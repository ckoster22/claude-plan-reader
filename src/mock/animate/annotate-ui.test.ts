// Mock-ANIMATE author-mode pure-logic tests (Phase 3) — the pin/normalize/delete helpers factored out
// of annotate-ui.ts so they need no live player or DOM. Each invariant is falsifiable: pin must stamp
// the CURRENT T and keep stroke points normalized 0..1; two pins at the SAME tMs must collapse to one
// tick group with count 2 (via the existing tickGroups); delete must remove exactly the right id.

import { describe, it, expect } from "vitest";

import { buildComment, normalizePoint, deleteComment } from "./annotate-ui";
import { tickGroups, type AnnotationDoc, type Stroke } from "./annotations";

function emptyDoc(): AnnotationDoc {
  return { version: 1, durationMs: 10000, viewport: { w: 1000, h: 800 }, comments: [] };
}

function penStroke(points: Array<[number, number]>): Stroke {
  return { tool: "pen", color: "#ff5555", width: 3, points };
}

describe("normalizePoint — pixels → normalized 0..1, clamped", () => {
  it("maps a pixel point to viewport-normalized coords", () => {
    expect(normalizePoint(500, 200, 1000, 800)).toEqual([0.5, 0.25]);
    expect(normalizePoint(0, 800, 1000, 800)).toEqual([0, 1]);
  });

  it("clamps out-of-viewport points into [0,1]", () => {
    expect(normalizePoint(1200, -40, 1000, 800)).toEqual([1, 0]);
  });
});

describe("buildComment — stamps current T, ids stably, keeps strokes normalized", () => {
  it("sets tMs to the passed (current) T and points stay within [0,1]", () => {
    const strokes = [penStroke([normalizePoint(250, 400, 1000, 800), normalizePoint(750, 600, 1000, 800)])];
    const c = buildComment(4200, "fix this", strokes, 1);
    expect(c.tMs).toBe(4200);
    expect(c.id).toBe("c1");
    expect(c.text).toBe("fix this");
    const allInRange = c.strokes.every((s) =>
      s.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
    );
    expect(allInRange).toBe(true);
  });

  it("deep-copies strokes so later mutation of the source can't alias into the comment", () => {
    const src = [penStroke([[0.1, 0.1]])];
    const c = buildComment(1000, "", src, 2);
    src[0].points.push([0.9, 0.9]);
    src[0].color = "#000000";
    expect(c.strokes[0].points).toEqual([[0.1, 0.1]]);
    expect(c.strokes[0].color).toBe("#ff5555");
  });
});

describe("two pins at the SAME tMs collapse to one tick group with count===2", () => {
  it("builds a doc whose tickGroups has one entry counting both comments", () => {
    let doc = emptyDoc();
    const a = buildComment(3000, "first", [], 1);
    const b = buildComment(3000, "second", [], 2);
    doc = { ...doc, comments: [...doc.comments, a, b] };
    const groups = tickGroups(doc);
    expect(groups).toEqual([{ tMs: 3000, count: 2 }]);
  });

  it("distinct tMs pins produce two separate tick groups", () => {
    let doc = emptyDoc();
    doc = { ...doc, comments: [buildComment(1000, "x", [], 1), buildComment(2000, "y", [], 2)] };
    expect(tickGroups(doc).map((g) => g.tMs)).toEqual([1000, 2000]);
  });
});

describe("deleteComment — removes exactly the targeted id", () => {
  it("removes the comment with the given id and leaves the rest", () => {
    let doc = emptyDoc();
    doc = {
      ...doc,
      comments: [
        buildComment(1000, "a", [], 1),
        buildComment(2000, "b", [], 2),
        buildComment(3000, "c", [], 3),
      ],
    };
    const next = deleteComment(doc, "c2");
    expect(next.comments.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("is a no-op when the id is absent", () => {
    let doc = emptyDoc();
    doc = { ...doc, comments: [buildComment(1000, "a", [], 1)] };
    expect(deleteComment(doc, "missing").comments.map((c) => c.id)).toEqual(["c1"]);
  });
});
