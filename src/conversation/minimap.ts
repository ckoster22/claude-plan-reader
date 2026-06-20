// Conversation Minimap (right-margin navigator).
//
// Self-contained: pure geometry/classification + a thin DOM controller. The pure functions are the
// tested seam (jsdom returns 0 for offset geometry, so the controller is intentionally thin and not
// unit-tested under jsdom — see minimap.test.ts).
//
// Tiering: every top-level message block is mapped to one of three tiers — user bubbles, assistant
// text, and everything else (tool/system rows, subagent groups) as "meta". Block heights are
// proportional to each child's rendered offsetHeight, contiguously tiled to fill the gutter.

export type MiniTier = "user" | "assistant" | "meta" | "danger";

export interface MiniBlock {
  /** Cumulative top offset within the minimap gutter (px). */
  top: number;
  /** Block height within the gutter (px). */
  height: number;
  tier: MiniTier;
  /** Position of the source child in the input array. */
  index: number;
}

/** Minimum visible block height (px), applied only when the budget allows (see computeBlocks). */
export const MIN_BLOCK_PX = 3;

/**
 * Inter-block gap (px), applied at PAINT time only — NOT in computeBlocks (which stays contiguous so
 * its pure tests and click-target tops are unchanged). Each painted block's height is shrunk by this
 * amount (floored so tiny blocks never go negative), leaving the gap below it while `top` is kept
 * exactly as computed.
 */
const GAP_PX = 6;

/** Minimum painted block height (px) after the gap is subtracted. */
const MIN_PAINT_PX = 2;

/** Minimum viewport-indicator height (px). */
export const MIN_VIEWPORT_PX = 8;

/**
 * Classify a top-level stream child into a tier. PURE.
 *
 * User bubbles carry BOTH `conv-text` and `conv-text-user` (render.ts), so `conv-text-user` MUST be
 * tested FIRST — otherwise a user bubble matches `conv-text` and is mislabeled "assistant".
 *
 * System (plumbing) bubbles likewise carry BOTH `conv-text` and `conv-text-system`. They are NOT the
 * human's words and NOT the assistant's — they belong in the gray "meta" tier, so `conv-text-system`
 * MUST also be tested BEFORE the `conv-text` → assistant fallthrough.
 *
 * An AskUserQuestion card (`conv-question`, render.ts) IS human-input solicitation — the human's
 * choice is captured there — so it belongs in the orange "user" tier alongside user bubbles. It
 * carries NEITHER `conv-text` nor `conv-text-user` (it is not a text bubble), so it must be matched
 * by its own class here; mapping it to "user" gives it the user-tier minimap color WITHOUT touching
 * the card's own DOM/classes (NOT done via `conv-text-user`, which carries user-BUBBLE styling —
 * accent-soft fill, right-alignment, inset margin — that would visually corrupt the card).
 */
// Loud, session-critical failure rows get the "danger" (red) tier so they are the EASIEST blocks to
// find in the navigator, not the dimmest. Three kinds qualify (render.ts): `conv-error` (diagnostic
// or, with `conv-error-fatal`, session-ending — the fatal variant always ALSO carries `conv-error`,
// so the base check covers both); `conv-perm-denied` (a denied tool); and a FAILED result, whose
// element carries BOTH `conv-result` and `conv-result-error`. The `conv-result-error` check MUST be
// specific — plain success `conv-result` and `conv-result conv-result-interrupted` are NOT failures
// and MUST stay "meta", so we match `conv-result-error` (never bare `conv-result`).
export function classifyTier(el: Element): MiniTier {
  const cl = el.classList;
  if (cl.contains("conv-text-user")) return "user";
  if (cl.contains("conv-question")) return "user";
  if (cl.contains("conv-error")) return "danger";
  if (cl.contains("conv-perm-denied")) return "danger";
  if (cl.contains("conv-result-error")) return "danger";
  if (cl.contains("conv-text-system")) return "meta";
  if (cl.contains("conv-text")) return "assistant";
  return "meta";
}

/**
 * Compute contiguously-tiled minimap blocks from each mapped child's rendered height. PURE.
 *
 * Each block's `top` is the cumulative sum of prior block heights, so blocks never overlap and never
 * gap — they tile the gutter in proportion to each child's rendered offsetHeight.
 *
 * Floor-vs-budget reconciliation:
 *   - Base height = (child.height / totalContent) * mapHeight (pure proportional).
 *   - A MIN_BLOCK_PX floor keeps tiny messages visible, BUT it can push the cumulative total past
 *     mapHeight. So the floor is applied only when it fits the budget:
 *       * If `N * MIN_BLOCK_PX > mapHeight`, the floor cannot possibly fit → drop it (pure proportional).
 *       * Otherwise apply the floor; if the floored total STILL exceeds mapHeight (heterogeneous mix
 *         where many tiny blocks get floored), fall back to pure proportional.
 *   In all cases the cumulative total never exceeds mapHeight: no overflow, no overlap, no clipped tail.
 *
 * Edge cases: empty input → []; totalContent === 0 → [] (documented choice — nothing meaningful to
 * tile); mapHeight <= 0 → [].
 */
export function computeBlocks(
  children: { height: number; tier: MiniTier }[],
  mapHeight: number,
): MiniBlock[] {
  if (children.length === 0) return [];
  if (mapHeight <= 0) return [];
  const totalContent = children.reduce((sum, c) => sum + c.height, 0);
  if (totalContent <= 0) return [];

  const n = children.length;
  const proportional = (h: number): number => (h / totalContent) * mapHeight;

  // Decide whether the MIN_BLOCK_PX floor fits the budget at all.
  let useFloor = n * MIN_BLOCK_PX <= mapHeight;
  if (useFloor) {
    // Even when N*MIN fits, applying the floor to individual small blocks can push the total over
    // (each floored block gains pixels). Verify the floored total fits; otherwise drop the floor.
    let flooredTotal = 0;
    for (const c of children) {
      flooredTotal += Math.max(proportional(c.height), MIN_BLOCK_PX);
    }
    if (flooredTotal > mapHeight) useFloor = false;
  }

  const blocks: MiniBlock[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const child = children[i];
    let h = proportional(child.height);
    if (useFloor) h = Math.max(h, MIN_BLOCK_PX);
    // Clamp the tail so the cumulative total never exceeds mapHeight (defends against fp drift).
    if (cursor + h > mapHeight) h = mapHeight - cursor;
    blocks.push({ top: cursor, height: h, tier: child.tier, index: i });
    cursor += h;
  }
  return blocks;
}

/**
 * Compute the viewport-indicator rectangle within the gutter. PURE.
 *
 * height = (clientHeight / scrollHeight) * mapHeight, clamped to [MIN_VIEWPORT_PX, mapHeight].
 * top    = (scrollTop / scrollHeight) * mapHeight, clamped so top + height <= mapHeight.
 *
 * When the content fits (scrollHeight <= clientHeight) or scrollHeight <= 0, the indicator spans the
 * full gutter: { top: 0, height: mapHeight }.
 */
export function computeViewport(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  mapHeight: number,
): { top: number; height: number } {
  if (mapHeight <= 0) return { top: 0, height: 0 };
  if (scrollHeight <= 0 || scrollHeight <= clientHeight) {
    return { top: 0, height: mapHeight };
  }
  const rawHeight = (clientHeight / scrollHeight) * mapHeight;
  const height = Math.min(Math.max(rawHeight, MIN_VIEWPORT_PX), mapHeight);
  const rawTop = (scrollTop / scrollHeight) * mapHeight;
  const top = Math.min(Math.max(rawTop, 0), mapHeight - height);
  return { top, height };
}

// ---------------------------------------------------------------------------------------------
// DOM controller (thin adapter — NOT unit-tested under jsdom; the pure functions above are the seam).
// ---------------------------------------------------------------------------------------------

export interface MinimapController {
  rebuild(): void;
  destroy(): void;
}

/**
 * Build the minimap DOM controller. Reads each mapped child's offset geometry + tier from the live
 * DOM, computes blocks via the pure functions, and paints them; keeps the viewport indicator in sync
 * on scroll/resize/mutation. All layout reads happen in a single pass BEFORE any write (reflow
 * discipline), and rebuilds are coalesced to one per animation frame.
 *
 * Defensive: if either element is missing, returns a no-op controller.
 */
export function createMinimap(
  streamEl: HTMLElement | null | undefined,
  minimapEl: HTMLElement | null | undefined,
): MinimapController {
  if (!streamEl || !minimapEl) {
    return { rebuild: () => {}, destroy: () => {} };
  }
  const stream = streamEl;
  const minimap = minimapEl;

  // index → source child offsetTop, captured at paint for click-to-scroll (do NOT re-read live DOM
  // at click time — that risks a mismatch against the painted blocks).
  let blockOffsets: number[] = [];

  let rebuildRaf = 0;
  let scrollRaf = 0;
  let lastMapHeight = 0;

  function paint(): void {
    rebuildRaf = 0;
    // ---- READ ALL FIRST (single pass, no interleaved writes) ----
    const collected: { offsetTop: number; height: number; tier: MiniTier }[] = [];
    for (const child of Array.from(stream.children)) {
      if (child.classList.contains("conv-working")) continue;
      const hel = child as HTMLElement;
      collected.push({
        offsetTop: hel.offsetTop,
        height: hel.offsetHeight,
        tier: classifyTier(child),
      });
    }
    const scrollHeight = stream.scrollHeight;
    const clientHeight = stream.clientHeight;
    const scrollTop = stream.scrollTop;
    // Measure the gutter height from the STREAM, not the minimap. The minimap can carry `is-empty`
    // (display:none → clientHeight 0), which self-deadlocks: once empty it can never measure a
    // nonzero height to recover. The stream is visible whenever the conversation pane is active and
    // is never the element that gets `is-empty`, and the gutter is laid out to the same height as the
    // stream (both stretch in .conv-stream-wrap), so streamEl.clientHeight is the correct, recoverable
    // gutter height for the compress-to-fit minimap.
    const mapHeight = stream.clientHeight;
    lastMapHeight = mapHeight;

    // ---- COMPUTE ----
    const blocks = computeBlocks(
      collected.map((c) => ({ height: c.height, tier: c.tier })),
      mapHeight,
    );
    const vp = computeViewport(scrollTop, clientHeight, scrollHeight, mapHeight);

    // ---- WRITE ----
    if (blocks.length === 0) {
      minimap.classList.add("is-empty");
      minimap.replaceChildren();
      blockOffsets = [];
      return;
    }
    minimap.classList.remove("is-empty");

    const offsets: number[] = [];
    const nodes: HTMLElement[] = [];
    for (const block of blocks) {
      const div = document.createElement("div");
      div.className = "conv-minimap-block";
      div.dataset.tier = block.tier;
      div.style.top = `${block.top}px`;
      // Paint a 6px gap below each block by shrinking its height (top stays exactly as computed so
      // positions and click targets are unchanged); floor so tiny blocks never go negative.
      div.style.height = `${Math.max(MIN_PAINT_PX, block.height - GAP_PX)}px`;
      nodes.push(div);
      offsets.push(collected[block.index].offsetTop);
    }
    blockOffsets = offsets;

    const viewport = document.createElement("div");
    viewport.className = "conv-minimap-viewport";
    viewport.style.top = `${vp.top}px`;
    viewport.style.height = `${vp.height}px`;

    minimap.replaceChildren(...nodes, viewport);
  }

  function rebuild(): void {
    if (rebuildRaf !== 0) return; // coalesce — one rebuild per frame
    rebuildRaf = requestAnimationFrame(paint);
  }

  function repositionViewport(): void {
    scrollRaf = 0;
    const viewport = minimap.querySelector<HTMLElement>(".conv-minimap-viewport");
    if (!viewport) return;
    // Stream-derived gutter height — consistent with paint() (see the note there).
    const mapHeight = stream.clientHeight;
    const vp = computeViewport(
      stream.scrollTop,
      stream.clientHeight,
      stream.scrollHeight,
      mapHeight,
    );
    viewport.style.top = `${vp.top}px`;
    viewport.style.height = `${vp.height}px`;
  }

  function onScroll(): void {
    if (scrollRaf !== 0) return; // rAF-throttle
    scrollRaf = requestAnimationFrame(repositionViewport);
  }

  function onClick(ev: MouseEvent): void {
    const target = ev.target as Element | null;
    const blockEl = target?.closest?.(".conv-minimap-block") as HTMLElement | null;
    if (blockEl && minimap.contains(blockEl)) {
      // Find the painted block's index by its DOM position among block siblings.
      const blockNodes = minimap.querySelectorAll(".conv-minimap-block");
      const idx = Array.prototype.indexOf.call(blockNodes, blockEl);
      if (idx >= 0 && idx < blockOffsets.length) {
        stream.scrollTo({ top: blockOffsets[idx], behavior: "smooth" });
      }
      return;
    }
    // Empty-track click → proportional jump. Stream-derived gutter height (consistent with paint()).
    const mapHeight = lastMapHeight || stream.clientHeight;
    if (mapHeight <= 0) return;
    const rect = minimap.getBoundingClientRect();
    const offsetY = ev.clientY - rect.top;
    const top = (offsetY / mapHeight) * stream.scrollHeight;
    stream.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  // Observers: gutter-height changes (resize) and content-height changes that bypass rerender
  // (notably tool-row expand/collapse, which changes scrollHeight but not the stream's box size).
  const resizeObserver = new ResizeObserver(() => rebuild());
  resizeObserver.observe(minimap);

  const mutationObserver = new MutationObserver(() => rebuild());
  mutationObserver.observe(stream, { childList: true, subtree: true, attributes: true });

  stream.addEventListener("scroll", onScroll, { passive: true });
  minimap.addEventListener("click", onClick);

  function destroy(): void {
    stream.removeEventListener("scroll", onScroll);
    minimap.removeEventListener("click", onClick);
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    if (rebuildRaf !== 0) {
      cancelAnimationFrame(rebuildRaf);
      rebuildRaf = 0;
    }
    if (scrollRaf !== 0) {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
    }
  }

  return { rebuild, destroy };
}
