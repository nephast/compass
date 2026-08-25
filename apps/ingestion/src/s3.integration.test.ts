// Full round trip against LocalStack: bundle the real handler, deploy it as
// a Lambda, wire it to the bucket via configureObjectCreatedTrigger, PUT an
// object, and confirm the handler actually ran -- both by reading its log
// line back out of CloudWatch Logs, and by reading the row it wrote to
// Postgres/pgvector back out of the real local Postgres (docker-compose).
//
// Requires `docker compose up -d localstack postgres` (localstack needs the
// docker.sock mount -- Lambda invocation spins up runtime containers via the
// host's Docker daemon). Not wired into `npm run test`: CI has no LocalStack
// service yet, so this is `test:integration`, run manually until that's set
// up.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import JSZip from 'jszip';
import pg from 'pg';
import {
  S3Client,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  LambdaClient,
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
} from '@aws-sdk/client-lambda';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { baseClientConfig } from './aws-config.js';
import { ensureBucketExists, configureObjectCreatedTrigger } from './s3.js';

const { Pool } = pg;

const bucket = `compass-ingestion-test-${randomUUID()}`;
const functionName = `compass-ingestion-test-${randomUUID()}`;
const lambdaClient = new LambdaClient(baseClientConfig);
const s3Client = new S3Client({ ...baseClientConfig, forcePathStyle: true });
const logsClient = new CloudWatchLogsClient(baseClientConfig);
// From the test's own process (host side), the DB is reachable at
// localhost, per .env's DATABASE_URL -- the Lambda container, on the other
// hand, reaches it via the docker-compose service name (see
// CreateFunctionCommand's Environment below).
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let functionArn: string;

async function waitUntilActive(): Promise<void> {
  // A cold LocalStack (no cached runtime image yet) pulls
  // public.ecr.aws/lambda/nodejs:20 on the first invocation, which can take
  // well over a minute -- generous budget so that doesn't false-negative.
  for (let attempt = 0; attempt < 90; attempt++) {
    const { Configuration } = await lambdaClient.send(
      new GetFunctionCommand({ FunctionName: functionName }),
    );
    if (Configuration?.State === 'Active') return;
    await sleep(1000);
  }
  throw new Error(`${functionName} never became Active`);
}

describe('S3 ObjectCreated -> Lambda (LocalStack)', () => {
  beforeAll(async () => {
    await ensureBucketExists(bucket);

    // Bundle the real handler to CJS -- no package.json needed in the zip,
    // and it sidesteps whether the LocalStack Node runtime picks up ESM.
    const bundled = await build({
      entryPoints: ['src/handler.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
    });
    const code = bundled.outputFiles[0]!.text;

    const zip = new JSZip();
    zip.file('handler.js', code);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const created = await lambdaClient.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        Runtime: 'nodejs20.x',
        Role: 'arn:aws:iam::000000000000:role/lambda-role', // unenforced by LocalStack
        Handler: 'handler.handler',
        Code: { ZipFile: zipBuffer },
        Timeout: 10,
        Environment: {
          // The Lambda runs in its own container on the docker-compose
          // network, so it reaches Postgres via the service name -- not
          // localhost, which is what the test's own process uses.
          Variables: { DATABASE_URL: 'postgresql://compass:compass@postgres:5432/compass' },
        },
      }),
    );
    functionArn = created.FunctionArn!;
    await waitUntilActive();

    await configureObjectCreatedTrigger(functionArn, bucket);
  });

  afterAll(async () => {
    // Best-effort cleanup -- don't let it mask the test's own failure.
    try {
      await lambdaClient.send(new DeleteFunctionCommand({ FunctionName: functionName }));
      const { Contents } = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket }));
      for (const object of Contents ?? []) {
        if (object.Key)
          await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      }
      await s3Client.send(new DeleteBucketCommand({ Bucket: bucket }));
      await pool.query('DELETE FROM chunks WHERE bucket = $1', [bucket]);
    } catch (err) {
      console.error('cleanup failed:', err);
    } finally {
      await pool.end();
    }
  });

  it('invokes the lambda, which stores the object as a chunk row', async () => {
    const key = `docs/${randomUUID()}.txt`;
    const body = 'hello';
    await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));

    const expectedLine = `s3://${bucket}/${key}`;
    const logGroupName = `/aws/lambda/${functionName}`;

    let found = false;
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      await sleep(1000);
      try {
        const { events } = await logsClient.send(new FilterLogEventsCommand({ logGroupName }));
        found = (events ?? []).some((event) => event.message?.includes(expectedLine));
      } catch {
        // Log group doesn't exist yet -- the first invocation creates it.
      }
    }
    expect(found).toBe(true);

    const { rows } = await pool.query('SELECT content, embedding FROM chunks WHERE bucket = $1 AND object_key = $2', [
      bucket,
      key,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(body);
  });
});
