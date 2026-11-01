variable "env" {
  description = "Environment name; used in resource names and the Environment tag."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "AWS region for all resources in this environment."
  type        = string
  default     = "eu-west-1"
}

variable "enable_interface_endpoints" {
  description = "ECR/Logs/Secrets Manager interface endpoints (~$64/month). See modules/vpc."
  type        = bool
  default     = false
}

variable "eks_public_access_cidrs" {
  description = "CIDRs allowed to reach the EKS public API endpoint. Set to your IP/32 in terraform.tfvars."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ci_deploy_role_arn" {
  description = "CI deploy role (envs/account output) granted edit on the compass namespace. Set in terraform.tfvars."
  type        = string
  default     = null
}
