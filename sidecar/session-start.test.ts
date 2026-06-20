// Falsifiable unit tests for the sidecar's PURE start-command decision (session-start.ts).
//
// THE BUG UNDER TEST (stop → new plan context bleed): a `start` command reaching an
// already-started sidecar used to be SILENTLY IGNORED ("start ignored — session already
// running") — the old SDK Query, its conversation context, AND the module-level hostPolicy
// all survived, so every subsequent `user` message (the new plan's turns) was absorbed into
// the OLD session. decideStart makes that path impossible: a second start is a FATAL
// protocol rejection (the process dies; the host's Terminated handler frees the session
// slot), and a fresh start derives the hostPolicy backstop from the start command's own
// permissionMode — never from whatever the module variable held before.

import { describe, it, expect } from "vitest";
import { decideStart, SECOND_START_MESSAGE } from "./session-start";

describe("sidecar decideStart — second start is a fatal protocol rejection, never a silent join", () => {
  it("alreadyStarted=true → reject with a FATAL protocol error frame", () => {
    const d = decideStart(true, "plan");
    // FALSIFY: restore the old silent-ignore (return a fresh/no-op decision for a second
    // start) → kind is not "reject" → RED. The fatal:true bit is load-bearing: the host
    // surfaces it AND the process exits, so the new plan can never silently run inside the
    // old session's context.
    expect(d.kind).toBe("reject");
    if (d.kind !== "reject") return;
    expect(d.frame).toEqual({
      kind: "error",
      error_kind: "protocol",
      message: SECOND_START_MESSAGE,
      fatal: true,
    });
  });

  it("the rejection message names the context-bleed hazard (operator-debuggable)", () => {
    expect(SECOND_START_MESSAGE).toMatch(/prior session/i);
  });
});

describe("sidecar decideStart — a fresh start derives hostPolicy from ITS OWN permissionMode", () => {
  it('mode "plan" → hostPolicy "plan" (a stale "acceptEdits" from a stopped run can never leak in)', () => {
    // The decision is a pure function of (alreadyStarted, permissionMode) — there is no input
    // for "the policy some prior session left behind", so a stale widened policy structurally
    // cannot flow into a fresh session. FALSIFY: have decideStart read/return anything other
    // than hostPolicyForMode(permissionMode) (e.g. a fixed "acceptEdits") → RED.
    const d = decideStart(false, "plan");
    expect(d).toEqual({ kind: "fresh", hostPolicy: "plan" });
  });

  it('mode "acceptEdits" → hostPolicy "acceptEdits" (the one widening value round-trips)', () => {
    expect(decideStart(false, "acceptEdits")).toEqual({ kind: "fresh", hostPolicy: "acceptEdits" });
  });

  it('mode "prototype" → hostPolicy "prototype" (the narrow prototype-scratch widening round-trips)', () => {
    // FALSIFY: drop the "prototype" branch from hostPolicyForMode → this collapses to "plan" → RED.
    expect(decideStart(false, "prototype")).toEqual({ kind: "fresh", hostPolicy: "prototype" });
  });

  it('unknown / SDK-only / malformed modes fail CLOSED to "plan"', () => {
    for (const mode of ["default", "bypassPermissions", undefined, null, 42, ""]) {
      expect(decideStart(false, mode)).toEqual({ kind: "fresh", hostPolicy: "plan" });
    }
  });
});
