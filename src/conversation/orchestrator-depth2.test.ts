// PHASE 4 — the scripted DEPTH-2 driver suite (the centerpiece): full descent/ascent through the
// REAL driver via live frames (no reducer mocking), with recording fakes — the same substrate the
// golden oracle and the gate-invariant suites use.
//
// Tree under test: root split [01 leaf, 02 split [02.01 leaf, 02.02 leaf]].
//
// PINNED INVARIANTS (each falsified — evidence inline):
//   • interrupt_fires_at_every_decomposition_approval — BOTH the root AND the nested decomposition
//     approval fire deps.interrupt() (exactly 2 across the run). FALSIFIED 2026-06-11: routed the
//     nested approval around the interrupt (guarded `if (path.length === 0)` before deps.interrupt
//     in the decomposition branch) → interrupts stayed 1 and the boundary-result assertions
//     downstream went RED; restored → GREEN.
//   • decomposition approvals are the ONLY resuming-arming sites — the watchdog timer count equals
//     the decomposition-approval count (2), and EVERY non-decomposition hop sends INLINE with no
//     live timer. Per-hop falsifications (run 2026-06-11, each restored):
//       hops A and C (child-summary → next-sibling recon; roll-up-summary → ascent next-sibling
//         recon — they share the summary branch's recon-arm site): replaced the inline send with
//         `armResuming(nextPath)` → the recon prompt was never sent off the summary result, a live
//         watchdog timer leaked, and BOTH the main trace test (hop A assertions) and the hop-C
//         test went RED (5/5 failed — everything downstream of hop A starves).
//       hop B (last-child-summary → roll-up send): same arm at the ROLL-UP arm site only → the
//         roll-up prompt never fired → the main test and hop-C test RED (the watchdog would FATAL
//         the live run).
//   • write-policy acceptEdits ONLY during leaf executions — the EXACT setMode trace.
//   • nested redraft-in-place at the 02 gate; roll-up 02-summary.md fed BOTH children's summaries;
//     per-level threading (02.02 sees 02.01's summary, never 01's); FATAL and Stop mid-depth leave
//     a coherent terminal state; nn>99 in a NESTED draft denies-for-redraft like the root.

import { describe, it, expect, vi } from "vitest";

import { createOrchestrator, type OrchestratorDeps, type OrchestratorHandle } from "./orchestrator";
import { assertCoherent2, nodeAtPath, parsePathKey, type PlanTreeSnapshot2 } from "./plan-tree";
import type { AssistantText, ResultMsg, ToolPermissionRequested } from "./types";

// ---- recording fakes + frame builders (the orchestrator-gate-invariants pattern) ----------------

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

interface Rec {
  deps: OrchestratorDeps;
  sends: string[];
  setModes: string[];
  writes: Array<{ name: string; contents: string }>;
  agentPlans: Array<{ treeId: string; nn: string | null }>;
  resolves: Array<{ id: string; allow: boolean; message?: string }>;
  interrupts: () => number;
  timers: FakeTimer[];
  liveTimers: () => number;
  // PHASE 5 — the RESUMING watchdog is 30s; the generalized summary/parent-review turn watchdogs
  // are 120s. Filtering by ms keeps the "decomposition approvals are the ONLY resuming-arming
  // sites" pin expressible now that every summary/review turn legitimately arms a (longer) timer.
  resumingTimers: () => FakeTimer[];
  liveResuming: () => number;
  cancels: () => number;
  ends: () => number;
}

function makeDeps(): Rec {
  const sends: string[] = [];
  const setModes: string[] = [];
  const writes: Array<{ name: string; contents: string }> = [];
  const agentPlans: Array<{ treeId: string; nn: string | null }> = [];
  const resolves: Array<{ id: string; allow: boolean; message?: string }> = [];
  const timers: FakeTimer[] = [];
  let interruptCount = 0;
  let cancelCount = 0;
  let endCount = 0;
  const deps: OrchestratorDeps = {
    startSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async (t: string) => void sends.push(t)),
    setMode: vi.fn(async (m: string) => void setModes.push(m)),
    resolvePermission: vi.fn(async (a: { id: string; allow: boolean; message?: string }) =>
      void resolves.push({ id: a.id, allow: a.allow, message: a.message }),
    ),
    cancelRun: vi.fn(async () => {
      cancelCount++;
    }),
    interrupt: vi.fn(async () => {
      interruptCount++;
    }),
    endSession: vi.fn(async () => {
      endCount++;
    }),
    writePlanTreeFile: vi.fn(async (_c, name, contents) => {
      writes.push({ name, contents });
      return `/abs/.plan-tree/${name}`;
    }),
    writeAgentPlan: vi.fn(async (_p, treeId, nn) => {
      agentPlans.push({ treeId, nn });
      return `/abs/plans/${nn ?? "master"}.md`;
    }),
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
  return {
    deps,
    sends,
    setModes,
    writes,
    agentPlans,
    resolves,
    interrupts: () => interruptCount,
    timers,
    liveTimers: () => timers.filter((t) => !t.cleared).length,
    resumingTimers: () => timers.filter((t) => t.ms === 30_000),
    liveResuming: () => timers.filter((t) => !t.cleared && t.ms === 30_000).length,
    cancels: () => cancelCount,
    ends: () => endCount,
  };
}

// Distinctive summary markers so containment assertions are unambiguous.
const SUM_01 = "ROOT-CHILD-01-SUMMARY-MARKER";
const SUM_0201 = "GRANDCHILD-0201-SUMMARY-MARKER";
const SUM_0202 = "GRANDCHILD-0202-SUMMARY-MARKER";
const SUM_ROLLUP_02 = "ROLLUP-02-SUMMARY-MARKER";

const summaryText = (marker: string): string =>
  `## Changes\n${marker}\n## Findings\nf\n## Next-step inputs\nn`;

// Drive a fresh handle to the held ROOT decomposition gate (split 2: 01 First / 02 Second).
async function driveToRootGate(h: OrchestratorHandle): Promise<void> {
  await h.start({ cwd: "/work", request: "deep request" });
  await h.ingestStream(textFrame("the confirmed intent"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("root recon report"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
  await h.ingestStream(resultFrame());
  await h.ingestPermission(
    exitPlanModeReq(
      "root-tu",
      "# Root preamble\n\n### Sub-Plan 01: First\nroot scope one\n\n### Sub-Plan 02: Second\nroot scope two\n",
    ),
  );
}

// Run one LEAF child at `key`: (recon already prompted) recon text+result → sizer single → draft →
// leaf gate → approve → exec result → summary text+result.
async function runLeaf(h: OrchestratorHandle, key: string, marker: string): Promise<void> {
  await h.ingestStream(textFrame(`${key} recon`));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
  await h.ingestStream(resultFrame());
  await h.ingestPermission(exitPlanModeReq(`leaf-${key}-tu`, `${key} plan body`));
  await h.approve(key);
  await h.ingestStream(resultFrame()); // exec completion → summary prompt
  await h.ingestStream(textFrame(summaryText(marker)));
  await h.ingestStream(resultFrame()); // summary result → write + ascent hop
}

// PHASE 5 — complete a pending parent-review turn with NONE (no adjustment note): the review
// result is the boundary that fires the next sibling's recon INLINE.
async function answerReviewNone(h: OrchestratorHandle): Promise<void> {
  await h.ingestStream(textFrame("NONE"));
  await h.ingestStream(resultFrame());
}

// Drive the WHOLE main scenario up to (and including) the nested 02 gate being held.
async function driveToNestedGate(h: OrchestratorHandle, rec: Rec): Promise<void> {
  await driveToRootGate(h);
  await h.approve(""); // root decomposition approval (interrupt #1, resuming armed)
  await h.ingestStream(resultFrame()); // boundary result → deferred 01 recon
  await runLeaf(h, "01", SUM_01); // 01 full leaf cycle → PHASE 5: the ROOT's review turn
  expect(rec.sends.at(-1)).toContain("Sub-plan 01 has completed");
  await answerReviewNone(h); // NONE → inline 02 recon prompt
  expect(rec.sends.at(-1)).toContain("sub-plan 02");
  await h.ingestStream(textFrame("02 recon"));
  await h.ingestStream(resultFrame()); // → sizer prompt for 02
  await h.ingestStream(textFrame("SIZER: split / 2 / 0.85"));
  await h.ingestStream(resultFrame()); // → nested decomposition draft prompt
  await h.ingestPermission(
    exitPlanModeReq(
      "decomp-02-tu",
      "# Nested preamble for 02\n\n### Sub-Plan 01: SubA\nnested scope A\n\n### Sub-Plan 02: SubB\nnested scope B\n",
    ),
  );
}

// ---- the centerpiece: descent_ascent_depth2_trace ------------------------------------------------

describe("PHASE 4 — descent_ascent_depth2_trace (root [01 leaf, 02 split[02.01, 02.02]])", () => {
  it("runs the full descent/ascent: gate order, BOTH interrupts, exact write-policy trace, roll-up, done", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    const gates: Array<{ key: string; kind: string }> = [];
    const doneSnaps: PlanTreeSnapshot2[] = [];
    h.subscribe({
      onAwaitingApproval: (g) => gates.push({ key: g.path.map((n) => String(n).padStart(2, "0")).join("."), kind: g.kind }),
      onDone: (s) => doneSnaps.push(s),
    });

    await driveToNestedGate(h, rec);

    // The NESTED decomposition gate is held at path "02", kind decomposition.
    expect(h.snapshot().pendingApproval).toMatchObject({ kind: "decomposition" });
    expect(gates.at(-1)).toEqual({ key: "02", kind: "decomposition" });

    // The nested decomposition draft prompt carried 02's MANDATE (parseSubPlanHeaders reuse): the
    // per-level header form, the child section body, and the root preamble as shared context.
    const nestedDraftPrompt = rec.sends.find((s) => s.includes("Draft its DECOMPOSITION plan"))!;
    expect(nestedDraftPrompt).toContain("Sub-Plan 02: Second");
    expect(nestedDraftPrompt).toContain("root scope two");
    expect(nestedDraftPrompt).toContain("Root preamble");
    expect(nestedDraftPrompt).toContain("the full id will be 02.NN");

    // The nested decomposition was written to BOTH stores: the plans dir (nn "02", same treeId as
    // the master) AND .plan-tree/02-plan.md (summaryName2-style naming).
    const treeId = h.snapshot().treeId;
    expect(rec.agentPlans).toContainEqual({ treeId, nn: null }); // the root master
    expect(rec.agentPlans).toContainEqual({ treeId, nn: "02" }); // the nested decomposition
    expect(rec.writes.some((w) => w.name === "02-plan.md")).toBe(true);

    // ---- NESTED REDRAFT-IN-PLACE at the 02 gate ----
    await h.requestChanges("02", "tighten the nested split");
    expect(rec.resolves.at(-1)).toEqual({
      id: "decomp-02-tu",
      allow: false,
      message: "tighten the nested split",
    });
    // Re-draft lands through the SAME nested decomposition flow; the gate re-arms with redraftCount 1.
    await h.ingestPermission(
      exitPlanModeReq(
        "decomp-02b-tu",
        "# Nested preamble for 02\n\n### Sub-Plan 01: SubA\nnested scope A v2\n\n### Sub-Plan 02: SubB\nnested scope B v2\n",
      ),
    );
    expect(h.snapshot().pendingApproval).toMatchObject({ kind: "decomposition", redraftCount: 1 });

    // ---- NESTED DECOMPOSITION APPROVAL: interrupt #2 + resuming (deferred 02.01 recon) ----
    const sendsBefore = rec.sends.length;
    await h.approve("02");
    // BOTH-INTERRUPTS PIN: the nested approval interrupts exactly like the root's. FALSIFIED
    // 2026-06-11 (see header): guard the interrupt to root-only → stays 1 → RED.
    expect(rec.interrupts()).toBe(2);
    expect(rec.sends.length).toBe(sendsBefore); // deferred — NOTHING sent inline at a decomposition approval
    expect(rec.liveTimers()).toBe(1); // the resuming watchdog armed
    expect(rec.liveResuming()).toBe(1);
    await h.ingestStream(resultFrame()); // interrupt-boundary result → deferred 02.01 recon
    expect(rec.liveTimers()).toBe(0);
    const recon0201 = rec.sends.at(-1)!;
    expect(recon0201).toContain("sub-plan 02.01");
    expect(recon0201).toContain("SubA");
    expect(recon0201).toContain("nested scope A v2"); // the REDRAFT's mandate, not the stale one
    expect(recon0201).toContain("Nested preamble for 02"); // nested-master preamble threads down

    // ---- 02.01 leaf cycle → hop A: the NESTED (02-level) review turn, then INLINE 02.02 recon ----
    await runLeaf(h, "02.01", SUM_0201);
    // PHASE 5: the review happens at the NESTED level — 02 reviews 02.01's summary against 02.02's
    // mandate before 02.02 starts.
    const nestedReview = rec.sends.at(-1)!;
    expect(nestedReview).toContain("Sub-plan 02.01 has completed");
    expect(nestedReview).toContain(SUM_0201); // the child summary rides the review prompt verbatim
    expect(nestedReview).toContain("Sub-Plan 02.02: SubB"); // the remaining sibling's frozen mandate
    expect(rec.liveResuming()).toBe(0); // hop A is inline — no resuming watchdog armed
    await answerReviewNone(h);
    const recon0202 = rec.sends.at(-1)!;
    expect(recon0202).toContain("sub-plan 02.02");
    expect(rec.liveResuming()).toBe(0);
    // PER-LEVEL THREADING PIN: 02.02 sees its SIBLING 02.01's summary — and NEVER 01's (the old
    // global collection would leak it here). FALSIFY: revert priorSummaries to the global
    // collection → SUM_01 appears → RED.
    expect(recon0202).toContain(SUM_0201);
    expect(recon0202).not.toContain(SUM_01);

    // ---- 02.02 leaf cycle (LAST grandchild) → hop B: INLINE roll-up prompt for 02, NO review ----
    await runLeaf(h, "02.02", SUM_0202);
    const rollupPrompt = rec.sends.at(-1)!;
    // PHASE 5 skip-after-last pin: the LAST sibling's summary goes straight to the roll-up — no
    // review turn fires (a review here would make this send a review prompt instead → RED).
    expect(rollupPrompt).toContain("All child sub-plans of sub-plan 02 have finished");
    expect(rec.liveResuming()).toBe(0); // hop B is inline too
    // The roll-up prompt is fed BOTH children's summaries.
    expect(rollupPrompt).toContain(SUM_0201);
    expect(rollupPrompt).toContain(SUM_0202);
    expect(rollupPrompt).not.toContain(SUM_01); // per-level: only 02's own children

    // ---- the roll-up summary turn → 02-summary.md → root done (02 is the LAST root child) ----
    await h.ingestStream(textFrame(summaryText(SUM_ROLLUP_02)));
    await h.ingestStream(resultFrame());
    const rollupWrite = rec.writes.find((w) => w.name === "02-summary.md");
    expect(rollupWrite).toBeDefined();
    expect(rollupWrite!.contents).toContain(SUM_ROLLUP_02);
    expect(doneSnaps).toHaveLength(1);
    expect(h.snapshot().done).toBe(true);
    expect(() => assertCoherent2(h.snapshot().root)).not.toThrow();

    // ---- GATE ORDER across the whole run ----
    expect(gates).toEqual([
      { key: "", kind: "decomposition" }, // root decomposition
      { key: "01", kind: "leaf" }, // 01 leaf
      { key: "02", kind: "decomposition" }, // nested decomposition
      { key: "02", kind: "decomposition" }, // its redraft
      { key: "02.01", kind: "leaf" },
      { key: "02.02", kind: "leaf" },
    ]);

    // ---- WRITE-POLICY: acceptEdits ONLY during the THREE leaf executions (exact trace) ----
    // The session OPENS in the genesis "prototype" policy (carried by startSession — no setMode);
    // "plan" is first asserted at the INTENT_CLARIFIED boundary, then re-asserted after each
    // ExitPlanMode allow-resolve (assertedPolicy → unknown) and after each leaf summary
    // (executing → summarized). The roll-up window/turn never widens the mode.
    expect(rec.setModes).toEqual([
      "plan", // INTENT_CLARIFIED (genesis "prototype" → root open/recon derives plan)
      "plan", // root decomposition approval (resolve nulls the cache; derived policy is plan)
      "acceptEdits", // 01 approved → executing
      "plan", // 01 summarized → 02 recon
      "plan", // nested 02 decomposition approval
      "acceptEdits", // 02.01 approved → executing
      "plan", // 02.01 summarized → 02.02 recon
      "acceptEdits", // 02.02 approved → executing
      "plan", // 02.02 summarized → 02 roll-up window (still plan)
    ]);

    // ---- RESUMING-ARMING SITES: exactly the TWO decomposition approvals armed a RESUMING (30s)
    // watchdog. FALSIFY: arm resuming at any summary/roll-up hop → a third 30s timer appears → RED.
    // (PHASE 5: summary and parent-review turns arm their own 120s turn watchdogs — 4 summary turns
    // [01, 02.01, 02.02, the 02 roll-up] + 2 review turns [root after 01, 02 after 02.01] — all
    // cleared by their consumed results; none live at the end.)
    expect(rec.resumingTimers()).toHaveLength(2);
    expect(rec.timers.filter((t) => t.ms === 120_000)).toHaveLength(6);
    expect(rec.liveTimers()).toBe(0);

    // ---- the summary FILES: every node contributed exactly one summary ----
    for (const name of ["01-summary.md", "02.01-summary.md", "02.02-summary.md", "02-summary.md"]) {
      expect(rec.writes.filter((w) => w.name === name)).toHaveLength(1);
    }
  });

  it("hop C: a roll-up summary under a NON-last parent ascends INLINE to the next ROOT sibling (threading the roll-up, not the grandchildren)", async () => {
    // Tree: root [01 split[01.01], 02 leaf] — 01's roll-up must fire 02's recon inline.
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await driveToRootGate(h);
    await h.approve("");
    await h.ingestStream(resultFrame()); // → 01 recon
    await h.ingestStream(textFrame("01 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 1 / 0.9")); // 01 itself splits
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("decomp-01-tu", "### Sub-Plan 01: OnlyGrand\ngrand scope\n"),
    );
    await h.approve("01"); // nested decomposition approval (interrupt #2)
    expect(rec.interrupts()).toBe(2);
    await h.ingestStream(resultFrame()); // → 01.01 recon
    await runLeaf(h, "01.01", SUM_0201); // last (only) grandchild → hop B: roll-up prompt for 01
    expect(rec.sends.at(-1)).toContain("All child sub-plans of sub-plan 01 have finished");

    // The roll-up summary result → 01-summary.md → hop C: PHASE 5 — the ROOT reviews 01's ROLL-UP
    // summary (a split sibling completes via its roll-up, exactly like a leaf via its summary)
    // before 02's recon. Both hops are INLINE: no resuming timer, no interrupt.
    const resumingBefore = rec.resumingTimers().length;
    const interruptsBefore = rec.interrupts();
    await h.ingestStream(textFrame(summaryText(SUM_ROLLUP_02.replace("02", "01"))));
    await h.ingestStream(resultFrame());
    const rootReview = rec.sends.at(-1)!;
    expect(rootReview).toContain("Sub-plan 01 has completed");
    expect(rootReview).toContain(SUM_ROLLUP_02.replace("02", "01")); // the ROLL-UP rides the review
    await answerReviewNone(h);
    const recon02 = rec.sends.at(-1)!;
    expect(recon02).toContain("sub-plan 02");
    expect(recon02).toContain("reconnaissance scoped to THIS sub-plan");
    // PER-LEVEL THREADING: 02 sees 01's ROLL-UP summary (one entry per completed sibling), never
    // the grandchild's. FALSIFY: thread the global map → SUM_0201 appears → RED.
    expect(recon02).toContain(SUM_ROLLUP_02.replace("02", "01"));
    expect(recon02).not.toContain(SUM_0201);
    // Hop C is INLINE: no new RESUMING watchdog, no interrupt (the review's own 120s turn watchdog
    // was armed and cleared by its consumed result).
    expect(rec.resumingTimers().length).toBe(resumingBefore);
    expect(rec.interrupts()).toBe(interruptsBefore);
    expect(rec.liveTimers()).toBe(0);

    await h.cancel();
  });
});

// ---- PHASE 6: refining a DEPTH-2 SPLIT target clears the WHOLE subtree (no stale descendants) ----
//
// The gap this pins: ACCEPTANCE_REFINED resets a root child + right-siblings, but the cleanup must be
// scoped to the WHOLE SUBTREE of each reset node — not just its direct key. When the refined target
// is itself a SPLIT node (depth-2 grandchildren under it), the driver's in-memory `summaries` map and
// the on-disk plan/summary files for those grandchildren are STALE and must be dropped. If only the
// direct key is dropped, the re-decomposition (which may reuse the same grandchild NNs) threads the
// stale "01.<nn>" entries as PHANTOM prior-sibling summaries into the re-run's recon/draft prompts —
// the exact stale-summary failure Phase 6 exists to eliminate.

describe("PHASE 6 — refining a depth-2 SPLIT target clears the whole subtree (driver map + on-disk files)", () => {
  const PROTO_BLOCK =
    "---PROTOTYPE---\n" +
    JSON.stringify({ kind: "html", paths: [".plan-tree/prototype/index.html"], screenshot: null, inline_preview: null, variants: [] }) +
    "\n---END-PROTOTYPE---";

  // makeDeps + the baseline/refine deps the shared fake omits (ensureBaselineDir + freezeBaseline so a
  // working-reference freeze records baseline_ → the acceptance gate ARMS; deletePlanTreeFile so the
  // refine's delete effects are recorded; openBaseline is best-effort at the gate).
  function makeRefineDeps(): Rec & { deletes: string[] } {
    const rec = makeDeps();
    const deletes: string[] = [];
    rec.deps.ensureBaselineDir = vi.fn(async () => "/abs/.plan-tree/baseline");
    rec.deps.freezeBaseline = vi.fn(async () => "/abs/.plan-tree/baseline");
    rec.deps.openBaseline = vi.fn(async () => {});
    rec.deps.deletePlanTreeFile = vi.fn(async (_c: string, name: string) => void deletes.push(name));
    return Object.assign(rec, { deletes });
  }

  // Drive: baseline-bearing prototype gate → root split [01 split[01.01], 02 leaf] → both branches
  // summarize → the LAST root child arms the forced acceptance gate (baseline present). Tree shape
  // mirrors hop C but with a working-reference baseline so the gate actually arms.
  async function driveDepth2BaselineToAcceptanceGate(h: OrchestratorHandle): Promise<void> {
    await h.start({ cwd: "/work", request: "deep request" });
    // Intent turn carries a prototype block → held prototype gate.
    await h.ingestStream(textFrame(`the confirmed intent\n\n${PROTO_BLOCK}`));
    await h.ingestStream(resultFrame());
    // WORKING REFERENCE → freezes prototype→baseline, records baseline_ → the gate will arm at completion.
    await h.approvePrototype({ asWorkingReference: true });
    // Root recon → split into [01, 02].
    await h.ingestStream(textFrame("root recon report"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq(
        "root-tu",
        "# Root preamble\n\n### Sub-Plan 01: First\nroot scope one\n\n### Sub-Plan 02: Second\nroot scope two\n",
      ),
    );
    await h.approve(""); // root decomposition approval (interrupt #1)
    await h.ingestStream(resultFrame()); // boundary → 01 recon
    // 01 itself SPLITS into a single grandchild [01.01].
    await h.ingestStream(textFrame("01 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("decomp-01-tu", "### Sub-Plan 01: OnlyGrand\ngrand scope\n"));
    await h.approve("01"); // nested decomposition approval (interrupt #2)
    await h.ingestStream(resultFrame()); // boundary → 01.01 recon
    await runLeaf(h, "01.01", SUM_0201); // grandchild → roll-up prompt for 01
    // 01's roll-up summary → 01-summary.md → root review of 01 → 02 recon.
    await h.ingestStream(textFrame(summaryText(SUM_01)));
    await h.ingestStream(resultFrame());
    await answerReviewNone(h); // NONE → 02 recon prompt (02 is a leaf)
    await runLeaf(h, "02", SUM_ROLLUP_02); // LAST root child → arms the forced acceptance gate
  }

  it("DEPTH-2 SPLIT TARGET: refine drops the whole subtree — stale grandchild summary does NOT thread into the re-run, and grandchild files are deleted", async () => {
    const rec = makeRefineDeps();
    const h = createOrchestrator(rec.deps);
    await driveDepth2BaselineToAcceptanceGate(h);

    // PRECONDITIONS: the acceptance gate is held, and the target 01 is a SPLIT (has a grandchild).
    expect(h.snapshot().pendingAcceptance).not.toBeNull();
    const child01 = nodeAtPath(h.snapshot().root, parsePathKey("01"));
    expect(child01?.state.stage).toBe("split"); // 01 really decomposed (else this degenerates to depth-1)

    // Sanity: BEFORE the refine, the grandchild's summary IS in the threading map — prove it by the
    // on-disk write (the in-memory map is private; its write companion is observable). 01.01 wrote a
    // summary file during the run.
    expect(rec.writes.some((w) => w.name === "01.01-summary.md")).toBe(true);

    const sendsBefore = rec.sends.length;
    await h.refineAcceptance(parsePathKey("01")); // reset 01 (split) + 02 (right sibling)

    // (b) ON-DISK CLEANUP: the refine deleted the target's DIRECT files AND its DESCENDANT (grandchild)
    // files — not just the direct 01 files. FALSIFIABLE: drop the reducer's emitDescendantDeletes call
    // → "01.01-plan.md"/"01.01-summary.md" vanish from this list → RED.
    expect(rec.deletes).toContain("01-plan.md");
    expect(rec.deletes).toContain("01-summary.md");
    expect(rec.deletes).toContain("01.01-plan.md");
    expect(rec.deletes).toContain("01.01-summary.md");
    expect(rec.deletes).toContain("02-plan.md");
    expect(rec.deletes).toContain("02-summary.md");
    // Every delete name is a containment-guardable plan-tree name (dotted NN(.NN)*-(plan|summary).md).
    for (const name of rec.deletes) {
      expect(name).toMatch(/^\d{2}(\.\d{2})*-(plan|summary)\.md$/);
    }

    // The refine drove 01's recon turn (re-execution resumes there); the gate cleared, no verdict.
    expect(h.snapshot().pendingAcceptance).toBeNull();
    expect(h.snapshot().done).toBe(false);
    const refineRecon = rec.sends.at(-1)!;
    expect(refineRecon).toContain("sub-plan 01");
    expect(refineRecon).toContain("reconnaissance scoped to THIS sub-plan");

    // (a) IN-MEMORY MAP CLEANUP: re-run 01 as a split that RE-DECOMPOSES into the SAME grandchild NN
    // (01.01). The new grandchild's recon prompt threads priorSummaries([01]) — the DIRECT children
    // of 01 in the live `summaries` map. If the stale "01.01" entry survived the refine, the OLD
    // grandchild marker (SUM_0201) would thread here as a phantom prior sibling.
    await h.ingestStream(textFrame("01 recon v2"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("decomp-01-v2-tu", "### Sub-Plan 01: OnlyGrandV2\ngrand scope v2\n"));
    await h.approve("01"); // re-decomposition approval
    await h.ingestStream(resultFrame()); // boundary → NEW 01.01 recon

    const newGrandReconIdx = rec.sends.findIndex(
      (s, i) => i >= sendsBefore && s.includes("sub-plan 01.01") && s.includes("reconnaissance scoped to THIS sub-plan"),
    );
    expect(newGrandReconIdx).toBeGreaterThanOrEqual(0); // the new grandchild recon DID fire
    const newGrandRecon = rec.sends[newGrandReconIdx];
    // THE FIX, OBSERVED: the stale grandchild summary is GONE from the re-run's threaded prior
    // summaries. FALSIFIABLE: in refineAcceptance, drop only the direct key (revert the subtree drop:
    // `for (const k of resetKeys) summaries.delete(k);`) → the stale "01.01" entry survives → SUM_0201
    // threads into this prompt as a phantom prior sibling → this assertion goes RED.
    expect(newGrandRecon).not.toContain(SUM_0201);

    await h.cancel();
  });
});

// ---- nested mandate validation: nn > 99 in a NESTED draft denies-for-redraft --------------------

describe("PHASE 4 — nested decomposition validation (same behavior as the root)", () => {
  it("a nested draft with `Sub-Plan 100` is DENIED with the validation message — run stays active, no gate", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await driveToNestedGate(h, rec); // (the valid nested draft holds the gate…)
    await h.requestChanges("02", "redo"); // …clear it so 02 is back at open/decomposing
    const gatesBefore = h.snapshot().pendingApproval;
    expect(gatesBefore).toBeNull();

    await h.ingestPermission(
      exitPlanModeReq("decomp-02-huge-tu", "### Sub-Plan 100: Way too many\nx\n"),
    );
    // The held ExitPlanMode was DENIED with the validation message (deny-for-redraft — the same
    // mechanism the root uses). FALSIFY: rethrow instead of deny in the nested path → the ingest
    // queue catch FATALs the run → orchestrationActive() false → RED below.
    const deny = rec.resolves.at(-1)!;
    expect(deny.id).toBe("decomp-02-huge-tu");
    expect(deny.allow).toBe(false);
    expect(deny.message).toContain("master plan validation failed");
    expect(deny.message).toContain("1-99");
    expect(h.snapshot().pendingApproval).toBeNull(); // no gate from the invalid draft
    expect(h.orchestrationActive()).toBe(true); // recoverable — the model redrafts in the same turn

    await h.cancel();
  });
});

// ---- mid-depth terminals: FATAL and Stop leave a coherent terminal state -------------------------

describe("PHASE 4 — mid-depth terminals", () => {
  // Drive to 02.01 EXECUTING (deep in the tree, acceptEdits live).
  async function driveToDeepExecuting(rec: Rec, h: OrchestratorHandle): Promise<void> {
    await driveToNestedGate(h, rec);
    await h.approve("02");
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("02.01 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("leaf-02.01-tu", "02.01 plan"));
    await h.approve("02.01");
    expect(rec.setModes.at(-1)).toBe("acceptEdits");
  }

  it("FATAL while 02.01 executes: terminal, session ended, ledger coherent, frames swallowed after", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    const fatals: string[] = [];
    h.subscribe({ onFatal: (m) => fatals.push(m) });
    await driveToDeepExecuting(rec, h);

    await h.dispatch({ type: "FATAL", message: "mid-depth boom" });
    expect(fatals).toEqual(["mid-depth boom"]);
    expect(h.orchestrationActive()).toBe(false);
    expect(rec.ends()).toBe(1); // FATAL ends the SDK session (no Stop-routing desync)
    // The ledger is left INTACT and COHERENT (02.01 still leaf/executing mid-tree — a legal resting
    // shape; FATAL never mutates the tree). FALSIFY: have FATAL zero out the children → throw here.
    expect(() => assertCoherent2(h.snapshot().root)).not.toThrow();
    expect(h.snapshot().done).toBe(false);

    // A trailing frame after the terminal is swallowed (no send, no throw).
    const sendsBefore = rec.sends.length;
    await h.ingestStream(resultFrame());
    expect(rec.sends.length).toBe(sendsBefore);
  });

  it("Stop (cancel) while 02.01 executes: cancelRun + endSession, coherent ledger, inactive", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await driveToDeepExecuting(rec, h);

    await h.cancel();
    expect(h.orchestrationActive()).toBe(false);
    expect(rec.cancels()).toBeGreaterThanOrEqual(1);
    expect(rec.ends()).toBe(1);
    expect(() => assertCoherent2(h.snapshot().root)).not.toThrow();
    // The active path is still resolvable mid-depth (parsePathKey round-trip sanity).
    expect(h.snapshot().activePath).toEqual(parsePathKey("02.01"));
  });
});
