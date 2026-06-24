// Mock-ANIMATE author mode UI (Phase 3) — the ONE interactive (non-pure-T) path over the otherwise
// pure-projection `mock-animate` demo. Behind a flag (`npm run mock-annotate`, or `?annotate=1`): draw
// pen/arrow/box strokes over the screen, type a comment, Pin it at the current scrub-time T, repeat,
// then Save the AnnotationDoc to disk (P2 middleware) so replay/capture can load it back.
//
// This module is the toolbar/composer + the canvas pointer-capture wiring. It is loaded ONLY in author
// mode (gated in index.ts); default/replay behavior is byte-unchanged because none of this mounts
// without the flag. The pure pin/normalize logic is factored into testable helpers below so the test
// needs no live player or DOM.

import type { AnnotationComment, AnnotationDoc, Stroke } from "./annotations";

// ---- pure helpers (unit-tested, no DOM) ------------------------------------------------------

// Map a viewport-pixel point to NORMALIZED viewport coords (0..1). Inverse of `denorm`. Clamped to
// [0,1] so a stray pointer just outside the window can't produce out-of-range stored coords.
export function normalizePoint(px: number, py: number, vw: number, vh: number): [number, number] {
  const nx = vw > 0 ? px / vw : 0;
  const ny = vh > 0 ? py / vh : 0;
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  return [clamp(nx), clamp(ny)];
}

// Build a pinned comment from the current T, composer text, and the working strokes. `seq` is the
// monotonic counter the caller bumps; the id is stable + unique within a session ("c1", "c2", ...).
// Strokes are copied (shallow per-stroke + points cloned) so later mutation of the working set can't
// alias into the doc.
export function buildComment(
  tMs: number,
  text: string,
  strokes: Stroke[],
  seq: number,
): AnnotationComment {
  return {
    id: `c${seq}`,
    tMs,
    text,
    strokes: strokes.map((s) => ({
      tool: s.tool,
      color: s.color,
      width: s.width,
      points: s.points.map((p) => [p[0], p[1]] as [number, number]),
    })),
  };
}

// Remove the comment with `id` from the doc, returning a NEW doc (the comments array is rebuilt). Pure.
export function deleteComment(doc: AnnotationDoc, id: string): AnnotationDoc {
  return { ...doc, comments: doc.comments.filter((c) => c.id !== id) };
}

// ---- author UI mount -------------------------------------------------------------------------

// The tool/color palettes. Kept small + stable so the verifier can target `.maa-tool[data-tool=…]`
// and `.maa-color[data-color=…]`.
const TOOLS: Array<Stroke["tool"]> = ["pen", "arrow", "box"];
const COLORS = ["#ff5555", "#6aa3ff", "#8be9a8"] as const;
const DEFAULT_WIDTH = 3;
const DRAFT_KEY = "mockanim-annotate-draft";

// Dependencies the player (index.ts) injects so the UI can read T, read/replace the in-memory doc,
// repaint the overlay, rebuild the scrubber ticks, and persist. The UI owns NO player state directly.
export interface AnnotateDeps {
  getT: () => number;
  getDoc: () => AnnotationDoc;
  setDoc: (doc: AnnotationDoc) => void;
  repaint: () => void;
  rebuildTicks: () => void;
  saveDoc: (name: string, doc: AnnotationDoc) => Promise<string>;
  // The canvas the player owns (`#demo-annotation-canvas`); author mode captures pointer input on it
  // and draws the in-progress working strokes over the projected (pinned) overlay each repaint.
  canvas: HTMLCanvasElement;
  // Draw one already-normalized stroke onto the canvas 2D context, denormalized to the viewport. The
  // player owns the drawing primitive (`drawStroke`); we reuse it for the working preview so the live
  // preview looks identical to the pinned render.
  drawStroke: (ctx: CanvasRenderingContext2D, stroke: Stroke, vw: number, vh: number) => void;
}

// The CSS for the author surface — a single namespaced block (`maa-` = mock-animate-annotate). The
// toolbar sits TOP-center at the TOPMOST z (2147483647, same tier as the transport), STRICTLY ABOVE the
// drawing canvas (2147483642) — otherwise the pointer-events:auto canvas would sit over the toolbar and
// eat every click (textarea/name/buttons would never receive focus, and pen strokes would paint on the
// toolbar). The canvas pointer-capture is enabled by the player (index.ts) flipping `pointer-events:auto`.
const AUTHOR_CSS = `
#mockanim-author {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(720px, 88vw);
  padding: 10px 12px;
  background: rgba(22, 22, 26, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  color: #e8e8e8;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: auto;
}
#mockanim-author .maa-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
#mockanim-author .maa-tool, #mockanim-author .maa-pin, #mockanim-author .maa-save {
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  cursor: pointer;
  font: inherit;
}
#mockanim-author .maa-tool:hover, #mockanim-author .maa-pin:hover, #mockanim-author .maa-save:hover {
  background: rgba(255, 255, 255, 0.16);
}
#mockanim-author .maa-tool.maa-active {
  background: #6aa3ff;
  border-color: #6aa3ff;
  color: #16161a;
}
#mockanim-author .maa-color {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  padding: 0;
}
#mockanim-author .maa-color.maa-active { border-color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,0.4); }
#mockanim-author textarea#maa-text {
  flex: 1 1 auto;
  min-height: 38px;
  resize: vertical;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(0, 0, 0, 0.25);
  color: #f3f3f3;
  font: inherit;
}
#mockanim-author input#maa-name {
  flex: 0 0 auto;
  width: 140px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(0, 0, 0, 0.25);
  color: #f3f3f3;
  font: inherit;
}
#mockanim-author #maa-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 22vh;
  overflow-y: auto;
}
#mockanim-author .maa-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 12px;
}
#mockanim-author .maa-list-item .maa-li-text { flex: 1 1 auto; white-space: pre-wrap; overflow: hidden; text-overflow: ellipsis; }
#mockanim-author .maa-del {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 80, 80, 0.18);
  color: #ffb3b3;
  cursor: pointer;
  line-height: 1;
  font: inherit;
}
#mockanim-author .maa-del:hover { background: rgba(255, 80, 80, 0.35); }
#mockanim-author-toast {
  position: fixed;
  left: 50%;
  bottom: 76px;
  transform: translateX(-50%);
  z-index: 2147483647;
  max-width: min(640px, 80vw);
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(22, 22, 26, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  color: #f3f3f3;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: none;
  opacity: 0;
  transition: opacity 160ms ease;
}
#mockanim-author-toast.maa-toast-on { opacity: 1; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Mount the author toolbar + wire canvas pointer capture. Returns nothing; the UI owns its own DOM and
// reaches the player only through `deps`. Idempotent: never mounts a second toolbar.
export function mountAnnotateUI(deps: AnnotateDeps): void {
  if (document.getElementById("mockanim-author")) return;

  // ---- style ----
  if (!document.getElementById("mockanim-author-style")) {
    const style = el("style");
    style.id = "mockanim-author-style";
    style.textContent = AUTHOR_CSS;
    document.head.appendChild(style);
  }

  // ---- author session state ----
  let activeTool: Stroke["tool"] = "pen";
  let activeColor: string = COLORS[0];
  // Strokes drawn but not yet pinned. Cleared on Pin. Rendered live over the projected overlay.
  let workingStrokes: Stroke[] = [];
  // The in-progress stroke during a pointer drag (a member of workingStrokes once started).
  let dragStroke: Stroke | null = null;
  // Monotonic id counter; seeded past any restored draft so ids never collide.
  let seq = 0;

  // ---- draft belt: stash on every doc mutation; restore on boot (Risk #1 recovery) ----
  const stashDraft = (): void => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(deps.getDoc()));
    } catch {
      // sessionStorage may be unavailable/full — non-fatal; the in-memory doc is still live.
    }
  };

  // ---- toolbar DOM ----
  const root = el("div");
  root.id = "mockanim-author";

  const toolRow = el("div", "maa-row");
  const toolBtns = new Map<Stroke["tool"], HTMLButtonElement>();
  for (const tool of TOOLS) {
    const b = el("button", "maa-tool", tool);
    b.type = "button";
    b.dataset.tool = tool;
    b.addEventListener("click", () => {
      activeTool = tool;
      syncToolHighlight();
    });
    toolBtns.set(tool, b);
    toolRow.appendChild(b);
  }
  const colorBtns = new Map<string, HTMLButtonElement>();
  for (const color of COLORS) {
    const b = el("button", "maa-color");
    b.type = "button";
    b.dataset.color = color;
    b.style.background = color;
    b.addEventListener("click", () => {
      activeColor = color;
      syncColorHighlight();
    });
    colorBtns.set(color, b);
    toolRow.appendChild(b);
  }
  root.appendChild(toolRow);

  const composeRow = el("div", "maa-row");
  const text = el("textarea");
  text.id = "maa-text";
  text.placeholder = "Comment at this T…";
  const pinBtn = el("button", "maa-pin", "Pin comment");
  pinBtn.type = "button";
  composeRow.appendChild(text);
  composeRow.appendChild(pinBtn);
  root.appendChild(composeRow);

  const saveRow = el("div", "maa-row");
  const nameInput = el("input");
  nameInput.id = "maa-name";
  nameInput.type = "text";
  nameInput.placeholder = "name (e.g. review)";
  nameInput.value = "review";
  const saveBtn = el("button", "maa-save", "Save");
  saveBtn.type = "button";
  saveRow.appendChild(nameInput);
  saveRow.appendChild(saveBtn);
  root.appendChild(saveRow);

  const list = el("div");
  list.id = "maa-list";
  root.appendChild(list);

  document.body.appendChild(root);

  const toast = el("div");
  toast.id = "mockanim-author-toast";
  document.body.appendChild(toast);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const showToast = (msg: string): void => {
    toast.textContent = msg;
    toast.classList.add("maa-toast-on");
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("maa-toast-on"), 4000);
  };

  // ---- highlight sync ----
  function syncToolHighlight(): void {
    for (const [tool, b] of toolBtns) b.classList.toggle("maa-active", tool === activeTool);
  }
  function syncColorHighlight(): void {
    for (const [color, b] of colorBtns) b.classList.toggle("maa-active", color === activeColor);
  }
  syncToolHighlight();
  syncColorHighlight();

  // ---- "comments at this T" list ----
  // Show the comments active near the current T (reuse a fixed window). Each row carries a delete (✕).
  const LIST_WINDOW_MS = 180;
  const rebuildList = (): void => {
    const T = deps.getT();
    const doc = deps.getDoc();
    const near = doc.comments
      .filter((c) => Math.abs(c.tMs - T) <= LIST_WINDOW_MS)
      .sort((a, b) => a.tMs - b.tMs || (a.id < b.id ? -1 : 1));
    const rows: HTMLElement[] = [];
    for (const c of near) {
      const row = el("div", "maa-list-item");
      const label = `@${c.tMs}ms  ${c.text || "(no text)"}`;
      row.appendChild(el("span", "maa-li-text", label));
      const del = el("button", "maa-del", "✕");
      del.type = "button";
      del.dataset.id = c.id;
      del.addEventListener("click", () => removeComment(c.id));
      row.appendChild(del);
      rows.push(row);
    }
    list.replaceChildren(...rows);
  };

  // ---- working-strokes live preview (drawn AFTER the player's pinned projection each repaint) ----
  const renderWorking = (): void => {
    const ctx = deps.canvas.getContext("2d");
    if (!ctx) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const s of workingStrokes) deps.drawStroke(ctx, s, vw, vh);
  };

  // ---- pin / delete / save ----
  const pin = (): void => {
    const doc = deps.getDoc();
    const comment = buildComment(deps.getT(), text.value, workingStrokes, ++seq);
    const next: AnnotationDoc = { ...doc, comments: [...doc.comments, comment] };
    deps.setDoc(next);
    workingStrokes = [];
    dragStroke = null;
    text.value = "";
    deps.rebuildTicks();
    deps.repaint();
    rebuildList();
    stashDraft();
  };

  const removeComment = (id: string): void => {
    deps.setDoc(deleteComment(deps.getDoc(), id));
    deps.rebuildTicks();
    deps.repaint();
    rebuildList();
    stashDraft();
  };

  const save = async (): Promise<void> => {
    const name = nameInput.value.trim() || "review";
    try {
      const p = await deps.saveDoc(name, deps.getDoc());
      showToast(`saved → ${p}`);
    } catch (err) {
      showToast(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  pinBtn.addEventListener("click", pin);
  saveBtn.addEventListener("click", () => void save());

  // ---- canvas pointer capture (author mode only; the player enables pointer-events on the canvas) ----
  const ptToNorm = (clientX: number, clientY: number): [number, number] =>
    normalizePoint(clientX, clientY, window.innerWidth, window.innerHeight);

  let drawing = false;
  deps.canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    deps.canvas.setPointerCapture?.(e.pointerId);
    const p = ptToNorm(e.clientX, e.clientY);
    dragStroke = { tool: activeTool, color: activeColor, width: DEFAULT_WIDTH, points: [p] };
    workingStrokes.push(dragStroke);
    deps.repaint();
  });
  deps.canvas.addEventListener("pointermove", (e) => {
    if (!drawing || dragStroke === null) return;
    const p = ptToNorm(e.clientX, e.clientY);
    if (dragStroke.tool === "pen") {
      dragStroke.points.push(p);
    } else {
      // arrow / box: exactly [start, current] — update the second point on each move.
      dragStroke.points = [dragStroke.points[0], p];
    }
    deps.repaint();
  });
  const endDraw = (e: PointerEvent): void => {
    if (!drawing) return;
    drawing = false;
    deps.canvas.releasePointerCapture?.(e.pointerId);
    dragStroke = null;
  };
  deps.canvas.addEventListener("pointerup", endDraw);
  deps.canvas.addEventListener("pointercancel", endDraw);

  // ---- draft restore on boot (only when not loading a ?annotations= file) ----
  const hasAnnotationsUrl = new URLSearchParams(window.location.search).has("annotations");
  if (!hasAnnotationsUrl) {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const restored = JSON.parse(raw) as AnnotationDoc;
        if (restored && Array.isArray(restored.comments)) {
          deps.setDoc(restored);
          // Seed `seq` past any restored numeric ids so new ids never collide.
          for (const c of restored.comments) {
            const m = /^c(\d+)$/.exec(c.id);
            if (m) seq = Math.max(seq, Number(m[1]));
          }
          deps.rebuildTicks();
          deps.repaint();
          console.info("[mock-annotate] restored draft from sessionStorage");
        }
      }
    } catch (err) {
      console.warn("[mock-annotate] failed to restore draft:", err);
    }
  }

  rebuildList();

  // The player calls this hook AFTER each paint so the working preview + list track the live T. We
  // expose it via the canvas dataset-free closure by attaching to the deps' repaint cycle: the player
  // invokes `renderWorking` through the returned hook. To keep deps one-way, we register on the window.
  // (Author mode only — never present without the flag.)
  // Drain any stale hooks before registering ours: `authorPaintHooks` is a module-global, and a dev HMR
  // remount could otherwise accumulate closures from prior mounts that runAuthorPaintHooks() runs every
  // paint. Only one author UI is ever mounted, so a single live hook is correct.
  authorPaintHooks.length = 0;
  authorPaintHooks.push(() => {
    renderWorking();
    rebuildList();
  });
}

// ---- author paint hooks ----------------------------------------------------------------------
//
// The player's `paint()` runs the pinned projection then must overlay the working strokes + refresh
// the "comments at this T" list. Rather than thread a callback back into the player's closure, the UI
// registers paint hooks here and the player drains them at the end of each paint (author mode only).
export const authorPaintHooks: Array<() => void> = [];

export function runAuthorPaintHooks(): void {
  for (const hook of authorPaintHooks) hook();
}
