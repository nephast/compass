output "endpoint" {
  description = "Hostname of the database. Private DNS only; not resolvable outside the VPC."
  value       = aws_db_instance.main.address
}

output "port" {
  description = "Port the database listens on."
  value       = aws_db_instance.main.port
}

output "db_name" {
  description = "Name of the initial database."
  value       = aws_db_instance.main.db_name
}

output "resource_id" {
  description = "RDS resource id (db-XXXXXXXX). Used to build rds-db:connect ARNs and to generate auth tokens."
  value       = aws_db_instance.main.resource_id
}

output "iam_db_username" {
  description = "Database role the application authenticates as. Created by bootstrap SQL, not by Terraform."
  value       = var.iam_db_username
}

output "app_security_group_id" {
  description = "Attach point for workloads permitted to reach the database. Consumed by the ingestion Lambda (COMPASS-11) and the EKS node group (COMPASS-6)."
  value       = aws_security_group.app.id
}

output "db_connect_policy_arn" {
  description = "IAM policy granting rds-db:connect as the IAM-mapped role."
  value       = aws_iam_policy.db_connect.arn
}

output "iam_migrator_username" {
  description = "Database role migrations run as. Created by bootstrap SQL, not by Terraform."
  value       = var.iam_migrator_username
}

output "db_migrate_policy_arn" {
  description = "IAM policy granting rds-db:connect as the migration role (COMPASS-14)."
  value       = aws_iam_policy.db_migrate.arn
}

output "master_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master password. Bootstrap SQL only."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}
