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
