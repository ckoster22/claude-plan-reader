// RECOVERY MODEL TESTS — the TOTAL `recoveryFor` classifier (Phase 1 of the recovery refactor).
//
// `recoveryFor(node, path, ledger?, decompositionArtifactExists?)` maps EVERY active (stage,phase)
// to a RecoveryAction — there is NO dead-end variant. These tests pin:
//   (1) the ONE behavioral change: `open/decomposing` is DISK-PROBE aware — artifact present → the
//       SAME decomposition gate as `awaiting-decomposition-approval` (re-present, do NOT re-draft);
//       artifact absent (or no probe injected, the default) → resend("decompose");
//   (2) TOTALITY: every representable stage/phase yields a RecoveryAction (never throws), and the
//       union is exactly {resume, rewind, restart};
//   (3) the COMPILE-TIME guard: omitting a phase from `recoveryFor` fails typecheck (demonstrated by
//       the `// @ts-expect-error` exhaustiveness probe below).
//
// Pure domain: no Tauri/DOM, zero side effects.

import { describe, it, expect } from "vitest";
import {
  parseNn,
  planName2,
  nonEmpty,
  recoveryFor,
  resumeScopeForRoot,
  activePathOf,
  pathKey,
  reduce2,
  assertCoherent2,
  EXECUTING_REWIND_HAZARD,
} from "./plan-tree";

// The leaf/executing rewind hazard — pinned from plan-tree.ts (DA Finding 4 action-risk copy).
const EXEC_HAZARD = EXECUTING_REWIND_HAZARD;
import type {
  TreeNode,
  NodeState,
  NodePath,
  PlanTreeFilePath,
  PlanTreeState2,
  RecoveryAction,
  RewindTarget,
  DecompositionArtifactExists,
} from "./plan-tree";

// ---- minimal fixture builders -----------------------------------------------------------------

const nnOf = (n: number) => parseNn(n);
const path = (...ns: number[]): NodePath => ns.map(nnOf);
const fileOf = (s: string) => s as PlanTreeFilePath;

function node(nn: number, state: NodeState, redraftCount = 0): TreeNode {
  return { nn: nnOf(nn), title: `node ${nn}`, redraftCount, lastFeedback: null, state };
}
function openNode(
  nn: number,
  phase: Extract<NodeState, { stage: "open" }>["phase"],
  redraftCount = 0,
): TreeNode {
  return node(nn, { stage: "open", phase }, redraftCount);
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
const summarizedChild = () => leafNode(1, "summarized", { summaryPath: fileOf("/s.md") });

// ---- (1) the decomposing disk-probe branch ----------------------------------------------------

describe("recoveryFor — open/decomposing is disk-probe aware", () => {
  it("artifact PRESENT → the SAME decomposition gate as awaiting-decomposition-approval (re-present, do NOT re-draft)", () => {
    const n = openNode(1, "decomposing", /*redraftCount*/ 3);
    const present: DecompositionArtifactExists = () => true;

    const action = recoveryFor(n, path(), undefined, present);

    // Re-present the decomposition gate — byte-identical to the awaiting-decomposition-approval shape
    // (planName2 reconstructs the filename; plansDirPath null; redraftCount carried from the node).
    const expected: RecoveryAction = {
      kind: "resume",
      plan: {
        kind: "gate",
        gateKind: "decomposition",
        path: path(),
        planPath: planName2(path()), // "master.md" at the root
        plansDirPath: null,
        redraftCount: 3,
      },
    };
    expect(action).toEqual(expected);

    // PROOF this is identical to the awaiting-decomposition-approval recovery on the same path/node.
    const awaiting = recoveryFor(openNode(1, "awaiting-decomposition-approval", 3), path());
    expect(action).toEqual(awaiting);
  });

  it("artifact ABSENT → resend('decompose') (re-send the decompose step fresh)", () => {
    const n = openNode(1, "decomposing");
    const absent: DecompositionArtifactExists = () => false;

    const expected: RecoveryAction = {
      kind: "resume",
      plan: { kind: "resend", awaiting: "decompose", path: path() },
    };
    expect(recoveryFor(n, path(), undefined, absent)).toEqual(expected);
  });

  it("NO probe injected → DEFAULT is artifact-absent → resend('decompose')", () => {
    // The documented default: omitting the predicate treats the artifact as ABSENT (the conservative
    // re-draft path, never a phantom re-present).
    const n = openNode(1, "decomposing");
    expect(recoveryFor(n, path())).toEqual({
      kind: "resume",
      plan: { kind: "resend", awaiting: "decompose", path: path() },
    });
  });

  it("the probe is called with the ACTIVE node's path (nested split path → 01-plan.md)", () => {
    const n = openNode(2, "decomposing");
    const seen: NodePath[] = [];
    const probe: DecompositionArtifactExists = (p) => {
      seen.push(p);
      return true;
    };
    const action = recoveryFor(n, path(1), undefined, probe);

    expect(seen).toEqual([path(1)]); // probed at exactly the active path
    // and the re-presented gate uses the nested-split filename
    if (action.kind !== "resume" || action.plan.kind !== "gate") throw new Error("unreachable");
    expect(action.plan.planPath).toBe(planName2(path(1))); // "01-plan.md"
    expect(action.plan.planPath).toBe("01-plan.md");
  });
});

// ---- (1b) INV-3 coherence: the re-presented gate and node phase stay coherent on resume --------
//
// recoveryFor returns the SAME opaque decomposition-gate ResumePlan for BOTH open/decomposing and
// open/awaiting-decomposition-approval (proven above). On resume the driver re-presents the gate and
// applies GATE_RE_PRESENTED to advance ONLY the node phase decomposing → awaiting-decomposition-
// approval — so the re-presented gate (kind "decomposition") and the node phase are COHERENT, and a
// subsequent DECOMPOSITION_APPROVED (whose guard requires awaiting-decomposition-approval) no longer
// throws. This pins that phase-only re-arm at the pure-reducer level.

describe("INV-3 — GATE_RE_PRESENTED makes the re-presented decomposition gate and node phase coherent", () => {
  // A minimal coherent state whose root is open/decomposing (the resumed decomposition-gate shape).
  function decomposingState(): PlanTreeState2 {
    const root: TreeNode = openNode(1, "decomposing", /*redraftCount*/ 2);
    assertCoherent2(root); // the fixture is a legal tree
    return {
      schema: 2,
      tree_id: "t",
      created_ms: 1,
      updated_ms: 1,
      root,
      pendingApproval: null,
      pendingClarify: null,
      pendingPrototype: null,
      pendingAcceptance: null,
      parsedChildren: null,
    };
  }

  it("advances open/decomposing → open/awaiting-decomposition-approval, the phase the decomposition gate requires, with NO effects", () => {
    const before = decomposingState();
    // recoveryFor on this node yields a decomposition gate (proven in the disk-probe block above).
    const present: DecompositionArtifactExists = () => true;
    const action = recoveryFor(before.root, path(), undefined, present);
    if (action.kind !== "resume" || action.plan.kind !== "gate") throw new Error("unreachable");
    expect(action.plan.gateKind).toBe("decomposition");

    const { state: after, effects } = reduce2(before, { type: "GATE_RE_PRESENTED", path: path() });

    // COHERENCE: the re-presented node phase now MATCHES what the decomposition gate's approval
    // requires (awaiting-decomposition-approval). FALSIFY: drop the GATE_RE_PRESENTED case (or leave
    // it advancing to the wrong phase) → this assertion goes RED.
    expect(after.root.state.stage).toBe("open");
    if (after.root.state.stage !== "open") throw new Error("unreachable");
    expect(after.root.state.phase).toBe("awaiting-decomposition-approval");

    // PHASE-ONLY: NO effects (no persist, no notify) — the driver already presented the gate on
    // resume; re-running DECOMPOSITION_DRAFTED would double-fire it. FALSIFY: emit persist/notify here
    // → effects non-empty → RED.
    expect(effects).toEqual([]);

    // redraftCount (and every other node-identity field) is preserved across the phase re-arm.
    expect(after.root.redraftCount).toBe(2);
  });

  it("is illegal from any phase other than open/decomposing (the guard the live gate invariant relies on)", () => {
    const before = decomposingState();
    // Already at awaiting-decomposition-approval (the already-armed resume case the driver SKIPS) —
    // re-arming would be a no-op-at-best / double-advance, so the reducer rejects it LOUDLY.
    const armed: PlanTreeState2 = {
      ...before,
      root: openNode(1, "awaiting-decomposition-approval", 2),
    };
    expect(() => reduce2(armed, { type: "GATE_RE_PRESENTED", path: path() })).toThrow(
      /GATE_RE_PRESENTED illegal/,
    );
  });
});

// ---- (2) TOTALITY over every representable stage/phase ----------------------------------------
//
// Build a node for EVERY (stage,phase) and assert recoveryFor returns a RecoveryAction (never throws)
// whose kind is one of the three variants. This is the runtime totality witness; the compile-time
// guard is the // @ts-expect-error probe below.

interface PhaseFixture {
  name: string;
  node: TreeNode;
  path: NodePath;
  expectKind: RecoveryAction["kind"];
}

// Every (stage,phase) the NodeState union admits. The `path` is only used for path-carrying actions;
// totality does not depend on activePathOf (recoveryFor takes the node + path directly).
const everyPhase: PhaseFixture[] = [
  { name: "open/clarifying-intent", node: openNode(1, "clarifying-intent"), path: path(), expectKind: "restart" },
  // PHASE 2: prototype-review is now a `resume` carrying the dedicated `prototype-gate` plan (durable
  // `.plan-tree/prototype/` + INTENT.md re-presented), NOT the genesis `restart` clarify lumps it with.
  { name: "open/prototype-review", node: openNode(1, "prototype-review"), path: path(), expectKind: "resume" },
  { name: "open/pending", node: openNode(1, "pending"), path: path(), expectKind: "rewind" },
  { name: "open/recon", node: openNode(1, "recon"), path: path(), expectKind: "resume" },
  { name: "open/sizing", node: openNode(1, "sizing"), path: path(), expectKind: "resume" },
  // decomposing with no probe defaults to resend (a resume).
  { name: "open/decomposing", node: openNode(1, "decomposing"), path: path(), expectKind: "resume" },
  {
    name: "open/awaiting-decomposition-approval",
    node: openNode(1, "awaiting-decomposition-approval"),
    path: path(),
    expectKind: "resume",
  },
  { name: "leaf/drafting", node: leafNode(1, "drafting"), path: path(), expectKind: "resume" },
  {
    name: "leaf/awaiting-approval (planPath set)",
    node: leafNode(1, "awaiting-approval", { planPath: "/abs/.claude/plans/p.md", plansDirPath: "/d" }),
    path: path(),
    expectKind: "resume",
  },
  {
    name: "leaf/awaiting-approval (planPath null → torn)",
    node: leafNode(1, "awaiting-approval", { planPath: null }),
    path: path(),
    expectKind: "rewind",
  },
  { name: "leaf/executing", node: leafNode(1, "executing"), path: path(), expectKind: "rewind" },
  {
    name: "leaf/summarized",
    node: leafNode(1, "summarized", { summaryPath: fileOf("/s.md") }),
    path: path(),
    expectKind: "rewind",
  },
  // split phases — recoveryFor takes the split node directly; a single summarized child makes
  // inAcceptanceWindow hold for running-children. The acceptance window needs path([]) + ledger;
  // with NO ledger the root running-children window → rewind placeholder.
  {
    name: "split/running-children (root acceptance window, no ledger → rewind)",
    node: splitNode(1, "running-children", [summarizedChild()]),
    path: path(),
    expectKind: "rewind",
  },
  {
    // DEFECT FIX: reviewing (between children) is now a RESUME that re-runs the in-flight parent-review
    // turn — NOT a rewind to a (consumed) decomposition gate that would dead-end on approve.
    name: "split/reviewing",
    node: splitNode(1, "reviewing", [summarizedChild()]),
    path: path(),
    expectKind: "resume",
  },
  {
    name: "split/summarized",
    node: splitNode(1, "summarized", [summarizedChild()]),
    path: path(),
    expectKind: "rewind",
  },
];

describe("recoveryFor — TOTALITY (every stage/phase yields a RecoveryAction)", () => {
  const VALID_KINDS = new Set<RecoveryAction["kind"]>(["resume", "rewind", "restart"]);

  for (const fx of everyPhase) {
    it(`${fx.name} → ${fx.expectKind} (never throws)`, () => {
      let action: RecoveryAction;
      expect(() => {
        action = recoveryFor(fx.node, fx.path);
      }).not.toThrow();
      action = recoveryFor(fx.node, fx.path);
      expect(VALID_KINDS.has(action.kind)).toBe(true);
      expect(action.kind).toBe(fx.expectKind);
    });
  }

  it("the root acceptance window WITH a frozen baseline and no verdict → resume('acceptance')", () => {
    // The ONE running-children case that is resumable: root + frozen baseline + no recorded verdict.
    const root = splitNode(1, "running-children", [summarizedChild()]);
    const action = recoveryFor(root, path(), { baseline_: { frozen: true, frozen_ms: 1 } });
    expect(action).toEqual({ kind: "resume", plan: { kind: "acceptance" } });
  });
});

// ---- rewind/restart placeholder shapes (minimal, exercised by Phases 2-3) ----------------------

describe("recoveryFor — rewind/restart placeholder shapes carry the legacy reason as hazard/anchor", () => {
  it("PHASE 3: leaf/executing → OFFERABLE rewind to leaf-approval, HAZARDOUS (requiresConfirm), carrying the leaf planPath", () => {
    const action = recoveryFor(
      leafNode(1, "executing", { planPath: "/abs/.claude/plans/exec.md" }),
      path(),
    );
    const expected: RewindTarget = {
      toGate: "leaf-approval",
      path: path(),
      planPath: "/abs/.claude/plans/exec.md",
      hazard: EXEC_HAZARD,
      offerable: true,
      requiresConfirm: true,
    };
    if (action.kind !== "rewind") throw new Error("unreachable");
    expect(action.target).toEqual(expected);
    // FALSIFIABILITY: it is OFFERABLE (Phase 3 surfaces it) and HAZARDOUS (one-confirm gated).
    expect(action.target.offerable).toBe(true);
    expect(action.target.requiresConfirm).toBe(true);
    expect(action.target.hazard).toBe(EXEC_HAZARD);
  });

  it("genesis (clarifying-intent) → restart from clarify", () => {
    const action = recoveryFor(openNode(1, "clarifying-intent"), path());
    expect(action).toEqual({ kind: "restart", from: "clarify" });
  });

  it("PHASE 2: prototype-review → resume with the dedicated prototype-gate plan (NOT a restart)", () => {
    const action = recoveryFor(openNode(1, "prototype-review"), path());
    expect(action).toEqual({ kind: "resume", plan: { kind: "prototype-gate", path: path() } });
  });

  it("DEFECT FIX: non-root roll-up window → RESUME that re-runs the roll-up summary turn (NOT a decomposition rewind)", () => {
    // The split is ALREADY decomposed+approved; the lost work is the un-landed roll-up summary turn.
    // recoveryFor must NOT route this through a decomposition-gate rewind (re-presenting an
    // already-consumed gate dead-ends on approve — CHILDREN_PARSED throws on a split node). It must
    // resume by re-running the in-flight turn (`resend('rollup')`).
    const action = recoveryFor(splitNode(2, "running-children", [summarizedChild()]), path(2));
    expect(action).toEqual({ kind: "resume", plan: { kind: "resend", awaiting: "rollup", path: path(2) } });
    // FALSIFIABILITY: it must NOT be a rewind to a decomposition gate (the buggy behavior).
    expect(action.kind).not.toBe("rewind");
  });

  it("DEFECT FIX: reviewing → RESUME that re-runs the parent-review turn (NOT a decomposition rewind)", () => {
    const action = recoveryFor(splitNode(2, "reviewing", [summarizedChild()]), path(2));
    expect(action).toEqual({ kind: "resume", plan: { kind: "resend", awaiting: "review", path: path(2) } });
    expect(action.kind).not.toBe("rewind");
  });

  it("DEFECT FIX: torn leaf gate (null planPath) → NON-offerable rewind (blocked, never a throwing button)", () => {
    // With planPath null the orchestrator's leaf-rewind branch FATALs immediately; offering it as a
    // forward resume would be a guaranteed dead-end. So the rewind must NOT be offerable — the adapter
    // renders the legacy BLOCKED verdict instead. FALSIFIABILITY: if a future edit re-set offerable,
    // both assertions below go RED.
    const action = recoveryFor(leafNode(1, "awaiting-approval", { planPath: null }), path());
    const expected: RewindTarget = {
      toGate: "leaf-approval",
      path: path(),
      planPath: null,
      hazard: "missing plan artifact — start a new plan",
    };
    if (action.kind !== "rewind") throw new Error("unreachable");
    expect(action.target).toEqual(expected);
    expect(action.target.offerable).toBeUndefined();
  });

  it("PHASE 3: a Phase-2 one-click rewind (torn leaf gate) does NOT set requiresConfirm", () => {
    // FALSIFIABILITY: the HAZARDOUS one-confirm flag is EXCLUSIVE to leaf/executing. The Phase-2
    // rewinds (here the torn leaf gate) must NOT carry requiresConfirm — they are not hazardous
    // partial-apply continuations. If a future edit leaked requiresConfirm onto them, this goes RED.
    const action = recoveryFor(leafNode(1, "awaiting-approval", { planPath: null }), path());
    if (action.kind !== "rewind") throw new Error("unreachable");
    expect(action.target.requiresConfirm).toBeUndefined();
  });
});

// ---- (3) COMPILE-TIME exhaustiveness guard ----------------------------------------------------
//
// `recoveryFor` ends each stage switch in `assertNeverRecovery(state: never)`. If a NodeState
// stage/phase were left unclassified, the residual union would NOT narrow to `never` and the call
// would be a type error — i.e. omitting a phase FAILS TO COMPILE. We can't delete a case from the
// production switch inside a test, so we demonstrate the guard's mechanism with a local mirror: the
// `// @ts-expect-error` below proves that passing a NON-never value to a `(x: never) => never` site
// is a compile error (exactly what protects recoveryFor). If a future edit made the residual union
// inhabited, this line would STOP erroring and the @ts-expect-error would itself fail the build.
function assertNeverMirror(_x: never): never {
  throw new Error("unreachable");
}
it("compile-time exhaustiveness: a non-never value is rejected at the assertNever site (mirrors recoveryFor's guard)", () => {
  const notNever = "open" as NodeState["stage"]; // an inhabited union, NOT never
  // @ts-expect-error — passing an inhabited union where `never` is required is a compile error; this
  // is the SAME guard that forces every recoveryFor phase to be classified (omit one → won't compile).
  expect(() => assertNeverMirror(notNever)).toThrow();
});

// ---- PHASE 3 — adapter: leaf/executing renders RESUMABLE with the confirm flag exposed ----------
//
// resumeScopeForRoot is the adapter that maps recoveryFor's RecoveryAction onto the UI ResumeScope.
// Phase 3 turns leaf/executing from a BLOCKED verdict into a RESUMABLE rewind that carries
// `requiresConfirm: true`, so the banner (P3c) can gate it behind a confirm dialog. The Phase-2
// one-click resumable verdicts must NOT carry requiresConfirm.

describe("resumeScopeForRoot — PHASE 3 hazardous executing rewind surfaces requiresConfirm", () => {
  it("leaf/executing → RESUMABLE rewind with requiresConfirm:true and the partial-apply hazard", () => {
    const root = leafNode(1, "executing", { planPath: "/abs/.claude/plans/exec.md" });
    // the root leaf IS the active node while executing
    const live = activePathOf(root);
    expect(live && pathKey(live)).toBe(pathKey(path()));

    const scope = resumeScopeForRoot(root);
    // RESUMABLE now (was a blocked verdict in Phase 2).
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan.kind).toBe("rewind");
    if (scope.plan.kind !== "rewind") throw new Error("unreachable");
    expect(scope.plan.toGate).toBe("leaf-approval");
    expect(scope.plan.hazard).toBe(EXEC_HAZARD);
    // THE PHASE-3 FLAG the banner reads: present and true.
    expect(scope.plan.requiresConfirm).toBe(true);
  });

  it("FALSIFIABILITY: inverting the executing mapping to non-hazardous would drop requiresConfirm", () => {
    // This pins requiresConfirm to leaf/executing specifically: if executing were (wrongly) mapped to a
    // one-click rewind, requiresConfirm would be absent and the assertion below would go RED.
    const scope = resumeScopeForRoot(leafNode(1, "executing", { planPath: "/abs/p.md" }));
    if (!scope.resumable || scope.plan.kind !== "rewind") throw new Error("unreachable");
    expect(scope.plan.requiresConfirm).not.toBeUndefined();
    expect(scope.plan.requiresConfirm).toBe(true);
  });

  it("a Phase-2 one-click resumable (non-root roll-up window) does NOT set requiresConfirm", () => {
    // A root split whose only child is a NON-ROOT split resting in its roll-up window (running-children,
    // all grandchildren summarized). activePathOf descends to that nested split → its recovery is the
    // Phase-2 `resend('rollup')` resume, a ONE-CLICK action that must NOT carry requiresConfirm.
    const root = splitNode(1, "running-children", [
      splitNode(1, "running-children", [summarizedChild()]),
    ]);
    const live = activePathOf(root);
    expect(live && pathKey(live)).toBe(pathKey(path(1))); // the nested split is active (its roll-up window)

    const scope = resumeScopeForRoot(root);
    expect(scope.resumable).toBe(true);
    if (!scope.resumable) throw new Error("unreachable");
    expect(scope.plan.kind).toBe("resend"); // one-click rollup re-send, not a rewind
    // FALSIFIABILITY: the one-click resumable carries NO confirm flag (it is not a hazardous rewind).
    expect((scope.plan as { requiresConfirm?: boolean }).requiresConfirm).toBeUndefined();
  });
});
