# Contributing (to your own project — yes, really)

This repo enforces trunk-based development even though it's a solo project, on purpose — the workflow itself is part of what you're practicing.

## Workflow

1. Branch off `main`: `git checkout -b feat/compass-19-llm-provider-abstraction` (prefix with the ticket ID from `docs/PROGRAM.md`).
2. Keep the PR small — one ticket, or a clean slice of one, ideally reviewable in under 15 minutes. If a ticket feels too big for one PR, that's a signal to split it, not to write a bigger PR.
3. PR title using **Conventional Commits** (enforced by CI — see `.github/workflows/pr-title.yml`):
  individual commits on a branch can be whatever gets you through the work (wip, fix typo, etc.) — only the PR title needs to follow Conventional Commits format, since that's what lands permanently on main
4. Open the PR against `main`. CI runs lint, typecheck, tests, security scans, and (for infra changes) posts a `terraform plan` / `cdk diff` as a comment.
5. Merge only when CI is green. Merging to `main` auto-deploys to `dev` (see `.github/workflows/deploy.yml`); promotion to `prod` needs a manual approval click in GitHub Environments.

## Commit message discipline, for real

Yes, even solo. The reason: a clean conventional-commit history is what lets `git log` answer "when did this change and why" without opening every PR, and it's a small, visible signal of professional habits when someone reviews this repo for a job. It costs seconds per commit.

## Reviewing your own PRs

Before merging, read your own diff as if reviewing a stranger's code: does it match the ticket's acceptance criteria in `docs/PROGRAM.md`? Did you leave a `console.log`? Does an IAM policy have a wildcard you didn't mean to leave in? Is there a magic number that should be a named constant? This habit transfers directly to real-job code review.
