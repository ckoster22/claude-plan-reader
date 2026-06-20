// Conversation Minimap — pure-function invariant tests.
//
// jsdom does not compute layout (offsetTop/offsetHeight/clientHeight are 0), so the createMinimap
// controller is intentionally not unit-tested here — the PURE functions (classifyTier / computeBlocks
// / computeViewport) are the tested seam. Each test asserts an INVARIANT, not the current
// implementation's output, and the suite includes a falsifiability check (a swapped-order classify
// would fail the dual-class user case).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyTier,
  computeBlocks,
  computeViewport,
  createMinimap,
  MIN_BLOCK_PX,
  MIN_VIEWPORT_PX,
  type MiniTier,
} from "./minimap";
import { renderTree } from "./render";
import type { ErrorNode, QuestionRequestNode, RenderTree, ResultNode } from "./stream";

function elWithClass(className: string): Element {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

describe("classifyTier — tier classification (pure)", () => {
  it("classifies a DUAL-CLASS user bubble (conv-text + conv-text-user) as 'user'", () => {
    // render.ts:346-347 — a user bubble carries BOTH classes. conv-text-user MUST be tested first.
    // Falsifiability: if classifyTier checked conv-text before conv-text-user, this returns
    // "assistant" and the test fails (confirmed by the temporary swap noted in the report).
    expect(classifyTier(elWithClass("conv-text conv-text-user"))).toBe("user");
  });

  it("classifies a plain conv-text bubble as 'assistant'", () => {
    expect(classifyTier(elWithClass("conv-text"))).toBe("assistant");
  });

  it("classifies a DUAL-CLASS system bubble (conv-text + conv-text-system) as 'meta'", () => {
    // A plumbing bubble carries BOTH classes (render.ts). conv-text-system MUST be tested BEFORE
    // the conv-text → assistant fallthrough. Falsifiability: if classifyTier checked conv-text first
    // (or dropped the conv-text-system check), this returns "assistant" and the test fails.
    expect(classifyTier(elWithClass("conv-text conv-text-system"))).toBe("meta");
  });

  it("classifies a tool row (conv-tool) as 'meta'", () => {
    expect(classifyTier(elWithClass("conv-tool"))).toBe("meta");
  });

  it("classifies a subagent group (conv-subagent) as 'meta'", () => {
    expect(classifyTier(elWithClass("conv-subagent"))).toBe("meta");
  });

  it("classifies the transient working indicator (conv-working) as 'meta'", () => {
    // conv-working is excluded upstream, but classification must still be defined.
    expect(classifyTier(elWithClass("conv-working"))).toBe("meta");
  });

  it("classifies an unknown element as 'meta'", () => {
    expect(classifyTier(elWithClass("conv-result"))).toBe("meta");
  });

  it("classifies an AskUserQuestion card (rendered via the REAL render path) as 'user'", () => {
    // INVARIANT: a question card is human-input solicitation (the user's choice is captured there),
    // so the minimap must paint it in the ORANGE "user" tier — NOT the dim "meta" tier where
    // tool/system plumbing rows live.
    //
    // Drive the REAL path: build the same QuestionRequestNode the controller derives and render it
    // through renderTree(), then classify the actual top-level element the minimap iterates
    // (stream.children[0]). This guarantees we test the element render.ts truly emits (className
    // "conv-question"), not a hand-built stand-in.
    //
    // Falsifiability: WITHOUT the `conv-question` → "user" branch in classifyTier, the card carries
    // neither conv-text-user nor conv-text, so classifyTier falls through to the final "meta" return
    // and this assertion fails (.toBe("meta") instead of "user") — confirmed by removing the branch.
    const questionNode: QuestionRequestNode = {
      type: "question_request",
      seq: 1,
      id: "tool-use-q1",
      answers: null,
      questions: [
        {
          question: "Which approach should we take?",
          header: "Approach",
          options: [
            { label: "Option A", description: "first" },
            { label: "Option B", description: "second" },
          ],
          multiSelect: false,
        },
      ],
    };
    const tree: RenderTree = {
      nodes: [questionNode],
      permissionMode: null,
      complete: false,
      working: null,
    };

    const stream = document.createElement("div");
    renderTree(stream, tree);

    // The minimap iterates stream.children; the question card is the single top-level child.
    expect(stream.children).toHaveLength(1);
    const card = stream.children[0];
    expect(card.classList.contains("conv-question")).toBe(true);
    // Guard the design constraint: the card must NOT carry the user-BUBBLE class (which would
    // visually corrupt it). Its minimap tier comes purely from classifyTier's conv-question branch.
    expect(card.classList.contains("conv-text-user")).toBe(false);

    expect(classifyTier(card)).toBe("user");
  });

  // ---- danger tier: loud failure rows must NOT collapse to the dim meta tier ----

  it("classifies a diagnostic error row (conv-error) as 'danger'", () => {
    // INVARIANT: an error row is a loud, session-relevant failure — the navigator must paint it in the
    // RED danger tier, not the dim meta tier. Falsifiability: WITHOUT the conv-error → danger branch
    // this falls through to the final "meta" return and the assertion fails.
    expect(classifyTier(elWithClass("conv-error"))).toBe("danger");
  });

  it("classifies a FATAL error row (conv-error conv-error-fatal) as 'danger'", () => {
    // The fatal variant always ALSO carries conv-error, so the base conv-error branch covers it.
    expect(classifyTier(elWithClass("conv-error conv-error-fatal"))).toBe("danger");
  });

  it("classifies a denied-permission row (conv-perm-denied) as 'danger'", () => {
    expect(classifyTier(elWithClass("conv-perm-denied"))).toBe("danger");
  });

  it("classifies a FAILED result (conv-result conv-result-error) as 'danger'", () => {
    // The failed-result element carries BOTH classes (render.ts). conv-result-error must be matched
    // specifically. Falsifiability: WITHOUT the conv-result-error → danger branch this returns "meta".
    expect(classifyTier(elWithClass("conv-result conv-result-error"))).toBe("danger");
  });

  it("KEEPS a plain success result (conv-result) as 'meta' — not danger", () => {
    // Precedence guard: only conv-result-ERROR is danger; bare conv-result success stays meta.
    // Falsifiability: if the danger branch matched bare conv-result, this returns "danger" and fails.
    expect(classifyTier(elWithClass("conv-result"))).toBe("meta");
  });

  it("KEEPS an interrupted result (conv-result conv-result-interrupted) as 'meta' — not danger", () => {
    // A deliberate interrupt is calm/truthful, NOT a failure — it must stay meta, never danger.
    expect(classifyTier(elWithClass("conv-result conv-result-interrupted"))).toBe("meta");
  });

  it("classifies a fatal error rendered via the REAL render path as 'danger'", () => {
    // Drive the REAL path: render an ErrorNode through renderTree() and classify the actual top-level
    // element the minimap iterates (stream.children[0]). This guarantees we test render.ts's true
    // emitted classes (conv-error / conv-error-fatal), not a hand-built stand-in.
    // Falsifiability: WITHOUT the conv-error → danger branch, classifyTier falls through to "meta".
    const errorNode: ErrorNode = {
      type: "error",
      seq: 1,
      errorKind: "sdk",
      message: "boom",
      fatal: true,
    };
    const tree: RenderTree = {
      nodes: [errorNode],
      permissionMode: null,
      complete: false,
      working: null,
    };
    const stream = document.createElement("div");
    renderTree(stream, tree);

    expect(stream.children).toHaveLength(1);
    const row = stream.children[0];
    expect(row.classList.contains("conv-error")).toBe(true);
    expect(row.classList.contains("conv-error-fatal")).toBe(true);
    expect(classifyTier(row)).toBe("danger");
  });

  it("classifies a FAILED result rendered via the REAL render path as 'danger', while a SUCCESS result stays 'meta'", () => {
    // Drive the REAL path for both the failed and the success result, asserting the precedence split:
    // conv-result-error → danger, plain conv-result → meta. Falsifiability: without the
    // conv-result-error branch the failed row returns "meta"; if the branch matched bare conv-result,
    // the success row returns "danger". Both halves catch a wrong implementation.
    const failedNode: ResultNode = {
      type: "result",
      seq: 1,
      isError: true,
      result: "exploded",
      subtype: "error_during_execution",
      deliberateInterrupt: false,
    };
    const successNode: ResultNode = {
      type: "result",
      seq: 2,
      isError: false,
      result: "",
      subtype: "success",
      deliberateInterrupt: false,
    };
    const tree: RenderTree = {
      nodes: [failedNode, successNode],
      permissionMode: null,
      complete: true,
      working: null,
    };
    const stream = document.createElement("div");
    renderTree(stream, tree);

    expect(stream.children).toHaveLength(2);
    const failed = stream.children[0];
    const success = stream.children[1];
    expect(failed.classList.contains("conv-result-error")).toBe(true);
    expect(success.classList.contains("conv-result-error")).toBe(false);
    expect(success.classList.contains("conv-result")).toBe(true);

    expect(classifyTier(failed)).toBe("danger");
    expect(classifyTier(success)).toBe("meta");
  });
});

describe("computeBlocks — contiguous tiling (pure)", () => {
  it("tiles three children contiguously and proportionally with no overlap or overflow", () => {
    const children: { height: number; tier: MiniTier }[] = [
      { height: 100, tier: "user" },
      { height: 300, tier: "assistant" },
      { height: 100, tier: "meta" },
    ];
    const mapHeight = 500;
    const blocks = computeBlocks(children, mapHeight);

    expect(blocks).toHaveLength(3);

    // Contiguity invariant: each block.top === cumulative sum of prior block heights.
    let cumulative = 0;
    for (const b of blocks) {
      expect(b.top).toBeCloseTo(cumulative, 6);
      cumulative += b.height;
    }

    // No overflow: last block flush-or-within the gutter.
    const last = blocks[blocks.length - 1];
    expect(last.top + last.height).toBeLessThanOrEqual(mapHeight + 1e-6);

    // Proportional: middle child is 3x the others → its block ~3x taller.
    expect(blocks[1].height).toBeGreaterThan(blocks[0].height * 2.5);
    expect(blocks[1].height).toBeCloseTo(blocks[0].height * 3, 4);

    // index carried through in input order.
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2]);
    // tier carried through.
    expect(blocks.map((b) => b.tier)).toEqual(["user", "assistant", "meta"]);
  });

  it("drops the MIN_BLOCK_PX floor in the large-N case (N*MIN > mapHeight) — no overflow, no overlap", () => {
    // 400 children * 3px floor = 1200 > 600 → floor must be dropped (pure proportional).
    const children: { height: number; tier: MiniTier }[] = Array.from({ length: 400 }, () => ({
      height: 10,
      tier: "assistant" as MiniTier,
    }));
    const mapHeight = 600;
    const blocks = computeBlocks(children, mapHeight);

    expect(blocks).toHaveLength(400);

    // No single block exceeds the gutter, no block overflows, contiguous.
    let cumulative = 0;
    for (const b of blocks) {
      expect(b.height).toBeLessThanOrEqual(mapHeight);
      expect(b.top).toBeCloseTo(cumulative, 6);
      cumulative += b.height;
    }
    const last = blocks[blocks.length - 1];
    expect(last.top + last.height).toBeLessThanOrEqual(mapHeight + 1e-6);

    // Floor was dropped: equal heights of 600/400 = 1.5px, BELOW the 3px floor.
    expect(blocks[0].height).toBeCloseTo(mapHeight / 400, 4);
    expect(blocks[0].height).toBeLessThan(MIN_BLOCK_PX);
  });

  it("applies the MIN_BLOCK_PX floor when the budget allows (tiny messages stay visible)", () => {
    // 2 tiny children, large gutter → both get at least the floor.
    const children: { height: number; tier: MiniTier }[] = [
      { height: 1, tier: "user" },
      { height: 1, tier: "assistant" },
    ];
    const mapHeight = 1000;
    const blocks = computeBlocks(children, mapHeight);

    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b.height).toBeGreaterThanOrEqual(MIN_BLOCK_PX);
    }
    // Still contiguous + within budget.
    expect(blocks[0].top).toBe(0);
    expect(blocks[1].top).toBeCloseTo(blocks[0].height, 6);
    const last = blocks[1];
    expect(last.top + last.height).toBeLessThanOrEqual(mapHeight + 1e-6);
  });

  it("returns [] for empty input", () => {
    expect(computeBlocks([], 500)).toEqual([]);
  });

  it("returns [] when total content height is 0", () => {
    const children: { height: number; tier: MiniTier }[] = [
      { height: 0, tier: "user" },
      { height: 0, tier: "assistant" },
    ];
    expect(computeBlocks(children, 500)).toEqual([]);
  });

  it("returns [] when mapHeight <= 0", () => {
    const children: { height: number; tier: MiniTier }[] = [{ height: 100, tier: "user" }];
    expect(computeBlocks(children, 0)).toEqual([]);
    expect(computeBlocks(children, -10)).toEqual([]);
  });
});

describe("computeViewport — indicator rectangle (pure)", () => {
  it("spans the full gutter at the top when content fits (scrollHeight == clientHeight)", () => {
    expect(computeViewport(0, 500, 500, 200)).toEqual({ top: 0, height: 200 });
  });

  it("spans the full gutter when content is shorter than the viewport", () => {
    expect(computeViewport(0, 500, 300, 200)).toEqual({ top: 0, height: 200 });
  });

  it("places a proportionally-sized box at a proportional offset mid-scroll", () => {
    // scrollHeight 1000, clientHeight 200, mapHeight 200 → height = (200/1000)*200 = 40.
    // scrollTop 400 → top = (400/1000)*200 = 80.
    const vp = computeViewport(400, 200, 1000, 200);
    expect(vp.height).toBeCloseTo(40, 6);
    expect(vp.top).toBeCloseTo(80, 6);
    expect(vp.top + vp.height).toBeLessThanOrEqual(200 + 1e-6);
  });

  it("sits flush against the bottom when scrolled to the bottom", () => {
    // scrollTop = scrollHeight - clientHeight = 800 → box bottom flush with gutter bottom.
    const mapHeight = 200;
    const vp = computeViewport(800, 200, 1000, mapHeight);
    expect(vp.top + vp.height).toBeCloseTo(mapHeight, 6);
  });

  it("enforces a minimum indicator height for very long content", () => {
    // clientHeight tiny relative to scrollHeight → raw height below MIN_VIEWPORT_PX → clamped up.
    const vp = computeViewport(0, 10, 100000, 200);
    expect(vp.height).toBe(MIN_VIEWPORT_PX);
  });

  it("spans the full gutter when scrollHeight <= 0 (guard)", () => {
    expect(computeViewport(0, 0, 0, 200)).toEqual({ top: 0, height: 200 });
  });
});

// The createMinimap controller is a DOM adapter not normally unit-tested (jsdom has no layout). But
// the deadlock bug is exactly a MEASUREMENT-SOURCE choice, which we CAN exercise by stubbing
// clientHeight/offset geometry via Object.defineProperty (as sticky-scroll.test.ts does). This test
// pins the fix: the gutter height must come from the STREAM, not the (possibly is-empty/hidden)
// minimap element, so the minimap can recover when the pane becomes visible.
describe("createMinimap — measures the gutter from the stream, not the (hideable) minimap element", () => {
  beforeEach(() => {
    // Synchronous rAF so rebuild() paints within the test without real animation frames. Returns 0
    // deliberately: production assigns `rebuildRaf = requestAnimationFrame(paint)` AFTER paint runs
    // (paint resets it to 0 first). With a real async rAF the handle is nonzero and paint runs later;
    // with a synchronous stub, paint runs first and the stub's return value is what sticks in
    // rebuildRaf — returning 0 keeps the coalescing flag clear so a subsequent rebuild() is not a no-op.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // ResizeObserver / MutationObserver exist in jsdom; if not, provide inert stubs.
    if (typeof ResizeObserver === "undefined") {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function defineH(el: HTMLElement, height: number): void {
    Object.defineProperty(el, "clientHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "scrollHeight", { get: () => height * 4, configurable: true });
    Object.defineProperty(el, "offsetHeight", { get: () => height, configurable: true });
  }

  it("recovers (removes is-empty, paints blocks) when the minimap element is hidden (clientHeight 0) but the stream is visible", () => {
    const stream = document.createElement("div");
    const minimap = document.createElement("div");
    document.body.append(stream, minimap);

    // Two real message children with nonzero rendered heights.
    for (const cls of ["conv-text conv-text-user", "conv-text"]) {
      const child = document.createElement("div");
      child.className = cls;
      Object.defineProperty(child, "offsetTop", { get: () => 0, configurable: true });
      Object.defineProperty(child, "offsetHeight", { get: () => 50, configurable: true });
      stream.appendChild(child);
    }

    // The stream is visible (real gutter height); the minimap is hidden (display:none → 0).
    defineH(stream, 300);
    Object.defineProperty(minimap, "clientHeight", { get: () => 0, configurable: true });

    const controller = createMinimap(stream, minimap);
    // Simulate the deadlock entry: minimap starts marked empty/hidden.
    minimap.classList.add("is-empty");

    controller.rebuild();

    // FIX: measuring from the stream yields a real mapHeight → blocks painted → is-empty removed.
    // Falsifiability: if the controller measured minimap.clientHeight (0), computeBlocks returns []
    // and the minimap stays is-empty with no blocks (the deadlock) — this assertion fails.
    expect(minimap.classList.contains("is-empty")).toBe(false);
    expect(minimap.querySelectorAll(".conv-minimap-block")).toHaveLength(2);

    controller.destroy();
  });

  it("stays empty when the stream itself is hidden (clientHeight 0) — recovers on the activation rebuild", () => {
    const stream = document.createElement("div");
    const minimap = document.createElement("div");
    document.body.append(stream, minimap);
    const child = document.createElement("div");
    child.className = "conv-text";
    Object.defineProperty(child, "offsetTop", { get: () => 0, configurable: true });
    Object.defineProperty(child, "offsetHeight", { get: () => 50, configurable: true });
    stream.appendChild(child);

    // Whole pane display:none → stream clientHeight 0 too.
    defineH(stream, 0);
    Object.defineProperty(minimap, "clientHeight", { get: () => 0, configurable: true });

    const controller = createMinimap(stream, minimap);
    controller.rebuild();
    expect(minimap.classList.contains("is-empty")).toBe(true);

    // Pane activated → stream now has a real height. The activation rebuild recovers it.
    defineH(stream, 300);
    controller.rebuild();
    expect(minimap.classList.contains("is-empty")).toBe(false);
    expect(minimap.querySelectorAll(".conv-minimap-block")).toHaveLength(1);

    controller.destroy();
  });
});
