output "arn" {
  description = "ARN of the permissions boundary policy."
  value       = aws_iam_policy.boundary.arn
}
