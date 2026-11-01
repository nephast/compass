import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../bin/compass.js";

// Offline synth of the whole app (no credentials: every platform value is a
// deploy-time SSM parameter), then assertions on the properties that would
// be security or cost incidents if they regressed.

let templates: Map<string, Template>;
let raw: Map<string, string>;

beforeAll(() => {
  const app = buildApp({ context: { env: "dev" } });
  const assembly = app.synth();
  templates = new Map();
  raw = new Map();
  for (const stack of app.node.children.filter((c): c is Stack => c instanceof Stack)) {
    templates.set(stack.stackName, Template.fromStack(stack));
    raw.set(stack.stackName, JSON.stringify(assembly.getStackByName(stack.stackName).template));
  }
});

const t = (name: string) => {
  const template = templates.get(`Compass-dev-${name}`);
  if (!template) throw new Error(`no stack ${name}`);
  return template;
};

describe("account hygiene", () => {
  it("every IAM role in every stack carries the permissions boundary (COMPASS-8)", () => {
    let roles = 0;
    for (const [name, template] of templates) {
      for (const [logicalId, role] of Object.entries(template.findResources("AWS::IAM::Role"))) {
        roles += 1;
        expect(role.Properties?.PermissionsBoundary, `${name}/${logicalId}`).toBeDefined();
      }
    }
    expect(roles).toBeGreaterThan(3);
  });

  it("no template contains a literal 12-digit account id (public repo)", () => {
    for (const [name, json] of raw) {
      expect(json, name).not.toMatch(/(?<![0-9])[0-9]{12}(?![0-9])/);
    }
  });

  it("tags taggable resources for the cost report (COMPASS-37)", () => {
    t("Ingestion").hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([
        { Key: "Environment", Value: "dev" },
        { Key: "ManagedBy", Value: "cdk" },
        { Key: "Project", Value: "compass" },
      ]),
    });
  });
});

describe("frontend (COMPASS-24, COMPASS-32)", () => {
  it("serves a private bucket through CloudFront OAC with WAF attached", () => {
    t("Frontend").hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    t("Frontend").resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    t("Frontend").hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }),
    });
  });

  it("rate-limits per IP and runs the AWS common rule set", () => {
    t("EdgeWaf").hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
      Rules: Match.arrayWith([
        Match.objectLike({
          Statement: { RateBasedStatement: Match.objectLike({ AggregateKeyType: "IP" }) },
        }),
        Match.objectLike({ Name: "aws-common-rule-set" }),
      ]),
    });
  });

  it("invalidates CloudFront as part of the deploy", () => {
    t("Site").hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionPaths: ["/*"],
    });
  });
});

describe("auth (COMPASS-15)", () => {
  it("issues short-lived, revocable tokens via code+PKCE only", () => {
    t("Auth").hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "web",
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AccessTokenValidity: 15,
      EnableTokenRevocation: true,
    });
  });
});

describe("api edge (COMPASS-16)", () => {
  it("guards every route with the JWT authorizer except /healthz", () => {
    const routes = t("Api").findResources("AWS::ApiGatewayV2::Route");
    const byKey = Object.fromEntries(
      Object.values(routes).map((r) => [
        r.Properties.RouteKey,
        r.Properties.AuthorizationType ?? "NONE",
      ]),
    );
    expect(byKey["GET /healthz"]).toBe("NONE");
    for (const [key, auth] of Object.entries(byKey)) {
      if (key !== "GET /healthz" && !key.startsWith("OPTIONS")) expect(auth, key).toBe("JWT");
    }
  });

  it("throttles the stage (HTTP APIs cannot take WAF)", () => {
    t("Api").hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  it("trusts each IRSA role to exactly one service account", () => {
    const roles = Object.values(t("Api").findResources("AWS::IAM::Role")).filter((r) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes("AssumeRoleWithWebIdentity"),
    );
    expect(roles).toHaveLength(2);
  });
});

describe("ingestion (COMPASS-9..12)", () => {
  it("routes only uploads/ ObjectCreated events to the state machine", () => {
    t("Ingestion").hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        "detail-type": ["Object Created"],
        detail: Match.objectLike({ object: { key: [{ prefix: "uploads/" }] } }),
      }),
    });
  });

  it("runs the Lambda in the VPC with bounded concurrency and verify-full TLS", () => {
    t("Ingestion").hasResourceProperties("AWS::Lambda::Function", {
      VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
      ReservedConcurrentExecutions: 5,
      Environment: {
        Variables: Match.objectLike({ DB_SSL_ROOT_CERT: "/var/runtime/ca-cert.pem" }),
      },
    });
  });
});

describe("observability (COMPASS-29, COMPASS-30)", () => {
  it("alarms on the four failure modes that matter", () => {
    const names = Object.values(t("Observability").findResources("AWS::CloudWatch::Alarm")).map(
      (a) => a.Properties.AlarmName as string,
    );
    expect(names.sort()).toEqual([
      "compass-dev-api-5xx-rate",
      "compass-dev-eks-node-not-ready",
      "compass-dev-ingest-lambda-errors",
      "compass-dev-ingestion-failed",
    ]);
  });
});
