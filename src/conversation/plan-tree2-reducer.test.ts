// Multiplan orchestration domain — GENERATION 2 reducer tests (falsifiable).
//
// Ports the INTENT of every gen-1 reducer test cluster (the deleted plan-tree.test.ts) onto the
// path-based gen-2 event union (PlanTreeEvent2 / reduce2). Every test is constructed to go RED if
// the behavior under test were inverted; where useful a comment names the exact mutation that
// breaks it. Pure domain — no Tauri/DOM, zero side effects. Since the Phase-1 cutover this IS the
// live wire's reducer (the driver runs on reduce2; golden-depth1.test.ts pins the wire). The
// gen-1 clusters that survived the deletion verbatim-in-intent (parseSizerDecision, the
// two-outcome-sizer compile proof, and the frontend↔Rust filename contract) live at the bottom of
// this file.
//
// PHASE-1 DEPTH-1 SCOPE: children are forced leaves (no per-node sizer turn), no parent review,
// root completion when the last child summarizes. Deeper paths throw loudly (seam-commented in
// the reducer: PHASE 4/5).

import { describe, it, expect } from "vitest";
import {
  reduce2,
  summaryName2,
  planName2,
  parseNn,
  parseSizerDecision,
  pathKey,
  nodeAtPath,
  activePathOf,
  writePolicyFor2,
  assertCoherent2,
  treeIsDone,
  toLedger2,
  toSnapshot2,
  inAcceptanceWindow,
  rehydrateState2,
} from "./plan-tree";
import type {
  PlanTreeState2,
  PlanTreeEvent2,
  RecursiveLedger,
  Effect2,
  ApprovalGate2,
  NodePath,
  TreeNode,
  SizerOutcome,
  PlanTreeFilePath,
  PrototypeGate,
} from "./plan-tree";

// ---- fixtures ---------------------------------------------------------------------------------

// Branded mints for fixtures. parseNn is the REAL production boundary; PlanTreeFilePath has NO
// production mint outside the driver's write wrapper, so tests cast explicitly — the cast is the
// test's declaration that this string plays a written file's path.
const nnOf = (n: number) => parseNn(n);
const p = (...ns: number[]): NodePath => ns.map(nnOf);
const fileOf = (s: string) => s as PlanTreeFilePath;

function sizer(decision: SizerOutcome["decision"], num_plans: number, confidence = 0.8): SizerOutcome {
  return { decision, confidence, num_plans };
}

// A minimal pre-START placeholder (only consumed by START, which ignores it).
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

// A genesis state (as if START had just run): root open/clarifying-intent.
function genesisIntent2(): PlanTreeState2 {
  return reduce2(blank2(), { type: "START", treeId: "t2", request: "do the thing", nowMs: 1000 }).state;
}

// A state past the intent phase (START → INTENT_CLARIFIED): root open/recon.
function genesis2(): PlanTreeState2 {
  return reduce2(genesisIntent2(), { type: "INTENT_CLARIFIED", intent: "the confirmed intent" }).state;
}

// Apply a sequence of events, returning the final state and the flat list of every emitted effect.
function run2(
  state: PlanTreeState2,
  events: PlanTreeEvent2[],
): { state: PlanTreeState2; effects: Effect2[] } {
  let cur = state;
  const all: Effect2[] = [];
  for (const ev of events) {
    const out = reduce2(cur, ev);
    cur = out.state;
    all.push(...out.effects);
  }
  return { state: cur, effects: all };
}

// Drive a split run up to the first child's recon (root split running-children, child 01 active).
// Event order mirrors the task spec (DECOMPOSITION_DRAFTED then CHILDREN_PARSED then APPROVED);
// the gen-1 SUBPLANS_PARSED-before-MASTER_DRAFTED order is exercised by a dedicated test below.
function splitToFirstChild(n: number): PlanTreeState2 {
  const children = Array.from({ length: n }, (_, i) => ({ nn: nnOf(i + 1), title: `Phase ${i + 1}` }));
  return run2(genesis2(), [
    { type: "NODE_RECON_DONE", path: [] },
    { type: "SIZER_DONE", path: [], outcome: sizer("split", n) },
    { type: "DECOMPOSITION_DRAFTED", path: [], planPath: "/pt/master.md", plansDirPath: "/plans/master.md", toolUseId: "m1" },
    { type: "CHILDREN_PARSED", path: [], children },
    { type: "DECOMPOSITION_APPROVED", path: [] },
  ]).state;
}

// Drive one depth-1 child through recon → sizer(single) → draft → approve → exec → summary,
// returning the final state and the effects from those steps only. PHASE 4: every non-root node
// runs the per-node sizer after recon — EXCEPT the root single-collapse child (it inherited the
// root sizer's verdict and goes recon → drafting directly); pass viaSizer:false there.
function cycleChild(
  s: PlanTreeState2,
  n: number,
  viaSizer = true,
): { state: PlanTreeState2; effects: Effect2[] } {
  return run2(s, [
    { type: "NODE_RECON_DONE", path: p(n) },
    ...(viaSizer
      ? [{ type: "SIZER_DONE", path: p(n), outcome: sizer("single", 1, 0.9) } as PlanTreeEvent2]
      : []),
    { type: "NODE_DRAFTED", path: p(n), toolUseId: `tu${n}`, planPath: `/p${n}.md`, plansDirPath: `/d${n}` },
    { type: "APPROVE", path: p(n) },
    { type: "EXEC_DONE", path: p(n) },
    { type: "SUMMARY_WRITTEN", path: p(n), summaryText: `summary ${n}`, summaryPath: fileOf(`/s${n}.md`) },
  ]);
}

// Resolve depth-1 child n, throwing if absent (keeps assertions terse and loud).
function child(s: PlanTreeState2, n: number): TreeNode {
  const c = nodeAtPath(s.root, p(n));
  if (!c) throw new Error(`fixture: no child ${n} under root`);
  return c;
}

// Narrow a node to its leaf state, loudly.
function leafState(node: TreeNode): Extract<TreeNode["state"], { stage: "leaf" }> {
  if (node.state.stage !== "leaf") throw new Error(`fixture: expected leaf, got ${node.state.stage}`);
  return node.state;
}

// ---- Test 0: intent-clarification phase precedes recon (gen-1 cluster mirror) ------------------

describe("gen-2 intent-clarification phase", () => {
  it("START lands the root in open/clarifying-intent, coherent, no transient gates", () => {
    const s = genesisIntent2();
    // Mutation: seed the root at open/recon → RED.
    expect(s.root.state).toEqual({ stage: "open", phase: "clarifying-intent" });
    expect(s.tree_id).toBe("t2");
    expect(s.pendingApproval).toBeNull();
    expect(s.pendingClarify).toBeNull();
    expect(s.parsedChildren).toBeNull();
    expect(() => assertCoherent2(s.root)).not.toThrow();
    // The in-flight root IS the active node (path []).
    expect(activePathOf(s.root)).toEqual([]);
  });

  it("START emits resetPlanTreeDir BEFORE persist (stale .plan-tree files are archived first)", () => {
    const out = reduce2(blank2(), { type: "START", treeId: "t2", request: "do the thing", nowMs: 1000 });
    const resetIdx = out.effects.findIndex((e) => e.kind === "resetPlanTreeDir");
    const persistIdx = out.effects.findIndex((e) => e.kind === "persist");
    // Mutation: drop the resetPlanTreeDir effect → findIndex -1 → RED.
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    // ORDER: reset MUST land before persist (else the genesis state.json is itself swept).
    expect(resetIdx).toBeLessThan(persistIdx);
  });

  it("INTENT_CLARIFIED writes INTENT.md + persists, then transitions clarifying-intent → recon", () => {
    const out = reduce2(genesisIntent2(), { type: "INTENT_CLARIFIED", intent: "build a widget, must be fast" });
    // Mutation: leave the root at clarifying-intent → RED.
    expect(out.state.root.state).toEqual({ stage: "open", phase: "recon" });
    // Mutation: drop the writePlanTreeFile effect (or rename) → RED.
    expect(out.effects).toContainEqual({
      kind: "writePlanTreeFile",
      name: "INTENT.md",
      contents: "build a widget, must be fast",
    });
    expect(out.effects).toContainEqual({ kind: "persist" });
  });

  it("INTENT_CLARIFIED throws loudly outside clarifying-intent", () => {
    // Stricter than gen-1 (which silently reset the phase): a stray INTENT_CLARIFIED mid-run must
    // not rewind the tree. Mutation: drop the phase guard → no throw → RED.
    expect(() => reduce2(genesis2(), { type: "INTENT_CLARIFIED", intent: "again" })).toThrow();
  });

  it("a CLARIFY gate raised during the intent phase is transient and does NOT change the phase", () => {
    const s = genesisIntent2();
    const req = reduce2(s, { type: "CLARIFY_REQUESTED", toolUseId: "q-1", questions: [] });
    expect(req.state.root.state).toEqual({ stage: "open", phase: "clarifying-intent" });
    expect(req.state.pendingClarify).toEqual({ toolUseId: "q-1", questions: [] });

    const ans = reduce2(req.state, { type: "CLARIFY_ANSWERED", toolUseId: "q-1", answers: { Q: "A" } });
    expect(ans.state.pendingClarify).toBeNull();
    expect(ans.state.root.state).toEqual({ stage: "open", phase: "clarifying-intent" });
    expect(ans.effects).toContainEqual({
      kind: "resolvePermission",
      id: "q-1",
      allow: true,
      message: JSON.stringify({ answers: { Q: "A" } }),
    });
  });
});

// ---- the visual-prototype review gate (root-only: clarifying-intent ↔ prototype-review → recon) -

describe("gen-2 prototype-review gate", () => {
  function protoGate(round = 0): PrototypeGate {
    return {
      kind: "html",
      paths: ["/tmp/proto/index.html"],
      screenshot: "/tmp/proto/shot.png",
      inlinePreview: null,
      variants: [{ label: "Variant A", path: "/tmp/proto/a.html", inlinePreview: null }],
      round,
      cwd: "/repo",
    };
  }

  it("PROTOTYPE_READY: root clarifying-intent → prototype-review, gate held, notifyPrototypeReview emitted", () => {
    const out = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGate() });
    // Mutation: leave the root at clarifying-intent → RED.
    expect(out.state.root.state).toEqual({ stage: "open", phase: "prototype-review" });
    // The gate is held TRANSIENTLY (pendingPrototype) — never on the tree.
    expect(out.state.pendingPrototype).toEqual(protoGate());
    // FALSIFIED (evidence in task report): dropping the notifyPrototypeReview effect push turns
    // the kinds pin RED. Notify rides with persist (gate surfaced + ledger saved).
    expect(out.effects).toContainEqual({ kind: "notifyPrototypeReview", gate: protoGate() });
    expect(out.effects.map((e) => e.kind)).toEqual(["notifyPrototypeReview", "persist"]);
    // The reviewing ROOT is still the active node, and the policy stays "prototype".
    expect(activePathOf(out.state.root)).toEqual([]);
    expect(writePolicyFor2(out.state.root)).toBe("prototype");
  });

  it("PROTOTYPE_READY throws outside root clarifying-intent (open/recon; a non-root active node)", () => {
    // Root at open/recon (the no-prototype fallback already ran) — illegal. Mutation: drop the
    // phase guard → no throw → RED.
    expect(() => reduce2(genesis2(), { type: "PROTOTYPE_READY", gate: protoGate() })).toThrow(
      /PROTOTYPE_READY illegal/,
    );
    // Root is a split with a non-root node active — illegal too (the gate is a genesis-window
    // root arc; mid-run prototypes have no arc).
    expect(() => reduce2(splitToFirstChild(2), { type: "PROTOTYPE_READY", gate: protoGate() })).toThrow(
      /PROTOTYPE_READY illegal/,
    );
    // Already in prototype-review — a second READY without a REFINED loop is illegal.
    const reviewing = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGate() }).state;
    expect(() => reduce2(reviewing, { type: "PROTOTYPE_READY", gate: protoGate(1) })).toThrow(
      /PROTOTYPE_READY illegal/,
    );
  });

  it("PROTOTYPE_APPROVED (sketch — default): prototype-review → recon, clears the gate, writes INTENT.md (mirrors INTENT_CLARIFIED), records NO baseline_", () => {
    const reviewing = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGate() }).state;
    const out = reduce2(reviewing, {
      type: "PROTOTYPE_APPROVED",
      intentContents: "intent + approved prototype",
      asWorkingReference: false,
      frozenMs: 9999,
    });
    // Mutation: route approval back to clarifying-intent (or leave prototype-review) → RED.
    expect(out.state.root.state).toEqual({ stage: "open", phase: "recon" });
    expect(out.state.pendingPrototype).toBeNull();
    // The INTENT.md write mirrors INTENT_CLARIFIED's effect shape byte-for-byte.
    expect(out.effects).toEqual([
      { kind: "writePlanTreeFile", name: "INTENT.md", contents: "intent + approved prototype" },
      { kind: "persist" },
    ]);
    // Recon onward derives "plan" — the prototype window is closed.
    expect(writePolicyFor2(out.state.root)).toBe("plan");
    // SKETCH = no working reference: baseline_ stays untouched (today's behavior). Falsifiable: if
    // the reducer set baseline_ on the default sketch path this assertion goes RED.
    expect(out.state.baseline_).toBeUndefined();
    // The persisted ledger likewise carries no baseline_ on the sketch path.
    expect(toLedger2(out.state).baseline_).toBeUndefined();
  });

  it("PROTOTYPE_APPROVED (working reference): records baseline_ on the ledger while the recon hop is otherwise identical to the sketch path", () => {
    const reviewing = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGate() }).state;
    const out = reduce2(reviewing, {
      type: "PROTOTYPE_APPROVED",
      intentContents: "intent + working reference",
      asWorkingReference: true,
      frozenMs: 4242,
    });
    // The recon hop + INTENT.md write + gate clear are IDENTICAL to the sketch path.
    expect(out.state.root.state).toEqual({ stage: "open", phase: "recon" });
    expect(out.state.pendingPrototype).toBeNull();
    expect(out.effects).toEqual([
      { kind: "writePlanTreeFile", name: "INTENT.md", contents: "intent + working reference" },
      { kind: "persist" },
    ]);
    // The DELTA: baseline_ is recorded with the event's frozenMs. Falsifiable: drop the
    // asWorkingReference branch and baseline_ stays undefined → RED.
    expect(out.state.baseline_).toEqual({ frozen: true, frozen_ms: 4242 });
    // And it round-trips through the persisted ledger (toLedger2 deep-copies it).
    expect(toLedger2(out.state).baseline_).toEqual({ frozen: true, frozen_ms: 4242 });
  });

  it("PROTOTYPE_APPROVED throws outside prototype-review (clarifying-intent; recon; non-root active)", () => {
    // At clarifying-intent (no prototype is up) — illegal.
    expect(() =>
      reduce2(genesisIntent2(), {
        type: "PROTOTYPE_APPROVED",
        intentContents: "i",
        asWorkingReference: false,
        frozenMs: 0,
      }),
    ).toThrow(/PROTOTYPE_APPROVED illegal/);
    // At recon — illegal.
    expect(() =>
      reduce2(genesis2(), {
        type: "PROTOTYPE_APPROVED",
        intentContents: "i",
        asWorkingReference: false,
        frozenMs: 0,
      }),
    ).toThrow(/PROTOTYPE_APPROVED illegal/);
    // Mid-run with a non-root node active — illegal.
    expect(() =>
      reduce2(splitToFirstChild(2), {
        type: "PROTOTYPE_APPROVED",
        intentContents: "i",
        asWorkingReference: false,
        frozenMs: 0,
      }),
    ).toThrow(/PROTOTYPE_APPROVED illegal/);
  });

  it("PROTOTYPE_REFINED: prototype-review → BACK to clarifying-intent, gate cleared, persist only", () => {
    const reviewing = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGate() }).state;
    const out = reduce2(reviewing, { type: "PROTOTYPE_REFINED", feedback: "make it denser" });
    // Mutation: advance to recon on refine → RED (refine LOOPS, never advances).
    expect(out.state.root.state).toEqual({ stage: "open", phase: "clarifying-intent" });
    expect(out.state.pendingPrototype).toBeNull();
    // The feedback is DRIVER prompt material: no write, no notify — persist only.
    expect(out.effects.map((e) => e.kind)).toEqual(["persist"]);
    // The loop is re-enterable: a fresh PROTOTYPE_READY (next round) is legal again.
    const again = reduce2(out.state, { type: "PROTOTYPE_READY", gate: protoGate(1) });
    expect(again.state.pendingPrototype?.round).toBe(1);
  });

  it("PROTOTYPE_REFINED throws outside prototype-review", () => {
    expect(() => reduce2(genesisIntent2(), { type: "PROTOTYPE_REFINED", feedback: "f" })).toThrow(
      /PROTOTYPE_REFINED illegal/,
    );
    expect(() => reduce2(splitToFirstChild(2), { type: "PROTOTYPE_REFINED", feedback: "f" })).toThrow(
      /PROTOTYPE_REFINED illegal/,
    );
  });

  it("the snapshot carries pendingPrototype; the LEDGER never does (no resume-from-disk)", () => {
    const reviewing = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGate() }).state;
    const snap = toSnapshot2(reviewing);
    // Mutation: drop pendingPrototype from toSnapshot2 → undefined here → RED.
    expect(snap.pendingPrototype).toEqual(protoGate());
    // FALSIFIED (evidence in task report): adding pendingPrototype to toLedger2's return object
    // turns this exact key-set pin RED.
    const ledger = toLedger2(reviewing);
    // sdk_session_id (resume support), baseline_ (working reference), and acceptance_ (Phase 5 —
    // the recorded acceptance verdict) are additive fields — present as keys but undefined until
    // stamped; JSON.stringify omits them while undefined so old state.json stays back-compatible.
    expect(Object.keys(ledger).sort()).toEqual([
      "acceptance_",
      "baseline_",
      "created_ms",
      "root",
      "schema",
      "sdk_session_id",
      "tree_id",
      "updated_ms",
    ]);
    expect("pendingPrototype" in ledger).toBe(false);
    expect("pendingAcceptance" in ledger).toBe(false);
  });

  it("INTENT_CLARIFIED is the unchanged no-prototype fallback (clarifying-intent → recon, INTENT.md)", () => {
    // Pin that adding the prototype arcs did NOT disturb the fallback: same source state, same
    // target, same effects as before the gate existed.
    const out = reduce2(genesisIntent2(), { type: "INTENT_CLARIFIED", intent: "plain text intent" });
    expect(out.state.root.state).toEqual({ stage: "open", phase: "recon" });
    expect(out.effects).toEqual([
      { kind: "writePlanTreeFile", name: "INTENT.md", contents: "plain text intent" },
      { kind: "persist" },
    ]);
  });
});

// ---- root pre-execution arc: recon → sizing → decomposing --------------------------------------

describe("gen-2 root pre-execution arc", () => {
  it("root NODE_RECON_DONE moves recon → sizing and persists (recon.md is now DRIVER-written)", () => {
    const out = reduce2(genesis2(), { type: "NODE_RECON_DONE", path: [] });
    expect(out.state.root.state).toEqual({ stage: "open", phase: "sizing" });
    // The gen-2 event carries NO recon text: the driver writes recon.md and dispatches the bare
    // event (same boundary as SUMMARY_WRITTEN). Mutation: re-add a writePlanTreeFile here → RED.
    expect(out.effects.map((e) => e.kind)).toEqual(["persist"]);
  });

  it("root SIZER_DONE split moves sizing → decomposing (no children yet)", () => {
    let s = genesis2();
    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    const out = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("split", 3) });
    expect(out.state.root.state).toEqual({ stage: "open", phase: "decomposing" });
    expect(out.effects.map((e) => e.kind)).toEqual(["persist"]);
  });

  it("a low-confidence single (0.5) is treated as a split → decomposing, NOT a collapse", () => {
    let s = genesis2();
    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    // Mutation: drop the `>= 0.6` confidence guard → collapses to split/running-children → RED.
    const out = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("single", 1, 0.5) });
    expect(out.state.root.state.stage).toBe("open");
    expect(out.state.root.state.phase).toBe("decomposing");
  });
});

// ---- single-collapse: root confident single ⇒ ONE child 01, NO decomposition gate --------------

describe("gen-2 single-collapse run", () => {
  it("confident single collapses to ONE child 01 ('Plan'), root split/running-children, child open/recon", () => {
    let s = genesis2();
    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    s = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("single", 1) }).state;

    // FALSIFIED (single-collapse arc): inverting the collapse (route confident single to
    // decomposing like a split) turns every assertion below RED — captured during development.
    expect(s.root.state.stage).toBe("split");
    expect(s.root.state.phase).toBe("running-children");
    if (s.root.state.stage !== "split") throw new Error("unreachable");
    expect(s.root.state.children).toHaveLength(1);
    const c = child(s, 1);
    expect(c.nn).toBe(nnOf(1));
    expect(c.title).toBe("Plan");
    expect(c.state).toEqual({ stage: "open", phase: "recon" });
    // No decomposition gate was ever set — the collapse materializes the child immediately.
    expect(s.pendingApproval).toBeNull();
    expect(s.parsedChildren).toBeNull();
  });

  it("emits exactly ONE approval gate across the whole run, and it is the LEAF gate", () => {
    let s = genesis2();
    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    s = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("single", 1) }).state;

    // The collapse child SKIPS the per-node sizer (root-only special case — PHASE 4 pin: a
    // SIZER_DONE for it would throw "expected open/sizing" since recon forced leaf/drafting).
    const out = cycleChild(s, 1, false);
    const gates = out.effects.filter((e) => e.kind === "notifyAwaitingApproval");
    // Mutation: keep a decomposition gate in the single path → a second gate appears → RED.
    expect(gates).toHaveLength(1);
    expect(gates[0].kind === "notifyAwaitingApproval" && gates[0].gate.kind).toBe("leaf");

    expect(treeIsDone(out.state.root)).toBe(true);
    expect(leafState(child(out.state, 1)).phase).toBe("summarized");
  });
});

// ---- full split run: coherent at EVERY reduce, ends done/all-summarized ------------------------

describe("gen-2 full split run", () => {
  it("drives root → 3 children → done; assertCoherent2 never throws; ends correct", () => {
    let s = genesis2();
    const preamble: PlanTreeEvent2[] = [
      { type: "NODE_RECON_DONE", path: [] },
      { type: "SIZER_DONE", path: [], outcome: sizer("split", 3) },
      {
        type: "DECOMPOSITION_DRAFTED",
        path: [],
        planPath: "/pt/master.md",
        plansDirPath: "/plans/master.md",
        toolUseId: "m1",
      },
      {
        type: "CHILDREN_PARSED",
        path: [],
        children: [
          { nn: nnOf(1), title: "A" },
          { nn: nnOf(2), title: "B" },
          { nn: nnOf(3), title: "C" },
        ],
      },
      { type: "DECOMPOSITION_APPROVED", path: [] },
    ];
    for (const ev of preamble) {
      s = reduce2(s, ev).state;
      expect(() => assertCoherent2(s.root)).not.toThrow();
    }

    for (const n of [1, 2, 3]) {
      const events: PlanTreeEvent2[] = [
        { type: "NODE_RECON_DONE", path: p(n) },
        // PHASE 4: every non-root node runs the per-node sizer (single ⇒ the node IS the leaf).
        { type: "SIZER_DONE", path: p(n), outcome: sizer("single", 1, 0.9) },
        { type: "NODE_DRAFTED", path: p(n), toolUseId: `tu${n}`, planPath: `/p${n}.md`, plansDirPath: `/d${n}` },
        { type: "APPROVE", path: p(n) },
        { type: "EXEC_DONE", path: p(n) },
        { type: "SUMMARY_WRITTEN", path: p(n), summaryText: `s${n}`, summaryPath: fileOf(`/s${n}.md`) },
        // PHASE 5: a non-final child's summary parks the root in `reviewing`; PARENT_REVIEW_DONE
        // is the arc that activates the next sibling. The LAST child skips the review entirely.
        ...(n < 3 ? [{ type: "PARENT_REVIEW_DONE", path: [], note: null } as PlanTreeEvent2] : []),
      ];
      for (const ev of events) {
        s = reduce2(s, ev).state;
        // Coherence holds after EVERY reduce. (Mutation: activating child n+1 early → RED.)
        expect(() => assertCoherent2(s.root)).not.toThrow();
      }
    }

    expect(s.root.state.stage).toBe("split");
    expect(s.root.state.phase).toBe("summarized");
    expect(treeIsDone(s.root)).toBe(true);
    for (const n of [1, 2, 3]) {
      expect(leafState(child(s, n)).phase).toBe("summarized");
      expect(leafState(child(s, n)).summaryPath).toBe(`/s${n}.md`);
    }
  });

  it("CHILDREN_PARSED is also legal BEFORE the draft (gen-1 SUBPLANS_PARSED-while-decomposing order)", () => {
    let s = genesis2();
    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    s = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("split", 2) }).state;
    s = reduce2(s, {
      type: "CHILDREN_PARSED",
      path: [],
      children: [
        { nn: nnOf(1), title: "A" },
        { nn: nnOf(2), title: "B" },
      ],
    }).state;
    // The parse is STASHED transiently — the root stays open (the split materializes at approval,
    // when exactly one child can be active; see the reducer's CHILDREN_PARSED note).
    expect(s.root.state.stage).toBe("open");
    expect(s.parsedChildren?.children).toHaveLength(2);
    s = reduce2(s, {
      type: "DECOMPOSITION_DRAFTED",
      path: [],
      planPath: "/pt/master.md",
      plansDirPath: "/plans/master.md",
      toolUseId: "m1",
    }).state;
    const out = reduce2(s, { type: "DECOMPOSITION_APPROVED", path: [] });
    expect(out.state.root.state.stage).toBe("split");
    expect(child(out.state, 1).state).toEqual({ stage: "open", phase: "recon" });
    expect(child(out.state, 2).state).toEqual({ stage: "open", phase: "pending" });
  });

  it("DECOMPOSITION_APPROVED before CHILDREN_PARSED throws (no children to run)", () => {
    let s = genesis2();
    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    s = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("split", 2) }).state;
    s = reduce2(s, {
      type: "DECOMPOSITION_DRAFTED",
      path: [],
      planPath: "/pt/master.md",
      plansDirPath: "/plans/master.md",
      toolUseId: "m1",
    }).state;
    // Mutation: default to an empty/auto child list on approval → no throw → RED.
    expect(() => reduce2(s, { type: "DECOMPOSITION_APPROVED", path: [] })).toThrow();
  });
});

// ---- the unified decomposition gate (root gate lives in pendingApproval — no nn:-1 sentinel) ----

describe("gen-2 unified decomposition gate", () => {
  function drafted(): { state: PlanTreeState2; effects: Effect2[] } {
    let s = genesis2();
    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    s = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("split", 2) }).state;
    return reduce2(s, {
      type: "DECOMPOSITION_DRAFTED",
      path: [],
      planPath: "/pt/master.md",
      plansDirPath: "/plans/master.md",
      toolUseId: "m1",
    });
  }

  it("DECOMPOSITION_DRAFTED sets the ROOT gate in pendingApproval (kind decomposition) and notifies", () => {
    const out = drafted();
    expect(out.state.root.state).toEqual({ stage: "open", phase: "awaiting-decomposition-approval" });
    const expected: ApprovalGate2 = {
      path: [],
      kind: "decomposition",
      toolUseId: "m1",
      planPath: "/pt/master.md",
      plansDirPath: "/plans/master.md",
      redraftCount: 0,
    };
    // FALSIFIED (unified root gate): omitting the pendingApproval assignment in
    // DECOMPOSITION_DRAFTED turns this RED — captured during development.
    expect(out.state.pendingApproval).toEqual(expected);
    expect(out.effects).toContainEqual({ kind: "notifyAwaitingApproval", gate: expected });
    expect(out.effects.map((e) => e.kind)).toEqual(["persist", "notifyAwaitingApproval"]);
  });

  it("DECOMPOSITION_APPROVED resolves the held permission (allow), clears the gate, activates child 01", () => {
    const afterDraft = drafted().state;
    const s = reduce2(afterDraft, {
      type: "CHILDREN_PARSED",
      path: [],
      children: [
        { nn: nnOf(1), title: "A" },
        { nn: nnOf(2), title: "B" },
      ],
    }).state;
    const out = reduce2(s, { type: "DECOMPOSITION_APPROVED", path: [] });
    expect(out.state.pendingApproval).toBeNull();
    expect(out.state.parsedChildren).toBeNull();
    // Mirror of the gen-1 APPROVE effect shape: resolve-allow then persist, nothing else.
    expect(out.effects.map((e) => e.kind)).toEqual(["resolvePermission", "persist"]);
    expect(out.effects).toContainEqual({ kind: "resolvePermission", id: "m1", allow: true });
    expect(out.state.root.state.stage).toBe("split");
    expect(out.state.root.state.phase).toBe("running-children");
    // The decomposition plan's artifact paths land on the split node.
    if (out.state.root.state.stage === "split") {
      expect(out.state.root.state.planPath).toBe("/pt/master.md");
      expect(out.state.root.state.plansDirPath).toBe("/plans/master.md");
    }
    expect(child(out.state, 1).state).toEqual({ stage: "open", phase: "recon" });
  });

  it("DECOMPOSITION_CHANGES_REQUESTED stays decomposing-side: redraftCount++, gate cleared, deny resolution", () => {
    const afterDraft = drafted().state;
    const out = reduce2(afterDraft, {
      type: "DECOMPOSITION_CHANGES_REQUESTED",
      path: [],
      feedback: "split differently",
    });
    // Back to decomposing (the same-turn redraft re-drafts and re-parses). Mutation: advance to
    // running-children on changes-requested → RED.
    expect(out.state.root.state).toEqual({ stage: "open", phase: "decomposing" });
    expect(out.state.root.redraftCount).toBe(1);
    expect(out.state.root.lastFeedback).toBe("split differently");
    expect(out.state.pendingApproval).toBeNull();
    expect(out.effects.map((e) => e.kind)).toEqual(["resolvePermission", "persist"]);
    expect(out.effects).toContainEqual({
      kind: "resolvePermission",
      id: "m1",
      allow: false,
      message: "split differently",
    });

    // The redraft carries the incremented count into the NEXT gate.
    const redraft = reduce2(out.state, {
      type: "DECOMPOSITION_DRAFTED",
      path: [],
      planPath: "/pt/master.md",
      plansDirPath: "/plans/master.md",
      toolUseId: "m2",
    });
    expect(redraft.state.pendingApproval?.redraftCount).toBe(1);
  });

  it("a stale CHILDREN_PARSED from a rejected draft is discarded (changes-requested clears the stash)", () => {
    const afterDraft = drafted().state;
    const parsed = reduce2(afterDraft, {
      type: "CHILDREN_PARSED",
      path: [],
      children: [{ nn: nnOf(1), title: "stale" }],
    }).state;
    const out = reduce2(parsed, {
      type: "DECOMPOSITION_CHANGES_REQUESTED",
      path: [],
      feedback: "redo",
    });
    // Mutation: keep parsedChildren across a rejection → the stale parse would seed the next
    // approval → RED.
    expect(out.state.parsedChildren).toBeNull();
  });
});

// ---- leaf REQUEST_CHANGES keeps position, redrafts in place, siblings untouched ----------------

describe("gen-2 leaf REQUEST_CHANGES", () => {
  it("keeps the active path fixed, drafts current, increments redraftCount, never touches siblings", () => {
    let s = splitToFirstChild(3);
    s = run2(s, [
      { type: "NODE_RECON_DONE", path: p(1) },
      { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(1), toolUseId: "tu1", planPath: "/p1.md", plansDirPath: "/d1" },
    ]).state;

    const activeBefore = activePathOf(s.root);
    const siblingsBefore = [child(s, 2), child(s, 3)];
    const redraftBefore = child(s, 1).redraftCount;

    const out = reduce2(s, { type: "REQUEST_CHANGES", path: p(1), feedback: "tighten scope" });
    const after = out.state;

    // Position fixed. (Mutation: advancing to child 2 in REQUEST_CHANGES → RED.)
    expect(activePathOf(after.root)).toEqual(activeBefore);
    expect(leafState(child(after, 1)).phase).toBe("drafting");
    expect(child(after, 1).redraftCount).toBe(redraftBefore + 1);
    expect(child(after, 1).lastFeedback).toBe("tighten scope");
    // Gate cleared and a deny resolution emitted with the feedback.
    expect(after.pendingApproval).toBeNull();
    expect(out.effects).toContainEqual({
      kind: "resolvePermission",
      id: "tu1",
      allow: false,
      message: "tighten scope",
    });
    // Siblings byte-identical. (Mutation: resetting a sibling's state → RED.)
    expect([child(after, 2), child(after, 3)]).toEqual(siblingsBefore);
  });
});

// ---- APPROVE legality + the leaf gate object shape ----------------------------------------------

describe("gen-2 APPROVE legality", () => {
  it("throws from recon, throws from executing, succeeds from awaiting-approval with exact effects", () => {
    let s = splitToFirstChild(1);
    // Child 1 is open/recon here — APPROVE is illegal. (Mutation: drop the phase guard → RED.)
    expect(() => reduce2(s, { type: "APPROVE", path: p(1) })).toThrow();

    s = reduce2(s, { type: "NODE_RECON_DONE", path: p(1) }).state;
    s = reduce2(s, { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.9) }).state;
    const draftedOut = reduce2(s, {
      type: "NODE_DRAFTED",
      path: p(1),
      toolUseId: "tu1",
      planPath: "/p.md",
      plansDirPath: "/d",
    });
    // The LEAF gate: path-addressed, kind "leaf", redraftCount carried from the node.
    const expectedGate: ApprovalGate2 = {
      path: p(1),
      kind: "leaf",
      toolUseId: "tu1",
      planPath: "/p.md",
      plansDirPath: "/d",
      redraftCount: 0,
    };
    expect(draftedOut.state.pendingApproval).toEqual(expectedGate);
    expect(draftedOut.effects).toContainEqual({ kind: "notifyAwaitingApproval", gate: expectedGate });
    // The drafted paths land on the leaf state. Mutation: drop the planPath record → RED.
    expect(leafState(child(draftedOut.state, 1)).planPath).toBe("/p.md");
    expect(leafState(child(draftedOut.state, 1)).plansDirPath).toBe("/d");

    const ok = reduce2(draftedOut.state, { type: "APPROVE", path: p(1) });
    expect(leafState(child(ok.state, 1)).phase).toBe("executing");
    expect(ok.state.pendingApproval).toBeNull();
    // EXACTLY resolve-allow + persist — APPROVE emits NO setMode effect: the writable mode is the
    // DERIVED policy (writePolicyFor2 flips off the `executing` leaf). Mutation: add a setMode-like
    // effect → the exact kinds list goes RED.
    expect(ok.effects.map((e) => e.kind)).toEqual(["resolvePermission", "persist"]);
    expect(ok.effects).toContainEqual({ kind: "resolvePermission", id: "tu1", allow: true });
    expect(writePolicyFor2(ok.state.root)).toBe("acceptEdits");

    // Approving an executing leaf is illegal → throw.
    expect(() => reduce2(ok.state, { type: "APPROVE", path: p(1) })).toThrow();
  });
});

// ---- advance-on-summary: parent reviews between siblings; last child completes the root ---------

describe("gen-2 SUMMARY_WRITTEN advance", () => {
  it("PHASE 5: a non-final child's summary parks the parent in `reviewing` — the next sibling STAYS pending", () => {
    let s = splitToFirstChild(2);
    s = run2(s, [
      { type: "NODE_RECON_DONE", path: p(1) },
      { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(1), toolUseId: "tu1", planPath: "/p1.md", plansDirPath: "/d1" },
      { type: "APPROVE", path: p(1) },
      { type: "EXEC_DONE", path: p(1) },
    ]).state;

    const out = reduce2(s, {
      type: "SUMMARY_WRITTEN",
      path: p(1),
      summaryText: "s1",
      summaryPath: fileOf("/s1.md"),
    });
    // FALSIFIED 2026-06-11 (review arc): reverting advanceAfterSummary to the Phase-4 direct
    // sibling activation (child 2 → recon, root stays running-children) turns the `reviewing` and
    // `pending` assertions below RED.
    expect(leafState(child(out.state, 1)).phase).toBe("summarized");
    expect(leafState(child(out.state, 1)).summaryPath).toBe("/s1.md");
    expect(child(out.state, 2).state).toEqual({ stage: "open", phase: "pending" });
    expect(out.state.root.state.phase).toBe("reviewing");
    // The reviewing PARENT is the active node (the review turn is the parent's turn).
    expect(activePathOf(out.state.root)).toEqual([]);
    expect(out.effects).toContainEqual({
      kind: "notifySummaryWritten",
      path: p(1),
      summaryPath: fileOf("/s1.md"),
    });
    // Order mirror of gen-1: notify BEFORE persist; no notifyDone mid-run.
    expect(out.effects.map((e) => e.kind)).toEqual(["notifySummaryWritten", "persist"]);
  });

  it("PHASE 5: PARENT_REVIEW_DONE is the arc that activates the NEXT pending sibling (reviewing → running-children)", () => {
    let s = splitToFirstChild(2);
    s = cycleChild(s, 1).state;
    expect(s.root.state.phase).toBe("reviewing");
    const out = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: "tighten scope" });
    // FALSIFY: drop the next-child activation (leave it pending) → assertCoherent2 throws inside
    // reduce2 (running-children with zero active children) → RED.
    expect(out.state.root.state.phase).toBe("running-children");
    expect(child(out.state, 2).state).toEqual({ stage: "open", phase: "recon" });
    expect(activePathOf(out.state.root)).toEqual(p(2));
    expect(out.effects.map((e) => e.kind)).toEqual(["persist"]);
  });

  it("PHASE 5: PARENT_REVIEW_DONE throws outside `reviewing` (reviewing has no other exit; no other state enters it)", () => {
    // running-children (child 1 mid-flight) — not reviewing.
    const s = splitToFirstChild(2);
    expect(() => reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null })).toThrow(
      /PARENT_REVIEW_DONE/,
    );
  });

  it("the LAST child's summary completes the ROOT (split → summarized) and notifies done — NO review after the last child", () => {
    let s = splitToFirstChild(2);
    s = cycleChild(s, 1).state;
    s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    const out = cycleChild(s, 2);
    // PHASE 5 skip-after-last pin: the root completes DIRECTLY (no reviewing window). FALSIFY:
    // route the last child through reviewing too → the phase here reads "reviewing" → RED.
    expect(out.state.root.state.phase).toBe("summarized");
    expect(treeIsDone(out.state.root)).toBe(true);
    // Mutation: leave the root running-children after the last child → notifyDone missing AND
    // assertCoherent2 throws (running-children with zero active children) → RED.
    const last = out.effects.slice(-3).map((e) => e.kind);
    expect(last).toEqual(["notifySummaryWritten", "notifyDone", "persist"]);
  });
});

// ---- PHASE 5: the forced acceptance gate (baseline floor enforcement) --------------------------

describe("gen-2 forced acceptance gate", () => {
  // A protoGate fixture (mirrors the prototype-gate cluster above) so the baseline-recording path is
  // exercised through the REAL PROTOTYPE_APPROVED arc, not by hand-injecting baseline_.
  function protoGateFix(): PrototypeGate {
    return {
      kind: "html",
      paths: ["index.html"],
      screenshot: null,
      inlinePreview: null,
      variants: [],
      round: 1,
      cwd: "/cwd",
    };
  }

  // Genesis past intent WITH a frozen working-reference baseline recorded (the real arc: START →
  // PROTOTYPE_READY → PROTOTYPE_APPROVED{asWorkingReference:true}). Root open/recon, baseline_ set.
  function genesisWithBaseline2(): PlanTreeState2 {
    const reviewing = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGateFix() }).state;
    const s = reduce2(reviewing, {
      type: "PROTOTYPE_APPROVED",
      intentContents: "the confirmed intent",
      asWorkingReference: true,
      frozenMs: 7777,
    }).state;
    if (!s.baseline_) throw new Error("fixture: baseline_ not recorded");
    return s;
  }

  // Drive a baseline-bearing 2-child split all the way to the LAST child's SUMMARY_WRITTEN, returning
  // that final reduce's {state, effects} so the gating decision is observable directly.
  function driveBaselineSplitToLastSummary(): { state: PlanTreeState2; effects: Effect2[] } {
    const children = [
      { nn: nnOf(1), title: "A" },
      { nn: nnOf(2), title: "B" },
    ];
    let s = run2(genesisWithBaseline2(), [
      { type: "NODE_RECON_DONE", path: [] },
      { type: "SIZER_DONE", path: [], outcome: sizer("split", 2) },
      { type: "DECOMPOSITION_DRAFTED", path: [], planPath: "/pt/master.md", plansDirPath: "/plans/master.md", toolUseId: "m1" },
      { type: "CHILDREN_PARSED", path: [], children },
      { type: "DECOMPOSITION_APPROVED", path: [] },
    ]).state;
    // Child 1 fully, then the parent review, then child 2 up to EXEC_DONE.
    s = cycleChild(s, 1).state;
    s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    s = run2(s, [
      { type: "NODE_RECON_DONE", path: p(2) },
      { type: "SIZER_DONE", path: p(2), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(2), toolUseId: "tu2", planPath: "/p2.md", plansDirPath: "/d2" },
      { type: "APPROVE", path: p(2) },
      { type: "EXEC_DONE", path: p(2) },
    ]).state;
    // The LAST child's summary is the gating reduce — return it directly.
    return reduce2(s, { type: "SUMMARY_WRITTEN", path: p(2), summaryText: "s2", summaryPath: fileOf("/s2.md") });
  }

  it("baseline present: the last child's summary ARMS the acceptance gate and WITHHOLDS notifyDone", () => {
    const out = driveBaselineSplitToLastSummary();
    // FALSIFIABLE (the headline test): remove the `next.baseline_ && !next.acceptance_` guard in
    // advanceAfterSummary (so the root finalizes unconditionally) → notifyDone fires here and the
    // gate is never armed → BOTH assertions below go RED.
    const kinds = out.effects.map((e) => e.kind);
    expect(kinds).toContain("notifyAcceptanceReview");
    expect(kinds).not.toContain("notifyDone");
    // The root is PARKED in its acceptance window (running-children, all children summarized) — NOT
    // summarized — so treeIsDone is false while the gate is open.
    expect(out.state.root.state.stage).toBe("split");
    expect(out.state.root.state.phase).toBe("running-children");
    expect(inAcceptanceWindow(out.state.root)).toBe(true);
    expect(treeIsDone(out.state.root)).toBe(false);
    // The transient gate is held; the snapshot surfaces it.
    expect(out.state.pendingAcceptance).not.toBeNull();
    expect(toSnapshot2(out.state).pendingAcceptance).not.toBeNull();
    // assertCoherent2 holds in the parked shape (it ran inside reduce2 already, but pin it).
    expect(() => assertCoherent2(out.state.root)).not.toThrow();
    // No verdict recorded yet.
    expect(out.state.acceptance_).toBeUndefined();
  });

  it("NO baseline: the last child's summary finalizes IMMEDIATELY (notifyDone, no gate) — unchanged", () => {
    // The common case (no working reference). Drive the SAME 2-child split WITHOUT a baseline.
    let s = splitToFirstChild(2);
    s = cycleChild(s, 1).state;
    s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    const out = cycleChild(s, 2);
    // FALSIFIABLE: if the gate armed on a no-baseline tree, notifyDone would be missing here → RED.
    const kinds = out.effects.map((e) => e.kind);
    expect(kinds).toContain("notifyDone");
    expect(kinds).not.toContain("notifyAcceptanceReview");
    expect(out.state.pendingAcceptance).toBeNull();
    expect(out.state.root.state.phase).toBe("summarized");
    expect(treeIsDone(out.state.root)).toBe(true);
    expect(out.state.acceptance_).toBeUndefined();
    // Effect ordering at the finalize is byte-identical to the pre-Phase-5 last child completion.
    const last = out.effects.slice(-3).map((e) => e.kind);
    expect(last).toEqual(["notifySummaryWritten", "notifyDone", "persist"]);
  });

  it("ACCEPTANCE_APPROVED finalizes the parked root (→ summarized + notifyDone) and records verdict 'approved'", () => {
    const parked = driveBaselineSplitToLastSummary().state;
    const out = reduce2(parked, { type: "ACCEPTANCE_APPROVED", decidedMs: 9001 });
    // The deferred finalize runs now.
    expect(out.state.root.state.phase).toBe("summarized");
    expect(treeIsDone(out.state.root)).toBe(true);
    expect(out.effects.map((e) => e.kind)).toEqual(["persist", "notifyDone"]);
    // The gate clears; the verdict is recorded (no reason on approve).
    expect(out.state.pendingAcceptance).toBeNull();
    expect(out.state.acceptance_).toEqual({ verdict: "approved", decided_ms: 9001 });
    // FALSIFY: drop the finalize (leave the root running-children) → treeIsDone false / notifyDone
    // missing → RED.
  });

  it("ACCEPTANCE_DIVERGED finalizes AND persists the divergence reason (round-tripped through the ledger)", () => {
    const parked = driveBaselineSplitToLastSummary().state;
    const out = reduce2(parked, {
      type: "ACCEPTANCE_DIVERGED",
      reason: "perf below the floor; shipped with a documented follow-up",
      decidedMs: 9002,
    });
    expect(out.state.root.state.phase).toBe("summarized");
    expect(treeIsDone(out.state.root)).toBe(true);
    expect(out.state.pendingAcceptance).toBeNull();
    // The reason is a serializable field recorded on acceptance_.
    expect(out.state.acceptance_).toEqual({
      verdict: "diverged",
      reason: "perf below the floor; shipped with a documented follow-up",
      decided_ms: 9002,
    });
    // ROUND-TRIP: toLedger2 → JSON → rehydrate preserves the verdict + reason exactly.
    const onDisk = JSON.parse(JSON.stringify(toLedger2(out.state)));
    const rehydrated = rehydrateState2(onDisk);
    expect(rehydrated.acceptance_).toEqual({
      verdict: "diverged",
      reason: "perf below the floor; shipped with a documented follow-up",
      decided_ms: 9002,
    });
    // FALSIFY: drop `reason` from the ACCEPTANCE_DIVERGED record (or from toLedger2's acceptance_
    // copy) → the reason is lost on round-trip → RED.
  });

  it("ACCEPTANCE_APPROVED / ACCEPTANCE_DIVERGED throw when no acceptance gate is open", () => {
    // A no-baseline DONE tree — never parked at the gate.
    let s = splitToFirstChild(2);
    s = cycleChild(s, 1).state;
    s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    s = cycleChild(s, 2).state;
    expect(s.pendingAcceptance).toBeNull();
    expect(() => reduce2(s, { type: "ACCEPTANCE_APPROVED", decidedMs: 1 })).toThrow(
      /no acceptance gate is open/,
    );
    expect(() => reduce2(s, { type: "ACCEPTANCE_DIVERGED", reason: "x", decidedMs: 1 })).toThrow(
      /no acceptance gate is open/,
    );
  });

  it("assertCoherent2 holds at EVERY reduce across the baseline split run AND through the gate resolution", () => {
    const children = [
      { nn: nnOf(1), title: "A" },
      { nn: nnOf(2), title: "B" },
    ];
    let s = genesisWithBaseline2();
    const events: PlanTreeEvent2[] = [
      { type: "NODE_RECON_DONE", path: [] },
      { type: "SIZER_DONE", path: [], outcome: sizer("split", 2) },
      { type: "DECOMPOSITION_DRAFTED", path: [], planPath: "/pt/master.md", plansDirPath: "/plans/master.md", toolUseId: "m1" },
      { type: "CHILDREN_PARSED", path: [], children },
      { type: "DECOMPOSITION_APPROVED", path: [] },
      { type: "NODE_RECON_DONE", path: p(1) },
      { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(1), toolUseId: "tu1", planPath: "/p1.md", plansDirPath: "/d1" },
      { type: "APPROVE", path: p(1) },
      { type: "EXEC_DONE", path: p(1) },
      { type: "SUMMARY_WRITTEN", path: p(1), summaryText: "s1", summaryPath: fileOf("/s1.md") },
      { type: "PARENT_REVIEW_DONE", path: [], note: null },
      { type: "NODE_RECON_DONE", path: p(2) },
      { type: "SIZER_DONE", path: p(2), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(2), toolUseId: "tu2", planPath: "/p2.md", plansDirPath: "/d2" },
      { type: "APPROVE", path: p(2) },
      { type: "EXEC_DONE", path: p(2) },
      { type: "SUMMARY_WRITTEN", path: p(2), summaryText: "s2", summaryPath: fileOf("/s2.md") },
      // The gate is now armed; the verdict resolves it.
      { type: "ACCEPTANCE_APPROVED", decidedMs: 1 },
    ];
    for (const ev of events) {
      s = reduce2(s, ev).state;
      expect(() => assertCoherent2(s.root)).not.toThrow();
    }
    expect(treeIsDone(s.root)).toBe(true);
  });
});

// ---- PHASE 6: the forced-acceptance REFINE (re-plan) branch -----------------------------------

describe("gen-2 forced-acceptance refine (re-plan) branch", () => {
  // Reuse the prototype-gate → baseline genesis path so the baseline is recorded through the REAL
  // arc (not by hand-injecting baseline_).
  function protoGateFix(): PrototypeGate {
    return {
      kind: "html",
      paths: ["index.html"],
      screenshot: null,
      inlinePreview: null,
      variants: [],
      round: 1,
      cwd: "/cwd",
    };
  }
  function genesisWithBaseline2(): PlanTreeState2 {
    const reviewing = reduce2(genesisIntent2(), { type: "PROTOTYPE_READY", gate: protoGateFix() }).state;
    const s = reduce2(reviewing, {
      type: "PROTOTYPE_APPROVED",
      intentContents: "the confirmed intent",
      asWorkingReference: true,
      frozenMs: 7777,
    }).state;
    if (!s.baseline_) throw new Error("fixture: baseline_ not recorded");
    return s;
  }

  // Drive a baseline-bearing N-child split to the gate ARMED (root parked in the acceptance window,
  // pendingAcceptance held). Each child runs recon→sizer(single)→draft→approve→exec→summary, with a
  // parent review between siblings (the real arc).
  function driveBaselineSplitToGate(n: number): PlanTreeState2 {
    const children = Array.from({ length: n }, (_, i) => ({ nn: nnOf(i + 1), title: `Sub ${i + 1}` }));
    let s = run2(genesisWithBaseline2(), [
      { type: "NODE_RECON_DONE", path: [] },
      { type: "SIZER_DONE", path: [], outcome: sizer("split", n) },
      { type: "DECOMPOSITION_DRAFTED", path: [], planPath: "/pt/master.md", plansDirPath: "/plans/master.md", toolUseId: "m1" },
      { type: "CHILDREN_PARSED", path: [], children },
      { type: "DECOMPOSITION_APPROVED", path: [] },
    ]).state;
    for (let k = 1; k <= n; k++) {
      s = cycleChild(s, k).state;
      if (k < n) s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    }
    return s;
  }

  // The coarse status of a root child (summarized / active-or-pending), for partition assertions.
  function childPhase(s: PlanTreeState2, n: number): { stage: string; phase: string } {
    const c = child(s, n);
    return { stage: c.state.stage, phase: c.state.phase };
  }

  it("HEADLINE: ACCEPTANCE_REFINED resets target + right-siblings to open/pending, left-siblings stay summarized, gate cleared, no verdict, assertCoherent2 PASSES", () => {
    // 3-child gate. Refine the MIDDLE child (02): 01 (left) stays summarized; 02 (target) → recon
    // (active); 03 (right sibling) → pending.
    const parked = driveBaselineSplitToGate(3);
    expect(inAcceptanceWindow(parked.root)).toBe(true);
    expect(parked.pendingAcceptance).not.toBeNull();

    const out = reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(2) });

    // Left sibling 01 is UNTOUCHED (still summarized).
    expect(childPhase(out.state, 1)).toEqual({ stage: "leaf", phase: "summarized" });
    // Target 02 is reset to ACTIVE (open/recon) so it re-executes.
    expect(childPhase(out.state, 2)).toEqual({ stage: "open", phase: "recon" });
    // Right sibling 03 is reset to fresh open/pending.
    expect(childPhase(out.state, 3)).toEqual({ stage: "open", phase: "pending" });
    // The reset nodes are FRESH (artifact-free): redraftCount 0, no lastFeedback (makeNode2 shape).
    expect(child(out.state, 2).redraftCount).toBe(0);
    expect(child(out.state, 2).lastFeedback).toBeNull();
    expect(child(out.state, 3).redraftCount).toBe(0);
    // The active node is now the target (re-execution resumes there).
    expect(activePathOf(out.state.root)).toEqual(p(2));
    // The gate is CLEARED (back to executing) and NO verdict was recorded.
    expect(out.state.pendingAcceptance).toBeNull();
    expect(out.state.acceptance_).toBeUndefined();
    // The baseline is STILL present (a refine never drops it — the gate must re-arm on re-completion).
    expect(out.state.baseline_).toEqual({ frozen: true, frozen_ms: 7777 });
    // The shape is a coherent `summarized* active pending*` partition.
    expect(() => assertCoherent2(out.state.root)).not.toThrow();
    expect(treeIsDone(out.state.root)).toBe(false);

    // FALSIFIABILITY (the headline guarantee): a tree that left a RIGHT-sibling summarized after the
    // target reset is NOT a coherent partition — assertCoherent2 throws ("summarized child ... right
    // of a non-summarized sibling"). This pins that the reset MUST sweep right-siblings, not just the
    // target. Hand-build the broken shape: 01 summarized, 02 recon (active), 03 LEFT summarized.
    const root = out.state.root;
    if (root.state.stage !== "split") throw new Error("fixture: root not split");
    const broken: TreeNode = {
      ...root,
      state: {
        ...root.state,
        children: [
          root.state.children[0], // 01 summarized (ok)
          root.state.children[1], // 02 recon (active)
          child(parked, 3), // 03 the ORIGINAL summarized node (right of the active target — illegal)
        ] as unknown as typeof root.state.children,
      },
    };
    expect(() => assertCoherent2(broken)).toThrow(/summarized child .* right of a non-summarized sibling/);
  });

  it("ACCEPTANCE_REFINED emits a deletePlanTreeFile for EACH reset node's NN-plan.md AND NN-summary.md, and nothing for left-siblings", () => {
    const parked = driveBaselineSplitToGate(3);
    const out = reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(2) });
    const deletes = out.effects
      .filter((e): e is Extract<Effect2, { kind: "deletePlanTreeFile" }> => e.kind === "deletePlanTreeFile")
      .map((e) => e.name);
    // Target 02 + right-sibling 03 → both their plan + summary files; NOTHING for left-sibling 01.
    expect(deletes).toEqual([
      planName2(p(2)),
      summaryName2(p(2)),
      planName2(p(3)),
      summaryName2(p(3)),
    ]);
    expect(deletes).not.toContain(planName2(p(1)));
    expect(deletes).not.toContain(summaryName2(p(1)));
    // Every emitted delete name is an allow-listed NN-(plan|summary).md shape (containment-guardable).
    for (const name of deletes) {
      expect(name).toMatch(/^\d{2}-(plan|summary)\.md$/);
    }
    // The reducer persists at the end.
    expect(out.effects.map((e) => e.kind)).toContain("persist");
  });

  // Drive a baseline-bearing root split where the TARGET root child (01) is itself a SPLIT (depth-2:
  // grandchildren 01.01/01.02 rolled up under 01), and a sibling root child (02) is a leaf — then
  // park at the acceptance gate. This is the SPLIT-target refine case Phase 6's stale-summary cleanup
  // must cover at the SUBTREE level (the direct-key drop alone leaks 01.01/01.02).
  function driveBaselineWithSplitChildToGate(): PlanTreeState2 {
    let s = run2(genesisWithBaseline2(), [
      { type: "NODE_RECON_DONE", path: [] },
      { type: "SIZER_DONE", path: [], outcome: sizer("split", 2) },
      { type: "DECOMPOSITION_DRAFTED", path: [], planPath: "/pt/master.md", plansDirPath: "/plans/master.md", toolUseId: "m0" },
      { type: "CHILDREN_PARSED", path: [], children: [{ nn: nnOf(1), title: "Sub 1 (split)" }, { nn: nnOf(2), title: "Sub 2 (leaf)" }] },
      { type: "DECOMPOSITION_APPROVED", path: [] },
      // Root child 01 is a SPLIT: it decomposes into grandchildren 01.01 + 01.02.
      { type: "NODE_RECON_DONE", path: p(1) },
      { type: "SIZER_DONE", path: p(1), outcome: sizer("split", 2) },
      { type: "DECOMPOSITION_DRAFTED", path: p(1), planPath: "/pt/01-plan.md", plansDirPath: "/plans/01-plan.md", toolUseId: "m1" },
      { type: "CHILDREN_PARSED", path: p(1), children: [{ nn: nnOf(1), title: "G 1" }, { nn: nnOf(2), title: "G 2" }] },
      { type: "DECOMPOSITION_APPROVED", path: p(1) },
      // Grandchild 01.01 (leaf): recon → sizer(single) → draft → approve → exec → summary.
      { type: "NODE_RECON_DONE", path: p(1, 1) },
      { type: "SIZER_DONE", path: p(1, 1), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(1, 1), toolUseId: "g11", planPath: "/p11.md", plansDirPath: "/d11" },
      { type: "APPROVE", path: p(1, 1) },
      { type: "EXEC_DONE", path: p(1, 1) },
      { type: "SUMMARY_WRITTEN", path: p(1, 1), summaryText: "summary 01.01", summaryPath: fileOf("/s11.md") },
      // Parent (01) review between its grandchildren, then grandchild 01.02.
      { type: "PARENT_REVIEW_DONE", path: p(1), note: null },
      { type: "NODE_RECON_DONE", path: p(1, 2) },
      { type: "SIZER_DONE", path: p(1, 2), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(1, 2), toolUseId: "g12", planPath: "/p12.md", plansDirPath: "/d12" },
      { type: "APPROVE", path: p(1, 2) },
      { type: "EXEC_DONE", path: p(1, 2) },
      { type: "SUMMARY_WRITTEN", path: p(1, 2), summaryText: "summary 01.02", summaryPath: fileOf("/s12.md") },
      // Roll-up: 01's own summary turn (its grandchildren are all summarized) → 01 summarized.
      { type: "SUMMARY_WRITTEN", path: p(1), summaryText: "rollup 01", summaryPath: fileOf("/s1.md") },
      // Root review between 01 and 02, then leaf child 02.
      { type: "PARENT_REVIEW_DONE", path: [], note: null },
      { type: "NODE_RECON_DONE", path: p(2) },
      { type: "SIZER_DONE", path: p(2), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(2), toolUseId: "g2", planPath: "/p2.md", plansDirPath: "/d2" },
      { type: "APPROVE", path: p(2) },
      { type: "EXEC_DONE", path: p(2) },
      { type: "SUMMARY_WRITTEN", path: p(2), summaryText: "summary 02", summaryPath: fileOf("/s2.md") },
    ]).state;
    return s;
  }

  it("DEPTH-2 SPLIT TARGET: refining a root child that is itself a split emits descendant (NN.NN) deletes, not just the direct NN file", () => {
    const parked = driveBaselineWithSplitChildToGate();
    expect(inAcceptanceWindow(parked.root)).toBe(true);
    // PRECONDITION: 01 really is a split with grandchildren (else this test would degenerate to depth-1).
    const targetNode = nodeAtPath(parked.root, p(1));
    if (!targetNode || targetNode.state.stage !== "split") throw new Error("fixture: child 01 is not a split");

    const out = reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(1) });
    const deletes = out.effects
      .filter((e): e is Extract<Effect2, { kind: "deletePlanTreeFile" }> => e.kind === "deletePlanTreeFile")
      .map((e) => e.name);

    // The DIRECT files of the reset nodes (01 = target, 02 = right-sibling) — already covered pre-fix.
    expect(deletes).toContain(planName2(p(1)));
    expect(deletes).toContain(summaryName2(p(1)));
    expect(deletes).toContain(planName2(p(2)));
    expect(deletes).toContain(summaryName2(p(2)));
    // THE FIX: the target's DESCENDANT files (01.01 / 01.02 plan + summary) MUST also be deleted —
    // otherwise the re-decomposition (which may reuse child NNs 01/02) leaves stale 01.NN-summary.md
    // on disk. FALSIFIABLE: drop the `emitDescendantDeletes(sib, sibPath)` call in the reducer and
    // these four go RED (only the direct NN deletes survive).
    expect(deletes).toContain(planName2(p(1, 1)));
    expect(deletes).toContain(summaryName2(p(1, 1)));
    expect(deletes).toContain(planName2(p(1, 2)));
    expect(deletes).toContain(summaryName2(p(1, 2)));
    // Concretely the dotted descendant names (the on-disk shape the driver deletes).
    expect(deletes).toContain("01.01-plan.md");
    expect(deletes).toContain("01.01-summary.md");
    expect(deletes).toContain("01.02-plan.md");
    expect(deletes).toContain("01.02-summary.md");
    // Every delete name is a containment-guardable plan-tree name (dotted NN(.NN)*-(plan|summary).md).
    for (const name of deletes) {
      expect(name).toMatch(/^\d{2}(\.\d{2})*-(plan|summary)\.md$/);
    }
    expect(out.effects.map((e) => e.kind)).toContain("persist");
  });

  it("refining the FIRST child resets ALL children (no left-siblings); refining the LAST resets only it", () => {
    const parked = driveBaselineSplitToGate(3);
    // First child → every child reset; the active node is 01.
    const first = reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(1) }).state;
    expect(childPhase(first, 1)).toEqual({ stage: "open", phase: "recon" });
    expect(childPhase(first, 2)).toEqual({ stage: "open", phase: "pending" });
    expect(childPhase(first, 3)).toEqual({ stage: "open", phase: "pending" });
    expect(activePathOf(first.root)).toEqual(p(1));
    expect(() => assertCoherent2(first.root)).not.toThrow();

    // Last child → only it resets (both left-siblings stay summarized); the active node is 03.
    const last = reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(3) }).state;
    expect(childPhase(last, 1)).toEqual({ stage: "leaf", phase: "summarized" });
    expect(childPhase(last, 2)).toEqual({ stage: "leaf", phase: "summarized" });
    expect(childPhase(last, 3)).toEqual({ stage: "open", phase: "recon" });
    expect(activePathOf(last.root)).toEqual(p(3));
    expect(() => assertCoherent2(last.root)).not.toThrow();
  });

  it("after refine, the reset nodes re-execute and on root re-completion the acceptance gate RE-ARMS (pendingAcceptance set again, notifyDone STILL withheld)", () => {
    const parked = driveBaselineSplitToGate(3);
    let s = reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(2) }).state;
    // refine before any verdict leaves the tree NOT done.
    expect(treeIsDone(s.root)).toBe(false);
    // Re-execute the reset target 02 (it is active in recon), then the parent review activates 03,
    // then 03 re-executes. The LAST reset child's summary is the re-arming reduce.
    s = cycleChild(s, 2).state;
    s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    const out = cycleChild(s, 3);
    const kinds = out.effects.map((e) => e.kind);
    // FALSIFIABLE: drop the baseline (or set acceptance_) before re-completion and the gate would NOT
    // re-arm → notifyDone fires here instead → these go RED.
    expect(kinds).toContain("notifyAcceptanceReview");
    expect(kinds).not.toContain("notifyDone");
    expect(out.state.pendingAcceptance).not.toBeNull();
    expect(inAcceptanceWindow(out.state.root)).toBe(true);
    expect(treeIsDone(out.state.root)).toBe(false);
    // No verdict was ever recorded across the refine + re-run.
    expect(out.state.acceptance_).toBeUndefined();
    // And the RE-ARMED gate can now be approved to done (the deferred finalize still works).
    const done = reduce2(out.state, { type: "ACCEPTANCE_APPROVED", decidedMs: 5 });
    expect(treeIsDone(done.state.root)).toBe(true);
    expect(done.state.acceptance_).toEqual({ verdict: "approved", decided_ms: 5 });
  });

  it("ACCEPTANCE_REFINED throws when NO acceptance gate is open (guard)", () => {
    // A no-baseline DONE tree — never parked at the gate.
    let s = splitToFirstChild(2);
    s = cycleChild(s, 1).state;
    s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    s = cycleChild(s, 2).state;
    expect(s.pendingAcceptance).toBeNull();
    expect(() => reduce2(s, { type: "ACCEPTANCE_REFINED", target: p(1) })).toThrow(
      /no acceptance gate is open/,
    );
  });

  it("ACCEPTANCE_REFINED rejects the root target and a non-direct-child target", () => {
    const parked = driveBaselineSplitToGate(2);
    expect(() => reduce2(parked, { type: "ACCEPTANCE_REFINED", target: [] })).toThrow(/target is the root/);
    expect(() => reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(1, 1) })).toThrow(
      /not a direct root child/,
    );
  });

  it("ACCEPTANCE_REFINED keeps the reducer PURE (input state untouched)", () => {
    const parked = driveBaselineSplitToGate(2);
    const before = JSON.stringify(toLedger2(parked));
    reduce2(parked, { type: "ACCEPTANCE_REFINED", target: p(1) });
    expect(JSON.stringify(toLedger2(parked))).toBe(before);
    // The transient gate on the INPUT is likewise untouched.
    expect(parked.pendingAcceptance).not.toBeNull();
  });
});

// ---- writePolicyFor2 across a full gen-2 run -----------------------------------------------------

describe("gen-2 writePolicyFor2 across a full run", () => {
  it("derives 'prototype' at genesis, 'plan' at every other pre-execution step, 'acceptEdits' only while a leaf executes", () => {
    let s = genesisIntent2();
    // DELIBERATE PIN CHANGE (prototype gate): genesis (clarifying-intent) now derives "prototype"
    // — the intent-clarification window may write throwaway prototype artifacts. Recon onward is
    // "plan" exactly as before.
    expect(writePolicyFor2(s.root)).toBe("prototype"); // clarifying-intent — the prototype window

    s = reduce2(s, { type: "INTENT_CLARIFIED", intent: "i" }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // recon

    s = reduce2(s, { type: "NODE_RECON_DONE", path: [] }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // sizing

    s = reduce2(s, { type: "SIZER_DONE", path: [], outcome: sizer("split", 2) }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // decomposing

    s = reduce2(s, {
      type: "DECOMPOSITION_DRAFTED",
      path: [],
      planPath: "/pt/master.md",
      plansDirPath: "/plans/master.md",
      toolUseId: "m1",
    }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // awaiting-decomposition-approval

    s = reduce2(s, {
      type: "CHILDREN_PARSED",
      path: [],
      children: [
        { nn: nnOf(1), title: "A" },
        { nn: nnOf(2), title: "B" },
      ],
    }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // parsed, still gated

    // THE INCIDENT STATE (gen-1's post-MASTER_APPROVED fix, preserved): right after decomposition
    // approval the active child is in `recon` — the session MUST derive "plan" here.
    s = reduce2(s, { type: "DECOMPOSITION_APPROVED", path: [] }).state;
    expect(child(s, 1).state).toEqual({ stage: "open", phase: "recon" });
    expect(writePolicyFor2(s.root)).toBe("plan");

    s = reduce2(s, { type: "NODE_RECON_DONE", path: p(1) }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // child sizing (PHASE 4: per-node sizer)

    s = reduce2(s, { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.9) }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // child drafting

    s = reduce2(s, {
      type: "NODE_DRAFTED",
      path: p(1),
      toolUseId: "tu1",
      planPath: "/p1.md",
      plansDirPath: "/d1",
    }).state;
    expect(writePolicyFor2(s.root)).toBe("plan"); // child awaiting-approval

    s = reduce2(s, { type: "APPROVE", path: p(1) }).state;
    expect(writePolicyFor2(s.root)).toBe("acceptEdits"); // the ONLY writable state

    s = reduce2(s, { type: "EXEC_DONE", path: p(1) }).state;
    expect(writePolicyFor2(s.root)).toBe("acceptEdits"); // still executing until the summary lands

    s = reduce2(s, { type: "SUMMARY_WRITTEN", path: p(1), summaryText: "s1", summaryPath: fileOf("/s1.md") }).state;
    expect(s.root.state.phase).toBe("reviewing");
    expect(writePolicyFor2(s.root)).toBe("plan"); // PHASE 5: the review window is never writable

    s = reduce2(s, { type: "PARENT_REVIEW_DONE", path: [], note: null }).state;
    expect(child(s, 2).state).toEqual({ stage: "open", phase: "recon" });
    expect(writePolicyFor2(s.root)).toBe("plan"); // advanced to child 2's recon

    s = run2(s, [
      { type: "NODE_RECON_DONE", path: p(2) },
      { type: "SIZER_DONE", path: p(2), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(2), toolUseId: "tu2", planPath: "/p2.md", plansDirPath: "/d2" },
    ]).state;
    expect(writePolicyFor2(s.root)).toBe("plan");
    s = reduce2(s, { type: "APPROVE", path: p(2) }).state;
    expect(writePolicyFor2(s.root)).toBe("acceptEdits");
    s = reduce2(s, { type: "SUMMARY_WRITTEN", path: p(2), summaryText: "s2", summaryPath: fileOf("/s2.md") }).state;
    expect(treeIsDone(s.root)).toBe(true);
    expect(writePolicyFor2(s.root)).toBe("plan"); // terminal done
  });
});

// ---- schema-2 persisted shape pin + projections (gates excluded from the ledger) ----------------

describe("gen-2 projections / persisted shape", () => {
  it("toLedger2 mid-run pins the exact schema-2 key set (no pointer, no subplans, no transients)", () => {
    let s = splitToFirstChild(2);
    s = run2(s, [
      { type: "NODE_RECON_DONE", path: p(1) },
      { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.9) },
      { type: "NODE_DRAFTED", path: p(1), toolUseId: "tu1", planPath: "/p1.md", plansDirPath: "/d1" },
    ]).state;
    expect(s.pendingApproval).not.toBeNull();

    const ledger = toLedger2(s);
    // THE PERSISTED SHAPE PIN: schema 2 is {schema, tree_id, created_ms, updated_ms, root,
    // sdk_session_id, baseline_, acceptance_} and NOTHING else — pointer/subplans are gone; transient
    // gates never serialize. (sdk_session_id is the additive resume-support field; baseline_ the
    // additive working-reference field; acceptance_ the Phase-5 additive acceptance-verdict field —
    // all undefined here, omitted by JSON.stringify.)
    // Mutation: leak pendingApproval/pendingAcceptance (or a pointer field) into toLedger2 → RED.
    expect(Object.keys(ledger).sort()).toEqual([
      "acceptance_",
      "baseline_",
      "created_ms",
      "root",
      "schema",
      "sdk_session_id",
      "tree_id",
      "updated_ms",
    ]);
    expect(ledger.schema).toBe(2);
    expect(Object.keys(ledger.root).sort()).toEqual(["lastFeedback", "nn", "redraftCount", "state", "title"]);

    const snap = toSnapshot2(s);
    expect(snap.pendingApproval).toEqual(s.pendingApproval);
    expect(snap.pendingClarify).toBeNull();
    expect(snap.activePath).toEqual(p(1));
    expect(snap.writePolicy).toBe("plan");
    expect(snap.done).toBe(false);
  });
});

// ---- summaryName2 -------------------------------------------------------------------------------

describe("summaryName2", () => {
  it("single segment keeps the legacy flat name; deeper paths are dotted", () => {
    // Mutation: emit '01.00-summary.md' or unpadded segments → RED (the Rust validator's
    // SEG('.'SEG)*-summary.md shape requires exactly-two-digit segments).
    expect(summaryName2(p(1))).toBe("01-summary.md");
    expect(summaryName2(p(99))).toBe("99-summary.md");
    expect(summaryName2(p(2, 1))).toBe("02.01-summary.md");
    expect(summaryName2(p(2, 1, 3))).toBe("02.01.03-summary.md");
  });

  it("throws loudly for the root path (the root writes no roll-up summary)", () => {
    expect(() => summaryName2([])).toThrow();
  });
});

// ---- PHASE 4: the depth guard is GONE — deep events are legal; mis-addressed ones still throw ----

describe("gen-2 depth unlock (Phase 4 — the requireDepth1 guard is deleted)", () => {
  it("a non-root SIZER_DONE is LEGAL: single makes the node ITSELF the leaf (no collapse child)", () => {
    let s = splitToFirstChild(2);
    s = reduce2(s, { type: "NODE_RECON_DONE", path: p(1) }).state;
    expect(child(s, 1).state).toEqual({ stage: "open", phase: "sizing" });
    const out = reduce2(s, { type: "SIZER_DONE", path: p(1), outcome: sizer("single", 1, 0.9) });
    // FALSIFIED 2026-06-11: routing a non-root confident single through the root collapse (minting
    // a child "Plan" under 01) turns the leaf assertion RED (01 becomes a split). The node ITSELF
    // is the leaf — no child is minted.
    expect(child(out.state, 1).state).toEqual({
      stage: "leaf",
      phase: "drafting",
      planPath: null,
      summaryPath: null,
      plansDirPath: null,
    });
  });

  it("a non-root SIZER_DONE split routes the node to open/decomposing (its own decomposition turn)", () => {
    let s = splitToFirstChild(2);
    s = reduce2(s, { type: "NODE_RECON_DONE", path: p(1) }).state;
    const out = reduce2(s, { type: "SIZER_DONE", path: p(1), outcome: sizer("split", 2, 0.9) });
    expect(child(out.state, 1).state).toEqual({ stage: "open", phase: "decomposing" });
  });

  it("events addressing a non-active node throw (the gen-1 requirePointer mirror)", () => {
    const s = splitToFirstChild(2);
    // Child 1 is active (open/recon); addressing child 2 must throw.
    expect(() => reduce2(s, { type: "NODE_RECON_DONE", path: p(2) })).toThrow();
  });
});

// ---- CLARIFY_ANSWERED gate/no-gate id fallback ---------------------------------------------------

describe("gen-2 CLARIFY_ANSWERED", () => {
  it("uses the event toolUseId when no gate is pending, the gate's when one is", () => {
    const sample = { q1: "yes", q2: ["a", "b"] };

    const noGate = genesis2();
    expect(noGate.pendingClarify).toBeNull();
    const a = reduce2(noGate, { type: "CLARIFY_ANSWERED", toolUseId: "q-x", answers: sample });
    expect(a.state.pendingClarify).toBeNull();
    expect(a.effects).toContainEqual({
      kind: "resolvePermission",
      id: "q-x",
      allow: true,
      message: JSON.stringify({ answers: sample }),
    });

    const gated: PlanTreeState2 = { ...genesis2(), pendingClarify: { toolUseId: "gate-tu", questions: [] } };
    const b = reduce2(gated, { type: "CLARIFY_ANSWERED", toolUseId: "evt-other", answers: sample });
    expect(b.state.pendingClarify).toBeNull();
    expect(b.effects).toContainEqual({
      kind: "resolvePermission",
      id: "gate-tu",
      allow: true,
      message: JSON.stringify({ answers: sample }),
    });
  });
});

// ---- FATAL ---------------------------------------------------------------------------------------

describe("gen-2 FATAL", () => {
  it("surfaces the error without mutating the ledger", () => {
    const s = splitToFirstChild(2);
    const out = reduce2(s, { type: "FATAL", message: "boom" });
    expect(out.effects).toEqual([{ kind: "notifyFatal", message: "boom" }]);
    expect(out.state.root).toEqual(s.root);
  });
});

// ---- purity: reduce2 never mutates its input -----------------------------------------------------

describe("gen-2 reducer purity", () => {
  it("the input state is byte-identical after a reduce that changes the tree", () => {
    const s = splitToFirstChild(2);
    const frozen = JSON.parse(JSON.stringify({ root: s.root, key: pathKey(activePathOf(s.root) ?? []) }));
    reduce2(s, { type: "NODE_RECON_DONE", path: p(1) });
    // Mutation: patch the child in place instead of replaceAt-copying → RED.
    expect(JSON.parse(JSON.stringify({ root: s.root, key: pathKey(activePathOf(s.root) ?? []) }))).toEqual(frozen);
  });
});

// ================================================================================================
// Gen-1 survivors — clusters ported VERBATIM-IN-INTENT from the deleted plan-tree.test.ts. They
// test surfaces the cutover kept (SizerOutcome, parseSizerDecision) or generalized (the driver-
// written plan-tree filenames, now summaryName2/recon.md/master.md driver writes).
// ================================================================================================

// ---- the sizer is TWO-OUTCOME — `escalate` is unrepresentable at the type level ----------------

describe("two-outcome sizer (escalate unrepresentable)", () => {
  it("a SizerOutcome with decision `escalate` does not compile (compile-proof, pinned by @ts-expect-error)", () => {
    // COMPILE-PROOF: the decision union is exactly "single" | "split". If `escalate` is ever
    // re-added to the union, the @ts-expect-error below becomes unnecessary and `npx tsc --noEmit`
    // FAILS with TS2578 — so this pin is falsifiable in both directions.
    // @ts-expect-error -- "escalate" was removed from SizerOutcome["decision"] (two-outcome sizer)
    const bad: SizerOutcome = { decision: "escalate", confidence: 0, num_plans: 0 };
    expect(bad.decision).toBe("escalate");
  });
});

// ---- parseSizerDecision -------------------------------------------------------------------------

describe("parseSizerDecision", () => {
  it("extracts split/3/0.82 from a SIZER line", () => {
    expect(parseSizerDecision("SIZER: split / 3 / 0.82")).toEqual({
      decision: "split",
      num_plans: 3,
      confidence: 0.82,
    });
  });

  it("returns null for a non-matching line", () => {
    // Mutation: returning a default outcome instead of null → RED here.
    expect(parseSizerDecision("just some assistant prose")).toBeNull();
  });

  it("returns null for a SIZER line with an unknown decision word (e.g. a stale `escalate`)", () => {
    // The two-outcome sizer parses ONLY single/split; the driver coerces a null parse to split.
    // (Mutation: widening the regex back to (single|split|escalate) → a parsed outcome here → RED.)
    expect(parseSizerDecision("SIZER: escalate / 0 / 0.3")).toBeNull();
  });
});

// ---- every plan-tree file name the system writes is a Rust-valid plan-tree name -----------------
//
// THE FRONTEND↔RUST FILENAME CONTRACT (the gap that shipped the halt-after-recon bug). The frontend
// unit tests mock writePlanTreeFile, so the names handed to the Rust validator were never exercised
// against the validator's allow-list. The real bug: the recon boundary writes `recon.md`, the Rust
// `valid_plan_tree_name` rejected it, and the throw aborted the effect loop before persist/the next
// prompt — the run stalled at recon.
//
// GEN-2 SHAPE OF THE SAME CONTRACT: the reducer emits writePlanTreeFile ONLY for INTENT.md (the one
// text-carrying event left); recon.md, master.md, state.json and summaryName2(path) are DRIVER
// writes (the driver-write boundary). This test mirrors the Rust allow-list
// (src-tauri/src/plan_tree.rs::valid_plan_tree_name) and asserts BOTH the reducer-emitted name and
// every driver-written name pass it. If a future control file is added without widening the Rust
// allow-list, this test goes red BEFORE the run can halt in production.
//
// Falsifiability: drop `recon.md` from VALID_LITERAL below (mirroring the OLD Rust validator) and
// the `expect(isValidPlanTreeName("recon.md")).toBe(true)` check goes red.
describe("plan-tree filename contract (frontend ↔ Rust)", () => {
  // Mirror of src-tauri/src/plan_tree.rs::valid_plan_tree_name. Kept literally in sync with the
  // Rust LITERAL_PLAN_TREE_NAMES + the NN-(plan|summary).md hand-parser. If the Rust side widens or
  // narrows, update BOTH (the Rust test accepts_every_orchestrator_emitted_name guards the other side).
  const VALID_LITERAL = new Set(["state.json", "INTENT.md", "recon.md", "master.md"]);
  function isValidPlanTreeName(name: string): boolean {
    if (VALID_LITERAL.has(name)) return true;
    // SEG("."SEG)*-(plan|summary).md (Phase-2 dotted Rust validator): dot-joined exactly-two-digit
    // segments, a hyphen, then `plan` or `summary`, then `.md`. Flat legacy is the 1-segment case.
    return /^\d\d(\.\d\d)*-(plan|summary)\.md$/.test(name);
  }

  it("the reducer emits INTENT.md; the driver writes state.json, recon.md, master.md + summaryName2 — all Rust-valid", () => {
    // The ONE reducer-emitted writePlanTreeFile name left in gen 2 (INTENT_CLARIFIED).
    const out = reduce2(genesisIntent2(), { type: "INTENT_CLARIFIED", intent: "i" });
    const emitted = out.effects.filter((e) => e.kind === "writePlanTreeFile").map((e) => e.name);
    expect(emitted).toEqual(["INTENT.md"]);

    // EVERY driver-written name (state.json at persist; recon.md at the root recon boundary;
    // master.md at the decomposition draft; summaryName2(path) at the summary boundary) must pass
    // the Rust allow-list mirror. summaryName2 is total over single-segment paths (1-99 zero-pads
    // to two digits), so probe its range edges.
    expect(summaryName2(p(1))).toBe("01-summary.md");
    const driverWritten = [
      "state.json",
      "recon.md",
      "master.md",
      summaryName2(p(1)),
      summaryName2(p(3)),
      summaryName2(p(99)),
      // PHASE 4 nested driver writes: dotted roll-up summaries + nested decomposition plans.
      summaryName2(p(2, 1)),
      planName2(p(2)),
      planName2(p(2, 1)),
    ];
    for (const name of [...emitted, ...driverWritten]) {
      expect(isValidPlanTreeName(name)).toBe(true);
    }
  });

  it("the Rust mirror still rejects unsafe names (the widening did not open a hole)", () => {
    for (const bad of ["../x", "/etc/passwd", "a/b.md", "", "..", ".hidden", "recon", "1-plan.md"]) {
      expect(isValidPlanTreeName(bad)).toBe(false);
    }
  });
});

// ---- SESSION_INITIALIZED (resume support: ledger self-stamps the SDK session_id) --------------
//
// Falsifiability hook: removing the `effects.push({ kind: "persist" })` in the SESSION_INITIALIZED
// arc makes the "emits a single persist" assertion FAIL; removing the `next.sdk_session_id =`
// assignment makes the "toLedger2 carries it" assertion FAIL; dropping the
// `event.sessionId !== next.sdk_session_id` idempotency guard makes the re-dispatch "no persist /
// no change" assertions FAIL. (Verified by temporarily reverting each — see task report.)
describe("gen-2 SESSION_INITIALIZED (sdk_session_id self-persist)", () => {
  it("stamps sdk_session_id onto the ledger and emits exactly one persist effect", () => {
    const out = reduce2(genesis2(), { type: "SESSION_INITIALIZED", sessionId: "sess-abc" });
    expect(toLedger2(out.state).sdk_session_id).toBe("sess-abc");
    expect(out.effects).toEqual([{ kind: "persist" }]);
  });

  it("is idempotent: re-dispatching the SAME id is a no-op (no persist, no change)", () => {
    const once = reduce2(genesis2(), { type: "SESSION_INITIALIZED", sessionId: "sess-abc" }).state;
    const again = reduce2(once, { type: "SESSION_INITIALIZED", sessionId: "sess-abc" });
    expect(again.effects).toEqual([]);
    expect(toLedger2(again.state)).toEqual(toLedger2(once));
    expect(again.state.sdk_session_id).toBe("sess-abc");
  });

  it("an empty id is a no-op (no persist, field stays undefined)", () => {
    const out = reduce2(genesis2(), { type: "SESSION_INITIALIZED", sessionId: "" });
    expect(out.effects).toEqual([]);
    expect(out.state.sdk_session_id).toBeUndefined();
  });

  it("a NEW non-empty id overwrites a prior one and persists again (live id wins)", () => {
    const first = reduce2(genesis2(), { type: "SESSION_INITIALIZED", sessionId: "sess-old" }).state;
    const out = reduce2(first, { type: "SESSION_INITIALIZED", sessionId: "sess-new" });
    expect(out.effects).toEqual([{ kind: "persist" }]);
    expect(toLedger2(out.state).sdk_session_id).toBe("sess-new");
  });

  it("touches NO node state and NO transient gate (pure run-level stamp)", () => {
    const before = genesis2();
    const out = reduce2(before, { type: "SESSION_INITIALIZED", sessionId: "sess-abc" });
    expect(out.state.root).toEqual(before.root);
    expect(activePathOf(out.state.root)).toEqual(activePathOf(before.root));
    expect(out.state.pendingApproval).toBe(before.pendingApproval);
    expect(out.state.pendingClarify).toBe(before.pendingClarify);
  });

  it("an old state.json with the field ABSENT deserializes (additive, schema stays 2)", () => {
    // A schema-2 ledger written BEFORE sdk_session_id existed (the field is simply absent).
    const legacy = JSON.stringify({
      schema: 2,
      tree_id: "t2",
      created_ms: 1,
      updated_ms: 1,
      root: genesis2().root,
    });
    const parsed = JSON.parse(legacy) as RecursiveLedger;
    expect(parsed.schema).toBe(2);
    expect(parsed.sdk_session_id).toBeUndefined();
  });
});
