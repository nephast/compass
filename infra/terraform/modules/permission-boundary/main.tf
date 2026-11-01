# The permissions boundary (COMPASS-8). Every IAM role this project creates --
# by Terraform, by CDK, for CI -- carries it. A boundary does not GRANT
# anything; it caps what a role's own policies can ever grant. So a
# misconfigured IaC run, or a compromised CI token, that attaches
# AdministratorAccess to a bounded role still ends up with at most this.
#
# Shape: a broad Allow over the services Compass actually uses, then Denies
# that close the privilege-escalation paths. The Allow is coarse on purpose --
# least privilege is each role's own policy's job (COMPASS-33); the boundary's
# job is to make escalation impossible, which the Denies do.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:policy/${var.name}"
}

data "aws_iam_policy_document" "boundary" {
  # tfsec:ignore:aws-iam-no-policy-wildcards
  statement {
    sid    = "ServicesCompassUses"
    effect = "Allow"
    # checkov's wildcard checks flag this by design: a boundary is a ceiling,
    # and the ceiling is "these services", not "these actions on these ARNs".
    actions = [
      "acm:*", "apigateway:*", "application-autoscaling:*", "autoscaling:*", "bedrock:*",
      "ce:Get*", "ce:Describe*", "cloudformation:*", "cloudfront:*", "cloudwatch:*",
      "cognito-idp:*", "dynamodb:*", "ec2:*", "ecr:*", "eks:*", "elasticloadbalancing:*",
      "events:*", "kms:*", "lambda:*", "logs:*", "rds:*", "rds-db:connect", "s3:*",
      "secretsmanager:*", "sns:*", "sqs:*", "ssm:*", "states:*", "sts:AssumeRole",
      "sts:AssumeRoleWithWebIdentity", "sts:GetCallerIdentity", "sts:TagSession", "tag:*",
      "wafv2:*", "xray:*", "iam:*",
    ]
    resources = ["*"]
  }

  # --- Escalation paths, closed -------------------------------------------

  # The acceptance test: a bounded principal attaching AdministratorAccess is
  # denied outright (not merely ineffective).
  statement {
    sid       = "NoAdministratorAccess"
    effect    = "Deny"
    actions   = ["iam:AttachRolePolicy", "iam:AttachUserPolicy", "iam:AttachGroupPolicy"]
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/AdministratorAccess",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/IAMFullAccess",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/PowerUserAccess",
      ]
    }
  }

  # A role created by a bounded principal must carry THIS boundary, or it
  # would be an unbounded role minted by a bounded one -- the classic escape.
  statement {
    sid       = "NewRolesMustBeBounded"
    effect    = "Deny"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }

  # Policies may only be added to roles that are themselves bounded.
  statement {
    sid    = "OnlyEditBoundedRoles"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
    ]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }

  statement {
    sid    = "BoundaryIsImmutableFromInside"
    effect = "Deny"
    actions = [
      "iam:DeleteRolePermissionsBoundary", "iam:DeleteUserPermissionsBoundary",
      "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
    ]
    resources = [local.boundary_arn]
  }

  statement {
    sid       = "NoRemovingBoundaries"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary", "iam:DeleteUserPermissionsBoundary"]
    resources = ["*"]
  }

  # Humans and long-lived keys are out of scope for anything automated.
  statement {
    sid    = "NoUsersOrKeys"
    effect = "Deny"
    actions = [
      "iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile",
      "iam:UpdateLoginProfile", "iam:AddUserToGroup",
    ]
    resources = ["*"]
  }

  # The audit trail and the budget alarms are not this project's to change
  # from an automated role (#55, ADR-0005).
  statement {
    sid    = "ProtectAuditAndBilling"
    effect = "Deny"
    actions = [
      "cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail",
      "cloudtrail:PutEventSelectors", "budgets:ModifyBudget", "budgets:DeleteBudgetAction",
      "organizations:*", "account:*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = var.name
  description = "Permissions boundary for every role Compass creates (COMPASS-8)"
  policy      = data.aws_iam_policy_document.boundary.json
}
