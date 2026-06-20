// Link handling for the reading pane.
//
// External links (http(s)/mailto) are opened in the OS default app via the
// opener plugin and NEVER navigate the WebView. Intra-doc `#anchor` links scroll
// within the pane.

import { openUrl } from "@tauri-apps/plugin-opener";

/** Pure classifier: true for hrefs that must open OUTSIDE the WebView. */
export function isExternalHref(href: string): boolean {
  if (!href) return false;
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}

// Track which panes already have the delegated listener so renderInto can be
// called repeatedly (reloads) without stacking handlers.
const wired = new WeakSet<HTMLElement>();

/** Attach a single delegated click listener to the pane (idempotent). */
export function attachLinkHandler(paneEl: HTMLElement): void {
  if (wired.has(paneEl)) return;
  wired.add(paneEl);

  paneEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const anchor = target?.closest("a") as HTMLAnchorElement | null;
    if (!anchor) return;

    // Prefer the raw attribute (anchor.href resolves relative URLs against the
    // document base, which would mangle `#anchor` / `mailto:` classification).
    const href = anchor.getAttribute("href") ?? "";

    if (anchor.dataset.external === "1" || isExternalHref(href)) {
      ev.preventDefault();
      void openUrl(href);
      return;
    }

    if (href.startsWith("#")) {
      // Intra-doc anchor: scroll the target into view within the pane.
      ev.preventDefault();
      const id = href.slice(1);
      // A bare `#` (empty fragment id) is a same-document no-op; `querySelector("#")`
      // would throw a SyntaxError on the empty selector, so bail out before querying.
      if (id === "") return;
      // Try id, then a name attribute fallback.
      const dest =
        paneEl.querySelector(`#${cssEscape(id)}`) ??
        paneEl.querySelector(`[name="${cssEscape(id)}"]`);
      if (dest) dest.scrollIntoView({ block: "start" });
      return;
    }

    // Default-DENY fall-through. Anything that is not an external link or a
    // same-document `#` fragment — relative paths (`foo.md`, `../03-plan.md`,
    // `./x`), query-only (`?q=1`), unknown schemes, or an empty/space href —
    // would otherwise make the single Tauri WebView navigate away, bricking the
    // app with no way back. Suppress the default navigation and do nothing; the
    // link becomes an inert no-op. This also covers anchors inside rendered
    // mermaid SVG, which carry no `data-external` stamp.
    ev.preventDefault();
  });
}

// Minimal CSS.escape fallback (jsdom/older WebViews may lack it for odd ids).
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\#.:>~+*\[\]()]/g, "\\$&");
}
