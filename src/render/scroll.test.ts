import { describe, it, expect } from "vitest";
import { computeScrollDelta } from "./scroll";

// newScrollTop = currentScrollTop + (chosenTop - containerTop) - anchor.offset
//
// Intuition: the chosen block is currently `chosenTop - containerTop` px below
// the container top. We want it `anchor.offset` px below. The difference is how
// much further we must scroll, added to the current scrollTop.

describe("computeScrollDelta — exact numeric cases", () => {
  it("block already at the captured offset → scrollTop unchanged", () => {
    // chosenTop=130, containerTop=100 → block is 30px below top; want 30 → delta 0.
    const out = computeScrollDelta(
      { line: 10, offset: 30 },
      [{ line: 10, top: 130 }],
      100,
      500,
    );
    expect(out).toBe(500);
  });

  it("block is lower than wanted → scroll DOWN by the difference", () => {
    // block currently 80px below top (180-100), want it 20px below → scroll down 60.
    const out = computeScrollDelta(
      { line: 10, offset: 20 },
      [{ line: 10, top: 180 }],
      100,
      500,
    );
    // 500 + (180-100) - 20 = 500 + 80 - 20 = 560
    expect(out).toBe(560);
  });

  it("block is higher than wanted → scroll UP", () => {
    // block currently 10px below top (110-100), want it 50px below → scroll up 40.
    const out = computeScrollDelta(
      { line: 10, offset: 50 },
      [{ line: 10, top: 110 }],
      100,
      500,
    );
    // 500 + (110-100) - 50 = 500 + 10 - 50 = 460
    expect(out).toBe(460);
  });

  it("non-zero containerTop is subtracted correctly", () => {
    // containerTop=44 (titlebar), chosenTop=244 → 200px below; want 12 → scroll down 188.
    const out = computeScrollDelta(
      { line: 5, offset: 12 },
      [{ line: 5, top: 244 }],
      44,
      1000,
    );
    // 1000 + (244-44) - 12 = 1000 + 200 - 12 = 1188
    expect(out).toBe(1188);
  });
});

describe("computeScrollDelta — nearest-line candidate selection", () => {
  it("picks the candidate whose line is closest to the anchor line", () => {
    // anchor line 20. Candidates at lines 5, 18, 40. Nearest is 18.
    const out = computeScrollDelta(
      { line: 20, offset: 10 },
      [
        { line: 5, top: 50 },
        { line: 18, top: 300 },
        { line: 40, top: 900 },
      ],
      100,
      500,
    );
    // Chosen line 18, top 300 → 500 + (300-100) - 10 = 690
    expect(out).toBe(690);
  });

  it("on a tie, keeps the earlier (smaller-line) candidate", () => {
    // anchor line 10. Candidates at lines 8 and 12 are equidistant (dist 2).
    // strictly-less keeps the first encountered → line 8.
    const out = computeScrollDelta(
      { line: 10, offset: 0 },
      [
        { line: 8, top: 200 },
        { line: 12, top: 400 },
      ],
      100,
      0,
    );
    // Chosen line 8, top 200 → 0 + (200-100) - 0 = 100
    expect(out).toBe(100);
  });

  it("selects an exact line match even when not first in the list", () => {
    const out = computeScrollDelta(
      { line: 33, offset: 5 },
      [
        { line: 1, top: 10 },
        { line: 33, top: 555 },
        { line: 34, top: 560 },
      ],
      0,
      0,
    );
    // exact match line 33, top 555 → 0 + (555-0) - 5 = 550
    expect(out).toBe(550);
  });

  it("returns currentScrollTop unchanged when there are no candidates", () => {
    const out = computeScrollDelta({ line: 10, offset: 5 }, [], 100, 777);
    expect(out).toBe(777);
  });
});
