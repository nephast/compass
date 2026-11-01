output "trail_arn" {
  description = "ARN of the CloudTrail trail."
  value       = aws_cloudtrail.main.arn
}

output "trail_name" {
  description = "Name of the CloudTrail trail. Use with `aws cloudtrail get-trail-status` to check delivery health."
  value       = aws_cloudtrail.main.name
}

output "bucket_name" {
  description = "Name of the S3 bucket receiving log files."
  value       = aws_s3_bucket.trail.id
}

output "bucket_arn" {
  description = "ARN of the S3 bucket receiving log files."
  value       = aws_s3_bucket.trail.arn
}

output "tamper_topic_arn" {
  description = "SNS topic notified when the trail is stopped, deleted or reconfigured."
  value       = aws_sns_topic.trail_tamper.arn
}
