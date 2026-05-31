import { describe, it, expect } from "vitest";

// applyReviewBarState / applyReviewButtonState are PURE (no DOM / Tauri imports) — mirrors
// feedback.ts's discipline, so they are unit-testable in isolation with no mocks.
import { applyReviewBarState, applyReviewButtonState } from "./review";

// ─────────────────────────────────────────────────────────────────────────────
// FALSIFIABILITY (read before trusting these tests):
//   `applyReviewBarState` has THREE mutually-exclusive modes. The assertions below pin EVERY
//   field on EACH mode boundary, so a regression that collapses two modes, drops a visibility
//   flag, or removes the `viewedCommentCount === 0` Submit-disable gate makes a specific test go
//   RED. Demonstrated red→green in the task report: forcing `submitDisabled` to a constant fails
//   the zero-comment case; forcing `mode` to "viewing" always fails the summary case.
// ─────────────────────────────────────────────────────────────────────────────

describe("applyReviewBarState — derived #review-bar state (three modes)", () => {
  it("pendingCount === 0 → everything hidden (no blocking hook to act on)", () => {
    const s = applyReviewBarState({ pendingCount: 0, viewing: false, viewedCommentCount: 0 });
    expect(s.barVisible).toBe(false);
    expect(s.mode).toBe("hidden");
    expect(s.submitVisible).toBe(false);
    expect(s.dismissVisible).toBe(false);
    expect(s.resumeVisible).toBe(false);
  });

  it("pendingCount === 0 even with viewing flags set → still fully hidden (pendingCount wins)", () => {
    // viewing:true must NOT leak a visible bar when nothing is actually pending.
    const s = applyReviewBarState({ pendingCount: 0, viewing: true, viewedCommentCount: 3 });
    expect(s.barVisible).toBe(false);
    expect(s.mode).toBe("hidden");
  });

  it("viewing a review with 0 comments → 'viewing' mode, Submit visible+DISABLED, Dismiss visible, Resume hidden", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 0 });
    expect(s.barVisible).toBe(true);
    expect(s.mode).toBe("viewing");
    expect(s.label).toBe("Reviewing plan — 0 comments");
    expect(s.submitVisible).toBe(true);
    expect(s.submitDisabled).toBe(true); // 0 comments → nothing to deny-with
    expect(s.dismissVisible).toBe(true);
    expect(s.resumeVisible).toBe(false);
    // Manual Clear is HIDDEN at 0 comments (nothing to clear). Forcing clearVisible:true here fails.
    expect(s.clearVisible).toBe(false);
  });

  it("viewing a review with 1 comment → Submit ENABLED, singular label, Clear VISIBLE", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 1 });
    expect(s.mode).toBe("viewing");
    expect(s.label).toBe("Reviewing plan — 1 comment");
    expect(s.submitVisible).toBe(true);
    expect(s.submitDisabled).toBe(false);
    // With >=1 comment in viewing mode the manual Clear affordance is shown (the user's complaint).
    expect(s.clearVisible).toBe(true);
  });

  it("viewing a review with 3 comments → Submit ENABLED, plural label", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 3 });
    expect(s.label).toBe("Reviewing plan — 3 comments");
    expect(s.submitDisabled).toBe(false);
  });

  it("not viewing but reviews pending → 'summary' mode: count label + Resume only (no Submit/Dismiss)", () => {
    const s = applyReviewBarState({ pendingCount: 2, viewing: false, viewedCommentCount: 0 });
    expect(s.barVisible).toBe(true);
    expect(s.mode).toBe("summary");
    expect(s.label).toBe("2 plans awaiting review");
    expect(s.submitVisible).toBe(false);
    expect(s.dismissVisible).toBe(false);
    expect(s.resumeVisible).toBe(true);
    // Manual Clear belongs to viewing mode only — hidden in summary even if a count is passed.
    expect(s.clearVisible).toBe(false);
  });

  it("summary mode with exactly 1 pending → singular label", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: false, viewedCommentCount: 0 });
    expect(s.mode).toBe("summary");
    expect(s.label).toBe("1 plan awaiting review");
    expect(s.resumeVisible).toBe(true);
  });

  it("flipping ONLY `viewing` (count held) flips mode AND the Submit/Resume visibility (single-field detection)", () => {
    // Hold pendingCount + viewedCommentCount constant; toggle viewing. The mode and the
    // Submit-vs-Resume affordance must invert — a no-op derivation is caught here.
    const summary = applyReviewBarState({ pendingCount: 1, viewing: false, viewedCommentCount: 0 });
    const viewing = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 0 });
    expect(summary.mode).toBe("summary");
    expect(viewing.mode).toBe("viewing");
    expect(summary.submitVisible).toBe(false);
    expect(viewing.submitVisible).toBe(true);
    expect(summary.resumeVisible).toBe(true);
    expect(viewing.resumeVisible).toBe(false);
    expect(summary).not.toEqual(viewing);
  });
});

describe("applyReviewButtonState — overlay #feedback-copy is always plain clipboard copy", () => {
  it("returns the clipboard-copy state (Approve/Submit moved off the overlay)", () => {
    const s = applyReviewButtonState();
    expect(s.copyMode).toBe("copy");
    expect(s.copyLabel).toBe("Copy to clipboard");
  });
});
