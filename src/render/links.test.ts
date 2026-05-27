import { describe, it, expect, vi, beforeEach } from "vitest";

// links.ts imports openUrl at module load; stub it so the import resolves.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { isExternalHref, attachLinkHandler } from "./links";

describe("isExternalHref — pure classifier", () => {
  it("treats http(s) URLs as external", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("http://example.com/a")).toBe(true);
    expect(isExternalHref("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("treats mailto: as external", () => {
    expect(isExternalHref("mailto:a@b.com")).toBe(true);
  });

  it("treats intra-doc anchors as NOT external", () => {
    expect(isExternalHref("#sec")).toBe(false);
    expect(isExternalHref("#")).toBe(false);
  });

  it("treats empty / relative as NOT external", () => {
    expect(isExternalHref("")).toBe(false);
    expect(isExternalHref("foo.md")).toBe(false);
    expect(isExternalHref("./rel/path")).toBe(false);
  });
});

describe("attachLinkHandler — click handling (default-DENY navigation)", () => {
  // Build a fresh pane with one anchor and dispatch a real bubbling click on it.
  // jsdom never performs the default anchor navigation, but it DOES honor
  // ev.preventDefault() → event.defaultPrevented, which is exactly the signal
  // the handler uses to keep the single WebView from navigating away. Each test
  // uses a fresh paneEl because attachLinkHandler is idempotent per-element (it
  // tracks wired panes in a module-level WeakSet).
  function clickAnchor(opts: {
    href: string;
    external?: boolean;
  }): { ev: MouseEvent; pane: HTMLElement } {
    const pane = document.createElement("div");
    const a = document.createElement("a");
    a.setAttribute("href", opts.href);
    if (opts.external) a.dataset.external = "1";
    a.textContent = "link";
    pane.appendChild(a);
    document.body.appendChild(pane);

    attachLinkHandler(pane);

    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    return { ev, pane };
  }

  beforeEach(() => {
    vi.mocked(openUrl).mockClear();
  });

  it("a RELATIVE-href anchor (../03-plan.md) preventDefaults and does NOT navigate / openUrl", () => {
    const { ev } = clickAnchor({ href: "../03-plan.md" });
    // The whole point of the fix: relative links must be inert no-ops, never a
    // WebView navigation that bricks the app.
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("an EXTERNAL anchor routes to openUrl and preventDefaults", () => {
    const { ev } = clickAnchor({ href: "https://example.com", external: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("an external anchor classified at runtime (no data-external stamp) still routes to openUrl", () => {
    // mermaid SVG links carry no data-external stamp; runtime isExternalHref
    // classification must still catch them.
    const { ev } = clickAnchor({ href: "https://example.com/runtime" });
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/runtime");
  });

  it("a #fragment anchor preventDefaults (in-doc scroll path) and does NOT navigate / openUrl", () => {
    const { ev } = clickAnchor({ href: "#sec" });
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("an empty-href anchor preventDefaults and does NOT navigate / openUrl", () => {
    const { ev } = clickAnchor({ href: "" });
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
