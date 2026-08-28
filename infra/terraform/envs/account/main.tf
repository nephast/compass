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
}
