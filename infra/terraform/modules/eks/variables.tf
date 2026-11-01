variable "env" {
  description = "Environment name; used in resource names."
  type        = string
}

variable "kubernetes_version" {
  description = "EKS Kubernetes minor version. Check `aws eks describe-cluster-versions` -- a version in extended support bills six times the control-plane rate."
  type        = string
  default     = "1.35"
}

variable "private_subnet_ids" {
  description = "Subnets for the control-plane ENIs and the nodes. Two AZs minimum."
  type        = list(string)
}

variable "public_access_cidrs" {
  description = "CIDRs allowed to reach the public API endpoint. Narrow this to your own IP for anything long-lived; IAM still gates every request."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "permissions_boundary_arn" {
  description = "Boundary applied to every role this module creates (COMPASS-8)."
  type        = string
}

variable "ci_deploy_role_arn" {
  description = "CI deploy role granted edit on the compass namespace. Null to skip."
  type        = string
  default     = null
}

variable "extra_node_security_group_ids" {
  description = "Security groups attached to every node in addition to the cluster SG (database app SG, ingress target SG)."
  type        = list(string)
  default     = []
}

variable "node_instance_types" {
  description = "t3.small because this account enforces Free-Tier-eligible instance types (see modules/vpc). 2 GiB and 11 pods per node -- enough for two replicas of each service plus system pods across two nodes."
  type        = list(string)
  default     = ["t3.small"]
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT. Spot is ~60% cheaper; on-demand avoids interruptions mid-demo."
  type        = string
  default     = "ON_DEMAND"
}

variable "node_min_size" {
  type    = number
  default = 2
}

variable "node_desired_size" {
  type    = number
  default = 2
}

variable "node_max_size" {
  type    = number
  default = 3
}
