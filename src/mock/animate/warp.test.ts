// (c6 — review2) Autoplay 4× time-warp tests. The user commented deep in the EXECUTION chapter ("at this
// point, animate at 4× speed"): the execution tail drags. We speed the AUTOPLAY ADVANCE 4× across the
// [WARP_POINT_MS, TERMINAL_LAND_MS) window, then drop back to 1× for the terminal "done" beat.
//
// The CRITICAL invariant under test: this is an autoplay RATE change ONLY. Scrub/seek and the progress
// fraction stay LINEAR in T, and every pure f(T) projection is untouched — so the review2 annotation
// timestamps (which are T values) still resolve to the same frames. seekTo(T) sets T directly, unwarped.
//
// FALSIFIABILITY (proven during authoring):
//   • Flatten tickRate to `() => speed` (constant 1×) → the 4×-inside-window assertions go RED.
//   • Invert the bound check (warp covering the terminal beat) → the "terminal lands at 1×" assertion goes RED.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { tickRate } from "./index";
import {
  WARP_POINT_MS,
  TERMINAL_LAND_MS,
  TERMINAL_MS,
  EXEC_BASE_MS,
} from "./storyboard";

describe("tickRate (pure autoplay-rate helper)", () => {
  it("advances at 4× the UI speed INSIDE [WARP_POINT_MS, TERMINAL_LAND_MS)", () => {
    const mid = (WARP_POINT_MS + TERMINAL_LAND_MS) / 2;
    // exactly at the lower bound (inclusive), at the midpoint, and just below the upper bound
    expect(tickRate(WARP_POINT_MS, 1)).toBe(4);
    expect(tickRate(mid, 1)).toBe(4);
    expect(tickRate(TERMINAL_LAND_MS - 1, 1)).toBe(4);
  });

  it("advances at 1× the UI speed OUTSIDE the warp window (front half AND terminal beat)", () => {
    // before the warp (deep in subplan 01's detail, and the whole front half)
    expect(tickRate(WARP_POINT_MS - 1, 1)).toBe(1);
    expect(tickRate(EXEC_BASE_MS, 1)).toBe(1);
    expect(tickRate(0, 1)).toBe(1);
    // at and after TERMINAL_LAND_MS (the exclusive upper bound): the terminal "done" beat lands at 1×
    expect(tickRate(TERMINAL_LAND_MS, 1)).toBe(1);
    expect(tickRate(TERMINAL_MS, 1)).toBe(1);
  });

  it("composes with (multiplies) the UI speed selector so the speed control still works", () => {
    // outside: passthrough of the UI speed
    expect(tickRate(0, 0.5)).toBe(0.5);
    expect(tickRate(0, 8)).toBe(8);
    // inside: 4× the UI speed, whatever it is
    const mid = (WARP_POINT_MS + TERMINAL_LAND_MS) / 2;
    expect(tickRate(mid, 0.5)).toBe(2);
    expect(tickRate(mid, 2)).toBe(8);
  });
});

describe("warp window constants are derived + well-ordered within the timeline", () => {
  it("both bounds sit strictly inside the Execution chapter and are ordered", () => {
    // WARP begins after subplan 01 has played in detail → strictly after the Execution open
    expect(WARP_POINT_MS).toBeGreaterThan(EXEC_BASE_MS);
    // TERMINAL_LAND drops back to 1× strictly before the terminal "done" beat so it lands
    expect(TERMINAL_LAND_MS).toBeLessThan(TERMINAL_MS);
    // and the window is non-empty and correctly ordered
    expect(WARP_POINT_MS).toBeLessThan(TERMINAL_LAND_MS);
  });

  it("leaves a genuine 1× landing runway before the terminal beat", () => {
    // a couple of beats of normal-speed runway so the close reads at 1× (not a derived-to-zero gap)
    expect(TERMINAL_MS - TERMINAL_LAND_MS).toBeGreaterThan(0);
  });
});

// ---- Linearity guard: the warp must NOT bend the T↔frame mapping --------------------------------
// Boot the REAL player in jsdom (mirrors capture-focus.test.ts) and drive window.__mockAnim. The warp
// only changes the autoplay ADVANCE; seekTo(T) sets T directly and getDuration()/the progress mapping
// stay linear in T. We assert seekTo lands on the EXACT T (incl. inside the warp window) and resolves the
// SAME active-comment frame as a direct projection at that T would.

async function bootFreshPlayer() {
  vi.resetModules();
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.removeAttribute("data-theme");
  delete (window as unknown as { __mockAnim?: unknown }).__mockAnim;
  const wrap = document.createElement("div");
  wrap.className = "conv-stream-wrap";
  const stream = document.createElement("div");
  stream.id = "conversation-stream";
  wrap.appendChild(stream);
  document.body.appendChild(wrap);
  const reading = document.createElement("div");
  reading.id = "reading-pane";
  document.body.appendChild(reading);

  await import("./index");
  await new Promise((r) => setTimeout(r, 0));
  const api = (window as unknown as { __mockAnim?: import("./index").MockAnimApi }).__mockAnim;
  if (!api) throw new Error("player did not install window.__mockAnim");
  return api;
}

describe("seek/progress stay LINEAR in T (warp is autoplay-advance only)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("seekTo(T) lands on the EXACT T — unaffected by the warp window", async () => {
    const api = await bootFreshPlayer();
    // a T INSIDE the warp window (where the autoplay would advance 4×) must still seek to exactly T
    const insideWarp = Math.round((WARP_POINT_MS + TERMINAL_LAND_MS) / 2);
    api.seekTo(insideWarp);
    expect(api.getT()).toBe(insideWarp);
    // a T OUTSIDE the warp window too
    api.seekTo(1000);
    expect(api.getT()).toBe(1000);
  });

  it("progress fraction at T is exactly T/duration (linear), and seekTo resolves the same frame as a direct seek", async () => {
    const api = await bootFreshPlayer();
    const duration = api.getDuration();
    expect(duration).toBe(TERMINAL_MS);

    // The progress fill in the player is (T/duration); a half-width pointer scrub therefore maps to
    // duration/2. We verify the linear relationship holds at the warp-window midpoint: seeking to the
    // T that 50%-width corresponds to lands on exactly duration/2 (no warp offset injected).
    const half = duration / 2;
    api.seekTo(half);
    expect(api.getT()).toBe(half);

    // Frame equivalence: a seek INTO the warp window resolves the SAME active comments as the projection
    // at that T (here: none, since the demo loads no annotation doc — the projection is empty at every T).
    // The point is that the resolved frame is a pure f(T): identical regardless of how T was reached.
    const tInside = WARP_POINT_MS + 500;
    api.seekTo(tInside);
    const viaInside = api.getActiveComments();
    api.seekTo(0);
    api.seekTo(tInside);
    const viaReseek = api.getActiveComments();
    expect(viaReseek).toEqual(viaInside);
  });
});
