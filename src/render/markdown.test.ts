import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown — fence rules", () => {
  it("renders a mermaid fence as a .mermaid-src placeholder carrying the source, not <pre><code>", () => {
    const src = "```mermaid\ngraph TD; A-->B;\n```\n";
    const html = renderMarkdown(src);
    expect(html).toContain('class="mermaid-src"');
    expect(html).toContain("data-source-line=");
    // The diagram source is preserved verbatim in the body.
    expect(html).toContain("graph TD; A--&gt;B;");
    // It must NOT be wrapped as a normal code block.
    expect(html).not.toContain("<pre><code");
    expect(html).not.toContain("mermaid-src</code>");
  });

  it("renders a rust fence with hljs classes and a data-source-line", () => {
    const src = "```rust\nfn main() { let x = 1; }\n```\n";
    const html = renderMarkdown(src);
    expect(html).toContain("hljs");
    expect(html).toMatch(/<pre data-source-line="\d+" data-source-end-line="\d+"><code class="hljs/);
    // highlight.js wraps tokens in spans with hljs-* classes.
    expect(html).toContain("hljs-keyword");
  });
});

describe("renderMarkdown — GFM tables", () => {
  it("renders a pipe table as a <table>", () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const html = renderMarkdown(src);
    // Table is rendered as an HTML <table> (it also carries a source-line stamp).
    expect(html).toMatch(/<table( data-source-line="\d+" data-source-end-line="\d+")?>/);
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });
});

describe("renderMarkdown — source-line stamping", () => {
  it("stamps headings with data-source-line", () => {
    const src = "intro\n\n## Section Two\n\ntext\n";
    const html = renderMarkdown(src);
    // The h2 opens on source line index 2 (0-based) — assert the attr exists on
    // an h2 regardless of exact number.
    expect(html).toMatch(/<h2 data-source-line="\d+" data-source-end-line="\d+">Section Two<\/h2>/);
  });

  it("stamps the first heading with the correct 0-based source line", () => {
    const src = "# Title\n\nbody\n";
    const html = renderMarkdown(src);
    expect(html).toContain('<h1 data-source-line="0" data-source-end-line="1">Title</h1>');
  });

  it("stamps a paragraph with BOTH data-source-line and data-source-end-line (token.map [start,end))", () => {
    // Source lines (0-based): 0="# H", 1="", 2="para A", 3="para B", 4="" (trailing newline).
    // markdown-it token.map is 0-based, end-EXCLUSIVE. The paragraph spans source lines 2 and 3,
    // so its map is [2, 4): start=2 (data-source-line), end=4 (data-source-end-line). Hand-counted
    // from markdown-it semantics, NOT copied from code output.
    const src = "# H\n\npara A\npara B\n";
    const html = renderMarkdown(src);
    const host = document.createElement("div");
    host.innerHTML = html;
    const p = host.querySelector("p");
    expect(p).not.toBeNull();
    expect(p!.getAttribute("data-source-line")).toBe("2");
    expect(p!.getAttribute("data-source-end-line")).toBe("4");
  });
});

describe("renderMarkdown — GFM task lists", () => {
  // Parse the rendered HTML in jsdom so assertions target real DOM, not strings.
  function firstLi(html: string): HTMLLIElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    const li = host.querySelector("li");
    if (!li) throw new Error("no <li> rendered");
    return li as HTMLLIElement;
  }

  it("renders `- [ ] todo` as an UNCHECKED checkbox input with the item text", () => {
    const li = firstLi(renderMarkdown("- [ ] todo\n"));
    const box = li.querySelector('input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(li.textContent).toContain("todo");
  });

  it("renders `- [x] done` as a CHECKED checkbox input with the item text", () => {
    const li = firstLi(renderMarkdown("- [x] done\n"));
    const box = li.querySelector('input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(li.textContent).toContain("done");
  });

  it("renders a plain list item `- plain` with NO checkbox", () => {
    const li = firstLi(renderMarkdown("- plain\n"));
    expect(li.querySelector('input[type="checkbox"]')).toBeNull();
    expect(li.textContent).toContain("plain");
  });

  it("renders task checkboxes as DISABLED (read-only viewer)", () => {
    const li = firstLi(renderMarkdown("- [ ] todo\n"));
    const box = li.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });
});

describe("renderMarkdown — links", () => {
  it("marks external links with data-external and leaves anchors alone", () => {
    const html = renderMarkdown("[ext](https://example.com) and [in](#sec)");
    expect(html).toContain('data-external="1"');
    expect(html).toContain('href="https://example.com"');
    // intra-doc anchor must NOT be marked external
    expect(html).toMatch(/<a href="#sec">/);
  });
});

describe("renderMarkdown — link-scheme XSS posture (markdown-it default validateLink)", () => {
  // The reading pane's "SAFE" verdict rests entirely on markdown-it's DEFAULT
  // validateLink (the config sets html:false but no custom validateLink). That
  // default strips dangerous schemes to plain text — NO anchor is emitted — so
  // a prompt-injected plan can't smuggle a script-bearing href into the pane.
  // These tests guard that posture. If markdown-it were configured with
  // validateLink: () => true, the javascript: assertion below goes red
  // (verified by temporarily toggling it).
  // markdown-it strips the scheme by refusing to build the <a> at all — the
  // dangerous URL never appears as an href. (The literal `[x](scheme:...)`
  // source text survives as inert paragraph text, which carries no executable
  // payload; the security property is the absence of an anchor/href.)
  it("strips a javascript: link — no anchor / no executable href", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("strips a vbscript: link — no anchor / no executable href", () => {
    const html = renderMarkdown("[x](vbscript:msgbox(1))");
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/href="vbscript:/);
  });

  it("strips a data:text/html link — no anchor / no executable href", () => {
    const html = renderMarkdown("[x](data:text/html,<b>hi</b>)");
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/href="data:text\/html/);
  });

  it("DOES emit an anchor for a benign https link (proves the test isn't trivially satisfied)", () => {
    const html = renderMarkdown("[x](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
  });
});
