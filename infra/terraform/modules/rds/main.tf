# RDS PostgreSQL with pgvector, per COMPASS-13. The database never accepts a
# password from the application: the app authenticates with a short-lived IAM
# auth token, and the only password that exists is the master one, which RDS
# generates and holds in Secrets Manager for bootstrap SQL.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# --- Placement ---------------------------------------------------------------

# Two AZs is not optional even though the instance is single-AZ: RDS refuses to
# create a subnet group with fewer, so that a later Multi-AZ conversion or a
# cross-AZ snapshot restore needs no network change.
resource "aws_db_subnet_group" "main" {
  name       = "compass-${var.env}-db"
  subnet_ids = var.subnet_ids

  tags = {
    Name = "compass-${var.env}-db"
  }
}

# --- Security groups ---------------------------------------------------------

# The identity of "things allowed to reach the data layer". Callers attach to
# this SG; the database's rule references the SG itself rather than a subnet
# CIDR, because a CIDR rule would also grant 5432 to every other workload in
# those subnets — the NAT instance included — and because Lambda ENIs take
# arbitrary, churning addresses from the subnet.
#
# The ingestion Lambda attaches here (COMPASS-11); the EKS node group joins it
# at COMPASS-6.
# name_prefix + create_before_destroy, not name: AWS exposes no API to modify
# an SG's description, so a one-word tidy-up forces replacement. Without both
# of these, replacement is destroy-first — this SG is attached, from outside
# this state, to things Terraform cannot see (Lambda ENIs at COMPASS-11, EKS
# nodes at COMPASS-6) and cannot order a delete around.
resource "aws_security_group" "app" {
  # checkov:skip=CKV2_AWS_5:Attached by consumers, not here. The ingestion Lambda joins it at COMPASS-11 and the EKS node group at COMPASS-6; it is published to SSM as the attach point.
  name_prefix = "compass-${var.env}-app-"
  description = "Workloads permitted to reach the Compass data layer"
  vpc_id      = var.vpc_id

  tags = {
    Name = "compass-${var.env}-app"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Same reasoning as aws_security_group.app: name_prefix + create_before_destroy
# so a replacement (e.g. a description edit) creates the new group before
# deleting the old one. Without it, a destroy-first replacement runs
# DeleteSecurityGroup while this SG is still attached to the live RDS
# instance, and AWS refuses with DependencyViolation.
resource "aws_security_group" "db" {
  name_prefix = "compass-${var.env}-db-"
  description = "Compass RDS PostgreSQL"
  vpc_id      = var.vpc_id

  tags = {
    Name = "compass-${var.env}-db"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from application workloads only"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id
}

# aws_security_group.db (above) declares no egress rule at all, and Terraform
# removes the implicit allow-all that comes with a freshly created group — the
# database initiates nothing, so it gets no egress. This rule is the app SG's
# own egress: workloads reach the database and nothing else on this port.
resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = aws_security_group.app.id
  description                  = "PostgreSQL to the Compass database"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.db.id
}

# AWS API calls (Secrets Manager, S3, Bedrock) leave via the NAT instance from
# ADR-0001. Narrowed to 443 rather than allow-all, since nothing here needs
# anything else outbound.
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS to AWS APIs via the NAT instance"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Engine configuration ----------------------------------------------------

# rds.force_ssl already defaults to 1 on PostgreSQL 15+. Stated explicitly
# because IAM auth is meaningless over cleartext: the token is a bearer
# credential, and anything that can read it can use it for its full 15 minutes.
#
# name_prefix, not name: this group pairs with create_before_destroy below,
# and a fixed name breaks that pairing on any replacement (a family bump for a
# major-version upgrade, most likely) — the replacement would need to be
# created under the name the group being destroyed still holds, and RDS
# parameter group names are unique per account/region.
resource "aws_db_parameter_group" "main" {
  name_prefix = "compass-${var.env}-pg17-"
  family      = "postgres17"
  description = "Compass PostgreSQL 17"

  # rds.force_ssl is dynamic (verified live: ApplyType "dynamic" both at the
  # postgres17 engine default and on this group) — flipping it takes effect
  # immediately, no reboot needed. apply_method here is not about that,
  # though: the value we declare (1) equals the engine default, so RDS never
  # registers it as a real user override (describe-db-parameters --source
  # user returns empty; Source stays "system"), and AWS's read-back for an
  # unregistered dynamic parameter is "pending-reboot" regardless of what we
  # send. Declaring "immediate" here diverges from that read-back and never
  # converges — verified live. "pending-reboot" is the value that makes
  # `plan` go clean, for bookkeeping reasons that have nothing to do with a
  # reboot actually being required.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Six scanner findings on this resource are suppressed with reasons rather than
# left to fail every pull request. Each one is a real control being declined for
# a stated reason, and a suppression carrying that reason is worth more than a
# recurring red mark everyone learns to scroll past. Revisit every one of them
# before anything resembling production.
#
# tfsec:ignore:aws-rds-specify-backup-retention tfsec:ignore:aws-rds-enable-performance-insights
resource "aws_db_instance" "main" {
  # checkov:skip=CKV_AWS_293:Deletion protection off by design; scripts/teardown.sh must destroy this in one pass on the last day of the credit budget (COMPASS-38).
  # checkov:skip=CKV_AWS_157:Multi-AZ doubles the instance cost to buy an availability guarantee a dev environment does not need. Recorded in docs/SCALING.md.
  # checkov:skip=CKV_AWS_129:Log exports to CloudWatch cost per ingested GB. Deferred to COMPASS-29, which owns logging and dashboards.
  # checkov:skip=CKV_AWS_118:Enhanced monitoring bills per instance per month. Nothing here is being profiled yet.
  # checkov:skip=CKV_AWS_353:Performance Insights likewise. Same reasoning.
  # checkov:skip=CKV_AWS_226:Minor version pinned deliberately, so a plan stays reproducible instead of drifting when AWS patches the fleet. Wrong default for a long-lived instance.
  identifier     = "compass-${var.env}"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.master_username

  # RDS generates the master password and owns it in Secrets Manager, rotating
  # the secret in place. The alternative — random_password — would write a live
  # credential into the Terraform state file in S3, where it is neither rotated
  # nor auditable.
  manage_master_user_password = true

  # The point of the ticket.
  iam_database_authentication_enabled = true

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name

  # Single-AZ: this is a dev environment on a $100 credit, and Multi-AZ doubles
  # the instance cost to buy an availability guarantee nothing here needs.
  multi_az = false

  # Minimum viable backups. Retention 0 would switch off point-in-time recovery
  # entirely, which is a worse default to get used to than one day of it.
  backup_retention_period = 1
  copy_tags_to_snapshot   = true

  # Pinned minor version, so `plan` stays reproducible instead of drifting the
  # first time AWS patches the fleet. Revisit for anything longer-lived.
  auto_minor_version_upgrade = false

  # Costs money on top of the instance; nothing here is being profiled yet.
  performance_insights_enabled = false
  monitoring_interval          = 0

  # Deliberate, and the reason is teardown: scripts/teardown.sh must be able to
  # destroy this in one pass on the last day. Both of these would block it.
  # tfsec:ignore:aws-rds-enable-deletion-protection
  deletion_protection = false
  skip_final_snapshot = true

  apply_immediately = true
}

# --- IAM auth ----------------------------------------------------------------

# Permission to open a connection as the IAM-mapped database role. The resource
# ARN takes the instance's *resource id* (db-XXXXXXXX), not its identifier or
# database name.
#
# This policy is the durable artefact of the ticket. The throwaway probe
# function that proves the acceptance criteria attaches it; so does the real
# ingestion Lambda at COMPASS-11; so does the IRSA role at COMPASS-6. Only the
# trust policy differs between them.
data "aws_iam_policy_document" "db_connect" {
  statement {
    sid       = "RdsIamAuthConnect"
    effect    = "Allow"
    actions   = ["rds-db:connect"]
    resources = ["arn:aws:rds-db:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.main.resource_id}/${var.iam_db_username}"]
  }
}

resource "aws_iam_policy" "db_connect" {
  name        = "compass-${var.env}-db-connect"
  description = "Open a PostgreSQL connection as ${var.iam_db_username} using an IAM auth token"
  policy      = data.aws_iam_policy_document.db_connect.json
}
