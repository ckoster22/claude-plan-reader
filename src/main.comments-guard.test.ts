import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Verification item 8 — the main.ts render-generation guard around applyComments.
//
// Locks the MANDATORY post-`await` re-check after `loadCommentsFor` in openPlan/reloadOpenPlan:
//
//     const recs = await loadCommentsFor(readingPaneEl, path);
//     if (!renderGuard.isCurrent(gen)) return;   // <-- under test
//     applyComments(readingPaneEl, recs);
//
// We supersede the render generation DURING the loadCommentsFor await (resolve a STALE render's
// load after a newer render has begun) and assert applyComments did NOT run for the stale render.
// This is the pattern from main.reload-guard.test.ts (controllable deferreds, real-ish render
// mocks). Falsify by removing the second isCurrent gate → the stale applyComments fires → red.
// ---------------------------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Shared mutable state for the hoisted mock factories.
const H = vi.hoisted(() => {
  return {
    // settle() resolves immediately (the race we model is the loadCommentsFor await, not settle).
    // loadCommentsFor returns a queued deferred so we can interleave two renders.
    loadQueue: [] as Array<{ promise: Promise<unknown>; resolve: (v: unknown) => void }>,
    readResults: [] as string[],
    readCall: 0,
    // Record which (gen-distinguishing) record-arrays applyComments was called with.
    appliedWith: [] as unknown[],
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "read_plan_contents") return Promise.resolve(H.readResults[H.readCall++] ?? "");
    if (cmd === "list_plans") return Promise.resolve([]);
    if (cmd === "get_comment_count") return Promise.resolve(0);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// renderInto writes markdown→pane; settle resolves immediately; loadCommentsFor returns a queued
// deferred (so we control WHEN each render's load resolves); applyComments records its calls.
vi.mock("./render", () => ({
  renderInto: vi.fn((paneEl: HTMLElement, markdown: string) => {
    paneEl.innerHTML = `<p data-source-line="0">${markdown}</p>`;
    paneEl.classList.remove("raw");
  }),
  settle: vi.fn(() => Promise.resolve()),
  extractToc: vi.fn(() => []),
  applyComments: vi.fn((_paneEl: HTMLElement, recs: unknown) => {
    H.appliedWith.push(recs);
  }),
  initComments: vi.fn(),
  onCommentCountChanged: vi.fn(),
  loadCommentsFor: vi.fn(() => {
    const d = deferred<unknown>();
    H.loadQueue.push(d);
    return d.promise;
  }),
  clearAllComments: vi.fn(),
}));
vi.mock("./render/scroll", () => ({
  captureAnchor: vi.fn(() => null),
  applyDelta: vi.fn(),
  scrollToHeading: vi.fn(),
}));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn() }));

import { openPlan } from "./main";
import { applyComments } from "./render";
import { asAbsPath, asStem } from "./types";

function bootDom(): void {
  document.body.innerHTML = `
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

beforeEach(() => {
  H.loadQueue.length = 0;
  H.readResults = [];
  H.readCall = 0;
  H.appliedWith.length = 0;
  (applyComments as ReturnType<typeof vi.fn>).mockClear();
});

describe("openPlan — applyComments is gated by the post-loadCommentsFor isCurrent re-check (Verification 8)", () => {
  it("a render superseded DURING the loadCommentsFor await does NOT applyComments", async () => {
    bootDom();
    H.readResults = ["Plan A", "Plan B"];

    // Open A: its read + renderInto + settle run, then A awaits loadCommentsFor (queued [0]).
    const openA = openPlan(asAbsPath("/p/A.md"), asStem("A"));
    // Let A progress to the loadCommentsFor await.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(H.loadQueue.length).toBe(1); // A is parked on its load.

    // Open B BEFORE A's load resolves — this bumps the render generation, superseding A.
    const openB = openPlan(asAbsPath("/p/B.md"), asStem("B"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(H.loadQueue.length).toBe(2); // B is now parked on its own load.

    // Resolve B first (B is current): B passes the re-check and applyComments runs for B.
    H.loadQueue[1].resolve([{ quote: "b", block_line: null, occurrence: 0, comment: "", id: 0 }]);
    await openB;
    const appliedCountAfterB = (applyComments as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(appliedCountAfterB).toBe(1); // exactly one applyComments (B's).

    // Now resolve the STALE A. Its post-await isCurrent(genA) check is false → applyComments
    // must NOT run again.
    H.loadQueue[0].resolve([{ quote: "a", block_line: null, occurrence: 0, comment: "", id: 9 }]);
    await openA;

    // INVARIANT: the superseded render A did NOT applyComments. Total calls stay at 1 (B only).
    expect((applyComments as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // And the one applied array is B's, never A's (id 9 / quote "a").
    const appliedArr = H.appliedWith[0] as Array<{ id: number }>;
    expect(appliedArr[0].id).toBe(0); // B's record, not A's (id 9)
  });
});
