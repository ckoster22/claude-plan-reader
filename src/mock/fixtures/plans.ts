// Mock-mode fixtures — sidebar plan records.
//
// A `PlanRecord[]` (the EXACT wire shape the real `list_plans` returns) so the unmodified
// `renderSidebar` renders them. Shapes mirror `src/__fixtures__/list_plans.sample.json` (the
// known-valid fixture the real unit tests use), branded via `asAbsPath`/`asStem` from src/types.ts.
//
// Composition (newest-first, the order the backend pre-sorts by mtime):
//   • an UNREAD standalone (bold title in the sidebar)
//   • a READ standalone
//   • a master + two subs tree (correct flavor / tree_id / nn / nn_path / child_count)
//
// Each plan path here is also a key in src/mock/fixtures/markdown.ts so `read_plan_contents`
// can map path -> document. Keep the two in sync.

import { asAbsPath, asStem, type PlanRecord } from "../../types";
import { ERROR_PLAN_PATH } from "./markdown";
import { NESTED_PLANS } from "./nested";
import { sentinelPlanRecord } from "./sentinel";

// One canned home so all paths render home-collapsed ("~/…") consistently with mock path.homeDir.
const PLANS = "/Users/mock/.claude/plans";

// Helper: build a PlanRecord with sensible defaults, branding the two branded string slots so a
// bare string is a compile error (the same discipline as src/main.test.ts's `rec`).
function plan(
  over: Partial<Omit<PlanRecord, "absolute_path" | "filename_stem">> & {
    absolute_path: string;
    filename_stem: string;
    flavor: PlanRecord["flavor"];
  },
): PlanRecord {
  const { absolute_path, filename_stem, ...rest } = over;
  return {
    mtime_ms: 1_700_000_000_000,
    cwd: null,
    unread: false,
    tree_id: null,
    nn: null,
    nn_path: null,
    child_count: null,
    collapsed: false,
    h1s: [],
    ...rest,
    absolute_path: asAbsPath(absolute_path),
    filename_stem: asStem(filename_stem),
  };
}

// The seed plan list. Newest-first (descending mtime) — `list_plans` returns pre-sorted records.
export const MOCK_PLANS: PlanRecord[] = [
  // The synthetic resume-SENTINEL row (plan-tree-resume:// scheme, no file behind it). Newest mtime so
  // it sits at the very top — opening it drives the placeholder-pane + resume-banner path token-free.
  sentinelPlanRecord(),
  // The REAL "Chompy Asteroids" nested tree (master + 01..04 + 04.01..04.04). Newest mtimes, so it
  // sits at the TOP of the sidebar, fully browsable token-free WITHOUT any preset. Pre-ordered
  // (master immediately followed by its children) exactly as the backend's arrange_plans emits.
  ...NESTED_PLANS,
  plan({
    absolute_path: `${PLANS}/unread-standalone.md`,
    filename_stem: "unread-standalone",
    flavor: "standalone",
    mtime_ms: 1_700_000_600_000,
    cwd: "/Users/mock/work/widgets",
    unread: true,
    h1s: ["Ship the widget pipeline"],
  }),
  plan({
    absolute_path: `${PLANS}/read-standalone.md`,
    filename_stem: "read-standalone",
    flavor: "standalone",
    mtime_ms: 1_700_000_500_000,
    cwd: "/Users/mock/work/notes",
    unread: false,
    h1s: ["A read standalone plan"],
  }),
  plan({
    absolute_path: `${PLANS}/master-harness.md`,
    filename_stem: "master-harness",
    flavor: "master",
    mtime_ms: 1_700_000_400_000,
    cwd: "/Users/mock/work/harness",
    unread: true,
    tree_id: "tree-harness",
    child_count: 2,
    h1s: ["Master: token-free harness"],
  }),
  plan({
    absolute_path: `${PLANS}/harness-sub01.md`,
    filename_stem: "harness-sub01",
    flavor: "sub",
    mtime_ms: 1_700_000_300_000,
    cwd: "/Users/mock/work/harness",
    unread: false,
    tree_id: "tree-harness",
    nn: 1,
    nn_path: "01",
    h1s: ["Sub-Plan 01 — Fake IPC shell"],
  }),
  plan({
    absolute_path: `${PLANS}/harness-sub02.md`,
    filename_stem: "harness-sub02",
    flavor: "sub",
    mtime_ms: 1_700_000_200_000,
    cwd: "/Users/mock/work/harness",
    unread: false,
    tree_id: "tree-harness",
    nn: 2,
    nn_path: "02",
    h1s: ["Sub-Plan 02 — Conversation scenes"],
  }),
  // ---- Phase 3 reading-pane variant standalones (one render concern each; keys match markdown.ts) --
  plan({
    absolute_path: `${PLANS}/variant-mermaid.md`,
    filename_stem: "variant-mermaid",
    flavor: "standalone",
    mtime_ms: 1_700_000_180_000,
    cwd: "/Users/mock/work/widgets",
    unread: false,
    h1s: ["Mermaid diagram"],
  }),
  plan({
    absolute_path: `${PLANS}/variant-table.md`,
    filename_stem: "variant-table",
    flavor: "standalone",
    mtime_ms: 1_700_000_170_000,
    cwd: "/Users/mock/work/widgets",
    unread: false,
    h1s: ["Tables"],
  }),
  plan({
    absolute_path: `${PLANS}/variant-code.md`,
    filename_stem: "variant-code",
    flavor: "standalone",
    mtime_ms: 1_700_000_160_000,
    cwd: "/Users/mock/work/widgets",
    unread: false,
    h1s: ["Code highlighting"],
  }),
  plan({
    absolute_path: `${PLANS}/variant-image.md`,
    filename_stem: "variant-image",
    flavor: "standalone",
    mtime_ms: 1_700_000_150_000,
    cwd: "/Users/mock/work/widgets",
    unread: false,
    h1s: ["Local image"],
  }),
  // The error-fallback plan: its read_plan_contents REJECTS (core.ts sentinel) → #reading-pane.raw.
  plan({
    absolute_path: ERROR_PLAN_PATH,
    filename_stem: "__error__",
    flavor: "standalone",
    mtime_ms: 1_700_000_140_000,
    cwd: "/Users/mock/work/widgets",
    unread: false,
    h1s: ["(read error)"],
  }),
  // The reviewed plan: opened by the external-review flow; VIEWING vs SUMMARY depends on whether it
  // is the open plan. unread:true so it also doubles as a bold-row example.
  plan({
    absolute_path: `${PLANS}/review-pending.md`,
    filename_stem: "review-pending",
    flavor: "standalone",
    mtime_ms: 1_700_000_130_000,
    cwd: "/Users/mock/work/widgets",
    unread: true,
    h1s: ["Plan under review"],
  }),
  // UNKNOWN-cwd plan: cwd:null AND its stem absent from any cwd source, so resolve_cwds returns null
  // for it → cwdState "unknown" → the "unknown" subtitle renders (exercises the resolve_cwds path).
  plan({
    absolute_path: `${PLANS}/unknown-cwd.md`,
    filename_stem: "unknown-cwd",
    flavor: "standalone",
    mtime_ms: 1_700_000_120_000,
    cwd: null,
    unread: false,
    h1s: ["A plan with an unknown origin directory"],
  }),
];

// Deep-copy the seed so a consumer mutating `state.plans` never aliases the module-level fixture
// (keeps re-seed / reset deterministic). Branded fields survive a structuredClone (brands are
// erased at runtime; they are plain strings on the wire).
export function clonePlans(): PlanRecord[] {
  return MOCK_PLANS.map((p) => ({ ...p }));
}

// ---- PHASE 4 parameterized sidebar builder (the Sidebar knobs) ------------------------------

// Options for buildSidebarPlans — the Sidebar knob group's tunables.
export interface SidebarBuildOpts {
  // How many TOP-LEVEL standalone rows to emit (>= 0). Default 4. The tree (when included) is added
  // ON TOP of this count.
  count?: number;
  // How many of those standalone rows are UNREAD (bold). Clamped to [0, count]. Default 1.
  unread?: number;
  // Include the master + two-subs tree (nested rows). Default true.
  tree?: boolean;
}

// A standalone row factory at a synthetic, strictly-descending mtime so the backend's recency order
// is preserved (the mock list_plans returns whatever we hand it; we keep it pre-sorted).
function standalone(i: number, unread: boolean): PlanRecord {
  // Start high and step DOWN so row 0 is newest. Spaced so the tree's mtimes (below) slot beneath.
  const mtime = 1_700_000_900_000 - i * 1_000_000;
  return plan({
    absolute_path: `${PLANS}/gen-standalone-${i}.md`,
    filename_stem: `gen-standalone-${i}`,
    flavor: "standalone",
    mtime_ms: mtime,
    cwd: "/Users/mock/work/widgets",
    unread,
    h1s: [`Generated standalone plan ${i + 1}`],
  });
}

// Build a parameterized sidebar plan list (used by the Sidebar knobs). Emits `count` standalone rows
// (the first `unread` of them bold), then optionally appends the master + two-subs tree. Newest-first.
// Returns FRESH records (no aliasing of the module seed). The generated rows reuse the markdown
// FALLBACK doc on open (no per-row fixture is registered), which is fine for sidebar-only QA.
export function buildSidebarPlans(opts: SidebarBuildOpts = {}): PlanRecord[] {
  const count = Math.max(0, Math.floor(opts.count ?? 4));
  const unread = Math.min(count, Math.max(0, Math.floor(opts.unread ?? 1)));
  const includeTree = opts.tree ?? true;

  const rows: PlanRecord[] = [];
  for (let i = 0; i < count; i++) rows.push(standalone(i, i < unread));

  if (includeTree) {
    rows.push(
      plan({
        absolute_path: `${PLANS}/master-harness.md`,
        filename_stem: "master-harness",
        flavor: "master",
        mtime_ms: 1_600_000_400_000,
        cwd: "/Users/mock/work/harness",
        unread: false,
        tree_id: "tree-harness",
        child_count: 2,
        h1s: ["Master: token-free harness"],
      }),
      plan({
        absolute_path: `${PLANS}/harness-sub01.md`,
        filename_stem: "harness-sub01",
        flavor: "sub",
        mtime_ms: 1_600_000_300_000,
        cwd: "/Users/mock/work/harness",
        unread: false,
        tree_id: "tree-harness",
        nn: 1,
        nn_path: "01",
        h1s: ["Sub-Plan 01 — Fake IPC shell"],
      }),
      plan({
        absolute_path: `${PLANS}/harness-sub02.md`,
        filename_stem: "harness-sub02",
        flavor: "sub",
        mtime_ms: 1_600_000_200_000,
        cwd: "/Users/mock/work/harness",
        unread: false,
        tree_id: "tree-harness",
        nn: 2,
        nn_path: "02",
        h1s: ["Sub-Plan 02 — Conversation scenes"],
      }),
    );
  }
  return rows;
}
