import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import { webAclParameterName } from "./edge-waf-stack.js";
import type { Construct } from "constructs";

// Static hosting for the Next.js export (COMPASS-24): a PRIVATE bucket that
// only this distribution can read, via Origin Access Control. The bucket has
// no website endpoint and no public policy -- the only door is CloudFront,
// which is where WAF and the security headers live.
export class FrontendStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StackProps & { envName: string }) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Rebuildable from git in one CI run; teardown must not block on it.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        // Scripts only from this origin; XHR to this origin, the API and
        // Cognito. A reflected script injection has nowhere to load from and
        // nowhere to send a stolen token.
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "connect-src 'self' https://*.execute-api.*.amazonaws.com https://*.amazoncognito.com https://cognito-idp.*.amazonaws.com https://*.s3.*.amazonaws.com https://*.s3.amazonaws.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self' https://*.amazoncognito.com",
          ].join("; "),
          override: true,
        },
      },
    });

    // The web ACL lives in us-east-1 (CloudFront's requirement); read its ARN
    // from there on every deploy.
    const parameterName = webAclParameterName(props.envName);
    const webAcl = new cr.AwsCustomResource(this, "WebAclArn", {
      onUpdate: {
        service: "SSM",
        action: "getParameter",
        parameters: { Name: parameterName },
        region: "us-east-1",
        physicalResourceId: cr.PhysicalResourceId.of(`${parameterName}-${Date.now()}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          `arn:${this.partition}:ssm:us-east-1:${this.account}:parameter${parameterName}`,
        ],
      }),
      installLatestAwsSdk: false,
    });

    // One origin object for both behaviours, so one OAC and one bucket-policy
    // statement -- not one per behaviour.
    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      // config.json changes per deploy and must never be served stale.
      additionalBehaviors: {
        "/config.json": {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: headers,
        },
      },
      defaultRootObject: "index.html",
      // Static export writes /signin/index.html etc; a missing path is the
      // SPA's 404 page, not an S3 AccessDenied leaking bucket semantics.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/404.html" },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/404.html" },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: webAcl.getResponseField("Parameter.Value"),
    });
  }
}
