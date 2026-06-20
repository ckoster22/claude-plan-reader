// Table-of-contents extraction from the rendered reading pane.
//
// This is the ONE sanctioned read-only data flow from the reading-pane domain to
// the sidebar domain (CLAUDE.md / CONTRACT.md keep those domains disjoint). The
// render layer PRODUCES a plain `TocEntry[]`; the sidebar CONSUMES it to build
// `#toc-list`. The sidebar never queries `#reading-pane` itself.
//
// Anchoring reuses the existing `data-source-line` attribute that markdown.ts
// already stamps on every heading (the SAME anchor key captureAnchor/applyDelta
// use). `extractToc` is strictly READ-ONLY on the pane — it mints no new id or
// attribute, so it never becomes a second writer of `#reading-pane` and never
// creates positionally-stale keys across live reloads.

/** A single ToC row: an H1 or H2 from the rendered pane. */
export interface TocEntry {
  /** Heading depth — only H1 and H2 are surfaced. */
  level: 1 | 2;
  /** Visible heading text (trimmed); `"(untitled)"` when the heading is empty. */
  text: string;
  /** The heading's existing `data-source-line` value (the scroll anchor key). */
  line: number;
}

/** Placeholder text for a heading with no visible text (e.g. image-only). */
const UNTITLED = "(untitled)";

/**
 * Walk the rendered pane for `h1, h2` in document order and return a plain
 * `TocEntry[]`. Read-only: records each heading's existing `data-source-line`
 * and trimmed `textContent` (falling back to `"(untitled)"` when empty). H3–H6
 * are excluded. Mints NO attributes on the pane.
 */
export function extractToc(paneEl: HTMLElement): TocEntry[] {
  const entries: TocEntry[] = [];
  const headings = paneEl.querySelectorAll<HTMLElement>("h1, h2");
  for (const el of Array.from(headings)) {
    const level: 1 | 2 = el.tagName === "H1" ? 1 : 2;
    const raw = el.textContent?.trim();
    const text = raw && raw.length > 0 ? raw : UNTITLED;
    const line = Number(el.getAttribute("data-source-line"));
    entries.push({ level, text, line });
  }
  return entries;
}
