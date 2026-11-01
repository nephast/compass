# ADR-0010: AI-assisted development workflow — implementer, cold reviewer, fixer, human gate

**Status:** Proposed — **the trial (COMPASS-39, #46) has not run yet.** This moves
to Accepted only with the trial PR linked below.
**Date:** 2026-11-01 (as of)
**Deciders:** nephast

> Numbering: #46 names this file `0004-…`, but ADR-0004 was taken by the RDS IAM-auth
> decision before #46 was written. Same decision, next free number.

## Context

Coding agents can write most of a ticket's implementation. The question this ADR
answers is not "should agents write code" but **what process around them still
produces code a human can stand behind**, in a repo whose definition of done
includes "I can explain why I built it this way" (`docs/PROGRAM.md`).

The failure mode to design against: **an agent reviewing its own work approves it.**
It already believes its choices were right, and it shares every blind spot that
produced the code.

### A data point from this repository

Most of the `claude/upbeat-curie-hdt2iy` branch (COMPASS-6…38) was produced by a
**single agent session**: implement, self-test, commit. That session's own tests
caught real defects (presigned uploads carrying an empty-body checksum S3 would
reject; a CDK custom-resource role escaping the permissions boundary; a checkov
gate that skipped two modules). But by construction it can't catch what it
doesn't know to test for. That is exactly the gap an independent reviewer exists
to close, and it makes the branch a natural first candidate for the trial below.

## Decision (proposed)

```
spec-grade ticket ─▶ implementer agent (own branch, opens PR)
                  ─▶ reviewer agent, COLD: sees only the diff + the ticket, posts inline comments
                  ─▶ fixer agent addresses comments, pushes
                  ─▶ human merge gate. Always.
```

Preconditions that live **in the repo, not in prompts**: `CLAUDE.md`, branch
protection (`main` ruleset, no bypass actors), and binding CI (COMPASS-25). The
agent gets a correctness signal it can run itself: tests, `tsc`, lint, `cdk synth`
assertions, checkov.

## Options considered

| | Single agent does everything | Implementer + cold reviewer + human gate (proposed) | Auto-merge on green CI |
|---|---|---|---|
| Catches implementer blind spots | No | Yes, if the reviewer is truly cold | Only what CI encodes |
| Human understanding of the change | Low unless they read every line | Review comments are the reading guide | None |
| Cost / latency | Lowest | ~2–3× tokens, one extra round trip | Lowest |
| Failure mode | Confident, plausible, wrong | Reviewer theatre (rubber-stamping) | Silent drift |

Tooling: **GitHub Action (`@claude` on PRs) vs separate local sessions.** Start with
separate sessions, by hand. Automate only what the trial proves useful;
automating an unvalidated process just produces an impressive pipeline that emits
bad PRs.

## Trial protocol (COMPASS-39 acceptance)

1. Pick one epic-4/5 ticket with real unit tests. Write it to spec grade.
2. **Session A (implementer):** full repo context, opens the PR.
3. **Session B (reviewer):** a *fresh* session given only `git diff main...` and the
   issue text, no conversation history. It posts inline comments.
4. **Session C (fixer):** addresses the comments.
5. The human reads the review, decides, merges. The gate is never bypassed.
6. Record: the PR link, which comments caused real changes, and the time and tokens per stage.

Evidence the review wasn't theatre: **at least one comment caused a genuine change.**

## Consequences

- Review comments become the human's map of the change, which directly serves
  "decisions retained" (`.claude/skills/compass-loop`).
- Every ticket costs roughly 2–3× the agent time. Worth it for application code
  with tests; probably not for docs-only changes.
- **Revisit trigger:** when the trial completes; when agent tooling can provably
  isolate reviewer context (so "cold" is guaranteed, not just intended); or six
  months from the as-of date, whichever comes first. This area moves fast enough
  that a dated decision goes stale quickly.

## Action items

1. [ ] Run the trial (above) and link the PR here: ___
2. [ ] Move to Accepted, or record why not
3. [ ] Decide whether to automate any stage, based on the trial's numbers
