import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// review2 c5 — LIVE-PATH test for the in-process "Request changes" review bar.
//
// THE BUG THIS CATCHES (the "mocked test hid the real bug" trap): the original c5 tests asserted
// `applyReviewBarState(...)` IN ISOLATION, which masked a real main.ts derivation bug — the mock-ANIMATE
// player renders the reading pane DIRECTLY (never through openPlan), so main.ts's module-level `openPath`
// stayed null/stale during the comment chapter. `viewingGate()` compares `gate.planPath === openPath`, so
// the held approval gate was seen as a review of a DIFFERENT plan → SUMMARY mode ("N plans awaiting
// review" + external "Submit feedback"), NOT the in-process "Request changes" VIEWING bar.
//
// This test drives the REAL composition the mock seam (`emitReviewGate` in src/mock/animate/index.ts)
// uses — __setOpenPathForMock + emitApprovalGate (onSnapshot fan) + refreshCommentCount — against a
// REAL #review-bar DOM + the REAL main.ts derivation (refreshReviewBar/applyReviewBarState). It asserts
// the RENDERED bar, not a pure helper in isolation. RED PROOF: omitting __setOpenPathForMock reproduces
// the live summary-mode bug (label "1 plan awaiting review" + "Submit feedback"), captured by the
// dedicated "RED proof" test below.
// ---------------------------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  // The mock comment count get_comment_count returns for the open plan (set per scenario).
  commentCount: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nbody\n");
    if (cmd === "list_plans") return Promise.resolve([]);
    if (cmd === "get_comments") return Promise.resolve([]);
    if (cmd === "get_comment_count") return Promise.resolve(H.commentCount);
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "hook_status") return Promise.resolve(false);
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    (H.listeners[name] ??= []).push(handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { __resetReviewStateForTest, __setOpenPathForMock, refreshCommentCount } from "./main";
import {
  installMockOrchestrator,
  emitApprovalGate,
  clearApprovalGate,
} from "./mock/orchestrator";
import { setCommentCount } from "./mock/state";

const MASTER = "/home/u/.claude/plans/agent-plan-tree-trailhead-7f3a91c2-00.md";

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button class="conv-new-plan" id="new-plan-btn"></button>
      <button id="theme-toggle"></button>
    </div></div>
    <div class="tab-row"><span class="tab" data-tab="plans">Plans</span></div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span>
      <div class="sidebar-status"><span class="conv-status" id="sdk-status"></span></div>
      <div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="reader-inner">
      <div class="tab-row reader-tab-row">
        <span class="tab active" data-tab="plan">Plan</span>
        <span class="tab" data-tab="conversation">Conversation</span>
      </div>
      <div class="tab-pane active" id="tab-plan">
        <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
        <div class="review-bar hidden" id="review-bar">
          <span id="review-bar-label"></span>
          <button id="review-submit" disabled>Submit feedback</button>
          <button id="review-clear">Clear comments</button>
          <button id="review-approve" class="hidden">Approve &amp; Build</button>
          <button id="review-resume"></button>
        </div>
        <div class="md" id="reading-pane"></div>
      </div>
      <div class="tab-pane" id="tab-conversation">
        <button class="conv-cancel" id="conversation-cancel"></button>
        <div class="conv-stream" id="conversation-stream"></div>
      </div>
    </div></main>
    <div class="sel-popover hidden" id="sel-popover">
      <div id="sp-quote"></div><textarea id="sp-text"></textarea>
      <button id="sp-cancel"></button><button id="sp-save"></button>
    </div>
    <div class="conv-modal hidden" id="composer-modal">
      <textarea id="composer-request"></textarea>
      <input id="composer-dir" />
      <button id="composer-choose-dir"></button>
      <div id="composer-mode"><button class="conv-mode-btn active" data-mode="plan"></button></div>
      <button id="composer-start"></button>
      <button id="composer-cancel"></button>
      <div class="conv-auth hidden" id="composer-auth"><input id="composer-token" /><button id="composer-token-submit"></button></div>
    </div>
    <button id="hook-setup"></button><button id="hook-remove"></button>
    <span id="hook-status"></span>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  // installMockOrchestrator MUST run before main.ts's DOMContentLoaded wiring subscribes its observer
  // (the same ordering the real mock boot guarantees).
  installMockOrchestrator();
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 24): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Drive the EXACT seam composition src/mock/animate/index.ts's emitReviewGate uses (minus the
// __setOpenPathForMock call, which `alignOpenPath` toggles so the RED proof can omit it).
async function driveReviewGate(planPath: string, commentCount: number, alignOpenPath: boolean): Promise<void> {
  if (alignOpenPath) __setOpenPathForMock(planPath);
  setCommentCount(commentCount);
  emitApprovalGate(planPath);
  await refreshCommentCount();
  await flush();
}

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  H.commentCount = 0;
  __resetReviewStateForTest();
});

describe("review2 c5 — in-process Request-changes bar (LIVE main.ts derivation)", () => {
  it("with openPath aligned: #review-bar renders VIEWING / in-process — 'Request changes', NOT summary", async () => {
    bootDom();
    await flush();
    H.commentCount = 3;
    await driveReviewGate(MASTER, 3, true);

    const bar = document.querySelector("#review-bar")!;
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    const label = document.querySelector("#review-bar-label")!;
    const resume = document.querySelector("#review-resume")!;

    // VISIBLE + in-process VIEWING (NOT proto, NOT summary).
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(bar.classList.contains("proto")).toBe(false);
    // The faithful in-process label "Request changes" (the EXTERNAL/summary path reads "Submit feedback").
    expect(submit.textContent).toBe("Request changes");
    expect(submit.classList.contains("hidden")).toBe(false);
    // 3 comments ⇒ ENABLED.
    expect(submit.disabled).toBe(false);
    // VIEWING label (not "N plans awaiting review"); Resume hidden (summary-only).
    expect(label.textContent).toContain("Reviewing plan");
    expect(label.textContent).not.toContain("awaiting review");
    expect(resume.classList.contains("hidden")).toBe(true);
  });

  it("Submit DISABLED at 0 comments → ENABLED at 1 (live, via refreshCommentCount)", async () => {
    bootDom();
    await flush();

    // 0 comments → bar visible, Request changes, DISABLED.
    H.commentCount = 0;
    await driveReviewGate(MASTER, 0, true);
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(submit.textContent).toBe("Request changes");
    expect(submit.disabled).toBe(true);

    // 1 comment → ENABLED (the count is the SOLE enable gate).
    H.commentCount = 1;
    await driveReviewGate(MASTER, 1, true);
    expect(submit.textContent).toBe("Request changes");
    expect(submit.disabled).toBe(false);
  });

  it("RED PROOF — WITHOUT aligning openPath the SAME gate lands in SUMMARY mode ('awaiting review' + 'Submit feedback')", async () => {
    // This is EXACTLY the live bug the isolation test masked: the player never set openPath, so
    // viewingGate() (openPath === gate.planPath) is false → viewing:false → SUMMARY mode. Asserting the
    // RENDERED summary state here proves the alignOpenPath step is load-bearing (remove it in the fix and
    // the first test goes RED with these summary values).
    bootDom();
    await flush();
    H.commentCount = 3;
    await driveReviewGate(MASTER, 3, /* alignOpenPath */ false);

    const bar = document.querySelector("#review-bar")!;
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    const label = document.querySelector("#review-bar-label")!;
    const resume = document.querySelector("#review-resume")!;

    // The gate IS pending, but the open plan is NOT it → SUMMARY: count label + Resume, NO in-process
    // "Request changes". This is the wrong state the original isolation test could not see.
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(label.textContent).toContain("awaiting review");
    expect(resume.classList.contains("hidden")).toBe(false);
    // External label, submit hidden in summary mode.
    expect(submit.textContent).not.toBe("Request changes");
    expect(submit.classList.contains("hidden")).toBe(true);
  });

  it("clearApprovalGate ⇒ the bar hides (clean teardown)", async () => {
    bootDom();
    await flush();
    H.commentCount = 3;
    await driveReviewGate(MASTER, 3, true);
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);

    clearApprovalGate();
    await flush();
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
  });
});
