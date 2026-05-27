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
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn() }));

import { applyFeedbackButtonState } from "./main";

type R = { quote: string; comment: string };

describe("buildFeedbackPrompt — format + numbering", () => {
  it("emits the lead line then one numbered `N. Re: \"<quote>\"` + indented comment per record", () => {
    const recs: R[] = [
      { quote: "scan the projects tree", comment: "cache this per session" },
      { quote: "auto-reloads in place", comment: "preserve my scroll position" },
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
    const out = buildFeedbackPrompt([{ quote: longQuote, comment: "note" }]);
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
      { quote: "first snippet", comment: "" }, // empty comment
      { quote: "second snippet", comment: "a real note" },
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
