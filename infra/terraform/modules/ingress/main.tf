# The path from API Gateway into the cluster (COMPASS-18):
#
#   API Gateway HTTP API --VPC Link--> internal ALB :80 --> node :30080 (NodePort)
#     --> kube-proxy --> api pod :8080
#
# Built here rather than by the AWS Load Balancer Controller. The controller
# is the idiomatic answer (Ingress objects, IP targets straight to pods), but
# it is one more in-cluster component with its own IAM role and upgrade cycle,
# and its ALB would be created by Kubernetes -- invisible to Terraform, so the
# listener ARN CDK needs for the VPC Link could not be published to SSM. The
# cost of this shape is one extra hop (node -> pod via kube-proxy). Recorded
# in docs/SCALING.md as the thing to change when traffic grows.

resource "aws_security_group" "vpc_link" {
  # checkov:skip=CKV2_AWS_5:Attached by CDK's VPC Link (published to SSM), not here.
  name_prefix = "compass-${var.env}-vpclink-"
  description = "API Gateway VPC Link ENIs"
  vpc_id      = var.vpc_id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_alb" {
  security_group_id            = aws_security_group.vpc_link.id
  description                  = "To the internal ALB only"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group" "alb" {
  name_prefix = "compass-${var.env}-alb-"
  description = "Internal ALB in front of the api NodePort"
  vpc_id      = var.vpc_id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_vpc_link" {
  # checkov:skip=CKV_AWS_260:False positive: the source is the VPC Link security group, not 0.0.0.0/0.
  security_group_id            = aws_security_group.alb.id
  description                  = "HTTP from the API Gateway VPC Link only"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.vpc_link.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_nodes" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the api NodePort on the nodes"
  ip_protocol                  = "tcp"
  from_port                    = var.node_port
  to_port                      = var.node_port
  referenced_security_group_id = aws_security_group.targets.id
}

# Attach point for the nodes (passed to modules/eks): admits the ALB on the
# NodePort and nothing else.
resource "aws_security_group" "targets" {
  # checkov:skip=CKV2_AWS_5:Attached to the EKS nodes via modules/eks's launch template, outside this module.
  name_prefix = "compass-${var.env}-ingress-targets-"
  description = "Nodes reachable from the internal ALB on the api NodePort"
  vpc_id      = var.vpc_id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "targets_from_alb" {
  security_group_id            = aws_security_group.targets.id
  description                  = "api NodePort from the internal ALB"
  ip_protocol                  = "tcp"
  from_port                    = var.node_port
  to_port                      = var.node_port
  referenced_security_group_id = aws_security_group.alb.id
}

# tfsec:ignore:aws-elb-alb-not-public
resource "aws_lb" "internal" {
  # checkov:skip=CKV_AWS_91:ALB access logs need a log bucket and bill per GB; API Gateway access logs (CDK) already record every request that can reach this internal ALB.
  # checkov:skip=CKV_AWS_150:Deletion protection off so teardown completes in one pass.
  # checkov:skip=CKV2_AWS_20:No HTTPS listener exists to redirect to; internal hop, see the listener comment.
  # checkov:skip=CKV2_AWS_28:WAF sits at the edge (CloudFront); this ALB is internal and reachable only from the VPC Link SG.
  name                       = "compass-${var.env}-internal"
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = var.private_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  idle_timeout               = 120 # agent requests can take a while
}

resource "aws_lb_target_group" "api" {
  # checkov:skip=CKV_AWS_378:Internal hop behind API Gateway's TLS; see the listener comment.
  name        = "compass-${var.env}-api"
  port        = var.node_port
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = var.vpc_id

  # Short deregistration delay: a node leaving the group during a scale-in
  # should drain in seconds, not the 300s default.
  deregistration_delay = 30

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

# Internal plaintext HTTP, deliberately: TLS terminates at API Gateway, and
# this hop never leaves the VPC. HTTPS here would need a private CA ($400/mo)
# or a public cert for an internal name. Listed in docs/SCALING.md.
# tfsec:ignore:aws-elb-http-not-used
resource "aws_lb_listener" "http" {
  # checkov:skip=CKV_AWS_2:Internal hop behind API Gateway's TLS; see comment.
  # checkov:skip=CKV_AWS_103:As above.
  # checkov:skip=CKV2_AWS_20:As above.
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_autoscaling_attachment" "api" {
  # checkov:skip=CKV2_AWS_15:The ASG is owned by the EKS managed node group, which manages node health itself; ELB health checks would let a pod-level failure terminate a healthy node.
  count                  = var.node_group_asg_name == null ? 0 : 1
  autoscaling_group_name = var.node_group_asg_name
  lb_target_group_arn    = aws_lb_target_group.api.arn
}
