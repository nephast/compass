# Resolved dynamically rather than hardcoded, same principle as the NAT
# instance's AMI lookup: stays correct if var.region ever changes, instead of
# silently referencing AZ names from the old region.
data "aws_availability_zones" "available" {
  state = "available"
}

module "vpc" {
  source = "../../modules/vpc"

  env = var.env
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}
