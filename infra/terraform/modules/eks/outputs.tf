output "cluster_name" {
  description = "EKS cluster name, for `aws eks update-kubeconfig --name`."
  value       = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_security_group_id" {
  description = "EKS-managed cluster security group (control plane <-> nodes)."
  value       = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

output "oidc_provider_arn" {
  description = "IRSA: the federated principal in every pod role's trust policy."
  value       = aws_iam_openid_connect_provider.cluster.arn
}

output "oidc_issuer" {
  description = "IRSA: issuer host (no https://) used as the condition-key prefix."
  value       = replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")
}

output "node_group_asg_name" {
  description = "Auto Scaling group behind the node group; the ingress target group attaches here."
  value       = aws_eks_node_group.main.resources[0].autoscaling_groups[0].name
}
