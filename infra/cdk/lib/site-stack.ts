import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const siteDir = path.join(repoRoot, "apps/frontend/out");

// Publishes the static export and its runtime config, then invalidates
// CloudFront in the same deploy (COMPASS-24): "a code change is visible at the
// CloudFront URL within a normal CI run, without a manual invalidation step".
//
// A separate stack because config.json needs the Cognito ids and the API URL,
// and Cognito needs the CloudFront URL for its callback list -- putting the
// deployment in either of those stacks would be a cycle.
//
// Runtime config rather than build-time NEXT_PUBLIC_* variables: one build
// artefact serves every environment, and a config change is a deploy, not a
// rebuild.
export class SiteStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      bucket: s3.IBucket;
      distribution: cloudfront.IDistribution;
      config: Record<string, string>;
    },
  ) {
    super(scope, id, props);

    const sources = [
      // Synth must not depend on the frontend being built (CI's cdk diff job
      // never builds it); a placeholder deploys an obviously-unbuilt page.
      existsSync(siteDir)
        ? // The build copies public/, which holds the LOCAL config; the
          // deployed config.json comes only from jsonData below.
          deploy.Source.asset(siteDir, { exclude: ["config.json", "config.local.json"] })
        : deploy.Source.data("index.html", "<h1>Frontend not built</h1>"),
      deploy.Source.jsonData("config.json", props.config),
    ];

    new deploy.BucketDeployment(this, "Deploy", {
      destinationBucket: props.bucket,
      sources,
      distribution: props.distribution,
      distributionPaths: ["/*"],
      prune: true,
      memoryLimit: 512,
    });

    new CfnOutput(this, "SiteUrl", {
      value: `https://${props.distribution.distributionDomainName}`,
    });
  }
}
