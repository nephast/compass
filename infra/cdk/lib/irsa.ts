import { CfnJson } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

// IRSA: an IAM role only ONE Kubernetes service account can assume
// (COMPASS-6). The trust policy's condition keys are prefixed with the
// cluster's OIDC issuer, which is a deploy-time token here (read from SSM) --
// and CloudFormation does not allow a token in a JSON *key*. CfnJson defers
// building the condition object until deploy time, which is the documented
// way around that.
export class IrsaRole extends Construct {
  readonly role: iam.Role;

  constructor(
    scope: Construct,
    id: string,
    props: {
      roleName: string;
      oidcProviderArn: string;
      oidcIssuer: string;
      namespace: string;
      serviceAccount: string;
    },
  ) {
    super(scope, id);

    const conditions = new CfnJson(this, "Conditions", {
      value: {
        [`${props.oidcIssuer}:sub`]: `system:serviceaccount:${props.namespace}:${props.serviceAccount}`,
        [`${props.oidcIssuer}:aud`]: "sts.amazonaws.com",
      },
    });

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName,
      assumedBy: new iam.FederatedPrincipal(
        props.oidcProviderArn,
        { StringEquals: conditions },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });
  }
}
