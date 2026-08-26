variable "env" {
  description = "Environment name; used in the Name tag of every resource."
  type        = string
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC. /16 leaves room for /20 subnets."
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "The two AZ names to spread subnets across. EKS requires >= 2."
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "One /20 per AZ, in the same order as var.azs."
  type        = list(string)
  default     = ["10.0.0.0/20", "10.0.16.0/20"]
}

variable "private_subnet_cidrs" {
  description = "One /20 per AZ, in the same order as var.azs."
  type        = list(string)
  default     = ["10.0.128.0/20", "10.0.144.0/20"]
}
