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

// The unified storyboard frame envelope.
export type Frame = ModelFrame | SurfaceFrame;

// The discriminator values that belong to the SURFACE family — every other `t` is a ModelFrame.
const SURFACE_KINDS = new Set<Frame["t"]>([
  "open_plan",
  "plan_changed",
  "set_comments",
  "pending_reviews",
  "prototype_gate",
]);

// Is this a SurfaceFrame (vs a ModelFrame)?
export function isSurfaceFrame(frame: Frame): frame is SurfaceFrame {
  return SURFACE_KINDS.has(frame.t);
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
    if (isSurfaceFrame(sf.frame)) continue;
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
//   Chapter "Clarify" (seq 1..5):
//     The user kicks off ("plan Trailhead"). The assistant asks ONE clarifying question via an
//     AskUserQuestion permission request (an interactive card). The user answers with a FREE-TEXT
//     value that matches NO option label — the "Other…" affordance — which folds onto the card
//     (answers set) and is ALSO echoed as a standalone user bubble (a demo-authored echo; see below).
//
//   Chapter "Scope recon" (seq 6..20):
//     The assistant launches a `scope-recon` SUBAGENT (a Task tool). A `subagent_started` frame LABELS
//     the group (header "scope-recon"). Inside the group the subagent runs four LEAF tool pairs
//     (Glob/Read/Grep/Bash), each tool_use + tool_result sharing a tMs so each reveals ATOMICALLY (no
//     "running" leaf at rest). The Task's OWN tool_result (seq 18) lands at the END, flipping the
//     top-level Task tool node running→done — WITHOUT it the Task row stays "running" forever (the
//     no-stuck-tool invariant fails).
//
//   Chapter "Prototype review" (seq 21..24):
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
//   • dense seqs 1..49 (model seqs 1..25, the system echo seq 26, then the Execution chapter seqs 27..49:
//     four 04.* Write leaves + their OUTPUT/`[context]` echoes, an integration wrap-up, the terminal 49).
//   • monotonic tMs; the terminal `result` (seq 49 / tMs 40000) is the strictly-highest seq AND tMs
//     (so `working` is non-null for every mid-run T but null at T = storyDurationMs — a finished
//     thought). The prototype-review surface frames (open_plan / prototype_gate at tMs 13800/15600),
//     the nested-plan surface frames (plan_changed at 0/19800, open_plan at 20200), the
//     comment-and-iterate surface frames (set_comments at 22000/22800/23600, open_plan{V2} at 24800),
//     and the Execution open_plan{null} (tMs 27000) carry no seq — they are SurfaceFrames, projected by
//     projectSurfaceState, never model frames.
//   • QUESTION INVARIANT: request.seq (3) < answer.seq (4) AND request.tMs (2000) <= answer.tMs (3600).
//   • The Task tool SPANS its group (tool_use seq 7 @ 5800 .. its tool_result seq 18 @ 10800); only the
//     LEAF tool pairs inside the group are atomic. The Task is the ONLY non-atomic tool — its result is
//     deferred to the group's end, which is exactly why it must be emitted explicitly (seq 18).
//   • subagent label path: `subagent_started` is an existing AgentStream kind that appendStream already
//     handles; emitting it through the widened ConvFrame Extract LABELS the group ("scope-recon")
//     WITHOUT any engine change.
const TASK_ID = "toolu_trailhead_task_scope_recon";
const GLOB_ID = "toolu_trailhead_glob_1";
const READ_ID = "toolu_trailhead_read_1";
const GREP_ID = "toolu_trailhead_grep_1";
const BASH_ID = "toolu_trailhead_bash_1";
const QUESTION_ID = "toolu_trailhead_ask_platform";
// Execution-chapter Write tool ids — one per 04.* detail leaf. Each leaf's tool_use + tool_result share
// the SAME id so derive() correlates the result onto its tool_use (atomic, no "running" leaf at rest).
const WRITE_0401_ID = "toolu_trailhead_write_0401";
const WRITE_0402_ID = "toolu_trailhead_write_0402";
const WRITE_0403_ID = "toolu_trailhead_write_0403";
const WRITE_0404_ID = "toolu_trailhead_write_0404";

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
  {
    // seq 1 — the user's kickoff request opens the beat (the first node is now a USER node).
    tMs: 0,
    chapterLabel: "Clarify",
    frame: {
      t: "user_message",
      seq: 1,
      text:
        "I want to build Trailhead — a mobile app that helps hikers find and log trails. Can you plan it?",
    },
  },
  {
    // seq 2 — the assistant's reply (streams via revealMs 900). Targeted by the token-reveal test.
    tMs: 900,
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
  {
    // seq 3 — an interactive AskUserQuestion permission request (the question card). While it is the
    // latest unresolved hold, derive() shows the WAITING_INPUT_LABEL working indicator.
    tMs: 2000,
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
    // seq 4 — the user's submitted answer. KEYED BY THE EXACT `question` STRING (derive folds by it).
    // The value matches NO option label → this is the "Other…" free-text demonstration: derive sets
    // the card's `answers` and the working indicator clears.
    tMs: 3600,
    frame: {
      t: "question_answered",
      id: QUESTION_ID,
      answers: { [PLATFORM_QUESTION]: PLATFORM_ANSWER },
      seq: 4,
    },
  },
  {
    // seq 5 — DEMO-AUTHORED echo: a standalone user bubble carrying the SAME free-text the user typed.
    // In the real app an "Other" pick folds onto the question card ONLY (no separate bubble); this echo
    // exists purely so the demo also shows the typed answer as a chat bubble. Shares the answer's tMs.
    tMs: 3600,
    frame: { t: "user_message", seq: 5, text: PLATFORM_ANSWER },
  },

  // ---- Chapter "Scope recon" -------------------------------------------------------------------
  {
    // seq 6 — the assistant acknowledges and starts scoping (streams via revealMs 1000).
    tMs: 4600,
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
    // OWN result is DEFERRED to seq 18 (the group's end) — so the Task spans the whole group.
    tMs: 5800,
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
            "Survey the Trailhead React-Native source: map the navigation layer, the screens, and where trail data lives. Report a concise summary.",
        },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 8 — a `subagent_started` frame LABELS the group (header → "scope-recon"). Keyed by
    // tool_use_id = TASK_ID (= the group key = every child's parent_tool_use_id). Produces NO timeline
    // node; it seeds the group metadata. (This is the widened-Extract conv frame.)
    tMs: 5800,
    frame: {
      t: "conv",
      ev: {
        seq: 8,
        kind: "subagent_started",
        tool_use_id: TASK_ID,
        subagent_type: "scope-recon",
        description: "Scope the Trailhead source tree",
        prompt:
          "Survey the Trailhead React-Native source: map the navigation layer, the screens, and where trail data lives. Report a concise summary.",
      },
    },
  },
  {
    // seq 9 — the subagent's first words (INSIDE the group, parent = TASK_ID). Non-empty so it renders.
    tMs: 6100,
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
    // seq 10 — LEAF tool: Glob for screen components (inside the group). Atomic with its result (seq 11).
    tMs: 7000,
    frame: {
      t: "conv",
      ev: {
        seq: 10,
        kind: "tool_use",
        id: GLOB_ID,
        tool: "Glob",
        input: { pattern: "src/**/*.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 11 — Glob result (SAME tMs as seq 10 = atomic; the leaf never lingers "running").
    tMs: 7000,
    frame: {
      t: "conv",
      ev: {
        seq: 11,
        kind: "tool_result",
        tool_use_id: GLOB_ID,
        content:
          "src/navigation/RootNavigator.tsx\nsrc/navigation/TabBar.tsx\nsrc/screens/TrailListScreen.tsx\nsrc/screens/TrailDetailScreen.tsx\nsrc/screens/LogHikeScreen.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 12 — LEAF tool: Read the root navigator (inside the group). Atomic with its result (seq 13).
    tMs: 7800,
    frame: {
      t: "conv",
      ev: {
        seq: 12,
        kind: "tool_use",
        id: READ_ID,
        tool: "Read",
        input: { file_path: "src/navigation/RootNavigator.tsx" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 13 — Read result (atomic with seq 12).
    tMs: 7800,
    frame: {
      t: "conv",
      ev: {
        seq: 13,
        kind: "tool_result",
        tool_use_id: READ_ID,
        content:
          "import { createNativeStackNavigator } from '@react-navigation/native-stack';\n\nconst Stack = createNativeStackNavigator();\n\nexport function RootNavigator() {\n  return (\n    <Stack.Navigator>\n      <Stack.Screen name=\"TrailList\" component={TrailListScreen} />\n      <Stack.Screen name=\"TrailDetail\" component={TrailDetailScreen} />\n    </Stack.Navigator>\n  );\n}",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 14 — LEAF tool: Grep for the navigator factory (inside the group). Atomic with seq 15.
    tMs: 8500,
    frame: {
      t: "conv",
      ev: {
        seq: 14,
        kind: "tool_use",
        id: GREP_ID,
        tool: "Grep",
        input: { pattern: "createNativeStackNavigator", output_mode: "files_with_matches" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 15 — Grep result (atomic with seq 14).
    tMs: 8500,
    frame: {
      t: "conv",
      ev: {
        seq: 15,
        kind: "tool_result",
        tool_use_id: GREP_ID,
        content: "src/navigation/RootNavigator.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 16 — LEAF tool: Bash list the screens dir (inside the group). Atomic with seq 17.
    tMs: 9200,
    frame: {
      t: "conv",
      ev: {
        seq: 16,
        kind: "tool_use",
        id: BASH_ID,
        tool: "Bash",
        input: { command: "ls src/screens" },
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 17 — Bash result (atomic with seq 16).
    tMs: 9200,
    frame: {
      t: "conv",
      ev: {
        seq: 17,
        kind: "tool_result",
        tool_use_id: BASH_ID,
        content:
          "MapScreen.tsx\nLogHikeScreen.tsx\nSettingsScreen.tsx\nTrailDetailScreen.tsx\nTrailListScreen.tsx\nProfileScreen.tsx",
        is_error: false,
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 18 — the subagent's closing summary text (inside the group).
    tMs: 10000,
    frame: {
      t: "conv",
      revealMs: 1200,
      ev: {
        seq: 18,
        kind: "assistant_text",
        text: "Mapped it: navigation in src/navigation, six screens in src/screens, trail data in src/data.",
        parent_tool_use_id: TASK_ID,
      },
    },
  },
  {
    // seq 19 — the Task's OWN tool_result (top-level, tool_use_id = TASK_ID). LOAD-BEARING: this is what
    // flips the top-level Task tool node running→done. WITHOUT it the Task row stays status:"running" at
    // T = duration and the no-stuck-tool invariant fails. (The Task is the ONLY non-atomic tool — its
    // result is deferred to here, the group's end.)
    tMs: 10800,
    frame: {
      t: "conv",
      ev: {
        seq: 19,
        kind: "tool_result",
        tool_use_id: TASK_ID,
        content:
          "Scope recon complete. Navigation: native-stack in src/navigation (RootNavigator + TabBar). Screens: six under src/screens (TrailList, TrailDetail, LogHike, Map, Settings, Profile). Trail data lives in src/data.",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 20 — the assistant's top-level wrap-up (streams via revealMs 1000).
    tMs: 11600,
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 20,
        kind: "assistant_text",
        text: "Scope recon complete — I have what I need to draft the plan.",
        parent_tool_use_id: null,
      },
    },
  },

  // ---- Chapter "Prototype review" --------------------------------------------------------------
  {
    // seq 21 — the assistant narrates the visual prototype (streams via revealMs 700). This bubble
    // lives on the Conversation tab; the prototype itself paints on the Plan tab (see the bracket).
    tMs: 13000,
    chapterLabel: "Prototype review",
    frame: {
      t: "conv",
      revealMs: 700,
      ev: {
        seq: 21,
        kind: "assistant_text",
        text:
          "I put together a quick visual prototype of the Trailhead flow — here's how a hike search moves through the screens.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // SURFACE — open the prototype-preview plan in the reading pane. This is the OPENING edge of the
    // open_plan bracket: while a plan is open the reconciler's structural projection makes
    // activeTab="plan" (the review bar + reading pane live on the Plan tab). Aligned with the gate ON.
    tMs: 13800,
    frame: { t: "open_plan", path: PROTO_PREVIEW_PATH },
  },
  {
    // SURFACE — the prototype gate turns ON (round 1): the review bar lights up "Visual prototype —
    // round 1 of 3". Production's onPrototypeReview force-switches to the Plan tab; here the open_plan
    // above already drives activeTab="plan", so the gate and the tab agree for the whole window.
    tMs: 13800,
    frame: { t: "prototype_gate", on: true, round: 1 },
  },
  {
    // SURFACE — the gate turns OFF (the user reviewed). Closing edge of the gate window.
    tMs: 15600,
    frame: { t: "prototype_gate", on: false },
  },
  {
    // SURFACE — close the reading pane (open_plan{path:null}). CLOSING edge of the bracket: with no
    // plan open the projection flips activeTab back to "conversation", so the reconciler clicks back to
    // the Conversation tab and the feedback/approval bubbles below are visible. Without this frame the
    // Plan tab would stay stuck (and the flip-back reconcile assertion goes RED).
    tMs: 15600,
    frame: { t: "open_plan", path: null },
  },
  {
    // seq 22 — the user's feedback on the prototype (a standalone user bubble on the Conversation tab).
    // Shares tMs 16000 with the system approval echo below (they land together).
    tMs: 16000,
    frame: {
      t: "user_message",
      seq: 22,
      text: "Love it — bump the trail-card size and add a difficulty badge.",
    },
  },
  {
    // seq 23 — DEMO-AUTHORED approval echo: a system bubble standing in for the review bar's Approve
    // click (in the real app clicking "Approve visual" resolves the gate; this echo exists purely so
    // the demo shows the approval as a chat row, like the seq-5 "Other" answer echo). Shares tMs 16000.
    tMs: 16000,
    frame: {
      t: "system_message",
      seq: 23,
      text: "Prototype approved with feedback — folding the changes into the plan.",
    },
  },
  {
    // seq 24 — the assistant acknowledges the feedback (streams via revealMs 1000).
    tMs: 16800,
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 24,
        kind: "assistant_text",
        text: "On it — larger trail cards and a difficulty badge. Drafting the plan now.",
        parent_tool_use_id: null,
      },
    },
  },

  // ---- Chapter "Nested plan" -------------------------------------------------------------------
  {
    // seq 25 — the assistant announces the drafted plan tree (streams via revealMs ~1200). This bubble
    // lives on the Conversation tab and narrates the nested plan the storyboard is about to reveal in
    // the sidebar (plan_changed below) + open in the reading pane (open_plan below).
    tMs: 19000,
    chapterLabel: "Nested plan",
    frame: {
      t: "conv",
      revealMs: 1200,
      ev: {
        seq: 25,
        kind: "assistant_text",
        text:
          "Here's the plan — a master with three subplans, plus a decomposition of the trail-detail screen into four leaves (including that difficulty badge you asked for).",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // SURFACE — the drafted Trailhead plan tree pops into the (until-now empty) sidebar: master + four
    // subs + four 04.* leaves. projectSurfaceState takes the last-≤-T plan_changed, so for any T in
    // [0, 19800) the sidebar is [] and for T ≥ 19800 it is TRAILHEAD_PLANS (a clean reveal).
    tMs: 19800,
    frame: { t: "plan_changed", plans: TRAILHEAD_PLANS },
  },
  {
    // SURFACE — open the master plan in the reading pane. LEFT OPEN (no closing open_plan{null}): the
    // beat ENDS on the still-open master, so activeTab stays "plan" and the master doc + its mermaid
    // decomposition diagram remain on screen at duration. Slice 06 comments on this still-open plan.
    tMs: 20200,
    frame: { t: "open_plan", path: TRAILHEAD_MASTER_PATH },
  },

  // ---- Chapter "Comment & iterate" -------------------------------------------------------------
  //
  // The master (TRAILHEAD_MASTER_PATH) is still open on the Plan tab. The user now leaves THREE comments
  // on it, one at a time — each `set_comments` SurfaceFrame projects the FULL comment set for that path,
  // so projectSurfaceState.comments grows 1 → 2 → 3 and the reconciler's applyComments paints that many
  // inline `.cmt-hl` highlights into the reading pane. HIGHLIGHTS-ONLY: no pending_reviews frame, no
  // review-bar count (see the comment consts above — driving the bar would auto-open + wipe highlights).
  {
    // SURFACE — comment 1 lands on the open V1 master (1 highlight).
    tMs: 22000,
    chapterLabel: "Comment & iterate",
    frame: { t: "set_comments", path: TRAILHEAD_MASTER_PATH, comments: [TRAILHEAD_COMMENT_1] },
  },
  {
    // SURFACE — comment 2 lands (full set [c1, c2] → 2 highlights).
    tMs: 22800,
    frame: { t: "set_comments", path: TRAILHEAD_MASTER_PATH, comments: [TRAILHEAD_COMMENT_1, TRAILHEAD_COMMENT_2] },
  },
  {
    // SURFACE — comment 3 lands (full set [c1, c2, c3] → 3 highlights).
    tMs: 23600,
    frame: {
      t: "set_comments",
      path: TRAILHEAD_MASTER_PATH,
      comments: [TRAILHEAD_COMMENT_1, TRAILHEAD_COMMENT_2, TRAILHEAD_COMMENT_3],
    },
  },
  {
    // SURFACE — switch the reading pane to the REVISED master (V2). No closing open_plan{null} — the
    // master stays open, so the beat ends on the Plan tab showing the revised doc. Because comments are
    // scoped to the OPEN path (projectSurfaceState), and V2 has no set_comments, projectSurfaceState
    // .comments is [] for T ≥ 24800 (the V1 comments do not paint on V2 — a clean iteration reveal).
    tMs: 24800,
    frame: { t: "open_plan", path: TRAILHEAD_MASTER_V2_PATH },
  },
  {
    // seq 26 — a system echo announcing the revision (a system bubble on the hidden Conversation tab).
    tMs: 25200,
    frame: {
      t: "system_message",
      seq: 26,
      text: "Revised the plan per your 3 comments — bigger trail cards and a difficulty badge are in.",
    },
  },

  // ---- Chapter "Execution" — the FINAL beat: build the four trail-detail leaves --------------------
  //
  // Plan approved → the assistant executes the four 04.* detail leaves FLAT (per-leaf, NO Task wrapper):
  // each leaf is one Write tool_use/tool_result pair (sharing a tMs = atomic, so the leaf never lingers
  // "running"), a leaf OUTPUT assistant_text, and a scripted `[context]` system_message that threads the
  // next leaf. All four leaves' OUTPUT texts (seqs 31/36/41/46) and `[context]` echoes (seqs 32/37/42/47)
  // are TOP-LEVEL (parent_tool_use_id: null) — they render as standalone bubbles, not nested in a group.
  //
  // DEMO-AUTHORED CONTEXT THREADING (load-bearing): the `[context] → NN.NN: …` system_messages are
  // SCRIPTED storyboard authoring, NOT emitted by a live orchestrator. The real app's multiplan driver
  // (orchestrator.ts) threads per-leaf context between sub-plans at runtime; here those handoffs are
  // hand-written so the demo SHOWS the threading without a live driver. Each is the seq-adjacent node
  // immediately AFTER its leaf's OUTPUT text (the seq-adjacency test pins outSeq→ctxSeq).
  {
    // SURFACE — the FIRST execution frame: open_plan{null} closes the reading pane (V2 master no longer
    // shown) so projectSurfaceState flips activeTab "plan"→"conversation" — the execution conversation
    // takes the foreground for the whole final chapter. Backward scrub reverts cleanly (pure fn of T).
    tMs: 27000,
    chapterLabel: "Execution",
    frame: { t: "open_plan", path: null },
  },
  {
    // seq 27 — the assistant announces execution (streams via revealMs). Top-level (Conversation tab).
    tMs: 27200,
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 27,
        kind: "assistant_text",
        text: "Plan approved — executing the four detail leaves now.",
        parent_tool_use_id: null,
      },
    },
  },

  // ---- Leaf 04.01 — Trail header + difficulty badge ----
  {
    // seq 28 — leaf 04.01 scaffolding narration (top-level).
    tMs: 28000,
    frame: {
      t: "conv",
      ev: {
        seq: 28,
        kind: "assistant_text",
        text: "04.01 · Trail header + difficulty badge — scaffolding.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 29 — Write tool_use for 04.01 (atomic with its result seq 30 — same tMs). Exact id correlates.
    tMs: 28800,
    frame: {
      t: "conv",
      ev: {
        seq: 29,
        kind: "tool_use",
        id: WRITE_0401_ID,
        tool: "Write",
        input: { file_path: "src/screens/TrailDetail/TrailHeader.tsx" },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 30 — Write result for 04.01 (SAME tMs as seq 29 = atomic; tool_use_id correlates by WRITE_0401_ID).
    tMs: 28800,
    frame: {
      t: "conv",
      ev: {
        seq: 30,
        kind: "tool_result",
        tool_use_id: WRITE_0401_ID,
        content: "Wrote src/screens/TrailDetail/TrailHeader.tsx",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 31 — leaf 04.01 OUTPUT (top-level). The `[context]` system_message (seq 32) is seq-adjacent next.
    tMs: 29400,
    frame: {
      t: "conv",
      ev: {
        seq: 31,
        kind: "assistant_text",
        text: "Done — colour-coded difficulty badge.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 32 — DEMO-AUTHORED `[context]` thread → 04.02 (top-level system bubble; seq-adjacent after seq 31).
    tMs: 29900,
    frame: {
      t: "system_message",
      seq: 32,
      text: "[context] → 04.02: difficulty palette {easy/moderate/hard} lives in TrailHeader; reuse it.",
    },
  },

  // ---- Leaf 04.02 — Elevation chart ----
  {
    // seq 33 — leaf 04.02 narration (top-level).
    tMs: 30600,
    frame: {
      t: "conv",
      ev: {
        seq: 33,
        kind: "assistant_text",
        text: "04.02 · Elevation chart — reusing the palette from 04.01.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 34 — Write tool_use for 04.02 (atomic with seq 35).
    tMs: 31400,
    frame: {
      t: "conv",
      ev: {
        seq: 34,
        kind: "tool_use",
        id: WRITE_0402_ID,
        tool: "Write",
        input: { file_path: "src/screens/TrailDetail/ElevationChart.tsx" },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 35 — Write result for 04.02 (atomic with seq 34).
    tMs: 31400,
    frame: {
      t: "conv",
      ev: {
        seq: 35,
        kind: "tool_result",
        tool_use_id: WRITE_0402_ID,
        content: "Wrote src/screens/TrailDetail/ElevationChart.tsx",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 36 — leaf 04.02 OUTPUT (top-level).
    tMs: 32000,
    frame: {
      t: "conv",
      ev: {
        seq: 36,
        kind: "assistant_text",
        text: "Done — elevation tinted by difficulty.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 37 — DEMO-AUTHORED `[context]` thread → 04.03 (seq-adjacent after seq 36).
    tMs: 32500,
    frame: {
      t: "system_message",
      seq: 37,
      text: "[context] → 04.03: chart exposes onSegmentPress.",
    },
  },

  // ---- Leaf 04.03 — Reviews ----
  {
    // seq 38 — leaf 04.03 narration (top-level).
    tMs: 33200,
    frame: {
      t: "conv",
      ev: {
        seq: 38,
        kind: "assistant_text",
        text: "04.03 · Reviews — deep-linking to elevation segments.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 39 — Write tool_use for 04.03 (atomic with seq 40).
    tMs: 34000,
    frame: {
      t: "conv",
      ev: {
        seq: 39,
        kind: "tool_use",
        id: WRITE_0403_ID,
        tool: "Write",
        input: { file_path: "src/screens/TrailDetail/Reviews.tsx" },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 40 — Write result for 04.03 (atomic with seq 39).
    tMs: 34000,
    frame: {
      t: "conv",
      ev: {
        seq: 40,
        kind: "tool_result",
        tool_use_id: WRITE_0403_ID,
        content: "Wrote src/screens/TrailDetail/Reviews.tsx",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 41 — leaf 04.03 OUTPUT (top-level).
    tMs: 34600,
    frame: {
      t: "conv",
      ev: {
        seq: 41,
        kind: "assistant_text",
        text: "Done — reviews with segment deep-links.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 42 — DEMO-AUTHORED `[context]` thread → 04.04 (seq-adjacent after seq 41).
    tMs: 35100,
    frame: {
      t: "system_message",
      seq: 42,
      text: "[context] → 04.04: reviews surface the shareable highlights.",
    },
  },

  // ---- Leaf 04.04 — Save / share ----
  {
    // seq 43 — leaf 04.04 narration (top-level).
    tMs: 35800,
    frame: {
      t: "conv",
      ev: {
        seq: 43,
        kind: "assistant_text",
        text: "04.04 · Save / share — wiring the share sheet.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 44 — Write tool_use for 04.04 (atomic with seq 45).
    tMs: 36600,
    frame: {
      t: "conv",
      ev: {
        seq: 44,
        kind: "tool_use",
        id: WRITE_0404_ID,
        tool: "Write",
        input: { file_path: "src/screens/TrailDetail/ShareSheet.tsx" },
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 45 — Write result for 04.04 (atomic with seq 44).
    tMs: 36600,
    frame: {
      t: "conv",
      ev: {
        seq: 45,
        kind: "tool_result",
        tool_use_id: WRITE_0404_ID,
        content: "Wrote src/screens/TrailDetail/ShareSheet.tsx",
        is_error: false,
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 46 — leaf 04.04 OUTPUT (top-level).
    tMs: 37200,
    frame: {
      t: "conv",
      ev: {
        seq: 46,
        kind: "assistant_text",
        text: "Done — save + share with review highlights.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 47 — DEMO-AUTHORED `[context]` thread → integration (seq-adjacent after seq 46).
    tMs: 37700,
    frame: {
      t: "system_message",
      seq: 47,
      text: "[context] → integration: all four leaves compose the Trail-detail screen.",
    },
  },
  {
    // seq 48 — integration wrap-up (streams via revealMs; top-level).
    tMs: 38600,
    frame: {
      t: "conv",
      revealMs: 1000,
      ev: {
        seq: 48,
        kind: "assistant_text",
        text: "Integrated all four detail leaves into the Trail-detail screen — Trailhead is ready to ship.",
        parent_tool_use_id: null,
      },
    },
  },
  {
    // seq 49 — terminal `result` frame: the turn FINISHES. STRICTLY the highest seq (49) AND tMs (40000),
    // so `working` is non-null for every mid-run T but null at T = storyDurationMs (a finished thought,
    // not a perpetual spinner). It lands on the Conversation tab (no plan open since the open_plan{null}
    // at 27000); the terminal only clears `working`. The non-wire bookkeeping fields are benign fixture
    // values — derive() never keys rendering off them (only `is_error`/`result`).
    tMs: 40000,
    chapterLabel: "Done",
    frame: {
      t: "conv",
      ev: {
        seq: 49,
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
  },
];
