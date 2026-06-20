// Mock-mode KNOB-APPLY tests — the deck's knobs drive their surface through the REAL knob.apply path.
//
// Review finding (Fix 1): the deck's reset() (called first by every composite driver) wiped the knob
// store BEFORE the driver read it, so six knobs silently no-op'd (review.comments, review.protoRound,
// and the four question.* knobs). The fix threads each knob's value EXPLICITLY into its driver. These
// tests exercise the REAL `KNOBS.find(k => k.id === …).apply(value)` path (NOT a hand-rolled driver
// call) and assert the RENDERED surface reflects `value`, not the default.
//
// FALSIFIABILITY: each assertion was confirmed RED by temporarily reverting Fix 1 (making the driver
// read the wiped store → the default). With the fix restored every assertion is GREEN. The asserts pin
// the NON-default value, so a regression that re-introduces the cold-read-after-reset bug fails here.
//
// HARNESS: identical to reset.test.ts — boot the REAL main.ts via DOMContentLoaded against the mock
// Tauri shims + the fake orchestrator installed FIRST, with window.__mockNoReload set so the
// conversation jumps (and the composite drivers' reset()/playScene) run IN PLACE (jsdom cannot reload).
// This is the live wiring (real conversation model, real review-bar derivation), not a copy.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => await import("./core"));
vi.mock("@tauri-apps/api/event", async () => await import("./event"));
vi.mock("@tauri-apps/api/path", async () => await import("./path"));
vi.mock("@tauri-apps/api/window", async () => await import("./window"));
vi.mock("@tauri-apps/plugin-opener", async () => await import("./opener"));
vi.mock("@tauri-apps/plugin-dialog", async () => await import("./dialog"));
vi.mock("../titlebar", () => ({
  initTitlebar: vi.fn(),
  initThemeToggle: vi.fn(),
  initTextSize: vi.fn(),
}));

import { listen, clearMockBuffer } from "./event";
import {
  resetState,
  getKnob,
  setKnob,
  setCommentCount,
  getCommentCount,
  persistKnobsToSession,
  restoreKnobsFromSession,
} from "./state";
import { installMockApi, readPendingConvJump } from "./api";
import { installMockOrchestrator } from "./orchestrator";
import { KNOBS, seedKnobDefaults, type Knob } from "./knobs";
import { ConversationModel } from "../conversation/stream";
import { renderTree } from "../conversation/render";

// ---- shared helpers --------------------------------------------------------------------------

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// A "fresh page load" live harness: a brand-new ConversationModel subscribing AFTER the jumps ran (=
// what a real reload's fresh model gets). Mirrors reset.test.ts's freshSubscriber. The post-reload model
// replays ONLY the agent buffers left after the jump, so an empty buffer → an empty pane.
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

// Look up a knob by id (the REAL deck path). Throws if absent so a renamed/removed knob fails loudly.
function knob(id: string): Knob {
  const k = KNOBS.find((x) => x.id === id);
  if (!k) throw new Error(`knob not found: ${id}`);
  return k;
}

// The SAME complete index.html main.ts's DOMContentLoaded wiring expects (sidebar, reader tabs, the full
// review bar incl. prototype controls, the conversation pane, composer, resume banner, titlebar). Lifted
// verbatim from reset.test.ts's bootDom so the live wiring matches the runtime exactly.
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

beforeEach(() => {
  document.body.innerHTML = "";
  clearMockBuffer();
  resetState();
  // Clear any persisted knob stash so the Fix-4 persistence tests don't leak across cases.
  try {
    window.sessionStorage?.clear();
  } catch {
    /* ignore */
  }
  // In-place (no reload) so the composite drivers' reset()/playScene stage onto the LIVE bus the booted
  // conversation model subscribes to, and showReview's reload-less path runs.
  window.__mockNoReload = true;
  installMockOrchestrator();
  installMockApi();
  // The deck seeds knob defaults on load; mirror that so getKnob fallbacks match the runtime BEFORE a
  // knob explicitly overrides its own value.
  seedKnobDefaults();
});

// ---------------------------------------------------------------------------------------------
// QUESTION CARD knobs — the four composite knobs each re-derive the whole card via driveQuestionCard.
// ---------------------------------------------------------------------------------------------
describe("knob.apply — question card knobs reflect their value (not the default)", () => {
  it("question.count apply(3) renders 3 question sections (default is 2)", async () => {
    bootDom();
    await flush();

    knob("question.count").apply(3);
    await flush();

    const sections = document.querySelectorAll("#conversation-stream .conv-question-section");
    // FALSIFY: if driveQuestionCard read the wiped store (default count 2), this would be 2 → RED.
    // (The store value itself is intentionally NOT asserted: every composite driver calls reset() →
    // resetState() which wipes the knob slice. The SURFACE is the contract — the value is threaded
    // explicitly into the driver, so it takes effect even though the store is cleared moments later.)
    expect(sections.length).toBe(3);
  });

  it("question.multiSelect apply(true) renders checkbox inputs (default radio)", async () => {
    bootDom();
    await flush();

    knob("question.multiSelect").apply(true);
    await flush();

    const checkboxes = document.querySelectorAll(
      '#conversation-stream .conv-question-input[type="checkbox"]',
    );
    const radios = document.querySelectorAll(
      '#conversation-stream .conv-question-input[type="radio"]',
    );
    // FALSIFY: if the knob no-op'd back to the default (multiSelect:false), inputs would be radios → RED.
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(radios.length).toBe(0);
    // The section also advertises its multiSelect via data-multi-select.
    expect(
      document.querySelector('#conversation-stream .conv-question-section[data-multi-select="true"]'),
    ).not.toBeNull();
  });

  it("question.answered toggles the result-present state (pending: no result; answered: result present)", async () => {
    bootDom();
    await flush();

    // answered:false → the card holds the turn, NO terminal result frame is staged.
    knob("question.answered").apply(false);
    await flush();
    expect(document.querySelector("#conversation-stream .conv-question-section")).not.toBeNull();
    expect(document.querySelector("#conversation-stream .conv-result")).toBeNull();

    // answered:true → driveQuestionCard appends a result frame so the card is no longer the active hold.
    knob("question.answered").apply(true);
    await flush();
    // FALSIFY: if driveQuestionCard read the wiped store (answered:false), no result frame would stage →
    // .conv-result absent → RED. The question card still renders alongside the result.
    expect(document.querySelector("#conversation-stream .conv-result")).not.toBeNull();
    expect(document.querySelector("#conversation-stream .conv-question-section")).not.toBeNull();
  });

  it("question.other apply(false) collapses each section to a single concrete option (default 3)", async () => {
    bootDom();
    await flush();

    knob("question.other").apply(false);
    await flush();

    // With includeOther:false each section carries ONE concrete option (the renderer still appends its
    // own always-present 'Other…' toggle, so total inputs = concrete + 1 other-toggle per section).
    const firstSection = document.querySelector("#conversation-stream .conv-question-section")!;
    const concrete = firstSection.querySelectorAll(
      ".conv-question-input:not(.conv-question-other-toggle)",
    );
    // FALSIFY: if the knob no-op'd back to the default (includeOther:true), the section would carry 3
    // concrete options → this would be 3, not 1 → RED.
    expect(concrete.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// REVIEW BAR knobs — protoRound (label) + comments (count label + submit-enabled).
// ---------------------------------------------------------------------------------------------
describe("knob.apply — review bar knobs reflect their value (not the default)", () => {
  it("review.protoRound apply('3') renders the bar label 'round 3' (default round 1)", async () => {
    bootDom();
    await flush();

    knob("review.protoRound").apply("3");
    await flush();

    const label = document.querySelector("#review-bar-label")!.textContent ?? "";
    // FALSIFY: if emitReviewWithRound read the wiped store (default round 1), this would be 'round 1' → RED.
    expect(label).toContain("round 3");
    expect(label).not.toContain("round 1");
  });

  it("review.comments apply(2) shows the VIEWING bar with 2 comments + Submit enabled (default 0/disabled)", async () => {
    bootDom();
    await flush();

    knob("review.comments").apply(2);
    await flush();

    const bar = document.querySelector("#review-bar")!;
    const label = document.querySelector("#review-bar-label")!.textContent ?? "";
    const submit = document.querySelector("#review-submit") as HTMLButtonElement;
    expect(bar.classList.contains("hidden")).toBe(false);
    // FALSIFY: if showReview's reset() left the count at 0 (the bug), the label would read '0 comments'
    // and Submit would stay disabled → both assertions RED.
    expect(label).toContain("2 comments");
    expect(submit.disabled).toBe(false);
  });

  it("review.comments apply(0) keeps Submit DISABLED (the zero-count boundary)", async () => {
    bootDom();
    await flush();

    // Drive to 2 first (Submit enabled), then back to 0 — the count must visibly fall to 0/disabled,
    // proving the value (not a stale default) drives the bar in BOTH directions.
    knob("review.comments").apply(2);
    await flush();
    knob("review.comments").apply(0);
    await flush();

    const label = document.querySelector("#review-bar-label")!.textContent ?? "";
    const submit = document.querySelector("#review-submit") as HTMLButtonElement;
    expect(label).toContain("0 comments");
    expect(submit.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// FIX 3 — conv.session="none" routes the "__none" sentinel through the reload seam → a genuinely empty
// LIVE conversation pane. Asserted via the fresh-subscriber (= post-reload model) pattern, the same way
// reset.test.ts proves scene-jump cleanliness: after the jump the agent buffers are empty, so the model
// a real reload would build renders NOTHING.
// ---------------------------------------------------------------------------------------------
describe("conv.session=none — clears the live conversation to a genuinely empty pane (reload seam)", () => {
  // NOTE on the LIVE reload routing: in the real app conv.session="none" routes through
  // routeConvJump({kind:"none"}) → location.replace(?mockjump=__none) so initConversation rebuilds a
  // FRESH (empty) model — the ONLY faithful way to clear the live ConversationModel (it has no in-place
  // reset). jsdom's window.location.replace is non-configurable (cannot be spied), so the navigation
  // itself is not directly asserted here; the two falsifiable proxies below cover the mechanism:
  //   (a) the post-jump buffer is empty → the fresh model a reload builds renders nothing, and
  //   (b) the "__none" the jump writes round-trips through readPendingConvJump back to {kind:"none"}.

  it("conv.session='none' → an empty buffer → a fresh subscriber renders no live nodes", async () => {
    bootDom();
    await flush();

    // Stage a scene with a clear signature via the real conversation knob path, then clear via the real
    // conv.session knob. In test mode the jump runs in place: reset() empties the agent buffers and
    // NOTHING is staged (the "none" sentinel stages no frames).
    knob("conv.subagent").apply(true);
    await flush();
    knob("conv.session").apply("none");
    await flush();

    // A fresh subscriber (= the model a real reload builds) replays the now-EMPTY buffer → no nodes.
    const container = await freshSubscriber();
    await flush();
    // FALSIFY: if the "none" jump staged ANYTHING (e.g. an assistant scene) instead of nothing, or did
    // not clear the prior subagent scene, these would find nodes → RED.
    expect(container.querySelector(".conv-subagent")).toBeNull();
    expect(
      container.querySelectorAll(".conv-text, .conv-tool, .conv-result, .conv-subagent").length,
    ).toBe(0);
  });

  it("the '__none' sentinel parses to the none jump; an unknown param is a no-op (null), not a throw", () => {
    const orig = window.location.search;
    const set = (search: string): void => {
      // jsdom allows assigning location.search; guard with a try so a hardened env degrades gracefully.
      try {
        window.history.replaceState(null, "", `${window.location.pathname}${search}`);
      } catch {
        /* ignore */
      }
    };

    set("?mockjump=__none");
    expect(readPendingConvJump()).toEqual({ kind: "none" });

    // FALSIFY: an unknown sentinel must validate to null (no-op), NOT throw and NOT a stray jump kind.
    set("?mockjump=__bogus");
    expect(readPendingConvJump()).toBeNull();

    set("?mockjump=scene:does-not-exist");
    expect(readPendingConvJump()).toBeNull();

    set(orig);
  });
});

// ---------------------------------------------------------------------------------------------
// FIX 4 — the knob store (+ commentCount) round-trips through sessionStorage across a conversation-jump
// reload: persistKnobsToSession() before location.replace, restoreKnobsFromSession() on boot. Tested at
// the state-module seam (jsdom has window.sessionStorage but cannot actually reload).
// ---------------------------------------------------------------------------------------------
describe("knob store persistence across a conversation-jump reload (sessionStorage)", () => {
  it("persist → resetState (simulates the reload's fresh state) → restore brings the knobs back", () => {
    // Mutate the store the way the deck would after a user changes some non-global knobs.
    setKnob("sidebar.count", 9);
    setKnob("sidebar.tree", false);
    setCommentCount(4);

    // Before the (simulated) reload, the jump persists the store.
    persistKnobsToSession();

    // The reload drops the in-memory store back to the fixture seed (knobs:{}, commentCount:0).
    resetState();
    expect(getKnob<number>("sidebar.count")).toBeUndefined();
    expect(getCommentCount()).toBe(0);

    // On boot the deck restores BEFORE seeding defaults.
    const restored = restoreKnobsFromSession();
    // FALSIFY: if persistence were absent (the bug), the store would still be empty → these go RED.
    expect(restored).not.toBeNull();
    expect(getKnob<number>("sidebar.count")).toBe(9);
    expect(getKnob<boolean>("sidebar.tree")).toBe(false);
    expect(getCommentCount()).toBe(4);
  });

  it("seedKnobDefaults does NOT clobber a restored value (fill-only-where-missing)", () => {
    setKnob("sidebar.count", 7);
    persistKnobsToSession();
    resetState();
    restoreKnobsFromSession();

    // seedKnobDefaults must leave the restored sidebar.count alone while filling the UNSET knobs.
    seedKnobDefaults();
    // FALSIFY: the old unconditional `setKnob(k.id, k.default)` would reset sidebar.count to 4 → RED.
    expect(getKnob<number>("sidebar.count")).toBe(7);
    // A knob that was NOT restored still gets its default.
    expect(getKnob<number>("sidebar.unread")).toBe(1);
  });

  it("restore is consume-once: a second restore (no fresh persist) returns null (clean manual refresh)", () => {
    setKnob("sidebar.count", 5);
    persistKnobsToSession();
    resetState();
    expect(restoreKnobsFromSession()).not.toBeNull();
    // The stash was cleared on the first restore → a later refresh starts clean (no stale carry-over).
    resetState();
    expect(restoreKnobsFromSession()).toBeNull();
  });
});
