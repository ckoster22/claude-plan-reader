// Mock-ANIMATE annotation projection tests — the PURE data-model fns (no DOM, no player). Each
// invariant is falsifiable: a window/boundary/grouping/scaling assertion that goes RED if the
// implementation widens the window, flips the boundary inclusivity, fails to collapse same-tMs
// comments, or mis-scales a normalized point. (Each was confirmed RED by a temporary break, then
// restored — see the task report.)

import { describe, it, expect } from "vitest";

import {
  projectActiveComments,
  tickGroups,
  denorm,
  type AnnotationComment,
  type AnnotationDoc,
} from "./annotations";

function comment(id: string, tMs: number): AnnotationComment {
  return { id, tMs, text: `c-${id}`, strokes: [] };
}

function doc(comments: AnnotationComment[]): AnnotationDoc {
  return { version: 1, durationMs: 10000, viewport: { w: 1000, h: 800 }, comments };
}

describe("projectActiveComments — window boundary (inclusive) + onlyId", () => {
  it("includes a comment at exactly |tMs - T| === windowMs and excludes just past it", () => {
    const d = doc([comment("a", 1000)]);
    // T such that the comment sits at exactly the default window (180) on each side: INCLUSIVE.
    expect(projectActiveComments(d, 1180).map((c) => c.id)).toEqual(["a"]); // |1000-1180| = 180 == window
    expect(projectActiveComments(d, 820).map((c) => c.id)).toEqual(["a"]); // |1000-820| = 180 == window
    // One ms past the window on each side: EXCLUDED.
    expect(projectActiveComments(d, 1181).map((c) => c.id)).toEqual([]); // 181 > 180
    expect(projectActiveComments(d, 819).map((c) => c.id)).toEqual([]); // 181 > 180
  });

  it("respects an explicit windowMs", () => {
    const d = doc([comment("a", 1000)]);
    expect(projectActiveComments(d, 1050, 50).map((c) => c.id)).toEqual(["a"]); // 50 == window
    expect(projectActiveComments(d, 1051, 50).map((c) => c.id)).toEqual([]); // 51 > window
  });

  it("orders active comments by tMs ascending, then id", () => {
    const d = doc([comment("z", 1000), comment("a", 1000), comment("m", 900)]);
    expect(projectActiveComments(d, 1000, 200).map((c) => c.id)).toEqual(["m", "a", "z"]);
  });

  it("onlyId returns just that comment regardless of the window, or empty if absent", () => {
    const d = doc([comment("a", 1000), comment("b", 9000)]);
    // T is far from b's tMs, but onlyId isolates it anyway.
    expect(projectActiveComments(d, 0, 180, "b").map((c) => c.id)).toEqual(["b"]);
    expect(projectActiveComments(d, 9000, 180, "missing")).toEqual([]);
  });
});

describe("tickGroups — same-tMs collapse + ascending distinct tMs", () => {
  it("collapses N comments sharing a tMs into one group with count === N", () => {
    const d = doc([comment("a", 1000), comment("b", 1000), comment("c", 1000)]);
    expect(tickGroups(d)).toEqual([{ tMs: 1000, count: 3 }]);
  });

  it("keeps distinct tMs separate, ascending", () => {
    const d = doc([comment("a", 2000), comment("b", 1000), comment("c", 2000), comment("d", 500)]);
    expect(tickGroups(d)).toEqual([
      { tMs: 500, count: 1 },
      { tMs: 1000, count: 1 },
      { tMs: 2000, count: 2 },
    ]);
  });
});

describe("denorm — normalized → pixels", () => {
  it("maps a normalized point to pixels for the given viewport", () => {
    expect(denorm([0.5, 0.25], 1000, 800)).toEqual([500, 200]);
    expect(denorm([0, 1], 1000, 800)).toEqual([0, 800]);
  });
});
