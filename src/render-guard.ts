// Render-generation guard for the reading pane.
//
// `openPlan` and `reloadOpenPlan` both `await invoke("read_plan_contents")` and then
// `await settle()`, mutating the pane after each await. Without serialization a newer
// open/reload can be superseded by an older one whose awaits resolve later — a stale
// render lands in the pane. This guard hands out a monotonically-increasing token at the
// start of each render; after every await the caller checks whether its token is still
// the latest and bails if not. Only the most-recent render is allowed to mutate the pane.
//
// Extracted from main.ts so the decision is unit-testable without the DOM / Tauri wiring.

export class RenderGuard {
  private current = 0;

  /**
   * Begin a new render. Increments the generation and returns the token the caller must
   * carry across its awaits. A later `begin()` strictly supersedes any earlier token.
   */
  begin(): number {
    this.current += 1;
    return this.current;
  }

  /**
   * True iff `token` is still the most-recently-issued generation (i.e. no newer render
   * has begun since). Callers bail out of mutating the pane when this returns false.
   */
  isCurrent(token: number): boolean {
    return token === this.current;
  }
}

/**
 * Pure decision used by RenderGuard.isCurrent — exported so the bail-out rule can be
 * tested in complete isolation. A captured generation is "latest" only when it equals
 * the current generation; any newer render (current > captured) supersedes it.
 */
export function isLatestGeneration(captured: number, current: number): boolean {
  return captured === current;
}
