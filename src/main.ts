import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import {
  renderInto,
  settle,
  extractToc,
  applyComments,
  initComments,
  onCommentCountChanged,
  loadCommentsFor,
  clearAllComments,
  type TocEntry,
  type CommentsIO,
} from "./render";
import { buildFeedbackPrompt } from "./feedback";
import { applyReviewButtonState, applyReviewBarState } from "./review";
import { captureAnchor, applyDelta, scrollToHeading } from "./render/scroll";
import { collapseHome } from "./cwd";
import { resolveCwds } from "./resolve";
import { filterRecords, highlightInto, planCountText } from "./filter";
import { RenderGuard } from "./render-guard";
import { initTitlebar, initThemeToggle, initTextSize } from "./titlebar";
import type {
  PlanRecord,
  SidebarCtx,
  CommentRecord,
  ReviewRequest,
  ReviewRequested,
  ReviewCancelled,
} from "./types";
import { asAbsPath, asStem, cwdState, type AbsPath, type Stem } from "./types";

// ---- Frozen contract type (mirrors Rust PlanChanged in CONTRACT.md) ----
interface PlanChanged {
  path: string;
  kind: string;
}

// ---- DOM handles (the frozen selector contract — see CONTRACT.md) ----
let planListEl: HTMLElement | null;
let planCountEl: HTMLElement | null;
let readerScrollEl: HTMLElement | null;
let readingPaneEl: HTMLElement | null;
let docHeaderEl: HTMLElement | null;
let docFilenameEl: HTMLElement | null;
let docSrcEl: HTMLElement | null;
let tocListEl: HTMLElement | null;
let filterInputEl: HTMLInputElement | null;
let filterClearEl: HTMLElement | null;
let searchEl: HTMLElement | null;
// Sub-Plan 03 — Prompt Feedback button + overlay (title-bar chrome; never inside #reading-pane).
let feedbackBtnEl: HTMLElement | null;
let feedbackCountEl: HTMLElement | null;
let feedbackOverlayEl: HTMLElement | null;
let feedbackBodyEl: HTMLElement | null;
let feedbackCopyEl: HTMLElement | null;
let feedbackClearEl: HTMLElement | null;
// Phase 6 — Plan Review (ExitPlanMode hook): hook install/remove buttons.
// Review action bar (non-occluding affordance docked in the reading-pane column header so inline
// commenting in the pane stays fully usable). Shown whenever a review is pending (viewing OR
// summary mode); see applyReviewBarState.
let reviewBarEl: HTMLElement | null;
let reviewBarLabelEl: HTMLElement | null;
let reviewSubmitEl: HTMLButtonElement | null;
let reviewClearEl: HTMLButtonElement | null;
let reviewDismissEl: HTMLButtonElement | null;
let reviewResumeEl: HTMLButtonElement | null;
let hookSetupEl: HTMLElement | null;
let hookRemoveEl: HTMLElement | null;
let hookStatusEl: HTMLElement | null;

// Absolute path of the currently-open plan (null when nothing selected).
let openPath: AbsPath | null = null;

// ---- Phase 6 — Plan Review (ExitPlanMode hook) — Option A: open the REAL plan file ----
//
// A plan review carries a BLOCKING PreToolUse hook; the app can only RELEASE it (decision "allow" →
// Claude Code shows its normal terminal plan-approval prompt) or DENY it with feedback (decision
// "deny" + assembled comments → Claude revises). There is no in-app auto-approve.
//
// NEW MODEL (the invariant fix): the reviewed plan is a REAL file under `~/.claude/plans/` (its
// absolute path rides on the review payload as `planFilePath`). A review now OPENS THAT FILE through
// the NORMAL plan-open flow, so it is SELECTED in the sidebar, its comments persist with the plan
// (keyed on its real path — no special store), and live-reload works. The review just adds an action
// bar + tracks that this plan has a pending blocking hook.
//
//   pendingReviews — every known pending review (each has a live blocking hook). Keyed by reviewId.
//                    Holds the plan file path (what we open) + planText (degraded fallback render).
//
// "Viewing a review" is a DERIVED condition: openPath equals some pending review's planFilePath.
// Browsing to another plan never touches pendingReviews — the bar simply drops to SUMMARY mode, so a
// pending review never traps navigation.
interface PendingReview {
  reviewId: string;
  planFilePath: string;
  planText: string;
  createdMs: number;
}
const pendingReviews = new Map<string, PendingReview>();

// The reviewId whose planFilePath === the currently-open plan, or null when the open plan is not a
// pending review (this is the single derivation of "viewing a review"). On ties (same path tracked
// by >1 review — should not happen) the last-iterated (newest-inserted) wins.
function currentReviewId(): string | null {
  if (openPath === null) return null;
  let match: string | null = null;
  for (const r of pendingReviews.values()) {
    if (r.planFilePath === openPath) match = r.reviewId;
  }
  return match;
}

// Test-only reader: the open plan's comment count (the review's comments are just the plan's
// comments now). Kept under the old name so existing review assertions still read it.
export function reviewCommentCount(): number {
  return currentReviewId() === null ? 0 : commentCount;
}

// Test-only: clear ALL review state (pending reviews). Module state persists across tests in a
// vitest file, so this gives each test a clean slate. Production code never calls it.
export function __resetReviewStateForTest(): void {
  pendingReviews.clear();
}

// ---- Sidebar filter (Fix 1) ----
// The live filter query (raw input value) and the last full records array `list_plans`
// returned. The Plans tab renders `filterRecords(lastRecords, filterQuery)`; the Contents tab
// is never filtered. Held at module scope so a late cwd patch can re-run the filter (keeping
// highlights/matches alive) without a fresh `list_plans` round-trip.
let filterQuery = "";
let lastRecords: PlanRecord[] = [];

// Monotonic render-generation guard. Every open/reload of the pane takes a token at its
// start; after each `await` it bails if a newer render has begun, so only the most-recent
// open/reload mutates the pane (no stale render landing after its successor under bursts).
const renderGuard = new RenderGuard();

// ---- Sub-Plan 02/03: comment count (backend is the single source of truth) ----
// The backend owns the count; main.ts reads it via a command (never the DOM). Sub-Plan 03 makes
// the count VISIBLE via the Prompt Feedback button (applyFeedbackButtonState below).
let commentCount = 0;

// Latest-wins request sequence (Sub-Plan 03). refreshCommentCount is fired un-awaited from open
// (openPlan), reload (reloadOpenPlan), and onCommentCountChanged — concurrent/bursty calls can
// resolve out of order. Each call takes a fresh `seq = ++countReqSeq` before its await and bails
// after if a newer call has begun. This defends BOTH the cross-plan A→B case (a slow get_comment_count
// for A resolving after B is open) AND the same-plan A→A bursty-reload reorder (an earlier request
// resolving last). Strictly stronger than capturing openPath.
let countReqSeq = 0;

// Pure: toggle the Prompt Feedback button's visibility + badge for `count`. count 0 ⇒ add `.hidden`
// (no comments → no button); count >= 1 ⇒ remove `.hidden` and set the badge text to String(count).
// EXPORTED so the gating logic is directly unit-testable (no DOMContentLoaded needed).
export function applyFeedbackButtonState(
  btnEl: HTMLElement | null,
  countEl: HTMLElement | null,
  count: number,
): void {
  if (!btnEl) return;
  if (count <= 0) {
    btnEl.classList.add("hidden");
    return;
  }
  btnEl.classList.remove("hidden");
  if (countEl) countEl.textContent = String(count);
}

// Commit-IF-CURRENT: apply an AUTHORITATIVE count for `path` synchronously to commentCount + the
// button. This is the path used by onCommentCountChanged after an in-session save/clear: the facade
// hands us the MUTATED path + post-mutation count (the just-mutated cache array's length) so we do
// NOT cold-re-read get_comment_count — at fire time the backend write (set_comments) may not have
// landed yet, so a cold read would race it and return a stale 0 (the original bug: button never
// appeared until a plan switch forced a fresh cold read).
//
// PLAN-AWARE guard (cross-plan race fix): a mutation's IPC can still be in flight when the user
// switches plans, so a FOREIGN-plan callback (e.g. a late clear-all for the plan we just left) can
// fire while a different plan is open. Such a callback must be a TOTAL no-op: it must NOT touch the
// button (it would show the wrong count) and — critically — must NOT bump countReqSeq, or it would
// strand the open plan's own in-flight cold refresh (whose seq would then be stale and bail). So we
// commit (and bump seq) ONLY when `path` is the currently-open plan. When it matches, the seq bump
// makes this synchronous commit the newest request, so an in-flight same-plan cold read bails
// instead of clobbering it (preserving latest-wins).
function applyCommentCount(path: AbsPath, count: number): void {
  if (path !== openPath) return; // foreign-plan callback: ignore entirely (no button, no seq bump).
  ++countReqSeq;
  commentCount = count;
  applyFeedbackButtonState(feedbackBtnEl, feedbackCountEl, commentCount);
  // If the open plan IS a pending review, the bar's VIEWING label + Submit-enabled state derive from
  // this count — re-derive so the first comment enables Submit. Pass the authoritative count (commentCount
  // is already committed, but be explicit to mirror the override contract).
  refreshReviewBar(count);
}

// Cold-read the open plan's comment count from the backend (the count-path that works even when
// the array isn't loaded frontend-side — used on OPEN/RELOAD). The latest-wins seq guard ensures
// only the most-recent request commits to commentCount / the button. After an in-session save/clear
// the count is delivered authoritatively via onCommentCountChanged → applyCommentCount (NOT this
// cold read), because the backend write may not be observed yet at fire time. EXPORTED so the count
// plumbing is unit-testable.
export async function refreshCommentCount(): Promise<void> {
  // Short-circuit: nothing open ⇒ count is 0 (no await needed; no stale landing to guard).
  if (openPath === null) {
    commentCount = 0;
    applyFeedbackButtonState(feedbackBtnEl, feedbackCountEl, 0);
    refreshReviewBar(0);
    return;
  }
  const seq = ++countReqSeq;
  try {
    const n = await invoke<number>("get_comment_count", { path: openPath });
    // A newer refresh (or an authoritative applyCommentCount) began while this one was in flight —
    // drop this stale landing so it cannot overwrite the newer count (cross-plan A→B, same-plan A→A
    // bursty-reorder, AND a fresh in-session add whose authoritative count must not be re-read away).
    if (seq !== countReqSeq) return;
    commentCount = n;
    applyFeedbackButtonState(feedbackBtnEl, feedbackCountEl, commentCount);
    // The open plan may BE a pending review — re-derive the bar so its VIEWING comment count is right.
    refreshReviewBar(n);
  } catch (e) {
    console.error("get_comment_count failed", e);
  }
}

// Test-only reader for the stashed count.
export function currentCommentCount(): number {
  return commentCount;
}

// ---- Sub-Plan 03: feedback-overlay sync hooks (registered by the DOMContentLoaded wiring) ----
// The overlay's open/close/snapshot logic lives in the wiring block (closed over its DOM handles +
// the snapshot `feedbackText`). openPlan/reloadOpenPlan are module-level and must keep the overlay
// from showing a STALE prompt across a plan switch / live reload, so the wiring block registers two
// hooks here:
//   - close():        unconditionally hide the overlay (used on a plan SWITCH — a different plan
//                      must never show the prior plan's prompt). The overlay is title-bar chrome,
//                      so closing it does NOT touch #reading-pane (disjointness preserved).
//   - refreshIfOpen():  if the overlay is currently open, re-snapshot its body from the now-current
//                      plan (used on a same-plan live RELOAD — closing would be disruptive if the
//                      user is mid-read, so we keep it open but refresh the quotes/comments in place).
// Null until wiring runs (e.g. under unit tests that never fire DOMContentLoaded) → both no-op.
let feedbackOverlayClose: (() => void) | null = null;
let feedbackOverlayRefreshIfOpen: (() => void) | null = null;

// ---- Review action bar (persistent, non-occluding, resumable) ----
//
// The slim bar docked in the reading-pane header is shown whenever one or more reviews are pending.
// It has two modes (pure derivation in applyReviewBarState):
//   • VIEWING  — the OPEN plan IS a pending review's plan file: Submit (deny + feedback, enabled
//                with >=1 comment) + Dismiss (allow, releases the hook to the terminal).
//   • SUMMARY  — reviews pending but the user is browsing a non-reviewed plan: count label + Resume
//                only, so a pending review never traps navigation.
//
// `viewing` is the DERIVED condition currentReviewId() !== null. `viewedCommentCount` is the OPEN
// plan's comment count (review comments are now the plan's normal persisted comments).
function refreshReviewBar(countOverride?: number): void {
  if (!reviewBarEl) return;
  const state = applyReviewBarState({
    pendingCount: pendingReviews.size,
    viewing: currentReviewId() !== null,
    viewedCommentCount: countOverride ?? commentCount,
  });
  reviewBarEl.classList.toggle("hidden", !state.barVisible);
  if (reviewBarLabelEl) reviewBarLabelEl.textContent = state.label;
  if (reviewSubmitEl) {
    reviewSubmitEl.classList.toggle("hidden", !state.submitVisible);
    reviewSubmitEl.disabled = state.submitDisabled;
  }
  if (reviewClearEl) {
    reviewClearEl.classList.toggle("hidden", !state.clearVisible);
    // If the manual clear button just became hidden (mode change / count hit 0), disarm any pending
    // two-click confirm so it can't fire later in a stale state.
    if (!state.clearVisible) reviewClearDisarm?.();
  }
  if (reviewDismissEl) reviewDismissEl.classList.toggle("hidden", !state.dismissVisible);
  if (reviewResumeEl) reviewResumeEl.classList.toggle("hidden", !state.resumeVisible);
}

// Disarm hook for the #review-clear two-click confirm (set by its wiring; null under unit tests that
// never wire it). refreshReviewBar calls it when the button hides.
let reviewClearDisarm: (() => void) | null = null;

// Shared review-response logic (the SINGLE place that calls respond_to_review), so the bar handlers
// never duplicate the invoke. On success, the review is removed from pendingReviews; the plan stays
// open + selected and its comments remain saved. The bar is then refreshed (drops to summary mode if
// other reviews remain, or hides entirely). Errors are surfaced in-DOM via #hook-status.
//   • Submit  = "deny" + buildFeedbackPrompt(the open plan's comments) → Claude revises.
//   • Dismiss = "allow" + a fixed reason → RELEASES the hook so Claude Code shows its normal terminal
//               plan-approval prompt (the only way to "approve" — see the state-model note above).
// Returns true iff the response was sent successfully (so callers — e.g. Submit — can take a
// success-only follow-up action such as clearing the submitted plan's now-consumed comments).
async function resolveReview(reviewId: string, decision: "allow" | "deny", reason: string): Promise<boolean> {
  try {
    await invoke("respond_to_review", { reviewId, decision, reason });
  } catch (e) {
    console.error(`respond_to_review (${decision}) failed`, e);
    setHookStatus(hookStatusEl, `Could not send review response: ${String(e)}`, "error");
    setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
    return false;
  }
  pendingReviews.delete(reviewId);
  refreshReviewBar();
  return true;
}

// ---- Sub-Plan 03: cwd resolution + read/unread wiring (sidebar only) ----

// The user's home dir, fetched once at startup. Used to collapse a resolved absolute cwd
// into a `~/…` display path. Null until fetched (then we render the absolute path verbatim).
let homePath: string | null = null;

// filename_stem -> resolved cwd display string. Mirrors the backend cwd cache once a
// `resolve_cwds` call returns. `null` means "resolved but unknown" (show "unknown");
// an ABSENT key means "not yet resolved" (show empty — no "unknown" flash).
const cwdByStem = new Map<Stem, string | null>();

// filename_stem of every stem currently in-flight to the backend (or terminally resolved), so
// a stream of `plan-changed` events never re-triggers a full corpus rescan for a stem while one
// is in flight. A `null` (unknown) result under the attempt cap is RELEASED from this set so a
// later event can re-attempt it (see `resolve.ts`); once it hits the cap it stays here.
const attemptedStems = new Set<Stem>();

// Per-stem count of how many times we have asked the backend to resolve it. A stem that keeps
// resolving to `null` ("unknown") is re-attempted up to `MAX_RESOLVE_ATTEMPTS` times so a
// transcript written shortly after the plan file is eventually picked up; past the cap it is
// pinned "unknown" (no unbounded rescans).
const resolveAttemptCounts = new Map<Stem, number>();

// Map a resolved cwd (absolute) to its sidebar display form (home-collapsed, else verbatim).
function displayCwd(absCwd: string): string {
  return homePath ? collapseHome(absCwd, homePath) : absCwd;
}

// Mark a plan viewed on the backend (clears its unread state). Errors are non-fatal.
async function markViewed(path: AbsPath): Promise<void> {
  try {
    await invoke("mark_viewed", { path });
  } catch (e) {
    console.error("mark_viewed failed", e);
  }
}

// Parent directory of an absolute path — used as the base for resolving a plan's
// relative image srcs. Strips the trailing `/<filename>`; falls back to the path
// itself if it has no separator.
function dirOf(absPath: AbsPath): string {
  const idx = absPath.lastIndexOf("/");
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}

// Human-friendly relative time for the sidebar `.plan-meta .when` slot.
function relativeTime(mtimeMs: number): string {
  const now = Date.now();
  const diff = now - mtimeMs;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  const d = new Date(mtimeMs);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Decide the `.plan-src` text for a record. Precedence: backend-cached `rec.cwd` (absolute)
// wins; otherwise consult `cwdByStem` (populated by a completed `resolve_cwds`). The two
// states a row can be in before/after resolution:
//   - not yet resolved (no cache hit, stem absent from cwdByStem) ⇒ "" (empty — no flash)
//   - resolved to a path ⇒ home-collapsed display
//   - resolved but unknown (cwdByStem has null) ⇒ "unknown"
function planSrcText(rec: PlanRecord): string {
  // Prior gate (NOT part of the three-state machine): a backend-cached absolute cwd wins.
  if (rec.cwd) return displayCwd(rec.cwd);
  const s = cwdState(cwdByStem, rec.filename_stem);
  switch (s.state) {
    case "unresolved":
      return ""; // not yet resolved → empty (no "unknown" flash)
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// ---- Nested sidebar rendering (Sub-Plan 02) ----------------------------------------------
//
// `list_plans` returns records PRE-ORDERED for direct nested rendering (see CONTRACT.md
// §"Nested master/sub hierarchy"): top-level masters + standalones interleaved by recency,
// each master IMMEDIATELY followed by its children in nn-ascending order, as a closed flavor
// set with orphans/duplicates already normalized. So `renderSidebar` walks top-to-bottom with
// NO re-aggregation and NO flavor-fallback logic.

// Apply the shared per-row classes/state and click → onOpen wiring to a `.plan` row.
function applyRowState(row: HTMLElement, rec: PlanRecord, ctx: SidebarCtx): void {
  row.dataset.path = rec.absolute_path;
  if (rec.unread) row.classList.add("unread");
  if (rec.absolute_path === ctx.openPath) row.classList.add("active");
  row.addEventListener("click", () => {
    ctx.onOpen(rec.absolute_path, rec.filename_stem);
  });
}

// Build a flat row matching the documented per-row template:
//   .plan[.active][.unread] data-path  >  .plan-row > .plan-title + .unread-dot
//                                          .plan-src (dimmed cwd; filled by 03)
//                                          .plan-meta (.when)
// Standalone rows and 0-child masters use this shape. A 0-child master keeps flavor=master
// semantics internally and opens normally (see the "0-child master ⇒ flat row" decision).
function buildFlatRow(rec: PlanRecord, ctx: SidebarCtx): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan";
  applyRowState(row, rec, ctx);

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const title = document.createElement("span");
  title.className = "plan-title";
  title.textContent = rec.filename_stem;

  const dot = document.createElement("span");
  dot.className = "unread-dot";

  planRow.appendChild(title);
  planRow.appendChild(dot);

  const src = document.createElement("div");
  src.className = "plan-src";
  src.textContent = planSrcText(rec);

  const meta = document.createElement("div");
  meta.className = "plan-meta";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relativeTime(rec.mtime_ms);
  meta.appendChild(when);

  row.appendChild(planRow);
  row.appendChild(src);
  row.appendChild(meta);

  return row;
}

// Build an expandable master: a `.master` wrapper holding a `.plan.master-row` (flat-row shape
// PLUS a leading `.twirl` and a trailing `.child-count`) and a `.children` container. Only built
// when child_count >= 1 (0-child masters render flat via buildFlatRow). Returns the wrapper and
// its `.children` box (the walk threads subs into the latter).
function buildMaster(rec: PlanRecord, ctx: SidebarCtx): { wrapper: HTMLElement; children: HTMLElement } {
  const treeId = rec.tree_id ?? "";
  const effectiveCollapsed = ctx.collapseOverride.get(treeId) ?? rec.collapsed;

  const wrapper = document.createElement("div");
  wrapper.className = "master";
  wrapper.dataset.treeId = treeId; // lets onToggleCollapse find this wrapper for instant feedback
  if (effectiveCollapsed) wrapper.classList.add("collapsed");

  const row = buildFlatRow(rec, ctx);
  row.classList.add("master-row");

  const planRow = row.querySelector(".plan-row") as HTMLElement;

  // Disclosure twirl — its OWN listener stops propagation so toggling never also opens the
  // master plan. Prepend it before the title.
  const twirl = document.createElement("span");
  twirl.className = "twirl";
  twirl.textContent = "▾"; // ▾
  twirl.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.onToggleCollapse(treeId, !(ctx.collapseOverride.get(treeId) ?? rec.collapsed));
  });
  planRow.insertBefore(twirl, planRow.firstChild);

  // "N sub-plans" count (singular at 1) appended after the title/dot.
  const n = rec.child_count ?? 0;
  const count = document.createElement("span");
  count.className = "child-count";
  count.textContent = `${n} sub-plan${n === 1 ? "" : "s"}`;
  planRow.appendChild(count);

  const children = document.createElement("div");
  children.className = "children";

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return { wrapper, children };
}

// Build a compact sub row: `.plan.sub[data-path]` > `.plan-row` = `.seq`(2-digit nn) + title +
// unread dot ONLY (no cwd/timestamp).
function buildSub(rec: PlanRecord, ctx: SidebarCtx): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan sub";
  applyRowState(row, rec, ctx);

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = String(rec.nn ?? 0).padStart(2, "0");

  const title = document.createElement("span");
  title.className = "plan-title";
  title.textContent = rec.filename_stem;

  const dot = document.createElement("span");
  dot.className = "unread-dot";

  planRow.appendChild(seq);
  planRow.appendChild(title);
  planRow.appendChild(dot);
  row.appendChild(planRow);

  return row;
}

// Render the full nested sidebar from pre-ordered records into `listEl`. Single stateful walk
// tracking the current master's `.children` container. EXPORTED so the DOM logic is unit-testable.
export function renderSidebar(listEl: HTMLElement, records: PlanRecord[], ctx: SidebarCtx): void {
  listEl.replaceChildren();
  let currentChildren: HTMLElement | null = null;

  for (const rec of records) {
    if (rec.flavor === "master" && (rec.child_count ?? 0) >= 1) {
      const { wrapper, children } = buildMaster(rec, ctx);
      listEl.appendChild(wrapper);
      currentChildren = children;
    } else if (rec.flavor === "sub") {
      // Trust the contract (a sub always follows its master), but be LOUD not silent: a sub with
      // no open children container is a backend contract violation — log it and append flat so
      // the sidebar still renders (a visible diagnostic, never a quiet re-classification).
      if (currentChildren) {
        currentChildren.appendChild(buildSub(rec, ctx));
      } else {
        console.error("renderSidebar: orphan sub with no master container", rec.absolute_path);
        listEl.appendChild(buildFlatRow(rec, ctx));
      }
    } else {
      // standalone, or a 0-child master ⇒ flat row.
      listEl.appendChild(buildFlatRow(rec, ctx));
      currentChildren = null;
    }
  }
}

// Session record of the user's collapse intent for trees toggled THIS session. Resolved as
// `collapseOverride.get(tree_id) ?? rec.collapsed` in `buildMaster`, so an in-flight refreshList
// reading a not-yet-persisted (stale) `collapsed` value cannot revert the user's toggle — the
// override wins until the backend converges; the empty map on restart cedes to the persisted value.
const collapseOverride = new Map<string, boolean>();

// Optimistic collapse toggle: record intent, toggle `.collapsed` on the master wrapper instantly
// for feedback, then fire-and-forget the persist (errors logged, non-fatal). No re-list.
function onToggleCollapse(treeId: string, next: boolean): void {
  collapseOverride.set(treeId, next);
  if (planListEl) {
    for (const wrapper of Array.from(planListEl.querySelectorAll<HTMLElement>(".master"))) {
      if (wrapper.dataset.treeId === treeId) {
        wrapper.classList.toggle("collapsed", next);
      }
    }
  }
  void invoke("set_tree_collapsed", { treeId, collapsed: next }).catch((e) =>
    console.error("set_tree_collapsed failed", e),
  );
}

// Re-fetch the list and re-render the sidebar (re-sort by recency / nesting happens in Rust).
async function refreshList(): Promise<void> {
  if (!planListEl) return;
  let records: PlanRecord[];
  try {
    records = await invoke<PlanRecord[]>("list_plans");
  } catch (e) {
    console.error("list_plans failed", e);
    records = [];
  }

  // Stash the full records array so the filter can re-render from memory (a late cwd patch
  // re-applies the filter without a fresh list_plans round-trip), then render through the
  // filter path. The filter + count are owned by applyFilterAndRender.
  lastRecords = records;
  applyFilterAndRender();

  // Resolve any still-unknown cwds off the main path, then late-patch the rows.
  void resolveMissingCwds(records);
}

// Build the FRESH sidebar render context (openPath read live, never a stale closure — keeps
// `.active` correct across re-lists). Shared by the filter render path.
function makeSidebarCtx(): SidebarCtx {
  return {
    openPath,
    collapseOverride,
    onOpen: (path, stem) => {
      void openPlan(path, stem);
    },
    onToggleCollapse,
  };
}

// Filter the in-memory records by the live query and render the PLANS TAB only (never the
// Contents/ToC tab — buildToc is not called here). Updates `#plan-count` to the "N of M" form
// while filtering (N = shown files, M = total files), or the plain "M file(s)" form when the
// query is empty. An empty result under a non-empty query shows the `.filter-empty` affordance.
// After rendering, matched substrings are highlighted in the visible `.plan-title` / `.plan-src`
// (a heading-only match still shows its row, un-highlighted). EXPORTED for unit tests.
export function applyFilterAndRender(): void {
  if (!planListEl) return;
  const total = lastRecords.length;
  const shown = filterRecords(lastRecords, filterQuery);

  if (shown.length === 0 && filterQuery.trim() !== "") {
    // Non-empty query with no matches ⇒ empty-state affordance (NOT an empty list).
    planListEl.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "filter-empty";
    empty.textContent = "No matching plans";
    planListEl.appendChild(empty);
  } else {
    renderSidebar(planListEl, shown, makeSidebarCtx());
    highlightVisibleRows(filterQuery);
  }

  if (planCountEl) {
    planCountEl.textContent = planCountText(shown.length, total, filterQuery);
  }
}

// Re-wrap the matched substring in a `<mark>` across every rendered `.plan-title` / `.plan-src`
// in #plan-list, reading each element's current text. Re-applied on every filter render and
// after a late cwd patch, so highlights survive a cwd arriving after the initial render. An
// empty query clears any marks (highlightInto emits plain text).
function highlightVisibleRows(query: string): void {
  if (!planListEl) return;
  for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>(".plan-title, .plan-src"))) {
    highlightInto(el, el.textContent ?? "", query);
  }
}

// Find rows with no resolved cwd, ask the backend to resolve any stems we haven't already
// attempted this session (ONE call), then patch each affected row's `.plan-src` and the
// reader header. Rows stay EMPTY until this completes (no "unknown" flash). The selection,
// the attempted-stems guard, and the retry-on-thrown-error policy live in `src/resolve.ts`
// (unit-tested); a thrown error un-attempts the stems so the next plan-changed retries them.
async function resolveMissingCwds(records: PlanRecord[]): Promise<void> {
  const ran = await resolveCwds(
    records,
    cwdByStem,
    attemptedStems,
    (stems) => invoke<Record<string, string | null>>("resolve_cwds", { stems }),
    resolveAttemptCounts,
  );
  if (ran) patchAllCwds();
}

// Apply newly-resolved cwds after a `resolve_cwds` round-trip (or once the home dir arrives).
// Each record's `.plan-src` text is the DISPLAYED cwd (home-collapsed) which the filter both
// matches against and highlights, so we sync the resolved DISPLAY cwd back onto the in-memory
// records and re-run the filter render. This is what keeps a late-arriving cwd both MATCHABLE
// (the filter sees it) and HIGHLIGHTED (re-rendered through highlightVisibleRows) — satisfying
// "re-apply the filter after late cwd patches". Also refreshes the reader header for the open
// plan. Cheap; safe to call after any resolution (no-op render when there are no records).
function patchAllCwds(): void {
  // Sync the DISPLAYED cwd onto the in-memory records so the (pure, record-based) filter both
  // matches and highlights the SAME string the user sees. `planSrcText` already yields the
  // displayed value (home-collapsed path, "unknown", or "" while unresolved); store it only
  // when it is a real path so an unresolved/unknown row's `cwd` is not poisoned with a
  // non-path placeholder.
  for (const rec of lastRecords) {
    const display = planSrcText(rec);
    if (display && display !== "unknown") rec.cwd = display as PlanRecord["cwd"];
  }
  applyFilterAndRender();
  patchDocSrc();
}

// The `.plan-src` / `#doc-src` text for a stem from the resolved cache alone (empty until
// resolved; "unknown" once resolved-but-null; home-collapsed path once resolved).
function cwdDisplayForStem(stem: Stem): string {
  const s = cwdState(cwdByStem, stem);
  switch (s.state) {
    case "unresolved":
      return "";
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// Filename stem (no `.md`) from an absolute plan path. Mirrors the backend stem.
function stemFromPath(absPath: AbsPath): Stem {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1);
  return asStem(base.endsWith(".md") ? base.slice(0, -3) : base);
}

// Update the reader header `#doc-src` for the currently-open plan via the same resolved
// cache + late-patch path as the sidebar. Empty until resolved; includes the `.folder`
// accent element the existing markup/CSS expect.
function patchDocSrc(): void {
  if (!docSrcEl) return;
  if (openPath === null) {
    docSrcEl.replaceChildren();
    return;
  }
  const text = cwdDisplayForStem(stemFromPath(openPath));
  docSrcEl.replaceChildren();
  if (!text) return;
  const folder = document.createElement("span");
  folder.className = "folder";
  folder.textContent = "📁";
  docSrcEl.appendChild(folder);
  const label = document.createElement("span");
  label.textContent = text;
  docSrcEl.appendChild(label);
}

// ---- Tabbed left panel + table of contents (sidebar domain) ------------------------------
//
// The ToC is the ONE sanctioned reading-pane → sidebar data flow, mediated entirely by the
// render facade: `extractToc(readingPaneEl)` produces a plain `TocEntry[]` (read-only on the
// pane), and `buildToc` consumes that list to populate `#toc-list`. This module never queries
// or mutates `#reading-pane` directly — only via `extractToc` / `scrollToHeading`.

// Wire tab switching: a click on a `.tab` makes it (and the matching `.tab-pane`) the only
// active one. Toggling tabs is a pure view switch — it never rebuilds either pane's content.
// EXPORTED so the toggle wiring is unit-testable against the real code.
export function initTabs(tabRowEl: HTMLElement, paneEls: HTMLElement[]): void {
  const tabs = Array.from(tabRowEl.querySelectorAll<HTMLElement>(".tab"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const pane of paneEls) {
        pane.classList.toggle("active", pane.id === `tab-${target}`);
      }
    });
  }
}

// Render a ToC into `listEl` from a plain entry list. One `.toc-item.toc-h1|.toc-h2` per entry
// carrying `data-line`; a click smooth-scrolls the reader to that heading and flashes the
// clicked row only (transient affordance — NOT scroll-spy). An EMPTY list renders the
// `.toc-empty` "No headings" affordance (caller only passes [] when a plan IS open — the
// nothing-open state clears the list instead). MUST NOT touch any `.tab`/`.tab-pane` `.active`
// class: the active tab is preserved across both open and live reload (no auto-switch).
// EXPORTED so the DOM logic + click wiring are unit-testable.
export function buildToc(listEl: HTMLElement, entries: TocEntry[]): void {
  listEl.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = "No headings";
    listEl.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("a");
    item.className = `toc-item toc-h${entry.level}`;
    item.dataset.line = String(entry.line);
    item.textContent = entry.text;
    item.addEventListener("click", () => {
      if (readerScrollEl && readingPaneEl) {
        scrollToHeading(readerScrollEl, readingPaneEl, entry.line);
      }
      // Flash the clicked row only, then clear (transient click affordance, no scroll-spy).
      for (const el of Array.from(listEl.querySelectorAll(".toc-item.flash"))) {
        el.classList.remove("flash");
      }
      item.classList.add("flash");
      setTimeout(() => item.classList.remove("flash"), 600);
    });
    listEl.appendChild(item);
  }
}

// Rebuild the ToC from the current rendered pane. Called ONLY from inside the render-generation
// guarded region in openPlan/reloadOpenPlan (after the final isCurrent check passes) so a
// superseded render can never clobber a newer render's ToC. Never changes the active tab.
function rebuildTocFromPane(): void {
  if (!tocListEl || !readingPaneEl) return;
  buildToc(tocListEl, extractToc(readingPaneEl));
}

// Open a plan: read raw text into #reading-pane, mark the row active, update the header.
// EXPORTED for testing the render-generation guard around the ToC rebuild (no behavior change).
export async function openPlan(path: AbsPath, stem: Stem): Promise<void> {
  if (!readingPaneEl) return;

  // Navigation is FREE and never touches pendingReviews. "Viewing a review" is derived from
  // openPath (see currentReviewId), so simply opening a plan flips the bar to VIEWING (if this is a
  // reviewed plan's file) or SUMMARY (if a review is pending elsewhere) via the refreshReviewBar()
  // call at the end of this function — no teardown/auto-resurface logic.
  openPath = path;

  // Plan SWITCH: close the feedback overlay so it never shows the PRIOR plan's prompt. Done
  // synchronously up-front (before any await) so even a superseded open still tears down a stale
  // overlay. Title-bar chrome only — does NOT touch #reading-pane (disjointness preserved).
  feedbackOverlayClose?.();

  // Take a render generation: any later open/reload bumps the guard and supersedes this
  // render, so its post-await pane mutations are skipped (no stale content landing late).
  const gen = renderGuard.begin();

  // Record the open plan so the backend holds it read by fiat (live-edits won't re-bold it).
  try {
    await invoke("set_open_plan", { path });
  } catch (e) {
    console.error("set_open_plan failed", e);
  }

  // A newer open superseded us while set_open_plan was in flight — bail before mutating the
  // sidebar/header so a slow A-then-fast-B double click can't leave the header/active row on A
  // while the (correctly guarded) pane shows B. openPath is already set synchronously and the
  // newer call owns the header, so the stale call must do nothing here.
  if (!renderGuard.isCurrent(gen)) return;

  // Reflect .active selection in the sidebar without a full re-list, and locally clear the
  // unread marker on the just-opened row (it is read the moment it's opened).
  if (planListEl) {
    // Rows are no longer all direct children of #plan-list — subs live inside .master > .children.
    // Iterate every row by data-path so nested sub rows also get .active/.unread updated.
    for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>("[data-path]"))) {
      const isThis = el.dataset.path === path;
      el.classList.toggle("active", isThis);
      if (isThis) el.classList.remove("unread");
    }
  }

  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  if (docFilenameEl) docFilenameEl.textContent = `${stem}.md`;
  // Late-patch the reader header cwd from the resolved cache (empty until resolved).
  patchDocSrc();

  try {
    const text = await invoke<string>("read_plan_contents", { path });
    // A newer open/reload superseded us while reading — drop this stale render.
    if (!renderGuard.isCurrent(gen)) return;
    // Sub-Plan 02: render full-fidelity markdown into #reading-pane. New opens
    // start at the top.
    renderInto(readingPaneEl, text, dirOf(path));
    readerScrollEl?.scrollTo({ top: 0 });
    await settle(readingPaneEl);
    // settle() is async; a newer render may have begun while it ran. Bail so a late
    // settle from a superseded render does not touch the pane.
    if (!renderGuard.isCurrent(gen)) return;
    // Rebuild the ToC INSIDE the guarded region (this render won) so a superseded
    // render can never clobber it with stale entries. Does not change the active tab.
    rebuildTocFromPane();
    // Sub-Plan 02: re-apply persisted highlights. loadCommentsFor is cached per-path (a
    // cache-miss is the only real IPC window). The post-await isCurrent re-check is MANDATORY:
    // it mirrors every other awaited mutation here, so a fast A→B switch can't let A's late
    // load resolve and applyComments mutate B's pane.
    const recs = await loadCommentsFor(readingPaneEl, path);
    if (!renderGuard.isCurrent(gen)) return;
    applyComments(readingPaneEl, recs);
    // Cold-read the authoritative count for the just-opened plan.
    void refreshCommentCount();
  } catch (e) {
    console.error("read_plan_contents failed", e);
    if (!renderGuard.isCurrent(gen)) return;
    readingPaneEl.classList.add("raw");
    readingPaneEl.textContent = `Could not read plan: ${String(e)}`;
    // Read failed — clear the ToC so no stale entries point at headings that no
    // longer rendered. (Cleared, not "No headings": there is no valid ToC here.)
    tocListEl?.replaceChildren();
  }

  // Persist the view: clears the unread state for this plan (backend stamps
  // viewed = max(now, mtime+1)). Belt-and-suspenders alongside the open-path fiat.
  await markViewed(path);

  // openPath is now set + the plan rendered: refresh the bar so it flips to VIEWING (this plan is a
  // pending review's file) or SUMMARY (a review is pending on a different plan) or hides (none
  // pending). NOT guarded by renderGuard — the bar reflects pending-review state + openPath, not the
  // rendered pane content. refreshCommentCount (fired un-awaited above) will re-refresh the bar once
  // the authoritative count lands, so the VIEWING label shows the right comment count.
  refreshReviewBar();
}

// Live-reload the currently-open plan, preserving the reading position with an
// element/source-line anchor that survives async render height changes. We
// capture the anchored block BEFORE re-render, apply the delta once after the
// synchronous text lands, then re-apply after settle() so mermaid/image height
// shifts don't drift the viewport.
// EXPORTED for testing the render-generation guard around the ToC rebuild (no behavior change).
export async function reloadOpenPlan(): Promise<void> {
  if (!readingPaneEl || !readerScrollEl || openPath === null) return;
  // A reviewed plan is now a REAL file, so a live edit to it reloads normally (Claude revising the
  // plan after a deny updates the file in place — the user sees the revision live).
  const path = openPath;
  // Take a render generation BEFORE the read: a newer open/reload supersedes us and our
  // post-await pane mutations (renderInto + the two applyDelta calls) are skipped, so an
  // older reload can never clobber a newer one.
  const gen = renderGuard.begin();
  const anchor = captureAnchor(readerScrollEl);
  try {
    const text = await invoke<string>("read_plan_contents", { path });
    // Superseded while reading — drop this stale reload entirely.
    if (!renderGuard.isCurrent(gen)) return;
    renderInto(readingPaneEl, text, dirOf(path));
    applyDelta(readerScrollEl, anchor);
    await settle(readingPaneEl);
    // settle() is async; bail so a superseded reload's second applyDelta never runs.
    if (!renderGuard.isCurrent(gen)) return;
    applyDelta(readerScrollEl, anchor);
    // Rebuild the ToC INSIDE the guarded region so a live edit that adds/removes a
    // heading updates the Contents tab in place. Never changes the active tab.
    rebuildTocFromPane();
    // Sub-Plan 02: on a live reload the cache for this path is invalidated and re-read from the
    // backend (loadCommentsFor re-invokes io.load), then highlights re-apply. The post-await
    // isCurrent re-check is MANDATORY (see openPlan) so a superseded reload never wraps
    // highlights into a newer plan's pane.
    const recs = await loadCommentsFor(readingPaneEl, path);
    if (!renderGuard.isCurrent(gen)) return;
    applyComments(readingPaneEl, recs);
    void refreshCommentCount();
    // Same-plan live RELOAD: a live edit may have added/removed/changed comments. If the overlay is
    // open, re-snapshot its body from the now-current plan instead of closing it (closing would be
    // disruptive mid-read). Low-risk: reuses the exact open-time snapshot path (get_comments →
    // buildFeedbackPrompt → set body), only when the overlay is already visible.
    feedbackOverlayRefreshIfOpen?.();
  } catch (e) {
    console.error("reload failed (plan may have been removed)", e);
  }
}

// Filename stem from an absolute plan path (no `.md`). Reuses stemFromPath for the basename rule.
function stemFromBasename(absPath: string): Stem {
  return stemFromPath(asAbsPath(absPath));
}

// Degraded fallback render: the review's `planFilePath` is empty OR opening the real file failed
// (not found / outside plans dir). Render the IPC-supplied `planText` detached into the reading pane
// so the review is STILL actionable (Submit/Dismiss work — the bar derives from pendingReviews, not
// openPath here). console.warn so the degradation is visible. NOTE: in this path the sidebar row is
// NOT selected (there is no file to select) — this is the documented degraded mode, not the norm.
async function renderReviewTextDetached(planText: string): Promise<void> {
  if (!readingPaneEl) return;
  console.warn("plan review: opening the real plan file failed; rendering detached plan text (degraded)");
  const gen = renderGuard.begin();
  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  if (docFilenameEl) docFilenameEl.textContent = "Plan review";
  if (docSrcEl) docSrcEl.replaceChildren();
  renderInto(readingPaneEl, planText, "");
  readerScrollEl?.scrollTo({ top: 0 });
  await settle(readingPaneEl);
  if (!renderGuard.isCurrent(gen)) return;
  rebuildTocFromPane();
}

// Open a pending review's REAL plan file through the NORMAL plan-open flow (Option A). Refresh the
// sidebar list FIRST so the just-written plan's `[data-path]` row exists, then openPlan(...) — which
// selects that row, persists/loads its comments on its real path, and live-reloads. The bar then
// derives VIEWING from openPath. Falls back to a detached planText render if planFilePath is empty or
// the open fails (file missing / outside plans dir) so the review stays actionable. `review` MUST
// already be tracked in pendingReviews (the caller adds it).
async function openReviewPlanFile(review: PendingReview): Promise<void> {
  if (!review.planFilePath) {
    await renderReviewTextDetached(review.planText);
    refreshReviewBar();
    return;
  }
  // Refresh the sidebar so the just-written plan row exists before we select it. (openPlan applies
  // .active by data-path; the row must be present at/after open for the selection invariant to hold.)
  await refreshList();
  try {
    await openPlan(asAbsPath(review.planFilePath), stemFromBasename(review.planFilePath));
  } catch (e) {
    console.error("plan review: openPlan of the real file failed", e);
    await renderReviewTextDetached(review.planText);
  }
  refreshReviewBar();
}

// Max age (ms) before a pending review is considered STALE: its blocking hook has already timed
// out, so its request file describes a dead review whose Submit/Dismiss would be a silent no-op.
// Stale entries are filtered out of launch recovery.
const STALE_REVIEW_MS = 600_000;

// Pick the NEWEST pending review (max createdMs). Tie-break MUST favor the LATER-INSERTED review on
// equal createdMs: two reviews can arrive within the same millisecond (createdMs falls back to
// Date.now()), and `pendingReviews` is a Map iterated in INSERTION order, so the last-inserted entry
// is the genuinely most-recent arrival. `>=` picks the later-inserted entry, making this deterministic.
function newestPendingReview(): PendingReview | null {
  let newest: PendingReview | null = null;
  for (const r of pendingReviews.values()) {
    if (newest === null || r.createdMs >= newest.createdMs) newest = r;
  }
  return newest;
}

// Resume the NEWEST pending review: open its real plan file through the normal flow (re-selecting its
// sidebar row), switching the bar to VIEWING mode. No-op if nothing is pending. The hook is untouched.
function resumeNewestReview(): void {
  const newest = newestPendingReview();
  if (newest === null) return;
  void openReviewPlanFile(newest);
}

// One serialized `plan-changed` handler body. Runs to completion before the next queued
// event begins (chained on `pending` in the listener) so refreshList/reloadOpenPlan from
// different events never interleave.
async function handlePlanChanged(changedPath: AbsPath): Promise<void> {
  // Keep the backend's notion of the open plan current (belt-and-suspenders; the open
  // plan is also held read by fiat backend-side).
  try {
    await invoke("set_open_plan", { path: openPath });
  } catch (e) {
    console.error("set_open_plan failed", e);
  }

  // If the OPEN plan changed, stamp it viewed BEFORE re-listing so list_plans never
  // momentarily bolds it (in addition to the open-path fiat).
  if (openPath !== null && changedPath === openPath) {
    await markViewed(openPath);
  }

  await refreshList();

  if (openPath !== null && changedPath === openPath) {
    await reloadOpenPlan();
  }
}

/**
 * Append `body` to a serialized promise chain and return the new tail. The `.catch` makes the
 * chain self-healing: if `body` rejects, it is logged and the returned promise still RESOLVES,
 * so the next event chained onto the tail still runs (a single failed handler can never wedge
 * the chain in a permanently-rejected state and silently drop all future events). Exported so
 * this self-healing property is unit-testable against the real code, not a copy of the pattern.
 */
export function chainHandler(
  pending: Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  return pending.then(body).catch((e) => console.error("plan-changed handler failed", e));
}

// ---- Phase 6 — Plan Review hook install/remove (DEPENDENCY-FREE in-DOM UX) ----
//
// WHY THIS REPLACES window.confirm / window.alert: in Tauri v2 (Wry + WKWebView on macOS) those
// JS dialogs have no UI delegate — window.confirm() returns false and window.alert() is a no-op.
// So the old `if (window.confirm(...)) invoke(...)` NEVER invoked, and any error alert was
// invisible → the button "did nothing". We replace both with an in-DOM mechanism that needs no
// new Tauri plugin/capability: a two-click "click again to confirm" arm on the button, and a
// transient status line (#hook-status) for success/error.

// How long the button stays "armed" (confirming) before reverting (ms), and how long a status
// message lingers before auto-clearing (ms). Module constants so the test can reason about them.
const HOOK_CONFIRM_MS = 4000;
const HOOK_STATUS_MS = 6000;

// Set the in-DOM hook status line. `kind` selects success (accent) vs error (red); empty text
// clears + hides it. EXPORTED so the status surface is directly unit-testable.
export function setHookStatus(
  statusEl: HTMLElement | null,
  text: string,
  kind: "success" | "error" = "success",
): void {
  if (!statusEl) return;
  if (!text) {
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    statusEl.classList.remove("error");
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.toggle("error", kind === "error");
  statusEl.classList.remove("hidden");
}

// Wire a hook install/remove button with a dependency-free in-DOM confirm + status flow:
//   1st click  → arm: button enters a "Click again to confirm" state (.confirming + relabel),
//                auto-reverting after HOOK_CONFIRM_MS so a stray click is harmless.
//   2nd click  → invoke the command (wrapped in try/catch). On success show an in-DOM success
//                status; on error show the command's error string in-DOM (NOT a silent alert).
//   Outcome is ALWAYS console.log/console.error'd too (so devtools shows it).
// The button's original label is captured from its current text so arming can restore it. Timers
// are tracked per-button so re-arming/re-clicking doesn't leak stale reverts.
// EXPORTED so the confirm→invoke→status flow is unit-testable without DOMContentLoaded.
export function wireHookButton(
  btn: HTMLElement | null,
  statusEl: HTMLElement | null,
  command: "install_hook" | "uninstall_hook",
  opts: {
    confirmLabel: string;
    successText: string;
    errorPrefix: string;
    invokeFn?: (cmd: string) => Promise<unknown>;
  },
): void {
  if (!btn) return;
  const doInvoke = opts.invokeFn ?? ((cmd: string) => invoke(cmd));
  const labelEl = btn.querySelector(".label");
  const originalLabel = (labelEl ?? btn).textContent ?? "";

  let armed = false;
  let revertTimer: ReturnType<typeof setTimeout> | null = null;

  const setLabel = (text: string): void => {
    if (labelEl) labelEl.textContent = text;
    else btn.textContent = text;
  };
  const disarm = (): void => {
    armed = false;
    btn.classList.remove("confirming");
    setLabel(originalLabel);
    if (revertTimer !== null) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
  };

  btn.addEventListener("click", () => {
    if (!armed) {
      // First click: arm. Clear any prior status so the confirm prompt is unambiguous.
      armed = true;
      btn.classList.add("confirming");
      setLabel(opts.confirmLabel);
      setHookStatus(statusEl, "");
      revertTimer = setTimeout(disarm, HOOK_CONFIRM_MS);
      return;
    }
    // Second click: confirmed. Disarm, then run the command and surface the outcome in-DOM.
    disarm();
    void (async () => {
      try {
        await doInvoke(command);
        console.log(`${command} succeeded`);
        setHookStatus(statusEl, opts.successText, "success");
      } catch (e) {
        console.error(`${command} failed`, e);
        setHookStatus(statusEl, `${opts.errorPrefix}: ${String(e)}`, "error");
      }
      // Auto-clear the (transient) status after a few seconds.
      setTimeout(() => setHookStatus(statusEl, ""), HOOK_STATUS_MS);
    })();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  planListEl = document.querySelector("#plan-list");
  planCountEl = document.querySelector("#plan-count");
  readerScrollEl = document.querySelector("#reader-scroll");
  readingPaneEl = document.querySelector("#reading-pane");
  docHeaderEl = document.querySelector(".doc-header");
  docFilenameEl = document.querySelector("#doc-filename");
  docSrcEl = document.querySelector("#doc-src");
  tocListEl = document.querySelector("#toc-list");
  filterInputEl = document.querySelector("#plan-filter");
  filterClearEl = document.querySelector(".search .clear");
  searchEl = document.querySelector(".search");
  // Sub-Plan 03 Prompt Feedback elements (title-bar + overlay; never inside #reading-pane).
  feedbackBtnEl = document.querySelector("#feedback-btn");
  feedbackCountEl = document.querySelector("#feedback-count");
  feedbackOverlayEl = document.querySelector("#feedback-overlay");
  feedbackBodyEl = document.querySelector("#feedback-body");
  feedbackCopyEl = document.querySelector("#feedback-copy");
  feedbackClearEl = document.querySelector("#feedback-clear");
  // Persistent, non-occluding review action bar (reading-pane header).
  reviewBarEl = document.querySelector("#review-bar");
  reviewBarLabelEl = document.querySelector("#review-bar-label");
  reviewSubmitEl = document.querySelector("#review-submit");
  reviewClearEl = document.querySelector("#review-clear");
  reviewDismissEl = document.querySelector("#review-dismiss");
  reviewResumeEl = document.querySelector("#review-resume");
  hookSetupEl = document.querySelector("#hook-setup");
  hookRemoveEl = document.querySelector("#hook-remove");
  hookStatusEl = document.querySelector("#hook-status");

  // Wire the sidebar filter (Plans tab only). Typing re-renders the filtered Plans list from
  // the in-memory records (no IPC per keystroke); the ✕ button clears the query and re-renders.
  // The `.has-text` class on `.search` reveals the clear button (CSS) only when there is text.
  if (filterInputEl) {
    filterInputEl.addEventListener("input", () => {
      filterQuery = filterInputEl?.value ?? "";
      searchEl?.classList.toggle("has-text", filterQuery.trim().length > 0);
      applyFilterAndRender();
    });
  }
  if (filterClearEl) {
    filterClearEl.addEventListener("click", () => {
      filterQuery = "";
      if (filterInputEl) {
        filterInputEl.value = "";
        filterInputEl.focus();
      }
      searchEl?.classList.remove("has-text");
      applyFilterAndRender();
    });
  }

  // Wire the Plans/Contents tab switching. Default-active tab is Plans (set in index.html);
  // opening/reloading a plan rebuilds the ToC silently without changing the active tab.
  const tabRowEl = document.querySelector<HTMLElement>(".tab-row");
  const tabPlansEl = document.querySelector<HTMLElement>("#tab-plans");
  const tabContentsEl = document.querySelector<HTMLElement>("#tab-contents");
  if (tabRowEl && tabPlansEl && tabContentsEl) {
    initTabs(tabRowEl, [tabPlansEl, tabContentsEl]);
  }
  // Nothing-open initial state: #toc-list stays blank (NOT the "No headings"
  // affordance — that is reserved for an OPEN plan with zero headings).

  // Wire the custom overlay titlebar for window drag + double-click-to-zoom.
  initTitlebar();
  // Wire the icon-only dark/light theme toggle in the titlebar-controls slot.
  initThemeToggle(document.querySelector("#theme-toggle"));
  // Wire the A−/A+ reading-pane text-size steppers (left of the theme toggle).
  initTextSize(document.querySelector("#text-dec"), document.querySelector("#text-inc"));

  // Sub-Plan 02: wire the highlight/comment feature behind the render facade. main.ts only
  // hands the pane element + a LIVE openPath reader + the IO adapters to the facade — it never
  // reaches into #reading-pane for this feature. The facade fires onCommentCountChanged after a
  // save/clear mutation; main.ts refreshes the (backend-owned) count in response.
  if (readingPaneEl) {
    // Comments are ALWAYS the open plan's normal persisted comments now (Option A): a reviewed plan
    // is a real file, so its comments key off its real path and persist to comments.json like any
    // other plan. There is no synthetic review store. The IO is the plain backend invoke path.
    const commentsIo: CommentsIO = {
      load: (p) => invoke<CommentRecord[]>("get_comments", { path: p }),
      save: (p, c) => invoke<CommentRecord[]>("set_comments", { path: p, comments: c }),
      clearAll: (p) => invoke<CommentRecord[]>("clear_comments", { path: p }),
    };
    // The comment-path reader is simply the open plan's real path.
    initComments(readingPaneEl, () => openPath, commentsIo);
    // The facade hands us the MUTATED path + AUTHORITATIVE post-mutation count after an in-session
    // save/clear. Route to applyCommentCount (the Prompt-Feedback badge path, guarded to the open
    // plan), which also re-derives the #review-bar — so if the open plan IS a review, Submit enables
    // on the first comment.
    onCommentCountChanged((path, count) => {
      applyCommentCount(asAbsPath(path), count);
    });
  }

  // ---- Sub-Plan 03: Prompt Feedback button + overlay wiring (title-bar domain) ----
  // The button toggles the overlay; on OPEN it snapshots the generated prompt (get_comments →
  // buildFeedbackPrompt) into the body. Copy writes the prompt to the clipboard; Clear wipes all
  // comments via the render facade (handing in the pane element, never reaching into #reading-pane
  // from main.ts — exactly like initComments / loadCommentsFor). Outside-click closes the overlay.
  if (feedbackBtnEl && feedbackOverlayEl) {
    // The prompt text currently shown in the overlay (snapshot at open) — Copy uses this so it
    // never re-reads the DOM/backend.
    let feedbackText = "";

    const closeOverlay = (): void => feedbackOverlayEl?.classList.add("hidden");

    // Snapshot the prompt into the body (records → buildFeedbackPrompt) from the open plan's
    // persisted comments. A reviewed plan is a real file now, so its comments are read the same way
    // as any plan. Shared by open (then un-hide) and the live-reload refresh-in-place (body only).
    const snapshotBody = async (): Promise<void> => {
      let records: CommentRecord[] = [];
      if (openPath !== null) {
        try {
          records = await invoke<CommentRecord[]>("get_comments", { path: openPath });
        } catch (e) {
          console.error("get_comments failed", e);
        }
      }
      feedbackText = buildFeedbackPrompt(records);
      if (feedbackBodyEl) feedbackBodyEl.textContent = feedbackText;
    };

    const openOverlay = async (): Promise<void> => {
      await snapshotBody();
      feedbackOverlayEl?.classList.remove("hidden");
    };

    // Register the module-level hooks openPlan/reloadOpenPlan call to keep the overlay non-stale.
    feedbackOverlayClose = closeOverlay;
    feedbackOverlayRefreshIfOpen = (): void => {
      // Only re-snapshot when the overlay is actually open (avoid needless IPC on every reload).
      if (feedbackOverlayEl && !feedbackOverlayEl.classList.contains("hidden")) {
        void snapshotBody();
      }
    };

    // The overlay's #feedback-copy is now ALWAYS a plain clipboard copy (review Submit/Dismiss moved
    // to the #review-bar; Approve was removed). applyReviewButtonState() is the single pure source
    // for its label/mode. Set once on load (it never changes).
    if (feedbackCopyEl) {
      const copyState = applyReviewButtonState();
      feedbackCopyEl.textContent = copyState.copyLabel;
      feedbackCopyEl.dataset.mode = copyState.copyMode;
    }

    feedbackBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      // Toggle: close if already open; otherwise snapshot + open.
      if (feedbackOverlayEl && !feedbackOverlayEl.classList.contains("hidden")) {
        closeOverlay();
        return;
      }
      void openOverlay();
    });

    // Outside-click closes the overlay (a click outside both the overlay AND the button).
    document.addEventListener("mousedown", (e) => {
      if (!feedbackOverlayEl || feedbackOverlayEl.classList.contains("hidden")) return;
      const t = e.target as Node | null;
      if (t && feedbackOverlayEl.contains(t)) return; // inside the overlay
      if (t && feedbackBtnEl && feedbackBtnEl.contains(t)) return; // the button (its own handler toggles)
      closeOverlay();
    });

    // #feedback-copy → clipboard (best-effort; jsdom/edge cases may lack navigator.clipboard).
    // Non-review behavior unchanged.
    feedbackCopyEl?.addEventListener("click", () => {
      try {
        void navigator.clipboard?.writeText(feedbackText);
      } catch (e) {
        console.error("clipboard write failed", e);
      }
    });

    // ---- Review action bar wiring (the persistent, non-occluding, resumable affordance) ----
    //   Submit  → deny + the assembled feedback prompt for the VIEWED review → Claude revises.
    //   Dismiss → allow (fixed reason) → RELEASES the hook so Claude Code shows its normal terminal
    //             plan-approval prompt (the only way to "approve"; no in-app auto-execute).
    //   Resume  → re-open the NEWEST pending review (summary mode → viewing mode).
    reviewSubmitEl?.addEventListener("click", () => {
      const reviewId = currentReviewId();
      if (reviewSubmitEl?.disabled || reviewId === null || openPath === null) return; // disabled at 0 comments
      // Assemble the reason from the OPEN plan's persisted comments (the same gathering the overlay
      // Copy uses), then deny. ORDER MATTERS: build the reason from the comments FIRST, send the deny,
      // and ONLY on success CLEAR the comments (they've been consumed into the feedback). The plan
      // stays open + selected; clearing wipes its persisted comments + in-pane highlights.
      const planPath = openPath;
      void (async () => {
        let records: CommentRecord[] = [];
        try {
          records = await invoke<CommentRecord[]>("get_comments", { path: planPath });
        } catch (e) {
          console.error("get_comments failed", e);
        }
        const sent = await resolveReview(reviewId, "deny", buildFeedbackPrompt(records));
        // Clear the submitted plan's comments only AFTER the deny landed (the feedback carried them).
        // Reuse the exact #feedback-clear path: facade clearAllComments removes highlights for planPath,
        // clears the backend (clear_comments), and fires onCommentCountChanged → the count/button/bar
        // refresh to zero. planPath is still the open plan (we just submitted it), so its highlights
        // visibly disappear.
        if (sent && readingPaneEl) {
          await clearAllComments(readingPaneEl, planPath);
        }
      })();
    });
    reviewDismissEl?.addEventListener("click", () => {
      const reviewId = currentReviewId();
      if (reviewId === null) return;
      void resolveReview(
        reviewId,
        "allow",
        "Dismissed in Plan Reader — approve in the terminal.",
      );
    });
    reviewResumeEl?.addEventListener("click", () => resumeNewestReview());

    // ---- #review-clear: discoverable MANUAL clear during review (two-click confirm) ----
    // The overlay's #feedback-clear is not obvious mid-review, so the bar offers a "Clear comments"
    // button (visible in viewing mode with >=1 comment). It uses the SAME dependency-free two-click
    // "click again to confirm" pattern as the hook-setup buttons (window.confirm is inert in this
    // WebView), then runs the EXACT #feedback-clear path: clearAllComments(pane, openPath) removes the
    // plan's highlights, clears the backend, and fires onCommentCountChanged → the bar refreshes (the
    // button hides at 0). Single click only ARMS (no clear); the second click clears.
    if (reviewClearEl) {
      const clearLabel = reviewClearEl.textContent ?? "Clear comments";
      let armed = false;
      let revertTimer: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        armed = false;
        reviewClearEl?.classList.remove("confirming");
        if (reviewClearEl) reviewClearEl.textContent = clearLabel;
        if (revertTimer !== null) {
          clearTimeout(revertTimer);
          revertTimer = null;
        }
      };
      // Expose disarm so refreshReviewBar can cancel a pending confirm when the button hides.
      reviewClearDisarm = disarm;
      reviewClearEl.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          reviewClearEl?.classList.add("confirming");
          if (reviewClearEl) reviewClearEl.textContent = "Click again to confirm";
          revertTimer = setTimeout(disarm, HOOK_CONFIRM_MS);
          return;
        }
        disarm();
        if (readingPaneEl && openPath !== null) {
          void clearAllComments(readingPaneEl, openPath);
        }
      });
    }

    // Clear → wipe all of the open plan's comments via the facade (removes highlights + persists []).
    // The facade's onCommentCountChanged fire refreshes the bar (re-derives Submit-disabled at 0). The
    // overlay closes after clearing.
    feedbackClearEl?.addEventListener("click", () => {
      if (readingPaneEl && openPath !== null) {
        void clearAllComments(readingPaneEl, openPath);
      }
      closeOverlay();
    });
  }

  // ---- Phase 6 — Plan Review hook install/remove buttons (titlebar domain) ----
  // DEPENDENCY-FREE in-DOM UX (see wireHookButton): a two-click "click again to confirm" arm
  // gates the mutation of ~/.claude/settings.json, and #hook-status surfaces success/error in
  // the DOM. This REPLACES window.confirm/window.alert, which are inert in Tauri v2's WKWebView
  // (confirm returns false → invoke never fired; alert is a no-op → any error was invisible).
  // install_hook is the idempotent additive merge; uninstall_hook removes our entry.
  wireHookButton(hookSetupEl, hookStatusEl, "install_hook", {
    confirmLabel: "Click again to confirm",
    successText: "Plan Reader hook installed.",
    errorPrefix: "Could not install hook",
  });
  wireHookButton(hookRemoveEl, hookStatusEl, "uninstall_hook", {
    confirmLabel: "Click again to confirm",
    successText: "Plan Reader hook removed.",
    errorPrefix: "Could not remove hook",
  });

  if (docHeaderEl) docHeaderEl.classList.add("hidden"); // hide until a plan is opened
  if (readingPaneEl) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select a plan from the sidebar to read it.";
    readingPaneEl.appendChild(empty);
  }

  // Fetch the home dir once (for `~/…` collapse). On success, re-patch any already-rendered
  // rows so a list that resolved before the home dir arrived still collapses.
  void homeDir()
    .then((h) => {
      homePath = h.endsWith("/") ? h.slice(0, -1) : h;
      patchAllCwds();
    })
    .catch((e) => console.error("homeDir failed (cwd shown verbatim)", e));

  void refreshList();

  // Live file-watch: re-list always; live-reload the open plan if it changed.
  // Serialize handler bodies on a single promise chain so a burst of `plan-changed`
  // events runs one-at-a-time (no interleaved refreshList/reloadOpenPlan); the
  // render-generation guard then ensures only the latest reload mutates the pane.
  let pending: Promise<void> = Promise.resolve();
  void listen<PlanChanged>("plan-changed", (event) => {
    const changedPath = asAbsPath(event.payload.path);
    // chainHandler appends this event's body to the serialized chain with a .catch backstop,
    // so a single failed handler can't wedge the chain rejected and drop ALL future events.
    pending = chainHandler(pending, () => handlePlanChanged(changedPath));
  });

  // ---- Phase 6 — Plan Review event listeners (mirror plan-changed's serialized chain) ----
  // Review events are serialized on their OWN chain (separate from plan-changed) so a request and
  // a cancel can't interleave their async open/refresh. chainHandler's .catch backstop keeps
  // a single failed handler from wedging the chain.
  let reviewPending: Promise<void> = Promise.resolve();

  // A new review request arrived (a new blocking hook). ALWAYS track it in pendingReviews (so it is
  // resumable and counted), then decide whether to YANK the pane to it:
  //   • If NO review is currently being viewed (currentReviewId() === null — the user is browsing a
  //     non-reviewed plan or nothing), focus the window and OPEN THE REAL plan file via the normal
  //     flow (selecting its sidebar row). Falls back to a detached planText render if that fails.
  //   • If a review is ALREADY being viewed, do NOT yank — just refresh the bar (the count rises;
  //     the user can finish the current one then Resume the rest).
  async function handleReviewRequested(payload: ReviewRequested): Promise<void> {
    // The event payload may not carry createdMs — stamp arrival time as a stable fallback so newest
    // resolution still works.
    const createdMs = (payload as { created_ms?: number }).created_ms ?? Date.now();
    const review: PendingReview = {
      reviewId: payload.review_id,
      planFilePath: payload.plan_file_path,
      planText: payload.plan_text,
      createdMs,
    };
    pendingReviews.set(payload.review_id, review);

    if (currentReviewId() === null) {
      try {
        await invoke("focus_main_window");
      } catch (e) {
        console.error("focus_main_window failed", e);
      }
      // Open the REAL plan file through the normal flow (selects the sidebar row). openReviewPlanFile
      // refreshes the list first and falls back to a detached render if the open fails.
      await openReviewPlanFile(review);
      return;
    }
    // A review is already being viewed — do not yank. The bar's count goes up via summary/viewing.
    refreshReviewBar();
  }

  // A pending request was cancelled (hook gave up / timed out / removed its request). Drop it from
  // pendingReviews. The open plan stays open — only the bar changes (drops to summary/hidden if this
  // was the reviewed plan).
  function handleReviewCancelled(payload: ReviewCancelled): void {
    pendingReviews.delete(payload.review_id);
    refreshReviewBar();
  }

  void listen<ReviewRequested>("plan-review-requested", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, () => handleReviewRequested(payload));
  });
  void listen<ReviewCancelled>("plan-review-cancelled", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, async () => handleReviewCancelled(payload));
  });

  // ---- Phase 6 — launch recovery ----
  // On startup, if reviews are already pending (the app launched while a hook is blocking), populate
  // pendingReviews with all non-stale entries and open the NEWEST one's real plan file via the normal
  // flow (no focus — the user just launched). console.warn if more than one is pending. Chained so it
  // serializes ahead of any live request that arrives during startup.
  reviewPending = chainHandler(reviewPending, async () => {
    let reviews: ReviewRequest[] = [];
    try {
      reviews = await invoke<ReviewRequest[]>("list_pending_reviews");
    } catch (e) {
      console.error("list_pending_reviews failed", e);
      return;
    }
    // Drop STALE entries (hook already timed out — its Submit/Dismiss would be a silent no-op).
    const now = Date.now();
    const fresh = reviews.filter((r) => now - r.created_ms < STALE_REVIEW_MS);
    if (fresh.length === 0) return;
    if (fresh.length > 1) {
      console.warn(`launch recovery: ${fresh.length} pending reviews; auto-showing the newest`);
    }
    // Track every non-stale pending review so all are resumable + counted.
    for (const r of fresh) {
      pendingReviews.set(r.review_id, {
        reviewId: r.review_id,
        planFilePath: r.plan_file_path,
        planText: r.plan_text,
        createdMs: r.created_ms,
      });
    }
    if (currentReviewId() !== null) {
      // A live request already opened a reviewed plan during startup — leave it; just refresh.
      refreshReviewBar();
      return;
    }
    // Open the newest pending review's real plan file (newestPendingReview honors the >= tie-break).
    const newest = newestPendingReview();
    if (newest !== null) await openReviewPlanFile(newest);
  });
});
