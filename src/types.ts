// ---- Shared frontend types (cycle-free: imports from NEITHER main.ts NOR resolve.ts) ----
//
// `PlanRecord` mirrors the Rust `PlanRecord` wire shape (see CONTRACT.md). `SidebarCtx` is the
// pure rendering context `renderSidebar` takes. Two of `PlanRecord`'s string fields are BRANDED
// (`AbsPath` / `Stem`) so a bare string — or the wrong branded string — cannot fill those slots:
// the brands turn two bug classes (passing a raw path/stem, or swapping the two) into compile
// errors. Brands are erased at compile time, so emitted JS is unchanged.

// ---- Branded string types ----
declare const brand: unique symbol;
type Brand<B extends string> = string & { readonly [brand]: B };
export type AbsPath = Brand<"AbsPath">;
export type Stem = Brand<"Stem">;
export const asAbsPath = (s: string): AbsPath => s as AbsPath;
export const asStem = (s: string): Stem => s as Stem;

// ---- Frozen contract type (mirrors Rust PlanRecord in CONTRACT.md) ----
export interface PlanRecord {
  absolute_path: AbsPath;
  filename_stem: Stem;
  mtime_ms: number;
  cwd: string | null;
  unread: boolean;
  // ---- Nested-hierarchy fields (Sub-Plan 01). Records arrive PRE-ORDERED. ----
  flavor: "master" | "sub" | "standalone";
  tree_id: string | null;
  nn: number | null;
  // Full canonical dotted id (zero-padded, e.g. "02.01"); `nn` above stays = FIRST segment for
  // legacy consumers only. The sidebar derives ALL sub identity/labels/nesting from `nn_path` —
  // never from `nn` (a 02.01 child labelled by `nn` would collide with its parent "02").
  nn_path: string | null;
  child_count: number | null;
  collapsed: boolean;
  // Plan's ATX H1 heading texts (fence-aware, from the bounded head read); [] when none.
  // Sourced from the backend so the sidebar filter can match on headings without querying
  // the reading pane.
  h1s: string[];
}

// ---- Sub-Plan 02 comment record (mirrors Rust CommentRecord in CONTRACT.md) ---------------
//
// A single persisted comment for a plan. FROZEN 6-key wire shape (see CONTRACT.md §"Sub-Plan
// 02 additions" / §"Highlight + comment with quoted-text anchoring"). `block_line` is
// `number | null` (Rust `Option<i64>`, serde `null`), mirroring
// the existing `cwd: string | null` precedent — `null` means "no enclosing source block, re-find
// scans the whole pane by occurrence". There is NO `-1` sentinel: "no block ancestor" is the type.
// `block_line` + `occurrence` together are the minimal deterministic re-anchor disambiguator;
// keying-by-plan-path lives in the store map (mirrors read-state.json), not the record.
export interface CommentRecord {
  quote: string; // normalized selected text (whitespace-collapsed, trimmed)
  block_line: number | null; // data-source-line of nearest enclosing block; null ⇒ whole-pane scan
  block_end_line: number | null; // data-source-end-line of that same block (markdown-it [start,end), exclusive); null ⇒ unknown/whole-pane
  occurrence: number; // 0-based Nth match of `quote` within the chosen root
  comment: string; // the user's comment
  id: number; // collision-free id = max(existing ids in this plan)+1; also the span's data-c value
}

// ---- cwd three-state read model ----------------------------------------------------------
//
// `cwdByStem: Map<Stem, string | null>` encodes three states via map-presence; this union is
// the single READ model for them and `cwdState` is the single interpreter. All presence/null
// interpretation MUST funnel through `cwdState`/`setCwd` — no scattered `.has()`/`?? null`/
// `=== null` reads of the map elsewhere.
//   - absent key   ⇒ `unresolved` (sidebar shows "")
//   - `null` value ⇒ `unknown`    (sidebar shows "unknown")
//   - path value   ⇒ `resolved`   (sidebar shows the home-collapsed path)
export type CwdState =
  | { state: "unresolved" }
  | { state: "resolved"; path: string }
  | { state: "unknown" };

// PURE — takes the map as a parameter so `resolve.ts` (which receives the map as an arg) can
// share it. Maps map-presence/value to the discriminated union per the table above.
export function cwdState(map: ReadonlyMap<Stem, string | null>, stem: Stem): CwdState {
  if (!map.has(stem)) return { state: "unresolved" };
  const v = map.get(stem) ?? null;
  return v === null ? { state: "unknown" } : { state: "resolved", path: v };
}

// The single write path into the cwd map (mirror of `cwdState`'s read path).
export function setCwd(map: Map<Stem, string | null>, stem: Stem, value: string | null): void {
  map.set(stem, value);
}

// ---- Plan Review (ExitPlanMode hook) wire shapes (mirror the Rust structs / event payloads) ----
//
// snake_case keys MIRROR THE BACKEND'S SERIALIZED JSON exactly (same convention as `PlanRecord` /
// `CommentRecord` above): these come straight off `invoke`/event payloads, so the TS keys must
// equal the Rust serde keys 1:1 — no camelCase conversion. See CONTRACT.md §"Plan Review
// (ExitPlanMode hook)" for the authoritative shapes.

// One parsed `requests/<review_id>.json` entry (returned by `list_pending_reviews`).
export interface ReviewRequest {
  schema: number;
  review_id: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  plan_text: string;
  // Absolute path of the reviewed plan file under `~/.claude/plans/` (Claude writes the plan
  // file before ExitPlanMode; the hook payload carries its path). The review opens THIS real
  // file through the normal plan-open flow so it is selected in the sidebar.
  plan_file_path: string;
  created_ms: number;
}

// Payload of the `plan-review-requested` event (a new pending request appeared).
export interface ReviewRequested {
  review_id: string;
  plan_text: string;
  // Absolute path of the reviewed plan file under `~/.claude/plans/` (see ReviewRequest).
  plan_file_path: string;
}

// Payload of the `plan-review-cancelled` event (a pending request was removed before response).
export interface ReviewCancelled {
  review_id: string;
}

// Pure rendering context. `renderSidebar` takes its container + this ctx so it is unit-testable
// without the module-global `planListEl`/`openPath`. `refreshList` builds the ctx FRESH each
// call so `openPath` is read live (never a stale closure) — this keeps `.active` correct across
// re-lists after navigation.
export interface SidebarCtx {
  openPath: AbsPath | null;
  collapseOverride: Map<string, boolean>; // tree_id -> session collapse intent
  // Session-ONLY collapse for INTERNAL sub nodes (subs with nested children), keyed
  // tree_id + U+0000 + nn_path (see subCollapseKey in main.ts). Deliberately separate from
  // the persisted master collapse store above — internal-node collapse is never persisted
  // (see CONTRACT.md §"Recursive sidebar nesting"). The twirl handler mutates this map
  // directly (no backend call).
  subCollapse: Map<string, boolean>;
  onOpen: (path: AbsPath, stem: Stem) => void;
  onToggleCollapse: (treeId: string, nextCollapsed: boolean) => void;
  // ---- Live-run placeholder (additive — see CONTRACT.md §".plan.placeholder") ----------------
  // A running agent conversation has NO sidebar row until its plan file is written (and list_plans
  // can lag the write). When set AND no rendered record carries `tree_id === placeholder.treeId`,
  // renderSidebar prepends a `.plan.placeholder` row (data-tree-id, NO data-path) as the FIRST
  // entry — always visible regardless of the filter query (it represents live work). `selected`
  // paints `.active` on it (the placeholder stands in as the active row while the real row is
  // missing). Optional so existing ctx constructors stay valid (absent ⇒ no placeholder).
  placeholder?: { treeId: string; label: string; selected: boolean } | null;
  // Click handler for the placeholder row (flips to the Conversation tab + selects it). Optional
  // for the same additive reason.
  onPlaceholderOpen?: () => void;
}
