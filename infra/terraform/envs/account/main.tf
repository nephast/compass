# Account-lifetime infrastructure: things that exist because the AWS account
# exists, not because an environment does. Applied rarely, destroyed
# essentially never, and — critically — held in a SEPARATE state file from
# envs/dev so that `scripts/teardown.sh` cannot reach it.
#
# The trail deleted in Aug 2026 was console-created and therefore invisible to
# review; had it instead lived in envs/dev, the nightly teardown would have
# deleted it on a schedule. Both failure modes are fixed by this root.

module "cloudtrail" {
  source = "../../modules/cloudtrail"

  alert_email = var.alert_email
}

# Account-lifetime for the same reason as the trail: CI must be able to deploy
# the morning after a teardown, and a boundary that is destroyed with dev
# would leave every recreated role briefly unbounded.
module "permission_boundary" {
  source = "../../modules/permission-boundary"
}

module "github_oidc" {
  source = "../../modules/github-oidc"

  repository               = var.github_repository
  permissions_boundary_arn = module.permission_boundary.arn
  state_bucket             = var.state_bucket
}

# Published for envs/dev and CDK, which both create roles that must carry it.
resource "aws_ssm_parameter" "permissions_boundary_arn" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time.
  name        = "/compass/account/permissions_boundary_arn"
  description = "Permissions boundary every Compass role must carry (COMPASS-8)"
  type        = "String"
  value       = module.permission_boundary.arn
}
