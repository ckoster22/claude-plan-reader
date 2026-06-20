// PHASE 5 — the PARENT REVIEW TURN suite (reducer arcs, parseParentReview, prompt injection +
// the single-note lifecycle, the generalized turn watchdog, and the rogue-ExitPlanMode deny).
//
// Falsifiability (each inversion executed during development — evidence inline at the tests):
//   • injection: drop the adjustNoteFor() arg at the recon/draft send sites → the ADJUST-note
//     assertions go RED.
//   • clear point: remove clearAdjustNoteOnDraft + make NONE not overwrite the slot → the note
//     LEAKS into the third child's prompts → RED.
//   • skip-after-last: force advanceAfterSummary to review after the last child too → the reducer
//     run RED (and golden Scenario A red at the wire — the single-child case).
//   • watchdog: drop the armTurnWatchdog calls → the watchdog FATAL tests find no timer → RED.
//   • rogue deny: restore the silent return for the review/summary windows → the deny assertions
//     find no resolution → RED.

import { describe, it, expect, vi } from "vitest";

// diag is a guarded no-op in tests (no Tauri runtime); mock it so the "coerce loudly" pin can
// assert the diagnostic actually fired.
vi.mock("./diag", () => ({ diag: vi.fn() }));
import { diag } from "./diag";

import {
  createOrchestrator,
  parseParentReview,
  parentReviewPrompt,
  subReconPrompt,
  subDraftPrompt,
  type Mandate,
  type OrchestratorDeps,
  type OrchestratorHandle,
} from "./orchestrator";
import {
  reduce2,
  parseNn,
  nodeAtPath,
  activePathOf,
  assertCoherent2,
  nonEmpty,
  type PlanTreeState2,
  type PlanTreeEvent2,
  type NodePath,
  type TreeNode,
  type PlanTreeFilePath,
} from "./plan-tree";
import type { AssistantText, ResultMsg, ToolPermissionRequested } from "./types";

// ---- shared fixtures -----------------------------------------------------------------------------

const nnOf = (n: number) => parseNn(n);
const p = (...ns: number[]): NodePath => ns.map(nnOf);
const fileOf = (s: string) => s as PlanTreeFilePath;

function run2(state: PlanTreeState2, events: PlanTreeEvent2[]): PlanTreeState2 {
  let cur = state;
  for (const ev of events) {
    cur = reduce2(cur, ev).state;
    assertCoherent2(cur.root);
  }
  return cur;
}

function blank2(): PlanTreeState2 {
  return {
    schema: 2,
    tree_id: "t5",
    created_ms: 0,
    updated_ms: 0,
    root: {
      nn: nnOf(1),
      title: "",
      redraftCount: 0,
      lastFeedback: null,
      state: { stage: "open", phase: "clarifying-intent" },
    },
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    pendingAcceptance: null,
    parsedChildren: null,
  };
}

// Root split into n children, first child active in recon.
function rootSplit(n: number): PlanTreeState2 {
  return run2(blank2(), [
    { type: "START", treeId: "t5", request: "r", nowMs: 1 },
    { type: "INTENT_CLARIFIED", intent: "i" },
    { type: "NODE_RECON_DONE", path: [] },
    { type: "SIZER_DONE", path: [], outcome: { decision: "split", confidence: 0.9, num_plans: n } },
    { type: "DECOMPOSITION_DRAFTED", path: [], planPath: "/pt/m.md", plansDirPath: "/plans/m.md", toolUseId: "m" },
    {
      type: "CHILDREN_PARSED",
      path: [],
      children: Array.from({ length: n }, (_, i) => ({ nn: nnOf(i + 1), title: `C${i + 1}` })),
    },
    { type: "DECOMPOSITION_APPROVED", path: [] },
  ]);
}

function leafCycle(path: NodePath, tag: string): PlanTreeEvent2[] {
  return [
    { type: "NODE_RECON_DONE", path },
    { type: "SIZER_DONE", path, outcome: { decision: "single", confidence: 0.9, num_plans: 1 } },
    { type: "NODE_DRAFTED", path, toolUseId: `tu-${tag}`, planPath: `/p/${tag}.md`, plansDirPath: `/d/${tag}` },
    { type: "APPROVE", path },
    { type: "EXEC_DONE", path },
    { type: "SUMMARY_WRITTEN", path, summaryText: `summary ${tag}`, summaryPath: fileOf(`/s/${tag}.md`) },
  ];
}

// ---- parseParentReview (pure) ----------------------------------------------------------------------

describe("PHASE 5 — parseParentReview", () => {
  it("parses `ADJUST: <note>` into { note }", () => {
    expect(parseParentReview("review prose\nADJUST: tighten the API surface")).toEqual({
      note: "tighten the API surface",
    });
  });

  it("parses `NONE` into { note: null }", () => {
    expect(parseParentReview("looks good\nNONE")).toEqual({ note: null });
  });

  it("the LAST matching line wins (ADJUST after NONE, and vice versa)", () => {
    // FALSIFY: take the FIRST match instead → both assertions invert → RED.
    expect(parseParentReview("NONE\nactually wait\nADJUST: do X")).toEqual({ note: "do X" });
    expect(parseParentReview("ADJUST: do X\non reflection\nNONE")).toEqual({ note: null });
  });

  it("returns null for unparseable text (no protocol line) and for a bare empty `ADJUST:`", () => {
    expect(parseParentReview("the model rambled and never decided")).toBeNull();
    expect(parseParentReview("ADJUST:")).toBeNull();
    expect(parseParentReview("ADJUST:   ")).toBeNull();
  });
});

// ---- prompt builders: injection block + byte-identical empty-note pins -----------------------------

const MANDATE: Mandate = { title: "Second", sectionBody: "scope two", masterPreamble: "preamble" };

describe("PHASE 5 — adjust-note prompt injection (pure builders)", () => {
  it("subReconPrompt/subDraftPrompt with a null/empty note are BYTE-IDENTICAL to the note-free prompt", () => {
    const recon = subReconPrompt(p(2), MANDATE, ["s1"]);
    // FALSIFY: always emit the labeled block → these equalities go RED.
    expect(subReconPrompt(p(2), MANDATE, ["s1"], null)).toBe(recon);
    expect(subReconPrompt(p(2), MANDATE, ["s1"], "")).toBe(recon);
    expect(subReconPrompt(p(2), MANDATE, ["s1"], "   ")).toBe(recon);
    const draft = subDraftPrompt(p(2), MANDATE, ["s1"]);
    expect(subDraftPrompt(p(2), MANDATE, ["s1"], null)).toBe(draft);
    expect(subDraftPrompt(p(2), MANDATE, ["s1"], "")).toBe(draft);
  });

  it("a non-empty note injects as the labeled block in BOTH builders", () => {
    for (const built of [
      subReconPrompt(p(2), MANDATE, [], "watch the schema"),
      subDraftPrompt(p(2), MANDATE, [], "watch the schema"),
    ]) {
      // FALSIFY: drop the adjustNoteLines spread → RED.
      expect(built).toContain("Adjustment from the parent's review of the previous sibling:");
      expect(built).toContain("watch the schema");
    }
  });

  it("parentReviewPrompt carries the child summary VERBATIM, the remaining mandates (title + body), and the strict protocol", () => {
    const built = parentReviewPrompt(p(1), "## Changes\nTHE-SUMMARY-MARKER", [
      { path: p(2), mandate: MANDATE },
      { path: p(3), mandate: { title: "Third", sectionBody: "scope three", masterPreamble: "" } },
    ]);
    expect(built).toContain("Summary of sub-plan 01 (verbatim):");
    expect(built).toContain("THE-SUMMARY-MARKER");
    expect(built).toContain("### Sub-Plan 02: Second");
    expect(built).toContain("scope two");
    expect(built).toContain("### Sub-Plan 03: Third");
    expect(built).toContain("scope three");
    expect(built).toContain("mandates");
    expect(built).toContain("FROZEN");
    expect(built).toContain("Do NOT call any tool");
    expect(built).toContain("ADJUST: <one short adjustment note for the next sub-plan>");
    expect(built).toContain("NONE");
  });
});

// ---- reducer arcs + coherence (one falsifiable test per rule) --------------------------------------

describe("PHASE 5 — reducer: the reviewing window", () => {
  it("a non-final child's SUMMARY_WRITTEN parks the parent in `reviewing`; the next sibling stays pending (any depth)", () => {
    // Depth 1 (root reviews) …
    const s1 = run2(rootSplit(2), leafCycle(p(1), "01"));
    expect(s1.root.state.phase).toBe("reviewing");
    expect(nodeAtPath(s1.root, p(2))!.state).toEqual({ stage: "open", phase: "pending" });
    expect(activePathOf(s1.root)).toEqual([]);

    // …and depth 2 (the nested parent reviews — the root stays running-children).
    let s2 = run2(rootSplit(2), [...leafCycle(p(1), "01"), { type: "PARENT_REVIEW_DONE", path: [], note: null }]);
    s2 = run2(s2, [
      { type: "NODE_RECON_DONE", path: p(2) },
      { type: "SIZER_DONE", path: p(2), outcome: { decision: "split", confidence: 0.9, num_plans: 2 } },
      { type: "DECOMPOSITION_DRAFTED", path: p(2), planPath: "/pt/02.md", plansDirPath: "/plans/02.md", toolUseId: "d2" },
      { type: "CHILDREN_PARSED", path: p(2), children: [{ nn: nnOf(1), title: "A" }, { nn: nnOf(2), title: "B" }] },
      { type: "DECOMPOSITION_APPROVED", path: p(2) },
      ...leafCycle(p(2, 1), "02.01"),
    ]);
    // FALSIFIED 2026-06-11: reverting advanceAfterSummary to direct sibling activation → both
    // `reviewing` assertions here read running-children/recon → RED. Restored → GREEN.
    expect(nodeAtPath(s2.root, p(2))!.state.phase).toBe("reviewing");
    expect(s2.root.state.phase).toBe("running-children");
    expect(activePathOf(s2.root)).toEqual(p(2));
    // PARENT_REVIEW_DONE at the NESTED level activates 02.02.
    const after = run2(s2, [{ type: "PARENT_REVIEW_DONE", path: p(2), note: "n" }]);
    expect(nodeAtPath(after.root, p(2, 2))!.state).toEqual({ stage: "open", phase: "recon" });
  });

  it("the ROLL-UP window does NOT enter reviewing: the LAST child's summary parks running-children (review is only BETWEEN siblings)", () => {
    let s = run2(rootSplit(2), [...leafCycle(p(1), "01"), { type: "PARENT_REVIEW_DONE", path: [], note: null }]);
    s = run2(s, [
      { type: "NODE_RECON_DONE", path: p(2) },
      { type: "SIZER_DONE", path: p(2), outcome: { decision: "split", confidence: 0.9, num_plans: 1 } },
      { type: "DECOMPOSITION_DRAFTED", path: p(2), planPath: "/pt/02.md", plansDirPath: "/plans/02.md", toolUseId: "d2" },
      { type: "CHILDREN_PARSED", path: p(2), children: [{ nn: nnOf(1), title: "Only" }] },
      { type: "DECOMPOSITION_APPROVED", path: p(2) },
      ...leafCycle(p(2, 1), "02.01"), // the ONLY (= last) child of 02
    ]);
    // FALSIFY: make advanceAfterSummary review after the last child too → phase reads "reviewing"
    // (and the roll-up SUMMARY_WRITTEN below throws) → RED.
    expect(nodeAtPath(s.root, p(2))!.state.phase).toBe("running-children");
    expect(() =>
      reduce2(s, { type: "SUMMARY_WRITTEN", path: p(2), summaryText: "r", summaryPath: fileOf("/r.md") }),
    ).not.toThrow();
  });

  it("reviewing → anything but PARENT_REVIEW_DONE is illegal (SUMMARY_WRITTEN / APPROVE at the reviewing parent throw)", () => {
    const s = run2(rootSplit(2), leafCycle(p(1), "01")); // root reviewing
    expect(() =>
      reduce2(s, { type: "SUMMARY_WRITTEN", path: [], summaryText: "x", summaryPath: fileOf("/x.md") }),
    ).toThrow();
    expect(() => reduce2(s, { type: "APPROVE", path: [] })).toThrow();
    // And events addressing the still-pending sibling throw too (it is not active).
    expect(() => reduce2(s, { type: "NODE_RECON_DONE", path: p(2) })).toThrow();
  });

  it("PARENT_REVIEW_DONE outside reviewing throws (running-children and the roll-up window both reject it)", () => {
    expect(() => reduce2(rootSplit(2), { type: "PARENT_REVIEW_DONE", path: [], note: null })).toThrow(
      /PARENT_REVIEW_DONE/,
    );
  });
});

// Hand-built illegal shapes for the coherence rules the arcs can never reach.
function leafNode(nn: number, phase: "executing" | "summarized" | "drafting"): TreeNode {
  return {
    nn: nnOf(nn),
    title: `c${nn}`,
    redraftCount: 0,
    lastFeedback: null,
    state: { stage: "leaf", phase, planPath: null, summaryPath: null, plansDirPath: null },
  };
}
function pendingNode(nn: number): TreeNode {
  return { nn: nnOf(nn), title: `c${nn}`, redraftCount: 0, lastFeedback: null, state: { stage: "open", phase: "pending" } };
}
function splitNode(phase: "running-children" | "reviewing", children: TreeNode[]): TreeNode {
  return {
    nn: nnOf(1),
    title: "r",
    redraftCount: 0,
    lastFeedback: null,
    state: { stage: "split", phase, children: nonEmpty(children), planPath: "/m", summaryPath: null, plansDirPath: null },
  };
}

describe("PHASE 5 — coherence rules for `reviewing` (one falsifiable test per rule)", () => {
  it("reviewing with an ACTIVE child is incoherent", () => {
    // FALSIFY: drop the activeCount check in assertCoherent2's reviewing rule → no throw → RED.
    const bad = splitNode("reviewing", [leafNode(1, "summarized"), leafNode(2, "drafting")]);
    expect(() => assertCoherent2(bad)).toThrow(/reviewing while a child is active/);
  });

  it("reviewing BEFORE the first child (no summarized) or AFTER the last (no pending) is incoherent", () => {
    const before = splitNode("reviewing", [pendingNode(1), pendingNode(2)]);
    expect(() => assertCoherent2(before)).toThrow(/outside the between-children window/);
    const after = splitNode("reviewing", [leafNode(1, "summarized"), leafNode(2, "summarized")]);
    expect(() => assertCoherent2(after)).toThrow(/outside the between-children window/);
  });

  it("no leaf may EXECUTE under a reviewing ancestor (the rule has a reachable arc now)", () => {
    // The nested-reviewing arc is REACHABLE since this phase (a nested parent reviews while the
    // root runs children) — this hand-built shape proves the dedicated first-pass rule still
    // rejects an executing leaf below it. FALSIFY: drop assertNoExecutingUnderReviewing → the
    // partition error masks it / no throw → RED.
    const nested = splitNode("reviewing", [leafNode(1, "summarized"), pendingNode(2)]);
    const executingUnder: TreeNode = {
      ...nested,
      state: {
        ...(nested.state as Extract<TreeNode["state"], { stage: "split" }>),
        children: nonEmpty([leafNode(1, "executing"), pendingNode(2)]),
      },
    };
    expect(() => assertCoherent2(executingUnder)).toThrow(/executing under a reviewing ancestor/);
  });
});

// ---- the scripted driver suites --------------------------------------------------------------------

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
  resolves: Array<{ id: string; allow: boolean; message?: string }>;
  writes: Array<{ name: string; contents: string }>;
  timers: FakeTimer[];
  liveTimers: () => FakeTimer[];
}

function makeDeps(): Rec {
  const sends: string[] = [];
  const resolves: Array<{ id: string; allow: boolean; message?: string }> = [];
  const writes: Array<{ name: string; contents: string }> = [];
  const timers: FakeTimer[] = [];
  const deps: OrchestratorDeps = {
    startSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async (t: string) => void sends.push(t)),
    setMode: vi.fn(async () => {}),
    resolvePermission: vi.fn(async (a: { id: string; allow: boolean; message?: string }) =>
      void resolves.push({ id: a.id, allow: a.allow, message: a.message }),
    ),
    cancelRun: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    writePlanTreeFile: vi.fn(async (_c, name, contents) => {
      writes.push({ name, contents });
      return `/abs/.plan-tree/${name}`;
    }),
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
  return { deps, sends, resolves, writes, timers, liveTimers: () => timers.filter((t) => !t.cleared) };
}

// Drive a fresh handle to a held root decomposition gate splitting into `headers`.
async function driveToRootGate(h: OrchestratorHandle, headers: string): Promise<void> {
  await h.start({ cwd: "/work", request: "phase-5 request" });
  await h.ingestStream(textFrame("the intent"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("root recon"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("SIZER: split / 3 / 0.9"));
  await h.ingestStream(resultFrame());
  await h.ingestPermission(exitPlanModeReq("root-tu", headers));
}

const THREE_WAY =
  "# Preamble\n\n### Sub-Plan 01: First\nscope one\n\n### Sub-Plan 02: Second\nscope two\n\n### Sub-Plan 03: Third\nscope three\n";

// One full leaf cycle at `key` through live frames (recon already prompted), WITHOUT the trailing
// review turn (callers drive that explicitly — it is the subject under test here).
async function runLeaf(h: OrchestratorHandle, key: string, marker: string): Promise<void> {
  await h.ingestStream(textFrame(`${key} recon`));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
  await h.ingestStream(resultFrame());
  await h.ingestPermission(exitPlanModeReq(`leaf-${key}-tu`, `${key} plan body`));
  await h.approve(key);
  await h.ingestStream(resultFrame()); // exec completion → summary prompt
  await h.ingestStream(textFrame(`## Changes\n${marker}\n## Findings\nf\n## Next-step inputs\nn`));
  await h.ingestStream(resultFrame()); // summary result → write + review/ascent hop
}

const NOTE = "ADJUSTMENT-NOTE-MARKER use the helper from sub-01";

describe("PHASE 5 — scripted depth-1: the review turn between siblings + the single-note lifecycle", () => {
  it("review after 01 → ADJUST lands in 02's BOTH prompts; NONE after 02 → 03's prompts are CLEAN (clear point + no leak)", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await driveToRootGate(h, THREE_WAY);
    await h.approve("");
    await h.ingestStream(resultFrame()); // boundary result → 01 recon

    await runLeaf(h, "01", "SUMMARY-01-MARKER");

    // The review prompt fired (the root reviews 01 against the remaining 02+03 mandates).
    const review1 = rec.sends.at(-1)!;
    expect(review1).toContain("Sub-plan 01 has completed");
    expect(review1).toContain("SUMMARY-01-MARKER"); // the child summary rides the prompt verbatim
    expect(review1).toContain("### Sub-Plan 02: Second");
    expect(review1).toContain("### Sub-Plan 03: Third"); // ALL remaining siblings' mandates

    // The review answers ADJUST → the note lands in 02's RECON prompt…
    await h.ingestStream(textFrame(`reviewed.\nADJUST: ${NOTE}`));
    await h.ingestStream(resultFrame());
    const recon02 = rec.sends.at(-1)!;
    expect(recon02).toContain("sub-plan 02");
    // FALSIFIED 2026-06-11 (injection): dropped the adjustNoteFor() arg at the recon/draft send
    // sites → both note assertions went RED (prompts byte-identical to note-free). Restored → GREEN.
    expect(recon02).toContain("Adjustment from the parent's review of the previous sibling:");
    expect(recon02).toContain(NOTE);

    // …AND in 02's DRAFT prompt (both prompts — the note's full scope).
    await h.ingestStream(textFrame("02 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    const draft02 = rec.sends.at(-1)!;
    expect(draft02).toContain("Draft the implementation plan for sub-plan 02");
    expect(draft02).toContain(NOTE);

    // Finish 02 (its NODE_DRAFTED dispatch is the CLEAR POINT), then answer the second review NONE.
    await h.ingestPermission(exitPlanModeReq("leaf-02-tu", "02 plan body"));
    await h.approve("02");
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("## Changes\nSUMMARY-02-MARKER\n## Findings\nf\n## Next-step inputs\nn"));
    await h.ingestStream(resultFrame());
    const review2 = rec.sends.at(-1)!;
    expect(review2).toContain("Sub-plan 02 has completed");
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());

    // 03's prompts are CLEAN: the 01-review note must not leak past its one-sibling scope.
    // FALSIFIED 2026-06-11 (clear point): removed clearAdjustNoteOnDraft AND made the NONE branch
    // keep the prior slot (only overwrite on ADJUST) → the note LEAKED into 03's recon prompt →
    // RED here. Restored → GREEN.
    const recon03 = rec.sends.at(-1)!;
    expect(recon03).toContain("sub-plan 03");
    expect(recon03).not.toContain(NOTE);
    expect(recon03).not.toContain("Adjustment from the parent's review");
    await h.ingestStream(textFrame("03 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    const draft03 = rec.sends.at(-1)!;
    expect(draft03).toContain("sub-plan 03");
    expect(draft03).not.toContain(NOTE);

    await h.cancel();
  });

  it("NONE injects NOTHING: the next child's recon prompt is BYTE-IDENTICAL to the note-free builder output", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await driveToRootGate(h, THREE_WAY);
    await h.approve("");
    await h.ingestStream(resultFrame());
    await runLeaf(h, "01", "SUMMARY-01-MARKER");
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());

    // BYTE-IDENTICAL pin: the sent prompt equals the pure builder's note-free output exactly.
    // FALSIFY: inject an empty labeled block on NONE → byte equality breaks → RED.
    const expected = subReconPrompt(
      p(2),
      { title: "Second", sectionBody: "scope two", masterPreamble: "# Preamble" },
      [`## Changes\nSUMMARY-01-MARKER\n## Findings\nf\n## Next-step inputs\nn`],
    );
    expect(rec.sends.at(-1)).toBe(expected);

    await h.cancel();
  });

  it("an UNPARSEABLE review coerces to NONE with a LOUD diag — the run advances, nothing injected", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await driveToRootGate(h, THREE_WAY);
    await h.approve("");
    await h.ingestStream(resultFrame());
    await runLeaf(h, "01", "SUMMARY-01-MARKER");
    vi.mocked(diag).mockClear();
    await h.ingestStream(textFrame("the model rambled with no protocol line at all"));
    await h.ingestStream(resultFrame());

    // LOUD diag pinned. FALSIFY: drop the diag call in the coerce branch → RED.
    expect(vi.mocked(diag).mock.calls.some(([m]) => m.includes("COERCING to NONE"))).toBe(true);
    // The run advanced to 02's recon, note-free — never fatal.
    expect(h.orchestrationActive()).toBe(true);
    const recon02 = rec.sends.at(-1)!;
    expect(recon02).toContain("sub-plan 02");
    expect(recon02).not.toContain("Adjustment from the parent's review");

    await h.cancel();
  });
});

describe("PHASE 5 — scripted depth-2: the review happens at the NESTED level", () => {
  it("02.01 → review BY 02 → ADJUST note lands in 02.02's prompts (and nowhere else)", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    // Root splits 2: [01 leaf, 02 split[02.01, 02.02]].
    await h.start({ cwd: "/work", request: "deep request" });
    await h.ingestStream(textFrame("intent"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("root recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("root-tu", "### Sub-Plan 01: First\nscope one\n\n### Sub-Plan 02: Second\nscope two\n"),
    );
    await h.approve("");
    await h.ingestStream(resultFrame());
    await runLeaf(h, "01", "SUMMARY-01-MARKER");
    await h.ingestStream(textFrame("NONE")); // root review of 01: no note
    await h.ingestStream(resultFrame());
    // 02 splits into 02.01 / 02.02.
    await h.ingestStream(textFrame("02 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.85"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("decomp-02-tu", "### Sub-Plan 01: SubA\nnested scope A\n\n### Sub-Plan 02: SubB\nnested scope B\n"),
    );
    await h.approve("02");
    await h.ingestStream(resultFrame()); // boundary → 02.01 recon
    await runLeaf(h, "02.01", "SUMMARY-0201-MARKER");

    // The NESTED review: 02 reviews 02.01 against 02.02's mandate.
    const nestedReview = rec.sends.at(-1)!;
    expect(nestedReview).toContain("Sub-plan 02.01 has completed");
    expect(nestedReview).toContain("SUMMARY-0201-MARKER");
    expect(nestedReview).toContain("### Sub-Plan 02.02: SubB");
    await h.ingestStream(textFrame(`ADJUST: ${NOTE}`));
    await h.ingestStream(resultFrame());

    // The note lands in 02.02's recon AND draft prompts.
    const recon0202 = rec.sends.at(-1)!;
    expect(recon0202).toContain("sub-plan 02.02");
    expect(recon0202).toContain(NOTE);
    await h.ingestStream(textFrame("02.02 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    const draft0202 = rec.sends.at(-1)!;
    expect(draft0202).toContain("sub-plan 02.02");
    expect(draft0202).toContain(NOTE);

    await h.cancel();
  });
});

describe("PHASE 5 — last-child skip (no review after the final sibling)", () => {
  it("the LAST child's summary goes straight to done — no review prompt anywhere after it", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await h.start({ cwd: "/work", request: "two-way" });
    await h.ingestStream(textFrame("intent"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("root-tu", "### Sub-Plan 01: First\nx\n\n### Sub-Plan 02: Second\ny\n"),
    );
    await h.approve("");
    await h.ingestStream(resultFrame());
    await runLeaf(h, "01", "S1");
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());
    const reviewSendsBefore = rec.sends.filter((s) => s.includes("has completed; its summary is below")).length;
    expect(reviewSendsBefore).toBe(1); // exactly the one between-siblings review
    await runLeaf(h, "02", "S2"); // the LAST child

    // FALSIFY (skip-after-last): force advanceAfterSummary to enter reviewing after the last child
    // → the reducer throws (reviewing with no pending child) / a second review prompt appears → RED.
    const reviewSendsAfter = rec.sends.filter((s) => s.includes("has completed; its summary is below")).length;
    expect(reviewSendsAfter).toBe(1);
    expect(h.snapshot().done).toBe(true);
  });
});

// ---- DA P4 follow-up: the generalized turn watchdog -------------------------------------------------

describe("PHASE 5 — turn watchdog for the summary and parent-review variants", () => {
  it("a parent-review turn that NEVER emits its result drives a loud watchdog FATAL", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    const fatals: string[] = [];
    h.subscribe({ onFatal: (m) => fatals.push(m) });
    await driveToRootGate(h, THREE_WAY);
    await h.approve("");
    await h.ingestStream(resultFrame());
    await runLeaf(h, "01", "S1"); // → the review turn is in flight, its watchdog armed

    const live = rec.liveTimers();
    // FALSIFIED 2026-06-11: dropped the armTurnWatchdog("parent-review", …) call → no live timer
    // here (length 0) → RED (and the live run would hang silently forever). Restored → GREEN.
    expect(live).toHaveLength(1);
    expect(live[0].ms).toBe(120_000);
    live[0].fn(); // the review result never arrives — fire the watchdog
    for (let i = 0; i < 16; i++) await Promise.resolve(); // drain the serialized ingest queue
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toContain("turn watchdog");
    expect(fatals[0]).toContain("parent-review");
    expect(h.orchestrationActive()).toBe(false);
  });

  it("a summary turn that NEVER emits its result drives a loud watchdog FATAL", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    const fatals: string[] = [];
    h.subscribe({ onFatal: (m) => fatals.push(m) });
    await driveToRootGate(h, THREE_WAY);
    await h.approve("");
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("01 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("leaf-01-tu", "01 plan"));
    await h.approve("01");
    await h.ingestStream(resultFrame()); // exec completion → summary prompt + summary watchdog

    const live = rec.liveTimers();
    // FALSIFIED 2026-06-11: dropped the armTurnWatchdog("summary", …) call at the exec branch →
    // zero live timers here → RED. Restored → GREEN.
    expect(live).toHaveLength(1);
    expect(live[0].ms).toBe(120_000);
    live[0].fn();
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toContain("turn watchdog");
    expect(fatals[0]).toContain("summary");
    expect(h.orchestrationActive()).toBe(false);
  });

  it("watchdogs are CLEARED on every exit path: consumed result, Stop, and FATAL", async () => {
    // Consumed result: the review turn ends normally → its timer is cleared (no late false FATAL).
    const a = makeDeps();
    const ha = createOrchestrator(a.deps);
    await driveToRootGate(ha, THREE_WAY);
    await ha.approve("");
    await ha.ingestStream(resultFrame());
    await runLeaf(ha, "01", "S1");
    expect(a.liveTimers()).toHaveLength(1);
    await ha.ingestStream(textFrame("NONE"));
    await ha.ingestStream(resultFrame());
    expect(a.liveTimers()).toHaveLength(0);
    await ha.cancel();

    // Stop: cancel() clears a live review watchdog.
    const b = makeDeps();
    const hb = createOrchestrator(b.deps);
    await driveToRootGate(hb, THREE_WAY);
    await hb.approve("");
    await hb.ingestStream(resultFrame());
    await runLeaf(hb, "01", "S1");
    expect(b.liveTimers()).toHaveLength(1);
    await hb.cancel();
    expect(b.liveTimers()).toHaveLength(0);

    // FATAL: a fatal during the review window clears the watchdog too.
    const c = makeDeps();
    const hc = createOrchestrator(c.deps);
    await driveToRootGate(hc, THREE_WAY);
    await hc.approve("");
    await hc.ingestStream(resultFrame());
    await runLeaf(hc, "01", "S1");
    expect(c.liveTimers()).toHaveLength(1);
    await hc.dispatch({ type: "FATAL", message: "boom" });
    expect(c.liveTimers()).toHaveLength(0);
  });
});

// ---- DA P4 follow-up: rogue ExitPlanMode deny ------------------------------------------------------

describe("PHASE 5 — rogue ExitPlanMode is DENIED (never silently stranded)", () => {
  it("during the REVIEWING window: denied with the review message; the run continues", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    await driveToRootGate(h, THREE_WAY);
    await h.approve("");
    await h.ingestStream(resultFrame());
    await runLeaf(h, "01", "S1"); // the review turn is in flight (root reviewing)

    await h.ingestPermission(exitPlanModeReq("rogue-review-tu", "a rogue plan"));
    // FALSIFIED 2026-06-11: restored the silent `return` for the review window → no resolution
    // recorded (the permission stranded) → RED. Restored the deny → GREEN.
    expect(rec.resolves.at(-1)).toEqual({
      id: "rogue-review-tu",
      allow: false,
      message: "this turn must not call ExitPlanMode — finish the review text",
    });
    expect(h.orchestrationActive()).toBe(true);
    // The run still advances normally: the review result lands and 02's recon fires.
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());
    expect(rec.sends.at(-1)).toContain("sub-plan 02");

    await h.cancel();
  });

  it("during the ROLL-UP window (roll-up summary turn): denied with the summary message; the run continues", async () => {
    const rec = makeDeps();
    const h = createOrchestrator(rec.deps);
    // Root [01 split[01.01]]: 01.01 is the only grandchild; its summary parks 01 in the roll-up
    // window with the roll-up summary turn in flight.
    await h.start({ cwd: "/work", request: "rollup case" });
    await h.ingestStream(textFrame("intent"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("root-tu", "### Sub-Plan 01: Only\nscope\n"));
    await h.approve("");
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("01 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 1 / 0.9")); // 01 itself splits
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("decomp-01-tu", "### Sub-Plan 01: Grand\ngscope\n"));
    await h.approve("01");
    await h.ingestStream(resultFrame());
    await runLeaf(h, "01.01", "S-GRAND"); // only child → 01's ROLL-UP summary turn in flight
    expect(rec.sends.at(-1)).toContain("All child sub-plans of sub-plan 01 have finished");

    await h.ingestPermission(exitPlanModeReq("rogue-rollup-tu", "a rogue plan"));
    // FALSIFY: restore the silent return (or the old NODE_DRAFTED throw-path) for the roll-up
    // window → no deny recorded / the run FATALs → RED.
    expect(rec.resolves.at(-1)).toEqual({
      id: "rogue-rollup-tu",
      allow: false,
      message: "this turn must not call ExitPlanMode — finish the summary text",
    });
    expect(h.orchestrationActive()).toBe(true);
    // The roll-up still completes (01 is the last root child → done).
    await h.ingestStream(textFrame("## Changes\nROLLUP\n## Findings\nf\n## Next-step inputs\nn"));
    await h.ingestStream(resultFrame());
    expect(h.snapshot().done).toBe(true);
  });
});
