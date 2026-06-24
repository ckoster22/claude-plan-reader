// Mock-ANIMATE capture-focus isolation tests (Fix 1) — booting the REAL player (index.ts) in jsdom and
// driving its `window.__mockAnim` control surface, asserting that the capture-frame-local focus set by
// focusComment() NEVER survives a doc load or a user scrub. Stale focus would otherwise hide all-but-one
// comment in a later replay session.
//
// The assertion seam is the comment PANEL (#mockanim-cmt): with two comments sharing one tMs, focusing
// one renders only its text; after a reset (loadAnnotations / seekTo) BOTH render again. (The canvas
// draw path is jsdom-inert — getContext returns null — so the panel is the testable, deterministic seam.)
//
// FALSIFIABLE: remove the `captureFocusId = null` reset from loadAnnotations (or seekTo) and the second
// comment stays hidden → these tests go RED.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AnnotationDoc } from "./annotations";

// Two comments pinned at the SAME tMs so the window-based projection shows BOTH, while focusComment
// isolates exactly one — the difference that proves the reset.
function twoCommentDoc(): AnnotationDoc {
  return {
    version: 1,
    durationMs: 100000,
    viewport: { w: 1000, h: 800 },
    comments: [
      { id: "a", tMs: 1000, text: "alpha comment", strokes: [] },
      { id: "b", tMs: 1000, text: "beta comment", strokes: [] },
    ],
  };
}

// Build the minimal DOM the player mounts into, then import index.ts fresh so its top-level boot()
// runs against this DOM and installs a fresh window.__mockAnim. resetModules guarantees isolation.
async function bootFreshPlayer() {
  vi.resetModules();
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.removeAttribute("data-theme");
  delete (window as unknown as { __mockAnim?: unknown }).__mockAnim;
  // The conversation slot the player mounts its pane into (optional — falls back to a floating pane).
  const wrap = document.createElement("div");
  wrap.className = "conv-stream-wrap";
  const stream = document.createElement("div");
  stream.id = "conversation-stream";
  wrap.appendChild(stream);
  document.body.appendChild(wrap);
  const reading = document.createElement("div");
  reading.id = "reading-pane";
  document.body.appendChild(reading);

  await import("./index");
  // boot() schedules the first paint on a macrotask; flush it so the player is fully live.
  await new Promise((r) => setTimeout(r, 0));
  const api = (window as unknown as { __mockAnim?: import("./index").MockAnimApi }).__mockAnim;
  if (!api) throw new Error("player did not install window.__mockAnim");
  return api;
}

function panelTexts(): string[] {
  const panel = document.getElementById("mockanim-cmt");
  if (!panel) return [];
  return Array.from(panel.querySelectorAll(".mockanim-cmt-item")).map((n) => n.textContent ?? "");
}

describe("Fix 1 — capture focus must not leak past a doc load or a scrub", () => {
  beforeEach(() => {
    // jsdom has no real layout; pin a deterministic viewport so denorm/window math is stable.
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("focusComment isolates one comment; loadAnnotations clears the focus so both render again", async () => {
    const api = await bootFreshPlayer();
    api.loadAnnotations(twoCommentDoc());
    api.seekTo(1000); // land both comments inside the active window

    // Sanity: with no focus, BOTH comments are shown.
    expect(panelTexts().sort()).toEqual(["alpha comment", "beta comment"]);

    // Focus one → only it renders.
    api.focusComment("a");
    expect(panelTexts()).toEqual(["alpha comment"]);

    // Re-loading a doc MUST clear the capture focus (otherwise "beta comment" stays hidden). No seekTo
    // afterward — T is already 1000 and loadAnnotations repaints — so this ISOLATES loadAnnotations's
    // own reset (a seekTo here would mask it via seekTo's reset).
    api.loadAnnotations(twoCommentDoc());
    expect(panelTexts().sort()).toEqual(["alpha comment", "beta comment"]);
  });

  it("seekTo also clears the capture focus", async () => {
    const api = await bootFreshPlayer();
    api.loadAnnotations(twoCommentDoc());
    api.seekTo(1000);
    api.focusComment("b");
    expect(panelTexts()).toEqual(["beta comment"]);

    // A user scrub (seekTo) is capture-frame-local's death — focus must reset.
    api.seekTo(1000);
    expect(panelTexts().sort()).toEqual(["alpha comment", "beta comment"]);
  });
});
