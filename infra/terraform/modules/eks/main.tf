# EKS for the api and agent-tools services (ADR-0003, COMPASS-6).
#
# Managed node group over Fargate -- the follow-up decision ADR-0003 asked
# for, recorded there. Short version: the internal ALB reaches pods through a
# NodePort on the node group's Auto Scaling group (modules/ingress), which
# Fargate cannot offer without the AWS Load Balancer Controller, and DaemonSets
# (the CloudWatch agent, Fluent Bit) do not run on Fargate at all.

data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
  name      = "compass-${var.env}"
}

# --- Cluster IAM -------------------------------------------------------------

data "aws_iam_policy_document" "cluster_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name                 = "${local.name}-eks-cluster"
  assume_role_policy   = data.aws_iam_policy_document.cluster_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

# Envelope encryption of Kubernetes Secrets in etcd. $1/month for the key;
# without it, a Secret is base64 in the control plane's storage. Compass keeps
# its real secrets in Secrets Manager, so this is defence in depth -- cheap
# enough to not argue about (CKV_AWS_58).
data "aws_caller_identity" "current" {}

# The default key policy, stated explicitly (CKV2_AWS_64): the account's IAM
# policies decide who may use the key. EKS uses it through the cluster role.
data "aws_iam_policy_document" "secrets_key" {
  # checkov:skip=CKV_AWS_109:This is AWS's default key policy: delegate to the account's IAM policies. "*" in a key policy means "this key".
  # checkov:skip=CKV_AWS_111:As above.
  # checkov:skip=CKV_AWS_356:As above.
  statement {
    sid       = "AccountIamDecides"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "secrets" {
  description             = "${local.name} EKS secrets envelope encryption"
  policy                  = data.aws_iam_policy_document.secrets_key.json
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

# Control-plane logs: audit and authenticator only. They answer "who did what
# to the cluster" and "who failed to authenticate"; api/scheduler/controller
# logs are high-volume and billed per GB ingested.
resource "aws_cloudwatch_log_group" "cluster" {
  # checkov:skip=CKV_AWS_158:Log group KMS encryption would need a CMK key policy for CloudWatch Logs; audit events here are already in CloudTrail-protected storage elsewhere. Default SSE applies.
  # checkov:skip=CKV_AWS_338:Seven days, not a year: this is a dev cluster torn down nightly; CloudTrail (365 days) is the long-term record of who changed what.
  name              = "/aws/eks/${local.name}/cluster"
  retention_in_days = 7
}

resource "aws_eks_cluster" "main" {
  # checkov:skip=CKV_AWS_39:Public endpoint kept so kubectl and CI work without a VPN or bastion; restricted by var.public_access_cidrs and IAM. Private endpoint is also on, so nodes never leave the VPC to reach it.
  # checkov:skip=CKV_AWS_38:See CKV_AWS_39 -- the CIDR list is variable, default documented in variables.tf.
  # checkov:skip=CKV_AWS_339:checkov's supported-version list lags EKS releases; var.kubernetes_version is chosen against `aws eks describe-cluster-versions` (see variables.tf).
  # checkov:skip=CKV_AWS_37:Only audit + authenticator logs enabled, deliberately (cost); see the log group above.
  name     = local.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.public_access_cidrs
  }

  # Access entries (the EKS API) rather than the aws-auth ConfigMap: access is
  # managed by IAM-side resources Terraform can see, instead of a YAML file in
  # the cluster that one bad `kubectl edit` can lock everyone out of.
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = aws_kms_key.secrets.arn
    }
  }

  enabled_cluster_log_types = ["audit", "authenticator"]

  depends_on = [aws_iam_role_policy_attachment.cluster, aws_cloudwatch_log_group.cluster]
}

# --- IRSA --------------------------------------------------------------------

# The OIDC provider is what lets a Kubernetes service account token be
# exchanged for an IAM role (IRSA). Without it, the only AWS identity a pod
# has is the node's -- shared by every pod on the node.
resource "aws_iam_openid_connect_provider" "cluster" {
  url            = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list = ["sts.amazonaws.com"]
}

# --- Access for CI -----------------------------------------------------------

# CI's deploy role may update Deployments in the compass namespace and nothing
# else -- not cluster-admin.
resource "aws_eks_access_entry" "ci" {
  count         = var.ci_deploy_role_arn == null ? 0 : 1
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = var.ci_deploy_role_arn
}

resource "aws_eks_access_policy_association" "ci" {
  count         = var.ci_deploy_role_arn == null ? 0 : 1
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = var.ci_deploy_role_arn
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"

  access_scope {
    type       = "namespace"
    namespaces = ["compass"]
  }

  depends_on = [aws_eks_access_entry.ci]
}

# --- Nodes -------------------------------------------------------------------

data "aws_iam_policy_document" "node_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name                 = "${local.name}-eks-node"
  assume_role_policy   = data.aws_iam_policy_document.node_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

# The node role is deliberately thin: join the cluster, run the VPC CNI, pull
# from ECR. Application permissions live on IRSA roles (CDK), and the launch
# template's IMDS hop limit stops pods from borrowing even this much.
#
# The CNI policy stays on the node role rather than its own IRSA role: the
# aws-node DaemonSet is the only consumer, and splitting it out buys little
# while pods already cannot reach IMDS. Noted as a COMPASS-33 exception.
resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "AmazonEKSWorkerNodePolicy",
    "AmazonEKS_CNI_Policy",
    "AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}"
}

resource "aws_launch_template" "node" {
  name_prefix = "${local.name}-node-"

  # Hop limit 1 is the single most important line in this module. IMDSv2's
  # PUT response cannot cross a second network hop, and a pod's network
  # namespace is that hop -- so no pod can fetch the node role's credentials.
  # Without it, IRSA is advisory: any pod could ignore its service account and
  # act as the node instead.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # The cluster security group (control plane <-> node traffic) PLUS the two
  # attach points other modules publish: the database's app SG, so pods can
  # reach RDS on 5432 (COMPASS-13's deferred half), and the ingress target SG,
  # so the internal ALB can reach the NodePort.
  vpc_security_group_ids = concat(
    [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id],
    var.extra_node_security_group_ids,
  )

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-node" }
  }

  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${local.name}-node" }
  }
}

resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.name}-default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids

  instance_types = var.node_instance_types
  capacity_type  = var.node_capacity_type
  ami_type       = "AL2023_x86_64_STANDARD"

  scaling_config {
    min_size     = var.node_min_size
    desired_size = var.node_desired_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }

  depends_on = [aws_iam_role_policy_attachment.node]

  lifecycle {
    # The HPA and the cluster's own scaling own desired size after creation.
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# --- Add-ons -----------------------------------------------------------------

# Managed add-ons rather than self-installed manifests: AWS patches them, and
# their versions show up in `terraform plan` instead of drifting silently.
resource "aws_eks_addon" "core" {
  for_each = toset(["kube-proxy", "coredns", "metrics-server"])

  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = each.value
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.main]
}

# The VPC CNI with its network policy agent switched on: without it,
# NetworkPolicy objects (infra/k8s/base/network-policies.yaml) are accepted by
# the API server and silently enforce nothing.
resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  configuration_values        = jsonencode({ enableNetworkPolicy = "true" })

  depends_on = [aws_eks_node_group.main]
}

# CloudWatch Container Insights + Fluent Bit (COMPASS-29/30): node and pod
# metrics -- including cluster_failed_node_count, which the "node not ready"
# alarm watches -- and container stdout shipped to
# /aws/containerinsights/<cluster>/application. The agent gets its own IRSA
# role; it never uses the node role.
data "aws_iam_policy_document" "cloudwatch_agent_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.cluster.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:amazon-cloudwatch:cloudwatch-agent"]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudwatch_agent" {
  name                 = "${local.name}-cloudwatch-agent"
  assume_role_policy   = data.aws_iam_policy_document.cloudwatch_agent_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.cloudwatch_agent.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# Created here, before the add-on, so they carry a retention policy. Left to
# the agent, it creates them on first write with "Never expire" -- a slow,
# silent cost leak, and exactly the "sane retention" COMPASS-29 asks for.
resource "aws_cloudwatch_log_group" "container_insights" {
  # checkov:skip=CKV_AWS_158:Default SSE; a CMK would need a key policy for CloudWatch Logs and bills per request.
  # checkov:skip=CKV_AWS_338:Seven days for a nightly-torn-down dev cluster; the dashboard's questions are about the last hour.
  for_each          = toset(["application", "dataplane", "host", "performance"])
  name              = "/aws/containerinsights/${local.name}/${each.value}"
  retention_in_days = 7
}

resource "aws_eks_addon" "cloudwatch_observability" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "amazon-cloudwatch-observability"
  service_account_role_arn    = aws_iam_role.cloudwatch_agent.arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  # Enhanced observability bills per metric observation and is the line item
  # that surprises people; the basic Container Insights metrics are enough for
  # the dashboard and the node alarm. Application logs keep 7 days.
  configuration_values = jsonencode({
    agent = {
      config = {
        logs = {
          metrics_collected = {
            kubernetes = { enhanced_container_insights = false }
          }
        }
      }
    }
    containerLogs = { enabled = true }
  })

  depends_on = [aws_eks_node_group.main, aws_cloudwatch_log_group.container_insights]
}
