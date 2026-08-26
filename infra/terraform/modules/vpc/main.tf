# VPC per ADR-0001. Public subnets hold the NAT instance and future load
# balancers; private subnets hold EKS nodes and RDS, and never get public IPs.

resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr

  # Both required for EKS: nodes register in the cluster by private DNS name,
  # and the VPC endpoints in ADR-0001 resolve to private IPs only if DNS
  # hostnames + resolution are on.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "compass-${var.env}"
  }
}

# The door to the internet. Free to create; only the route tables that point
# at it decide who actually gets to use it.
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "compass-${var.env}-igw"
  }
}

# --- Subnets -----------------------------------------------------------------

resource "aws_subnet" "public_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidrs[0]
  availability_zone = var.azs[0]

  # Anything launched here gets an auto-assigned public IP. This is the flag
  # the COMPASS-5 acceptance criteria checks is *absent* on private subnets.
  map_public_ip_on_launch = true

  tags = {
    Name = "compass-${var.env}-public-${var.azs[0]}"

    # Consumed by the AWS Load Balancer Controller in a later epic: it looks
    # for this tag to decide where to put internet-facing load balancers.
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidrs[1]
  availability_zone = var.azs[1]

  map_public_ip_on_launch = true

  tags = {
    Name = "compass-${var.env}-public-${var.azs[1]}"

    "kubernetes.io/role/elb" = "1"
  }

}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[0]
  availability_zone = var.azs[0]

  map_public_ip_on_launch = false

  tags = {
    Name = "compass-${var.env}-private-${var.azs[0]}"

    "kubernetes.io/role/internal-elb" = "1"
  }

}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[1]
  availability_zone = var.azs[1]

  map_public_ip_on_launch = false

  tags = {
    Name = "compass-${var.env}-private-${var.azs[1]}"

    "kubernetes.io/role/internal-elb" = "1"
  }

}

# --- Route tables ------------------------------------------------------------
# A subnet is public purely because its route table sends 0.0.0.0/0 to the IGW.
# Routes are separate aws_route resources rather than inline `route` blocks:
# the two styles cannot be mixed on one table, and the private tables gain a
# NAT route in a later step.

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "compass-${var.env}-public"
  }
}

# "Everything not inside this VPC goes out of the front door."
resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

# Without an association a subnet silently falls back to the VPC's default
# "main" route table. Associate all four explicitly, always.
resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private_a" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "compass-${var.env}-private-a"
  }
}

resource "aws_route_table" "private_b" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "compass-${var.env}-private-b"
  }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private_a.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private_b.id
}

# --- NAT instance ------------------------------------------------------------

# Resolved from AWS's published parameter, never hardcoded — AMI IDs rotate
# as AWS patches them. x86_64, not arm64/t4g: this account has AWS's
# "Free Tier eligible instance types only" guardrail on, which t4g.nano
# fails (InvalidParameterCombination on RunInstances). ADR-0001 already
# anticipated this ("t4g.nano is ~$3/mo, or free-tier eligible depending on
# instance type/region") — t3.micro is free-tier eligible and $0/mo here.
data "aws_ssm_parameter" "al2023_x86_64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_security_group" "nat" {
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = var.private_subnet_cidrs
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "compass-${var.env}-nat" }
}

resource "aws_instance" "nat" {
  ami                    = data.aws_ssm_parameter.al2023_x86_64.value
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.public_a.id
  vpc_security_group_ids = [aws_security_group.nat.id]

  # NAT forwards packets that are neither sourced from nor destined to this
  # instance. AWS drops that traffic by default as an anti-spoofing measure;
  # this opts the instance out of that check.
  source_dest_check = false

  # Refuse the unauthenticated IMDSv1 path (plain GET to 169.254.169.254);
  # require a session token first.
  metadata_options {
    http_tokens = "required"
  }
  user_data = local.user_data

  tags = { Name = "compass-${var.env}-nat" }
}

# cloud-init script, run once on first boot. The security group and
# source_dest_check only handle admission at the AWS layer; the kernel still
# has to actually forward and masquerade packets — that's what this does.
locals {
  user_data = <<-EOF
    #!/bin/bash
    set -euo pipefail

    # Enable IP Forwarding
    echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
    sysctl -p /etc/sysctl.conf

    # Identify primary network interface
    PRIMARY_IF=$(ip -4 route list 0/0 | awk '{print $5}')

    # Install iptables-services for persistence on AL2023
    dnf install -y iptables-services || yum install -y iptables-services

    # Configure NAT masquerading
    iptables -t nat -A POSTROUTING -o "$PRIMARY_IF" -j MASQUERADE
    iptables -A FORWARD -i "$PRIMARY_IF" -m state --state RELATED,ESTABLISHED -j ACCEPT
    iptables -A FORWARD -o "$PRIMARY_IF" -j ACCEPT

    # Save rules directly with iptables-save, not `service iptables save` --
    # the `service` command needs the separate initscripts package, which
    # iptables-services does not pull in. Without this, rules apply live but
    # silently vanish on the next reboot (iptables.service asserts this path
    # exists before it will start).
    iptables-save > /etc/sysconfig/iptables
    systemctl enable --now iptables
  EOF
}

# Target is the NAT instance's ENI, not its instance ID. AWS resolves an
# instance-ID target to whatever ENI was primary at creation time; if the
# instance is ever replaced, a route pinned to the old instance can be left
# blackholed. Pointing at the ENI attribute gives Terraform a direct
# dependency, so a replacement updates the route in the same apply.
resource "aws_route" "private_a_nat" {
  route_table_id         = aws_route_table.private_a.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat.primary_network_interface_id
}

resource "aws_route" "private_b_nat" {
  route_table_id         = aws_route_table.private_b.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat.primary_network_interface_id
}

# --- S3 gateway endpoint -----------------------------------------------------

data "aws_region" "current" {}

# Free, unlike interface endpoints (hourly + per-AZ ENI cost) -- a gateway
# endpoint is just a route table entry AWS manages, pointing S3-bound traffic
# here instead of out through the NAT instance. Attaches to route tables, not
# subnets: it works by injecting a route for S3's IP prefix list, not by
# being a network target with its own IP.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private_a.id, aws_route_table.private_b.id]
}
