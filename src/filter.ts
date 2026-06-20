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

// Filter the pre-ordered record stream, PRESERVING the master→sub nesting so a matched sub is
// never orphaned. The flat `records` array is the display-ordered stream from `list_plans`:
// each master (flavor "master" with child_count >= 1) is IMMEDIATELY followed by its subs
// (flavor "sub"), then standalones / 0-child masters render flat (see CONTRACT.md
// §"Pre-ordering guarantee"). We walk it as groups:
//   - a master group = the master record + the run of "sub" records that follow it;
//   - any other record (standalone, or a 0-child master) is its own single-record group.
// Inclusion rules:
//   - standalone/flat: included iff it matches.
//   - master group: if the MASTER matches ⇒ keep the master AND all its subs (the block renders
//     intact, "subs may follow"). Else if ANY sub matches ⇒ keep the master (so the matched sub
//     keeps its parent — never an orphan) plus the matching subs AND every ANCESTOR prefix row of
//     each match (dotted trees: a matching "02.01.03" retains "02" and "02.01" too — the sidebar's
//     prefix-stack walk would otherwise log the survivor as a LOUD orphan and render it flat).
//     Else ⇒ drop the whole group.
// An empty query keeps every record (matchesQuery returns true for all).
export function filterRecords(records: PlanRecord[], query: string): PlanRecord[] {
  const out: PlanRecord[] = [];
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    const isExpandableMaster = rec.flavor === "master" && (rec.child_count ?? 0) >= 1;

    if (!isExpandableMaster) {
      // Standalone or 0-child (flat) master: a single-record group.
      if (matchesQuery(rec, query)) out.push(rec);
      i += 1;
      continue;
    }

    // Master group: gather the contiguous run of subs following this master.
    const subs: PlanRecord[] = [];
    let j = i + 1;
    while (j < records.length && records[j].flavor === "sub") {
      subs.push(records[j]);
      j += 1;
    }

    const masterMatches = matchesQuery(rec, query);
    if (masterMatches) {
      // Master matches ⇒ keep the whole block intact.
      out.push(rec, ...subs);
    } else {
      const matchedSubs = subs.filter((s) => matchesQuery(s, query));
      if (matchedSubs.length > 0) {
        // A sub matched ⇒ keep its master (no orphan) + the matching subs + ANCESTOR RETENTION:
        // every sub whose dotted nn_path is a PROPER PREFIX of a match's nn_path (its parent
        // chain), so a filtered dotted tree never orphans — the sidebar nests the survivor under
        // its real ancestors instead of flat-rendering it loudly. Original order is preserved by
        // re-filtering `subs` (never by pushing matches out of sequence).
        const keep = new Set<PlanRecord>(matchedSubs);
        for (const m of matchedSubs) {
          if (!m.nn_path) continue; // a legacy sub with no dotted id has no representable ancestors
          for (const s of subs) {
            if (s.nn_path && m.nn_path.startsWith(`${s.nn_path}.`)) keep.add(s);
          }
        }
        out.push(rec, ...subs.filter((s) => keep.has(s)));
      }
      // else: neither master nor any sub matched ⇒ drop the group entirely.
    }

    i = j;
  }
  return out;
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
