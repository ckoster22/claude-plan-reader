import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Regression: the Prompt Feedback button must appear IMMEDIATELY when the first comment is added
// to the OPEN plan — with NO plan navigation in between.
//
// INVARIANT: button visible iff the open plan has >= 1 comment, and that holds the instant a
// comment is added/cleared (no openPlan() call required to surface it).
//
// This test deliberately exercises the REAL render facade (`./render` is NOT mocked) so the real
// save→fireCountChanged→onCommentCountChanged→refreshCommentCount→button path runs end to end.
// The Tauri backend is modeled with a SHARED in-memory store: `get_comment_count` reads exactly
// what `set_comments` has written. This faithfully reproduces production timing — `set_comments`
// resolves on a later microtask than the synchronous fireCountChanged inside addComment, so a
// cold `get_comment_count` re-read fired BEFORE the write lands sees the stale 0.
//
// Falsify: the bug (cold re-read racing the not-yet-issued write) keeps the button hidden after
// the first add. The fix surfaces it immediately. Inverting the fix turns this test red.
// ---------------------------------------------------------------------------------------------

type Rec = { quote: string; comment: string; block_line: number | null; occurrence: number; id: number };
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The backend's comment store, keyed by path. get_comment_count reads its length; set_comments /
// clear_comments mutate it (full-array replacement) and return the post-mutation array.
//
// `parkCountFor` / `parkClearFor` let a test PARK a specific command's resolution (by path) so it
// can control the interleaving precisely — the command pushes a deferred onto the matching queue
// instead of resolving inline. The store mutation for a parked clear still happens at PARK time
// (the backend would have committed it) so a later get reflects it; only the promise is deferred.
const H = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  parkCountFor: null as string | null,
  parkClearFor: null as string | null,
  parkedCount: [] as Array<Deferred<number>>,
  parkedClear: [] as Array<Deferred<Rec[]>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: { path?: string; comments?: Rec[] }) => {
    const path = args?.path ?? "";
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nselect this phrase here\n");
    if (cmd === "list_plans") return Promise.resolve([]);
    if (cmd === "get_comments") return Promise.resolve(H.store[path] ?? []);
    if (cmd === "get_comment_count") {
      const n = (H.store[path] ?? []).length;
      if (H.parkCountFor === path) {
        const d = deferred<number>();
        // Capture the count AT DISPATCH time (the value the backend would return now); the test
        // resolves the deferred later with this captured value to model a slow round-trip.
        d.promise.then(() => {});
        H.parkedCount.push(d);
        return d.promise.then(() => n);
      }
      return Promise.resolve(n);
    }
    if (cmd === "set_comments") {
      const next = args?.comments ?? [];
      if (next.length === 0) delete H.store[path];
      else H.store[path] = next;
      return Promise.resolve(next);
    }
    if (cmd === "clear_comments") {
      // The backend commits the clear immediately (store mutated), but the RESPONSE may be parked.
      delete H.store[path];
      if (H.parkClearFor === path) {
        const d = deferred<Rec[]>();
        H.parkedClear.push(d);
        return d.promise;
      }
      return Promise.resolve([]);
    }
    // set_open_plan / mark_viewed / resolve_cwds / set_tree_collapsed — resolve benignly.
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn() }));
// NOTE: ./render is intentionally NOT mocked — we need the real comments save→fire path.

import { openPlan } from "./main";
import { clearAllComments } from "./render";
import { asAbsPath, asStem } from "./types";

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button class="feedback-btn hidden" id="feedback-btn"><span id="feedback-count">0</span></button>
      <button id="theme-toggle"></button>
    </div></div>
    <div class="tab-row"><span class="tab" data-tab="plans">Plans</span></div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span><div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
    <div class="sel-popover hidden" id="sel-popover">
      <div id="sp-quote"></div><textarea id="sp-text"></textarea>
      <button id="sp-cancel"></button><button id="sp-save"></button>
    </div>
    <div class="feedback-overlay hidden" id="feedback-overlay">
      <pre id="feedback-body"></pre>
      <button id="feedback-copy"></button><button id="feedback-clear"></button>
    </div>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Select the occurrence-th match of `needle` inside `block` as the live window selection.
function selectText(block: Element, needle: string, occurrence: number): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let tn = walker.nextNode() as Text | null;
  while (tn) {
    let from = 0;
    while (true) {
      const idx = tn.data.indexOf(needle, from);
      if (idx < 0) break;
      if (seen === occurrence) {
        const range = document.createRange();
        range.setStart(tn, idx);
        range.setEnd(tn, idx + needle.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      seen++;
      from = idx + needle.length;
    }
    tn = walker.nextNode() as Text | null;
  }
}

beforeEach(() => {
  H.store = {};
  H.parkCountFor = null;
  H.parkClearFor = null;
  H.parkedCount = [];
  H.parkedClear = [];
});

// Add a comment to the CURRENTLY-OPEN plan via the real popover save flow.
function addCommentViaPopover(comment: string): void {
  const pane = document.querySelector<HTMLElement>("#reading-pane")!;
  const block = pane.querySelector("p[data-source-line]") ?? pane;
  selectText(block, "select this phrase", 0);
  pane.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  (document.querySelector("#sp-text") as HTMLTextAreaElement).value = comment;
  document.querySelector<HTMLElement>("#sp-save")!.click();
}

describe("Prompt Feedback button appears immediately on the first in-session comment add (no navigation)", () => {
  it("adding the first comment to the OPEN plan shows the button with count 1 — without re-opening the plan", async () => {
    bootDom();
    await flush();

    // Open the plan (it has zero comments). The button starts hidden.
    await openPlan(asAbsPath("/p/A.md"), asStem("A"));
    await flush();

    const btn = document.querySelector<HTMLElement>("#feedback-btn")!;
    const badge = document.querySelector<HTMLElement>("#feedback-count")!;
    expect(btn.classList.contains("hidden")).toBe(true); // no comments yet → hidden

    // Add a comment via the REAL popover save flow (selection → mouseup → type → save).
    const pane = document.querySelector<HTMLElement>("#reading-pane")!;
    // The phrase lives in the <p> (the <h1> is the first [data-source-line]); select within it.
    const block = pane.querySelector('p[data-source-line]') ?? pane;
    selectText(block, "select this phrase", 0);
    pane.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    (document.querySelector("#sp-text") as HTMLTextAreaElement).value = "please revise this";
    document.querySelector<HTMLElement>("#sp-save")!.click();

    // Let the save + count-refresh microtasks settle. CRUCIALLY: there is NO openPlan/navigation
    // call here — the button MUST become visible from the in-session add alone.
    await flush();

    // INVARIANT: the button is now visible with badge "1".
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toBe("1");
    // Sanity: the backend actually recorded one comment for this plan.
    expect((H.store["/p/A.md"] ?? []).length).toBe(1);
  });

  it("clearing the last comment hides the button immediately (no navigation)", async () => {
    bootDom();
    await flush();

    await openPlan(asAbsPath("/p/A.md"), asStem("A"));
    await flush();

    const btn = document.querySelector<HTMLElement>("#feedback-btn")!;
    const pane = document.querySelector<HTMLElement>("#reading-pane")!;
    // The phrase lives in the <p> (the <h1> is the first [data-source-line]); select within it.
    const block = pane.querySelector('p[data-source-line]') ?? pane;

    // Add one comment so the button is showing.
    selectText(block, "select this phrase", 0);
    pane.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    (document.querySelector("#sp-text") as HTMLTextAreaElement).value = "note";
    document.querySelector<HTMLElement>("#sp-save")!.click();
    await flush();
    expect(btn.classList.contains("hidden")).toBe(false);

    // Click the highlight → view mode, then save acts as "clear this comment".
    const hl = pane.querySelector<HTMLElement>(".cmt-hl")!;
    hl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector<HTMLElement>("#sp-save")!.click();
    await flush();

    // INVARIANT: button hidden again immediately after the last comment is cleared (no navigation).
    expect(btn.classList.contains("hidden")).toBe(true);
    expect(H.store["/p/A.md"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Cross-plan regression (devil's-advocate finding): a stray foreign-plan count callback must NOT
// strand the OPEN plan's legitimate count refresh.
//
// Reachable interleaving:
//   1. User clears all comments on plan A (A's clear_comments IPC is still in flight).
//   2. User switches to plan B (which HAS comments) → openPlan(B) dispatches get_comment_count(B)
//      and parks on its await.
//   3. A's clear_comments resolves → fireCountChanged(0) for plan A.
//   4. get_comment_count(B) resolves.
// With the (buggy) plan-UNAWARE applyCommentCount, step 3 bumps countReqSeq and hides the button,
// then step 4's B-refresh BAILS (its seq is now stale) → plan B is open WITH comments but the
// button is wrongly hidden. The plan-aware guard ignores A's callback while B is open.
// ---------------------------------------------------------------------------------------------
describe("cross-plan: a foreign plan's count callback never strands the open plan's refresh", () => {
  it("clearing plan A while switching to plan B (with comments) leaves B's button VISIBLE with B's count", async () => {
    bootDom();
    await flush();

    // Plan B already has one comment on disk.
    H.store["/p/B.md"] = [
      { quote: "beta", comment: "b-note", block_line: null, occurrence: 0, id: 0 },
    ];

    // Open A and give it a comment (so clearAll on A has something to clear and fires the count cb).
    await openPlan(asAbsPath("/p/A.md"), asStem("A"));
    await flush();
    addCommentViaPopover("a-note");
    await flush();

    const btn = document.querySelector<HTMLElement>("#feedback-btn")!;
    const badge = document.querySelector<HTMLElement>("#feedback-count")!;
    expect((H.store["/p/A.md"] ?? []).length).toBe(1);

    // (1) Begin clearing ALL of A's comments, but PARK A's clear_comments response in flight.
    H.parkClearFor = "/p/A.md";
    const pane = document.querySelector<HTMLElement>("#reading-pane")!;
    const clearA = clearAllComments(pane, "/p/A.md");
    await flush();
    expect(H.parkedClear.length).toBe(1); // A's clear is genuinely parked (response not delivered)

    // (2) Switch to B WHILE A's clear is still in flight. Park B's get_comment_count so it resolves
    // AFTER A's clear callback (the exact interleaving the reviewer hit).
    H.parkCountFor = "/p/B.md";
    await openPlan(asAbsPath("/p/B.md"), asStem("B"));
    await flush();
    expect(H.parkedCount.length).toBe(1); // B's count read is parked, awaiting resolution

    // (3) A's clear_comments now resolves → fireCountChanged(0) for plan A (a FOREIGN plan; B is open).
    H.parkedClear[0].resolve([]);
    await clearA;
    await flush();

    // (4) B's get_comment_count resolves last, returning B's real count (1).
    H.parkedCount[0].resolve(0);
    await flush();

    // INVARIANT: B is open with 1 comment, so its button is VISIBLE with badge "1". A's stray
    // clear-callback must neither hide the button nor strand B's refresh.
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toBe("1");
  });

  it("a foreign-plan in-session add/clear callback while B is open does NOT alter B's button", async () => {
    bootDom();
    await flush();

    // B has two comments; A has one.
    H.store["/p/B.md"] = [
      { quote: "beta1", comment: "b1", block_line: null, occurrence: 0, id: 0 },
      { quote: "beta2", comment: "b2", block_line: null, occurrence: 0, id: 1 },
    ];

    // Open A, add a comment so A's pane cache holds a record (so a foreign clearAll(A) fires a cb).
    await openPlan(asAbsPath("/p/A.md"), asStem("A"));
    await flush();
    addCommentViaPopover("a-note");
    await flush();

    // Switch to B and let B's count settle → button shows "2".
    await openPlan(asAbsPath("/p/B.md"), asStem("B"));
    await flush();
    const btn = document.querySelector<HTMLElement>("#feedback-btn")!;
    const badge = document.querySelector<HTMLElement>("#feedback-count")!;
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toBe("2");

    // Now a FOREIGN-plan mutation fires for A (e.g. a late clear-all) while B is the open plan.
    const pane = document.querySelector<HTMLElement>("#reading-pane")!;
    await clearAllComments(pane, "/p/A.md");
    await flush();

    // INVARIANT: B's button is untouched — still visible, still "2" (the foreign A callback no-ops).
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toBe("2");
  });
});
