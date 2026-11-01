variable "repository" {
  description = "GitHub repository allowed to assume the CI roles, as owner/name."
  type        = string
  default     = "nephast/compass"
}

variable "permissions_boundary_arn" {
  description = "Boundary applied to both CI roles (COMPASS-8)."
  type        = string
}

variable "state_bucket" {
  description = "S3 bucket holding Terraform state (docs/runbooks/terraform-bootstrap.md)."
  type        = string
}
