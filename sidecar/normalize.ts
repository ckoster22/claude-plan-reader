// SDKMessage normalizer — extracted from index.ts so it is unit-testable WITHOUT
// importing index.ts (which embeds the `claude` binary via a `with { type: "file" }`
// import AND installs a stdin readline loop + SIGTERM/SIGINT handlers at import time).
//
// It NORMALIZES the SDK's large `SDKMessage` union into a small, stable wire vocabulary
// so the SDK's version volatility is encapsulated HERE and never leaks into Rust or the
// frontend. The committed `agent-stream` kinds are:
//   system_init | assistant_text | tool_use | tool_result | mode_change |
//   result | permission_denied | subagent_started | status | quota_exceeded
// (Unrecognized subtypes are dropped, logged to THIS process's stderr.)
//
// SEQ COUNTER (load-bearing): the running `seq` is a SHARED, mutable counter — `index.ts`
// stamps its OWN out-of-band frames (resume_fallback, error, the permission gate's frames)
// with the same monotonic sequence. We therefore take it by reference as a `{ value }`
// holder so a `seq++` here and a `seq++` there draw from the one counter, byte-for-byte
// identical to the prior single-module behavior.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { StatusThrottle, statusLabelFor } from "./permissions";
import { isRenderableText } from "./frames";
import { decideRateLimitFrame, isUsageLimitText, decideResultQuota } from "./quota";

/** Shared, monotonic frame-sequence counter — held by reference so index.ts's own
 *  emit sites and this normalizer draw from the SAME running value. */
export interface SeqCounter {
  value: number;
}

export interface NormalizerDeps {
  /** Shared seq counter (see SeqCounter). */
  seq: SeqCounter;
  /** Diagnostics sink (fd 2). */
  logErr: (...parts: unknown[]) => void;
}

export interface Normalizer {
  /** SDKMessage → committed agent-stream kinds. Returns the wire object(s) to emit (a
   *  single assistant message can carry several text/tool_use blocks → several frames).
   *  Unknown subtypes return [] (dropped + logged). */
  normalize(msg: SDKMessage): Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// OVERLOAD (HTTP 529) detection — pure predicate.
//
// The Anthropic SDK retries a 529 "Overloaded" INTERNALLY (≤8s, not configurable) and then —
// if still overloaded — surfaces it IN-BAND as a terminal frame on the output stream (NOT as a
// throw in index.ts's catch). index.ts's retry loop watches for this on the consume loop and
// re-issues with a fresh queue + exponential backoff (sidecar/backoff.ts).
//
// WIRE-SHAPE CAVEAT (load-bearing): the EXACT post-internal-retry wire shape is NOT 100% confirmed
// — it is produced by the bundled `claude` CLI binary, not modeled byte-for-byte by the SDK's
// `.d.ts`. The SDK types DO document several overload-bearing fields, and the real frame could be
// any of them depending on whether overload surfaces on the assistant message or the terminal
// result. So we match DEFENSIVELY across ALL documented shapes rather than betting on one:
//   - an assistant message with `error === "overloaded"` (SDKAssistantMessage.error, the
//     SDKAssistantMessageError union includes "overloaded");
//   - a terminal `result` with `api_error_status === 529` (SDKResultSuccess.api_error_status);
//   - a terminal `result` whose `error` field is "overloaded" (defensive — not in the .d.ts but a
//     plausible CLI rendering on the is_error path, mirroring the result `result`-string divergence);
//   - a terminal `result` whose `errors[]` (SDKResultError.errors) contains /overloaded|529/.
//
// ORTHOGONAL TO QUOTA: this must NOT fire on a usage/session-limit wall (the `quota_exceeded`
// path) — those carry the human "you've hit your … limit" string / a rate_limit_event, none of
// which mention overloaded or 529. Kept disjoint so the two transient-failure paths never collide.
const OVERLOADED_RE = /overloaded|\b529\b/i;

/** True iff `msg` is the SDK's in-band signal that the request is overloaded (HTTP 529) AFTER the
 *  SDK's own internal retries. Defensively matches every documented overload shape (see above). */
export function isOverloadedMessage(msg: SDKMessage): boolean {
  if (msg == null || typeof msg !== "object") return false;
  const m = msg as { type?: string; error?: unknown; api_error_status?: unknown; errors?: unknown };

  // (1) assistant message carrying an overloaded error.
  if (m.type === "assistant" && m.error === "overloaded") return true;

  // (2)/(3)/(4) terminal result carriers.
  if (m.type === "result") {
    if (typeof m.api_error_status === "number" && m.api_error_status === 529) return true;
    if (m.error === "overloaded") return true;
    if (Array.isArray(m.errors) && m.errors.some((e) => typeof e === "string" && OVERLOADED_RE.test(e))) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// MID-TURN-529 GRACEFUL TURN-BOUNDARY FRAME — pure builder.
//
// When a 529 overload surfaces AFTER this attempt already emitted rendered output, index.ts ends the
// turn (rather than re-driving, which would duplicate the emitted text) by emitting the terminal
// `result` the partial turn never got to. This builds that frame, matching the EXACT field shape +
// order normalize() produces for a `result` frame. is_error:true + subtype "error_during_execution"
// is load-bearing: the orchestrator's session-FATAL guard EXCLUDES that subtype, so it is consumed as
// a GRACEFUL turn-end (advance/terminate), never a crash.
export function overloadResultFrame(seq: number): Record<string, unknown> {
  return {
    seq,
    kind: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Anthropic API overloaded (HTTP 529) after partial output; not retried.",
    num_turns: null,
    duration_ms: null,
    total_cost_usd: null,
    session_id: null,
  };
}

/** A content block may be a string, or an array of typed blocks. Narrow safely. */
function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.filter((b): b is Record<string, unknown> => b != null && typeof b === "object");
  }
  return [];
}

export function createNormalizer(deps: NormalizerDeps): Normalizer {
  const { seq, logErr } = deps;

  // PHASE 1 — the most-recent `SDKRateLimitInfo` seen on a `rate_limit_event`, retained across
  // messages. The result-carrier quota path (a usage-limit `result` with no structured field of its
  // own) reuses a recent structured `resetsAt` from here via decideResultQuota → extractResetAt.
  // Stored for ALL statuses; reuse is gated on `status === "rejected"` inside extractResetAt (which
  // returns null otherwise), so a stale `allowed`/`allowed_warning` info never feeds a false reset.
  let lastRateLimitInfo: unknown = null;

  const statusThrottle = new StatusThrottle();

  function nextFrame(kind: string, extra: Record<string, unknown>): Record<string, unknown> {
    return { seq: seq.value++, kind, ...extra };
  }

  /** Emit a `status` frame iff `label` differs from the last one emitted (de-dup throttle).
   *  Returns the frame(s) to emit (0 or 1). */
  function statusFrames(label: string): Array<Record<string, unknown>> {
    return statusThrottle.next(label).map((l) => nextFrame("status", { label: l }));
  }

  function normalize(msg: SDKMessage): Array<Record<string, unknown>> {
    switch (msg.type) {
      case "system": {
        const sub = msg.subtype;
        // A subagent (Task/Agent tool) was just spawned. The SDK carries rich metadata here that we
        // surface as a committed `subagent_started` frame: the `tool_use_id` is the SAME id the
        // subagent's child messages carry as `parent_tool_use_id` AND the id of the parent Task
        // tool_use — so the frontend keys the subagent group off it. Without this frame the group is
        // anonymous (identity + task lost). task_progress/task_notification stay coarse `status`.
        if (msg.subtype === "task_started") {
          return [
            nextFrame("subagent_started", {
              tool_use_id: msg.tool_use_id ?? null,
              subagent_type: msg.subagent_type ?? null,
              description: msg.description ?? null,
              prompt: msg.prompt ?? null,
            }),
          ];
        }
        if (msg.subtype === "init") {
          return [
            nextFrame("system_init", {
              model: msg.model ?? null,
              cwd: msg.cwd ?? null,
              tools: msg.tools ?? [],
              skills: msg.skills ?? [],
              slash_commands: msg.slash_commands ?? [],
              permission_mode: msg.permissionMode ?? null,
              session_id: msg.session_id ?? null,
            }),
          ];
        }
        if (msg.subtype === "permission_denied") {
          return [
            nextFrame("permission_denied", {
              tool: msg.tool_name ?? null,
              tool_use_id: msg.tool_use_id ?? null,
              agent_id: msg.agent_id ?? null,
              decision_reason_type: msg.decision_reason_type ?? null,
              message: msg.message ?? null,
            }),
          ];
        }
        // status carries the live permission mode — surface mode flips so the UI
        // reflects setPermissionMode round-trips. NOTE: this is OUTBOUND notification only —
        // SDK-originated mode changes must NEVER update `hostPolicy` (the SDK silently leaves
        // "plan" after an ExitPlanMode approval; only the host's set-permission-mode command
        // may widen the policy).
        if (msg.subtype === "status") {
          if (msg.permissionMode) {
            return [nextFrame("mode_change", { mode: msg.permissionMode })];
          }
          return [];
        }
        // Low-level progress signals (thinking / task lifecycle / rate-limit) surface as a
        // throttled, label-only `status` frame so the pane shows "working" instead of going blank.
        {
          const label = sub ? statusLabelFor(sub) : null;
          if (label !== null) return statusFrames(label);
        }
        // Other system subtypes are not committed by Sub-Plan 01 → drop.
        logErr("[sidecar] dropping system subtype:", sub);
        return [];
      }

      case "assistant": {
        const frames: Array<Record<string, unknown>> = [];
        for (const block of contentBlocks(msg.message?.content)) {
          if (block.type === "text" && isRenderableText(block.text)) {
            frames.push(
              nextFrame("assistant_text", {
                text: block.text,
                parent_tool_use_id: msg.parent_tool_use_id ?? null,
              }),
            );
          } else if (block.type === "tool_use") {
            frames.push(
              nextFrame("tool_use", {
                id: block.id ?? null,
                tool: block.name ?? null,
                input: block.input ?? {},
                parent_tool_use_id: msg.parent_tool_use_id ?? null,
              }),
            );
          }
          // thinking / other blocks are not committed → silently skipped.
        }
        return frames;
      }

      case "user": {
        // Tool results come back as a `user` message whose content holds
        // tool_result blocks. Surface those under the committed `tool_result`
        // kind; an ordinary echoed user turn carries no tool_result block.
        const frames: Array<Record<string, unknown>> = [];
        for (const block of contentBlocks(msg.message?.content)) {
          if (block.type === "tool_result") {
            frames.push(
              nextFrame("tool_result", {
                tool_use_id: block.tool_use_id ?? null,
                content: block.content ?? null,
                is_error: block.is_error ?? false,
                parent_tool_use_id: msg.parent_tool_use_id ?? null,
              }),
            );
          }
        }
        return frames;
      }

      case "result": {
        // A turn completed — clear the throttle so the NEXT turn re-emits its first status label
        // (e.g. "thinking…") instead of being suppressed as a duplicate of the prior turn's last.
        statusThrottle.reset();
        // WIRE-vs-`.d.ts` DIVERGENCE (load-bearing): `result: string` lives ONLY on
        // `SDKResultSuccess` in the SDK types — `SDKResultError` models its payload as
        // `errors: string[]` and has NO `result` field. But the WIRE delivers the human
        // usage/session-limit string on an `is_error:true` result (a "wall"), which the SDK's
        // own `.d.ts` does not model. So we read `result` through a `"result" in msg` guard
        // (NOT by narrowing on `subtype === "success"`, which would BLIND quota detection on the
        // is_error path) and reuse the same value for BOTH the quota check and the normal frame.
        const resultText = "result" in msg ? msg.result : undefined;
        // PHASE 1 — RESULT-CARRIER QUOTA DETECTION. A usage/session limit has NO dedicated subtype:
        // it arrives as an `is_error:true` result whose only payload is the human limit string. When
        // this result IS that wall, DROP the plain result (Decision B) and emit a `quota_exceeded`
        // frame instead — driving the same pause + auto-resume + gracefulExit(0) path the
        // rate_limit_event carrier uses. The reset time prefers a recent structured `resetsAt`
        // (lastRateLimitInfo), then the string clock, then sentinel 0 (degraded → host routes to
        // EXHAUSTED).
        if ((msg.is_error ?? false) && isUsageLimitText(resultText)) {
          const { resetAt, source } = decideResultQuota(resultText, lastRateLimitInfo);
          return [nextFrame("quota_exceeded", { resetAt, source })];
        }
        return [
          nextFrame("result", {
            subtype: msg.subtype ?? null,
            is_error: msg.is_error ?? false,
            result: resultText ?? null,
            num_turns: msg.num_turns ?? null,
            duration_ms: msg.duration_ms ?? null,
            total_cost_usd: msg.total_cost_usd ?? null,
            session_id: msg.session_id ?? null,
          }),
        ];
      }

      case "rate_limit_event": {
        // A rate-limit notice. When the limit is REJECTED (the quota wall) AND a reset time is
        // determinable, emit a NON-fatal `quota_exceeded` frame so the host can PAUSE + auto-resume
        // instead of dying — travels via the normal stream (NOT an `error` kind), so the Rust `_ =>`
        // Stream arm relays it with no Rust change. The emit loop drives gracefulExit(0) when it sees
        // this kind (the SDK iterator is dead once the quota throws/ends; keeping the sidecar idle
        // would pin the OAuth-bearing `claude` grandchild). Otherwise (allowed / allowed_warning /
        // rejected-but-no-reset) keep TODAY's label-only `status` behavior unchanged.
        const info = msg.rate_limit_info;
        // PHASE 1 — retain the latest info so a following result-carrier quota can reuse its
        // structured `resetsAt`. Stored for ALL statuses; reuse is gated on status==="rejected" in
        // extractResetAt.
        lastRateLimitInfo = info;
        const decision = decideRateLimitFrame(info);
        if (decision.quota) {
          return [nextFrame("quota_exceeded", { resetAt: decision.resetAt, source: decision.source })];
        }
        return statusFrames(statusLabelFor("rate_limit_event") ?? "waiting (rate limit)");
      }

      default: {
        // Some progress signals arrive as their OWN top-level message type rather than a
        // system subtype — map those to a throttled, label-only `status` frame too.
        const t = (msg as { type?: string }).type ?? "";
        const label = statusLabelFor(t);
        if (label !== null) return statusFrames(label);
        logErr("[sidecar] dropping unknown message type:", t);
        return [];
      }
    }
  }

  return { normalize };
}
