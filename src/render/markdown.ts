// Configured markdown-it singleton for the reading pane.
//
// Renderer-rule overrides:
//  - fence: `mermaid` lang -> <pre class="mermaid-src"> carrying the raw diagram
//    source (NOT a <pre><code>); every other lang -> highlight.js highlighted
//    `.md pre` block. Both stamp data-source-line from the token's source map.
//  - image: rewrite local srcs to a deferred-resolution placeholder so an async
//    pass can swap in a data: URL after insertion (markdown-it render is sync).
//  - link_open: external (http(s)/mailto) links get data-external="1".
//  - source-line stamping: every block-open token with a `.map` carries
//    data-source-line so the scroll-restore can anchor on real elements.
//  - GFM task lists: a small custom core rule rewrites leading `[ ]` / `[x]`
//    in list items into a DISABLED checkbox <input> (read-only viewer). No
//    external plugin — the project already drives everything via custom rules,
//    and disabled-by-construction keeps the viewer non-interactive. Works with
//    html:false because the checkbox is emitted via tokens, not raw HTML.

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import hljs from "highlight.js";
import { isExternalHref } from "./links";

// Build the singleton.
function buildMd(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    // NOTE: no `highlight` option here on purpose. The custom fence rule below
    // fully replaces `md.renderer.rules.fence` and re-implements highlighting
    // via `hljs.highlight`, so a constructor `highlight` callback would never
    // execute. Omitting it keeps a single source of truth for code highlighting.
  });

  const esc = md.utils.escapeHtml;

  // ---- fence rule (code blocks ```lang ... ```) ----
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : "";
    const lang = info.split(/\s+/g)[0] || "";
    const sourceLine = token.map ? String(token.map[0]) : "";
    const sourceEndLine = token.map ? String(token.map[1]) : "";

    if (lang === "mermaid") {
      // Carry the diagram SOURCE verbatim (escaped) — rendered later by mermaid.ts.
      return (
        `<pre class="mermaid-src" data-source-line="${sourceLine}" data-source-end-line="${sourceEndLine}">` +
        esc(token.content) +
        `</pre>\n`
      );
    }

    // Syntax-highlighted code block. Prefer the configured highlight() output;
    // if empty (no language / failure), escape the raw content.
    let highlighted = "";
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(token.content, {
          language: lang,
          ignoreIllegals: true,
        }).value;
      } catch {
        highlighted = "";
      }
    }
    const body = highlighted || esc(token.content);
    const langClass = lang ? ` language-${esc(lang)}` : "";
    return (
      `<pre data-source-line="${sourceLine}" data-source-end-line="${sourceEndLine}"><code class="hljs${langClass}">` +
      body +
      `</code></pre>\n`
    );
  };

  // ---- image rule ----
  // markdown-it render is synchronous; we cannot await invoke() here. Remote /
  // data: srcs are emitted directly; everything else becomes a placeholder that
  // assets.ts resolves asynchronously after the HTML is inserted.
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIdx = token.attrIndex("src");
    if (srcIdx >= 0 && token.attrs) {
      const src = token.attrs[srcIdx][1];
      if (
        src.startsWith("http://") ||
        src.startsWith("https://") ||
        src.startsWith("data:")
      ) {
        // Remote / inline — leave src untouched.
      } else {
        // Local — defer resolution. Stash the original src + remove the live
        // src so the browser doesn't try to fetch a non-existent file.
        token.attrSet("data-resolve", "1");
        token.attrSet("data-local-src", src);
        token.attrs[srcIdx][1] = ""; // blank src placeholder
      }
    }
    return defaultImage
      ? defaultImage(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };

  // ---- link_open rule ----
  const defaultLinkOpen = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIdx = token.attrIndex("href");
    if (hrefIdx >= 0 && token.attrs) {
      const href = token.attrs[hrefIdx][1];
      if (isExternalHref(href)) {
        token.attrSet("data-external", "1");
      }
      // intra-doc `#anchor` links are left untouched.
    }
    return defaultLinkOpen
      ? defaultLinkOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };

  // ---- source-line stamping ----
  // Wrap renderToken so every top-level block-open token with a `.map` gets a
  // data-source-line attribute. fence handles its own stamping above (it does
  // not go through renderToken), so this covers headings, paragraphs, lists,
  // tables, blockquotes, etc.
  const defaultRenderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, idx, options) => {
    const token = tokens[idx];
    if (
      token.map &&
      token.nesting === 1 && // opening tag only
      token.type.endsWith("_open")
    ) {
      // Don't clobber an explicit attr, and only stamp block-level tokens
      // (inline tokens have null .map so they never reach here anyway).
      if (token.attrIndex("data-source-line") < 0) {
        token.attrSet("data-source-line", String(token.map[0]));
      }
      // Also stamp the end line (markdown-it map is [start, end) 0-based). Feedback
      // reads this off prose blocks to render a line range; fenced blocks are
      // comment-excluded so their end-line is never read, but it is stamped above
      // for contract symmetry.
      if (token.attrIndex("data-source-end-line") < 0) {
        token.attrSet("data-source-end-line", String(token.map[1]));
      }
    }
    return defaultRenderToken(tokens, idx, options);
  };

  // ---- GFM task lists ----
  // A core rule that runs after block+inline parsing. For each list item whose
  // first inline content starts with `[ ]`, `[x]`, or `[X]`, strip that marker
  // and prepend a DISABLED checkbox <input> (read-only viewer — the user must
  // not toggle it, and rendering never depends on toggling). We mark the <li>
  // and its parent <ul>/<ol> so CSS can suppress the bullet/number on task
  // items without affecting normal lists.
  const CHECKBOX_RE = /^\[([ xX])\]([ \t]|$)/;
  md.core.ruler.after("inline", "gfm_task_lists", (state) => {
    const tokens = state.tokens;
    // Track the open list token so we can flag it once a task item is found.
    const listStack: Array<{ token: Token }> = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
        listStack.push({ token: t });
        continue;
      }
      if (t.type === "bullet_list_close" || t.type === "ordered_list_close") {
        listStack.pop();
        continue;
      }
      if (t.type !== "list_item_open") continue;

      // The list item's text lives in the inline token of its first paragraph.
      // Layout: list_item_open, paragraph_open, inline, ... — find that inline.
      const inlineTok = tokens[i + 2];
      if (
        !inlineTok ||
        inlineTok.type !== "inline" ||
        tokens[i + 1]?.type !== "paragraph_open" ||
        !inlineTok.children ||
        inlineTok.children.length === 0
      ) {
        continue;
      }
      const firstChild = inlineTok.children[0];
      if (firstChild.type !== "text") continue;
      const m = CHECKBOX_RE.exec(firstChild.content);
      if (!m) continue;

      const checked = m[1] === "x" || m[1] === "X";

      // Strip the `[ ]`/`[x]` marker (and the single trailing space) from the
      // visible text.
      firstChild.content = firstChild.content.slice(m[0].length);

      // Build a disabled checkbox token and splice it to the front of the
      // inline content. html_inline lets us emit the <input> markup even though
      // the parser runs with html:false (this is our own trusted markup).
      const box = new state.Token("html_inline", "", 0);
      box.content =
        `<input class="task-checkbox" type="checkbox" disabled` +
        (checked ? " checked" : "") +
        `>`;
      inlineTok.children.unshift(box);

      // Flag the <li> and its enclosing list so CSS can drop the marker.
      t.attrJoin("class", "task-list-item");
      const list = listStack[listStack.length - 1];
      if (list) {
        // attrJoin de-dupes-by-append; guard so repeated items don't stack the
        // class multiple times on the same list token.
        const ci = list.token.attrIndex("class");
        if (ci < 0 || !/\btask-list\b/.test(list.token.attrs![ci][1])) {
          list.token.attrJoin("class", "task-list");
        }
      }
    }
    return true;
  });

  return md;
}

let _md: MarkdownIt | null = null;

/** The configured markdown-it singleton. */
export function getMarkdown(): MarkdownIt {
  if (_md === null) _md = buildMd();
  return _md;
}

/** Render markdown source to an HTML string. */
export function renderMarkdown(src: string): string {
  return getMarkdown().render(src);
}
