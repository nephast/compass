# Account-wide CloudTrail, per COMPASS-1. Records management-plane API calls —
# who created, changed or deleted infrastructure, from where, and whether it
# succeeded — into an S3 bucket this module also owns.
#
# Lifecycle note: everything here is account-scoped and account-lifetime. It is
# deliberately NOT part of envs/dev, because `scripts/teardown.sh` destroys dev
# to stop the bill, and an audit log that is deleted every time the project is
# torn down is not an audit log. See ADR-0005.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  bucket_name = "compass-cloudtrail-${data.aws_caller_identity.current.account_id}"

  # Built from parts rather than read off aws_cloudtrail.main.arn on purpose.
  # The trail declares depends_on the bucket policy (see below), so reading the
  # ARN off the trail here would add policy -> trail on top of trail -> policy
  # and Terraform would refuse to plan the cycle. Account, region and name are
  # all known before either resource exists, so composing the ARN by hand
  # breaks the loop without weakening the condition.
  #
  # The cycle is not inherent to these resources: drop the depends_on and the
  # graph is policy -> trail -> bucket, which plans fine. The depends_on is
  # what earns it, and it is worth keeping — see the trail resource.
  trail_arn = "arn:aws:cloudtrail:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:trail/${var.trail_name}"

  # CloudTrail writes under a fixed prefix it controls; the bucket policy has
  # to name the same path or every delivery is denied.
  log_prefix = "AWSLogs/${data.aws_caller_identity.current.account_id}/*"
}

# --- Log bucket --------------------------------------------------------------

# force_destroy is deliberately left at its default of false: `terraform
# destroy` on a bucket holding log objects fails with BucketNotEmpty, which is
# the correct outcome for an audit log. Consequence to know before you need it:
# tearing this root down is a two-step operation — empty the bucket by hand
# first, deliberately. See ADR-0005.
resource "aws_s3_bucket" "trail" {
  # checkov:skip=CKV_AWS_18:Access logging on the audit bucket would need a second bucket to receive it, which would itself want access logging. The trail's own log-file validation digests cover tamper-detection here.
  # checkov:skip=CKV_AWS_144:Cross-region replication is a multi-account/DR control; this is a single-account portfolio project on a fixed credit. Noted as a scaling seam in ADR-0005.
  # checkov:skip=CKV_AWS_145:SSE-S3 over SSE-KMS is a deliberate cost decision argued in ADR-0005 — a CMK bills per request and needs its own key policy for CloudTrail.
  bucket = local.bucket_name

  tags = {
    Name = local.bucket_name
  }
}

# ACLs are legacy. Every bucket created since April 2023 defaults to
# BucketOwnerEnforced, which disables them outright; this states it explicitly
# so the intent survives a provider default changing under us.
#
# Consequence for the bucket policy below: the s3:x-amz-acl =
# bucket-owner-full-control condition in AWS's reference policy is redundant
# here, so it is omitted. It would not break anything — CloudTrail does send
# the header, and bucket-owner-full-control is the one canned ACL S3 still
# accepts on a BucketOwnerEnforced bucket — there is simply nothing left for it
# to assert once ACLs are disabled.
resource "aws_s3_bucket_ownership_controls" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket = aws_s3_bucket.trail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, not SSE-KMS, deliberately. A customer-managed key bills per request
# and would additionally require a key policy granting CloudTrail
# GenerateDataKey* — a second resource policy with its own confused-deputy
# condition to get right. At this event volume that is real money and real
# surface area for no threat this project actually faces. Revisit if the
# account ever holds data whose access pattern is itself sensitive.
resource "aws_s3_bucket_server_side_encryption_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Retention is a decision, not an accident. 365 days ~= one audit cycle, and
# long enough that an intrusion discovered late still has evidence behind it —
# the failure mode to avoid is a retention window shorter than realistic
# time-to-discovery, which reads as logging but functions as none.
#
# No Glacier tiering: CloudTrail writes many tiny objects (~120k/year here at
# a few KB each), and lifecycle transitions bill per object, so tiering would
# cost more in transition requests than it saves in storage. Total footprint is
# a few hundred MB/year — roughly a cent a month in Standard.
resource "aws_s3_bucket_lifecycle_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    id     = "expire-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --- Bucket policy -----------------------------------------------------------

# CloudTrail does not use our credentials to deliver logs. It writes as the
# service principal cloudtrail.amazonaws.com, on its own schedule, so access
# cannot come from an IAM role we attach to anything — it has to be granted by
# a resource policy on the bucket. The trust direction is inverted from the
# rest of this repo.
data "aws_iam_policy_document" "trail" {
  # Before every delivery CloudTrail calls GetBucketAcl to confirm the bucket
  # exists and identify its owner. Omit this statement and the trail still
  # creates, still reports healthy, and silently never delivers an object.
  #
  # The permission is named for the ACL API but does not require ACLs to be
  # enabled — it works fine against a BucketOwnerEnforced bucket.
  statement {
    sid       = "AWSCloudTrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn] # the BUCKET, not the objects

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "AWSCloudTrailWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trail.arn}/${local.log_prefix}"] # the OBJECTS

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    # Without this, the policy reads "any CloudTrail in ANY AWS account may
    # write here" — the classic confused-deputy hole. A stranger could point
    # their trail at this bucket, bill us for their storage and interleave
    # their events with ours, which is worse than the cost: it corrupts the
    # log we would be reading during an incident.
    #
    # Scoped to the exact trail ARN rather than aws:SourceAccount. Both block
    # the cross-account attack equally; SourceArn additionally excludes our own
    # future trails, which is not a threat but is free to exclude today. If a
    # second trail ever needs this bucket, widen to ArnLike with a wildcard
    # rather than dropping to SourceAccount.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = data.aws_iam_policy_document.trail.json
}

# --- Trail -------------------------------------------------------------------

resource "aws_cloudtrail" "main" {
  # checkov:skip=CKV_AWS_35:SSE-S3 over SSE-KMS is a deliberate cost decision argued in ADR-0005.
  name           = var.trail_name
  s3_bucket_name = aws_s3_bucket.trail.id

  # Multi-region, so a single trail in eu-west-1 captures activity in regions
  # this project never deliberately uses. That is the point: "did anything
  # touch this account outside eu-west-1?" is otherwise a question you answer
  # by opening ~17 consoles by hand.
  is_multi_region_trail = true

  # IAM, CloudFront and Route 53 are global services whose events are emitted
  # in us-east-1. Without this they are simply absent — including every
  # AssumeRole and every IAM policy change.
  include_global_service_events = true

  # Writes signed digest files so log tampering after delivery is detectable.
  # Free, and it is the difference between a log and an audit log. The trail
  # deleted in Aug 2026 had this off.
  enable_log_file_validation = true

  # Management events only. Data events (s3:GetObject, lambda:Invoke, and the
  # rest of the data plane) are off by default and bill per event — on the
  # ingestion path this project is about to build, that is the line item that
  # would turn a free trail into a real charge against a fixed credit. Revisit
  # under COMPASS-33 if the least-privilege audit needs object-level evidence.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  # The bucket policy must be in place before the trail is created: CloudTrail
  # validates write access at creation time, and a policy that lands late
  # means a failed first delivery and a backoff before it retries.
  depends_on = [aws_s3_bucket_policy.trail]
}
