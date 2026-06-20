#!/usr/bin/env bash
# Phase 7 — self-contained shell tests for the embedded HOOK_SCRIPT (src-tauri/src/lib.rs).
#
# WHAT THIS TESTS (end-to-end, against a SANDBOXED $HOME — never the real ~/.claude):
#   1. Injection safety   — plan_text containing $(...), backticks, quotes, `rm -rf` is stored as
#                           inert DATA in the request JSON (no shell expansion / no command runs).
#   2. Fast fallthrough   — when the app heartbeat (app.alive) is absent/stale, the hook exits 0
#                           quickly, writes NO request, emits NO decision JSON.
#   3. jq-missing fallthrough — when `jq` is not on PATH, the hook fails OPEN (exit 0, no output,
#                           no request) rather than stalling.
#
# The script under test is EXTRACTED verbatim from the Rust `HOOK_SCRIPT` const so this test tracks
# the shipped source. Prints PASS/FAIL per case; exits non-zero if any case fails.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_RS="$REPO_ROOT/src-tauri/src/lib.rs"

FAILS=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

# ── Extract HOOK_SCRIPT from lib.rs ──────────────────────────────────────────
# The const is `const HOOK_SCRIPT: &str = r#"...."#;`. The opening line carries the shebang after
# `r#"`; the body ends at the line that is exactly `"#;`. We emit everything between, restoring the
# shebang on the first line.
HOOK="$(mktemp)"
trap 'rm -f "$HOOK"' EXIT
awk '
  /const HOOK_SCRIPT: &str = r#"/ { inblk=1; sub(/.*r#"/, ""); print; next }
  inblk && /^"#;[[:space:]]*$/    { inblk=0; next }
  inblk                            { print }
' "$LIB_RS" > "$HOOK"

if [ ! -s "$HOOK" ]; then
  fail "extract HOOK_SCRIPT from lib.rs (empty extraction)"
  echo "Could not extract the hook script; aborting."
  exit 1
fi
# Sanity: the extracted script must start with the shebang and contain the jq fail-open guard.
head -1 "$HOOK" | grep -q '^#!/usr/bin/env bash' \
  && grep -q 'command -v jq' "$HOOK" \
  && pass "extracted HOOK_SCRIPT from lib.rs" \
  || fail "extracted HOOK_SCRIPT looks wrong (shebang/jq guard missing)"
chmod +x "$HOOK"

# A fresh sandbox HOME per case. Everything the hook touches lives under here.
fresh_home() {
  local h
  h="$(mktemp -d)"
  mkdir -p "$h/.claude/plan-reader"
  printf '%s' "$h"
}

# ─────────────────────────────────────────────────────────────────────────────
# CASE 1 — Injection safety
# ─────────────────────────────────────────────────────────────────────────────
case1() {
  local NAME="case1 injection-safety: plan_text stored as inert data, no command executed"
  local H; H="$(fresh_home)"
  local REQDIR="$H/.claude/plan-reader/requests"
  local RESPDIR="$H/.claude/plan-reader/responses"

  # Heartbeat present & fresh so the hook does NOT fast-fallthrough — it must reach the request write.
  touch "$H/.claude/plan-reader/app.alive"

  # Marker the injection would create IF the plan_text were ever shell-evaluated.
  local MARKER="$H/PWNED_TEST"
  rm -f "$MARKER"

  # The malicious plan_text. Note: this is a JSON STRING value — the hook must treat it as data.
  # It contains a command substitution, a backtick, a quote-break, and an rm. None must execute.
  local INJECT
  INJECT='$(touch '"$MARKER"') `id` "; rm -rf /tmp/should_not_happen'
  # The plan file path the hook must capture from tool_input.planFilePath into .plan_file_path.
  local PLANFILE="/Users/x/.claude/plans/test.md"
  # Build the stdin payload with jq so the JSON is well-formed regardless of the funky chars.
  local PAYLOAD
  PAYLOAD="$(jq -nc --arg p "$INJECT" --arg pf "$PLANFILE" \
    '{tool_input:{plan:$p, planFilePath:$pf}, session_id:"s", cwd:"/c", transcript_path:"/t"}')"

  # Run the hook in the background (it blocks waiting for a response).
  local OUT="$H/stdout.txt"
  ( HOME="$H" PATH="$PATH" bash "$HOOK" >"$OUT" 2>/dev/null ) <<<"$PAYLOAD" &
  local HOOK_PID=$!

  # Give it up to ~2s to write the request file.
  local REQ="" i
  for i in $(seq 1 20); do
    REQ="$(ls "$REQDIR"/*.json 2>/dev/null | head -1 || true)"
    [ -n "$REQ" ] && break
    sleep 0.1
  done

  local ok=1
  if [ -z "$REQ" ]; then
    fail "$NAME (no request file written)"; ok=0
  else
    # The stored plan_text must EQUAL the literal injection string (no expansion).
    local STORED; STORED="$(jq -r '.plan_text' "$REQ")"
    if [ "$STORED" = "$INJECT" ]; then
      :
    else
      fail "$NAME (.plan_text != literal injection)"
      printf '  expected: %q\n  got:      %q\n' "$INJECT" "$STORED"
      ok=0
    fi
    # The plan file path must be captured from tool_input.planFilePath into .plan_file_path.
    local STORED_PF; STORED_PF="$(jq -r '.plan_file_path' "$REQ")"
    if [ "$STORED_PF" = "$PLANFILE" ]; then
      :
    else
      fail "$NAME (.plan_file_path != fed planFilePath)"
      printf '  expected: %q\n  got:      %q\n' "$PLANFILE" "$STORED_PF"
      ok=0
    fi
  fi
  # The injected command must NOT have run.
  if [ -e "$MARKER" ]; then
    fail "$NAME (injection EXECUTED — marker file was created!)"; ok=0
  fi

  # Release the hook by minting a response with the request's review_id (the filename stem).
  if [ -n "$REQ" ]; then
    local RID; RID="$(basename "$REQ" .json)"
    mkdir -p "$RESPDIR"
    jq -nc '{decision:"deny", reason:"test feedback"}' > "$RESPDIR/$RID.json"
  fi

  # Wait for the hook to finish (bounded). Then assert it emitted the decision JSON on stdout.
  local j
  for j in $(seq 1 30); do
    kill -0 "$HOOK_PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$HOOK_PID" 2>/dev/null; then
    kill "$HOOK_PID" 2>/dev/null || true
    wait "$HOOK_PID" 2>/dev/null || true
  else
    wait "$HOOK_PID" 2>/dev/null || true
  fi

  if [ -n "$REQ" ]; then
    # The released hook should have printed a PreToolUse decision echoing our reason verbatim.
    # The hook emits PRETTY-printed JSON, so parse it with jq rather than string-matching.
    local DEC REASON
    DEC="$(jq -r '.hookSpecificOutput.permissionDecision // empty' "$OUT" 2>/dev/null || true)"
    REASON="$(jq -r '.hookSpecificOutput.permissionDecisionReason // empty' "$OUT" 2>/dev/null || true)"
    if [ "$DEC" = "deny" ] && [ "$REASON" = "test feedback" ]; then
      :
    else
      fail "$NAME (hook did not emit the expected decision JSON after response)"
      printf '  stdout: %s\n' "$(cat "$OUT")"
      ok=0
    fi
  fi

  [ "$ok" = 1 ] && pass "$NAME"
  rm -rf "$H"
}

# ─────────────────────────────────────────────────────────────────────────────
# CASE 2 — Fast fallthrough when app not running (stale/absent heartbeat)
# ─────────────────────────────────────────────────────────────────────────────
case2() {
  local NAME="case2 fast-fallthrough: stale app.alive → exit 0 quickly, no request, no stdout"
  local H; H="$(fresh_home)"
  local REQDIR="$H/.claude/plan-reader/requests"

  # Backdate app.alive well beyond the 10s staleness window so the hook treats the app as down.
  touch "$H/.claude/plan-reader/app.alive"
  touch -t 202001010000 "$H/.claude/plan-reader/app.alive"

  local PAYLOAD
  PAYLOAD="$(jq -nc '{tool_input:{plan:"a perfectly valid plan body"}, session_id:"s", cwd:"/c", transcript_path:"/t"}')"

  local OUT="$H/stdout.txt"
  local START END ELAPSED RC
  START="$(date +%s)"
  HOME="$H" bash "$HOOK" >"$OUT" 2>/dev/null <<<"$PAYLOAD"
  RC=$?
  END="$(date +%s)"
  ELAPSED=$((END - START))

  local ok=1
  [ "$RC" -eq 0 ] || { fail "$NAME (exit code $RC != 0)"; ok=0; }
  [ "$ELAPSED" -le 3 ] || { fail "$NAME (took ${ELAPSED}s, expected <=3s — it BLOCKED)"; ok=0; }
  if ls "$REQDIR"/*.json >/dev/null 2>&1; then
    fail "$NAME (a request file was written — must be none)"; ok=0
  fi
  if [ -s "$OUT" ]; then
    fail "$NAME (emitted stdout — must be empty)"
    printf '  stdout: %s\n' "$(cat "$OUT")"
    ok=0
  fi

  [ "$ok" = 1 ] && pass "$NAME"
  rm -rf "$H"
}

# ─────────────────────────────────────────────────────────────────────────────
# CASE 3 — jq-missing fallthrough (fail OPEN)
# ─────────────────────────────────────────────────────────────────────────────
# APPROACH: the hook's FIRST functional line is `command -v jq >/dev/null 2>&1 || exit 0`. To make
# a REAL end-to-end run see "no jq", we run it under a minimal PATH containing ONLY the coreutils
# the hook needs (cat/date/stat/mkdir/printf/sleep/jot...) via symlinks — but deliberately WITHOUT
# a jq symlink. We resolve each tool from the current PATH and symlink it into a tmp bindir. This
# is a genuine end-to-end invocation; only jq is withheld.
case3() {
  local NAME="case3 jq-missing fallthrough: no jq on PATH → exit 0, no stdout, no request"
  local H; H="$(fresh_home)"
  local REQDIR="$H/.claude/plan-reader/requests"
  # App is live & fresh so the ONLY reason to fall through is the missing jq.
  touch "$H/.claude/plan-reader/app.alive"

  local BIN="$H/bin"
  mkdir -p "$BIN"
  # Symlink the tools the hook may invoke — but NOT jq. (bash is the interpreter; include it too.)
  local t src
  for t in bash cat date stat mkdir printf sleep ls mv rm jot head sh env; do
    src="$(command -v "$t" 2>/dev/null || true)"
    [ -n "$src" ] && ln -sf "$src" "$BIN/$t"
  done
  # Guard: jq must NOT be reachable via $BIN.
  if [ -e "$BIN/jq" ]; then rm -f "$BIN/jq"; fi

  local PAYLOAD
  PAYLOAD="$(jq -nc '{tool_input:{plan:"valid plan body"}, session_id:"s", cwd:"/c", transcript_path:"/t"}')"

  local OUT="$H/stdout.txt"
  local RC START END ELAPSED
  START="$(date +%s)"
  # PATH is ONLY our jq-less bindir. command -v jq must fail → hook exits 0 immediately.
  HOME="$H" PATH="$BIN" bash "$HOOK" >"$OUT" 2>/dev/null <<<"$PAYLOAD"
  RC=$?
  END="$(date +%s)"
  ELAPSED=$((END - START))

  local ok=1
  # Confirm the premise actually held: jq was NOT resolvable under the test PATH. Run the check in
  # a CHILD bash so the PATH override genuinely scopes the lookup (a `PATH=x command -v` prefix in
  # the current shell can consult the shell's hash table / not re-scope a builtin reliably).
  if env -i PATH="$BIN" bash -c 'command -v jq >/dev/null 2>&1'; then
    fail "$NAME (test setup invalid: jq IS reachable under restricted PATH)"; ok=0
  fi
  [ "$RC" -eq 0 ] || { fail "$NAME (exit code $RC != 0)"; ok=0; }
  [ "$ELAPSED" -le 3 ] || { fail "$NAME (took ${ELAPSED}s — should be instant)"; ok=0; }
  if ls "$REQDIR"/*.json >/dev/null 2>&1; then
    fail "$NAME (a request file was written — must be none)"; ok=0
  fi
  if [ -s "$OUT" ]; then
    fail "$NAME (emitted stdout — must be empty)"
    printf '  stdout: %s\n' "$(cat "$OUT")"
    ok=0
  fi

  [ "$ok" = 1 ] && pass "$NAME"
  rm -rf "$H"
}

# ─────────────────────────────────────────────────────────────────────────────
# CASE 4 — Mid-review quit: app dies AFTER the request is written → hook falls
#          through within ~10s (NOT the full 570s deadline), emitting NO decision.
# ─────────────────────────────────────────────────────────────────────────────
# The app is live when the hook starts (so it writes a request and begins polling).
# Once the request file appears we remove app.alive to simulate the app quitting.
# The in-loop staleness re-check must then fire (stat fails → MTIME=0 → huge age)
# and exit 0 within ~10s. We allow up to 13s of headroom.
case4() {
  local NAME="case4 mid-review-quit: app dies after request written → hook exits within ~13s, no decision"
  local H; H="$(fresh_home)"
  local REQDIR="$H/.claude/plan-reader/requests"
  local ALIVE="$H/.claude/plan-reader/app.alive"

  # Heartbeat present & fresh so the hook does NOT fast-fallthrough — it reaches the poll loop.
  touch "$ALIVE"

  local PAYLOAD
  PAYLOAD="$(jq -nc '{tool_input:{plan:"a perfectly valid plan body"}, session_id:"s", cwd:"/c", transcript_path:"/t"}')"

  local OUT="$H/stdout.txt"
  ( HOME="$H" PATH="$PATH" bash "$HOOK" >"$OUT" 2>/dev/null ) <<<"$PAYLOAD" &
  local HOOK_PID=$!

  # Wait (up to ~3s) for the request file to appear — proves the hook entered the poll loop.
  local REQ="" i
  for i in $(seq 1 30); do
    REQ="$(ls "$REQDIR"/*.json 2>/dev/null | head -1 || true)"
    [ -n "$REQ" ] && break
    sleep 0.1
  done

  local ok=1
  if [ -z "$REQ" ]; then
    fail "$NAME (no request file written — hook never reached the poll loop)"; ok=0
    kill "$HOOK_PID" 2>/dev/null || true
    wait "$HOOK_PID" 2>/dev/null || true
    rm -rf "$H"
    return
  fi

  # Simulate the app quitting MID-review: remove the heartbeat. (stat will now fail → MTIME=0.)
  rm -f "$ALIVE"

  # The hook must now fall through within ~10s (we allow 13s headroom). Poll its liveness.
  local START END ELAPSED j
  START="$(date +%s)"
  for j in $(seq 1 130); do
    kill -0 "$HOOK_PID" 2>/dev/null || break
    sleep 0.1
  done
  END="$(date +%s)"
  ELAPSED=$((END - START))

  if kill -0 "$HOOK_PID" 2>/dev/null; then
    fail "$NAME (hook still running after ${ELAPSED}s — it did NOT detect the quit)"; ok=0
    kill "$HOOK_PID" 2>/dev/null || true
  fi
  wait "$HOOK_PID" 2>/dev/null || true

  [ "$ELAPSED" -le 13 ] || { fail "$NAME (took ${ELAPSED}s, expected <=13s)"; ok=0; }
  # It must NOT have emitted a decision (no response was ever written).
  if [ -s "$OUT" ]; then
    fail "$NAME (emitted stdout/decision — must be empty on a quit-fallthrough)"
    printf '  stdout: %s\n' "$(cat "$OUT")"
    ok=0
  fi

  [ "$ok" = 1 ] && pass "$NAME"
  rm -rf "$H"
}

echo "── HOOK_SCRIPT shell tests ──"
case1
case2
case3
case4
echo "─────────────────────────────"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "$FAILS case(s) FAILED"
  exit 1
fi
