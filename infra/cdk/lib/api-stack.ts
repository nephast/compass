import { Annotations, CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { bedrockInvokeStatement } from "./bedrock.js";
import { IrsaRole } from "./irsa.js";
import { platform as readPlatform, publish } from "./seam.js";

// The edge of the synchronous path (COMPASS-16):
//
//   browser -> HTTP API (JWT authorizer) -> VPC Link -> internal ALB -> api pods
//
// plus the IAM roles the pods run as (IRSA) and the SSM parameters
// scripts/k8s-deploy.sh reads to configure them.
export class ApiStack extends Stack {
  readonly httpApi: apigw.HttpApi;
  readonly accessLogs: logs.LogGroup;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      envName: string;
     
      userPool: cognito.IUserPool;
      clientIds: string[];
      documentsBucket: s3.IBucket;
      corsOrigins: string[];
    },
  ) {
    super(scope, id, props);
    const { envName } = props;
    const platform = readPlatform(this, envName);

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
    const vpcLinkSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "VpcLinkSg",
      platform.ingress.vpcLinkSecurityGroupId,
      { mutable: false },
    );
    const vpcLink = new apigw.VpcLink(this, "VpcLink", {
      vpc,
      subnets: { subnets: vpc.privateSubnets },
      securityGroups: [vpcLinkSg],
    });

    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, "Listener", {
      listenerArn: platform.ingress.listenerArn,
      securityGroup: vpcLinkSg,
    });

    // The gateway stamps its request id onto the upstream request, so one id
    // joins the access log below to every log line in the api and agent-tools
    // (packages/telemetry derives the trace id from it). overwrite, not
    // append: a client-supplied x-request-id must not be able to collide.
    const integration = new integrations.HttpAlbIntegration("Api", listener, {
      vpcLink,
      parameterMapping: new apigw.ParameterMapping().overwriteHeader(
        "x-request-id",
        apigw.MappingValue.contextVariable("requestId"),
      ),
    });

    const authorizer = new authorizers.HttpJwtAuthorizer(
      "Cognito",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: props.clientIds, identitySource: ["$request.header.Authorization"] },
    );

    this.httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: `compass-${envName}`,
      corsPreflight: {
        allowOrigins: props.corsOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ["authorization", "content-type", "traceparent"],
      },
      createDefaultStage: false,
    });

    this.accessLogs = new logs.LogGroup(this, "AccessLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // HTTP APIs cannot take a WAF web ACL (only REST APIs can), so abuse
    // protection here is the stage throttle -- a token bucket API Gateway
    // enforces before any request reaches the VPC -- plus the authorizer,
    // which rejects anonymous traffic without invoking anything (ADR-0009).
    const stage = new apigw.HttpStage(this, "Stage", {
      httpApi: this.httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
    });
    const cfnStage = stage.node.defaultChild as apigw.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: this.accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        method: "$context.httpMethod",
        route: "$context.routeKey",
        status: "$context.status",
        latencyMs: "$context.responseLatency",
        integrationLatencyMs: "$context.integration.latency",
        integrationError: "$context.integrationErrorMessage",
        authorizerError: "$context.authorizer.error",
        user: "$context.authorizer.claims.sub",
      }),
    };

    // /healthz is the only anonymous route: the smoke test and uptime checks
    // need it, and it returns nothing but {"status":"ok"}.
    this.httpApi.addRoutes({
      path: "/healthz",
      methods: [apigw.HttpMethod.GET],
      integration,
    });
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration,
      authorizer,
    });

    // --- Pod identities (IRSA) ---------------------------------------------

    const api = new IrsaRole(this, "ApiRole", {
      roleName: `compass-${envName}-api`,
      oidcProviderArn: platform.eks.oidcProviderArn,
      oidcIssuer: platform.eks.oidcIssuer,
      namespace: "compass",
      serviceAccount: "api",
    }).role;
    // PutObject only, only under uploads/: the presigned URL is signed with
    // these credentials, so this is also the ceiling on what any URL the api
    // hands out can do.
    props.documentsBucket.grantPut(api, "uploads/*");
    api.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyArn(this, "ApiDbConnect", platform.db.connectPolicyArn),
    );
    api.addToPolicy(bedrockInvokeStatement(this, { embeddings: true, completions: true }));

    // Holds OPENROUTER_API_KEY / GITHUB_TOKEN as JSON, both optional. Created
    // empty; set it once with `aws secretsmanager put-secret-value`.
    const agentSecret = new secretsmanager.Secret(this, "AgentSecret", {
      secretName: `compass/${envName}/agent`,
      description: "agent-tools optional credentials: {OPENROUTER_API_KEY?, GITHUB_TOKEN?}",
      generateSecretString: { secretStringTemplate: "{}", generateStringKey: "_unused" },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const agent = new IrsaRole(this, "AgentRole", {
      roleName: `compass-${envName}-agent-tools`,
      oidcProviderArn: platform.eks.oidcProviderArn,
      oidcIssuer: platform.eks.oidcIssuer,
      namespace: "compass",
      serviceAccount: "agent-tools",
    }).role;
    // The entire read surface of the agent (ADR-0008). Neither action
    // supports resource-level scoping, hence "*": that is an AWS limit, not a
    // shortcut, and is listed as such in docs/iam-audit.md.
    agent.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ce:GetCostAndUsage", "cloudwatch:DescribeAlarms"],
        resources: ["*"],
      }),
    );
    agentSecret.grantRead(agent);
    agent.addToPolicy(bedrockInvokeStatement(this, { completions: true }));

    // --- Seam back to k8s ---------------------------------------------------

    publish(this, envName, "documents_bucket", props.documentsBucket.bucketName);
    publish(this, envName, "cognito_user_pool_id", props.userPool.userPoolId);
    // The api verifies tokens from either client (web, smoke test).
    publish(this, envName, "cognito_client_id", props.clientIds.join(","));
    publish(this, envName, "api_role_arn", api.roleArn);
    publish(this, envName, "agent_role_arn", agent.roleArn);
    publish(this, envName, "agent_secret_id", agentSecret.secretName);
    publish(this, envName, "api_url", this.httpApi.apiEndpoint);

    new CfnOutput(this, "ApiUrl", { value: this.httpApi.apiEndpoint });
  }
}
