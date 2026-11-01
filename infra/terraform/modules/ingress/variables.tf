variable "env" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "node_port" {
  description = "NodePort the api Service exposes (infra/k8s/base/api/service.yaml must match)."
  type        = number
  default     = 30080
}

variable "node_group_asg_name" {
  description = "Node group ASG to register as ALB targets."
  type        = string
  default     = null
}
