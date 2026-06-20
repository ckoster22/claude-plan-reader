// Mock-mode fixtures — a REAL historical nested-plan tree (token-free, fully explorable).
//
// This embeds an ACTUAL plan tree authored by the app ("tree-mqcobtz3-5632dc17", the
// "Chompy Asteroids" master plan: a web 2D asteroid game). The nine .md files under
// ./nested/ are VERBATIM copies of the originals from ~/.claude/plans/ — imported as raw
// strings via Vite's `?raw` suffix so the reading pane renders them with full fidelity.
//
// Shape of the tree (the sidebar derives ALL nesting from `nn_path`):
//   master (00) -> 01, 02, 03, 04
//                        04 is a DECOMPOSITION parent -> 04.01, 04.02, 04.03, 04.04
//
// Two read paths consume this module:
//   • NESTED_PLANS — nine PlanRecords appended to MOCK_PLANS (newest-first), so the tree
//     renders prominently near the top of the sidebar and is browsable WITHOUT any preset.
//   • NESTED_MARKDOWN — path -> raw markdown, merged into MOCK_MARKDOWN, so the mock
//     read_plan_contents serves each node's REAL content (frontmatter-stripped, exactly as
//     the real backend's read_plan_contents does — see splitFrontmatter below).

import { asAbsPath, asStem, type PlanRecord } from "../../types";

// VERBATIM raw imports of the nine real plan files (frontmatter intact — stripped on read,
// just like the real backend's read_plan_contents).
import RAW_00 from "./nested/00-master.md?raw";
import RAW_01 from "./nested/01.md?raw";
import RAW_02 from "./nested/02.md?raw";
import RAW_03 from "./nested/03.md?raw";
import RAW_04 from "./nested/04.md?raw";
import RAW_0401 from "./nested/04.01.md?raw";
import RAW_0402 from "./nested/04.02.md?raw";
import RAW_0403 from "./nested/04.03.md?raw";
import RAW_0404 from "./nested/04.04.md?raw";

// One canned home so all paths render home-collapsed ("~/…") consistently with mock path.homeDir.
const PLANS = "/Users/mock/.claude/plans";

// The originating working directory the tree was authored in (drives the sidebar subtitle).
const CWD = "/Users/mock/work/chompy-asteroids";

export const NESTED_TREE_ID = "tree-mqcobtz3-5632dc17";

// ---- frontmatter stripping (mirror of the Rust `split_frontmatter` single source of truth) ----
//
// The real backend's read_plan_contents strips a leading `---`…`---` YAML frontmatter block before
// returning the body, so the reading pane never renders it. The mock's read_plan_contents serves
// these raw files, so it MUST strip identically. We replicate the Rust rule EXACTLY: line 1 must be
// a fence (`---` after trimming trailing whitespace), and a later fence line closes it; only a
// LEADING block counts; an opening fence with no close passes through unchanged. Tolerates `\r\n`.
export function stripFrontmatter(content: string): string {
  const isFence = (line: string): boolean => line.replace(/\s+$/, "") === "---";
  const firstNl = content.indexOf("\n");
  const firstLineEnd = firstNl === -1 ? content.length : firstNl + 1;
  const firstLine = content.slice(0, firstLineEnd);
  if (!isFence(firstLine)) return content;

  let cursor = firstLineEnd;
  while (cursor < content.length) {
    const rest = content.slice(cursor);
    const nl = rest.indexOf("\n");
    const lineEndRel = nl === -1 ? rest.length : nl + 1;
    const line = rest.slice(0, lineEndRel);
    if (isFence(line)) {
      return content.slice(cursor + lineEndRel);
    }
    cursor += lineEndRel;
  }
  // Opening fence but no closing fence ⇒ NOT frontmatter; pass through unchanged.
  return content;
}

// ---- record + content tables -----------------------------------------------------------------

// One node descriptor: its on-disk-style filename stem, its raw file content, and (for subs) the
// canonical dotted nn_path. `title` is what the sidebar renders (the real H1) — in the mock the
// sidebar title derives from `filename_stem`, so we set the stem to the real title text so the
// REAL titles appear in the tree (matching how the existing harness fixtures drive their labels).
interface NestedNode {
  filename: string; // file basename under PLANS (the markdown-table key)
  title: string; // real H1 — used as the displayed filename_stem
  raw: string;
  flavor: PlanRecord["flavor"];
  nn: number | null;
  nn_path: string | null;
  child_count: number | null;
}

const NODES: NestedNode[] = [
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-00.md",
    title: "Master Plan: Chompy Asteroids — Web 2D Asteroid Game",
    raw: RAW_00,
    flavor: "master",
    nn: null,
    nn_path: null,
    child_count: 4, // 01, 02, 03, 04 are its direct children
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-01.md",
    title: "Sub-Plan 01: Engine Scaffold, Body Model & Render Loop",
    raw: RAW_01,
    flavor: "sub",
    nn: 1,
    nn_path: "01",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-02.md",
    title: "Sub-Plan 02: Physics Core — Gravity, Collision Regimes, Soft-Body & Growth",
    raw: RAW_02,
    flavor: "sub",
    nn: 2,
    nn_path: "02",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-03.md",
    title: "Sub-Plan 03: Input, Controls & Infinite-World Population Management",
    raw: RAW_03,
    flavor: "sub",
    nn: 3,
    nn_path: "03",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-04.md",
    title: "Sub-Plan 04 (DECOMPOSITION): HUD, Integration & Tuning",
    raw: RAW_04,
    flavor: "sub",
    nn: 4,
    nn_path: "04",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-04.01.md",
    title: "Sub-Plan 04.01: Integration Verification, Repair & Baseline Commit",
    raw: RAW_0401,
    flavor: "sub",
    nn: 4,
    nn_path: "04.01",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-04.02.md",
    title: "Sub-Plan 04.02: HUD Surfacing & VM-Mapping Tests",
    raw: RAW_0402,
    flavor: "sub",
    nn: 4,
    nn_path: "04.02",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-04.03.md",
    title: "Sub-Plan 04.03: Lose / Restart Flow",
    raw: RAW_0403,
    flavor: "sub",
    nn: 4,
    nn_path: "04.03",
    child_count: null,
  },
  {
    filename: "agent-plan-tree-mqcobtz3-5632dc17-04.04.md",
    title: "Sub-Plan 04.04: Tuning Pass & End-to-End Verification (FINAL)",
    raw: RAW_0404,
    flavor: "sub",
    nn: 4,
    nn_path: "04.04",
    child_count: null,
  },
];

// The absolute path of the master node (the deck preset selects + opens this).
export const NESTED_MASTER_PATH = `${PLANS}/${NODES[0].filename}`;
export const NESTED_MASTER_STEM = NODES[0].title;

// The nine real-title stems (the sidebar/loadPlanHistory pass the title as the stem — see
// NESTED_PLANS.filename_stem). The transcript fixture matches on these so EVERY Chompy node replays
// the same originating session, mirroring the live app's tree_id → session fallback.
export const NODES_TITLES: readonly string[] = NODES.map((n) => n.title);

// Records arrive PRE-ORDERED (list_plans pre-sorts): master first, then its children in
// nn_path-ascending document order (01, 02, 03, 04, 04.01…04.04) — exactly how arrange_plans
// emits a tree (a master IMMEDIATELY followed by its children, deeper dotted children right after
// their parent). We give them recent, strictly-descending mtimes so the whole tree slots near the
// TOP of the sidebar (above the harness tree) while preserving that pre-order within the tree.
const NESTED_BASE_MTIME = 1_700_001_000_000; // newer than every other MOCK_PLANS mtime

export const NESTED_PLANS: PlanRecord[] = NODES.map((node, i) =>
  ({
    absolute_path: asAbsPath(`${PLANS}/${node.filename}`),
    filename_stem: asStem(node.title), // sidebar renders the real title
    mtime_ms: NESTED_BASE_MTIME - i * 1_000, // strictly descending, preserves pre-order
    cwd: CWD,
    unread: i === 0, // the master is unread (a bold row), the rest read
    flavor: node.flavor,
    tree_id: NESTED_TREE_ID,
    nn: node.nn,
    nn_path: node.nn_path,
    child_count: node.child_count,
    collapsed: false,
    h1s: [node.title],
  }) satisfies PlanRecord,
);

// path -> RAW (frontmatter-INTACT) markdown. The mock read_plan_contents strips frontmatter on
// read (stripFrontmatter), mirroring the real backend, so the pane shows only the body.
export const NESTED_MARKDOWN: Record<string, string> = Object.fromEntries(
  NODES.map((node) => [`${PLANS}/${node.filename}`, node.raw]),
);
