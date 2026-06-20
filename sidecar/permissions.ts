// Agent SDK sidecar — pure permission + status helpers.
//
// Extracted from index.ts so the load-bearing decisions are UNIT-TESTABLE without importing
// index.ts (which has top-level side effects: the embedded-CLI `binPath` import and a stdin
// reader). NO module-level side effects here — pure functions plus one self-contained factory
// (`createInteractivePermissionGate`) whose state is closed over per-instance, not at module scope.

import type {
  HookCallback,
  HookJSONOutput,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

// The tool that is round-tripped to the frontend for plan review. Retained as a named export for
// callers/tests that reference the plan-emission tool specifically.
export const REVIEW_TOOL = "ExitPlanMode" as const;

// The INTERACTIVE tools — those that must NOT be auto-allowed in the sidecar but are instead held
// for the host (frontend) to resolve via a round-trip. Two members:
//   - ExitPlanMode    — the plan emission; the host reviews the plan and approves/denies.
//   - AskUserQuestion — the SDK's built-in question tool; the host collects the user's answers and
//                       resolves with `updatedInput` carrying those answers (see the resolve seam).
// Every OTHER tool is auto-allowed synchronously in-process (no round-trip, no pending entry).
export const INTERACTIVE_TOOLS: ReadonlySet<string> = new Set(["ExitPlanMode", "AskUserQuestion"]);

// Whether a tool must be HELD for the host to resolve (true) or auto-allowed in-process (false).
// True for the interactive tools (ExitPlanMode + AskUserQuestion); false for everything else.
export function isReviewTool(toolName: string): boolean {
  return INTERACTIVE_TOOLS.has(toolName);
}

// ---------------------------------------------------------------------------
// Host-asserted policy backstop.
//
// The SDK silently flips its own permission mode out of "plan" the moment an
// ExitPlanMode approval resolves — and this gate auto-allows every non-interactive
// tool — so file writes sailed through phases the HOST still considered planning.
// The host (frontend orchestrator) is the authority on the flow's phase: it asserts
// the policy via the `set-permission-mode` command, and the gate consults that
// policy (via an injected getter) to deny MUTATING tools while it is "plan".
// ---------------------------------------------------------------------------

// The host-asserted policy. "plan" denies the mutating tools; "acceptEdits" allows them;
// "prototype" allows them ONLY for paths strictly under `<cwd>/.plan-tree/prototype/`
// (the prototype scratch area) while behaving exactly like "plan" for everything else.
export type HostPolicy = "plan" | "acceptEdits" | "prototype";

// The CLOSED set of file-mutating tools denied under the "plan" policy. Deliberately
// narrow: Task/Read/Grep/Glob/Bash stay allowed (planning subagents need them).
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

// The deny message fed back to the model when a mutating tool is blocked under "plan".
export const PLAN_POLICY_WRITE_DENY =
  "You are in a planning phase; do not modify files until the current plan is approved.";

// The deny message fed back to the model when a mutating tool targets a path OUTSIDE the
// prototype scratch area while the host policy is "prototype".
export const PROTOTYPE_POLICY_WRITE_DENY =
  "You are in the prototype phase; file writes are only allowed under .plan-tree/prototype/ " +
  "— do not modify any other files.";

// Write-shaped Bash command patterns denied under the "plan" policy. Bash is NOT in
// MUTATING_TOOLS (planning subagents need grep/find/ls/cat/test runs), but an unconditional
// allow let `echo … > file`, `rm`, `sed -i`, `git checkout` etc. mutate the tree during
// planning. Exported as DATA so the set is testable member-by-member.
//
// BEST-EFFORT BLOCKLIST, NOT A SANDBOX (this is the "plan" tier ONLY — "prototype" uses the
// fail-closed ALLOWLIST in bashDecisionFor below). The "plan" tier must PRESERVE the documented
// test-run capability (`cargo test` / `npm test` / `npx vitest`), so it stays a blocklist; the
// holes the S1+S2 finding identified (no-space/clobber redirects, `python -c`/`node -e` style
// interpreters, archive/file-write tools) are closed here. Quoting tricks can still slip a
// blocklist — the interrupt-bounded approval window + SDK plan mode are the primary mitigations,
// and the durable boundary is the named OS `sandbox-exec` follow-on.

// An OUTPUT redirect that WRITES A FILE, whitespace-INSENSITIVE and incl. the `>|` clobber, the
// no-space form (`x>f`), and the numbered/merged-fd forms (`1>f`, `2>f`, `2>>f`, `&>f`, `&>>f`,
// `>&f` where the target is a FILE). The ONLY redirects that are NOT file writes are fd-DUP/close
// (`2>&1`, `>&2`, `2>&-`): a `>{1,2}` whose target is `&<digit>` or `&-`. The negative lookahead
// `(?!&[0-9-])` excludes exactly those, so a digit/`&` BEFORE `>` is no longer mistaken for a
// non-write (the DA-found escape: `echo x 1>/tmp/evil`, `cat foo 1>out`, `echo x &>file`).
//
// A redirect whose TARGET is the bit-bucket `/dev/null` is a DISCARD, not a tree write — it is the
// idiomatic way to silence stderr/stdout on a read-only command. This holds for BOTH the truncate
// form (`rg … 2>/dev/null`, `cmd >/dev/null`, `&>/dev/null`) AND the append form (`cmd 2>>/dev/null`,
// `cmd &>>/dev/null`, `cmd >>/dev/null`) — appending to the bit-bucket discards just the same. The
// `/dev/null` negative lookahead excludes both so the read-only command is not misclassified as a
// file-write and denied. The lookahead is anchored AFTER the first `>` and tolerates an optional
// second `>` (`>?`) so the discard exclusion covers `>>` as well as `>`, without letting an append
// to a REAL file slip through. `/dev/null` must be the COMPLETE target — it is terminated by
// whitespace, a pipe/separator (`|`/`;`/`&`), a further redirect (`>`), or end of string; a path
// that merely PREFIXES it (`/dev/null.bak`, `/dev/nullish`) is a REAL file and still matches. A REAL
// file target (`> out.txt`, `2> err.log`, `>> log`) stays DENIED, and a command that mixes a discard
// with a real redirect (`cmd 2>>/dev/null > out.txt`) is still DENIED by the real `> out.txt`.
const OUTPUT_REDIRECT = /(?:[0-9]*|&)>(?!&[0-9-])(?!>?\s*\/dev\/null(?:[\s|;&>]|$))>?\|?/;

export const BASH_WRITE_DENY_PATTERNS: ReadonlyArray<RegExp> = [
  // File-write output redirection (shared with the prototype allowlist — one definition).
  OUTPUT_REDIRECT,
  /\btee\b/,
  /\bsed\s+-i\b/,
  /\brm\s/,
  /\bmv\s/,
  /\bcp\s/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\btruncate\b/,
  /\bdd\b/,
  /\binstall\b/,
  /\bln\s/,
  /\bpatch\b/,
  /\bxargs\b/,
  // Archive tools that extract/create files. `tar -x` (extract) and the create/unpack helpers.
  /\btar\b[^|;&]*\s-?-?x/,
  /\bunzip\b/,
  /\bchmod\b/,
  /\bgit\s+(apply|checkout|restore|clean|reset|stash|commit|add|rm|mv)\b/,
  // Interpreters invoked with an INLINE-CODE flag can write arbitrarily (`python -c`, `node -e`,
  // `perl -e`, `ruby -e`, `sh -c`, `bash -c`, `osascript -e`). Deny the inline-code form.
  /\b(python[0-9.]*|node|perl|ruby)\b[^|;&]*\s-(c|e)\b/,
  /\b(sh|bash|zsh|osascript)\b[^|;&]*\s-(c|e)\b/,
  // A here-string (`<<<`) or heredoc (`<< EOF`) feeds inline code to an interpreter — same
  // arbitrary-write risk as an inline-code flag.
  /<<</,
  /<<\s*\w/,
  // `find` write/exec actions: the COMPLETE exec family (`-exec`, `-execdir`, `-ok`, `-okdir`),
  // `-delete`, and the `-f*` FILE-WRITE family (`-fls`, `-fprint`, `-fprint0`, `-fprintf`).
  // `exec(dir)?` / `ok(dir)?` cover the `dir` twins WITHOUT the no-boundary pitfall (a `\b` cannot
  // sit between `ok` and `dir`, so a bare `ok\b` missed `-okdir`). `f(print0?|printf|ls)` covers all
  // four `-f*` writes WITHOUT the trailing-\b pitfall (`\b` cannot sit between `fprint` and the
  // trailing `f`, so a bare `fprint)\b` missed `-fprintf`; `-fls`/`-fprint0` were absent). The
  // read-only `-f*` primaries `-fstype`/`-follow` and the stdout actions `-print`/`-print0`/
  // `-printf`/`-ls` are NOT matched (no `f` prefix on `-print*`/`-ls`; `-fstype`/`-follow` are not
  // in the alternation; `-ls` and `-okdir` differ in the `ok` vs `l` lead).
  /\bfind\b[^|;&]*\s-(delete|exec(dir)?|ok(dir)?|f(print0?|printf|ls))\b/,
];

// Whether a raw Bash command string looks write-shaped (any deny pattern matches). Non-string
// input (malformed tool input) is NOT flagged — the backstop never throws on shape. This backs
// the "plan" tier of bashDecisionFor.
export function isWriteShapedBashCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return BASH_WRITE_DENY_PATTERNS.some((p) => p.test(command));
}

// ---------------------------------------------------------------------------
// FAIL-CLOSED prototype Bash allowlist (INV-1).
//
// Under "prototype" the only window agent with Bash is `intent-clarifier`, which writes its
// artifacts through the CONTAINED Write tool (the prototype dir is pre-created host-side via
// OrchestratorDeps.ensurePrototypeDir, so `mkdir` is never needed). So Bash here may run ONLY
// when every segment is a PROVABLY READ-ONLY command. Anything unrecognized fails closed → deny.
// ---------------------------------------------------------------------------

// Read-only leading verbs that never write (a redirect is rejected separately). `echo` is in the
// same class but, like the others, only when no output redirect follows.
const PROTOTYPE_READONLY_VERBS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "pwd",
  "wc",
  "which",
  "file",
  "stat",
  "echo",
  // `cd <dir>` is read-only: it only changes the shell's working directory. It is commonly
  // chained before a read (`cd ~/x && rg foo`); the per-segment write check (redirects, etc.)
  // still runs on every segment, so allowing the `cd` verb opens no write hole.
  "cd",
]);

// The read-only `git` subcommands the prototype allowlist permits (no working-tree / repo writes).
const PROTOTYPE_GIT_READONLY_SUBCMDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
]);

// `find` action tokens that turn a read-only traversal into a write (or arbitrary exec).
// Covers the COMPLETE findutils EXEC family (`-exec`, `-execdir`, `-ok`, `-okdir` — each runs an
// arbitrary command; `-okdir` is the interactive twin of `-execdir`), `-delete`, and the COMPLETE
// `-f*` FILE-WRITE family (`-fls`, `-fprint`, `-fprint0`, `-fprintf` — each takes a FILE argument
// and writes it). Omitting any (the Medium escape) let e.g. `find . -fls out.txt` or
// `find . -okdir cat {} ;` slip through the fail-closed prototype allowlist. NOTE the read-only
// `-f*` primaries (`-fstype` TEST, `-follow` option) and the stdout actions (`-print`, `-print0`,
// `-printf`, `-ls`) are deliberately NOT here — they do not write a file, and exact-equality
// matching keeps them allowed.
const FIND_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

// Whitespace tokenizer (quote-naive — splits on runs of whitespace). Good enough for the
// fail-closed allowlist: anything it can't cleanly classify denies anyway.
function bashTokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter((t) => t.length > 0);
}

// Whether a SINGLE pipeline segment is provably read-only under the prototype allowlist.
function isReadOnlyPrototypeSegment(rawSegment: string): boolean {
  const segment = rawSegment.trim();
  if (segment.length === 0) return false; // an empty segment (e.g. trailing `;`) is not provable.
  // Env-assignment prefix (`FOO=bar …`) is never provably read-only — it can prefix any command.
  const tokens = bashTokens(segment);
  if (tokens.length === 0) return false;
  if (/^\w+=/.test(tokens[0])) return false;
  // Any output redirect makes the segment write-shaped (even for a read-only verb).
  if (OUTPUT_REDIRECT.test(segment)) return false;

  const verb = tokens[0];

  if (verb === "git") {
    // No global flag that can redirect the repo or inject config-run commands (`-C`, `-c`,
    // `--git-dir`, etc.): the token immediately after `git` must be the subcommand itself.
    const sub = tokens[1];
    if (sub === undefined || sub.startsWith("-")) return false;
    if (!PROTOTYPE_GIT_READONLY_SUBCMDS.has(sub)) return false;
    // `git branch` is read-only ONLY in its `--list` form (a bare `git branch` lists; but
    // `git branch <name>` CREATES). Require an explicit `--list` to stay provably read-only.
    if (sub === "branch" && !tokens.includes("--list")) return false;
    return true;
  }

  if (verb === "find") {
    // Read-only traversal only — no write/exec action token anywhere in the segment.
    if (tokens.some((t) => FIND_WRITE_ACTIONS.has(t))) return false;
    return true;
  }

  return PROTOTYPE_READONLY_VERBS.has(verb);
}

// The ONE shared Bash decision both the PreToolUse hook tier and the canUseTool gate call, so the
// two tiers cannot drift. Returns a deny-reason string, or null to ALLOW.
//   - "acceptEdits" → unrestricted (always allow).
//   - "plan"        → blocklist (preserve test runs; deny the extended write set). Non-string
//                     command → allow (the backstop never throws on shape — matches legacy).
//   - "prototype"   → FAIL-CLOSED ALLOWLIST: allow only when every segment is provably read-only
//                     and there is no command-substitution. Non-string / unrecognized → DENY.
export function bashDecisionFor(policy: HostPolicy, command: unknown): string | null {
  if (policy === "acceptEdits") return null;

  if (policy === "plan") {
    return isWriteShapedBashCommand(command) ? PLAN_POLICY_WRITE_DENY : null;
  }

  // policy === "prototype": fail closed.
  if (typeof command !== "string" || command.trim().length === 0) {
    return PLAN_POLICY_WRITE_DENY;
  }
  // Command substitution is never provably read-only (the inner command is unconstrained).
  // Process substitution `<(…)`/`>(…)` is the same hazard — the inner command runs unconstrained
  // (and the substituted /dev/fd path can hide a write), so it is rejected up front for the same
  // reason as `$(`/backtick.
  if (
    command.includes("$(") ||
    command.includes("`") ||
    command.includes("<(") ||
    command.includes(">(")
  ) {
    return PLAN_POLICY_WRITE_DENY;
  }
  // Every segment (split on the shell control operators) must be provably read-only. The splitter
  // covers ALL command separators that can chain a second command after an allowlisted leading verb:
  //   `||` `&&` `;` `|`  AND  bare `&` (background), and the newline forms `\n`/`\r`.
  // `&&` is kept BEFORE the bare-`&` alternative so a logical-AND is not mis-split into two bare-`&`
  // boundaries. The bare-`&` alternative is `&(?![>&])` and is preceded by `(?<![>&])` so it does NOT
  // match the `&` inside an fd-redirect (`2>&1`, `>&2`, `&>file`, `&>>file`) — those `&`s are part of
  // a redirect, not a command separator, and the redirect itself is caught by OUTPUT_REDIRECT in the
  // per-segment check (a fd-to-FILE redirect denies; a fd-DUP like `2>&1` is read-only and allowed).
  // A trailing separator (`cmd &`, `cmd ;`) yields an empty segment, which the empty-segment rule in
  // isReadOnlyPrototypeSegment rejects (fail closed) — so `cmd &` denies.
  const segments = command.split(/\|\||&&|;|\||(?<![>&])&(?![>&])|\n|\r/);
  const allReadOnly = segments.every((seg) => isReadOnlyPrototypeSegment(seg));
  return allReadOnly ? null : PLAN_POLICY_WRITE_DENY;
}

// Map an incoming `set-permission-mode` wire mode to the host policy. ONLY "acceptEdits"
// and "prototype" widen the policy (and "prototype" only narrowly — see HostPolicy); every
// other value (including the SDK-only "default"/"bypassPermissions" and malformed input)
// fails closed to "plan".
export function hostPolicyForMode(mode: unknown): HostPolicy {
  if (mode === "acceptEdits") return "acceptEdits";
  if (mode === "prototype") return "prototype";
  return "plan";
}

// Map a wire mode to the PermissionMode actually handed to the SDK. "prototype" is a
// HOST-ONLY policy — the SDK's PermissionMode union does not include it, and SDK "plan"
// mode hard-blocks Write at the CLI level regardless of canUseTool — so "prototype" runs
// the SDK in "default" mode and relies on the host-policy gate above for enforcement.
// Unknown/malformed input maps to "default" (the SDK's own fail-safe baseline; the HOST
// policy still fails closed to "plan" via hostPolicyForMode).
export function sdkPermissionMode(mode: unknown): "plan" | "acceptEdits" | "default" {
  if (mode === "plan") return "plan";
  if (mode === "acceptEdits") return "acceptEdits";
  return "default";
}

// Split a path into its meaningful segments: "/"-separated, with empty segments (doubled or
// trailing slashes) and "." (current dir, a no-op) dropped. Deliberately does NOT collapse
// ".." — collapsing is exactly what would let a traversal be laundered into legality before
// the containment check; instead ".." is REJECTED outright by isPrototypeWritePath.
function pathSegments(p: string): string[] {
  return p.split("/").filter((s) => s !== "" && s !== ".");
}

// Whether `filePath` (a mutating tool's target) is allowed under the "prototype" policy:
// it must resolve to a path STRICTLY UNDER `<cwd>/.plan-tree/prototype/`. Pure + fail-closed:
//   - non-string / empty filePath → false (malformed tool input never allows).
//   - any ".." segment → false, checked BOTH on the raw input (BEFORE resolving against cwd)
//     AND on the resolved segments (no traversal escapes — `…/prototype/../../etc/passwd` is
//     rejected up front, never collapsed into something that might pass).
//   - relative paths resolve against `cwd`; the resolved path must extend the prototype root
//     by at least one segment (the root directory itself is NOT a writable target) and match
//     it segment-for-segment (so a `prototype-evil/` sibling cannot pass a string-prefix test).
export function isPrototypeWritePath(cwd: string, filePath: unknown): boolean {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  // Reject traversal BEFORE resolution: a ".." segment anywhere in the raw path is an
  // escape attempt regardless of what it would collapse to.
  if (filePath.split("/").includes("..")) return false;
  const resolved = filePath.startsWith("/")
    ? pathSegments(filePath)
    : [...pathSegments(cwd), ...pathSegments(filePath)];
  // And AFTER resolution (the cwd side could smuggle one in).
  if (resolved.includes("..")) return false;
  const root = [...pathSegments(cwd), ".plan-tree", "prototype"];
  // STRICTLY under the root: longer than it, and matching it segment-for-segment.
  if (resolved.length <= root.length) return false;
  return root.every((seg, i) => resolved[i] === seg);
}

// ---------------------------------------------------------------------------
// PreToolUse HOOK tier enforcement for the "prototype" policy.
//
// The canUseTool gate above is the LAST tier in the SDK's permission precedence:
//   PreToolUse hooks → deny rules → permission mode → allow rules → canUseTool.
// Under "prototype" the SDK runs in permissionMode "default" (SDK "plan" mode is not
// usable — it hard-blocks Write at the CLI level), so a user's ~/.claude/settings.json
// `permissions.allow` rule (e.g. "Write", "Edit(**)", "Bash(*)") would auto-allow the
// tool at the allow-rules tier — BEFORE canUseTool ever runs — bypassing the prototype
// containment entirely (settingSources loads user/project/local settings). This hook
// re-applies EXACTLY the same prototype rules at the PreToolUse tier, which PRECEDES
// allow rules, so user allow-rules cannot bypass the containment.
//
// Under "plan" the hook passes through: SDK "plan" mode blocks writes at the mode tier,
// which also precedes allow rules (and the canUseTool backstop covers the rest).
// Under "acceptEdits" the hook passes through: that policy is intentionally permissive.
// ---------------------------------------------------------------------------

// The pure decision: deny-reason string, or null to pass through. Reuses the SAME
// predicates the canUseTool gate applies under "prototype" — MUTATING_TOOLS targets must
// resolve strictly under `<cwd>/.plan-tree/prototype/` (null cwd fails closed), and
// write-shaped Bash is denied (same constant the gate feeds back today).
export function prototypeHookDecision(
  policy: HostPolicy,
  cwd: string | null,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (policy !== "prototype") return null;
  if (MUTATING_TOOLS.has(toolName)) {
    const target = input.file_path ?? input.notebook_path;
    if (cwd === null || !isPrototypeWritePath(cwd, target)) {
      return PROTOTYPE_POLICY_WRITE_DENY;
    }
    return null;
  }
  if (toolName === "Bash") {
    // The ONE shared decision — same helper the canUseTool gate calls, so the tiers never drift.
    return bashDecisionFor("prototype", input.command);
  }
  return null;
}

// Factory for the SDK `HookCallback` registered under `options.hooks.PreToolUse`.
// `getHostPolicy` / `getCwd` are consulted PER CALL (never captured) so a live host
// policy flip takes effect immediately — same injection contract as the gate above.
// Returns `{}` (no-op SyncHookJSONOutput) to pass through; a deny is returned as the
// SDK's PreToolUseHookSpecificOutput deny shape.
export function createPrototypePreToolUseHook(
  getHostPolicy: () => HostPolicy,
  getCwd: () => string | null,
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    // Hooks receive a discriminated union; only PreToolUse inputs carry tool_name/tool_input.
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput: Record<string, unknown> =
      typeof input.tool_input === "object" && input.tool_input !== null
        ? (input.tool_input as Record<string, unknown>)
        : {};
    const reason = prototypeHookDecision(getHostPolicy(), getCwd(), input.tool_name, toolInput);
    if (reason === null) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Interactive-hold SERIALIZATION.
//
// At most ONE interactive hold (ExitPlanMode / AskUserQuestion) may be live at a
// time. The host UI surfaces a single approval/question card; two concurrent holds
// (e.g. an AskUserQuestion arriving while an ExitPlanMode plan review is still
// awaiting the user) would collide — a held approval could be resolved against the
// wrong card. So the SECOND interactive request is denied IMMEDIATELY (fed back to
// the model as a tool error telling it to ask sequentially); the FIRST proceeds and
// holds. Non-interactive tools are never affected (they auto-allow in-process). When
// the live hold resolves (allow/deny) or aborts, the slot frees for the next request.
// ---------------------------------------------------------------------------

// The deny message handed back to the model when a second interactive request collides
// with a live interactive hold. Instructs it to retry sequentially after the first resolves.
export const SEQUENTIAL_INTERACTIVE_DENY =
  "Another approval/question is already awaiting the user; ask again after it resolves.";

// Whether an arriving interactive request must be denied-as-busy. True iff the tool is
// interactive AND there is already a live interactive hold. Pure: the caller passes the
// current live-hold flag. Non-interactive tools always return false (never serialized).
export function shouldDenyConcurrentInteractive(
  toolName: string,
  hasLiveInteractiveHold: boolean,
): boolean {
  return isReviewTool(toolName) && hasLiveInteractiveHold;
}

// Build the `allow` PermissionResult. It ALWAYS carries `updatedInput` (the echoed tool input):
// the SDK's runtime Zod validator REQUIRES it on an allow result, even though the published
// `.d.ts` marks it optional — a bare `{ behavior: "allow" }` fails with a ZodError, which the
// SDK then turns into an `is_error` tool result. Echoing the original input is a no-op semantically
// (the tool runs with its original args) while satisfying the validator.
export function allowResult(input: Record<string, unknown>): PermissionResult {
  return { behavior: "allow", updatedInput: input };
}

// Build the `deny` PermissionResult with a feedback message (fed back to the model as a tool error).
export function denyResult(message: string): PermissionResult {
  return { behavior: "deny", message };
}

// Choose the `updatedInput` for an ALLOW resolve. The host may supply an explicit `updatedInput`
// (the AskUserQuestion answers: `{ questions, answers }`); when it does and it is an object, use it.
// Otherwise fall back to the stored tool input (the ExitPlanMode behavior — echo so the SDK's runtime
// validator is satisfied and the tool runs with its original args). Returns the object to wrap in
// allowResult(). `provided` is whatever arrived on the wire (possibly undefined/null/non-object).
export function resolveAllowInput(
  provided: unknown,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  if (provided != null && typeof provided === "object") {
    return provided as Record<string, unknown>;
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Interactive permission GATE — the canUseTool seam, factored out of index.ts so its
// full register / serialize / free behavior is unit-testable. State (the pending-hold
// map) is closed over per-instance; there is NO module-level side effect.
//
// Behavior:
//   - Non-interactive tool → auto-allow in-process (echoed updatedInput). No emit, no hold.
//   - Interactive tool, slot FREE → emit `tool_permission_requested`, register a pending
//     hold keyed by toolUseID, await the host's resolve raced against the abort signal.
//   - Interactive tool, slot BUSY (a live interactive hold already pending) → deny
//     IMMEDIATELY with SEQUENTIAL_INTERACTIVE_DENY; do NOT register a second hold.
//   - resolve(id, result) frees the slot and settles the awaiting promise.
//   - abort (interrupt) frees the slot and settles with deny("interrupted").
// ---------------------------------------------------------------------------

type PermResolver = (r: PermissionResult) => void;
interface PendingHold {
  resolve: PermResolver;
  input: Record<string, unknown>;
}

export interface CanUseToolOptions {
  signal: AbortSignal;
  toolUseID: string;
  agentID?: string;
}

export interface InteractivePermissionGate {
  /** The canUseTool callback handed to the SDK `query` options. */
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>;
  /** Resolve a held interactive request by toolUseID. Returns true if a hold was found+settled. */
  resolve: (id: string, result: PermissionResult) => boolean;
  /** Test/introspection: number of live interactive holds (0 or 1 under the serialization invariant). */
  pendingCount: () => number;
  /** Test/introspection: the stored input for a held id (for the ExitPlanMode echo path). */
  storedInput: (id: string) => Record<string, unknown> | undefined;
}

// `emit` is injected (index.ts wires its fd-1 framer); the gate never touches stdout itself.
// `getHostPolicy` is consulted PER REQUEST (never captured) so a live host policy flip takes
// effect immediately — it backstops the SDK's own mode, which silently leaves "plan" on approval.
// `getCwd` (also consulted per request) supplies the session's working directory for the
// "prototype" policy's path containment check; it defaults to `() => null`, under which the
// prototype policy denies ALL mutating tools (fail closed — no cwd, no containment, no writes).
export function createInteractivePermissionGate(
  emit: (frame: Record<string, unknown>) => void,
  getHostPolicy: () => HostPolicy,
  getCwd: () => string | null = () => null,
): InteractivePermissionGate {
  // Only interactive tools are ever stored here, so a non-empty map IS a live interactive hold.
  const pending = new Map<string, PendingHold>();

  const canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> => {
    // BACKSTOP: while the host asserts "plan", the mutating tools are denied in-process —
    // regardless of what mode the SDK believes it is in. Mutating tools are never interactive,
    // so this fires before (and never interferes with) the hold logic below.
    if (MUTATING_TOOLS.has(toolName) && getHostPolicy() === "plan") {
      return Promise.resolve(denyResult(PLAN_POLICY_WRITE_DENY));
    }

    // BACKSTOP (prototype): mutating tools are allowed ONLY when their target path resolves
    // strictly under `<cwd>/.plan-tree/prototype/`. A null cwd fails CLOSED (deny) — without
    // a cwd there is no containment boundary to check against. Everything outside the
    // prototype scratch area is denied with the prototype-phase message.
    if (MUTATING_TOOLS.has(toolName) && getHostPolicy() === "prototype") {
      const cwd = getCwd();
      const target = input.file_path ?? input.notebook_path;
      if (cwd === null || !isPrototypeWritePath(cwd, target)) {
        return Promise.resolve(denyResult(PROTOTYPE_POLICY_WRITE_DENY));
      }
    }

    // BACKSTOP (Bash): the ONE shared decision (bashDecisionFor) — IDENTICAL to the PreToolUse
    // hook tier, so the two tiers never drift. "plan" applies the extended write blocklist (test
    // runs preserved); "prototype" applies the FAIL-CLOSED read-only allowlist (anything not
    // provably read-only is denied — the SDK runs in "default" mode under prototype, so this host
    // check is the only Bash write backstop, and file writes must go through Write/Edit which the
    // containment check above scopes to the prototype area); "acceptEdits" is unrestricted.
    if (toolName === "Bash") {
      const reason = bashDecisionFor(getHostPolicy(), input.command);
      if (reason !== null) {
        return Promise.resolve(denyResult(reason));
      }
    }

    // Non-interactive: auto-allow in-process. No emit, no hold, no round-trip.
    if (!isReviewTool(toolName)) {
      return Promise.resolve(allowResult(input));
    }

    // SERIALIZE: at most ONE interactive hold live at a time. A second interactive request
    // is denied immediately (re-ask sequentially) and is NOT registered as a second hold.
    if (shouldDenyConcurrentInteractive(toolName, pending.size > 0)) {
      return Promise.resolve(denyResult(SEQUENTIAL_INTERACTIVE_DENY));
    }

    const id = options.toolUseID;

    emit({
      kind: "tool_permission_requested",
      id,
      tool: toolName,
      input,
      agent_id: options.agentID ?? null,
    });

    const resolverPromise = new Promise<PermissionResult>((resolve) => {
      pending.set(id, { resolve, input });
    });

    const abortPromise = new Promise<PermissionResult>((resolve) => {
      if (options.signal.aborted) {
        pending.delete(id);
        resolve(denyResult("interrupted"));
        return;
      }
      options.signal.addEventListener(
        "abort",
        () => {
          pending.delete(id);
          resolve(denyResult("interrupted"));
        },
        { once: true },
      );
    });

    return Promise.race([resolverPromise, abortPromise]);
  };

  const resolve = (id: string, result: PermissionResult): boolean => {
    const hold = pending.get(id);
    if (!hold) return false;
    pending.delete(id);
    hold.resolve(result);
    return true;
  };

  return {
    canUseTool,
    resolve,
    pendingCount: () => pending.size,
    storedInput: (id) => pending.get(id)?.input,
  };
}

// ---------------------------------------------------------------------------
// Status-label mapping for low-level progress signals (thinking / subagent tasks /
// rate-limit). Label-only — never the underlying text (privacy + noise).
// ---------------------------------------------------------------------------

// Map a low-level SDK progress signal to a SHORT status label, or null if the signal is not a
// recognized progress signal (caller drops + logs the unknown). `key` is the signal's discriminator
// (a system subtype or a top-level message type).
export function statusLabelFor(key: string): string | null {
  switch (key) {
    case "thinking_tokens":
      return "thinking…";
    case "task_started":
    case "task_progress":
    case "task_notification":
      return "running subagent";
    case "rate_limit_event":
      return "waiting (rate limit)";
    default:
      return null;
  }
}

// A de-dup throttle for status labels: emit a label ONLY when it CHANGES from the last emitted one.
// Stateful but isolated (one instance per session in index.ts); pure-logic + unit-testable.
export class StatusThrottle {
  private last: string | null = null;

  // Return [label] if it differs from the last emitted label (and record it), else [].
  next(label: string): string[] {
    if (label === this.last) return [];
    this.last = label;
    return [label];
  }

  // Clear the throttle so the next label always emits (call on turn boundaries / new session).
  reset(): void {
    this.last = null;
  }
}
