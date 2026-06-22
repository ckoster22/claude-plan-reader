// Falsifiable regression tests for the SDKMessage normalizer (normalize.ts).
//
// THE BEHAVIOR UNDER TEST: normalize() maps the SDK's `SDKMessage` union onto the committed
// wire vocabulary. The load-bearing, easy-to-break-during-a-type-refactor branches are the two
// quota carriers:
//   (a) a `result` with is_error:true whose payload is a usage/session-limit string → a SINGLE
//       `quota_exceeded` frame (NOT a plain `result`), even though the SDK's `.d.ts` models
//       `result` only on SDKResultSuccess (the wire delivers it on an is_error result anyway —
//       hence the `"result" in msg` read, NOT a `subtype === "success"` narrow that would blind
//       this path);
//   (b) a `rate_limit_event` whose info is `{ status:"rejected", resetsAt }` → a `quota_exceeded`
//       frame;
//   (c) a benign is_error:true `result` with a NON-limit string → a normal `result` frame.
//
// We import `createNormalizer` (NOT index.ts). index.ts is NOT importable under vitest: at import
// time it embeds the `claude` binary (`with { type: "file" }`) AND installs a stdin readline loop
// + SIGTERM/SIGINT handlers — all process-level side effects. So normalize() lives in its own
// SDK-message-only module, wired here with a local seq counter + a no-op logErr.

import { describe, it, expect } from "vitest";
import { createNormalizer, isOverloadedMessage, overloadResultFrame, type SeqCounter } from "./normalize";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// A session-limit string CONFIRMED matched by isUsageLimitText (see quota.test.ts).
const SESSION_LIMIT_TEXT = "You've hit your session limit · resets 2:10pm (America/Chicago)";

/** Fresh normalizer per call so the seq counter / throttle state never bleeds across cases. */
function freshNormalize() {
  const seq: SeqCounter = { value: 0 };
  const { normalize } = createNormalizer({ seq, logErr: () => {} });
  return normalize;
}

describe("normalize — result-carrier quota detection (wire-vs-.d.ts divergence)", () => {
  it("(a) is_error result whose `result` is a session-limit string → exactly one quota_exceeded frame", () => {
    const normalize = freshNormalize();
    // Shape the wire message the way the CLI actually delivers it: an is_error:true `result`
    // carrying the human limit string in `result`. Cast through the union — the SDK's
    // SDKResultError member does NOT type `result`, but the WIRE carries it here.
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: SESSION_LIMIT_TEXT,
      num_turns: 3,
    } as unknown as SDKMessage;

    const frames = normalize(msg);

    // Exactly ONE frame, and it is the quota frame — the plain `result` is DROPPED (Decision B).
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("quota_exceeded");
    // resetAt + source are present (resetAt resolved from the string clock; source from quota.ts).
    expect(frames[0].source).toBe("result_error");
    expect(frames[0]).toHaveProperty("resetAt");
    expect(typeof frames[0].resetAt).toBe("number");
    // The 2:10pm string parses to a real future instant, never the sentinel 0.
    expect(frames[0].resetAt as number).toBeGreaterThan(0);
    // It must NOT have emitted a plain result alongside it.
    expect(frames.some((f) => f.kind === "result")).toBe(false);
  });

  it("(c) is_error result with a NON-limit string → a normal `result` frame (NOT quota)", () => {
    const normalize = freshNormalize();
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "some other error",
      num_turns: 1,
    } as unknown as SDKMessage;

    const frames = normalize(msg);

    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("result");
    // The benign error string is preserved on the result frame (read via `"result" in msg`).
    expect(frames[0].result).toBe("some other error");
    expect(frames[0].is_error).toBe(true);
    // And it is definitively NOT a quota frame.
    expect(frames.some((f) => f.kind === "quota_exceeded")).toBe(false);
  });
});

describe("normalize — cross-message lastRateLimitInfo reuse (shared closure state)", () => {
  it("a rejected rate_limit_event's resetsAt is reused by a LATER clock-less limit result", () => {
    // ONE normalizer instance — the whole point is exercising the shared closure `lastRateLimitInfo`
    // WRITTEN by the rate_limit_event and READ by the later result. Do NOT recreate it between calls.
    const seq: SeqCounter = { value: 0 };
    const { normalize } = createNormalizer({ seq, logErr: () => {} });

    // resetsAt below 1e12 → extractResetAt treats it as epoch-SECONDS and normalizes ×1000 to ms.
    const resetsAtSeconds = 1_700_000_000;
    const expectedMs = 1_700_000_000_000;

    // Step 1: the rate_limit_event writes lastRateLimitInfo (status rejected). We don't assert on its
    // own frame here — we care about the SIDE EFFECT it leaves in the shared closure for step 2.
    normalize({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: resetsAtSeconds },
    } as unknown as SDKMessage);

    // Step 2: an is_error usage-limit result whose string has NO "resets <h><am|pm> (tz)" clause —
    // quota.test.ts confirms this exact string yields sentinel 0 via decideResultQuota when lastInfo
    // is null. So the ONLY way this frame carries a real resetAt is reuse of step 1's structured value.
    const frames = normalize({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "You've hit your session limit, please wait",
      num_turns: 2,
    } as unknown as SDKMessage);

    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("quota_exceeded");
    // The structured-info branch of decideResultQuota returns source "result_error" (NOT
    // "rate_limit_event"), even though the value ORIGINATED from a rate_limit_event — assert exactly.
    expect(frames[0].source).toBe("result_error");
    // resetAt == step 1's resetsAt normalized seconds→ms. Without cross-message reuse this would be
    // the sentinel 0 (the unparseable string carries no clock of its own).
    expect(frames[0].resetAt).toBe(expectedMs);
  });
});

describe("normalize — rate_limit_event quota carrier", () => {
  it("(b) rejected rate_limit_event with resetsAt → a quota_exceeded frame", () => {
    const normalize = freshNormalize();
    const resetsAt = 1_750_000_000_000; // already epoch-ms (>= 1e12) → passes through unchanged
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt },
    } as unknown as SDKMessage;

    const frames = normalize(msg);

    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("quota_exceeded");
    expect(frames[0].source).toBe("rate_limit_event");
    expect(frames[0].resetAt).toBe(resetsAt);
  });
});

// ---------------------------------------------------------------------------
// isOverloadedMessage — the IN-BAND HTTP 529 "Overloaded" detection seam.
//
// THE BEHAVIOR UNDER TEST: the Anthropic SDK retries a 529 internally (≤8s), then surfaces a
// STILL-overloaded request IN-BAND on the output stream (NOT as a throw). index.ts's retry loop
// watches for it via this pure predicate. The EXACT post-internal-retry wire shape is not 100%
// confirmed (it is produced by the bundled `claude` CLI binary), so the predicate matches
// DEFENSIVELY across every documented overload shape — and these tests pin all four positives plus
// the negatives that keep it ORTHOGONAL to the quota/usage-limit path (which must NOT match here).
//
// index.ts's retry CONTROL FLOW is not vitest-importable (it boots the `claude` binary + a stdin
// readline loop at import), so this pure predicate is where the falsifiable coverage lives. Proof of
// falsifiability: temporarily replace the body of isOverloadedMessage with `return false` and EVERY
// positive case below goes RED while the negatives stay GREEN; restore for GREEN.
// ---------------------------------------------------------------------------
describe("isOverloadedMessage — defensive in-band HTTP 529 detection (all documented shapes)", () => {
  it("(1) assistant message with error:'overloaded' → true", () => {
    // SDKAssistantMessage.error; SDKAssistantMessageError includes 'overloaded'.
    // FALSIFY: drop the assistant branch → false → RED.
    expect(
      isOverloadedMessage({
        type: "assistant",
        error: "overloaded",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
      } as unknown as SDKMessage),
    ).toBe(true);
  });

  it("(2) result with api_error_status === 529 → true", () => {
    // SDKResultSuccess.api_error_status.
    // FALSIFY: drop the api_error_status branch → false → RED.
    expect(
      isOverloadedMessage({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 529,
        result: "",
      } as unknown as SDKMessage),
    ).toBe(true);
  });

  it("(3) result with error:'overloaded' (defensive CLI rendering, not in .d.ts) → true", () => {
    // FALSIFY: drop the result.error branch → false → RED.
    expect(
      isOverloadedMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        error: "overloaded",
      } as unknown as SDKMessage),
    ).toBe(true);
  });

  it("(4) result whose errors[] mentions overloaded / 529 → true", () => {
    // SDKResultError.errors. FALSIFY: drop the errors[] scan → false → RED.
    expect(
      isOverloadedMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Overloaded: the API is temporarily overloaded (HTTP 529)"],
      } as unknown as SDKMessage),
    ).toBe(true);
    // The bare "529" token also matches (anchored on a word boundary).
    expect(
      isOverloadedMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["request failed with status 529"],
      } as unknown as SDKMessage),
    ).toBe(true);
  });

  it("a NORMAL assistant message (no error) → false", () => {
    // FALSIFY: match assistant regardless of error → a plain text turn would falsely retry → RED.
    expect(
      isOverloadedMessage({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        parent_tool_use_id: null,
      } as unknown as SDKMessage),
    ).toBe(false);
    // A DIFFERENT assistant error (e.g. server_error) is NOT an overload → false.
    expect(
      isOverloadedMessage({
        type: "assistant",
        error: "server_error",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
      } as unknown as SDKMessage),
    ).toBe(false);
  });

  it("a NORMAL successful result → false", () => {
    expect(
      isOverloadedMessage({
        type: "result",
        subtype: "success",
        is_error: false,
        api_error_status: null,
        result: "Done. All tests pass.",
        num_turns: 3,
      } as unknown as SDKMessage),
    ).toBe(false);
  });

  it("a QUOTA / usage-limit result must NOT match (orthogonal to quota_exceeded)", () => {
    // The usage-limit wall carries the human "you've hit your … limit" string — no 'overloaded'/529.
    // FALSIFY: scan the `result` string for /limit/ or loosen the regex → this matches → RED, which
    // would collide the 529 retry path with the quota pause path.
    expect(
      isOverloadedMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "You've hit your session limit · resets 2:10pm (America/Chicago)",
      } as unknown as SDKMessage),
    ).toBe(false);
    // A rejected rate_limit_event (the structured quota carrier) is also NOT an overload.
    expect(
      isOverloadedMessage({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1_750_000_000_000 },
      } as unknown as SDKMessage),
    ).toBe(false);
  });

  it("a non-529 api_error_status (e.g. 500) → false", () => {
    // FALSIFY: treat any numeric api_error_status as overloaded → a 500 would retry → RED.
    expect(
      isOverloadedMessage({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 500,
        result: "",
      } as unknown as SDKMessage),
    ).toBe(false);
  });

  it("null / non-object input → false (defensive)", () => {
    expect(isOverloadedMessage(null as unknown as SDKMessage)).toBe(false);
    expect(isOverloadedMessage(undefined as unknown as SDKMessage)).toBe(false);
    expect(isOverloadedMessage("overloaded" as unknown as SDKMessage)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// overloadResultFrame — the MID-TURN-529 graceful turn-boundary `result` frame.
//
// THE BEHAVIOR UNDER TEST: when a 529 surfaces AFTER this attempt emitted rendered output, index.ts
// does NOT retry (that would duplicate text under fresh seqs) — it ends the turn by emitting the
// terminal `result` the partial turn never got to. This pure builder produces that exact frame. Its
// field shape must stay byte-identical to what normalize() emits for a `result`, and two fields are
// load-bearing for the orchestrator's graceful-advance: is_error:true and subtype
// "error_during_execution" (the session-FATAL guard EXCLUDES that subtype). So we pin the WHOLE
// object — deep-equal, not field-by-field — and call out the load-bearing fields explicitly.
// ---------------------------------------------------------------------------
describe("overloadResultFrame — mid-turn-529 graceful turn-boundary frame", () => {
  it("builds the exact 9-field result frame for the given seq", () => {
    const frame = overloadResultFrame(42);

    // Whole-object pin: the inline literal index.ts used to emit, byte-for-byte. A drift in any
    // field name/value/order (vs normalize()'s result frame) would break this.
    // FALSIFY: flip subtype to "success" (or is_error to false) → the partial-turn 529 would be
    // routed through the orchestrator's session-FATAL guard instead of graceful-advance → RED.
    expect(frame).toEqual({
      seq: 42,
      kind: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Anthropic API overloaded (HTTP 529) after partial output; not retried.",
      num_turns: null,
      duration_ms: null,
      total_cost_usd: null,
      session_id: null,
    });

    // Belt-and-suspenders on the load-bearing fields the orchestrator branches on, asserted
    // individually so a regression names the exact culprit (toEqual above would catch it too).
    // FALSIFY: subtype "success" → orchestrator treats it as a FATAL result → RED.
    expect(frame.subtype).toBe("error_during_execution");
    // FALSIFY: is_error:false → the frontend stream reducer / orchestrator misread the turn-end → RED.
    expect(frame.is_error).toBe(true);
    // FALSIFY: any other kind → neither consumer would treat it as the terminal turn boundary → RED.
    expect(frame.kind).toBe("result");
    // FALSIFY: a different string → the user-facing "not retried" notice would drift → RED.
    expect(frame.result).toBe("Anthropic API overloaded (HTTP 529) after partial output; not retried.");
    // The four trailing metrics are unknown for a synthesized frame → all null (never 0/"").
    // FALSIFY: any non-null → a downstream cost/turn aggregator would double-count → RED.
    expect(frame.num_turns).toBeNull();
    expect(frame.duration_ms).toBeNull();
    expect(frame.total_cost_usd).toBeNull();
    expect(frame.session_id).toBeNull();
  });

  it("stamps the seq it is given (caller draws from the shared counter)", () => {
    // index.ts calls overloadResultFrame(seqCounter.value++) — the frame must carry whatever seq the
    // shared monotonic counter hands it, NOT a hard-coded value.
    // FALSIFY: hard-code seq inside the builder → this (and the 42 case above) → RED.
    expect(overloadResultFrame(0).seq).toBe(0);
    expect(overloadResultFrame(7).seq).toBe(7);
  });
});
