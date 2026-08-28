# ADR-0005: CloudTrail lives in account-scoped Terraform state

**Status:** Accepted
**Date:** 2026-08-28
**Deciders:** Stéphan (solo project)

## Context

COMPASS-1 required "CloudTrail (management events, all regions)" with the
acceptance criterion "CloudTrail trail visible in console". That criterion was
met by clicking through the console, and the ticket was closed.

The timeline matters, because it is shorter than it feels. The trail began
logging on 2026-08-24. Issue #6 was created on 2026-08-25T08:42Z as part of the
bulk import of `docs/PROGRAM.md`, and closed 14 minutes later at 08:56Z —
retroactively, against work already done by hand the previous day. On
2026-08-28, three days after that, a cross-region audit found resources
apparently scattered across three regions. Two of the three were benign — AWS
creates a default VPC in every enabled region, and IAM is global but surfaces
through us-east-1 in the Resource Groups Tagging API. The third was a CloudTrail trail homed in
eu-west-2, a region this project does not use, writing to a bucket there.

Nothing in the repository recorded that the trail was deliberate, so it read as
drift and was deleted along with its bucket — four days of logs. Only
afterwards did `docs/PROGRAM.md` reveal it had been satisfying a closed ticket.

That the whole cycle — create, close, forget, destroy — fit inside four days is
the point. This was not knowledge lost to time; the ticket was closed three
days earlier, by the same person, on the same project. Nothing about a longer
interval would have made it worse.

Two distinct failures produced that outcome:

1. **A console-created resource has no reviewable trace.** It cannot be
   diffed, cannot be commented, and does not appear in any PR. To the next
   reader — human or agent — it is indistinguishable from an accident.
2. **Had it instead lived in `envs/dev`, the outcome would have been worse.**
   `scripts/teardown.sh` runs `terraform destroy` against `envs/dev` at the end
   of most sessions to stop the bill. An audit log deleted on a schedule is not
   an audit log; the manual deletion was a one-off, but that would have been
   recurring and silent.

## Decision

Define the trail and its log bucket in `infra/terraform/modules/cloudtrail`,
consumed by a **new root, `infra/terraform/envs/account`**, held in a separate
state file (`account/terraform.tfstate`) in the existing state bucket.

The separation of *state*, not merely of module, is the substantive part.
`terraform destroy` in `envs/dev` can only act on dev's state, so teardown is
structurally incapable of removing the trail.

## Options Considered

### Option A: `modules/cloudtrail` consumed by `envs/dev`

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — one new module, no new root, no new backend |
| Cost | Identical |
| Scalability | Poor — misfiles account-lifetime infra as environment infra |
| Team familiarity | Highest; matches the existing envs/dev pattern |

**Pros:** No new state to initialise; one `terraform apply` for everything;
consistent with every other module in the repo.
**Cons:** `scripts/teardown.sh` destroys it every session. Also semantically
wrong: a second environment would either duplicate the trail or fight over it,
since the trail is account-scoped and there is only one account.

### Option B: separate `envs/account` root and state (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — a second root, a second backend key, a second apply |
| Cost | Identical |
| Scalability | Good — the seam where account-lifetime infra belongs already exists |
| Team familiarity | New pattern in this repo, but a standard one |

**Pros:** Survives teardown by construction rather than by remembering. Makes
the lifecycle distinction explicit and reusable — future account-wide concerns
(IAM permission boundaries, Budgets, Config) have an obvious home.
**Cons:** Two roots to apply and to keep in mind. A reader must understand why
`envs/account` is not an environment in the same sense as `envs/dev`.

### Option C: leave it console-managed, document it instead

**Pros:** Zero work.
**Cons:** Restates the failure this ADR exists to fix. Documentation of an
untracked resource decays; the resource itself cannot be reviewed, and cannot
be rebuilt after an account rebuild.

## Trade-off Analysis

The decisive argument is not tidiness but **lifecycle class**. Resources in this
account fall into two groups: those that exist because an *environment* exists
(VPC, RDS, EKS — destroyed nightly to control cost) and those that exist because
the *account* exists (the trail, and the Terraform state bucket itself, which is
already bootstrapped outside any root for exactly this reason). Terraform's unit
of destruction is the state file, so the only reliable way to give two lifecycle
classes two fates is to give them two state files.

Option A collapses that distinction and pays for it every time teardown runs.
The extra root in Option B is the honest cost of keeping the distinction.

Secondary decisions inside the module, recorded here because each has a
non-obvious failure mode:

- **`aws:SourceArn` on both bucket-policy statements.** Without a source
  condition the policy grants write access to *any* CloudTrail in *any* AWS
  account — the confused-deputy hole. The cost is not only a stranger's storage
  bill but a polluted audit log, which is worse: it corrupts the evidence during
  the incident you would be using it for. `SourceArn` is chosen over
  `SourceAccount` because both block the cross-account case equally, and the
  tighter scope costs nothing while there is one trail.
- **The trail ARN is composed from account/region/name, not read from
  `aws_cloudtrail.main.arn`.** The cycle is self-inflicted and worth stating
  precisely: the trail must be created *after* the bucket policy
  (`depends_on`, below), so reading the ARN off the trail would add
  `policy → trail` on top of the existing `trail → policy` and Terraform would
  refuse to plan. Composing the ARN by hand breaks the loop without weakening
  the condition — account, region and name are all known before either resource
  exists. Note the cycle is *not* inherent to the resources: without the
  `depends_on`, the graph is `policy → trail → bucket` and plans fine.
- **ACLs stay disabled (`BucketOwnerEnforced`).** ACLs are S3's pre-IAM access
  mechanism and are off by default for buckets created since April 2023. The
  `s3:x-amz-acl = bucket-owner-full-control` condition is therefore *redundant*
  here and is omitted for simplicity — not because it would break delivery.
  AWS's current reference policy still includes it alongside `aws:SourceArn`,
  CloudTrail does send the header, and `bucket-owner-full-control` is the one
  canned ACL S3 still accepts on a `BucketOwnerEnforced` bucket, so the
  condition is harmless either way. `s3:GetBucketAcl` is still granted; it is a
  permission name, not an endorsement of ACLs, and works against an ACL-free
  bucket.
- **Management events only; no data events.** Data events bill per event and
  the ingestion path (Epic 2) would generate them continuously. That is the
  line item that turns a free trail into a real charge against a fixed credit.
- **SSE-S3, not SSE-KMS.** A customer-managed key bills per request and needs a
  key policy granting CloudTrail `GenerateDataKey*`, with its own
  confused-deputy condition. Real money and real surface area for no threat
  this project faces.
- **365-day retention, no Glacier tiering.** Retention shorter than realistic
  time-to-discovery reads as logging but functions as none; 90 days in
  particular buys nothing, because free CloudTrail Event History already covers
  that window and the trail would then earn only its multi-region aggregation.
  Tiering is skipped because CloudTrail delivers on a ~5-minute cadence per
  active region — order 100k small objects a year — and lifecycle transitions
  bill per object. At $0.05/1,000 transition requests that is roughly $6/year
  against a storage saving of well under $1/year on a few hundred MB. S3
  corroborates the shape independently: the bucket reports
  `TransitionDefaultMinimumObjectSize: all_storage_classes_128K`, so objects
  this small would not be transitioned by default anyway. Total run cost is
  well under a dollar a year, storage and PUT requests combined.

## Consequences

- **Easier:** teardown is safe to run without reasoning about the audit log.
  Account-wide concerns added later (permission boundaries under COMPASS-8,
  Budgets under COMPASS-2) have an established home and an established
  lifecycle.
- **Harder:** two Terraform roots to apply. A first-time setup on a fresh
  account now has an extra documented step, and CI's plan job must cover both
  roots or one silently drifts.
- **To revisit:** this is a single-account design. The multi-account reference
  architecture puts the trail in a dedicated **Log Archive** account, written by
  an AWS Organizations organization trail, where no workload account holds
  permission to delete it — which would have prevented the original incident
  outright rather than mitigating it. Single-account is the correct choice here
  (Organizations, Control Tower and cross-account role chains would consume days
  and demo nothing on a fixed credit), but the seam is named so the scaling
  answer is ready. To be written up in `docs/SCALING.md` under COMPASS-34,
  which is still a template at the time of writing.
- **To revisit:** cross-region replication and S3 access logging on the log
  bucket are both suppressed with documented `checkov:skip` annotations. Both
  are multi-account/DR controls that presume infrastructure this project does
  not have.
- **Known gap, deliberately not closed here — the trail can still be stopped or
  deleted, and nothing would notice.** This decision protects the trail from
  *scripted* destruction (`teardown.sh`), which is the recurring risk. It does
  nothing about *ad-hoc* destruction, which is what actually happened: the
  `DeleteTrail` call was made with a long-lived access key, with no MFA in the
  session, and that key still exists. Terraform would surface it as drift on the
  next plan, but the plan job is gated off and does not yet cover this root.
  Detective and preventive controls worth adding — an EventBridge rule on
  `StopLogging`/`DeleteTrail` to SNS, S3 versioning or Object Lock on the log
  bucket, an explicit `Deny` on `s3:DeleteObject` for non-break-glass
  principals — are scoped out to keep this change to one ticket, and tracked in
  issue #55. Naming the gap is the point: the fix here is partial and should
  not be presented as complete.
- **Interview note:** the deletion was performed by an agent using the operator's
  access key. CloudTrail recorded it under the operator's IAM principal, and no
  field distinguishes an agent driving the CLI from a human driving the same
  CLI. (`userAgent` names the CLI and version, and `sessionContext` shows
  whether MFA backed the session — both are evidence about *how*, not *who*.)
  This is the AWS half of the attribution gap already noted for GitHub, and is
  direct input to the deferred ADR on agent attribution.

## Action Items

1. [x] `modules/cloudtrail` — bucket, ownership controls, BPA, SSE, lifecycle, policy, trail
2. [x] `envs/account` root with its own backend key
3. [x] `scripts/teardown.sh` — state explicitly that account-scoped state is out of scope
4. [x] `terraform apply` in `envs/account`; first delivery confirmed 2026-08-28T10:22Z, ~5 min after `TimeLoggingStarted` (10:17Z)
5. [x] CI plan matrix extended to `[dev, account]` in `.github/workflows/infra-plan.yml` (still gated `if: false` until COMPASS-25)
6. [ ] Detective/preventive controls on the trail — issue #55
7. [ ] Re-close COMPASS-1 once the PR merges
