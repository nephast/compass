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
