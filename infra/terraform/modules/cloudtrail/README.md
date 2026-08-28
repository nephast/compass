# modules/cloudtrail

Account-wide CloudTrail trail plus the S3 bucket that receives its log files.
Consumed by `envs/account`, **not** by `envs/dev` — see ADR-0005 for why the
state separation matters more than the module boundary.

## What it records

Management events only: control-plane API calls (`CreateDBInstance`,
`AssumeRole`, `DeleteBucket`, every IAM change) across **all** regions,
including global-service events emitted in us-east-1.

It does **not** record data events (`s3:GetObject`, `lambda:Invoke`). Those are
off by default and bill per event; the ingestion path in Epic 2 would generate
them continuously. Enable them only with a cost estimate in hand.

## What you already have without this

CloudTrail **Event History** is always on and free, retaining 90 days of
management events *per region*. This module adds: retention beyond 90 days,
all regions aggregated into one bucket, queryability (Athena, or plain `grep`
over S3), and tamper-evidence via signed digest files.

That framing matters when tuning `retention_days`: anything at or below 90 buys
only the aggregation, which is why the variable validates against it.

## Verifying delivery

Creation succeeding does not mean logs are arriving. A trail with a broken
bucket policy creates cleanly, reports healthy, and silently delivers nothing.

```bash
aws cloudtrail get-trail-status --name compass-management-events --region eu-west-1
```

Want `LatestDeliveryTime` present and `LatestDeliveryError` absent. First
delivery can take ~15 minutes, so an empty result immediately after apply is not
yet a failure — check once, do something else, check again.

## Gotchas encoded here

- **Two statements, two different ARNs.** `s3:GetBucketAcl` targets the bucket;
  `s3:PutObject` targets `<bucket>/AWSLogs/<account-id>/*`. Swapping them is the
  most common cause of silent delivery failure.
- **`s3:x-amz-acl = bucket-owner-full-control` is omitted, not forbidden.**
  AWS's current reference policy still includes it next to `aws:SourceArn`, and
  it works fine — CloudTrail sends the header, and that canned ACL is the one
  S3 still accepts on a `BucketOwnerEnforced` bucket. With ACLs disabled it
  simply asserts nothing, so it is dropped for simplicity. Do not "fix" its
  absence, and do not treat its presence elsewhere as a bug.
- **The trail ARN is composed by hand**, not read from `aws_cloudtrail.main.arn`.
  The trail `depends_on` the policy, so reading the ARN back off the trail adds
  the opposite edge and Terraform refuses to plan the cycle. Without the
  `depends_on` there would be no cycle — it is the price of correct ordering,
  not an inherent property of the resources.
- **`aws:SourceArn` is not optional.** Without it the policy lets any CloudTrail
  in any AWS account write here.
- **`depends_on` the bucket policy.** CloudTrail validates write access at
  creation time; a late policy means a failed first delivery and a backoff.

## Destroying this module

`force_destroy` is deliberately unset, so `terraform destroy` fails with
`BucketNotEmpty` once logs have been delivered. That is intended for an audit
log: destruction is a two-step, deliberate operation. Empty the bucket by hand
first, then destroy.

## Known gap

Nothing here detects the trail being stopped or deleted. There is no EventBridge
rule on `StopLogging`/`DeleteTrail`, no bucket versioning and no Object Lock, so
an ad-hoc deletion by a principal with the right permissions is silent until
someone runs `terraform plan`. See the Consequences section of ADR-0005; tracked
in issue #55 rather than fixed here.

## Inputs

| Name | Default | Notes |
|------|---------|-------|
| `trail_name` | `compass-management-events` | Part of the ARN used in the bucket policy; changing it replaces both resources |
| `retention_days` | `365` | Must exceed 90 (validated) |

## Outputs

`trail_arn`, `trail_name`, `bucket_name`, `bucket_arn`.
