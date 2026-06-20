// Mock-mode fixture — the synthetic "resume sentinel" sidebar row (Phase 4b).
//
// `list_plans` (Rust) synthesizes a childless MASTER PlanRecord for a mid-decompose tree that has NO
// plan `.md` file on disk yet; its `absolute_path` is the SENTINEL `plan-tree-resume://<tree_id>` —
// there is no file behind it. Opening such a row must (a) NOT read_plan_contents the sentinel path,
// (b) render a graceful placeholder pane (the tree's INTENT.md when readable, else a static note), and
// (c) still surface the resume banner with the forward action (derived from the row's cwd + the
// tree's `.plan-tree/state.json`, independent of the absolute_path being a real file).
//
// This fixture lets the TOKEN-FREE harness drive that whole path through the REAL openPlan +
// detectResumable: a sentinel PlanRecord in the seed (so the sidebar renders + resolve_cwds answers
// its cwd), plus a canned state.json ledger and INTENT.md the mock `read_plan_tree_file` serves keyed
// by the sentinel tree's cwd (see core.ts). The ledger is a schema-2 open/recon root, so the REAL
// resumeScopeForRoot classifies it as a resumable resend → the banner shows "Resume — Reconnaissance".

import { asAbsPath, asStem, type PlanRecord } from "../../types";
import { parseNn, type RecursiveLedger, type TreeNode } from "../../conversation/plan-tree";

// The sentinel tree's id + its (mock) originating cwd. The cwd is a real-looking absolute path under
// the mock home so resolvedCwdFor expands cleanly and read_plan_tree_file keys off it.
export const SENTINEL_TREE_ID = "tree-synth-resume";
export const SENTINEL_CWD = "/Users/mock/work/floorplan";

// The sentinel row's absolute_path: the `plan-tree-resume://<tree_id>` scheme main.ts gates on.
export const SENTINEL_PATH = `plan-tree-resume://${SENTINEL_TREE_ID}`;

// The tree's human title (rides h1s[0]) — shown on the sidebar row + reader header instead of the
// tree_id stem.
export const SENTINEL_TITLE = "Build the WebGL floor-plan renderer";

// The INTENT.md body the placeholder pane renders (the original request the driver re-mints under
// `.plan-tree/`). Markdown so the reading pane exercises its real render path.
export const SENTINEL_INTENT_MD = [
  "# Build the WebGL floor-plan renderer",
  "",
  "Render the property's measured floor plan in the browser with WebGL: walls, doors, room labels,",
  "and a north arrow. The renderer must stay 60fps while panning a 40-room plan.",
  "",
  "This plan is still being decomposed — resume above to continue.",
  "",
].join("\n");

// The childless MASTER sentinel PlanRecord exactly as the backend mints it: sentinel path, cwd set,
// title on h1s[0], no nn/nn_path, child_count 0. Newest mtime so it sorts to the TOP of the sidebar.
export function sentinelPlanRecord(): PlanRecord {
  return {
    absolute_path: asAbsPath(SENTINEL_PATH),
    filename_stem: asStem(SENTINEL_TREE_ID), // the tree_id (display-incidental)
    mtime_ms: 1_700_000_950_000,
    cwd: SENTINEL_CWD,
    unread: true,
    flavor: "master",
    tree_id: SENTINEL_TREE_ID,
    nn: null,
    nn_path: null,
    child_count: 0,
    collapsed: false,
    h1s: [SENTINEL_TITLE],
  };
}

// A schema-2 ledger with an OPEN/RECON root for the sentinel tree. The REAL resumeScopeForRoot reads
// this and returns a resumable resend("recon") → the banner offers "Resume — Reconnaissance".
function reconRoot(): TreeNode {
  return {
    nn: parseNn(1),
    title: "Build the WebGL floor-plan renderer",
    redraftCount: 0,
    lastFeedback: null,
    state: { stage: "open", phase: "recon" },
  };
}

// The on-disk state.json string the mock read_plan_tree_file returns for (SENTINEL_CWD, "state.json").
export function sentinelStateJson(): string {
  const ledger: RecursiveLedger = {
    schema: 2,
    tree_id: SENTINEL_TREE_ID,
    created_ms: 1_700_000_000_000,
    updated_ms: 1_700_000_900_000,
    root: reconRoot(),
  };
  return JSON.stringify(ledger);
}
