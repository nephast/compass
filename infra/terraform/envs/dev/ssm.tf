# The Terraform -> CDK seam, per docs/ARCHITECTURE.md. Terraform owns the
# platform layer and publishes here; CDK reads these at synth time. Nothing
# crosses this boundary by any other route — not a hardcoded value, not a .env
# file, not a copy-pasted console lookup.
#
# Keeping every published parameter in one file is the point: this is the whole
# contract, auditable at a glance. VPC and EKS outputs land here too as their
# consumers appear.
#
# All of these are String rather than SecureString, and checkov's CKV2_AWS_34 is
# suppressed on each with that reason. None of them is a secret — a hostname, a
# port, a database name, a role name and two AWS resource identifiers, all of
# which are discoverable by anyone already holding credentials for this account.
# SecureString would also make the seam worse rather than better: CDK cannot
# resolve an encrypted parameter at synth time, which is exactly when it needs
# these. The one real secret in this system, the master password, is not here —
# RDS owns it in Secrets Manager.

resource "aws_ssm_parameter" "db_endpoint" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/endpoint"
  description = "RDS PostgreSQL hostname"
  type        = "String"
  value       = module.rds.endpoint
}

resource "aws_ssm_parameter" "db_port" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/port"
  description = "RDS PostgreSQL port"
  type        = "String"
  value       = tostring(module.rds.port)
}

resource "aws_ssm_parameter" "db_name" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/name"
  description = "Initial database name"
  type        = "String"
  value       = module.rds.db_name
}

resource "aws_ssm_parameter" "db_iam_username" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/iam_username"
  description = "Database role the application authenticates as via an IAM auth token"
  type        = "String"
  value       = module.rds.iam_db_username
}

resource "aws_ssm_parameter" "db_app_security_group_id" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/app_security_group_id"
  description = "Security group callers must attach to in order to reach the database"
  type        = "String"
  value       = module.rds.app_security_group_id
}

resource "aws_ssm_parameter" "db_migrator_username" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/migrator_username"
  description = "Database role migrations run as via an IAM auth token"
  type        = "String"
  value       = module.rds.iam_migrator_username
}

resource "aws_ssm_parameter" "db_migrate_policy_arn" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/migrate_policy_arn"
  description = "IAM policy granting rds-db:connect as the migration role"
  type        = "String"
  value       = module.rds.db_migrate_policy_arn
}

resource "aws_ssm_parameter" "db_connect_policy_arn" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/db/connect_policy_arn"
  description = "IAM policy granting rds-db:connect as the IAM-mapped database role"
  type        = "String"
  value       = module.rds.db_connect_policy_arn
}

# --- Network (COMPASS-5) -----------------------------------------------------

resource "aws_ssm_parameter" "vpc_id" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/network/vpc_id"
  type  = "String"
  value = module.vpc.vpc_id
}

resource "aws_ssm_parameter" "private_subnet_ids" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/network/private_subnet_ids"
  type  = "StringList"
  value = join(",", module.vpc.private_subnet_ids)
}

# --- EKS (COMPASS-6) ---------------------------------------------------------

resource "aws_ssm_parameter" "eks_cluster_name" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/eks/cluster_name"
  type  = "String"
  value = module.eks.cluster_name
}

resource "aws_ssm_parameter" "eks_oidc_provider_arn" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/eks/oidc_provider_arn"
  description = "Federated principal for IRSA trust policies (CDK creates the pod roles)"
  type        = "String"
  value       = module.eks.oidc_provider_arn
}

resource "aws_ssm_parameter" "eks_oidc_issuer" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/eks/oidc_issuer"
  type  = "String"
  value = module.eks.oidc_issuer
}

# --- Ingress (COMPASS-18) ----------------------------------------------------

resource "aws_ssm_parameter" "ingress_listener_arn" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name        = "/compass/${var.env}/ingress/listener_arn"
  description = "Internal ALB listener the API Gateway VPC Link targets"
  type        = "String"
  value       = module.ingress.listener_arn
}

resource "aws_ssm_parameter" "ingress_vpc_link_sg" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/ingress/vpc_link_security_group_id"
  type  = "String"
  value = module.ingress.vpc_link_security_group_id
}

resource "aws_ssm_parameter" "ingress_alb_arn_suffix" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/ingress/alb_arn_suffix"
  type  = "String"
  value = module.ingress.alb_arn_suffix
}

resource "aws_ssm_parameter" "ingress_tg_arn_suffix" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/ingress/target_group_arn_suffix"
  type  = "String"
  value = module.ingress.target_group_arn_suffix
}

# --- ECR (COMPASS-7) ---------------------------------------------------------

resource "aws_ssm_parameter" "ecr_registry" {
  # checkov:skip=CKV2_AWS_34:Not a secret; SecureString cannot be resolved by CDK at synth time. See header.
  name  = "/compass/${var.env}/ecr/registry"
  type  = "String"
  value = module.ecr.registry
}
