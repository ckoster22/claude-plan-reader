import { describe, it, expect, beforeEach, vi } from "vitest";
import { wireTitlebar, initThemeToggle, THEME_KEY } from "./titlebar";

// Window-drag regression guard.
//
// The custom macOS native-overlay titlebar (titleBarStyle:"Overlay") relies on
// `data-tauri-drag-region` to move the window. Tauri v2 only initiates a drag
// when the mousedown event's TARGET is the element carrying that attribute — it
// does NOT walk up the ancestor chain. The titlebar now hosts a genuinely
// interactive control (the theme toggle) inside `.titlebar-controls`. Because
// that control lives INSIDE `.titlebar[data-tauri-drag-region]`, a plain
// `closest("[data-tauri-drag-region]")` walk would (wrongly) match the ancestor
// `.titlebar` and start a window drag — which can swallow the control's click.
//
// The fix is in JS: `isDragTarget` bails first when the mousedown target is, or
// is inside, an interactive control (button/a/input/select/textarea/[data-no-drag]).
// These tests reproduce the real chrome + the relevant CSS and assert that
// contract. They are falsifiable: removing the interactive-target bail makes a
// primary mousedown on the toggle wrongly call `startDragging`.

// The relevant slice of src/styles.css (kept in sync with the real titlebar
// rules). Inlined so jsdom can resolve computed styles without filesystem I/O,
// matching the in-DOM convention used by the other DOM-touching tests.
const TITLEBAR_CSS = `
  .titlebar {
    height: 44px;
    display: flex; align-items: center; gap: 8px;
    padding: 0 14px 0 78px;
  }
  .titlebar-controls { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .theme-toggle { pointer-events: auto; width: 28px; height: 28px; }
`;

function mountChrome() {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = TITLEBAR_CSS;
  document.head.appendChild(style);

  // Mirror index.html's titlebar subtree exactly.
  const titlebar = document.createElement("div");
  titlebar.className = "titlebar";
  titlebar.setAttribute("data-tauri-drag-region", "");
  titlebar.innerHTML = `
    <div class="titlebar-controls">
      <button class="theme-toggle" id="theme-toggle" type="button"
              title="Toggle dark / light theme" aria-label="Toggle dark / light theme">
        <span class="ico" id="theme-icon">&#9789;</span>
      </button>
    </div>`;
  document.body.appendChild(titlebar);
  return titlebar;
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
});

describe("titlebar drag-region contract", () => {
  it("the titlebar carries data-tauri-drag-region and is pointer-interactive", () => {
    const titlebar = mountChrome();
    expect(titlebar.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(getComputedStyle(titlebar).pointerEvents).not.toBe("none");
  });

  it("the theme toggle stays pointer-interactive and is NOT itself a drag region", () => {
    mountChrome();
    const toggle = document.querySelector<HTMLElement>("#theme-toggle")!;
    // Interactive controls in the slot keep pointer-events:auto (so they can be
    // clicked) — they are NOT made pointer-transparent.
    expect(getComputedStyle(toggle).pointerEvents).toBe("auto");
    // The control must NOT carry the drag attribute itself (drag exclusion is
    // handled by isDragTarget's interactive-target bail, not the attribute).
    expect(toggle.hasAttribute("data-tauri-drag-region")).toBe(false);
  });
});

// Explicit JS wiring guard.
//
// `data-tauri-drag-region` alone proved insufficient: the underlying
// `startDragging` window command is gated behind the
// `core:window:allow-start-dragging` capability, and without it the attribute
// silently no-ops. As a robustness layer (and to restore native
// double-click-to-zoom), wireTitlebar() attaches explicit handlers:
//   - mousedown (primary button, target inside a drag region) -> startDragging
//   - dblclick (target inside a drag region) -> toggleMaximize
// Interactive controls (the theme toggle) must be left alone so they keep their
// own click behavior — and so the OS traffic lights are untouched.
describe("titlebar JS wiring (drag + zoom)", () => {
  function fakeWindow() {
    return {
      startDragging: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("primary-button mousedown on the drag region (bar whitespace) starts a window drag", () => {
    const titlebar = mountChrome();
    const win = fakeWindow();
    wireTitlebar(titlebar, win);

    // mousedown directly on .titlebar (the bar whitespace) is a genuine drag.
    titlebar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    expect(win.startDragging).toHaveBeenCalledTimes(1);
  });

  it("non-primary-button mousedown does NOT start a drag", () => {
    const titlebar = mountChrome();
    const win = fakeWindow();
    wireTitlebar(titlebar, win);

    // Right button (buttons bitmask = 2) must not hijack into a drag.
    titlebar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 2 }));
    expect(win.startDragging).not.toHaveBeenCalled();
  });

  it("primary-button mousedown on the #theme-toggle does NOT start a drag (drag attribute intact)", () => {
    const titlebar = mountChrome();
    const win = fakeWindow();
    wireTitlebar(titlebar, win);

    // The toggle lives INSIDE .titlebar[data-tauri-drag-region] — we do NOT
    // strip the attribute. closest() would match .titlebar regardless, so the
    // ONLY thing keeping this from starting a drag is isDragTarget's
    // interactive-target bail. This is the meaningful falsifiable guard.
    const toggle = document.querySelector<HTMLElement>("#theme-toggle")!;
    toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    expect(win.startDragging).not.toHaveBeenCalled();
  });

  it("primary-button mousedown on a child INSIDE the toggle (the icon) also does NOT start a drag", () => {
    const titlebar = mountChrome();
    const win = fakeWindow();
    wireTitlebar(titlebar, win);

    // closest("button, …") must catch a descendant of the button too.
    const icon = document.querySelector<HTMLElement>("#theme-icon")!;
    icon.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    expect(win.startDragging).not.toHaveBeenCalled();
  });

  it("double-click on the drag region toggles maximize (native zoom)", () => {
    const titlebar = mountChrome();
    const win = fakeWindow();
    wireTitlebar(titlebar, win);

    titlebar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
  });
});

// Theme-toggle behavior.
//
// initThemeToggle is pure & dependency-injected: a fake `root` element + fake
// `storage` let us assert the token-swap (data-theme), persistence, and icon
// updates without touching real localStorage or the live document element.
// Sun = &#9788; (decodes to ☼, shown in dark mode), moon = &#9789; (decodes to
// ☽, shown in light mode) — the prototype's exact entity mapping.
const ICON_SUN = "☼";
const ICON_MOON = "☽";

describe("initThemeToggle behavior", () => {
  function setup(initialDark = false) {
    const root = document.createElement("html");
    if (initialDark) root.dataset.theme = "dark";
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: vi.fn((k: string, v: string) => {
        store.set(k, v);
      }),
    };
    return { root, button, icon, storage, store };
  }

  // The icon glyph is set via innerHTML with an HTML entity; jsdom decodes it,
  // so we compare the decoded character.
  const iconChar = (el: Element) => el.textContent;

  it("no-op when button is null (does not throw)", () => {
    const { root, storage } = setup();
    expect(() => initThemeToggle(null, root, storage)).not.toThrow();
  });

  it("paints the MOON icon at init when the root is light (no data-theme)", () => {
    const { root, button, icon, storage } = setup(false);
    initThemeToggle(button, root, storage, icon);
    expect(iconChar(icon)).toBe(ICON_MOON);
  });

  it("paints the SUN icon at init when the root is pre-set to dark (mirrors the inline-script read path)", () => {
    const { root, button, icon, storage } = setup(true);
    initThemeToggle(button, root, storage, icon);
    expect(iconChar(icon)).toBe(ICON_SUN);
  });

  it("clicking from light flips root to dark, persists 'dark', and paints the sun", () => {
    const { root, button, icon, storage } = setup(false);
    initThemeToggle(button, root, storage, icon);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // token-swap
    expect(root.dataset.theme).toBe("dark");
    // persistence
    expect(storage.setItem).toHaveBeenCalledWith(THEME_KEY, "dark");
    // icon update
    expect(iconChar(icon)).toBe(ICON_SUN);
  });

  it("clicking from dark flips root to light (attribute removed), persists 'light', and paints the moon", () => {
    const { root, button, icon, storage } = setup(true);
    initThemeToggle(button, root, storage, icon);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // token-swap: dark → light removes the attribute entirely (light is default)
    expect(root.dataset.theme).toBeUndefined();
    expect(root.hasAttribute("data-theme")).toBe(false);
    // persistence
    expect(storage.setItem).toHaveBeenCalledWith(THEME_KEY, "light");
    // icon update
    expect(iconChar(icon)).toBe(ICON_MOON);
  });

  it("two clicks round-trip: light → dark → light, with both writes persisted", () => {
    const { root, button, icon, storage } = setup(false);
    initThemeToggle(button, root, storage, icon);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.dataset.theme).toBe("dark");

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(iconChar(icon)).toBe(ICON_MOON);

    expect(storage.setItem).toHaveBeenNthCalledWith(1, THEME_KEY, "dark");
    expect(storage.setItem).toHaveBeenNthCalledWith(2, THEME_KEY, "light");
  });
});
