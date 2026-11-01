# modules/eks

Implements ADR-0003 and COMPASS-6.

| Piece | Choice | Why |
|---|---|---|
| Compute | Managed node group, `t3.small` x2 on-demand | Free-Tier-only instance guardrail; NodePort + ASG attachment for the ALB; DaemonSets for Container Insights. See the ADR-0003 follow-up. |
| Auth | EKS access entries (`authentication_mode = "API"`) | No `aws-auth` ConfigMap to lock yourself out of. CI gets `AmazonEKSEditPolicy` on the `compass` namespace only. |
| Pod IAM | IRSA via the cluster OIDC provider; **IMDS hop limit 1** | Pods cannot reach the node role at all, so IRSA is enforced rather than advisory. |
| Secrets | KMS envelope encryption | $1/month. |
| Add-ons | vpc-cni, kube-proxy, coredns, metrics-server, amazon-cloudwatch-observability | Managed, versioned in plan. metrics-server feeds the HPA. |

## Access

```bash
aws eks update-kubeconfig --name compass-dev --region eu-west-1
kubectl get nodes
```

The identity that ran `terraform apply` is cluster admin
(`bootstrap_cluster_creator_admin_permissions`). Anyone else needs an access entry.

## Cost

Control plane **$0.10/hour (~$73/month)** from the moment it exists, plus two
`t3.small` (~$0.042/hour together). Run `scripts/teardown.sh` at the end of every session.
