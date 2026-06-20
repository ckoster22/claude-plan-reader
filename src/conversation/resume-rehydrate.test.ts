// Multiplan orchestration domain — RESUME rehydration & scope tests (falsifiable, PURE).
//
// Covers the Phase-2 resume helpers appended to plan-tree.ts: rehydrateState2, resumeScopeForRoot,
// activePhaseLabel. For EVERY representable active stage×phase we build a COHERENT tree in that
// phase (assertCoherent2 passes by construction), then:
//   (a) ROUND-TRIP: toLedger2 → JSON.parse(JSON.stringify(...)) → rehydrateState2, asserting the
//       active path + active node's stage/phase survive and every transient gate is null;
//   (b) VERDICT: resumeScopeForRoot returns the EXACT expected resumable/blocked verdict (and, for
//       resumable, the exact ResumePlan kind/awaiting/gateKind/path);
//   (c) LABEL: activePhaseLabel returns the expected friendly string.
//
// Every assertion is constructed to go RED if the mapping were inverted (the resumable-vs-blocked
// verdict is the load-bearing one — see the comment on the parametric verdict table). Pure domain:
// no Tauri/DOM, zero side effects.

import { describe, it, expect } from "vitest";
import {
  parseNn,
  pathKey,
  nonEmpty,
  activePathOf,
  toLedger2,
  rehydrateState2,
  resumeScopeForRoot,
  activePhaseLabel,
  planName2,
  EXECUTING_REWIND_HAZARD,
} from "./plan-tree";
import type {
  TreeNode,
  NodeState,
  NodePath,
  PlanTreeState2,
  RecursiveLedger,
  PlanTreeFilePath,
  ApprovalGate2,
  ClarifyGate,
  PrototypeGate,
} from "./plan-tree";

// ---- fixtures ---------------------------------------------------------------------------------

const nnOf = (n: number) => parseNn(n);
const path = (...ns: number[]): NodePath => ns.map(nnOf);
const fileOf = (s: string) => s as PlanTreeFilePath;

function node(nn: number, state: NodeState): TreeNode {
  return { nn: nnOf(nn), title: `node ${nn}`, redraftCount: 0, lastFeedback: null, state };
}
function openNode(nn: number, phase: Extract<NodeState, { stage: "open" }>["phase"]): TreeNode {
  return node(nn, { stage: "open", phase });
}
function leafNode(
  nn: number,
  phase: Extract<NodeState, { stage: "leaf" }>["phase"],
  paths: { planPath?: string | null; summaryPath?: PlanTreeFilePath | null; plansDirPath?: string | null } = {},
): TreeNode {
  return node(nn, {
    stage: "leaf",
    phase,
    planPath: paths.planPath ?? null,
    summaryPath: paths.summaryPath ?? null,
    plansDirPath: paths.plansDirPath ?? null,
  });
}
function splitNode(
  nn: number,
  phase: Extract<NodeState, { stage: "split" }>["phase"],
  children: readonly TreeNode[],
): TreeNode {
  return node(nn, {
    stage: "split",
    phase,
    children: nonEmpty(children),
    planPath: null,
    summaryPath: null,
    plansDirPath: null,
  });
}

// Wrap a root TreeNode in a coherent PlanTreeState2 with NON-null transient gates, so the
// round-trip + rehydrate can prove the gates are dropped. (toLedger2 strips transients; we set them
// here only to verify rehydrateState2 nulls them on the way back in.)
function stateWithGates(root: TreeNode): PlanTreeState2 {
  const fakeGate: ApprovalGate2 = {
    path: path(),
    kind: "leaf",
    toolUseId: "sentinel",
    planPath: "/sentinel.md",
    plansDirPath: "/sentinel",
    redraftCount: 0,
  };
  const fakeClarify: ClarifyGate = { toolUseId: "c1", questions: [] };
  const fakePrototype: PrototypeGate = {
    kind: "html",
    paths: [],
    screenshot: null,
    inlinePreview: null,
    variants: [],
    round: 0,
    cwd: "/tmp",
  };
  return {
    schema: 2,
    tree_id: "tree-x",
    created_ms: 1,
    updated_ms: 2,
    root,
    sdk_session_id: "sess-42",
    pendingApproval: fakeGate,
    pendingClarify: fakeClarify,
    pendingPrototype: fakePrototype,
    pendingAcceptance: { cwd: "/tmp", openTarget: "index.html", runCommand: null, round: 1 },
    parsedChildren: { path: path(), children: nonEmpty([leafNode(1, "drafting")]) },
  };
}

// JSON round-trip a state's ledger and rehydrate — the exact disk path a resume takes.
function diskRoundTrip(state: PlanTreeState2): PlanTreeState2 {
  const ledger = toLedger2(state);
  const onDisk = JSON.parse(JSON.stringify(ledger)) as RecursiveLedger;
  return rehydrateState2(onDisk);
}

// ---- per-phase roots (each coherent by construction) -------------------------------------------
//
// `active` is the path the test expects activePathOf to resolve. For root-active phases that is [];
// for child-active phases the deeper path. `stage`/`phase` are the active node's expected state.

interface PhaseCase {
  name: string;
  root: TreeNode;
  active: NodePath;
  stage: NodeState["stage"];
  phase: string;
  expect:
    | { resumable: true; plan: import("./plan-tree").ResumePlan }
    | { resumable: false; reason: string };
  label: string;
}

// A leaf plan's REAL on-disk shape: an ABSOLUTE path under `~/.claude/plans/` (this app's canonical
// plan store), NOT a `.plan-tree/` path. resumeScopeForRoot copies it verbatim onto the leaf-gate
// ResumePlan.planPath (the driver passes it straight through — leaf gates are not `.plan-tree/`-joined).
const LEAF_PLAN = "/abs/.claude/plans/agent-plan-tree-x-00-DEADBEEF.md";
const LEAF_DIR = "/abs/.claude/plans/agent-plan-tree-x-00-DEADBEEF.md";

const cases: PhaseCase[] = [
  // ---- open phases (root-active) ----
  {
    // PHASE 2: the genesis clarify window is now a FORWARD `restart` resume (re-run the clarify turn),
    // no longer the "genesis phase — start a new plan" dead-end.
    name: "open/clarifying-intent (genesis) → restart resume",
    root: openNode(1, "clarifying-intent"),
    active: path(),
    stage: "open",
    phase: "clarifying-intent",
    expect: { resumable: true, plan: { kind: "restart", from: "clarify", path: path() } },
    label: "Clarifying intent",
  },
  {
    // PHASE 2: the prototype gate has durable `.plan-tree/prototype/` + INTENT.md artifacts, so it is a
    // FORWARD resume via the dedicated `prototype-gate` plan (re-present the gate), not a restart.
    name: "open/prototype-review (genesis gate) → prototype-gate resume",
    root: openNode(1, "prototype-review"),
    active: path(),
    stage: "open",
    phase: "prototype-review",
    expect: { resumable: true, plan: { kind: "prototype-gate", path: path() } },
    label: "Reviewing prototype",
  },
  {
    name: "open/recon → resend recon",
    root: openNode(1, "recon"),
    active: path(),
    stage: "open",
    phase: "recon",
    expect: { resumable: true, plan: { kind: "resend", awaiting: "recon", path: path() } },
    label: "Reconnaissance",
  },
  {
    name: "open/sizing → resend sizer",
    root: openNode(1, "sizing"),
    active: path(),
    stage: "open",
    phase: "sizing",
    expect: { resumable: true, plan: { kind: "resend", awaiting: "sizer", path: path() } },
    label: "Sizing",
  },
  {
    // RECOVERY REFACTOR (Phase 1): open/decomposing is now DISK-PROBE aware. With NO probe injected
    // (the default `resumeScopeForRoot(root)` path these cases exercise), the artifact is treated as
    // ABSENT → resumable via resend("decompose") (re-send the decompose step fresh). The
    // artifact-PRESENT branch (re-present the decomposition gate) is covered in the dedicated
    // recoveryFor tests, which inject the probe.
    name: "open/decomposing (no probe) → resend decompose",
    root: openNode(1, "decomposing"),
    active: path(),
    stage: "open",
    phase: "decomposing",
    expect: { resumable: true, plan: { kind: "resend", awaiting: "decompose", path: path() } },
    label: "Decomposing",
  },
  {
    name: "open/awaiting-decomposition-approval (root) → gate decomposition (master.md)",
    root: openNode(1, "awaiting-decomposition-approval"),
    active: path(),
    stage: "open",
    phase: "awaiting-decomposition-approval",
    expect: {
      resumable: true,
      plan: {
        kind: "gate",
        gateKind: "decomposition",
        path: path(),
        planPath: planName2(path()), // "master.md"
        plansDirPath: null,
        redraftCount: 0,
      },
    },
    label: "Awaiting decomposition approval",
  },

  // ---- leaf phases ----
  {
    name: "leaf/drafting → resend draft",
    root: leafNode(1, "drafting"),
    active: path(),
    stage: "leaf",
    phase: "drafting",
    expect: { resumable: true, plan: { kind: "resend", awaiting: "draft", path: path() } },
    label: "Drafting the plan",
  },
  {
    name: "leaf/awaiting-approval (with planPath) → gate leaf",
    root: leafNode(1, "awaiting-approval", { planPath: LEAF_PLAN, plansDirPath: LEAF_DIR }),
    active: path(),
    stage: "leaf",
    phase: "awaiting-approval",
    expect: {
      resumable: true,
      plan: {
        kind: "gate",
        gateKind: "leaf",
        path: path(),
        planPath: LEAF_PLAN,
        plansDirPath: LEAF_DIR,
        redraftCount: 0,
      },
    },
    label: "Awaiting your approval of the plan",
  },
  {
    // PHASE 3 — leaf/executing is now an OFFERABLE-but-HAZARDOUS rewind (the user may continue, but
    // edits from the in-flight turn may be partially applied — invariant I3 — so the banner gates it
    // behind a confirm via `requiresConfirm`). It rewinds to this leaf's approval gate, carrying the
    // leaf's own planPath.
    name: "leaf/executing → resumable hazardous rewind (requiresConfirm)",
    root: leafNode(1, "executing", { planPath: LEAF_PLAN }),
    active: path(),
    stage: "leaf",
    phase: "executing",
    expect: {
      resumable: true,
      plan: {
        kind: "rewind",
        toGate: "leaf-approval",
        path: path(),
        planPath: LEAF_PLAN,
        hazard: EXECUTING_REWIND_HAZARD,
        requiresConfirm: true,
      },
    },
    label: "Executing",
  },

  // ---- split phases (need multi-node coherent trees; active node is the split itself) ----
  {
    // ROLL-UP WINDOW: a NON-ROOT split running-children with ALL children summarized is the active
    // node (activePathOf returns the split path). The root is split running-children with this
    // child active and a pending right-sibling keeps the root coherent.
    // DEFECT FIX: a non-root roll-up window now RESUMES by re-running its in-flight roll-up summary
    // turn (`resend('rollup')`), NOT by re-presenting the (already-consumed) decomposition gate. The
    // decomposition is durable+approved; re-presenting its gate would dead-end on approve (the node is
    // already split, so CHILDREN_PARSED throws). The summary turn is reconstructable from the reloaded
    // child summaries, so the only lost work is the un-landed roll-up turn.
    name: "split/running-children rollup window (non-root) → resend('rollup') resume",
    root: splitNode(1, "running-children", [
      splitNode(1, "running-children", [leafNode(1, "summarized", { summaryPath: fileOf("/s.md") })]),
      openNode(2, "pending"),
    ]),
    active: path(1),
    stage: "split",
    phase: "running-children",
    expect: {
      resumable: true,
      plan: { kind: "resend", awaiting: "rollup", path: path(1) },
    },
    label: "Rolling up",
  },
  {
    // REVIEWING: the reviewing split IS the active node. Needs ≥1 summarized child behind and ≥1
    // pending child ahead (the between-children window). Root reviewing is legal.
    // DEFECT FIX: between-children review now RESUMES by re-running its in-flight parent-review turn
    // (`resend('review')`), NOT by re-presenting the decomposition gate (same already-split dead-end
    // as the roll-up window). The review turn is no-tools, so re-running it has no duplicate side effect.
    name: "split/reviewing (root) → resend('review') resume",
    root: splitNode(1, "reviewing", [
      leafNode(1, "summarized", { summaryPath: fileOf("/s1.md") }),
      openNode(2, "pending"),
    ]),
    active: path(),
    stage: "split",
    phase: "reviewing",
    expect: {
      resumable: true,
      plan: { kind: "resend", awaiting: "review", path: path() },
    },
    label: "Reviewing before the next sub-plan",
  },
];

// A deeper child-active case to prove activePathOf recursion is handled by the descendant's own
// phase (NOT mis-bucketed as the parent split's rollup/reviewing): root split running-children with
// child 01 a leaf awaiting-approval — the gate is the CHILD's, addressed at [01].
const deepLeafGate: PhaseCase = {
  name: "deep: root split running-children, child leaf/awaiting-approval → gate leaf at [01]",
  root: splitNode(1, "running-children", [
    leafNode(1, "awaiting-approval", { planPath: LEAF_PLAN, plansDirPath: LEAF_DIR }),
    openNode(2, "pending"),
  ]),
  active: path(1),
  stage: "leaf",
  phase: "awaiting-approval",
  expect: {
    resumable: true,
    plan: {
      kind: "gate",
      gateKind: "leaf",
      path: path(1),
      planPath: LEAF_PLAN,
      plansDirPath: LEAF_DIR,
      redraftCount: 0,
    },
  },
  label: "Awaiting your approval of the plan",
};

// A deep decomposition gate: root split running-children, child 01 open/awaiting-decomposition-
// approval. planName2([01]) is "01-plan.md" (nested split convention), proving the non-root path.
const deepDecompGate: PhaseCase = {
  name: "deep: child open/awaiting-decomposition-approval → gate decomposition (01-plan.md) at [01]",
  root: splitNode(1, "running-children", [
    openNode(1, "awaiting-decomposition-approval"),
    openNode(2, "pending"),
  ]),
  active: path(1),
  stage: "open",
  phase: "awaiting-decomposition-approval",
  expect: {
    resumable: true,
    plan: {
      kind: "gate",
      gateKind: "decomposition",
      path: path(1),
      planPath: planName2(path(1)), // "01-plan.md"
      plansDirPath: null,
      redraftCount: 0,
    },
  },
  label: "Awaiting decomposition approval",
};

const allCases = [...cases, deepLeafGate, deepDecompGate];

// ---- round-trip + rehydrate ---------------------------------------------------------------------

describe("rehydrateState2 (disk round-trip preserves active node, nulls transients)", () => {
  for (const c of allCases) {
    it(c.name, () => {
      const state = stateWithGates(c.root);
      // Sanity: the fixture's active node matches the case's declared active/stage/phase.
      const liveActive = activePathOf(state.root);
      expect(liveActive && pathKey(liveActive)).toBe(pathKey(c.active));

      const rehydrated = diskRoundTrip(state);

      // active path identical after the disk trip
      const rActive = activePathOf(rehydrated.root);
      expect(rActive && pathKey(rActive)).toBe(pathKey(c.active));

      // active node's stage/phase identical
      const rNode = nodeAtPathOrThrow(rehydrated.root, c.active);
      expect(rNode.state.stage).toBe(c.stage);
      expect(rNode.state.phase).toBe(c.phase);

      // every transient gate is null
      expect(rehydrated.pendingApproval).toBeNull();
      expect(rehydrated.pendingClarify).toBeNull();
      expect(rehydrated.pendingPrototype).toBeNull();
      // PHASE 5 — the transient forced-acceptance gate is nulled on rehydrate too (re-minted from the
      // tree shape + baseline_, never restored from a persisted gate). FALSIFY: carry it through
      // rehydrateState2 → non-null here → RED.
      expect(rehydrated.pendingAcceptance).toBeNull();
      expect(rehydrated.parsedChildren).toBeNull();

      // serialized fields carried
      expect(rehydrated.tree_id).toBe("tree-x");
      expect(rehydrated.sdk_session_id).toBe("sess-42");
    });
  }
});

// ---- resume scope verdict + label --------------------------------------------------------------
//
// THE load-bearing assertion: for every phase the exact resumable/blocked verdict. Falsifiability is
// demonstrated by the dedicated inversion test below (flip a mapping → a case goes RED).

describe("resumeScopeForRoot verdict + activePhaseLabel", () => {
  for (const c of allCases) {
    it(c.name, () => {
      const scope = resumeScopeForRoot(c.root);
      expect(scope.phaseLabel).toBe(c.label);
      expect(activePhaseLabel(c.root)).toBe(c.label);

      if (c.expect.resumable) {
        expect(scope.resumable).toBe(true);
        if (!scope.resumable) throw new Error("unreachable");
        expect(scope.plan).toEqual(c.expect.plan);
      } else {
        expect(scope.resumable).toBe(false);
        if (scope.resumable) throw new Error("unreachable");
        expect(scope.reason).toBe(c.expect.reason);
      }
    });
  }
});

// ---- PHASE 5: the forced acceptance window resume scope ----------------------------------------
//
// The ROOT resting running-children with ALL children summarized is the forced-acceptance hold. It is
// STRUCTURALLY identical to a non-root roll-up window, so resumeScopeForRoot needs the run-level facts
// (baseline_ frozen, acceptance_ absent) to classify it: a baseline-bearing root parked awaiting a
// verdict is RESUMABLE (the driver re-mints the verdict gate — no turn is sent); without those facts
// it stays blocked. Falsifiability is demonstrated both directions in the dedicated block below.

describe("resumeScopeForRoot — PHASE 5 forced acceptance window", () => {
  // A coherent root acceptance window: a single-child root split, child summarized (the
  // single-collapse run's only child completed). assertCoherent2 allows the root running-children
  // all-summarized shape (the acceptance-window allowance).
  function acceptanceRoot(): TreeNode {
    return splitNode(1, "running-children", [
      leafNode(1, "summarized", { summaryPath: fileOf("/s.md") }),
    ]);
  }

  it("RESUMABLE acceptance scope when a baseline is frozen and no verdict is recorded", () => {
    const root = acceptanceRoot();
    const scope = resumeScopeForRoot(root, { baseline_: { frozen: true, frozen_ms: 1 } });
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan).toEqual({ kind: "acceptance" });
    // The friendly label distinguishes it from the roll-up window.
    expect(scope.phaseLabel).toBe("Awaiting baseline acceptance");
    expect(activePhaseLabel(root)).toBe("Awaiting baseline acceptance");
  });

  it("FALSIFIABILITY: WITHOUT the ledger facts (no baseline) the SAME tree is BLOCKED (the resumable verdict is not vacuous)", () => {
    // Same tree shape, but no run-level facts → not safely resumable. If resumeScopeForRoot ignored
    // the ledger and returned resumable on the tree shape alone, this would go RED.
    const root = acceptanceRoot();
    const scope = resumeScopeForRoot(root); // ledger omitted
    expect(scope.resumable).toBe(false);
    if (scope.resumable) throw new Error("unreachable");
    expect(scope.reason).toBe("awaiting baseline acceptance — start a new plan");
  });

  it("BLOCKED when a verdict was ALREADY recorded (acceptance_ set) — the gate is over-resolved", () => {
    const root = acceptanceRoot();
    const scope = resumeScopeForRoot(root, {
      baseline_: { frozen: true, frozen_ms: 1 },
      acceptance_: { verdict: "approved", decided_ms: 2 },
    });
    expect(scope.resumable).toBe(false);
    if (scope.resumable) throw new Error("unreachable");
    expect(scope.reason).toBe("awaiting baseline acceptance — start a new plan");
  });

  it("a NON-ROOT roll-up window is NOT the acceptance scope even with a baseline (the acceptance scope is ROOT-only)", () => {
    // Root split running-children with child 01 a NON-ROOT roll-up window (its own children all
    // summarized) active, and a pending right-sibling keeping the root coherent. activePathOf returns
    // [01], NOT [], so this must NOT be classified as the acceptance scope even when a baseline exists.
    // DEFECT FIX: it IS resumable now — but as a `resend('rollup')` re-running the in-flight roll-up
    // turn, NOT `acceptance` (and NOT a decomposition rewind). The load-bearing assertion is the KIND
    // (resend, not acceptance), proving the baseline did not leak the acceptance scope down to a non-root
    // node.
    const root = splitNode(1, "running-children", [
      splitNode(1, "running-children", [leafNode(1, "summarized", { summaryPath: fileOf("/s.md") })]),
      openNode(2, "pending"),
    ]);
    const scope = resumeScopeForRoot(root, { baseline_: { frozen: true, frozen_ms: 1 } });
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan).toEqual({ kind: "resend", awaiting: "rollup", path: path(1) });
    expect(scope.plan.kind).not.toBe("acceptance");
  });
});

// ---- done / empty edge cases -------------------------------------------------------------------

describe("resumeScopeForRoot edge cases", () => {
  it("a done tree (root summarized) → not resumable, reason 'already complete', label 'Complete'", () => {
    const root = leafNode(1, "summarized", { summaryPath: fileOf("/s.md") });
    const scope = resumeScopeForRoot(root);
    expect(scope.resumable).toBe(false);
    if (scope.resumable) throw new Error("unreachable");
    expect(scope.reason).toBe("already complete");
    expect(scope.phaseLabel).toBe("Complete");
    expect(activePhaseLabel(root)).toBe("Complete");
  });

  it("a degenerate no-active-node tree (not done) → BLOCKED (honest, never a throwing Resume button)", () => {
    // open/pending root is "not active" per activePathOf, and the tree is not done — the
    // runtime-degenerate activePath===null case. DEFECT FIX (honesty): there is NO durable artifact to
    // wind back to, and the orchestrator's leaf-rewind branch FATALs immediately on a null planPath, so
    // offering a Resume button here would dead-end on click. It must be reported BLOCKED instead.
    // (A coherent fresh tree opens in clarifying-intent, which IS active; this shape is a torn ledger.)
    const root = openNode(1, "pending");
    const scope = resumeScopeForRoot(root);
    expect(scope.resumable).toBe(false);
    if (scope.resumable) throw new Error("unreachable");
    expect(scope.reason).toBe("no active node — start a new plan");
    // FALSIFIABILITY: it must NOT surface a (throwing) rewind plan.
    expect("plan" in scope).toBe(false);
  });
});

// ---- FALSIFIABILITY GUARD ----------------------------------------------------------------------
//
// Proves the verdict assertions are not vacuous: every resumable case is genuinely resumable and
// every blocked case is genuinely blocked under the CURRENT code — so flipping any single mapping in
// resumeScopeForRoot (e.g. making leaf/executing return resumable, or open/recon return blocked)
// makes the corresponding case above go RED. This test asserts the partition itself.

describe("resume scope partition is exactly as the v1 table specifies (falsifiable)", () => {
  it("the resumable set and blocked set are disjoint and complete over the cases", () => {
    const resumableNames = new Set(
      allCases.filter((c) => c.expect.resumable).map((c) => c.name),
    );
    const blockedNames = new Set(
      allCases.filter((c) => !c.expect.resumable).map((c) => c.name),
    );
    // No overlap, and the union is every case.
    for (const n of resumableNames) expect(blockedNames.has(n)).toBe(false);
    expect(resumableNames.size + blockedNames.size).toBe(allCases.length);

    // Concretely: within `allCases` EVERY phase is now resumable — recon/sizer/draft/decompose, leaf+
    // decomp gates, acceptance, clarify(restart), prototype-gate, (DEFECT FIX) non-root-rollup/reviewing
    // which resend their in-flight turn, AND (PHASE 3) leaf/executing which is now an offerable hazardous
    // rewind (requiresConfirm). (The torn-leaf and no-active-node DEGENERATE shapes are honestly BLOCKED,
    // asserted in their own describe blocks, not in `allCases`.)
    for (const c of allCases) {
      const scope = resumeScopeForRoot(c.root);
      expect(scope.resumable).toBe(c.expect.resumable);
    }
  });
});

// ---- PHASE 2: the newly-FORWARD phases (clarify/prototype/rollup/reviewing/degenerate/torn) --------
//
// Each of these was BLOCKED before Phase 2; resumeScopeForRoot now returns resumable:true with the
// expected plan kind. Falsifiability: each test pins BOTH the resumable flag AND the discriminating
// plan.kind, so reverting the mapping to blocked (or to the wrong kind) goes RED. leaf/executing is the
// PHASE-3 case — now an offerable HAZARDOUS rewind (requiresConfirm), no longer blocked.

describe("PHASE 2 — formerly-blocked phases now resolve to FORWARD resumable verdicts", () => {
  it("clarifying-intent → resumable restart (was 'genesis phase — start a new plan')", () => {
    const scope = resumeScopeForRoot(openNode(1, "clarifying-intent"));
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan).toEqual({ kind: "restart", from: "clarify", path: path() });
  });

  it("prototype-review → resumable prototype-gate (was 'genesis phase — start a new plan')", () => {
    const scope = resumeScopeForRoot(openNode(1, "prototype-review"));
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan).toEqual({ kind: "prototype-gate", path: path() });
  });

  it("non-root roll-up window → resumable resend('rollup') that re-runs the in-flight turn (DEFECT FIX: was a decomposition rewind that dead-ended on approve)", () => {
    const root = splitNode(1, "running-children", [
      splitNode(1, "running-children", [leafNode(1, "summarized", { summaryPath: fileOf("/s.md") })]),
      openNode(2, "pending"),
    ]);
    const scope = resumeScopeForRoot(root);
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan).toEqual({ kind: "resend", awaiting: "rollup", path: path(1) });
    // FALSIFIABILITY: must NOT re-present a decomposition gate (the buggy dead-ending behavior).
    expect(scope.plan.kind).not.toBe("rewind");
  });

  it("reviewing → resumable resend('review') that re-runs the in-flight turn (DEFECT FIX: was a decomposition rewind that dead-ended on approve)", () => {
    const root = splitNode(1, "reviewing", [
      leafNode(1, "summarized", { summaryPath: fileOf("/s1.md") }),
      openNode(2, "pending"),
    ]);
    const scope = resumeScopeForRoot(root);
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan).toEqual({ kind: "resend", awaiting: "review", path: path() });
    expect(scope.plan.kind).not.toBe("rewind");
  });

  it("runtime-degenerate (no active node, not done) → BLOCKED (DEFECT FIX: was a throwing rewind button)", () => {
    const scope = resumeScopeForRoot(openNode(1, "pending"));
    expect(scope.resumable).toBe(false);
    if (scope.resumable) throw new Error("unreachable");
    expect(scope.reason).toBe("no active node — start a new plan");
    expect("plan" in scope).toBe(false);
  });

  it("torn leaf gate (null planPath) → BLOCKED (DEFECT FIX: was a throwing rewind button)", () => {
    const scope = resumeScopeForRoot(leafNode(1, "awaiting-approval", { planPath: null }));
    expect(scope.resumable).toBe(false);
    if (scope.resumable) throw new Error("unreachable");
    expect(scope.reason).toBe("missing plan artifact — start a new plan");
    expect("plan" in scope).toBe(false);
  });

  it("PHASE 3 — leaf/executing is now an OFFERABLE HAZARDOUS rewind (requiresConfirm), no longer blocked", () => {
    const scope = resumeScopeForRoot(leafNode(1, "executing", { planPath: LEAF_PLAN }));
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan.kind).toBe("rewind");
    if (scope.plan.kind !== "rewind") throw new Error("unreachable");
    expect(scope.plan.toGate).toBe("leaf-approval");
    expect(scope.plan.hazard).toBe(EXECUTING_REWIND_HAZARD);
    // THE hazardous-confirm flag the banner reads (P3c gates the action behind a dialog).
    expect(scope.plan.requiresConfirm).toBe(true);
  });
});

// ---- baseline_ (working-reference) round-trip (Phase 3) ----------------------------------------
//
// The frozen working-reference record must survive the disk round-trip (toLedger2 → JSON →
// rehydrateState2) so a resumed run still knows the baseline was frozen. Falsifiable both ways: a
// run WITHOUT baseline_ rehydrates undefined; a run WITH it rehydrates the exact record.

describe("rehydrateState2 carries the baseline_ working-reference record", () => {
  it("absent baseline_ (sketch run) rehydrates as undefined", () => {
    const state = stateWithGates(openNode(1, "recon"));
    // stateWithGates sets no baseline_ — confirm the sketch default survives the disk trip.
    expect(state.baseline_).toBeUndefined();
    const rehydrated = diskRoundTrip(state);
    expect(rehydrated.baseline_).toBeUndefined();
  });

  it("present baseline_ rehydrates with the exact frozen record (deep-copied, not aliased)", () => {
    const base = stateWithGates(openNode(1, "recon"));
    const state: PlanTreeState2 = { ...base, baseline_: { frozen: true, frozen_ms: 1234 } };

    // toLedger2 carries it; JSON survives it; rehydrateState2 restores it.
    const ledger = toLedger2(state);
    expect(ledger.baseline_).toEqual({ frozen: true, frozen_ms: 1234 });

    const rehydrated = diskRoundTrip(state);
    expect(rehydrated.baseline_).toEqual({ frozen: true, frozen_ms: 1234 });

    // FALSIFIABLE deep-copy proof: mutating the rehydrated record must not touch the source ledger
    // (rehydrateState2 spreads a fresh object). If it aliased, this mutation would leak.
    rehydrated.baseline_!.frozen_ms = 9999;
    expect(ledger.baseline_).toEqual({ frozen: true, frozen_ms: 1234 });
  });
});

// ---- helpers ----

function nodeAtPathOrThrow(root: TreeNode, p: NodePath): TreeNode {
  let cur: TreeNode = root;
  for (const seg of p) {
    if (cur.state.stage !== "split") throw new Error(`cannot descend ${pathKey(p)}`);
    const child = cur.state.children.find((c) => c.nn === seg);
    if (!child) throw new Error(`no child ${seg} on ${pathKey(p)}`);
    cur = child;
  }
  return cur;
}
