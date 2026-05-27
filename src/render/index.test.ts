import { describe, it, expect, vi, beforeEach } from "vitest";

// Fix 1 proof: settle() must AWAIT resolveLocalImages (which sets real srcs on
// local <img> placeholders) BEFORE awaitImages observes them. We use a DEFERRED
// mock invoke: the data: URL only resolves when we manually release it, so we can
// prove the image's src is already set by the time awaitImages runs.

// Deferred invoke: resolves with a data: URL only when `release()` is called.
let releaseInvoke: (() => void) | null = null;
const invokeMock = vi.fn(
  (..._args: unknown[]) =>
    new Promise<string>((resolve) => {
      releaseInvoke = () => resolve("data:image/png;base64,RESOLVED");
    }),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// links.ts (pulled in by index.ts) imports openUrl at load.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { renderInto, settle } from "./index";

beforeEach(() => {
  invokeMock.mockClear();
  releaseInvoke = null;
});

describe("settle — resolves local images before awaiting them", () => {
  it("sets the real src via resolveLocalImages before awaitImages observes the img", async () => {
    const pane = document.createElement("div");
    // A markdown body with one LOCAL image -> markdown.ts emits a data-resolve
    // placeholder with an empty src.
    renderInto(pane, "![alt](pic.png)\n", "/plans");

    const imgBefore = pane.querySelector("img")!;
    // renderInto is synchronous and must NOT have started resolution.
    expect(imgBefore.getAttribute("src")).toBe(""); // empty placeholder
    expect(imgBefore.hasAttribute("data-resolve")).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();

    // Kick off settle(); it will call resolveLocalImages -> invoke (pending).
    // Use a short awaitImages timeout so the test never depends on jsdom firing
    // image load events (jsdom does not decode data: URLs).
    const settled = settle(pane, 30);

    // Let the microtask that calls invoke run.
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // settle() must STILL be blocked: resolveLocalImages is awaited first, and
    // its invoke() is deferred. If settle did not await resolveLocalImages, it
    // would have raced ahead through awaitImages and resolved already.
    let done = false;
    void settled.then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);

    // The src is still the empty placeholder until the deferred invoke resolves —
    // proving resolveLocalImages had NOT completed before awaitImages would run.
    expect(pane.querySelector("img")!.getAttribute("src")).toBe("");

    // Release the deferred invoke -> resolveLocalImages sets the real src, THEN
    // settle proceeds to renderDiagrams + awaitImages (which times out at 30ms).
    releaseInvoke!();
    await settled;

    const imgAfter = pane.querySelector("img")!;
    // By the time settle() resolves, the real src is in place (resolveLocalImages
    // ran to completion before awaitImages).
    expect(imgAfter.getAttribute("src")).toBe("data:image/png;base64,RESOLVED");
    expect(imgAfter.hasAttribute("data-resolve")).toBe(false);
  });
});
