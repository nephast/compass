variable "trail_name" {
  description = "Name of the CloudTrail trail. Forms part of the trail ARN used to scope the bucket policy's aws:SourceArn condition, so changing it replaces both."
  type        = string
  default     = "compass-management-events"
}

variable "retention_days" {
  description = "Days to retain log objects before lifecycle expiry. See the rationale in main.tf before shortening this — anything at or below 90 buys nothing over free CloudTrail Event History."
  type        = number
  default     = 365

  validation {
    condition     = var.retention_days > 90
    error_message = "Retention must exceed 90 days; below that, free Event History already covers the window and the trail earns only its multi-region aggregation."
  }
}
