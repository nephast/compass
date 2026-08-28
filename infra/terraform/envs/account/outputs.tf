output "trail_name" {
  description = "Name of the CloudTrail trail. Use with `aws cloudtrail get-trail-status` to check delivery health."
  value       = module.cloudtrail.trail_name
}

output "trail_arn" {
  description = "ARN of the CloudTrail trail."
  value       = module.cloudtrail.trail_arn
}

# Not published to SSM, unlike envs/dev. Nothing downstream consumes these —
# CDK has no reason to read the audit trail — so they exist for operators
# running `terraform output`, not as a cross-stack seam.
output "log_bucket_name" {
  description = "S3 bucket receiving CloudTrail log files."
  value       = module.cloudtrail.bucket_name
}
