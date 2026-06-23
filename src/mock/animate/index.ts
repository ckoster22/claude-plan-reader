// Mock-ANIMATE boot + chrome — the injected entry for `npm run mock-animate`.
//
// Boots the UNMODIFIED app frontend (via vite.mock.config.ts's alias seam) and plays ONE short
// fictional "Trailhead" conversation beat INSIDE the real conversation pane, plus the surrounding host
// surfaces (reading pane, sidebar, review bar, prototype gate, active tab) — so it looks like the live
// app. The player activates the Conversation tab (clicking the app's OWN tab button so its real
// switching logic runs), mounts a player-owned container INTO the conversation-stream slot, and pins a
// transport bar (play/pause + draggable progress with chapter markers + speed control) at the bottom.
//
// ARCHITECTURE — PURE projection + FROM-SCRATCH reconciliation: the storyboard is split into MODEL
// frames (applied onto a ConversationModel) and SURFACE frames (open plan / comments / plans / reviews
// / gate). On every tick the player computes the model signature + the projected surface state at the
// scrub time T (both PURE fns of (story, T)) and hands them to the reconciler (reconcile.ts), which
// re-drives ONLY the REAL host seams whose projected value changed, rebuilding un-invertible surfaces
// from scratch (so a backward scrub correctly reverts a fire-once event with no inverse). See
// reconcile.ts for the core principle.
//
// CHOSEN SEAM (load-bearing, preserved from Slice-01): the player owns its OWN ConversationModel and
// its OWN container <div>. It NEVER renders into the production #conversation-stream — that element is
// owned by main.ts and is clobbered by loadHistoryForPlan on every sidebar click, which would wipe our
// animation. Instead the player pane is mounted as a SIBLING of #conversation-stream inside its parent
// (.conv-stream-wrap), sized to fill the same flex slot; the empty real #conversation-stream is hidden
// via a `mockanim-*` namespaced presentation style.
//
// DARK MODE: the app defaults to LIGHT; the demo must render dark deterministically, so at boot we set
// `document.documentElement.dataset.theme = "dark"` — exactly the attribute/value the app's own CSS
// keys on. Presentation set from mock code; no production file is touched.
//
// STYLE ISOLATION: a SINGLE injected <style id="mock-anim-style">; every class is prefixed
// `mockanim-`; the transport bar is position:fixed at z-index 2147483647 so it never participates in
// the app's layout.

import { ConversationModel } from "../../conversation/stream";
import { renderTree } from "../../conversation/render";
import { invoke } from "../core";
import { setPlans, setPendingReviews } from "../state";
import { emitMockEvent } from "../event";
import { emitGate, clearGate, installMockOrchestrator } from "../orchestrator";
import { applyComments, renderInto, settle } from "../../render";
import {
  TRAILHEAD_PROTO_CARD_R1_HTML,
  TRAILHEAD_PROTO_CARD_R2_HTML,
  TRAILHEAD_PROTO_CARD_CSS,
} from "../fixtures/markdown";
import {
  applyUpToTime,
  storyDurationMs,
  TRAILHEAD_BEAT,
  type StoryFrame,
} from "./storyboard";
import { createReconciler } from "./reconcile";
import type { PlanRecord, ReviewRequest } from "../../types";

// ---- namespaced stylesheet -------------------------------------------------------------------

const ANIM_CSS = `
/* The real #conversation-stream stays EMPTY (we never write into it). Hide it so only the
   player-owned pane shows content in the conversation slot. Namespaced to avoid colliding with the
   app's own rules; it only sets display, never touches the production element's content. */
.conv-stream-wrap > #conversation-stream.mockanim-hidden-stream {
  display: none;
}
/* The player-owned pane: a SIBLING of #conversation-stream inside .conv-stream-wrap, filling the same
   flex slot so the beat renders exactly where real conversation content would. Scrolls like the real
   stream; opaque dark background so bubbles stay legible regardless of theme. */
.conv-stream-wrap > .mockanim-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 16px;
  background: #16161a;
  color: #e8e8e8;
}
/* Fallback only: when the real conversation chrome is absent we float the pane as a card so the demo
   still plays (it is appended to <body>, NOT inside .conv-stream-wrap, hence the separate selector). */
.mockanim-pane.mockanim-pane-floating {
  position: fixed;
  right: 24px;
  bottom: 88px;
  width: min(560px, 46vw);
  max-height: 64vh;
  overflow-y: auto;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
  background: #16161a;
  color: #e8e8e8;
}
/* The transport bar — pinned bottom-center over the app, the lone fixed/max-z layer. */
#mock-anim.mockanim-root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#mock-anim .mockanim-controls {
  position: absolute;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(700px, 76vw);
  padding: 9px 14px;
  background: rgba(22, 22, 26, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  color: #e8e8e8;
  pointer-events: auto;
}
#mock-anim .mockanim-play {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
#mock-anim .mockanim-play:hover { background: rgba(255, 255, 255, 0.18); }
/* The draggable progress TRACK — pointerdown/move scrub the scrub time T. Chapter markers are absolute
   children at their tMs/duration; the fill grows from the left. */
#mock-anim .mockanim-progress {
  flex: 1 1 auto;
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.16);
  cursor: pointer;
  touch-action: none;
}
#mock-anim .mockanim-progress-fill {
  height: 100%;
  width: 0%;
  background: #6aa3ff;
  border-radius: 4px;
  pointer-events: none;
}
#mock-anim .mockanim-marker {
  position: absolute;
  top: -3px;
  width: 3px;
  height: 14px;
  margin-left: -1px;
  border-radius: 2px;
  background: #f0c674;
  cursor: pointer;
  pointer-events: auto;
}
#mock-anim .mockanim-marker:hover { background: #ffd98a; }
#mock-anim .mockanim-speed {
  flex: 0 0 auto;
  font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.85;
  min-width: 34px;
  text-align: center;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  cursor: pointer;
}
#mock-anim .mockanim-speed:hover { background: rgba(255, 255, 255, 0.16); }

/* ---- overlay primitives (cosmetic; reconciler-owned) -----------------------------------------
   All scoped to their own ids/classes so they never perturb real app layout. */

/* The simulated cursor: a fixed, max-z arrow overlay positioned via style.transform (translate +
   optional press scale composed in JS). transition smooths the 50ms tick steps. */
#demo-cursor {
  position: fixed;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  z-index: 2147483647;
  pointer-events: none;
  transition: transform 60ms linear;
  will-change: transform;
  background-repeat: no-repeat;
  background-size: contain;
  /* A classic arrow pointer (inline SVG data URL). */
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'><path d='M2 1 L2 17 L6.5 12.8 L9.4 19.2 L12 18 L9.2 11.8 L15 11.6 Z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/></svg>");
}

/* Attention pulse: a glowing outline that breathes while the element carries .demo-pulse. */
@keyframes demo-pulse {
  0% {
    outline-color: rgba(106, 163, 255, 0.0);
    box-shadow: 0 0 0 0 rgba(106, 163, 255, 0.45);
  }
  35% {
    outline-color: rgba(106, 163, 255, 0.95);
    box-shadow: 0 0 0 5px rgba(106, 163, 255, 0.28);
  }
  100% {
    outline-color: rgba(106, 163, 255, 0.0);
    box-shadow: 0 0 0 11px rgba(106, 163, 255, 0.0);
  }
}
.demo-pulse {
  animation: demo-pulse 1.1s ease-out infinite;
  border-radius: 8px;
  outline: 2px solid rgba(106, 163, 255, 0.85);
  outline-offset: 2px;
}

/* The prototype trail-card overlay CHROME: a fixed, max-z card positioned over #reading-pane each tick.
   --tc-scale grows round 1 → round 2 (set by the player per round). The card INTERIOR rules
   (.tc-card/.tc-thumb/.tc-title/.tc-meta/.tc-badge) live in TRAILHEAD_PROTO_CARD_CSS (markdown.ts),
   injected alongside this sheet — cohesive with the player-authored HTML those exports also own. */
#demo-proto-card {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483646;
  pointer-events: none;
  --tc-scale: 1;
  width: calc(260px * var(--tc-scale));
  padding: calc(14px * var(--tc-scale)) calc(16px * var(--tc-scale));
  border-radius: 12px;
  background: #1f2027;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  color: #e8e8e8;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  transition: width 200ms ease, padding 200ms ease;
}
`;

// ---- element helper (mirrors deck.ts's el()) -------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function injectStyle(): void {
  if (document.getElementById("mock-anim-style")) return;
  const style = el("style");
  style.id = "mock-anim-style";
  // The card-interior rules (.tc-card/.tc-thumb/…/.tc-badge) ship with the player-authored card HTML in
  // markdown.ts; append them so the card markup + its styling stay cohesive in one place.
  style.textContent = ANIM_CSS + TRAILHEAD_PROTO_CARD_CSS;
  document.head.appendChild(style);
}

// ---- presentation setup (dark mode + real conversation tab) ----------------------------------

// Force the app into DARK mode deterministically (the exact attribute/value the app's CSS keys on).
function forceDarkTheme(): void {
  document.documentElement.dataset.theme = "dark";
}

// Click the real tab button for `tab` so main.ts's initTabs switching logic runs (it toggles `.active`
// on the matching `.tab-pane`, and main.ts's conversation-tab click listener repaints the minimap).
// The click path is PREFERRED (it runs main.ts's real switching logic). But the click is a no-op if
// initTabs hasn't wired its listener yet (a boot-order race) — so we fall back to toggling the `.active`
// classes directly both when the button is ABSENT and when the click left the tab inactive. This mirrors
// exactly what initTabs itself does (toggle `.active` on the app's own `.tab`/`.tab-pane` elements);
// it NEVER un-hides #conversation-stream and NEVER removes `mockanim-hidden-stream`.
function clickTab(tab: "plan" | "conversation"): HTMLElement | null {
  const tabBtn = document.querySelector<HTMLElement>(`.reader-tab-row .tab[data-tab="${tab}"]`);
  const pane = document.getElementById(`tab-${tab}`);
  if (tabBtn) tabBtn.click();
  // Fallback: button absent, OR the click had no effect (no listener yet → still inactive). Toggle the
  // `.active` classes directly the way initTabs does, so activation is robust regardless of boot timing.
  if (!tabBtn || !tabBtn.classList.contains("active")) {
    const row =
      tabBtn?.closest(".reader-tab-row") ??
      pane?.closest(".reader-inner")?.querySelector(".reader-tab-row") ??
      null;
    if (row) {
      for (const t of Array.from(row.querySelectorAll<HTMLElement>(".tab"))) {
        t.classList.toggle("active", t.dataset.tab === tab);
      }
    }
    document.getElementById("tab-plan")?.classList.toggle("active", tab === "plan");
    document.getElementById("tab-conversation")?.classList.toggle("active", tab === "conversation");
  }
  return pane;
}

// Derive a plan's directory from its absolute path (mirrors main.ts's dirOf). "" → "".
function planDirOf(path: string): string {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : path;
}

// ---- playback timing -------------------------------------------------------------------------

// The wall-clock tick interval; T advances by `TICK_MS × SPEED` each tick.
const TICK_MS = 50;
// The cycle of playback speeds the speed control rotates through.
const SPEEDS = [0.5, 1, 2, 4, 8] as const;

// ---- player ----------------------------------------------------------------------------------

function mountPlayer(): void {
  // Idempotent: never mount twice (e.g. an HMR re-run).
  if (document.getElementById("mock-anim")) return;
  injectStyle();

  // Presentation: render the demo dark.
  forceDarkTheme();

  const story: StoryFrame[] = TRAILHEAD_BEAT;
  const duration = storyDurationMs(story);

  // The player owns its OWN model + container — never #conversation-stream.
  const model = new ConversationModel();

  // ---- player-owned pane: mounted INTO the real conversation slot ----
  const pane = el("div", "mockanim-pane");
  const stream = document.getElementById("conversation-stream");
  const wrap = stream?.parentElement ?? null;
  if (wrap) {
    stream?.classList.add("mockanim-hidden-stream");
    wrap.insertBefore(pane, stream?.nextSibling ?? null);
  } else {
    pane.classList.add("mockanim-pane-floating");
    document.body.appendChild(pane);
  }

  // The reading pane (the production render target). May be absent in a stripped DOM (fallback null).
  const readingPane =
    document.getElementById("reading-pane") ?? document.createElement("div");

  // ---- overlay nodes: created ONCE, appended to the max-z player root layer ----
  // (Defined below; the root is built after the reconciler. We append them to <body> here so they
  // exist before the first paint; they sit at the same max-z as the transport chrome.)
  const cursorNode = el("div");
  cursorNode.id = "demo-cursor";
  cursorNode.style.display = "none";
  document.body.appendChild(cursorNode);

  const protoCard = el("div");
  protoCard.id = "demo-proto-card";
  protoCard.style.display = "none";
  document.body.appendChild(protoCard);

  // The set of elements currently carrying `.demo-pulse` (so a changed pulse set removes from the gone
  // and adds to the new). Held across reconcile passes — the player is the single writer of the class.
  const pulsedEls = new Set<HTMLElement>();

  // ---- overlay seam implementations -------------------------------------------------------------

  // Move/press the cursor. Position IS a transform (translate); compose the press scale in JS so a
  // single transform carries both (a class alone cannot encode the live x/y).
  const setCursor = (state: { x: number; y: number; pressing: boolean } | null): void => {
    if (state === null) {
      cursorNode.style.display = "none";
      return;
    }
    cursorNode.style.display = "block";
    const scale = state.pressing ? " scale(0.82)" : "";
    cursorNode.style.transform = `translate(${state.x}px, ${state.y}px)${scale}`;
  };

  // Drive `.demo-pulse` to EXACTLY the projected selector set: remove from elements no longer targeted,
  // add to elements matching the new selectors. A missing selector is a no-op (no match → nothing added).
  const setPulseTargets = (selectors: ReadonlySet<string>): void => {
    const next = new Set<HTMLElement>();
    for (const sel of selectors) {
      for (const m of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        next.add(m);
      }
    }
    // Remove from elements that fell out of the set.
    for (const elPrev of pulsedEls) {
      if (!next.has(elPrev)) elPrev.classList.remove("demo-pulse");
    }
    // Add to the new set.
    for (const elNext of next) elNext.classList.add("demo-pulse");
    pulsedEls.clear();
    for (const elNext of next) pulsedEls.add(elNext);
  };

  // Re-apply the LAST projected pulse set to the live DOM (after a conv rebuild wiped classes on conv
  // nodes). Reads the same source of truth — `pulsedEls` is rebuilt from scratch by setPulseTargets,
  // so we re-derive from the selectors the reconciler last passed. We cache that selector set here.
  let lastPulseSelectors: ReadonlySet<string> = new Set();
  const setPulseTargetsTracked = (selectors: ReadonlySet<string>): void => {
    lastPulseSelectors = selectors;
    setPulseTargets(selectors);
  };

  // Type into a real field: set .value to the prefix and dispatch a real `input` event (so the app's
  // own input listeners — composer error-clear, #review-submit enable — fire faithfully).
  const setFieldText = (selector: string, prefix: string): void => {
    const field = document.querySelector(selector) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!field) return;
    field.value = prefix;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // Drive the composer modal open/closed. The reconciler is the EXCLUSIVE writer of `.hidden` during
  // the demo (cursor clicks are cosmetic; the real #new-plan-btn is never triggered), so toggling the
  // class directly cannot desync any second writer.
  const setComposerOpen = (open: boolean): void => {
    const modal = document.getElementById("composer-modal");
    if (!modal) return;
    modal.classList.toggle("hidden", !open);
  };

  // Drive the selection popover (reconciler exclusive writer). On: show #sel-popover, set #sp-quote
  // from the target block's text, position it under the target block's rect. Off: hide it. No real
  // selection events are dispatched.
  const setSelPopover = (state: { on: boolean; target: string | null }): void => {
    const popover = document.getElementById("sel-popover");
    if (!popover) return;
    if (!state.on || state.target === null) {
      popover.classList.add("hidden");
      return;
    }
    const block = document.querySelector(state.target);
    if (block === null) {
      popover.classList.add("hidden");
      return;
    }
    const quote = document.getElementById("sp-quote");
    if (quote) quote.textContent = (block.textContent ?? "").trim();
    popover.classList.remove("hidden");
    const rect = block.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.bottom + 6}px`;
  };

  // Drive the prototype trail-card overlay. null → hide. Otherwise inject the player-authored card HTML
  // (TRAILHEAD_PROTO_CARD_R1/R2_HTML from markdown.ts — SAFE, not user content) and bump --tc-scale so
  // round 2 is visibly LARGER; round 2's HTML also carries the difficulty badge (.tc-badge). Position it
  // over #reading-pane by reading that pane's rect EACH call (the pane scrolls).
  const setProtoCard = (state: { round: number | null }): void => {
    if (state.round === null) {
      protoCard.style.display = "none";
      return;
    }
    const round = state.round;
    // Round 2+ : larger card + difficulty badge. Round 1: the clean base card.
    protoCard.style.setProperty("--tc-scale", round >= 2 ? "1.3" : "1");
    protoCard.innerHTML = round >= 2 ? TRAILHEAD_PROTO_CARD_R2_HTML : TRAILHEAD_PROTO_CARD_R1_HTML;
    protoCard.style.display = "block";
    // Reposition over #reading-pane each call (the reconciler calls this every tick; the pane scrolls).
    const paneRect = readingPane.getBoundingClientRect();
    if (paneRect.width > 0 || paneRect.height > 0) {
      protoCard.style.left = `${paneRect.left + 24}px`;
      protoCard.style.top = `${paneRect.top + 24}px`;
    }
  };

  // Drive the reconciler-owned question-card Other answer UI. Non-null: check the toggle + dispatch a
  // real `change` (so the card's refresh() un-hides the Other input) and set the text input value (+
  // dispatch input). null: leave as-is (the reconciler only calls on change; backward scrub re-asserts).
  // Idempotent: only dispatch when the value actually changes.
  const setQuestionAnswerUI = (
    state: { otherChecked: boolean; otherText: string } | null,
  ): void => {
    const card = document.querySelector(".conv-question");
    if (!card) return;
    const toggle = card.querySelector('[data-other="toggle"]') as HTMLInputElement | null;
    const textInput = card.querySelector('[data-other="text"]') as HTMLInputElement | null;
    if (state === null) {
      if (toggle && toggle.checked) {
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    if (toggle && toggle.checked !== state.otherChecked) {
      toggle.checked = state.otherChecked;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (textInput && textInput.value !== state.otherText) {
      textInput.value = state.otherText;
      textInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  // ---- the reconciler: wired to the REAL host seams ----
  const reconciler = createReconciler(
    {
      // Conversation: re-apply the model to T (token reveal included) + renderTree into the player pane.
      renderConv: (T: number): void => {
        applyUpToTime(model, story, T);
        renderTree(pane, model.derive());
        // renderTree does replaceChildren (no scroll handling); the long Execution conversation would
        // render with the finale below the fold. Pin to the bottom so the latest bubbles stay visible.
        pane.scrollTop = pane.scrollHeight;
        // SAME-PASS PULSE RE-APPLY (anti-strobe): replaceChildren above wiped `.demo-pulse` on the conv
        // nodes. During a revealMs window the pulse SET is unchanged, so the memoized reconcilePulse
        // pass would NOT re-apply it — a separate post-pass would strobe at 20Hz. Re-apply the LAST
        // projected pulse selectors here, in the SAME paint pass, immediately after the conv rebuild.
        setPulseTargetsTracked(lastPulseSelectors);
      },
      // Reading pane: the real read_plan_contents + render facade.
      readPlan: (path: string) => invoke<string>("read_plan_contents", { path }),
      renderInto,
      settle,
      applyComments,
      readingPane,
      planDirOf,
      // Sidebar: stash the full plan set + emit plan-changed so main.ts re-lists through its real handler.
      setPlans: (plans: PlanRecord[]): void => setPlans(plans),
      emitPlanChanged: (): void => emitMockEvent("plan-changed", { path: "/Users/mock/.claude/plans/unread-standalone.md" }),
      // Review bar: drive the input seams; NEVER write #review-bar — main.ts paints it.
      setPendingReviews: (reviews: ReviewRequest[]): void => setPendingReviews(reviews),
      emitReviewRequested: (r: ReviewRequest): void =>
        emitMockEvent("plan-review-requested", {
          review_id: r.review_id,
          plan_text: r.plan_text,
          plan_file_path: r.plan_file_path,
          created_ms: r.created_ms,
        }),
      emitReviewCancelled: (reviewId: string): void =>
        emitMockEvent("plan-review-cancelled", { review_id: reviewId }),
      // Prototype gate: the fake orchestrator seam.
      emitGate: (_which: "prototype", round?: number): void => emitGate("prototype", round),
      clearGate,
      // Active tab: click the real tab button (never un-hide #conversation-stream).
      setActiveTab: (tab: "plan" | "conversation"): void => {
        clickTab(tab);
      },
      // ---- overlay seams (cosmetic; reconciler-owned DOM) ----
      setCursor,
      // Use the tracked variant so the LAST projected pulse selectors are cached for the same-pass
      // re-apply inside renderConv (anti-strobe).
      setPulseTargets: setPulseTargetsTracked,
      setFieldText,
      setComposerOpen,
      setSelPopover,
      setProtoCard,
      setQuestionAnswerUI,
    },
    story,
    model,
  );

  // ---- transport bar: the only fixed/max-z layer ----
  const root = el("div", "mockanim-root");
  root.id = "mock-anim";

  const controls = el("div", "mockanim-controls");
  const playBtn = el("button", "mockanim-play", "▶");
  playBtn.type = "button";
  const progress = el("div", "mockanim-progress");
  const fill = el("div", "mockanim-progress-fill");
  progress.appendChild(fill);

  // Chapter markers: one per frame carrying a chapterLabel, positioned at tMs/duration, click-to-jump.
  for (const sf of story) {
    if (!sf.chapterLabel) continue;
    const marker = el("div", "mockanim-marker");
    marker.style.left = duration > 0 ? `${(sf.tMs / duration) * 100}%` : "0%";
    marker.title = sf.chapterLabel;
    marker.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // don't also start a track drag
      seekTo(sf.tMs);
    });
    progress.appendChild(marker);
  }

  const speedBtn = el("div", "mockanim-speed", "1×");
  controls.appendChild(playBtn);
  controls.appendChild(progress);
  controls.appendChild(speedBtn);
  root.appendChild(controls);

  document.body.appendChild(root);

  // ---- playback state ----
  let T = 0;
  let playing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let speedIdx = 1; // start at 1×

  const speed = (): number => SPEEDS[speedIdx];

  // Single paint: reconcile the host seams to T + update the transport fill.
  const paint = (): void => {
    reconciler.reconcile(T);
    const pct = duration > 0 ? Math.min(100, (T / duration) * 100) : 100;
    fill.style.width = `${pct}%`;
  };

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    playing = false;
    playBtn.textContent = "▶";
  };

  // Seek to an absolute T (clamped), pause, repaint. Used by the progress drag + chapter markers.
  const seekTo = (next: number): void => {
    T = Math.max(0, Math.min(duration, next));
    stop();
    paint();
  };

  const tick = (): void => {
    T += TICK_MS * speed();
    if (T >= duration) {
      T = duration;
      paint();
      stop(); // clamp + stop at the end of the story
      return;
    }
    paint();
  };

  const play = (): void => {
    if (playing) return;
    if (T >= duration) T = 0; // restart from the beginning if parked at the end
    playing = true;
    playBtn.textContent = "❚❚";
    timer = setInterval(tick, TICK_MS);
  };

  playBtn.addEventListener("click", () => {
    if (playing) stop();
    else play();
  });

  // ---- draggable progress track: pointerdown/move/up → scrub T ----
  const tFromPointer = (clientX: number): number => {
    const rect = progress.getBoundingClientRect();
    const width = rect.width || 1;
    const x = Math.max(0, Math.min(width, clientX - rect.left));
    return duration > 0 ? (x / width) * duration : 0;
  };
  let dragging = false;
  progress.addEventListener("pointerdown", (e) => {
    dragging = true;
    progress.setPointerCapture?.(e.pointerId);
    seekTo(tFromPointer(e.clientX));
  });
  progress.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    seekTo(tFromPointer(e.clientX));
  });
  const endDrag = (): void => {
    dragging = false;
  };
  progress.addEventListener("pointerup", endDrag);
  progress.addEventListener("pointercancel", endDrag);

  // ---- speed control: cycle 0.5×/1×/2×/4×/8× ----
  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    speedBtn.textContent = `${speed()}×`;
  });

  // Initial paint at T=0 (the opening frame), paused. The reconciler will activate the Conversation
  // tab (no plan open at T=0 → activeTab "conversation").
  //
  // DEFERRED to a macrotask (mirrors deck.ts's `setTimeout(applyDefaultOnReady, 0)`): this script loads
  // after main.ts's deferred bundle, so at module-eval `document.readyState` is "interactive" and
  // main.ts's DOMContentLoaded handler (which calls initTabs to wire the reader tab buttons) has NOT run
  // yet. Painting synchronously here would land `setActiveTab("conversation")` → clickTab → tabBtn.click()
  // on a button with no listener, so #tab-conversation would stay display:none and the player pane —
  // nested inside it — would be invisible. The chrome + transport handlers were wired synchronously
  // above; only the FIRST reconcile/paint is deferred so it runs AFTER initTabs has attached its
  // listeners. (clickTab's direct-toggle fallback also covers any residual timing slip.)
  setTimeout(paint, 0);
}

// Install the FAKE orchestrator as the orchestrator singleton FIRST — BEFORE main.ts's
// DOMContentLoaded wiring calls getOrchestrator().subscribe(...). This module evaluates at mock boot
// (after main.ts's module body, which only registers a DOMContentLoaded listener), so the singleton is
// installed before that handler runs. WITHOUT this, main.ts subscribes to the REAL orchestrator while
// the reconciler's emitGate/clearGate fan to the fake handle nobody subscribed to — so the prototype
// gate (Slice 04) and review (Slice 06) animation would silently no-op. deck.ts does the same; the
// animate path omitted it because deck.ts is excluded when MOCK_ANIMATE=1. Only the orchestrator is
// needed here: the reconciler drives setPlans/setPendingReviews/emitMockEvent/emitGate/clearGate
// DIRECTLY (not via window.__mock), so installMockApi() (the window.__mock hook) is NOT required.
installMockOrchestrator();

// DOM-ready boot guard (mirrors deck.ts): this script loads after main.ts's deferred bundle, so
// DOMContentLoaded may have already fired.
function boot(): void {
  mountPlayer();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
