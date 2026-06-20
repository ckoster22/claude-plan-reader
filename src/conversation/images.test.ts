// Conversation domain — images.ts tests (PURE helpers; jsdom for FileReader).
//
// Invariant-first: these assert what the validation/encoding contract SHOULD be (the wire
// shape `{media_type, data}` with NO data: prefix; size checks against ENCODED base64 length,
// not raw File.size), independent of the current implementation.

import { describe, it, expect } from "vitest";
import {
  fileToAttachedImage,
  validateImageFile,
  MAX_IMAGE_BASE64_BYTES,
  MAX_TOTAL_BASE64_BYTES,
  MAX_IMAGES,
} from "./images";

// A 1x1 PNG (tiny, real bytes) — gives a deterministic small base64 payload.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function pngFile(name = "tiny.png"): File {
  const bytes = Uint8Array.from(atob(PNG_1x1_BASE64), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}

describe("fileToAttachedImage — encode + prefix strip", () => {
  it("strips the data: prefix and yields bare base64 with the correct media_type", async () => {
    const out = await fileToAttachedImage(pngFile());
    expect(out.media_type).toBe("image/png");
    // The bare data must NOT carry the data:…;base64, prefix.
    expect(out.data.startsWith("data:")).toBe(false);
    expect(out.data).not.toContain(";base64,");
    // Round-trips back to the original PNG bytes (so the strip preserved the payload).
    expect(out.data).toBe(PNG_1x1_BASE64);
  });
});

describe("validateImageFile — type / per-image size / count / total (ENCODED bytes)", () => {
  it("accepts a valid small image", () => {
    const r = validateImageFile(pngFile(), PNG_1x1_BASE64.length, 0, 0);
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported media type", () => {
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    const r = validateImageFile(svg, 10, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsupported/i);
  });

  it("rejects when the ENCODED length exceeds the per-image cap", () => {
    const r = validateImageFile(pngFile(), MAX_IMAGE_BASE64_BYTES + 1, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/i);
  });

  it("accepts at exactly the per-image cap (boundary)", () => {
    const r = validateImageFile(pngFile(), MAX_IMAGE_BASE64_BYTES, 0, 0);
    expect(r.ok).toBe(true);
  });

  it("rejects the (MAX_IMAGES + 1)-th image on count", () => {
    const r = validateImageFile(pngFile(), 10, 0, MAX_IMAGES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too many/i);
  });

  it("accepts the MAX_IMAGES-th image (count boundary)", () => {
    const r = validateImageFile(pngFile(), 10, 0, MAX_IMAGES - 1);
    expect(r.ok).toBe(true);
  });

  it("rejects when running total + this image exceeds the total cap", () => {
    const r = validateImageFile(pngFile(), 1, MAX_TOTAL_BASE64_BYTES, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/total/i);
  });

  it("accepts when running total + this image is exactly at the total cap (boundary)", () => {
    const r = validateImageFile(pngFile(), 1, MAX_TOTAL_BASE64_BYTES - 1, 0);
    expect(r.ok).toBe(true);
  });
});
