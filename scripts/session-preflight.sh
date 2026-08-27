#!/usr/bin/env bash
# Session preflight: prints the repo's real state at the start of every Claude
# Code session, so an agent never has to *remember* to look.
#
# Written after a session in which the agent read a one-line memory summary,
# inferred repo state from `main`'s history, and rebuilt an already-merged,
# already-applied ticket from scratch. The checks below cost ~1 second and
# would have caught it. Deterministic beats well-intentioned.
#
# Wired via .claude/settings.json as a SessionStart hook; stdout lands in the
# agent's context. Safe to commit: reads only local git/gh state, prints no
# secrets, and derives every path generically.
set -uo pipefail

say() { printf '%s\n' "$*"; }

say "=== SESSION PREFLIGHT ==="

# --- Where are we, and is anything uncommitted? -------------------------------
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not-a-git-repo')"
say "Branch: ${branch}"
if [ "${branch}" = "main" ] || [ "${branch}" = "master" ]; then
  say "  !! On the default branch. Branch before writing code."
fi

dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
if [ "${dirty}" != "0" ]; then
  say "Uncommitted changes: ${dirty} file(s)"
  git status --short 2>/dev/null | sed 's/^/  /' | head -15
fi

# --- Work already in flight. The check that was skipped. ----------------------
if command -v gh >/dev/null 2>&1; then
  prs="$(gh pr list --state open --limit 20 \
        --json number,title,headRefName,mergeable \
        --jq '.[] | "  #\(.number) [\(.mergeable)] \(.title)  <\(.headRefName)>"' 2>/dev/null)"
  if [ -n "${prs}" ]; then
    say "OPEN PRs -- check these before starting any ticket:"
    say "${prs}"
  else
    say "Open PRs: none"
  fi
else
  say "Open PRs: unknown (gh not installed)"
fi

# --- Local branches carrying unmerged commits ---------------------------------
unmerged="$(git branch --no-merged main 2>/dev/null | sed 's/^..//' | head -10)"
if [ -n "${unmerged}" ]; then
  say "Local branches with unmerged work:"
  printf '%s\n' "${unmerged}" | sed 's/^/  /'
fi

# --- Deployed infrastructure --------------------------------------------------
# "Is anything actually live?" is the question whose wrong answer is expensive.
for env_dir in infra/terraform/envs/*/; do
  [ -d "${env_dir}" ] || continue
  if [ -f "${env_dir}backend.tf" ]; then
    say "Terraform ${env_dir}: backend configured -- resources may be LIVE."
    say "  Confirm with: (cd ${env_dir} && terraform state list)"
  fi
done

# --- Private state-of-play ----------------------------------------------------
# Path derived from cwd the same way Claude Code mangles it; never hardcoded,
# so this script is portable and carries no personal path.
state_file="${HOME}/.claude/projects/$(printf '%s' "${PWD}" | tr '/' '-')/memory/state-of-play.md"
if [ -f "${state_file}" ]; then
  say "--- STATE OF PLAY (read the full file before writing code) ---"
  # Header only: everything above the first '---' separator.
  awk 'NR>1 && /^---$/{exit} NR>1{print "  " $0}' "${state_file}"
else
  say "State of play: no file yet (${state_file##*/})"
fi

say "=== END PREFLIGHT ==="
