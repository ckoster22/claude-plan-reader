// Reading-pane render facade. main.ts talks only to this module.
//
// Two phases keep the sync-render / async-asset boundary explicit:
//  - renderInto(): SYNCHRONOUS. Sets innerHTML from markdown-it, drops the .raw
//    class, wires the link handler once. Returns immediately so the scroll-restore
//    can run against the freshly-laid-out TEXT-ONLY layout before slow assets
//    (local images, mermaid SVG) shift heights.
//  - settle(): ASYNC. Resolves local image data: URLs FIRST (so placeholders get
//    real srcs before we wait on them), then renders mermaid diagrams, then awaits
//    all images (load/error with a per-image timeout). Callers re-apply the scroll
//    anchor after this so height changes from images/diagrams don't drift the view.

import { renderMarkdown } from "./markdown";
import { attachLinkHandler } from "./links";
import { resolveLocalImages, awaitImages } from "./assets";
import { renderDiagrams, destroyControllers } from "./mermaid";

import "highlight.js/styles/github-dark.css";

// Re-export the read-only ToC extraction surface so main.ts (sidebar domain)
// talks only to this render facade — never to `src/render/toc` directly.
export { extractToc } from "./toc";
export type { TocEntry } from "./toc";

// Highlight/comment surface. main.ts talks only to this facade for the comment
// feature; all popover/highlight/anchoring logic lives behind it in `./comments`. renderInto
// stays a pure transform (NO highlight logic added here).
export { applyComments, initComments, onCommentCountChanged, loadCommentsFor, clearAllComments } from "./comments";
export type { CommentsIO } from "./comments";

// The plan dir is captured at renderInto time and consumed by settle(), so the
// caller doesn't have to thread it through both calls.
const planDirs = new WeakMap<HTMLElement, string>();

/**
 * Synchronously render markdown into the pane. NO async work is started here —
 * local image resolution happens in settle() — so the caller's first applyDelta()
 * runs against a stable text-only layout.
 */
export function renderInto(
  paneEl: HTMLElement,
  markdown: string,
  planDir: string,
): void {
  // Tear down the PREVIOUS render's pan/zoom controllers at the EXACT moment we
  // destroy the DOM (and the `.mermaid-viewport` elements they bound `window`
  // drag listeners to). Doing this here — tied to the innerHTML wipe — means
  // teardown runs on every DOM-wipe path regardless of whether the async
  // settle()/renderDiagrams() that follows completes or throws. (renderDiagrams
  // still calls destroyControllers at its top as an idempotent safety net.)
  // NOTE: this runs ONLY when the pane is actually wiped. A read error in
  // openPlan/reloadOpenPlan that leaves the previous plan on screen never calls
  // renderInto, so that plan's controllers stay live and interactive — exactly
  // what we want (the old diagram is still shown).
  destroyControllers(paneEl);
  paneEl.innerHTML = renderMarkdown(markdown);
  paneEl.classList.remove("raw");
  attachLinkHandler(paneEl);
  planDirs.set(paneEl, planDir);
}

/**
 * Await the slow parts in order:
 *  1. resolveLocalImages — swap in real data: URLs for local <img> placeholders.
 *     MUST run (and be awaited) BEFORE awaitImages, otherwise placeholders still
 *     have empty src and awaitImages would treat them as already-complete.
 *  2. renderDiagrams — render mermaid SVGs in place (failures isolated, never reject).
 *  3. awaitImages — wait until every resolved <img> has fired load/error (bounded
 *     by a per-image timeout) so async height growth is settled.
 */
export async function settle(
  paneEl: HTMLElement,
  imageTimeoutMs?: number,
): Promise<void> {
  const planDir = planDirs.get(paneEl) ?? "";
  await resolveLocalImages(paneEl, planDir);
  await renderDiagrams(paneEl);
  await awaitImages(paneEl, imageTimeoutMs);
}
