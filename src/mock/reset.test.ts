// Mock-mode PHASE 4 tests — the RESET seam + knob/jumper IDEMPOTENCY (the deck's foundation).
//
// Falsifiable properties, each through the REAL production code the live app uses:
//   1. SCENE-JUMP CLEANLINESS (carried Finding 2): a conversation jump A → jump B (through the SAME
//      __mock mechanism) leaves a fresh subscriber (= a fresh page load's fresh ConversationModel)
//      replaying ONLY B's signature. Falsifiability: a sibling test emits both scenes WITHOUT the
//      reset/buffer-clear and shows A leaks — proving the clear is load-bearing.
//   2. REVIEW RESET: showReview("viewing") → reset() → the review bar is fully hidden, asserted via
//      the REAL refresh signal (main.ts's pendingReviews effectively cleared), not just the mock store.
//   3. AUTH RESTORE: showAuthOnboarding() → reset()/openComposer() → the composer is NOT auth-blocked.
//   4. (Concern 4) the MODULE-PRIVATE applyPrototypeBar renders `.review-bar.proto`/#prototype-feedback
//      through the REAL observer (the fake orchestrator gate → main.ts's subscribed observer), not just
//      the pure gate functions.
//
// HARNESS: tests 2-4 boot the REAL main.ts via DOMContentLoaded against the MOCK Tauri shims (aliased
// the same way vite.mock.config.ts does at runtime) + the mock fake orchestrator installed FIRST, so
// main.ts subscribes ITS real observer to our handle. This is the live wiring, not a copy.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Alias @tauri-apps/* to the SAME mock shims the runtime uses, so the real main.ts + conversation
// facade run against the in-memory store (no real Tauri). This mirrors vite.mock.config.ts's resolve
// alias at the vitest layer (vi.mock with a factory that re-exports the shim module).
vi.mock("@tauri-apps/api/core", async () => await import("./core"));
vi.mock("@tauri-apps/api/event", async () => await import("./event"));
vi.mock("@tauri-apps/api/path", async () => await import("./path"));
vi.mock("@tauri-apps/api/window", async () => await import("./window"));
vi.mock("@tauri-apps/plugin-opener", async () => await import("./opener"));
vi.mock("@tauri-apps/plugin-dialog", async () => await import("./dialog"));
// The titlebar initializers read localStorage (absent in this jsdom config). The DOM-boot tests here
// exercise the review bar / composer / prototype applier — NOT theme/text-size — so stub the titlebar
// initializers, exactly as the other main.ts DOM-boot tests do. (The theme/text-size KNOBS drive the
// real titlebar buttons; that path is exercised through the deck, not these boot tests.)
vi.mock("../titlebar", () => ({
  initTitlebar: vi.fn(),
  initThemeToggle: vi.fn(),
  initTextSize: vi.fn(),
}));

import { ConversationModel } from "../conversation/stream";
import { renderTree } from "../conversation/render";
import { listen, clearMockBuffer } from "./event";
import { resetState } from "./state";
import { SCENES } from "./fixtures/scenes";
import { installMockApi } from "./api";
import { installMockOrchestrator, emitGate } from "./orchestrator";

// ---- shared helpers --------------------------------------------------------------------------

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// A minimal "fresh page load" live harness: a brand-new ConversationModel subscribing to the two
// render channels AFTER the jumps ran, rendering on each replayed frame. Mirrors the controller's
// subscribe → model → rerender wiring (and what a real reload gives the live app). Returns the
// container so the test can query the rendered DOM.
async function freshSubscriber(): Promise<HTMLElement> {
  const model = new ConversationModel();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const rerender = (): void => renderTree(container, model.derive());
  await listen("agent-stream", (e) => {
    model.appendStream(e.payload as never);
    rerender();
  });
  await listen("tool-permission-requested", (e) => {
    model.appendPermissionRequest(e.payload as never);
    rerender();
  });
  return container;
}

// ---------------------------------------------------------------------------------------------
// 1. SCENE-JUMP CLEANLINESS (carried Finding 2).
// ---------------------------------------------------------------------------------------------
describe("reset — a conversation jump A → B leaves no leftover of A for a fresh subscriber", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearMockBuffer();
    resetState();
    // Test mode: conversation jumps run IN PLACE (no reload — unavailable in jsdom). The buffer-clear
    // inside reset()/playSceneFrames is what a fresh subscriber (a real reload's fresh model) relies on.
    window.__mockNoReload = true;
    installMockApi();
  });

  it("__mock.playScene(A) then __mock.playScene(B): a fresh subscriber renders ONLY B's signature", async () => {
    // Jump A (subagentGroup) then jump B (toolError) through the public __mock mechanism (each routes
    // through reset() → in-place stage, clearing the agent buffers before staging the new scene).
    window.__mock!.playScene("subagentGroup");
    window.__mock!.playScene("toolError");
    await flush();

    // A fresh subscriber (= a fresh page load's fresh model) replays the now-B-only buffer.
    const container = await freshSubscriber();
    await flush();

    // Scene B's signature is present…
    expect(container.querySelector('.conv-tool[data-status="error"]')).not.toBeNull();
    // …and scene A's signature (the subagent group) is NOT — reset() cleared A's frames before B staged.
    expect(container.querySelector(".conv-subagent")).toBeNull();
  });

  it("FALSIFY: WITHOUT the reset/buffer-clear, scene A leaks into the fresh subscriber", async () => {
    // Emit BOTH scenes' frames onto the bus directly WITHOUT clearing between them (i.e. reset skipped).
    // The fresh subscriber then replays BOTH — scene A's subagent group leaks in. This is the proof the
    // reset's buffer-clear is load-bearing: with it (the test above) A is absent; without it A is present.
    const { emitMockEvent } = await import("./event");
    for (const f of SCENES.subagentGroup()) emitMockEvent(f.event, f.payload);
    for (const f of SCENES.toolError()) emitMockEvent(f.event, f.payload);
    await flush();

    const container = await freshSubscriber();
    await flush();

    expect(container.querySelector('.conv-tool[data-status="error"]')).not.toBeNull();
    expect(container.querySelector(".conv-subagent")).not.toBeNull(); // A leaked (the bug reset prevents)
  });

  it("a jump A → reset() clears the staged frames: a fresh subscriber renders NOTHING from A", async () => {
    window.__mock!.playScene("subagentGroup");
    window.__mock!.reset();
    await flush();

    const container = await freshSubscriber();
    await flush();

    // After reset(), the buffer is empty → the fresh subscriber renders no scene-A nodes.
    expect(container.querySelector(".conv-subagent")).toBeNull();
    expect(container.querySelector('.conv-tool')).toBeNull();
  });

  it("buffer-scoping holds for the in-place stage path: only the latest scene is buffered", async () => {
    // Drive three jumps; the buffer must carry ONLY the last scene's frames (each playScene clears first).
    window.__mock!.playScene("toolDone");
    window.__mock!.playScene("resultError");
    window.__mock!.playScene("assistantText");
    await flush();

    const container = await freshSubscriber();
    await flush();

    expect(container.querySelector(".conv-text")).not.toBeNull(); // assistantText present
    expect(container.querySelector('.conv-tool[data-status="done"]')).toBeNull(); // toolDone gone
    expect(container.querySelector(".conv-result-error")).toBeNull(); // resultError gone
  });
});

// ---------------------------------------------------------------------------------------------
// 2-4. DOM-boot tests: the REAL main.ts wired to the mock shims + the mock fake orchestrator.
// ---------------------------------------------------------------------------------------------

// A complete-enough index.html for main.ts's DOMContentLoaded wiring: sidebar, reader tabs, the FULL
// review bar (incl. the prototype-mode controls applyPrototypeBar drives), the conversation pane, the
// composer modal (incl. the auth block), the resume banner, and the titlebar buttons.
function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button class="conv-new-plan" id="new-plan-btn"></button>
      <button id="text-dec"></button><button id="text-inc"></button>
      <button id="theme-toggle"><span id="theme-icon"></span></button>
    </div></div>
    <div class="tab-row"><span class="tab active" data-tab="plans">Plans</span>
      <span class="tab" data-tab="contents">Contents</span></div>
    <div class="tab-pane active" id="tab-plans">
      <div class="search"><input id="plan-filter" /><button class="clear"></button></div>
      <span id="plan-count"></span>
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
        <div class="resume-banner hidden" id="resume-banner">
          <span id="resume-banner-msg"></span><button id="resume-plan-btn"></button>
        </div>
        <div class="review-bar hidden" id="review-bar">
          <span id="review-bar-label"></span>
          <button id="review-submit" disabled>Submit feedback</button>
          <button id="review-clear">Clear comments</button>
          <button id="review-approve" class="hidden">Approve &amp; Build</button>
          <button id="review-resume"></button>
          <button id="review-refine" class="hidden"></button>
          <select id="review-refine-target" class="hidden"></select>
          <textarea id="prototype-feedback" class="hidden"></textarea>
          <button id="prototype-open" class="hidden"></button>
          <input type="checkbox" id="prototype-working-ref" />
          <label id="prototype-working-ref-label" class="hidden"></label>
        </div>
        <div class="md" id="reading-pane"></div>
      </div>
      <div class="tab-pane" id="tab-conversation">
        <button class="conv-cancel" id="conversation-cancel"></button>
        <button id="conversation-pause"></button>
        <button id="conversation-resume"></button>
        <div class="conv-stream" id="conversation-stream"></div>
        <textarea id="conversation-input"></textarea>
        <button id="conversation-send"></button>
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
      <div id="composer-mode"><button class="conv-mode-btn active" data-mode="plan"></button><button class="conv-mode-btn" data-mode="acceptEdits"></button></div>
      <button id="composer-start"></button>
      <button id="composer-cancel"></button>
      <div class="conv-auth hidden" id="composer-auth"><input id="composer-token" /><button id="composer-token-submit"></button></div>
    </div>
    <div id="composer-status"></div>
    <button id="hook-setup"></button><button id="hook-remove"></button>
    <span id="hook-status"></span>
    <div class="toast hidden" id="toast"></div>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

describe("reset — DOM-boot review/auth idempotency + the real prototype applier", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearMockBuffer();
    resetState();
    window.__mockNoReload = true;
    // Install the fake orchestrator BEFORE main.ts boots so getOrchestrator() returns it and main.ts
    // subscribes its REAL observer to our handle (the prototype-gate seam).
    installMockOrchestrator();
    installMockApi();
  });

  // ---- 4. Concern-4: the module-private applyPrototypeBar through the REAL observer --------------
  it("emitGate('prototype') drives the REAL applyPrototypeBar → .review-bar.proto + #prototype-feedback shown", async () => {
    bootDom();
    await flush();

    // Park on Conversation so the gate's flip-to-Plan + applyPrototypeBar is load-bearing.
    document.querySelector<HTMLElement>('.reader-tab-row .tab[data-tab="conversation"]')!.click();

    // Drive the prototype gate through the fake handle → main.ts's subscribed onSnapshot/onPrototypeReview
    // → the REAL applyPrototypeBar (module-private; reachable ONLY via this observer).
    emitGate("prototype");
    await flush();

    const bar = document.querySelector("#review-bar")!;
    // FALSIFY: if main.ts derived the bar mode from anything other than the snapshot (or the observer
    // were not wired), .proto would never be added → RED.
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(bar.classList.contains("proto")).toBe(true);
    expect(document.querySelector("#prototype-feedback")!.classList.contains("hidden")).toBe(false);
    // The label is the REAL prototypeBarLabel(round=1).
    expect(document.querySelector("#review-bar-label")!.textContent).toContain("round 1");
  });

  it("the prototype round knob varies the REAL label via emitGate(round)", async () => {
    bootDom();
    await flush();
    emitGate("prototype", 2);
    await flush();
    expect(document.querySelector("#review-bar-label")!.textContent).toContain("round 2");
  });

  // ---- 2. Review reset: showReview('viewing') → reset() → bar fully hidden ----------------------
  it("showReview('viewing') shows the bar; reset() hides it (main.ts pendingReviews cleared)", async () => {
    bootDom();
    await flush();

    await window.__mock!.showReview("viewing");
    await flush();
    const bar = document.querySelector("#review-bar")!;
    // The bar is showing the external review (VIEWING): not hidden.
    expect(bar.classList.contains("hidden")).toBe(false);

    // Reset drives the REAL teardown (end_agent_session purge + __resetReviewStateForTest clears the
    // pendingReviews Map + openPath). The bar must fully hide — asserted via the rendered bar (driven by
    // the real refreshReviewBar off the now-empty pendingReviews), not the mock store.
    window.__mock!.reset();
    await flush();
    // FALSIFY: if reset() only cleared the mock store (setPendingReviews) but NOT main.ts's own Map, the
    // bar would still show SUMMARY (pendingCount > 0) → this assertion goes RED.
    expect(bar.classList.contains("hidden")).toBe(true);
  });

  it("showReview('viewing') → another jump (openComposer) also clears the review bar", async () => {
    bootDom();
    await flush();
    await window.__mock!.showReview("viewing");
    await flush();
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);

    // openComposer() calls reset() first → the review bar must hide before the composer opens.
    window.__mock!.openComposer();
    await flush();
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
  });

  // ---- 3. Auth restore: showAuthOnboarding() → openComposer() not auth-blocked ------------------
  it("showAuthOnboarding() blocks the composer on auth; openComposer() afterward is NOT auth-blocked", async () => {
    bootDom();
    await flush();

    window.__mock!.showAuthOnboarding();
    await flush();
    // The composer opened in the auth-onboarding state: the auth block is visible.
    const authBlock = document.querySelector("#composer-auth")!;
    expect(authBlock.classList.contains("hidden")).toBe(false);

    // A later openComposer() calls reset() first → auth restored to hasToken:true → the composer opens
    // WITHOUT the auth block. FALSIFY: if reset() did not restore auth, the block would still show → RED.
    window.__mock!.openComposer();
    await flush();
    expect(document.querySelector("#composer-auth")!.classList.contains("hidden")).toBe(true);
  });
});
