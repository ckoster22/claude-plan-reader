import { describe, it, expect, vi, beforeEach } from "vitest";

// buildFeedbackPrompt is a pure module (imports only the CommentRecord type) — no DOM/Tauri.
import { buildFeedbackPrompt } from "./feedback";

// applyFeedbackButtonState is exported from main.ts, which pulls in the Tauri APIs + render facade
// at load. Mock them so importing the module is a no-op (it only registers a DOMContentLoaded
// listener, which never fires under vitest). applyFeedbackButtonState takes its elements as params,
// so it sidesteps the module-global handles entirely.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./render", () => ({
  renderInto: vi.fn(),
  settle: vi.fn(),
  extractToc: vi.fn(() => []),
  applyComments: vi.fn(),
  initComments: vi.fn(),
  onCommentCountChanged: vi.fn(),
  loadCommentsFor: vi.fn(async () => []),
  clearAllComments: vi.fn(),
}));
vi.mock("./render/scroll", () => ({ captureAnchor: vi.fn(), applyDelta: vi.fn(), scrollToHeading: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { applyFeedbackButtonState } from "./main";

type R = { quote: string; comment: string; block_line: number | null; block_end_line: number | null };

describe("buildFeedbackPrompt — format + numbering", () => {
  it("emits the lead line then one numbered `N. Re: \"<quote>\"` + indented comment per record", () => {
    const recs: R[] = [
      { quote: "scan the projects tree", comment: "cache this per session", block_line: null, block_end_line: null },
      { quote: "auto-reloads in place", comment: "preserve my scroll position", block_line: null, block_end_line: null },
    ];
    const out = buildFeedbackPrompt(recs);

    // Lead line first.
    expect(out.startsWith("Please revise the plan based on this feedback:")).toBe(true);
    // Both entries are numbered 1./2. in order, each quoting its snippet.
    expect(out).toContain('1. Re: "scan the projects tree"');
    expect(out).toContain('2. Re: "auto-reloads in place"');
    // The comment text follows each quote on the next (indented) line.
    expect(out).toContain('1. Re: "scan the projects tree"\n   cache this per session');
    expect(out).toContain('2. Re: "auto-reloads in place"\n   preserve my scroll position');
    // Numbering is 1-based and contiguous: there is a "1." and a "2." but no "3.".
    expect(out).toMatch(/^1\. Re:/m);
    expect(out).toMatch(/^2\. Re:/m);
    expect(out).not.toMatch(/^3\. Re:/m);
  });

  it("clamps a very long quote to ~90 chars + ellipsis", () => {
    const longQuote = "x".repeat(200);
    const out = buildFeedbackPrompt([{ quote: longQuote, comment: "note", block_line: null, block_end_line: null }]);
    // The full 200-char quote must NOT appear; a 90-char prefix + ellipsis must.
    expect(out).not.toContain(longQuote);
    expect(out).toContain("x".repeat(90) + "…");
    // The clamped run is exactly 90 'x' then the ellipsis — a 91st 'x' before the ellipsis is wrong.
    expect(out).not.toContain("x".repeat(91) + "…");
  });

  it("an empty-comment record STILL emits a quote-only entry (NOT skipped) — entry count == record count", () => {
    // 02's save flow does not reject an empty comment, so a record with comment:"" exists on disk
    // AND counts toward the badge. It must produce an entry (quote-only) so the entry count matches.
    const recs: R[] = [
      { quote: "first snippet", comment: "", block_line: null, block_end_line: null }, // empty comment
      { quote: "second snippet", comment: "a real note", block_line: null, block_end_line: null },
    ];
    const out = buildFeedbackPrompt(recs);

    // BOTH records produce a numbered entry — the empty one is the quote-only `1. Re: "..."` line.
    expect(out).toContain('1. Re: "first snippet"');
    expect(out).toContain('2. Re: "second snippet"');
    // The empty-comment entry has NO comment line: count the `N. Re:` markers and assert == 2.
    const entryCount = (out.match(/^\d+\. Re:/gm) ?? []).length;
    expect(entryCount).toBe(recs.length);
    expect(entryCount).toBe(2);
    // The empty record contributes no comment text immediately after its quote (next thing is the
    // blank-line separator then entry 2), so "first snippet" is not followed by an indented line.
    expect(out).not.toMatch(/1\. Re: "first snippet"\n {3}\S/);
  });

  it("empty input yields the lead line alone (no entries)", () => {
    const out = buildFeedbackPrompt([]);
    expect(out).toBe("Please revise the plan based on this feedback:");
    expect(out.match(/^\d+\. Re:/gm)).toBeNull();
  });

  // HAND-COUNTED line math. markdown-it token.map = [start, end) is 0-based, end-exclusive.
  // 1-based inclusive range: start = block_line + 1, end = block_end_line.
  //   - multi-line: block_line=41, block_end_line=45 → start=42, end=45 → "(lines 42-45)".
  //   - single-line: block_line=2, block_end_line=3 → start=3, end=3 (end<=start) → "(line 3)".
  //   - block_line=null → no suffix.
  it("test_buildFeedbackPrompt_line_range — appends (lines N-M) / (line N) / nothing per the source range", () => {
    const recs: R[] = [
      { quote: "multi block", comment: "a", block_line: 41, block_end_line: 45 },
      { quote: "single block", comment: "b", block_line: 2, block_end_line: 3 },
      { quote: "whole pane", comment: "c", block_line: null, block_end_line: null },
    ];
    const out = buildFeedbackPrompt(recs);

    expect(out).toContain('1. Re: "multi block" (lines 42-45)');
    expect(out).toContain('2. Re: "single block" (line 3)');
    // whole-pane: NO suffix — the quote line ends right at the closing quote.
    expect(out).toMatch(/^3\. Re: "whole pane"$/m);
    expect(out).not.toContain('"whole pane" (');
  });

  // FALSIFICATION (b): bumping an input line by +1 MUST change the asserted range — catches an
  // off-by-one in the start = block_line + 1 conversion.
  it("test_buildFeedbackPrompt_line_range falsifies via input perturbation (+1 shifts the range)", () => {
    const base = buildFeedbackPrompt([{ quote: "q", comment: "c", block_line: 41, block_end_line: 45 }]);
    expect(base).toContain("(lines 42-45)");
    const bumped = buildFeedbackPrompt([{ quote: "q", comment: "c", block_line: 42, block_end_line: 45 }]);
    expect(bumped).toContain("(lines 43-45)");
    expect(bumped).not.toContain("(lines 42-45)");
  });
});

describe("buildFeedbackPrompt IS the review deny-reason (contract lock)", () => {
  // CONTRACT: main.ts's Submit handler sends `buildFeedbackPrompt(reviewComments)` VERBATIM as the
  // `reason` of the deny response written to the hook. That reason is fed to Claude Code as the
  // plan-rejection feedback. The handler itself is DOM + Tauri bound and not unit-testable here, so
  // we lock down the exact output shape for representative multi-comment input: a regression in
  // buildFeedbackPrompt (renumbering, dropping the lead line, mangling quotes/line-suffixes, or
  // changing the indent) would silently CORRUPT the reason Claude receives. This test is the
  // tripwire for that.
  //
  // FALSIFIABLE: the assertion below is the FULL exact string (toBe, not toContain). Any single
  // character drift in buildFeedbackPrompt's format — a missing blank-line separator, a changed
  // indent width, a renumber, a dropped line-suffix — flips this test red. Inverting any branch of
  // buildFeedbackPrompt (e.g. skipping empty-comment records, or off-by-one in the line range)
  // produces a different exact string and fails here.
  it("deny reason == buildFeedbackPrompt(records) — exact string for representative comments", () => {
    const records: R[] = [
      { quote: "scan the projects tree", comment: "cache this per session", block_line: 41, block_end_line: 45 },
      { quote: "auto-reloads in place", comment: "preserve my scroll position", block_line: 2, block_end_line: 3 },
      { quote: "render mermaid", comment: "", block_line: null, block_end_line: null }, // empty comment, whole-pane
    ];

    // This is the literal string the hook will receive as `reason`. main.ts passes
    // buildFeedbackPrompt(reviewComments) here unchanged — so locking this output locks the reason.
    const denyReason = buildFeedbackPrompt(records);

    const expected =
      'Please revise the plan based on this feedback:\n\n' +
      '1. Re: "scan the projects tree" (lines 42-45)\n   cache this per session\n\n' +
      '2. Re: "auto-reloads in place" (line 3)\n   preserve my scroll position\n\n' +
      '3. Re: "render mermaid"';

    expect(denyReason).toBe(expected);
  });
});

describe("applyFeedbackButtonState — visibility + badge gating", () => {
  let btn: HTMLElement;
  let badge: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    btn = document.createElement("button");
    btn.id = "feedback-btn";
    btn.classList.add("hidden"); // starts hidden (boot state)
    badge = document.createElement("span");
    badge.id = "feedback-count";
    btn.appendChild(badge);
    document.body.appendChild(btn);
  });

  it("count 0 → button is .hidden (no comments → no button)", () => {
    applyFeedbackButtonState(btn, badge, 0);
    expect(btn.classList.contains("hidden")).toBe(true);
  });

  it("count >= 1 → button shown (no .hidden) with the badge text == N", () => {
    applyFeedbackButtonState(btn, badge, 3);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toBe("3");

    // A different positive count updates the badge and keeps the button shown.
    applyFeedbackButtonState(btn, badge, 1);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toBe("1");
  });

  it("re-hides when the count drops back to 0 (clear-all path)", () => {
    applyFeedbackButtonState(btn, badge, 2);
    expect(btn.classList.contains("hidden")).toBe(false);
    applyFeedbackButtonState(btn, badge, 0);
    expect(btn.classList.contains("hidden")).toBe(true);
  });
});
