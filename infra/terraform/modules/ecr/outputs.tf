output "repository_urls" {
  description = "Map of service -> repository URL."
  value       = { for k, r in aws_ecr_repository.service : k => r.repository_url }
}

output "registry" {
  description = "Registry host (account.dkr.ecr.region.amazonaws.com) for the ECR_REGISTRY CI variable."
  value       = split("/", values(aws_ecr_repository.service)[0].repository_url)[0]
}
