// PHASE 4 — reducer arcs for depth > 1 (per-node sizer, nested gates, completion ascent, roll-up).
//
// Every test drives the REAL reduce2 through event sequences (no hand-built trees except where a
// test must construct an ILLEGAL resting shape to prove coherence rejects it). Falsifiability:
// each rule names the inversion that turns it red; the load-bearing ones were executed during
// development (evidence in the comments).

import { describe, it, expect } from "vitest";
import {
  reduce2,
  parseNn,
  pathKey,
  nodeAtPath,
  activePathOf,
  writePolicyFor2,
  assertCoherent2,
  treeIsDone,
  summaryName2,
  planName2,
  isRootCollapseChild,
  inRollupWindow,
} from "./plan-tree";
import type {
  PlanTreeState2,
  PlanTreeEvent2,
  Effect2,
  NodePath,
  TreeNode,
  SizerOutcome,
  PlanTreeFilePath,
  NonEmptyArray,
} from "./plan-tree";

// ---- fixtures -----------------------------------------------------------------------------------

const nnOf = (n: number) => parseNn(n);
const p = (...ns: number[]): NodePath => ns.map(nnOf);
const fileOf = (s: string) => s as PlanTreeFilePath;

function sizer(decision: SizerOutcome["decision"], num_plans: number, confidence = 0.9): SizerOutcome {
  return { decision, confidence, num_plans };
}

function blank2(): PlanTreeState2 {
  return {
    schema: 2,
    tree_id: "",
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

function run2(
  state: PlanTreeState2,
  events: PlanTreeEvent2[],
  coherentEveryStep = true,
): { state: PlanTreeState2; effects: Effect2[] } {
  let cur = state;
  const all: Effect2[] = [];
  for (const ev of events) {
    const out = reduce2(cur, ev);
    cur = out.state;
    all.push(...out.effects);
    if (coherentEveryStep) assertCoherent2(cur.root);
  }
  return { state: cur, effects: all };
}

// The shared event sequences (real arcs, no hand-built trees).
function genesis(): PlanTreeState2 {
  return run2(blank2(), [
    { type: "START", treeId: "t-depth", request: "deep thing", nowMs: 1 },
    { type: "INTENT_CLARIFIED", intent: "the intent" },
  ]).state;
}

// Root split into `titles.length` children; first child active in recon.
function rootSplit(titles: string[]): PlanTreeState2 {
  return run2(genesis(), [
    { type: "NODE_RECON_DONE", path: [] },
    { type: "SIZER_DONE", path: [], outcome: sizer("split", titles.length) },
    { type: "DECOMPOSITION_DRAFTED", path: [], planPath: "/pt/master.md", plansDirPath: "/plans/master.md", toolUseId: "m" },
    { type: "CHILDREN_PARSED", path: [], children: titles.map((t, i) => ({ nn: nnOf(i + 1), title: t })) },
    { type: "DECOMPOSITION_APPROVED", path: [] },
  ]).state;
}

// One full LEAF cycle at `path` (recon → sizer single → draft → approve → exec → summary).
function leafCycle(path: NodePath, tag: string): PlanTreeEvent2[] {
  return [
    { type: "NODE_RECON_DONE", path },
    { type: "SIZER_DONE", path, outcome: sizer("single", 1) },
    { type: "NODE_DRAFTED", path, toolUseId: `tu-${tag}`, planPath: `/p/${tag}.md`, plansDirPath: `/d/${tag}` },
    { type: "APPROVE", path },
    { type: "EXEC_DONE", path },
    { type: "SUMMARY_WRITTEN", path, summaryText: `summary ${tag}`, summaryPath: fileOf(`/s/${tag}.md`) },
  ];
}

// Nested split at `path` into `n` grandchildren (recon → sizer split → drafted → parsed → approved).
function nestedSplit(path: NodePath, n: number, tag: string): PlanTreeEvent2[] {
  return [
    { type: "NODE_RECON_DONE", path },
    { type: "SIZER_DONE", path, outcome: sizer("split", n) },
    { type: "DECOMPOSITION_DRAFTED", path, planPath: `/pt/${tag}-plan.md`, plansDirPath: `/plans/${tag}.md`, toolUseId: `tu-${tag}` },
    { type: "CHILDREN_PARSED", path, children: Array.from({ length: n }, (_, i) => ({ nn: nnOf(i + 1), title: `${tag}.${i + 1}` })) },
    { type: "DECOMPOSITION_APPROVED", path },
  ];
}

// PHASE 5 — the parent-review hop between siblings: a non-final child's summary parks the parent
// in `reviewing`; this event (the only exit) activates the next pending sibling.
function review(parentPath: NodePath, note: string | null = null): PlanTreeEvent2 {
  return { type: "PARENT_REVIEW_DONE", path: parentPath, note };
}

const nodeAt = (s: PlanTreeState2, path: NodePath): TreeNode => {
  const n = nodeAtPath(s.root, path);
  if (!n) throw new Error(`fixture: no node at "${pathKey(path)}"`);
  return n;
};

// ---- the depth-2 descent/ascent reducer trace (the reducer half of the centerpiece) -------------

describe("PHASE 4 — depth-2 descent/ascent through the reducer", () => {
  it("root [01 leaf, 02 split[02.01, 02.02]] descends, rolls up 02, and completes — coherent at EVERY reduce", () => {
    let s = rootSplit(["First", "Second"]);

    // 01: full leaf cycle → PHASE 5: the root REVIEWS before 02 activates (per-level ascent).
    s = run2(s, leafCycle(p(1), "01")).state;
    expect(s.root.state.phase).toBe("reviewing");
    expect(nodeAt(s, p(2)).state).toEqual({ stage: "open", phase: "pending" });
    s = run2(s, [review([])]).state;
    expect(nodeAt(s, p(2)).state).toEqual({ stage: "open", phase: "recon" });

    // 02 splits into 02.01/02.02; first grandchild active in recon; ancestors stay running-children.
    s = run2(s, nestedSplit(p(2), 2, "02")).state;
    expect(nodeAt(s, p(2)).state.stage).toBe("split");
    expect(nodeAt(s, p(2)).state.phase).toBe("running-children");
    expect(s.root.state.phase).toBe("running-children");
    expect(nodeAt(s, p(2, 1)).state).toEqual({ stage: "open", phase: "recon" });
    expect(activePathOf(s.root)).toEqual(p(2, 1));

    // 02.01 leaf cycle → PHASE 5: the NESTED parent (02) reviews before 02.02 activates.
    s = run2(s, leafCycle(p(2, 1), "02.01")).state;
    expect(nodeAt(s, p(2)).state.phase).toBe("reviewing");
    expect(activePathOf(s.root)).toEqual(p(2)); // the reviewing parent IS the active node
    s = run2(s, [review(p(2))]).state;
    expect(nodeAt(s, p(2, 2)).state).toEqual({ stage: "open", phase: "recon" });

    // 02.02 (LAST grandchild) leaf cycle → 02 enters its ROLL-UP WINDOW: running-children with all
    // children summarized, NO notifyDone yet, and 02 ITSELF is the active node (the roll-up turn).
    // FALSIFIED 2026-06-11: completing 02 to summarized directly at the last grandchild's summary
    // (skipping the window) turns the running-children + activePathOf assertions RED.
    const lastLeaf = run2(s, leafCycle(p(2, 2), "02.02"));
    s = lastLeaf.state;
    expect(nodeAt(s, p(2)).state.phase).toBe("running-children");
    expect(inRollupWindow(nodeAt(s, p(2)))).toBe(true);
    expect(activePathOf(s.root)).toEqual(p(2));
    expect(treeIsDone(s.root)).toBe(false);
    expect(lastLeaf.effects.some((e) => e.kind === "notifyDone")).toBe(false);

    // The ROLL-UP SUMMARY_WRITTEN for 02 completes it (split/summarized + summaryPath recorded) and
    // — 02 being the root's LAST child — completes the ROOT (notifyDone; done derived).
    const rollup = reduce2(s, {
      type: "SUMMARY_WRITTEN",
      path: p(2),
      summaryText: "roll-up of 02",
      summaryPath: fileOf("/s/02.md"),
    });
    s = rollup.state;
    assertCoherent2(s.root);
    const two = nodeAt(s, p(2));
    expect(two.state.stage).toBe("split");
    expect(two.state.phase).toBe("summarized");
    if (two.state.stage === "split") expect(two.state.summaryPath).toBe("/s/02.md");
    expect(treeIsDone(s.root)).toBe(true);
    expect(rollup.effects.map((e) => e.kind)).toEqual(["notifySummaryWritten", "notifyDone", "persist"]);
  });

  it("a roll-up under a NON-last parent ascends to the parent's NEXT SIBLING, not to done", () => {
    // root [01 split[01.01], 02]: 01's roll-up must activate 02 — and NOT complete the root.
    let s = rootSplit(["First", "Second"]);
    s = run2(s, nestedSplit(p(1), 1, "01")).state;
    s = run2(s, leafCycle(p(1, 1), "01.01")).state;
    expect(activePathOf(s.root)).toEqual(p(1)); // 01's roll-up window
    const out = run2(s, [
      { type: "SUMMARY_WRITTEN", path: p(1), summaryText: "roll-up 01", summaryPath: fileOf("/s/01.md") },
    ]);
    s = out.state;
    // FALSIFY: route the parent roll-up through the root-completion branch → notifyDone fires here
    // and 02 stays pending → RED on both assertions. PHASE 5: a ROLL-UP summary with a remaining
    // sibling parks the GRANDparent (here: the root) in reviewing exactly like a leaf summary does.
    expect(out.effects.some((e) => e.kind === "notifyDone")).toBe(false);
    expect(s.root.state.phase).toBe("reviewing");
    s = run2(s, [review([])]).state;
    expect(nodeAt(s, p(2)).state).toEqual({ stage: "open", phase: "recon" });
    expect(treeIsDone(s.root)).toBe(false);
  });

  it("depth-3: a grandchild split's roll-up ascends into the GRANDPARENT's roll-up window", () => {
    // root [01 split[01.01 split[01.01.01]]]: completing 01.01.01 parks 01.01; 01.01's roll-up
    // parks 01; 01's roll-up completes the root. The ascent is one hop per SUMMARY_WRITTEN.
    let s = rootSplit(["Only"]);
    s = run2(s, nestedSplit(p(1), 1, "01")).state;
    s = run2(s, nestedSplit(p(1, 1), 1, "01.01")).state;
    s = run2(s, leafCycle(p(1, 1, 1), "01.01.01")).state;
    expect(activePathOf(s.root)).toEqual(p(1, 1)); // deepest roll-up window first
    s = run2(s, [
      { type: "SUMMARY_WRITTEN", path: p(1, 1), summaryText: "r-01.01", summaryPath: fileOf("/s/0101.md") },
    ]).state;
    expect(activePathOf(s.root)).toEqual(p(1)); // grandparent's window next
    expect(inRollupWindow(nodeAt(s, p(1)))).toBe(true);
    const done = run2(s, [
      { type: "SUMMARY_WRITTEN", path: p(1), summaryText: "r-01", summaryPath: fileOf("/s/01.md") },
    ]);
    expect(treeIsDone(done.state.root)).toBe(true);
    expect(done.effects.some((e) => e.kind === "notifyDone")).toBe(true);
  });

  it("writePolicyFor2 flips to acceptEdits ONLY while a leaf executes — at depth 2 too", () => {
    let s = rootSplit(["First", "Second"]);
    s = run2(s, [...leafCycle(p(1), "01"), review([])]).state;
    s = run2(s, nestedSplit(p(2), 2, "02")).state;
    s = run2(s, [
      { type: "NODE_RECON_DONE", path: p(2, 1) },
      { type: "SIZER_DONE", path: p(2, 1), outcome: sizer("single", 1) },
      { type: "NODE_DRAFTED", path: p(2, 1), toolUseId: "t", planPath: "/p", plansDirPath: "/d" },
    ]).state;
    expect(writePolicyFor2(s.root)).toBe("plan");
    s = reduce2(s, { type: "APPROVE", path: p(2, 1) }).state;
    expect(writePolicyFor2(s.root)).toBe("acceptEdits"); // the deep executing leaf is the witness
    s = reduce2(s, {
      type: "SUMMARY_WRITTEN", path: p(2, 1), summaryText: "s", summaryPath: fileOf("/s.md"),
    }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // back to plan the moment the leaf summarizes
  });
});

// ---- nested gate arcs ----------------------------------------------------------------------------

describe("PHASE 4 — nested decomposition gate arcs", () => {
  // root [01 done, 02 awaiting its nested decomposition approval] with grandchildren stashed.
  function toNestedGate(): PlanTreeState2 {
    let s = rootSplit(["First", "Second"]);
    s = run2(s, [...leafCycle(p(1), "01"), review([])]).state;
    return run2(s, nestedSplit(p(2), 2, "02").slice(0, 4)).state; // stop before APPROVED
  }

  it("nested DECOMPOSITION_DRAFTED holds the unified gate at the nested path (kind decomposition)", () => {
    const s = toNestedGate();
    expect(nodeAt(s, p(2)).state).toEqual({ stage: "open", phase: "awaiting-decomposition-approval" });
    expect(s.pendingApproval).toMatchObject({ path: p(2), kind: "decomposition", toolUseId: "tu-02" });
    expect(s.parsedChildren?.children).toHaveLength(2);
    expect(pathKey(s.parsedChildren!.path)).toBe("02");
  });

  it("nested DECOMPOSITION_CHANGES_REQUESTED redrafts IN PLACE: back to decomposing, redraftCount++, stash discarded, siblings untouched", () => {
    const s = toNestedGate();
    const oneBefore = nodeAt(s, p(1));
    const out = reduce2(s, { type: "DECOMPOSITION_CHANGES_REQUESTED", path: p(2), feedback: "re-split" });
    assertCoherent2(out.state.root);
    // FALSIFY: advance to running-children on a nested changes-request → RED.
    expect(nodeAt(out.state, p(2)).state).toEqual({ stage: "open", phase: "decomposing" });
    expect(nodeAt(out.state, p(2)).redraftCount).toBe(1);
    expect(nodeAt(out.state, p(2)).lastFeedback).toBe("re-split");
    expect(out.state.parsedChildren).toBeNull();
    expect(out.state.pendingApproval).toBeNull();
    expect(out.effects).toContainEqual({ kind: "resolvePermission", id: "tu-02", allow: false, message: "re-split" });
    expect(nodeAt(out.state, p(1))).toEqual(oneBefore); // the completed sibling is untouched
  });

  it("nested DECOMPOSITION_APPROVED materializes the split with the FIRST grandchild in recon; the artifact paths land on 02", () => {
    const s = toNestedGate();
    const out = reduce2(s, { type: "DECOMPOSITION_APPROVED", path: p(2) });
    assertCoherent2(out.state.root);
    const two = nodeAt(out.state, p(2));
    expect(two.state.stage).toBe("split");
    if (two.state.stage === "split") {
      expect(two.state.phase).toBe("running-children");
      expect(two.state.planPath).toBe("/pt/02-plan.md");
      expect(two.state.plansDirPath).toBe("/plans/02.md");
      expect(two.state.children).toHaveLength(2);
    }
    expect(nodeAt(out.state, p(2, 1)).state).toEqual({ stage: "open", phase: "recon" });
    expect(nodeAt(out.state, p(2, 2)).state).toEqual({ stage: "open", phase: "pending" });
    expect(out.state.root.state.phase).toBe("running-children"); // the ancestor is untouched
    expect(out.effects).toContainEqual({ kind: "resolvePermission", id: "tu-02", allow: true });
  });
});

// ---- per-node sizer at non-root: the collapse-child exception -----------------------------------

describe("PHASE 4 — per-node sizer vs the root-collapse child", () => {
  it("isRootCollapseChild is true ONLY for the sole child of a planPath-less root split", () => {
    // The collapse path: root confident single.
    const collapsed = run2(genesis(), [
      { type: "NODE_RECON_DONE", path: [] },
      { type: "SIZER_DONE", path: [], outcome: sizer("single", 1, 0.95) },
    ]).state;
    expect(isRootCollapseChild(collapsed.root, p(1))).toBe(true);
    // A REAL decomposition's child is NOT a collapse child (the split carries its planPath).
    const split = rootSplit(["A", "B"]);
    expect(isRootCollapseChild(split.root, p(1))).toBe(false);
  });

  it("the collapse child SKIPS the sizer (recon → leaf/drafting); a decomposition child does NOT (recon → sizing)", () => {
    const collapsed = run2(genesis(), [
      { type: "NODE_RECON_DONE", path: [] },
      { type: "SIZER_DONE", path: [], outcome: sizer("single", 1, 0.95) },
      { type: "NODE_RECON_DONE", path: p(1) },
    ]).state;
    // FALSIFIED 2026-06-11: routed the collapse child to open/sizing like everyone → RED here AND
    // golden Scenario A went red at the wire (the unchanged Scenario-A trace IS the collapse-skip
    // pin); restored → GREEN.
    expect(nodeAt(collapsed, p(1)).state.stage).toBe("leaf");
    expect(nodeAt(collapsed, p(1)).state.phase).toBe("drafting");

    const split = run2(rootSplit(["A", "B"]), [{ type: "NODE_RECON_DONE", path: p(1) }]).state;
    expect(nodeAt(split, p(1)).state).toEqual({ stage: "open", phase: "sizing" });
  });

  it("a non-root LOW-confidence single decomposes (coerced split — same 0.6 threshold as the root)", () => {
    let s = rootSplit(["A", "B"]);
    s = reduce2(s, { type: "NODE_RECON_DONE", path: p(1) }).state;
    const out = reduce2(s, { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.5) });
    expect(nodeAt(out.state, p(1)).state).toEqual({ stage: "open", phase: "decomposing" });
  });
});

// ---- roll-up window: coherence + active-path + SUMMARY_WRITTEN legality --------------------------

describe("PHASE 4 — roll-up window rules (one falsifiable test per new rule)", () => {
  // A REAL roll-up window reached through the arcs.
  function inWindow(): PlanTreeState2 {
    let s = rootSplit(["First", "Second"]);
    s = run2(s, nestedSplit(p(1), 1, "01")).state;
    return run2(s, leafCycle(p(1, 1), "01.01")).state;
  }

  it("COHERENCE: a NON-ROOT split may rest running-children with ALL children summarized", () => {
    const s = inWindow();
    // FALSIFIED 2026-06-11: removing the roll-up-window allowance from assertCoherent2 (restoring
    // the unconditional exactly-1-active rule) makes this reduce sequence THROW inside reduce2
    // ("running-children with 0 active children") → RED. Restored → GREEN.
    expect(() => assertCoherent2(s.root)).not.toThrow();
    expect(inRollupWindow(nodeAt(s, p(1)))).toBe(true);
  });

  it("PHASE 5: the ROOT MAY rest in that shape — it is the forced-ACCEPTANCE WINDOW (run built, awaiting a baseline verdict)", () => {
    // PIN CHANGE (Phase 5 — forced acceptance gate): the root all-summarized running-children shape
    // was previously a loud incoherence (a missed completion). It is now LEGAL — the acceptance
    // window the reducer parks the root in (instead of finalizing) when a baseline exists, awaiting
    // the user's ACCEPTANCE_APPROVED/DIVERGED verdict. treeIsDone stays FALSE in this shape (phase
    // is running-children, not summarized), so a baseline-bearing tree can never read done without a
    // recorded verdict. Hand-built shape: root running-children, every child summarized.
    const child: TreeNode = {
      nn: nnOf(1),
      title: "c",
      redraftCount: 0,
      lastFeedback: null,
      state: { stage: "leaf", phase: "summarized", planPath: null, summaryPath: null, plansDirPath: null },
    };
    const root: TreeNode = {
      nn: nnOf(1),
      title: "r",
      redraftCount: 0,
      lastFeedback: null,
      state: {
        stage: "split",
        phase: "running-children",
        children: [child] as NonEmptyArray<TreeNode>,
        planPath: "/pt/master.md",
        summaryPath: null,
        plansDirPath: null,
      },
    };
    // FALSIFY: re-restrict the all-summarized allowance to path.length > 0 (the old rule) → this
    // throws → RED. The acceptance window requires the allowance to cover the root too.
    expect(() => assertCoherent2(root)).not.toThrow();
    expect(treeIsDone(root)).toBe(false);
  });

  it("COHERENCE: a root running-children with a PENDING (not summarized) child and none active is STILL incoherent (the window needs ALL summarized)", () => {
    // The acceptance/roll-up allowances require EVERY child summarized AND zero active. A root with a
    // child still pending and none active is a genuine missed-activation incoherence, kept loud.
    // FALSIFY: broaden the allowance to permit a non-all-summarized running-children → no throw → RED.
    const child: TreeNode = {
      nn: nnOf(1),
      title: "c",
      redraftCount: 0,
      lastFeedback: null,
      state: { stage: "open", phase: "pending" },
    };
    const root: TreeNode = {
      nn: nnOf(1),
      title: "r",
      redraftCount: 0,
      lastFeedback: null,
      state: {
        stage: "split",
        phase: "running-children",
        children: [child] as NonEmptyArray<TreeNode>,
        planPath: "/pt/master.md",
        summaryPath: null,
        plansDirPath: null,
      },
    };
    expect(() => assertCoherent2(root)).toThrow(/running-children with 0 active/);
  });

  it("ACTIVE PATH: the parked parent ITSELF is the active node during its window", () => {
    const s = inWindow();
    // FALSIFIED 2026-06-11: restored the old activeWithin throw for the zero-active
    // running-children split (removed the window return) → this derivation threw instead of
    // returning ["01"] → RED; restored → GREEN.
    expect(activePathOf(s.root)).toEqual(p(1));
  });

  it("SUMMARY_WRITTEN for a split OUTSIDE its window throws (a child still pending)", () => {
    // root [01 split[01.01, 01.02]] with only 01.01 done — 01 is NOT in its window.
    let s = rootSplit(["First", "Second"]);
    s = run2(s, nestedSplit(p(1), 2, "01")).state;
    s = run2(s, [...leafCycle(p(1, 1), "01.01"), review(p(1))]).state;
    expect(activePathOf(s.root)).toEqual(p(1, 2)); // 01.02 active — not the parent
    expect(() =>
      reduce2(s, { type: "SUMMARY_WRITTEN", path: p(1), summaryText: "x", summaryPath: fileOf("/x.md") }),
    ).toThrow(); // requireActive2 rejects the non-active parent
  });

  it("SUMMARY_WRITTEN for the ROOT throws (the root writes no roll-up; summaryName2/planName2 agree)", () => {
    const s = inWindow();
    expect(() =>
      reduce2(s, { type: "SUMMARY_WRITTEN", path: [], summaryText: "x", summaryPath: fileOf("/x.md") }),
    ).toThrow();
    // The filename helpers encode the same root exceptions: no root summary; root plan = master.md.
    expect(() => summaryName2([])).toThrow();
    expect(planName2([])).toBe("master.md");
    expect(planName2(p(2))).toBe("02-plan.md");
    expect(planName2(p(2, 1))).toBe("02.01-plan.md");
  });

  it("PARTITION at depth 2: a second active grandchild (or summarized-right-of-pending) still throws", () => {
    const s = inWindow();
    // Mutate a copy into an illegal deep shape: 01 is in its window; ALSO activate a fake pending
    // sibling order violation by hand-building 01's children as [pending, summarized].
    const grand = nodeAtPath(s.root, p(1, 1))!;
    const pendingFirst: TreeNode = { ...grand, nn: nnOf(1), state: { stage: "open", phase: "pending" } };
    const summarizedSecond: TreeNode = { ...grand, nn: nnOf(2) }; // leaf/summarized from the cycle
    const badRoot: TreeNode = {
      ...s.root,
      state: {
        ...(s.root.state as Extract<TreeNode["state"], { stage: "split" }>),
        children: [
          {
            ...nodeAtPath(s.root, p(1))!,
            state: {
              ...(nodeAtPath(s.root, p(1))!.state as Extract<TreeNode["state"], { stage: "split" }>),
              children: [pendingFirst, summarizedSecond] as NonEmptyArray<TreeNode>,
            },
          },
          nodeAtPath(s.root, p(2))!,
        ] as NonEmptyArray<TreeNode>,
      },
    };
    // FALSIFY: skip the recursive assertStructure descent for nested children → no throw → RED.
    expect(() => assertCoherent2(badRoot)).toThrow(/summarized child .* right of a non-summarized/);
  });
});
