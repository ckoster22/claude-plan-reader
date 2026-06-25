// Mock-ANIMATE boot + chrome — the injected entry for `npm run mock-animate`.
//
// Boots the UNMODIFIED app frontend (via vite.mock.config.ts's alias seam) and plays ONE short
// fictional "Trailhead" conversation beat INSIDE the real conversation pane, plus the surrounding host
// surfaces (reading pane, sidebar, review bar, prototype gate, active tab) — so it looks like the live
// app. The player activates the Conversation tab (clicking the app's OWN tab button so its real
// switching logic runs), mounts a player-owned container INTO the conversation-stream slot, and pins a
// transport bar (play/pause + draggable progress with chapter markers + speed control) at the bottom.
//
// ARCHITECTURE — PURE projection + FROM-SCRATCH reconciliation: the storyboard is split into MODEL
// frames (applied onto a ConversationModel) and SURFACE frames (open plan / comments / plans / reviews
// / gate). On every tick the player computes the model signature + the projected surface state at the
// scrub time T (both PURE fns of (story, T)) and hands them to the reconciler (reconcile.ts), which
// re-drives ONLY the REAL host seams whose projected value changed, rebuilding un-invertible surfaces
// from scratch (so a backward scrub correctly reverts a fire-once event with no inverse). See
// reconcile.ts for the core principle.
//
// CHOSEN SEAM (load-bearing, preserved from Slice-01): the player owns its OWN ConversationModel and
// its OWN container <div>. It NEVER renders into the production #conversation-stream — that element is
// owned by main.ts and is clobbered by loadHistoryForPlan on every sidebar click, which would wipe our
// animation. Instead the player pane is mounted as a SIBLING of #conversation-stream inside its parent
// (.conv-stream-wrap), sized to fill the same flex slot; the empty real #conversation-stream is hidden
// via a `mockanim-*` namespaced presentation style.
//
// DARK MODE: the app defaults to LIGHT; the demo must render dark deterministically, so at boot we set
// `document.documentElement.dataset.theme = "dark"` — exactly the attribute/value the app's own CSS
// keys on. Presentation set from mock code; no production file is touched.
//
// STYLE ISOLATION: a SINGLE injected <style id="mock-anim-style">; every class is prefixed
// `mockanim-`; the transport bar is position:fixed at z-index 2147483647 so it never participates in
// the app's layout.

import { ConversationModel } from "../../conversation/stream";
import { renderTree } from "../../conversation/render";
import { createMinimap } from "../../conversation/minimap";
import { invoke } from "../core";
import { setPlans, setPendingReviews } from "../state";
import { emitMockEvent } from "../event";
import { emitGate, clearGate, installMockOrchestrator } from "../orchestrator";
import { applyComments, renderInto, settle } from "../../render";
import { extractToc } from "../../render/toc";
import { buildToc } from "../../main";
import { trailheadProtoPreviewOverride } from "../fixtures/markdown";
import {
  applyUpToTime,
  storyDurationMs,
  TRAILHEAD_BEAT,
  type StoryFrame,
} from "./storyboard";
import { createReconciler } from "./reconcile";
import {
  projectActiveComments,
  tickGroups,
  denorm,
  type AnnotationDoc,
  type AnnotationComment,
  type Stroke,
} from "./annotations";
import { loadDoc, saveDoc } from "./annotations-io";
import { mountAnnotateUI, runAuthorPaintHooks } from "./annotate-ui";
import type { PlanRecord, ReviewRequest } from "../../types";

// ---- window globals: the programmatic seek hook + the author-mode flag --------------------------
//
// `window.__mockAnim` is the capture/replay control surface (exposed at the end of mountPlayer). It
// lets a headless driver land EXACTLY on a comment's tMs (vs fuzzing pixel-drags on .mockanim-progress)
// and await a fully-settled reading pane before screenshotting. `window.__MOCK_ANNOTATE` is the
// author-mode flag injected by the dev plugin (Phase 3); declared now so later phases need no re-decl.
export interface MockAnimApi {
  seekTo: (tMs: number) => void;
  seekSettled: (tMs: number) => Promise<void>;
  play: () => void;
  stop: () => void;
  getT: () => number;
  getDuration: () => number;
  loadAnnotations: (doc: AnnotationDoc | null) => void;
  getActiveComments: () => AnnotationComment[];
  focusComment: (id: string | null) => void;
}

declare global {
  interface Window {
    __mockAnim?: MockAnimApi;
    __MOCK_ANNOTATE?: boolean | undefined;
  }
}

// ---- namespaced stylesheet -------------------------------------------------------------------

const ANIM_CSS = `
/* The real #conversation-stream stays EMPTY (we never write into it). Hide it so only the
   player-owned pane shows content in the conversation slot. Namespaced to avoid colliding with the
   app's own rules; it only sets display, never touches the production element's content. */
.conv-stream-wrap > #conversation-stream.mockanim-hidden-stream {
  display: none;
}
/* The player-owned pane: a SIBLING of #conversation-stream inside .conv-stream-wrap, filling the same
   flex slot so the beat renders exactly where real conversation content would. Scrolls like the real
   stream; opaque dark background so bubbles stay legible regardless of theme. */
.conv-stream-wrap > .mockanim-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 16px;
  background: #16161a;
  color: #e8e8e8;
}
/* Fallback only: when the real conversation chrome is absent we float the pane as a card so the demo
   still plays (it is appended to <body>, NOT inside .conv-stream-wrap, hence the separate selector). */
.mockanim-pane.mockanim-pane-floating {
  position: fixed;
  right: 24px;
  bottom: 88px;
  width: min(560px, 46vw);
  max-height: 64vh;
  overflow-y: auto;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
  background: #16161a;
  color: #e8e8e8;
}
/* The transport bar — pinned bottom-center over the app, the lone fixed/max-z layer. */
#mock-anim.mockanim-root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#mock-anim .mockanim-controls {
  position: absolute;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(700px, 76vw);
  padding: 9px 14px;
  background: rgba(22, 22, 26, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  color: #e8e8e8;
  pointer-events: auto;
}
#mock-anim .mockanim-play {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
#mock-anim .mockanim-play:hover { background: rgba(255, 255, 255, 0.18); }
/* The draggable progress TRACK — pointerdown/move scrub the scrub time T. Chapter markers are absolute
   children at their tMs/duration; the fill grows from the left. */
#mock-anim .mockanim-progress {
  flex: 1 1 auto;
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.16);
  cursor: pointer;
  touch-action: none;
}
#mock-anim .mockanim-progress-fill {
  height: 100%;
  width: 0%;
  background: #6aa3ff;
  border-radius: 4px;
  pointer-events: none;
}
#mock-anim .mockanim-marker {
  position: absolute;
  top: -3px;
  width: 3px;
  height: 14px;
  margin-left: -1px;
  border-radius: 2px;
  background: #f0c674;
  cursor: pointer;
  pointer-events: auto;
}
#mock-anim .mockanim-marker:hover { background: #ffd98a; }
#mock-anim .mockanim-speed {
  flex: 0 0 auto;
  font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.85;
  min-width: 34px;
  text-align: center;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  cursor: pointer;
}
#mock-anim .mockanim-speed:hover { background: rgba(255, 255, 255, 0.16); }

/* ---- overlay primitives (cosmetic; reconciler-owned) -----------------------------------------
   All scoped to their own ids/classes so they never perturb real app layout. */

/* The simulated cursor: a fixed, max-z arrow overlay positioned via style.transform (translate +
   optional press scale composed in JS). transition smooths the 50ms tick steps. */
#demo-cursor {
  position: fixed;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  z-index: 2147483641;
  pointer-events: none;
  transition: transform 60ms linear;
  will-change: transform;
  background-repeat: no-repeat;
  background-size: contain;
  /* A classic arrow pointer (inline SVG data URL). */
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'><path d='M2 1 L2 17 L6.5 12.8 L9.4 19.2 L12 18 L9.2 11.8 L15 11.6 Z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/></svg>");
}

/* Attention pulse: a glowing outline that breathes while the element carries .demo-pulse. */
@keyframes demo-pulse {
  0% {
    outline-color: rgba(106, 163, 255, 0.0);
    box-shadow: 0 0 0 0 rgba(106, 163, 255, 0.45);
  }
  35% {
    outline-color: rgba(106, 163, 255, 0.95);
    box-shadow: 0 0 0 5px rgba(106, 163, 255, 0.28);
  }
  100% {
    outline-color: rgba(106, 163, 255, 0.0);
    box-shadow: 0 0 0 11px rgba(106, 163, 255, 0.0);
  }
}
.demo-pulse {
  animation: demo-pulse 1.1s ease-out infinite;
  border-radius: 8px;
  outline: 2px solid rgba(106, 163, 255, 0.85);
  outline-offset: 2px;
}

/* ---- annotation overlay (Phase 1: replay/capture; pure projection of (doc, T)) ----------------
   Z-ORDER STACK (load-bearing, pinned with DISTINCT numeric z — no ties — so author chrome stays
   clickable ABOVE the drawing canvas regardless of DOM append order):
     transport #mock-anim controls + #mockanim-author toolbar .. 2147483647  (TOPMOST + interactive:
                                                 clicks on the textarea/name/buttons + the scrubber must
                                                 WIN over the canvas, so these sit strictly above it.)
     #mockanim-cmt panel ......... 2147483643  (passive text panel; pointer-events:none — must NEVER
                                                 intercept clicks, sits just under the chrome.)
     #demo-annotation-canvas ..... 2147483642  (ABOVE app + #demo-cursor so strokes
                                                 paint over the screen; in author mode pointer-events:auto
                                                 to capture drawing — but strictly BELOW the toolbar/
                                                 transport so it can't eat their clicks.)
     #demo-cursor ................ 2147483641  (cosmetic; strictly below the canvas)
   The canvas + panel are pure projections re-derived every paint (back-scrub clears them like every
   other overlay). They are INERT until a doc is loaded (no doc ⇒ cleared canvas + empty panel). */
#demo-annotation-canvas {
  position: fixed;
  inset: 0;
  z-index: 2147483642;
  pointer-events: none;
  width: 100vw;
  height: 100vh;
}
#mockanim-cmt {
  position: fixed;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  z-index: 2147483643;
  pointer-events: none;
  display: none;
  flex-direction: column;
  gap: 6px;
  max-width: min(640px, 80vw);
}
#mockanim-cmt.mockanim-cmt-on { display: flex; }
#mockanim-cmt .mockanim-cmt-item {
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(22, 22, 26, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  color: #f3f3f3;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: pre-wrap;
}
/* Comment ticks on the scrubber — a distinct shape/color from the chapter .mockanim-marker so the two
   read apart. Click-to-jump (pointer-events:auto). A multi-comment tick carries a small count badge. */
#mock-anim .mockanim-cmt-tick {
  position: absolute;
  bottom: -4px;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: #8be9a8;
  border: 1px solid rgba(0, 0, 0, 0.45);
  cursor: pointer;
  pointer-events: auto;
}
#mock-anim .mockanim-cmt-tick:hover { background: #aef3c4; }
#mock-anim .mockanim-cmt-tick-badge {
  position: absolute;
  top: -14px;
  left: 50%;
  transform: translateX(-50%);
  font: 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #16161a;
  background: #8be9a8;
  border-radius: 7px;
  padding: 1px 4px;
  pointer-events: none;
}
`;

// ---- element helper (mirrors deck.ts's el()) -------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function injectStyle(): void {
  if (document.getElementById("mock-anim-style")) return;
  const style = el("style");
  style.id = "mock-anim-style";
  style.textContent = ANIM_CSS;
  document.head.appendChild(style);
}

// ---- presentation setup (dark mode + real conversation tab) ----------------------------------

// Force the app into DARK mode deterministically (the exact attribute/value the app's CSS keys on).
function forceDarkTheme(): void {
  document.documentElement.dataset.theme = "dark";
}

// Click the real tab button for `tab` so main.ts's initTabs switching logic runs (it toggles `.active`
// on the matching `.tab-pane`, and main.ts's conversation-tab click listener repaints the minimap).
// The click path is PREFERRED (it runs main.ts's real switching logic). But the click is a no-op if
// initTabs hasn't wired its listener yet (a boot-order race) — so we fall back to toggling the `.active`
// classes directly both when the button is ABSENT and when the click left the tab inactive. This mirrors
// exactly what initTabs itself does (toggle `.active` on the app's own `.tab`/`.tab-pane` elements);
// it NEVER un-hides #conversation-stream and NEVER removes `mockanim-hidden-stream`.
function clickTab(tab: "plan" | "conversation"): HTMLElement | null {
  const tabBtn = document.querySelector<HTMLElement>(`.reader-tab-row .tab[data-tab="${tab}"]`);
  const pane = document.getElementById(`tab-${tab}`);
  if (tabBtn) tabBtn.click();
  // Fallback: button absent, OR the click had no effect (no listener yet → still inactive). Toggle the
  // `.active` classes directly the way initTabs does, so activation is robust regardless of boot timing.
  if (!tabBtn || !tabBtn.classList.contains("active")) {
    const row =
      tabBtn?.closest(".reader-tab-row") ??
      pane?.closest(".reader-inner")?.querySelector(".reader-tab-row") ??
      null;
    if (row) {
      for (const t of Array.from(row.querySelectorAll<HTMLElement>(".tab"))) {
        t.classList.toggle("active", t.dataset.tab === tab);
      }
    }
    document.getElementById("tab-plan")?.classList.toggle("active", tab === "plan");
    document.getElementById("tab-conversation")?.classList.toggle("active", tab === "conversation");
  }
  return pane;
}

// Derive a plan's directory from its absolute path (mirrors main.ts's dirOf). "" → "".
function planDirOf(path: string): string {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : path;
}

// ---- playback timing -------------------------------------------------------------------------

// The wall-clock tick interval; T advances by `TICK_MS × SPEED` each tick.
const TICK_MS = 50;
// The cycle of playback speeds the speed control rotates through.
const SPEEDS = [0.5, 1, 2, 4, 8] as const;

// ---- player ----------------------------------------------------------------------------------

function mountPlayer(): void {
  // Idempotent: never mount twice (e.g. an HMR re-run).
  if (document.getElementById("mock-anim")) return;
  injectStyle();

  // AUTHOR MODE (Phase 3): the one interactive path. Gated on the injected flag OR a `?annotate=1`
  // runtime fallback. When ON: boot PAUSED, mount the author toolbar, let the canvas capture pointer
  // input, and SUPPRESS the cosmetic demo overlays (#demo-cursor / .demo-pulse) — they are demo-internal
  // presentation, not part of the screen being annotated, and the reconciler re-asserts them every tick
  // (Risk #3), so we suppress at the seam (below) and after every paint. Default/replay: authorMode is
  // false and NOTHING below changes — behavior is byte-unchanged.
  const authorMode =
    window.__MOCK_ANNOTATE === true ||
    new URLSearchParams(window.location.search).has("annotate");

  // Presentation: render the demo dark.
  forceDarkTheme();

  const story: StoryFrame[] = TRAILHEAD_BEAT;
  const duration = storyDurationMs(story);

  // The player owns its OWN model + container — never #conversation-stream.
  const model = new ConversationModel();

  // ---- player-owned pane: mounted INTO the real conversation slot ----
  const pane = el("div", "mockanim-pane");
  const stream = document.getElementById("conversation-stream");
  const wrap = stream?.parentElement ?? null;
  if (wrap) {
    stream?.classList.add("mockanim-hidden-stream");
    wrap.insertBefore(pane, stream?.nextSibling ?? null);
  } else {
    pane.classList.add("mockanim-pane-floating");
    document.body.appendChild(pane);
  }

  // ---- player-owned conversation minimap (Phase 6) ----
  // The real initConversation binds its OWN createMinimap controller to #conversation-stream — which the
  // player HIDES (mockanim-hidden-stream) and never renders into — yet that controller paints the
  // #conversation-minimap gutter node it queried at boot. Its MutationObserver/ResizeObserver re-paint
  // from the EMPTY hidden stream every tick and re-assert `.is-empty`. CRUCIALLY both controllers boot on
  // DOMContentLoaded, so a player controller bound to the SAME #conversation-minimap node is repeatedly
  // CLOBBERED back to empty by the real (empty-stream) controller (verified at runtime: two controllers
  // fighting over one node, the empty-stream one wins).
  //
  // The fix gives the player its OWN gutter node that the real controller can NEVER bind to. The original
  // #conversation-minimap is LEFT in place (the real controller keeps painting it from the empty hidden
  // stream → it stays `.is-empty` → `display:none`, invisible + harmless). We insert a SEPARATE
  // `.conv-minimap` node — id `mockanim-minimap`, identical styling (the `.conv-minimap` CLASS carries
  // all CSS; the id is never a selector) — as the VISIBLE sibling of `.mockanim-pane`, and the player's
  // controller is the SOLE writer of it. No production file, CSS, or minimap.ts is touched.
  let paneMinimap: { rebuild(): void; destroy(): void } = {
    rebuild: () => {},
    destroy: () => {},
  };
  // jsdom guard: createMinimap constructs a ResizeObserver (and a MutationObserver), which jsdom does
  // NOT define — the player-boot unit tests (e.g. capture-focus.test.ts) call mountPlayer under jsdom and
  // would throw `ResizeObserver is not defined`. The minimap is a browser/WebView-only affordance (it
  // measures real offset geometry, which jsdom reports as 0 anyway), so skip its construction when the
  // observers are unavailable — leaving the no-op `paneMinimap` stub. Real browsers (the demo, the CDP
  // harness) always have ResizeObserver, so this never skips at runtime. We do NOT modify minimap.ts.
  const observersAvailable = typeof ResizeObserver !== "undefined";
  // Idempotent across an HMR re-eval (the mountPlayer guard already blocks a second mount, but belt-and-
  // suspenders: never insert a second gutter).
  if (observersAvailable && wrap && !document.getElementById("mockanim-minimap")) {
    const playerMinimapEl = el("div", "conv-minimap");
    playerMinimapEl.id = "mockanim-minimap";
    playerMinimapEl.setAttribute("aria-hidden", "true");
    // Start hidden; the controller's first rebuild toggles `.is-empty` off once the pane has children.
    playerMinimapEl.classList.add("is-empty");
    wrap.appendChild(playerMinimapEl);
    paneMinimap = createMinimap(pane, playerMinimapEl);
  }

  // The reading pane (the production render target). May be absent in a stripped DOM (fallback null).
  const readingPane =
    document.getElementById("reading-pane") ?? document.createElement("div");

  // ---- overlay nodes: created ONCE, appended to the max-z player root layer ----
  // (Defined below; the root is built after the reconciler. We append them to <body> here so they
  // exist before the first paint; they sit at the same max-z as the transport chrome.)
  const cursorNode = el("div");
  cursorNode.id = "demo-cursor";
  cursorNode.style.display = "none";
  document.body.appendChild(cursorNode);

  // ---- annotation overlay nodes (Phase 1) ----
  // The canvas sits ABOVE #demo-cursor (it is appended AFTER it, below the transport
  // root appended later — see the z-order comment in ANIM_CSS). Both nodes are created ONCE; the player
  // is the single writer, mirroring the #demo-cursor pattern. INERT until a doc is loaded.
  const annoCanvas = el("canvas");
  annoCanvas.id = "demo-annotation-canvas";
  document.body.appendChild(annoCanvas);

  const cmtPanel = el("div");
  cmtPanel.id = "mockanim-cmt";
  document.body.appendChild(cmtPanel);

  // ---- annotation in-memory state (Phase 1: no persistence) ----
  // The active doc, or null when none is loaded (the default — the overlay is then fully INERT). The
  // player is the single writer via loadAnnotations(); the overlay is a PURE projection of (currentDoc, T)
  // re-derived every paint, so a back-scrub clears it like every other reconciler-owned overlay.
  let currentDoc: AnnotationDoc | null = null;

  // Capture-isolation focus (Phase 4): when non-null, the CANVAS + panel render path shows ONLY the
  // comment with this id (passed as `projectActiveComments`'s `onlyId` arg), so the capture script can
  // shoot one clean frame per comment even when several share a tMs. null (the default) = normal
  // window-based projection → byte-unchanged replay/author behavior. The player is the single writer
  // via focusComment(); `getActiveComments()` stays window-based (NOT gated on this).
  let captureFocusId: string | null = null;

  // Draw one stroke (already-denormalized to the current viewport) onto a 2D context. pen = polyline
  // through all points; arrow = points[0]→points[1] with a small arrowhead; box = rect points[0]..[1].
  const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke, vw: number, vh: number): void => {
    const pts = stroke.points.map((p) => denorm(p, vw, vh));
    if (pts.length === 0) return;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (stroke.tool === "pen") {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      return;
    }
    if (pts.length < 2) return;
    const [x0, y0] = pts[0];
    const [x1, y1] = pts[1];
    if (stroke.tool === "box") {
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      return;
    }
    // arrow: the shaft + a small arrowhead at the end, sized to the stroke width.
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = Math.max(8, stroke.width * 3);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  };

  // Render the overlay as a PURE fn of (currentDoc, T): size+clear the canvas, draw the strokes of every
  // active comment, and stack their text in the panel. No doc OR no active comment ⇒ cleared canvas +
  // empty/hidden panel (the INERT default). Called every paint AFTER the reconcile pass.
  const renderAnnotations = (T: number): void => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // DPR-aware sizing, kept simple: back the canvas at device pixels, draw in CSS pixels via a scale.
    const dpr = window.devicePixelRatio || 1;
    if (annoCanvas.width !== Math.round(vw * dpr)) annoCanvas.width = Math.round(vw * dpr);
    if (annoCanvas.height !== Math.round(vh * dpr)) annoCanvas.height = Math.round(vh * dpr);
    const ctx = annoCanvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
    }
    if (currentDoc === null) {
      cmtPanel.replaceChildren();
      cmtPanel.classList.remove("mockanim-cmt-on");
      return;
    }
    const active = projectActiveComments(
      currentDoc,
      T,
      undefined,
      captureFocusId ?? undefined,
    );
    if (ctx) {
      for (const cmt of active) {
        for (const stroke of cmt.strokes) drawStroke(ctx, stroke, vw, vh);
      }
    }
    // Panel: stack every active comment's text. Empty/hidden when none.
    const items: HTMLElement[] = [];
    for (const cmt of active) {
      if (cmt.text.trim().length === 0) continue;
      items.push(el("div", "mockanim-cmt-item", cmt.text));
    }
    cmtPanel.replaceChildren(...items);
    cmtPanel.classList.toggle("mockanim-cmt-on", items.length > 0);
  };

  // The set of elements currently carrying `.demo-pulse` (so a changed pulse set removes from the gone
  // and adds to the new). Held across reconcile passes — the player is the single writer of the class.
  const pulsedEls = new Set<HTMLElement>();

  // ---- overlay seam implementations -------------------------------------------------------------

  // Move/press the cursor. Position IS a transform (translate); compose the press scale in JS so a
  // single transform carries both (a class alone cannot encode the live x/y).
  const setCursor = (state: { x: number; y: number; pressing: boolean } | null): void => {
    if (state === null) {
      cursorNode.style.display = "none";
      return;
    }
    // In-viewport visibility gate (pure fn of the per-tick computed position): when the resolved cursor
    // position falls OUTSIDE the viewport it would park off-screen (e.g. below the fold following a
    // last-waypoint target at rest), so hide it rather than leave a stray arrow. The reconciler calls
    // setCursor every tick, so this self-corrects the instant the position re-enters the viewport. The
    // transform/lerp is unchanged — we only toggle display based on the resolved x/y.
    const outside =
      state.x < 0 ||
      state.y < 0 ||
      state.x > window.innerWidth ||
      state.y > window.innerHeight;
    if (outside) {
      cursorNode.style.display = "none";
      return;
    }
    cursorNode.style.display = "block";
    const scale = state.pressing ? " scale(0.82)" : "";
    cursorNode.style.transform = `translate(${state.x}px, ${state.y}px)${scale}`;
  };

  // AUTHOR-MODE cursor suppression: the reconciler calls setCursor every tick with the projected
  // position; in author mode we hard-hide it instead (the cosmetic cursor must not float over the
  // drawing surface). This wraps the real seam so suppression is enforced AFTER each paint's reconcile
  // pass (a seek that re-runs paint() can't resurrect it). Default/replay uses the raw setCursor.
  const setCursorMaybeSuppressed = (
    state: { x: number; y: number; pressing: boolean } | null,
  ): void => {
    if (authorMode) {
      cursorNode.style.display = "none";
      return;
    }
    setCursor(state);
  };

  // Drive `.demo-pulse` to EXACTLY the projected selector set: remove from elements no longer targeted,
  // add to elements matching the new selectors. A missing selector is a no-op (no match → nothing added).
  const setPulseTargets = (selectors: ReadonlySet<string>): void => {
    const next = new Set<HTMLElement>();
    for (const sel of selectors) {
      for (const m of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        next.add(m);
      }
    }
    // Remove from elements that fell out of the set.
    for (const elPrev of pulsedEls) {
      if (!next.has(elPrev)) elPrev.classList.remove("demo-pulse");
    }
    // Add to the new set.
    for (const elNext of next) elNext.classList.add("demo-pulse");
    pulsedEls.clear();
    for (const elNext of next) pulsedEls.add(elNext);
  };

  // Re-apply the LAST projected pulse set to the live DOM (after a conv rebuild wiped classes on conv
  // nodes). Reads the same source of truth — `pulsedEls` is rebuilt from scratch by setPulseTargets,
  // so we re-derive from the selectors the reconciler last passed. We cache that selector set here.
  let lastPulseSelectors: ReadonlySet<string> = new Set();
  const setPulseTargetsTracked = (selectors: ReadonlySet<string>): void => {
    // AUTHOR-MODE pulse suppression: drive the live set to EMPTY so no `.demo-pulse` outline appears
    // over the drawing surface. Passing the empty set (not the projected one) makes setPulseTargets
    // remove the class from every previously-pulsed element and add to none — and because the
    // reconciler + the same-pass renderConv re-apply both route through here, suppression holds across
    // ticks and across a seek-triggered repaint (Risk #3). Default/replay passes the projected set.
    const effective = authorMode ? new Set<string>() : selectors;
    lastPulseSelectors = effective;
    setPulseTargets(effective);
  };

  // Type into a real field: set .value to the prefix and dispatch a real `input` event (so the app's
  // own input listeners — composer error-clear, #review-submit enable — fire faithfully).
  const setFieldText = (selector: string, prefix: string): void => {
    const field = document.querySelector(selector) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!field) return;
    field.value = prefix;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // Drive the composer modal open/closed. The reconciler is the EXCLUSIVE writer of `.hidden` during
  // the demo (cursor clicks are cosmetic; the real #new-plan-btn is never triggered), so toggling the
  // class directly cannot desync any second writer.
  const setComposerOpen = (open: boolean): void => {
    const modal = document.getElementById("composer-modal");
    if (!modal) return;
    modal.classList.toggle("hidden", !open);
  };

  // Drive the selection popover (reconciler exclusive writer). On: show #sel-popover, set #sp-quote
  // from the target block's text, position it under the target block's rect. Off: hide it. No real
  // selection events are dispatched.
  const setSelPopover = (state: { on: boolean; target: string | null }): void => {
    const popover = document.getElementById("sel-popover");
    if (!popover) return;
    if (!state.on || state.target === null) {
      popover.classList.add("hidden");
      return;
    }
    const block = document.querySelector(state.target);
    if (block === null) {
      popover.classList.add("hidden");
      return;
    }
    const quote = document.getElementById("sp-quote");
    if (quote) quote.textContent = (block.textContent ?? "").trim();
    popover.classList.remove("hidden");
    const rect = block.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.bottom + 6}px`;
  };

  // Drive the reconciler-owned question-card Other answer UI. Non-null: check the toggle + dispatch a
  // real `change` (so the card's refresh() un-hides the Other input) and set the text input value (+
  // dispatch input). null: leave as-is (the reconciler only calls on change; backward scrub re-asserts).
  // Idempotent: only dispatch when the value actually changes.
  const setQuestionAnswerUI = (
    state: { otherChecked: boolean; otherText: string } | null,
  ): void => {
    const card = document.querySelector(".conv-question");
    if (!card) return;
    const toggle = card.querySelector('[data-other="toggle"]') as HTMLInputElement | null;
    const textInput = card.querySelector('[data-other="text"]') as HTMLInputElement | null;
    if (state === null) {
      if (toggle && toggle.checked) {
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    if (toggle && toggle.checked !== state.otherChecked) {
      toggle.checked = state.otherChecked;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (textInput && textInput.value !== state.otherText) {
      textInput.value = state.otherText;
      textInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  // Drive a scroll container's scrollTop to the projected FRACTION of its max scroll range. Resolves
  // the target selector against the LIVE DOM each call (the container's scrollHeight/clientHeight move
  // as content renders). null ⇒ NO active scroll window → do NOT touch scrollTop (leave the pane put).
  // Idempotent: only writes scrollTop when it actually differs (avoids fighting user/native scrolling).
  const setScroll = (state: { target: string; frac: number } | null): void => {
    if (state === null) return;
    const container = document.querySelector(state.target) as HTMLElement | null;
    if (!container) return;
    const range = container.scrollHeight - container.clientHeight;
    if (range <= 0) return; // nothing to scroll (content fits) → no-op.
    const next = Math.round(state.frac * range);
    if (Math.abs(container.scrollTop - next) > 0.5) container.scrollTop = next;
  };

  // (c4) Rebuild the sidebar Contents ToC from the CURRENTLY-rendered reading pane, reusing the REAL
  // production data flow: extractToc (read-only over #reading-pane) → buildToc (writes #toc-list, wiring
  // each row's click to scrollToHeading). This is the ONE sanctioned render→sidebar flow (the sidebar
  // never queries #reading-pane itself). Resolves #toc-list against the LIVE DOM each call; no-op if the
  // ToC list is absent (a stripped DOM). buildToc clears + repopulates, so an empty pane ⇒ an empty ToC.
  const rebuildToc = (pane: HTMLElement): void => {
    const tocList = document.getElementById("toc-list");
    if (!tocList) return;
    buildToc(tocList, extractToc(pane));
  };

  // (c4) Switch the SIDEBAR Plans/Contents tab by clicking the real `.tab-row .tab[data-tab=…]` so
  // main.ts's initTabs switching logic runs (toggles `.active` on `#tab-plans` / `#tab-contents`). Falls
  // back to toggling the `.active` classes directly the way initTabs does — robust to a boot-order race
  // where the click listener isn't wired yet (mirrors clickTab's fallback for the reader tab). Scopes to
  // the SIDEBAR `.tab-row` (the FIRST one — NOT `.reader-tab-row`) so it never grabs the reader tabs.
  const setSidebarTab = (tab: "plans" | "contents"): void => {
    const row = document.querySelector<HTMLElement>(".tab-row:not(.reader-tab-row)");
    const tabBtn = row?.querySelector<HTMLElement>(`.tab[data-tab="${tab}"]`) ?? null;
    if (tabBtn) tabBtn.click();
    if (!tabBtn || !tabBtn.classList.contains("active")) {
      if (row) {
        for (const t of Array.from(row.querySelectorAll<HTMLElement>(".tab"))) {
          t.classList.toggle("active", t.dataset.tab === tab);
        }
      }
      document.getElementById("tab-plans")?.classList.toggle("active", tab === "plans");
      document.getElementById("tab-contents")?.classList.toggle("active", tab === "contents");
    }
  };

  // ---- the reconciler: wired to the REAL host seams ----
  const reconciler = createReconciler(
    {
      // Conversation: re-apply the model to T (token reveal included) + renderTree into the player pane.
      renderConv: (T: number): void => {
        applyUpToTime(model, story, T);
        renderTree(pane, model.derive());
        // renderTree does replaceChildren (no scroll handling); the long Execution conversation would
        // render with the finale below the fold. Pin to the bottom so the latest bubbles stay visible.
        pane.scrollTop = pane.scrollHeight;
        // PLAYER-OWNED MINIMAP REBUILD (Phase 6): repaint the right-gutter minimap from the pane's
        // CURRENT children every tick — a pure reflection of the just-rendered stream, so a back-scrub
        // (which re-renders fewer/no children) reverts it cleanly (empty stream → `.is-empty`). Called
        // AFTER the scrollTop pin above so the viewport indicator reflects the pinned scroll position.
        // rebuild() coalesces to one paint per animation frame; idempotent across repeated ticks at the
        // same T. The minimap's own ResizeObserver/MutationObserver also fire, but the explicit call
        // guarantees a rebuild on every reconcile pass (the mock player drives renders directly, not via
        // the app's rerender()).
        paneMinimap.rebuild();
        // SAME-PASS PULSE RE-APPLY (anti-strobe): replaceChildren above wiped `.demo-pulse` on the conv
        // nodes. During a revealMs window the pulse SET is unchanged, so the memoized reconcilePulse
        // pass would NOT re-apply it — a separate post-pass would strobe at 20Hz. Re-apply the LAST
        // projected pulse selectors here, in the SAME paint pass, immediately after the conv rebuild.
        setPulseTargetsTracked(lastPulseSelectors);
      },
      // Reading pane: the real read_plan_contents + render facade.
      readPlan: (path: string) => invoke<string>("read_plan_contents", { path }),
      renderInto,
      settle,
      applyComments,
      readingPane,
      planDirOf,
      // (c4) Rebuild the Contents ToC from the rendered pane via the REAL extractToc→buildToc.
      rebuildToc,
      // Sidebar: stash the full plan set + emit plan-changed so main.ts re-lists through its real handler.
      setPlans: (plans: PlanRecord[]): void => setPlans(plans),
      emitPlanChanged: (): void => emitMockEvent("plan-changed", { path: "/Users/mock/.claude/plans/unread-standalone.md" }),
      // Review bar: drive the input seams; NEVER write #review-bar — main.ts paints it.
      setPendingReviews: (reviews: ReviewRequest[]): void => setPendingReviews(reviews),
      emitReviewRequested: (r: ReviewRequest): void =>
        emitMockEvent("plan-review-requested", {
          review_id: r.review_id,
          plan_text: r.plan_text,
          plan_file_path: r.plan_file_path,
          created_ms: r.created_ms,
        }),
      emitReviewCancelled: (reviewId: string): void =>
        emitMockEvent("plan-review-cancelled", { review_id: reviewId }),
      // Prototype gate: the fake orchestrator seam. Pass the ROUND-AWARE Trailhead ASCII override so
      // main.ts's renderPrototypePreview composes the trail-card ASCII INLINE in #reading-pane (the real
      // app's inline-preview path) — round 1 = the clean card, round 2 = the difficulty-badge variant.
      // Never mermaid (review item #6 — the default fixture's `flowchart LR` would otherwise paint).
      emitGate: (_which: "prototype", round?: number): void =>
        emitGate("prototype", round, trailheadProtoPreviewOverride(round ?? 1)),
      clearGate,
      // Active tab: click the real tab button (never un-hide #conversation-stream).
      setActiveTab: (tab: "plan" | "conversation"): void => {
        clickTab(tab);
      },
      // (c4) Sidebar tab: click the real sidebar Plans/Contents tab so initTabs switching runs.
      setSidebarTab,
      // ---- overlay seams (cosmetic; reconciler-owned DOM) ----
      // Author mode routes through the suppression wrapper (cursor hard-hidden); default/replay uses
      // the raw seam.
      setCursor: setCursorMaybeSuppressed,
      // Use the tracked variant so the LAST projected pulse selectors are cached for the same-pass
      // re-apply inside renderConv (anti-strobe).
      setPulseTargets: setPulseTargetsTracked,
      setFieldText,
      setComposerOpen,
      setSelPopover,
      setQuestionAnswerUI,
      setScroll,
    },
    story,
    model,
  );

  // ---- transport bar: the only fixed/max-z layer ----
  const root = el("div", "mockanim-root");
  root.id = "mock-anim";

  const controls = el("div", "mockanim-controls");
  const playBtn = el("button", "mockanim-play", "▶");
  playBtn.type = "button";
  const progress = el("div", "mockanim-progress");
  const fill = el("div", "mockanim-progress-fill");
  progress.appendChild(fill);

  // Chapter markers: one per frame carrying a chapterLabel, positioned at tMs/duration, click-to-jump.
  for (const sf of story) {
    if (!sf.chapterLabel) continue;
    const marker = el("div", "mockanim-marker");
    marker.style.left = duration > 0 ? `${(sf.tMs / duration) * 100}%` : "0%";
    marker.title = sf.chapterLabel;
    marker.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // don't also start a track drag
      seekTo(sf.tMs);
    });
    progress.appendChild(marker);
  }

  const speedBtn = el("div", "mockanim-speed", "1×");
  controls.appendChild(playBtn);
  controls.appendChild(progress);
  controls.appendChild(speedBtn);
  root.appendChild(controls);

  document.body.appendChild(root);

  // ---- playback state ----
  let T = 0;
  let playing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let speedIdx = 1; // start at 1×

  const speed = (): number => SPEEDS[speedIdx];

  // Single paint: reconcile the host seams to T + update the transport fill + render the annotation
  // overlay (a pure projection of (currentDoc, T); inert when no doc is loaded).
  const paint = (): void => {
    reconciler.reconcile(T);
    const pct = duration > 0 ? Math.min(100, (T / duration) * 100) : 100;
    fill.style.width = `${pct}%`;
    renderAnnotations(T);
    // Author mode: AFTER the pinned projection renders, overlay the in-progress working strokes and
    // refresh the "comments at this T" list. No-op (empty hooks) in default/replay.
    if (authorMode) runAuthorPaintHooks();
  };

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    playing = false;
    playBtn.textContent = "▶";
  };

  // Seek to an absolute T (clamped), pause, repaint. Used by the progress drag + chapter markers.
  const seekTo = (next: number): void => {
    // Capture focus is a strictly capture-frame-local concern — a user scrub must never inherit a
    // stale focus (which would hide all-but-one comment). Reset it before any seek-driven repaint.
    captureFocusId = null;
    T = Math.max(0, Math.min(duration, next));
    stop();
    paint();
  };

  const tick = (): void => {
    T += TICK_MS * speed();
    if (T >= duration) {
      T = duration;
      paint();
      stop(); // clamp + stop at the end of the story
      return;
    }
    paint();
  };

  const play = (): void => {
    if (playing) return;
    if (T >= duration) T = 0; // restart from the beginning if parked at the end
    playing = true;
    playBtn.textContent = "❚❚";
    timer = setInterval(tick, TICK_MS);
  };

  playBtn.addEventListener("click", () => {
    if (playing) stop();
    else play();
  });

  // ---- draggable progress track: pointerdown/move/up → scrub T ----
  const tFromPointer = (clientX: number): number => {
    const rect = progress.getBoundingClientRect();
    const width = rect.width || 1;
    const x = Math.max(0, Math.min(width, clientX - rect.left));
    return duration > 0 ? (x / width) * duration : 0;
  };
  let dragging = false;
  progress.addEventListener("pointerdown", (e) => {
    dragging = true;
    progress.setPointerCapture?.(e.pointerId);
    seekTo(tFromPointer(e.clientX));
  });
  progress.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    seekTo(tFromPointer(e.clientX));
  });
  const endDrag = (): void => {
    dragging = false;
  };
  progress.addEventListener("pointerup", endDrag);
  progress.addEventListener("pointercancel", endDrag);

  // ---- speed control: cycle 0.5×/1×/2×/4×/8× ----
  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    speedBtn.textContent = `${speed()}×`;
  });

  // ---- annotation comment ticks on the scrubber (rebuilt on doc change, NOT every tick) ----
  // One `.mockanim-cmt-tick` per distinct comment tMs (tickGroups), positioned at tMs/duration, click →
  // seekTo (mirrors the chapter .mockanim-marker). A multi-comment group carries a small count badge.
  const rebuildCmtTicks = (): void => {
    for (const old of Array.from(progress.querySelectorAll(".mockanim-cmt-tick"))) old.remove();
    if (currentDoc === null) return;
    for (const group of tickGroups(currentDoc)) {
      const tick = el("div", "mockanim-cmt-tick");
      tick.style.left = duration > 0 ? `${(group.tMs / duration) * 100}%` : "0%";
      tick.title = `comment @ ${group.tMs}ms${group.count > 1 ? ` (${group.count})` : ""}`;
      tick.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); // don't also start a track drag
        seekTo(group.tMs);
      });
      if (group.count > 1) {
        tick.appendChild(el("div", "mockanim-cmt-tick-badge", String(group.count)));
      }
      progress.appendChild(tick);
    }
  };

  // ---- programmatic seek/replay control surface (window.__mockAnim) ----
  // seekSettled: seek, then await the reconciler's reading-pane settle barrier so a caller (capture /
  // replay) lands on a FULLY-rendered pane. The barrier resolves immediately (next microtask) when no
  // plan-open is in flight, so callers can await it uniformly.
  const seekSettled = async (tMs: number): Promise<void> => {
    seekTo(tMs);
    await reconciler.settleBarrier();
  };
  // loadAnnotations: set the active doc, rebuild ticks, repaint (so the overlay reflects the new doc at
  // the current T). Passing null returns to the inert default.
  const loadAnnotations = (next: AnnotationDoc | null): void => {
    // Capture focus is capture-frame-local: it must never survive a doc load (a stale focus would
    // hide all-but-one comment in the freshly-loaded doc). Reset before anything else.
    captureFocusId = null;
    // Shape guard: a malformed/old doc (e.g. comments missing or not an array, or a version mismatch)
    // would throw inside tickGroups/projectActiveComments at paint time. Warn and treat as a no-op
    // clear instead of proceeding. The null case (clear) is preserved.
    if (next !== null && (next.version !== 1 || !Array.isArray(next.comments))) {
      console.warn(
        "[mock-animate] ignoring malformed annotation doc (expected version:1 with a comments[] array)",
        next,
      );
      next = null;
    }
    currentDoc = next;
    rebuildCmtTicks();
    paint();
  };
  const getActiveComments = (): AnnotationComment[] =>
    currentDoc === null ? [] : projectActiveComments(currentDoc, T);
  // focusComment (Phase 4 capture): set the capture-isolation id + repaint so ONLY that comment's
  // strokes/text render (via projectActiveComments's onlyId). null returns to normal window behavior.
  const focusComment = (id: string | null): void => {
    captureFocusId = id;
    paint();
  };

  // Idempotent assignment (the HMR guard at the top of mountPlayer already prevents a second mount, but
  // assigning the fresh closures is harmless if it ever runs again).
  window.__mockAnim = {
    seekTo,
    seekSettled,
    play,
    stop,
    getT: (): number => T,
    getDuration: (): number => duration,
    loadAnnotations,
    getActiveComments,
    focusComment,
  };

  // ---- author mode: enable canvas capture + mount the toolbar (Phase 3) ----
  // Only in author mode: flip the annotation canvas to capture pointer input (replay/default keeps it
  // pointer-events:none) and mount the author UI. The UI reaches the player ONLY through these deps —
  // it shares no closure state. `getDoc`/`setDoc` bridge the player's `currentDoc` so the UI mutates
  // the SAME in-memory doc the overlay projects + the ticks are built from.
  if (authorMode) {
    // Match the capture environment's viewport: capture pins `--hide-scrollbars`, but author mode pins
    // nothing, so an author with classic (non-overlay) scrollbars would record a viewport inner-width
    // that differs from capture, drifting strokes horizontally a few px. Hide the document scrollbars
    // here so authoring measures the same inner-width capture/replay does. Author-mode ONLY — default
    // and replay are untouched.
    document.documentElement.style.overflow = "hidden";
    annoCanvas.style.pointerEvents = "auto";
    mountAnnotateUI({
      getT: (): number => T,
      // An author session always edits a concrete doc; seed an empty one if none is loaded yet so the
      // UI never has to special-case null. loadAnnotations(null) is never reached in author mode.
      getDoc: (): AnnotationDoc =>
        currentDoc ?? {
          version: 1,
          durationMs: duration,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          comments: [],
        },
      setDoc: (doc: AnnotationDoc): void => {
        currentDoc = doc;
      },
      repaint: (): void => paint(),
      rebuildTicks: (): void => rebuildCmtTicks(),
      saveDoc,
      canvas: annoCanvas,
      drawStroke,
    });
  }

  // Initial paint at T=0 (the opening frame), paused. The reconciler will activate the Conversation
  // tab (no plan open at T=0 → activeTab "conversation").
  //
  // DEFERRED to a macrotask (mirrors deck.ts's `setTimeout(applyDefaultOnReady, 0)`): this script loads
  // after main.ts's deferred bundle, so at module-eval `document.readyState` is "interactive" and
  // main.ts's DOMContentLoaded handler (which calls initTabs to wire the reader tab buttons) has NOT run
  // yet. Painting synchronously here would land `setActiveTab("conversation")` → clickTab → tabBtn.click()
  // on a button with no listener, so #tab-conversation would stay display:none and the player pane —
  // nested inside it — would be invisible. The chrome + transport handlers were wired synchronously
  // above; only the FIRST reconcile/paint is deferred so it runs AFTER initTabs has attached its
  // listeners. (clickTab's direct-toggle fallback also covers any residual timing slip.)
  setTimeout(paint, 0);
}

// Install the FAKE orchestrator as the orchestrator singleton FIRST — BEFORE main.ts's
// DOMContentLoaded wiring calls getOrchestrator().subscribe(...). This module evaluates at mock boot
// (after main.ts's module body, which only registers a DOMContentLoaded listener), so the singleton is
// installed before that handler runs. WITHOUT this, main.ts subscribes to the REAL orchestrator while
// the reconciler's emitGate/clearGate fan to the fake handle nobody subscribed to — so the prototype
// gate (Slice 04) and review (Slice 06) animation would silently no-op. deck.ts does the same; the
// animate path omitted it because deck.ts is excluded when MOCK_ANIMATE=1. Only the orchestrator is
// needed here: the reconciler drives setPlans/setPendingReviews/emitMockEvent/emitGate/clearGate
// DIRECTLY (not via window.__mock), so installMockApi() (the window.__mock hook) is NOT required.
installMockOrchestrator();

// Replay-from-file boot hook (Phase 2): when launched with `?annotations=<name>`, load the persisted
// AnnotationDoc from the dev middleware and feed it into the just-mounted player so its ticks + overlay
// render from disk. A missing file (null) or a fetch error is logged and NON-fatal — the demo still
// plays unannotated. Author UI / sessionStorage draft belt are Phase 3, not here.
async function loadAnnotationsFromUrl(): Promise<void> {
  const name = new URLSearchParams(window.location.search).get("annotations");
  if (name === null || name.length === 0) return;
  try {
    const doc = await loadDoc(name);
    if (doc === null) {
      console.warn(`[mock-animate] no annotations file named "${name}"`);
      return;
    }
    window.__mockAnim?.loadAnnotations(doc);
  } catch (err) {
    console.warn(`[mock-animate] failed to load annotations "${name}":`, err);
  }
}

// DOM-ready boot guard (mirrors deck.ts): this script loads after main.ts's deferred bundle, so
// DOMContentLoaded may have already fired.
function boot(): void {
  mountPlayer();
  void loadAnnotationsFromUrl();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
