// Mermaid diagram rendering for the reading pane.
//
// markdown.ts emits `<pre class="mermaid-src">SOURCE</pre>` placeholders. This
// module lazily loads mermaid (dynamic import keeps the heavy bundle off the
// initial load and avoids Vite pre-bundle issues) and replaces each placeholder
// with a rendered SVG. One bad diagram must never blank the pane, so each render
// is isolated in try/catch and a failure falls back to showing the raw source.
//
// SECURITY: we run mermaid with securityLevel:"loose" (needed for <br/> multi-line
// label fidelity). Under loose, mermaid 11 SKIPS its internal DOMPurify pass (the
// sanitize call lives in the `!isLooseSecurityLevel` branch), so the returned SVG
// is UNSANITIZED. A prompt-injected plan could embed an onerror/event-handler in a
// node label that would execute when we do `innerHTML = svg`. We therefore run
// DOMPurify OURSELVES on the SVG (svg + html profile, which preserves <foreignObject>
// and <br> labels) before injection, and never call bindFunctions.

import DOMPurify from "dompurify";
import {
  attachPanZoom,
  svgContentSize,
  type PanZoomController,
} from "./panzoom";

type MermaidModule = typeof import("mermaid");

// Shared sanitize config — exported so the falsifiability test exercises the exact
// same profile used at injection time.
//  - svg + svgFilters profiles keep diagram geometry (path/rect/g/marker/…).
//  - html profile keeps the HTML label content (<div>/<span>/<br>) mermaid emits
//    inside <foreignObject> for multi-line labels.
//  - ADD_TAGS:['foreignObject'] re-allows the element (it's in DOMPurify's
//    svgDisallowed list by default).
//  - HTML_INTEGRATION_POINTS:{foreignobject:true} is REQUIRED: without it,
//    DOMPurify's namespace check (_checkValidNamespace) strips the HTML children
//    of a foreignObject because their SVG-namespaced parent is not an HTML
//    integration point — collapsing multi-line labels to empty. Marking
//    foreignobject as an integration point preserves the <br> labels while STILL
//    stripping <script> and on* event-handler attributes.
export const MERMAID_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ["foreignObject"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
};

/** Sanitize a mermaid-produced SVG string before it is injected via innerHTML. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, MERMAID_SANITIZE_CONFIG);
}

/**
 * Pin the `<svg>` inside a freshly-populated `.mermaid-stage` to its intrinsic
 * pixel size, derived from the viewBox (via the shared `svgContentSize`).
 *
 * Mermaid's `width="100%"` + `max-width` + no-height shape collapses to the CSS
 * replaced-element default (~300px) inside our absolutely-positioned auto-width
 * stage (see the call site for the full measured rationale). Replacing `width`
 * with explicit pixels (and adding the missing `height`) makes the laid-out box
 * equal the diagram's true size so the pan/zoom fit/centering are computed
 * against the same dimensions the diagram is actually drawn at.
 *
 * No-ops when there is no SVG or no usable intrinsic size (svgContentSize returns
 * 0/0) — the SVG keeps whatever sizing it had rather than getting a 0×0 box.
 * The `style.maxWidth` mermaid set is cleared so it cannot cap the pinned width.
 * Exported for the falsifiability test.
 */
export function setIntrinsicSvgSize(stage: HTMLElement): void {
  const svg = stage.querySelector("svg");
  if (!svg) return;
  const { w, h } = svgContentSize(svg as unknown as SVGElement);
  if (w <= 0 || h <= 0) return;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.style.removeProperty("max-width");
}

let _mermaid: MermaidModule["default"] | null = null;
let _idCounter = 0;

// Live pan/zoom controllers from the MOST RECENT renderDiagrams() pass, keyed by
// the pane they were rendered into. A fresh render (open / live-reload / plan
// switch) calls renderDiagrams again — we destroy the prior pass's controllers
// for that pane FIRST so no `window` drag listener (or wheel listener) leaks
// across renders. Reset is structural: each render builds a brand-new box +
// controller initialized to a centered fit, so pan/zoom always re-fits.
const _controllers = new WeakMap<HTMLElement, PanZoomController[]>();

async function getMermaid(): Promise<MermaidModule["default"]> {
  if (_mermaid) return _mermaid;
  const mod = await import("mermaid");
  const mermaid = mod.default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    // "default" theme reads well against the light reader chrome.
    theme: "default",
  });
  _mermaid = mermaid;
  return mermaid;
}

/**
 * Render every `.mermaid-src` placeholder in the pane. Resolves after all
 * diagrams have been attempted. A render failure shows the raw source plus a dim
 * error note (reusing the .mermaid-box / .mermaid-cap chrome) instead of throwing.
 */
export async function renderDiagrams(paneEl: HTMLElement): Promise<void> {
  // Tear down any pan/zoom controllers from this pane's PREVIOUS render so their
  // listeners never leak across renders (structural reset — see _controllers).
  destroyControllers(paneEl);

  const sources = Array.from(
    paneEl.querySelectorAll<HTMLElement>("pre.mermaid-src"),
  );
  if (sources.length === 0) return;

  const mermaid = await getMermaid();
  const fresh: PanZoomController[] = [];

  // Render sequentially: mermaid mutates document.body with transient nodes and
  // is not reentrancy-friendly across concurrent render() calls.
  for (const el of sources) {
    const src = el.textContent ?? "";
    const id = `mermaid-${_idCounter++}`;
    try {
      const { svg } = await mermaid.render(id, src);
      const { box, controller } = buildPanZoomBox(svg);
      // DO NOT call bindFunctions — keeps any embedded click/script inert.
      el.replaceWith(box);
      if (controller) fresh.push(controller);
    } catch (e) {
      renderError(el, src, e);
    } finally {
      // mermaid appends a transient measuring container (<div id="dmermaid-N">)
      // to document.body during render; remove any stragglers.
      const transient = document.getElementById(`d${id}`);
      if (transient && transient.parentNode === document.body) {
        transient.remove();
      }
    }
  }

  _controllers.set(paneEl, fresh);
}

/**
 * Destroy + forget the controllers from this pane's previous render pass.
 *
 * EXPORTED so the render facade (`renderInto`) can tie controller teardown to the
 * EXACT moment it wipes the pane (`paneEl.innerHTML = …`), which is when the
 * `.mermaid-viewport` elements those controllers are bound to are destroyed. The
 * call at the top of `renderDiagrams` then becomes a harmless no-op safety net.
 *
 * Idempotent: a second call after the WeakMap entry is deleted finds no prior
 * controllers and returns. Each `controller.destroy()` is itself idempotent (it
 * removes listeners — a no-op if already removed — and tears down any in-flight
 * drag), so a double-destroy can never throw or double-remove anything live.
 */
export function destroyControllers(paneEl: HTMLElement): void {
  const prev = _controllers.get(paneEl);
  if (prev) {
    for (const c of prev) c.destroy();
    _controllers.delete(paneEl);
  }
}

/**
 * Build a `.mermaid-box` whose sanitized SVG lives inside a pannable/zoomable
 * `.mermaid-viewport > .mermaid-stage`, with on-screen +/−/reset controls and a
 * live zoom-% readout. Returns the box and its fresh pan/zoom controller.
 *
 * SECURITY: the SVG is sanitized with the SAME `sanitizeSvg(svg)` call as before
 * (loose mode does NOT auto-sanitize — see file header) and is injected into the
 * STAGE wrapper. We only transform the OUTER divs we create; the sanitized SVG
 * content is never re-wired.
 */
function buildPanZoomBox(svg: string): {
  box: HTMLElement;
  controller: PanZoomController | null;
} {
  const box = document.createElement("div");
  box.className = "mermaid-box mermaid-rendered";

  const viewport = document.createElement("div");
  viewport.className = "mermaid-viewport";

  const stage = document.createElement("div");
  stage.className = "mermaid-stage";
  // Sanitize: loose mode does NOT auto-sanitize (see file header), so we must.
  stage.innerHTML = sanitizeSvg(svg);
  // Pin the SVG to its INTRINSIC pixel size from the viewBox.
  //
  // WHY (proven by measurement): mermaid 11 emits the SVG with `width="100%"`,
  // `style="max-width:<vbW>px"`, and NO height attribute. Our `.mermaid-stage svg
  // { max-width:none }` rule (needed so the SVG isn't squashed by the in-column
  // `max-width:100%`) removes the only constraint that would have stretched it,
  // and the stage is `position:absolute; width:auto` — so `width:100%` has no
  // containing-block width to resolve against and the SVG COLLAPSES to the CSS
  // replaced-element default (~300×150, clamped by the viewBox aspect to ~300×25).
  // The pan/zoom fit then reads the diagram size from the viewBox (e.g. 1135×94)
  // while the laid-out stage box is only ~300px wide — so centering is computed
  // for a box ~3.8× wider than what is actually drawn, leaving the diagram small
  // and shoved to the left. Setting explicit pixel width/height makes the laid-out
  // box EQUAL the intrinsic diagram box, so fit + centering use the real size.
  setIntrinsicSvgSize(stage);

  const readout = document.createElement("div");
  readout.className = "mermaid-zoom-readout";
  readout.textContent = "100%";

  const ctl = document.createElement("div");
  ctl.className = "mermaid-ctl";
  const zin = document.createElement("button");
  zin.type = "button";
  zin.title = "Zoom in";
  zin.textContent = "+";
  const zout = document.createElement("button");
  zout.type = "button";
  zout.title = "Zoom out";
  zout.textContent = "−"; // minus sign
  const zreset = document.createElement("button");
  zreset.type = "button";
  zreset.title = "Reset / fit";
  zreset.textContent = "⤢"; // fit glyph
  ctl.append(zin, zout, zreset);

  viewport.append(stage, readout, ctl);
  box.appendChild(viewport);

  // A fresh controller per render → centered-fit reset on every render/reload/
  // plan-switch with no carried-over state.
  const controller = attachPanZoom(viewport, stage, {
    onChange: (s) => {
      readout.textContent = `${Math.round(s.scale * 100)}%`;
    },
  });

  zin.addEventListener("click", () => controller.zoomIn());
  zout.addEventListener("click", () => controller.zoomOut());
  zreset.addEventListener("click", () => controller.reset());

  return { box, controller };
}

/** Replace a failed placeholder with the raw source + a dim error note. */
function renderError(el: HTMLElement, src: string, err: unknown): void {
  const box = document.createElement("div");
  box.className = "mermaid-box";

  const cap = document.createElement("div");
  cap.className = "mermaid-cap";
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = "mermaid";
  cap.appendChild(pill);
  const note = document.createElement("span");
  note.textContent = `diagram failed to render — ${String(err)}`;
  cap.appendChild(note);

  const pre = document.createElement("pre");
  pre.className = "mermaid-src-error";
  pre.textContent = src;

  box.appendChild(cap);
  box.appendChild(pre);
  el.replaceWith(box);
}
