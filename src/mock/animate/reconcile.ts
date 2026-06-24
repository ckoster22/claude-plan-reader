// Mock-ANIMATE reconciler — drives the REAL host seams to the FULL projected state at scrub time T.
//
// THE CORE PRINCIPLE (load-bearing): surfaces driven by fire-once events (open_plan, set_comments,
// emitGate, …) have NO inverse — there is no "un-emit". So a backward scrub cannot replay a forward
// delta; it must re-drive each real seam to the WHOLE projected state at T (never an incremental
// forward delta). reconcile(T) therefore:
//   - projects the model SIGNATURE + the SURFACE state at T (both pure fns of (story, T)), then
//   - compares against the last-applied values and re-drives ONLY the seams whose projected value
//     changed (so an unchanged tick is a no-op — no thrash), and
//   - rebuilds un-invertible surfaces FROM SCRATCH (e.g. the reading pane is always renderInto'd from
//     the projected markdown, so comment REMOVAL on rewind is correct: there is no stale highlight to
//     subtract).
//
// SEAMS ARE INJECTED so unit tests drive spies (jsdom) and the player (index.ts) wires the real
// production seams. The reconciler never reaches into the DOM directly (except the conversation
// player pane it owns, via renderConv) and NEVER writes #review-bar or #conversation-stream — it
// drives the input seams and lets main.ts paint.

import type {
  StoryFrame,
  SurfaceState,
} from "./storyboard";
import {
  modelSignature,
  projectSurfaceState,
  projectPulseSet,
  projectCursorState,
  projectFieldText,
  projectModalState,
} from "./storyboard";
import type { ConversationModel } from "../../conversation/stream";
import type { CommentRecord, PlanRecord, ReviewRequest } from "../../types";

// The question card's reconciler-owned "Other" answer UI: the selector of its toggle checkbox and its
// free-text input. The reconciler is the EXCLUSIVE writer of both (sets `.checked` + dispatches change,
// sets the input value) so the answer UI is a pure fn of T and reverts on backward scrub. Derived from
// projectFieldText: an entry for QUESTION_OTHER_TEXT_SELECTOR ⇒ the Other input is being typed into ⇒
// the toggle is checked and the input carries that prefix; no entry ⇒ the whole answer UI is off (null).
export const QUESTION_OTHER_TEXT_SELECTOR = '[data-other="text"]';

// The injected seam surface. Tests pass spies; index.ts passes the real production seams.
export interface ReconcilerSeams {
  // ---- conversation pane (the player-owned model + pane) ----
  // Re-render the conversation from the model scrubbed to T (resets + re-applies the ≤T model-frame
  // SET, then renderTree into the player pane). Called ONLY when modelSignature changes.
  renderConv: (T: number) => void;

  // ---- reading pane ----
  // Read a plan's markdown (the real `invoke("read_plan_contents", { path })`). Async.
  readPlan: (path: string) => Promise<string>;
  // The real render facade: synchronous markdown→HTML into the pane.
  renderInto: (pane: HTMLElement, markdown: string, planDir: string) => void;
  // The real render facade: async settle (images/mermaid).
  settle: (pane: HTMLElement) => Promise<void>;
  // The real comments facade: add-only highlight application onto the freshly-rendered pane.
  applyComments: (pane: HTMLElement, records: CommentRecord[]) => void;
  // The reading-pane element + a fn deriving the plan dir from a path (so the reconciler stays DOM-light).
  readingPane: HTMLElement;
  planDirOf: (path: string) => string;

  // ---- sidebar ----
  // Stash the full plan set the mock list_plans returns, then …
  setPlans: (plans: PlanRecord[]) => void;
  // … emit the plan-changed event so main.ts re-lists the sidebar through its real handler.
  emitPlanChanged: () => void;

  // ---- review bar (NEVER write #review-bar — drive the inputs; main.ts paints) ----
  setPendingReviews: (reviews: ReviewRequest[]) => void;
  emitReviewRequested: (review: ReviewRequest) => void;
  emitReviewCancelled: (reviewId: string) => void;

  // ---- prototype gate ----
  emitGate: (which: "prototype", round?: number) => void;
  clearGate: () => void;

  // ---- active tab (click the real tab button; never un-hide #conversation-stream) ----
  setActiveTab: (tab: "plan" | "conversation") => void;

  // ---- overlay seams (cosmetic; reconciler-owned DOM) --------------------------------------------
  // All overlay seams are OPTIONAL so the player (index.ts) can wire them incrementally (P2) without a
  // typecheck break; the reconciler guards each call. Unit tests inject all of them as spies.
  //
  // Move/press the #demo-cursor overlay. The reconciler resolves selectors→rects against the LIVE DOM
  // and lerps, so it passes PIXELS in (not selectors). `null` ⇒ hide / no known position yet.
  setCursor?: (state: { x: number; y: number; pressing: boolean } | null) => void;
  // Drive the `.demo-pulse` class to EXACTLY this set of selectors (add to the new, remove from the gone).
  setPulseTargets?: (selectors: ReadonlySet<string>) => void;
  // Set a field's value to `prefix` and dispatch a real `input` event (the player owns the DOM write).
  // Called ONLY when that target's prefix changed since the last tick (once per character, not per tick).
  setFieldText?: (selector: string, prefix: string) => void;
  // Drive the composer modal open/closed (reconciler owns `#composer-modal.hidden`).
  setComposerOpen?: (open: boolean) => void;
  // Drive the selection popover (reconciler owns `#sel-popover`): on + its anchor target selector.
  setSelPopover?: (state: { on: boolean; target: string | null }) => void;
  // Drive the prototype trail-card overlay: round 1|2 shows the card, null hides it.
  setProtoCard?: (state: { round: number | null }) => void;
  // Drive the reconciler-owned question-card Other-toggle (`.checked` + dispatched change) + its text
  // input. `null` ⇒ the answer UI is off (toggle unchecked, input empty/hidden).
  setQuestionAnswerUI?: (state: { otherChecked: boolean; otherText: string } | null) => void;
}

// A reconciler instance holds the last-applied model signature + surface so each reconcile(T) re-drives
// ONLY the seams whose projected value changed.
export interface Reconciler {
  reconcile: (T: number) => void;
  // Await the in-flight reading-pane render+settle (read → renderInto → applyComments → settle). Resolves
  // immediately (already-resolved promise) when no async open is in flight. The player wires this into
  // `window.__mockAnim.seekSettled` so a capture/replay caller can await a FULLY-rendered pane before
  // screenshotting (seekTo → paint → reconcileReadingPane kicks off a detached async chain that returns
  // BEFORE the pane finishes rendering — this barrier closes that race). Pure addition: existing callers
  // never call it, so reconcile behavior is unchanged.
  settleBarrier: () => Promise<void>;
}

// Stable JSON of a comment-record array (order-sensitive, which is fine — the projection preserves
// story order). Used as half the reading-pane coupling key.
function commentsKey(comments: CommentRecord[]): string {
  return JSON.stringify(comments);
}

// Stable identity key for the FULL pending-reviews set (by review_id, in order).
function reviewsKey(reviews: ReviewRequest[]): string {
  return JSON.stringify(reviews.map((r) => r.review_id));
}

// Stable identity key for the FULL plan set (by absolute_path, in order).
function plansKey(plans: PlanRecord[]): string {
  return JSON.stringify(plans.map((p) => p.absolute_path));
}

// Create a reconciler over the injected seams + the story. `_model` is documented for symmetry with
// the player wiring (the model lives behind renderConv); the reconciler itself only needs the seams.
export function createReconciler(
  seams: ReconcilerSeams,
  story: ReadonlyArray<StoryFrame>,
  _model?: ConversationModel,
): Reconciler {
  // Last-applied memo state.
  let lastModelSig: string | null = null;
  let lastSurface: SurfaceState | null = null;
  // The reading-pane coupling key = (openPlanPath, JSON(comments)). When EITHER changes the pane is
  // rebuilt from scratch. Held separately so an unchanged tick skips the (async) read entirely.
  let lastReadingKey: string | null = null;
  // Epoch guard: each open-plan render bumps this; an in-flight async read whose epoch is stale aborts
  // its post-await pane mutations so two back-to-back open_plans never let the FIRST plan's settle
  // clobber the SECOND plan's content.
  let openEpoch = 0;
  // The promise of the CURRENT in-flight reading-pane async chain (read → renderInto → applyComments →
  // settle), or null when idle. `settleBarrier()` awaits this so a caller can wait for a fully-rendered
  // pane. It is set BEFORE the IIFE awaits anything and cleared only when the LATEST chain finishes (a
  // superseded chain leaves the field pointing at the newest open). It never rejects (the chain swallows).
  let inFlightSettle: Promise<void> | null = null;

  // ---- overlay-pass memo state ------------------------------------------------------------------
  // Pulse: the sorted-JSON key of the last-applied pulse SET (mirrors plansKey). null ⇒ never applied.
  let lastPulseKey: string | null = null;
  // Fields: the last-applied visible prefix PER target, so setFieldText fires only when a target's
  // prefix CHANGED (once per character on forward scrub; the shorter prefix re-fires on backward scrub).
  const lastFieldText = new Map<string, string>();
  // Composer / popover / proto-card / question-UI: the last-applied projected value (stable JSON keys),
  // so each drives its seam only on change (mirrors reconcileGate). null ⇒ never applied.
  let lastComposerOpen: boolean | null = null;
  let lastPopoverKey: string | null = null;
  let lastProtoRound: number | null | undefined = undefined;
  let lastQuestionKey: string | null = null;
  // Cursor: the last-GOOD resolved position. Held when a target is absent OR resolves to a zero-area
  // rect (e.g. a display:none modal), so the cursor never lerps toward (0,0) — it dwells in place.
  let lastCursorPos: { x: number; y: number } | null = null;

  function reconcileReadingPane(surface: SurfaceState): void {
    const key = `${surface.openPlanPath ?? " null"}|${commentsKey(surface.comments)}`;
    if (key === lastReadingKey) return;
    lastReadingKey = key;

    if (surface.openPlanPath === null) {
      // No plan open — empty the pane (a real renderInto of "" through the facade).
      // Bump the epoch so any in-flight async read aborts (it would otherwise re-fill the pane).
      void ++openEpoch;
      seams.renderInto(seams.readingPane, "", seams.planDirOf(""));
      // Synchronous, fully-settled close: nothing async is pending, so any prior in-flight barrier is
      // now superseded and the pane is in its final empty state. Drop the barrier to idle.
      inFlightSettle = null;
      return;
    }

    const path = surface.openPlanPath;
    const comments = surface.comments;
    const gen = ++openEpoch;
    // Capture the detached async chain into inFlightSettle so settleBarrier() can await it. The chain
    // resolves AFTER renderInto + applyComments + settle for THIS epoch; a superseded chain returns
    // early (the epoch guard) WITHOUT clearing inFlightSettle, so the field always points at the newest
    // open. The latest chain clears it to null on completion.
    const chain = (async () => {
      const md = await seams.readPlan(path);
      // Stale-read guard: a newer open superseded this read — abort BEFORE any pane mutation.
      if (gen !== openEpoch) return;
      seams.renderInto(seams.readingPane, md, seams.planDirOf(path));
      // Rebuild from scratch: applyComments is add-only onto a freshly-rendered pane, so comment
      // REMOVAL on rewind is correct (the prior highlights were wiped by renderInto).
      seams.applyComments(seams.readingPane, comments);
      // Guard again before the (async) settle so a delayed settle from a superseded read can't run.
      if (gen === openEpoch) await seams.settle(seams.readingPane);
      // Only the LATEST chain clears the barrier (a stale chain returned above without touching it).
      if (gen === openEpoch) inFlightSettle = null;
    })();
    inFlightSettle = chain;
  }

  function reconcileSidebar(surface: SurfaceState, prev: SurfaceState | null): void {
    if (prev !== null && plansKey(prev.plans) === plansKey(surface.plans)) return;
    seams.setPlans(surface.plans);
    seams.emitPlanChanged();
  }

  function reconcileReviewBar(surface: SurfaceState, prev: SurfaceState | null): void {
    const prevReviews: ReviewRequest[] = prev?.pendingReviews ?? [];
    if (prev !== null && reviewsKey(prevReviews) === reviewsKey(surface.pendingReviews)) return;
    // Always set the FULL projected set first (so main.ts's count derivation is correct), then fire
    // the per-id requested/cancelled events main.ts's review chain listens for. NEVER write #review-bar.
    seams.setPendingReviews(surface.pendingReviews);
    const prevIds = new Set(prevReviews.map((r) => r.review_id));
    const nextIds = new Set(surface.pendingReviews.map((r) => r.review_id));
    for (const r of surface.pendingReviews) {
      if (!prevIds.has(r.review_id)) seams.emitReviewRequested(r);
    }
    for (const r of prevReviews) {
      if (!nextIds.has(r.review_id)) seams.emitReviewCancelled(r.review_id);
    }
  }

  function reconcileGate(surface: SurfaceState, prev: SurfaceState | null): void {
    const prevGate = prev?.prototypeGate ?? { on: false, round: 1 };
    const next = surface.prototypeGate;
    if (prevGate.on === next.on && prevGate.round === next.round) return;
    if (!prevGate.on && next.on) {
      seams.emitGate("prototype", next.round);
    } else if (prevGate.on && !next.on) {
      seams.clearGate();
    } else {
      // on→on with a changed round: re-emit at the new round (turns the gate ON again, refreshing
      // the bar label) — emitGate is idempotent on the active flag.
      seams.emitGate("prototype", next.round);
    }
  }

  function reconcileActiveTab(surface: SurfaceState, prev: SurfaceState | null): void {
    if (prev !== null && prev.activeTab === surface.activeTab) return;
    seams.setActiveTab(surface.activeTab);
  }

  // ---- overlay passes ---------------------------------------------------------------------------

  // Drive `.demo-pulse` to EXACTLY the projected pulse set. Memoized on a sorted-JSON key (mirrors
  // plansKey) so an unchanged set is a no-op; a changed set re-drives the WHOLE set (the player diffs
  // add/remove against the live DOM). Backward scrub re-derives the set from scratch (pure fn of T).
  function reconcilePulse(T: number): void {
    if (!seams.setPulseTargets) return;
    const set = projectPulseSet(story, T);
    const key = JSON.stringify([...set].sort());
    if (key === lastPulseKey) return;
    lastPulseKey = key;
    seams.setPulseTargets(set);
  }

  // Type into each field: drive setFieldText ONLY when that target's visible prefix CHANGED since the
  // last tick (so the player's dispatched `input` event fires once per character, not every 50ms tick;
  // and a BACKWARD scrub re-fires the SHORTER prefix). Targets that drop out of the projection (e.g. a
  // field_type window not yet reached on rewind) revert to "" once and are then forgotten.
  function reconcileFields(T: number): void {
    if (!seams.setFieldText) return;
    const text = projectFieldText(story, T);
    // Forward + present: drive any target whose prefix changed.
    for (const [sel, prefix] of text) {
      if (lastFieldText.get(sel) === prefix) continue;
      lastFieldText.set(sel, prefix);
      seams.setFieldText(sel, prefix);
    }
    // A target that was typed before but is absent now (rewound before its window) ⇒ clear to "" once.
    for (const sel of [...lastFieldText.keys()]) {
      if (text.has(sel)) continue;
      if (lastFieldText.get(sel) === "") {
        lastFieldText.delete(sel);
        continue;
      }
      lastFieldText.set(sel, "");
      seams.setFieldText(sel, "");
    }
  }

  // Drive the composer modal open/closed only on change (mirrors reconcileGate).
  function reconcileComposer(T: number): void {
    if (!seams.setComposerOpen) return;
    const open = projectModalState(story, T).composer;
    if (open === lastComposerOpen) return;
    lastComposerOpen = open;
    seams.setComposerOpen(open);
  }

  // Drive the selection popover (on + target) only on change.
  function reconcilePopover(T: number): void {
    if (!seams.setSelPopover) return;
    const pop = projectModalState(story, T).popover;
    const key = `${pop.on ? 1 : 0}|${pop.target ?? ""}`;
    if (key === lastPopoverKey) return;
    lastPopoverKey = key;
    seams.setSelPopover(pop);
  }

  // Drive the prototype trail-card overlay. The round is DERIVED from the existing prototype_gate
  // projection (projectSurfaceState.prototypeGate): round 1|2 while the gate is ON, null while OFF. This
  // reuses the gate's pure-in-T projection rather than inventing a second signal. Only on change.
  function reconcileProtoCard(surface: SurfaceState): void {
    if (!seams.setProtoCard) return;
    const round = surface.prototypeGate.on ? surface.prototypeGate.round : null;
    if (round === lastProtoRound) return;
    lastProtoRound = round;
    seams.setProtoCard({ round });
  }

  // Drive the reconciler-owned question-card Other answer UI. DERIVED purely from projectFieldText: an
  // entry for the Other text selector ⇒ the card is being answered via "Other…" (toggle checked + the
  // input carries that prefix); no entry ⇒ the answer UI is off (null). The reconciler RE-ASSERTS this
  // each change (the player sets `.checked`+dispatch change and the input value), so a backward scrub
  // before the field_type window reverts it to null. Only on change.
  function reconcileQuestionUI(T: number): void {
    if (!seams.setQuestionAnswerUI) return;
    const text = projectFieldText(story, T);
    const otherText = text.get(QUESTION_OTHER_TEXT_SELECTOR);
    const state =
      otherText === undefined ? null : { otherChecked: true, otherText };
    const key = state === null ? "off" : `on|${state.otherText}`;
    if (key === lastQuestionKey) return;
    lastQuestionKey = key;
    seams.setQuestionAnswerUI(state);
  }

  // Resolve a selector to its rect CENTER against the LIVE DOM. Returns null when the element is absent
  // OR resolves to a ZERO-AREA rect (width===0 && height===0 — e.g. a display:none / not-yet-shown
  // node returns an all-zeros getBoundingClientRect). Callers HOLD the last-good position on null so the
  // cursor never lerps toward (0,0).
  function resolveCenter(selector: string): { x: number; y: number } | null {
    const elem = document.querySelector(selector);
    if (elem === null) return null;
    const rect = elem.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  // Drive the #demo-cursor overlay. Runs EVERY tick (no signature memo) since rects move as modals open.
  // Resolves fromTarget/toTarget to rect-centers and lerps by t01; on a missing/zero-area endpoint it
  // HOLDS the last-good position (caches it like lastSurface) rather than lerping toward (0,0). With no
  // last-good position yet AND an unresolvable target, it hides the cursor (setCursor(null)).
  function reconcileCursor(T: number): void {
    if (!seams.setCursor) return;
    const cur = projectCursorState(story, T);
    if (cur === null) {
      // Before the first cursor_move: nothing to show.
      seams.setCursor(null);
      return;
    }
    const fromPos = resolveCenter(cur.fromTarget);
    const toPos = resolveCenter(cur.toTarget);

    let pos: { x: number; y: number } | null;
    if (fromPos !== null && toPos !== null) {
      // Both endpoints resolved: lerp by t01.
      pos = {
        x: fromPos.x + (toPos.x - fromPos.x) * cur.t01,
        y: fromPos.y + (toPos.y - fromPos.y) * cur.t01,
      };
    } else if (toPos !== null) {
      // Destination known but origin missing (e.g. first move out of an unshown node): snap to dest.
      pos = toPos;
    } else if (fromPos !== null) {
      // Destination missing (modal not open yet): hold at the known origin rather than lerp to (0,0).
      pos = fromPos;
    } else {
      // Neither resolves: HOLD the last-good position; never lerp toward (0,0).
      pos = lastCursorPos;
    }

    if (pos === null) {
      // No last-good position yet AND nothing resolvable → hide.
      seams.setCursor(null);
      return;
    }
    lastCursorPos = pos;
    seams.setCursor({ x: pos.x, y: pos.y, pressing: cur.pressing });
  }

  function reconcile(T: number): void {
    // ---- conversation: re-render only when the model signature changes ----
    const sig = modelSignature(story, T);
    if (sig !== lastModelSig) {
      lastModelSig = sig;
      seams.renderConv(T);
    }

    // ---- surfaces: project the FULL state at T, drive only the changed seams ----
    const surface = projectSurfaceState(story, T);
    const prev = lastSurface;
    reconcileReadingPane(surface);
    reconcileSidebar(surface, prev);
    reconcileReviewBar(surface, prev);
    reconcileGate(surface, prev);
    reconcileActiveTab(surface, prev);

    // ---- overlays: drive the cosmetic seams. ORDER MATTERS: every pass that may change DOM geometry
    // (composer/popover/proto-card/question-UI) runs BEFORE the cursor, so reconcileCursor reads
    // post-update rects. Pulse + fields are geometry-neutral but kept here for grouping.
    reconcilePulse(T);
    reconcileFields(T);
    reconcileComposer(T);
    reconcilePopover(T);
    reconcileProtoCard(surface);
    reconcileQuestionUI(T);
    // Cursor LAST (runs every tick, no memo) so it reads geometry after the modal/card passes settle.
    reconcileCursor(T);

    lastSurface = surface;
  }

  // Await the in-flight reading-pane chain (or resolve immediately when idle). Wrapped in
  // Promise.resolve so the returned promise is always a fresh, never-rejecting microtask boundary.
  const settleBarrier = (): Promise<void> =>
    inFlightSettle === null ? Promise.resolve() : Promise.resolve(inFlightSettle);

  return { reconcile, settleBarrier };
}
