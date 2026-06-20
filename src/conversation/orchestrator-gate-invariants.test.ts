// UNIFIED-GATE ROUTING INVARIANTS (Phase 1 of the recursive-multiplan plan).
//
// The gen-2 approve(pathKey) surface routes by gate.kind through an exhaustive switch. TWO
// load-bearing invariants live in that switch, each pinned here by a falsifiable test:
//
//   1. root_decomposition_gate_routes_decomposition_branch — approving the ROOT decomposition gate
//      MUST take the decomposition branch: arm the `resuming` hold (deferring the first child's
//      recon to the interrupt-boundary result) AND fire deps.interrupt() exactly once. FALSIFIED
//      2026-06-10: forced the root gate through the leaf branch (`gate.kind === "decomposition" ?
//      "leaf" : gate.kind` at the switch head) → APPROVE{path:[]} threw in the reducer (the root is
//      not a leaf), interrupt count stayed 0, the deferred recon never fired → RED; restored → GREEN.
//
//   2. leaf_approval_never_interrupts — approving a LEAF gate must NEVER call deps.interrupt():
//      the approval-resumed turn IS the user-approved execution, and interrupting it would abort
//      the very work the user just approved. FALSIFIED 2026-06-10: added `await deps.interrupt()`
//      to the leaf case → the interrupt count rose to 1 (root run: 2) → RED; removed → GREEN.
//
// Both tests drive the REAL driver through live frames (no reducer mocking) with recording fakes —
// the same substrate the golden oracle uses.

import { describe, it, expect, vi } from "vitest";

import { createOrchestrator, type OrchestratorDeps, type OrchestratorHandle } from "./orchestrator";
import type { AssistantText, ResultMsg, ToolPermissionRequested } from "./types";

// ---- recording fakes + frame builders (the orchestrator.test.ts pattern) ----------------------

let seq = 0;
const textFrame = (text: string): AssistantText => ({
  seq: ++seq,
  kind: "assistant_text",
  text,
  parent_tool_use_id: null,
});
const resultFrame = (): ResultMsg => ({
  seq: ++seq,
  kind: "result",
  subtype: "success",
  is_error: false,
  result: "",
  num_turns: 1,
  duration_ms: 1,
  total_cost_usd: 0,
  session_id: "s",
});
const exitPlanModeReq = (id: string, plan: string): ToolPermissionRequested => ({
  seq: ++seq,
  kind: "tool_permission_requested",
  id,
  tool: "ExitPlanMode",
  input: { plan },
  agent_id: null,
});

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function makeDeps(): {
  deps: OrchestratorDeps;
  sends: string[];
  interrupts: () => number;
  timers: FakeTimer[];
} {
  const sends: string[] = [];
  const timers: FakeTimer[] = [];
  let interruptCount = 0;
  const deps: OrchestratorDeps = {
    startSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async (t: string) => void sends.push(t)),
    setMode: vi.fn(async () => {}),
    resolvePermission: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {
      interruptCount++;
    }),
    endSession: vi.fn(async () => {}),
    writePlanTreeFile: vi.fn(async (_c, name) => `/abs/.plan-tree/${name}`),
    writeAgentPlan: vi.fn(async (_p, _t, nn) => `/abs/plans/${nn ?? "master"}.md`),
    resetPlanTreeDir: vi.fn(async () => {}),
    setTimeout: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as FakeTimer).cleared = true;
    },
  };
  return { deps, sends, interrupts: () => interruptCount, timers };
}

// Drive a fresh handle through intent → recon → sizer to a held ROOT decomposition gate (split 2).
async function driveToRootGate(h: OrchestratorHandle): Promise<void> {
  await h.start({ cwd: "/work", request: "do it" });
  await h.ingestStream(textFrame("the confirmed intent"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("recon report"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
  await h.ingestStream(resultFrame());
  await h.ingestPermission(
    exitPlanModeReq("root-tu", "### Sub-Plan 01: First\nx\n### Sub-Plan 02: Second\ny"),
  );
}

describe("invariant: root_decomposition_gate_routes_decomposition_branch", () => {
  it("approve('') on the root gate arms the resuming hold AND fires interrupt exactly once", async () => {
    const { deps, sends, interrupts, timers } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToRootGate(h);
    expect(h.snapshot().pendingApproval?.kind).toBe("decomposition");

    const sendsBefore = sends.length;
    await h.approve("");

    // The decomposition branch fired: interrupt EXACTLY once (the resume boundary), the resuming
    // watchdog armed (one live timer), and NOTHING sent inline (the deferred-send rule).
    expect(interrupts()).toBe(1);
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(sends.length).toBe(sendsBefore);

    // The boundary result consumes the hold → the deferred first-child recon fires (proof the
    // resuming hold — not idle, not exec — was armed).
    await h.ingestStream(resultFrame());
    expect(sends.length).toBe(sendsBefore + 1);
    expect(sends.at(-1)).toContain("sub-plan 01");
    expect(timers.every((t) => t.cleared)).toBe(true);

    await h.cancel();
  });
});

describe("invariant: leaf_approval_never_interrupts", () => {
  it("approve('01') on a leaf gate resolves + arms exec WITHOUT ever calling deps.interrupt()", async () => {
    const { deps, sends, interrupts } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToRootGate(h);
    await h.approve(""); // decomposition approval (the ONE legitimate interrupt site)
    await h.ingestStream(resultFrame()); // boundary result → deferred child-01 recon
    expect(interrupts()).toBe(1);

    // Child 01: recon → per-node sizer (PHASE 4; single ⇒ the child IS the leaf) → leaf draft →
    // held LEAF gate.
    await h.ingestStream(textFrame("child recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("leaf-tu", "the child plan"));
    expect(h.snapshot().pendingApproval?.kind).toBe("leaf");

    const sendsBefore = sends.length;
    await h.approve("01");

    // The LEAF branch: no interrupt (the resumed turn IS the execution), no inline send, and the
    // exec hold armed — the next result is the exec boundary and yields the summary prompt.
    expect(interrupts()).toBe(1); // unchanged — the decomposition approval's one interrupt only
    expect(sends.length).toBe(sendsBefore);
    await h.ingestStream(resultFrame()); // exec completion
    expect(sends.at(-1)).toContain("## Changes"); // the summary prompt (exec was armed, not resuming)
    expect(interrupts()).toBe(1); // still no further interrupt anywhere in the leaf arc

    await h.cancel();
  });
});
