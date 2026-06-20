#!/usr/bin/env bash
# Ownership-guard tests for the GLOBAL PostToolUse:ExitPlanMode hook
# ~/.claude/scripts/plan-tree-save-plan.sh.
#
# CONTRACT UNDER TEST (see CONTRACT.md "Ownership of .plan-tree/ ..."):
#   .plan-tree/state.json is the app-owned marker — the claude-plan-reader app is
#   the SOLE writer of state.json; the CLI /multiplan flow never creates one.
#   When state.json exists under the hook's working dir, the hook MUST exit 0
#   without writing ANYTHING (no plans, no .pending-* caches, no .hook.log).
#   When state.json is absent, hook behavior must be unchanged (CLI flows keep
#   working: master.md / NN-plan.md / .pending-* writes as before).
#
# CASES:
#   A  app-owned tree (state.json present), ambiguous plan payload that WOULD
#      produce .pending-* litter → .plan-tree/ must be byte-identical after.
#   B  CLI tree (no state.json), master-shaped plan → master.md written.
#   C  CLI tree (no state.json), ambiguous plan → .pending-*.md written.
#      (C proves case A's silence comes from the guard, not from the hook
#      having nothing to write for that payload.)
#
# Run: bash scripts/hook-ownership.test.sh
set -uo pipefail

HOOK="${HOOK_UNDER_TEST:-$HOME/.claude/scripts/plan-tree-save-plan.sh}"

FAILS=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

# The hook is a HOST-ONLY manual prerequisite living in the user's global
# ~/.claude/ — this repo does not install it. Absent hook ⇒ SKIP, not FAIL.
if [ ! -f "$HOOK" ]; then
  printf 'SKIP: hook not installed on this machine (%s) — nothing to test\n' "$HOOK"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required to build test payloads (and by the hook itself)"
  exit 1
fi

BASE="${TMPDIR:-/tmp}/hook-ownership.$$"
mkdir -p "$BASE"
trap 'rm -rf "$BASE"' EXIT

# snapshot DIR OUTPREFIX — sorted path listing + per-file md5, for byte-identity diffs.
snapshot() {
  local dir="$1" out="$2" f
  find "$dir" -print | LC_ALL=C sort > "$out.list"
  : > "$out.sums"
  while IFS= read -r f; do
    if [ -f "$f" ]; then
      md5 -r "$f" >> "$out.sums"
    fi
  done < "$out.list"
  return 0
}

# run_hook PAYLOAD_FILE OUT_FILE — invoke the hook exactly as Claude Code would.
run_hook() {
  bash "$HOOK" < "$1" > "$2" 2>"$2.err"
}

# ─────────────────────────────────────────────────────────────────────────────
# CASE A — app-owned tree: state.json present → byte-identical .plan-tree/
# ─────────────────────────────────────────────────────────────────────────────
caseA() {
  local NAME="caseA app-owned: state.json present → exit 0, .plan-tree/ byte-identical"
  local D="$BASE/app-owned"
  mkdir -p "$D/.plan-tree"
  printf '{"version":1,"master":{"phase":"recon"}}\n' > "$D/.plan-tree/state.json"
  # Pre-existing app files the hook must not touch either.
  printf '# recon notes\n' > "$D/.plan-tree/recon.md"

  # Ambiguous payload (no master.md, plan has no Sub-Plan headers): absent the
  # guard, the hook writes .pending-<stamp>.md + .hook.log here.
  jq -nc --arg cwd "$D" \
    '{cwd: $cwd, tool_input: {plan: "Just a plain plan body with no sub-plan headers."}, session_id: "s", transcript_path: "/t"}' \
    > "$BASE/payload-a.json"

  snapshot "$D/.plan-tree" "$BASE/snap-a-before"
  run_hook "$BASE/payload-a.json" "$BASE/out-a"
  local RC=$?
  snapshot "$D/.plan-tree" "$BASE/snap-a-after"

  local ok=1
  [ "$RC" -eq 0 ] || { fail "$NAME (exit code $RC != 0)"; ok=0; }
  if ! diff -u "$BASE/snap-a-before.list" "$BASE/snap-a-after.list" > "$BASE/diff-a.list"; then
    fail "$NAME (file set changed — new/removed files in .plan-tree/)"
    cat "$BASE/diff-a.list"
    ok=0
  fi
  if ! diff -u "$BASE/snap-a-before.sums" "$BASE/snap-a-after.sums" > "$BASE/diff-a.sums"; then
    fail "$NAME (file contents changed in .plan-tree/)"
    cat "$BASE/diff-a.sums"
    ok=0
  fi
  if [ -s "$BASE/out-a" ]; then
    fail "$NAME (hook emitted stdout — must be silent)"
    cat "$BASE/out-a"
    ok=0
  fi

  [ "$ok" = 1 ] && pass "$NAME"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# CASE B — CLI tree, master-shaped plan: still writes master.md as before
# ─────────────────────────────────────────────────────────────────────────────
caseB() {
  local NAME="caseB cli-owned: no state.json + master-shaped plan → master.md written"
  local D="$BASE/cli-master"
  mkdir -p "$D/.plan-tree"

  local PLAN="# Master

### Sub-Plan 01: First thing

body"
  jq -nc --arg cwd "$D" --arg p "$PLAN" \
    '{cwd: $cwd, tool_input: {plan: $p}, session_id: "s", transcript_path: "/t"}' \
    > "$BASE/payload-b.json"

  run_hook "$BASE/payload-b.json" "$BASE/out-b"
  local RC=$?

  local ok=1
  [ "$RC" -eq 0 ] || { fail "$NAME (exit code $RC != 0)"; ok=0; }
  if [ ! -f "$D/.plan-tree/master.md" ]; then
    fail "$NAME (master.md was NOT written — CLI behavior regressed)"
    ok=0
  else
    if ! grep -q 'Sub-Plan 01: First thing' "$D/.plan-tree/master.md"; then
      fail "$NAME (master.md content does not match the plan payload)"
      ok=0
    fi
  fi

  [ "$ok" = 1 ] && pass "$NAME"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# CASE C — CLI tree, ambiguous plan: still caches to .pending-*.md as before
# ─────────────────────────────────────────────────────────────────────────────
caseC() {
  local NAME="caseC cli-owned: no state.json + ambiguous plan → .pending-*.md written"
  local D="$BASE/cli-pending"
  mkdir -p "$D/.plan-tree"

  jq -nc --arg cwd "$D" \
    '{cwd: $cwd, tool_input: {plan: "Just a plain plan body with no sub-plan headers."}, session_id: "s", transcript_path: "/t"}' \
    > "$BASE/payload-c.json"

  run_hook "$BASE/payload-c.json" "$BASE/out-c"
  local RC=$?

  local ok=1
  [ "$RC" -eq 0 ] || { fail "$NAME (exit code $RC != 0)"; ok=0; }
  if ! ls "$D/.plan-tree"/.pending-*.md >/dev/null 2>&1; then
    fail "$NAME (no .pending-*.md written — CLI ambiguous-cache behavior regressed)"
    ok=0
  fi

  [ "$ok" = 1 ] && pass "$NAME"
  return 0
}

echo "── hook ownership-guard tests ($HOOK) ──"
caseA
caseB
caseC
echo "────────────────────────────────────────"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "$FAILS case(s) FAILED"
  exit 1
fi
