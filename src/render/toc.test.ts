import { describe, it, expect } from "vitest";
import { extractToc } from "./toc";

// Build a pane element from an HTML string (jsdom). The headings carry the SAME
// data-source-line attribute markdown.ts stamps in production, so these tests
// exercise the real anchor key, not a contrived one.
function pane(html: string): HTMLElement {
  const el = document.createElement("div");
  el.id = "reading-pane";
  el.innerHTML = html;
  return el;
}

describe("extractToc — H1/H2 only, in document order", () => {
  it("returns exactly the h1 + h2 entries (h3 EXCLUDED), with correct levels/text/order/line", () => {
    const el = pane(
      `<h1 data-source-line="0">Title</h1>` +
        `<h2 data-source-line="3">Section A</h2>` +
        `<h3 data-source-line="5">Sub A</h3>` +
        `<h2 data-source-line="8">Section B</h2>`,
    );
    const toc = extractToc(el);

    // Exactly 3 entries — the h3 is excluded.
    expect(toc).toHaveLength(3);
    expect(toc.map((e) => e.level)).toEqual([1, 2, 2]);
    expect(toc.map((e) => e.text)).toEqual(["Title", "Section A", "Section B"]);
    expect(toc.map((e) => e.line)).toEqual([0, 3, 8]);
  });
});

describe("extractToc — empty-heading placeholder", () => {
  it("uses the '(untitled)' placeholder for a heading with empty textContent (never a blank row)", () => {
    const el = pane(`<h2 data-source-line="4"></h2>`);
    const toc = extractToc(el);
    expect(toc).toHaveLength(1);
    expect(toc[0].text).toBe("(untitled)");
    // Guard the falsification: the placeholder is non-empty.
    expect(toc[0].text).not.toBe("");
  });

  it("trims surrounding whitespace from heading text", () => {
    const el = pane(`<h1 data-source-line="0">  Padded Title  </h1>`);
    expect(extractToc(el)[0].text).toBe("Padded Title");
  });
});

describe("extractToc — empty pane", () => {
  it("returns [] for a pane with no headings", () => {
    expect(extractToc(pane("<p data-source-line=\"0\">body</p>"))).toEqual([]);
  });
});

describe("extractToc — read-only (no pane mutation)", () => {
  it("mints NO id and adds NO attribute to any heading after extraction", () => {
    const el = pane(
      `<h1 data-source-line="0">Title</h1>` +
        `<h2 data-source-line="3">Section</h2>`,
    );
    const before = Array.from(el.querySelectorAll<HTMLElement>("h1, h2")).map(
      (h) => h.getAttributeNames().sort().join(","),
    );

    extractToc(el);

    const after = Array.from(el.querySelectorAll<HTMLElement>("h1, h2")).map(
      (h) => h.getAttributeNames().sort().join(","),
    );
    // Attribute sets are unchanged — no new `id`, no new anything.
    expect(after).toEqual(before);
    // And specifically: no heading gained an `id`.
    for (const h of Array.from(el.querySelectorAll<HTMLElement>("h1, h2"))) {
      expect(h.hasAttribute("id")).toBe(false);
    }
  });
});
