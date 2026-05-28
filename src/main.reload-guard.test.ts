import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Locks the central correctness invariant of the ToC feature: the ToC rebuild
// (rebuildTocFromPane → extractToc + buildToc) must run ONLY AFTER the FINAL
// `if (!renderGuard.isCurrent(gen)) return;` check in reloadOpenPlan. A render superseded by a
// newer plan-changed reload (the guard going stale DURING settle()) must NOT rebuild #toc-list,
// or a stale render would clobber the newer plan's ToC.
//
// This test uses the REAL extractToc + REAL buildToc (the global () => [] mock in main.test.ts
// would make hoisting the rebuild above the guard ship green). renderInto is mocked to write its
// markdown arg into #reading-pane so extractToc sees real <h1>/<h2> headings; settle is mocked to
// a CONTROLLABLE deferred so we can interleave two reloads and resolve them out of order.
// ---------------------------------------------------------------------------------------------

// Controllable deferred for settle() — created per reload so we can resolve A and B in any order.
type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Shared mutable test state lives in vi.hoisted so the hoisted vi.mock factories below can close
// over it (a plain top-level const would be initialized AFTER the hoisted mocks and throw).
const H = vi.hoisted(() => {
  const settleQueue: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  return {
    // settle() returns the NEXT queued deferred; reloads dequeue in call order (A first, then B).
    settleQueue,
    // read_plan_contents resolutions, keyed by call order. Each read resolves immediately here
    // (the race we model is supersession DURING settle, not during read).
    readResults: [] as string[],
    readCall: 0,
    settleMock: (): Promise<void> => {
      const d = settleQueue.shift();
      return d ? d.promise : Promise.resolve();
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "read_plan_contents") {
      return Promise.resolve(H.readResults[H.readCall++] ?? "");
    }
    // set_open_plan / mark_viewed / list_plans etc. — resolve benignly.
    if (cmd === "list_plans") return Promise.resolve([]);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// REAL extractToc; renderInto writes markdown→pane innerHTML; settle is the controllable deferred.
vi.mock("./render", async () => {
  const actual = await vi.importActual<typeof import("./render/toc")>("./render/toc");
  return {
    renderInto: vi.fn((paneEl: HTMLElement, markdown: string) => {
      // Minimal markdown→HTML: turn "# X" into <h1>, "## X" into <h2>, carrying a source line so
      // extractToc records a real anchor. Enough for a faithful ToC extraction in this test.
      const lines = markdown.split("\n");
      const html = lines
        .map((ln, i) => {
          if (ln.startsWith("## ")) return `<h2 data-source-line="${i}">${ln.slice(3)}</h2>`;
          if (ln.startsWith("# ")) return `<h1 data-source-line="${i}">${ln.slice(2)}</h1>`;
          return "";
        })
        .join("");
      paneEl.innerHTML = html;
      paneEl.classList.remove("raw");
    }),
    settle: vi.fn(() => H.settleMock()),
    extractToc: actual.extractToc,
    // Comment facade exports — no-ops here (this test exercises the ToC rebuild guard, not
    // the comment re-apply). loadCommentsFor resolves immediately so the openPlan/reload flows
    // complete; applyComments is a no-op.
    applyComments: vi.fn(),
    initComments: vi.fn(),
    onCommentCountChanged: vi.fn(),
    loadCommentsFor: vi.fn(async () => []),
    clearAllComments: vi.fn(),
  };
});
vi.mock("./render/scroll", () => ({
  captureAnchor: vi.fn(() => null),
  applyDelta: vi.fn(),
  scrollToHeading: vi.fn(),
}));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn() }));

import { openPlan, reloadOpenPlan } from "./main";
import { asAbsPath, asStem } from "./types";

function bootDom(): void {
  document.body.innerHTML = `
    <div class="tab-row">
      <span class="tab" data-tab="plans">Plans</span>
      <span class="tab active" data-tab="contents">Contents</span>
    </div>
    <div class="tab-pane" id="tab-plans">
      <span id="plan-count"></span>
      <div class="plan-list" id="plan-list"></div>
    </div>
    <div class="tab-pane active" id="tab-contents">
      <div class="toc-list" id="toc-list"></div>
    </div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
  `;
  // jsdom has no Element.scrollTo; openPlan calls readerScrollEl.scrollTo({top:0}). Stub it so
  // openPlan takes its SUCCESS path (not the read-failure catch that clears the ToC).
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

function tocTexts(): string[] {
  return Array.from(document.querySelectorAll("#toc-list .toc-item")).map((e) => e.textContent ?? "");
}

beforeEach(() => {
  H.settleQueue.length = 0;
  H.readResults = [];
  H.readCall = 0;
});

describe("reloadOpenPlan — ToC rebuild is gated by the FINAL render-generation guard", () => {
  it("a reload superseded DURING settle() does NOT rebuild #toc-list (newer reload's ToC survives)", async () => {
    bootDom();

    // Open a plan so openPath is set (its own read resolves immediately; its settle is the first
    // queued deferred — resolve it so openPlan completes before we model the reload race).
    H.readResults = ["# Open\n", "# Alpha\n## A-sec\n", "# Beta\n## B-sec\n"];
    const openSettle = deferred();
    H.settleQueue.push(openSettle);
    const opening = openPlan(asAbsPath("/p/plan.md"), asStem("plan"));
    openSettle.resolve();
    await opening;

    // Baseline: ToC reflects the opened plan.
    expect(tocTexts()).toEqual(["Open"]);

    // Reload A: read resolves to "# Alpha / ## A-sec", then settle A is pending (gen for A).
    const settleA = deferred();
    H.settleQueue.push(settleA);
    const reloadA = reloadOpenPlan();
    // Let A's read + renderInto + first applyDelta run; A is now awaiting settle A.
    await Promise.resolve();
    await Promise.resolve();

    // INVARIANT (placement): the ToC rebuild runs ONLY AFTER the FINAL isCurrent check — never
    // right after renderInto. A's renderInto has run (pane now holds Alpha) but A has NOT yet
    // passed its final guard, so the ToC must STILL reflect the opened plan, not Alpha. If the
    // rebuild were hoisted to immediately after renderInto, this would already read ["Alpha",…].
    expect(tocTexts()).toEqual(["Open"]);

    // Reload B begins BEFORE A's settle resolves — this bumps the render generation, superseding A.
    const settleB = deferred();
    H.settleQueue.push(settleB);
    const reloadB = reloadOpenPlan();
    await Promise.resolve();
    await Promise.resolve();

    // Resolve B first: B is current, so B rebuilds the ToC to its headings.
    settleB.resolve();
    await reloadB;
    expect(tocTexts()).toEqual(["Beta", "B-sec"]);

    // Plant a SENTINEL in the pane after B has committed. If the superseded reload A rebuilds the
    // ToC (i.e. its rebuild is NOT gated by the final isCurrent check), it will extract THIS pane
    // content and the ToC becomes ["Sentinel"]. If A correctly bails at the final guard, the ToC
    // stays B's ["Beta", "B-sec"]. This makes the test sensitive to whether A's rebuild EXECUTES,
    // independent of pane-content ordering (the rebuild placement is what's under test).
    const pane = document.querySelector<HTMLElement>("#reading-pane")!;
    pane.innerHTML = `<h1 data-source-line="0">Sentinel</h1>`;

    // Now resolve the STALE A. The final isCurrent(genA) check must be false, so A must NOT rebuild.
    settleA.resolve();
    await reloadA;

    // INVARIANT: the superseded reload A did not rebuild the ToC — B's ToC survives, and the
    // sentinel (which only a stale, ungated rebuild would surface) never appears.
    expect(tocTexts()).toEqual(["Beta", "B-sec"]);
    expect(tocTexts()).not.toContain("Sentinel");
  });
});
