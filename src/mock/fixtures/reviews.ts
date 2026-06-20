// Mock-mode fixtures — plan-REVIEW surfaces (Phase 3).
//
// Four review-bar modes light up here, each through the NARROWEST faithful production seam (no
// production edits — see the seam notes at each fixture):
//
//   • VIEWING / SUMMARY (external review) — a `ReviewRequest` (the EXACT wire shape `list_pending_reviews`
//     returns, lifted from src/types.ts). Driven through the REAL external-review wire: mock
//     `list_pending_reviews` returns it, mock `read_plan_contents` serves its plan file, and a
//     `plan-review-requested` event makes main.ts's handleReviewRequested → openReviewPlanFile →
//     refreshReviewBar paint the bar. VIEWING = the review's plan is open; SUMMARY = a DIFFERENT plan
//     is open while the review is still pending.
//
//   • PROTOTYPE / ACCEPTANCE (orchestrator gates) — a `PrototypeGate` / `AcceptanceGate` (the EXACT
//     shapes from src/conversation/plan-tree.ts) carried on a `PlanTreeSnapshot2`. main.ts derives the
//     bar's PROTOTYPE/ACCEPTANCE mode STRICTLY from the orchestrator snapshot it holds in `orchSnapshot`
//     (set by the orchestrator's onSnapshot/onPrototypeReview/onAcceptanceReview observers) AND
//     isOrchestrationActive(). The narrowest faithful seam is therefore to feed main.ts's OWN subscribed
//     observer a real snapshot through a fake OrchestratorHandle (see src/mock/orchestrator.ts) — the
//     real prototypeGateActive/acceptanceGateActive + applyPrototypeBar/applyAcceptanceBar do the rest.
//     We fabricate only the gate DATA the real orchestrator would itself produce; the derivation +
//     render are the unmodified production code.

import type { ReviewRequest } from "../../types";
import type {
  PrototypeGate,
  AcceptanceGate,
  PlanTreeSnapshot2,
  TreeNode,
  RecursiveLedger,
} from "../../conversation/plan-tree";
import { nonEmpty, parseNn } from "../../conversation/plan-tree";
import type { ResumeVerdict } from "../../main";

const PLANS = "/Users/mock/.claude/plans";

// The reviewed plan's absolute path. This is ALSO a key in src/mock/fixtures/markdown.ts so the
// review's openReviewPlanFile → openPlan → read_plan_contents serves a real document.
export const REVIEW_PLAN_PATH = `${PLANS}/review-pending.md`;

// The reviewed plan's stem (basename without .md) — openReviewPlanFile derives this via
// stemFromBasename; we keep an explicit handle for resolve_cwds + the sidebar fixture.
export const REVIEW_PLAN_STEM = "review-pending";

// A single external-review request fixture (the `requests/<review_id>.json` shape). snake_case keys
// MIRROR the backend serde exactly (see src/types.ts ReviewRequest). created_ms is "now-ish" so the
// launch-recovery STALE filter (10 min) never drops it.
export const MOCK_REVIEW: ReviewRequest = {
  schema: 1,
  review_id: "mock-review-1",
  session_id: "mock-session",
  cwd: "/Users/mock/work/widgets",
  transcript_path: "/Users/mock/.claude/projects/mock/transcript.jsonl",
  plan_text: "# Plan under review\n\n- Step one\n- Step two\n",
  plan_file_path: REVIEW_PLAN_PATH,
  created_ms: 1_700_000_700_000,
};

// ---- orchestrator-gate fixtures (PROTOTYPE / ACCEPTANCE) -------------------------------------

// The cwd the gates render under (open_prototype / open_baseline resolve relative to it).
export const GATE_CWD = "/Users/mock/work/widgets";

// A held visual-prototype gate. kind:"mermaid" so composePreviewMarkdown emits a ```mermaid fence the
// reading-pane's existing mermaid pipeline renders inline (proving the detached preview path). round:1
// → the bar label reads "Visual prototype — round 1 of 3" and the approve button "Approve visual".
export const MOCK_PROTOTYPE_GATE: PrototypeGate = {
  kind: "mermaid",
  paths: [],
  screenshot: null,
  inlinePreview: "flowchart LR\n  A[Request] --> B[Prototype] --> C[Review]",
  variants: [],
  round: 1,
  cwd: GATE_CWD,
};

// A held forced-acceptance gate. openTarget:"index.html" → the bar's reused #prototype-open relabels
// to "Open baseline"; runCommand is the display-only exercise hint.
export const MOCK_ACCEPTANCE_GATE: AcceptanceGate = {
  cwd: GATE_CWD,
  openTarget: "index.html",
  runCommand: "npm run dev",
  round: 1,
};

// A minimal SPLIT root so acceptanceRefineTargets(root) yields two refine targets (the picker +
// #review-refine button show). A split node carries non-empty children; each child is a summarized
// leaf (the acceptance gate arms only once every child summarized). pathKey([c.nn]) keys the picker.
function leaf(nn: number, title: string): TreeNode {
  return {
    nn: parseNn(nn),
    title,
    redraftCount: 0,
    lastFeedback: null,
    state: {
      stage: "leaf",
      phase: "summarized",
      planPath: `${GATE_CWD}/.plan-tree/0${nn}-plan.md`,
      summaryPath: null,
      plansDirPath: null,
    },
  };
}

function splitRoot(): TreeNode {
  return {
    nn: parseNn(1),
    title: "Widget pipeline",
    redraftCount: 0,
    lastFeedback: null,
    state: {
      stage: "split",
      phase: "running-children",
      children: nonEmpty([leaf(1, "Ingestion stage"), leaf(2, "Dashboard wiring")]),
      planPath: `${GATE_CWD}/.plan-tree/master-plan.md`,
      summaryPath: null,
      plansDirPath: null,
    },
  };
}

// Build a PlanTreeSnapshot2 carrying exactly ONE held gate (prototype OR acceptance). All four
// pending* gates default null; the one requested is set. This is the data the real orchestrator
// produces; main.ts's real derivation reads it via orchSnapshot.
//
// PHASE 4 — the Review-bar "prototype round" knob varies the held gate's `round` (1..3); the real
// prototypeBarLabel(round) → "Visual prototype — round N of 3". `round` is clamped to the real 1..3
// band the orchestrator emits. Passing it for an acceptance gate is harmless (acceptance also carries
// a round, surfaced only as audit data).
export function gateSnapshot(which: "prototype" | "acceptance", round = 1): PlanTreeSnapshot2 {
  const r = Math.min(3, Math.max(1, Math.floor(round)));
  // Preserve REFERENCE identity for the fixtures' own default round (1) so existing tests asserting
  // `toBe(MOCK_PROTOTYPE_GATE)` stay green; only spread a fresh object when a different round is asked.
  const proto = r === MOCK_PROTOTYPE_GATE.round ? MOCK_PROTOTYPE_GATE : { ...MOCK_PROTOTYPE_GATE, round: r };
  const accept = r === MOCK_ACCEPTANCE_GATE.round ? MOCK_ACCEPTANCE_GATE : { ...MOCK_ACCEPTANCE_GATE, round: r };
  return {
    treeId: "tree-mock-gate",
    root: splitRoot(),
    activePath: null,
    writePolicy: which === "prototype" ? "prototype" : "acceptEdits",
    done: false,
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: which === "prototype" ? proto : null,
    pendingAcceptance: which === "acceptance" ? accept : null,
  };
}

// A "live-run placeholder" snapshot: an ACTIVE tree with a treeId and NO held gate, so main.ts's
// onSnapshot mints the sidebar live-run placeholder (`.plan.placeholder.active`) without painting any
// review-bar mode. The Sidebar "placeholder on/off" knob drives this. `done:false` + a treeId are the
// two fields onSnapshot keys on.
export function placeholderSnapshot(): PlanTreeSnapshot2 {
  return {
    treeId: "tree-mock-gate",
    root: splitRoot(),
    activePath: null,
    writePolicy: "plan",
    done: false,
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    pendingAcceptance: null,
  };
}

// ---- RESUME BANNER verdict fixtures ---------------------------------------------------------

// A minimal RecursiveLedger (schema 2) for the resume verdict's stashed `ledger` (used only when the
// Resume button is clicked → getOrchestrator().resume()). The banner render itself reads only
// resumable/phaseLabel; cwd/ledger are stashed for the click.
function mockLedger(): RecursiveLedger {
  return {
    schema: 2,
    tree_id: "tree-mock-resume",
    created_ms: 1_700_000_000_000,
    updated_ms: 1_700_000_500_000,
    root: splitRoot(),
  };
}

// A RESUMABLE verdict → #resume-banner shows the #resume-plan-btn labeled "Resume — <phaseLabel>".
export const MOCK_RESUME_RESUMABLE: ResumeVerdict = {
  resumable: true,
  plan: { kind: "resend", awaiting: "recon", path: [] },
  phaseLabel: "Reconnaissance",
  cwd: GATE_CWD,
  ledger: mockLedger(),
};

// A BLOCKED verdict → #resume-banner shows the muted "<phaseLabel> — resuming … isn't supported yet"
// message and NO button.
export const MOCK_RESUME_BLOCKED: ResumeVerdict = {
  resumable: false,
  reason: "resuming from this phase isn't supported yet",
  phaseLabel: "Executing sub-plan 02",
  cwd: GATE_CWD,
  ledger: mockLedger(),
};

// A HAZARDOUS resumable verdict (leaf/executing). Its plan is a `rewind` carrying
// `requiresConfirm:true` + a `hazard` note — the ONLY shape main.ts gates behind the inline
// #resume-confirm row. renderResumeBanner shows the primary button labeled "Continue implementation"
// (resumeActionLabel maps a requiresConfirm rewind to that copy); clicking it reveals the confirm row
// (hazard text + Confirm/Cancel) WITHOUT resuming. This mirrors the jsdom leaf/executing tests so the
// mock can paint the same DOM state the visual QA needs. The hazard string is display-only here.
export const MOCK_RESUME_HAZARDOUS: ResumeVerdict = {
  resumable: true,
  plan: {
    kind: "rewind",
    toGate: "leaf",
    path: [],
    planPath: "/Users/mock/.claude/plans/exec-leaf.md",
    hazard:
      "edits from the in-flight step may be partially applied; continuing could duplicate or corrupt them",
    requiresConfirm: true,
  },
  phaseLabel: "Executing sub-plan 01",
  cwd: GATE_CWD,
  ledger: mockLedger(),
};
