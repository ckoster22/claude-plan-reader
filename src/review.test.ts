import { describe, it, expect } from "vitest";

// applyReviewBarState is PURE (no DOM / Tauri imports) — mirrors feedback.ts's discipline, so it is
// unit-testable in isolation with no mocks.
import { applyReviewBarState } from "./review";

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
    expect(s.resumeVisible).toBe(false);
  });

  it("pendingCount === 0 even with viewing flags set → still fully hidden (pendingCount wins)", () => {
    // viewing:true must NOT leak a visible bar when nothing is actually pending.
    const s = applyReviewBarState({ pendingCount: 0, viewing: true, viewedCommentCount: 3 });
    expect(s.barVisible).toBe(false);
    expect(s.mode).toBe("hidden");
  });

  it("viewing a review with 0 comments → 'viewing' mode, Submit visible+DISABLED, Resume hidden", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 0 });
    expect(s.barVisible).toBe(true);
    expect(s.mode).toBe("viewing");
    expect(s.label).toBe("Reviewing plan — 0 comments");
    expect(s.submitVisible).toBe(true);
    expect(s.submitDisabled).toBe(true); // 0 comments → nothing to deny-with
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

  it("not viewing but reviews pending → 'summary' mode: count label + Resume only (no Submit)", () => {
    const s = applyReviewBarState({ pendingCount: 2, viewing: false, viewedCommentCount: 0 });
    expect(s.barVisible).toBe(true);
    expect(s.mode).toBe("summary");
    expect(s.label).toBe("2 plans awaiting review");
    expect(s.submitVisible).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Plan 03 — source-aware affordances (#review-approve + submitLabel).
//   FALSIFIABILITY: each assertion pins a NEW field on a source boundary. If approve were tied to
//   submitDisabled it would vanish at 0 comments (test 1 catches it). If the default source were not
//   "external" the existing snapshot would drift (test 2 catches it, byte-for-byte). If approve leaked
//   into hidden/summary the last test catches it.
// ─────────────────────────────────────────────────────────────────────────────
describe("applyReviewBarState — Sub-Plan 03 source-aware approve + submit label", () => {
  it("in-process + viewing + 0 comments → approve VISIBLE, label 'Request changes', Submit DISABLED", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 0, source: "in-process" });
    // Approve is shown even at 0 comments — it is NOT gated on submitDisabled (the falsification target:
    // tying approveVisible to !submitDisabled would make this false).
    expect(s.approveVisible).toBe(true);
    expect(s.submitLabel).toBe("Request changes");
    expect(s.submitDisabled).toBe(true); // 0 comments → Request-changes (deny) still needs >=1 comment
    expect(s.submitVisible).toBe(true);
    expect(s.mode).toBe("viewing");
  });

  it("in-process + viewing + 1 comment → approve still VISIBLE, Submit ENABLED, label still 'Request changes'", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 1, source: "in-process" });
    expect(s.approveVisible).toBe(true);
    expect(s.submitDisabled).toBe(false);
    expect(s.submitLabel).toBe("Request changes");
    expect(s.clearVisible).toBe(true); // >=1 comment → manual clear offered (same as external)
  });

  it("external (explicit) viewing → approve HIDDEN, label 'Submit' (unchanged external behavior)", () => {
    const s = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 2, source: "external" });
    expect(s.approveVisible).toBe(false);
    expect(s.submitLabel).toBe("Submit");
  });

  it("OMITTED source viewing === explicit external, AND every PRE-03 field is byte-identical to the legacy snapshot", () => {
    const omitted = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 2 });
    const external = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 2, source: "external" });
    expect(omitted).toEqual(external);
    // Byte-identical to the PRE-Sub-Plan-03 viewing snapshot (the new fields are additive; existing
    // fields must not drift when source is omitted). Any default drift fails here.
    expect(omitted).toEqual({
      barVisible: true,
      mode: "viewing",
      label: "Reviewing plan — 2 comments",
      submitVisible: true,
      submitDisabled: false,
      resumeVisible: false,
      clearVisible: true,
      // Sub-Plan 03 additive fields (external defaults).
      approveVisible: false,
      submitLabel: "Submit",
    });
  });

  it("hidden mode → approve hidden + label 'Submit' regardless of source", () => {
    const s = applyReviewBarState({ pendingCount: 0, viewing: true, viewedCommentCount: 3, source: "in-process" });
    expect(s.mode).toBe("hidden");
    expect(s.approveVisible).toBe(false);
    expect(s.submitLabel).toBe("Submit");
  });

  it("summary mode (in-process source, not viewing) → approve hidden (approve is a VIEWING-only affordance)", () => {
    const s = applyReviewBarState({ pendingCount: 2, viewing: false, viewedCommentCount: 0, source: "in-process" });
    expect(s.mode).toBe("summary");
    expect(s.approveVisible).toBe(false);
    expect(s.submitLabel).toBe("Submit");
  });
});
