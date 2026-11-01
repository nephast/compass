import { Fn } from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

// The Terraform -> CDK seam (docs/ARCHITECTURE.md). Every platform value CDK
// needs is read here and only here, from the SSM parameters Terraform writes
// (infra/terraform/envs/*/ssm.tf). Nothing is hardcoded, nothing comes from a
// .env file.
//
// valueForStringParameter, not valueFromLookup: it resolves at DEPLOY time as
// a CloudFormation parameter, so `cdk synth` needs no AWS credentials (CI's
// unit tests synth offline) and no lookup values are cached into
// cdk.context.json -- whose keys embed the account id, in a public repo.
//
// Lazy: each value becomes a template parameter only when a stack actually
// reads it, so no stack carries parameters it never uses.

export function platform(scope: Construct, env: string) {
  const cache = new Map<string, string>();
  const read = (name: string) => {
    if (!cache.has(name)) cache.set(name, ssm.StringParameter.valueForStringParameter(scope, name));
    return cache.get(name) as string;
  };
  const dev = (name: string) => read(`/compass/${env}/${name}`);
  let subnets: string[] | undefined;

  return {
    get vpcId() {
      return dev("network/vpc_id");
    },
    get privateSubnetIds() {
      if (!subnets) {
        const list = ssm.StringListParameter.valueForTypedListParameter(
          scope,
          `/compass/${env}/network/private_subnet_ids`,
        );
        subnets = [Fn.select(0, list), Fn.select(1, list)];
      }
      return subnets;
    },
    db: {
      get host() {
        return dev("db/endpoint");
      },
      get port() {
        return dev("db/port");
      },
      get name() {
        return dev("db/name");
      },
      get user() {
        return dev("db/iam_username");
      },
      get appSecurityGroupId() {
        return dev("db/app_security_group_id");
      },
      get connectPolicyArn() {
        return dev("db/connect_policy_arn");
      },
    },
    eks: {
      get clusterName() {
        return dev("eks/cluster_name");
      },
      get oidcProviderArn() {
        return dev("eks/oidc_provider_arn");
      },
      get oidcIssuer() {
        return dev("eks/oidc_issuer");
      },
    },
    ingress: {
      get listenerArn() {
        return dev("ingress/listener_arn");
      },
      get vpcLinkSecurityGroupId() {
        return dev("ingress/vpc_link_security_group_id");
      },
    },
  };
}

/** CDK -> k8s seam: values scripts/k8s-deploy.sh reads back. */
export function publish(scope: Construct, env: string, name: string, value: string): void {
  new ssm.StringParameter(scope, `Param-${name.replace(/[^A-Za-z0-9]/g, "")}`, {
    parameterName: `/compass/${env}/app/${name}`,
    stringValue: value,
  });
}
