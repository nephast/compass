import { App, Aspects, Tags, type AppProps } from "aws-cdk-lib";
import { BOUNDARY_NAME, BoundaryOnRawRoles } from "../lib/boundary.js";
import { ApiStack } from "../lib/api-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { EdgeWafStack } from "../lib/edge-waf-stack.js";
import { FrontendStack } from "../lib/frontend-stack.js";
import { IngestionStack } from "../lib/ingestion-stack.js";
import { ObservabilityStack } from "../lib/observability-stack.js";
import { SiteStack } from "../lib/site-stack.js";

// COMPASS-8 on the CDK side: every IAM role in every stack -- including the
// ones CDK creates for its own custom resources (bucket auto-delete,
// BucketDeployment) -- carries the account's permissions boundary, owned by
// envs/account in Terraform. Set at the App level by NAME, via CDK's
// permissionsBoundary context key, and a name carries no account id; the
// BoundaryOnRawRoles aspect covers the provider roles that key misses.
// test/stacks.test.ts asserts no role escapes it.
export function buildApp(props: AppProps = {}): App {
  const app = new App({
    ...props,
    context: {
      ...props.context,
      "@aws-cdk/core:permissionsBoundary": { name: BOUNDARY_NAME },
      // Strong exports: CloudFormation refuses to delete a value another stack
      // still imports. Explicit, so tests and the CLI behave the same.
      "@aws-cdk/core:defaultCrossStackReferences": "strong",
    },
  });
  // One stack set per environment: `cdk deploy --all --context env=dev`.
  const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
  if (!/^[a-z]+$/.test(envName)) throw new Error(`invalid env "${envName}"`);

  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const region = process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
  const env = { account, region };
  const prefix = `Compass-${envName}`;

  const waf = new EdgeWafStack(app, `${prefix}-EdgeWaf`, {
    env: { account, region: "us-east-1" },
    envName,
  });

  const frontend = new FrontendStack(app, `${prefix}-Frontend`, { env, envName });
  frontend.addStackDependency(waf, "reads the web ACL ARN the WAF stack publishes");
  const siteUrl = `https://${frontend.distribution.distributionDomainName}`;
  const corsOrigins = [siteUrl, "http://localhost:3000"];

  const auth = new AuthStack(app, `${prefix}-Auth`, { env, envName, siteUrl });

  const ingestion = new IngestionStack(app, `${prefix}-Ingestion`, { env, envName, corsOrigins });

  const api = new ApiStack(app, `${prefix}-Api`, {
    env,
    envName,
    corsOrigins,
    userPool: auth.userPool,
    clientIds: [auth.webClient.userPoolClientId, auth.smokeClient.userPoolClientId],
    documentsBucket: ingestion.documentsBucket,
  });

  new SiteStack(app, `${prefix}-Site`, {
    env,
    bucket: frontend.bucket,
    distribution: frontend.distribution,
    // Public by nature -- shipped to every browser. Not secrets.
    config: {
      apiUrl: api.httpApi.apiEndpoint,
      region,
      userPoolId: auth.userPool.userPoolId,
      clientId: auth.webClient.userPoolClientId,
      authDomain: `${auth.domain.domainName}.auth.${region}.amazoncognito.com`,
      env: envName,
    },
  });

  new ObservabilityStack(app, `${prefix}-Observability`, {
    env,
    envName,
    httpApi: api.httpApi,
    apiAccessLogs: api.accessLogs,
    stateMachine: ingestion.stateMachine,
    ingestFunction: ingestion.ingestFunction,
    ingestLogGroup: ingestion.ingestLogGroup,
    alertEmail:
      (app.node.tryGetContext("alertEmail") as string | undefined) ?? process.env.ALERT_EMAIL,
  });

  Aspects.of(app).add(new BoundaryOnRawRoles());

  // Cost allocation tags on every taggable resource (COMPASS-37).
  Tags.of(app).add("Project", "compass");
  Tags.of(app).add("Environment", envName);
  Tags.of(app).add("ManagedBy", "cdk");
  return app;
}

if (process.argv[1]?.endsWith("compass.ts")) buildApp().synth();
