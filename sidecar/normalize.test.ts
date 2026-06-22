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
import { createNormalizer, type SeqCounter } from "./normalize";
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
