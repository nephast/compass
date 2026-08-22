# modules/eks

Implements ADR-0003. Build order:

1. EKS cluster control plane in the VPC's private subnets.
2. OIDC identity provider for the cluster (this is what makes IRSA possible).
3. Node group (managed, small — e.g. 2x `t3.medium` spot, or on-demand if spot interruptions get annoying during a demo) **or** Fargate profiles for the pods, skipping node management entirely. Decide, then add a follow-up note to ADR-0003 explaining which you picked and why — both are defensible, the point is having a reason.
4. `aws-auth` ConfigMap (or access entries, the newer EKS API) mapping your IAM user/role to `system:masters` for `kubectl` access.

**Outputs to expose:** `cluster_name`, `cluster_endpoint`, `oidc_provider_arn`, `cluster_security_group_id`.

**Before you build anything on top of this:** confirm `kubectl get nodes` works and note the exact command you ran in `docs/runbooks/local-development.md` — future-you (or an interviewer asking "how do you access this cluster") will want it.
