import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Sub-Plan 03 — the latest-wins count-request guard in refreshCommentCount.
//
// refreshCommentCount is fired un-awaited from open/reload/onCommentCountChanged; concurrent or
// bursty calls can resolve OUT OF ORDER. The module-level `countReqSeq` makes each call bail after
// its await if a newer call has begun, so only the most-recent request commits to commentCount /
// the button. We exercise BOTH reorder cases by controlling WHEN each get_comment_count resolves:
//   (a) cross-plan A→B: a SLOW count for A resolving AFTER B is open must NOT overwrite B's count.
//   (b) same-plan A→A bursty reload: the EARLIER request resolving last must NOT win — the newer
//       count must stand.
// Falsify by dropping the `seq !== countReqSeq` bail → both go red (the stale value lands).
// ---------------------------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Shared mutable state for the hoisted mock factory: a queue of deferreds for get_comment_count so
// the test controls each call's resolution order independently of call order.
const H = vi.hoisted(() => {
  return {
    countQueue: [] as Array<Deferred<number>>,
    // Per-path comment fixtures for get_comments (so the overlay body differs by plan). The value
    // is whatever buildFeedbackPrompt will quote; tests seed this keyed by absolute_path.
    commentsByPath: {} as Record<string, Array<{ quote: string; comment: string; block_line: null; block_end_line: null; occurrence: number; id: number }>>,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: { path?: string }) => {
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n");
    if (cmd === "list_plans") return Promise.resolve([]);
    if (cmd === "get_comments") {
      const path = args?.path ?? "";
      return Promise.resolve(H.commentsByPath[path] ?? []);
    }
    if (cmd === "get_comment_count") {
      // Hand back a fresh deferred so the test resolves counts in an arbitrary order.
      const d = deferred<number>();
      H.countQueue.push(d);
      return d.promise;
    }
    // set_open_plan / mark_viewed / resolve_cwds / etc. — resolve benignly.
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// renderInto writes markdown→pane; settle + loadCommentsFor resolve immediately; the rest no-op.
vi.mock("./render", () => ({
  renderInto: vi.fn((paneEl: HTMLElement, markdown: string) => {
    paneEl.innerHTML = `<p data-source-line="0">${markdown}</p>`;
    paneEl.classList.remove("raw");
  }),
  settle: vi.fn(() => Promise.resolve()),
  extractToc: vi.fn(() => []),
  applyComments: vi.fn(),
  initComments: vi.fn(),
  onCommentCountChanged: vi.fn(),
  loadCommentsFor: vi.fn(async () => []),
  clearAllComments: vi.fn(),
}));
vi.mock("./render/scroll", () => ({
  captureAnchor: vi.fn(() => null),
  applyDelta: vi.fn(),
  scrollToHeading: vi.fn(),
}));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { openPlan, refreshCommentCount, currentCommentCount } from "./main";
import { asAbsPath, asStem } from "./types";

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
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
    </div>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  H.countQueue.length = 0;
  H.commentsByPath = {};
});

describe("refreshCommentCount — latest-wins guard (Sub-Plan 03)", () => {
  it("(a) cross-plan A→B: A's slow get_comment_count resolving AFTER B is open does NOT overwrite B's count", async () => {
    bootDom();
    // Drain any count requests the open-during-boot path enqueued so our two are deterministic.
    H.countQueue.length = 0;

    // Open A; its refreshCommentCount enqueues count request #0 (A's). Don't resolve it yet.
    const openA = openPlan(asAbsPath("/p/A.md"), asStem("A"));
    await flush();
    await openA;
    // A's count request is parked.
    expect(H.countQueue.length).toBe(1);

    // Open B (newer) WHILE A's count is still in flight; B enqueues count request #1.
    const openB = openPlan(asAbsPath("/p/B.md"), asStem("B"));
    await flush();
    await openB;
    expect(H.countQueue.length).toBe(2);

    // Resolve B FIRST (B is current): B's count of 5 commits.
    H.countQueue[1].resolve(5);
    await flush();
    expect(currentCommentCount()).toBe(5);

    // Now resolve the STALE A with a different count. Its seq is older than B's, so the bail fires
    // and A's count must NOT overwrite B's.
    H.countQueue[0].resolve(99);
    await flush();
    expect(currentCommentCount()).toBe(5); // still B's count, NOT A's 99
  });

  it("(b) same-plan A→A bursty reload: the EARLIER request resolving LAST does not win; the newer count stands", async () => {
    bootDom();
    H.countQueue.length = 0;

    // Open A so openPath is A; drain its boot count request.
    await openPlan(asAbsPath("/p/A.md"), asStem("A"));
    await flush();
    H.countQueue.length = 0;

    // Fire two refreshes for the SAME plan back-to-back (models a bursty reload re-querying count).
    void refreshCommentCount(); // request #0 (earlier)
    void refreshCommentCount(); // request #1 (newer)
    await flush();
    expect(H.countQueue.length).toBe(2);

    // Resolve the NEWER one first with 7 — it is current, so 7 commits.
    H.countQueue[1].resolve(7);
    await flush();
    expect(currentCommentCount()).toBe(7);

    // Now resolve the EARLIER request LAST with a stale 1 — the seq bail must drop it.
    H.countQueue[0].resolve(1);
    await flush();
    expect(currentCommentCount()).toBe(7); // newer count stands, earlier stale value dropped
  });

});
