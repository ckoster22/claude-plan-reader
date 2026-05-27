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
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn() }));

import { renderSidebar, buildToc, initTabs } from "./main";
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
    rec({ absolute_path: "/p/a-sub01.md", filename_stem: "a-sub01", flavor: "sub", tree_id: "tree-a", nn: 1 }),
    rec({ absolute_path: "/p/a-sub02.md", filename_stem: "a-sub02", flavor: "sub", tree_id: "tree-a", nn: 2 }),
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
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1 }),
    ];
    render(listEl, single, makeCtx());
    expect(listEl.querySelector(".master .child-count")!.textContent).toBe("1 sub-plan");
  });

  it("a collapsed:true master gets the .collapsed class", () => {
    const recs: Rec[] = [
      rec({ absolute_path: "/p/m.md", filename_stem: "m", flavor: "master", tree_id: "t", child_count: 1, collapsed: true }),
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1 }),
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
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1 }),
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
      rec({ absolute_path: "/p/m-01.md", filename_stem: "m-01", flavor: "sub", tree_id: "t", nn: 1, unread: true }),
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
      rec({ absolute_path: "/p/orphan.md", filename_stem: "orphan", flavor: "sub", tree_id: "t", nn: 1 }),
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
