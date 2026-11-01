import { CfnResource, Fn, type IAspect } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";

export const BOUNDARY_NAME = "compass-permissions-boundary";

/**
 * Closes the gap CDK's permissionsBoundary context leaves: roles created by
 * core custom-resource *providers* (bucket auto-delete, the cross-region
 * reference writer) are raw CfnResources of type AWS::IAM::Role, not
 * iam.CfnRole, and the built-in mechanism never sees them. Without this they
 * would be the only unbounded roles in the account -- and they are Lambda
 * execution roles that can delete objects.
 */
export class BoundaryOnRawRoles implements IAspect {
  visit(node: IConstruct): void {
    if (
      node instanceof CfnResource &&
      !(node instanceof iam.CfnRole) &&
      node.cfnResourceType === "AWS::IAM::Role"
    ) {
      node.addPropertyOverride(
        "PermissionsBoundary",
        Fn.sub(`arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${BOUNDARY_NAME}`),
      );
    }
  }
}
