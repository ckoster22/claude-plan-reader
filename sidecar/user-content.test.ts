// Falsifiable, invariant-first unit tests for the sidecar's PURE multimodal content
// builder (buildUserContent in user-content.ts, re-exported from index.ts) — the single
// authoritative `string → content-array`
// migration + positional `[Image #N]` token-injection point (cross-layer contract §E / DA #6).
//
// INVARIANTS UNDER TEST:
//   - with images: content is an array of one image block per image (in attach order),
//     followed by ONE text block whose text carries 1-based, incrementing `[Image #N]`
//     tokens (one per image, space-joined) prepended to the original text.
//   - with no images (undefined or empty): content is the BARE STRING (byte-identical to
//     the text-only path that predates multimodal support).
//   - image-block count === images.length; numbering is 1-based and increments.

import { describe, it, expect } from "vitest";
import { buildUserContent, type InboundImage } from "./user-content";

const a: InboundImage = { media_type: "image/png", data: "AAAA" };
const b: InboundImage = { media_type: "image/jpeg", data: "BBBB" };
const c: InboundImage = { media_type: "image/gif", data: "CCCC" };

const block = (img: InboundImage) => ({
  type: "image",
  source: { type: "base64", media_type: img.media_type, data: img.data },
});

describe("buildUserContent — multimodal content-array migration", () => {
  it("three images → [blockA, blockB, blockC, text] with 1-based incrementing tokens", () => {
    // FALSIFY: making injectTokens 0-based, or dropping the leading token, turns the
    // text block into the wrong string → RED.
    expect(buildUserContent("hi", [a, b, c])).toEqual([
      block(a),
      block(b),
      block(c),
      { type: "text", text: "[Image #1] [Image #2] [Image #3] hi" },
    ]);
  });

  it("single image → [blockA, text] with one 1-based token", () => {
    expect(buildUserContent("hi", [a])).toEqual([
      block(a),
      { type: "text", text: "[Image #1] hi" },
    ]);
  });

  it("no images (undefined) → bare string (byte-identical to text-only)", () => {
    // FALSIFY: wrapping the no-images path in an array → this strict-equals check RED.
    expect(buildUserContent("hi")).toBe("hi");
  });

  it("empty images array → bare string (byte-identical to text-only)", () => {
    expect(buildUserContent("hi", [])).toBe("hi");
  });

  it("image-block count === images.length and numbering increments", () => {
    const result = buildUserContent("body", [a, b, c]);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ type: string; [k: string]: unknown }>;
    const imageBlocks = arr.filter((x) => x.type === "image");
    expect(imageBlocks).toHaveLength(3);
    const textBlock = arr.find((x) => x.type === "text") as { text: string };
    expect(textBlock.text).toBe("[Image #1] [Image #2] [Image #3] body");
  });
});
