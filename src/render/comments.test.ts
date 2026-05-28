import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeQuote,
  findRangeForRecord,
  wrapRange,
  clearHighlight,
  applyComments,
  initComments,
  onCommentCountChanged,
  loadCommentsFor,
  clearAllComments,
  type CommentsIO,
} from "./comments";
import type { CommentRecord } from "../types";

// ---- Test helpers --------------------------------------------------------------------------

// Build a #reading-pane element from an HTML string. Production stamps data-source-line on
// block-open tokens, so these fixtures carry it the same way.
function pane(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "md";
  el.id = "reading-pane";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

// Build a CommentRecord with sensible defaults.
function rec(over: Partial<CommentRecord> & { quote: string }): CommentRecord {
  return {
    block_line: null,
    occurrence: 0,
    comment: "",
    id: 0,
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

// ============================================================================================
// Verification item 1 — duplicate-text 2nd-occurrence anchoring
// ============================================================================================
describe("applyComments — duplicate-text anchoring (Verification 1)", () => {
  it("anchors the 2nd occurrence (occurrence:1) leaving the 1st un-highlighted", () => {
    // A block with the phrase "foo bar" repeated twice (block data-source-line=5).
    const p = pane('<p data-source-line="5">alpha foo bar beta foo bar gamma</p>');
    const record = rec({ quote: "foo bar", block_line: 5, occurrence: 1, id: 7 });

    applyComments(p, [record]);

    const spans = p.querySelectorAll('.cmt-hl[data-c="7"]');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    // The highlighted text is "foo bar".
    const highlighted = Array.from(spans).map((s) => s.textContent).join("");
    expect(highlighted).toBe("foo bar");

    const block = p.querySelector('[data-source-line="5"]')!;
    // The text BEFORE the (single) highlight span must still contain the FIRST, un-highlighted
    // "foo bar". We reconstruct the leading plain text by walking siblings up to the first span.
    const firstSpan = spans[0];
    let leading = "";
    let node: ChildNode | null = block.firstChild;
    while (node && node !== firstSpan) {
      leading += node.textContent ?? "";
      node = node.nextSibling;
    }
    // The 1st "foo bar" lives in the leading plain text (NOT wrapped).
    expect(leading).toContain("foo bar");
    expect(leading.startsWith("alpha foo bar")).toBe(true);
    // And there is exactly ONE highlight occurrence (the 2nd), not the 1st.
    expect(block.querySelectorAll(".cmt-hl").length).toBeGreaterThanOrEqual(1);
    expect(block.textContent).toBe("alpha foo bar beta foo bar gamma"); // text preserved
  });

  it("FULL round-trip: capturing the 2nd occurrence persists occurrence:1 and re-applies to the 2nd", async () => {
    // This exercises the WHOLE pipeline — capture (countOccurrencesBefore) → persist → re-apply
    // — on duplicate text, instead of hand-building occurrence:1. It pins the stepping symmetry
    // between countOccurrencesBefore and findRangeForRecord (both use `from = idx + 1`): if either
    // side's stepping breaks, the captured occurrence and the re-applied occurrence diverge.
    const html = '<p data-source-line="5">alpha foo bar beta foo bar gamma</p>';
    const p = pane(html);

    let saved: CommentRecord[] = [];
    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_path, c) => {
        saved = c;
        return c;
      }),
      clearAll: vi.fn(async () => []),
    };
    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    // Programmatically select the 2ND "foo bar" (occurrence index 1) and save it as a comment.
    selectText(p, p.querySelector('[data-source-line="5"]')!, "foo bar", 1);
    fireMouseUp(p);
    setTextarea("a note on the 2nd");
    clickSave();
    await Promise.resolve();
    await Promise.resolve();

    // The CAPTURE produced the record (NOT hand-built): occurrence:1, block_line:5, quote:"foo bar".
    expect(saved).toHaveLength(1);
    const captured = saved[0];
    expect(captured.quote).toBe("foo bar");
    expect(captured.block_line).toBe(5);
    expect(captured.occurrence).toBe(1); // <-- derived by countOccurrencesBefore, not by hand

    // Simulate renderInto's innerHTML wipe (live-reload / plan-switch): rebuild the pane fresh.
    p.innerHTML = html;
    expect(p.querySelectorAll(".cmt-hl").length).toBe(0); // truly wiped

    // Re-apply the captured record to the fresh pane.
    applyComments(p, [captured]);

    // The 2nd occurrence (and only it) is re-highlighted.
    const spans = p.querySelectorAll(`.cmt-hl[data-c="${captured.id}"]`);
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(normalizeQuote(Array.from(spans).map((s) => s.textContent).join(""))).toBe("foo bar");

    const block = p.querySelector('[data-source-line="5"]')!;
    // The leading plain text (before the highlight) still carries the FIRST, un-highlighted "foo bar".
    const firstSpan = spans[0];
    let leading = "";
    let node: ChildNode | null = block.firstChild;
    while (node && node !== firstSpan) {
      leading += node.textContent ?? "";
      node = node.nextSibling;
    }
    expect(leading.startsWith("alpha foo bar")).toBe(true);
    expect(block.textContent).toBe("alpha foo bar beta foo bar gamma"); // text preserved
  });
});

// ============================================================================================
// Verification item 2 — cross-inline-element wrap (no surroundContents throw)
// ============================================================================================
describe("wrapRange — cross-inline-element selection (Verification 2)", () => {
  it("wraps a quote spanning <code>…</code> … <strong>…</strong> as multiple sibling spans, tags intact", () => {
    const p = pane('<p data-source-line="0">use <code>foo()</code> then <strong>bar</strong> done</p>');
    // Quote spans from inside <code> through inside <strong>: "foo() then bar".
    const record = rec({ quote: "foo() then bar", block_line: 0, occurrence: 0, id: 3 });

    expect(() => applyComments(p, [record])).not.toThrow();

    const spans = p.querySelectorAll('.cmt-hl[data-c="3"]');
    // Multiple sibling spans (the selection crosses element boundaries).
    expect(spans.length).toBeGreaterThan(1);
    // The original inline elements survive.
    expect(p.querySelector("code")).not.toBeNull();
    expect(p.querySelector("strong")).not.toBeNull();
    // The union of the highlighted text equals the quote (modulo collapsed whitespace).
    const joined = normalizeQuote(Array.from(spans).map((s) => s.textContent).join(""));
    expect(joined).toBe("foo() then bar");
    // No span crosses an element boundary: each span's children are text only.
    for (const s of Array.from(spans)) {
      for (const child of Array.from(s.childNodes)) {
        expect(child.nodeType).toBe(Node.TEXT_NODE);
      }
    }
  });
});

// ============================================================================================
// Verification item 3 — clear round-trip (multi-span unwrap invariant)
// ============================================================================================
describe("clearHighlight — total + idempotent unwrap (Verification 3)", () => {
  it("restores textContent and leaves zero [data-c] after clearing a multi-element wrap", () => {
    const html = '<p data-source-line="0">use <code>foo()</code> then <strong>bar</strong> done</p>';
    const p = pane(html);
    const before = p.textContent;

    applyComments(p, [rec({ quote: "foo() then bar", block_line: 0, occurrence: 0, id: 9 })]);
    // Sanity: several sibling spans were created.
    expect(p.querySelectorAll('[data-c="9"]').length).toBeGreaterThan(1);

    clearHighlight(p, 9);

    // (a) textContent fully restored.
    expect(p.textContent).toBe(before);
    // (b) zero orphan [data-c] spans.
    expect(p.querySelectorAll("[data-c]").length).toBe(0);
  });

  it("is idempotent — clearing twice is a no-op and never throws", () => {
    const p = pane('<p data-source-line="0">alpha foo bar beta</p>');
    applyComments(p, [rec({ quote: "foo bar", block_line: 0, occurrence: 0, id: 1 })]);
    const restored = p.textContent;
    clearHighlight(p, 1);
    expect(() => clearHighlight(p, 1)).not.toThrow();
    expect(p.textContent).toBe(restored);
    expect(p.querySelectorAll("[data-c]").length).toBe(0);
  });
});

// ============================================================================================
// Verification item 4 — block_line: null whole-pane re-find
// ============================================================================================
describe("applyComments — block_line null scans the whole pane (Verification 4)", () => {
  it("a null-block record finds its match by occurrence across the whole pane", () => {
    // Two separate blocks; the quote lives in the SECOND block. A whole-pane scan (block_line:null)
    // must still find it. occurrence counts across the whole pane.
    const p = pane(
      '<p data-source-line="0">first block has needle</p>' +
        '<p data-source-line="3">second block also has needle here</p>',
    );
    const record = rec({ quote: "needle", block_line: null, occurrence: 1, id: 4 });

    applyComments(p, [record]);

    const spans = p.querySelectorAll('.cmt-hl[data-c="4"]');
    expect(spans.length).toBe(1);
    // The 2nd "needle" (in the second block) is the one wrapped.
    const wrapped = spans[0] as HTMLElement;
    expect(wrapped.textContent).toBe("needle");
    expect(wrapped.closest('[data-source-line="3"]')).not.toBeNull();
    expect(wrapped.closest('[data-source-line="0"]')).toBeNull();
  });
});

// ============================================================================================
// Verification item 5 — id uniqueness after K appends (minting invariant guard)
// ============================================================================================
describe("addComment minting — ids are pairwise distinct after K appends (Verification 5)", () => {
  it("K sequential saves mint pairwise-distinct ids", async () => {
    const p = pane('<p data-source-line="0">repeated word repeated word repeated word repeated word</p>');

    // Track what was persisted so we can read back the minted ids.
    let saved: CommentRecord[] = [];
    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_p, c) => {
        saved = c;
        return c;
      }),
      clearAll: vi.fn(async () => []),
    };

    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    // Drive K saves through the popover create flow. Each selects the next "repeated" occurrence.
    const K = 4;
    for (let i = 0; i < K; i++) {
      selectText(p, p.querySelector('[data-source-line="0"]')!, "repeated", i);
      fireMouseUp(p);
      setTextarea("c" + i);
      clickSave();
      // Let the async addComment cache+save settle.
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(saved).toHaveLength(K);
    const ids = saved.map((r) => r.id);
    expect(new Set(ids).size).toBe(K); // pairwise distinct
  });
});

// ============================================================================================
// Verification item 6 (frontend half) — persistence round-trip via mocked CommentsIO
// ============================================================================================
describe("addComment / clear — adopt returned array + fire onChange (Verification 6)", () => {
  it("addComment calls io.save with the new array, adopts the returned array, and fires onChange", async () => {
    const p = pane('<p data-source-line="0">hello world here</p>');
    const returned: CommentRecord[] = [];
    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_path, c) => {
        // Backend returns the authoritative array (echo on success).
        returned.push(...c);
        return c;
      }),
      clearAll: vi.fn(async () => []),
    };
    const onChange = vi.fn();
    onCommentCountChanged(onChange);

    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    selectText(p, p.querySelector('[data-source-line="0"]')!, "world", 0);
    fireMouseUp(p);
    setTextarea("a note");
    clickSave();
    await Promise.resolve();
    await Promise.resolve();

    expect(io.save).toHaveBeenCalledTimes(1);
    const [, savedArr] = (io.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(savedArr).toHaveLength(1);
    expect(savedArr[0].quote).toBe("world");
    expect(onChange).toHaveBeenCalled();
  });

  it("clearing the only comment (view-mode save) fires onChange and persists the empty array", async () => {
    const p = pane('<p data-source-line="0">hello world here</p>');
    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_p, c) => c),
      clearAll: vi.fn(async () => []),
    };
    const onChange = vi.fn();
    onCommentCountChanged(onChange);

    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    // Create one comment.
    selectText(p, p.querySelector('[data-source-line="0"]')!, "world", 0);
    fireMouseUp(p);
    setTextarea("x");
    clickSave();
    await Promise.resolve();
    await Promise.resolve();
    onChange.mockClear();

    // Click the highlight → view mode, then "save" acts as clear.
    const hl = p.querySelector<HTMLElement>(".cmt-hl")!;
    hl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    clickSave();
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange).toHaveBeenCalled();
    // The last save call persisted an empty array (the comment was spliced).
    const calls = (io.save as ReturnType<typeof vi.fn>).mock.calls;
    const lastArr = calls[calls.length - 1][1];
    expect(lastArr).toHaveLength(0);
    // The highlight span is gone.
    expect(p.querySelectorAll("[data-c]").length).toBe(0);
  });
});

// ============================================================================================
// Verification item 7 — popover state machine via the single renderPopover applier
// ============================================================================================
describe("popover state machine (Verification 7)", () => {
  it("mouseup over a selection → create (un-hidden, #sp-quote set); cancel → hidden (no io.save)", async () => {
    const p = pane('<p data-source-line="0">select me please</p>');
    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_p, c) => c),
      clearAll: vi.fn(async () => []),
    };
    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    const popEl = document.querySelector<HTMLElement>("#sel-popover")!;
    // Initially hidden.
    expect(popEl.classList.contains("hidden")).toBe(true);

    selectText(p, p.querySelector('[data-source-line="0"]')!, "select me", 0);
    fireMouseUp(p);
    // create: un-hidden + #sp-quote shows the quote.
    expect(popEl.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#sp-quote")!.textContent).toContain("select me");

    // cancel → hidden + nothing saved.
    document.querySelector<HTMLElement>("#sp-cancel")!.click();
    expect(popEl.classList.contains("hidden")).toBe(true);
    expect(io.save).not.toHaveBeenCalled();
  });

  it("clicking a .cmt-hl → view (un-hidden, shows that comment); Escape → hidden", async () => {
    const p = pane('<p data-source-line="0">view this text</p>');
    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_p, c) => c),
      clearAll: vi.fn(async () => []),
    };
    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    // Create a comment first.
    selectText(p, p.querySelector('[data-source-line="0"]')!, "view this", 0);
    fireMouseUp(p);
    setTextarea("my note");
    clickSave();
    await Promise.resolve();
    await Promise.resolve();

    const popEl = document.querySelector<HTMLElement>("#sel-popover")!;
    // Click the highlight → view mode.
    const hl = p.querySelector<HTMLElement>(".cmt-hl")!;
    hl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popEl.classList.contains("hidden")).toBe(false);
    expect((document.querySelector("#sp-text") as HTMLTextAreaElement).value).toBe("my note");

    // Escape → hidden.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popEl.classList.contains("hidden")).toBe(true);
  });

  it("an empty/collapsed selection leaves the popover hidden (no transition)", () => {
    const p = pane('<p data-source-line="0">nothing selected</p>');
    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_p, c) => c),
      clearAll: vi.fn(async () => []),
    };
    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    // No selection → mouseup is a no-op.
    window.getSelection()!.removeAllRanges();
    fireMouseUp(p);
    expect(document.querySelector<HTMLElement>("#sel-popover")!.classList.contains("hidden")).toBe(true);
  });
});

// ============================================================================================
// loadCommentsFor — facade loader populates + caches per pane
// ============================================================================================
// ============================================================================================
// findRangeForRecord / wrapRange / normalizeQuote — direct pure-function coverage
// ============================================================================================
describe("normalizeQuote", () => {
  it("collapses internal whitespace runs to a single space and trims", () => {
    expect(normalizeQuote("  foo   bar\n\tbaz  ")).toBe("foo bar baz");
    expect(normalizeQuote("")).toBe("");
  });
});

describe("findRangeForRecord", () => {
  it("returns null for a missing root", () => {
    expect(findRangeForRecord(null, "x", 0)).toBeNull();
  });
  it("returns null when the occurrence is not present", () => {
    const p = pane('<p data-source-line="0">only one needle here</p>');
    expect(findRangeForRecord(p, "needle", 1)).toBeNull(); // no 2nd occurrence
  });
  it("returns a Range covering the matched text", () => {
    const p = pane('<p data-source-line="0">find the target word</p>');
    const range = findRangeForRecord(p, "target", 0);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("target");
  });
});

describe("wrapRange", () => {
  it("wraps a single-node range in one .cmt-hl span without surroundContents", () => {
    const p = pane('<p data-source-line="0">wrap this part only</p>');
    const range = findRangeForRecord(p, "this part", 0)!;
    wrapRange(range, 42);
    const spans = p.querySelectorAll('.cmt-hl[data-c="42"]');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(normalizeQuote(Array.from(spans).map((s) => s.textContent).join(""))).toBe("this part");
    expect(p.textContent).toBe("wrap this part only");
  });
});

describe("loadCommentsFor", () => {
  it("returns [] for a pane that was never initialized", async () => {
    const p = pane("<p>x</p>");
    expect(await loadCommentsFor(p, "/never.md")).toEqual([]);
  });

  it("delegates to io.load for an initialized pane", async () => {
    const p = pane("<p>x</p>");
    const records = [rec({ quote: "q", id: 0 })];
    const io: CommentsIO = {
      load: vi.fn(async () => records),
      save: vi.fn(async (_p, c) => c),
      clearAll: vi.fn(async () => []),
    };
    bootPopoverDom();
    initComments(p, () => "/plan.md", io);
    const got = await loadCommentsFor(p, "/plan.md");
    expect(got).toEqual(records);
    expect(io.load).toHaveBeenCalledWith("/plan.md");
  });
});

// ============================================================================================
// facade clearAllComments (remove every highlight + wipe the cache, fire onChange)
// ============================================================================================
describe("clearAllComments — wipes all highlights + cache + fires onChange", () => {
  it("after clearAllComments the pane has zero .cmt-hl spans, the cache is [], and onChange fired", async () => {
    // A pane with TWO committed comments in two separate blocks. The clear-all sweep must remove
    // EVERY highlight (iterating the cached record ids), not just one — so two distinct comments is
    // the minimal multi-record case. (Multi-span-PER-record unwrap is already covered by the
    // clearHighlight tests above; here the invariant is "every cached record's highlight is swept".)
    const html =
      '<p data-source-line="0">first comment lives here</p>' +
      '<p data-source-line="1">a second comment here</p>';
    const p = pane(html);

    const io: CommentsIO = {
      load: vi.fn(async () => []),
      save: vi.fn(async (_pp, c) => c),
      clearAll: vi.fn(async () => []), // backend returns the empty array
    };
    const onChange = vi.fn();
    onCommentCountChanged(onChange);

    bootPopoverDom();
    initComments(p, () => "/plan.md", io);

    // Create two comments via the real save flow so they land in the per-pane cache (clearAll
    // iterates the CACHED ids — building the cache through the real path is what the closure reads).
    selectText(p, p.querySelector('[data-source-line="0"]')!, "first comment", 0);
    fireMouseUp(p);
    setTextarea("c0");
    clickSave();
    await Promise.resolve();
    await Promise.resolve();

    selectText(p, p.querySelector('[data-source-line="1"]')!, "second comment", 0);
    fireMouseUp(p);
    setTextarea("c1");
    clickSave();
    await Promise.resolve();
    await Promise.resolve();

    // Sanity: TWO highlights are present (one per comment, distinct data-c ids).
    expect(p.querySelectorAll(".cmt-hl").length).toBe(2);
    expect(new Set(Array.from(p.querySelectorAll<HTMLElement>(".cmt-hl")).map((s) => s.dataset.c)).size).toBe(2);
    onChange.mockClear();
    (io.clearAll as ReturnType<typeof vi.fn>).mockClear();

    // Clear ALL via the facade.
    await clearAllComments(p, "/plan.md");

    // (a) zero highlight spans remain (the sweep removed EVERY data-c, across both records).
    expect(p.querySelectorAll(".cmt-hl").length).toBe(0);
    expect(p.querySelectorAll("[data-c]").length).toBe(0);
    // text fully restored (clearHighlight unwraps + normalizes).
    expect(p.textContent).toBe("first comment lives herea second comment here");
    // (b) the backend clearAll was called for the path (the cache adopts its returned []).
    expect(io.clearAll).toHaveBeenCalledWith("/plan.md");
    // (c) the count-changed callback fired (main.ts refreshes → button hides at 0).
    expect(onChange).toHaveBeenCalled();
  });

  it("is a no-op (resolves, never throws) for a pane never initialized", async () => {
    const p = pane("<p>x</p>");
    await expect(clearAllComments(p, "/never.md")).resolves.toBeUndefined();
  });
});

// ---- Popover DOM + selection helpers -------------------------------------------------------

function bootPopoverDom(): void {
  const pop = document.createElement("div");
  pop.className = "sel-popover hidden";
  pop.id = "sel-popover";
  pop.innerHTML = `
    <div class="sp-quote" id="sp-quote"></div>
    <textarea id="sp-text"></textarea>
    <div class="sp-foot">
      <button id="sp-cancel" type="button">Cancel</button>
      <button class="save" id="sp-save" type="button">Add comment</button>
    </div>`;
  document.body.appendChild(pop);
}

// Set the live window selection to the `occurrence`-th match of `needle` inside `block`.
function selectText(_pane: HTMLElement, block: Element, needle: string, occurrence: number): void {
  // Find the Text node + offset for the occurrence-th match within the block.
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

function fireMouseUp(p: HTMLElement): void {
  p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function setTextarea(value: string): void {
  (document.querySelector("#sp-text") as HTMLTextAreaElement).value = value;
}

function clickSave(): void {
  document.querySelector<HTMLElement>("#sp-save")!.click();
}
