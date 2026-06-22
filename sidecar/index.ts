// Agent SDK sidecar — Sub-Plan 01.
//
// A single-binary process (compiled with `bun build --compile`, see
// scripts/sidecar-build.mjs) that embeds the Claude Agent SDK and speaks
// newline-delimited JSON (JSON-lines) to the Rust driver over stdin/stdout.
//
// It NORMALIZES the SDK's large `SDKMessage` union into a small, stable wire
// vocabulary so the SDK's version volatility is encapsulated HERE and never
// leaks into Rust or the frontend. The committed `agent-stream` kinds are:
//   system_init | assistant_text | tool_use | tool_result | mode_change |
//   result | permission_denied
// (Unrecognized subtypes are dropped, logged to THIS process's stderr.)
//
// SERIALIZATION INVARIANT: every stdout frame is `JSON.stringify(...) + "\n"`
// and nothing bypasses JSON.stringify — so the only raw `\n`/`\r` on fd 1 is
// the single terminating `\n`. Raw CR/LF captured inside a payload (e.g. Bash
// output) stays escaped and cannot split a frame.

import {
  query,
  getSessionInfo,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import {
  allowResult,
  denyResult,
  resolveAllowInput,
  createInteractivePermissionGate,
  createPrototypePreToolUseHook,
  hostPolicyForMode,
  sdkPermissionMode,
  type HostPolicy,
} from "./permissions";
import { optionOverridesFromEnv } from "./env-overrides";
import { resolveModelEffort } from "./model-effort";
import { cliPlanRedirectSettings } from "./cli-plans";
import { decideStart } from "./session-start";
import { decideResume, resumeOption, RESUME_FALLBACK_REASON } from "./session-resume";
import { parseResetFromError } from "./quota";
import { createNormalizer, isOverloadedMessage, overloadResultFrame, type SeqCounter } from "./normalize";
import { decideBackoff, BACKOFF_MAX_RETRIES } from "./backoff";
import { planningAgents } from "./agents/planningAgents";
import { makeGracefulExit, drainQuery } from "./shutdown";
// The platform package carries the bundled `claude` CLI. Imported as a `file`
// so `bun build --compile` embeds it; `extractFromBunfs` unpacks it at runtime
// and yields the on-disk path we hand to `pathToClaudeCodeExecutable`.
// @ts-expect-error — `with { type: "file" }` import returns a path string the
// type system does not model; the platform pkg ships no `.d.ts` for it.
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" };

import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// stdout framing — the ONE writer of fd 1. Honors the serialization invariant.
// ---------------------------------------------------------------------------

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Diagnostics go to fd 2 only (never fd 1 — that would corrupt the channel). */
function logErr(...parts: unknown[]): void {
  process.stderr.write(parts.map(String).join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// 529 "Overloaded" backoff — net-new abort infra.
//
// There is NO AbortController anywhere else in the sidecar today. This single module-level one is
// aborted at the VERY TOP of graceful shutdown (wired into makeGracefulExit's onBeforeDrain below)
// so a SIGTERM/SIGINT/`end` arriving DURING a multi-minute 529 backoff sleep aborts the wait
// immediately instead of hanging the teardown for up to ~30 minutes.
// ---------------------------------------------------------------------------
const backoffAbort = new AbortController();

/** Sleep `ms`, resolving early (rejecting with the abort reason) if `backoffAbort` fires. ALWAYS
 *  clears its timer on settle so a resolved/aborted sleep never leaks a pending timeout that would
 *  pin the event loop. On abort the caller stops retrying and lets graceful shutdown proceed. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// The user message(s) of the IN-FLIGHT turn — captured at the push site (case "user") so a 529
// retry can re-seed a FRESH MessageQueue with the exact same input that drove the overloaded
// attempt. We never re-iterate the original queue (a second `query({prompt: sameQueue})` would
// create a second concurrent consumer of the same buffer → a drop/duplicate race). Cleared when a
// turn completes (a `result` frame) so the next turn starts empty and a later retry only ever
// re-pushes the CURRENT turn, never a stale prior one.
let pendingTurn: SDKUserMessage[] = [];

// ---------------------------------------------------------------------------
// Push-queue AsyncIterable<SDKUserMessage> — streaming-input mode.
//
// QUEUE LIFECYCLE INVARIANT (load-bearing): the iterator PARKS when empty
// (awaits a re-armed `notify` promise) and NEVER resolves `done` until an
// explicit `end`. An idle stdin must NOT signal end-of-input, or the SDK would
// terminate the session after turn 1. We use an unbounded internal buffer plus
// a `notify` promise re-armed after each park — not an ad-hoc promise swap,
// which can drop a turn under a feed/consume race.
// ---------------------------------------------------------------------------

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private ended = false;
  private notify: Promise<void>;
  private wake!: () => void;

  constructor() {
    this.notify = new Promise<void>((r) => (this.wake = r));
  }

  /** Re-arm the park promise, then wake any current waiter. Order matters: a
   * waiter that resumes must see a FRESH notify so the next park blocks again. */
  private signal(): void {
    const prevWake = this.wake;
    this.notify = new Promise<void>((r) => (this.wake = r));
    prevWake();
  }

  push(msg: SDKUserMessage): void {
    this.buffer.push(msg);
    this.signal();
  }

  end(): void {
    this.ended = true;
    this.signal();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      if (this.ended) return;
      // Park until push()/end() re-arms + wakes us.
      await this.notify;
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive permission gate — owns the pending-hold registry (toolUseID → hold) and
// the canUseTool seam. We RETAIN the tool `input` alongside the resolver because the
// SDK's runtime Zod validator REQUIRES `updatedInput` on an `allow` PermissionResult
// (the published `.d.ts` marks it optional, but the validator rejects its absence —
// every bare `{ behavior: "allow" }` then fails with a ZodError). On allow we echo the
// original input back as `updatedInput`. The gate ALSO serializes interactive holds:
// at most one ExitPlanMode/AskUserQuestion hold may be live at a time (a second is denied
// immediately so a held approval can never collide with a held clarify). The injected
// `emit` wrapper stamps the frame with the running `seq`.
// ---------------------------------------------------------------------------

// HOST-ASSERTED policy backstop. The host (frontend orchestrator) is the authority on the
// flow's phase; this variable is updated ONLY by the `set-permission-mode` command handler.
// It is DELIBERATELY NOT updated from SDK-originated mode_change frames: the SDK silently
// flips itself out of "plan" the moment an ExitPlanMode approval resolves, and that silent
// post-approval flip must NOT widen this policy — only an explicit host command may.
// Defaults to "plan" (fail closed: no file mutations until the host says otherwise) and is
// RE-ASSERTED from the `start` command's own permissionMode when the session begins (see the
// decideStart wiring), so a fresh session can never inherit a stale widened policy.
let hostPolicy: HostPolicy = "plan";

// The session's working directory, captured from the `start` command. The permission gate's
// "prototype" policy needs it for the `.plan-tree/prototype/` containment check. Null until
// start arrives — under which the prototype policy denies all mutating tools (fail closed).
let sessionCwd: string | null = null;

// The running, monotonic frame-sequence counter — SHARED (by reference) with the
// extracted normalizer so its `nextFrame` and these out-of-band emit sites (the
// permission gate's frames, resume_fallback, error, quota backstop) all draw from the
// ONE counter, byte-for-byte identical to the prior single-module behavior.
const seqCounter: SeqCounter = { value: 0 };

const permissionGate = createInteractivePermissionGate(
  (frame) => emit({ seq: seqCounter.value++, ...frame }),
  () => hostPolicy,
  () => sessionCwd,
);

// PreToolUse HOOK tier enforcement of the prototype containment. The canUseTool gate
// above is the LAST tier in the SDK's permission precedence — a user's settings.json
// `permissions.allow` rule (e.g. "Write") auto-allows the tool BEFORE canUseTool runs
// while the SDK sits in "default" mode (the prototype phase). Hooks run FIRST, before
// allow rules, so this re-applies the same prototype rules where allow-rules cannot
// bypass them. Reads the LIVE hostPolicy/sessionCwd via the same getters as the gate.
const prototypePreToolUseHook = createPrototypePreToolUseHook(
  () => hostPolicy,
  () => sessionCwd,
);

// ---------------------------------------------------------------------------
// Wire → SDKUserMessage lift. `parent_tool_use_id` is NON-OPTIONAL; we set it
// to null explicitly rather than relying on a lenient SDK accepting `{type,text}`.
//
// MULTIMODAL: an inbound `user` command may carry inline base64 images. The
// `string → content-array` migration + positional `[Image #N]` token injection
// happens HERE (the single authoritative point — see the cross-layer contract).
// With no images the content stays the BARE STRING (byte-identical to text-only
// today). The pure builders below are EXPORTED as the load-bearing test seam.
// ---------------------------------------------------------------------------

// The pure multimodal builders live in their own SDK-free module so they can be
// unit-tested without importing this entry (which embeds the `claude` binary). The
// load-bearing test seam (DA #6) is `user-content.ts`; re-exported here for callers.
// Value `import` (NOT a pure `export ... from`) so `buildUserContent` is a REAL
// local binding usable by `liftUserMessage` below. A pure re-export does NOT
// create a local binding: `tsc`/vitest accept the bare call, but `bun build
// --compile` renames the re-exported symbol and leaves the local call dangling
// → `ReferenceError: buildUserContent is not defined` at runtime. The public
// export surface (test seam) is preserved by re-exporting the same locals.
import { buildUserContent, injectTokens, toImageBlock } from "./user-content";
export { buildUserContent, injectTokens, toImageBlock };
// `import type` (NOT a pure `export type ... from`) so `InboundImage`/`ContentBlock`
// are REAL local type bindings usable below; re-exported separately to preserve the
// public test-seam surface.
import type { InboundImage, ContentBlock } from "./user-content";
export type { InboundImage, ContentBlock };

function liftUserMessage(text: string, images?: InboundImage[]): SDKUserMessage {
  // `buildUserContent` returns the generic `string | ContentBlock[]` shape (each
  // block matches the SDK's RESPONSE `ContentBlock`); `SDKUserMessage.message.content`
  // wants the INPUT `string | ContentBlockParam[]`. The runtime image objects ARE
  // valid `ImageBlockParam`s (type:"image" + base64 source) — only `media_type` is a
  // plain `string` rather than the SDK's literal union, so we annotate at this seam
  // (no runtime change) to the SDK input content type.
  const content = buildUserContent(text, images) as SDKUserMessage["message"]["content"];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

// ---------------------------------------------------------------------------
// Normalizer — SDKMessage → committed agent-stream kinds. Returns the wire
// object(s) to emit (a single assistant message can carry several text/tool_use
// blocks → several frames). Unknown subtypes return [] (dropped + logged).
// ---------------------------------------------------------------------------

// The normalizer body lives in its own SDK-message-only module (`normalize.ts`) so it can be
// unit-tested WITHOUT importing THIS entry (which embeds the `claude` binary AND installs a
// stdin readline loop + SIGTERM/SIGINT handlers at import time). It owns its `lastRateLimitInfo`
// + status throttle internally; we wire it the SHARED `seqCounter` (so its frame seq and our
// out-of-band emit sites stay one monotonic sequence) and the `logErr` sink.
const { normalize } = createNormalizer({ seq: seqCounter, logErr });

// ---------------------------------------------------------------------------
// canUseTool — the interactive permission seam. The full logic lives in the gate
// (createInteractivePermissionGate, sidecar/permissions.ts) so its register / serialize
// / free behavior is unit-testable without importing this side-effecting module.
//
// AUTO-ALLOW everything except the INTERACTIVE tools SYNCHRONOUSLY in the sidecar. Only the
// interactive tools (`ExitPlanMode` for plan review + `AskUserQuestion` for the question card)
// are round-tripped to the frontend; every other tool is allowed in-process without emitting
// `tool_permission_requested` and without registering a pending entry. This eliminates two
// failure modes seen in the live session:
//   1. ZodError — the allow result now ALWAYS carries `updatedInput` (the echoed input),
//      which the SDK's runtime validator requires (it rejected bare `{behavior:"allow"}`).
//   2. "Stream closed" races — fast/subagent tool calls no longer wait on a frontend
//      round-trip, so a slow UI hop can't outlive the tool-permission window.
//
// SERIALIZATION: at most ONE interactive hold is live at a time. A second interactive request
// (e.g. an AskUserQuestion arriving while an ExitPlanMode plan review is still awaiting the user)
// is denied IMMEDIATELY (re-ask sequentially) and is NOT registered as a second hold — so a held
// approval can never collide with a held clarify.
//
// For the INTERACTIVE tools ONLY: `id` is the SDK's `options.toolUseID` (NOT a minted id) so
// resolve round-trips line up; `agent_id` maps from `options.agentID`. The gate races the resolver
// against the abort signal (from `interrupt`): a cancel mid-permission resolves to a
// deny("interrupted") and frees the slot, so it can never deadlock.
// ---------------------------------------------------------------------------

const canUseTool = permissionGate.canUseTool;

// ---------------------------------------------------------------------------
// Boot — read the `start` command, build options, launch query, run the
// normalize loop. One session per process (Rust enforces one process/launch).
// ---------------------------------------------------------------------------

let q: Query | null = null;

interface StartCmd {
  type: "start";
  cwd: string;
  // The WIRE mode — may carry host-only values (e.g. "prototype") that the SDK's
  // PermissionMode union does not include; sdkPermissionMode() maps it before the SDK sees it.
  permissionMode: string;
  // Header-picker selection (Phase 1). Optional: null/absent/empty == not set.
  model?: string;
  effort?: string;
  // SDK session id to resume (Phase 4). Optional: absent/empty == fresh start.
  // When set, buildOptions adds the SDK `resume` option and runSession pre-flights
  // getSessionInfo, dropping it with a `resume_fallback` frame if the transcript is gone.
  resume?: string;
}

// Test-harness cost overrides — read ONCE at startup. Unset/invalid env →
// empty object → spreading it changes nothing (normal app behavior).
const envOverrides = optionOverridesFromEnv(process.env);
if (envOverrides.effort !== undefined || envOverrides.model !== undefined) {
  logErr(
    "[sidecar] env overrides active:",
    JSON.stringify(envOverrides),
    "(AGENT_EFFORT/AGENT_MODEL)",
  );
}

function buildOptions(start: StartCmd) {
  // The bundled CLI path — extracted from the compiled binary's embedded fs.
  const cliPath = extractFromBunfs(binPath as unknown as string);

  const modelEffort = resolveModelEffort(start, envOverrides);
  logErr(
    "[sidecar] resolved model=" +
      (modelEffort.model ?? "<default>") +
      " effort=" +
      (modelEffort.effort ?? "<default>"),
  );

  return {
    ...modelEffort,
    cwd: start.cwd,
    // NEVER the raw wire mode: host-only modes (e.g. "prototype") map to SDK "default"
    // (SDK "plan" hard-blocks Write at the CLI level regardless of canUseTool; the host
    // policy gate enforces the prototype containment instead).
    permissionMode: sdkPermissionMode(start.permissionMode),
    // Explicit for DETERMINISM — never let an SDK bump silently flip the default.
    settingSources: ["user", "project", "local"] as Array<"user" | "project" | "local">,
    // APP-OWNED planning sub-agents (intent-clarifier / plan-sizer / scope-recon /
    // devils-advocate-reviewer). Passed programmatically so the multiplan flow no longer
    // depends on the host's global ~/.claude/agents/ and resolves regardless of the target
    // cwd. Explicitly-passed `agents` take precedence over settingSources-discovered ones of
    // the same name, so keeping settingSources unchanged is safe — these four keys shadow any
    // ambient copies while OTHER ambient agents stay discoverable.
    agents: planningAgents,
    // Redirect the CLI's OWN plan-mode saves (its frontmatter-less ExitPlanMode
    // copy, slugged from the session's first user message) into the run's
    // `.plan-tree/cli-plans/` instead of `~/.claude/plans/` — otherwise every
    // agent-drafted plan lands TWICE in the sidebar: once nested via
    // write_agent_plan's tagged copy, once as a standalone top-level duplicate.
    // Flag-settings tier ⇒ user/project settings.json cannot re-point it back.
    settings: cliPlanRedirectSettings(),
    // Skills are gated by THIS option, not by settingSources alone.
    skills: "all" as const,
    pathToClaudeCodeExecutable: cliPath,
    // Keep the CLI child's diagnostics OFF fd 1 (which carries our JSON-lines).
    stderr: (data: string) => process.stderr.write(data),
    canUseTool,
    // PreToolUse hook tier: enforce the prototype containment BEFORE the SDK's
    // allow-rules tier (user settings.json allow rules would otherwise bypass the
    // canUseTool gate entirely while the SDK runs in "default" mode for "prototype").
    // No `matcher` — match every tool; the callback no-ops fast for non-mutating tools
    // and for the "plan"/"acceptEdits" policies.
    hooks: {
      PreToolUse: [{ hooks: [prototypePreToolUseHook] }],
    },
    // Resume an in-progress SDK conversation (Phase 4) by session id. KEY-OMISSION:
    // the `resume` key is present ONLY when the host supplied a resume id — a fresh
    // start omits it entirely (never `resume: undefined`). runSession pre-flights the
    // transcript and rebuilds options WITHOUT this when it is missing/expired. The
    // spread is the pure `resumeOption` so the omission property is unit-testable.
    ...resumeOption(start.resume),
    // NOTE: we deliberately do NOT set `env` — the spawned CLI INHERITS
    // CLAUDE_CODE_OAUTH_TOKEN (and PATH) from this process's env (Rust injects
    // it). The SDK's `env` REPLACES rather than merges, so setting it would drop
    // both. ANTHROPIC_API_KEY is never set/forwarded.
  };
}

// Pre-flight a resume request: probe getSessionInfo for the transcript. Guarded —
// a throw OR an undefined return means "transcript missing/expired" → fall back.
// Returns true iff the transcript exists and resume should proceed. Never throws.
async function resumeTranscriptExists(sessionId: string): Promise<boolean> {
  try {
    const info = await getSessionInfo(sessionId);
    return info != null;
  } catch (e) {
    logErr("[sidecar] getSessionInfo failed for resume id:", sessionId, "-", String(e));
    return false;
  }
}

async function runSession(start: StartCmd): Promise<void> {
  // FIRST, SYNCHRONOUSLY (before ANY await): allocate attempt 0's MessageQueue and point
  // `userQueue` at it. The resume pre-flight below `await`s getSessionInfo; on a resume start a
  // `user` stdin line can arrive DURING that await, and if `userQueue` were still null it would hit
  // the `case "user"` drop guard and be lost. Assigning here (the original ordering, restored) means
  // the very first user message always lands in attempt 0's queue regardless of the resume probe.
  // The retry loop REUSES this queue for attempt 0 and only allocates a fresh one for attempt > 0.
  const initialQueue = new MessageQueue();
  userQueue = initialQueue;

  // Resume pre-flight (Phase 4): if a resume id was requested, probe the transcript
  // BEFORE building options. SINGLE fallback — we decide once here; we never retry.
  // Computed ONCE here (outside the 529 retry loop): a retry re-issues with the SAME options.
  let effectiveStart = start;
  if (start.resume) {
    const exists = await resumeTranscriptExists(start.resume);
    const decision = decideResume(exists, true);
    if (decision.kind === "fresh") {
      // Transcript gone — drop `resume` (rebuild options without it) and emit a
      // NON-fatal notice. Strip via destructuring so the key is truly omitted.
      const { resume: _dropped, ...withoutResume } = start;
      effectiveStart = withoutResume;
      if (decision.fallback) {
        emit({ seq: seqCounter.value++, kind: "resume_fallback", reason: RESUME_FALLBACK_REASON });
      }
    }
  }

  let options;
  try {
    options = buildOptions(effectiveStart);
  } catch (e) {
    emit({ seq: seqCounter.value++, kind: "error", error_kind: "spawn", message: String(e), fatal: true });
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // 529 "Overloaded" in-band exponential-backoff retry loop.
  //
  // The HAPPY PATH (no overload) runs this loop exactly ONCE and is byte-identical to before: a
  // single fresh queue, a single query(), the same consume loop with the same single emit site, the
  // same quota handling, the same catch. The retry machinery is inert unless `isOverloadedMessage`
  // fires IN-BAND on the stream (the SDK retries 529 internally first; only a STILL-overloaded
  // request surfaces here, NOT as a throw — so the catch below is left UNCHANGED).
  //
  // PER ATTEMPT: a NEW MessageQueue (never re-iterate the singleton — a second concurrent consumer
  // of the same buffer races). On a retry the prior turn's user message(s) are re-pushed from
  // `pendingTurn` so the fresh query sees the same input; on attempt 1 the live stdin push already
  // seeded the queue, so we do NOT re-push (that would double the turn). The previous `q`/queue are
  // drained (interrupt → close → end, the same teardown gracefulExit uses) BEFORE the next query()
  // so the prior `claude` subprocess is not orphaned by the re-issue.
  // ---------------------------------------------------------------------------
  let retry = 0; // 0 → 6; PRE-incremented per backoff decision (decideBackoff is 1-based).
  let attempt = 0; // 0-based attempt index; attempt 0 is the original, >0 are 529 retries.

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // NOTE: the previous attempt's query+queue are drained in the retry TAIL (below), right before
    // the backoff sleep, which also nulls `q` — so on re-entry here there is no live prior query to
    // drain. (On attempt 0 there is none either.) This keeps the drain at exactly one site.
    //
    // ATTEMPT 0 REUSES `initialQueue` (allocated + pointed-to by `userQueue` SYNCHRONOUSLY at the top
    // of runSession, before the resume `await`) so a `user` line that arrived during the resume
    // pre-flight is already buffered in it and is NOT dropped. A RETRY (attempt > 0) allocates a
    // FRESH queue, repoints `userQueue`, and re-seeds it from the captured `pendingTurn`. We must
    // NOT re-push on attempt 0: the live stdin `case "user"` handler already fed `initialQueue`
    // (re-pushing would double the turn).
    let queue: MessageQueue;
    if (attempt === 0) {
      queue = initialQueue; // `userQueue` already points here (set at the top, before the await).
    } else {
      queue = new MessageQueue();
      userQueue = queue; // repoint BEFORE the (possible) backoff sleep so stdin `user` lands here.
      for (const m of pendingTurn) queue.push(m);
    }
    attempt++;

    q = query({ prompt: queue, options });

    // Per-ATTEMPT overload bookkeeping (reset each attempt). `emittedAnyFrame` gates the retry:
    // we only re-drive a PRE-OUTPUT overload (no assistant_text/tool_use emitted yet this attempt);
    // an overload AFTER frames is mid-turn and must NOT be re-driven (it would duplicate already-
    // emitted text under fresh seqCounter values).
    let emittedAnyFrame = false;
    let overloadPreOutput = false; // retryable: overloaded with nothing emitted this attempt.

    try {
      for await (const msg of q) {
        // PHASE 0 — RAW-FRAME TRACE (GATE A capture). With AGENT_TRACE set, log every raw SDK message
        // verbatim to STDERR (logErr — off the fd-1 JSON-lines `emit` channel, so it never corrupts the
        // host's frame stream). Used to capture the exact shape of a real usage-limit `result` /
        // `rate_limit_event` before building quota detection. No file writes.
        if (process.env.AGENT_TRACE) logErr("[raw]", JSON.stringify(msg));

        // IN-BAND 529 detection — BEFORE normalize (which would otherwise drop the overload frame or
        // recast it as a plain `result`). Checked here so the retry is driven off the raw SDK message.
        if (isOverloadedMessage(msg)) {
          if (emittedAnyFrame) {
            // MID-TURN overload: text/tool_use already went out this attempt. Re-driving would
            // duplicate it under new seqs, so we do NOT retry. But BOTH consumers end a turn ONLY on a
            // terminal `result` frame — the frontend's stream reducer clears the working spinner on
            // `kind:"result"` (active=false), and the orchestrator's sequencer returns early on any
            // non-`result` frame and has NO watchdog for recon/sizer/exec tags. A bare `status`
            // notice would therefore HANG the run permanently on a mid-turn 529 in those phases. So we
            // SYNTHESIZE the terminal `result` the partial turn never got to emit, matching the EXACT
            // field shape normalize.ts produces for a `result` frame (subtype/is_error/result/
            // num_turns/duration_ms/total_cost_usd/session_id). It is is_error:true + subtype
            // "error_during_execution" — the orchestrator's session-FATAL guard EXCLUDES that subtype,
            // so it is consumed as a GRACEFUL turn-end (advance/terminate), never a crash. We do NOT
            // retry (partial output is already on the wire). A short non-fatal `status` rides ALONGSIDE
            // the result (informational), never instead of it. This turn is finished (partially), so
            // clear `pendingTurn` — a LATER turn's 529 must never re-push it.
            emit({
              seq: seqCounter.value++,
              kind: "status",
              label: "Overloaded (529) after partial output — this turn ended early; send your message again to continue.",
            });
            emit(overloadResultFrame(seqCounter.value++));
            pendingTurn = [];
            continue; // keep consuming so the session stays alive for the next turn; do NOT retry.
          }
          // PRE-OUTPUT overload (the dominant case): nothing emitted yet → retryable. Break the
          // consume loop and handle backoff/exhaustion below.
          overloadPreOutput = true;
          break;
        }

        let quotaPaused = false;
        for (const frame of normalize(msg)) {
          emit(frame);
          const kind = (frame as { kind?: string }).kind;
          // Track output for THIS attempt's `emittedAnyFrame` gate (only rendered content counts).
          if (kind === "assistant_text" || kind === "tool_use") emittedAnyFrame = true;
          // A completed turn (its terminal `result`) clears the pending-turn buffer so a future
          // turn's 529 retry only ever re-pushes the CURRENT turn, never a stale prior one.
          if (kind === "result") pendingTurn = [];
          // A `quota_exceeded` frame means the session hit the quota wall. The SDK iterator is now
          // effectively dead; exit GRACEFULLY (0) so the SDK reaper closes the `claude` grandchild
          // and the queue drains — never a bare process.exit (which would re-orphan it). The host
          // records the pause + schedules auto-resume off the frame's resetAt.
          if (kind === "quota_exceeded") quotaPaused = true;
        }
        if (quotaPaused) {
          await gracefulExit("quota exceeded", 0);
          return;
        }
      }
    } catch (e) {
      const text = String(e);
      const isAuth = /auth|token|unauthor|401|oauth/i.test(text);
      // Quota-wall backstop: the rate_limit_event may not precede the throw. If this is NOT an auth
      // error AND a reset time is parseable from the error text, emit a NON-fatal `quota_exceeded`
      // frame (same contract as the normalize path) and exit GRACEFULLY (0) — driving the SDK reaper
      // so the `claude` grandchild is not re-orphaned. Otherwise the existing fatal path is unchanged:
      // auth → "auth", everything else → "sdk", both fatal with exit(1).
      if (!isAuth) {
        const resetAt = parseResetFromError(text);
        if (resetAt !== null) {
          emit({ seq: seqCounter.value++, kind: "quota_exceeded", resetAt, source: "thrown_error" });
          await gracefulExit("quota exceeded (thrown)", 0);
          return;
        }
      }
      emit({
        seq: seqCounter.value++,
        kind: "error",
        error_kind: isAuth ? "auth" : "sdk",
        message: text,
        fatal: true,
      });
      process.exit(1);
    }

    // Reached here either by a NATURAL iterator end (turn(s) done, queue ended → session over) or by
    // a PRE-OUTPUT 529 break. Only the latter retries; the former returns.
    if (!overloadPreOutput) return;

    // PRE-OUTPUT 529 → exponential backoff (sidecar/backoff.ts). decideBackoff is 1-based; PRE-
    // increment `retry` (starts at 0) so the first retry is 1.
    const decision = decideBackoff(++retry, Date.now());
    if (decision.kind === "exhausted") {
      // Sustained outage: retried BACKOFF_MAX_RETRIES times over ~61 min. Give up FATALLY, reusing
      // the existing error shape (error_kind stays "sdk" — the contract enum is NOT widened).
      emit({
        seq: seqCounter.value++,
        kind: "error",
        error_kind: "sdk",
        message: `Anthropic API overloaded (HTTP 529); retried ${BACKOFF_MAX_RETRIES}× over ~61 min, giving up.`,
        fatal: true,
      });
      process.exit(1);
    }

    // Status notice BEFORE the wait (direct emit, NOT via the normalizer throttle — same out-of-band
    // shape as the other index.ts status sites). Round the delay to whole minutes for the label.
    const minutes = Math.round(decision.delayMs / 60_000);
    emit({
      seq: seqCounter.value++,
      kind: "status",
      label: `Overloaded (529) — retrying in ${minutes}m (retry ${decision.retry}/${BACKOFF_MAX_RETRIES})`,
    });

    // Drain THIS attempt's overloaded query before the wait so its `claude` subprocess is reaped
    // while we sleep (not left live holding the OAuth-bearing grandchild for up to 30 minutes).
    if (q) await drainQuery({ q, userQueue, logErr });
    q = null;

    // Abortable wait. A SIGTERM/SIGINT/`end` during the sleep aborts it (backoffAbort, wired into
    // gracefulExit.onBeforeDrain) — stop retrying and let graceful shutdown proceed.
    try {
      await abortableSleep(decision.delayMs, backoffAbort.signal);
    } catch {
      logErr("[sidecar] 529 backoff sleep aborted — shutting down, no further retries.");
      return;
    }
    // Loop: build a fresh queue, re-push pendingTurn, re-issue query().
  }
}

// ---------------------------------------------------------------------------
// stdin command handling — JSON-lines.
//   { type: "start", cwd, permissionMode }
//   { type: "user", text }
//   { type: "resolve-tool-permission", id, allow, message?, updatedInput? }
//   { type: "set-permission-mode", mode }
//   { type: "interrupt" }
//   { type: "end" }
// ---------------------------------------------------------------------------

let userQueue: MessageQueue | null = null;
let started = false;

// The ONE graceful teardown drain (INV-4). ALL FOUR exit triggers route here — the
// `end` command (the host's PRIMARY app-quit path), SIGTERM/SIGINT, and a bare
// stdin-close — so each aborts the in-flight turn, closes the SDK query (which
// drives the SDK's own `claude`-grandchild reaper), ends the parked queue, and
// AWAITS that drain BEFORE exiting. A synchronous exit would cut the SDK's async
// teardown off and re-orphan the grandchild. Getters read the LIVE q/userQueue
// (null until `start` arrives). Idempotent (latched in makeGracefulExit) so a
// second trigger mid-drain is a no-op.
const gracefulExit = makeGracefulExit({
  getQ: () => q,
  getUserQueue: () => userQueue,
  logErr,
  exit: (code) => process.exit(code),
  // VERY FIRST thing on any teardown trigger: abort an in-flight 529 backoff sleep so the wait
  // (up to ~30m) cannot stall the drain. The latch in makeGracefulExit makes repeat triggers safe;
  // AbortController.abort() is itself idempotent.
  onBeforeDrain: () => backoffAbort.abort(),
});

async function handleCommand(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let cmd: Record<string, unknown>;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    logErr("[sidecar] ignoring non-JSON stdin line:", trimmed);
    return;
  }

  switch (cmd.type) {
    case "start": {
      // ONE SESSION PER PROCESS — enforced LOUDLY, never silently. The old behavior ("start
      // ignored — session already running") was the context-bleed seam: the second start was
      // dropped but the OLD Query, its conversation context, and the module-level hostPolicy all
      // survived, so the next `user` messages (a NEW plan) were absorbed into the prior session.
      // decideStart (pure, unit-tested) makes a second start a FATAL protocol rejection — the
      // process exits, the host's Terminated handling frees the session slot, and a retry gets a
      // fresh process. A FRESH start (re)asserts hostPolicy from THIS command's permissionMode,
      // so a stale "acceptEdits" can never leak into a new session's planning phase.
      const decision = decideStart(started, cmd.permissionMode);
      if (decision.kind === "reject") {
        emit({ seq: seqCounter.value++, ...decision.frame });
        process.exit(1);
      }
      started = true;
      hostPolicy = decision.hostPolicy;
      // Capture the session cwd for the gate's prototype containment check. Empty/missing
      // cwd stays null → the prototype policy fails closed (denies all mutating tools).
      sessionCwd = typeof cmd.cwd === "string" && cmd.cwd.length > 0 ? cmd.cwd : null;
      // Fire-and-forget: runSession drives the stream until end/exit.
      void runSession({
        type: "start",
        cwd: String(cmd.cwd ?? ""),
        permissionMode: typeof cmd.permissionMode === "string" ? cmd.permissionMode : "default",
        // Picker values — guard against null/non-string; resolveModelEffort drops empties.
        model: typeof cmd.model === "string" ? cmd.model : undefined,
        effort: typeof cmd.effort === "string" ? cmd.effort : undefined,
        // Resume id — guard against null/non-string/empty; absent/empty == fresh start.
        resume: typeof cmd.resume === "string" && cmd.resume.length > 0 ? cmd.resume : undefined,
      });
      return;
    }

    case "user": {
      if (!userQueue) {
        logErr("[sidecar] user message before start — dropped");
        return;
      }
      // MULTIMODAL: an inbound `user` command may carry inline base64 images
      // (snake_case `media_type` + base64 `data`). Read DEFENSIVELY — keep only
      // well-formed elements; a malformed `images` field FAILS SOFT to the bare
      // string rather than throwing in the stdin loop (see cross-layer contract).
      const imgs = Array.isArray(cmd.images)
        ? (cmd.images as unknown[]).filter(
            (x: any) => x && typeof x.media_type === "string" && typeof x.data === "string",
          )
        : [];
      const lifted = liftUserMessage(
        String(cmd.text ?? ""),
        imgs.length ? (imgs as InboundImage[]) : undefined,
      );
      // Mirror the message into the in-flight-turn buffer so a 529 retry can re-seed a fresh queue
      // with the SAME input (see runSession). Cleared on each completed turn's `result` frame, so
      // this only ever accumulates the CURRENT turn's message(s).
      pendingTurn.push(lifted);
      userQueue.push(lifted);
      return;
    }

    case "resolve-tool-permission": {
      const id = String(cmd.id ?? "");
      const stored = permissionGate.storedInput(id);
      if (stored === undefined) {
        logErr("[sidecar] resolve for unknown/expired permission id:", id);
        return;
      }
      // Build the result, then hand it to the gate (which frees the slot + settles the hold).
      const result =
        cmd.allow === true
          ? // On allow, prefer an explicit `updatedInput` from the host if one was provided (this is how
            // AskUserQuestion answers are returned: { questions, answers }). Absent it, echo the stored
            // input — the SDK's runtime validator REQUIRES `updatedInput` on an allow result (a bare
            // { behavior: "allow" } fails with a ZodError), and echoing the original input is a no-op.
            allowResult(resolveAllowInput(cmd.updatedInput, stored))
          : denyResult(typeof cmd.message === "string" ? cmd.message : "denied");
      permissionGate.resolve(id, result);
      return;
    }

    case "set-permission-mode": {
      // The ONLY writer of hostPolicy (the gate's backstop). Updated even before `q` exists —
      // the policy is host state, not SDK session state. Anything but "acceptEdits"/"prototype"
      // → "plan".
      hostPolicy = hostPolicyForMode(cmd.mode);
      if (!q) {
        logErr("[sidecar] set-permission-mode before start — dropped");
        return;
      }
      // NEVER the raw wire mode: "prototype" is host-only (the SDK's PermissionMode union
      // does not include it) and maps to SDK "default"; the host-policy gate enforces the
      // prototype containment.
      await q.setPermissionMode(sdkPermissionMode(cmd.mode));
      return;
    }

    case "interrupt": {
      if (!q) {
        logErr("[sidecar] interrupt before start — dropped");
        return;
      }
      // Graceful Query.interrupt(): the in-flight turn aborts and emits its terminal `result`
      // (subtype error_during_execution), which the normalize loop forwards like any result.
      // Guarded: interrupting an idle query (the turn ended in the race window) may reject, and
      // an unhandled rejection here would kill the sidecar — log it instead (fd 2).
      try {
        await q.interrupt();
      } catch (e) {
        logErr("[sidecar] interrupt failed (turn may already be idle):", String(e));
      }
      return;
    }

    case "end": {
      // The host's PRIMARY app-quit path. Route through the SAME awaited drain as
      // the signal handlers (interrupt → close → queue-end, THEN exit) — the old
      // synchronous `process.exit(0)` could cut the SDK's async child teardown off
      // and orphan the `claude` grandchild (INV-4). `await` so a fast follow-up
      // signal cannot exit ahead of this drain; the latch makes that second trigger
      // a no-op regardless.
      await gracefulExit("end command", 0);
      return;
    }

    default:
      logErr("[sidecar] unknown stdin command type:", cmd.type);
      return;
  }
}

// ---------------------------------------------------------------------------
// Main — line-buffered stdin reader.
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  void handleCommand(line);
});

// All non-`end` exit triggers route through the SAME awaited `gracefulExit`
// (defined above, alongside q/userQueue) so the drain is identical on every path:
rl.on("close", () => {
  // stdin closed (parent went away) — drain the SDK session (close reaps the CLI
  // child) and exit cleanly. Previously this only ended the queue, leaving the
  // SDK query (and its grandchild) live → orphan on parent-death.
  void gracefulExit("stdin closed", 0);
});

// The Rust teardown's PRIMARY path is the `{type:end}` stdin line (handled above);
// SIGTERM/SIGINT cover an external kill / Ctrl-C / dev-terminal interrupt. All drain.
process.on("SIGTERM", () => void gracefulExit("SIGTERM", 0));
process.on("SIGINT", () => void gracefulExit("SIGINT", 0));
