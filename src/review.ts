// Plan Review (ExitPlanMode hook) — PURE, DOM-free, invoke-free helpers.
//
// Mirrors feedback.ts's discipline: no imports from main.ts, no DOM, no Tauri. main.ts (the
// title-bar / overlay domain) consumes these; this file stays unit-testable in isolation
// exactly like feedback.ts.
//
// A plan review now OPENS THE REAL plan file through the normal plan-open flow (Option A): the
// reviewed plan is a real file under `~/.claude/plans/`, so opening it selects its sidebar row,
// persists comments with the plan, and live-reloads. There is no synthetic comment store — review
// comments ARE the normal persisted comments of the opened plan. These pure helpers derive only the
// #review-bar / overlay-Copy state.

/** The derived button/overlay state for the feedback overlay's Copy control (non-review use). */
export interface ReviewButtonState {
  // "Copy to clipboard" — the overlay's #feedback-copy is now ONLY ever a clipboard copy (the
  // Submit/Dismiss controls live in the #review-bar, not the overlay). Approve has been removed.
  copyLabel: string;
  // Whether the `#feedback-copy` click copies to clipboard (always "copy" now).
  copyMode: "copy";
}

/**
 * PURE: derive the feedback overlay's Copy button state. The overlay is no longer review-aware —
 * Submit/Dismiss moved to the persistent #review-bar and Approve was removed entirely — so this is
 * always plain clipboard-copy mode. Kept (and unit-tested) so the overlay wiring has a single
 * pure source of truth for its one remaining control.
 */
export function applyReviewButtonState(): ReviewButtonState {
  return { copyLabel: "Copy to clipboard", copyMode: "copy" };
}

/**
 * The pure, derived state of the persistent #review-bar. Three modes:
 *   - "hidden":  no pending reviews at all → the bar is not shown.
 *   - "viewing": the open plan IS a pending review's plan file → Submit/Dismiss are shown (acting
 *                on that review); Resume is hidden.
 *   - "summary": pending reviews exist but the user is browsing a non-reviewed plan (or nothing) →
 *                only a count label + Resume are shown; Submit/Dismiss are hidden (the pending
 *                review stays resumable but does not trap navigation).
 */
export interface ReviewBarState {
  barVisible: boolean;
  mode: "viewing" | "summary" | "hidden";
  label: string;
  submitVisible: boolean;
  submitDisabled: boolean;
  dismissVisible: boolean;
  resumeVisible: boolean;
  // The manual "Clear comments" affordance — shown in VIEWING mode whenever the open plan has >=1
  // comment, so a reviewer always has a discoverable way to wipe their comments mid-review (the
  // overlay's #feedback-clear was not reachable during review). Hidden in summary/hidden modes and
  // when there are 0 comments (nothing to clear).
  clearVisible: boolean;
}

/**
 * PURE: derive the #review-bar's state from (a) how many pending reviews exist, (b) whether the
 * open plan is one of them (viewing), and (c) the open plan's comment count.
 *
 * Rules (see the task spec):
 *   - pendingCount === 0 → everything hidden (no blocking hook to act on).
 *   - viewing === true   → "viewing" mode: Submit (disabled at 0 comments) + Dismiss; Resume hidden.
 *   - viewing === false && pendingCount > 0 → "summary" mode: count label + Resume; Submit/Dismiss
 *     hidden (the pending review stays resumable but does not trap navigation).
 */
export function applyReviewBarState(input: {
  pendingCount: number;
  viewing: boolean;
  viewedCommentCount: number;
}): ReviewBarState {
  if (input.pendingCount === 0) {
    return {
      barVisible: false,
      mode: "hidden",
      label: "",
      submitVisible: false,
      submitDisabled: true,
      dismissVisible: false,
      resumeVisible: false,
      clearVisible: false,
    };
  }
  if (input.viewing) {
    const n = input.viewedCommentCount;
    return {
      barVisible: true,
      mode: "viewing",
      label: `Reviewing plan — ${n} comment${n === 1 ? "" : "s"}`,
      submitVisible: true,
      submitDisabled: n === 0,
      dismissVisible: true,
      resumeVisible: false,
      // Manual clear is offered only when there is something to clear.
      clearVisible: n > 0,
    };
  }
  return {
    barVisible: true,
    mode: "summary",
    label: `${input.pendingCount} plan${input.pendingCount === 1 ? "" : "s"} awaiting review`,
    submitVisible: false,
    submitDisabled: true,
    dismissVisible: false,
    resumeVisible: true,
    clearVisible: false,
  };
}
