# modules/vpc

Implements ADR-0001. Build order:

1. VPC + 2 public + 2 private subnets across 2 AZs.
2. Internet Gateway on the public route table.
3. S3 Gateway endpoint (free) associated with the private route tables.
4. Interface endpoints (ECR API, ECR DKR, CloudWatch Logs, Secrets Manager) in one AZ.
5. NAT instance (t4g.nano) in a public subnet — see ADR-0001 for exact config (source/dest check disabled, security group scoped to private subnet CIDRs only).
6. Private route tables: `0.0.0.0/0` → NAT instance ENI.

**Outputs to expose** (consumed by `modules/eks` and by CDK via SSM): `vpc_id`, `private_subnet_ids`, `public_subnet_ids`.
