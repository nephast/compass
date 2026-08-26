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
