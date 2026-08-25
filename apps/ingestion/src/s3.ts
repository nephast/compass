import {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketNotificationConfigurationCommand,
} from "@aws-sdk/client-s3";
import { LambdaClient, AddPermissionCommand, ResourceConflictException } from "@aws-sdk/client-lambda";
import { baseClientConfig, isLocalstack } from "./aws-config.js";

// forcePathStyle is only safe to force when we're actually targeting
// LocalStack -- real S3 has deprecated path-style for anything but legacy
// us-east-1 buckets, so leave it to the SDK default otherwise.
const client = new S3Client({ ...baseClientConfig, ...(isLocalstack ? { forcePathStyle: true } : {}) });
const lambdaClient = new LambdaClient(baseClientConfig);

export const RAW_DOCUMENTS_BUCKET = process.env.RAW_DOCUMENTS_BUCKET ?? "compass-raw-documents";

// Idempotent: safe to call on every local boot. LocalStack throws on
// CreateBucket if the bucket already exists, so check first.
export async function ensureBucketExists(bucket = RAW_DOCUMENTS_BUCKET): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function getObjectText(bucket: string, key: string): Promise<string> {
  const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body) throw new Error(`empty body for s3://${bucket}/${key}`);
  return Body.transformToString();
}

export async function configureObjectCreatedTrigger(
  lambdaArn: string,
  bucket = RAW_DOCUMENTS_BUCKET,
): Promise<void> {
  try {
    await lambdaClient.send(
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

  await client.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          {
            LambdaFunctionArn: lambdaArn,
            Events: ["s3:ObjectCreated:*"],
          },
        ],
      },
    }),
  );
}
