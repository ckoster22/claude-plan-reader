import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri core invoke. resolveImageSrc's only side effect is calling
// invoke("read_image_as_data_url", { path }); we assert what `path` it builds.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { resolveImageSrc, joinPath, awaitImages } from "./assets";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("data:image/png;base64,STUB");
});

describe("resolveImageSrc — passthrough schemes", () => {
  it("returns https URLs unchanged without invoking", async () => {
    const out = await resolveImageSrc("https://x.com/a.png", "/plans");
    expect(out).toBe("https://x.com/a.png");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns http URLs unchanged without invoking", async () => {
    const out = await resolveImageSrc("http://x.com/a.png", "/plans");
    expect(out).toBe("http://x.com/a.png");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns data: URLs unchanged without invoking", async () => {
    const out = await resolveImageSrc("data:image/png;base64,AAAA", "/plans");
    expect(out).toBe("data:image/png;base64,AAAA");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("resolveImageSrc — local resolution", () => {
  it("joins a relative src against planDir and invokes read_image_as_data_url", async () => {
    const out = await resolveImageSrc("foo.png", "/Users/me/plans");
    expect(invokeMock).toHaveBeenCalledWith("read_image_as_data_url", {
      path: "/Users/me/plans/foo.png",
    });
    expect(out).toBe("data:image/png;base64,STUB");
  });

  it("passes an absolute src straight through to invoke (no planDir join)", async () => {
    await resolveImageSrc("/abs/x.png", "/Users/me/plans");
    expect(invokeMock).toHaveBeenCalledWith("read_image_as_data_url", {
      path: "/abs/x.png",
    });
  });

  it("strips a leading ./ before joining", async () => {
    await resolveImageSrc("./sub/y.png", "/p");
    expect(invokeMock).toHaveBeenCalledWith("read_image_as_data_url", {
      path: "/p/sub/y.png",
    });
  });
});

describe("awaitImages — unresolved placeholders are not awaited", () => {
  // Make placeholders an HTMLImageElement in jsdom.
  function img(attrs: Record<string, string>): HTMLImageElement {
    const el = document.createElement("img");
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  it("resolves immediately for a data: src image (already loadable)", async () => {
    const pane = document.createElement("div");
    pane.appendChild(img({ src: "data:image/png;base64,AAAA" }));
    // Should settle without hanging. A 1s budget proves it's prompt.
    await Promise.race([
      awaitImages(pane, 50),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("hung")), 1000)),
    ]);
  });

  it("does NOT wait on a still-deferred placeholder (data-resolve present)", async () => {
    // A placeholder that carries data-resolve AND a real src. The guard must SKIP
    // it (resolve immediately). The buggy version (no data-resolve guard) would
    // attach load/error listeners that never fire under jsdom and only resolve via
    // the timeout — so we give a generous race budget far below the 5s default.
    const pane = document.createElement("div");
    pane.appendChild(
      img({ "data-resolve": "1", src: "data:image/png;base64,PENDING" }),
    );
    const started = Date.now();
    await awaitImages(pane, 5000);
    // With the guard this returns in ~0ms; without it, it would wait ~5000ms.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("does NOT count an empty-src placeholder as a real image to wait on", async () => {
    const pane = document.createElement("div");
    pane.appendChild(img({ "data-resolve": "1" })); // no src at all
    const started = Date.now();
    await awaitImages(pane, 5000);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("joinPath — pure", () => {
  it("joins relative under base, normalizing trailing slash", () => {
    expect(joinPath("/a/b/", "c.png")).toBe("/a/b/c.png");
    expect(joinPath("/a/b", "c.png")).toBe("/a/b/c.png");
  });
  it("returns absolute srcs as-is", () => {
    expect(joinPath("/a/b", "/abs/x.png")).toBe("/abs/x.png");
  });
});
