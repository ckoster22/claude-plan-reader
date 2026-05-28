// Element-anchored scroll restore.
//
// Raw scrollTop restore drifts when content above the viewport changes height
// (e.g. an inserted paragraph, or a mermaid diagram that finishes rendering and
// grows). Instead we anchor on the source line of the first visible block:
// before reload we capture which markdown line is at the top of the viewport and
// its pixel offset; after re-render (and again after async settle) we find the
// element nearest that line and scroll so it sits back at the same offset.
//
// The math is a PURE numeric function (computeScrollDelta) because jsdom has no
// layout — getBoundingClientRect returns zeros — so the testable core takes
// plain numbers. The DOM adapters (captureAnchor / applyDelta) read real rects
// and are not unit-tested.

export interface ScrollAnchor {
  /** Source line of the anchored block (from data-source-line). */
  line: number;
  /** Pixels the block's top sat below the container top when captured. */
  offset: number;
}

export interface LineCandidate {
  line: number;
  /** The candidate element's top, in the same coordinate space as containerTop. */
  top: number;
}

/**
 * PURE. Given the captured anchor, the current candidate blocks (their source
 * lines + tops), the container's top edge, and the current scrollTop, return the
 * scrollTop that puts the chosen candidate's top back at `anchor.offset` px below
 * the container top.
 *
 * Candidate selection: the candidate whose `line` is nearest `anchor.line`
 * (ties broken toward the earlier/smaller line). Returns `currentScrollTop`
 * unchanged when there are no candidates.
 *
 *   newScrollTop = currentScrollTop + (chosenTop - containerTop) - anchor.offset
 */
export function computeScrollDelta(
  anchor: ScrollAnchor,
  candidates: LineCandidate[],
  containerTop: number,
  currentScrollTop: number,
): number {
  if (candidates.length === 0) return currentScrollTop;

  let chosen = candidates[0];
  let bestDist = Math.abs(chosen.line - anchor.line);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const dist = Math.abs(c.line - anchor.line);
    // Strictly-less keeps the first (earlier) candidate on ties.
    if (dist < bestDist) {
      bestDist = dist;
      chosen = c;
    }
  }

  return currentScrollTop + (chosen.top - containerTop) - anchor.offset;
}

// ---- DOM adapters (not unit-tested; jsdom lacks layout) ----

/**
 * Capture the first block at/just below the container's top edge as the anchor.
 * Returns null when nothing is found (e.g. empty pane) — callers guard for it.
 */
export function captureAnchor(scrollEl: HTMLElement): ScrollAnchor | null {
  const containerTop = scrollEl.getBoundingClientRect().top;
  const blocks = scrollEl.querySelectorAll<HTMLElement>("[data-source-line]");

  let best: { line: number; offset: number } | null = null;
  for (const el of Array.from(blocks)) {
    const lineAttr = el.getAttribute("data-source-line");
    if (lineAttr === null || lineAttr === "") continue;
    const line = Number(lineAttr);
    if (!Number.isFinite(line)) continue;

    const top = el.getBoundingClientRect().top;
    const offset = top - containerTop;
    // First block whose top is at or below the container top wins (it's the one
    // anchored at the viewport top). offset >= 0.
    if (offset >= 0) {
      best = { line, offset };
      break;
    }
    // Otherwise keep the last block above the top as a fallback (partially
    // scrolled-past block) — overwritten until we find one at/below.
    best = { line, offset };
  }

  return best;
}

/**
 * Re-derive candidate rects from the pane and scroll so the anchored line sits
 * back at its captured offset. No-op when anchor is null.
 */
export function applyDelta(scrollEl: HTMLElement, anchor: ScrollAnchor | null): void {
  if (!anchor) return;
  const containerTop = scrollEl.getBoundingClientRect().top;
  const blocks = scrollEl.querySelectorAll<HTMLElement>("[data-source-line]");

  const candidates: LineCandidate[] = [];
  for (const el of Array.from(blocks)) {
    const lineAttr = el.getAttribute("data-source-line");
    if (lineAttr === null || lineAttr === "") continue;
    const line = Number(lineAttr);
    if (!Number.isFinite(line)) continue;
    candidates.push({ line, top: el.getBoundingClientRect().top });
  }

  const next = computeScrollDelta(
    anchor,
    candidates,
    containerTop,
    scrollEl.scrollTop,
  );
  scrollEl.scrollTop = Math.max(0, next);
}

/**
 * Smooth-scroll the pane so the heading carrying `data-source-line="<line>"`
 * sits at the top of the scroll container. Resolves the heading by the SAME
 * source-line anchor key the ToC records (no minted ids). Rect-based target
 * computed in the `applyDelta` style. No-op when no matching heading exists
 * (e.g. a stale ToC entry after a live reload removed the heading).
 *
 * A DOM adapter — not unit-tested under jsdom (no layout / no rects).
 */
export function scrollToHeading(
  scrollEl: HTMLElement,
  paneEl: HTMLElement,
  line: number,
): void {
  const heading = paneEl.querySelector<HTMLElement>(
    `h1[data-source-line="${line}"], h2[data-source-line="${line}"]`,
  );
  if (!heading) return;
  const containerTop = scrollEl.getBoundingClientRect().top;
  const headingTop = heading.getBoundingClientRect().top;
  const target = scrollEl.scrollTop + (headingTop - containerTop);
  scrollEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}
