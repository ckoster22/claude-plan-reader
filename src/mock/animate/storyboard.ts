// Mock-ANIMATE storyboard — the PURE, frame-timed driver of a fictional "Trailhead" conversation
// beat PLUS the surrounding host SURFACES (reading pane, sidebar, review bar, prototype gate, active
// tab). NO DOM. Two disjoint frame families:
//
//   ModelFrame  — applied DIRECTLY onto a ConversationModel via its real append* methods (so the
//                 derived tree, and the live renderTree, is identical to production).
//   SurfaceFrame — describes a host surface's value at a point in time (open plan, comments, plans,
//                 pending reviews, prototype gate). These are NOT applied to the model; the player's
//                 reconciler (reconcile.ts) projects them with `projectSurfaceState` and drives the
//                 REAL host seam to the FULL projected state at T.
//
// WHY THE SPLIT (load-bearing): surfaces driven by fire-once events (open_plan, set_comments,
// emitGate, …) have NO inverse — you cannot "un-emit" a comment. So a backward scrub cannot replay a
// forward delta; it must re-drive the real seam to the WHOLE projected state at T. ModelFrames, by
// contrast, are pure-replayable: `applyUpToTime` rebuilds the model from scratch (reset + re-apply the
// ≤T frame SET), so rewinding drops later frames cleanly. The surface projection is the analogous
// from-scratch rebuild for the un-invertible surfaces: `projectSurfaceState` is a pure fn of (story, T).
//
// SEQ POLICY (load-bearing): storyboard frame `seq` values use 1..N — small, dense, contiguous. The
// existing live player (src/mock/player.ts applySceneToModel) stamps SYNTHETIC terminal events
// (agent-error / agent-exit, which carry no wire seq) at a reserved high base of 1e9 so they always
// sort AFTER every wire frame. Any future synthetic terminal event this storyboard adds MUST use that
// same reserved high base (>= 1e9), never a value inside the 1..N range, so it can never interleave
// ahead of a real frame.
//
// QUESTION INVARIANT (load-bearing): a `question_request` ModelFrame and its `question_answered`
// ModelFrame MUST satisfy BOTH `request.seq < answer.seq` AND `request.tMs <= answer.tMs`. The seq
// ordering is what makes derive() fold the answer onto the request (and clear the
// pendingInteractiveId hold) instead of leaving a stuck "Waiting for your input…" indicator; the tMs
// ordering is what makes a mid-scrub T between the two show the OPEN form (request shown, answer not
// yet applied) rather than skipping straight to the answered record.

import type { ConversationModel } from "../../conversation/stream";
import type { AgentStream, ToolPermissionRequested, AskUserQuestionAnswers } from "../../conversation/types";
import type { PlanRecord, CommentRecord, ReviewRequest } from "../../types";
import { clonePlans } from "../fixtures/plans";
import { PROTO_PREVIEW_PATH } from "../fixtures/markdown";
import { TRAILHEAD_PLANS, TRAILHEAD_MASTER_PATH, TRAILHEAD_MASTER_V2_PATH } from "../fixtures/trailhead-plan";

// The conversation frames a storyboard can drive directly through the model's appendStream(). We
// play text + the tool_use/tool_result pair, the `subagent_started` label frame, PLUS the terminal
// `result` frame that ends the turn.
// The `result` kind is load-bearing for the finished-thought invariant: production derive()
// is the ONLY agent-stream kind that sets `complete = true` and clears `active`/`latestStatusLabel`,
// so without it the derived `working` indicator never resolves and the beat pulses "Working…" forever.
// `subagent_started` is included so a subagent group can be LABELED (group header reads "scope-recon")
// rather than rendering as an anonymous box. It is an existing AgentStream kind that appendStream
// already handles (derive()'s `case "subagent_started"` seeds the group metadata) — widening this
// Extract drives it through the SAME appendStream path as every other conv frame, NOT a new engine
// method. derive() turns it into NO timeline node directly: it seeds/annotates the subagent group.
export type ConvFrame = Extract<
  AgentStream,
  { kind: "assistant_text" | "tool_use" | "tool_result" | "subagent_started" | "result" }
>;

// ---- ModelFrame variants -----------------------------------------------------------------------
//
// Every ModelFrame applies DIRECTLY onto the ConversationModel through one of its real append*
// methods. The exhaustive switch in applyModelFrame keeps every variant honest.
export type ModelFrame =
  // The original conversation stream variant — appended via appendStream(). `revealMs`, when present,
  // turns this into a token-reveal frame: while `tMs <= T < tMs + revealMs` the player appends a
  // PREFIX of the text (a pure fn of T); past that window it appends the full text. Only meaningful
  // for `assistant_text` (the only kind whose text streams); ignored for the others.
  | { t: "conv"; ev: ConvFrame; revealMs?: number }
  // A tool-permission-requested marker — appended via appendPermissionRequest(). For an
  // AskUserQuestion request this derives a question_request node (the input card).
  | { t: "question_request"; ev: ToolPermissionRequested }
  // The user submitted answers for the AskUserQuestion request `id` — appended via
  // appendQuestionAnswered(id, answers, seq). Folds onto the matching question_request node on derive.
  | { t: "question_answered"; id: string; answers: AskUserQuestionAnswers; seq: number }
  // A verbatim user-message echo at an explicit seq — appended via appendUserMessageAt(text, seq).
  | { t: "user_message"; text: string; seq: number }
  // A verbatim system-message echo at an explicit seq — appended via appendSystemMessageAt(text, seq).
  | { t: "system_message"; text: string; seq: number }
  // The held permission `id` was resolved (allow/deny) — appended via appendPermissionResolved(id, seq).
  | { t: "permission_resolved"; id: string; seq: number };

// ---- SurfaceFrame variants ---------------------------------------------------------------------
//
// SurfaceFrames are NEVER applied to the model (applyModelFrame treats them as no-ops). They are
// projected by projectSurfaceState and reconciled onto the real host seam.
export type SurfaceFrame =
  // Open a plan in the reading pane (path) OR close it (path: null → empty pane).
  | { t: "open_plan"; path: string | null }
  // The FULL sidebar plan set at this point (REQUIRED full set, not a delta — projection takes the
  // last-≤-T value, falling back to the fixture seed before any plan_changed frame).
  | { t: "plan_changed"; plans: PlanRecord[] }
  // The comments for `path` at this point (full set for that path).
  | { t: "set_comments"; path: string; comments: CommentRecord[] }
  // The FULL pending-reviews set at this point.
  | { t: "pending_reviews"; reviews: ReviewRequest[] }
  // The prototype gate state: on/off (+ optional round 1..3 when on).
  | { t: "prototype_gate"; on: boolean; round?: number };

// ---- OverlayFrame variants ---------------------------------------------------------------------
//
// OverlayFrames are NEVER applied to the model (applyModelFrame treats them as no-ops, exactly like
// SurfaceFrames) AND they are excluded from the model signature (an overlay frame entering the ≤T set
// must NOT re-render the conversation pane — it drives a cosmetic overlay seam, not conv content).
// Each is a PURE function of T projected by one of the projections below (projectPulseSet,
// projectCursorState, projectFieldText, projectModalState) and reconciled onto a real overlay seam.
//
// The cursor is COSMETIC: cursor_move/cursor_click drive a `#demo-cursor` overlay; they NEVER dispatch
// a real DOM click. `pulse` is an attention glow over matching elements while fromMs <= T < toMs.
// `field_type` types a growing prefix into a real input/textarea. `overlay_modal` drives a real
// modal/popover open/closed as a pure last-≤-T fn of T per `kind`.
export type OverlayFrame =
  | { t: "cursor_move"; target: string; moveMs: number }
  | { t: "cursor_click"; target: string; pressMs?: number }
  | { t: "pulse"; target: string; fromMs: number; toMs: number }
  | { t: "field_type"; target: string; text: string; fromMs: number; toMs: number }
  | { t: "overlay_modal"; kind: "composer" | "popover"; on: boolean; target?: string }
  // A scroll-timeline window: lerp the scroll-container `target`'s scrollTop FRACTION (0..1 of its
  // max scroll range) from `fromFrac` → `toFrac` over [fromMs, toMs). `target` is a SCROLL CONTAINER
  // selector (e.g. `#reader-scroll`, the `.reader` element with overflow-y:auto), NOT the inner
  // content div (`#reading-pane`/`.md` has no overflow — setting its scrollTop is a silent no-op).
  // Projected by projectScroll (last-active window, lerped) and reconciled by the setScroll seam,
  // which resolves the fraction to pixels (frac * (scrollHeight - clientHeight)) against the live DOM.
  | { t: "scroll"; target: string; fromFrac: number; toFrac: number; fromMs: number; toMs: number }
  // (c4) The SIDEBAR tab (Plans / Contents) shown at this point. A real, deterministic surface (the
  // c4 navigation choreography clicks the Contents tab to reveal the plan's ToC, then restores Plans
  // before commenting). Projected by projectSidebarTab (last-≤-T, default "plans") and reconciled by
  // the setSidebarTab seam, which clicks the real `.tab-row .tab[data-tab=…]` so main.ts's initTabs
  // switching logic runs (toggles `.active` on `#tab-plans` / `#tab-contents`). Distinct from the
  // READER tab (Plan / Conversation) `activeTab`, which is structural (open-plan ⇒ Plan).
  | { t: "sidebar_tab"; tab: "plans" | "contents" };

// The unified storyboard frame envelope.
export type Frame = ModelFrame | SurfaceFrame | OverlayFrame;

// The discriminator values that belong to the SURFACE family — every other `t` is a ModelFrame.
const SURFACE_KINDS = new Set<Frame["t"]>([
  "open_plan",
  "plan_changed",
  "set_comments",
  "pending_reviews",
  "prototype_gate",
]);

// The discriminator values that belong to the OVERLAY family (mirrors SURFACE_KINDS). Overlay frames
// are model no-ops AND signature-excluded — they drive cosmetic overlay seams, never conv content.
const OVERLAY_KINDS = new Set<Frame["t"]>([
  "cursor_move",
  "cursor_click",
  "pulse",
  "field_type",
  "overlay_modal",
  "scroll",
  "sidebar_tab",
]);

// Is this a SurfaceFrame (vs a ModelFrame)?
export function isSurfaceFrame(frame: Frame): frame is SurfaceFrame {
  return SURFACE_KINDS.has(frame.t);
}

// Is this an OverlayFrame (vs a ModelFrame or SurfaceFrame)?
export function isOverlayFrame(frame: Frame): frame is OverlayFrame {
  return OVERLAY_KINDS.has(frame.t);
}

// One timed storyboard entry: reveal `frame` once the scrub time reaches `tMs`. `chapterLabel` is an
// optional human label for the chapter this frame opens (the transport's chapter markers list).
export interface StoryFrame {
  tMs: number;
  frame: Frame;
  chapterLabel?: string;
}

// Clamp x into [0, 1].
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Apply a single MODEL frame onto the model at scrub time T. SurfaceFrames are model no-ops (handled
// by projectSurfaceState/reconcile, never the model). The switch is exhaustive over Frame's `t`
// discriminator so adding a new envelope variant is a compile error until handled here.
//
// `tMs` (the frame's reveal time) + `T` (the scrub time) drive token reveal for assistant_text
// conv frames carrying `revealMs`: a single in-progress frame (tMs <= T < tMs + revealMs) appends a
// sliced prefix (same seq); a fully-past frame appends the full text. Pure fn of T.
export function applyModelFrame(
  model: ConversationModel,
  frame: Frame,
  tMs: number,
  T: number,
): void {
  switch (frame.t) {
    case "conv": {
      const ev = frame.ev;
      // Token reveal: only assistant_text with a revealMs window streams a prefix.
      if (ev.kind === "assistant_text" && frame.revealMs && frame.revealMs > 0 && T < tMs + frame.revealMs) {
        const fraction = clamp01((T - tMs) / frame.revealMs);
        const cut = Math.floor(fraction * ev.text.length);
        model.appendStream({ ...ev, text: ev.text.slice(0, cut) });
        break;
      }
      model.appendStream(ev);
      break;
    }
    case "question_request":
      model.appendPermissionRequest(frame.ev);
      break;
    case "question_answered":
      model.appendQuestionAnswered(frame.id, frame.answers, frame.seq);
      break;
    case "user_message":
      model.appendUserMessageAt(frame.text, frame.seq);
      break;
    case "system_message":
      model.appendSystemMessageAt(frame.text, frame.seq);
      break;
    case "permission_resolved":
      model.appendPermissionResolved(frame.id, frame.seq);
      break;
    // SurfaceFrames are model no-ops — projected by projectSurfaceState, never applied here.
    case "open_plan":
    case "plan_changed":
    case "set_comments":
    case "pending_reviews":
    case "prototype_gate":
      break;
    // OverlayFrames are model no-ops too — projected by projectPulseSet/projectCursorState/
    // projectFieldText/projectModalState and reconciled onto cosmetic overlay seams, never the model.
    case "cursor_move":
    case "cursor_click":
    case "pulse":
    case "field_type":
    case "overlay_modal":
    case "scroll":
    case "sidebar_tab":
      break;
    default: {
      // Exhaustiveness guard — a new Frame variant must add a case above.
      const _exhaustive: never = frame;
      void _exhaustive;
    }
  }
}

// Back-compat alias: the original entry point name some call sites/tests use.
export function applyFrame(model: ConversationModel, frame: Frame): void {
  // Without timing context, apply at the frame's own reveal time (no reveal window).
  applyModelFrame(model, frame, 0, Number.POSITIVE_INFINITY);
}

// Rebuild the model to reflect the story scrubbed to time `T`: reset to empty, then re-apply every
// MODEL frame whose tMs <= T in story order, passing T so the single in-progress token-reveal frame
// streams a prefix. Resetting first is what makes this IDEMPOTENT (re-applying at the same T does not
// double frames) and SCRUBBABLE (rewinding drops later frames cleanly). SurfaceFrames are skipped
// here (they never touch the model). derive() orders by seq, so the iteration order only feeds the
// right frame SET — the derived tree is seq-ordered regardless.
export function applyUpToTime(
  model: ConversationModel,
  story: ReadonlyArray<StoryFrame>,
  T: number,
): void {
  model.reset();
  for (const sf of story) {
    if (sf.tMs <= T) applyModelFrame(model, sf.frame, sf.tMs, T);
  }
}

// The total story length in milliseconds: the max `tMs` across all frames (0 for an empty story).
export function storyDurationMs(story: ReadonlyArray<StoryFrame>): number {
  let max = 0;
  for (const sf of story) if (sf.tMs > max) max = sf.tMs;
  return max;
}

// ---- Surface projection (PURE fn of T) ---------------------------------------------------------

// The host SURFACE state projected at scrub time T. Every field is the last-≤-T SurfaceFrame value;
// `plans` falls back to the fixture seed before any plan_changed frame; `activeTab` is "plan" iff a
// plan is open, else "conversation".
export interface SurfaceState {
  openPlanPath: string | null;
  comments: CommentRecord[];
  plans: PlanRecord[];
  pendingReviews: ReviewRequest[];
  prototypeGate: { on: boolean; round: number };
  activeTab: "plan" | "conversation";
}

// PURE: project the host surface state at scrub time T. Each surface is the LAST frame of its kind
// with tMs <= T (story order = emission order). Comments are scoped to the currently-open plan path
// (a set_comments for a different path does not paint the open plan). plans falls back to the fixture
// seed. activeTab = "plan" iff a plan is open (a non-null open_plan), else "conversation".
export function projectSurfaceState(story: ReadonlyArray<StoryFrame>, T: number): SurfaceState {
  let openPlanPath: string | null = null;
  let openPlanSet = false;
  let plans: PlanRecord[] | null = null;
  let pendingReviews: ReviewRequest[] = [];
  let prototypeGate: { on: boolean; round: number } = { on: false, round: 1 };
  // Comments keyed by path so the open-plan's comments are the last set_comments for THAT path.
  const commentsByPath = new Map<string, CommentRecord[]>();

  for (const sf of story) {
    if (sf.tMs > T) continue;
    const frame = sf.frame;
    switch (frame.t) {
      case "open_plan":
        openPlanPath = frame.path;
        openPlanSet = true;
        break;
      case "plan_changed":
        plans = frame.plans;
        break;
      case "set_comments":
        commentsByPath.set(frame.path, frame.comments);
        break;
      case "pending_reviews":
        pendingReviews = frame.reviews;
        break;
      case "prototype_gate":
        prototypeGate = {
          on: frame.on,
          round: Math.min(3, Math.max(1, Math.floor(frame.round ?? 1))),
        };
        break;
      // ModelFrames contribute nothing to the surface projection.
      default:
        break;
    }
  }

  const comments = openPlanPath !== null ? (commentsByPath.get(openPlanPath) ?? []) : [];
  return {
    openPlanPath: openPlanSet ? openPlanPath : null,
    comments,
    plans: plans ?? clonePlans(),
    pendingReviews,
    prototypeGate,
    // activeTab is structural: a plan is open ⇒ Plan tab, else Conversation tab.
    activeTab: openPlanPath !== null ? "plan" : "conversation",
  };
}

// ---- Overlay projections (PURE fns of (story, T)) ----------------------------------------------
//
// Each projects ONE overlay primitive at scrub time T from the OverlayFrames in the story. All four
// are pure (no DOM, no selectors resolved to pixels — that happens later in the reconciler). They
// scrub forward AND backward cleanly because they are full re-derivations from the frame set, not
// forward deltas.

// The default press duration (ms) for a cursor_click whose `pressMs` is omitted.
const DEFAULT_PRESS_MS = 180;

// PURE: the set of pulse `target`s active at T. STATELESS additive scan: for every `pulse` OverlayFrame
// include its `target` iff its window contains T (half-open [fromMs, toMs)). NOT last-≤-T — pulses are
// additive windows, so two overlapping pulses are both present.
export function projectPulseSet(story: ReadonlyArray<StoryFrame>, T: number): Set<string> {
  const out = new Set<string>();
  for (const sf of story) {
    const frame = sf.frame;
    if (frame.t !== "pulse") continue;
    if (frame.fromMs <= T && T < frame.toMs) out.add(frame.target);
  }
  return out;
}

// The symbolic cursor state at T. `t01` is the lerp fraction along the current move (0 at depart, 1 at
// arrive / at rest). Selectors are NOT resolved to pixels here — the reconciler does that against the
// live DOM. `null` before the first cursor_move frame.
export interface CursorState {
  fromTarget: string;
  toTarget: string;
  t01: number;
  pressing: boolean;
}

// PURE: project the cursor's symbolic state at T. Waypoints are the `cursor_move` frames in story (tMs)
// order. The move toward waypoint `w` runs during [w.tMs, w.tMs + w.moveMs): the cursor DEPARTS the
// previous waypoint's target at w.tMs and ARRIVES at w.target by w.tMs + w.moveMs.
//
// Let `cur` = the latest waypoint with cur.tMs <= T (the move currently happening or just-completed),
// and `from` = the waypoint immediately before it (where the cursor came from). Then:
//   • no waypoint with tMs <= T (T before the first cursor_move) → null;
//   • cur.tMs <= T < cur.tMs + cur.moveMs → TRAVELING from.target → cur.target, t01 lerped along the
//     move (from.target is cur.target itself for the very first waypoint — it eases out in place);
//   • T >= cur.tMs + cur.moveMs → RESTED at cur.target (t01 = 1).
// `pressing` = some cursor_click frame has tMs <= T < tMs + (pressMs ?? DEFAULT_PRESS_MS).
export function projectCursorState(story: ReadonlyArray<StoryFrame>, T: number): CursorState | null {
  // Collect cursor_move waypoints with their StoryFrame tMs, in story order (already tMs-ordered).
  const moves: Array<{ tMs: number; target: string; moveMs: number }> = [];
  for (const sf of story) {
    if (sf.frame.t === "cursor_move") {
      moves.push({ tMs: sf.tMs, target: sf.frame.target, moveMs: sf.frame.moveMs });
    }
  }
  moves.sort((a, b) => a.tMs - b.tMs);

  // pressing: any cursor_click whose press window contains T.
  let pressing = false;
  for (const sf of story) {
    if (sf.frame.t !== "cursor_click") continue;
    const pressMs = sf.frame.pressMs ?? DEFAULT_PRESS_MS;
    if (sf.tMs <= T && T < sf.tMs + pressMs) {
      pressing = true;
      break;
    }
  }

  if (moves.length === 0) return null;

  // `curIdx` = latest waypoint that has started (tMs <= T) = the move currently happening or completed.
  // Before the first move begins → null.
  let curIdx = -1;
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].tMs <= T) curIdx = i;
    else break;
  }
  if (curIdx === -1) return null;

  const cur = moves[curIdx];
  // Where the cursor came from: the prior waypoint (or `cur` itself for the very first move).
  const from = curIdx > 0 ? moves[curIdx - 1] : cur;

  // Traveling toward `cur` while inside its move window.
  if (T < cur.tMs + cur.moveMs) {
    const t01 = cur.moveMs > 0 ? clamp01((T - cur.tMs) / cur.moveMs) : 1;
    return { fromTarget: from.target, toTarget: cur.target, t01, pressing };
  }

  // The move has completed → rested at cur.target.
  return { fromTarget: cur.target, toTarget: cur.target, t01: 1, pressing };
}

// PURE: the visible typed text per target at T. For each `field_type` frame:
//   • T < fromMs → contributes nothing;
//   • fromMs <= T < toMs → a linear prefix slice (floor(fraction * length));
//   • T >= toMs → the full text.
// Last-writer-wins per target (story order). Map keys are targets, values the visible prefix.
export function projectFieldText(story: ReadonlyArray<StoryFrame>, T: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const sf of story) {
    const frame = sf.frame;
    if (frame.t !== "field_type") continue;
    if (T < frame.fromMs) continue; // not started → contributes nothing (do NOT clear a prior writer).
    if (T >= frame.toMs) {
      out.set(frame.target, frame.text);
      continue;
    }
    const span = frame.toMs - frame.fromMs;
    const fraction = span > 0 ? clamp01((T - frame.fromMs) / span) : 1;
    const cut = Math.floor(fraction * frame.text.length);
    out.set(frame.target, frame.text.slice(0, cut));
  }
  return out;
}

// The modal/popover overlay state at T. `composer` open/closed; `popover` on + its (optional) target.
export interface ModalState {
  composer: boolean;
  popover: { on: boolean; target: string | null };
}

// PURE: project the modal state at T as the LAST `overlay_modal` frame (tMs <= T) PER kind (mirrors the
// open_plan last-≤-T pattern). Default both off / null target before any frame. A backward scrub reverts
// because we re-derive the last-≤-T value from scratch (a modal opened later is closed at an earlier T).
export function projectModalState(story: ReadonlyArray<StoryFrame>, T: number): ModalState {
  let composer = false;
  let popoverOn = false;
  let popoverTarget: string | null = null;
  for (const sf of story) {
    if (sf.tMs > T) continue;
    const frame = sf.frame;
    if (frame.t !== "overlay_modal") continue;
    if (frame.kind === "composer") {
      composer = frame.on;
    } else {
      popoverOn = frame.on;
      popoverTarget = frame.target ?? null;
    }
  }
  return { composer, popover: { on: popoverOn, target: popoverTarget } };
}

// The projected scroll override at T: the scroll container `target` selector + the lerped scrollTop
// FRACTION (0..1 of the container's max scroll range). null ⇒ no scroll window is active at T (the
// reconciler then leaves the pane where it is — never forces a scrollTop).
export interface ScrollState {
  target: string;
  frac: number;
}

// PURE: project the scroll override at T. Scans every `scroll` OverlayFrame; the ACTIVE one is the
// LAST (story order) whose window contains T (fromMs <= T < toMs). Inside that window the fraction is
// lerped fromFrac → toFrac by clamp01((T - fromMs)/(toMs - fromMs)); a zero-length window yields toFrac.
// Returns null when NO scroll window contains T — outside any window the reconciler does not touch the
// pane. A backward scrub reverts cleanly because this is a full re-derivation from the frame set (not a
// forward delta): the active window at an earlier T is re-selected and re-lerped from scratch, so
// scrub-forward-then-back yields the identical fraction.
export function projectScroll(story: ReadonlyArray<StoryFrame>, T: number): ScrollState | null {
  let active: { target: string; fromFrac: number; toFrac: number; fromMs: number; toMs: number } | null = null;
  for (const sf of story) {
    const frame = sf.frame;
    if (frame.t !== "scroll") continue;
    if (frame.fromMs <= T && T < frame.toMs) {
      // Last-active-window: a later scroll window whose span contains T supersedes an earlier one.
      active = frame;
    }
  }
  if (active === null) return null;
  const span = active.toMs - active.fromMs;
  const f = span > 0 ? clamp01((T - active.fromMs) / span) : 1;
  const frac = active.fromFrac + (active.toFrac - active.fromFrac) * f;
  return { target: active.target, frac };
}

// PURE: the SIDEBAR tab ("plans" | "contents") shown at T — the LAST `sidebar_tab` OverlayFrame whose
// tMs <= T, defaulting to "plans" before any such frame (the app's default-active sidebar tab). Mirrors
// the open_plan last-≤-T pattern, so a backward scrub reverts cleanly (a tab switched later is back on
// the default at an earlier T). The reconciler drives setSidebarTab only on change.
export function projectSidebarTab(story: ReadonlyArray<StoryFrame>, T: number): "plans" | "contents" {
  let tab: "plans" | "contents" = "plans";
  for (const sf of story) {
    if (sf.tMs > T) continue;
    if (sf.frame.t === "sidebar_tab") tab = sf.frame.tab;
  }
  return tab;
}

// ---- Model signature (memo key) ----------------------------------------------------------------

// An INJECTIVE string over the applied MODEL-frame SET at T plus the in-progress reveal prefix. The
// reconciler re-renders the conversation pane ONLY when this changes. It is keyed on (a) how many
// model frames are ≤ T (the frame SET grows monotonically as T advances) and (b) the in-progress
// reveal-prefix length (so a mid-stream token reveal re-renders each tick). It deliberately does NOT
// key on tool-ids or node ids — those are stable content addresses, not what changed.
export function modelSignature(story: ReadonlyArray<StoryFrame>, T: number): string {
  let countModelFramesLeqT = 0;
  let revealPrefixLen = 0;
  for (const sf of story) {
    if (sf.tMs > T) continue;
    if (isSurfaceFrame(sf.frame) || isOverlayFrame(sf.frame)) continue;
    countModelFramesLeqT++;
    const frame = sf.frame;
    if (
      frame.t === "conv" &&
      frame.ev.kind === "assistant_text" &&
      frame.revealMs &&
      frame.revealMs > 0 &&
      T < sf.tMs + frame.revealMs
    ) {
      const fraction = clamp01((T - sf.tMs) / frame.revealMs);
      revealPrefixLen += Math.floor(fraction * frame.ev.text.length);
    }
  }
  return `${countModelFramesLeqT}|${revealPrefixLen}`;
}

// ---- TRAILHEAD_BEAT — a fictional, public-safe conversation beat -----------------------------
//
// A two-chapter beat for a fictional React-Native "Trailhead" hiking app. It exercises the FULL
// interactive + subagent surface the live app renders, all through the REAL ConversationModel:
//
//   P3 REWRITTEN FRONT (beats 1-4) — the cosmetic-cursor / frame-driven-truth interaction model:
//   every cursor click is COSMETIC (a `#demo-cursor` press animation); the named state change is driven
//   by the frame next to it, and the reconciler owns any real DOM it touches. The named B1_/B2_/B3_/B4_
//   tMs constants above pin every dwell; the tests reference THOSE constants (not magic numbers).
//
//   Chapter "Clarify" — Beat 1 + Beat 2 (seq 1..5):
//     Beat 1 (new-plan opening, REPLACES the old pre-filled prompt): the cursor moves to #new-plan-btn
//     and cosmetically clicks; overlay_modal opens the composer (reconciler-owned `.hidden`); a ~2s
//     pulse dwells on the empty composer; the cursor moves to #composer-request and field_type TYPES the
//     Trailhead request over ~2.5s; the cursor clicks #composer-start (cosmetic) and overlay_modal closes
//     the composer (NOT via the real start(), which the mock forces to fail); THEN the seq-1 user_message
//     (the SAME request text) lands as a chat bubble, gets a ~1.8s pulse, and the seq-2 reply streams.
//     Beat 2 (clarify): the seq-3 AskUserQuestion card is pulsed ~2s, then the answer is DRIVEN through
//     the card's Other input — field_type into [data-other="text"] (the reconciler auto-checks the Other
//     toggle); a cosmetic submit-button click; the seq-4 question_answered folds the FREE-TEXT "Other"
//     value (source of truth) and the seq-5 echo bubble carries it.
//
//   Chapter "Scope recon" — Beat 3 (seq 6..54):
//     The assistant launches a `scope-recon` SUBAGENT (a Task tool). A `subagent_started` frame LABELS
//     the group. Inside the group the subagent runs ~20 LEAF tool pairs (Glob×4 / Read×9 / Grep×4 /
//     Bash×3) plus two intermediate in-group notes, each tool_use + tool_result sharing a tMs so each
//     reveals ATOMICALLY (no "running" leaf at rest). The Task's OWN tool_result (seq 53) lands at the
//     END, flipping the top-level Task tool node running→done — WITHOUT it the Task row stays "running"
//     forever (the no-stuck-tool invariant fails). seq 52 is the in-group summary, seq 54 the wrap-up.
//
//   Chapter "Plan sizer" — Beat 4 (seq 55..58, NEW):
//     A short narration announces the right-sizing gate, then a top-level `plan-sizer` Task (atomic
//     tool_use seq 56 + tool_result seq 57, shared tMs) returns the SPLIT decision ("master + 3 subplans;
//     subplan 04 decomposed into 4 leaves"). A brief pulse marks the plan-sizer row; seq 58 narrates the
//     outcome. This precedes the (shifted) prototype-review chapter.
//
//   DOWNSTREAM SHIFT (load-bearing): the chapters BELOW (prototype review … execution … terminal) are
//   kept VERBATIM in shape but written PRE-SHIFTED: every downstream model frame's seq is + SEQ_SHIFT
//   (38) and its tMs is + EXEC_SHIFT (26800). The seq/tMs ranges quoted below are the ORIGINAL pre-shift
//   numbers; add SEQ_SHIFT/EXEC_SHIFT for the live values (e.g. the terminal is seq TERMINAL_SEQ / tMs
//   TERMINAL_MS — the strictly-highest seq AND tMs).
//
//   Chapter "Prototype review" (orig seq 21..24, + SEQ_SHIFT):
//     The assistant narrates a visual prototype (seq 21, Conversation tab). A SURFACE bracket then
//     opens PROTO_PREVIEW_PATH in the reading pane AND turns the prototype gate ON for a window, then
//     closes BOTH (open_plan{null} + gate off) — so during the window the reconciler tracks
//     activeTab="plan" (the review bar + reading pane live there) and flips back to Conversation after.
//     The user leaves feedback (seq 22) and a system approval echo lands (seq 23), then the assistant
//     acknowledges (seq 24).
//
//   Chapter "Nested plan" (seq 25):
//     The assistant announces the drafted plan (seq 25, Conversation tab). A SURFACE pair then reveals
//     the drafted TRAILHEAD_PLANS tree in the until-now-empty sidebar (plan_changed at 19800) AND opens
//     the master in the reading pane (open_plan at 20200) — LEFT OPEN, so this chapter ends on the Plan
//     tab with the V1 master + its mermaid decomposition diagram on screen.
//
//   Chapter "Comment & iterate" (set_comments ×3 + open_plan{V2}) + seq 26 system echo:
//     With the V1 master still open, the user leaves THREE comments on it one at a time (set_comments at
//     22000/22800/23600 — the FULL set grows [c1] → [c1,c2] → [c1,c2,c3]). projectSurfaceState.comments
//     follows 1 → 2 → 3 and the reconciler's applyComments paints that many inline `.cmt-hl` highlights
//     on the open V1 prose. The pane then switches to the REVISED master (open_plan{TRAILHEAD_MASTER_V2}
//     at 24800, LEFT OPEN — no closing null) — because comments are scoped to the open path and V2 has
//     none, the highlights clear to 0 on the revised doc (a clean iteration reveal, Plan tab). A system
//     echo (seq 26) announces the revision. HIGHLIGHTS-ONLY: this beat drives NO pending_reviews frame
//     and shows NO review-bar count (driving the bar would auto-open the plan and re-render the pane,
//     WIPING the highlights — see the comment consts below).
//
//   Chapter "Execution" + "Done" (open_plan{null} + seq 27..49):
//     The plan is approved and the assistant EXECUTES the four 04.* trail-detail leaves FLAT (per-leaf,
//     no Task wrapper). The first execution frame is a SURFACE open_plan{null} (tMs 27000): it closes the
//     reading pane (the V2 master is no longer shown) so projectSurfaceState flips activeTab "plan" →
//     "conversation" for the whole chapter — the execution conversation owns the foreground. Each leaf is
//     one atomic Write tool_use/tool_result pair (shared tMs, correlated by a per-leaf WRITE_*_ID), a
//     top-level OUTPUT assistant_text, and a DEMO-AUTHORED `[context] → NN.NN: …` system_message that
//     threads the next leaf (scripted authoring, NOT a live orchestrator). An integration wrap-up (seq
//     48) and the terminal `result` (seq 49 / tMs 40000, "Done") close the turn — STRICTLY the highest
//     seq AND tMs (so `working` is non-null for every mid-run T but null at duration: a finished thought).
//
//   PROTOTYPE-REVIEW DESIGN RATIONALE (load-bearing): in production the gate force-switches to the
//   Plan tab (onPrototypeReview → switchToPlanTab); the review bar + reading pane live on the Plan tab
//   while the conversation bubbles live on the Conversation tab (the two tabs are MUTUALLY EXCLUSIVE).
//   The open_plan{path}…open_plan{path:null} BRACKET is aligned with the gate window precisely so the
//   reconciler's structural activeTab projection ("plan" iff a plan is open) tracks the Plan tab during
//   the gate and reverts to Conversation after — making BOTH the gate AND the tab pure functions of T
//   (forward + backward scrub revert cleanly, no stuck Plan tab), and sequencing the beat as
//   narration → prototype (Plan) → flip back → feedback + approval bubbles (Conversation).
//
// TIMING / INVARIANTS (load-bearing):
//   • dense, contiguous seqs 1..TERMINAL_SEQ (= 87). Front beats 1-4 use seqs 1..58 (Beat 1/2 → 1..5,
//     Beat 3 scope-recon → 6..54 incl. ~20 atomic leaf pairs, Beat 4 plan-sizer → 55..58); the
//     downstream chapters (prototype review … execution … terminal) follow at + SEQ_SHIFT (orig 21..49 →
//     59..87).
//   • monotonic tMs; the terminal `result` (seq TERMINAL_SEQ / tMs TERMINAL_MS) is the strictly-highest
//     seq AND tMs (so `working` is non-null for every mid-run T but null at T = storyDurationMs — a
//     finished thought). All surface frames (the tMs-0 empty plan_changed, the prototype-review /
//     nested-plan / comment-and-iterate brackets, the Execution open_plan{null}) AND all overlay frames
//     (cursor_move/click, pulse, field_type, overlay_modal) carry no seq — they are projected by
//     projectSurfaceState / the overlay projections, never applied to the model.
//   • QUESTION INVARIANT: request.seq (3) < answer.seq (4) AND request.tMs (B2_QUESTION_MS) <= answer.tMs
//     (B2_ANSWER_MS).
//   • The scope-recon Task tool SPANS its group (tool_use seq 7 @ B3_TASK_MS .. its tool_result seq 53 @
//     B3_TASK_RESULT_MS); only the LEAF tool pairs inside the group are atomic. The scope-recon Task is
//     the ONLY non-atomic tool — its result is deferred to the group's end, emitted explicitly (seq 53).
//     The Beat-4 plan-sizer Task, by contrast, is ATOMIC (its result shares its tMs).
//   • subagent label path: `subagent_started` is an existing AgentStream kind that appendStream already
//     handles; emitting it through the widened ConvFrame Extract LABELS the group ("scope-recon")
//     WITHOUT any engine change.
const TASK_ID = "toolu_trailhead_task_scope_recon";
// The intent-clarifier subagent's Task id (Beat 1.5). Top-level Task; its OWN result is DEFERRED to the
// group's end (mirrors scope-recon at smaller scale) so the spanning Task flips running→done.
const CLARIFIER_TASK_ID = "toolu_trailhead_task_intent_clarifier";
const QUESTION_ID = "toolu_trailhead_ask_platform";
// The plan-sizer right-sizing gate's tool id (Beat 4). Top-level Task; its result lands atomically.
const PLAN_SIZER_ID = "toolu_trailhead_plan_sizer";

// ---- Named beat tMs constants (load-bearing; tests pin to THESE, not magic numbers) -------------
//
// Beats 1-4 (the rewritten front) introduce real viewer DWELLS — the cursor moves, the composer opens
// and is read, text is typed character-by-character, the question is read and answered. Every dwell is
// a tMs GAP that the player's hold-state spans; a `pulse` window straddling the gap tells the viewer
// where to look. These constants make a re-time a one-line change instead of churn across the tests.
//
// Beat 1 — New plan opening (the composer flow REPLACES the old pre-filled seq-1 prompt):
export const B1_NEWPLAN_MOVE_MS = 600; // cursor travels to #new-plan-btn
export const B1_NEWPLAN_CLICK_MS = 1300; // cosmetic click on #new-plan-btn
export const B1_COMPOSER_OPEN_MS = 1500; // overlay_modal{composer,on} — the modal opens (reconciler-owned)
export const B1_COMPOSER_PULSE_FROM = 1700; // pulse #composer-modal …
export const B1_COMPOSER_PULSE_TO = 3700; //   … for ~2s (a real dwell: the viewer reads the empty composer)
export const B1_REQUEST_MOVE_MS = 3700; // cursor travels to #composer-request
export const B1_REQUEST_TYPE_FROM = 4300; // field_type #composer-request begins …
export const B1_REQUEST_TYPE_TO = 6800; //   … typed over ~2.5s
// (P5 #1) PACING: right after typing ends the cursor re-anchors AT the request field (a fresh origin
// waypoint), THEN travels SLOWLY to #composer-start so the viewer can follow the field→button move (no
// jump). A dwell + pulse on Start lets the moment read before the cosmetic click. The whole tail still
// completes before B1B_LEAD_MS (11000), so NO downstream shift is needed (it fits the pre-existing slack).
export const B1_REQUEST_DWELL_MS = 6850; // cursor re-anchors at #composer-request (fresh origin for the slow travel)
export const B1_START_MOVE_MS = 7150; // cursor travels SLOWLY to #composer-start …
export const B1_START_MOVE_DUR = 750; //   … over ~0.75s (legible travel, not a jump). Arrives 7900.
export const B1_START_PULSE_FROM = 7900; // pulse #composer-start once the cursor arrives …
export const B1_START_PULSE_TO = 8450; //   … ~0.55s dwell so the viewer reads the moment before the click
export const B1_START_CLICK_MS = 8450; // cosmetic click on #composer-start (after the dwell)
export const B1_COMPOSER_CLOSE_MS = 8650; // overlay_modal{composer,off} — modal closes (NOT via real start())
export const B1_USER_MSG_MS = 8850; // seq 1 user_message (the request) appears as a chat bubble
export const B1_USER_PULSE_FROM = 8950; // pulse the user bubble …
export const B1_USER_PULSE_TO = 9700; //   … for ~0.75s
export const B1_REPLY_MS = 9800; // seq 2 assistant reply begins streaming (reveal 900 → ends 10700 < B1B_LEAD_MS)

// Beat 1.5 — Intent-clarifier running beat (P4, #2): BEFORE the clarify question card appears, the
// intent-clarifier agent is shown RUNNING with realistic streaming tool calls (a small mirror of the
// scope-recon group). It launches a top-level `intent-clarifier` Task, runs 4 atomic leaf tool pairs
// (Glob/Read/Grep), notes a brief summary, then its OWN deferred Task tool_result flips it done — so the
// viewer sees the clarifier work the codebase before it asks "which platform?". Seqs are FRACTIONAL
// (2.x, strictly between the seq-2 reply and the seq-3 question) so NO downstream seq shifts: the
// question stays seq 3 and the QUESTION INVARIANT (req.seq 3 < ans.seq 4) is untouched.
export const B1B_LEAD_MS = 11000; // seq 2.1 brief reasoning ("Let me quickly scan the codebase…")
export const B1B_TASK_MS = 11900; // seq 2.2 intent-clarifier Task tool_use + seq 2.3 subagent_started
export const B1B_FIRSTWORDS_MS = 12200; // seq 2.4 the clarifier's first words (inside the group)
export const B1B_LEAF_START_MS = 12700; // first clarifier leaf pair tMs; each steps by B1B_LEAF_STEP_MS
export const B1B_LEAF_STEP_MS = 450; // the inter-leaf gap (atomic pair shares one tMs)
export const B1B_SUMMARY_MS = 14800; // the clarifier's closing in-group summary
export const B1B_TASK_RESULT_MS = 15300; // the clarifier Task's OWN deferred tool_result (flips it done)

// CLARIFIER_SHIFT (load-bearing, P4 #2): the intent-clarifier running beat (B1B_*, above) is INSERTED
// between the seq-2 reply (B1_REPLY_MS) and the (formerly tMs-11000) clarify question. It adds TIME only
// (its model frames carry FRACTIONAL 2.x seqs, so no seq renumbering). EVERYTHING downstream of the reply
// — the question (B2_*), scope-recon (B3_*), plan-sizer (B4_*), prototype review (PROTO_*), and the
// programmatic Execution chapter (EXEC_BASE_MS) — slides later by exactly this much. The B2_/B3_/B4_/
// PROTO_* literal constants below each add `+ CLARIFIER_SHIFT` (their pre-clarifier literal stays visible
// as documentation); EXEC_BASE_MS adds it too; and the DOWNSTREAM_AFTER_PROTOTYPE splice .map adds it on
// top of PROTO_ACT_SHIFT. SCROLL_* are NOT bumped here — they live only inside DOWNSTREAM_AFTER_PROTOTYPE,
// which the .map already shifts by + CLARIFIER_SHIFT (bumping them too would double-shift).
export const CLARIFIER_SHIFT = 4400; // B2_QUESTION_MS moves 11000 → 15400, after the clarifier result (15300).

// Beat 2 — Clarify (the user is shown ENTERING the Other answer):
export const B2_QUESTION_MS = 11000 + CLARIFIER_SHIFT; // seq 3 question_request (the AskUserQuestion card)
export const B2_QUESTION_PULSE_FROM = 11200 + CLARIFIER_SHIFT; // pulse .conv-question …
export const B2_QUESTION_PULSE_TO = 13200 + CLARIFIER_SHIFT; //   … for ~2s (pause+pulse on the card)
export const B2_ANSWER_TYPE_FROM = 13400 + CLARIFIER_SHIFT; // field_type [data-other="text"] begins (reconciler auto-checks Other)
export const B2_ANSWER_TYPE_TO = 15600 + CLARIFIER_SHIFT; //   … typed over ~2.2s
// (P5 #3) PACING: right after the answer is typed the cursor re-anchors AT the Other input (a fresh
// origin waypoint — the cursor's prior waypoint is the far-away #composer-start from Beat 1), THEN
// travels SLOWLY to the submit button so the field→button move is legible. A dwell + pulse on the submit
// button lets the moment read. The whole tail still completes before B3_ACK_MS (17600 + SHIFT), so NO
// downstream shift is needed (it fits the pre-existing slack).
export const B2_ANSWER_DWELL_MS = 15700 + CLARIFIER_SHIFT; // cursor re-anchors at [data-other="text"] (fresh origin)
export const B2_SUBMIT_MOVE_MS = 15900 + CLARIFIER_SHIFT; // cursor travels SLOWLY to .conv-question-submit …
export const B2_SUBMIT_MOVE_DUR = 800; //   … over ~0.8s (legible travel, not a jump). Arrives 16700 + SHIFT.
export const B2_SUBMIT_PULSE_FROM = 16700 + CLARIFIER_SHIFT; // pulse .conv-question-submit once the cursor arrives …
export const B2_SUBMIT_PULSE_TO = 17250 + CLARIFIER_SHIFT; //   … ~0.55s dwell before the cosmetic click
export const B2_SUBMIT_CLICK_MS = 17250 + CLARIFIER_SHIFT; // cosmetic click on .conv-question-submit (after the dwell)
export const B2_ANSWER_MS = 17450 + CLARIFIER_SHIFT; // seq 4 question_answered (folds onto the card — source of truth) + seq 5 echo

// Beat 3 — Scope recon ×5 (~20 atomic leaf tool pairs under the scope-recon Task):
export const B3_ACK_MS = 17600 + CLARIFIER_SHIFT; // seq 6 assistant ack
export const B3_TASK_MS = 18800 + CLARIFIER_SHIFT; // seq 7 Task tool_use + seq 8 subagent_started
export const B3_FIRSTWORDS_MS = 19100 + CLARIFIER_SHIFT; // seq 9 subagent's first words
export const B3_LEAF_START_MS = 20000 + CLARIFIER_SHIFT; // first leaf pair tMs; each subsequent pair steps by B3_LEAF_STEP_MS
export const B3_LEAF_STEP_MS = 450; // the inter-leaf gap (atomic pair shares one tMs)
export const B3_SUMMARY_MS = 31000 + CLARIFIER_SHIFT; // the subagent's closing summary
export const B3_TASK_RESULT_MS = 31900 + CLARIFIER_SHIFT; // the Task's OWN deferred tool_result (flips it done)
export const B3_WRAPUP_MS = 32800 + CLARIFIER_SHIFT; // the top-level wrap-up

// Beat 4 — Plan-sizer (NEW): the right-sizing gate between scope-recon and the drafted plan:
export const B4_NARRATION_MS = 34200 + CLARIFIER_SHIFT; // short narration announcing the right-sizing gate
export const B4_SIZER_MS = 35400 + CLARIFIER_SHIFT; // the plan-sizer Task tool_use + its atomic tool_result
export const B4_SIZER_PULSE_FROM = 35600 + CLARIFIER_SHIFT; // brief pulse on the plan-sizer row …
export const B4_SIZER_PULSE_TO = 37200 + CLARIFIER_SHIFT; //   … ~1.6s
export const B4_OUTCOME_MS = 37600 + CLARIFIER_SHIFT; // narration of the split decision

// EXEC_SHIFT / SEQ_SHIFT (load-bearing): the rewritten front (beats 1-4) is LONGER and uses MORE seqs
// than the original. The downstream beats (prototype review … execution … terminal) are kept VERBATIM
// in shape but SHIFTED uniformly: every downstream model frame's tMs is + EXEC_SHIFT and its seq is +
// SEQ_SHIFT. The original front ended at seq 20 / the prototype-review chapter opened at tMs 13000; the
// new front ends at seq 58 / tMs B4_OUTCOME_MS, so downstream is renumbered from there. These two
// constants are the SINGLE source of the shift (every downstream literal below is written pre-shifted).
export const SEQ_SHIFT = 38; // old downstream seqs 21..49 → 59..87
export const EXEC_SHIFT = 26800; // old downstream tMs 13000..40000 → 39800..66800

// PROTO_ACT_SHIFT (load-bearing, P4): the rewritten "Prototype review" chapter is LONGER than the
// original instant feedback/approval — it now scripts the full prototype ACT (pulse the narration
// bubble ~2s, show the round-1 trail card + pulse it, TYPE the feedback into #prototype-feedback ~2.5s,
// cosmetic-click #review-submit, morph to the round-2 card + pulse it ~2s, cosmetic-click #review-approve).
// It adds NO new seqs (every new frame is an OVERLAY frame, which carries no seq) — only TIME. So the
// chapters BELOW it (nested plan … comment & iterate … execution … terminal) keep their seqs but shift
// their tMs by + PROTO_ACT_SHIFT (applied via DOWNSTREAM_AFTER_PROTOTYPE.map below, NOT hand-edited
// literals). The prototype chapter's OWN seq-60/61/62 model frames are written at their new in-act tMs.
export const PROTO_ACT_SHIFT = 9600; // pushes nested-plan (was 45800) → 55400, after the act ends (~52400).

// COMMENT_ACT_SHIFT (load-bearing, P4): the rewritten "Comment & iterate" chapter now SCRIPTS the
// selection-popover act for two comments (cursor → block, popover open + pulse, type into #sp-text,
// cosmetic #sp-save click, popover close, THEN the highlight paints). That act carries NO new seqs (all
// overlay frames) and shifts the (P4) nested-plan/comment-and-iterate tMs by + PROTO_ACT_SHIFT only.
// (Before P5 the Execution chapter also shifted by + COMMENT_ACT_SHIFT; P5 REWROTE Execution as a
// programmatic subagent sequence built directly at FINAL tMs/seq from EXEC_BASE_MS / EXEC_SEQ_BASE
// below, so this constant now only documents the comment-act length used to choose EXEC_BASE_MS.)
export const COMMENT_ACT_SHIFT = 5000;

// ---- (P5) Execution chapter base — built directly at FINAL tMs/seq ------------------------------
//
// The P4 "Comment & iterate" chapter's last model frame lands at final tMs 68000 (pre-shift 58400 +
// PROTO_ACT_SHIFT) at seq 64. The P5 Execution chapter (a SEQUENCE OF SUBAGENTS) is generated by the
// EXEC_SUBPLANS builder below at FINAL tMs/seq (NO further shift) starting just after that. EXEC_BASE_MS
// is the Execution open_plan{null} tMs; EXEC_SEQ_BASE is the first Execution model seq (the exec-open
// narration). The builder steps from there; TERMINAL_MS / TERMINAL_SEQ are COMPUTED from its output
// (see after EXEC_FRAMES) so a re-time/re-count is a one-line base change, never a literal edit.
// (c4) The comment-and-iterate chapter (COMMENT_AND_V2) is pushed by PROTO_ACT_SHIFT + CLARIFIER_SHIFT +
// C4_SHIFT (the c4 ToC-navigation beat now plays BEFORE the comments and is longer than the old generic
// slow-scroll beat it replaced). The comment act's last model frame (the seq-64 system echo, literal
// 69400) therefore lands at final 69400 + PROTO_ACT_SHIFT + CLARIFIER_SHIFT + C4_SHIFT = 85400.
// EXEC_BASE_MS must stay strictly greater than that.
export const EXEC_BASE_MS = 82000 + CLARIFIER_SHIFT; // Execution open_plan{null}; > the comment act's last frame (85400).
export const EXEC_SEQ_BASE = 65; // first Execution model seq (= old 64 + 1, contiguous after the comment chapter).

// ---- (c4) Contents-tab ToC navigation beat constants (tests pin to THESE) -----------------------
//
// (c4 — review2) BEFORE the user comments, the demo NAVIGATES the plan's table of contents: it clicks
// the SIDEBAR "Contents" tab (revealing the ToC built from the open master), clicks a LOW ToC entry so
// the reading pane scrolls way down, then clicks the "Context" ToC entry so it scrolls back to the top
// — only THEN does the commenting begin. This REPLACES the old generic slow-scroll beat (the demo now
// scrolls by DRIVING the real ToC entries the cursor visibly clicks, not an anonymous scroll sweep).
//
// The scroll itself is still the PURE `scroll` primitive (projectScroll, lerped, scrub-revertable) over
// #reader-scroll, so it is deterministic and reverts on a back-scrub; the cursor merely TARGETS the
// real `.toc-item` elements for legibility. Two scroll windows (down 0→1 then up 1→0) drive the pane;
// they MUST NOT overlap (projectScroll is last-window-wins — an overlap would silently mask the earlier
// window). All literals below are in DOWNSTREAM_HEAD space (the master opens at literal 47000); the
// .map splice adds + PROTO_ACT_SHIFT + CLARIFIER_SHIFT, exactly like the rest of the head.
//
// C4_SHIFT (load-bearing): the c4 navigation beat is LONGER than the old slow-scroll beat it replaces,
// so the whole comment-and-iterate chapter (COMMENT_AND_V2, authored at its original literals) is pushed
// later by + C4_SHIFT (applied programmatically in the splice loop, NOT hand-edited literals). The
// tMs-pinned comment tests add C4_SHIFT to their expected paint times.
export const SCROLL_TARGET = "#reader-scroll";
export const C4_SHIFT = 2000; // the comment chapter slid later by this much (the c4 beat is longer than the old scroll beat).

// The cursor travels to the Contents tab, a cosmetic click lands, and the sidebar switches to Contents
// (the real initTabs switch, via the setSidebarTab seam) so the ToC — built from the open master — shows.
export const C4_CONTENTS_TAB_MOVE_MS = 48000; // cursor → the sidebar "Contents" tab
export const C4_CONTENTS_TAB_CLICK_MS = 48700; // cosmetic click on the Contents tab
export const C4_CONTENTS_TAB_SWITCH_MS = 48700; // sidebar_tab → "contents" (lands WITH the click so the ToC reveals)
export const C4_CONTENTS_TAB_PULSE_FROM = 48200; // pulse the Contents tab as the cursor arrives …
export const C4_CONTENTS_TAB_PULSE_TO = 49400; //   … through the click
// The cursor travels to a LOW ToC entry (the master's last heading, "Decomposition" = data-line 6) and
// clicks it; the reading pane SCROLLS DOWN (0→1) so the viewer sees the bottom of the plan.
export const C4_TOC_DOWN_MOVE_MS = 49800; // cursor → the low ToC entry (.toc-item[data-line="6"])
export const C4_TOC_DOWN_CLICK_MS = 50500; // cosmetic click on the low ToC entry
export const C4_SCROLL_DOWN_FROM = 50500; // begin scrolling the master pane DOWN (paired with the click) …
export const C4_SCROLL_DOWN_TO = 52900; //   … reaching the bottom over ~2.4s
export const C4_TOC_DOWN_PULSE_FROM = 50000; // pulse the low ToC entry as the cursor arrives …
export const C4_TOC_DOWN_PULSE_TO = 51200; //   … through the click
// After a brief dwell at the bottom, the cursor travels to the "Context" ToC entry (data-line 2) and
// clicks it; the reading pane SCROLLS BACK UP (1→0) to the top — only THEN does commenting begin.
export const C4_TOC_CONTEXT_MOVE_MS = 53300; // cursor → the "Context" ToC entry (.toc-item[data-line="2"])
export const C4_TOC_CONTEXT_CLICK_MS = 54000; // cosmetic click on the "Context" ToC entry
export const C4_SCROLL_UP_FROM = 54000; // begin scrolling the master pane back UP (paired with the click) …
export const C4_SCROLL_UP_TO = 56400; //   … reaching the top over ~2.4s
export const C4_TOC_CONTEXT_PULSE_FROM = 53500; // pulse the "Context" ToC entry as the cursor arrives …
export const C4_TOC_CONTEXT_PULSE_TO = 54700; //   … through the click
// Restore the Plans tab before the user starts commenting (the comments anchor reading-pane blocks; the
// sidebar shows the plan list again). The cursor travels to the Plans tab and clicks it.
export const C4_PLANS_TAB_MOVE_MS = 56600; // cursor → the sidebar "Plans" tab
export const C4_PLANS_TAB_CLICK_MS = 57300; // cosmetic click on the Plans tab
export const C4_PLANS_TAB_SWITCH_MS = 57300; // sidebar_tab → "plans" (restores the plan list for commenting)
// The two ToC entry selectors the cursor targets (built by buildToc from extractToc on the open master:
// the h1 "Master Plan…" = data-line 0, the h2 "Context" = data-line 2, the h2 "Decomposition" = data-line 6).
export const C4_TOC_LOW_SELECTOR = '#toc-list .toc-item[data-line="6"]';
export const C4_TOC_CONTEXT_SELECTOR = '#toc-list .toc-item[data-line="2"]';
export const C4_CONTENTS_TAB_SELECTOR = '.tab-row .tab[data-tab="contents"]';
export const C4_PLANS_TAB_SELECTOR = '.tab-row .tab[data-tab="plans"]';

// ---- Named tMs constants for the P4 prototype ACT (tests pin to THESE, not magic numbers) -------
// The prototype chapter narration (seq 59) lands at PROTO_NARR_MS; the act then plays out as a sequence
// of dwells (pulses spanning tMs gaps) the player's hold-state covers. All overlay frames; no seqs.
// (All PROTO_* add + CLARIFIER_SHIFT — the intent-clarifier beat slid the whole back half later; the
// pre-clarifier literal stays visible as documentation, tests pin to the constants.)
export const PROTO_NARR_MS = 39800 + CLARIFIER_SHIFT; // seq 59 "I put together a quick visual prototype…"
export const PROTO_NARR_PULSE_FROM = 40700 + CLARIFIER_SHIFT; // pulse the narration bubble (by data-seq) …
export const PROTO_NARR_PULSE_TO = 42700 + CLARIFIER_SHIFT; //   … ~2s pause (the viewer reads it)
export const PROTO_OPEN_MS = 40600 + CLARIFIER_SHIFT; // open_plan(PROTO_PREVIEW_PATH) + prototype_gate{on,round:1} → inline round-1 card shows
export const PROTO_CARD1_PULSE_FROM = 42800 + CLARIFIER_SHIFT; // pulse #reading-pane (inline round-1 card) …
export const PROTO_CARD1_PULSE_TO = 44800 + CLARIFIER_SHIFT; //   … ~2s
export const PROTO_FEEDBACK_MOVE_MS = 44900 + CLARIFIER_SHIFT; // cursor → #prototype-feedback
export const PROTO_FEEDBACK_TYPE_FROM = 45200 + CLARIFIER_SHIFT; // field_type #prototype-feedback begins …
export const PROTO_FEEDBACK_TYPE_TO = 47700 + CLARIFIER_SHIFT; //   … typed over ~2.5s (also pulsed across this window)
export const PROTO_SUBMIT_MOVE_MS = 47900 + CLARIFIER_SHIFT; // cursor → #review-submit
export const PROTO_SUBMIT_CLICK_MS = 48200 + CLARIFIER_SHIFT; // cosmetic click on #review-submit ("Request changes")
export const PROTO_ROUND2_MS = 48400 + CLARIFIER_SHIFT; // prototype_gate{on,round:2} → the inline card MORPHS with a difficulty badge
export const PROTO_CARD2_PULSE_FROM = 48600 + CLARIFIER_SHIFT; // pulse #reading-pane (inline round-2 card) …
export const PROTO_CARD2_PULSE_TO = 50600 + CLARIFIER_SHIFT; //   … ~2s pause
// (P5 #10) PACING: before approving, make the review-bar buttons read clearly — pulse #review-approve,
// re-anchor the cursor at the feedback field (a fresh origin — its prior waypoint is #review-submit from
// the round-1 cosmetic click), then travel SLOWLY across the review bar to Approve so the move is
// legible. The whole approve sequence still completes by the ORIGINAL PROTO_ACK_MS (52400 + SHIFT), so
// PROTO_ACT_SHIFT is UNCHANGED and NO downstream chapter shifts (it fits the pre-existing slack).
export const PROTO_APPROVE_PULSE_FROM = 50650 + CLARIFIER_SHIFT; // pulse #review-approve so the button reads clearly …
export const PROTO_APPROVE_PULSE_TO = 51900 + CLARIFIER_SHIFT; //   … through the slow move, up to the click
export const PROTO_APPROVE_ORIGIN_MS = 50650 + CLARIFIER_SHIFT; // cursor re-anchors at #prototype-feedback (fresh origin)
export const PROTO_APPROVE_MOVE_MS = 50900 + CLARIFIER_SHIFT; // cursor travels SLOWLY to #review-approve …
export const PROTO_APPROVE_MOVE_DUR = 750; //   … over ~0.75s (legible travel across the review bar). Arrives 51650 + SHIFT.
export const PROTO_APPROVE_CLICK_MS = 51900 + CLARIFIER_SHIFT; // cosmetic click on #review-approve ("Approve visual") after the dwell
export const PROTO_CLOSE_MS = 52050 + CLARIFIER_SHIFT; // prototype_gate{off} + open_plan{null} → card hides, tab flips back
export const PROTO_FEEDBACK_MS = 52200 + CLARIFIER_SHIFT; // seq 60 user feedback bubble + seq 61 approval echo (land together)
export const PROTO_ACK_MS = 52400 + CLARIFIER_SHIFT; // seq 62 assistant ack (UNCHANGED — the approve act fits before it)
// (P5) The Execution chapter is now a SEQUENCE OF SUBAGENTS — one Task subagent per subplan, each with
// 4–6 atomic leaf tool calls + a deferred top-level Task tool_result. The per-subplan Task ids and the
// leaf-tool ids are generated by the EXEC_SUBPLANS builder below (no hand-authored WRITE_* ids).

// The Trailhead kickoff request. In the rewritten Beat 1 the user TYPES this into the composer
// (field_type #composer-request) and it then appears as the seq-1 user bubble — so the SAME string is
// both the typed composer text AND the chat bubble (no pre-filled prompt). Reuse of the original text.
const TRAILHEAD_REQUEST =
  "I want to build Trailhead — a mobile app that helps hikers find and log trails. Can you plan it?";

// The prototype feedback the user TYPES into #prototype-feedback during the P4 prototype act and that
// then lands as the seq-60 user bubble — the SAME string is both the typed feedback AND the chat row
// (mirrors Beat 1's compose-then-echo). It literally names the two changes the round-2 card makes
// (larger card + difficulty badge), so the typed feedback and the card morph are coherent.
const TRAILHEAD_PROTO_FEEDBACK = "Love it — bump the trail-card size and add a difficulty badge.";

// The exact question text — used BOTH as the card's question and as the answers key (the SDK keys
// `answers` by the `question` string, and derive() folds by that key).
const PLATFORM_QUESTION = "Which platform should the first cut target?";
// The free-text "Other" answer the user typed (matches NO option label → the "Other…" demonstration).
const PLATFORM_ANSWER = "Android first — that's where most of our trail users are";

// ---- Slice-06 "Comment & iterate" comment records ----------------------------------------------
//
// Three comments the user leaves on the STILL-OPEN V1 master (TRAILHEAD_MASTER_PATH). Each `quote` is
// a VERBATIM phrase from the V1 master's PROSE (outside the ```mermaid fence), so applyComments anchors
// it as a `.cmt-hl` highlight in the reading pane. `block_line: null` ⇒ whole-pane occurrence scan
// (the render facade's applyComments path), `occurrence: 0` ⇒ the first match.
//
// HIGHLIGHTS-ONLY (load-bearing): these drive ONLY `set_comments` SurfaceFrames → the reconciler's
// applyComments → inline `.cmt-hl` highlights. We deliberately DO NOT emit any `pending_reviews`
// frame and DO NOT assert a review-bar count: that would be the review-bar surface, NOT content. In
// the real app opening the review bar AUTO-OPENS the plan and re-renders the pane, which WIPES the
// freshly-applied highlights — so a review-bar count and the inline highlights are mutually exclusive
// in one frame. This slice delivers the inline highlights + the V1→V2 iteration only.
// Exported so the storyboard test can assert the highlights anchor the EXACT records the beat drives
// (and that each quote is verbatim V1 prose). Order is c1, c2, c3 — the order the beat reveals them.
export const TRAILHEAD_COMMENT_1: CommentRecord = {
  quote: "decomposes the build into four subplans",
  block_line: null,
  block_end_line: null,
  occurrence: 0,
  comment: "Can we make the trail cards bigger? They feel cramped in the prototype.",
  id: 1,
};
export const TRAILHEAD_COMMENT_2: CommentRecord = {
  quote: "the difficulty-badge work the reviewer asked for has a home",
  block_line: null,
  block_end_line: null,
  occurrence: 0,
  comment: "Surface the difficulty badge on the card too, not just the detail header.",
  id: 2,
};
export const TRAILHEAD_COMMENT_3: CommentRecord = {
  quote: "Subplans run in order",
  block_line: null,
  block_end_line: null,
  occurrence: 0,
  comment: "Confirm 04 (trail detail) lands last so the badge has its leaves first.",
  id: 3,
};

export const TRAILHEAD_BEAT: StoryFrame[] = [
  // ---- Chapter "Clarify" -----------------------------------------------------------------------
  {
    // SURFACE (tMs 0) — start with an EMPTY sidebar. projectSurfaceState falls back to the fixture
    // seed (clonePlans) before any plan_changed frame, which would show the unrelated harness/Chompy
    // plans during the whole beat. Emitting an explicit empty plan_changed at tMs 0 pins the sidebar
    // to [] from the very start so the drafted Trailhead tree (plan_changed at 19800) is the FIRST
    // thing that ever appears there — a clean "the plan was just written" reveal.
    tMs: 0,
    frame: { t: "plan_changed", plans: [] },
  },

  // ================================================================================================
  // Chapter "Clarify" — Beat 1 (new-plan opening) + Beat 2 (entering the Other answer)
  // ================================================================================================
  //
  // Beat 1 REPLACES the old pre-filled seq-1 prompt. The user OPENS a new plan through the real
  // composer flow — all cursor clicks are COSMETIC; the modal open/close and the chat bubble are driven
  // by frames (overlay_modal / user_message), the reconciler being the exclusive owner of #composer-modal.
  //
  // ---- Beat 1: cursor → #new-plan-btn (cosmetic click) → composer opens → read → type request → start
  {
    // OVERLAY — the cursor travels to the New-plan button.
    tMs: B1_NEWPLAN_MOVE_MS,
    chapterLabel: "Clarify",
    frame: { t: "cursor_move", target: "#new-plan-btn", moveMs: 500 },
  },
  {
    // OVERLAY — a COSMETIC press on #new-plan-btn (no real DOM click is dispatched).
    tMs: B1_NEWPLAN_CLICK_MS,
    frame: { t: "cursor_click", target: "#new-plan-btn" },
  },
  {
    // OVERLAY — the composer modal OPENS (reconciler-owned `.hidden`), driven by the frame (NOT the real
    // #new-plan-btn handler — the click above was cosmetic). A backward scrub closes it (last-≤-T per kind).
    tMs: B1_COMPOSER_OPEN_MS,
    frame: { t: "overlay_modal", kind: "composer", on: true },
  },
  {
    // OVERLAY — pulse the open composer for ~2s: a real DWELL (the tMs gap to the next frame) so the
    // viewer reads the empty composer before anything is typed.
    tMs: B1_COMPOSER_PULSE_FROM,
    frame: { t: "pulse", target: "#composer-modal", fromMs: B1_COMPOSER_PULSE_FROM, toMs: B1_COMPOSER_PULSE_TO },
  },
  {
    // OVERLAY — the cursor travels to the request textarea.
    tMs: B1_REQUEST_MOVE_MS,
    frame: { t: "cursor_move", target: "#composer-request", moveMs: 500 },
  },
  {
    // OVERLAY — the user TYPES the Trailhead request into #composer-request over ~2.5s. field_type
    // dispatches a real `input` event (harmless: it clears the composer's own error state visually).
    tMs: B1_REQUEST_TYPE_FROM,
    frame: {
      t: "field_type",
      target: "#composer-request",
      text: TRAILHEAD_REQUEST,
      fromMs: B1_REQUEST_TYPE_FROM,
      toMs: B1_REQUEST_TYPE_TO,
    },
  },
  {
    // OVERLAY (P5 #1) — the cursor RE-ANCHORS at the request field right after typing ends. This is the
    // fresh ORIGIN waypoint for the slow travel below: it guarantees projectCursorState's `from` is
    // #composer-request at the start-move (a real field→button TRAVEL, not a jump). Eases in place.
    tMs: B1_REQUEST_DWELL_MS,
    frame: { t: "cursor_move", target: "#composer-request", moveMs: 200 },
  },
  {
    // OVERLAY (P5 #1) — the cursor travels SLOWLY (B1_START_MOVE_DUR ~0.75s) from #composer-request to the
    // Start button, so the viewer can FOLLOW the move instead of seeing it jump.
    tMs: B1_START_MOVE_MS,
    frame: { t: "cursor_move", target: "#composer-start", moveMs: B1_START_MOVE_DUR },
  },
  {
    // OVERLAY (P5 #1) — pulse #composer-start once the cursor arrives: a DWELL (the tMs gap to the click)
    // so the viewer reads the button before the cosmetic press.
    tMs: B1_START_PULSE_FROM,
    frame: { t: "pulse", target: "#composer-start", fromMs: B1_START_PULSE_FROM, toMs: B1_START_PULSE_TO },
  },
  {
    // OVERLAY — a COSMETIC press on #composer-start (the real start() is forced to fail in the mock, so
    // we never trigger it; the close below is frame-driven).
    tMs: B1_START_CLICK_MS,
    frame: { t: "cursor_click", target: "#composer-start" },
  },
  {
    // OVERLAY — the composer CLOSES (frame-driven, NOT via the real start()). Backward scrub re-opens it.
    tMs: B1_COMPOSER_CLOSE_MS,
    frame: { t: "overlay_modal", kind: "composer", on: false },
  },
  {
    // seq 1 — the user's kickoff request now APPEARS as a chat bubble (the SAME text just typed into the
    // composer). The first conv node is a USER node, but it lands AFTER the composer beat (no pre-fill).
    tMs: B1_USER_MSG_MS,
    frame: { t: "user_message", seq: 1, text: TRAILHEAD_REQUEST },
  },
  {
    // OVERLAY — pulse the freshly-landed user bubble (by its data-seq) for ~1.8s. The bubble lives under
    // the player's conv pane, so the selector is `.mockanim-pane [data-seq="1"]`.
    tMs: B1_USER_PULSE_FROM,
    frame: {
      t: "pulse",
      target: '.mockanim-pane [data-seq="1"]',
      fromMs: B1_USER_PULSE_FROM,
      toMs: B1_USER_PULSE_TO,
    },
  },
  {
    // seq 2 — the assistant's reply (streams via revealMs 900). Targeted by the token-reveal test.
    tMs: B1_REPLY_MS,
    frame: {
      t: "conv",
      revealMs: 900,
      ev: {
        seq: 2,
        kind: "assistant_text",
        text: "Happy to. One quick question before I scope the codebase.",
        parent_tool_use_id: null,
      },
    },
  },

  // ================================================================================================
  // Chapter "Clarify" — Beat 1.5: intent-clarifier RUNNING beat (P4, #2)
  // ================================================================================================
  //
  // BEFORE the question card lands, the intent-clarifier agent is shown RUNNING — a small mirror of the
  // scope-recon group (Task + subagent_started label + atomic leaf tool pairs + an in-group summary + a
  // DEFERRED top-level Task tool_result that flips it done). So the viewer sees the clarifier scan the
  // codebase to ASK THE RIGHT QUESTION, instead of the card landing cold. Every leaf carries
  // parent_tool_use_id = CLARIFIER_TASK_ID and is ATOMIC (tool_use + tool_result share a tMs → no
  // lingering "running" leaf). SEQS ARE FRACTIONAL (2.1 … 2.9, strictly between the seq-2 reply and the
  // seq-3 question) so NOTHING downstream renumbers — the question stays seq 3 (QUESTION INVARIANT intact).
  {
    // seq 2.1 — a brief top-level reasoning line (streams via revealMs 800).
    tMs: B1B_LEAD_MS,
    frame: {
      t: "conv",
      revealMs: 800,
      ev: {
        seq: 2.1,
        kind: "assistant_text",
        text: "Let me quickly scan the codebase so I ask the right question…",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 2.2 — the Task tool_use launching the `intent-clarifier` subagent. Top-level (parent null); its
    // OWN result is DEFERRED to the group's end (so the Task SPANS the whole clarifier group).
    tMs: B1B_TASK_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.2,
        kind: "tool_use",
        id: CLARIFIER_TASK_ID,
        tool: "Task",
        input: {
          description: "Clarify intent before planning",
          subagent_type: "intent-clarifier",
          prompt:
            "Skim the Trailhead repo just enough to ask ONE high-leverage clarifying question before scoping: detect the target platform(s), the package manager, and any existing platform config so the question is grounded.",
        },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 2.3 — a `subagent_started` frame LABELS the group (header → "intent-clarifier"). Keyed by
    // tool_use_id = CLARIFIER_TASK_ID. Produces NO timeline node; it seeds the group metadata.
    tMs: B1B_TASK_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.3,
        kind: "subagent_started",
        tool_use_id: CLARIFIER_TASK_ID,
        subagent_type: "intent-clarifier",
        description: "Clarify intent before planning",
        prompt:
          "Skim the Trailhead repo just enough to ask ONE high-leverage clarifying question before scoping: detect the target platform(s), the package manager, and any existing platform config so the question is grounded.",
      },
    },
  },
  {
    // seq 2.4 — the clarifier's first words (INSIDE the group, parent = CLARIFIER_TASK_ID).
    tMs: B1B_FIRSTWORDS_MS,
    frame: {
      t: "conv",
      revealMs: 700,
      ev: {
        seq: 2.4,
        kind: "assistant_text",
        text: "Checking which platforms the project is already set up for…",
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.41 — LEAF Glob (inside the group, parent = CLARIFIER_TASK_ID). Atomic with its result (2.42).
    tMs: B1B_LEAF_START_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.41,
        kind: "tool_use",
        id: "toolu_th_ic_1",
        tool: "Glob",
        input: { pattern: "{android,ios}/**" },
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.42 — Glob result (SAME tMs = atomic; the leaf never lingers "running").
    tMs: B1B_LEAF_START_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.42,
        kind: "tool_result",
        tool_use_id: "toolu_th_ic_1",
        content: "android/app/build.gradle\nandroid/settings.gradle\n(no ios/ directory found)",
        is_error: false,
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.43 — LEAF Read (parent = CLARIFIER_TASK_ID). Atomic with its result (2.44).
    tMs: B1B_LEAF_START_MS + 1 * B1B_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.43,
        kind: "tool_use",
        id: "toolu_th_ic_2",
        tool: "Read",
        input: { file_path: "package.json" },
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.44 — Read result (SAME tMs = atomic).
    tMs: B1B_LEAF_START_MS + 1 * B1B_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.44,
        kind: "tool_result",
        tool_use_id: "toolu_th_ic_2",
        content: "{\n  \"name\": \"trailhead\",\n  \"scripts\": { \"android\": \"react-native run-android\" },\n  \"dependencies\": { \"react-native\": \"0.74.1\" }\n}",
        is_error: false,
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.45 — LEAF Grep (parent = CLARIFIER_TASK_ID). Atomic with its result (2.46).
    tMs: B1B_LEAF_START_MS + 2 * B1B_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.45,
        kind: "tool_use",
        id: "toolu_th_ic_3",
        tool: "Grep",
        input: { pattern: "Platform.OS", glob: "src/**/*.tsx" },
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.46 — Grep result (SAME tMs = atomic).
    tMs: B1B_LEAF_START_MS + 2 * B1B_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.46,
        kind: "tool_result",
        tool_use_id: "toolu_th_ic_3",
        content: "src/screens/MapScreen.tsx: const provider = Platform.OS === 'android' ? 'google' : 'apple';",
        is_error: false,
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.47 — LEAF Grep (parent = CLARIFIER_TASK_ID). Atomic with its result (2.48).
    tMs: B1B_LEAF_START_MS + 3 * B1B_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.47,
        kind: "tool_use",
        id: "toolu_th_ic_4",
        tool: "Grep",
        input: { pattern: "minSdkVersion", glob: "android/**/*.gradle" },
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.48 — Grep result (SAME tMs = atomic).
    tMs: B1B_LEAF_START_MS + 3 * B1B_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.48,
        kind: "tool_result",
        tool_use_id: "toolu_th_ic_4",
        content: "android/app/build.gradle: minSdkVersion 24",
        is_error: false,
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.85 — the clarifier's closing in-group summary (parent = CLARIFIER_TASK_ID).
    tMs: B1B_SUMMARY_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.85,
        kind: "assistant_text",
        text: "Only Android is wired up (no ios/ dir, an android run-script, minSdkVersion 24). I'll confirm the platform target with the user.",
        parent_tool_use_id: CLARIFIER_TASK_ID,
      },
    },
  },
  {
    // seq 2.9 — the clarifier Task's OWN DEFERRED tool_result. Top-level (parent null), tool_use_id =
    // CLARIFIER_TASK_ID → flips the spanning Task running→done (without it the Task row stays "running"
    // forever — the recursive no-stuck-tool invariant fails). Lands BEFORE the seq-3 question (tMs + seq).
    tMs: B1B_TASK_RESULT_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 2.9,
        kind: "tool_result",
        tool_use_id: CLARIFIER_TASK_ID,
        content:
          "Clarifier finding: the repo is Android-only today (no ios/ directory, an `android` run-script, minSdkVersion 24). Recommend asking the user which platform the first cut should target before scoping.",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },

  // ---- Beat 2: clarify — show the user ENTERING the Other answer --------------------------------
  {
    // seq 3 — an interactive AskUserQuestion permission request (the question card). While it is the
    // latest unresolved hold, derive() shows the WAITING_INPUT_LABEL working indicator.
    tMs: B2_QUESTION_MS,
    frame: {
      t: "question_request",
      ev: {
        seq: 3,
        kind: "tool_permission_requested",
        id: QUESTION_ID,
        tool: "AskUserQuestion",
        agent_id: null,
        input: {
          questions: [
            {
              question: PLATFORM_QUESTION,
              header: "Platform",
              multiSelect: false,
              options: [
                { label: "iOS", description: "Ship the iPhone build first; largest app-store reach." },
                { label: "Android", description: "Ship the Android build first; widest device spread." },
                { label: "Both", description: "Target both platforms in the first cut (more scope)." },
              ],
            },
          ],
        },
      },
    },
  },
  {
    // OVERLAY — pause+pulse the question card for ~2s so the viewer reads it before the answer is entered.
    tMs: B2_QUESTION_PULSE_FROM,
    frame: {
      t: "pulse",
      target: ".conv-question",
      fromMs: B2_QUESTION_PULSE_FROM,
      toMs: B2_QUESTION_PULSE_TO,
    },
  },
  {
    // OVERLAY — drive the ANSWER through the card's Other input: field_type into [data-other="text"].
    // The reconciler auto-checks the Other toggle when this selector has field text (setQuestionAnswerUI
    // from projectFieldText), un-hiding the real Other input — a pure fn of T that resets on back-scrub.
    tMs: B2_ANSWER_TYPE_FROM,
    frame: {
      t: "field_type",
      target: '[data-other="text"]',
      text: PLATFORM_ANSWER,
      fromMs: B2_ANSWER_TYPE_FROM,
      toMs: B2_ANSWER_TYPE_TO,
    },
  },
  {
    // OVERLAY (P5 #3) — the cursor RE-ANCHORS at the Other input right after the answer is typed. Without
    // this fresh origin the cursor's prior waypoint is the far-away #composer-start (Beat 1), so the
    // submit move would jump from across the screen. This pins `from` = [data-other="text"] for a real
    // field→button TRAVEL. Eases in place.
    tMs: B2_ANSWER_DWELL_MS,
    frame: { t: "cursor_move", target: '[data-other="text"]', moveMs: 200 },
  },
  {
    // OVERLAY (P5 #3) — the cursor travels SLOWLY (B2_SUBMIT_MOVE_DUR ~0.8s) from the Other input to the
    // question card's submit button, so the viewer can FOLLOW the move instead of seeing it jump.
    tMs: B2_SUBMIT_MOVE_MS,
    frame: { t: "cursor_move", target: ".conv-question-submit", moveMs: B2_SUBMIT_MOVE_DUR },
  },
  {
    // OVERLAY (P5 #3) — pulse .conv-question-submit once the cursor arrives: a DWELL (the tMs gap to the
    // click) so the viewer reads the submit button before the cosmetic press.
    tMs: B2_SUBMIT_PULSE_FROM,
    frame: { t: "pulse", target: ".conv-question-submit", fromMs: B2_SUBMIT_PULSE_FROM, toMs: B2_SUBMIT_PULSE_TO },
  },
  {
    // OVERLAY — a COSMETIC press on .conv-question-submit (the real submit is never dispatched; the fold
    // below is frame-driven).
    tMs: B2_SUBMIT_CLICK_MS,
    frame: { t: "cursor_click", target: ".conv-question-submit" },
  },
  {
    // seq 4 — the user's submitted answer (the SOURCE OF TRUTH for the fold). KEYED BY THE EXACT
    // `question` STRING (derive folds by it). The value matches NO option label → the "Other…" free-text
    // demonstration: derive sets the card's `answers` and the working indicator clears.
    tMs: B2_ANSWER_MS,
    frame: {
      t: "question_answered",
      id: QUESTION_ID,
      answers: { [PLATFORM_QUESTION]: PLATFORM_ANSWER },
      seq: 4,
    },
  },
  {
    // seq 5 — DEMO-AUTHORED echo: a standalone user bubble carrying the SAME free-text. Shares the
    // answer's tMs (they land together).
    tMs: B2_ANSWER_MS,
    frame: { t: "user_message", seq: 5, text: PLATFORM_ANSWER },
  },

  // ================================================================================================
  // Chapter "Scope recon" — Beat 3: ~20 atomic leaf tool pairs under the scope-recon Task
  // ================================================================================================
  //
  // The assistant launches a `scope-recon` SUBAGENT (a Task). A `subagent_started` frame LABELS the
  // group. Inside it the subagent runs ~20 LEAF tool pairs (Glob×3 / Read×8 / Grep×4 / Bash×3) plus two
  // intermediate in-group notes, EACH tool_use+tool_result pair sharing a tMs (atomic — no lingering
  // "running" leaf, so the no-stuck-tool invariant holds). The Task's OWN deferred tool_result lands at
  // the group's END, flipping the top-level Task running→done. All leaves carry parent_tool_use_id =
  // TASK_ID. File names/patterns are realistic for a React-Native trail app.
  {
    // seq 6 — the assistant acknowledges and starts scoping (streams via revealMs 1000).
    tMs: B3_ACK_MS,
    chapterLabel: "Scope recon",
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 6,
        kind: "assistant_text",
        text: "Got it — Android-first. Scoping the codebase now.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 7 — the Task tool_use that launches the `scope-recon` subagent. Top-level (parent null). Its
    // OWN result is DEFERRED to the group's end — so the Task SPANS the whole group.
    tMs: B3_TASK_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 7,
        kind: "tool_use",
        id: TASK_ID,
        tool: "Task",
        input: {
          description: "Scope the Trailhead source tree",
          subagent_type: "scope-recon",
          prompt:
            "Survey the Trailhead React-Native source: map the navigation layer, the screens, the components, and where trail data lives. Report a concise summary.",
        },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 8 — a `subagent_started` frame LABELS the group (header → "scope-recon"). Keyed by
    // tool_use_id = TASK_ID. Produces NO timeline node; it seeds the group metadata.
    tMs: B3_TASK_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 8,
        kind: "subagent_started",
        tool_use_id: TASK_ID,
        subagent_type: "scope-recon",
        description: "Scope the Trailhead source tree",
        prompt:
          "Survey the Trailhead React-Native source: map the navigation layer, the screens, the components, and where trail data lives. Report a concise summary.",
      },
    },
  },
  {
    // seq 9 — the subagent's first words (INSIDE the group, parent = TASK_ID).
    tMs: B3_FIRSTWORDS_MS,
    frame: {
      t: "conv",
      revealMs: 800,
      ev: {
        seq: 9,
        kind: "assistant_text",
        text: "Surveying the Trailhead source tree…",
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 10 — LEAF Glob (inside the group, parent = TASK_ID). Atomic with its result (seq 11).
    tMs: B3_LEAF_START_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 10,
        kind: "tool_use",
        id: "toolu_th_sr_10",
        tool: "Glob",
        input: { pattern: "src/screens/**/*.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 11 — Glob result (SAME tMs as seq 10 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 11,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_10",
        content: "src/screens/TrailListScreen.tsx\nsrc/screens/TrailDetailScreen.tsx\nsrc/screens/LogHikeScreen.tsx\nsrc/screens/MapScreen.tsx\nsrc/screens/SettingsScreen.tsx\nsrc/screens/ProfileScreen.tsx\nsrc/screens/SearchScreen.tsx\nsrc/screens/OnboardingScreen.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 12 — LEAF Glob (inside the group, parent = TASK_ID). Atomic with its result (seq 13).
    tMs: B3_LEAF_START_MS + 1 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 12,
        kind: "tool_use",
        id: "toolu_th_sr_12",
        tool: "Glob",
        input: { pattern: "src/navigation/**/*.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 13 — Glob result (SAME tMs as seq 12 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 1 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 13,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_12",
        content: "src/navigation/RootNavigator.tsx\nsrc/navigation/TabNavigator.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 14 — LEAF Glob (inside the group, parent = TASK_ID). Atomic with its result (seq 15).
    tMs: B3_LEAF_START_MS + 2 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 14,
        kind: "tool_use",
        id: "toolu_th_sr_14",
        tool: "Glob",
        input: { pattern: "src/components/**/*.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 15 — Glob result (SAME tMs as seq 14 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 2 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 15,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_14",
        content: "src/components/TrailCard.tsx\nsrc/components/DifficultyBadge.tsx\nsrc/components/ElevationSparkline.tsx\nsrc/components/SearchBar.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 16 — LEAF Glob (inside the group, parent = TASK_ID). Atomic with its result (seq 17).
    tMs: B3_LEAF_START_MS + 3 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 16,
        kind: "tool_use",
        id: "toolu_th_sr_16",
        tool: "Glob",
        input: { pattern: "src/data/**/*.{ts,json}" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 17 — Glob result (SAME tMs as seq 16 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 3 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 17,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_16",
        content: "src/data/TrailRepository.ts\nsrc/data/trails.json\nsrc/data/useTrails.ts",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 18 — INTERMEDIATE in-group note (parent = TASK_ID).
    tMs: B3_LEAF_START_MS + 4 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 18,
        kind: "assistant_text",
        text: "Navigation maps cleanly: a root native-stack wrapping a 4-tab bottom navigator.",
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 19 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 20).
    tMs: B3_LEAF_START_MS + 5 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 19,
        kind: "tool_use",
        id: "toolu_th_sr_19",
        tool: "Read",
        input: { file_path: "src/navigation/RootNavigator.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 20 — Read result (SAME tMs as seq 19 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 5 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 20,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_19",
        content: "import { createNativeStackNavigator } from '@react-navigation/native-stack';\n\nconst Stack = createNativeStackNavigator();\n\nexport function RootNavigator() {\n  return (\n    <Stack.Navigator>\n      <Stack.Screen name=\"Tabs\" component={TabNavigator} />\n      <Stack.Screen name=\"TrailDetail\" component={TrailDetailScreen} />\n    </Stack.Navigator>\n  );\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 21 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 22).
    tMs: B3_LEAF_START_MS + 6 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 21,
        kind: "tool_use",
        id: "toolu_th_sr_21",
        tool: "Read",
        input: { file_path: "src/navigation/TabNavigator.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 22 — Read result (SAME tMs as seq 21 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 6 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 22,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_21",
        content: "const Tab = createBottomTabNavigator();\n\nexport function TabNavigator() {\n  return (\n    <Tab.Navigator>\n      <Tab.Screen name=\"Trails\" component={TrailListScreen} />\n      <Tab.Screen name=\"Map\" component={MapScreen} />\n      <Tab.Screen name=\"Log\" component={LogHikeScreen} />\n      <Tab.Screen name=\"Profile\" component={ProfileScreen} />\n    </Tab.Navigator>\n  );\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 23 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 24).
    tMs: B3_LEAF_START_MS + 7 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 23,
        kind: "tool_use",
        id: "toolu_th_sr_23",
        tool: "Read",
        input: { file_path: "src/screens/TrailListScreen.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 24 — Read result (SAME tMs as seq 23 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 7 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 24,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_23",
        content: "export function TrailListScreen({ navigation }) {\n  const { trails } = useTrails();\n  return (\n    <FlatList\n      data={trails}\n      renderItem={({ item }) => <TrailCard trail={item} onPress={() => navigation.navigate('TrailDetail', { id: item.id })} />}\n    />\n  );\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 25 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 26).
    tMs: B3_LEAF_START_MS + 8 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 25,
        kind: "tool_use",
        id: "toolu_th_sr_25",
        tool: "Read",
        input: { file_path: "src/screens/TrailDetailScreen.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 26 — Read result (SAME tMs as seq 25 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 8 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 26,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_25",
        content: "export function TrailDetailScreen({ route }) {\n  const trail = useTrail(route.params.id);\n  // TODO: header + difficulty badge, elevation chart, reviews, save/share\n  return <ScrollView><Text>{trail.name}</Text></ScrollView>;\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 27 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 28).
    tMs: B3_LEAF_START_MS + 9 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 27,
        kind: "tool_use",
        id: "toolu_th_sr_27",
        tool: "Read",
        input: { file_path: "src/components/TrailCard.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 28 — Read result (SAME tMs as seq 27 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 9 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 28,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_27",
        content: "export function TrailCard({ trail, onPress }) {\n  return (\n    <Pressable onPress={onPress} style={styles.card}>\n      <Image source={{ uri: trail.thumb }} style={styles.thumb} />\n      <Text style={styles.title}>{trail.name}</Text>\n      <Text style={styles.meta}>{trail.distance} mi · {trail.gain} ft</Text>\n    </Pressable>\n  );\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 29 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 30).
    tMs: B3_LEAF_START_MS + 10 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 29,
        kind: "tool_use",
        id: "toolu_th_sr_29",
        tool: "Read",
        input: { file_path: "src/components/DifficultyBadge.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 30 — Read result (SAME tMs as seq 29 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 10 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 30,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_29",
        content: "export function DifficultyBadge({ level }) {\n  const color = DIFFICULTY_COLORS[level];\n  return <View style={[styles.badge, { backgroundColor: color }]}><Text>{level}</Text></View>;\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 31 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 32).
    tMs: B3_LEAF_START_MS + 11 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 31,
        kind: "tool_use",
        id: "toolu_th_sr_31",
        tool: "Read",
        input: { file_path: "src/data/TrailRepository.ts" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 32 — Read result (SAME tMs as seq 31 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 11 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 32,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_31",
        content: "export class TrailRepository {\n  async list(): Promise<Trail[]> { return seed; }\n  async byId(id: string): Promise<Trail> { return seed.find((t) => t.id === id)!; }\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 33 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 34).
    tMs: B3_LEAF_START_MS + 12 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 33,
        kind: "tool_use",
        id: "toolu_th_sr_33",
        tool: "Read",
        input: { file_path: "src/data/useTrails.ts" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 34 — Read result (SAME tMs as seq 33 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 12 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 34,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_33",
        content: "export function useTrails() {\n  const [trails, setTrails] = useState<Trail[]>([]);\n  useEffect(() => { repo.list().then(setTrails); }, []);\n  return { trails };\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 35 — LEAF Read (inside the group, parent = TASK_ID). Atomic with its result (seq 36).
    tMs: B3_LEAF_START_MS + 13 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 35,
        kind: "tool_use",
        id: "toolu_th_sr_35",
        tool: "Read",
        input: { file_path: "src/data/trails.json" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 36 — Read result (SAME tMs as seq 35 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 13 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 36,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_35",
        content: "[{ \"id\": \"eagle-ridge\", \"name\": \"Eagle Ridge Loop\", \"distance\": 5.2, \"gain\": 1200, \"difficulty\": \"moderate\" }]",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 37 — INTERMEDIATE in-group note (parent = TASK_ID).
    tMs: B3_LEAF_START_MS + 14 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 37,
        kind: "assistant_text",
        text: "Trail data flows TrailRepository → useTrails → TrailListScreen → TrailCard; difficulty palette is shared.",
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 38 — LEAF Grep (inside the group, parent = TASK_ID). Atomic with its result (seq 39).
    tMs: B3_LEAF_START_MS + 15 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 38,
        kind: "tool_use",
        id: "toolu_th_sr_38",
        tool: "Grep",
        input: { pattern: "createNativeStackNavigator", output_mode: "files_with_matches" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 39 — Grep result (SAME tMs as seq 38 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 15 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 39,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_38",
        content: "src/navigation/RootNavigator.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 40 — LEAF Grep (inside the group, parent = TASK_ID). Atomic with its result (seq 41).
    tMs: B3_LEAF_START_MS + 16 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 40,
        kind: "tool_use",
        id: "toolu_th_sr_40",
        tool: "Grep",
        input: { pattern: "useTrails", output_mode: "files_with_matches" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 41 — Grep result (SAME tMs as seq 40 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 16 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 41,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_40",
        content: "src/screens/TrailListScreen.tsx\nsrc/data/useTrails.ts",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 42 — LEAF Grep (inside the group, parent = TASK_ID). Atomic with its result (seq 43).
    tMs: B3_LEAF_START_MS + 17 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 42,
        kind: "tool_use",
        id: "toolu_th_sr_42",
        tool: "Grep",
        input: { pattern: "DIFFICULTY_COLORS", output_mode: "files_with_matches" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 43 — Grep result (SAME tMs as seq 42 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 17 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 43,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_42",
        content: "src/components/DifficultyBadge.tsx\nsrc/theme/difficulty.ts",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 44 — LEAF Grep (inside the group, parent = TASK_ID). Atomic with its result (seq 45).
    tMs: B3_LEAF_START_MS + 18 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 44,
        kind: "tool_use",
        id: "toolu_th_sr_44",
        tool: "Grep",
        input: { pattern: "difficulty", output_mode: "files_with_matches" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 45 — Grep result (SAME tMs as seq 44 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 18 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 45,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_44",
        content: "src/components/DifficultyBadge.tsx\nsrc/data/trails.json\nsrc/theme/difficulty.ts",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 46 — LEAF Bash (inside the group, parent = TASK_ID). Atomic with its result (seq 47).
    tMs: B3_LEAF_START_MS + 19 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 46,
        kind: "tool_use",
        id: "toolu_th_sr_46",
        tool: "Bash",
        input: { command: "ls src/screens" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 47 — Bash result (SAME tMs as seq 46 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 19 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 47,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_46",
        content: "LogHikeScreen.tsx\nMapScreen.tsx\nOnboardingScreen.tsx\nProfileScreen.tsx\nSearchScreen.tsx\nSettingsScreen.tsx\nTrailDetailScreen.tsx\nTrailListScreen.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 48 — LEAF Bash (inside the group, parent = TASK_ID). Atomic with its result (seq 49).
    tMs: B3_LEAF_START_MS + 20 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 48,
        kind: "tool_use",
        id: "toolu_th_sr_48",
        tool: "Bash",
        input: { command: "ls src/data" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 49 — Bash result (SAME tMs as seq 48 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 20 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 49,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_48",
        content: "TrailRepository.ts\ntrails.json\nuseTrails.ts",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 50 — LEAF Bash (inside the group, parent = TASK_ID). Atomic with its result (seq 51).
    tMs: B3_LEAF_START_MS + 21 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 50,
        kind: "tool_use",
        id: "toolu_th_sr_50",
        tool: "Bash",
        input: { command: "wc -l src/screens/TrailDetailScreen.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 51 — Bash result (SAME tMs as seq 50 = atomic; the leaf never lingers "running").
    tMs: B3_LEAF_START_MS + 21 * B3_LEAF_STEP_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 51,
        kind: "tool_result",
        tool_use_id: "toolu_th_sr_50",
        content: "9 src/screens/TrailDetailScreen.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 52 — the subagent's closing summary text (inside the group).
    tMs: B3_SUMMARY_MS,
    frame: {
      t: "conv",
      revealMs: 1200,
      ev: {
        seq: 52,
        kind: "assistant_text",
        text:
          "Mapped it: native-stack navigation in src/navigation, eight screens in src/screens, shared UI in src/components, and trail data in src/data (TrailRepository + the trails seed).",
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 53 — the Task's OWN tool_result (top-level, tool_use_id = TASK_ID). LOAD-BEARING: this is what
    // flips the top-level Task tool node running→done. WITHOUT it the Task row stays status:"running" at
    // T = duration and the no-stuck-tool invariant fails. (The Task is the ONLY non-atomic tool.)
    tMs: B3_TASK_RESULT_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 53,
        kind: "tool_result",
        tool_use_id: TASK_ID,
        content:
          "Scope recon complete. Navigation: native-stack in src/navigation (RootNavigator + TabNavigator). Screens: eight under src/screens. Components: TrailCard, DifficultyBadge, ElevationSparkline in src/components. Trail data: src/data (TrailRepository + trails.json seed + the useTrails hook).",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 54 — the assistant's top-level wrap-up (streams via revealMs 1000).
    tMs: B3_WRAPUP_MS,
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 54,
        kind: "assistant_text",
        text: "Scope recon complete — I have what I need to right-size the plan.",
        parent_tool_use_id: null,
      },
    },
  },

  // ================================================================================================
  // Chapter "Plan sizer" — Beat 4 (NEW): the right-sizing gate before the plan is drafted
  // ================================================================================================
  //
  // Between scope-recon and the drafted plan the assistant runs a `plan-sizer` Task whose result returns
  // the split decision ("master + 3 subplans; subplan 04 decomposed into 4 leaves"). The Task's tool_use
  // and tool_result share a tMs (ATOMIC — no lingering running leaf, so the no-stuck-tool invariant
  // holds). A brief pulse draws the eye to the plan-sizer row.
  {
    // seq 55 — short narration announcing the right-sizing gate (streams via revealMs 900).
    tMs: B4_NARRATION_MS,
    chapterLabel: "Plan sizer",
    frame: {
      t: "conv",
      revealMs: 900,
      ev: {
        seq: 55,
        kind: "assistant_text",
        text: "Before drafting, I'll right-size the work so each plan stays focused.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 56 — the plan-sizer Task tool_use (top-level). Its `input` describes the right-sizing decision.
    // ATOMIC with its result (seq 57, SAME tMs) — the plan-sizer is a quick gate, not a spanning group.
    tMs: B4_SIZER_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 56,
        kind: "tool_use",
        id: PLAN_SIZER_ID,
        tool: "Task",
        input: {
          description: "Right-size the Trailhead plan",
          subagent_type: "plan-sizer",
          prompt:
            "Given the scope-recon report (navigation, eight screens, shared components, trail data), decide whether to draft a single plan or split into a master + subplans. Decompose any screen that is itself multi-part.",
        },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 57 — the plan-sizer's tool_result (ATOMIC with seq 56). Returns the SPLIT DECISION verbatim.
    tMs: B4_SIZER_MS,
    frame: {
      t: "conv",
      ev: {
        seq: 57,
        kind: "tool_result",
        tool_use_id: PLAN_SIZER_ID,
        content:
          "Right-sizing decision: SPLIT. Master + 3 subplans (01 navigation, 02 data layer, 03 trail list). Subplan 04 (trail detail) decomposed into 4 leaves: 04.01 header + difficulty badge, 04.02 elevation chart, 04.03 reviews, 04.04 save/share.",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },
  {
    // OVERLAY — a brief pulse on the plan-sizer Task row (by its data-seq) so the gate reads as deliberate.
    tMs: B4_SIZER_PULSE_FROM,
    frame: {
      t: "pulse",
      target: '.mockanim-pane [data-seq="56"]',
      fromMs: B4_SIZER_PULSE_FROM,
      toMs: B4_SIZER_PULSE_TO,
    },
  },
  {
    // seq 58 — the assistant narrates the split outcome (streams via revealMs 1000).
    tMs: B4_OUTCOME_MS,
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 58,
        kind: "assistant_text",
        text:
          "Right-sized: a master with three subplans, and the trail-detail screen split into four leaves (including that difficulty badge).",
        parent_tool_use_id: null,
      },
    },
  },
  // ---- Chapter "Prototype review" (P4: the scripted prototype ACT) -----------------------------
  //
  // The assistant narrates a visual prototype; the storyboard then PLAYS the act: pulse the narration
  // bubble (a ~2s read), show the ROUND-1 trail card INLINE in #reading-pane (exactly as the real app
  // does — main.ts's renderPrototypePreview composes the ASCII trail card via composePreviewMarkdown,
  // NOT a floating overlay) + pulse the pane, TYPE the feedback into #prototype-feedback over ~2.5s,
  // cosmetic-click #review-submit, MORPH to the ROUND-2 card (difficulty badge, driven by prototype_gate
  // round:2) + pulse it, then cosmetic-click #review-approve. The card round is DERIVED from the
  // prototype_gate projection (renderPrototypePreview re-fires per round), so the round-2 gate frame is
  // what re-renders the badged card — no separate card signal. All clicks are COSMETIC (the named state
  // change is frame-driven); the gate drives the inline preview + the review bar.
  {
    // seq 59 — the assistant narrates the visual prototype (streams via revealMs 700). Conversation tab.
    tMs: PROTO_NARR_MS,
    chapterLabel: "Prototype review",
    frame: {
      t: "conv",
      revealMs: 700,
      ev: {
        seq: 59,
        kind: "assistant_text",
        text:
          "Before I build the trail-detail screen, let me validate its core UI with you — the trail card. " +
          "Here's a quick HTML prototype of the Eagle Peak Loop card, opening in the pane now →",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // SURFACE — open the prototype-preview plan in the reading pane (OPENING edge of the bracket: a plan
    // being open makes activeTab="plan"). This doc IS the inline ASCII trail card (PROTO_PREVIEW_DOC,
    // byte-identical to composePreviewMarkdown's round-1 output) so the pane is coherent the instant it
    // opens, regardless of the two-writer race with renderPrototypePreview. (Ordered before the narration
    // pulse below so the array stays tMs-monotonic: PROTO_OPEN_MS < PROTO_NARR_PULSE_FROM.)
    tMs: PROTO_OPEN_MS,
    frame: { t: "open_plan", path: PROTO_PREVIEW_PATH },
  },
  {
    // SURFACE — the prototype gate turns ON (round 1): the review bar lights up AND main.ts's
    // renderPrototypePreview composes the ROUND-1 trail card INLINE into #reading-pane (the real app's
    // inline-preview path).
    tMs: PROTO_OPEN_MS,
    frame: { t: "prototype_gate", on: true, round: 1 },
  },
  {
    // OVERLAY — pulse the narration bubble (by its data-seq) for ~2s: a real DWELL so the viewer reads it
    // (the card has just appeared on the Plan side). The bubble lives under the player pane →
    // `.mockanim-pane [data-seq="59"]`.
    tMs: PROTO_NARR_PULSE_FROM,
    frame: {
      t: "pulse",
      target: '.mockanim-pane [data-seq="59"]',
      fromMs: PROTO_NARR_PULSE_FROM,
      toMs: PROTO_NARR_PULSE_TO,
    },
  },
  {
    // OVERLAY — pulse the reading pane (the inline round-1 card) for ~2s so the viewer takes it in.
    tMs: PROTO_CARD1_PULSE_FROM,
    frame: { t: "pulse", target: "#reading-pane", fromMs: PROTO_CARD1_PULSE_FROM, toMs: PROTO_CARD1_PULSE_TO },
  },
  {
    // OVERLAY — the cursor travels to the inline feedback textarea (visible while the gate is on).
    tMs: PROTO_FEEDBACK_MOVE_MS,
    frame: { t: "cursor_move", target: "#prototype-feedback", moveMs: 500 },
  },
  {
    // OVERLAY — the user TYPES the feedback into #prototype-feedback over ~2.5s. field_type dispatches a
    // real `input` event, which (harmlessly + faithfully) enables #review-submit ("Request changes").
    tMs: PROTO_FEEDBACK_TYPE_FROM,
    frame: {
      t: "field_type",
      target: "#prototype-feedback",
      text: TRAILHEAD_PROTO_FEEDBACK,
      fromMs: PROTO_FEEDBACK_TYPE_FROM,
      toMs: PROTO_FEEDBACK_TYPE_TO,
    },
  },
  {
    // OVERLAY — pulse #prototype-feedback across the typing window (draws the eye to the field being typed).
    tMs: PROTO_FEEDBACK_TYPE_FROM,
    frame: { t: "pulse", target: "#prototype-feedback", fromMs: PROTO_FEEDBACK_TYPE_FROM, toMs: PROTO_FEEDBACK_TYPE_TO },
  },
  {
    // OVERLAY — the cursor travels to the "Request changes" button (#review-submit).
    tMs: PROTO_SUBMIT_MOVE_MS,
    frame: { t: "cursor_move", target: "#review-submit", moveMs: 300 },
  },
  {
    // OVERLAY — a COSMETIC press on #review-submit (the real refine handler is never triggered; the card
    // morph below is frame-driven via the round-2 gate).
    tMs: PROTO_SUBMIT_CLICK_MS,
    frame: { t: "cursor_click", target: "#review-submit" },
  },
  {
    // SURFACE — the gate ADVANCES to round 2: reconcileGate re-emits at the new round AND main.ts's
    // renderPrototypePreview re-composes the inline card with the round-2 ASCII (the green "Moderate"
    // difficulty badge line). This is the on-screen result of the typed feedback (frame-driven, the
    // #review-submit click above being cosmetic).
    tMs: PROTO_ROUND2_MS,
    frame: { t: "prototype_gate", on: true, round: 2 },
  },
  {
    // OVERLAY — pulse the reading pane (the morphed round-2 inline card) for ~2s: register the change.
    tMs: PROTO_CARD2_PULSE_FROM,
    frame: { t: "pulse", target: "#reading-pane", fromMs: PROTO_CARD2_PULSE_FROM, toMs: PROTO_CARD2_PULSE_TO },
  },
  {
    // OVERLAY (P5 #10) — pulse the "Approve visual" button (#review-approve) so the review-bar buttons
    // read clearly BEFORE and THROUGH the slow cursor travel (up to the click). Draws the viewer's eye to
    // where the cursor is heading.
    tMs: PROTO_APPROVE_PULSE_FROM,
    frame: { t: "pulse", target: "#review-approve", fromMs: PROTO_APPROVE_PULSE_FROM, toMs: PROTO_APPROVE_PULSE_TO },
  },
  {
    // OVERLAY (P5 #10) — the cursor RE-ANCHORS at the feedback field. Without this fresh origin the
    // cursor's prior waypoint is #review-submit (the round-1 cosmetic click), so the move to Approve would
    // barely travel. Re-anchoring at #prototype-feedback makes the approve move a real, legible TRAVEL
    // across the review bar (from = #prototype-feedback → to = #review-approve). Eases in place.
    tMs: PROTO_APPROVE_ORIGIN_MS,
    frame: { t: "cursor_move", target: "#prototype-feedback", moveMs: 200 },
  },
  {
    // OVERLAY (P5 #10) — the cursor travels SLOWLY (PROTO_APPROVE_MOVE_DUR ~0.75s) from the feedback field
    // to the "Approve visual" button (#review-approve), so the viewer can FOLLOW the move (not a jump).
    tMs: PROTO_APPROVE_MOVE_MS,
    frame: { t: "cursor_move", target: "#review-approve", moveMs: PROTO_APPROVE_MOVE_DUR },
  },
  {
    // OVERLAY — a COSMETIC press on #review-approve (the real approve handler is never triggered; the
    // gate-off + pane-close below are frame-driven). Lands after a brief dwell (the cursor rested under
    // the #review-approve pulse since PROTO_APPROVE_MOVE_DUR completed).
    tMs: PROTO_APPROVE_CLICK_MS,
    frame: { t: "cursor_click", target: "#review-approve" },
  },
  {
    // SURFACE — the gate turns OFF (closing edge): the review bar reverts and the inline preview clears
    // when the pane closes below (open_plan{null}).
    tMs: PROTO_CLOSE_MS,
    frame: { t: "prototype_gate", on: false },
  },
  {
    // SURFACE — close the reading pane (open_plan{null}). CLOSING edge of the bracket: activeTab flips
    // back to "conversation" so the feedback/approval bubbles below are visible.
    tMs: PROTO_CLOSE_MS,
    frame: { t: "open_plan", path: null },
  },
  {
    // seq 60 — the user's feedback now appears as a chat bubble (the SAME text just typed into
    // #prototype-feedback). Lands with the approval echo below.
    tMs: PROTO_FEEDBACK_MS,
    frame: {
      t: "user_message",
      seq: 60,
      text: TRAILHEAD_PROTO_FEEDBACK,
    },
  },
  {
    // seq 61 — DEMO-AUTHORED approval echo: a system bubble standing in for the review bar's Approve
    // click (in the real app clicking "Approve visual" resolves the gate; this echo shows it as a chat row).
    tMs: PROTO_FEEDBACK_MS,
    frame: {
      t: "system_message",
      seq: 61,
      text: "Prototype approved with feedback — folding the changes into the plan.",
    },
  },
  {
    // seq 62 — the assistant acknowledges the feedback (streams via revealMs 1000).
    tMs: PROTO_ACK_MS,
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 62,
        kind: "assistant_text",
        text: "On it — larger trail cards and a difficulty badge. Drafting the plan now.",
        parent_tool_use_id: null,
      },
    },
  },
];

// ---- (P1) PROGRESSIVE PLAN-TREE SNAPSHOTS — the sidebar grows ONE node at a time ----------------
//
// Phase 1 conveys progression by NODE APPEARANCE (the real sidebar has no queued/active/done node
// styling — PlanRecord is a frozen wire contract). So instead of injecting the whole TRAILHEAD_PLANS
// tree at once, the storyboard emits a SEQUENCE of `plan_changed` snapshots, each a FULL, PRE-ORDERED
// `PlanRecord[]` = the tree grown SO FAR. The growth is derived from TRAILHEAD_PLANS by FILTERING it
// (preserving its master-first, parent-before-child pre-order) down to the nn_paths revealed so far —
// so EVERY snapshot is master-first and parent-before-child and can NEVER trip the sidebar orphan-row
// path (main.ts renderSidebar: a sub whose master/dotted-parent isn't already present logs an orphan).
//
// The master (nn_path null) is ALWAYS present (it is revealed first, alone, in the Nested-plan chapter
// via TREE_MASTER_ONLY). `treeThrough(revealedPaths)` returns master + every TRAILHEAD_PLANS row whose
// nn_path is in `revealedPaths`, in TRAILHEAD_PLANS pre-order. Because the slice always respects that
// pre-order, including a 04.0x leaf REQUIRES its 04 parent be in `revealedPaths` too (the per-subplan
// snapshots in buildExecution add "04" at 04.01's turn — see each ExecSubplan.reveals).

// The master row alone — the FIRST sidebar reveal (Nested-plan chapter). child_count 4 ⇒ renders as a
// master with an (empty until populated) children container. Pre-ordered (single master, no orphans).
const TREE_MASTER_ONLY: PlanRecord[] = TRAILHEAD_PLANS.filter((p) => p.flavor === "master");

// PURE: the full pre-ordered tree grown to include the master + every row whose nn_path is in
// `revealedPaths`. Filters TRAILHEAD_PLANS (which is already master-first, parent-before-child) so the
// result preserves that pre-order — master-first, every parent before its children. Never re-orders.
function treeThrough(revealedPaths: ReadonlySet<string>): PlanRecord[] {
  return TRAILHEAD_PLANS.filter((p) => p.flavor === "master" || (p.nn_path !== null && revealedPaths.has(p.nn_path)));
}

// ---- DOWNSTREAM (P4-shifted): nested plan … comment & iterate … execution … terminal ------------
//
// These chapters keep their ORIGINAL shape + seqs but are shifted by + PROTO_ACT_SHIFT in tMs (the P4
// prototype ACT above is longer than the original instant feedback). The shift is applied PROGRAMMATICALLY
// by the .map at the bottom (never hand-edited literals) — exactly the named-constant discipline P3 used
// for EXEC_SHIFT, extended one level. Every tMs literal below is written at its pre-PROTO_ACT_SHIFT value
// (= old + EXEC_SHIFT); the .map adds PROTO_ACT_SHIFT so the tests can pin `old + EXEC_SHIFT + PROTO_ACT_SHIFT`.
const DOWNSTREAM_AFTER_PROTOTYPE: StoryFrame[] = [
  // ---- Chapter "Nested plan" -------------------------------------------------------------------
  {
    // seq 25 — the assistant announces the drafted plan tree (streams via revealMs ~1200). This bubble
    // lives on the Conversation tab and narrates the nested plan the storyboard is about to reveal in
    // the sidebar (plan_changed below) + open in the reading pane (open_plan below).
    tMs: 45800,
    chapterLabel: "Nested plan",
    frame: {
      t: "conv",
      revealMs: 1200,
      ev: {
        seq: 63,
        kind: "assistant_text",
        text:
          "Here's the plan — a master with three subplans, plus a decomposition of the trail-detail screen into four leaves (including that difficulty badge you asked for).",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // SURFACE — (P1) ONLY the MASTER row pops into the (until-now empty) sidebar — NOT the whole tree.
    // The drafted subplan rows appear ONE AT A TIME later, during the progressive Execution chapter (each
    // subplan's row materializes at its turn). projectSurfaceState takes the last-≤-T plan_changed, so for
    // any T in [0, 19800+shift) the sidebar is [] and for T ≥ that it is the master alone (TREE_MASTER_ONLY)
    // until the Execution chapter grows it. The master carries child_count 4 so it renders as a master with
    // an (empty until populated) children container — pre-ordered, never tripping the sidebar orphan path.
    tMs: 46600,
    frame: { t: "plan_changed", plans: TREE_MASTER_ONLY },
  },
  {
    // SURFACE — open the master plan in the reading pane. LEFT OPEN (no closing open_plan{null}): the
    // beat ENDS on the still-open master, so activeTab stays "plan" and the master doc + its mermaid
    // decomposition diagram remain on screen at duration. Slice 06 comments on this still-open plan.
    tMs: 47000,
    frame: { t: "open_plan", path: TRAILHEAD_MASTER_PATH },
  },

  // ---- (c4) Contents-tab ToC navigation beat ---------------------------------------------------
  //
  // Before the user comments, the demo NAVIGATES the plan's table of contents (review2 c4): click the
  // SIDEBAR "Contents" tab → the ToC (built from the open master by the real extractToc→buildToc, via
  // the player's TOC-populate seam) shows; click a LOW ToC entry → the reading pane scrolls way down;
  // click the "Context" ToC entry → it scrolls back to the top. The cursor visibly TARGETS the real
  // `.toc-item` / tab elements; the scroll itself is the PURE `scroll` primitive (projectScroll, lerped,
  // scrub-revertable) over #reader-scroll. The two scroll windows DO NOT overlap (last-window-wins), so
  // down then up read as distinct beats. Finally the Plans tab is restored before commenting begins.
  {
    // OVERLAY — the cursor travels to the sidebar "Contents" tab.
    tMs: C4_CONTENTS_TAB_MOVE_MS,
    chapterLabel: "Review the plan",
    frame: { t: "cursor_move", target: C4_CONTENTS_TAB_SELECTOR, moveMs: 600 },
  },
  {
    // OVERLAY — pulse the Contents tab as the cursor arrives, through the click.
    tMs: C4_CONTENTS_TAB_PULSE_FROM,
    frame: { t: "pulse", target: C4_CONTENTS_TAB_SELECTOR, fromMs: C4_CONTENTS_TAB_PULSE_FROM, toMs: C4_CONTENTS_TAB_PULSE_TO },
  },
  {
    // OVERLAY — a cosmetic press on the Contents tab.
    tMs: C4_CONTENTS_TAB_CLICK_MS,
    frame: { t: "cursor_click", target: C4_CONTENTS_TAB_SELECTOR },
  },
  {
    // OVERLAY — switch the SIDEBAR to the Contents tab (the real initTabs switch, via setSidebarTab) so
    // the ToC built from the open master shows. Lands WITH the click so the reveal reads as its result.
    tMs: C4_CONTENTS_TAB_SWITCH_MS,
    frame: { t: "sidebar_tab", tab: "contents" },
  },
  {
    // OVERLAY — the cursor travels to a LOW ToC entry (the master's last heading, "Decomposition").
    tMs: C4_TOC_DOWN_MOVE_MS,
    frame: { t: "cursor_move", target: C4_TOC_LOW_SELECTOR, moveMs: 600 },
  },
  {
    // OVERLAY — pulse the low ToC entry as the cursor arrives, through the click.
    tMs: C4_TOC_DOWN_PULSE_FROM,
    frame: { t: "pulse", target: C4_TOC_LOW_SELECTOR, fromMs: C4_TOC_DOWN_PULSE_FROM, toMs: C4_TOC_DOWN_PULSE_TO },
  },
  {
    // OVERLAY — a cosmetic press on the low ToC entry.
    tMs: C4_TOC_DOWN_CLICK_MS,
    frame: { t: "cursor_click", target: C4_TOC_LOW_SELECTOR },
  },
  {
    // OVERLAY — the reading pane SCROLLS DOWN to the bottom over ~2.4s (paired with the low-entry click).
    tMs: C4_SCROLL_DOWN_FROM,
    frame: {
      t: "scroll",
      target: SCROLL_TARGET,
      fromFrac: 0,
      toFrac: 1,
      fromMs: C4_SCROLL_DOWN_FROM,
      toMs: C4_SCROLL_DOWN_TO,
    },
  },
  {
    // OVERLAY — the cursor travels to the "Context" ToC entry (after a brief dwell at the bottom).
    tMs: C4_TOC_CONTEXT_MOVE_MS,
    frame: { t: "cursor_move", target: C4_TOC_CONTEXT_SELECTOR, moveMs: 600 },
  },
  {
    // OVERLAY — pulse the "Context" ToC entry as the cursor arrives, through the click.
    tMs: C4_TOC_CONTEXT_PULSE_FROM,
    frame: { t: "pulse", target: C4_TOC_CONTEXT_SELECTOR, fromMs: C4_TOC_CONTEXT_PULSE_FROM, toMs: C4_TOC_CONTEXT_PULSE_TO },
  },
  {
    // OVERLAY — a cosmetic press on the "Context" ToC entry.
    tMs: C4_TOC_CONTEXT_CLICK_MS,
    frame: { t: "cursor_click", target: C4_TOC_CONTEXT_SELECTOR },
  },
  {
    // OVERLAY — the reading pane SCROLLS BACK UP to the top over ~2.4s (paired with the Context click).
    // This window starts AT C4_SCROLL_DOWN_TO + dwell — strictly AFTER the down window ends (no overlap).
    tMs: C4_SCROLL_UP_FROM,
    frame: {
      t: "scroll",
      target: SCROLL_TARGET,
      fromFrac: 1,
      toFrac: 0,
      fromMs: C4_SCROLL_UP_FROM,
      toMs: C4_SCROLL_UP_TO,
    },
  },
  {
    // OVERLAY — the cursor travels to the sidebar "Plans" tab to restore the plan list before commenting.
    tMs: C4_PLANS_TAB_MOVE_MS,
    frame: { t: "cursor_move", target: C4_PLANS_TAB_SELECTOR, moveMs: 600 },
  },
  {
    // OVERLAY — a cosmetic press on the Plans tab.
    tMs: C4_PLANS_TAB_CLICK_MS,
    frame: { t: "cursor_click", target: C4_PLANS_TAB_SELECTOR },
  },
  {
    // OVERLAY — restore the SIDEBAR Plans tab (the comments anchor reading-pane blocks; the sidebar
    // shows the plan list again). The reader Plan tab is unchanged (the master stays open).
    tMs: C4_PLANS_TAB_SWITCH_MS,
    frame: { t: "sidebar_tab", tab: "plans" },
  },
];

// ---- (c4) The comment-and-iterate chapter — pushed an EXTRA + C4_SHIFT later ---------------------
//
// Authored at its ORIGINAL literals (continuing the EXEC_SHIFT scheme); the splice loop adds
// PROTO_ACT_SHIFT + CLARIFIER_SHIFT + C4_SHIFT to every frame here. Split OUT of DOWNSTREAM_AFTER_PROTOTYPE
// (which now ends at the c4 Plans-restore) so the c4 beat and the comment chapter get DIFFERENT shifts
// cleanly — a per-array push, not a literal-tMs boundary (the c4 beat's tail literal exceeds the first
// comment's literal, so a single tMs threshold could not separate them).
const COMMENT_AND_V2: StoryFrame[] = [
  // ---- Chapter "Comment & iterate" (P2: every comment gets a full popover ACT) ------------------
  //
  // The master (TRAILHEAD_MASTER_PATH) is still open on the Plan tab. The user now leaves THREE comments
  // on it — and (P2) the demo SCRIPTS a full act for EACH (c1, c2, c3): the target block is EMPHASIZED
  // (a pulse on the block), the cursor moves to it, the selection popover opens under it (#sel-popover,
  // driven by overlay_modal{popover,on,target} — the reconciler is its exclusive writer, setting
  // #sp-quote + positioning it), the popover is pulsed, the comment is TYPED into #sp-text, a cosmetic
  // #sp-save click lands, the popover closes, and THEN the `set_comments` SurfaceFrame paints the
  // persisted `.cmt-hl` highlight (the SOLE source of truth — the real #sp-save handler stays inert).
  // The comment SET grows 1 → 2 → 3. HIGHLIGHTS-ONLY: no pending_reviews frame (driving the review bar
  // would auto-open + wipe highlights).
  //
  // The popover anchor selectors are stable reading-pane blocks by `data-source-line` (the V1 master's
  // Context paragraph = line 4 carries BOTH c1's and c2's quotes; the closing paragraph = line 53 carries
  // c3's quote). c1 + c2 share the Context block; c3 anchors the distinct closing block.

  // ---- Comment 1 act (anchors to the Context paragraph, data-source-line="4") ----
  {
    // OVERLAY — EMPHASIZE the target block before typing (pulse the Context block ~1s). The chapter
    // label moves here (the c4 navigation beat above carries the "Review the plan" label).
    tMs: 56200,
    chapterLabel: "Comment & iterate",
    frame: { t: "pulse", target: '#reading-pane [data-source-line="4"]', fromMs: 56200, toMs: 57200 },
  },
  {
    // OVERLAY — the cursor travels to the Context block (carries c1's quote).
    tMs: 56400,
    frame: { t: "cursor_move", target: '#reading-pane [data-source-line="4"]', moveMs: 400 },
  },
  {
    // OVERLAY — the selection popover opens UNDER that block (reconciler shows #sel-popover, sets
    // #sp-quote from the block text, positions it). Backward scrub closes it (last-≤-T per kind).
    tMs: 56800,
    frame: { t: "overlay_modal", kind: "popover", on: true, target: '#reading-pane [data-source-line="4"]' },
  },
  {
    // OVERLAY — pulse the open popover (~1s).
    tMs: 57000,
    frame: { t: "pulse", target: "#sel-popover", fromMs: 57000, toMs: 58200 },
  },
  {
    // OVERLAY — TYPE the comment into #sp-text over ~1.8s (the popover's textarea).
    tMs: 57200,
    frame: { t: "field_type", target: "#sp-text", text: TRAILHEAD_COMMENT_1.comment, fromMs: 57200, toMs: 59000 },
  },
  {
    // OVERLAY — the cursor travels to the popover's save button.
    tMs: 59100,
    frame: { t: "cursor_move", target: "#sp-save", moveMs: 300 },
  },
  {
    // OVERLAY — a COSMETIC press on #sp-save (the real handler is inert; the highlight is painted by the
    // set_comments below, the SOLE source of truth).
    tMs: 59400,
    frame: { t: "cursor_click", target: "#sp-save" },
  },
  {
    // OVERLAY — the popover closes (frame-driven).
    tMs: 59600,
    frame: { t: "overlay_modal", kind: "popover", on: false },
  },
  {
    // SURFACE — comment 1's persisted highlight paints (1 highlight). This lands AFTER the popover act
    // (the popover-on + typing precede this highlight, the ordering the test asserts).
    tMs: 59800,
    frame: { t: "set_comments", path: TRAILHEAD_MASTER_PATH, comments: [TRAILHEAD_COMMENT_1] },
  },

  // ---- Comment 2 act (P2: now a FULL act; anchors to the SAME Context block, data-source-line="4") ----
  {
    // OVERLAY — EMPHASIZE the target block before typing (pulse the Context block ~1s).
    tMs: 60200,
    frame: { t: "pulse", target: '#reading-pane [data-source-line="4"]', fromMs: 60200, toMs: 61200 },
  },
  {
    // OVERLAY — the cursor travels to the Context block (c2's quote shares c1's block).
    tMs: 60400,
    frame: { t: "cursor_move", target: '#reading-pane [data-source-line="4"]', moveMs: 400 },
  },
  {
    // OVERLAY — the selection popover opens under that block again (a fresh act for c2).
    tMs: 60800,
    frame: { t: "overlay_modal", kind: "popover", on: true, target: '#reading-pane [data-source-line="4"]' },
  },
  {
    // OVERLAY — pulse the open popover (~1s).
    tMs: 61000,
    frame: { t: "pulse", target: "#sel-popover", fromMs: 61000, toMs: 62200 },
  },
  {
    // OVERLAY — TYPE comment 2 into #sp-text over ~1.8s.
    tMs: 61200,
    frame: { t: "field_type", target: "#sp-text", text: TRAILHEAD_COMMENT_2.comment, fromMs: 61200, toMs: 63000 },
  },
  {
    // OVERLAY — the cursor travels to the save button.
    tMs: 63100,
    frame: { t: "cursor_move", target: "#sp-save", moveMs: 300 },
  },
  {
    // OVERLAY — a COSMETIC press on #sp-save.
    tMs: 63400,
    frame: { t: "cursor_click", target: "#sp-save" },
  },
  {
    // OVERLAY — the popover closes.
    tMs: 63600,
    frame: { t: "overlay_modal", kind: "popover", on: false },
  },
  {
    // SURFACE — comment 2's persisted highlight paints (full set [c1, c2] → 2 highlights).
    tMs: 63800,
    frame: { t: "set_comments", path: TRAILHEAD_MASTER_PATH, comments: [TRAILHEAD_COMMENT_1, TRAILHEAD_COMMENT_2] },
  },

  // ---- Comment 3 act (anchors to the closing paragraph, data-source-line="53") ----
  {
    // OVERLAY — EMPHASIZE the target block before typing (pulse the closing block ~1s).
    tMs: 64200,
    frame: { t: "pulse", target: '#reading-pane [data-source-line="53"]', fromMs: 64200, toMs: 65200 },
  },
  {
    // OVERLAY — the cursor travels to the closing block (carries c3's quote, a DISTINCT block from c1/c2).
    tMs: 64400,
    frame: { t: "cursor_move", target: '#reading-pane [data-source-line="53"]', moveMs: 400 },
  },
  {
    // OVERLAY — the popover opens under that block.
    tMs: 64800,
    frame: { t: "overlay_modal", kind: "popover", on: true, target: '#reading-pane [data-source-line="53"]' },
  },
  {
    // OVERLAY — pulse the popover (~1s).
    tMs: 65000,
    frame: { t: "pulse", target: "#sel-popover", fromMs: 65000, toMs: 66200 },
  },
  {
    // OVERLAY — TYPE comment 3 into #sp-text over ~1.8s.
    tMs: 65200,
    frame: { t: "field_type", target: "#sp-text", text: TRAILHEAD_COMMENT_3.comment, fromMs: 65200, toMs: 67000 },
  },
  {
    // OVERLAY — the cursor travels to the save button.
    tMs: 67100,
    frame: { t: "cursor_move", target: "#sp-save", moveMs: 300 },
  },
  {
    // OVERLAY — a COSMETIC press on #sp-save.
    tMs: 67400,
    frame: { t: "cursor_click", target: "#sp-save" },
  },
  {
    // OVERLAY — the popover closes.
    tMs: 67600,
    frame: { t: "overlay_modal", kind: "popover", on: false },
  },
  {
    // SURFACE — comment 3's persisted highlight paints (full set [c1, c2, c3] → 3 highlights).
    tMs: 67800,
    frame: {
      t: "set_comments",
      path: TRAILHEAD_MASTER_PATH,
      comments: [TRAILHEAD_COMMENT_1, TRAILHEAD_COMMENT_2, TRAILHEAD_COMMENT_3],
    },
  },
  {
    // OVERLAY — the cursor travels to "Request changes" (#review-submit) to send the comments back.
    tMs: 68400,
    frame: { t: "cursor_move", target: "#review-submit", moveMs: 300 },
  },
  {
    // OVERLAY — a COSMETIC press on #review-submit ("Request changes"); the V2 load below is frame-driven.
    tMs: 68700,
    frame: { t: "cursor_click", target: "#review-submit" },
  },
  {
    // SURFACE — switch the reading pane to the REVISED master (V2). No closing open_plan{null} — the
    // master stays open, so the beat ends on the Plan tab showing the revised doc. Because comments are
    // scoped to the OPEN path (projectSurfaceState), and V2 has no set_comments, projectSurfaceState
    // .comments is [] for T ≥ this frame (the V1 comments do not paint on V2 — a clean iteration reveal).
    tMs: 69000,
    frame: { t: "open_plan", path: TRAILHEAD_MASTER_V2_PATH },
  },
  {
    // seq 26 — a system echo announcing the revision (a system bubble on the hidden Conversation tab).
    tMs: 69400,
    frame: {
      t: "system_message",
      seq: 64,
      text: "Revised the plan per your 3 comments — bigger trail cards and a difficulty badge are in.",
    },
  },
];

// ---- (P5) EXECUTION CHAPTER — a SEQUENCE OF PER-SUBPLAN SUBAGENTS -------------------------------
//
// The plan (master + subplans 01/02/03 + 04 decomposed into 04.01–04.04) is approved → the assistant
// EXECUTES it. P5 REWROTE this chapter from four flat Write leaves into a SEQUENCE OF SUBAGENTS: each
// subplan runs via its OWN `Task` subagent — a top-level Task tool_use + a `subagent_started` label +
// the subplan's 4–6 LEAF tool calls (a realistic Read/Write/Edit/Bash mix) nested under that Task's id,
// an in-group summary `assistant_text`, and a DEFERRED top-level Task `tool_result` (mirroring the
// scope-recon Task pattern: the deferred result is what flips the spanning Task running→done). Every
// leaf tool_use+tool_result pair shares a tMs (ATOMIC — no lingering "running" leaf, so the recursive
// no-stuck-tool invariant holds).
//
// CONTEXT THREADING (load-bearing, replaces P4's hand-wavy `[context]` system echoes): each subplan
// produces a named ARTIFACT (e.g. 01 → `TrailRepository.ts` exposing a `Trail` type + difficulty
// palette {easy/moderate/hard}; 04.01 → `<DifficultyBadge>`). The NEXT subplan's launch narration AND
// its `Task.input.prompt` VERBATIM reference the prior subplan's produced artifact (e.g. 02's prompt
// "Building on subplan 01's `TrailRepository` …"). This makes "the output of one plan feeds the next"
// literal and visible (the falsifiable context-threading test asserts the actual substring).

// One leaf tool inside a subplan subagent group. `tool` is the engine tool name; `input` is its tool_use
// input; `result` is the tool_result content. Read/Write/Edit/Bash mix per subplan.
interface ExecLeaf {
  tool: "Read" | "Write" | "Edit" | "Bash" | "Grep";
  input: Record<string, unknown>;
  result: string;
}

// One subplan executed as a Task subagent. `narration` is the top-level launch narration (VERBATIM
// references `producedBy`-prior artifacts where threaded); `prompt` is the Task.input.prompt (likewise
// threaded); `summary` is the in-group closing summary naming `artifact`; `taskResult` is the DEFERRED
// top-level Task tool_result (also naming `artifact`). `leaves` are the 4–6 atomic leaf tool calls.
interface ExecSubplan {
  id: string; // subplan id label, e.g. "01" / "04.01"
  taskId: string; // the Task tool_use id (= the subagent group key)
  description: string; // Task description / subagent_started description
  // (P1) The nn_path(s) this subplan's row APPEARANCE adds to the cumulative revealed set, in pre-order.
  // Usually just the subplan's own nn_path; for 04.01 it is ["04","04.01"] (the 04 DECOMPOSITION parent
  // must appear WITH — and before — its first leaf so the snapshot stays parent-before-child).
  reveals: string[];
  planBeat: ExecPlanBeat; // (P1) the just-in-time planning beat (recon/sizing/draft) before execution
  narration: string; // top-level launch narration (threads the prior artifact)
  prompt: string; // Task.input.prompt (threads the prior artifact)
  leaves: ExecLeaf[]; // 4–6 atomic leaf tool calls
  summary: string; // in-group closing summary (names the produced artifact)
  taskResult: string; // deferred top-level Task tool_result (names the produced artifact)
}

// (P1) The just-in-time planning beat for ONE subplan: the narration the agent emits while DRAFTING that
// subplan's plan (recon/sizing), plus a small atomic tool-call group representing the drafting work. The
// `draftResult` is the in-group note that the subplan's own plan was written NOW (just before execution).
interface ExecPlanBeat {
  narration: string; // top-level "planning subplan NN now" narration (precedes the row's execution)
  taskId: string; // the planning Task tool_use id (a distinct spanning Task per subplan's drafting)
  description: string; // the planning Task description / subagent_started label
  prompt: string; // the planning Task.input.prompt
  leaves: ExecLeaf[]; // 2–3 atomic recon/sizing leaf tool calls (the drafting work)
  draftResult: string; // deferred top-level planning-Task tool_result (the subplan's plan, drafted now)
}

// The seven subplan subagents, in execution order. Subplans 01/02/03 are top-level subplans; 04.01–04.04
// are the trail-detail decomposition leaves — each rendered as its OWN Task subagent per the P5 spec.
// THREADING: every subplan after the first names the IMMEDIATELY-PRIOR subplan's artifact VERBATIM in
// BOTH its narration AND its Task prompt (the substrings the falsifiable test pins).
const EXEC_SUBPLANS: ExecSubplan[] = [
  {
    id: "01",
    taskId: "toolu_th_exec_sp01",
    description: "Subplan 01 — Trail data & search",
    reveals: ["01"],
    planBeat: {
      narration: "Planning subplan 01 · Trail data & search — recon the data shape, size the work, and draft the subplan now.",
      taskId: "toolu_th_plan_sp01",
      description: "Draft subplan 01 — Trail data & search",
      prompt:
        "Draft subplan 01 (Trail data & search): recon the existing trail data shape, size the catalog/search/filter work, and write the subplan. Report the drafted subplan.",
      leaves: [
        { tool: "Read", input: { file_path: "src/data/trails.json" }, result: "Seed trail catalog — 42 trails, each with id/name/distance/gain/difficulty. Drives the data-layer shape." },
        { tool: "Grep", input: { pattern: "difficulty", output_mode: "files_with_matches" }, result: "src/data/trails.json\nsrc/components/DifficultyBadge.tsx — difficulty already modelled; size as one focused subplan." },
      ],
      draftResult:
        "Subplan 01 drafted — Trail data & search: a TrailRepository (`Trail` type + difficulty palette {easy/moderate/hard}) seeded from trails.json, with a search-by-name query. Sized: one focused subplan.",
    },
    narration: "Subplan 01 · Trail data & search — building the data layer first so everything downstream has trails to render.",
    prompt:
      "Implement subplan 01 (Trail data & search): create a TrailRepository that exposes a `Trail` type and a difficulty palette {easy/moderate/hard}, seed it from trails.json, and add a search-by-name query. Report the artifact you produced.",
    leaves: [
      { tool: "Read", input: { file_path: "src/data/trails.json" }, result: "[ { \"id\": \"t-001\", \"name\": \"Eagle Ridge\", \"difficulty\": \"hard\" }, … 42 trails ]" },
      { tool: "Write", input: { file_path: "src/data/TrailRepository.ts" }, result: "Wrote src/data/TrailRepository.ts — exports `Trail` type + DIFFICULTY_PALETTE {easy,moderate,hard} + searchByName()." },
      { tool: "Write", input: { file_path: "src/data/useTrails.ts" }, result: "Wrote src/data/useTrails.ts — a hook over TrailRepository.searchByName()." },
      { tool: "Bash", input: { command: "npx tsc --noEmit -p src/data" }, result: "tsc: no errors. TrailRepository + useTrails typecheck clean." },
    ],
    summary: "Subplan 01 done — `TrailRepository.ts` exposes the `Trail` type and the difficulty palette {easy/moderate/hard}, with a search-by-name hook.",
    taskResult:
      "Subplan 01 complete. ARTIFACT: `TrailRepository.ts` — exposes a `Trail` type + a difficulty palette {easy/moderate/hard} + searchByName(), with the `useTrails` hook over it.",
  },
  {
    id: "02",
    taskId: "toolu_th_exec_sp02",
    description: "Subplan 02 — Map & navigation",
    reveals: ["02"],
    planBeat: {
      narration: "Planning subplan 02 · Map & navigation — recon the navigation layer, size the map work against subplan 01's `TrailRepository`, and draft it.",
      taskId: "toolu_th_plan_sp02",
      description: "Draft subplan 02 — Map & navigation",
      prompt:
        "Draft subplan 02 (Map & navigation): recon the navigation layer, size plotting subplan 01's `TrailRepository` trails on a MapScreen, and write the subplan. Report the drafted subplan.",
      leaves: [
        { tool: "Read", input: { file_path: "src/navigation/RootNavigator.tsx" }, result: "Native-stack root — a MapScreen + TrailDetail route slot in cleanly. Sized as one subplan." },
        { tool: "Read", input: { file_path: "src/data/TrailRepository.ts" }, result: "TrailRepository exposes the `Trail` type + difficulty palette from subplan 01 — the map consumes both." },
      ],
      draftResult:
        "Subplan 02 drafted — Map & navigation: a MapScreen plotting subplan 01's `TrailRepository` trails with difficulty-coloured pins, wired into native-stack navigation. Sized: one subplan.",
    },
    narration: "Subplan 02 · Map & navigation — building on subplan 01's `TrailRepository` (`Trail` type + difficulty palette) to plot trails on the map.",
    prompt:
      "Implement subplan 02 (Map & navigation): building on subplan 01's `TrailRepository` (`Trail` type + difficulty palette), wire native-stack navigation and plot each trail on the MapScreen, colouring pins by the difficulty palette. Report the artifact you produced.",
    leaves: [
      { tool: "Read", input: { file_path: "src/data/TrailRepository.ts" }, result: "export type Trail = …; export const DIFFICULTY_PALETTE = { easy, moderate, hard }; export function searchByName() …" },
      { tool: "Write", input: { file_path: "src/screens/MapScreen.tsx" }, result: "Wrote src/screens/MapScreen.tsx — plots TrailRepository trails, pins coloured by DIFFICULTY_PALETTE." },
      { tool: "Edit", input: { file_path: "src/navigation/RootNavigator.tsx" }, result: "Edited RootNavigator.tsx — registered MapScreen + TrailDetail route in the native stack." },
      { tool: "Edit", input: { file_path: "src/navigation/TabNavigator.tsx" }, result: "Edited TabNavigator.tsx — added the Map tab." },
      { tool: "Bash", input: { command: "npx tsc --noEmit -p src/screens/MapScreen.tsx" }, result: "tsc: no errors. MapScreen consumes the Trail type cleanly." },
    ],
    summary: "Subplan 02 done — `MapScreen.tsx` plots `TrailRepository` trails with difficulty-coloured pins, wired into native-stack navigation.",
    taskResult:
      "Subplan 02 complete. ARTIFACT: `MapScreen.tsx` + native-stack routes — plots `TrailRepository` trails, pins coloured by the difficulty palette, with a TrailDetail route registered.",
  },
  {
    id: "03",
    taskId: "toolu_th_exec_sp03",
    description: "Subplan 03 — Hike logging",
    reveals: ["03"],
    planBeat: {
      narration: "Planning subplan 03 · Hike logging — recon subplan 02's `MapScreen.tsx` route, size the logging store, and draft the subplan.",
      taskId: "toolu_th_plan_sp03",
      description: "Draft subplan 03 — Hike logging",
      prompt:
        "Draft subplan 03 (Hike logging): recon subplan 02's `MapScreen.tsx` + TrailDetail route, size a hike-log store + screen that deep-links to a trail, and write the subplan. Report the drafted subplan.",
      leaves: [
        { tool: "Read", input: { file_path: "src/screens/MapScreen.tsx" }, result: "MapScreen navigates to the TrailDetail route with a Trail param — the hike log can reuse that deep-link." },
        { tool: "Bash", input: { command: "ls src/data" }, result: "TrailRepository.ts  useTrails.ts — a HikeLogStore slots beside them. Sized as one subplan." },
      ],
      draftResult:
        "Subplan 03 drafted — Hike logging: a HikeLogStore recording hikes against a `Trail` + a LogHikeScreen that deep-links to subplan 02's TrailDetail route. Sized: one subplan.",
    },
    narration: "Subplan 03 · Hike logging — building on subplan 02's `MapScreen.tsx` + TrailDetail route so a logged hike deep-links back to its trail.",
    prompt:
      "Implement subplan 03 (Hike logging): building on subplan 02's `MapScreen.tsx` + TrailDetail route, add a HikeLogStore that records completed hikes against a `Trail` and a LogHikeScreen that deep-links to the trail. Report the artifact you produced.",
    leaves: [
      { tool: "Read", input: { file_path: "src/screens/MapScreen.tsx" }, result: "MapScreen navigates to the TrailDetail route with a Trail param — reuse that route for the hike deep-link." },
      { tool: "Write", input: { file_path: "src/data/HikeLogStore.ts" }, result: "Wrote src/data/HikeLogStore.ts — records {trailId, date, notes} against a Trail; exposes logsForTrail()." },
      { tool: "Write", input: { file_path: "src/screens/LogHikeScreen.tsx" }, result: "Wrote src/screens/LogHikeScreen.tsx — logs a hike + deep-links to the TrailDetail route from subplan 02." },
      { tool: "Edit", input: { file_path: "src/navigation/TabNavigator.tsx" }, result: "Edited TabNavigator.tsx — added the Log tab next to Map." },
      { tool: "Bash", input: { command: "npx vitest run src/data/HikeLogStore.test.ts" }, result: "1 file, 4 tests passed — logsForTrail() returns the hikes for a given Trail." },
    ],
    summary: "Subplan 03 done — `HikeLogStore.ts` records hikes against a `Trail`, and LogHikeScreen deep-links to subplan 02's TrailDetail route.",
    taskResult:
      "Subplan 03 complete. ARTIFACT: `HikeLogStore.ts` + LogHikeScreen — records hikes against a `Trail`, deep-linking to the TrailDetail route, with the Log tab wired in.",
  },
  {
    id: "04.01",
    taskId: "toolu_th_exec_sp0401",
    description: "Subplan 04.01 — Trail header + difficulty badge",
    // The 04 DECOMPOSITION parent appears HERE, WITH (and pre-ordered before) its first leaf 04.01 —
    // treeThrough preserves TRAILHEAD_PLANS pre-order so "04" sorts before "04.01" in the snapshot.
    reveals: ["04", "04.01"],
    planBeat: {
      narration: "Planning subplan 04 · Trail detail — decomposing into four leaves; drafting 04.01 (header + difficulty badge) first, reusing subplan 01's palette.",
      taskId: "toolu_th_plan_sp0401",
      description: "Draft subplan 04.01 — Trail header + difficulty badge",
      prompt:
        "Draft subplan 04.01 (Trail header + difficulty badge): recon subplan 01's `TrailRepository` difficulty palette {easy/moderate/hard}, size a `<DifficultyBadge>` + TrailHeader, and write the leaf subplan. Report the drafted subplan.",
      leaves: [
        { tool: "Read", input: { file_path: "src/data/TrailRepository.ts" }, result: "DIFFICULTY_PALETTE {easy/moderate/hard} from subplan 01 — the badge reuses it. Sized as a small leaf." },
        { tool: "Read", input: { file_path: "src/screens/TrailDetailScreen.tsx" }, result: "TrailDetail has a TODO for header/badge/chart/reviews/share — confirms the four-leaf decomposition." },
      ],
      draftResult:
        "Subplan 04.01 drafted — Trail header + difficulty badge: a `<DifficultyBadge>` coloured from subplan 01's palette {easy/moderate/hard}, shown in TrailHeader. Sized: the first of four 04.* leaves.",
    },
    narration: "Subplan 04.01 · Trail header + difficulty badge — reusing subplan 01's `TrailRepository` difficulty palette {easy/moderate/hard} for the badge colours.",
    prompt:
      "Implement subplan 04.01 (Trail header + difficulty badge): reusing subplan 01's `TrailRepository` difficulty palette {easy/moderate/hard}, build a `<DifficultyBadge>` and a TrailHeader that shows it. Report the artifact you produced.",
    leaves: [
      { tool: "Read", input: { file_path: "src/data/TrailRepository.ts" }, result: "DIFFICULTY_PALETTE = { easy: '#2e7d32', moderate: '#f9a825', hard: '#c62828' } — reuse for the badge." },
      { tool: "Write", input: { file_path: "src/screens/TrailDetail/DifficultyBadge.tsx" }, result: "Wrote DifficultyBadge.tsx — a `<DifficultyBadge>` pill coloured from DIFFICULTY_PALETTE." },
      { tool: "Write", input: { file_path: "src/screens/TrailDetail/TrailHeader.tsx" }, result: "Wrote TrailHeader.tsx — title + `<DifficultyBadge>`." },
      { tool: "Bash", input: { command: "npx tsc --noEmit -p src/screens/TrailDetail/TrailHeader.tsx" }, result: "tsc: no errors. TrailHeader + DifficultyBadge typecheck clean." },
    ],
    summary: "Subplan 04.01 done — `<DifficultyBadge>` reuses subplan 01's difficulty palette, shown in TrailHeader.",
    taskResult:
      "Subplan 04.01 complete. ARTIFACT: `<DifficultyBadge>` — a difficulty pill coloured from subplan 01's palette {easy/moderate/hard}, surfaced in TrailHeader.",
  },
  {
    id: "04.02",
    taskId: "toolu_th_exec_sp0402",
    description: "Subplan 04.02 — Elevation chart",
    reveals: ["04.02"],
    planBeat: {
      narration: "Planning subplan 04.02 · Elevation chart — recon subplan 04.01's `<DifficultyBadge>` palette, size the chart, and draft the leaf.",
      taskId: "toolu_th_plan_sp0402",
      description: "Draft subplan 04.02 — Elevation chart",
      prompt:
        "Draft subplan 04.02 (Elevation chart): recon subplan 04.01's `<DifficultyBadge>` palette, size an ElevationChart tinted by difficulty with onSegmentPress, and write the leaf subplan. Report the drafted subplan.",
      leaves: [
        { tool: "Read", input: { file_path: "src/screens/TrailDetail/DifficultyBadge.tsx" }, result: "DifficultyBadge maps difficulty → palette colour — the chart line reuses the same map. Small leaf." },
        { tool: "Grep", input: { pattern: "elevation", output_mode: "files_with_matches" }, result: "src/components/ElevationSparkline.tsx — an existing sparkline to build the full chart from." },
      ],
      draftResult:
        "Subplan 04.02 drafted — Elevation chart: an ElevationChart whose line is tinted by subplan 04.01's `<DifficultyBadge>` palette, exposing onSegmentPress. Sized: the second of four 04.* leaves.",
    },
    narration: "Subplan 04.02 · Elevation chart — reusing subplan 04.01's `<DifficultyBadge>` palette to tint the elevation line.",
    prompt:
      "Implement subplan 04.02 (Elevation chart): reusing subplan 04.01's `<DifficultyBadge>` palette, draw an ElevationChart whose line is tinted by the trail's difficulty and expose onSegmentPress. Report the artifact you produced.",
    leaves: [
      { tool: "Read", input: { file_path: "src/screens/TrailDetail/DifficultyBadge.tsx" }, result: "DifficultyBadge maps difficulty → palette colour — reuse the same map to tint the elevation line." },
      { tool: "Write", input: { file_path: "src/screens/TrailDetail/ElevationChart.tsx" }, result: "Wrote ElevationChart.tsx — line tinted by `<DifficultyBadge>` palette; exposes onSegmentPress." },
      { tool: "Edit", input: { file_path: "src/screens/TrailDetail/TrailHeader.tsx" }, result: "Edited TrailHeader.tsx — render ElevationChart under the header." },
      { tool: "Bash", input: { command: "npx tsc --noEmit -p src/screens/TrailDetail/ElevationChart.tsx" }, result: "tsc: no errors. ElevationChart typechecks; onSegmentPress exported." },
    ],
    summary: "Subplan 04.02 done — `ElevationChart.tsx` tints its line by subplan 04.01's badge palette and exposes onSegmentPress.",
    taskResult:
      "Subplan 04.02 complete. ARTIFACT: `ElevationChart.tsx` — elevation line tinted by subplan 04.01's `<DifficultyBadge>` palette, exposing onSegmentPress.",
  },
  {
    id: "04.03",
    taskId: "toolu_th_exec_sp0403",
    description: "Subplan 04.03 — Reviews",
    reveals: ["04.03"],
    planBeat: {
      narration: "Planning subplan 04.03 · Reviews — recon subplan 04.02's `ElevationChart.tsx` onSegmentPress, size the reviews list, and draft the leaf.",
      taskId: "toolu_th_plan_sp0403",
      description: "Draft subplan 04.03 — Reviews",
      prompt:
        "Draft subplan 04.03 (Reviews): recon subplan 04.02's `ElevationChart.tsx` onSegmentPress, size a Reviews list deep-linking to elevation segments, and write the leaf subplan. Report the drafted subplan.",
      leaves: [
        { tool: "Read", input: { file_path: "src/screens/TrailDetail/ElevationChart.tsx" }, result: "ElevationChart exposes onSegmentPress(segmentIndex) — Reviews subscribe to it. Small leaf." },
        { tool: "Bash", input: { command: "ls src/screens/TrailDetail" }, result: "DifficultyBadge.tsx  ElevationChart.tsx  TrailHeader.tsx — Reviews.tsx slots in next." },
      ],
      draftResult:
        "Subplan 04.03 drafted — Reviews: a Reviews list whose entries deep-link to subplan 04.02's `ElevationChart.tsx` segments (onSegmentPress), surfacing shareable highlights. Sized: third of four 04.* leaves.",
    },
    narration: "Subplan 04.03 · Reviews — wiring subplan 04.02's `ElevationChart.tsx` onSegmentPress so a review deep-links to its elevation segment.",
    prompt:
      "Implement subplan 04.03 (Reviews): wiring subplan 04.02's `ElevationChart.tsx` onSegmentPress, add a Reviews list whose entries deep-link to the elevation segment they describe, and surface shareable highlights. Report the artifact you produced.",
    leaves: [
      { tool: "Read", input: { file_path: "src/screens/TrailDetail/ElevationChart.tsx" }, result: "ElevationChart exposes onSegmentPress(segmentIndex) — subscribe Reviews to it." },
      { tool: "Write", input: { file_path: "src/screens/TrailDetail/Reviews.tsx" }, result: "Wrote Reviews.tsx — reviews deep-link to elevation segments via onSegmentPress; marks shareable highlights." },
      { tool: "Edit", input: { file_path: "src/screens/TrailDetail/ElevationChart.tsx" }, result: "Edited ElevationChart.tsx — forwards onSegmentPress to the Reviews list." },
      { tool: "Bash", input: { command: "npx vitest run src/screens/TrailDetail/Reviews.test.ts" }, result: "1 file, 3 tests passed — a segment press scrolls to the matching review." },
    ],
    summary: "Subplan 04.03 done — `Reviews.tsx` deep-links to subplan 04.02's elevation segments and marks shareable highlights.",
    taskResult:
      "Subplan 04.03 complete. ARTIFACT: `Reviews.tsx` — reviews deep-linking to subplan 04.02's elevation segments (onSegmentPress), surfacing shareable highlights.",
  },
  {
    id: "04.04",
    taskId: "toolu_th_exec_sp0404",
    description: "Subplan 04.04 — Save / share",
    reveals: ["04.04"],
    planBeat: {
      narration: "Planning subplan 04.04 · Save / share — recon subplan 04.03's `Reviews.tsx` shareable highlights, size the share sheet, and draft the final leaf.",
      taskId: "toolu_th_plan_sp0404",
      description: "Draft subplan 04.04 — Save / share",
      prompt:
        "Draft subplan 04.04 (Save / share): recon subplan 04.03's `Reviews.tsx` shareable highlights, size a ShareSheet that saves a trail and shares them, and write the final leaf subplan. Report the drafted subplan.",
      leaves: [
        { tool: "Read", input: { file_path: "src/screens/TrailDetail/Reviews.tsx" }, result: "Reviews exposes shareableHighlights() — the share sheet feeds on them. Final small leaf." },
        { tool: "Bash", input: { command: "ls src/screens/TrailDetail" }, result: "DifficultyBadge.tsx  ElevationChart.tsx  Reviews.tsx  TrailHeader.tsx — ShareSheet.tsx completes the screen." },
      ],
      draftResult:
        "Subplan 04.04 drafted — Save / share: a ShareSheet that saves a trail and shares subplan 04.03's `Reviews.tsx` highlights, completing the trail-detail decomposition. Sized: last of four 04.* leaves.",
    },
    narration: "Subplan 04.04 · Save / share — surfacing subplan 04.03's `Reviews.tsx` shareable highlights through a share sheet.",
    prompt:
      "Implement subplan 04.04 (Save / share): surfacing subplan 04.03's `Reviews.tsx` shareable highlights, wire a ShareSheet that saves a trail and shares its review highlights. Report the artifact you produced.",
    leaves: [
      { tool: "Read", input: { file_path: "src/screens/TrailDetail/Reviews.tsx" }, result: "Reviews exposes shareableHighlights() — feed them into the share sheet." },
      { tool: "Write", input: { file_path: "src/screens/TrailDetail/ShareSheet.tsx" }, result: "Wrote ShareSheet.tsx — saves the trail + shares subplan 04.03's review highlights." },
      { tool: "Edit", input: { file_path: "src/screens/TrailDetail/TrailHeader.tsx" }, result: "Edited TrailHeader.tsx — added the Save/Share action that opens ShareSheet." },
      { tool: "Bash", input: { command: "npx tsc --noEmit -p src/screens/TrailDetail" }, result: "tsc: no errors. The whole Trail-detail screen (header/badge/chart/reviews/share) typechecks." },
    ],
    summary: "Subplan 04.04 done — `ShareSheet.tsx` shares subplan 04.03's review highlights; the Trail-detail screen is complete.",
    taskResult:
      "Subplan 04.04 complete. ARTIFACT: `ShareSheet.tsx` — saves a trail and shares subplan 04.03's review highlights; all four 04.* leaves compose the Trail-detail screen.",
  },
];

// ---- (P1) Programmatic PROGRESSIVE Execution-chapter builder (FINAL tMs/seq, no further shift) ---
//
// Phase 1 makes the back half play PROGRESSIVELY. The builder walks EXEC_SUBPLANS and, PER SUBPLAN,
// emits in order:
//   (a) the subplan's ROW(s) appear — a `plan_changed` snapshot = the tree grown SO FAR (treeThrough),
//   (b) a just-in-time PLANNING beat — narration + a small spanning planning Task (recon/sizing leaves)
//       + a DEFERRED planning-Task tool_result (the subplan's plan, drafted NOW),
//   (c) the EXECUTION beat — the subplan's spanning Task + its atomic leaf tool calls + in-group summary
//       + a DEFERRED execution-Task tool_result (flips the Task done, names the produced artifact),
//   (d) a "done" beat — folded into the execution summary + deferred result above, and
//   (e) a parent-REVIEW beat — a top-level narration acknowledging the subplan and queueing the next.
// THEN the next subplan's row appears, and so on. Before subplan 01's row, a master→01 "thinking" group
// (#7) plays (the agent reasons about WHERE to start before the first row populates).
//
// Every leaf tool_use+tool_result pair shares a tMs (ATOMIC). Both the planning Task AND the execution
// Task are SPANNING (their own deferred tool_result lands at their group's end → no stuck running Task).
// seqs are dense/contiguous from EXEC_SEQ_BASE; tMs steps by EXEC_STEP_MS. The chapter opens with a
// SURFACE open_plan{null} (closes the V2 master → activeTab "conversation") and ends with an integration
// wrap-up + the terminal `result` (strictly highest seq AND tMs).
const EXEC_STEP_MS = 600; // inter-frame tMs step within the Execution chapter (atomic pairs share one tMs).

function buildExecution(): { frames: StoryFrame[]; terminalSeq: number; terminalMs: number } {
  const frames: StoryFrame[] = [];
  let seq = EXEC_SEQ_BASE;
  let tMs = EXEC_BASE_MS;
  const step = () => {
    tMs += EXEC_STEP_MS;
  };

  // The cumulative set of revealed subplan nn_paths — GROWS one subplan at a time. Each subplan's
  // `reveals` are unioned in just before that subplan's row snapshot, so the snapshot is the tree-so-far.
  const revealed = new Set<string>();

  // Emit a top-level streaming assistant_text. Returns its seq (for pulse targeting if needed).
  const narrate = (text: string, revealMs: number): number => {
    step();
    const s = seq++;
    frames.push({ tMs, frame: { t: "conv", revealMs, ev: { seq: s, kind: "assistant_text", text, parent_tool_use_id: null } } });
    return s;
  };

  // Emit ONE spanning Task subagent group (planning OR execution): a top-level Task tool_use +
  // `subagent_started` label (shared tMs), the atomic leaf pairs (each pair shares a tMs, parent=taskId),
  // an in-group summary, and a DEFERRED top-level Task tool_result that flips the spanning Task done.
  const emitSpanningTask = (args: {
    taskId: string;
    description: string;
    prompt: string;
    subagentType: string;
    leaves: ExecLeaf[];
    summary: string;
    deferredResult: string;
  }): void => {
    step();
    const taskTMs = tMs;
    frames.push({
      tMs: taskTMs,
      frame: {
        t: "conv",
        ev: {
          seq: seq++,
          kind: "tool_use",
          id: args.taskId,
          tool: "Task",
          input: { description: args.description, subagent_type: args.subagentType, prompt: args.prompt },
          parent_tool_use_id: null,
        },
      },
    });
    frames.push({
      tMs: taskTMs,
      frame: {
        t: "conv",
        ev: {
          seq: seq++,
          kind: "subagent_started",
          tool_use_id: args.taskId,
          subagent_type: args.subagentType,
          description: args.description,
          prompt: args.prompt,
        },
      },
    });

    let leafIdx = 0;
    for (const leaf of args.leaves) {
      step();
      const leafTMs = tMs;
      const leafId = `${args.taskId}_leaf_${leafIdx++}`;
      frames.push({
        tMs: leafTMs,
        frame: { t: "conv", ev: { seq: seq++, kind: "tool_use", id: leafId, tool: leaf.tool, input: leaf.input, parent_tool_use_id: args.taskId } },
      });
      frames.push({
        tMs: leafTMs,
        frame: { t: "conv", ev: { seq: seq++, kind: "tool_result", tool_use_id: leafId, content: leaf.result, is_error: false, parent_tool_use_id: args.taskId } },
      });
    }

    // In-group summary (parent = taskId).
    step();
    frames.push({
      tMs,
      frame: { t: "conv", revealMs: 800, ev: { seq: seq++, kind: "assistant_text", text: args.summary, parent_tool_use_id: args.taskId } },
    });

    // DEFERRED top-level Task tool_result — flips the spanning Task running→done.
    step();
    frames.push({
      tMs,
      frame: { t: "conv", ev: { seq: seq++, kind: "tool_result", tool_use_id: args.taskId, content: args.deferredResult, is_error: false, parent_tool_use_id: null } },
    });
  };

  // SURFACE — close the reading pane (the V2 master is no longer shown) so projectSurfaceState flips
  // activeTab "plan" → "conversation" for the whole Execution chapter. No seq (a surface frame).
  frames.push({ tMs: EXEC_BASE_MS, chapterLabel: "Execution", frame: { t: "open_plan", path: null } });

  // Top-level exec-open narration.
  narrate(
    "Plan approved — I'll plan and execute the subplans one at a time, each as its own subagent. The output of each feeds the next.",
    1000,
  );

  // (#7) The master→01 "thinking" group: BEFORE the first subplan row appears, the agent reasons about
  // where to start. A small spanning `planning-lead` Task whose deferred result decides "data layer first".
  narrate("Thinking about where to start — the data layer is the foundation everything else renders from.", 900);
  emitSpanningTask({
    taskId: "toolu_th_plan_lead",
    description: "Decide the execution order",
    subagentType: "planning-lead",
    prompt:
      "Given the approved master (subplans 01–04, with 04 decomposed into four leaves), decide which subplan to plan and execute FIRST. Report the starting point.",
    leaves: [
      { tool: "Read", input: { file_path: "src/data/trails.json" }, result: "The trail catalog is the root dependency — every screen renders from it. Start with the data layer (01)." },
      { tool: "Grep", input: { pattern: "useTrails", output_mode: "files_with_matches" }, result: "src/screens/TrailListScreen.tsx\nsrc/data/useTrails.ts — downstream consumers; they need the data layer first." },
    ],
    summary: "Decided — execute the data layer (subplan 01) first; map/log/detail all depend on it.",
    deferredResult: "Execution order: start with subplan 01 (Trail data & search) — it is the root dependency for 02/03/04. Subplans 01–04 then run in order.",
  });

  for (const sp of EXEC_SUBPLANS) {
    // (a) The subplan's ROW(s) APPEAR — grow the revealed set, then emit the full pre-ordered snapshot.
    // The snapshot frame carries a per-subplan chapterLabel so the scrubber has a navigable marker at
    // each subplan's turn (the progressive chapter is long; one "Execution" marker would be too sparse).
    for (const path of sp.reveals) revealed.add(path);
    step();
    frames.push({ tMs, chapterLabel: `Subplan ${sp.id}`, frame: { t: "plan_changed", plans: treeThrough(revealed) } });

    // (b) The just-in-time PLANNING beat — narration + a spanning planning Task whose deferred result IS
    // the subplan's plan, drafted NOW (so the row that just appeared is being planned at its turn).
    narrate(sp.planBeat.narration, 800);
    emitSpanningTask({
      taskId: sp.planBeat.taskId,
      description: sp.planBeat.description,
      subagentType: "subplan-planner",
      prompt: sp.planBeat.prompt,
      leaves: sp.planBeat.leaves,
      summary: `Drafted subplan ${sp.id} — ready to execute.`,
      deferredResult: sp.planBeat.draftResult,
    });

    // (c)+(d) The EXECUTION beat — launch narration (threads the prior artifact) + the spanning execution
    // Task + its atomic leaves + in-group summary + deferred result (the "done" signal naming the artifact).
    narrate(sp.narration, 800);
    emitSpanningTask({
      taskId: sp.taskId,
      description: sp.description,
      subagentType: "subplan-executor",
      prompt: sp.prompt,
      leaves: sp.leaves,
      summary: sp.summary,
      deferredResult: sp.taskResult,
    });

    // (e) The parent-REVIEW beat — a top-level narration acknowledging the just-finished subplan and
    // queueing the next (mirrors the real driver's parent `reviewing` beat between siblings).
    narrate(`Subplan ${sp.id} reviewed and integrated — moving on.`, 700);
  }

  // Integration wrap-up (top-level).
  narrate(
    "Integrated all subplans — data (01) → map & navigation (02) → hike logging (03) → the four trail-detail leaves (04.01–04.04). Trailhead is ready to ship.",
    1000,
  );

  // Terminal `result` — STRICTLY the highest seq AND tMs (so `working` is non-null mid-run but null at
  // duration: a finished thought). The non-wire bookkeeping fields are benign fixture values.
  step();
  const terminalSeq = seq++;
  const terminalMs = tMs;
  frames.push({
    tMs: terminalMs,
    chapterLabel: "Done",
    frame: {
      t: "conv",
      ev: {
        seq: terminalSeq,
        kind: "result",
        subtype: "success",
        is_error: false,
        result: "Execution complete — Trailhead built.",
        num_turns: 3,
        duration_ms: 40000,
        total_cost_usd: 0,
        session_id: "mock-animate-trailhead",
      },
    },
  });

  return { frames, terminalSeq, terminalMs };
}

const EXEC_BUILT = buildExecution();

// The terminal `result` seq + tMs are COMPUTED from the Execution builder (strictly highest of each).
// Re-timing/re-counting the Execution chapter updates these automatically (one-line base change above).
export const TERMINAL_SEQ = EXEC_BUILT.terminalSeq;
export const TERMINAL_MS = EXEC_BUILT.terminalMs;

// Shift a StoryFrame by `delta` ms. The outer `tMs` ALWAYS shifts; for OVERLAY frames carrying their
// OWN time windows (pulse / field_type / scroll have fromMs+toMs) the INNER window shifts in lockstep
// too — otherwise the shifted frame's projection window (projectPulseSet/projectFieldText/projectScroll
// read the INNER fromMs/toMs) would fire at the UNSHIFTED time, decoupled from the shifted outer tMs.
// cursor_move/cursor_click/overlay_modal/sidebar_tab carry no fromMs/toMs and need only the outer-tMs shift.
function shiftStoryFrame(sf: StoryFrame, delta: number): StoryFrame {
  const f = sf.frame;
  if (f.t === "pulse" || f.t === "field_type" || f.t === "scroll") {
    return { ...sf, tMs: sf.tMs + delta, frame: { ...f, fromMs: f.fromMs + delta, toMs: f.toMs + delta } };
  }
  return { ...sf, tMs: sf.tMs + delta };
}

// Splice the P4-shifted nested-plan/comment-and-iterate chapters (shift by + PROTO_ACT_SHIFT, INNER
// overlay windows included — see shiftStoryFrame), then the P5 Execution chapter (already authored at
// FINAL tMs/seq — pushed verbatim, no shift). chapterLabels preserved; monotonic tMs preserved (the
// comment chapter's last frame stays strictly below EXEC_BASE_MS).
// The nested-plan + master-open + c4 ToC-navigation beat: shifted by the BASE head shift only
// (PROTO_ACT_SHIFT + CLARIFIER_SHIFT). The c4 scroll/pulse inner windows pick up this base shift here
// (their CONSTANTS are deliberately NOT bumped, to avoid double-shifting).
const HEAD_SHIFT = PROTO_ACT_SHIFT + CLARIFIER_SHIFT;
for (const sf of DOWNSTREAM_AFTER_PROTOTYPE) {
  // + CLARIFIER_SHIFT on top of PROTO_ACT_SHIFT: the intent-clarifier running beat (B1B_*) inserted in
  // the front slides this whole block (nested-plan … c4 nav) later by CLARIFIER_SHIFT too.
  TRAILHEAD_BEAT.push(shiftStoryFrame(sf, HEAD_SHIFT));
}
// (c4) The comment-and-iterate chapter: shifted by the head shift PLUS an extra + C4_SHIFT (the c4
// ToC-navigation beat is longer than the old generic slow-scroll beat it replaced, so the comment chapter
// — authored at its original literals — slides later by C4_SHIFT). A per-array push (NOT a literal-tMs
// boundary): the c4 beat's tail literal exceeds the first comment's literal, so a single threshold could
// not separate them. The tMs-pinned comment tests add C4_SHIFT to their expected paint times.
for (const sf of COMMENT_AND_V2) {
  TRAILHEAD_BEAT.push(shiftStoryFrame(sf, HEAD_SHIFT + C4_SHIFT));
}
for (const sf of EXEC_BUILT.frames) {
  TRAILHEAD_BEAT.push(sf);
}
