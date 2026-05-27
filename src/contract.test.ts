// Wire contract-conformance test (TS side).
//
// HONEST SCOPE: this test locks the SHAPE the frontend EXPECTS of a `list_plans` response —
// the exact eleven snake_case keys per record (CONTRACT.md §"PlanRecord — five appended fields")
// — and gives render coverage across all three flavors + the cwd null/real-path branches. The
// fixture is authored AGAINST CONTRACT.md, not copied from a runtime dump, so it is a written
// statement of the contract, not an observation of the backend.
//
// It does NOT validate the live backend or assert how Rust serializes `PlanRecord`. The
// authoritative Rust→JSON serialization is asserted by the Rust-side test; drift is therefore
// caught on the PRODUCING side. This test catches drift on the CONSUMING side: if the frontend's
// expected key set changes (a field added/dropped here), the key-set assertion goes red.

import { describe, it, expect, vi, beforeEach } from "vitest";
// Read the REAL index.html (not a hand-built copy) via Vite's `?raw` loader so deleting a
// selector from it makes the relevant assertion go red — the property that makes this a
// genuine contract guard. `?raw` keeps this off @types/node (no fs/process needed).
import INDEX_HTML from "../index.html?raw";
// Read the REAL CONTRACT.md the same way so the cmt-hl/data-c convention assertions go red if
// the contract drops them (the highlight spans are runtime-emitted, not in static index.html).
import CONTRACT_MD from "../CONTRACT.md?raw";

// main.ts pulls in Tauri APIs + the render facade at load. Mirror main.test.ts and mock them so
// importing the module is a no-op (it only registers a DOMContentLoaded listener, never fired
// under vitest). We exercise the REAL renderSidebar.
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
vi.mock("./render/scroll", () => ({ captureAnchor: vi.fn(), applyDelta: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn() }));

import { renderSidebar } from "./main";
import { asAbsPath, asStem, type PlanRecord, type SidebarCtx, type CommentRecord } from "./types";
import fixture from "./__fixtures__/list_plans.sample.json";

// ---- Contract anchor ---------------------------------------------------------------------
// The eleven snake_case keys the frontend expects on every PlanRecord, sorted. Written out
// literally so an added/dropped fixture key is caught by the deep-equal below.
const EXPECTED_KEYS = [
  "absolute_path",
  "child_count",
  "collapsed",
  "cwd",
  "filename_stem",
  "flavor",
  "h1s",
  "mtime_ms",
  "nn",
  "tree_id",
  "unread",
].sort();

// Re-brand the two branded string fields (absolute_path / filename_stem) instead of `as any`.
// This shows the raw JSON record is STRUCTURALLY compatible with PlanRecord apart from the
// compile-time brand: every other field flows through unchanged, typed by PlanRecord.
function toPlanRecord(raw: (typeof fixture)[number]): PlanRecord {
  return {
    ...raw,
    flavor: raw.flavor as PlanRecord["flavor"],
    absolute_path: asAbsPath(raw.absolute_path),
    filename_stem: asStem(raw.filename_stem),
  };
}

const records: PlanRecord[] = fixture.map(toPlanRecord);

function makeCtx(over: Partial<SidebarCtx> = {}): SidebarCtx {
  return {
    openPath: null,
    collapseOverride: new Map(),
    onOpen: vi.fn(),
    onToggleCollapse: vi.fn(),
    ...over,
  };
}

let listEl: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  listEl = document.createElement("div");
  listEl.id = "plan-list";
  document.body.appendChild(listEl);
});

describe("contract — fixture sanity (authored against CONTRACT.md)", () => {
  it("contains exactly one master, two subs, and one standalone in pre-ordered display shape", () => {
    expect(fixture.map((r) => r.flavor)).toEqual(["master", "sub", "sub", "standalone"]);
  });

  it("covers both cwd states: at least one null cwd and at least one real-path cwd", () => {
    expect(fixture.some((r) => r.cwd === null)).toBe(true);
    expect(fixture.some((r) => typeof r.cwd === "string" && r.cwd.length > 0)).toBe(true);
  });

  it("the master has a non-null tree_id, child_count>=1, collapsed:false; subs share its tree_id with an nn", () => {
    const master = fixture.find((r) => r.flavor === "master")!;
    expect(master.tree_id).not.toBeNull();
    expect(master.child_count).toBeGreaterThanOrEqual(1);
    expect(master.collapsed).toBe(false);

    const subs = fixture.filter((r) => r.flavor === "sub");
    for (const sub of subs) {
      expect(sub.tree_id).toBe(master.tree_id);
      expect(typeof sub.nn).toBe("number");
    }
  });

  it("the standalone has null tree_id, nn, and child_count", () => {
    const standalone = fixture.find((r) => r.flavor === "standalone")!;
    expect(standalone.tree_id).toBeNull();
    expect(standalone.nn).toBeNull();
    expect(standalone.child_count).toBeNull();
  });
});

describe("contract — PlanRecord key set is locked", () => {
  it("EVERY fixture record has exactly the eleven expected snake_case keys (no more, no fewer)", () => {
    for (const raw of fixture) {
      expect(Object.keys(raw).sort()).toEqual(EXPECTED_KEYS);
    }
  });

  it("the expected key set is exactly eleven keys", () => {
    expect(EXPECTED_KEYS).toHaveLength(11);
  });
});

describe("contract — fixture is consumable as PlanRecord[]", () => {
  it("re-branding the two branded fields yields a structurally-complete PlanRecord per record", () => {
    expect(records).toHaveLength(fixture.length);
    for (const rec of records) {
      // Branded slots carry the same underlying string value (brands erase at runtime).
      expect(typeof (rec.absolute_path as unknown as string)).toBe("string");
      expect(typeof (rec.filename_stem as unknown as string)).toBe("string");
      // Non-branded fields survive the spread unchanged and keep their contract types.
      expect(typeof rec.mtime_ms).toBe("number");
      expect(typeof rec.unread).toBe("boolean");
      expect(typeof rec.collapsed).toBe("boolean");
      expect(["master", "sub", "standalone"]).toContain(rec.flavor);
      expect(rec.cwd === null || typeof rec.cwd === "string").toBe(true);
      expect(rec.tree_id === null || typeof rec.tree_id === "string").toBe(true);
      expect(rec.nn === null || typeof rec.nn === "number").toBe(true);
      expect(rec.child_count === null || typeof rec.child_count === "number").toBe(true);
    }
  });
});

describe("contract — table-of-contents sidebar selectors present in index.html", () => {
  // Each token is a selector/markup fragment the ToC feature depends on. The test reads the
  // real file, so removing any one of these from index.html turns its assertion red.
  const TOKENS = [
    "tab-row",
    'data-tab="plans"',
    'data-tab="contents"',
    'id="tab-plans"',
    'id="tab-contents"',
    'id="toc-list"',
    // Sidebar filter (Fix 1): the real interactive control inside the frozen .search container.
    'id="plan-filter"',
    'class="search"',
    'class="clear"',
    // Sub-Plan 01: theme toggle in the .titlebar-controls slot + the persisted-theme
    // localStorage key (pins the inline anti-FOUC script's key to the contract).
    'class="titlebar-controls"',
    'id="theme-toggle"',
    "plan-reader-theme",
  ];
  for (const token of TOKENS) {
    it(`index.html contains \`${token}\``, () => {
      expect(INDEX_HTML).toContain(token);
    });
  }

  it("#plan-count stays inside the plans pane's sidebar-head (not relocated)", () => {
    // The plans pane head still carries the frozen #plan-count selector.
    expect(INDEX_HTML).toMatch(/id="tab-plans"[\s\S]*id="plan-count"[\s\S]*id="plan-list"/);
  });
});

describe("contract — Sub-Plan 02 highlight/comment selectors present in index.html", () => {
  // Popover markup the comment feature depends on. Reads the real file, so removing any of
  // these from index.html turns its assertion red.
  const TOKENS = [
    'id="sel-popover"',
    'id="sp-quote"',
    'id="sp-text"',
    'id="sp-cancel"',
    'id="sp-save"',
  ];
  for (const token of TOKENS) {
    it(`index.html contains \`${token}\``, () => {
      expect(INDEX_HTML).toContain(token);
    });
  }

  it("the popover lives OUTSIDE #reading-pane (survives the pane's innerHTML wipe)", () => {
    // #reading-pane is an empty <div> in the markup; the popover must NOT be nested inside it.
    // Assert the popover markup appears AFTER the #reading-pane element closes, as a sibling
    // under .window. (A naive nesting would place #sel-popover between #reading-pane's tags.)
    const paneIdx = INDEX_HTML.indexOf('id="reading-pane"');
    const popIdx = INDEX_HTML.indexOf('id="sel-popover"');
    expect(paneIdx).toBeGreaterThan(-1);
    expect(popIdx).toBeGreaterThan(paneIdx);
    // The #reading-pane div is self-contained (`<div ... id="reading-pane"></div>`), so the
    // popover cannot be a descendant — it appears later in the document as a sibling.
    expect(INDEX_HTML).toMatch(/id="reading-pane"><\/div>/);
  });

  it("the popover has NO data-tauri-drag-region (it is not part of the titlebar)", () => {
    // Slice from the popover's start to its save button and assert the drag attribute is absent
    // within that region (the titlebar above it does carry it, so a global check would be wrong).
    const start = INDEX_HTML.indexOf('id="sel-popover"');
    const end = INDEX_HTML.indexOf('id="sp-save"');
    const region = INDEX_HTML.slice(start, end);
    expect(region).not.toContain("data-tauri-drag-region");
  });

  it("the cmt-hl highlight class + data-c convention are documented in the contract", () => {
    // The highlight spans are emitted by comments.ts at runtime (not in static index.html), so
    // the contract markdown is where the selector/attribute convention is locked. Read the real
    // CONTRACT.md so dropping the convention turns this red.
    expect(CONTRACT_MD).toContain(".cmt-hl");
    expect(CONTRACT_MD).toContain('data-c="{id}"');
  });
});

describe("contract — Sub-Plan 03 Prompt Feedback selectors present in index.html", () => {
  // Button + overlay markup the feedback feature depends on. Reads the real index.html, so removing
  // any of these turns its assertion red. The facade `clearAllComments` is asserted separately.
  const TOKENS = [
    'id="feedback-btn"',
    'id="feedback-count"',
    'id="feedback-overlay"',
    'id="feedback-body"',
    'id="feedback-copy"',
    'id="feedback-clear"',
  ];
  for (const token of TOKENS) {
    it(`index.html contains \`${token}\``, () => {
      expect(INDEX_HTML).toContain(token);
    });
  }

  it("the feedback overlay lives OUTSIDE #reading-pane (survives the pane's innerHTML wipe)", () => {
    // Appears AFTER #reading-pane closes, as a sibling under .window (not nested in the pane).
    const paneIdx = INDEX_HTML.indexOf('id="reading-pane"');
    const overlayIdx = INDEX_HTML.indexOf('id="feedback-overlay"');
    expect(paneIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(paneIdx);
  });

  it("the feedback button is the FIRST control in .titlebar-controls (theme toggle stays far-right)", () => {
    // #feedback-btn must precede #theme-toggle inside the markup.
    expect(INDEX_HTML).toMatch(/class="titlebar-controls"[\s\S]*id="feedback-btn"[\s\S]*id="theme-toggle"/);
  });

  it("neither the feedback button nor overlay carries data-tauri-drag-region", () => {
    // Slice the button markup and the overlay markup and assert the drag attribute is absent in
    // each (the titlebar wrapper carries it, so a global check would be wrong).
    const btnStart = INDEX_HTML.indexOf('id="feedback-btn"');
    const btnEnd = INDEX_HTML.indexOf('id="theme-toggle"');
    expect(INDEX_HTML.slice(btnStart, btnEnd)).not.toContain("data-tauri-drag-region");
    const ovStart = INDEX_HTML.indexOf('id="feedback-overlay"');
    const ovEnd = INDEX_HTML.indexOf('id="feedback-clear"');
    expect(INDEX_HTML.slice(ovStart, ovEnd)).not.toContain("data-tauri-drag-region");
  });

  it("the facade clearAllComments surface is documented in CONTRACT.md", () => {
    expect(CONTRACT_MD).toContain("clearAllComments");
  });
});

describe("contract — CommentRecord carries exactly its 5 fields (separate from PlanRecord)", () => {
  // DERIVED FROM THE TYPE, not a hand-written literal: the keymap is `satisfies
  // Record<keyof CommentRecord, true>`, so the COMPILER enforces it covers EVERY key of the
  // interface. Adding a 6th interface field → tsc fails (the keymap is missing that key);
  // renaming a field → tsc fails (the keymap names a key that no longer exists). Either way the
  // freeze is falsifiable via the type, not just runtime. PlanRecord is UNAFFECTED — comments do
  // not ride on it (EXPECTED_KEYS stays eleven, untouched). The authoritative Rust→JSON freeze is
  // the cargo test `comment_record_wire_contract_is_frozen`.
  const COMMENT_KEY_MAP = {
    quote: true,
    block_line: true,
    occurrence: true,
    comment: true,
    id: true,
  } satisfies Record<keyof CommentRecord, true>;
  const COMMENT_KEYS = Object.keys(COMMENT_KEY_MAP).sort();

  const EXPECTED_COMMENT_KEYS = ["block_line", "comment", "id", "occurrence", "quote"].sort();

  it("the type-derived CommentRecord key set is exactly the five expected snake_case keys", () => {
    // The keymap is exhaustive over keyof CommentRecord (compile-enforced); this runtime check
    // pins the EXACT key names so a renamed field (which still type-checks if both sides rename)
    // is caught against the written contract.
    expect(COMMENT_KEYS).toEqual(EXPECTED_COMMENT_KEYS);
    expect(COMMENT_KEYS).toHaveLength(5);
  });

  it("a CommentRecord literal carries exactly those keys, with block_line nullable (both branches)", () => {
    const anchored: CommentRecord = { quote: "hello", block_line: 5, occurrence: 1, comment: "note", id: 0 };
    const wholePane: CommentRecord = { quote: "floating", block_line: null, occurrence: 0, comment: "note2", id: 1 };
    expect(Object.keys(anchored).sort()).toEqual(COMMENT_KEYS);
    expect(Object.keys(wholePane).sort()).toEqual(COMMENT_KEYS);
    // block_line covers BOTH branches: a number and null (the no-block-ancestor type, no -1).
    expect(typeof anchored.block_line).toBe("number");
    expect(wholePane.block_line).toBeNull();
  });
});

describe("contract — render coverage across flavors + cwd states", () => {
  it("renders all three flavors from the fixture without throwing: master row, sub rows, standalone row", () => {
    expect(() => renderSidebar(listEl, records, makeCtx())).not.toThrow();

    // master → .master wrapper with a .master-row
    const masterRow = listEl.querySelector('.master .master-row[data-path="/Users/u/.claude/plans/master-alpha.md"]');
    expect(masterRow).toBeTruthy();

    // both subs nested under the master's .children
    const subs = listEl.querySelectorAll(".master .children .plan.sub");
    expect(subs.length).toBe(2);

    // standalone → a flat .plan that is neither .master nor .sub
    const standalone = listEl.querySelector<HTMLElement>(
      '.plan[data-path="/Users/u/.claude/plans/standalone-solo.md"]',
    )!;
    expect(standalone).toBeTruthy();
    expect(standalone.classList.contains("master")).toBe(false);
    expect(standalone.classList.contains("sub")).toBe(false);
  });

  it("the .plan-src cwd display covers BOTH branches: real-path cwd shown verbatim, null cwd ⇒ empty", () => {
    renderSidebar(listEl, records, makeCtx());

    // real-path branch: rec.cwd wins in planSrcText. homePath is unset under vitest (homeDir is
    // mocked but never invoked since DOMContentLoaded never fires), so displayCwd returns the
    // path verbatim — the master row's .plan-src shows its real cwd.
    const masterSrc = listEl.querySelector<HTMLElement>(
      '.master .master-row[data-path="/Users/u/.claude/plans/master-alpha.md"] .plan-src',
    )!;
    expect(masterSrc).toBeTruthy();
    expect(masterSrc.textContent).toBe("/Users/u/work/alpha");

    // null-cwd branch: standalone-solo has cwd:null and its stem is absent from cwdByStem
    // (unresolved) ⇒ empty string (no "unknown" flash).
    const standaloneSrc = listEl.querySelector<HTMLElement>(
      '.plan[data-path="/Users/u/.claude/plans/standalone-solo.md"] .plan-src',
    )!;
    expect(standaloneSrc).toBeTruthy();
    expect(standaloneSrc.textContent).toBe("");
  });
});
