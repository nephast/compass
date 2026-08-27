output "vpc_id" {
  description = "ID of the VPC. Consumed by modules/eks and, via SSM, by CDK."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the two public subnets, one per AZ."
  value       = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

output "private_subnet_ids" {
  description = "IDs of the two private subnets, one per AZ. Where EKS nodes and RDS live."
  value       = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}
