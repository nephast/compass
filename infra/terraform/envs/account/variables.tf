variable "region" {
  description = "Home region for account-wide resources. The CloudTrail trail is multi-region regardless; this only decides where it is administered and where its bucket lives."
  type        = string
  default     = "eu-west-1"
}

variable "alert_email" {
  description = "Where security alerts go. Set in an untracked terraform.tfvars, never in the repo."
  type        = string
  default     = null
}

variable "github_repository" {
  description = "Repository whose workflows may assume the CI roles."
  type        = string
  default     = "nephast/compass"
}

variable "state_bucket" {
  description = "Terraform state bucket name (same value as backend.tf). Set in terraform.tfvars."
  type        = string
}
