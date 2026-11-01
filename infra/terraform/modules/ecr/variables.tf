variable "services" {
  description = "One repository per service, named compass-<service>."
  type        = list(string)
  default     = ["api", "agent-tools"]
}
