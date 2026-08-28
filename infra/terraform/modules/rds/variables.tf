variable "env" {
  description = "Environment name; used in resource names and the Name tag."
  type        = string
}

variable "vpc_id" {
  description = "VPC the database and its callers live in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs, one per AZ. RDS rejects a subnet group spanning fewer than two AZs, even for a single-AZ instance."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS requires a DB subnet group covering at least two availability zones."
  }
}

variable "db_name" {
  description = "Name of the initial database created on the instance."
  type        = string
  default     = "compass"
}

variable "master_username" {
  description = "Master user. Used only for bootstrap SQL (CREATE EXTENSION, GRANT rds_iam); never by the application."
  type        = string
  default     = "compass_admin"
}

variable "iam_db_username" {
  description = "Database role the application authenticates as, via an IAM auth token. Created by bootstrap SQL, not by Terraform."
  type        = string
  default     = "compass_app"
}

variable "iam_migrator_username" {
  description = "Database role migrations run as, via an IAM auth token. Holds DDL rights the application deliberately does not. Created by bootstrap SQL, not by Terraform."
  type        = string
  default     = "compass_migrator"
}

variable "instance_class" {
  description = "Instance class. db.t3.micro is free-tier eligible; this account has a guardrail rejecting anything that is not."
  type        = string
  default     = "db.t3.micro"
}

variable "engine_version" {
  description = "Exact PostgreSQL minor version. Pinned rather than tracking latest, so a plan is reproducible."
  type        = string
  default     = "17.11"
}

variable "allocated_storage" {
  description = "Storage in GiB. 20 is the gp3 minimum on RDS."
  type        = number
  default     = 20
}
