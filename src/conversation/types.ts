// Conversation domain (Sub-Plan 02) — wire types.
//
// SINGLE SOURCE OF TRUTH for the Agent SDK driver surface this domain consumes. Every field
// here is lifted VERBATIM (snake_case) from CONTRACT.md §"Agent SDK driver (Sub-Plan 01)" —
// the frozen command/event vocabulary. We consume ONLY fields the contract actually froze:
//   - no subagent-`name` field (none committed; the visible name is deferred to live smoke),
//   - no `skill_use` kind / skill-discriminator (skills surface as ordinary `tool_use`),
//   - the normalized error discriminator is `kind` (NOT `error_kind` — the sidecar's internal
//     `error_kind` is lifted into `kind` and dropped at the Rust seam, commit 84a3700).
//
// These interfaces are a written statement of the contract, not an observation of the wire.

// ---- agent-stream kinds (the committed `agent-stream` vocabulary) -------------------------
// Every frame carries a monotonic `seq` and a `kind`. The seven committed kinds:

export interface SystemInit {
  seq: number;
  kind: "system_init";
  model: string;
  cwd: string;
  tools: string[];
  skills: string[];
  slash_commands: string[];
  permission_mode: string;
  session_id: string;
}

export interface AssistantText {
  seq: number;
  kind: "assistant_text";
  text: string;
  // Non-null when the text originated inside a subagent sub-stream (groups under that agent).
  parent_tool_use_id: string | null;
}

export interface ToolUse {
  seq: number;
  kind: "tool_use";
  // Correlation key: matches a later tool_result's `tool_use_id`.
  id: string;
  tool: string;
  // Arbitrary structured tool input (rendered via textContent, never raw innerHTML).
  input: unknown;
  parent_tool_use_id: string | null;
}

export interface ToolResult {
  seq: number;
  kind: "tool_result";
  // Correlation key: matches an earlier tool_use's `id`.
  tool_use_id: string;
  // Tool output (text/structured). Rendered via textContent.
  content: unknown;
  is_error: boolean;
  parent_tool_use_id: string | null;
}

export interface ModeChange {
  seq: number;
  kind: "mode_change";
  // The new permissionMode (e.g. "plan" | "acceptEdits" | …) — drives the mode chip.
  mode: string;
}

export interface ResultMsg {
  seq: number;
  kind: "result";
  subtype: string;
  is_error: boolean;
  result: string;
  num_turns: number;
  duration_ms: number;
  total_cost_usd: number;
  session_id: string;
  // HOST-SIDE annotation, NEVER on the wire: set by the conversation controller (index.ts) when the
  // orchestrator deliberately interrupted this turn (the post-decomposition-approval boundary). It is
  // persisted on the STORED frame so every model rebuild re-reads the same verdict — by later
  // rebuilds the orchestrator has long de-armed `resuming`, so live state cannot reproduce it.
  deliberateInterrupt?: boolean;
}

export interface PermissionDenied {
  seq: number;
  kind: "permission_denied";
  tool: string;
  tool_use_id: string;
  agent_id: string | null;
  decision_reason_type: string;
  message: string;
}

// `status` — a lightweight, throttled "working" signal. The sidecar maps low-level SDK progress
// signals (thinking tokens, subagent task lifecycle, rate-limit notices) onto this kind, carrying a
// SHORT label ONLY (never the underlying text). It drives a single in-place "working…" indicator so
// the pane is never blank while the agent thinks / runs a subagent. Throttled at the source (emitted
// only when the label changes).
export interface StatusMsg {
  seq: number;
  kind: "status";
  // A short human label, e.g. "thinking…" | "running subagent" | "waiting (rate limit)".
  label: string;
}

// `subagent_started` — emitted when the agent spawns a subagent (Task/Agent tool). Carries the
// subagent's identity + task so its group renders a labeled header instead of an anonymous box.
// `tool_use_id` is the load-bearing key: it equals BOTH the parent Task tool_use's id AND the
// `parent_tool_use_id` carried by every child message of the subagent — so the model matches this
// frame to the subagent group keyed by that id. Any field may be null if the SDK omitted it.
export interface SubagentStarted {
  seq: number;
  kind: "subagent_started";
  tool_use_id: string;
  subagent_type: string | null;
  description: string | null;
  prompt: string | null;
}

// `resume_fallback` — emitted by the sidecar (Phase 4) when a session resume was
// requested but the SDK transcript was missing/expired (getSessionInfo pre-flight
// failed). NON-fatal: the sidecar drops the `resume` option and runs the current
// step fresh. The host surfaces a non-blocking notice (Phase 5's toast). Carries
// only a short reason string.
export interface ResumeFallback {
  seq: number;
  kind: "resume_fallback";
  reason: string;
}

// `quota_exceeded` — emitted by the sidecar (Phase 1) when the SDK reports the usage/rate-limit
// quota was hit, either via a rate-limit progress event or a thrown quota error. NON-fatal: it
// travels via `agent-stream` (NEVER `agent-error`), so the session is NOT torn down — a later
// phase's orchestrator owns the waiting banner + auto-resume when the quota resets.
//   - `resetAt` is epoch-MILLISECONDS (already normalized by the sidecar — do NOT re-scale).
//   - `source` distinguishes the two detection carriers: a rate-limit progress event vs. a thrown
//     quota error.
export interface QuotaExceeded {
  seq: number;
  kind: "quota_exceeded";
  resetAt: number;
  source: "rate_limit_event" | "thrown_error" | "result_error";
}

// The discriminated union of every committed agent-stream kind.
export type AgentStream =
  | SystemInit
  | AssistantText
  | ToolUse
  | ToolResult
  | ModeChange
  | ResultMsg
  | PermissionDenied
  | StatusMsg
  | SubagentStarted
  | ResumeFallback
  | QuotaExceeded;

// ---- the other four Tauri events (not agent-stream) ---------------------------------------

// `tool-permission-requested` — the canUseTool seam. Sub-Plan 02 RENDERS this as a marker but
// never resolves it (resolution is Sub-Plan 03's policy).
export interface ToolPermissionRequested {
  seq: number;
  kind: "tool_permission_requested";
  // The SDK toolUseID — the id Sub-Plan 03 round-trips via resolve_tool_permission.
  id: string;
  tool: string;
  input: unknown;
  // Non-null when the request originated inside a subagent, else null.
  agent_id: string | null;
}

// ---- AskUserQuestion tool input shape (the built-in question tool) ------------------------
//
// AskUserQuestion is an INTERACTIVE tool (like ExitPlanMode): the sidecar holds it and round-trips
// a `tool-permission-requested` event carrying `tool: "AskUserQuestion"` and this `input`. The host
// renders a question card, collects the user's selections, and resolves with `updatedInput` of shape
// `{ questions: <original>, answers: { "<question text>": "<label>" | ["<labels>"] } }`. The SDK keys
// `answers` by each question's `question` string; the value is the chosen option `label` (string), or
// an array of labels when `multiSelect` is true.
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  // The question text — ALSO the key under which this question's answer is returned.
  question: string;
  // A short header/title for the question card section.
  header: string;
  // 2–4 selectable options.
  options: QuestionOption[];
  // When true the user may pick multiple options (checkboxes); otherwise one (radios).
  multiSelect: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

// The answers payload returned under `updatedInput.answers`: keyed by question text, value is a
// single chosen label (single-select) or an array of labels (multiSelect).
export type AskUserQuestionAnswers = Record<string, string | string[]>;

// `agent-error` — normalized to the PUBLIC wire shape `{kind, message, fatal}`. `kind` is the
// discriminator; `error_kind` does NOT appear here (dropped at the Rust seam).
export interface AgentError {
  // "protocol" = the sidecar rejected a second `start` (fatal — a fresh process is required).
  kind: "auth" | "cwd" | "spawn" | "sdk" | "io" | "contamination" | "protocol";
  message: string;
  fatal: boolean;
}

// `agent-exit` — the sidecar process terminated.
export interface AgentExit {
  code: number;
}

// `agent-auth-required` — emitted when start is attempted with no stored token.
export type AgentAuthRequired = Record<string, never>;

// ---- command arg/result shapes -------------------------------------------------------------

// start_agent_session({ cwd, permissionMode })
export interface StartAgentSessionArgs {
  cwd: string;
  // "plan" for the planning flow; "acceptEdits" for Build mode.
  permissionMode: string;
}

// agent_auth_status() -> { hasToken }
export interface AgentAuthStatus {
  hasToken: boolean;
}

// The starting-mode toggle in the composer maps to a permissionMode string.
export type StartingMode = "plan" | "acceptEdits";
