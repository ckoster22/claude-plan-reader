// ---- Sidebar filter (Fix 1) — pure, testable core -----------------------------------------
//
// The sidebar filter narrows the Plans list by a free-text query that ORs across each plan's
// TITLE (filename_stem), its working DIR (cwd), and its H1 HEADINGS (h1s, sourced from the
// backend). This module is pure: it takes records + a query and returns the filtered list, and
// it builds highlighted DOM safely. It NEVER queries `#reading-pane` (the filter reads `h1s`
// straight off the in-memory records — honoring the sidebar↔reading-pane disjointness in
// CONTRACT.md) and it never touches the Contents/ToC tab.

import type { PlanRecord } from "./types";

// Case-insensitive substring predicate. An EMPTY or whitespace-only query matches everything
// (the unfiltered list). Otherwise the (lower-cased) query must appear in the title, the cwd,
// or ANY of the plan's H1 headings.
export function matchesQuery(record: PlanRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true; // empty query ⇒ everything matches

  const title = String(record.filename_stem).toLowerCase();
  if (title.includes(q)) return true;

  if (record.cwd && record.cwd.toLowerCase().includes(q)) return true;

  for (const h of record.h1s) {
    if (h.toLowerCase().includes(q)) return true;
  }
  return false;
}

// Filter the mtime-ordered record stream: keep each record iff it matches the query. An empty
// query keeps every record (matchesQuery returns true for all).
export function filterRecords(records: PlanRecord[], query: string): PlanRecord[] {
  return records.filter((r) => matchesQuery(r, query));
}

// Set `el`'s content to `text`, wrapping the FIRST case-insensitive occurrence of `query` in a
// single `<mark>`. Builds DOM text nodes (NOT innerHTML string concat), so a `<` in `text`
// renders as literal text, never markup. No match or an empty/whitespace query ⇒ plain text
// (no `<mark>`). Used only for the visible title (`.plan-title`) and cwd (`.plan-src`) — a
// heading-only match shows the row un-highlighted (the heading text is not displayed).
export function highlightInto(el: HTMLElement, text: string, query: string): void {
  el.replaceChildren();
  const q = query.trim();
  if (q === "") {
    el.appendChild(document.createTextNode(text));
    return;
  }
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) {
    el.appendChild(document.createTextNode(text));
    return;
  }
  const before = text.slice(0, idx);
  const matched = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  if (before) el.appendChild(document.createTextNode(before));
  const mark = document.createElement("mark");
  mark.textContent = matched;
  el.appendChild(mark);
  if (after) el.appendChild(document.createTextNode(after));
}

// The `#plan-count` text for the filtered state: "N of M" when filtering, where N = shown and
// M = total. An empty/whitespace query falls back to the unfiltered "M file(s)" form so the
// idle display is unchanged. Pure so the count format is unit-testable.
export function planCountText(shown: number, total: number, query: string): string {
  if (query.trim() === "") {
    return `${total} file${total === 1 ? "" : "s"}`;
  }
  return `${shown} of ${total}`;
}
