// Sub-Plan 03 — pure display helper for the resolved cwd subtitle.
//
// The resolved cwd comes back from the backend as an ABSOLUTE path. For display we collapse
// a leading `$HOME` into `~` (the CSS `.plan-src` rule then left-truncates, keeping the tail
// dir visible). Kept pure + dependency-free so it is unit-testable in isolation; `main.ts`
// resolves the actual home directory once via Tauri's `homeDir()` and passes it in.

/**
 * Replace a leading `home` segment of `path` with `~`. If `home` is empty or `path` is not
 * under `home` at a path boundary, returns `path` unchanged. Mirrors the Rust `collapse_home`
 * reference in `src-tauri/src/lib.rs`.
 *
 * The boundary check (next char is `/` or end-of-string) prevents `/Users/bobby` collapsing
 * under home `/Users/bob`. A trailing slash on `home` is normalized away first.
 */
export function collapseHome(path: string, home: string): string {
  if (!home) return path;
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === h) return "~";
  if (path.startsWith(h + "/")) {
    return "~" + path.slice(h.length);
  }
  return path;
}
