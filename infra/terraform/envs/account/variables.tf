variable "region" {
  description = "Home region for account-wide resources. The CloudTrail trail is multi-region regardless; this only decides where it is administered and where its bucket lives."
  type        = string
  default     = "eu-west-1"
}
