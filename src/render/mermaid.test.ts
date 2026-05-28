import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeSvg, renderDiagrams, setIntrinsicSvgSize } from "./mermaid";
import { renderInto } from "./index";

// Mock the lazily-imported mermaid module so renderDiagrams() runs under jsdom
// without the real (heavy, DOM-measuring) mermaid bundle. The mock echoes a
// deterministic SVG so the structure assertions are exact.
const renderMock = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

// Spy harness for FIX A: wrap the REAL attachPanZoom so every controller it
// returns has its `destroy` replaced by a spy that still calls through. This lets
// us assert teardown is invoked WITHOUT changing any pan/zoom behavior — the real
// controller is fully wired; we only observe `destroy`.
const destroySpies: ReturnType<typeof vi.fn>[] = [];
vi.mock("./panzoom", async () => {
  const actual = await vi.importActual<typeof import("./panzoom")>("./panzoom");
  return {
    ...actual,
    attachPanZoom: (...args: Parameters<typeof actual.attachPanZoom>) => {
      const controller = actual.attachPanZoom(...args);
      const realDestroy = controller.destroy.bind(controller);
      const spy = vi.fn(() => realDestroy());
      destroySpies.push(spy);
      controller.destroy = spy;
      return controller;
    },
  };
});

// Fix 2 proof: mermaid runs under securityLevel:"loose", which SKIPS mermaid's
// internal DOMPurify. We sanitize the SVG ourselves before innerHTML injection.
// These tests assert that our sanitize config (svg + html profile) closes the XSS
// hole (strips <script> + on* handlers) WITHOUT breaking multi-line labels
// (<foreignObject> + <br> are preserved). DOMPurify runs natively under jsdom.

describe("sanitizeSvg — strips active content", () => {
  it("removes an onerror event-handler attribute injected into a label", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<image href="x" onerror="alert(1)" />' +
      "</svg>";
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("alert(1)");
  });

  it("removes a <script> element embedded in the SVG", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<script>window.__pwned = true;</script>' +
      "<rect/></svg>";
    const clean = sanitizeSvg(dirty);
    expect(clean.toLowerCase()).not.toContain("<script");
    expect(clean).not.toContain("__pwned");
  });

  it("removes an onclick handler on a foreignObject label", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>' +
      '<div xmlns="http://www.w3.org/1999/xhtml" onclick="steal()">hi</div>' +
      "</foreignObject></svg>";
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("steal()");
  });
});

describe("sanitizeSvg — preserves multi-line label fidelity", () => {
  it("keeps <br> inside a foreignObject label", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>' +
      '<div xmlns="http://www.w3.org/1999/xhtml">line one<br/>line two</div>' +
      "</foreignObject></svg>";
    const clean = sanitizeSvg(svg);
    expect(clean.toLowerCase()).toContain("<br");
  });

  it("keeps the <foreignObject> wrapper that carries HTML labels", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>' +
      '<div xmlns="http://www.w3.org/1999/xhtml">label</div>' +
      "</foreignObject></svg>";
    const clean = sanitizeSvg(svg);
    expect(clean.toLowerCase()).toContain("foreignobject");
    expect(clean).toContain("label");
  });

  it("keeps core SVG geometry (path/rect/g)", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<g><rect width="10" height="10"/><path d="M0 0 L10 10"/></g></svg>';
    const clean = sanitizeSvg(svg);
    expect(clean).toContain("<rect");
    expect(clean).toContain("<path");
  });
});

// ---- setIntrinsicSvgSize: pin the SVG to its viewBox pixel size --------------
//
// THE MEASURED ROOT CAUSE of the "too small / left-shifted" fit bug: mermaid 11
// emits `width="100%"`, `style="max-width:<W>px"`, and NO height. Inside the
// absolutely-positioned, auto-width `.mermaid-stage` (with `max-width:none`
// removing the cap), `width:100%` has no containing-block width to resolve
// against, so the SVG COLLAPSES to the CSS replaced-element default (~300px) —
// while the pan/zoom fit reads the diagram size from the viewBox (e.g. 1135).
// Centering is then computed for a box ~3.8× wider than what is drawn. Pinning
// explicit pixel width/height from the viewBox makes the laid-out box equal the
// intrinsic diagram box so fit/centering agree.
describe("setIntrinsicSvgSize — pins the SVG to its viewBox pixel size", () => {
  function stageWith(svgHtml: string): HTMLElement {
    const stage = document.createElement("div");
    stage.innerHTML = svgHtml;
    return stage;
  }

  it("replaces width='100%'/no-height with explicit pixel width+height from the viewBox", () => {
    // Exactly the mermaid-under-useMaxWidth shape that triggered the bug.
    const stage = stageWith(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 1135.875px;" viewBox="0 0 1135.875 94"></svg>',
    );
    setIntrinsicSvgSize(stage);
    const svg = stage.querySelector("svg")!;
    // INVERSION CHECK: if the function were a no-op (the old behavior), width
    // would still be "100%" and height absent → these go red. We demand the
    // intrinsic viewBox pixels so the laid-out box matches the fit's contentSize.
    expect(svg.getAttribute("width")).toBe("1135.875");
    expect(svg.getAttribute("height")).toBe("94");
    // The max-width cap mermaid set must be cleared so it cannot shrink the pin.
    expect(svg.style.maxWidth).toBe("");
  });

  it("uses the viewBox W/H (parts 3 & 4), not its min-x/min-y offset", () => {
    const stage = stageWith(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="-8 -8 416 316"></svg>',
    );
    setIntrinsicSvgSize(stage);
    const svg = stage.querySelector("svg")!;
    // If parts[0]/[1] (the -8 offsets) leaked in, width would be "-8" → red.
    expect(svg.getAttribute("width")).toBe("416");
    expect(svg.getAttribute("height")).toBe("316");
  });

  it("no-ops when the SVG carries no usable intrinsic size (keeps width='100%')", () => {
    const stage = stageWith(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%"></svg>',
    );
    setIntrinsicSvgSize(stage);
    const svg = stage.querySelector("svg")!;
    // No viewBox, no numeric attrs → svgContentSize returns 0/0 → leave as-is
    // rather than pinning a 0×0 box (which would collapse the diagram entirely).
    expect(svg.getAttribute("width")).toBe("100%");
    expect(svg.getAttribute("height")).toBeNull();
  });

  it("does not throw when there is no SVG in the stage", () => {
    const stage = stageWith("<div>no svg here</div>");
    expect(() => setIntrinsicSvgSize(stage)).not.toThrow();
  });
});

describe("renderDiagrams — wraps the sanitized SVG in a pan/zoom viewport", () => {
  beforeEach(() => {
    renderMock.mockReset();
  });

  function pane(srcHtml: string): HTMLElement {
    const el = document.createElement("div");
    el.id = "reading-pane";
    el.innerHTML = srcHtml;
    // attachPanZoom reads viewport client sizes; jsdom reports 0, which is fine
    // (fitState guards it) but we attach to the document so layout queries work.
    document.body.appendChild(el);
    return el;
  }

  it("builds .mermaid-viewport > .mermaid-stage holding the SVG, plus controls + readout", async () => {
    renderMock.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="10" height="10" data-marker="geom"/></svg>',
    });

    const el = pane('<pre class="mermaid-src">graph TD; A--&gt;B</pre>');
    await renderDiagrams(el);

    const box = el.querySelector(".mermaid-box");
    expect(box).not.toBeNull();

    // The transformed-wrapper structure must exist (old direct-injection put the
    // SVG straight into .mermaid-box, so .mermaid-stage would be null → red).
    const viewport = box!.querySelector<HTMLElement>(".mermaid-viewport");
    expect(viewport).not.toBeNull();
    const stage = viewport!.querySelector<HTMLElement>(".mermaid-stage");
    expect(stage).not.toBeNull();

    // The SANITIZED svg lives INSIDE the stage (not bare in the box).
    const svg = stage!.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('[data-marker="geom"]')).not.toBeNull();

    // Controls + readout present.
    const ctl = box!.querySelector(".mermaid-ctl");
    expect(ctl).not.toBeNull();
    // +, −, reset buttons.
    expect(ctl!.querySelectorAll("button").length).toBe(3);
    expect(box!.querySelector(".mermaid-zoom-readout")).not.toBeNull();
  });

  it("pins the rendered SVG to its viewBox pixel size inside the stage (the fit-size fix)", async () => {
    // mermaid-shaped output: width:100%, max-width style, no height, size in viewBox.
    renderMock.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 600px;" viewBox="0 0 600 150"><rect/></svg>',
    });

    const el = pane('<pre class="mermaid-src">graph LR; A--&gt;B</pre>');
    await renderDiagrams(el);

    const svg = el.querySelector<SVGElement>(".mermaid-stage svg")!;
    // INVERSION CHECK: drop setIntrinsicSvgSize from buildPanZoomBox and width
    // stays "100%"/height stays absent → these assertions go red.
    expect(svg.getAttribute("width")).toBe("600");
    expect(svg.getAttribute("height")).toBe("150");
  });

  it("keeps the SVG sanitized inside the stage (no injected script survives)", async () => {
    renderMock.mockResolvedValue({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
        "<script>window.__pwned_mermaid = true;</script><rect/></svg>",
    });

    const el = pane('<pre class="mermaid-src">graph TD; A</pre>');
    await renderDiagrams(el);

    const stage = el.querySelector(".mermaid-stage");
    expect(stage).not.toBeNull();
    expect(stage!.innerHTML.toLowerCase()).not.toContain("<script");
    expect(
      (window as unknown as { __pwned_mermaid?: boolean }).__pwned_mermaid,
    ).toBeUndefined();
  });
});

// ---- FIX A: controller teardown is tied to the DOM wipe in renderInto --------
//
// renderInto wipes the pane (`paneEl.innerHTML = …`), which DETACHES the previous
// render's `.mermaid-viewport` elements. The pan/zoom controllers bound to those
// viewports register `window` drag listeners that would otherwise outlive the
// detached DOM. FIX A calls destroyControllers() at the EXACT innerHTML wipe so
// teardown happens on every wipe path independent of whether the async settle()/
// renderDiagrams() that follows ever runs. This drives the REAL renderInto so the
// test covers FIX A specifically.
//
// Falsifiability (verified): removing the destroyControllers() call added inside
// renderInto AND the one at the top of renderDiagrams makes the destroy spy never
// fire → `toHaveBeenCalledTimes(1)` goes RED. Restored → green.
describe("renderInto — tears down the previous render's pan/zoom controller (FIX A)", () => {
  beforeEach(() => {
    renderMock.mockReset();
    destroySpies.length = 0;
  });

  it("calls the first render's controller.destroy exactly once when renderInto wipes the pane", async () => {
    renderMock.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect/></svg>',
    });

    const el = document.createElement("div");
    el.id = "reading-pane";
    el.innerHTML = '<pre class="mermaid-src">graph TD; A--&gt;B</pre>';
    document.body.appendChild(el);

    // FIRST render: produces controller #0, registered in the pane's WeakMap.
    await renderDiagrams(el);
    expect(destroySpies).toHaveLength(1);
    const firstDestroy = destroySpies[0];
    expect(firstDestroy).not.toHaveBeenCalled();

    // SECOND render via the REAL renderInto path: the innerHTML wipe must tear
    // down controller #0. renderInto is synchronous, so by the time it returns
    // the first controller's destroy must already have run exactly once.
    renderInto(el, "```mermaid\ngraph TD; C-->D\n```\n", "");
    expect(firstDestroy).toHaveBeenCalledTimes(1);

    // And the pane was actually re-wiped to a fresh mermaid placeholder (proves we
    // exercised the real wipe, not a no-op): the old rendered box is gone.
    expect(el.querySelector(".mermaid-rendered")).toBeNull();
    expect(el.querySelector("pre.mermaid-src")).not.toBeNull();
  });
});
