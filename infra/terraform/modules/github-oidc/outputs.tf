output "plan_role_arn" {
  description = "Set as the AWS_CI_PLAN_ROLE_ARN repository secret."
  value       = aws_iam_role.plan.arn
}

output "deploy_role_arn" {
  description = "Set as the AWS_CI_ROLE_ARN repository secret."
  value       = aws_iam_role.deploy.arn
}
