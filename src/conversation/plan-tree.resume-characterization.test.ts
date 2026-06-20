// CHARACTERIZATION TESTS — pin the EXACT current resumeScopeForRoot(...) output for the six
// currently-resumable verdicts BEFORE the recoveryFor refactor.
//
// Purpose: these tests freeze the FULL ResumeScope object (deep-equal) returned for each active
// node state that resumeScopeForRoot today treats as resumable. The upcoming refactor will derive
// resumeScopeForRoot's output from a new internal `recoveryFor` function; if that refactor silently
// drifts ANY field (resumable flag, plan.kind, gateKind, path, planPath, plansDirPath, awaiting,
// redraftCount, or phaseLabel) of a working resume path, the corresponding deep-equal below goes
// RED. Each fixture is a COHERENT tree by construction (assertCoherent2 holds) so the active-node
// resolution under test is the real one, not an artificial shape.
//
// These six are the currently-resumable verdicts:
//   1. open/recon                                       → resend("recon")
//   2. open/sizing                                      → resend("sizer")
//   3. leaf/drafting                                    → resend("draft")
//   4. leaf/awaiting-approval (real planPath)           → gate kind "leaf"
//   5. open/awaiting-decomposition-approval             → gate kind "decomposition"
//   6. root split/running-children, baseline_ set,
//      acceptance_ unset                                → acceptance
//
// Pure domain: no Tauri/DOM, zero side effects.

import { describe, it, expect } from "vitest";
import {
  parseNn,
  nonEmpty,
  activePathOf,
  pathKey,
  inAcceptanceWindow,
  planName2,
  resumeScopeForRoot,
} from "./plan-tree";
import type {
  TreeNode,
  NodeState,
  NodePath,
  PlanTreeFilePath,
  ResumeScope,
} from "./plan-tree";

// ---- minimal fixture builders -----------------------------------------------------------------

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

// A leaf plan's REAL on-disk shape: an ABSOLUTE path under ~/.claude/plans/ (this app's canonical
// plan store), copied verbatim onto the leaf-gate ResumePlan (the driver passes it straight through).
const LEAF_PLAN = "/abs/.claude/plans/agent-plan-tree-x-00-DEADBEEF.md";
const LEAF_DIR = "/abs/.claude/plans/agent-plan-tree-x-00-DEADBEEF.md";

// Assert the fixture's active node is where the case expects it (the verdict is only meaningful if
// activePathOf resolves to the node we built the state on).
function expectActiveAt(root: TreeNode, expected: NodePath): void {
  const live = activePathOf(root);
  expect(live && pathKey(live)).toBe(pathKey(expected));
}

// ---- the six currently-resumable verdicts -----------------------------------------------------

describe("resumeScopeForRoot — characterization of the six resumable verdicts (full deep-equal)", () => {
  it("1. open/recon → resend('recon')", () => {
    const root = openNode(1, "recon");
    expectActiveAt(root, path());

    const expected: ResumeScope = {
      resumable: true,
      plan: { kind: "resend", awaiting: "recon", path: path() },
      phaseLabel: "Reconnaissance",
    };
    expect(resumeScopeForRoot(root)).toEqual(expected);
  });

  it("2. open/sizing → resend('sizer')", () => {
    const root = openNode(1, "sizing");
    expectActiveAt(root, path());

    const expected: ResumeScope = {
      resumable: true,
      plan: { kind: "resend", awaiting: "sizer", path: path() },
      phaseLabel: "Sizing",
    };
    expect(resumeScopeForRoot(root)).toEqual(expected);
  });

  it("3. leaf/drafting → resend('draft')", () => {
    const root = leafNode(1, "drafting");
    expectActiveAt(root, path());

    const expected: ResumeScope = {
      resumable: true,
      plan: { kind: "resend", awaiting: "draft", path: path() },
      phaseLabel: "Drafting the plan",
    };
    expect(resumeScopeForRoot(root)).toEqual(expected);
  });

  it("4. leaf/awaiting-approval (real planPath) → gate kind 'leaf'", () => {
    const root = leafNode(1, "awaiting-approval", { planPath: LEAF_PLAN, plansDirPath: LEAF_DIR });
    expectActiveAt(root, path());

    const expected: ResumeScope = {
      resumable: true,
      plan: {
        kind: "gate",
        gateKind: "leaf",
        path: path(),
        planPath: LEAF_PLAN,
        plansDirPath: LEAF_DIR,
        redraftCount: 0,
      },
      phaseLabel: "Awaiting your approval of the plan",
    };
    expect(resumeScopeForRoot(root)).toEqual(expected);
  });

  it("5. open/awaiting-decomposition-approval → gate kind 'decomposition'", () => {
    const root = openNode(1, "awaiting-decomposition-approval");
    expectActiveAt(root, path());

    const expected: ResumeScope = {
      resumable: true,
      plan: {
        kind: "gate",
        gateKind: "decomposition",
        path: path(),
        // Reconstructed from disk shape — master.md at the root.
        planPath: planName2(path()),
        plansDirPath: null,
        redraftCount: 0,
      },
      phaseLabel: "Awaiting decomposition approval",
    };
    expect(planName2(path())).toBe("master.md"); // pin the reconstructed filename
    expect(resumeScopeForRoot(root)).toEqual(expected);
  });

  it("6. root split/running-children WITH baseline_ set and acceptance_ unset → acceptance", () => {
    // A coherent root acceptance window: a single-child root split whose only child summarized
    // (inAcceptanceWindow holds — the root rests running-children with all children summarized).
    const root = splitNode(1, "running-children", [
      leafNode(1, "summarized", { summaryPath: fileOf("/s.md") }),
    ]);
    expectActiveAt(root, path()); // the ROOT itself is the active node in the acceptance window
    expect(inAcceptanceWindow(root)).toBe(true);

    const expected: ResumeScope = {
      resumable: true,
      plan: { kind: "acceptance" },
      phaseLabel: "Awaiting baseline acceptance",
    };
    expect(resumeScopeForRoot(root, { baseline_: { frozen: true, frozen_ms: 1 } })).toEqual(expected);
  });
});
