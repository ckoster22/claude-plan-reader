// Agent SDK sidecar — pure `start`-command decision.
//
// Extracted from index.ts (like permissions.ts) so the session-freshness rule is UNIT-TESTABLE
// without importing index.ts's top-level side effects. NO module-level state here — the decision
// is a pure function of (alreadyStarted, permissionMode), which is the point: a fresh session's
// hostPolicy backstop is derived from the start command's OWN mode, so a stale "acceptEdits"
// left behind by a stopped mid-execution run structurally cannot leak into a new session's
// planning phase.

import { hostPolicyForMode, type HostPolicy } from "./permissions";

// The fatal-rejection message for a `start` arriving while a session already ran in this
// process. Names the hazard so the host-side log is operator-debuggable.
export const SECOND_START_MESSAGE =
  "start rejected: this sidecar already ran a session — a second start would silently join the " +
  "prior session's context. Spawn a fresh sidecar per session.";

// What the index.ts `start` handler must do with an incoming start command.
//   fresh  — begin the one session this process will ever run; assert `hostPolicy` as the
//            host-policy backstop (derived from the command's permissionMode, fail-closed "plan").
//   reject — a session already started in this process. Emit `frame` (the standard sidecar error
//            shape; the host normalizes error_kind → the public `kind`) and EXIT non-zero: the
//            old SDK Query / conversation context / module state MUST NOT absorb a new run. The
//            host's Terminated handling releases the session slot, so a retry starts clean.
export type StartDecision =
  | { kind: "fresh"; hostPolicy: HostPolicy }
  | {
      kind: "reject";
      frame: { kind: "error"; error_kind: "protocol"; message: string; fatal: true };
    };

// Decide how to handle a `start` command. Pure; the caller owns the `started` flag and the
// hostPolicy assignment.
export function decideStart(alreadyStarted: boolean, permissionMode: unknown): StartDecision {
  if (alreadyStarted) {
    return {
      kind: "reject",
      frame: {
        kind: "error",
        error_kind: "protocol",
        message: SECOND_START_MESSAGE,
        fatal: true,
      },
    };
  }
  return { kind: "fresh", hostPolicy: hostPolicyForMode(permissionMode) };
}
