// Local-dev / test wiring only. None of this ships in the Lambda bundle:
// in a real environment the bucket, the notification and the invoke
// permission are all created by CDK (COMPASS-9/10), not by application code.
import { build } from "esbuild";
import JSZip from "jszip";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutBucketNotificationConfigurationCommand,
} from "@aws-sdk/client-s3";
import {
  LambdaClient,
  AddPermissionCommand,
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  ResourceConflictException,
} from "@aws-sdk/client-lambda";
import { setTimeout as sleep } from "node:timers/promises";
import { baseClientConfig } from "../../src/aws-config.js";

export const s3 = new S3Client({ ...baseClientConfig, forcePathStyle: true });
export const lambda = new LambdaClient(baseClientConfig);

// The Lambda runs in its own container on the compose network, so it reaches
// Postgres by service name -- not localhost, which is what this process uses.
const LAMBDA_DATABASE_URL = "postgresql://compass:compass@postgres:5432/compass";

export async function createBucket(bucket: string): Promise<void> {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
}

export async function deleteBucket(bucket: string): Promise<void> {
  const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  for (const object of Contents ?? []) {
    if (object.Key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}

export async function deployHandler(functionName: string): Promise<string> {
  // Bundle the real handler to CJS -- no package.json needed in the zip, and
  // it sidesteps whether the LocalStack Node runtime picks up ESM.
  const bundled = await build({
    entryPoints: ["src/on-object-created.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });

  const zip = new JSZip();
  zip.file("on-object-created.js", bundled.outputFiles[0]!.text);
  const ZipFile = await zip.generateAsync({ type: "nodebuffer" });

  const created = await lambda.send(
    new CreateFunctionCommand({
      FunctionName: functionName,
      Runtime: "nodejs20.x",
      Role: "arn:aws:iam::000000000000:role/lambda-role", // unenforced by LocalStack
      Handler: "on-object-created.handler",
      Code: { ZipFile },
      Timeout: 10,
      Environment: { Variables: { DATABASE_URL: LAMBDA_DATABASE_URL } },
    }),
  );

  await waitUntilActive(functionName);
  return created.FunctionArn!;
}

export async function deleteFunction(functionName: string): Promise<void> {
  await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
}

// A cold LocalStack (no cached runtime image yet) pulls the Lambda runtime
// image on first use, which can take well over a minute -- generous budget so
// that doesn't false-negative.
async function waitUntilActive(functionName: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const { Configuration } = await lambda.send(
      new GetFunctionCommand({ FunctionName: functionName }),
    );
    if (Configuration?.State === "Active") return;
    await sleep(1000);
  }
  throw new Error(`${functionName} never became Active`);
}

export async function triggerOnObjectCreated(lambdaArn: string, bucket: string): Promise<void> {
  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: lambdaArn,
        StatementId: `${bucket}-invoke`,
        Action: "lambda:InvokeFunction",
        Principal: "s3.amazonaws.com",
        SourceArn: `arn:aws:s3:::${bucket}`,
      }),
    );
  } catch (err) {
    // Permission already granted from a previous run -- fine to ignore.
    if (!(err instanceof ResourceConflictException)) throw err;
  }

  await s3.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          { LambdaFunctionArn: lambdaArn, Events: ["s3:ObjectCreated:*"] },
        ],
      },
    }),
  );
}
