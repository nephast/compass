# The Terraform -> CDK seam, per docs/ARCHITECTURE.md. Terraform owns the
# platform layer and publishes here; CDK reads these at synth time. Nothing
# crosses this boundary by any other route — not a hardcoded value, not a .env
# file, not a copy-pasted console lookup.
#
# Keeping every published parameter in one file is the point: this is the whole
# contract, auditable at a glance. VPC and EKS outputs land here too as their
# consumers appear.

resource "aws_ssm_parameter" "db_endpoint" {
  name        = "/compass/${var.env}/db/endpoint"
  description = "RDS PostgreSQL hostname"
  type        = "String"
  value       = module.rds.endpoint
}

resource "aws_ssm_parameter" "db_port" {
  name        = "/compass/${var.env}/db/port"
  description = "RDS PostgreSQL port"
  type        = "String"
  value       = tostring(module.rds.port)
}

resource "aws_ssm_parameter" "db_name" {
  name        = "/compass/${var.env}/db/name"
  description = "Initial database name"
  type        = "String"
  value       = module.rds.db_name
}

resource "aws_ssm_parameter" "db_iam_username" {
  name        = "/compass/${var.env}/db/iam_username"
  description = "Database role the application authenticates as via an IAM auth token"
  type        = "String"
  value       = module.rds.iam_db_username
}

resource "aws_ssm_parameter" "db_app_security_group_id" {
  name        = "/compass/${var.env}/db/app_security_group_id"
  description = "Security group callers must attach to in order to reach the database"
  type        = "String"
  value       = module.rds.app_security_group_id
}

resource "aws_ssm_parameter" "db_connect_policy_arn" {
  name        = "/compass/${var.env}/db/connect_policy_arn"
  description = "IAM policy granting rds-db:connect as the IAM-mapped database role"
  type        = "String"
  value       = module.rds.db_connect_policy_arn
}
