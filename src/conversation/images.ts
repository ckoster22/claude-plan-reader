// Conversation domain — image attachment helpers (PURE: no DOM).
//
// The encapsulated "image input" volatility shared by both prompt surfaces (the
// new-conversation composer modal and the in-conversation follow-up input). This file owns
// the cross-layer data contract and the validation/encoding logic; attachments.ts owns the
// DOM (chips/strip/events) and consumes these helpers.
//
// CONTRACT (must match every downstream hop — Rust ImageInput, sidecar buildUserContent):
// the image payload is `{ media_type, data }` with snake_case `media_type` and base64 `data`
// carrying NO `data:<mime>;base64,` prefix. Only the 4 media types the Anthropic API accepts
// are allowed (png/jpeg/gif/webp).

/**
 * A single attached image, in the exact wire shape the send path forwards.
 * `data` is base64 with NO `data:…;base64,` prefix (the prefix is stripped at encode time —
 * note assets.ts `resolveImageSrc` PASSES `data:` through; this strip is separate, new logic).
 */
export type AttachedImage = {
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
};

// The media types the Anthropic API accepts for inline base64 image blocks (verified against
// `@anthropic-ai/sdk` Base64ImageSource + the vision docs). `mime_for_ext` (svg/bmp/avif) is
// broader and intentionally excluded from the send path.
export const SUPPORTED_IMAGE_TYPES: ReadonlySet<AttachedImage["media_type"]> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Per-image limit, in BASE64-ENCODED bytes — the Anthropic direct-API per-image ceiling is
// 10 MB base64 (5 MB on Bedrock/Vertex). Base64 inflates raw bytes ~33%, so we validate the
// encoded `data` length, NOT raw `File.size`.
export const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;

// Total-request guard across all attached images, in base64-encoded bytes. Conservative
// default: a per-image 10 MB cap does not bound a 20-image request, so this caps the whole
// set. Tune against the actual API request-size ceiling.
export const MAX_TOTAL_BASE64_BYTES = 30 * 1024 * 1024;

// Max images per single send. Under the API's stricter many-image dimension rule (API hard max
// is 100). Keeps a single message's attachment set bounded.
export const MAX_IMAGES = 20;

/**
 * Read a File into an AttachedImage via FileReader.readAsDataURL, then split the
 * `data:<mime>;base64,<data>` result into `{ media_type, data }` — stripping the
 * `data:…;base64,` prefix so `data` is bare base64. `media_type` is derived from the data-URL
 * prefix (the authoritative source for what was actually encoded), falling back to `file.type`.
 *
 * Pure aside from the FileReader read; rejects if the file cannot be read.
 */
export async function fileToAttachedImage(file: File): Promise<AttachedImage> {
  const dataUrl = await readAsDataURL(file);
  // Shape: data:<mime>;base64,<base64-bytes>  — split on the first comma.
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  // Extract the mime from `data:<mime>;base64`. Fall back to file.type when the header is
  // absent/unparseable (e.g. a stubbed reader or an exotic Blob).
  const mimeMatch = /^data:([^;,]+)/.exec(header);
  const mediaType = (mimeMatch?.[1] || file.type) as AttachedImage["media_type"];
  return { media_type: mediaType, data };
}

/**
 * Validate a candidate image at attach time. All size checks run against the ENCODED base64
 * length (`encodedDataLength` = the base64 `data` string length), because that is what the API
 * limits — NOT raw `file.size` (base64 inflates ~33%).
 *
 * Checks, in order: supported media type, per-image encoded size, running-total encoded size,
 * and image count. Returns a distinct human-readable error string per failure.
 */
export function validateImageFile(
  file: File,
  encodedDataLength: number,
  runningTotalBytes: number,
  currentCount: number,
): { ok: true } | { ok: false; error: string } {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type as AttachedImage["media_type"])) {
    const kind = file.type || "unknown";
    return {
      ok: false,
      error: `Unsupported image type "${kind}". Allowed: PNG, JPEG, GIF, WebP.`,
    };
  }
  if (currentCount >= MAX_IMAGES) {
    return {
      ok: false,
      error: `Too many images — at most ${MAX_IMAGES} per message.`,
    };
  }
  if (encodedDataLength > MAX_IMAGE_BASE64_BYTES) {
    return {
      ok: false,
      error: `Image is too large (${formatMB(encodedDataLength)}). Max ${formatMB(
        MAX_IMAGE_BASE64_BYTES,
      )} per image.`,
    };
  }
  if (runningTotalBytes + encodedDataLength > MAX_TOTAL_BASE64_BYTES) {
    return {
      ok: false,
      error: `Total attachment size exceeds ${formatMB(MAX_TOTAL_BASE64_BYTES)}.`,
    };
  }
  return { ok: true };
}

/**
 * Convert attached images to DISPLAY data URLs for the conversation-history thumbnail render path.
 * The wire shape strips the `data:<mime>;base64,` prefix (`{ media_type, data }`); the user-bubble
 * `<img src>` needs it back. Re-assembles `data:<media_type>;base64,<data>` per image, in order.
 * Returns a fresh array (never mutates the input). Empty in → empty out (callers OMIT the field then).
 */
export function imagesToDataUrls(imgs: readonly AttachedImage[]): string[] {
  return imgs.map((i) => `data:${i.media_type};base64,${i.data}`);
}

/**
 * Pull image `File`s out of a paste/drop DataTransfer. Iterates `items` (the richer source,
 * which a paste exposes) and falls back to `files`, keeping only entries whose `type` starts
 * with `image/`. Non-image flavors (text, html, etc.) are ignored. De-duplicates so an item
 * also present in `files` is not added twice.
 */
export function extractImageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const seen = new Set<File>();
  const add = (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return;
    if (seen.has(f)) return;
    seen.add(f);
    out.push(f);
  };
  // items: each DataTransferItem of kind "file" yields a File via getAsFile().
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file") add(item.getAsFile());
    }
  }
  // files: a plain FileList fallback (some drop sources populate only this).
  if (dt.files) {
    for (const f of Array.from(dt.files)) add(f);
  }
  return out;
}

// --- internals -------------------------------------------------------------

// FileReader.readAsDataURL wrapped as a promise. Isolated so tests can construct a real
// Blob/File and assert prefix-stripping (jsdom provides FileReader).
function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

// Human-readable MB for error strings (1 decimal place).
function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
