variable "name" {
  description = "Name of the boundary policy. Referenced by ARN from every Compass role."
  type        = string
  default     = "compass-permissions-boundary"
}
