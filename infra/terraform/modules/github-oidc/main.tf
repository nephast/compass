# GitHub Actions -> AWS with no stored credentials (docs/runbooks/ci-aws-auth.md).
# Two roles, split by blast radius:
#
#   compass-ci-plan    any PR in this repo        read-only: terraform plan, cdk diff
#   compass-ci-deploy  main branch + environments push images, cdk deploy, kubectl
#
# Both carry the permissions boundary, so neither can mint itself more power.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # No thumbprint_list: IAM verifies GitHub's certificate against its own
  # trusted CA store for this provider, and the thumbprint is ignored.
}

data "aws_iam_policy_document" "trust_plan" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # pull_request runs only. A fork PR never reaches this: fork workflows get
    # no id-token, and infra-plan.yml has an explicit fork guard (#59).
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:pull_request"]
    }
  }
}

data "aws_iam_policy_document" "trust_deploy" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Jobs bound to a GitHub Environment present `environment:<name>` as the
    # subject; prod additionally needs a reviewer's click before the job (and
    # so this token) exists at all.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.repository}:ref:refs/heads/main",
        "repo:${var.repository}:environment:dev",
        "repo:${var.repository}:environment:prod",
      ]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = "compass-ci-plan"
  assume_role_policy   = data.aws_iam_policy_document.trust_plan.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan_extra" {
  # terraform plan needs the state lock; cdk diff needs CDK's lookup role.
  statement {
    sid       = "TerraformStateLock"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:${local.partition}:s3:::${var.state_bucket}/*.tflock"]
  }
  statement {
    sid       = "CdkLookup"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/cdk-*-lookup-role-${local.account_id}-*"]
  }
}

resource "aws_iam_role_policy" "plan_extra" {
  name   = "plan-extra"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan_extra.json
}

resource "aws_iam_role" "deploy" {
  name                 = "compass-ci-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust_deploy.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  # CDK deploys through its bootstrap roles; CI never holds CloudFormation
  # rights directly, so a deploy is bounded by what the bootstrap's execution
  # role may do -- see infra/cdk/README.md.
  statement {
    sid       = "CdkBootstrapRoles"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/cdk-*-${local.account_id}-*"]
  }
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
      "ecr:DescribeImages", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = ["arn:${local.partition}:ecr:${local.region}:${local.account_id}:repository/compass-*"]
  }
  statement {
    sid       = "EksDescribe"
    actions   = ["eks:DescribeCluster"]
    resources = ["arn:${local.partition}:eks:${local.region}:${local.account_id}:cluster/compass-*"]
  }
  statement {
    sid       = "ReadSeamParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = ["arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter/compass/*"]
  }
  statement {
    sid       = "SmokeTestUser"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:compass/*/smoke-test-*"]
  }
  statement {
    sid       = "CognitoSmokeLogin"
    actions   = ["cognito-idp:AdminInitiateAuth"]
    resources = ["arn:${local.partition}:cognito-idp:${local.region}:${local.account_id}:userpool/*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
