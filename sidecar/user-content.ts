// Multimodal user-content builder — the SINGLE authoritative `string → content-array`
// migration + positional `[Image #N]` token-injection point (cross-layer contract §E).
//
// Extracted into its own SDK-free module so it can be unit-tested in isolation: the
// sidecar entry (`index.ts`) imports the bundled `claude` native binary, so importing
// it from a test triggers the bundler to choke on that binary (OOM). These builders are
// PURE and import nothing heavy — the load-bearing test seam (DA #6) lives here and is
// re-exported from `index.ts`.

/** One inbound image: snake_case `media_type` + base64 `data` (no `data:` prefix). */
export type InboundImage = { media_type: string; data: string };

/** A single content block in the SDK's content-array shape. */
export type ContentBlock = { type: string; [k: string]: unknown };

/** base64 image → the SDK's `ImageBlockParam` shape. */
export function toImageBlock(img: InboundImage): ContentBlock {
  return { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } };
}

/**
 * Prepend one 1-based `[Image #N]` token per image (space-joined) to `text`.
 * `n <= 0` returns `text` unchanged. The visible composer never holds these
 * tokens — authority lives here, recomputed positionally at build time.
 */
export function injectTokens(text: string, n: number): string {
  return n > 0
    ? Array.from({ length: n }, (_, i) => `[Image #${i + 1}]`).join(" ") + " " + text
    : text;
}

/**
 * Build the SDKUserMessage `content`: with valid images, an array of one image
 * block per image (in order) followed by a single text block whose text carries
 * the injected tokens; with none, the bare `text` string. PURE — test seam.
 */
export function buildUserContent(
  text: string,
  images?: InboundImage[],
): string | ContentBlock[] {
  if (!images || images.length === 0) return text;
  return [...images.map(toImageBlock), { type: "text", text: injectTokens(text, images.length) }];
}
