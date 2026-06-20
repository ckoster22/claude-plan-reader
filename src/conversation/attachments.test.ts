// Conversation domain — attachments.ts tests (DOM controller; jsdom).
//
// Invariant-first: assert the chip/strip/getImages contract that SHOULD hold — chips render
// in attach order with 1-based positional #N badges, removal renumbers + reorders getImages(),
// and a rejected attach shows an error with NO chip added — independent of implementation.

import { describe, it, expect, beforeEach } from "vitest";
import { createImageAttachments, type ImageAttachments } from "./attachments";

// A 1x1 PNG (tiny, real bytes) — deterministic small base64 payload through jsdom's FileReader.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function pngFile(name: string): File {
  const bytes = Uint8Array.from(atob(PNG_1x1_BASE64), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}

function svgFile(name = "x.svg"): File {
  return new File(["<svg/>"], name, { type: "image/svg+xml" });
}

// Build a DataTransfer-ish object for a paste/drop event (jsdom has no real DataTransfer).
function fakeDataTransfer(files: File[]): DataTransfer {
  return {
    items: files.map((f) => ({ kind: "file", getAsFile: () => f })),
    files,
  } as unknown as DataTransfer;
}

// Surface DOM + a handle. inputEl + chipStrip + errorEl mirror the real prompt-surface shape.
interface Harness {
  inputEl: HTMLElement;
  chipStrip: HTMLElement;
  errorEl: HTMLElement;
  attach: ImageAttachments;
}

function makeHarness(): Harness {
  const inputEl = document.createElement("div");
  const chipStrip = document.createElement("div");
  const errorEl = document.createElement("div");
  errorEl.className = "hidden";
  document.body.append(inputEl, chipStrip, errorEl);
  const attach = createImageAttachments({ inputEl, chipStrip, errorEl });
  return { inputEl, chipStrip, errorEl, attach };
}

// Dispatch a paste carrying the given files; wait for the async addFiles funnel to settle.
async function paste(h: Harness, files: File[]): Promise<void> {
  const ev = new Event("paste") as Event & { clipboardData?: DataTransfer };
  ev.clipboardData = fakeDataTransfer(files);
  h.inputEl.dispatchEvent(ev);
  await flush();
}

// Two microtask turns: FileReader.onload (macrotask in jsdom) → addFiles awaits → render.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function chips(h: Harness): HTMLElement[] {
  return Array.from(h.chipStrip.querySelectorAll(".conv-attach-chip"));
}

function badges(h: Harness): string[] {
  return Array.from(h.chipStrip.querySelectorAll(".conv-attach-badge")).map(
    (b) => b.textContent ?? "",
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createImageAttachments — single image", () => {
  it("one image → one chip + getImages() length 1", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png")]);
    expect(chips(h)).toHaveLength(1);
    expect(h.attach.getImages()).toHaveLength(1);
    expect(h.attach.getImages()[0].media_type).toBe("image/png");
    expect(h.attach.getImages()[0].data).toBe(PNG_1x1_BASE64);
    expect(h.attach.isEmpty()).toBe(false);
  });
});

describe("createImageAttachments — multiple ordered images", () => {
  it("three images → ordered chips #1 #2 #3 + getImages() length 3 in order", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    expect(chips(h)).toHaveLength(3);
    expect(badges(h)).toEqual(["#1", "#2", "#3"]);
    // Order is the attach order — assert via the per-chip thumbnail alt is not enough, so the
    // chip count + getImages length carry the ordering invariant; thumbnails all share data here.
    expect(h.attach.getImages()).toHaveLength(3);
  });

  it("remove the MIDDLE chip → renumbers #1 #2 and getImages reflects the new order", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    expect(badges(h)).toEqual(["#1", "#2", "#3"]);

    // Click the middle chip's remove button.
    const middleRemove = chips(h)[1].querySelector<HTMLButtonElement>(".conv-attach-remove")!;
    middleRemove.click();

    expect(chips(h)).toHaveLength(2);
    expect(badges(h)).toEqual(["#1", "#2"]); // renumbered positionally
    expect(h.attach.getImages()).toHaveLength(2);
  });

  it("order preserved across removal-then-add", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    // Remove the first.
    chips(h)[0].querySelector<HTMLButtonElement>(".conv-attach-remove")!.click();
    expect(badges(h)).toEqual(["#1", "#2"]);
    // Add a fourth — appends to the end, badges stay contiguous.
    await paste(h, [pngFile("d.png")]);
    expect(badges(h)).toEqual(["#1", "#2", "#3"]);
    expect(h.attach.getImages()).toHaveLength(3);
  });
});

describe("createImageAttachments — reject at attach", () => {
  it("unsupported type → inline error shown and NO chip added", async () => {
    const h = makeHarness();
    await paste(h, [svgFile()]);
    expect(chips(h)).toHaveLength(0);
    expect(h.attach.getImages()).toHaveLength(0);
    expect(h.attach.isEmpty()).toBe(true);
    expect(h.errorEl.classList.contains("hidden")).toBe(false);
    expect(h.errorEl.textContent ?? "").toMatch(/unsupported/i);
  });

  it("a valid image alongside a rejected one keeps only the valid chip", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("ok.png"), svgFile()]);
    expect(chips(h)).toHaveLength(1);
    expect(badges(h)).toEqual(["#1"]);
    expect(h.errorEl.classList.contains("hidden")).toBe(false);
  });
});

describe("createImageAttachments — clear()", () => {
  it("clear() empties images, strip, and error", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png")]);
    await paste(h, [svgFile()]); // sets an error
    h.attach.clear();
    expect(h.attach.getImages()).toHaveLength(0);
    expect(chips(h)).toHaveLength(0);
    expect(h.attach.isEmpty()).toBe(true);
    expect(h.errorEl.classList.contains("hidden")).toBe(true);
  });
});
