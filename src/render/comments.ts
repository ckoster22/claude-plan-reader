// Sub-Plan 02 — highlight + comment with quoted-text anchoring + persistence.
//
// This module is the ENTIRE highlight/comment/popover domain. It lives BEHIND the render
// facade (src/render/index.ts re-exports its public surface) so main.ts never reaches into
// #reading-pane for this feature. `renderInto` stays a pure markdown→HTML transform — none of
// this logic touches it.
//
// Anchoring strategy (survives renderInto's innerHTML wipe on live-reload / plan-switch):
//   - `quote`       = normalized selected text (whitespace-collapsed, trimmed).
//   - `block_line`  = data-source-line of the nearest enclosing block (null ⇒ whole-pane scan).
//   - `occurrence`  = 0-based Nth match of `quote` within the chosen root.
// `block_line` is a 0-based index into the frontmatter-stripped body and is consistent across
// reloads (capture and re-apply both read the same read_plan_contents output) → it is the
// natural disambiguator. `block_line + occurrence` together are the minimal deterministic key.
//
// IO is INJECTED (`CommentsIO`) so this module is unit-testable in jsdom with no Tauri.

import type { CommentRecord } from "../types";

// ---- Injected IO (main.ts wires these to Tauri invoke calls) -------------------------------
//
// `save` and `clearAll` return the AUTHORITATIVE resulting array (the backend does pure
// full-array replacement), so the frontend adopts the return value as its cache — divergence
// between the cache and the backend is unrepresentable after any mutation.
export interface CommentsIO {
  load: (path: string) => Promise<CommentRecord[]>;
  save: (path: string, comments: CommentRecord[]) => Promise<CommentRecord[]>;
  clearAll: (path: string) => Promise<CommentRecord[]>;
}

// ---- Pure helpers --------------------------------------------------------------------------

/**
 * Collapse internal whitespace runs to a single space and trim. Markdown→HTML inserts
 * inconsistent whitespace between inline elements, so both capture and re-apply normalize
 * before comparing — the SAME normalization on both sides is what makes occurrence matching
 * deterministic across the innerHTML wipe.
 */
export function normalizeQuote(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The nearest ancestor (inclusive of an element node, else its parent) carrying a
 * `data-source-line` attribute, or null if none exists up to (and excluding) `root`.
 * Returns the numeric source line, or null when there is no block ancestor.
 */
export function nearestBlock(node: Node, root: HTMLElement): number | null {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el !== root.parentNode) {
    if (el instanceof HTMLElement) {
      const sl = el.getAttribute("data-source-line");
      if (sl !== null && sl !== "") {
        const n = Number(sl);
        if (Number.isInteger(n)) return n;
      }
    }
    if (el === root) break;
    el = el.parentNode;
  }
  return null;
}

/** True iff `node` (or an ancestor up to `root`) is a fenced code block or a mermaid/SVG node. */
function isExcludedContainer(node: Node, root: HTMLElement): boolean {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el !== root.parentNode) {
    if (el instanceof Element) {
      const tag = el.tagName.toLowerCase();
      // Fenced code interiors: <pre><code> (whitespace-normalized matching is unreliable in
      // hljs-highlighted code). Inline <code> in prose is NOT excluded.
      if (tag === "code" && el.parentElement && el.parentElement.tagName.toLowerCase() === "pre") {
        return true;
      }
      // Mermaid box / SVG selections.
      if (tag === "svg" || el.classList.contains("mermaid-box") || el.classList.contains("mermaid-viewport")) {
        return true;
      }
    }
    el = el.parentNode;
  }
  return false;
}

// ---- Text-walk anchoring -------------------------------------------------------------------
//
// We build a normalized character map over the search root's text nodes: each output char
// records which Text node it came from and the offset within that node. We then search the
// normalized text for the `occurrence`-th match of the (normalized) quote and translate the
// match's start/end back to (node, offset) DOM positions to build a Range.

interface CharMapEntry {
  node: Text;
  offset: number;
}

interface NormalizedMap {
  text: string; // normalized text (single-spaced)
  map: CharMapEntry[]; // one entry per char in `text`, mapping to a DOM (node, offset)
}

/**
 * Build a single-space-normalized character map over `root`'s text nodes, SKIPPING text inside
 * excluded containers (fenced code / mermaid / svg). Whitespace runs collapse to a single space
 * whose map entry points at the FIRST whitespace char (a stable, deterministic choice).
 */
function buildNormalizedMap(root: HTMLElement): NormalizedMap {
  const text: string[] = [];
  const map: CharMapEntry[] = [];
  let lastWasSpace = true; // leading whitespace is trimmed (matches normalizeQuote's trim)

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      return isExcludedContainer(n, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });

  let tn = walker.nextNode() as Text | null;
  while (tn) {
    const raw = tn.data;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (/\s/.test(ch)) {
        if (!lastWasSpace) {
          text.push(" ");
          map.push({ node: tn, offset: i });
          lastWasSpace = true;
        }
        // else: collapse into the previous space (no new entry).
      } else {
        text.push(ch);
        map.push({ node: tn, offset: i });
        lastWasSpace = false;
      }
    }
    tn = walker.nextNode() as Text | null;
  }

  // Drop a single trailing collapsed space (trim) if present.
  if (text.length > 0 && text[text.length - 1] === " ") {
    text.pop();
    map.pop();
  }

  return { text: text.join(""), map };
}

/**
 * Build a DOM Range for the `occurrence`-th match of `quote` within `root`, or null when the
 * root is missing or the occurrence is not found (caller skips silently — the record persists
 * and may re-anchor on a later reload). PURE w.r.t. side effects (only reads the DOM).
 */
export function findRangeForRecord(root: HTMLElement | null, quote: string, occurrence: number): Range | null {
  if (!root) return null;
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return null;

  const { text, map } = buildNormalizedMap(root);

  // Find the occurrence-th match.
  let from = 0;
  let found = -1;
  for (let n = 0; n <= occurrence; n++) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) return null;
    found = idx;
    from = idx + 1; // overlapping-safe stepping
  }
  if (found < 0) return null;

  const startEntry = map[found];
  const endEntry = map[found + needle.length - 1];
  if (!startEntry || !endEntry) return null;

  const range = document.createRange();
  range.setStart(startEntry.node, startEntry.offset);
  // end offset is exclusive → +1 past the last matched char.
  range.setEnd(endEntry.node, endEntry.offset + 1);
  return range;
}

/**
 * Wrap a Range in highlight spans WITHOUT `range.surroundContents` (which throws on a partially
 * selected non-Text node — exactly the nested-inline <code>/<strong>/<a> case). Instead split
 * each covered Text node at the range boundaries and wrap each covered slice in its own
 * `<span class="cmt-hl" data-c="{id}">`. A multi-element selection therefore yields multiple
 * SIBLING spans sharing one `data-c` — structurally valid, never crossing element boundaries.
 */
export function wrapRange(range: Range, id: number): void {
  // Collect the Text nodes that intersect the range FIRST (mutating during the walk would
  // invalidate the walker). Then split + wrap each.
  const root = range.commonAncestorContainer;
  const rootEl: Node = root.nodeType === Node.ELEMENT_NODE ? root : (root.parentNode as Node);

  const texts: Text[] = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  let tn = walker.nextNode() as Text | null;
  while (tn) {
    if (range.intersectsNode(tn)) texts.push(tn);
    tn = walker.nextNode() as Text | null;
  }

  for (const textNode of texts) {
    let node = textNode;
    // Clip the leading part if this node holds the range start.
    if (node === range.startContainer && range.startOffset > 0) {
      node = node.splitText(range.startOffset);
    }
    // Clip the trailing part if this node holds the range end.
    if (node === range.endContainer) {
      // After a possible leading split, the end offset shifts when start/end share a node.
      const endOffset =
        textNode === range.endContainer && textNode === range.startContainer
          ? range.endOffset - range.startOffset
          : range.endOffset;
      if (endOffset < node.data.length) {
        node.splitText(endOffset);
      }
    }
    if (node.data.length === 0) continue;
    const span = document.createElement("span");
    span.className = "cmt-hl";
    span.dataset.c = String(id);
    node.parentNode?.insertBefore(span, node);
    span.appendChild(node);
  }
}

/**
 * TOTAL + IDEMPOTENT unwrap of ALL highlight spans for `id`. Finds EVERY `[data-c="id"]` span
 * (a multi-element selection produced several siblings), replaces each with its children, then
 * `normalize()`s so adjacent Text nodes re-merge (textContent fully restored, zero orphans).
 */
export function clearHighlight(paneEl: HTMLElement, id: number): void {
  const spans = Array.from(paneEl.querySelectorAll<HTMLElement>(`[data-c="${id}"]`));
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
  }
  paneEl.normalize();
}

/**
 * Re-apply every record's highlight into a freshly-rendered pane. For each record the search
 * root is `block_line === null ? paneEl : paneEl.querySelector('[data-source-line="N"]')` — the
 * nullable type makes the whole-pane branch STRUCTURAL (no sentinel test). A missing block or an
 * un-found occurrence is SKIPPED silently (record persists; may re-anchor on a later reload).
 */
export function applyComments(paneEl: HTMLElement, records: CommentRecord[]): void {
  for (const rec of records) {
    const root =
      rec.block_line === null
        ? paneEl
        : paneEl.querySelector<HTMLElement>(`[data-source-line="${rec.block_line}"]`);
    const range = findRangeForRecord(root, rec.quote, rec.occurrence);
    if (!range) continue;
    wrapRange(range, rec.id);
  }
}

// ---- Popover state machine -----------------------------------------------------------------
//
// A discriminated union so "visible-but-no-subject" and "both-create-and-view" are
// unrepresentable. The `create` arm carries its live Range + capture; `view` carries only an
// existing record id. Visibility is `kind !== "hidden"` (no separate boolean to drift).
type PopoverState =
  | { kind: "hidden" }
  | { kind: "create"; range: Range; quote: string; blockLine: number | null; occurrence: number }
  | { kind: "view"; id: number };

// A capture snapshot taken at mouseup (everything needed to build a record on save).
interface Capture {
  range: Range;
  quote: string;
  blockLine: number | null;
  occurrence: number;
}

// ---- Public init ---------------------------------------------------------------------------

// Callbacks fired AFTER an in-pane save/clear mutation is requested (NOT on open/reload
// re-apply). main.ts registers one via onCommentCountChanged. The callback receives the path that
// was MUTATED plus the AUTHORITATIVE post-mutation count (the just-mutated cache array's length) so
// main.ts can apply it directly — it must NOT cold-re-read get_comment_count here, because the
// backend write (io.save / io.clearAll) has not necessarily been observed yet at fire time, so a
// cold read would race the not-yet-landed write and return a stale count.
//
// The `path` is carried because a mutation's IPC (e.g. clearAll's clear_comments) can still be in
// flight when the user switches plans; without the path, a stale FOREIGN-plan callback resolving
// after the switch would clobber/strand the now-open plan's count (a cross-plan race). main.ts
// commits the count ONLY when `path` is the currently-open plan (see applyCommentCount).
type CountChangedCb = (path: string, count: number) => void;
const countChangedCbs: CountChangedCb[] = [];

/**
 * Register a callback fired after a save/clear mutation with the MUTATED path + the authoritative
 * post-mutation comment count for that path. main.ts applies the count to the button only when the
 * mutated path is the currently-open plan.
 */
export function onCommentCountChanged(cb: CountChangedCb): void {
  countChangedCbs.push(cb);
}

function fireCountChanged(path: string, count: number): void {
  for (const cb of countChangedCbs) cb(path, count);
}

/**
 * Wire selection→popover, save/clear flows, and the per-path comment cache. IO-free (injected).
 * `getPlanPath` is a LIVE reader (`() => openPath`) — the sanctioned sidebar→pane crossing, a
 * reader handed to the facade, never reverse pane access.
 */
export function initComments(
  paneEl: HTMLElement,
  getPlanPath: () => string | null,
  io: CommentsIO,
): void {
  // Per-path cache. The cache is ALWAYS the last backend-confirmed value (adopted from
  // load/save/clear return values), so divergence is unrepresentable after any mutation.
  const cache = new Map<string, CommentRecord[]>();

  // Popover DOM (outside #reading-pane — survives the pane's innerHTML wipe).
  const popEl = document.querySelector<HTMLElement>("#sel-popover");
  const quoteEl = document.querySelector<HTMLElement>("#sp-quote");
  const textEl = document.querySelector<HTMLTextAreaElement>("#sp-text");
  const cancelEl = document.querySelector<HTMLElement>("#sp-cancel");
  const saveEl = document.querySelector<HTMLElement>("#sp-save");

  let state: PopoverState = { kind: "hidden" };

  // ---- The SOLE writer of #sel-popover.hidden / #sp-quote / #sp-text ----
  // Every transition sets `state` then calls this. "popover visible iff kind!=='hidden'" is
  // structurally enforced because nothing else toggles `.hidden`.
  function renderPopover(next: PopoverState): void {
    state = next;
    if (!popEl) return;
    // Narrow on `next` (the parameter) — narrowing a reassigned closure variable is not
    // reliable, but `next` is a fresh const-like binding TS narrows precisely.
    if (next.kind === "hidden") {
      popEl.classList.add("hidden");
      return;
    }
    if (next.kind === "create") {
      if (quoteEl) quoteEl.textContent = `"${clampSnippet(next.quote)}"`;
      if (textEl) textEl.value = "";
      popEl.classList.remove("hidden");
      positionPopover(popEl, next.range);
      textEl?.focus();
      return;
    }
    // kind === "view": show the existing quote + comment, offer a clear action.
    const viewed = currentRecords().find((r) => r.id === next.id);
    if (quoteEl) quoteEl.textContent = viewed ? `"${clampSnippet(viewed.quote)}"` : "";
    if (textEl) textEl.value = viewed ? viewed.comment : "";
    popEl.classList.remove("hidden");
  }

  function currentRecords(): CommentRecord[] {
    const path = getPlanPath();
    if (path === null) return [];
    return cache.get(path) ?? [];
  }

  // ---- Cache loading ----
  async function loadCommentsFor(path: string): Promise<CommentRecord[]> {
    const recs = await io.load(path);
    cache.set(path, recs);
    return recs;
  }

  // ---- Mint a collision-free id (max existing id + 1; NOT Date.now()) ----
  function mintId(recs: CommentRecord[]): number {
    let max = -1;
    for (const r of recs) if (r.id > max) max = r.id;
    return max + 1;
  }

  // ---- Add a comment: optimistic cache+wrap, save, adopt returned array, fire onChange ----
  async function addComment(path: string, capture: Capture, comment: string): Promise<void> {
    const existing = cache.get(path) ?? [];
    const rec: CommentRecord = {
      quote: normalizeQuote(capture.quote),
      block_line: capture.blockLine,
      occurrence: capture.occurrence,
      comment,
      id: mintId(existing),
    };
    const next = [...existing, rec];
    cache.set(path, next);
    // Wrap the stashed range immediately (the pane is live; data-c keyed by the minted id).
    wrapRange(capture.range, rec.id);
    // Fire with the MUTATED path + the authoritative post-add count (the new array length). The
    // backend write (io.save) below has NOT happened yet, so this count — not a cold
    // get_comment_count — is the truth main.ts must apply (if `path` is still the open plan).
    fireCountChanged(path, next.length);
    try {
      const confirmed = await io.save(path, next);
      cache.set(path, confirmed); // adopt the authoritative array (cache == backend value).
    } catch (e) {
      console.error("set_comments failed", e);
    }
  }

  // ---- Clear a single comment (view-mode): splice the record, unwrap spans, save, fire ----
  async function clearComment(path: string, id: number): Promise<void> {
    const existing = cache.get(path) ?? [];
    const next = existing.filter((r) => r.id !== id);
    cache.set(path, next);
    clearHighlight(paneEl, id);
    // Mutated path + authoritative post-clear count (before the backend write is awaited below).
    fireCountChanged(path, next.length);
    try {
      const confirmed = await io.save(path, next);
      cache.set(path, confirmed);
    } catch (e) {
      console.error("set_comments (clear one) failed", e);
    }
  }

  // ---- Clear ALL comments for a plan (Sub-Plan 03 feedback overlay's "Clear" action) ----
  // Remove EVERY highlight span by iterating the CACHED record ids and calling clearHighlight for
  // each — this MUST happen BEFORE clearing the cache, because io.clearAll returns [] (the ids are
  // only known from the cache). Then clearAll on the backend, adopt the returned [] into the cache,
  // and fire onCountChanged (main.ts refreshes the count → the button hides at 0).
  async function clearAll(path: string): Promise<void> {
    const existing = cache.get(path) ?? [];
    for (const rec of existing) clearHighlight(paneEl, rec.id);
    try {
      const confirmed = await io.clearAll(path);
      cache.set(path, confirmed); // adopt the authoritative [] (cache == backend value).
    } catch (e) {
      console.error("clear_comments failed", e);
      cache.set(path, []); // local intent already applied (highlights unwrapped); keep cache in sync.
    }
    // Clear-all always leaves zero comments → authoritative count is 0 (button hides, IF this is
    // still the open plan; main.ts no-ops a stale foreign-plan clear-all fire).
    fireCountChanged(path, 0);
  }

  // ---- Capture from the current selection (returns null if it must be rejected) ----
  function captureSelection(): Capture | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const rawText = sel.toString();
    if (normalizeQuote(rawText).length === 0) return null;

    // Must be wholly within the pane.
    if (!paneEl.contains(range.startContainer) || !paneEl.contains(range.endContainer)) return null;

    // Reject fenced-code / mermaid / svg selections at capture (either endpoint).
    if (isExcludedContainer(range.startContainer, paneEl) || isExcludedContainer(range.endContainer, paneEl)) {
      return null;
    }

    // Clamp to a single block: start/end must resolve to the SAME [data-source-line] block
    // (or both to whole-pane null). A cross-block selection is rejected (no popover).
    const startBlock = nearestBlock(range.startContainer, paneEl);
    const endBlock = nearestBlock(range.endContainer, paneEl);
    if (startBlock !== endBlock) return null;

    const blockLine = startBlock;
    const quote = normalizeQuote(rawText);

    // occurrence = count of `quote` matches in the chosen root BEFORE the selection's start.
    const root = blockLine === null ? paneEl : paneEl.querySelector<HTMLElement>(`[data-source-line="${blockLine}"]`);
    const occurrence = countOccurrencesBefore(root, quote, range);

    return { range, quote, blockLine, occurrence };
  }

  // ---- Listeners (the single-applier funnel: each sets state then renderPopover) ----
  paneEl.addEventListener("mouseup", () => {
    // Defer so the selection is finalized.
    const capture = captureSelection();
    if (!capture) {
      // Don't hide on a plain click that is NOT a selection — only an explicit cancel/outside
      // click hides. A click with no selection simply leaves the popover as-is.
      return;
    }
    renderPopover({
      kind: "create",
      range: capture.range,
      quote: capture.quote,
      blockLine: capture.blockLine,
      occurrence: capture.occurrence,
    });
  });

  // Delegated click on a highlight span → view mode for that data-c.
  paneEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    const hl = target?.closest<HTMLElement>(".cmt-hl");
    if (!hl) return;
    const id = Number(hl.dataset.c);
    if (!Number.isInteger(id)) return;
    e.stopPropagation();
    renderPopover({ kind: "view", id });
  });

  cancelEl?.addEventListener("click", () => renderPopover({ kind: "hidden" }));

  saveEl?.addEventListener("click", () => {
    const path = getPlanPath();
    if (path === null) {
      renderPopover({ kind: "hidden" });
      return;
    }
    if (state.kind === "create") {
      const capture: Capture = {
        range: state.range,
        quote: state.quote,
        blockLine: state.blockLine,
        occurrence: state.occurrence,
      };
      const comment = textEl?.value ?? "";
      void addComment(path, capture, comment);
      renderPopover({ kind: "hidden" });
    } else if (state.kind === "view") {
      // In view mode, the save button acts as "clear this comment".
      void clearComment(path, state.id);
      renderPopover({ kind: "hidden" });
    }
  });

  // Escape hides + discards.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.kind !== "hidden") renderPopover({ kind: "hidden" });
  });

  // Outside-click hides + discards (a click outside the pane AND outside the popover).
  document.addEventListener("mousedown", (e) => {
    if (state.kind === "hidden") return;
    const t = e.target as Node | null;
    if (popEl && t && popEl.contains(t)) return; // inside the popover
    if (paneEl.contains(t as Node)) return; // inside the pane (handled by mouseup/click)
    renderPopover({ kind: "hidden" });
  });

  // Expose loadCommentsFor + clearAll to the facade-level exports (main.ts calls them via the
  // facade). Each is a per-pane closure (over `cache`, `io`, `paneEl`, `fireCountChanged`) looked
  // up by pane element so the facade re-exports a single thin wrapper without leaking the cache.
  loaderRegistry.set(paneEl, loadCommentsFor);
  clearAllRegistry.set(paneEl, clearAll);
}

// ---- Facade-level loader registry ----------------------------------------------------------
//
// main.ts calls `loadCommentsFor(path)` inside its guarded region. We keep the per-pane loader
// here (closed over the cache) and expose a thin module-level lookup so the facade can re-export
// a single `loadCommentsFor` without leaking the cache.
const loaderRegistry = new WeakMap<HTMLElement, (path: string) => Promise<CommentRecord[]>>();

/** Load (and cache) the comments for `path` against the pane initialized via initComments. */
export function loadCommentsFor(paneEl: HTMLElement, path: string): Promise<CommentRecord[]> {
  const loader = loaderRegistry.get(paneEl);
  if (!loader) return Promise.resolve([]);
  return loader(path);
}

// ---- Facade-level clear-all registry (mirrors loaderRegistry) -------------------------------
//
// main.ts calls `clearAllComments(paneEl, path)` from the feedback overlay's "Clear" action. The
// per-pane closure (registered in initComments, closed over the cache) removes every highlight by
// cached id, clears the backend, adopts [] into the cache, and fires onCountChanged. We expose a
// thin module-level lookup so the facade can re-export a single `clearAllComments` without leaking
// the cache — the exact same pattern as loaderRegistry / loadCommentsFor.
const clearAllRegistry = new WeakMap<HTMLElement, (path: string) => Promise<void>>();

/** Clear ALL comments + highlights for `path` against the pane initialized via initComments. */
export function clearAllComments(paneEl: HTMLElement, path: string): Promise<void> {
  const clear = clearAllRegistry.get(paneEl);
  if (!clear) return Promise.resolve();
  return clear(path);
}

// ---- Small pure helpers (snippet clamp + occurrence-before counting) -----------------------

/** Clamp a quote to a short snippet for the popover header (display only). */
function clampSnippet(s: string): string {
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

/**
 * Count how many full matches of `quote` occur in `root`'s normalized text BEFORE the
 * selection's start position. This is the 0-based `occurrence` for the captured selection.
 */
function countOccurrencesBefore(root: HTMLElement | null, quote: string, range: Range): number {
  if (!root) return 0;
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return 0;

  const { text, map } = buildNormalizedMap(root);

  // Find the normalized-text index of the selection's start (node, offset).
  let startIdx = -1;
  for (let i = 0; i < map.length; i++) {
    const entry = map[i];
    if (entry.node === range.startContainer && entry.offset >= range.startOffset) {
      startIdx = i;
      break;
    }
    // If the start container is the same node and we've passed its offset region, the first
    // entry at-or-after the offset wins (handled above).
  }
  if (startIdx < 0) startIdx = text.length; // fall back to "all before"

  // Count non-overlapping matches that END at or before startIdx (i.e. occur before selection).
  let count = 0;
  let from = 0;
  while (true) {
    const idx = text.indexOf(needle, from);
    if (idx < 0 || idx >= startIdx) break;
    count++;
    from = idx + 1;
  }
  return count;
}

// ---- Positioning (UN-UNIT-TESTED DOM adapter) ----------------------------------------------
//
// jsdom has no layout, so getBoundingClientRect() returns zeros — positioning is carved into
// this adapter that unit tests do NOT assert against (consistent with scroll.ts's convention).
function positionPopover(popEl: HTMLElement, range: Range): void {
  try {
    const rect = range.getBoundingClientRect();
    popEl.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    popEl.style.top = `${rect.bottom + 8 + window.scrollY}px`;
  } catch {
    // No layout (jsdom) — leave the popover at its default position.
  }
}
