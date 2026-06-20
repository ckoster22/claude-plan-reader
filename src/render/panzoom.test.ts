import { describe, it, expect } from "vitest";
import {
  clampScale,
  zoomAt,
  fitState,
  transformString,
  svgContentSize,
  viewportHeightFor,
  attachPanZoom,
  type PanZoomState,
} from "./panzoom";

// Pure-module tests for the hand-rolled pan/zoom math (no DOM). Transform
// convention under test: with `transform-origin: 0 0`, a content point `c`
// maps to screen coordinate `screen = c * scale + t`. transformString emits
// `translate(<tx>px, <ty>px) scale(<scale>)` to match that convention.
//
// Float comparisons use an EPSILON (never ===) so a legitimate FP-rounded
// result is not treated as a failure — but the epsilon is tight enough that an
// INVERTED formula goes red.

const EPSILON = 1e-9;

describe("clampScale — bounds", () => {
  it("clamps a value below the minimum up to the minimum", () => {
    expect(clampScale(0.1)).toBe(0.3);
    expect(clampScale(-5)).toBe(0.3);
  });
  it("clamps a value above the maximum down to the maximum", () => {
    expect(clampScale(99)).toBe(4);
  });
  it("leaves a value inside the bounds unchanged", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
  });
  it("honors custom min/max args", () => {
    expect(clampScale(0.05, 0.5, 2)).toBe(0.5);
    expect(clampScale(10, 0.5, 2)).toBe(2);
    expect(clampScale(1.25, 0.5, 2)).toBe(1.25);
  });
});

describe("zoomAt — cursor-stationary invariant", () => {
  // The defining property: the CONTENT point under the cursor before the zoom
  // is still under the cursor after the zoom. Content coord under cursor is
  // (cursor - t) / scale. We assert it is unchanged within EPSILON.
  function contentUnderCursor(
    state: PanZoomState,
    cx: number,
    cy: number,
  ): { x: number; y: number } {
    return {
      x: (cx - state.tx) / state.scale,
      y: (cy - state.ty) / state.scale,
    };
  }

  it("keeps the content point under the cursor fixed when zooming in", () => {
    const before: PanZoomState = { scale: 1, tx: 30, ty: 17 };
    const cx = 220;
    const cy = 140;
    const cBefore = contentUnderCursor(before, cx, cy);
    const after = zoomAt(before, cx, cy, 1.12);
    const cAfter = contentUnderCursor(after, cx, cy);

    expect(Math.abs(cAfter.x - cBefore.x)).toBeLessThan(EPSILON);
    expect(Math.abs(cAfter.y - cBefore.y)).toBeLessThan(EPSILON);
    // Sanity: the zoom actually changed the scale.
    expect(after.scale).toBeGreaterThan(before.scale);
  });

  it("keeps the content point under the cursor fixed when zooming out", () => {
    const before: PanZoomState = { scale: 2, tx: -40, ty: 12 };
    const cx = 100;
    const cy = 250;
    const cBefore = contentUnderCursor(before, cx, cy);
    const after = zoomAt(before, cx, cy, 1 / 1.12);
    const cAfter = contentUnderCursor(after, cx, cy);

    expect(Math.abs(cAfter.x - cBefore.x)).toBeLessThan(EPSILON);
    expect(Math.abs(cAfter.y - cBefore.y)).toBeLessThan(EPSILON);
    expect(after.scale).toBeLessThan(before.scale);
  });

  it("clamps the resulting scale (cannot exceed max even with a huge factor)", () => {
    const before: PanZoomState = { scale: 3, tx: 0, ty: 0 };
    const after = zoomAt(before, 50, 50, 10);
    expect(after.scale).toBe(4);
  });

  it("clamps the resulting scale (cannot drop below min)", () => {
    const before: PanZoomState = { scale: 0.4, tx: 0, ty: 0 };
    const after = zoomAt(before, 50, 50, 0.01);
    expect(after.scale).toBe(0.3);
  });
});

describe("fitState — centered fit", () => {
  it("scales to the limiting dimension * 0.92 margin and centers", () => {
    // viewport 400x340, content 640x430.
    // raw fit = min(400/640, 340/430, 1) = min(0.625, 0.79.., 1) = 0.625
    // scale = 0.625 * 0.92 = 0.575
    const s = fitState(400, 340, 640, 430);
    expect(Math.abs(s.scale - 0.575)).toBeLessThan(1e-12);
    // centered: tx = (vw - cw*scale)/2 ; ty = (vh - ch*scale)/2
    expect(Math.abs(s.tx - (400 - 640 * s.scale) / 2)).toBeLessThan(1e-9);
    expect(Math.abs(s.ty - (340 - 430 * s.scale) / 2)).toBeLessThan(1e-9);
  });

  it("never scales up past 1 (the min(...,1) cap) for tiny content", () => {
    // content much smaller than viewport — fit must not blow it up beyond 1*margin.
    const s = fitState(800, 800, 100, 100);
    expect(s.scale).toBeLessThanOrEqual(1 * 0.92 + 1e-12);
    expect(Math.abs(s.scale - 0.92)).toBeLessThan(1e-12);
  });

  it("guards zero content dimensions (no NaN/Infinity)", () => {
    const s = fitState(400, 340, 0, 0);
    expect(Number.isFinite(s.scale)).toBe(true);
    expect(Number.isFinite(s.tx)).toBe(true);
    expect(Number.isFinite(s.ty)).toBe(true);
    expect(s.scale).toBeGreaterThan(0);
  });

  it("guards NaN content dimensions (no NaN propagation)", () => {
    const s = fitState(400, 340, NaN, NaN);
    expect(Number.isFinite(s.scale)).toBe(true);
    expect(Number.isFinite(s.tx)).toBe(true);
    expect(Number.isFinite(s.ty)).toBe(true);
  });
});

describe("svgContentSize — intrinsic size, NOT the laid-out box", () => {
  // The actual bug: mermaid 11 emits `width="100%"` and NO height attribute, so
  // the diagram's natural pixel size lives ONLY in the viewBox. With our
  // `.mermaid-stage svg { max-width:none }` rule the laid-out box stretches to the
  // viewport width, so measuring the box would feed fitState the VIEWPORT width
  // and break centering. svgContentSize must return the viewBox W/H regardless.
  function svgEl(html: string): SVGElement {
    const doc = new DOMParser().parseFromString(html, "image/svg+xml");
    return doc.documentElement as unknown as SVGElement;
  }

  it("returns the viewBox width/height even when width='100%' and no height attr (the real mermaid shape)", () => {
    // This is exactly what mermaid emits under useMaxWidth:true.
    const svg = svgEl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 800px;" viewBox="0 0 800 600"></svg>',
    );
    // INVERSION CHECK: if the derivation instead returned the laid-out box
    // (clientWidth/getBoundingClientRect → 0 in jsdom, or the viewport width in
    // the app), this assertion goes red. Here we demand the intrinsic viewBox.
    expect(svgContentSize(svg)).toEqual({ w: 800, h: 600 });
  });

  it("ignores a non-origin viewBox offset and uses only width/height (parts 3 & 4)", () => {
    // mermaid's viewBox is `${x-pad} ${y-pad} ${w+2pad} ${h+2pad}` — the min-x/
    // min-y are NOT the size. Using parts[0]/[1] instead of [2]/[3] → red.
    const svg = svgEl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="-8 -8 416 316"></svg>',
    );
    expect(svgContentSize(svg)).toEqual({ w: 416, h: 316 });
  });

  it("falls back to numeric width/height attrs when there is no viewBox (useMaxWidth:false)", () => {
    const svg = svgEl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="430"></svg>',
    );
    expect(svgContentSize(svg)).toEqual({ w: 640, h: 430 });
  });

  it("returns 0/0 (caller falls back) when neither viewBox nor numeric size is usable", () => {
    const svg = svgEl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%"></svg>',
    );
    expect(svgContentSize(svg)).toEqual({ w: 0, h: 0 });
  });

  it("returns 0/0 for a null element", () => {
    expect(svgContentSize(null)).toEqual({ w: 0, h: 0 });
  });

  it("prefers the viewBox over numeric attrs when both are present", () => {
    // viewBox is the authoritative natural size; assert it wins.
    const svg = svgEl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="25" viewBox="0 0 800 600"></svg>',
    );
    expect(svgContentSize(svg)).toEqual({ w: 800, h: 600 });
  });
});

describe("viewportHeightFor — clip frame matches the diagram aspect", () => {
  // The clip frame is no longer a fixed 340px band: a wide-short `graph LR` would
  // sit as a thin strip lost in vertical whitespace, and a tall `graph TD` would
  // be cramped/scrolled. The height is derived from the content aspect at the
  // width-limited scale, clamped to [200, 560].
  const MIN_H = 200;
  const MAX_H = 560;

  it("gives a wide-short diagram a SHORT band (clamped to the minimum)", () => {
    // 1135.875×94 in a 1058-wide frame: widthScale = min(1058/1135.875,1)*0.92
    // = 0.857; desired height = 94*0.857/0.92 = 94 → clamped up to MIN_H 200.
    // INVERSION CHECK: a fixed 340 (or using the content WIDTH for height) → red.
    expect(viewportHeightFor(1058, 1135.875, 94)).toBe(MIN_H);
  });

  it("gives a tall diagram a TALL band proportional to its height", () => {
    // 276×406 in a 1058-wide frame: width is not the constraint (276<1058) so
    // widthScale = 1*0.92; desired = 406*0.92/0.92 = 406 → within [200,560].
    expect(viewportHeightFor(1058, 276, 406)).toBe(406);
  });

  it("clamps an extremely tall diagram to the maximum", () => {
    // 200×4000: widthScale = 1*0.92; desired = 4000 → clamped down to MAX_H 560.
    expect(viewportHeightFor(1058, 200, 4000)).toBe(MAX_H);
  });

  it("scales the height down when the diagram is wider than the frame", () => {
    // 2000×400 in a 500-wide frame: widthScale = min(500/2000,1)*0.92 = 0.23;
    // desired = 400*0.23/0.92 = 100 → clamped up to MIN_H 200.
    expect(viewportHeightFor(500, 2000, 400)).toBe(MIN_H);
    // A milder case that lands strictly inside the band proves it is not always
    // pinned to the clamp: 1000×800 in 1000-wide → widthScale=0.92,
    // desired = 800 → clamped to MAX_H 560. Use 1000×500 → desired 500 (in band).
    expect(viewportHeightFor(1000, 1000, 500)).toBe(500);
  });

  it("falls back to a mid-band height for zero / non-finite content", () => {
    const mid = Math.round((MIN_H + MAX_H) / 2);
    expect(viewportHeightFor(1058, 0, 0)).toBe(mid);
    expect(viewportHeightFor(1058, NaN, NaN)).toBe(mid);
    expect(viewportHeightFor(0, 600, 150)).toBe(mid);
  });
});

describe("attachPanZoom — initial fit is deferred until the viewport is sized", () => {
  // The PRIMARY trigger of the centering bug: buildPanZoomBox calls attachPanZoom
  // while the box is still DETACHED, so the viewport reports clientWidth/Height 0.
  // A synchronous fit at that moment produces an off-center transform. The fix
  // defers the initial fit until the viewport has a real layout box. jsdom has no
  // layout, so we drive clientWidth/clientHeight directly.
  function sizedViewport(w: number, h: number): {
    viewport: HTMLElement;
    stage: HTMLElement;
    setSize: (w: number, h: number) => void;
  } {
    const viewport = document.createElement("div");
    const stage = document.createElement("div");
    // mermaid-shaped SVG: width="100%", no height, viewBox carries the size.
    stage.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 800 600"></svg>';
    viewport.appendChild(stage);

    let cw = w;
    let ch = h;
    Object.defineProperty(viewport, "clientWidth", { get: () => cw });
    Object.defineProperty(viewport, "clientHeight", { get: () => ch });
    return {
      viewport,
      stage,
      setSize: (nw, nh) => {
        cw = nw;
        ch = nh;
      },
    };
  }

  it("does NOT fit synchronously while the viewport is unsized (clientWidth 0)", () => {
    const { viewport, stage } = sizedViewport(0, 0);
    const c = attachPanZoom(viewport, stage);
    // Identity state — no broken off-center transform was written eagerly.
    expect(c.getState()).toEqual({ scale: 1, tx: 0, ty: 0 });
    c.destroy();
  });

  it("fits synchronously and CENTERS when the viewport is already sized", () => {
    // viewport 400x340, content 800x600 → raw = min(400/800,340/600,1)=0.5
    // scale = 0.5 * 0.92 = 0.46 ; centered tx/ty per fitState.
    const { viewport, stage } = sizedViewport(400, 340);
    const c = attachPanZoom(viewport, stage);
    const s = c.getState();
    const expected = fitState(400, 340, 800, 600);
    expect(Math.abs(s.scale - expected.scale)).toBeLessThan(1e-9);
    expect(Math.abs(s.tx - expected.tx)).toBeLessThan(1e-9);
    expect(Math.abs(s.ty - expected.ty)).toBeLessThan(1e-9);
    // It must have used the INTRINSIC 800x600 (viewBox), not a 0/viewport size:
    // a positive centered scale of 0.46 proves real content dims were fed in.
    expect(Math.abs(s.scale - 0.46)).toBeLessThan(1e-9);
    c.destroy();
  });

  it("sets the viewport's inline height to the adaptive value on fit", () => {
    // viewport width 400, content 800×600 → widthScale=min(400/800,1)*0.92=0.46;
    // desired height = 600*0.46/0.92 = 300 (inside [200,560]).
    const { viewport, stage } = sizedViewport(400, 340);
    const c = attachPanZoom(viewport, stage);
    // INVERSION CHECK: if fit() did not size the frame to the content aspect (the
    // old fixed-340 band), viewport.style.height would stay "" → this goes red.
    expect(viewport.style.height).toBe("300px");
    c.destroy();
  });

  it("the deferred initial fit runs once the viewport gains a size (rAF), and centers", async () => {
    const { viewport, stage, setSize } = sizedViewport(0, 0);
    const c = attachPanZoom(viewport, stage);
    expect(c.getState()).toEqual({ scale: 1, tx: 0, ty: 0 });

    // The viewport gets laid out (as happens after replaceWith inserts the box).
    setSize(400, 340);
    // Let the armed requestAnimationFrame callback run.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const s = c.getState();
    const expected = fitState(400, 340, 800, 600);
    // INVERSION CHECK: with the old synchronous fit() (no deferral), this state
    // would have been frozen at the unsized fitState(0,0,800,600) — a negative,
    // off-center tx/ty — and never re-fit. Asserting the centered fit goes red.
    expect(Math.abs(s.scale - expected.scale)).toBeLessThan(1e-9);
    expect(Math.abs(s.tx - expected.tx)).toBeLessThan(1e-9);
    expect(Math.abs(s.ty - expected.ty)).toBeLessThan(1e-9);
    expect(s.scale).toBeGreaterThan(0);
    c.destroy();
  });
});

describe("transformString — exact format", () => {
  it("emits translate(tx px, ty px) scale(scale)", () => {
    expect(transformString({ scale: 1.5, tx: 10, ty: -20 })).toBe(
      "translate(10px, -20px) scale(1.5)",
    );
  });
  it("emits the identity transform for the unit state", () => {
    expect(transformString({ scale: 1, tx: 0, ty: 0 })).toBe(
      "translate(0px, 0px) scale(1)",
    );
  });
});
