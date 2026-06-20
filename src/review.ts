// Plan Review (ExitPlanMode hook) — PURE, DOM-free, invoke-free helpers.
//
// Mirrors feedback.ts's discipline: no imports from main.ts, no DOM, no Tauri. main.ts (the
// title-bar / overlay domain) consumes these; this file stays unit-testable in isolation
// exactly like feedback.ts.
//
// A plan review now OPENS THE REAL plan file through the normal plan-open flow (Option A): the
// reviewed plan is a real file under `~/.claude/plans/`, so opening it selects its sidebar row,
// persists comments with the plan, and live-reloads. There is no synthetic comment store — review
// comments ARE the normal persisted comments of the opened plan. This pure helper derives the
// #review-bar state (the old titlebar Prompt Feedback button + overlay have been removed).

/**
 * The pure, derived state of the persistent #review-bar. Three modes:
 *   - "hidden":  no pending reviews at all → the bar is not shown.
 *   - "viewing": the open plan IS a pending review's plan file → Submit is shown (acting on that
 *                review); Resume is hidden.
 *   - "summary": pending reviews exist but the user is browsing a non-reviewed plan (or nothing) →
 *                only a count label + Resume are shown; Submit is hidden (the pending review stays
 *                resumable but does not trap navigation).
 */
export interface ReviewBarState {
  barVisible: boolean;
  mode: "viewing" | "summary" | "hidden";
  label: string;
  submitVisible: boolean;
  submitDisabled: boolean;
  resumeVisible: boolean;
  // The manual "Clear comments" affordance — shown in VIEWING mode whenever the open plan has >=1
  // comment, so a reviewer always has a discoverable way to wipe their comments mid-review. Hidden
  // in summary/hidden modes and when there are 0 comments (nothing to clear).
  clearVisible: boolean;
  // ---- Sub-Plan 03: source-aware affordances (additive) -------------------------------------
  // The dedicated "Approve & Build" button (#review-approve). It exists ONLY for in-process reviews
  // (a plan held at the in-process canUseTool seam): one click allows the plan and begins execution.
  // External reviews carry a blocking PreToolUse hook that cannot be auto-approved in-app, so this
  // stays false for them. True ONLY when VIEWING an in-process review.
  approveVisible: boolean;
  // The label for the Submit/deny button. In-process reviews deny → the agent RE-PLANS in the same
  // session ("Request changes"); external reviews deny → the terminal Claude revises ("Submit").
  // The Submit button's VISIBILITY + disabled gate (>=1 comment) is identical for both sources; only
  // the label differs.
  submitLabel: string;
}

/**
 * PURE: derive the #review-bar's state from (a) how many pending reviews exist, (b) whether the
 * open plan is one of them (viewing), and (c) the open plan's comment count.
 *
 * Rules (see the task spec):
 *   - pendingCount === 0 → everything hidden (no blocking hook to act on).
 *   - viewing === true   → "viewing" mode: Submit (disabled at 0 comments); Resume hidden.
 *   - viewing === false && pendingCount > 0 → "summary" mode: count label + Resume; Submit hidden
 *     (the pending review stays resumable but does not trap navigation).
 */
export function applyReviewBarState(input: {
  pendingCount: number;
  viewing: boolean;
  viewedCommentCount: number;
  // Sub-Plan 03: which review surface the VIEWED review came from. Defaults to "external" so every
  // existing caller (and the existing snapshot) is byte-identical. Only affects approveVisible +
  // submitLabel in VIEWING mode; all other fields are unchanged for both sources.
  source?: "external" | "in-process";
}): ReviewBarState {
  const source = input.source ?? "external";
  if (input.pendingCount === 0) {
    return {
      barVisible: false,
      mode: "hidden",
      label: "",
      submitVisible: false,
      submitDisabled: true,
      resumeVisible: false,
      clearVisible: false,
      approveVisible: false,
      submitLabel: "Submit",
    };
  }
  if (input.viewing) {
    const n = input.viewedCommentCount;
    const inProcess = source === "in-process";
    return {
      barVisible: true,
      mode: "viewing",
      label: `Reviewing plan — ${n} comment${n === 1 ? "" : "s"}`,
      submitVisible: true,
      submitDisabled: n === 0,
      resumeVisible: false,
      // Manual clear is offered only when there is something to clear.
      clearVisible: n > 0,
      // Approve & Build exists ONLY while viewing an in-process review.
      approveVisible: inProcess,
      submitLabel: inProcess ? "Request changes" : "Submit",
    };
  }
  return {
    barVisible: true,
    mode: "summary",
    label: `${input.pendingCount} plan${input.pendingCount === 1 ? "" : "s"} awaiting review`,
    submitVisible: false,
    submitDisabled: true,
    resumeVisible: true,
    clearVisible: false,
    approveVisible: false,
    submitLabel: "Submit",
  };
}
