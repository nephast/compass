# Scaling Compass — fill this in during Epic 9 (COMPASS-34)

Don't write this from theory before you've built the thing — write it after,
from what you actually observed (dashboards, load-tested numbers if you get to
it, or honest reasoning about the design you built). This document, filled in
well, is one of the highest-leverage artifacts in the whole repo for an
interview — a specific, concrete answer beats a generic one every time.

## Current design point

*(Fill in: expected load this was designed for — e.g. "a handful of users,
low request volume, optimized for cost and learning depth, not throughput.")*

## First bottleneck at 10x traffic

*(Which component breaks first? The EKS HPA config? The single-AZ RDS
instance? The NAT instance's bandwidth? Be specific — name the component and
why, not "the database" in the abstract.)*

## First bottleneck at 100x traffic

*(What changes qualitatively, not just quantitatively — e.g. "pgvector on a
single Postgres instance stops being viable around N vectors / M concurrent
queries; migrate to [specific alternative] at that point.")*

## What I'd change first, in order

1.
2.
3.

## What I deliberately did NOT build for scale, and why

*(Reference the ADRs — e.g. "single-AZ RDS and a NAT instance instead of NAT
Gateway were explicit cost/learning trade-offs for a 2-week budget-constrained
project, not oversights — see ADR-0001 and ADR-0002.")*

## Cost at scale

*(Rough back-of-envelope: what would running this for 1,000 real users cost
per month, and what's the single biggest line item?)*
