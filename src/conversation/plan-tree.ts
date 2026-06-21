// Multiplan orchestration domain (Sub-Plan 02) — PURE core of the plan-tree state machine.
//
// This file is the pure heart of the multiplan orchestrator: the frozen serializable ledger
// (state.json schema 2) types, an in-memory transient-gate overlay, a PURE reducer over a
// discriminated event union, and a coherence-invariant checker. It mirrors how stream.ts
// (ConversationModel, pure) is separated from index.ts (the impure driver): NO `invoke`, NO
// `listen`, NO Tauri, NO DOM. The reducer DECIDES side effects (returns an Effect2[]); the driver
// EXECUTES them.
//
// GENERATION 2 (the recursive representation) is the live wire: the flat gen-1
// master+subplans/pointer machine was deleted at the Phase-1 cutover (its depth-1 observable
// behavior is preserved byte-for-byte — pinned by golden-depth1.test.ts). The shared primitives
// the cutover kept (branded Nn/PlanTreeFilePath, SizerOutcome, ClarifyGate, WritePolicy,
// parseSizerDecision) live at the top; everything tree-shaped below the gen-2 banner.

import type { AskUserQuestionItem, AskUserQuestionAnswers } from "./types";

// ---- branded domain primitives (make the invalid representations uncompilable) ---------------

// An absolute path PROVEN to come from a real plan-tree write — minted ONLY by the driver's wrapper
// around the write command's returned path (orchestrator.ts). There is deliberately NO exported cast
// helper: prose/summary TEXT can never flow into a `summaryPath` slot without failing tsc (the
// text-as-path bug this brand eliminates).
export type PlanTreeFilePath = string & { __brand: "PlanTreeFilePath" };

// A sub-plan number, PROVEN to be an integer in 1–99 (the `NN-(plan|summary).md` two-digit on-disk
// shape). Minted ONLY by parseNn — the single validation boundary — so a 3-digit header can never be
// silently truncated or carried into summaryName.
export type Nn = number & { __brand: "Nn" };

// THE single Nn boundary: every raw number entering the domain (parsed headers, UI gate clicks)
// passes through here. Throws LOUDLY on anything outside the representable 1–99 range — never a
// silent drop.
export function parseNn(n: number): Nn {
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    throw new Error(`invalid sub-plan number ${n}: must be an integer in 1-99`);
  }
  return n as Nn;
}

// ---- shared frozen types (survivors of the gen-1 deletion — names are load-bearing) --------

// The sizer's verdict on how to decompose the request. EXACTLY two outcomes: "split" or a
// confident "single". `escalate` is unrepresentable — the master gate is already the human
// checkpoint, so an uncertain sizer splits (the driver coerces any unknown decision to split).
export interface SizerOutcome {
  decision: "single" | "split";
  confidence: number;
  num_plans: number;
}

// The held-AskUserQuestion clarify gate (transient, not serialized).
export interface ClarifyGate {
  readonly toolUseId: string;
  readonly questions: AskUserQuestionItem[];
}

// What a visual prototype IS: the artifact kind, the on-disk file paths backing it, an optional
// screenshot path, an optional inline preview (small artifacts render in-pane without a file
// round-trip), and the labeled variants the prototype turn produced (a prototype turn may offer
// the user several candidate directions side by side).
export interface PrototypeInfo {
  kind: "html" | "mermaid" | "ascii" | "table";
  paths: string[];
  screenshot: string | null;
  inlinePreview: string | null;
  variants: Array<{ label: string; path: string | null; inlinePreview: string | null }>;
}

// The held visual-prototype review gate (transient, not serialized — see pendingPrototype):
// PrototypeInfo plus the refinement round (0-based; PROTOTYPE_REFINED loops increment it
// driver-side) and the cwd the prototype files were written under.
export interface PrototypeGate extends PrototypeInfo {
  round: number;
  cwd: string;
}

// PHASE 5 — THE FORCED ACCEPTANCE GATE (transient, NEVER serialized — modeled on PrototypeGate).
// A tree that froze a working-reference baseline (state.baseline_) CANNOT be reported done without
// the user recording an acceptance verdict against that baseline. When the ROOT's last child
// summarizes WITH a baseline present, instead of finalizing the reducer holds the root in its
// running-children acceptance window (all children summarized — coherent; see assertCoherent2) and
// opens THIS gate. It carries everything the UI needs to surface the verdict without re-deriving:
//   - cwd: the working directory the baseline lives under (open_baseline resolves `openTarget`
//     relative to <cwd>/.plan-tree/baseline/).
//   - openTarget: the file the "Open baseline" button hands open_baseline (e.g. "index.html"),
//     relative to the baseline dir — null when there is nothing single-file to open.
//   - runCommand: a human-readable hint for how to exercise the just-built result against the
//     baseline (e.g. "npm run dev"). Display-only; the gate never runs it.
//   - round: 1-based, mirroring PrototypeGate.round (the acceptance gate is single-round today, so
//     this is always 1 — kept for a uniform held-gate shape and future divergence loops).
// The gate is DERIVED-and-held, not stored: rehydrate nulls it (a resumed run re-presents it from
// the tree shape + baseline_ — same discipline as pendingPrototype).
export interface AcceptanceGate {
  readonly cwd: string;
  readonly openTarget: string | null;
  readonly runCommand: string | null;
  readonly round: number;
}

// ---- derived write policy ---------------------------------------------------------------------

// The sidecar permission mode the session must be in for a given ledger state. Derived by
// writePolicyFor2 (root-phase-aware over the gen-2 tree) and asserted by the driver after every
// transition. "prototype" is the visual-prototyping window: the root is still clarifying intent
// (clarifying-intent / prototype-review), where throwaway prototype artifacts may be written but
// no plan exists yet.
export type WritePolicy = "plan" | "acceptEdits" | "prototype";

// ===============================================================================================
// ==== GENERATION 2 — THE RECURSIVE REPRESENTATION (the live wire since the Phase-1 cutover) =====
// ===============================================================================================
//
// Everything below this banner is the recursive-multiplan representation (Phase 1 of the
// recursive-multiplan plan). The flat gen-1 machine it once coexisted with was DELETED at the
// driver cutover; the orchestrator (orchestrator.ts) runs entirely on these types. Depth-1
// observable behavior is byte-identical to gen 1 — pinned by golden-depth1.test.ts.
//
// Design decisions encoded here (per the plan's "Design Decisions"):
//   - ONE node type (`TreeNode`) for root and non-root alike — a separate RootNode type is
//     deliberately rejected (it would re-introduce the master/sub type split this redesign removes).
//   - Illegal stage/phase/children combinations are UNCOMPILABLE: `children` exists only on the
//     `split` state, `executing` exists only on the `leaf` state, and `children` is non-empty by
//     construction (`NonEmptyArray`).
//   - ROOT-ONLY PHASES: `clarifying-intent` and `prototype-review` are members of the `open`
//     phase union but are depth-0-only values enforced by assertCoherent2 (a runtime rule, mirroring how the flat
//     generation enforced root lifecycles). `done` is NOT a NodeState phase at all: run completion
//     is DERIVED — the tree is done iff the ROOT's state is `summarized` (see `treeIsDone`). A
//     non-root node therefore CANNOT be "done" (the value does not exist) and cannot be
//     "clarifying-intent" (coherence throws); no `completed` boolean is stored on the ledger
//     because a stored flag could disagree with the tree it summarizes.

// ---- gen-2 branded path primitives ------------------------------------------------------------

// A node's address in the tree: the Nn segments from the root down (root itself is `[]`). Nodes
// store only their OWN segment (`TreeNode.nn`); full paths derive from nesting.
export type NodePath = readonly Nn[];

// The canonical string form of a NodePath, branded so a bare string can never be used as a path
// Map key — minted ONLY by pathKey() (zero-padded dotted, e.g. "02.01"; root [] → "").
export type PathKey = string & { __brand: "PathKey" };

// THE sole PathKey mint: zero-pad each segment to exactly two digits and join with ".". The root
// path [] mints the empty string. Total over NodePath — Nn's 1-99 brand guarantees two digits.
export function pathKey(path: NodePath): PathKey {
  return path.map((nn) => String(nn).padStart(2, "0")).join(".") as PathKey;
}

// THE sole PathKey inverse. Accepts ONLY the canonical padded form pathKey produces: "" (root) or
// two-digit segments joined by "." ("02", "02.01", ...). Anything else throws LOUDLY — an empty
// segment ("02..01"), non-digits, an UNPADDED segment ("2.1" — canonical-form-only is deliberate:
// accepting "2.1" would make two distinct strings denote one path and silently split Map keys),
// a 3+-digit segment ("002", "100"), or "00" (parseNn rejects 0).
export function parsePathKey(s: string): NodePath {
  if (s === "") return [];
  return s.split(".").map((seg) => {
    if (!/^\d{2}$/.test(seg)) {
      throw new Error(
        `invalid PathKey segment "${seg}" in "${s}": must be exactly two digits (canonical padded form)`,
      );
    }
    return parseNn(Number.parseInt(seg, 10));
  });
}

// ---- INV-2: typed plan-validation error -------------------------------------------------------

// A RECOVERABLE decomposition-plan validation failure — a malformed master/decomposition DRAFT that
// the user can fix by redrafting (zero `### Sub-Plan` headers, a header outside the 1-99 range, or an
// empty children list reaching the nonEmpty boundary). Thrown by parseSubPlanHeaders (orchestrator)
// and nonEmpty (here), discriminated by the orchestrator's `instanceof PlanValidationError` catch so
// the held ExitPlanMode is DENIED for a redraft (the run stays active) instead of dispatching FATAL.
// This is a TYPED discriminator, never a `message.startsWith(...)` string match: both the throwers
// and the catch live in the same Vite frontend bundle, so the class identity is reliable.
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
    // Restore the prototype chain so `instanceof PlanValidationError` holds even after TS downlevels
    // `extends Error` (the classic TS-extends-builtin trap).
    Object.setPrototypeOf(this, PlanValidationError.prototype);
  }
}

// ---- gen-2 non-empty array --------------------------------------------------------------------

// An array PROVEN non-empty at the type level — `children` on a split node uses this so an empty
// children list is unrepresentable at rest.
export type NonEmptyArray<T> = readonly [T, ...T[]];

// THE NonEmptyArray boundary: throws LOUDLY on an empty input (e.g. a decomposition that parsed
// zero children) instead of letting an empty split exist. INV-2: this is a PlanValidationError — a
// header-less decomposition that slips past parseSubPlanHeaders to here still denies-for-redraft (the
// orchestrator's instanceof catch covers it) rather than FATALing the whole run.
export function nonEmpty<T>(arr: readonly T[]): NonEmptyArray<T> {
  if (arr.length === 0) {
    throw new PlanValidationError("nonEmpty: array is empty — a split node must have at least one child");
  }
  return arr as unknown as NonEmptyArray<T>;
}

// ---- gen-2 node state + tree node -------------------------------------------------------------

// The discriminated per-node state. The three stages are STRUCTURALLY distinct:
//   - "open": pre-sizing (the split-decided-but-not-yet-parsed window included) — NO children, NO
//     artifact paths. `clarifying-intent` is the root-only genesis phase and `prototype-review`
//     the root-only visual-prototype gate window (depth-0 rules, both).
//   - "leaf": the node IS the plan — drafts, gates, executes, summarizes. NO children.
//   - "split": the node decomposed — `children` exists ONLY here and is non-empty by construction.
//     `executing` is NOT a split phase (the type system makes split-executing uncompilable), so
//     writePolicyFor2's existential only ever finds leaves.
// Artifact paths (planPath/summaryPath/plansDirPath) live on leaf AND split states (a split node
// writes its decomposition plan and, post-children, a roll-up summary) but NOT on open (an
// un-sized node has produced no artifacts — unrepresentable rather than null-at-rest).
export type NodeState =
  | {
      stage: "open";
      phase: "clarifying-intent" | "prototype-review" | "pending" | "recon" | "sizing" | "decomposing" | "awaiting-decomposition-approval";
    }
  | {
      stage: "leaf";
      phase: "drafting" | "awaiting-approval" | "executing" | "summarized";
      planPath: string | null;
      summaryPath: PlanTreeFilePath | null;
      plansDirPath: string | null;
    }
  | {
      stage: "split";
      phase: "running-children" | "reviewing" | "summarized";
      children: NonEmptyArray<TreeNode>;
      planPath: string | null;
      summaryPath: PlanTreeFilePath | null;
      plansDirPath: string | null;
    };

// The ONE recursive node type (root included — no separate RootNode). Identity/bookkeeping fields
// that survive stage transitions live at node level, OUTSIDE the state object: nn/title persist
// across open→leaf/split replacement, and redraftCount/lastFeedback accumulate across redrafts of
// EITHER a decomposition or a leaf plan. The ROOT's `nn` is conventional (mint parseNn(1)) and
// never read: full paths derive from CHILD segments only, so the root contributes no segment.
export interface TreeNode {
  readonly nn: Nn;
  readonly title: string;
  readonly redraftCount: number;
  readonly lastFeedback: string | null;
  readonly state: NodeState;
}

// ---- gen-2 ledger (schema 2) + projections ----------------------------------------------------

// The recursive JSON-serializable ledger, 1:1 with `.plan-tree/state.json` schema 2. `pointer` is
// GONE — the active path is derived (activePathOf); coherence guarantees ≤ 1 active node. No
// schema-1 migration exists (no resume-from-disk exists).
export interface RecursiveLedger {
  schema: 2;
  tree_id: string;
  created_ms: number;
  updated_ms: number;
  root: TreeNode;
  // The SDK conversation's session_id, captured off the system_init frame and self-persisted via
  // SESSION_INITIALIZED so a killed run can later be resumed (resume: sessionId). OPTIONAL and
  // additive — the schema stays 2: an old state.json written before this field existed deserializes
  // fine (absent ⇒ undefined ⇒ no resumable transcript, the expired-transcript fallback). Set once
  // on the first non-empty id of a run; a later re-init overwrites it (the live id wins).
  sdk_session_id?: string;
  // The frozen "working reference" record (Phase 3). PRESENT iff the user marked the visual
  // prototype a working reference at the prototype-approval gate — the driver froze
  // `.plan-tree/prototype/` into the contained `.plan-tree/baseline/` and recorded it here. The
  // baseline is a FLOOR on the outcome dimensions captured in INTENT.md, never a behavioral
  // match-target. OPTIONAL + additive (schema stays 2): an old/sketch state.json without it
  // deserializes fine (absent ⇒ undefined ⇒ no working reference, today's behavior). `frozen_ms`
  // stamps when the freeze happened (purely informational — the presence of the record is the
  // signal). The on-disk artifacts live under `.plan-tree/baseline/`, so no path list is stored
  // (it would only duplicate the dir's contents and could drift from them).
  baseline_?: { frozen: true; frozen_ms: number };
  // PHASE 5 — THE ACCEPTANCE VERDICT against the frozen baseline. PRESENT iff the run reached the
  // forced acceptance gate (a baseline existed when the last child summarized) AND the user resolved
  // it. Two shapes:
  //   - "approved": the built result clears the baseline floor (the default success verdict).
  //   - "diverged": the user accepted a result that does NOT meet the baseline floor and recorded
  //     WHY (`reason` — a serializable, round-tripped string the planner/handoff reads). A divergence
  //     is still a completion (the tree finalizes), but the recorded reason is the audit trail for
  //     why the floor was waived.
  // OPTIONAL + additive (schema stays 2): a tree with NO baseline never reaches the gate, so this
  // field is absent and behavior is byte-identical to today (immediate finalize). The reducer never
  // reads a clock — `decided_ms` rides the resolving event (ACCEPTANCE_APPROVED/DIVERGED).
  acceptance_?:
    | { verdict: "approved"; decided_ms: number }
    | { verdict: "diverged"; reason: string; decided_ms: number };
  // QUOTA AUTO-RESUME BUDGET (the usage-limit pause/resume feature). PRESENT iff the run was started
  // with an auto-resume budget (the composer's quota-resume choice → QUOTA_BUDGET_SET at START): a
  // FINITE count of how many times a quota pause may auto-resume itself before the run must exhaust.
  // `budget` is the original allotment (for display/audit); `remaining` is the live countdown that
  // QUOTA_RESUMED decrements. OPTIONAL + additive (schema STAYS 2): an old/legacy state.json without
  // it deserializes to undefined. THE FAIL-CLOSED DEFAULT lives in the reducer, NOT here: an ABSENT
  // field (no budget was ever set — the resume() path, a legacy ledger) is treated as remaining 0, so
  // a quota pause with no budget goes STRAIGHT to exhausted and NEVER auto-resumes. "Once" is a UI
  // default only; the unset-ledger default is always 0. Pause itself is NOT stored here — it is
  // in-memory orchestrator state (same-process scope), so a killed run never resumes from a stale
  // "paused" flag.
  auto_resume_?: { budget: number; remaining: number };
}

// THE UNIFIED APPROVAL GATE (gen 2): ONE shape for ALL held-ExitPlanMode gates — the root
// decomposition gate included. The gen-1 `nn: -1` sentinel does not exist here: a gate is
// addressed by its NodePath and discriminated by `kind` ("decomposition" = the node's split plan
// is awaiting approval; "leaf" = the node's own plan is). Transient — never serialized.
export interface ApprovalGate2 {
  readonly path: NodePath;
  readonly kind: "decomposition" | "leaf";
  readonly toolUseId: string;
  readonly planPath: string;
  readonly plansDirPath: string;
  readonly redraftCount: number;
}

// The gen-2 in-memory state: the persisted schema-2 ledger PLUS transient fields that are NEVER
// serialized (they live only while held open this session):
//   - pendingApproval: the unified gate (decomposition AND leaf — no sentinel).
//   - pendingClarify: the held AskUserQuestion gate, carried over from gen 1 as-is.
//   - parsedChildren: children parsed from a decomposition DRAFT, stashed until the gate resolves.
//     They are deliberately NOT in the tree yet: a split node's phases (running-children/reviewing/
//     summarized) all require child activity the gate window cannot have (assertCoherent2's
//     exactly-one-active rule; the plan's diagram enters RunKids only on approve), and the `open`
//     stage is structurally child-free. DECOMPOSITION_APPROVED materializes the split from this
//     stash; DECOMPOSITION_CHANGES_REQUESTED discards it (the redraft re-parses).
//   - pendingPrototype: the held visual-prototype gate. Transient like pendingClarify: it is
//     NEVER serialized into the schema-2 ledger (no resume-from-disk exists — see RecursiveLedger —
//     so a persisted gate could only describe a review the restarted session can no longer
//     resolve; the prototype turn simply re-runs).
//   - pendingAcceptance: PHASE 5's held forced-acceptance gate. Transient like pendingPrototype: it
//     is opened when the root's last child summarizes WITH a baseline present (the reducer holds the
//     root in its running-children acceptance window instead of finalizing) and cleared by
//     ACCEPTANCE_APPROVED/ACCEPTANCE_DIVERGED. NEVER serialized — a resumed run re-presents it from
//     the tree shape + baseline_, never from a persisted gate.
export interface PlanTreeState2 extends RecursiveLedger {
  pendingApproval: ApprovalGate2 | null;
  pendingClarify: ClarifyGate | null;
  pendingPrototype: PrototypeGate | null;
  pendingAcceptance: AcceptanceGate | null;
  parsedChildren: { readonly path: NodePath; readonly children: NonEmptyArray<TreeNode> } | null;
}

// The gen-2 read-only snapshot: the ledger's tree plus DERIVED fields (active path, write policy,
// done) so consumers never re-derive them divergently, plus the transient gates (mirroring the
// gen-1 snapshot, which carried pendingApproval/pendingClarify to the UI).
export interface PlanTreeSnapshot2 {
  readonly treeId: string;
  readonly root: TreeNode;
  readonly activePath: NodePath | null;
  readonly writePolicy: WritePolicy;
  readonly done: boolean;
  readonly pendingApproval: ApprovalGate2 | null;
  readonly pendingClarify: ClarifyGate | null;
  readonly pendingPrototype: PrototypeGate | null;
  readonly pendingAcceptance: AcceptanceGate | null;
}

// Deep-clone a node recursively so projections never alias the live state's tree.
function cloneNode(node: TreeNode): TreeNode {
  const state: NodeState =
    node.state.stage === "split"
      ? { ...node.state, children: nonEmpty(node.state.children.map(cloneNode)) }
      : { ...node.state };
  return { ...node, state };
}

// Derive the schema-2 serializable ledger (deep-copied; excludes any future transient gates) —
// what the driver will persist to state.json after the swap.
export function toLedger2(state: PlanTreeState2): RecursiveLedger {
  return {
    schema: 2,
    tree_id: state.tree_id,
    created_ms: state.created_ms,
    updated_ms: state.updated_ms,
    root: cloneNode(state.root),
    sdk_session_id: state.sdk_session_id,
    // Carry the frozen working-reference record through persistence (deep-copied so the ledger
    // never aliases live state). Absent ⇒ omitted (sketch — today's behavior unchanged).
    baseline_: state.baseline_ ? { ...state.baseline_ } : undefined,
    // PHASE 5 — carry the acceptance verdict (incl. the divergence reason) through persistence so a
    // resumed/reopened ledger keeps the recorded audit trail. Deep-copied; absent ⇒ omitted (the
    // no-baseline path never sets it, so this stays byte-identical to today there).
    acceptance_: state.acceptance_ ? { ...state.acceptance_ } : undefined,
    // Carry the quota auto-resume budget through persistence (deep-copied so the ledger never aliases
    // live state). Absent ⇒ omitted (no budget was set — byte-identical to today's no-quota behavior).
    auto_resume_: state.auto_resume_ ? { ...state.auto_resume_ } : undefined,
  };
}

// Derive the gen-2 read-only snapshot (ledger tree + derived fields + transient gates).
export function toSnapshot2(state: PlanTreeState2): PlanTreeSnapshot2 {
  return {
    treeId: state.tree_id,
    root: cloneNode(state.root),
    activePath: activePathOf(state.root),
    writePolicy: writePolicyFor2(state.root),
    done: treeIsDone(state.root),
    pendingApproval: state.pendingApproval,
    pendingClarify: state.pendingClarify,
    pendingPrototype: state.pendingPrototype,
    pendingAcceptance: state.pendingAcceptance,
  };
}

// Run completion is DERIVED, never stored: the tree is done iff the ROOT has summarized (leaf or
// split). "done" is deliberately NOT a NodeState phase — a non-root "done" is unrepresentable.
// PHASE 5 — the forced acceptance gate keeps `treeIsDone` FALSE while it is open: the root rests in
// its `running-children` acceptance window (NOT `summarized`) until ACCEPTANCE_APPROVED/DIVERGED
// finalizes it, so a baseline-bearing tree can never read done without a recorded verdict.
export function treeIsDone(root: TreeNode): boolean {
  return root.state.stage !== "open" && root.state.phase === "summarized";
}

// ---- gen-2 tree navigation --------------------------------------------------------------------

// Resolve the node at `path` under `root` (root itself for []). Returns null when the path walks
// off the tree — a missing child segment, or a segment under a non-split node (only split states
// HAVE children, so descent through open/leaf is structurally impossible).
export function nodeAtPath(root: TreeNode, path: NodePath): TreeNode | null {
  let cur: TreeNode = root;
  for (const seg of path) {
    if (cur.state.stage !== "split") return null;
    const child = cur.state.children.find((c) => c.nn === seg);
    if (!child) return null;
    cur = child;
  }
  return cur;
}

// The path of the ONE active node — the node the sequencer dispatches on — or null when nothing
// is in flight (a fresh pending tree, or a done tree). PRECISE DEFINITION (depth-first):
//   - open/pending → not active (not started); any OTHER open phase → the node itself is active.
//   - leaf → active unless summarized.
//   - split summarized → nothing active below a completed subtree.
//   - split REVIEWING → the reviewing PARENT IS the active node for dispatch (the review turn is
//     the parent's turn; coherence guarantees no child is active during it).
//   - split running-children → the active node is the single active DESCENDANT (the parent is
//     bookkeeping, not dispatchable); zero active children under running-children is incoherent
//     and throws LOUDLY rather than silently dispatching on the parent.
// Serves sequencer dispatch ONLY — writePolicyFor2 is deliberately independent of this.
export function activePathOf(root: TreeNode): NodePath | null {
  return activeWithin(root, []);
}

function activeWithin(node: TreeNode, prefix: NodePath): NodePath | null {
  switch (node.state.stage) {
    case "open":
      return node.state.phase === "pending" ? null : prefix;
    case "leaf":
      return node.state.phase === "summarized" ? null : prefix;
    case "split": {
      if (node.state.phase === "summarized") return null;
      if (node.state.phase === "reviewing") return prefix;
      // running-children: descend depth-first to the single active descendant.
      for (const child of node.state.children) {
        const found = activeWithin(child, [...prefix, child.nn]);
        if (found !== null) return found;
      }
      // PHASE 4 ROLL-UP WINDOW: a NON-ROOT split whose children are ALL summarized has no active
      // descendant — the split node ITSELF is the active node (its roll-up summary turn is the one
      // in flight; SUMMARY_WRITTEN{this path} completes it).
      if (prefix.length > 0 && inRollupWindow(node)) return prefix;
      // PHASE 5 ACCEPTANCE WINDOW: the ROOT resting running-children with ALL children summarized is
      // the forced-acceptance hold — the ROOT itself is the active node (the acceptance verdict is
      // its "turn"; ACCEPTANCE_APPROVED/DIVERGED resolves it). Without a baseline the reducer never
      // parks the root here (it finalizes in the same reduction), so this path is only reached with
      // the gate held — but activePathOf reads the TREE alone, so the allowance is structural, like
      // the roll-up window's.
      if (prefix.length === 0 && inAcceptanceWindow(node)) return prefix;
      throw new Error(
        `incoherent: split node at "${pathKey(prefix)}" is running-children with no active child`,
      );
    }
  }
}

// ---- gen-2 derived write policy ---------------------------------------------------------------

// PURE projection, ROOT-PHASE-AWARE then TREE-WIDE EXISTENTIAL:
//   - the ROOT in its intent-clarification window (open clarifying-intent OR prototype-review) →
//     "prototype": throwaway visual-prototype artifacts may be written, but no plan exists yet.
//     GENESIS therefore derives "prototype" (a fresh tree opens in clarifying-intent); recon
//     onward falls through to the existential below.
//   - otherwise the session is writable ("acceptEdits") iff SOME node anywhere in the tree is a
//     leaf in `executing` — at ANY depth — else "plan". Defined INDEPENDENTLY of activePathOf
//     (which serves dispatch): the policy must hold even if dispatch derivation drifted. Note the
//     type system already guarantees the witness is a LEAF: `executing` is not a split phase.
export function writePolicyFor2(root: TreeNode): WritePolicy {
  if (
    root.state.stage === "open" &&
    (root.state.phase === "clarifying-intent" || root.state.phase === "prototype-review")
  ) {
    return "prototype";
  }
  return someNodeExecuting(root) ? "acceptEdits" : "plan";
}

function someNodeExecuting(node: TreeNode): boolean {
  if (node.state.stage === "leaf") return node.state.phase === "executing";
  if (node.state.stage === "split") return node.state.children.some(someNodeExecuting);
  return false;
}

// ---- gen-2 coherence invariants ---------------------------------------------------------------

// A child's coarse status for the per-level partition. "summarized" = completed (leaf or split);
// "pending" = not started (open/pending); everything else is "active" (in flight).
type ChildStatus = "summarized" | "active" | "pending";

function statusOf(node: TreeNode): ChildStatus {
  if (node.state.stage === "open") {
    return node.state.phase === "pending" ? "pending" : "active";
  }
  return node.state.phase === "summarized" ? "summarized" : "active";
}

// Throw on any incoherent gen-2 tree. Enforces, for what the types CANNOT express:
//   (1) no leaf may be `executing` anywhere under a `reviewing` ancestor (the review turn is
//       no-tools — concurrent execution below it would race the review) — checked in a dedicated
//       first pass so its violation is reported as ITSELF, not masked by a partition error;
//   (2) per-level partition: each split's children read summarized* active? pending* left-to-right
//       (left siblings completed, AT MOST one in flight, right siblings untouched);
//   (3) parent split phase ↔ children: `running-children` iff EXACTLY one child active — EXCEPT
//       the PHASE-4 roll-up window: a NON-ROOT split may rest running-children with ZERO active
//       and ALL children summarized (awaiting its roll-up summary turn; the root may not — it
//       writes no roll-up);
//       `reviewing` only BETWEEN children (no child active, ≥1 summarized behind, ≥1 pending
//       ahead — never before the first or after the last child); `summarized` only when ALL
//       children are summarized (a parent may not complete with an incomplete child);
//   (4) root-only phases at depth 0: `clarifying-intent` and `prototype-review` are illegal below
//       the root. (`done` needs no rule — it is not a representable NodeState phase; see
//       treeIsDone.)
export function assertCoherent2(root: TreeNode): void {
  assertNoExecutingUnderReviewing(root, false);
  assertStructure(root, []);
}

// Pass 1 — rule (1): scan the whole tree carrying an "ancestor is reviewing" flag.
function assertNoExecutingUnderReviewing(node: TreeNode, underReviewing: boolean): void {
  if (underReviewing && node.state.stage === "leaf" && node.state.phase === "executing") {
    throw new Error("incoherent: a leaf is executing under a reviewing ancestor");
  }
  if (node.state.stage === "split") {
    const flag = underReviewing || node.state.phase === "reviewing";
    for (const child of node.state.children) assertNoExecutingUnderReviewing(child, flag);
  }
}

// Pass 2 — rules (2)(3)(4): recursive structural walk (path threaded for loud error messages).
function assertStructure(node: TreeNode, path: NodePath): void {
  const at = path.length === 0 ? "root" : `"${pathKey(path)}"`;

  // (4) root-only phases at depth 0 (clarifying-intent AND its prototype-review gate window).
  if (
    path.length > 0 &&
    node.state.stage === "open" &&
    (node.state.phase === "clarifying-intent" || node.state.phase === "prototype-review")
  ) {
    throw new Error(`incoherent: non-root node ${at} is ${node.state.phase} (root-only phase)`);
  }

  if (node.state.stage !== "split") return;
  const children = node.state.children;

  // (0) SIBLING-nn UNIQUENESS: a "types-cannot-express" invariant — the NonEmptyArray type proves
  // children is non-empty but cannot prove the nn segments are distinct, and the navigation
  // primitives resolve nn to the FIRST match, so a duplicate-nn pair silently aliases. The
  // CHILDREN_PARSED parse boundary already rejects this for live drafts; this is defense in depth
  // for any tree (resume rehydration, hand-built fixtures) that reaches rest with a collision.
  const seenNn = new Set<Nn>();
  for (const c of children) {
    if (seenNn.has(c.nn)) {
      throw new Error(`incoherent: ${at} has duplicate sub-plan nn "${pathKey([c.nn])}" among its children`);
    }
    seenNn.add(c.nn);
  }

  const statuses = children.map(statusOf);

  // (2) per-level partition: summarized* active? pending*. Walk left-to-right through the three
  // zones; any status that steps BACKWARD (or a second active) is incoherent.
  let zone: ChildStatus = "summarized";
  for (let i = 0; i < children.length; i++) {
    const st = statuses[i];
    const childAt = `"${pathKey([...path, children[i].nn])}"`;
    if (st === "summarized") {
      if (zone !== "summarized") {
        throw new Error(`incoherent: summarized child ${childAt} right of a non-summarized sibling`);
      }
    } else if (st === "active") {
      if (zone === "active") {
        throw new Error(`incoherent: second active child ${childAt} (at most one active sibling)`);
      }
      if (zone === "pending") {
        throw new Error(`incoherent: active child ${childAt} right of a pending sibling`);
      }
      zone = "active";
    } else {
      zone = "pending";
    }
  }

  // (3) parent phase ↔ children.
  const activeCount = statuses.filter((s) => s === "active").length;
  const summarizedCount = statuses.filter((s) => s === "summarized").length;
  const pendingCount = statuses.filter((s) => s === "pending").length;
  if (node.state.phase === "running-children" && activeCount !== 1) {
    // PHASE-4 ROLL-UP WINDOW allowance: a NON-ROOT split legally rests running-children with all
    // children summarized while its roll-up summary turn is in flight.
    // PHASE-5 ACCEPTANCE WINDOW allowance: the ROOT — previously excluded (a root resting here was a
    // missed completion) — now ALSO legally rests running-children with all children summarized: the
    // forced-acceptance hold (running-children, not summarized, so treeIsDone stays false) while the
    // user records a verdict against the frozen baseline. The shape is structurally identical to the
    // non-root roll-up window; whether THIS root is legitimately parked (a baseline exists, the gate
    // is held) or stuck is a transient-state concern (pendingAcceptance + the reducer's discipline),
    // not a tree-structure one — exactly as the roll-up window's legitimacy lives in the driver's
    // event stream, not in the tree. So the all-summarized allowance now covers the root too.
    const allSummarizedWindow = activeCount === 0 && summarizedCount === children.length;
    if (!allSummarizedWindow) {
      throw new Error(
        `incoherent: ${at} is running-children with ${activeCount} active children (exactly 1 required)`,
      );
    }
  }
  if (node.state.phase === "reviewing") {
    if (activeCount !== 0) {
      throw new Error(`incoherent: ${at} is reviewing while a child is active`);
    }
    if (summarizedCount === 0 || pendingCount === 0) {
      throw new Error(
        `incoherent: ${at} is reviewing outside the between-children window (needs >=1 summarized and >=1 pending child)`,
      );
    }
  }
  if (node.state.phase === "summarized" && summarizedCount !== children.length) {
    throw new Error(`incoherent: ${at} is summarized with an incomplete child`);
  }

  for (const child of children) assertStructure(child, [...path, child.nn]);
}

// ---- gen-2 events (path-based discriminated union) ---------------------------------------------
//
// PHASE-1 DEPTH-1 SCOPE: events carry full NodePaths, but this phase only handles the root ([])
// and depth-1 children ([nn]); any deeper path throws LOUDLY ("not yet supported" — PHASE 4
// unlocks depth > 1 with the per-node sizer). The gen-1 nn-addressed events map 1:1:
//   RECON_DONE/SUB_RECON_DONE → NODE_RECON_DONE; MASTER_DRAFTED → DECOMPOSITION_DRAFTED;
//   SUBPLANS_PARSED → CHILDREN_PARSED; MASTER_APPROVED → DECOMPOSITION_APPROVED;
//   SUB_DRAFTED → NODE_DRAFTED; APPROVE/REQUEST_CHANGES/EXEC_DONE/SUMMARY_WRITTEN keep their
//   names path-addressed; the master REQUEST_CHANGES (gen-1 driver-side only, no reducer event)
//   becomes the first-class DECOMPOSITION_CHANGES_REQUESTED.
//
// DRIVER-WRITE BOUNDARY (cutover seam): gen-2 events carry NO plan/recon TEXT. The driver
// physically writes the artifact FIRST and dispatches the event with the write's real returned
// paths — generalizing the gen-1 SUMMARY_WRITTEN precedent (and matching what the gen-1 driver
// ALREADY does for sub plans: it calls writeAgentPlan itself and no-ops the reducer's effect via
// wrotePlanForNn). Consequently Effect2 has NO writeAgentPlan kind, and NODE_RECON_DONE emits no
// recon.md write (the driver writes recon.md itself before dispatching — cutover seam).
export type PlanTreeEvent2 =
  | { type: "START"; treeId: string; request: string; nowMs: number }
  | { type: "INTENT_CLARIFIED"; intent: string }
  // THE VISUAL-PROTOTYPE GATE (root-only, no path — like INTENT_CLARIFIED these address the root's
  // genesis window). PROTOTYPE_READY opens the gate (clarifying-intent → prototype-review);
  // PROTOTYPE_APPROVED resolves it forward (→ recon, writing INTENT.md exactly as INTENT_CLARIFIED
  // does — INTENT_CLARIFIED remains the unchanged no-prototype fallback); PROTOTYPE_REFINED loops
  // back (→ clarifying-intent) for another prototype round with the user's feedback (the feedback
  // text is DRIVER-side prompt material, never stored on the ledger — same boundary as the
  // parent-review note).
  | { type: "PROTOTYPE_READY"; gate: PrototypeGate }
  // PROTOTYPE_APPROVED resolves the gate forward (→ recon, writing INTENT.md). `asWorkingReference`
  // classifies the approval: false (DEFAULT — "just a sketch") leaves the ledger untouched beyond
  // the recon hop (today's behavior); true ("working reference") additionally records the frozen
  // baseline (`baseline_`). baseline_ is recorded ONLY when the freeze succeeded (a presence record
  // must match disk): the DRIVER sets this flag true only AFTER it has frozen `.plan-tree/prototype/`
  // into `.plan-tree/baseline/` without throwing — a freeze failure dispatches false (recon still
  // proceeds, but no baseline is claimed). `frozenMs` rides the event (the reducer never reads a clock
  // — START's `nowMs` precedent) and is stored only when `asWorkingReference` is true.
  | { type: "PROTOTYPE_APPROVED"; intentContents: string; asWorkingReference: boolean; frozenMs: number }
  | { type: "PROTOTYPE_REFINED"; feedback: string }
  | { type: "NODE_RECON_DONE"; path: NodePath }
  | { type: "SIZER_DONE"; path: NodePath; outcome: SizerOutcome }
  | { type: "DECOMPOSITION_DRAFTED"; path: NodePath; planPath: string; plansDirPath: string; toolUseId: string }
  // INV-3 — THE RESUME PHASE-ONLY RE-ARM (no path beyond the addressed node). On resume the disk-probe
  // gate branch re-presents a decomposition gate from a node still at `open/decomposing` (the
  // transient DECOMPOSITION_DRAFTED event died with the killed process), while the DRIVER sets
  // pendingApproval + fires onAwaitingApproval DIRECTLY (effect-free — there is no DRAFTED event to
  // replay). This event advances ONLY the node phase `open/decomposing` → `open/awaiting-decomposition-
  // approval` so a subsequent Approve's DECOMPOSITION_APPROVED guard is satisfied. It emits NO effects
  // (no persist, no notify) — re-dispatching DECOMPOSITION_DRAFTED would double-fire the gate (the
  // driver already presented it). Legal ONLY from `open/decomposing` (the resumed gate shape); any
  // other phase throws LOUDLY.
  | { type: "GATE_RE_PRESENTED"; path: NodePath }
  | { type: "CHILDREN_PARSED"; path: NodePath; children: ReadonlyArray<{ nn: Nn; title: string }> }
  | { type: "DECOMPOSITION_APPROVED"; path: NodePath }
  | { type: "DECOMPOSITION_CHANGES_REQUESTED"; path: NodePath; feedback: string }
  | { type: "NODE_DRAFTED"; path: NodePath; planPath: string; plansDirPath: string; toolUseId: string }
  | { type: "APPROVE"; path: NodePath }
  | { type: "REQUEST_CHANGES"; path: NodePath; feedback: string }
  | { type: "EXEC_DONE"; path: NodePath }
  // The DRIVER physically writes summaryName2(path) and dispatches this with the write's real
  // returned path — the reducer only RECORDS it (no write effect), exactly as in gen 1.
  | { type: "SUMMARY_WRITTEN"; path: NodePath; summaryText: string; summaryPath: PlanTreeFilePath }
  // PHASE 5 — the parent-review turn ended (ADJUST note or NONE). `path` addresses the REVIEWING
  // parent (the active node during the review window). `note` rides the event for traceability
  // only: the reducer never stores it (the note is DRIVER-side state, never persisted — same
  // boundary as summaries/mandates). reviewing → running-children + next pending child → recon.
  | { type: "PARENT_REVIEW_DONE"; path: NodePath; note: string | null }
  // PHASE 5 — THE FORCED ACCEPTANCE GATE RESOLUTIONS (root-only, no path — they address the root's
  // completion window, like the prototype gate addresses the genesis window). Both perform the
  // ORIGINAL finalize the gate deferred (root running-children acceptance window → summarized +
  // notifyDone) and clear pendingAcceptance. Legal ONLY while the gate is open (the root resting in
  // its acceptance window with pendingAcceptance set); dispatched anywhere else throws LOUDLY.
  //   - ACCEPTANCE_APPROVED: the built result clears the baseline floor. Records acceptance_ =
  //     {verdict:"approved", decided_ms}.
  //   - ACCEPTANCE_DIVERGED: the user accepted a result below the floor and recorded WHY. Records
  //     acceptance_ = {verdict:"diverged", reason, decided_ms} — `reason` is a serializable field
  //     round-tripped through toLedger2/rehydrate. `decidedMs` rides the event (the reducer never
  //     reads a clock — START's nowMs precedent).
  | { type: "ACCEPTANCE_APPROVED"; decidedMs: number }
  | { type: "ACCEPTANCE_DIVERGED"; reason: string; decidedMs: number }
  // PHASE 6 — THE FORCED-ACCEPTANCE REFINE (re-plan) BRANCH. A THIRD acceptance-gate action, beside
  // approve and accept-divergence: re-plan a chosen sub-plan as a first-class operation. `target`
  // addresses the node to re-plan (a non-empty path — the root [] is illegal: the root writes no
  // plan/summary and re-planning the whole tree is "start a new plan", not a refine). The reset is
  // the ENTIRE STORY — there is deliberately NO "stale summary" flag: RESET the target node AND every
  // RIGHT-SIBLING at the target's level back to a fresh re-execution shape (target → open/recon
  // active, right-siblings → open/pending), preserving the LEFT-siblings as summarized. The result is
  // a coherent `summarized* active pending*` per-level partition assertCoherent2 already permits, so
  // the normal executing→summary→advanceAfterSummary flow re-runs the reset nodes and OVERWRITES
  // their summaries; on the root's re-completion (baseline_ still present, acceptance_ still absent)
  // the Phase-5 acceptance gate RE-ARMS automatically. Clears pendingAcceptance (we are executing
  // again) and records NO verdict. Legal ONLY while the acceptance gate is open (the root resting in
  // its acceptance window with pendingAcceptance set); dispatched anywhere else throws LOUDLY.
  | { type: "ACCEPTANCE_REFINED"; target: NodePath }
  | { type: "CLARIFY_REQUESTED"; toolUseId: string; questions: AskUserQuestionItem[] }
  | { type: "CLARIFY_ANSWERED"; toolUseId: string; answers: AskUserQuestionAnswers }
  // SESSION-CAPTURE ARC (resume support): the SDK session_id arrived on the system_init frame. This
  // is NOT a node transition — it stamps the run-level sdk_session_id onto the ledger and SELF-
  // PERSISTS so a killed run leaves a resumable id on disk (the id is never carried by a later node
  // transition). Idempotent: a re-dispatched same id is a no-op (no change, no persist effect).
  | { type: "SESSION_INITIALIZED"; sessionId: string }
  // QUOTA AUTO-RESUME ARC (usage-limit pause/resume). These are RUN-LEVEL events (no path — they
  // address the run's auto-resume budget, like SESSION_INITIALIZED addresses the run's session id),
  // and like every gen-2 event the reducer reads NO clock: every timestamp rides its event.
  //   - QUOTA_BUDGET_SET: dispatched at START from the composer's quota-resume choice. Sets
  //     auto_resume_ = { budget, remaining: budget } — the run's auto-resume allotment. NOT dispatched
  //     on the resume() path (a resumed run has no fresh choice — it keeps its persisted budget, or
  //     fails closed at 0 if none was set).
  //   - QUOTA_PAUSED: a usage-limit quota_exceeded frame arrived; the run is paused until `resetAt`
  //     (epoch ms — the provider's reset time, ridden on the event). `source` names the limit that
  //     tripped (display/audit only). The reducer DECIDES whether this pause can auto-resume:
  //     remaining > 0 ⇒ notifyQuotaPaused (a countdown to auto-resume); remaining === 0 (or no budget)
  //     ⇒ notifyQuotaExhausted (no auto-resume left).
  //   - QUOTA_RESUMED: the orchestrator's auto-resume timer fired (or the user resumed manually);
  //     decrement remaining by one (down to the floor 0). `nowMs` rides the event (no clock read).
  //   - QUOTA_EXHAUSTED: a terminal exhaust signal (the run cannot auto-resume further). Emits
  //     notifyQuotaExhausted; the budget is left as-is (already 0 in the auto-resume flow).
  | { type: "QUOTA_BUDGET_SET"; budget: number }
  | { type: "QUOTA_PAUSED"; resetAt: number; source: string }
  | { type: "QUOTA_RESUMED"; nowMs: number }
  | { type: "QUOTA_EXHAUSTED"; resetAt: number; source: string }
  | { type: "FATAL"; message: string };

// ---- gen-2 effects (the reducer DECIDES; the driver EXECUTES) ----------------------------------
//
// Same effect KINDS and per-event ordering as gen 1 at depth 1, with two deliberate deltas (both
// driver-cutover seams, documented on PlanTreeEvent2 above):
//   - NO writeAgentPlan kind (the driver writes plans before dispatching DRAFTED events);
//   - NODE_RECON_DONE emits no writePlanTreeFile (recon.md becomes a driver write);
//   - notifyAwaitingApproval now fires for DECOMPOSITION_DRAFTED too (gate unification: the gen-1
//     driver surfaced the master gate itself via the nn:-1 sentinel — the reducer owns it now).
export type Effect2 =
  // Persist the ledger (toLedger2) to .plan-tree/state.json.
  | { kind: "persist" }
  // Archive every current entry of <cwd>/.plan-tree/ (START only, BEFORE persist).
  | { kind: "resetPlanTreeDir" }
  // Write an auxiliary plan-tree file (gen 2 emits this for INTENT.md only — see the seam note).
  | { kind: "writePlanTreeFile"; name: string; contents: string }
  // PHASE 6 — Delete an auxiliary plan-tree file (the refine branch's per-reset-node cleanup). Emitted
  // by ACCEPTANCE_REFINED for each reset node's `NN-plan.md` and `NN-summary.md`, so the re-executed
  // sub-plans overwrite a clean slate (a stale summary cannot survive a re-plan). The driver's delete
  // is the SAME containment-guarded allow-list as writePlanTreeFile (deletePlanTreeFile reuses
  // guarded_plan_tree_path), and absent ⇒ graceful no-op (a leaf node never wrote `NN-plan.md`).
  | { kind: "deletePlanTreeFile"; name: string }
  // Resolve a held canUseTool permission (ExitPlanMode / AskUserQuestion).
  | { kind: "resolvePermission"; id: string; allow: boolean; message?: string }
  // Surface that a node (decomposition OR leaf — unified) is awaiting the user's approval.
  | { kind: "notifyAwaitingApproval"; gate: ApprovalGate2 }
  // Surface that a visual prototype is awaiting the user's review (the root prototype gate).
  | { kind: "notifyPrototypeReview"; gate: PrototypeGate }
  // PHASE 5 — Surface the forced acceptance gate: the run is complete EXCEPT the user must record a
  // verdict against the frozen baseline (Approve / Accept divergence). The driver opens the baseline
  // (open_baseline) and surfaces the Approve/Diverge actions; notifyDone is WITHHELD until one of
  // ACCEPTANCE_APPROVED/DIVERGED resolves the gate.
  | { kind: "notifyAcceptanceReview"; gate: AcceptanceGate }
  // Surface that a node's summary was written (path-branded — never the summary text).
  | { kind: "notifySummaryWritten"; path: NodePath; summaryPath: PlanTreeFilePath }
  // Surface that the whole tree is done.
  | { kind: "notifyDone" }
  // QUOTA AUTO-RESUME — surface that the run is PAUSED on a usage limit and WILL auto-resume. The
  // driver starts a countdown to `resetAt` and arms the auto-resume timer; `remaining` is the
  // post-pause auto-resume count it may display ("N auto-resumes left"); `source` names the limit.
  | { kind: "notifyQuotaPaused"; resetAt: number; remaining: number; source: string }
  // QUOTA AUTO-RESUME — surface that the run is PAUSED with NO auto-resume left (budget exhausted, or
  // never set — the fail-closed default). The driver surfaces a paused-until-`resetAt` state but does
  // NOT auto-resume; only a manual user action continues the run. `source` names the limit.
  | { kind: "notifyQuotaExhausted"; resetAt: number; source: string }
  // Surface a fatal error.
  | { kind: "notifyFatal"; message: string };

// ---- gen-2 summary filename ---------------------------------------------------------------------

// The on-disk summary filename for a node: the dotted pathKey + "-summary.md". A single segment
// degenerates to the legacy flat shape ("01-summary.md" — byte-identical to gen-1 summaryName), so
// Phase-1 depth-1 filenames are unchanged on disk. The ROOT writes no roll-up summary (run
// completion is DERIVED — see treeIsDone), so the empty path throws loudly.
export function summaryName2(path: NodePath): string {
  if (path.length === 0) {
    throw new Error("summaryName2: the root writes no summary file (completion is derived, not summarized)");
  }
  return `${pathKey(path)}-summary.md`;
}

// The on-disk DECOMPOSITION-plan filename for a split node (PHASE 4): the root keeps its legacy
// "master.md" (root-only artifact special case); a non-root split writes the dotted
// `<pathKey>-plan.md` (summaryName2-style naming) — e.g. "02-plan.md", "02.01-plan.md".
export function planName2(path: NodePath): string {
  if (path.length === 0) return "master.md";
  return `${pathKey(path)}-plan.md`;
}

// ---- gen-2 reducer helpers ----------------------------------------------------------------------

// A freshly-minted pending child (the gen-2 makeSub: artifact-free by CONSTRUCTION — the open
// stage has no path fields, so "no artifacts yet" is structural, not null-at-rest).
function makeNode2(nn: Nn, title: string): TreeNode {
  return { nn, title, redraftCount: 0, lastFeedback: null, state: { stage: "open", phase: "pending" } };
}

// Construct the fresh initial gen-2 state for a brand-new tree. The root's nn is conventional
// (parseNn(1), never read — paths derive from CHILD segments only); its title records the request.
function initial2(treeId: string, request: string, nowMs: number): PlanTreeState2 {
  return {
    schema: 2,
    tree_id: treeId,
    created_ms: nowMs,
    updated_ms: nowMs,
    root: {
      nn: parseNn(1),
      title: request,
      redraftCount: 0,
      lastFeedback: null,
      // GENESIS: the run opens with the intent-clarifier (root-only phase), exactly as in gen 1.
      state: { stage: "open", phase: "clarifying-intent" },
    },
    // No SDK session yet — captured on the first system_init frame (SESSION_INITIALIZED).
    sdk_session_id: undefined,
    // No working reference yet — set iff the user picks "working reference" at the prototype gate.
    baseline_: undefined,
    // No acceptance verdict yet — set only when the forced acceptance gate resolves.
    acceptance_: undefined,
    // No quota auto-resume budget yet — set by QUOTA_BUDGET_SET (dispatched at START from the
    // composer's quota-resume choice). Absent ⇒ the fail-closed reducer default (remaining 0).
    auto_resume_: undefined,
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    pendingAcceptance: null,
    parsedChildren: null,
  };
}

// Clone gen-2 state immutably (deep tree copy) so the reducer never mutates its input.
function clone2(state: PlanTreeState2): PlanTreeState2 {
  return {
    schema: 2,
    tree_id: state.tree_id,
    created_ms: state.created_ms,
    updated_ms: state.updated_ms,
    root: cloneNode(state.root),
    sdk_session_id: state.sdk_session_id,
    baseline_: state.baseline_ ? { ...state.baseline_ } : undefined,
    acceptance_: state.acceptance_ ? { ...state.acceptance_ } : undefined,
    auto_resume_: state.auto_resume_ ? { ...state.auto_resume_ } : undefined,
    pendingApproval: state.pendingApproval,
    pendingClarify: state.pendingClarify,
    pendingPrototype: state.pendingPrototype,
    pendingAcceptance: state.pendingAcceptance,
    parsedChildren: state.parsedChildren,
  };
}

// Return a NEW tree with the node at `path` replaced by `replace(old)` — every untouched node is
// carried by reference-copy, the spine is rebuilt immutably. Throws loudly on a path that walks
// off the tree (descent through a non-split, or a missing segment).
function replaceAt(node: TreeNode, path: NodePath, replace: (n: TreeNode) => TreeNode): TreeNode {
  if (path.length === 0) return replace(node);
  if (node.state.stage !== "split") {
    throw new Error(`replaceAt: cannot descend "${pathKey(path)}" under a ${node.state.stage} node`);
  }
  const seg = path[0];
  if (!node.state.children.some((c) => c.nn === seg)) {
    throw new Error(`replaceAt: no child ${seg} at "${pathKey(path)}"`);
  }
  const children = nonEmpty(
    node.state.children.map((c) => (c.nn === seg ? replaceAt(c, path.slice(1), replace) : c)),
  );
  return { ...node, state: { ...node.state, children } };
}

// PHASE 4: the depth-1 guard (requireDepth1) is GONE — every arc is path-generic and the tree
// recurses without limit. Two derived predicates replace the special cases it covered:

// Whether `path` addresses THE root single-collapse child: the SOLE child of a root split holding
// NO decomposition plan (planPath null ⇒ no decomposition was ever drafted ⇒ the split was minted
// by the root confident-single collapse, the only arc that creates a planPath-less split). That
// child INHERITED the root sizer's `single` verdict — running a second sizer over the same scope
// would let one request be sized twice — so it skips the per-node sizer and goes straight to
// leaf/drafting (preserving the gen-1 golden depth-1 single trace byte-for-byte).
export function isRootCollapseChild(root: TreeNode, path: NodePath): boolean {
  return (
    path.length === 1 &&
    root.state.stage === "split" &&
    root.state.planPath === null &&
    root.state.children.length === 1
  );
}

// Whether a split node sits in its ROLL-UP WINDOW: running-children with EVERY child summarized.
// This is the (non-root-only — coherence forbids it at the root) state a split rests in after its
// last child's SUMMARY_WRITTEN, while the DRIVER runs the roll-up summary turn; the node's own
// SUMMARY_WRITTEN{path} then completes it to split/summarized. The window deliberately re-uses
// `running-children` (no new phase): the persisted schema is untouched, `reviewing` stays reserved
// for Phase 5's parent-review, and the window is fully DERIVED from the children — a stored flag
// could disagree with them.
export function inRollupWindow(node: TreeNode): boolean {
  return (
    node.state.stage === "split" &&
    node.state.phase === "running-children" &&
    node.state.children.every((c) => c.state.stage !== "open" && c.state.phase === "summarized")
  );
}

// PHASE 5 — THE FORCED ACCEPTANCE WINDOW: the ROOT resting in `running-children` with EVERY child
// summarized. STRUCTURALLY identical to a non-root roll-up window, but at the ROOT it is the
// forced-acceptance hold — the root writes no roll-up, so without a baseline the reducer finalizes
// here in the SAME reduction (root → summarized). WITH a baseline it instead parks here while
// pendingAcceptance is held, awaiting the user's ACCEPTANCE_APPROVED/DIVERGED verdict. `treeIsDone`
// is false in this shape (phase is running-children, not summarized), so a baseline-bearing tree can
// never read done without a recorded verdict. assertCoherent2 accepts this shape (the all-summarized
// running-children allowance is extended to the root for exactly this window).
export function inAcceptanceWindow(root: TreeNode): boolean {
  return (
    root.state.stage === "split" &&
    root.state.phase === "running-children" &&
    root.state.children.every((c) => c.state.stage !== "open" && c.state.phase === "summarized")
  );
}

// The gen-2 requirePointer: assert the event addresses THE active node, returning it. Every
// node-targeted event must address the currently-active node (depth-first uniqueness is the
// coherence invariant), exactly as gen-1 events had to address the pointed-at sub-plan.
function requireActive2(root: TreeNode, path: NodePath, what: string): TreeNode {
  const active = activePathOf(root);
  if (active === null || pathKey(active) !== pathKey(path)) {
    throw new Error(
      `${what} targets "${pathKey(path)}" but the active node is ${active === null ? "none" : `"${pathKey(active)}"`}`,
    );
  }
  const node = nodeAtPath(root, path);
  if (!node) throw new Error(`${what}: no node at "${pathKey(path)}"`); // unreachable post-active check
  return node;
}

// PHASE 4 — ONE COMPLETION-ASCENT HOP. After the node at `path` (a leaf or a rolled-up split) was
// marked summarized, mutate `next`/append `effects` for the single step the tree takes next:
//   - a NEXT PENDING SIBLING exists → it activates (open/pending → open/recon);
//   - LAST child of the ROOT → the root completes (split → summarized; treeIsDone) + notifyDone
//     (the root writes no roll-up — root-only special case, gen-1 golden behavior);
//   - LAST child of a NON-ROOT split → NO tree mutation: the parent now RESTS in its roll-up
//     window (running-children + all children summarized — the assertCoherent2 allowance). The
//     DRIVER detects the window (inRollupWindow at the new active path), runs the roll-up summary
//     turn, and dispatches SUMMARY_WRITTEN{parentPath} — which re-enters this fn one level up,
//     continuing the ascent (next sibling of the parent / grandparent roll-up / root done).
function advanceAfterSummary(next: PlanTreeState2, path: NodePath, effects: Effect2[]): void {
  if (path.length === 0) {
    throw new Error("advanceAfterSummary: the root has no parent to ascend to (unreachable)");
  }
  const parentPath = path.slice(0, -1);
  const parent = nodeAtPath(next.root, parentPath);
  if (!parent || parent.state.stage !== "split") {
    throw new Error(`incoherent: summarized node "${pathKey(path)}" has no split parent`);
  }
  const siblings = parent.state.children;
  const idx = siblings.findIndex((c) => c.nn === path[path.length - 1]);
  const sibling = idx + 1 < siblings.length ? siblings[idx + 1] : null;
  if (sibling) {
    // PHASE 5 — THE PARENT-REVIEW TURN: a child summarized with right-siblings remaining, so the
    // PARENT (root included) enters `reviewing` and the next sibling STAYS pending. The driver runs
    // the no-tools review turn (child summary + remaining FROZEN mandates → ADJUST/NONE) and
    // dispatches PARENT_REVIEW_DONE, which is the ONLY arc that activates the next sibling's recon.
    // Review happens only BETWEEN siblings: the last child takes the root-completion / roll-up
    // branches below and never enters reviewing.
    if (sibling.state.stage !== "open" || sibling.state.phase !== "pending") {
      throw new Error(
        `incoherent: next sibling "${pathKey([...parentPath, sibling.nn])}" is ${sibling.state.stage}/${sibling.state.phase}, expected open/pending`,
      );
    }
    next.root = replaceAt(next.root, parentPath, (n) => {
      if (n.state.stage !== "split") {
        throw new Error("unreachable: parent-review target re-checked non-split");
      }
      return { ...n, state: { ...n.state, phase: "reviewing" } };
    });
    return;
  }
  if (parentPath.length === 0) {
    // LAST CHILD OF THE ROOT → ROOT COMPLETION (no roll-up; done is DERIVED — see treeIsDone).
    if (next.root.state.stage !== "split") {
      throw new Error("incoherent: completion ascent reached a non-split root");
    }
    // PHASE 5 — THE FORCED ACCEPTANCE GATE: a tree that froze a working-reference baseline CANNOT
    // finalize without a recorded acceptance verdict. When `next.baseline_` is present AND no verdict
    // has been recorded yet (acceptance_ undefined — defensive against a double-finalize), instead of
    // completing the root we PARK it in its acceptance window (running-children, all children
    // summarized — coherent; treeIsDone stays false) and open the transient pendingAcceptance gate.
    // The DRIVER (notifyAcceptanceReview) opens the baseline + surfaces Approve/Diverge; the original
    // finalize (root → summarized + notifyDone) is performed by ACCEPTANCE_APPROVED/DIVERGED. With NO
    // baseline this branch is byte/effect-identical to before (immediate finalize + notifyDone).
    if (next.baseline_ && !next.acceptance_) {
      // The root STAYS running-children (the acceptance window — see inAcceptanceWindow). No tree
      // mutation; the gate is the transient hold. The gate's display fields the reducer cannot know
      // (cwd/openTarget/runCommand — driver concerns) are blank; the driver augments them when it
      // surfaces the gate. round is 1 (single-round acceptance today).
      const gate: AcceptanceGate = { cwd: "", openTarget: null, runCommand: null, round: 1 };
      next.pendingAcceptance = gate;
      effects.push({ kind: "notifyAcceptanceReview", gate });
      return;
    }
    next.root = { ...next.root, state: { ...next.root.state, phase: "summarized" } };
    effects.push({ kind: "notifyDone" });
    return;
  }
  // LAST CHILD OF A NON-ROOT SPLIT → the parent's ROLL-UP WINDOW (deliberate no-op: the resting
  // state IS the window; the driver's roll-up turn completes it via SUMMARY_WRITTEN{parentPath}).
}

// ---- the gen-2 pure reducer ----------------------------------------------------------------------

// The PURE gen-2 reducer. Returns a NEW state plus the effects the driver must execute. Never
// mutates the input; assertCoherent2 runs at the end of EVERY arc so any illegal transition throws.
// Effect kinds/ordering mirror the gen-1 reducer one-for-one at depth 1 (see the Effect2 notes for
// the two documented driver-write-boundary deltas), so the driver cutover preserves the golden
// depth-1 trace.
export function reduce2(
  state: PlanTreeState2,
  event: PlanTreeEvent2,
): { state: PlanTreeState2; effects: Effect2[] } {
  const next = clone2(state);
  const effects: Effect2[] = [];

  switch (event.type) {
    case "START": {
      // Bootstrap a fresh tree (ignores prior state — START is the genesis event). The on-disk
      // .plan-tree/ is reset FIRST, THEN the genesis ledger is persisted into it (gen-1 order).
      const fresh = initial2(event.treeId, event.request, event.nowMs);
      effects.push({ kind: "resetPlanTreeDir" }, { kind: "persist" });
      assertCoherent2(fresh.root);
      return { state: fresh, effects };
    }

    case "INTENT_CLARIFIED": {
      // ROOT-ONLY GENESIS ARC: clarifying-intent → recon, writing INTENT.md (the one artifact
      // whose text still rides the event — the reducer write mirrors gen 1 byte-for-byte).
      // Stricter than gen 1: a stray INTENT_CLARIFIED mid-run throws instead of rewinding.
      if (next.root.state.stage !== "open" || next.root.state.phase !== "clarifying-intent") {
        throw new Error(
          `INTENT_CLARIFIED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/clarifying-intent`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "recon" } };
      effects.push(
        { kind: "writePlanTreeFile", name: "INTENT.md", contents: event.intent },
        { kind: "persist" },
      );
      break;
    }

    case "PROTOTYPE_READY": {
      // ROOT-ONLY GATE-OPEN ARC: clarifying-intent → prototype-review, holding the gate
      // transiently (pendingPrototype — never serialized). Legal ONLY from the genesis window:
      // a prototype arriving mid-run (recon onward, or a non-root active node) throws.
      if (next.root.state.stage !== "open" || next.root.state.phase !== "clarifying-intent") {
        throw new Error(
          `PROTOTYPE_READY illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/clarifying-intent`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "prototype-review" } };
      next.pendingPrototype = event.gate;
      effects.push({ kind: "notifyPrototypeReview", gate: event.gate }, { kind: "persist" });
      break;
    }

    case "PROTOTYPE_APPROVED": {
      // ROOT-ONLY GATE-RESOLVE ARC: prototype-review → recon, writing INTENT.md (mirrors
      // INTENT_CLARIFIED's shape — the prototype path and the no-prototype fallback converge on
      // the identical recon entry). Clears the held gate.
      if (next.root.state.stage !== "open" || next.root.state.phase !== "prototype-review") {
        throw new Error(
          `PROTOTYPE_APPROVED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/prototype-review`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "recon" } };
      next.pendingPrototype = null;
      // WORKING-REFERENCE classification (Phase 3): on `asWorkingReference`, record the frozen
      // baseline (the DRIVER already copied .plan-tree/prototype/ → .plan-tree/baseline/ before
      // dispatching). The default (false — "just a sketch") leaves baseline_ untouched, so the
      // recon entry is byte-identical to today's no-working-reference behavior.
      if (event.asWorkingReference) {
        next.baseline_ = { frozen: true, frozen_ms: event.frozenMs };
      }
      effects.push(
        { kind: "writePlanTreeFile", name: "INTENT.md", contents: event.intentContents },
        { kind: "persist" },
      );
      break;
    }

    case "PROTOTYPE_REFINED": {
      // ROOT-ONLY GATE-LOOP ARC: prototype-review → BACK to clarifying-intent for another
      // prototype round. The feedback rides the event for the DRIVER's next prompt only — the
      // reducer never stores it. Clears the held gate (the next round mints a fresh one).
      if (next.root.state.stage !== "open" || next.root.state.phase !== "prototype-review") {
        throw new Error(
          `PROTOTYPE_REFINED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/prototype-review`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "clarifying-intent" } };
      next.pendingPrototype = null;
      effects.push({ kind: "persist" });
      break;
    }

    case "NODE_RECON_DONE": {
      const node = requireActive2(next.root, event.path, "NODE_RECON_DONE");
      if (node.state.stage !== "open" || node.state.phase !== "recon") {
        throw new Error(
          `NODE_RECON_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/recon`,
        );
      }
      if (isRootCollapseChild(next.root, event.path)) {
        // ROOT-COLLAPSE CHILD (root-only special case, PHASE 4): the sole child of the root
        // single-collapse inherited the ROOT sizer's `single` verdict, so it skips the per-node
        // sizer — recon → leaf/drafting directly (the open→leaf node replacement), preserving the
        // gen-1 golden depth-1 single trace byte-for-byte.
        next.root = replaceAt(next.root, event.path, (n) => ({
          ...n,
          state: { stage: "leaf", phase: "drafting", planPath: null, summaryPath: null, plansDirPath: null },
        }));
      } else {
        // PHASE 4 — EVERY OTHER NODE (root AND non-root alike): recon → sizing (the per-node
        // sizer turn follows; the SIZER_DONE verdict decides leaf vs split). recon.md is
        // DRIVER-written at the root (cutover seam on PlanTreeEvent2 — the event carries no text).
        next.root = replaceAt(next.root, event.path, (n) => ({
          ...n,
          state: { stage: "open", phase: "sizing" },
        }));
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "SIZER_DONE": {
      const node = requireActive2(next.root, event.path, "SIZER_DONE");
      if (node.state.stage !== "open" || node.state.phase !== "sizing") {
        throw new Error(
          `SIZER_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/sizing`,
        );
      }
      // TWO-OUTCOME SIZER, gen-1 thresholds preserved AT EVERY DEPTH: a CONFIDENT single makes the
      // node a leaf; a split OR a low-confidence single (< 0.6, per the sizer skill's rule)
      // decomposes. (The outcome itself is not stored: schema 2 has no sizer field — the verdict
      // is fully encoded in the arc.)
      if (event.outcome.decision === "single" && event.outcome.confidence >= 0.6) {
        if (event.path.length === 0) {
          // ROOT SINGLE-COLLAPSE (root-only special case, preserving gen-1 golden behavior): the
          // decomposition gate is COLLAPSED — the root becomes a split with EXACTLY ONE child 01
          // ("Plan"), materialized immediately (no CHILDREN_PARSED, no gate), child active in recon.
          // The child's OWN leaf gate is the only plan gate in the whole run.
          const only: TreeNode = { ...makeNode2(parseNn(1), "Plan"), state: { stage: "open", phase: "recon" } };
          next.root = {
            ...next.root,
            state: {
              stage: "split",
              phase: "running-children",
              children: nonEmpty([only]),
              planPath: null,
              summaryPath: null,
              plansDirPath: null,
            },
          };
        } else {
          // PHASE 4 — NON-ROOT SINGLE: the node ITSELF becomes the leaf (open→leaf node
          // replacement; NO collapse child is minted — the collapse exists only at the root, where
          // a gate must still follow). Its leaf gate is this node's human checkpoint.
          next.root = replaceAt(next.root, event.path, (n) => ({
            ...n,
            state: { stage: "leaf", phase: "drafting", planPath: null, summaryPath: null, plansDirPath: null },
          }));
        }
      } else {
        // SPLIT (or low-confidence single treated as one) → the decomposition draft turn, at ANY
        // depth (PHASE 4: non-root splits draft their own decompositions).
        next.root = replaceAt(next.root, event.path, (n) => ({
          ...n,
          state: { stage: "open", phase: "decomposing" },
        }));
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "DECOMPOSITION_DRAFTED": {
      // PHASE 4: legal at ANY depth — a non-root split drafts its own decomposition
      // (".plan-tree/<dotted>-plan.md", driver-written) and gets the same unified gate.
      const node = requireActive2(next.root, event.path, "DECOMPOSITION_DRAFTED");
      if (node.state.stage !== "open" || node.state.phase !== "decomposing") {
        throw new Error(
          `DECOMPOSITION_DRAFTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/decomposing`,
        );
      }
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: { stage: "open", phase: "awaiting-decomposition-approval" },
      }));
      // THE UNIFIED GATE: the root decomposition gate lives in pendingApproval like every other
      // gate (the gen-1 nn:-1 sentinel + driver-side master gate are gone). master.md and the
      // plans-dir copy are DRIVER-written before this event (cutover seam) — the event carries
      // their real paths into the gate.
      const gate: ApprovalGate2 = {
        path: event.path,
        kind: "decomposition",
        toolUseId: event.toolUseId,
        planPath: event.planPath,
        plansDirPath: event.plansDirPath,
        redraftCount: node.redraftCount,
      };
      next.pendingApproval = gate;
      effects.push({ kind: "persist" }, { kind: "notifyAwaitingApproval", gate });
      break;
    }

    case "GATE_RE_PRESENTED": {
      // INV-3 — PHASE-ONLY RE-ARM (resume). Advance ONLY the node phase open/decomposing →
      // open/awaiting-decomposition-approval so a subsequent DECOMPOSITION_APPROVED finds the phase
      // its guard requires (the resumed-gate Approve path dead-ended at FATAL otherwise). The DRIVER
      // already set pendingApproval + fired onAwaitingApproval directly on resume, so this emits NO
      // effects (no persist, no notify) — re-running DECOMPOSITION_DRAFTED here would double-present
      // the gate. Legal ONLY from open/decomposing (the resumed decomposition-gate shape).
      const node = requireActive2(next.root, event.path, "GATE_RE_PRESENTED");
      if (node.state.stage !== "open" || node.state.phase !== "decomposing") {
        throw new Error(
          `GATE_RE_PRESENTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/decomposing`,
        );
      }
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: { stage: "open", phase: "awaiting-decomposition-approval" },
      }));
      // NO effects: the gate is already surfaced (driver-side, on resume). This is a pure phase fix.
      break;
    }

    case "CHILDREN_PARSED": {
      // PHASE 4: legal at ANY depth (children carry per-level Nn segments; full paths derive from
      // nesting at DECOMPOSITION_APPROVED).
      const node = requireActive2(next.root, event.path, "CHILDREN_PARSED");
      // Legal in the gen-1 SUBPLANS_PARSED window: while decomposing OR while the draft's gate is
      // held (the parse derives from the draft, whichever order the driver lands them in).
      if (
        node.state.stage !== "open" ||
        (node.state.phase !== "decomposing" && node.state.phase !== "awaiting-decomposition-approval")
      ) {
        throw new Error(
          `CHILDREN_PARSED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/decomposing|awaiting-decomposition-approval`,
        );
      }
      // SIBLING-nn UNIQUENESS (INV-2 recoverable): two headers parsing to the SAME nn (e.g.
      // "Sub-Plan 1" and "Sub-Plan 01") would mint duplicate-nn siblings — and every navigation
      // primitive (nodeAtPath/replaceAt/advanceAfterSummary) resolves nn to the FIRST match, so the
      // run executes one twin and later events alias back to the other, wedging mid-run. REJECT it
      // HERE with a PlanValidationError — the SAME typed class as the empty/out-of-range cases — so
      // the orchestrator's `instanceof PlanValidationError` catch denies the held ExitPlanMode for a
      // redraft (run stays active) instead of FATALing. (assertStructure carries a defense-in-depth
      // Set check for any tree that somehow reaches rest with collisions.)
      const seenNn = new Set<Nn>();
      for (const c of event.children) {
        if (seenNn.has(c.nn)) {
          throw new PlanValidationError(
            `decomposition validation failed: sub-plan nn "${pathKey([c.nn])}" appears more than once — ` +
              "sibling sub-plan numbers must be unique; redraft the decomposition with distinct `### Sub-Plan NN:` headers",
          );
        }
        seenNn.add(c.nn);
      }
      // STASHED, NOT YET IN THE TREE: minted via nonEmpty (an empty decomposition throws here),
      // all open/pending, held transiently until the gate resolves. The node deliberately STAYS
      // open: every split phase requires child activity the held-gate window cannot have
      // (assertCoherent2's exactly-one-active rule; the plan diagram enters RunKids on approve),
      // so the open→split node replacement happens at DECOMPOSITION_APPROVED, not here.
      next.parsedChildren = {
        path: event.path,
        children: nonEmpty(event.children.map((c) => makeNode2(c.nn, c.title))),
      };
      effects.push({ kind: "persist" });
      break;
    }

    case "DECOMPOSITION_APPROVED": {
      // PHASE 4: legal at ANY depth — the open→split node replacement happens wherever the gated
      // node lives; ANCESTORS are untouched (they stay running-children: the spine copy in
      // replaceAt preserves their state, and the newly-active first grandchild keeps each level's
      // exactly-one-active partition satisfied).
      const node = requireActive2(next.root, event.path, "DECOMPOSITION_APPROVED");
      if (node.state.stage !== "open" || node.state.phase !== "awaiting-decomposition-approval") {
        throw new Error(
          `DECOMPOSITION_APPROVED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/awaiting-decomposition-approval`,
        );
      }
      const stash = next.parsedChildren;
      if (!stash || pathKey(stash.path) !== pathKey(event.path)) {
        // The gen-1 "MASTER_APPROVED before SUBPLANS_PARSED" guard, path-addressed.
        throw new Error("DECOMPOSITION_APPROVED before CHILDREN_PARSED — no children to run");
      }
      const gate = next.pendingApproval;
      // The instantaneous `approved` tick (gen-1 semantics preserved): the open node is REPLACED
      // by the populated split (sizer-driven arc #2), already running its first child — a resting
      // "approved-but-idle" state is unrepresentable. The decomposition plan's artifact paths move
      // from the gate onto the split node (artifacts live on leaf/split states, never open).
      const children = nonEmpty(
        stash.children.map((c, i): TreeNode => (i === 0 ? { ...c, state: { stage: "open", phase: "recon" } } : c)),
      );
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: {
          stage: "split",
          phase: "running-children",
          children,
          planPath: gate ? gate.planPath : null,
          summaryPath: null,
          plansDirPath: gate ? gate.plansDirPath : null,
        },
      }));
      next.parsedChildren = null;
      next.pendingApproval = null;
      // Gen-1 APPROVE effect shape, unified onto the decomposition gate: resolve-allow + persist.
      // (The driver-side interrupt/arm-resuming hardening stays DRIVER policy at cutover — the
      // reducer only resolves the held permission, exactly as it does for a leaf APPROVE.)
      if (gate) effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: true });
      effects.push({ kind: "persist" });
      break;
    }

    case "DECOMPOSITION_CHANGES_REQUESTED": {
      // PHASE 4: legal at ANY depth — the nested redraft happens IN PLACE exactly like the root's.
      const node = requireActive2(next.root, event.path, "DECOMPOSITION_CHANGES_REQUESTED");
      if (node.state.stage !== "open" || node.state.phase !== "awaiting-decomposition-approval") {
        throw new Error(
          `DECOMPOSITION_CHANGES_REQUESTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/awaiting-decomposition-approval`,
        );
      }
      const gate = next.pendingApproval;
      // STAYS DECOMPOSING-SIDE: back to open/decomposing for the same-turn redraft; redraftCount
      // accumulates on the NODE (it survives the open→split replacement later); the stale parse
      // is discarded (the redraft re-parses); the gate clears with a deny carrying the feedback.
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        redraftCount: n.redraftCount + 1,
        lastFeedback: event.feedback,
        state: { stage: "open", phase: "decomposing" },
      }));
      next.parsedChildren = null;
      next.pendingApproval = null;
      if (gate) {
        effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: false, message: event.feedback });
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "NODE_DRAFTED": {
      const node = requireActive2(next.root, event.path, "NODE_DRAFTED");
      if (node.state.stage !== "leaf" || node.state.phase !== "drafting") {
        throw new Error(
          `NODE_DRAFTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/drafting`,
        );
      }
      // leaf drafting → awaiting-approval, recording the DRIVER-written plan's paths (the plan
      // text never rides the event — see the driver-write boundary note on PlanTreeEvent2; the
      // gen-1 writeAgentPlan effect, which the driver already no-oped, is gone).
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: {
          stage: "leaf",
          phase: "awaiting-approval",
          planPath: event.planPath,
          summaryPath: null,
          plansDirPath: event.plansDirPath,
        },
      }));
      const gate: ApprovalGate2 = {
        path: event.path,
        kind: "leaf",
        toolUseId: event.toolUseId,
        planPath: event.planPath,
        plansDirPath: event.plansDirPath,
        redraftCount: node.redraftCount,
      };
      next.pendingApproval = gate;
      effects.push({ kind: "persist" }, { kind: "notifyAwaitingApproval", gate });
      break;
    }

    case "APPROVE": {
      const node = requireActive2(next.root, event.path, "APPROVE");
      // Legal ONLY from leaf/awaiting-approval (the gen-1 lifecycle guard, stage-aware).
      if (node.state.stage !== "leaf" || node.state.phase !== "awaiting-approval") {
        throw new Error(
          `APPROVE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/awaiting-approval`,
        );
      }
      const gate = next.pendingApproval;
      next.root = replaceAt(next.root, event.path, (n) => {
        if (n.state.stage !== "leaf") throw new Error("unreachable: APPROVE target re-checked non-leaf");
        return { ...n, state: { ...n.state, phase: "executing" } };
      });
      next.pendingApproval = null;
      if (gate) effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: true });
      // NO setMode effect (gen-1 invariant preserved): the writable mode is DERIVED from the tree
      // (writePolicyFor2's existential flips on the `executing` leaf set above).
      effects.push({ kind: "persist" });
      break;
    }

    case "REQUEST_CHANGES": {
      const node = requireActive2(next.root, event.path, "REQUEST_CHANGES");
      if (node.state.stage !== "leaf" || node.state.phase !== "awaiting-approval") {
        throw new Error(
          `REQUEST_CHANGES illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/awaiting-approval`,
        );
      }
      const gate = next.pendingApproval;
      // Re-draft IN PLACE: the active path MUST NOT move; siblings MUST NOT be touched (replaceAt
      // copies only the spine). The drafted paths stay recorded on the leaf (gen-1 behavior).
      next.root = replaceAt(next.root, event.path, (n) => {
        if (n.state.stage !== "leaf") throw new Error("unreachable: REQUEST_CHANGES target re-checked non-leaf");
        return {
          ...n,
          redraftCount: n.redraftCount + 1,
          lastFeedback: event.feedback,
          state: { ...n.state, phase: "drafting" },
        };
      });
      next.pendingApproval = null;
      if (gate) {
        effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: false, message: event.feedback });
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "EXEC_DONE": {
      const node = requireActive2(next.root, event.path, "EXEC_DONE");
      // The leaf finished executing; it STAYS `executing` until its summary lands (gen-1 shape —
      // the summary turn still needs the writable window's bookkeeping to be unambiguous).
      if (node.state.stage !== "leaf" || node.state.phase !== "executing") {
        throw new Error(
          `EXEC_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/executing`,
        );
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "SUMMARY_WRITTEN": {
      // PHASE 4 — TWO shapes at ANY depth, both addressing THE active node:
      //   LEAF summary: a leaf/executing node summarizes (the gen-1 arc, path-generic), OR
      //   ROLL-UP summary: a NON-ROOT split resting in its roll-up window (running-children, all
      //   children summarized — see inRollupWindow) records its own roll-up and completes.
      // Either way the summary FILE was already written by the driver — the event carries the
      // write's real returned path; the reducer only RECORDS it (no write effect; gen-1 invariant).
      const node = requireActive2(next.root, event.path, "SUMMARY_WRITTEN");
      if (node.state.stage === "leaf") {
        if (node.state.phase !== "executing") {
          throw new Error(
            `SUMMARY_WRITTEN illegal: leaf "${pathKey(event.path)}" is ${node.state.phase}, expected executing`,
          );
        }
        next.root = replaceAt(next.root, event.path, (n) => {
          if (n.state.stage !== "leaf") throw new Error("unreachable: SUMMARY_WRITTEN target re-checked non-leaf");
          return { ...n, state: { ...n.state, phase: "summarized", summaryPath: event.summaryPath } };
        });
      } else if (node.state.stage === "split") {
        // The ROOT writes no roll-up summary — completion is DERIVED (treeIsDone). Defensive: the
        // active-node check above already rejects a resting root split.
        if (event.path.length === 0) {
          throw new Error("SUMMARY_WRITTEN illegal: the root writes no roll-up summary (completion is derived)");
        }
        if (!inRollupWindow(node)) {
          throw new Error(
            `SUMMARY_WRITTEN illegal: split "${pathKey(event.path)}" is ${node.state.phase} outside the roll-up window (all children must be summarized)`,
          );
        }
        next.root = replaceAt(next.root, event.path, (n) => {
          if (n.state.stage !== "split") throw new Error("unreachable: SUMMARY_WRITTEN target re-checked non-split");
          return { ...n, state: { ...n.state, phase: "summarized", summaryPath: event.summaryPath } };
        });
      } else {
        throw new Error(
          `SUMMARY_WRITTEN illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/executing or a roll-up-window split`,
        );
      }
      effects.push({ kind: "notifySummaryWritten", path: event.path, summaryPath: event.summaryPath });
      // COMPLETION ASCENT (internal — no public advance event), generalized to any depth: activate
      // the next pending sibling, or complete/park the parent. Exactly ONE ascent hop per event —
      // a non-root parent's own completion arrives as its OWN roll-up SUMMARY_WRITTEN (a separate
      // driver turn), so the recursion across levels lives in the EVENT STREAM, not in one reduce.
      advanceAfterSummary(next, event.path, effects);
      effects.push({ kind: "persist" });
      break;
    }

    case "PARENT_REVIEW_DONE": {
      // PHASE 5 — the ONLY exit from `reviewing`: back to running-children, activating the next
      // pending child's recon. Legal ONLY while the addressed node is a split in `reviewing` (any
      // other state throws — reviewing → anything-else has no arc). The reviewed-child summary and
      // the ADJUST note are driver concerns; the reducer only moves the partition forward.
      const node = requireActive2(next.root, event.path, "PARENT_REVIEW_DONE");
      if (node.state.stage !== "split" || node.state.phase !== "reviewing") {
        throw new Error(
          `PARENT_REVIEW_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected split/reviewing`,
        );
      }
      const pending = node.state.children.find(
        (c) => c.state.stage === "open" && c.state.phase === "pending",
      );
      if (!pending) {
        // Unreachable: assertCoherent2 forbids reviewing without a pending child (kept loud).
        throw new Error(
          `PARENT_REVIEW_DONE incoherent: reviewing node "${pathKey(event.path)}" has no pending child`,
        );
      }
      next.root = replaceAt(next.root, event.path, (n) => {
        if (n.state.stage !== "split") throw new Error("unreachable: PARENT_REVIEW_DONE target re-checked non-split");
        return { ...n, state: { ...n.state, phase: "running-children" } };
      });
      next.root = replaceAt(next.root, [...event.path, pending.nn], (n) => ({
        ...n,
        state: { stage: "open", phase: "recon" },
      }));
      effects.push({ kind: "persist" });
      break;
    }

    case "ACCEPTANCE_APPROVED":
    case "ACCEPTANCE_DIVERGED": {
      // PHASE 5 — RESOLVE THE FORCED ACCEPTANCE GATE: perform the ORIGINAL finalize the
      // advanceAfterSummary completion ascent deferred (root acceptance window → summarized +
      // notifyDone) and clear the held gate. Legal ONLY while the gate is open: the root MUST be
      // resting in its acceptance window (running-children, all children summarized) AND
      // pendingAcceptance held. Any other shape throws LOUDLY (a verdict with no gate to resolve).
      if (!next.pendingAcceptance) {
        throw new Error(`${event.type} illegal: no acceptance gate is open`);
      }
      if (!inAcceptanceWindow(next.root)) {
        throw new Error(
          `${event.type} illegal: root is ${next.root.state.stage}/${next.root.state.phase}, not in the acceptance window (running-children, all children summarized)`,
        );
      }
      if (next.root.state.stage !== "split") {
        throw new Error("unreachable: acceptance window re-checked non-split root");
      }
      // RECORD THE VERDICT (serializable; round-tripped through toLedger2/rehydrate). DIVERGED also
      // records the reason — the audit trail for why the baseline floor was waived.
      next.acceptance_ =
        event.type === "ACCEPTANCE_APPROVED"
          ? { verdict: "approved", decided_ms: event.decidedMs }
          : { verdict: "diverged", reason: event.reason, decided_ms: event.decidedMs };
      // THE DEFERRED FINALIZE: root → summarized (treeIsDone now true) + notifyDone. Identical shape
      // to the no-baseline immediate-finalize branch in advanceAfterSummary — just deferred behind
      // the verdict.
      next.root = { ...next.root, state: { ...next.root.state, phase: "summarized" } };
      next.pendingAcceptance = null;
      effects.push({ kind: "persist" }, { kind: "notifyDone" });
      break;
    }

    case "ACCEPTANCE_REFINED": {
      // PHASE 6 — RE-PLAN A SUB-PLAN FROM THE FORCED ACCEPTANCE GATE. A first-class third action: reset
      // the target node AND its right-siblings to a fresh re-execution shape so they re-run and
      // overwrite their summaries; on the tree's re-completion (baseline still present, no verdict yet)
      // the Phase-5 gate re-arms automatically. NO "stale summary" flag exists — the reset IS the
      // mechanism, and the resulting tree shape is one the per-level partition already permits.
      //
      // Legal ONLY while the acceptance gate is open: pendingAcceptance held AND the root resting in
      // its acceptance window (running-children, all children summarized). Any other shape throws
      // LOUDLY (a refine with no gate to refine from).
      if (!next.pendingAcceptance) {
        throw new Error("ACCEPTANCE_REFINED illegal: no acceptance gate is open");
      }
      if (!inAcceptanceWindow(next.root)) {
        throw new Error(
          `ACCEPTANCE_REFINED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, not in the acceptance window (running-children, all children summarized)`,
        );
      }
      const target = event.target;
      if (target.length === 0) {
        // The root writes no plan/summary and re-planning the whole tree is "start a new plan", not a
        // refine — so a root target is meaningless here.
        throw new Error("ACCEPTANCE_REFINED illegal: target is the root (re-plan a sub-plan, not the whole tree)");
      }
      // SCOPE: only the root's DIRECT children (the top-level sub-plans the acceptance gate surfaces)
      // are refine targets today. A deeper target would have to un-summarize every ancestor back to the
      // root (the root acceptance window requires ALL root children summarized), which the per-level
      // reset below does not do — so reject it loudly rather than corrupt an ancestor's partition. The
      // realistic gate workflow re-plans a whole top-level sub-plan and re-runs it (and its
      // right-siblings) from scratch.
      if (target.length !== 1) {
        throw new Error(
          `ACCEPTANCE_REFINED illegal: target "${pathKey(target)}" is not a direct root child (only top-level sub-plans are refine targets)`,
        );
      }
      const targetNode = nodeAtPath(next.root, target);
      if (!targetNode) {
        throw new Error(`ACCEPTANCE_REFINED illegal: no node at "${pathKey(target)}"`);
      }
      const parentPath = target.slice(0, -1);
      const parent = nodeAtPath(next.root, parentPath);
      if (!parent || parent.state.stage !== "split") {
        throw new Error(`ACCEPTANCE_REFINED illegal: "${pathKey(target)}" has no split parent`);
      }
      const targetSeg = target[target.length - 1];
      const idx = parent.state.children.findIndex((c) => c.nn === targetSeg);
      if (idx < 0) {
        throw new Error(`ACCEPTANCE_REFINED illegal: "${pathKey(target)}" is not a child of "${pathKey(parentPath)}"`);
      }
      // Collect the reset set: the target plus every right-sibling at the target's level. Each must be
      // currently summarized (the acceptance window guarantees every root child is summarized; a deeper
      // target's right-siblings are likewise summarized when the window holds, but assert it loudly so
      // a refine that would step a non-summarized sibling backward never silently corrupts the
      // partition). For each, emit deletes of its on-disk NN-plan.md / NN-summary.md so the re-run
      // overwrites a clean slate (the driver's delete is a graceful no-op when a file never existed).
      //
      // A reset node may itself be a SPLIT node (a re-planned top-level sub-plan that decomposed into
      // depth-2 children, e.g. 01.01/01.02 + a roll-up under "01"). makeNode2 below discards that live
      // subtree, so BEFORE it does we walk each reset node's CURRENT subtree and emit deletes for every
      // descendant's NN.NN…-plan.md / NN.NN…-summary.md too — otherwise stale descendant summaries leak
      // on disk and the re-decomposition (which may reuse the same child NNs) would render them as
      // phantom prior siblings. Effects only (the reducer stays pure); the driver's delete is
      // containment-guarded and a graceful no-op for a never-written file.
      const emitDescendantDeletes = (node: TreeNode, nodePath: NodePath): void => {
        if (node.state.stage !== "split") return;
        for (const child of node.state.children) {
          const childPath: NodePath = [...nodePath, child.nn];
          effects.push({ kind: "deletePlanTreeFile", name: planName2(childPath) });
          effects.push({ kind: "deletePlanTreeFile", name: summaryName2(childPath) });
          emitDescendantDeletes(child, childPath);
        }
      };
      const resetSegs: Nn[] = [];
      for (let i = idx; i < parent.state.children.length; i++) {
        const sib = parent.state.children[i];
        if (sib.state.stage === "open" || sib.state.phase !== "summarized") {
          throw new Error(
            `ACCEPTANCE_REFINED incoherent: sibling "${pathKey([...parentPath, sib.nn])}" is not summarized (cannot reset a non-summarized node)`,
          );
        }
        resetSegs.push(sib.nn);
        const sibPath: NodePath = [...parentPath, sib.nn];
        effects.push({ kind: "deletePlanTreeFile", name: planName2(sibPath) });
        effects.push({ kind: "deletePlanTreeFile", name: summaryName2(sibPath) });
        emitDescendantDeletes(sib, sibPath);
      }
      // RESET in place: the FIRST reset node (the target) becomes ACTIVE (open/recon) so re-execution
      // starts immediately; every right-sibling resets to fresh open/pending. Left-siblings are
      // untouched (still summarized). The result — summarized* (recon) pending* at the target's level
      // — is a coherent `summarized* active pending*` partition, and the parent stays running-children
      // with EXACTLY ONE active child (assertCoherent2 accepts it). Mirrors DECOMPOSITION_APPROVED's
      // "first child → recon, rest pending" shaping.
      next.root = replaceAt(next.root, parentPath, (n) => {
        if (n.state.stage !== "split") throw new Error("unreachable: ACCEPTANCE_REFINED target parent re-checked non-split");
        const children = nonEmpty(
          n.state.children.map((c): TreeNode => {
            if (!resetSegs.includes(c.nn)) return c;
            const fresh = makeNode2(c.nn, c.title);
            return c.nn === targetSeg
              ? { ...fresh, state: { stage: "open", phase: "recon" } }
              : fresh;
          }),
        );
        return { ...n, state: { ...n.state, children } };
      });
      // BACK TO EXECUTING: clear the held gate (no verdict recorded — acceptance_ stays absent). The
      // re-executed nodes will eventually re-arm the gate at root re-completion (Phase-5 logic).
      next.pendingAcceptance = null;
      effects.push({ kind: "persist" });
      break;
    }

    case "CLARIFY_REQUESTED": {
      // A held AskUserQuestion — transient gate only; does NOT change any node (gen-1 carry-over).
      next.pendingClarify = { toolUseId: event.toolUseId, questions: event.questions };
      break;
    }

    case "CLARIFY_ANSWERED": {
      const gate = next.pendingClarify;
      next.pendingClarify = null;
      // Resolve the held AskUserQuestion with the user's selections (gate id wins; event id is the
      // no-gate fallback — gen-1 carry-over).
      const message = JSON.stringify({ answers: event.answers });
      const id = gate ? gate.toolUseId : event.toolUseId;
      effects.push({ kind: "resolvePermission", id, allow: true, message });
      break;
    }

    case "SESSION_INITIALIZED": {
      // Stamp the run-level SDK session_id and SELF-PERSIST (resume support). NOT a node transition:
      // no node state changes, so the tree (and activePathOf / pendingApproval / every gate) is
      // untouched. IDEMPOTENT: an empty id, or a re-dispatched id equal to the one already stored,
      // is a no-op — no field change AND no persist effect (so re-init on a reconnect doesn't churn
      // state.json). Only a NEW non-empty id sets the field and emits a single persist.
      if (event.sessionId && event.sessionId !== next.sdk_session_id) {
        next.sdk_session_id = event.sessionId;
        effects.push({ kind: "persist" });
      }
      break;
    }

    case "QUOTA_BUDGET_SET": {
      // Set the run's auto-resume budget (dispatched at START from the composer's quota-resume
      // choice). budget == remaining at the start of the run; QUOTA_RESUMED decrements remaining as
      // auto-resumes are spent. NOT a node transition — the tree is untouched. Persist so a killed
      // run resumes with its budget intact.
      next.auto_resume_ = { budget: event.budget, remaining: event.budget };
      effects.push({ kind: "persist" });
      break;
    }

    case "QUOTA_PAUSED": {
      // A quota pause arrived. THE DECISION — fully driven by `remaining`, with the FAIL-CLOSED
      // default: an ABSENT auto_resume_ (no QUOTA_BUDGET_SET was ever dispatched — the resume() path,
      // a legacy ledger) is treated as remaining 0, so the pause goes STRAIGHT to exhausted and NEVER
      // auto-resumes. Only a set budget with remaining > 0 yields an auto-resuming pause. The reducer
      // does NOT decrement here (the decrement rides QUOTA_RESUMED when the resume actually happens) —
      // and stores NO "paused" flag (pause is in-memory orchestrator state, same-process scope). No
      // ledger field changes, so no persist effect.
      // DEGRADED-RESET GUARD: a non-finite or <= 0 resetAt (the sentinel a result-carrier quota emits
      // when the reset time is undeterminable) MUST force the exhausted path REGARDLESS of budget — a
      // resume timer to epoch 0 fires immediately, back into the wall = a new loop. Only a usable
      // (finite, > 0) reset may consult the budget.
      const usableReset = Number.isFinite(event.resetAt) && event.resetAt > 0;
      const remaining = usableReset && next.auto_resume_ ? next.auto_resume_.remaining : 0;
      if (remaining > 0) {
        effects.push({
          kind: "notifyQuotaPaused",
          resetAt: event.resetAt,
          remaining,
          source: event.source,
        });
      } else {
        effects.push({ kind: "notifyQuotaExhausted", resetAt: event.resetAt, source: event.source });
      }
      break;
    }

    case "QUOTA_RESUMED": {
      // An auto-resume (or manual resume) happened — spend one from the budget. Clamp at the floor 0
      // (a resume with no budget left is a defensive no-op on the count). Persist the decremented
      // budget so a kill mid-window leaves the spent count on disk. `nowMs` rides the event (no clock
      // read) for the driver's bookkeeping; the reducer does not store it.
      if (next.auto_resume_ && next.auto_resume_.remaining > 0) {
        next.auto_resume_ = {
          budget: next.auto_resume_.budget,
          remaining: next.auto_resume_.remaining - 1,
        };
        effects.push({ kind: "persist" });
      }
      break;
    }

    case "QUOTA_EXHAUSTED": {
      // A terminal exhaust signal: the run cannot auto-resume further. Surface it; the budget is left
      // as-is (already 0 in the auto-resume flow — no ledger change, so no persist). NOT a node
      // transition.
      effects.push({ kind: "notifyQuotaExhausted", resetAt: event.resetAt, source: event.source });
      break;
    }

    case "FATAL": {
      effects.push({ kind: "notifyFatal", message: event.message });
      // FATAL does not mutate the ledger — it surfaces the error; the driver decides teardown.
      assertCoherent2(next.root);
      return { state: next, effects };
    }
  }

  // NOTE: the reducer does NOT stamp updated_ms (gen-1 invariant): the driver stamps a fresh
  // injected-now() timestamp at its single persist path.
  assertCoherent2(next.root);
  return { state: next, effects };
}

// ---- gen-2 resume rehydration & scope (PURE — no driver/Tauri/DOM) -----------------------------
//
// RESUME ARC (Phase 2 of the resume plan): three PURE projections that turn a persisted
// RecursiveLedger into a resume DECISION, so a killed run's `.plan-tree/state.json` can be reopened
// and continued. Like the reducer, these decide NOTHING about side effects — they only describe
// what the active node is and whether resuming from it is faithful. The driver (Phase 3) consumes
// these to either re-present a gate (pure disk re-read) or re-send the current step's prompt.
//
// WHY some phases are blocked (the v1 scope table): the ledger alone does NOT fully describe a live
// run — the driver holds non-serialized state (summaries/mandates/adjustNote/parsedChildren/held
// gates/reviewedChild). Phases whose continuation needs UNRECOVERABLE driver state (genesis
// confirmedIntent, in-flight tool calls, review/roll-up context, the transient parsedChildren
// stash) are reported NOT resumable rather than resumed unfaithfully.

// Rehydrate the in-memory PlanTreeState2 from a persisted ledger: assert coherence, carry EVERY
// serialized field, and null EVERY transient gate (none of pendingApproval/pendingClarify/
// pendingPrototype/parsedChildren survives a restart — they describe a session that is gone). The
// driver re-mints any gate it re-presents from on-disk artifacts (Phase 3).
export function rehydrateState2(ledger: RecursiveLedger): PlanTreeState2 {
  assertCoherent2(ledger.root);
  return {
    schema: 2,
    tree_id: ledger.tree_id,
    created_ms: ledger.created_ms,
    updated_ms: ledger.updated_ms,
    root: ledger.root,
    sdk_session_id: ledger.sdk_session_id,
    // Rehydrate the working-reference record from disk so a resumed run still knows the baseline
    // was frozen (deep-copied; absent ⇒ undefined ⇒ a sketch run, unchanged).
    baseline_: ledger.baseline_ ? { ...ledger.baseline_ } : undefined,
    // Rehydrate the recorded acceptance verdict (incl. the divergence reason) from disk; absent ⇒
    // undefined ⇒ the gate was never resolved (a run paused at the acceptance window re-presents the
    // gate from the tree shape + baseline_, not from a persisted gate).
    acceptance_: ledger.acceptance_ ? { ...ledger.acceptance_ } : undefined,
    // Rehydrate the quota auto-resume budget from disk so a resumed run keeps its remaining count
    // (deep-copied; absent ⇒ undefined ⇒ the fail-closed reducer default, never auto-resumes).
    auto_resume_: ledger.auto_resume_ ? { ...ledger.auto_resume_ } : undefined,
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    // The forced acceptance gate is transient — a resumed run re-mints it from the tree + baseline_.
    pendingAcceptance: null,
    parsedChildren: null,
  };
}

// What resuming the active node REQUIRES of the driver. Three shapes (mirroring the v1 scope table):
//   - "gate": the active node is parked at a human approval checkpoint (a leaf plan gate, or a
//     decomposition/master gate). The driver re-presents it from disk — `planPath` is the file the
//     user reviews; `plansDirPath` is its plans-dir copy when known; `redraftCount` rides for the
//     gate. NO tokens are spent re-presenting.
//   - "resend": the active node is mid-turn at a re-sendable step (recon / sizer / leaf draft). The
//     driver re-arms `awaiting` and re-sends that step's existing prompt.
//   - "acceptance" (PHASE 5): the ROOT is parked in its forced-acceptance window (running-children,
//     all children summarized, a baseline frozen, no verdict yet). The build is COMPLETE — the only
//     thing missing is the human's verdict against the frozen baseline. The driver re-mints the
//     transient pendingAcceptance gate (exactly as the live notifyAcceptanceReview path does) so the
//     acceptance bar (Approve / Accept-divergence / Open baseline) re-appears. NO model turn is sent —
//     the tree is parked awaiting a human verdict, not an agent. The verdict (approveAcceptance /
//     divergeAcceptance) then drives the deferred finalize. Carries NO path/artifact fields: the gate
//     is re-derived from the tree shape + baseline_, not from disk artifacts (the gate was never
//     serialized).
//   - "restart" (PHASE 2): the active node is in the GENESIS clarify window (open/clarifying-intent).
//     No durable artifact exists; recovery means RE-RUNNING the clarify turn from the root title. The
//     `path` is the (root) node being re-clarified; `from:"clarify"` is the only restart anchor today.
//     This is a FORWARD action the banner can offer (the driver re-opens the clarifier) — distinct from
//     the legacy "genesis phase — start a new plan" dead-end it replaces.
//   - "prototype-gate" (PHASE 2): the active node is the root prototype-approval window
//     (open/prototype-review). Unlike clarify it DOES have durable artifacts on disk — the
//     `.plan-tree/prototype/` dir + INTENT.md the prototype gate reviews — so it is re-presentable as a
//     GATE-style action rather than a from-scratch restart. Modeled as a DEDICATED resumable kind (NOT a
//     reuse of the "gate" kind) because its artifact is a DIRECTORY/manifest under `.plan-tree/`, not a
//     single plan .md verified through the gate-artifact channels — the consumer (detectResumable /
//     the driver) verifies/re-mints the prototype gate, not a plan-file read. `path` is the (root) node.
//   - "rewind" (PHASE 2): fast-forward-safe resume is impossible from the active node, but the run can
//     be SALVAGED by winding back to the nearest DURABLE gate rather than discarded. `toGate` names the
//     checkpoint to wind back to and `path` the node that gate lives on; `planPath` is the durable
//     artifact's filename when the gate has one (a decomposition plan under `.plan-tree/`), else null;
//     `hazard` is the human-readable note about what made the active node unrecoverable. This is the
//     resumable counterpart of the internal RecoveryAction rewind: ONLY the rewinds recoveryFor marked
//     `offerable` (non-root roll-up, between-children review, torn leaf gate, and the runtime-degenerate
//     no-active-node case) surface as this kind; non-offerable rewinds (leaf/executing — Phase 3 — and
//     the root acceptance-window holds) still map to a BLOCKED verdict.
export type ResumePlan =
  | {
      kind: "gate";
      gateKind: "leaf" | "decomposition";
      path: NodePath;
      planPath: string;
      plansDirPath: string | null;
      redraftCount: number;
    }
  // The active node is mid-turn at a re-sendable step. "recon"/"sizer"/"draft"/"decompose" re-arm a
  // leaf/open step from the node's own state. PHASE-2 DEFECT FIX — "rollup"/"review" re-run the
  // IN-FLIGHT TURN of an ALREADY-SPLIT node whose context (child summaries / mandates) is fully
  // reconstructable from disk (reloadDriverStateFromDisk), so the lost work is ONLY the un-landed
  // turn, not the durable+approved decomposition:
  //   - "rollup": a NON-ROOT split resting in its roll-up window (running-children, all children
  //     summarized) was mid roll-up-summary turn. The driver re-sends rollupSummaryPrompt(path,
  //     direct-children summaries) and re-arms `summary`; its SUMMARY_WRITTEN{path} completes the
  //     split (the write OVERWRITES summaryName2(path) — idempotent). NOT a decomposition re-present
  //     (the node is already split — re-presenting its decomposition gate would dead-end on approve,
  //     because CHILDREN_PARSED/DECOMPOSITION_APPROVED require open/awaiting-decomposition-approval).
  //   - "review": a split in `reviewing` (between children) was mid parent-review turn. The driver
  //     re-sends parentReviewPrompt(reviewed child, its summary, remaining sibling mandates) and
  //     re-arms `parent-review`; its PARENT_REVIEW_DONE{path} advances to the next pending child. The
  //     review turn is NO-TOOLS, so re-running it has no duplicate side effects.
  | { kind: "resend"; awaiting: "recon" | "sizer" | "draft" | "decompose" | "rollup" | "review"; path: NodePath }
  | { kind: "acceptance" }
  | { kind: "restart"; from: "clarify"; path: NodePath }
  | { kind: "prototype-gate"; path: NodePath }
  | {
      kind: "rewind";
      toGate: "leaf-approval" | "decomposition" | "leaf";
      path: NodePath;
      planPath: string | null;
      hazard?: string;
      // PHASE 3: a HAZARDOUS rewind that the user may take but ONLY behind a confirmation (edits from
      // the in-flight executing turn may already be PARTIALLY APPLIED — invariant I3). `true` ⇒ the
      // banner (P3c) must gate the action behind a confirm dialog; absent/false ⇒ a one-click Phase-2
      // rewind (rollup / between-children review / torn leaf gate — no side effects to re-apply). The
      // ONLY requiresConfirm rewind today is leaf/executing.
      requiresConfirm?: boolean;
    };

// The resume verdict for a tree: either resumable (with the ResumePlan describing the continuation)
// or blocked (with a human-readable reason). `phaseLabel` is ALWAYS present (a friendly banner
// label for the active phase) so the UI can describe BOTH outcomes.
export type ResumeScope =
  | { resumable: true; plan: ResumePlan; phaseLabel: string }
  | { resumable: false; reason: string; phaseLabel: string };

// ---- TOTAL recovery model (Phase 1 of the recovery refactor) -----------------------------------
//
// `RecoveryAction` is the TOTAL replacement for the partial resumable/blocked split: EVERY active
// (stage,phase) maps to a concrete recovery, so a dead-end is UNREPRESENTABLE. Three variants, NO
// dead-end:
//   - "resume": re-present a gate / re-send a step exactly as today (the only variant Phase 1
//     exercises — `recoveryFor` maps every currently-resumable phase to this, carrying the SAME
//     ResumePlan the legacy table produced).
//   - "rewind": fast-forward-safe recovery is impossible from the active node, but the run can be
//     SALVAGED by winding back to the nearest durable gate (a leaf-approval/decomposition/leaf
//     checkpoint) rather than discarded. Defined now with a minimal shape; Phases 2-3 implement the
//     actual rewind targets (today every currently-blocked phase yields a PLACEHOLDER rewind/restart
//     that the `resumeScopeForRoot` adapter still renders as the SAME `blocked(reason)` it did
//     before — so Phase 1 changes nothing for those phases).
//   - "restart": the active node is in the GENESIS window (clarify/prototype) where no durable
//     artifact exists; recovery means restarting the clarify turn. `from: "clarify"` is the only
//     restart anchor today.
export type RewindTarget = {
  // The nearest durable gate to wind back to. `path` is the node that gate lives on; `hazard` is an
  // optional human-readable note about what made the active node unrecoverable (e.g. an in-flight
  // tool call). Phases 2-3 refine how the driver acts on this.
  toGate: "leaf-approval" | "decomposition" | "leaf";
  path: NodePath;
  hazard?: string;
  // PHASE 2: whether this rewind is OFFERABLE as a forward resume action NOW. `true` ⇒ the
  // resumeScopeForRoot adapter surfaces it as a resumable `{kind:"rewind", …}` ResumePlan the banner
  // can offer; absent/false ⇒ the adapter keeps the LEGACY blocked verdict (the hazard string is the
  // reason). NON-offerable rewinds today: leaf/executing (Phase 3 owns the duplicate-write recovery)
  // and the root acceptance-window holds (no baseline / over-resolved). Leaving this OFF for executing
  // keeps its placeholder RewindTarget byte-identical to Phase 1 (`{toGate,path,hazard}`).
  offerable?: boolean;
  // The durable artifact filename for an offerable rewind that re-presents a gate (a decomposition
  // plan under `.plan-tree/`, via planName2). Carried so the adapter can build the rewind ResumePlan's
  // `planPath` without re-deriving it. null when the rewind has no single plan artifact (a torn leaf
  // gate whose plan is gone, or a roll-up/review whose target is the split's own decomposition).
  planPath?: string | null;
  // PHASE 3: this OFFERABLE rewind is HAZARDOUS — the user may continue, but ONLY behind a confirmation,
  // because the in-flight executing turn may have ALREADY PARTIALLY APPLIED edits (invariant I3). `true`
  // ⇒ the adapter surfaces `requiresConfirm` on the resumable verdict so the banner (P3c) gates it
  // behind a confirm dialog; absent/false ⇒ the one-click Phase-2 rewinds (rollup / between-children
  // review / torn leaf gate), which have no partially-applied side effects to re-apply. The ONLY
  // requiresConfirm rewind today is leaf/executing.
  requiresConfirm?: boolean;
};

export type RecoveryAction =
  | { kind: "resume"; plan: ResumePlan }
  | { kind: "rewind"; target: RewindTarget }
  | { kind: "restart"; from: "clarify" };

// Injected disk-probe seam (kept OUT of this pure module): whether the decomposition artifact for a
// given node path exists on disk under `.plan-tree/` (the file is `planName2(path)`). `recoveryFor`
// stays pure + synchronous; the REAL disk check is wired by the caller (orchestrator / detectResumable)
// in the next task. When the predicate is OMITTED the default is "artifact ABSENT" (see the
// `open/decomposing` case) — the conservative re-draft path, never a phantom re-present.
export type DecompositionArtifactExists = (path: NodePath) => boolean;

// TOTAL recovery classifier: maps the GIVEN node's (stage,phase) to a RecoveryAction for EVERY case.
// The switch is exhaustive and ends in an `assertNever`-style guard, so adding a new phase to
// NodeState fails to COMPILE here until it is classified. `path` is the active node's path (for the
// gate/rewind targets that need it); `decompositionArtifactExists` is the injected disk probe used
// ONLY by the `open/decomposing` case.
//
// DA Finding 4 — the HAZARD copy for the leaf/executing audit-and-continue rewind. Names the ACTION's
// risk (what resuming will DO and how it can go wrong), not merely the state. Surfaced verbatim in the
// banner's confirm row ("Are you sure? <hazard>"). Exported so tests pin it from the other side rather
// than duplicating the literal.
export const EXECUTING_REWIND_HAZARD =
  "The assistant will inspect the working tree and continue the remaining steps; if it misjudges " +
  "what's already applied, edits could be duplicated or corrupted.";

// Phase-1 mapping policy:
//   - every CURRENTLY-resumable phase → `{kind:"resume", plan: <the SAME ResumePlan as the legacy
//     table>}`;
//   - every CURRENTLY-blocked phase → a PLACEHOLDER `rewind`/`restart` action (Phases 2-3 refine
//     these). The `resumeScopeForRoot` adapter maps those placeholders back to the IDENTICAL
//     `blocked(reason)` strings, so no externally-observable behavior changes for blocked phases.
//   - the ONE behavioral change: `open/decomposing` (see below).
export function recoveryFor(
  node: TreeNode,
  path: NodePath,
  ledger?: Pick<RecursiveLedger, "baseline_" | "acceptance_">,
  decompositionArtifactExists?: DecompositionArtifactExists,
): RecoveryAction {
  const resume = (plan: ResumePlan): RecoveryAction => ({ kind: "resume", plan });
  const rewind = (target: RewindTarget): RecoveryAction => ({ kind: "rewind", target });

  const state = node.state;
  switch (state.stage) {
    case "open":
      switch (state.phase) {
        case "clarifying-intent":
          // GENESIS clarify window: no durable artifact; the driver-held confirmedIntent is gone.
          // Restart the clarify turn from the root title. PHASE 2: the adapter now surfaces this as a
          // RESUMABLE `restart` ResumePlan (was the legacy "genesis phase — start a new plan" dead-end).
          return { kind: "restart", from: "clarify" };
        case "prototype-review":
          // PROTOTYPE GATE window: UNLIKE clarify this has durable artifacts on disk (the
          // `.plan-tree/prototype/` dir + INTENT.md the gate reviews), so it is RE-PRESENTABLE rather
          // than restarted from scratch. PHASE 2: classify as a `resume` carrying the dedicated
          // `prototype-gate` ResumePlan (the consumer re-mints the prototype gate from those durable
          // artifacts — it is not a plan-file gate). path is the root.
          return resume({ kind: "prototype-gate", path });
        case "recon":
          return resume({ kind: "resend", awaiting: "recon", path });
        case "sizing":
          return resume({ kind: "resend", awaiting: "sizer", path });
        case "decomposing": {
          // THE Phase-1 behavioral change — DISK-PROBE aware. A persisted `decomposing` is ambiguous:
          // either the draft was never sent, OR a draft WAS produced but the transient decomposition
          // gate event was lost on the kill. Probe disk to disambiguate:
          //   - artifact PRESENT (planName2(path) exists under `.plan-tree/`): the draft survived — yield
          //     the SAME action as `awaiting-decomposition-approval` (re-present the decomposition gate,
          //     do NOT re-draft). No tokens spent.
          //   - artifact ABSENT (or no predicate injected — the conservative default): no draft on disk
          //     → re-send the decompose step (`resend("decompose")`). The driver re-arms the decompose
          //     turn fresh.
          const present = decompositionArtifactExists ? decompositionArtifactExists(path) : false;
          if (present) {
            return resume({
              kind: "gate",
              gateKind: "decomposition",
              path,
              planPath: planName2(path),
              plansDirPath: null,
              redraftCount: node.redraftCount,
            });
          }
          return resume({ kind: "resend", awaiting: "decompose", path });
        }
        case "awaiting-decomposition-approval":
          // DECOMPOSITION GATE: pure-disk re-presentation. planPath is planName2(path) under
          // `.plan-tree/` (reconstructed from disk shape — see the function note above); plansDirPath
          // is unknown from the ledger (the driver reconstructs it in Phase 3), so null here.
          return resume({
            kind: "gate",
            gateKind: "decomposition",
            path,
            planPath: planName2(path),
            plansDirPath: null,
            redraftCount: node.redraftCount,
          });
        case "pending":
          // Defensive: open/pending is "not active" per activePathOf, so we never reach here with it
          // as the active node — but the switch must be exhaustive. There is nothing to re-present;
          // rewind to the (nonexistent) decomposition gate is the placeholder for "not started".
          return rewind({ toGate: "decomposition", path, hazard: "not started" });
      }
      return assertNeverRecovery(state);
    case "leaf":
      switch (state.phase) {
        case "drafting":
          return resume({ kind: "resend", awaiting: "draft", path });
        case "awaiting-approval":
          // LEAF GATE: the plan path lives ON the leaf node (recorded at NODE_DRAFTED). A null here is
          // a torn ledger — the adapter renders that as "missing plan artifact"; otherwise re-present.
          if (state.planPath === null) {
            // RUNTIME-DEGENERATE torn leaf gate: the plan path that should live on the node is gone, so
            // there is NO durable leaf plan to re-present. DEFECT FIX (honesty): NON-offerable. With
            // planPath null the orchestrator's leaf-rewind branch has nothing to re-present and FATALs
            // immediately, so an OFFERABLE rewind here is a guaranteed throwing button. Leave it
            // non-offerable so the adapter renders the LEGACY blocked verdict (the hazard is the reason),
            // matching the no-active-node degenerate case above.
            return rewind({
              toGate: "leaf-approval",
              path,
              planPath: null,
              hazard: "missing plan artifact — start a new plan",
            });
          }
          return resume({
            kind: "gate",
            gateKind: "leaf",
            path,
            planPath: state.planPath,
            plansDirPath: state.plansDirPath,
            redraftCount: node.redraftCount,
          });
        case "executing":
          // PHASE 3 — OFFERABLE-but-HAZARDOUS rewind (invariant I3). The in-flight executing turn may
          // have ALREADY PARTIALLY APPLIED edits to disk; winding back to this leaf's approval gate and
          // re-running could DUPLICATE those writes. Rather than dead-end (the Phase-1/2 non-offerable
          // blocked verdict), we OFFER the rewind — the user CAN continue — but ONLY behind a
          // confirmation (`requiresConfirm`), so the banner (P3c) forces an explicit acknowledgement of
          // the partial-apply risk before resuming. `planPath` carries the leaf's own plan path (the
          // approval gate re-presents it); `offerable` renders it RESUMABLE.
          return rewind({
            toGate: "leaf-approval",
            path,
            planPath: state.planPath,
            // DA Finding 4 — name the ACTION's risk, not just the state, so the confirm row reads as an
            // honest description of what resuming will do and how it can go wrong.
            hazard: EXECUTING_REWIND_HAZARD,
            offerable: true,
            requiresConfirm: true,
          });
        case "summarized":
          // Unreachable: a summarized leaf is not active. Exhaustiveness only.
          return rewind({ toGate: "leaf", path, hazard: "already complete" });
      }
      return assertNeverRecovery(state);
    case "split":
      switch (state.phase) {
        case "running-children":
          // PHASE 5 — THE ROOT ACCEPTANCE WINDOW: the run is complete except the user's verdict against
          // the frozen baseline. RESUMABLE iff the run-level facts confirm a legitimately-parked
          // baseline root (a frozen baseline AND no recorded verdict). Otherwise (non-root roll-up
          // window, or a torn/over-resolved root) → rewind placeholder (adapter renders the legacy
          // blocked reason).
          if (path.length === 0 && inAcceptanceWindow(node)) {
            if (ledger?.baseline_ && !ledger.acceptance_) {
              return resume({ kind: "acceptance" });
            }
            // ROOT acceptance hold without a frozen baseline (or already over-resolved): NOT offerable —
            // the build is parked on a human verdict that no longer has its baseline context. Stays the
            // legacy blocked verdict (the acceptance scope is baseline-gated, ROOT-only).
            return rewind({
              toGate: "leaf",
              path,
              hazard: "awaiting baseline acceptance — start a new plan",
            });
          }
          // NON-ROOT ROLL-UP WINDOW: a split running-children with EVERY child summarized, mid roll-up
          // summary turn. The decomposition here is ALREADY APPROVED and durable — the only lost work is
          // the un-landed roll-up summary turn. DEFECT FIX: re-RUN that turn rather than re-present the
          // (already-consumed) decomposition gate. Re-presenting the decomposition gate would dead-end on
          // approve — the node is ALREADY split, and CHILDREN_PARSED/DECOMPOSITION_APPROVED both require
          // open/awaiting-decomposition-approval (they THROW on a split node), so the Resume button would
          // wedge at an unresolvable gate. Instead `resend("rollup")`: reloadDriverStateFromDisk rebuilds
          // the direct children's summaries, the driver re-sends rollupSummaryPrompt, and the turn's
          // SUMMARY_WRITTEN{path} completes the split (the write OVERWRITES summaryName2(path) —
          // idempotent, no duplicate side effect).
          return resume({ kind: "resend", awaiting: "rollup", path });
        case "reviewing":
          // BETWEEN-CHILDREN REVIEW: the split is reviewing before dispatching its next child. The
          // decomposition is ALREADY APPROVED and durable; the only lost work is the un-landed
          // parent-review turn (a NO-TOOLS turn — no side effects to duplicate). DEFECT FIX: re-RUN that
          // turn (`resend("review")`) rather than re-present the consumed decomposition gate (which would
          // dead-end on approve for the same already-split reason as the roll-up window above).
          // reloadDriverStateFromDisk rebuilds the mandates; the driver re-sends parentReviewPrompt and
          // PARENT_REVIEW_DONE{path} (legal from split/reviewing) advances to the next pending child.
          return resume({ kind: "resend", awaiting: "review", path });
        case "summarized":
          // Unreachable: a summarized split is not active. Exhaustiveness only.
          return rewind({ toGate: "leaf", path, hazard: "already complete" });
      }
      return assertNeverRecovery(state);
  }
}

// Compile-time exhaustiveness guard for recoveryFor's stage/phase switch. A NodeState the switch did
// not handle (only reachable if a new stage/phase is added without classifying it) is a `never` at
// this site — so omitting a phase FAILS TO COMPILE here. At runtime (only if the type system is
// bypassed) it throws LOUDLY rather than returning a silent action.
function assertNeverRecovery(state: never): never {
  throw new Error(`recoveryFor: unclassified node state ${JSON.stringify(state)}`);
}

// PURE resume-scope decision over a tree, following the v1 scope table EXACTLY. Resolves the active
// node via activePathOf, then maps its stage×phase to a verdict. The switch is EXHAUSTIVE: every
// representable stage×phase is handled and an unknown combination throws LOUDLY (so a new phase
// cannot silently slip through as "resumable" — it must be classified here deliberately).
//
// DECOMPOSITION GATE PLAN PATH (Phase-3 finding): an `open/awaiting-decomposition-approval` node
// has NO path field on its NodeState (the open stage is artifact-free at rest — the
// decomposition's masterPath lived only on the transient ApprovalGate2, which a restart discards).
// So the path here is RECONSTRUCTED from disk shape via planName2(path) ("master.md" at the root,
// "<pathKey>-plan.md" for a nested split). The driver (Phase 3) resolves this against the cwd's
// .plan-tree/ directory; here we return the FILENAME the driver will read.
//
// PHASE 5 ACCEPTANCE-WINDOW RESUME: the ROOT acceptance window (running-children, all children
// summarized) is STRUCTURALLY identical to a non-root roll-up window, so the tree shape alone cannot
// tell a legitimately-parked baseline root (resumable — re-mint the verdict gate) from a torn ledger.
// The optional `ledger` carries the run-level facts (baseline_ frozen, acceptance_ not yet recorded)
// that disambiguate it: a root in the acceptance window WITH a frozen baseline AND no verdict is the
// resumable acceptance scope; without those facts (or omitted ledger — e.g. older callers) it stays
// blocked exactly as before. The reducer NEVER parks the root here without a baseline, so an absent
// baseline_ on a root acceptance window is an inconsistent ledger and is correctly NOT offered.
// PHASE-2 ADAPTER: `resumeScopeForRoot` DERIVES its ResumeScope from the TOTAL `recoveryFor`
// classifier. The mapping (Phase 2 turns the formerly-blocked rewind/restart phases into FORWARD,
// resumable verdicts):
//   - `{kind:"resume", plan}`  → `{resumable:true, plan, phaseLabel}` (plan carried verbatim — gate /
//     resend / acceptance, AND the dedicated `prototype-gate` plan from open/prototype-review);
//   - `{kind:"restart", from}` → `{resumable:true, plan:{kind:"restart", from, path}, phaseLabel}`
//     (the genesis clarify window re-runs the clarify turn — no longer a dead-end);
//   - `{kind:"rewind", target}`:
//       · OFFERABLE target → `{resumable:true, plan:{kind:"rewind", toGate, path, planPath, hazard?}}`
//         (non-root roll-up, between-children review, torn leaf gate, runtime-degenerate no-active-node);
//       · NON-offerable target → `{resumable:false, reason: hazard, phaseLabel}` (leaf/executing, owned
//         by Phase 3; and the root acceptance-window holds) — the LEGACY blocked verdict, unchanged.
// The disk-probe `open/decomposing` behavior (resend by default, decomposition gate when the artifact
// is present) is unchanged from Phase 1.
//
// `decompositionArtifactExists` is the injected disk-probe seam threaded down to `recoveryFor`. It is
// PURE here (the function performs no IO); the real probe is wired by the caller in the next task.
// Omitted ⇒ "artifact absent" default ⇒ `open/decomposing` resolves to `resend("decompose")`.
export function resumeScopeForRoot(
  root: TreeNode,
  ledger?: Pick<RecursiveLedger, "baseline_" | "acceptance_">,
  decompositionArtifactExists?: DecompositionArtifactExists,
): ResumeScope {
  const phaseLabel = activePhaseLabel(root);
  const activePath = activePathOf(root);

  if (activePath === null) {
    if (treeIsDone(root)) {
      return { resumable: false, reason: "already complete", phaseLabel };
    }
    // RUNTIME-DEGENERATE: a non-done tree with no active node (an over-resolved/torn ledger — a fresh
    // pending tree opens in clarifying-intent, which IS active, so this should not occur in a coherent
    // run). DEFECT FIX (honesty): NON-offerable. There is NO durable artifact to wind back to (no active
    // node ⇒ no leaf plan, planPath null), and the orchestrator's leaf-rewind branch FATALs immediately
    // on a null planPath — so offering a Resume button here is a guaranteed dead-end. Report BLOCKED with
    // the hazard as the reason instead (matching the non-offerable leaf rewinds), so no throwing button
    // is ever surfaced.
    return { resumable: false, reason: "no active node — start a new plan", phaseLabel };
  }

  const node = nodeAtPath(root, activePath);
  if (!node) {
    // Unreachable: activePathOf only returns paths that resolve.
    return { resumable: false, reason: "no active node", phaseLabel };
  }

  const action = recoveryFor(node, activePath, ledger, decompositionArtifactExists);
  switch (action.kind) {
    case "resume":
      // resume carries a ResumePlan verbatim — today the gate/resend/acceptance shapes AND (Phase 2)
      // the dedicated `prototype-gate` shape from open/prototype-review. All are resumable as-is.
      return { resumable: true, plan: action.plan, phaseLabel };
    case "rewind": {
      const t = action.target;
      // PHASE 2: an OFFERABLE rewind becomes a RESUMABLE `rewind` ResumePlan the banner can offer
      // (wind back to the nearest durable gate). A non-offerable rewind (leaf/executing — Phase 3 —
      // and the root acceptance-window holds) keeps the LEGACY blocked verdict, its hazard the reason.
      if (t.offerable) {
        return {
          resumable: true,
          plan: {
            kind: "rewind",
            toGate: t.toGate,
            path: t.path,
            planPath: t.planPath ?? null,
            ...(t.hazard !== undefined ? { hazard: t.hazard } : {}),
            // PHASE 3: surface the HAZARDOUS one-confirm flag (leaf/executing) so detectResumable /
            // renderResumeBanner (P3c) can gate it behind a confirm dialog. The Phase-2 one-click
            // rewinds (rollup / review / torn leaf gate) leave requiresConfirm absent ⇒ stay one-click.
            ...(t.requiresConfirm ? { requiresConfirm: true } : {}),
          },
          phaseLabel,
        };
      }
      return { resumable: false, reason: t.hazard ?? "not resumable", phaseLabel };
    }
    case "restart":
      // PHASE 2: the GENESIS clarify window is now a FORWARD action — a resumable `restart` ResumePlan
      // (re-run the clarify turn from the root title), no longer the "genesis phase — start a new plan"
      // dead-end. `path` is the active (root) node being re-clarified.
      return {
        resumable: true,
        plan: { kind: "restart", from: action.from, path: activePath },
        phaseLabel,
      };
  }
}

// Friendly banner label for the ACTIVE node's phase (used for BOTH resumable and blocked verdicts).
// A small pure switch over the active node's stage×phase; a done/empty tree reads "Complete".
export function activePhaseLabel(root: TreeNode): string {
  const activePath = activePathOf(root);
  if (activePath === null) {
    return treeIsDone(root) ? "Complete" : "Idle";
  }
  const node = nodeAtPath(root, activePath);
  if (!node) return "Idle"; // unreachable
  const state = node.state;
  switch (state.stage) {
    case "open":
      switch (state.phase) {
        case "clarifying-intent":
          return "Clarifying intent";
        case "prototype-review":
          return "Reviewing prototype";
        case "pending":
          return "Pending";
        case "recon":
          return "Reconnaissance";
        case "sizing":
          return "Sizing";
        case "decomposing":
          return "Decomposing";
        case "awaiting-decomposition-approval":
          return "Awaiting decomposition approval";
      }
      return "Working";
    case "leaf":
      switch (state.phase) {
        case "drafting":
          return "Drafting the plan";
        case "awaiting-approval":
          return "Awaiting your approval of the plan";
        case "executing":
          return "Executing";
        case "summarized":
          return "Complete";
      }
      return "Working";
    case "split":
      switch (state.phase) {
        case "running-children":
          // PHASE 5 — the ROOT resting running-children with all children summarized is the
          // forced-acceptance hold (the run is built; the user must record a verdict); every other
          // running-children resting node is a roll-up window.
          return activePath.length === 0 && inAcceptanceWindow(node)
            ? "Awaiting baseline acceptance"
            : "Rolling up";
        case "reviewing":
          return "Reviewing before the next sub-plan";
        case "summarized":
          return "Complete";
      }
      return "Working";
  }
}

// ===============================================================================================
// ==== end GENERATION 2 =========================================================================
// ===============================================================================================

// ---- sizer-decision parser ------------------------------------------------------------------

// Extract a SizerOutcome from a single assistant text line. DOCUMENTED FORMAT: a line of the form
//   SIZER: <decision> / <num_plans> / <confidence>
// e.g. `SIZER: split / 3 / 0.82`. `decision` ∈ {single,split} — the ONLY two outcomes; `num_plans`
// is a non-negative integer; `confidence` is a float in [0,1]. Returns null for any non-matching
// line, INCLUDING a SIZER line with an unknown decision word (e.g. a stale `escalate`) — the
// driver coerces a sizer turn with no parseable outcome to split.
export function parseSizerDecision(line: string): SizerOutcome | null {
  const m = /^\s*SIZER:\s*(single|split)\s*\/\s*(\d+)\s*\/\s*(\d*\.?\d+)\s*$/i.exec(line);
  if (!m) return null;
  const decision = m[1].toLowerCase() as SizerOutcome["decision"];
  const num_plans = Number.parseInt(m[2], 10);
  const confidence = Number.parseFloat(m[3]);
  if (Number.isNaN(num_plans) || Number.isNaN(confidence)) return null;
  return { decision, confidence, num_plans };
}
