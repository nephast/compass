import path from "node:path";
import { Annotations, fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import { bedrockInvokeStatement } from "./bedrock.js";
import { platform as readPlatform } from "./seam.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The ingestion pipeline (COMPASS-9/10/11):
//
//   S3 ObjectCreated (uploads/*) -> EventBridge rule -> Step Functions
//     -> ingest Lambda (VPC, IAM DB auth) -> RDS/pgvector
//
// Step Functions between the event and the Lambda, rather than EventBridge
// invoking the Lambda directly, buys three things a one-hop design lacks:
// an execution per document visible in the console (COMPASS-10's acceptance),
// a declarative retry policy with backoff for throttled embedding calls, and a
// terminal FAILED state that alarms (COMPASS-30) -- the role the descoped SQS
// DLQ would have played.
export class IngestionStack extends Stack {
  readonly documentsBucket: s3.Bucket;
  readonly stateMachine: sfn.StateMachine;
  readonly ingestFunction: nodejs.NodejsFunction;
  readonly ingestLogGroup: logs.LogGroup;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { envName: string; corsOrigins: string[] },
  ) {
    super(scope, id, props);
    const platform = readPlatform(this, props.envName);

    this.documentsBucket = new s3.Bucket(this, "Documents", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Unversioned on purpose: documents.version_id stays '' and an overwrite
      // is handled by the idempotent store, not by keeping old bytes around.
      versioned: false,
      eventBridgeEnabled: true,
      // The browser PUTs straight to S3 with the presigned URL (COMPASS-9),
      // so the bucket must answer the preflight -- for PUT only.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: props.corsOrigins,
          allowedHeaders: ["content-type", "content-length"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // Uploaded test documents; the database rows are the system of record.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      // Lambda and the VPC Link derive their VPC from the subnets; nothing in
      // the template needs the id itself, so it is not read from SSM (an
      // unused template parameter would only add noise).
      vpcId: "vpc-derived-from-subnets",
      availabilityZones: [this.availabilityZones[0] ?? "a", this.availabilityZones[1] ?? "b"],
      privateSubnetIds: platform.privateSubnetIds,
    });
    // Route tables are Terraform's; nothing here adds routes to them.
    Annotations.of(vpc).acknowledgeWarning(
      "@aws-cdk/aws-ec2:noSubnetRouteTableId",
      "subnets are imported from Terraform; CDK never touches their routes",
    );
    const appSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "DbAppSg",
      platform.db.appSecurityGroupId,
      { mutable: false },
    );

    const logGroup = (this.ingestLogGroup = new logs.LogGroup(this, "IngestLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    }));

    this.ingestFunction = new nodejs.NodejsFunction(this, "Ingest", {
      entry: path.join(repoRoot, "apps/ingestion/src/on-object-created.ts"),
      handler: "handler",
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 1024,
      // Long enough for a 5 MiB document's embedding fan-out; a document that
      // cannot finish in this window is the accepted failure mode of the
      // descoped single-function design (COMPASS-11).
      timeout: Duration.minutes(5),
      // Caps database connections (2 per instance) and Bedrock concurrency.
      // A burst of uploads queues in Step Functions instead of exhausting a
      // db.t3.micro's ~80 connections.
      reservedConcurrentExecutions: 5,
      vpc,
      vpcSubnets: { subnets: vpc.privateSubnets },
      securityGroups: [appSecurityGroup],
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        format: nodejs.OutputFormat.CJS,
        target: "node22",
        minify: true,
        sourceMap: true,
        // Bundle the AWS SDK rather than trusting the runtime's copy (the RDS
        // signer is not guaranteed to be in it); pg-native is an optional
        // native binding pg never loads unless asked.
        externalModules: ["pg-native"],
      },
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        SERVICE_NAME: "ingestion",
        DB_HOST: platform.db.host,
        DB_PORT: platform.db.port,
        DB_NAME: platform.db.name,
        DB_USER: platform.db.user,
        // The Lambda Node runtime ships Amazon's RDS CAs here; verify-full
        // against it rather than turning verification off.
        DB_SSL_ROOT_CERT: "/var/runtime/ca-cert.pem",
        LLM_EMBEDDING_PROVIDER: "bedrock",
      },
    });

    this.documentsBucket.grantRead(this.ingestFunction, "uploads/*");
    this.ingestFunction.role?.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyArn(this, "DbConnect", platform.db.connectPolicyArn),
    );
    this.ingestFunction.addToRolePolicy(bedrockInvokeStatement(this, { embeddings: true }));

    const invoke = new tasks.LambdaInvoke(this, "IngestDocument", {
      lambdaFunction: this.ingestFunction,
      // EventBridge "Object Created" detail: { bucket: {name}, object: {key} }.
      payload: sfn.TaskInput.fromJsonPathAt("$.detail"),
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    // Embedding errors are rethrown by the handler precisely so they land
    // here: throttling clears with backoff. Unsupported or undecodable files
    // never throw -- they are recorded as failed and the execution succeeds.
    invoke.addRetry({
      errors: ["States.TaskFailed"],
      interval: Duration.seconds(10),
      backoffRate: 3,
      maxAttempts: 3,
    });

    const failed = new sfn.Fail(this, "IngestionFailed", {
      error: "IngestionFailed",
      cause: "Retries exhausted; see the Lambda log for the document's failure_reason",
    });

    const sfnLogs = new logs.LogGroup(this, "StateMachineLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, "Pipeline", {
      stateMachineName: `compass-${props.envName}-ingestion`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        invoke.addCatch(failed, { resultPath: "$.error" }),
      ),
      timeout: Duration.minutes(20),
      tracingEnabled: true,
      logs: { destination: sfnLogs, level: sfn.LogLevel.ERROR },
    });

    new events.Rule(this, "ObjectCreated", {
      description: "New upload -> ingestion state machine",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [this.documentsBucket.bucketName] },
          object: { key: [{ prefix: "uploads/" }] },
        },
      },
      targets: [new targets.SfnStateMachine(this.stateMachine)],
    });
  }
}
