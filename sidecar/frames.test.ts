// Falsifiable unit tests for the sidecar's PURE frame-emission predicate (frames.ts).
//
// THE BUG UNDER TEST (empty assistant bubbles): the SDK emits assistant text blocks that are
// empty or whitespace-only (typically around tool calls); normalize() used to gate only on
// `typeof block.text === "string"`, so those passed through as `assistant_text` frames and the
// host rendered empty bubbles. isRenderableText additionally requires non-empty-after-trim
// content, so such blocks emit NO frame at all.

import { describe, it, expect } from "vitest";
import { isRenderableText } from "./frames";

describe("sidecar isRenderableText — only non-empty-after-trim strings are renderable", () => {
  it('"" → false (an empty block must emit no frame, not an empty bubble)', () => {
    // FALSIFY: revert the predicate to the old `typeof text === "string"` check → "" is a
    // string → true → RED.
    expect(isRenderableText("")).toBe(false);
  });

  it('"  \\n\\t" (whitespace-only) → false', () => {
    expect(isRenderableText("  \n\t")).toBe(false);
  });

  it('"x" → true (real content still renders)', () => {
    expect(isRenderableText("x")).toBe(true);
  });

  it("non-strings → false (null, undefined, 42, {})", () => {
    expect(isRenderableText(null)).toBe(false);
    expect(isRenderableText(undefined)).toBe(false);
    expect(isRenderableText(42)).toBe(false);
    expect(isRenderableText({})).toBe(false);
  });
});
