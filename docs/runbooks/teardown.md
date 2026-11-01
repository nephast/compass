# Runbook: teardown (COMPASS-38)

Run at the end of **every** session that doesn't need things running overnight.
The full stack costs ~$5/day; a forgotten weekend is a sixth of the credit.

## 1. Run it

```bash
scripts/teardown.sh          # asks you to type 'teardown'
```

What it does, in order, and why the order matters:

1. **`cdk destroy --all`** (both regions): API Gateway + VPC Link, Lambda, Step
   Functions, Cognito, CloudFront, WAF, buckets (auto-emptied), IRSA roles. First,
   because the VPC Link's and the Lambda's network interfaces sit in Terraform's
   subnets and would block deleting them.
2. **Waits for Lambda's VPC network interfaces to be released.** AWS frees a deleted
   function's interfaces asynchronously, and it can take 20+ minutes. Destroying the
   subnets before then fails with `DependencyViolation`.
3. **`terraform destroy` in `envs/dev`**: EKS (cluster, nodes, add-ons), ALB, RDS
   (no final snapshot, by design), ECR (force-deleted with images), NAT instance, VPC.
   ~15 minutes, mostly EKS.
4. **`envs/account` is deliberately NOT destroyed**: CloudTrail, the permissions
   boundary and the CI roles cost ~$0 and must survive (ADR-0005).
5. Runs **`scripts/verify-teardown.sh`**, which lists anything billable that's left.

## 2. Confirm in the console (not just the exit code)

`verify-teardown.sh` checks these through the API; still look once in the console:

- [ ] **EKS**: no clusters. The control plane bills regardless of node count.
- [ ] **EC2 → Instances**: NAT instance and nodes *terminated*, not stopped (stopped still bills EBS).
- [ ] **EC2 → Load balancers**: none.
- [ ] **RDS**: no instances.
- [ ] **VPC → Endpoints**: no *Interface* endpoints. **NAT gateways**: none. **Elastic IPs**: none.
- [ ] **CloudFront / WAF (us-east-1)**: gone.
- [ ] **AWS Budgets**: spend flat by tomorrow.
- [ ] **CloudTrail**: the trail is **still there**. If it's missing, re-apply `envs/account`.

## 3. If something is stuck

| Error | Cause | Fix |
|---|---|---|
| `DependencyViolation` on a subnet or security group | Lambda/VPC Link interfaces not yet released | wait 10 minutes, re-run `terraform destroy` |
| `DeleteConflict` on `compass-dev-db-connect` | a role outside dev state still attaches it | fixed by #52 (the policy no longer depends on the instance); detach by hand if it recurs |
| CDK `DELETE_FAILED` on a bucket | objects added after deploy | `aws s3 rm s3://<bucket> --recursive`, re-run |
| EKS add-on deletion hangs | node group already gone | `aws eks delete-addon …` by hand, re-run |

## Session log

Track when things were torn down and stood up again. It feeds the cost report (COMPASS-37).

| Date | Action | Notes |
|------|--------|-------|
| | | |
