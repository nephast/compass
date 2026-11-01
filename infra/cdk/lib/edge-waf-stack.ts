import { Stack, type StackProps } from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";

// WAF for CloudFront (COMPASS-32). Must live in us-east-1: CloudFront is a
// global service and only accepts web ACLs from there.
//
// Why only CloudFront: API Gateway *HTTP* APIs cannot be associated with WAF
// at all -- only REST APIs, ALBs, AppSync and CloudFront can. The ticket's
// "WAF on API Gateway" is therefore covered differently, in ApiStack: stage
// throttling (a token bucket per API, enforced by API Gateway itself) plus the
// JWT authorizer rejecting unauthenticated traffic before it costs anything.
// See ADR-0009 for the alternatives (REST API, or CloudFront in front of the
// HTTP API) and why they were not taken.
//
// Cost: $5/month per web ACL + $1 per rule + $0.60 per million requests.
// Three rules here -> ~$8/month.
export class EdgeWafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: StackProps & { envName: string }) {
    super(scope, id, props);

    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName,
    });

    const acl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: `compass-${props.envName}-edge`,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`compass-${props.envName}-edge`),
      rules: [
        {
          // The acceptance test: many rapid requests from one IP get 403s.
          // 100 per 5-minute window is the lowest WAF allows evaluating
          // against (the minimum limit is 10 since 2024, but 100 keeps a real
          // user reloading the SPA comfortably clear of it).
          name: "rate-limit-per-ip",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 100, aggregateKeyType: "IP", evaluationWindowSec: 300 },
          },
          visibilityConfig: visibility("rate-limit-per-ip"),
        },
        {
          name: "aws-common-rule-set",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" },
          },
          visibilityConfig: visibility("aws-common-rule-set"),
        },
        {
          name: "aws-known-bad-inputs",
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          visibilityConfig: visibility("aws-known-bad-inputs"),
        },
      ],
    });

    this.webAclArn = acl.attrArn;

    // Read back by FrontendStack in eu-west-1. An explicit parameter rather
    // than CDK's crossRegionReferences: that feature's writer is a custom
    // resource created after Aspects run, so its role could never carry the
    // permissions boundary (test/stacks.test.ts).
    new ssm.StringParameter(this, "WebAclArnParam", {
      parameterName: webAclParameterName(props.envName),
      stringValue: acl.attrArn,
    });
  }
}

export function webAclParameterName(envName: string): string {
  return `/compass/${envName}/edge/web_acl_arn`;
}
