output "eks_cluster_name" {
  description = "aws eks update-kubeconfig --name <this>"
  value       = module.eks.cluster_name
}

output "ecr_registry" {
  description = "Repository variable ECR_REGISTRY."
  value       = module.ecr.registry
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}
