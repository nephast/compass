output "listener_arn" {
  description = "ALB listener the API Gateway VPC Link integration targets."
  value       = aws_lb_listener.http.arn
}

output "vpc_link_security_group_id" {
  description = "Security group CDK attaches to the VPC Link."
  value       = aws_security_group.vpc_link.id
}

output "targets_security_group_id" {
  description = "Security group attached to nodes so the ALB can reach the NodePort."
  value       = aws_security_group.targets.id
}

output "alb_arn_suffix" {
  description = "For CloudWatch ALB metrics (dashboard)."
  value       = aws_lb.internal.arn_suffix
}

output "target_group_arn_suffix" {
  description = "For CloudWatch target-group metrics (dashboard)."
  value       = aws_lb_target_group.api.arn_suffix
}
