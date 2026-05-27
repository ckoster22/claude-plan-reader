// Hand-rolled pan/zoom for the mermaid reading-pane viewport.
//
// Why hand-rolled (not d3-zoom, which is in node_modules): d3-zoom attaches its
// listeners directly to the zoomed node — for us that would be the SANITIZED SVG.
// We must never re-wire the sanitized SVG. Instead we transform an OUTER wrapper
// (`.mermaid-stage`) that merely CONTAINS the SVG, and bind listeners to the
// `.mermaid-viewport` clip frame, leaving the SVG content inert.
//
// Transform convention (single source of truth — assert it in tests):
//   `transform-origin: 0 0` on the stage, so a content point `c` (in the stage's
//   own coordinate space) maps to a screen/viewport-local coordinate as:
//       screen = c * scale + translate
//   transformString emits `translate(<tx>px, <ty>px) scale(<scale>)` — the
//   translate is the OUTER op (applied after scale), which is exactly this map.
//   Inverting: the content point under a viewport-local cursor `cur` is
//       c = (cur - translate) / scale
//   zoomAt keeps that `c` fixed across the scale change (cursor-stationary zoom).

export interface PanZoomState {
  scale: number;
  tx: number;
  ty: number;
}

const DEFAULT_MIN = 0.3;
const DEFAULT_MAX = 4;
// Leave a little breathing room around a fitted diagram (matches prototype).
const FIT_MARGIN = 0.92;

// Adaptive viewport-height bounds. A hard-coded 340px band makes a wide-short
// `graph LR` diagram (measured viewBox 1135×94 — a ~12:1 strip) sit as a thin
// line lost in vertical whitespace, and forces a tall `graph TD` to scroll. The
// clip frame's height is instead derived per-diagram from the content aspect so
// the diagram fills its frame, clamped to a sane band.
const MIN_VIEWPORT_H = 200;
const MAX_VIEWPORT_H = 560;

/**
 * The clip-frame height that best matches a `contentW × contentH` diagram laid
 * out in a `viewportW`-wide frame, clamped to [MIN_VIEWPORT_H, MAX_VIEWPORT_H].
 *
 * Rationale (proven by measurement): with the full-width breakout the width is
 * the usual fit constraint, so we compute the width-limited scale (capped at 1,
 * times the margin), apply it to the content height, then re-add the vertical
 * margin so the same FIT_MARGIN breathing room appears top/bottom as left/right.
 * The result is a frame proportioned to the diagram — short for a wide diagram,
 * tall for a `graph TD` — instead of a fixed 340px band. Non-finite / zero
 * content falls back to a mid-band height so the frame is never collapsed.
 */
export function viewportHeightFor(
  viewportW: number,
  contentW: number,
  contentH: number,
): number {
  const safeW = Number.isFinite(contentW) && contentW > 0 ? contentW : 0;
  const safeH = Number.isFinite(contentH) && contentH > 0 ? contentH : 0;
  const vw = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 0;
  if (safeW <= 0 || safeH <= 0 || vw <= 0) {
    return clampViewportHeight((MIN_VIEWPORT_H + MAX_VIEWPORT_H) / 2);
  }
  const widthScale = Math.min(vw / safeW, 1) * FIT_MARGIN;
  const desired = (safeH * widthScale) / FIT_MARGIN;
  return clampViewportHeight(desired);
}

function clampViewportHeight(h: number): number {
  if (!Number.isFinite(h)) return (MIN_VIEWPORT_H + MAX_VIEWPORT_H) / 2;
  return Math.max(MIN_VIEWPORT_H, Math.min(MAX_VIEWPORT_H, Math.round(h)));
}

/** Clamp a scale to [min, max]. */
export function clampScale(
  scale: number,
  min: number = DEFAULT_MIN,
  max: number = DEFAULT_MAX,
): number {
  return Math.max(min, Math.min(max, scale));
}

/**
 * Cursor-stationary zoom. Given the current state and a cursor point in
 * VIEWPORT-LOCAL coordinates (x from the viewport's left edge, y from its top),
 * return the new state after multiplying scale by `factor`. The content point
 * under the cursor stays under the cursor.
 *
 * Derivation: let s' = clamp(s * factor). We want (cx - tx')/s' = (cx - tx)/s,
 * i.e. tx' = cx - (cx - tx) * (s'/s). Same for ty'.
 */
export function zoomAt(
  state: PanZoomState,
  cursorX: number,
  cursorY: number,
  factor: number,
  min: number = DEFAULT_MIN,
  max: number = DEFAULT_MAX,
): PanZoomState {
  const ns = clampScale(state.scale * factor, min, max);
  const ratio = ns / state.scale;
  return {
    scale: ns,
    tx: cursorX - (cursorX - state.tx) * ratio,
    ty: cursorY - (cursorY - state.ty) * ratio,
  };
}

/**
 * The state that fits `content` centered inside `viewport`.
 *   scale = min(vw/cw, vh/ch, 1) * FIT_MARGIN   (never upscales past the margin)
 *   tx/ty center the scaled content in the viewport.
 * Guards against zero / NaN / non-finite content dimensions (which would make
 * vw/cw infinite or NaN) by falling back to the margin scale.
 */
export function fitState(
  viewportW: number,
  viewportH: number,
  contentW: number,
  contentH: number,
): PanZoomState {
  const safeW = Number.isFinite(contentW) && contentW > 0 ? contentW : 0;
  const safeH = Number.isFinite(contentH) && contentH > 0 ? contentH : 0;

  let raw: number;
  if (safeW <= 0 || safeH <= 0) {
    // Unknown content size — fit cannot be computed; use the unit (margin) scale.
    raw = 1;
  } else {
    raw = Math.min(viewportW / safeW, viewportH / safeH, 1);
    if (!Number.isFinite(raw) || raw <= 0) raw = 1;
  }
  const scale = raw * FIT_MARGIN;

  // Center using the safe (possibly 0) content dims; with 0 content this centers
  // a zero-size box, which is harmless and finite.
  const tx = (viewportW - safeW * scale) / 2;
  const ty = (viewportH - safeH * scale) / 2;
  return { scale, tx, ty };
}

/** The exact CSS transform string for a state. Assert this format in tests. */
export function transformString(state: PanZoomState): string {
  return `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
}

/**
 * The diagram's TRUE intrinsic content size, independent of how it is laid out.
 *
 * mermaid 11 emits its SVG with `width="100%"`, a `style="max-width:NNNpx"`, and
 * (crucially) NO numeric `height` attribute — the only reliable record of the
 * diagram's natural pixel size is the `viewBox` ("minX minY W H"). Our CSS
 * (`.mermaid-stage svg { max-width: none }`) deliberately removes the max-width
 * cap so the SVG can be panned, which means the LAID-OUT box stretches to the
 * stage/viewport width. Measuring `getBoundingClientRect()`/`clientWidth` would
 * therefore return the VIEWPORT width, not the diagram size — so we must read the
 * intrinsic size from the viewBox (W/H), exactly as the approved prototype does
 * with its literal `sw/sh`.
 *
 * Resolution order, most-authoritative first:
 *   1. `viewBox` width/height (the natural diagram size under useMaxWidth).
 *   2. numeric `width`/`height` attributes (present only when useMaxWidth:false).
 * Returns 0/0 when neither yields a positive finite pair, so the caller can fall
 * back without ever feeding NaN/100%/0 into fitState.
 */
export function svgContentSize(svg: SVGElement | null): {
  w: number;
  h: number;
} {
  if (!svg) return { w: 0, h: 0 };

  // 1. viewBox: "minX minY width height" — parse the raw attribute string so we
  //    do not depend on the SVGAnimatedRect baseVal (absent under jsdom).
  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4) {
      const w = parts[2];
      const h = parts[3];
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { w, h };
      }
    }
  }

  // 2. numeric width/height attributes (useMaxWidth:false path). `Number("100%")`
  //    is NaN and `Number(null)` is 0 — both rejected by the > 0 guard below.
  const wAttr = Number(svg.getAttribute("width"));
  const hAttr = Number(svg.getAttribute("height"));
  if (
    Number.isFinite(wAttr) &&
    Number.isFinite(hAttr) &&
    wAttr > 0 &&
    hAttr > 0
  ) {
    return { w: wAttr, h: hAttr };
  }

  return { w: 0, h: 0 };
}

// ---------------------------------------------------------------------------
// DOM adapter
// ---------------------------------------------------------------------------

export interface PanZoomOptions {
  min?: number;
  max?: number;
  /** Step factor for the +/− buttons (default 1.25). */
  buttonStep?: number;
  /** Step factor per wheel notch (default 1.12). */
  wheelStep?: number;
  /** Called after every state change with the new state (for the % readout). */
  onChange?: (state: PanZoomState) => void;
}

export interface PanZoomController {
  zoomIn(): void;
  zoomOut(): void;
  /** Re-fit the content centered in the viewport. */
  reset(): void;
  /** Current state (read-only snapshot). */
  getState(): PanZoomState;
  /** Remove ALL listeners (viewport + any active window drag listeners). */
  destroy(): void;
}

/**
 * Wire drag-pan + wheel-zoom + a controller onto a viewport/stage pair.
 *
 * Leak discipline: the `mousemove`/`mouseup` listeners are attached to `window`
 * ONLY for the duration of an active drag and removed on mouseup. `destroy()`
 * removes the viewport-level listeners AND tears down any in-flight drag
 * listeners, so re-rendering (which builds a fresh controller per diagram) never
 * accumulates stale window listeners across renders.
 */
export function attachPanZoom(
  viewportEl: HTMLElement,
  stageEl: HTMLElement,
  opts: PanZoomOptions = {},
): PanZoomController {
  const min = opts.min ?? DEFAULT_MIN;
  const max = opts.max ?? DEFAULT_MAX;
  const buttonStep = opts.buttonStep ?? 1.25;
  const wheelStep = opts.wheelStep ?? 1.12;
  const onChange = opts.onChange;

  let state: PanZoomState = { scale: 1, tx: 0, ty: 0 };

  function contentSize(): { w: number; h: number } {
    // Read the SVG's INTRINSIC size from its viewBox (not its laid-out box, which
    // our `max-width:none` rule stretches to the viewport width). See
    // svgContentSize for the full rationale. Only if the SVG carries no usable
    // intrinsic size do we fall back to the laid-out box, then the viewport.
    const svg = stageEl.querySelector("svg");
    const intrinsic = svgContentSize(svg);
    if (intrinsic.w > 0 && intrinsic.h > 0) return intrinsic;
    return {
      w: stageEl.offsetWidth || viewportEl.clientWidth,
      h: stageEl.offsetHeight || viewportEl.clientHeight,
    };
  }

  function apply(): void {
    stageEl.style.transform = transformString(state);
    onChange?.(state);
  }

  function setState(next: PanZoomState): void {
    state = next;
    apply();
  }

  function zoomAtViewport(factor: number, cx: number, cy: number): void {
    setState(zoomAt(state, cx, cy, factor, min, max));
  }

  function fit(): void {
    const { w, h } = contentSize();
    // Size the clip frame to the diagram's aspect FIRST (a wide diagram → short
    // band, a tall diagram → tall band), then read the resulting clientHeight so
    // the centered fit uses the adapted frame. Width is unchanged (the frame is
    // full-reader-width via CSS), so we feed clientWidth straight through.
    const vw = viewportEl.clientWidth;
    viewportEl.style.height = `${viewportHeightFor(vw, w, h)}px`;
    setState(fitState(vw, viewportEl.clientHeight, w, h));
  }

  // The initial fit can only be CENTERED once the viewport has a real laid-out
  // size. attachPanZoom is called by buildPanZoomBox while the box is still
  // DETACHED from the document (replaceWith happens afterwards), so a synchronous
  // fit() here would measure clientWidth/clientHeight === 0 and produce a wrong,
  // off-center transform. We therefore defer the initial fit until the viewport
  // reports non-zero dimensions: try once on the next animation frame, and also
  // arm a ResizeObserver that fires the moment the viewport gains a layout box.
  // Both paths funnel through fitWhenSized(), which fits at most once and then
  // disarms — so a later user-driven reset()/dblclick (which calls fit()
  // directly) is never clobbered, and the observer never leaks (destroy() and a
  // successful fit both disconnect it).
  let initialFitDone = false;
  let ro: ResizeObserver | null = null;
  let rafId = 0;

  function disarmInitialFit(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (ro) {
      ro.disconnect();
      ro = null;
    }
  }

  function fitWhenSized(): void {
    if (initialFitDone) return;
    if (viewportEl.clientWidth > 0 && viewportEl.clientHeight > 0) {
      initialFitDone = true;
      disarmInitialFit();
      fit();
    }
  }

  function armInitialFit(): void {
    // Fast path: if we already have a layout (e.g. the viewport was attached
    // before attachPanZoom ran), fit synchronously so callers/tests that don't
    // pump rAF still see a centered state immediately.
    if (viewportEl.clientWidth > 0 && viewportEl.clientHeight > 0) {
      initialFitDone = true;
      fit();
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        fitWhenSized();
      });
    }
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => fitWhenSized());
      ro.observe(viewportEl);
    }
  }

  // ---- wheel = zoom toward cursor (passive:false so preventDefault works) ----
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = viewportEl.getBoundingClientRect();
    const factor = e.deltaY < 0 ? wheelStep : 1 / wheelStep;
    zoomAtViewport(factor, e.clientX - r.left, e.clientY - r.top);
  }

  // ---- drag = pan (window listeners only during an active drag) ----
  let drag: { px: number; py: number; ox: number; oy: number } | null = null;

  function onWindowMove(e: MouseEvent): void {
    if (!drag) return;
    setState({
      scale: state.scale,
      tx: drag.ox + (e.clientX - drag.px),
      ty: drag.oy + (e.clientY - drag.py),
    });
  }

  function endDrag(): void {
    drag = null;
    viewportEl.classList.remove("dragging");
    window.removeEventListener("mousemove", onWindowMove);
    window.removeEventListener("mouseup", endDrag);
  }

  function onMouseDown(e: MouseEvent): void {
    e.preventDefault();
    drag = { px: e.clientX, py: e.clientY, ox: state.tx, oy: state.ty };
    viewportEl.classList.add("dragging");
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", endDrag);
  }

  function onDblClick(): void {
    fit();
  }

  viewportEl.addEventListener("wheel", onWheel, { passive: false });
  viewportEl.addEventListener("mousedown", onMouseDown);
  viewportEl.addEventListener("dblclick", onDblClick);

  // Initialize to a centered fit — deferred until the viewport has a real
  // layout box (see armInitialFit / fitWhenSized).
  armInitialFit();

  return {
    zoomIn() {
      zoomAtViewport(
        buttonStep,
        viewportEl.clientWidth / 2,
        viewportEl.clientHeight / 2,
      );
    },
    zoomOut() {
      zoomAtViewport(
        1 / buttonStep,
        viewportEl.clientWidth / 2,
        viewportEl.clientHeight / 2,
      );
    },
    reset() {
      // An explicit reset takes precedence over a still-pending initial fit:
      // mark it done and disarm so the deferred auto-fit can never re-run and
      // clobber the user's reset.
      initialFitDone = true;
      disarmInitialFit();
      fit();
    },
    getState() {
      return { ...state };
    },
    destroy() {
      viewportEl.removeEventListener("wheel", onWheel);
      viewportEl.removeEventListener("mousedown", onMouseDown);
      viewportEl.removeEventListener("dblclick", onDblClick);
      // Tear down any in-flight drag listeners too.
      endDrag();
      // Cancel a still-pending initial fit (rAF + ResizeObserver) so neither
      // leaks past the controller's lifetime.
      disarmInitialFit();
    },
  };
}
