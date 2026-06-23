// Mock-mode fixture — the "Trailhead" nested plan tree the ANIMATE storyboard drafts on-screen.
//
// This mirrors the Chompy `nested.ts` structure EXACTLY (master → 01..04, with 04 a DECOMPOSITION
// parent → 04.01..04.04) so the sidebar's nn_path-driven nesting renders identically. The CONTENT is
// the fictional, public-safe Trailhead trail-finder mobile app. The ANIMATE storyboard's closing beat
// (src/mock/animate/storyboard.ts) emits a `plan_changed {plans: TRAILHEAD_PLANS}` frame and opens the
// master in the reading pane — so the drafted plan tree pops into the (previously empty) sidebar and
// the master doc (with a mermaid decomposition diagram) renders on the Plan tab.
//
// The sidebar derives ALL nesting from `nn_path`:
//   master (nn_path null) -> 01, 02, 03, 04
//                                  04 is a DECOMPOSITION parent -> 04.01, 04.02, 04.03, 04.04
//
// Three exports drive the harness:
//   • TRAILHEAD_PLANS — nine PlanRecords (pre-ordered master-first, strictly-descending mtimes), the
//     full set the storyboard's plan_changed frame projects into the sidebar.
//   • TRAILHEAD_MASTER_PATH — the master node's absolute path (the storyboard opens THIS).
//   • TRAILHEAD_MARKDOWN — path -> markdown, merged into MOCK_MARKDOWN so read_plan_contents serves it.

import { asAbsPath, asStem, type PlanRecord } from "../../types";

// One canned home so all paths render home-collapsed ("~/…") consistently with mock path.homeDir.
const PLANS = "/Users/mock/.claude/plans";

// The originating working directory the tree was authored in (drives the sidebar subtitle).
const CWD = "/Users/mock/work/trailhead";

export const TRAILHEAD_TREE_ID = "tree-trailhead-7f3a91c2";

// ---- The master plan document --------------------------------------------------------------------
//
// Opened by the storyboard in the reading pane. Body STARTS with the H1 (NO leading `---` frontmatter
// — this constant is the already-stripped body, not a raw on-disk file). Short Context + Decomposition
// prose plus a real ```mermaid fence. The mermaid uses SAFE alphanumeric node ids (M, S1..S4, L1..L4)
// with the dotted ids inside the bracketed labels — a bare `04.01[…]` mis-parses as a node id.
export const TRAILHEAD_MASTER_DOC = `# Master Plan: Trailhead — trail-finder mobile app

## Context

Trailhead is an Android-first mobile app that helps hikers **find** and **log** trails. This master
plan decomposes the build into four subplans; the trail-detail screen (04) is itself decomposed into
four leaves so the difficulty-badge work the reviewer asked for has a home.

## Decomposition

1. **Trail data & search** — the trail catalog, search, and filtering.
2. **Map & navigation** — the map screen and turn-by-turn routing to a trailhead.
3. **Hike logging** — recording a hike (GPS track, distance, elevation) and saving it.
4. **Trail detail screen (DECOMPOSITION)** — the rich detail view, split into four leaves:
   header + difficulty badge, an elevation chart, reviews, and save / share.

\`\`\`mermaid
flowchart TD
  M["Master · Trailhead"] --> S1["01 · Trail data & search"]
  M --> S2["02 · Map & navigation"]
  M --> S3["03 · Hike logging"]
  M --> S4["04 · Trail detail screen"]
  S4 --> L1["04.01 · Header + difficulty badge"]
  S4 --> L2["04.02 · Elevation chart"]
  S4 --> L3["04.03 · Reviews"]
  S4 --> L4["04.04 · Save / share"]
\`\`\`

Subplans run in order; the trail-detail leaves (04.01–04.04) compose into the detail screen last.
`;

// ---- The REVISED master plan document (V2) -------------------------------------------------------
//
// The Slice-06 "Comment & iterate" beat opens THIS after the user leaves three comments on V1: the
// revised plan that folds the Slice-04 feedback in. It is NOT a sidebar row (not in TRAILHEAD_PLANS);
// it only flows into TRAILHEAD_MARKDOWN so the mock read_plan_contents can serve it when the
// storyboard opens TRAILHEAD_MASTER_V2_PATH in the reading pane. It VISIBLY differs from V1: a new
// "## Difficulty badge" subsection and a "larger trail cards" note reflecting the prototype feedback.
export const TRAILHEAD_MASTER_V2_DOC = `# Master Plan: Trailhead — trail-finder mobile app (revised)

## Context

Trailhead is an Android-first mobile app that helps hikers **find** and **log** trails. This revised
master plan folds in the reviewer's prototype feedback: the trail cards grow and every trail surfaces
its difficulty up front.

## Difficulty badge

Each trail now carries a colour-coded difficulty badge (easy / moderate / hard) on its card and in the
trail-detail header, so a hiker can gauge a trail at a glance before opening it.

## Larger trail cards

The trail list now uses larger trail cards — a bigger hero photo, the difficulty badge, and the trail
length — so the most-scanned screen reads cleanly on a phone.

## Decomposition

1. **Trail data & search** — the trail catalog, search, and filtering.
2. **Map & navigation** — the map screen and turn-by-turn routing to a trailhead.
3. **Hike logging** — recording a hike (GPS track, distance, elevation) and saving it.
4. **Trail detail screen (DECOMPOSITION)** — the rich detail view, split into four leaves:
   header + difficulty badge, an elevation chart, reviews, and save / share.

\`\`\`mermaid
flowchart TD
  M["Master · Trailhead (revised)"] --> S1["01 · Trail data & search"]
  M --> S2["02 · Map & navigation"]
  M --> S3["03 · Hike logging"]
  M --> S4["04 · Trail detail screen"]
  S4 --> L1["04.01 · Header + difficulty badge"]
  S4 --> L2["04.02 · Elevation chart"]
  S4 --> L3["04.03 · Reviews"]
  S4 --> L4["04.04 · Save / share"]
\`\`\`

Subplans run in order; the trail-detail leaves (04.01–04.04) compose into the detail screen last.
`;

// ---- node descriptors (mirror of nested.ts's NestedNode) -----------------------------------------
//
// `title` is the displayed sidebar label (the mock derives the sidebar title from `filename_stem`, so
// we set the stem to the title text). `markdown` is the served body; only the master is seeded (the
// subs are optional — the storyboard never opens them).
interface TrailheadNode {
  filename: string; // file basename under PLANS (the markdown-table key)
  title: string; // displayed filename_stem
  flavor: PlanRecord["flavor"];
  nn: number | null;
  nn_path: string | null;
  child_count: number | null;
  markdown?: string; // served body (master only; subs optional)
}

const NODES: TrailheadNode[] = [
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-00.md",
    title: "Master Plan: Trailhead — trail-finder mobile app",
    flavor: "master",
    nn: null,
    nn_path: null,
    child_count: 4, // 01, 02, 03, 04 are its direct children
    markdown: TRAILHEAD_MASTER_DOC,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-01.md",
    title: "Trail data & search",
    flavor: "sub",
    nn: 1,
    nn_path: "01",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-02.md",
    title: "Map & navigation",
    flavor: "sub",
    nn: 2,
    nn_path: "02",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-03.md",
    title: "Hike logging",
    flavor: "sub",
    nn: 3,
    nn_path: "03",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-04.md",
    title: "Trail detail screen (DECOMPOSITION)",
    flavor: "sub",
    nn: 4,
    nn_path: "04",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-04.01.md",
    title: "Trail header + difficulty badge",
    flavor: "sub",
    nn: 4,
    nn_path: "04.01",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-04.02.md",
    title: "Elevation chart",
    flavor: "sub",
    nn: 4,
    nn_path: "04.02",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-04.03.md",
    title: "Reviews",
    flavor: "sub",
    nn: 4,
    nn_path: "04.03",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-trailhead-7f3a91c2-04.04.md",
    title: "Save / share",
    flavor: "sub",
    nn: 4,
    nn_path: "04.04",
    child_count: null,
  },
];

// The absolute path of the master node (the storyboard opens this).
export const TRAILHEAD_MASTER_PATH = `${PLANS}/${NODES[0].filename}`;

// The absolute path of the REVISED master (V2). The Slice-06 storyboard switches the reading pane to
// THIS after the comment-and-iterate beat. It is deliberately NOT a NODES entry / TRAILHEAD_PLANS row
// (no sidebar row) — it only flows into TRAILHEAD_MARKDOWN below so read_plan_contents can serve it.
export const TRAILHEAD_MASTER_V2_PATH = `${PLANS}/agent-plan-tree-trailhead-7f3a91c2-00-v2.md`;

// Records arrive PRE-ORDERED (list_plans pre-sorts): master first, then its children in nn_path-ascending
// document order (01, 02, 03, 04, 04.01…04.04) — exactly how arrange_plans emits a tree. Strictly-
// descending mtimes preserve that pre-order while slotting the whole tree near the TOP of the sidebar.
const TRAILHEAD_BASE_MTIME = 1_700_002_000_000; // newer than every other MOCK_PLANS mtime (incl. NESTED)

export const TRAILHEAD_PLANS: PlanRecord[] = NODES.map((node, i) =>
  ({
    absolute_path: asAbsPath(`${PLANS}/${node.filename}`),
    filename_stem: asStem(node.title), // sidebar renders the title
    mtime_ms: TRAILHEAD_BASE_MTIME - i * 1_000, // strictly descending, preserves pre-order
    cwd: CWD,
    unread: i === 0, // the master is unread (a bold row), the rest read
    flavor: node.flavor,
    tree_id: TRAILHEAD_TREE_ID,
    nn: node.nn,
    nn_path: node.nn_path,
    child_count: node.child_count,
    collapsed: false,
    h1s: [node.title],
  }) satisfies PlanRecord,
);

// path -> markdown for the served documents (master only — the subs are not opened by the storyboard).
// The mock read_plan_contents serves these; no frontmatter stripping needed (these are already bodies).
export const TRAILHEAD_MARKDOWN: Record<string, string> = {
  ...Object.fromEntries(
    NODES.filter((node) => node.markdown !== undefined).map((node) => [
      `${PLANS}/${node.filename}`,
      node.markdown as string,
    ]),
  ),
  // The revised master (V2) is served too, but is NOT a NODES/TRAILHEAD_PLANS row (no sidebar entry).
  // The Slice-06 storyboard opens TRAILHEAD_MASTER_V2_PATH after the comment-and-iterate beat.
  [TRAILHEAD_MASTER_V2_PATH]: TRAILHEAD_MASTER_V2_DOC,
};
