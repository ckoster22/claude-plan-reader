// Multiplan orchestration domain — GENERATION 2 recursive-foundation tests (falsifiable).
//
// Covers the recursive types/helpers appended to plan-tree.ts (PathKey, NonEmptyArray, TreeNode,
// schema-2 ledger projections, nodeAtPath/activePathOf, the tree-wide-existential write policy,
// and assertCoherent2 — one test per coherence rule). Every test is constructed to go RED if the
// behavior under test were inverted; where useful a comment names the exact mutation that breaks
// it. Pure domain — no Tauri/DOM, zero side effects. NO production behavior is exercised here:
// the live reducer/driver still run on the flat generation (golden-depth1.test.ts pins that).

import { describe, it, expect } from "vitest";
import {
  parseNn,
  pathKey,
  parsePathKey,
  nonEmpty,
  nodeAtPath,
  activePathOf,
  writePolicyFor2,
  assertCoherent2,
  treeIsDone,
  toLedger2,
  toSnapshot2,
  PlanValidationError,
} from "./plan-tree";
import type { TreeNode, NodeState, NodePath, PlanTreeState2 } from "./plan-tree";

// ---- fixtures ---------------------------------------------------------------------------------

// Branded mints for fixtures (parseNn is the real production boundary).
const nnOf = (n: number) => parseNn(n);
const path = (...ns: number[]): NodePath => ns.map(nnOf);

// Node builders. Identity fields are boilerplate here — the tests exercise the STATE shapes.
function node(nn: number, state: NodeState): TreeNode {
  return { nn: nnOf(nn), title: `node ${nn}`, redraftCount: 0, lastFeedback: null, state };
}
function openNode(nn: number, phase: Extract<NodeState, { stage: "open" }>["phase"]): TreeNode {
  return node(nn, { stage: "open", phase });
}
function leafNode(nn: number, phase: Extract<NodeState, { stage: "leaf" }>["phase"]): TreeNode {
  return node(nn, { stage: "leaf", phase, planPath: null, summaryPath: null, plansDirPath: null });
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

// A canonical coherent depth-2 tree: root split running-children; child 01 fully summarized;
// child 02 split running-children with grandchild 02.01 summarized, 02.02 in flight (phase
// parameterized so write-policy tests can flip it), 02.03 pending; child 03 pending.
function depth2Tree(
  grand0202: Extract<NodeState, { stage: "leaf" }>["phase"] = "executing",
): TreeNode {
  return splitNode(1, "running-children", [
    leafNode(1, "summarized"),
    splitNode(2, "running-children", [
      leafNode(1, "summarized"),
      leafNode(2, grand0202),
      openNode(3, "pending"),
    ]),
    openNode(3, "pending"),
  ]);
}

// ---- pathKey / parsePathKey ---------------------------------------------------------------------

describe("pathKey", () => {
  it("mints the canonical zero-padded dotted form (root [] → empty string)", () => {
    expect(pathKey([])).toBe("");
    expect(pathKey(path(2))).toBe("02");
    expect(pathKey(path(2, 1))).toBe("02.01");
    expect(pathKey(path(12, 3, 99))).toBe("12.03.99");
  });

  it("round-trips through parsePathKey for every depth", () => {
    for (const p of [[], path(1), path(2, 1), path(9, 10, 99), path(1, 1, 1, 1)]) {
      expect(parsePathKey(pathKey(p))).toEqual(p);
    }
  });
});

describe("parsePathKey", () => {
  it("accepts only the canonical padded form", () => {
    expect(parsePathKey("")).toEqual([]);
    expect(parsePathKey("02")).toEqual(path(2));
    expect(parsePathKey("02.01")).toEqual(path(2, 1));
  });

  it("loudly rejects unpadded segments (canonical-form-only: '2.1' must not alias '02.01')", () => {
    expect(() => parsePathKey("2.1")).toThrow(/invalid PathKey segment/);
    expect(() => parsePathKey("2")).toThrow(/invalid PathKey segment/);
  });

  it("loudly rejects empty segments, non-digits, and over-wide segments", () => {
    expect(() => parsePathKey("02..01")).toThrow(/invalid PathKey segment/);
    expect(() => parsePathKey(".02")).toThrow(/invalid PathKey segment/);
    expect(() => parsePathKey("02.")).toThrow(/invalid PathKey segment/);
    expect(() => parsePathKey("0a")).toThrow(/invalid PathKey segment/);
    expect(() => parsePathKey("002")).toThrow(/invalid PathKey segment/);
    expect(() => parsePathKey("100")).toThrow(/invalid PathKey segment/);
  });

  it("loudly rejects '00' (segments route through parseNn — 0 is out of range)", () => {
    expect(() => parsePathKey("00")).toThrow(/invalid sub-plan number/);
    expect(() => parsePathKey("02.00")).toThrow(/invalid sub-plan number/);
  });
});

// ---- nonEmpty -----------------------------------------------------------------------------------

describe("nonEmpty", () => {
  it("passes a populated array through unchanged", () => {
    const arr = nonEmpty([leafNode(1, "drafting")]);
    expect(arr).toHaveLength(1);
    expect(arr[0].nn).toBe(1);
  });

  it("loudly throws a PlanValidationError on an empty array (an empty split is unrepresentable)", () => {
    // INV-2: an empty children list is a PLAN-VALIDATION failure of the same typed class as nn>99 /
    // zero-header — so the orchestrator's deny-for-redraft catch (instanceof PlanValidationError)
    // covers it and the run is NEVER FATALed by a header-less decomposition reaching this boundary.
    // FALSIFY: revert nonEmpty to throw a bare Error → the instanceof assertion goes RED.
    expect(() => nonEmpty([])).toThrow(PlanValidationError);
    expect(() => nonEmpty([])).toThrow(/array is empty/);
  });
});

// ---- nodeAtPath ---------------------------------------------------------------------------------

describe("nodeAtPath", () => {
  it("resolves the root for [] and descends split children by nn segment", () => {
    const root = depth2Tree();
    expect(nodeAtPath(root, [])).toBe(root);
    expect(nodeAtPath(root, path(2))!.title).toBe("node 2");
    const grand = nodeAtPath(root, path(2, 2))!;
    expect(grand.state).toMatchObject({ stage: "leaf", phase: "executing" });
  });

  it("returns null for a missing segment or descent through a non-split node", () => {
    const root = depth2Tree();
    expect(nodeAtPath(root, path(9))).toBeNull(); // no such child
    expect(nodeAtPath(root, path(1, 1))).toBeNull(); // 01 is a leaf — no children to descend
    expect(nodeAtPath(root, path(3, 1))).toBeNull(); // 03 is open — no children to descend
  });
});

// ---- activePathOf -------------------------------------------------------------------------------

describe("activePathOf", () => {
  it("returns null for an all-pending root and for a done tree", () => {
    expect(activePathOf(openNode(1, "pending"))).toBeNull();
    expect(activePathOf(leafNode(1, "summarized"))).toBeNull();
    expect(activePathOf(splitNode(1, "summarized", [leafNode(1, "summarized")]))).toBeNull();
  });

  it("returns [] for an in-flight root (clarifying-intent, recon, leaf drafting)", () => {
    expect(activePathOf(openNode(1, "clarifying-intent"))).toEqual([]);
    expect(activePathOf(openNode(1, "recon"))).toEqual([]);
    expect(activePathOf(leafNode(1, "drafting"))).toEqual([]);
  });

  it("descends depth-first to the single deep active node", () => {
    expect(activePathOf(depth2Tree())).toEqual(path(2, 2));
  });

  it("returns the REVIEWING PARENT itself as the active node for dispatch", () => {
    // Mutation that breaks this: treating `reviewing` like running-children (descending) or like
    // summarized (null) — the review turn is the PARENT's turn.
    const root = splitNode(1, "running-children", [
      leafNode(1, "summarized"),
      splitNode(2, "reviewing", [leafNode(1, "summarized"), openNode(2, "pending")]),
      openNode(3, "pending"),
    ]);
    expect(activePathOf(root)).toEqual(path(2));
  });

  it("PHASE 5: the ROOT resting running-children with ALL children summarized is the ACCEPTANCE WINDOW — the root itself is active ([])", () => {
    // PIN CHANGE (Phase 5 — forced acceptance gate): this shape was previously a loud incoherence
    // ("a root resting here is a missed completion"). It is now the forced-acceptance hold (the run
    // is built; the user must record a verdict against the frozen baseline), structurally identical
    // to a non-root roll-up window. activePathOf returns [] (the acceptance verdict is the root's
    // turn). FALSIFY: drop the `prefix.length === 0 && inAcceptanceWindow` return in activeWithin →
    // this throws instead of returning [] → RED.
    const root = splitNode(1, "running-children", [leafNode(1, "summarized")]);
    expect(activePathOf(root)).toEqual([]);
  });

  it("still throws on running-children with a PENDING (not summarized) child and none active (genuine incoherence)", () => {
    // The acceptance/roll-up windows require EVERY child summarized. A running-children node with a
    // child still pending and none active is still a loud incoherence (not a window). FALSIFY:
    // broaden the window allowance to non-all-summarized → no throw → RED.
    const root = splitNode(1, "running-children", [openNode(1, "pending")]);
    expect(() => activePathOf(root)).toThrow(/running-children with no active child/);
  });
});

// ---- writePolicyFor2 ----------------------------------------------------------------------------

describe("writePolicyFor2", () => {
  it("acceptEdits iff SOME node anywhere is a leaf executing (tree-wide existential, deep)", () => {
    // FALSIFIED (evidence in task report): with the deep 02.02 leaf executing the policy is
    // acceptEdits; flipping that same fixture leaf to `drafting` flips the assertion red — the
    // test detects the executing witness, not the tree shape.
    expect(writePolicyFor2(depth2Tree("executing"))).toBe("acceptEdits");
  });

  it("derives plan when the deep leaf is merely drafting / awaiting-approval", () => {
    expect(writePolicyFor2(depth2Tree("drafting"))).toBe("plan");
    expect(writePolicyFor2(depth2Tree("awaiting-approval"))).toBe("plan");
  });

  it("derives plan for pre-execution and done trees", () => {
    expect(writePolicyFor2(openNode(1, "recon"))).toBe("plan");
    expect(writePolicyFor2(splitNode(1, "summarized", [leafNode(1, "summarized")]))).toBe("plan");
  });

  it("derives 'prototype' for the root intent window (clarifying-intent AND prototype-review)", () => {
    // FALSIFIED (evidence in task report): removing writePolicyFor2's root-phase branch (reverting
    // to the bare existential) turns BOTH assertions red ("plan" comes back).
    expect(writePolicyFor2(openNode(1, "clarifying-intent"))).toBe("prototype");
    expect(writePolicyFor2(openNode(1, "prototype-review"))).toBe("prototype");
  });
});

// ---- assertCoherent2 — one test per rule, each falsifiable -------------------------------------

describe("assertCoherent2", () => {
  it("accepts the canonical coherent depth-2 tree and the genesis root", () => {
    expect(() => assertCoherent2(depth2Tree())).not.toThrow();
    expect(() => assertCoherent2(openNode(1, "clarifying-intent"))).not.toThrow();
  });

  it("rule: left siblings of the active child must be summarized", () => {
    const root = splitNode(1, "running-children", [
      openNode(1, "pending"), // pending LEFT of the active child — incoherent
      leafNode(2, "executing"),
    ]);
    expect(() => assertCoherent2(root)).toThrow(/right of a pending sibling/);
  });

  it("rule: at most one active sibling per level", () => {
    const root = splitNode(1, "running-children", [
      leafNode(1, "executing"),
      leafNode(2, "drafting"), // second in-flight sibling — incoherent
    ]);
    expect(() => assertCoherent2(root)).toThrow(/second active child/);
  });

  it("rule: right siblings of the active child must be pending (no summarized after active)", () => {
    const root = splitNode(1, "running-children", [
      leafNode(1, "executing"),
      leafNode(2, "summarized"), // completed RIGHT of the active child — incoherent
    ]);
    expect(() => assertCoherent2(root)).toThrow(/summarized child .* right of a non-summarized/);
  });

  it("rule: running-children requires exactly one active child", () => {
    const root = splitNode(1, "running-children", [
      leafNode(1, "summarized"),
      openNode(2, "pending"), // zero active — parent claims running-children, nobody is running
    ]);
    expect(() => assertCoherent2(root)).toThrow(/running-children with 0 active children/);
  });

  it("rule: reviewing forbids an active child", () => {
    const root = splitNode(1, "reviewing", [
      leafNode(1, "summarized"),
      leafNode(2, "drafting"), // in flight DURING the review turn — incoherent
      openNode(3, "pending"),
    ]);
    expect(() => assertCoherent2(root)).toThrow(/reviewing while a child is active/);
  });

  it("rule: reviewing happens only BETWEEN children (>=1 summarized behind, >=1 pending ahead)", () => {
    // Before any child completed:
    const before = splitNode(1, "reviewing", [openNode(1, "pending"), openNode(2, "pending")]);
    expect(() => assertCoherent2(before)).toThrow(/between-children window/);
    // After the last child completed (review is skipped after the last child):
    const after = splitNode(1, "reviewing", [leafNode(1, "summarized"), leafNode(2, "summarized")]);
    expect(() => assertCoherent2(after)).toThrow(/between-children window/);
  });

  it("rule: a parent may not be summarized with an incomplete child", () => {
    const root = splitNode(1, "summarized", [
      leafNode(1, "summarized"),
      openNode(2, "pending"), // incomplete child under a completed parent — incoherent
    ]);
    expect(() => assertCoherent2(root)).toThrow(/summarized with an incomplete child/);
  });

  it("rule: no leaf executing under a reviewing ancestor (reported as ITSELF, not masked)", () => {
    // The fixture necessarily violates other rules too (a coherent tree cannot host this shape);
    // the dedicated first pass must surface THIS rule's message — asserting the specific message
    // is what makes the test falsifiable (deleting the pass yields a different error → red).
    const root = splitNode(1, "reviewing", [
      splitNode(1, "summarized", [leafNode(1, "executing")]),
      openNode(2, "pending"),
    ]);
    expect(() => assertCoherent2(root)).toThrow(/executing under a reviewing ancestor/);
  });

  it("rule: clarifying-intent is root-only (depth-0 rule on the one node type)", () => {
    const root = splitNode(1, "running-children", [openNode(1, "clarifying-intent")]);
    expect(() => assertCoherent2(root)).toThrow(/clarifying-intent \(root-only phase\)/);
  });

  it("rule: prototype-review is root-only (depth-0 rule, same as clarifying-intent)", () => {
    // The ROOT in prototype-review is coherent...
    expect(() => assertCoherent2(openNode(1, "prototype-review"))).not.toThrow();
    // ...a NON-ROOT node in it is not. FALSIFIED (evidence in task report): narrowing rule (4)
    // back to clarifying-intent-only lets this tree pass → RED.
    const root = splitNode(1, "running-children", [openNode(1, "prototype-review")]);
    expect(() => assertCoherent2(root)).toThrow(/prototype-review \(root-only phase\)/);
  });

  it("rule: sibling nn must be UNIQUE (duplicate-nn siblings are structurally incoherent)", () => {
    // A "types-cannot-express" invariant (defense in depth for the CHILDREN_PARSED parse guard):
    // every navigation primitive resolves nn to the FIRST match, so two siblings sharing an nn
    // silently alias. This tree is coherent in EVERY other respect — child 01 active, two pending
    // after it (a legal partition) — so the duplicate nn (02, 02) is the SOLE violation, which is
    // what makes the assertion falsifiable. FALSIFY: drop the nn-collision check in assertStructure
    // → this tree passes → RED.
    const root = splitNode(1, "running-children", [
      leafNode(1, "drafting"),
      openNode(2, "pending"),
      openNode(2, "pending"),
    ]);
    expect(() => assertCoherent2(root)).toThrow(/duplicate sub-plan nn/);
  });
});

// ---- treeIsDone / schema-2 projections ----------------------------------------------------------

describe("treeIsDone", () => {
  it("derives done iff the ROOT summarized (leaf or split) — never stored, never non-root", () => {
    expect(treeIsDone(leafNode(1, "summarized"))).toBe(true);
    expect(treeIsDone(splitNode(1, "summarized", [leafNode(1, "summarized")]))).toBe(true);
    expect(treeIsDone(openNode(1, "clarifying-intent"))).toBe(false);
    expect(treeIsDone(depth2Tree())).toBe(false);
  });
});

describe("toLedger2 / toSnapshot2", () => {
  const state: PlanTreeState2 = {
    schema: 2,
    tree_id: "t2",
    created_ms: 100,
    updated_ms: 200,
    root: depth2Tree(),
    // Transient fields (reducer-era additions): never serialized — toLedger2 must exclude them.
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    pendingAcceptance: null,
    parsedChildren: null,
  };

  it("toLedger2 emits the schema-2 shape with a DEEP-copied tree (no aliasing)", () => {
    const ledger = toLedger2(state);
    expect(ledger.schema).toBe(2);
    expect(ledger.tree_id).toBe("t2");
    expect(ledger.root).toEqual(state.root);
    expect(ledger.root).not.toBe(state.root);
    // Deep: the grandchild is a copy too, not a shared reference.
    expect(nodeAtPath(ledger.root, path(2, 2))).not.toBe(nodeAtPath(state.root, path(2, 2)));
  });

  it("toSnapshot2 mirrors the ledger plus derived activePath/writePolicy/done", () => {
    const snap = toSnapshot2(state);
    expect(snap.treeId).toBe("t2");
    expect(snap.root).toEqual(state.root);
    expect(snap.activePath).toEqual(path(2, 2));
    expect(snap.writePolicy).toBe("acceptEdits");
    expect(snap.done).toBe(false);
  });
});
