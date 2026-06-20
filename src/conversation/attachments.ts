// Conversation domain — image attachment DOM controller (chips/strip/events).
//
// Owns the DOM side of the "image input" volatility: it binds paste/drop/file-pick on a
// prompt surface, validates+encodes via images.ts, holds the ordered AttachedImage[] as
// PER-INSTANCE closure state (both prompt surfaces — composer + in-conversation — coexist in
// one DOM, so module-level state would bleed across them), and renders removable chips.
//
// The pure data contract + validation/encoding live in images.ts; this file is the DOM seam.

import {
  type AttachedImage,
  fileToAttachedImage,
  validateImageFile,
  extractImageFiles,
} from "./images";

/** Public handle the prompt surfaces consume to read/clear the attached image set. */
export interface ImageAttachments {
  /** Ordered AttachedImage[] (media_type + bare base64 data), in attach order. */
  getImages(): AttachedImage[];
  /** True when no images are attached. */
  isEmpty(): boolean;
  /** Drop all images, clear the chip strip + any inline error. */
  clear(): void;
}

export interface CreateImageAttachmentsOptions {
  /** Surface the user types/pastes/drops into; paste + dragover/drop are bound here. */
  inputEl: HTMLElement;
  /** Container the chips render into. */
  chipStrip: HTMLElement;
  /** Optional "attach" button that proxies a click to the hidden file input. */
  attachBtn?: HTMLElement;
  /** Optional hidden <input type="file"> whose `change` funnels picked files in. */
  fileInput?: HTMLInputElement;
  /** Optional inline error line for attach-time rejections. */
  errorEl?: HTMLElement;
}

// Stable DOM classes (test + style contract).
const CLASS_CHIP = "conv-attach-chip";
const CLASS_THUMB = "conv-attach-thumb";
const CLASS_BADGE = "conv-attach-badge";
const CLASS_REMOVE = "conv-attach-remove";

/**
 * Wire up an image-attachment controller on a single prompt surface. Returns a handle the
 * caller uses to read/clear images; everything else (validation, chips, removal renumbering)
 * is internal. State is closure-local to this call — two surfaces never share an array.
 */
export function createImageAttachments(opts: CreateImageAttachmentsOptions): ImageAttachments {
  const { inputEl, chipStrip, attachBtn, fileInput, errorEl } = opts;

  // ORDERED per-instance state. Never module-level.
  const images: AttachedImage[] = [];

  function showError(msg: string): void {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  function clearError(): void {
    if (!errorEl) return;
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  function totalBytes(): number {
    let sum = 0;
    for (const img of images) sum += img.data.length;
    return sum;
  }

  function render(): void {
    chipStrip.replaceChildren();
    images.forEach((img, idx) => {
      const chip = document.createElement("div");
      chip.className = CLASS_CHIP;

      const thumb = document.createElement("img");
      thumb.className = CLASS_THUMB;
      thumb.src = `data:${img.media_type};base64,${img.data}`;
      thumb.alt = "";

      // 1-based positional badge — recomputed each render so removal renumbers.
      const badge = document.createElement("span");
      badge.className = CLASS_BADGE;
      badge.textContent = `#${idx + 1}`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = CLASS_REMOVE;
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove image #${idx + 1}`);
      remove.addEventListener("click", () => {
        images.splice(idx, 1);
        render();
      });

      chip.append(thumb, badge, remove);
      chipStrip.append(chip);
    });
  }

  /**
   * The single funnel for every entry point (paste, drop, file-pick). Encodes each file,
   * validates against the ENCODED base64 length (the API's actual limit), and on success
   * pushes in order + re-renders. On the first rejection shows the error and adds no chip.
   */
  async function addFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    clearError();
    let added = false;
    for (const file of files) {
      let encoded: AttachedImage;
      try {
        encoded = await fileToAttachedImage(file);
      } catch {
        showError(`Could not read "${file.name || "image"}".`);
        continue;
      }
      const verdict = validateImageFile(
        file,
        encoded.data.length,
        totalBytes(),
        images.length,
      );
      if (!verdict.ok) {
        showError(verdict.error);
        continue; // add NO chip for a rejected file
      }
      images.push({ media_type: encoded.media_type, data: encoded.data });
      added = true;
    }
    if (added) render();
  }

  // --- event bindings ------------------------------------------------------

  inputEl.addEventListener("paste", (e) => {
    const dt = (e as ClipboardEvent).clipboardData;
    const files = extractImageFiles(dt);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  });

  inputEl.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  inputEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    const files = extractImageFiles(dt);
    if (files.length > 0) void addFiles(files);
  });

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const list = fileInput.files;
      const files = list ? Array.from(list).filter((f) => f.type.startsWith("image/")) : [];
      void addFiles(files);
      // Reset so the same file can be re-picked later.
      fileInput.value = "";
    });
  }

  return {
    getImages: () => images.map((img) => ({ media_type: img.media_type, data: img.data })),
    isEmpty: () => images.length === 0,
    clear: () => {
      images.length = 0;
      chipStrip.replaceChildren();
      clearError();
    },
  };
}
