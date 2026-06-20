import { describe, it, expect, vi, beforeEach } from "vitest";

// renderSidebar lives in main.ts, which pulls in the Tauri APIs and the render facade at load.
// Mock them so importing the module is a no-op (it only registers a DOMContentLoaded listener,
// which never fires under vitest). renderSidebar takes its container + ctx as params, so it
// sidesteps the module-global planListEl/openPath entirely. We exercise the REAL renderSidebar.
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
vi.mock("./render/scroll", () => ({
  captureAnchor: vi.fn(),
  applyDelta: vi.fn(),
  scrollToHeading: vi.fn(),
}));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import {
  renderSidebar,
  buildToc,
  initTabs,
  suppressConversationFlip,
  placeholderVisible,
  shouldClearPlaceholderOnExit,
  __setRunPlaceholderForTest,
} from "./main";
import { scrollToHeading } from "./render/scroll";
import { invoke } from "@tauri-apps/api/core";
import type { TocEntry } from "./render";
import { asAbsPath, asStem, type PlanRecord, type SidebarCtx } from "./types";

// Build records via a defaults helper. The fixture takes raw strings for `absolute_path`/
// `filename_stem` and brands them, so call sites stay terse; the branded slots make a bare
// string a compile error (the whole point of this fixture's typing).
type Rec = PlanRecord;

function rec(
  over: Partial<Omit<PlanRecord, "absolute_path" | "filename_stem">> & {
    absolute_path: string;
    filename_stem: string;
    flavor: PlanRecord["flavor"];
  },
): Rec {
  const { absolute_path, filename_stem, ...rest } = over;
  return {
    mtime_ms: 1_700_000_000_000,
    cwd: null,
    unread: false,
    tree_id: null,
    nn: null,
    nn_path: null,
    child_count: null,
    collapsed: false,
    h1s: [],
    ...rest,
    absolute_path: asAbsPath(absolute_path),
    filename_stem: asStem(filename_stem),
  };
}

type Ctx = SidebarCtx;

function makeCtx(over: Partial<Omit<SidebarCtx, "openPath">> & { openPath?: string | null } = {}): Ctx {
  const { openPath, ...rest } = over;
  return {
    collapseOverride: new Map(),
    subCollapse: new Map(),
    onOpen: vi.fn(),
    onToggleCollapse: vi.fn(),
    ...rest,
    openPath: openPath == null ? null : asAbsPath(openPath),
  };
}

// renderSidebar's params are the real exported PlanRecord[]/SidebarCtx; no cast needed.
function render(listEl: HTMLElement, records: Rec[], ctx: Ctx): void {
  renderSidebar(listEl, records, ctx);
}

let listEl: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  listEl = document.createElement("div");
  listEl.id = "plan-list";
  document.body.appendChild(listEl);
});

// A canonical 2-child master tree + interleaved standalone, in PRE-ORDERED display shape.
function masterTree(): Rec[] {
  return [
    rec({ absolute_path: "/p/standalone-x.md", filename_stem: "standalone-x", flavor: "standalone" }),
    rec({
      absolute_path: "/p/master-a.md",
      filename_stem: "master-a",
      flavor: "master",
      tree_id: "tree-a",
      child_count: 2,
    }),
    rec({ absolute_path: "/p/a-sub01.md", filename_stem: "a-sub01", flavor: "sub", tree_id: "tree-a", nn: 1, nn_path: "01" }),
    rec({ absolute_path: "/p/a-sub02.md", filename_stem: "a-sub02", flavor: "sub", tree_id: "tree-a", nn: 2, nn_path: "02" }),
  ];
}

describe("renderSidebar — flavor rendering", () => {
  it("renders standalone as a flat .plan, master(>=1) as .master > .master-row + .children, subs inside .children", () => {
    render(listEl, masterTree(), makeCtx());

    const standalone = listEl.querySelector('.plan[data-path="/p/standalone-x.md"]')!;
    expect(standalone).toBeTruthy();
    expect(standalone.classList.contains("master")).toBe(false);
    expect(standalone.classList.contains("sub")).toBe(false);

    const master = listEl.querySelector(".master")!;
    expect(master).toBeTruthy();
    const masterRow = master.querySelector(".master-row")!;
    expect(masterRow).toBeTruthy();
    expect(masterRow.classList.contains("plan")).toBe(true);
    const children = master.querySelector(".children")!;
    expect(children).toBeTruthy();

    const subs = children.querySelectorAll(".plan.sub");
    expect(subs.length).toBe(2);
  });
});

describe("renderSidebar — nesting & nn order", () => {
  it("places both subs inside their master's .children, in nn order, with .seq '01'/'02'; top-level order matches input", () => {
    render(listEl, masterTree(), makeCtx());

    const children = listEl.querySelector(".master .children")!;
    const subs = children.querySelectorAll<HTMLElement>(".plan.sub");
    expect(subs.length).toBe(2);
    expect(subs[0].querySelector(".seq")!.textContent).toBe("01");
    expect(subs[1].querySelector(".seq")!.textContent).toBe("02");
    expect(subs[0].dataset.path).toBe("/p/a-sub01.md");
    expect(subs[1].dataset.path).toBe("/p/a-sub02.md");

    // Top-level order: standalone first, then the master wrapper (input order preserved).
    const topLevel = Array.from(listEl.children) as HTMLElement[];
    expect(topLevel[0].dataset.path).toBe("/p/standalone-x.md");
    expect(topLevel[1].classList.contains("master")).toBe(true);
  });
});

describe("renderSidebar — master affordances", () => {
  it("child-count reads '2 sub-plans' for 2 and '1 sub-plan' (singular) for 1", () => {
    render(listEl, masterTree(), makeCtx());
    expect(listEl.querySelector(".master .child-count")!.textContent).toBe("2 sub-plans");

    const single: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 1 }),
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01" }),
    ];
    render(listEl, single, makeCtx());
    expect(listEl.querySelector(".master .child-count")!.textContent).toBe("1 sub-plan");
  });

  it("a collapsed:true master gets the .collapsed class", () => {
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 1, collapsed: true }),
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01" }),
    ];
    render(listEl, recs, makeCtx());
    expect(listEl.querySelector(".master")!.classList.contains("collapsed")).toBe(true);
  });
});

describe("renderSidebar — 0-child master ⇒ flat row", () => {
  it("renders a child_count:0 master as a flat .plan with NO twirl/child-count/children", () => {
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m0.md", filename_stem: "m0", flavor: "master", tree_id: "t0", child_count: 0 }),
    ];
    render(listEl, recs, makeCtx());

    expect(listEl.querySelector(".master")).toBeNull();
    expect(listEl.querySelector(".children")).toBeNull();
    expect(listEl.querySelector(".twirl")).toBeNull();
    expect(listEl.querySelector(".child-count")).toBeNull();

    const row = listEl.querySelector('.plan[data-path="/p/m0.md"]')!;
    expect(row).toBeTruthy();
    expect(row.classList.contains("master")).toBe(false);
  });
});

describe("renderSidebar — .active state follows ctx.openPath", () => {
  it("lands .active on the row whose path equals ctx.openPath", () => {
    render(listEl, masterTree(), makeCtx({ openPath: "/p/a-sub01.md" }));
    const active = listEl.querySelector(".active")!;
    expect((active as HTMLElement).dataset.path).toBe("/p/a-sub01.md");
  });

  it("MOVES .active when re-rendered with a different ctx.openPath (guards live-openPath threading)", () => {
    render(listEl, masterTree(), makeCtx({ openPath: "/p/standalone-x.md" }));
    expect((listEl.querySelector(".active") as HTMLElement).dataset.path).toBe("/p/standalone-x.md");

    // Re-render the SAME records with a different openPath — the active marker must move.
    render(listEl, masterTree(), makeCtx({ openPath: "/p/a-sub02.md" }));
    const actives = listEl.querySelectorAll(".active");
    expect(actives.length).toBe(1);
    expect((actives[0] as HTMLElement).dataset.path).toBe("/p/a-sub02.md");
  });
});

describe("renderSidebar — unread dot", () => {
  it("shows .unread + a VISIBLE .unread-dot on an unread MASTER row (dot is the master unread cue)", () => {
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 1, unread: true }),
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01" }),
    ];
    render(listEl, recs, makeCtx());

    const masterRow = listEl.querySelector<HTMLElement>(".master-row")!;
    expect(masterRow.classList.contains("unread")).toBe(true);
    // The dot element must exist on the master row so .plan.unread .unread-dot can paint it.
    const dot = masterRow.querySelector(".unread-dot");
    expect(dot).toBeTruthy();
  });

  it("shows .unread + an .unread-dot on an unread SUB row", () => {
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 1 }),
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01", unread: true }),
    ];
    render(listEl, recs, makeCtx());
    const sub = listEl.querySelector<HTMLElement>(".plan.sub")!;
    expect(sub.classList.contains("unread")).toBe(true);
    expect(sub.querySelector(".unread-dot")).toBeTruthy();
  });
});

describe("renderSidebar — collapseOverride wins over stale record", () => {
  it("renders .collapsed when override says true even if the record's collapsed:false (stale/unpersisted)", () => {
    const override = new Map<string, boolean>([["tree-a", true]]);
    const recs = masterTree(); // master-a has collapsed:false
    render(listEl, recs, makeCtx({ collapseOverride: override }));
    expect(listEl.querySelector(".master")!.classList.contains("collapsed")).toBe(true);
  });
});

describe("renderSidebar — collapse vs open click wiring", () => {
  it("clicking the twirl calls onToggleCollapse(treeId, true) and does NOT call onOpen", () => {
    const onOpen = vi.fn();
    const onToggleCollapse = vi.fn();
    render(listEl, masterTree(), makeCtx({ onOpen, onToggleCollapse }));

    const twirl = listEl.querySelector<HTMLElement>(".master .twirl")!;
    twirl.click();

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).toHaveBeenCalledWith("tree-a", true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clicking the master .plan-title (or .child-count) calls onOpen and NOT onToggleCollapse", () => {
    const onOpen = vi.fn();
    const onToggleCollapse = vi.fn();
    render(listEl, masterTree(), makeCtx({ onOpen, onToggleCollapse }));

    const title = listEl.querySelector<HTMLElement>(".master-row .plan-title")!;
    title.click();
    expect(onOpen).toHaveBeenCalledWith("/p/master-a.md", "master-a");
    expect(onToggleCollapse).not.toHaveBeenCalled();

    onOpen.mockClear();
    const count = listEl.querySelector<HTMLElement>(".master .child-count")!;
    count.click();
    expect(onOpen).toHaveBeenCalledWith("/p/master-a.md", "master-a");
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});

// ---- Tabbed left panel + table of contents -----------------------------------------------

// Mount the full sidebar DOM and fire DOMContentLoaded so main.ts's load block runs and binds
// the module-level handles (readerScrollEl/readingPaneEl/tocListEl + tab wiring). buildToc's
// click handler scrolls via those module globals, so they must be bound for the click test.
function bootSidebarDom(): void {
  // DOMContentLoaded triggers refreshList → invoke("list_plans"); return an empty list so the
  // load block runs cleanly and binds the module handles we exercise below.
  vi.mocked(invoke).mockResolvedValue([] as unknown as never);
  document.body.innerHTML = `
    <div class="tab-row">
      <span class="tab active" data-tab="plans">Plans</span>
      <span class="tab" data-tab="contents">Contents</span>
    </div>
    <div class="tab-pane active" id="tab-plans">
      <span id="plan-count"></span>
      <div class="plan-list" id="plan-list"></div>
    </div>
    <div class="tab-pane" id="tab-contents">
      <div class="toc-list" id="toc-list"></div>
    </div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
  `;
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

const entry = (level: 1 | 2, text: string, line: number): TocEntry => ({ level, text, line });

describe("buildToc — entry rendering", () => {
  it("renders one .toc-item.toc-h1|.toc-h2 per entry, carrying the right data-line and text/order", () => {
    const listEl = document.createElement("div");
    buildToc(listEl, [entry(1, "Title", 0), entry(2, "Section A", 4), entry(2, "Section B", 9)]);

    const items = Array.from(listEl.querySelectorAll<HTMLElement>(".toc-item"));
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.className)).toEqual([
      "toc-item toc-h1",
      "toc-item toc-h2",
      "toc-item toc-h2",
    ]);
    expect(items.map((i) => i.dataset.line)).toEqual(["0", "4", "9"]);
    expect(items.map((i) => i.textContent)).toEqual(["Title", "Section A", "Section B"]);
  });

  it("renders .toc-empty (and ZERO .toc-item) for an empty entry list (open plan, no headings)", () => {
    const listEl = document.createElement("div");
    buildToc(listEl, []);
    expect(listEl.querySelectorAll(".toc-item")).toHaveLength(0);
    const empty = listEl.querySelector(".toc-empty");
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toBe("No headings");
  });
});

describe("buildToc — click scrolls to the entry's line", () => {
  it("clicking a .toc-item invokes scrollToHeading with that entry's line", () => {
    bootSidebarDom();
    vi.mocked(scrollToHeading).mockClear();

    const listEl = document.querySelector<HTMLElement>("#toc-list")!;
    buildToc(listEl, [entry(1, "Title", 0), entry(2, "Section B", 9)]);

    const second = listEl.querySelectorAll<HTMLElement>(".toc-item")[1];
    second.click();

    expect(scrollToHeading).toHaveBeenCalledTimes(1);
    // Third arg is the clicked entry's source line.
    expect(vi.mocked(scrollToHeading).mock.calls[0][2]).toBe(9);
  });
});

describe("initTabs — tab toggling", () => {
  it("clicking [data-tab=contents] moves .active onto it + #tab-contents, off [data-tab=plans]/#tab-plans", () => {
    document.body.innerHTML = `
      <div class="tab-row">
        <span class="tab active" data-tab="plans">Plans</span>
        <span class="tab" data-tab="contents">Contents</span>
      </div>
      <div class="tab-pane active" id="tab-plans"></div>
      <div class="tab-pane" id="tab-contents"></div>
    `;
    const tabRow = document.querySelector<HTMLElement>(".tab-row")!;
    const plansPane = document.querySelector<HTMLElement>("#tab-plans")!;
    const contentsPane = document.querySelector<HTMLElement>("#tab-contents")!;
    initTabs(tabRow, [plansPane, contentsPane]);

    const plansTab = document.querySelector<HTMLElement>('[data-tab="plans"]')!;
    const contentsTab = document.querySelector<HTMLElement>('[data-tab="contents"]')!;

    contentsTab.click();

    expect(contentsTab.classList.contains("active")).toBe(true);
    expect(contentsPane.classList.contains("active")).toBe(true);
    expect(plansTab.classList.contains("active")).toBe(false);
    expect(plansPane.classList.contains("active")).toBe(false);
  });
});

describe("buildToc — does NOT change the active tab (tab-state preservation)", () => {
  it("rebuilding the ToC with Contents active leaves .tab.active / .tab-pane.active unchanged", () => {
    document.body.innerHTML = `
      <div class="tab-row">
        <span class="tab" data-tab="plans">Plans</span>
        <span class="tab active" data-tab="contents">Contents</span>
      </div>
      <div class="tab-pane" id="tab-plans"></div>
      <div class="tab-pane active" id="tab-contents">
        <div class="toc-list" id="toc-list"></div>
      </div>
    `;
    const listEl = document.querySelector<HTMLElement>("#toc-list")!;

    // Rebuild path: a fresh ToC render must not touch any .active class.
    buildToc(listEl, [entry(1, "Title", 0), entry(2, "Section", 3)]);

    const activeTab = document.querySelector(".tab.active") as HTMLElement;
    const activePane = document.querySelector(".tab-pane.active") as HTMLElement;
    expect(activeTab.dataset.tab).toBe("contents");
    expect(activePane.id).toBe("tab-contents");
    // Exactly one of each remains active (nothing got toggled on/off).
    expect(document.querySelectorAll(".tab.active")).toHaveLength(1);
    expect(document.querySelectorAll(".tab-pane.active")).toHaveLength(1);
  });
});

// ---- Sidebar filter (Fix 1) — wired through the real DOMContentLoaded setup ---------------

// Boot the full sidebar DOM INCLUDING the filter control + count, with `list_plans` returning
// `records`. Fires DOMContentLoaded so main.ts binds the module handles + filter listeners and
// runs the initial refreshList. Returns once the initial async refresh microtasks have flushed.
async function bootWithRecords(records: Rec[]): Promise<void> {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "list_plans") return Promise.resolve(records as unknown as never);
    if (cmd === "resolve_cwds") return Promise.resolve({} as unknown as never);
    return Promise.resolve(undefined as unknown as never);
  });
  document.body.innerHTML = `
    <div class="tab-row">
      <span class="tab active" data-tab="plans">Plans</span>
      <span class="tab" data-tab="contents">Contents</span>
    </div>
    <div class="tab-pane active" id="tab-plans">
      <span id="plan-count"></span>
      <div class="search">
        <span class="ico">🔍</span>
        <input id="plan-filter" type="text" placeholder="Filter plans…" />
        <button class="clear" type="button">✕</button>
      </div>
      <div class="plan-list" id="plan-list"></div>
    </div>
    <div class="tab-pane" id="tab-contents">
      <div class="toc-list" id="toc-list"></div>
    </div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
  `;
  window.dispatchEvent(new Event("DOMContentLoaded"));
  // Flush the chain of awaited microtasks inside refreshList (list_plans → render → resolveCwds).
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function typeFilter(value: string): void {
  const input = document.querySelector<HTMLInputElement>("#plan-filter")!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("filter wiring — Plans tab only, never the ToC", () => {
  it("does NOT touch #toc-list nor call buildToc when filtering", async () => {
    const recs = masterTree();
    await bootWithRecords(recs);

    const toc = document.querySelector<HTMLElement>("#toc-list")!;
    // Seed #toc-list with sentinel content; filtering must leave it untouched.
    toc.innerHTML = `<div class="toc-sentinel">KEEP</div>`;

    typeFilter("standalone-x");

    // The Plans list narrowed…
    const planRows = document.querySelectorAll("#plan-list [data-path]");
    expect(planRows.length).toBe(1);
    // …but #toc-list is byte-for-byte unchanged (no buildToc, no clearing).
    expect(toc.innerHTML).toBe(`<div class="toc-sentinel">KEEP</div>`);
    expect(toc.querySelector(".toc-sentinel")).toBeTruthy();
  });

  it("updates #plan-count to the 'N of M' form while filtering", async () => {
    await bootWithRecords(masterTree()); // 4 files total (1 master + 2 subs + 1 standalone)
    typeFilter("standalone-x"); // matches only the standalone
    expect(document.querySelector("#plan-count")!.textContent).toBe("1 of 4");
  });
});

describe("filter wiring — empty-state + clear", () => {
  it("shows the .filter-empty affordance when nothing matches", async () => {
    await bootWithRecords(masterTree());
    typeFilter("zzz-no-such-plan-zzz");

    const empty = document.querySelector("#plan-list .filter-empty");
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toBe("No matching plans");
    // No plan rows rendered alongside the empty state.
    expect(document.querySelectorAll("#plan-list [data-path]").length).toBe(0);
  });

  it("the clear (✕) button resets the filter and restores the full list", async () => {
    await bootWithRecords(masterTree());
    typeFilter("standalone-x");
    expect(document.querySelectorAll("#plan-list [data-path]").length).toBe(1);

    const clear = document.querySelector<HTMLElement>(".search .clear")!;
    clear.click();

    // Input cleared and the full list restored (all 4 files).
    expect(document.querySelector<HTMLInputElement>("#plan-filter")!.value).toBe("");
    expect(document.querySelectorAll("#plan-list [data-path]").length).toBe(4);
    expect(document.querySelector("#plan-list .filter-empty")).toBeNull();
  });

  it("highlights the matched substring in the visible .plan-title with a single <mark>", async () => {
    await bootWithRecords(masterTree());
    typeFilter("standalone");

    const row = document.querySelector<HTMLElement>('#plan-list [data-path="/p/standalone-x.md"]')!;
    const title = row.querySelector<HTMLElement>(".plan-title")!;
    const marks = title.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("standalone");
  });
});

// ---- FIX B Test 2: a late-arriving cwd re-runs the filter (match + highlight) -------------
//
// A plan's cwd resolves AFTER the initial list render (the backend cache misses; resolve_cwds
// returns it on a follow-up round-trip). patchAllCwds() syncs the resolved DISPLAY cwd onto the
// in-memory record AND re-runs applyFilterAndRender(), so a filter query that only matches the
// cwd must (a) make the row APPEAR once the cwd lands, and (b) HIGHLIGHT the matched substring
// in the row's .plan-src. This drives the REAL resolve_cwds → patchAllCwds path (no direct call
// to the unexported patchAllCwds): we mock resolve_cwds to return the late cwd for the stem.
//
// Falsifiability (verified): making patchAllCwds NOT re-run applyFilterAndRender (or not sync
// rec.cwd) leaves the row filtered OUT / un-highlighted → both assertions go RED. Restored →
// green.

// Boot like bootWithRecords but with resolve_cwds returning `resolved` (stem → cwd). Sets the
// initial filter query BEFORE the resolve patch lands so the late cwd is what flips the row in.
async function bootWithLateCwd(
  records: Rec[],
  resolved: Record<string, string | null>,
  query: string,
): Promise<void> {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "list_plans") return Promise.resolve(records as unknown as never);
    if (cmd === "resolve_cwds") return Promise.resolve(resolved as unknown as never);
    return Promise.resolve(undefined as unknown as never);
  });
  document.body.innerHTML = `
    <div class="tab-row">
      <span class="tab active" data-tab="plans">Plans</span>
      <span class="tab" data-tab="contents">Contents</span>
    </div>
    <div class="tab-pane active" id="tab-plans">
      <span id="plan-count"></span>
      <div class="search">
        <span class="ico">🔍</span>
        <input id="plan-filter" type="text" placeholder="Filter plans…" />
        <button class="clear" type="button">✕</button>
      </div>
      <div class="plan-list" id="plan-list"></div>
    </div>
    <div class="tab-pane" id="tab-contents">
      <div class="toc-list" id="toc-list"></div>
    </div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
  `;
  window.dispatchEvent(new Event("DOMContentLoaded"));
  // Set the filter query, then flush microtasks so the async resolve_cwds → patchAllCwds runs.
  typeFilter(query);
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("filter wiring — late-arriving cwd re-filters + highlights (FIX B / Test 2)", () => {
  it("a row that only matches via its LATE-resolved cwd appears AND highlights the match in .plan-src", async () => {
    // One standalone whose backend cwd is null (forces a resolve_cwds round-trip). The filter
    // query "acme" matches NOTHING in the title/headings — only the cwd that resolves later.
    const recs: Rec[] = [
      rec({ absolute_path: "/p/widget.md", filename_stem: "widget", flavor: "standalone", cwd: null }),
    ];
    // resolve_cwds returns the cwd keyed by stem. Under /home/u (mocked homeDir) it collapses to
    // "~/projects/acme-app", which contains "acme".
    await bootWithLateCwd(recs, { widget: "/home/u/projects/acme-app" }, "acme");

    // (a) The row now PASSES the filter (it was invisible before the cwd resolved).
    const row = document.querySelector<HTMLElement>('#plan-list [data-path="/p/widget.md"]');
    expect(row).not.toBeNull();

    // (b) The matched substring is highlighted in .plan-src via a <mark>.
    const src = row!.querySelector<HTMLElement>(".plan-src")!;
    expect(src.textContent).toContain("acme");
    const marks = src.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("acme");
  });
});

describe("renderSidebar — loud orphan guard", () => {
  it("renders a leading orphan sub FLAT and triggers console.error (contract-violation diagnostic)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recs: Rec[] = [
      rec({ absolute_path: "/p/orphan.md", filename_stem: "orphan", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01" }),
    ];
    render(listEl, recs, makeCtx());

    expect(spy).toHaveBeenCalled();
    // Appended flat at the top level (not inside any .children, none exists).
    const row = listEl.querySelector('[data-path="/p/orphan.md"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.parentElement).toBe(listEl);
    spy.mockRestore();
  });
});

// ---- Recursive nesting from nn_path prefixes (Phase 3) -------------------------------------
//
// `arrange_plans` returns each tree's subs PRE-ORDERED depth-first on the dotted id; visual
// depth is built HERE from nn_path prefixes. A sub whose nn_path extends a preceding sub's
// nn_path by exactly one segment nests inside that sub's `.children`; a sub with nested
// children becomes an INTERNAL node (`.sub-node` wrapper with twirl + child-count, like a
// master). Internal collapse is session-only (ctx.subCollapse) — the persisted master
// collapse store is never touched.

// A depth-2 tree: 01, 02, 02.01, 02.02, 03 (02 is internal with two children).
function depth2Tree(): Rec[] {
  return [
    rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 5 }),
    rec({ absolute_path: "/p/s01.md", filename_stem: "s01", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01" }),
    rec({ absolute_path: "/p/s02.md", filename_stem: "s02", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02" }),
    rec({ absolute_path: "/p/s0201.md", filename_stem: "s0201", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02.01" }),
    rec({ absolute_path: "/p/s0202.md", filename_stem: "s0202", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02.02" }),
    rec({ absolute_path: "/p/s03.md", filename_stem: "s03", flavor: "sub", tree_id: "t", nn: 3, nn_path: "03" }),
  ];
}

describe("renderSidebar — recursive nesting from nn_path prefixes", () => {
  it("nests 02.01/02.02 inside 02's .children; 01/02/03 stay at the master's depth-1 level", () => {
    render(listEl, depth2Tree(), makeCtx());

    const base = listEl.querySelector(".master > .children")!;
    // Depth-1 children of the master, in order: leaf 01, internal node 02, leaf 03.
    const depth1 = Array.from(base.children) as HTMLElement[];
    expect(depth1.length).toBe(3);
    expect((depth1[0] as HTMLElement).dataset.path).toBe("/p/s01.md");
    expect(depth1[1].classList.contains("sub-node")).toBe(true);
    expect(depth1[1].querySelector<HTMLElement>(".plan.sub")!.dataset.path).toBe("/p/s02.md");
    expect((depth1[2] as HTMLElement).dataset.path).toBe("/p/s03.md");

    // 02's nested .children holds exactly its two extensions, in order.
    const nested = depth1[1].querySelector(":scope > .children")!;
    const grandkids = Array.from(nested.children) as HTMLElement[];
    expect(grandkids.map((g) => g.dataset.path)).toEqual(["/p/s0201.md", "/p/s0202.md"]);
  });

  it("DA criterion: EVERY .seq shows the FULL dotted nn_path — a 02.01 child must NOT collide with '02'", () => {
    render(listEl, depth2Tree(), makeCtx());
    const seqs = Array.from(listEl.querySelectorAll(".plan.sub .seq")).map((s) => s.textContent);
    expect(seqs).toEqual(["01", "02", "02.01", "02.02", "03"]);
  });

  it("internal node 02 carries twirl + per-node DIRECT child count; leaves carry neither", () => {
    render(listEl, depth2Tree(), makeCtx());

    const internal = listEl.querySelector<HTMLElement>(".sub-node > .plan.sub")!;
    expect(internal.querySelector(".twirl")).toBeTruthy();
    // DIRECT children only (2), not the master's whole-tree count (5).
    expect(internal.querySelector(".child-count")!.textContent).toBe("2 sub-plans");

    const leaf = listEl.querySelector<HTMLElement>('.plan.sub[data-path="/p/s01.md"]')!;
    expect(leaf.querySelector(".twirl")).toBeNull();
    expect(leaf.querySelector(".child-count")).toBeNull();
  });

  it("internal-node collapse is SESSION-ONLY: twirl toggles .collapsed + ctx.subCollapse and never touches the persisted master store (onToggleCollapse)", () => {
    const onToggleCollapse = vi.fn();
    const onOpen = vi.fn();
    const subCollapse = new Map<string, boolean>();
    render(listEl, depth2Tree(), makeCtx({ onToggleCollapse, onOpen, subCollapse }));

    const node = listEl.querySelector<HTMLElement>(".sub-node")!;
    const twirl = node.querySelector<HTMLElement>(".twirl")!;
    expect(node.classList.contains("collapsed")).toBe(false);

    twirl.click();
    expect(node.classList.contains("collapsed")).toBe(true);
    // Session map recorded the intent; the persisted-store callback and onOpen stayed silent.
    expect(Array.from(subCollapse.values())).toEqual([true]);
    expect(onToggleCollapse).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    // A re-render with the SAME session map keeps the node collapsed (map is the source).
    render(listEl, depth2Tree(), makeCtx({ onToggleCollapse, onOpen, subCollapse }));
    expect(listEl.querySelector(".sub-node")!.classList.contains("collapsed")).toBe(true);

    twirl.click(); // stale node, but the FIRST render's handler still flips its own wrapper
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it("clicking an internal sub's title still opens it (twirl is the only collapse surface)", () => {
    const onOpen = vi.fn();
    render(listEl, depth2Tree(), makeCtx({ onOpen }));
    listEl.querySelector<HTMLElement>('.plan.sub[data-path="/p/s02.md"] .plan-title')!.click();
    expect(onOpen).toHaveBeenCalledWith("/p/s02.md", "s02");
  });
});

describe("renderSidebar — generalized loud orphan guard (dotted)", () => {
  it("renders a 02.01 with NO preceding 02 row FLAT under the master + console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 2 }),
      rec({ absolute_path: "/p/s01.md", filename_stem: "s01", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01" }),
      rec({ absolute_path: "/p/s0201.md", filename_stem: "s0201", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02.01" }),
    ];
    render(listEl, recs, makeCtx());

    expect(spy).toHaveBeenCalled();
    // Flat at the master's depth-1 level — full dotted .seq, no .sub-node wrapper anywhere.
    const base = listEl.querySelector(".master > .children")!;
    const orphan = listEl.querySelector<HTMLElement>('.plan.sub[data-path="/p/s0201.md"]')!;
    expect(orphan.parentElement).toBe(base);
    expect(orphan.querySelector(".seq")!.textContent).toBe("02.01");
    expect(listEl.querySelector(".sub-node")).toBeNull();
    spy.mockRestore();
  });
});

describe("renderSidebar — duplicate dotted ids are deterministic", () => {
  it("renders both '02' rows at depth 1 in input order; '02.01' nests under the LAST '02'", () => {
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 3 }),
      rec({ absolute_path: "/p/dup-a.md", filename_stem: "dup-a", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02" }),
      rec({ absolute_path: "/p/dup-b.md", filename_stem: "dup-b", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02" }),
      rec({ absolute_path: "/p/s0201.md", filename_stem: "s0201", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02.01" }),
    ];
    render(listEl, recs, makeCtx());

    const base = listEl.querySelector(".master > .children")!;
    const depth1 = Array.from(base.children) as HTMLElement[];
    expect(depth1.length).toBe(2);
    // First duplicate: a plain leaf row (its frame was popped when the second '02' arrived).
    expect(depth1[0].dataset.path).toBe("/p/dup-a.md");
    expect(depth1[0].classList.contains("sub-node")).toBe(false);
    // Last duplicate: the internal node that captures '02.01'.
    expect(depth1[1].classList.contains("sub-node")).toBe(true);
    expect(depth1[1].querySelector<HTMLElement>(".plan.sub")!.dataset.path).toBe("/p/dup-b.md");
    const nested = depth1[1].querySelector(":scope > .children")!;
    expect((nested.children[0] as HTMLElement).dataset.path).toBe("/p/s0201.md");
  });
});

describe("renderSidebar — legacy flat tree DOM is byte-identical (golden pin)", () => {
  it("a depth-1 master+2-subs tree renders EXACTLY the pre-Phase-3 markup (no new classes/wrappers)", () => {
    // mtime = now ⇒ relativeTime renders the locale-independent literal "just now".
    const now = Date.now();
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 2, mtime_ms: now }),
      rec({ absolute_path: "/p/s1.md", filename_stem: "s1", flavor: "sub", tree_id: "t", nn: 1, nn_path: "01", mtime_ms: now }),
      rec({ absolute_path: "/p/s2.md", filename_stem: "s2", flavor: "sub", tree_id: "t", nn: 2, nn_path: "02", mtime_ms: now }),
    ];
    render(listEl, recs, makeCtx());

    // Captured from the pre-Phase-3 renderer (same fixture, byte-for-byte).
    const GOLDEN =
      '<div class="master" data-tree-id="t">' +
      '<div class="plan master-row" data-path="/p/m.md">' +
      '<div class="plan-row"><span class="twirl">▾</span><span class="plan-title">m</span>' +
      '<span class="unread-dot"></span><span class="child-count">2 sub-plans</span></div>' +
      '<div class="plan-src"></div><div class="plan-meta"><span class="when">just now</span></div></div>' +
      '<div class="children">' +
      '<div class="plan sub" data-path="/p/s1.md"><div class="plan-row"><span class="seq">01</span>' +
      '<span class="plan-title">s1</span><span class="unread-dot"></span></div></div>' +
      '<div class="plan sub" data-path="/p/s2.md"><div class="plan-row"><span class="seq">02</span>' +
      '<span class="plan-title">s2</span><span class="unread-dot"></span></div></div>' +
      "</div></div>";
    expect(listEl.innerHTML).toBe(GOLDEN);
  });
});

// ---- Bug A fix: the `.plan.placeholder` live-run sidebar row ----------------------------------

describe("renderSidebar — live-run placeholder row", () => {
  const ph = { treeId: "tree-live", label: "New plan — drafting…", selected: true };

  it("prepends .plan.placeholder as the FIRST entry (with .active + data-tree-id) when no record matches its tree_id", () => {
    render(listEl, masterTree(), makeCtx({ placeholder: ph }));
    const first = listEl.firstElementChild as HTMLElement;
    expect(first.classList.contains("plan")).toBe(true);
    expect(first.classList.contains("placeholder")).toBe(true);
    expect(first.classList.contains("active")).toBe(true);
    expect(first.dataset.treeId).toBe("tree-live");
    expect(first.querySelector(".plan-title")!.textContent).toBe("New plan — drafting…");
    expect(first.querySelector(".placeholder-dot")).not.toBeNull();
    // Exactly one placeholder, and the rest of the tree still renders after it.
    expect(listEl.querySelectorAll(".plan.placeholder").length).toBe(1);
    expect(listEl.querySelector('[data-path="/p/standalone-x.md"]')).not.toBeNull();
  });

  it("renders WITHOUT .active when selected=false", () => {
    render(listEl, masterTree(), makeCtx({ placeholder: { ...ph, selected: false } }));
    const row = listEl.querySelector<HTMLElement>(".plan.placeholder")!;
    expect(row.classList.contains("active")).toBe(false);
  });

  it("is OMITTED when a rendered record carries the same tree_id (the real row took over)", () => {
    render(listEl, masterTree(), makeCtx({ placeholder: { ...ph, treeId: "tree-a" } }));
    expect(listEl.querySelector(".plan.placeholder")).toBeNull();
  });

  it("is rendered when the ctx carries no placeholder (absent/null) — i.e. never spuriously", () => {
    render(listEl, masterTree(), makeCtx());
    expect(listEl.querySelector(".plan.placeholder")).toBeNull();
    render(listEl, masterTree(), makeCtx({ placeholder: null }));
    expect(listEl.querySelector(".plan.placeholder")).toBeNull();
  });

  it("carries NO data-path, so openPlan's [data-path] selection loop leaves it untouched", () => {
    render(listEl, masterTree(), makeCtx({ placeholder: ph }));
    const row = listEl.querySelector<HTMLElement>(".plan.placeholder")!;
    expect(row.hasAttribute("data-path")).toBe(false);
    // Mirror openPlan's selection loop EXACTLY (it toggles .active across every [data-path] row):
    // the placeholder must not be in the loop's selection AND must keep its own .active.
    const looped = Array.from(listEl.querySelectorAll<HTMLElement>("[data-path]"));
    expect(looped).not.toContain(row);
    for (const el of looped) {
      const isThis = el.dataset.path === "/p/a-sub01.md";
      el.classList.toggle("active", isThis);
      if (isThis) el.classList.remove("unread");
    }
    expect(row.classList.contains("active")).toBe(true);
  });

  it("click fires onPlaceholderOpen and NEVER ctx.onOpen (there is no path to open)", () => {
    const onOpen = vi.fn();
    const onPlaceholderOpen = vi.fn();
    render(listEl, masterTree(), makeCtx({ placeholder: ph, onOpen, onPlaceholderOpen }));
    const row = listEl.querySelector<HTMLElement>(".plan.placeholder")!;
    row.click();
    expect(onPlaceholderOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // FIX 1 (double-.active at run start): the user is reading plan A when a run starts — the
  // placeholder mints selected, but openPath still points at A. The SELECTED placeholder must be
  // the SINGLE active row; A's row cedes `.active`.
  // Falsifiability (verified): removing the `ph.selected && phShown` suppression pass in
  // renderSidebar leaves A's row `.active` too → the count assertion goes RED (2 actives).
  it("FIX 1: a SELECTED placeholder is the SINGLE .active row even when openPath matches a record", () => {
    render(listEl, masterTree(), makeCtx({ placeholder: ph, openPath: "/p/standalone-x.md" }));
    const actives = listEl.querySelectorAll(".active");
    expect(actives).toHaveLength(1);
    expect(actives[0].classList.contains("placeholder")).toBe(true);
    // The openPath row exists but ceded .active.
    const aRow = listEl.querySelector<HTMLElement>('[data-path="/p/standalone-x.md"]')!;
    expect(aRow.classList.contains("active")).toBe(false);
  });

  it("FIX 1 scope guard: an UNSELECTED placeholder does NOT suppress the openPath row's .active", () => {
    render(
      listEl,
      masterTree(),
      makeCtx({ placeholder: { ...ph, selected: false }, openPath: "/p/standalone-x.md" }),
    );
    const aRow = listEl.querySelector<HTMLElement>('[data-path="/p/standalone-x.md"]')!;
    expect(aRow.classList.contains("active")).toBe(true);
    expect(listEl.querySelectorAll(".active")).toHaveLength(1);
  });

  it("FIX 1 scope guard: a selected-but-OMITTED placeholder (real row exists) does not suppress", () => {
    // treeId matches a rendered record → placeholder omitted → openPath drives .active normally.
    render(
      listEl,
      masterTree(),
      makeCtx({ placeholder: { ...ph, treeId: "tree-a" }, openPath: "/p/standalone-x.md" }),
    );
    expect(listEl.querySelector(".plan.placeholder")).toBeNull();
    const aRow = listEl.querySelector<HTMLElement>('[data-path="/p/standalone-x.md"]')!;
    expect(aRow.classList.contains("active")).toBe(true);
  });
});

// ---- FIX 3: ONE shared placeholder-visibility predicate for both render sites ------------------

describe("placeholderVisible — the single shared predicate", () => {
  it("true when set and NO record carries its tree_id; false when one does; false when null", () => {
    const ph = { treeId: "tree-live" };
    expect(placeholderVisible(ph, masterTree())).toBe(true);
    expect(placeholderVisible({ treeId: "tree-a" }, masterTree())).toBe(false);
    expect(placeholderVisible(null, masterTree())).toBe(false);
    expect(placeholderVisible(ph, [])).toBe(true);
  });
});

describe("applyFilterAndRender — .filter-empty branch renders the placeholder through the SAME predicate (FIX 3)", () => {
  it("placeholder + non-empty no-match query → exactly one .plan.placeholder FIRST, above .filter-empty", async () => {
    await bootWithRecords(masterTree());
    __setRunPlaceholderForTest({ treeId: "tree-live", label: "New plan — drafting…" }, true);
    typeFilter("zzz-no-such-plan-zzz");

    const list = document.querySelector<HTMLElement>("#plan-list")!;
    // Falsifiability (verified): inverting placeholderVisible's return makes the placeholder
    // vanish here (and double-render in renderSidebar's tests) → these go RED.
    expect(list.querySelectorAll(".plan.placeholder")).toHaveLength(1);
    const first = list.firstElementChild as HTMLElement;
    expect(first.classList.contains("placeholder")).toBe(true);
    // The empty-state note renders AFTER the placeholder.
    const empty = list.querySelector(".filter-empty")!;
    expect(empty).toBeTruthy();
    expect(first.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Cleanup the module-level placeholder so later tests in this file see a clean slate.
    __setRunPlaceholderForTest(null, false);
  });
});

// ---- FIX 4: the agent-exit × placeholder treeId race — pure truth table ------------------------

describe("shouldClearPlaceholderOnExit — clears ONLY a placeholder no ACTIVE orchestration claims", () => {
  // Falsifiability (verified): inverting the treeId comparison (=== instead of !==) flips (a)
  // vs (b)/(c) → all three go RED.
  it("(a) placeholder tree-B + ACTIVE snapshot tree-B → do NOT clear (still-live run owns it)", () => {
    expect(shouldClearPlaceholderOnExit({ treeId: "tree-B" }, true, "tree-B")).toBe(false);
  });

  it("(b) placeholder tree-A + ACTIVE snapshot tree-B → clear (stale placeholder from a dead run)", () => {
    expect(shouldClearPlaceholderOnExit({ treeId: "tree-A" }, true, "tree-B")).toBe(true);
  });

  it("(c) placeholder tree-A + NO active orchestration → clear (even if a stale snapshot matches)", () => {
    expect(shouldClearPlaceholderOnExit({ treeId: "tree-A" }, false, null)).toBe(true);
    // An inactive orchestration's leftover snapshot treeId must NOT keep the placeholder alive.
    expect(shouldClearPlaceholderOnExit({ treeId: "tree-A" }, false, "tree-A")).toBe(true);
  });

  it("no placeholder → never clear (guard short-circuits)", () => {
    expect(shouldClearPlaceholderOnExit(null, false, null)).toBe(false);
    expect(shouldClearPlaceholderOnExit(null, true, "tree-B")).toBe(false);
  });
});

// ---- Bug B fix: the onActivity conversation-tab flip suppression -------------------------------

describe("suppressConversationFlip — keyed STRICTLY on pendingApproval", () => {
  // A minimal gate-shaped object; the helper only null-checks the field, never reads into it.
  const gate = { kind: "leaf" } as unknown as NonNullable<
    Parameters<typeof suppressConversationFlip>[0]
  >["pendingApproval"];

  it("null snapshot → false (no run; the flip proceeds)", () => {
    expect(suppressConversationFlip(null)).toBe(false);
  });

  it("snapshot without a pendingApproval → false (streaming flips to Conversation)", () => {
    expect(suppressConversationFlip({ pendingApproval: null })).toBe(false);
  });

  it("snapshot with a pendingApproval → true (a held gate owns the Plan tab)", () => {
    expect(suppressConversationFlip({ pendingApproval: gate })).toBe(true);
  });

  it("pendingClarify set + pendingApproval null → false (AskUserQuestion cards NEED the flip)", () => {
    // Extra transient-gate fields must be IGNORED — only pendingApproval suppresses.
    const snap = { pendingApproval: null, pendingClarify: { toolUseId: "t1" } };
    expect(suppressConversationFlip(snap)).toBe(false);
  });
});
