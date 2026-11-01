# Resolved dynamically rather than hardcoded, same principle as the NAT
# instance's AMI lookup: stays correct if var.region ever changes, instead of
# silently referencing AZ names from the old region.
data "aws_availability_zones" "available" {
  state = "available"
}

# Owned by envs/account (account-lifetime, survives teardown). Read by name
# from SSM -- the same seam CDK uses -- rather than a remote-state lookup, so
# this root never needs read access to the account root's state file.
data "aws_ssm_parameter" "permissions_boundary_arn" {
  name = "/compass/account/permissions_boundary_arn"
}

locals {
  permissions_boundary_arn = data.aws_ssm_parameter.permissions_boundary_arn.value
}

module "vpc" {
  source = "../../modules/vpc"

  env                        = var.env
  azs                        = slice(data.aws_availability_zones.available.names, 0, 2)
  enable_interface_endpoints = var.enable_interface_endpoints
}

module "rds" {
  source = "../../modules/rds"

  env        = var.env
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
}

module "ecr" {
  source = "../../modules/ecr"
}

module "ingress" {
  source = "../../modules/ingress"

  env                 = var.env
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  node_group_asg_name = module.eks.node_group_asg_name
}

module "eks" {
  source = "../../modules/eks"

  env                      = var.env
  private_subnet_ids       = module.vpc.private_subnet_ids
  public_access_cidrs      = var.eks_public_access_cidrs
  permissions_boundary_arn = local.permissions_boundary_arn
  ci_deploy_role_arn       = var.ci_deploy_role_arn
  # Pods reach RDS through the app SG (COMPASS-13's deferred half); the ALB
  # reaches the api NodePort through the ingress targets SG (COMPASS-18).
  extra_node_security_group_ids = [
    module.rds.app_security_group_id,
    module.ingress.targets_security_group_id,
  ]
}
