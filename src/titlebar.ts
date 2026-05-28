import { getCurrentWindow } from "@tauri-apps/api/window";

// Titlebar window-chrome wiring for the macOS native-overlay titlebar
// (titleBarStyle:"Overlay" in tauri.conf.json).
//
// WHY THIS EXISTS (beyond `data-tauri-drag-region`):
//   1. Robustness — `data-tauri-drag-region` only initiates a drag when the
//      mousedown TARGET is the element carrying the attribute (Tauri v2 does
//      not walk ancestors). An explicit handler that matches via
//      `closest("[data-tauri-drag-region]")` is resilient to passive child
//      elements regardless of their pointer-events state.
//   2. Native double-click-to-zoom — the overlay titlebar loses the OS's
//      default dbl-click-to-zoom behavior, so we restore it explicitly via
//      `toggleMaximize()`.
//
// Both `startDragging` and `toggleMaximize` are gated behind capability
// permissions (core:window:allow-start-dragging /
// core:window:allow-toggle-maximization). They are granted in
// src-tauri/capabilities/default.json.

// True when the mousedown originated on a drag region (not on an interactive
// control). Interactive controls (the theme toggle and the Prompt Feedback
// button) live INSIDE `.titlebar[data-tauri-drag-region]`, so a plain
// `closest("[data-tauri-drag-region]")` walk would match the ancestor
// `.titlebar` and (wrongly) start a window drag on them — which can swallow
// the ensuing click. We therefore bail FIRST when the target is, or is inside,
// an interactive control. Omitting the drag attribute on the control alone is
// insufficient (closest() still reaches `.titlebar`); the bail is the real
// guard.
//
// The macOS traffic-light buttons are painted by the OS over the titlebar's
// left inset; they are not DOM elements, so events over them never reach the
// WebView and this handler never sees them. They are unaffected.
function isDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Interactive controls inside the drag region (the theme toggle in
  // .titlebar-controls, and the Prompt Feedback button) must never start a
  // window drag — closest() would otherwise match the ancestor .titlebar.
  if (target.closest("button, a, input, select, textarea, [data-no-drag]")) return false;
  return target.closest("[data-tauri-drag-region]") !== null;
}

// Attach drag + double-click-to-zoom handlers to the titlebar element.
// `appWindow` is injected for testability; defaults to the current window.
export function wireTitlebar(
  titlebar: Element,
  appWindow: { startDragging: () => Promise<void>; toggleMaximize: () => Promise<void> } = getCurrentWindow(),
): void {
  // Drag: primary button only (e.buttons === 1) and only when the press lands
  // on a drag region. Guarding on the primary button avoids hijacking
  // right/middle clicks; the drag-region check leaves interactive controls
  // (and OS traffic lights) untouched.
  titlebar.addEventListener("mousedown", (ev) => {
    const e = ev as MouseEvent;
    if (e.buttons !== 1) return;
    if (!isDragTarget(e.target)) return;
    void appWindow.startDragging().catch((err) => console.error("startDragging failed", err));
  });

  // Double-click on the drag region toggles maximize (macOS zoom), matching
  // the native titlebar behavior the overlay style otherwise suppresses.
  titlebar.addEventListener("dblclick", (ev) => {
    const e = ev as MouseEvent;
    if (!isDragTarget(e.target)) return;
    void appWindow.toggleMaximize().catch((err) => console.error("toggleMaximize failed", err));
  });
}

// Convenience: find the titlebar in the document and wire it. No-op if absent.
export function initTitlebar(): void {
  const titlebar = document.querySelector(".titlebar");
  if (titlebar) wireTitlebar(titlebar);
}

// localStorage key for the persisted theme choice. Shared with the inline
// anti-FOUC script in index.html (which cannot import a module constant, so the
// literal is unavoidably duplicated there; contract.test.ts pins it).
export const THEME_KEY = "plan-reader-theme";

// Sun (dark mode shows it to switch back to light) / moon (light mode) glyphs,
// matching the prototype's `themeIco.innerHTML` mapping (&#9788; / &#9789;).
const ICON_SUN = "&#9788;";
const ICON_MOON = "&#9789;";

// Wire the icon-only dark/light theme toggle. Pure & dependency-injected so
// jsdom tests can pass a fake `root` element and fake `storage`.
//   - reads the CURRENT theme from `root.dataset.theme === "dark"`
//   - paints the icon from it (dark → sun, light → moon)
//   - on click: flips the theme on `root`, persists to `storage`, repaints icon
// No-op when `button` is null. The persisted theme is READ at startup by the
// inline script in index.html (this initializer only writes on click).
export function initThemeToggle(
  button: Element | null,
  root: HTMLElement = document.documentElement,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  icon?: Element | null,
): void {
  if (!button) return;
  const iconEl =
    icon ?? button.querySelector("#theme-icon") ?? document.querySelector("#theme-icon");

  const paint = (): void => {
    const dark = root.dataset.theme === "dark";
    if (iconEl) iconEl.innerHTML = dark ? ICON_SUN : ICON_MOON;
  };
  paint();

  button.addEventListener("click", () => {
    const dark = root.dataset.theme === "dark";
    if (dark) {
      delete root.dataset.theme; // light is the default (no attribute)
      storage.setItem(THEME_KEY, "light");
    } else {
      root.dataset.theme = "dark";
      storage.setItem(THEME_KEY, "dark");
    }
    paint();
  });
}
