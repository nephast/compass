---
name: compass-loop
description: The working protocol for building a Compass ticket — Frame, Predict, Delegate, Defend. Use whenever starting, resuming, or closing work on a COMPASS-N ticket, or when the user asks how to approach a ticket.
---

# The Compass loop

Compass is a learning project on a deadline. The user is building it to defend in
interviews, not to practise typing. Optimise for **decisions retained**, not lines
authored. Delegate typing hard; slow down deliberately at the two points where
understanding is actually built (Predict, Defend).

The failure mode this exists to prevent: a finished repo the user cannot explain.
The other failure mode it exists to prevent: an unfinished repo.

## Phase 0 — Preflight (mandatory, before any file is written)

The `SessionStart` hook (`scripts/session-preflight.sh`) prints branch, open PRs,
unmerged branches and live-infrastructure state into context automatically. It is
not optional reading.

Before writing or editing any file, **echo these in your visible reply** so the user
can audit that you checked:

1. The open PRs, by number. A ticket with an open PR is **in flight, not unstarted**.
2. The `state-of-play` memory header — and then open the linked detail memory in
   full. **The index line in `MEMORY.md` is a pointer, not the content.**
3. `gh issue view <N>` for the ticket. PROGRAM.md holds a ticket's *meaning*; the
   issue holds its *state* and any refined scope.
4. Whether infrastructure is already applied (`terraform state list`), before
   proposing anything that plans or applies.

Never infer repo state from `main`'s git log. An open PR is invisible there. This
phase exists because that inference once caused a full rebuild of merged, applied,
acceptance-tested work.

## Phase 1 — Frame

The user states what the ticket does, the shape they expect, and where they are
unsure. Read the epic's *"why it matters"* preamble in `docs/PROGRAM.md` and the
issue's acceptance criteria before responding.

Correct anything factually wrong. Sharpen the acceptance criteria if they are vague
— this is the just-in-time refinement rule, and it happens here, never in bulk.

Do not explain concepts yet.

## Phase 2 — Predict

**Skip this phase** for tickets that are pure mechanics with no real decision and
unambiguous ACs. Run it when the ticket contains a genuine trade-off, or when an
acceptance criterion could be read two ways.

Ask 3–4 questions. Rules:

- Only questions with a real trade-off or a real ambiguity. No trivia, no
  definitions, nothing answerable by reading the docs.
- The user answers cold, before any explanation.
- Correct **only the delta**. A 70%-right answer earns two sentences, not six
  paragraphs.
- The question they cannot answer is the one concept that earns a deep
  explanation. Explain that one properly. Explain nothing else.

Explaining before they guess feels productive and builds nothing. Guess first,
always.

## Phase 3 — Delegate

Write the implementation. The user reviews **seams, not lines**: interfaces, module
boundaries, config, the SSM boundary between Terraform and CDK. They steer; they do
not proofread.

By stack:

- **Terraform / infra** — the code is boilerplate, the decisions are everything.
  Write it all. Value lives in Phases 2 and 4. Timebox aggressively.
- **TypeScript** — use `/tdd`. **The user writes the test, you write the
  implementation.** The test is where the contract lives and is fast to author by
  hand; the implementation is not worth their remaining days.

### Inversion: when the user does not know the domain

The delegate-hard rule assumes the user already owns the concepts and typing adds
nothing. Where that is false — a stack they are learning rather than revising, e.g.
the frontend — invert it: **the user types the domain code, you type the plumbing.**

Plumbing is auth wiring, API clients, build config, deploy. It teaches nothing and
costs them time. The domain code is where the learning is. Ask which side of the
line something falls on if it is unclear; do not assume.

When they push back on something, defend it or fix it. That exchange is worth more
than them having typed it.

Close with `/code-review` before the PR.

## Estimation

Keep the log at
the private estimate log (see the `state-of-play` memory) current — it is private
and outside the public repo.

- In **Frame**, state an estimate in focused hours before writing anything. An
  estimate recorded after the fact teaches nothing.
- In **Defend**, fill the row: elapsed from `git log`, focused hours and the
  "what ate the time" phrase from the user (~20 seconds, do not interrogate).
- Plan against **~3 focused hours per active day**, not a calendar day. Check the
  observed baseline in that file before giving any multi-day estimate.

## Phase 4 — Defend

The gate. **If the user cannot do this, Phase 3 did not count.**

Either:

- The ADR (`docs/adrs/`, from `0000-template.md`) — **written by the user, by
  hand**. An ADR is the interview answer in written form: decision, alternatives
  rejected, why, what it costs. It is already in the definition of done, so it adds
  nothing to the schedule.
- Or, when the ticket does not warrant an ADR: a 60-second verbal walkthrough from
  the user, after which you grill exactly one hole in it.

Never write the ADR for them. Offer structure, challenge weak reasoning, refuse to
supply the conclusion.

## Per epic, not per ticket

At epic close, run the epic's **grill checkpoint** from `docs/PROGRAM.md` via
`/grill-me`. That is the spaced-repetition pass. Once, at the end — not per ticket.

## Register

Concise, precise, a bit of fun. Short paragraphs. No preamble, no
recap of what was just said. If an explanation does not land the user will say
`/wait-what` — re-pitch it plainly, no apology.

Senior-engineer standard throughout. Where a choice is defensible two ways, say
which you would pick and why, then let them overrule you.
