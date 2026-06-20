import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Plan-review UX — OPTION A: a review OPENS THE REAL plan file through the normal plan-open flow.
//
// The redesign (the invariant fix):
//   • A review's plan is a REAL file under ~/.claude/plans/ (its absolute path rides on the payload
//     as `plan_file_path`). Handling a review REFRESHES the sidebar and OPENS that file via openPlan,
//     so the plan's sidebar row is SELECTED (`[data-path].active`) — no more detached IPC-text render
//     with no selection (the bug this file's INVARIANT test pins, red→green in the report).
//   • Review comments are just the opened plan's NORMAL persisted comments (keyed on its real path).
//     There is no synthetic in-memory store.
//   • Browse freely: a pending review NEVER traps navigation. Opening another plan shows it and leaves
//     the review pending; the bar drops to SUMMARY mode (count + Resume). Resume reopens + reselects it.
//   • Submit → respond_to_review decision "deny" + buildFeedbackPrompt(open plan's comments), removes
//     it from pending.
//   • Un-openable: an empty plan_file_path (or an open that throws) is REFUSED — the review is dropped
//     from pending (so it is not counted) and the failure is surfaced on #hook-status; it is NEVER
//     rendered as an unactionable detached phantom (bug #1).
//
// This test uses the REAL ./render facade (NOT mocked) so the genuine save→IO→fireCountChanged path
// runs end-to-end. The backend is a shared in-memory comment store keyed by REAL plan path; every
// comment-command + respond_to_review invoke is recorded so the persistence + decision invariants are
// checkable.
// ---------------------------------------------------------------------------------------------

type Rec = { quote: string; comment: string; block_line: number | null; block_end_line: number | null; occurrence: number; id: number };
type Review = { schema: number; review_id: string; session_id: string; cwd: string; transcript_path: string; plan_text: string; plan_file_path: string; created_ms: number };

// Hoisted shared state: the backend comment store (keyed by real plan path), a record of EVERY invoke
// call, the pending-reviews fixture, the captured respond_to_review responses, the list_plans rows,
// and a registry of the listen() handlers so tests can FIRE plan-review events.
const H = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  invokeCalls: [] as Array<{ cmd: string; path: string }>,
  pendingReviews: [] as Review[],
  responses: [] as Array<{ reviewId: string; decision: string; reason: string }>,
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
  // Sidebar rows list_plans returns. Tests push a row for a review's plan_file_path so openPlan can
  // select it (the invariant). A PlanRecord-ish shape sufficient for renderSidebar.
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: { path?: string; comments?: Rec[]; reviewId?: string; decision?: string; reason?: string }) => {
    const path = args?.path ?? "";
    H.invokeCalls.push({ cmd, path });
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nselect this phrase here\n");
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "get_comments") return Promise.resolve(H.store[path] ?? []);
    if (cmd === "get_comment_count") return Promise.resolve((H.store[path] ?? []).length);
    if (cmd === "set_comments") {
      const next = args?.comments ?? [];
      if (next.length === 0) delete H.store[path];
      else H.store[path] = next;
      return Promise.resolve(next);
    }
    if (cmd === "clear_comments") {
      delete H.store[path];
      return Promise.resolve([]);
    }
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve(H.pendingReviews);
    if (cmd === "respond_to_review") {
      H.responses.push({ reviewId: args?.reviewId ?? "", decision: args?.decision ?? "", reason: args?.reason ?? "" });
      return Promise.resolve(undefined);
    }
    // set_open_plan / mark_viewed / resolve_cwds / focus_main_window / etc. — resolve benignly.
    return Promise.resolve(undefined);
  }),
}));
// The listen mock records each handler by event name so a test can dispatch a synthetic event.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    H.listeners[name] = handler;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));
// NOTE: ./render is intentionally NOT mocked — we need the real comments save/clear IO path.

import { openPlan, reviewCommentCount, __resetReviewStateForTest } from "./main";
import { asAbsPath, asStem } from "./types";

// Build a minimal standalone PlanRecord row for list_plans so renderSidebar emits a [data-path] row.
function planRow(absPath: string, stem: string): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd: null,
    unread: false,
    flavor: "standalone",
    tree_id: null,
    nn: null,
    child_count: null,
    collapsed: false,
    h1s: [],
  };
}

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button id="theme-toggle"></button>
    </div></div>
    <div class="tab-row"><span class="tab" data-tab="plans">Plans</span></div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span><div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
    <div class="sel-popover hidden" id="sel-popover">
      <div id="sp-quote"></div><textarea id="sp-text"></textarea>
      <button id="sp-cancel"></button><button id="sp-save"></button>
    </div>
    <div class="review-bar hidden" id="review-bar">
      <span id="review-bar-label"></span>
      <button id="review-submit" disabled></button>
      <button id="review-clear">Clear comments</button>
      <button id="review-resume"></button>
    </div>
    <button id="hook-setup"></button><button id="hook-remove"></button>
    <span id="hook-status"></span>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Fire a synthetic plan-review-requested event through the captured listener (the real wiring runs).
// `planFilePath` defaults to a real plans-dir path; tests push the matching list_plans row first.
async function fireReviewRequested(
  reviewId: string,
  planFilePath: string,
  planText = "# plan\n\nselect this phrase here\n",
): Promise<void> {
  H.listeners["plan-review-requested"]?.({
    payload: { review_id: reviewId, plan_text: planText, plan_file_path: planFilePath },
  });
  await flush();
}

// Fire a synthetic plan-review-cancelled event.
async function fireReviewCancelled(reviewId: string): Promise<void> {
  H.listeners["plan-review-cancelled"]?.({ payload: { review_id: reviewId } });
  await flush();
}

// Select the occurrence-th match of `needle` inside `block` as the live window selection.
function selectText(block: Element, needle: string, occurrence: number): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let tn = walker.nextNode() as Text | null;
  while (tn) {
    let from = 0;
    while (true) {
      const idx = tn.data.indexOf(needle, from);
      if (idx < 0) break;
      if (seen === occurrence) {
        const range = document.createRange();
        range.setStart(tn, idx);
        range.setEnd(tn, idx + needle.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      seen++;
      from = idx + needle.length;
    }
    tn = walker.nextNode() as Text | null;
  }
}

// Add an inline comment to whatever is currently rendered in the pane via the REAL popover flow.
function addCommentViaPopover(comment: string): void {
  const pane = document.querySelector<HTMLElement>("#reading-pane")!;
  const block = pane.querySelector("p[data-source-line]") ?? pane;
  selectText(block, "select this phrase", 0);
  pane.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  (document.querySelector("#sp-text") as HTMLTextAreaElement).value = comment;
  document.querySelector<HTMLElement>("#sp-save")!.click();
}

beforeEach(() => {
  H.store = {};
  H.invokeCalls = [];
  H.pendingReviews = [];
  H.responses = [];
  H.listeners = {};
  H.rows = [];
  // Module state (pendingReviews) persists across tests in a vitest file and re-booting the DOM does
  // not reset it. Clear it so each test starts clean.
  __resetReviewStateForTest();
});

// ---------------------------------------------------------------------------------------------
// INVARIANT (the bug we're fixing): a review OPENS + SELECTS the real plan file in the sidebar.
// ---------------------------------------------------------------------------------------------
describe("review-opens-real-file invariant — the reviewed plan is selected in the sidebar", () => {
  it("after plan-review-requested with a plan_file_path that has a sidebar row: pane shows that plan AND its row is active", async () => {
    const path = "/home/u/.claude/plans/Feature-X.md";
    H.rows = [planRow(path, "Feature-X")];
    bootDom();
    await flush();

    await fireReviewRequested("rev-inv", path);
    await flush();

    // The reading pane shows the REAL plan (its header filename = the file's basename).
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Feature-X.md");
    // INVARIANT: the sidebar row for that plan is SELECTED (.active). This is what was BROKEN before
    // (a detached render had no selected row). Inverting the open/select in main.ts makes this RED.
    const row = document.querySelector<HTMLElement>(`[data-path="${path}"]`)!;
    expect(row).not.toBeNull();
    expect(row.classList.contains("active")).toBe(true);
    // The bar is in VIEWING mode (the open plan IS the pending review).
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(submit.classList.contains("hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// CORE FIX — navigation is NEVER trapped by a pending review.
// ---------------------------------------------------------------------------------------------
describe("navigation-unstick — opening another plan while a review is pending does NOT trap or resolve", () => {
  it("shows the other plan, leaves the review pending, drops the bar to SUMMARY, and Resume reopens + reselects it", async () => {
    const reviewPath = "/home/u/.claude/plans/Reviewed.md";
    H.rows = [planRow(reviewPath, "Reviewed"), planRow("/home/u/.claude/plans/Other.md", "Other")];
    bootDom();
    await flush();

    // A review arrives while nothing is being viewed → opens + selects the real reviewed plan.
    await fireReviewRequested("rev-nav", reviewPath);
    await flush();
    const bar = document.querySelector<HTMLElement>("#review-bar")!;
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    const resume = document.querySelector<HTMLButtonElement>("#review-resume")!;
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(submit.classList.contains("hidden")).toBe(false); // viewing mode → Submit visible

    // Navigate to ANOTHER plan. The plan renders, the review stays pending, the bar enters SUMMARY.
    await openPlan(asAbsPath("/home/u/.claude/plans/Other.md"), asStem("Other"));
    await flush();

    expect(document.querySelector("#doc-filename")!.textContent).toBe("Other.md");
    // The OTHER plan's row is active; the reviewed plan's row is NOT.
    expect(document.querySelector<HTMLElement>(`[data-path="/home/u/.claude/plans/Other.md"]`)!.classList.contains("active")).toBe(true);
    expect(document.querySelector<HTMLElement>(`[data-path="${reviewPath}"]`)!.classList.contains("active")).toBe(false);
    // No respond_to_review was sent — the hook is untouched.
    expect(H.responses).toHaveLength(0);
    // Bar is in SUMMARY mode.
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(submit.classList.contains("hidden")).toBe(true);
    expect(resume.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-bar-label")!.textContent).toBe("1 plan awaiting review");

    // RESUME re-opens + reselects the still-pending reviewed plan (back to viewing mode).
    resume.click();
    await flush();
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Reviewed.md");
    expect(document.querySelector<HTMLElement>(`[data-path="${reviewPath}"]`)!.classList.contains("active")).toBe(true);
    expect(submit.classList.contains("hidden")).toBe(false);
    expect(resume.classList.contains("hidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Submit (deny) decision + removal from pending.
// ---------------------------------------------------------------------------------------------
describe("review action bar — Submit (deny) decision", () => {
  it("Submit sends decision 'deny' with the buildFeedbackPrompt reason (from the OPEN plan's comments), removes it from pending, hides the bar", async () => {
    const path = "/home/u/.claude/plans/Submit-Me.md";
    H.rows = [planRow(path, "Submit-Me")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-submit", path);

    addCommentViaPopover("please rename this section");
    await flush();
    expect(reviewCommentCount()).toBe(1);
    // The comment persisted to the REAL plan path (review comments are normal comments now).
    expect(H.store[path]).toBeDefined();
    expect(H.store[path]).toHaveLength(1);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(false); // enabled on the first comment
    submit.click();
    await flush();

    expect(H.responses).toHaveLength(1);
    expect(H.responses[0].reviewId).toBe("rev-submit");
    expect(H.responses[0].decision).toBe("deny");
    // The reason was built from the comments BEFORE they were cleared — the feedback carries them.
    expect(H.responses[0].reason).toContain("please rename this section");
    expect(H.responses[0].reason).toContain("Please revise the plan based on this feedback:");
    // Removed from pending → bar hidden (no other reviews).
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Submit-Me.md");
  });

  // ---------------------------------------------------------------------------------------------
  // CHANGE 1 (FALSIFIABLE): Submit CLEARS the submitted plan's comments AFTER the deny lands.
  // ---------------------------------------------------------------------------------------------
  it("Submit clears the submitted plan's comments (clear_comments invoked for openPath; store + pane highlights emptied) AFTER the deny", async () => {
    const path = "/home/u/.claude/plans/Clear-On-Submit.md";
    H.rows = [planRow(path, "Clear-On-Submit")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-clear-submit", path);

    addCommentViaPopover("consume this comment");
    await flush();
    expect(H.store[path]).toHaveLength(1);
    // The highlight is present in the pane before submit.
    expect(document.querySelectorAll("#reading-pane .cmt-hl").length).toBeGreaterThan(0);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    submit.click();
    await flush();

    // The deny was sent with the comment in the reason (reason built BEFORE the clear).
    expect(H.responses).toHaveLength(1);
    expect(H.responses[0].decision).toBe("deny");
    expect(H.responses[0].reason).toContain("consume this comment");

    // FALSIFIABLE assertion: clear_comments was invoked for the submitted plan's path, the backend
    // store for that path is empty, and the pane has no comment highlights. (Inverting the on-submit
    // clear in main.ts — i.e. not calling clearAllComments — turns all three of these RED.)
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(true);
    expect(H.store[path]).toBeUndefined();
    expect(document.querySelectorAll("#reading-pane .cmt-hl").length).toBe(0);
    // The count/bar reflect zero (bar hidden because the only review was removed).
    expect(reviewCommentCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // CHANGE 2 (FALSIFIABLE): the MANUAL #review-clear button — two-click confirm clears, single arms.
  // ---------------------------------------------------------------------------------------------
  it("#review-clear: a SINGLE click only arms (does NOT clear); a SECOND click clears the plan's comments", async () => {
    const path = "/home/u/.claude/plans/Manual-Clear.md";
    H.rows = [planRow(path, "Manual-Clear")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-manual-clear", path);

    addCommentViaPopover("a comment to clear manually");
    await flush();
    expect(H.store[path]).toHaveLength(1);

    const clearBtn = document.querySelector<HTMLButtonElement>("#review-clear")!;
    // The button is visible in viewing mode with >=1 comment.
    expect(clearBtn.classList.contains("hidden")).toBe(false);

    // FIRST click: arms only — NO clear_comments invoke, comments still present.
    clearBtn.click();
    await flush();
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(false);
    expect(H.store[path]).toHaveLength(1);
    expect(clearBtn.classList.contains("confirming")).toBe(true);

    // SECOND click: confirms — clear_comments invoked for the plan, store emptied, highlights gone.
    clearBtn.click();
    await flush();
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(true);
    expect(H.store[path]).toBeUndefined();
    expect(document.querySelectorAll("#reading-pane .cmt-hl").length).toBe(0);
    // No respond_to_review was sent — manual clear is independent of Submit.
    expect(H.responses).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------------------------
// First-comment Submit-enable (on the real plan's comment count).
// ---------------------------------------------------------------------------------------------
describe("review Submit button — enables on the FIRST inline comment", () => {
  it("Submit is disabled at 0 comments and ENABLES immediately after exactly one comment", async () => {
    const path = "/home/u/.claude/plans/First.md";
    H.rows = [planRow(path, "First")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-first", path);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(true); // 0 comments

    addCommentViaPopover("first and only comment");
    await flush();
    expect(reviewCommentCount()).toBe(1);
    expect(submit.disabled).toBe(false); // authoritative-count plumbing enables on the FIRST comment
  });
});

// ---------------------------------------------------------------------------------------------
// Cancellation — the open plan stays open; only the bar changes.
// ---------------------------------------------------------------------------------------------
describe("review cancellation — removes from pending, plan stays open", () => {
  it("a cancelled review is removed from pending and the bar hides if it was the only one; the plan stays open", async () => {
    const path = "/home/u/.claude/plans/Cancel.md";
    H.rows = [planRow(path, "Cancel")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-cancel", path);
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Cancel.md");

    await fireReviewCancelled("rev-cancel");
    // Bar hides (no pending reviews) but the plan is STILL open + selected.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Cancel.md");
    expect(document.querySelector<HTMLElement>(`[data-path="${path}"]`)!.classList.contains("active")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Un-openable plan (empty plan_file_path) — REFUSE-and-surface, NOT a detached phantom.
// (Bug #1 fix: the old "degraded detached render" left openPath null, so currentReviewId() stayed
// null → the bar fell to SUMMARY mode (Submit hidden, handlers bail on the null guards)
// while the dead review was STILL counted ("1 plan awaiting review"). It was un-actionable yet
// trapping. An un-openable review must be REFUSED — dropped from pending so it is not counted, with
// the failure surfaced on #hook-status — never rendered.)
// ---------------------------------------------------------------------------------------------
describe("un-openable review — empty plan_file_path refuses and surfaces (no unactionable phantom)", () => {
  it("with an empty plan_file_path the review is NOT rendered, NOT counted, and shows a #hook-status error", async () => {
    bootDom();
    await flush();

    await fireReviewRequested("rev-fallback", "", "# fallback plan\n\nselect this phrase here\n");
    await flush();

    // NOT rendered as a phantom: no "Plan review" header, the plan text is not shown in the pane.
    expect(document.querySelector("#doc-filename")!.textContent).not.toBe("Plan review");
    const pane = document.querySelector<HTMLElement>("#reading-pane")!;
    expect(pane.textContent ?? "").not.toContain("fallback plan");
    // NOT counted: the bar is fully hidden (pendingCount === 0). A counted phantom would show SUMMARY.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#review-bar-label")!.textContent).not.toContain("awaiting review");
    // The failure is surfaced on the existing #hook-status error affordance.
    const status = document.querySelector<HTMLElement>("#hook-status")!;
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent!.length).toBeGreaterThan(0);
  });
});
