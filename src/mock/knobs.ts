// Mock-mode KNOBS — typed, live controls that re-drive ONE surface in place.
//
// Each knob is a self-contained definition: { id, group, label, kind, options?, default, apply }. The
// deck (deck.ts) renders an input per knob (toggle/select/number/text) and calls knob.apply(value) on
// change. `apply` mutates the mock store + RE-DRIVES ONLY the affected surface by reusing the SAME
// production seams the __mock jumpers use (theme/text-size click the real titlebar buttons; sidebar
// re-lists via list_plans + a plan-changed event; reading pane via the real openPlan; conversation via
// the real scene player; review bar via the real appliers driven by the fake orchestrator gate). No
// rendering logic is duplicated here — a knob only chooses INPUTS and calls an existing driver.
//
// FIDELITY: knobs that need a fixture parameter the canned scenes don't carry (question count /
// multiSelect / include-Other, comment count, prototype round) extend the relevant fixture BUILDER
// (questions.buildQuestions, reviews.gateSnapshot(round), core get_comment_count) — kept typed — and
// feed it through the real seam. A knob never reaches into the DOM except to drive a REAL control (the
// theme/text-size buttons + the filter input), exactly as a user would.

import { emitMockEvent } from "./event";
import { playScene, reset } from "./api";
import {
  setPlans,
  setKnob,
  getKnob,
} from "./state";
import { buildSidebarPlans } from "./fixtures/plans";
import { buildQuestions } from "./fixtures/questions";
import { emitGate, emitPlaceholderSnapshot, clearGate } from "./orchestrator";
import { playSceneFrames } from "./player";
import { systemInitFrame, questionPermissionFrame, resultFrame } from "./fixtures/scenes";
import type { SceneName } from "./fixtures/scenes";

// The knob groups (mirror the plan's Phase-4 knob-group list). Used by the deck to section the panel.
export type KnobGroup =
  | "Global"
  | "Sidebar"
  | "Reading pane"
  | "Conversation"
  | "Question card"
  | "Review bar"
  | "Modals";

// The input KIND the deck renders for a knob.
export type KnobKind = "toggle" | "select" | "number" | "text";

// A single select option: the stored value + its human label.
export interface KnobOption {
  value: string;
  label: string;
}

// A typed knob definition. `default` seeds the control + the store; `apply(value)` re-drives the
// surface. `value` is `unknown` at the boundary (each kind carries its own runtime shape — boolean for
// toggle, string for select/text, number for number); each apply narrows it.
export interface Knob {
  id: string;
  group: KnobGroup;
  label: string;
  kind: KnobKind;
  // Present only for `select`.
  options?: KnobOption[];
  // The initial value (boolean | string | number).
  default: boolean | string | number;
  // Re-drive the affected surface for the new value.
  apply(value: unknown): void;
}

// ---- small helpers (REAL-control drivers, no rendering logic) --------------------------------

// Re-list the sidebar faithfully: stash the records the mock list_plans should return, then emit a
// plan-changed event — main.ts's handler re-invokes list_plans → refreshList → renderSidebar. This is
// the SAME path a real on-disk plan change takes; the deck never calls renderSidebar directly.
function relistSidebar(): void {
  emitMockEvent("plan-changed", { path: "/Users/mock/.claude/plans/unread-standalone.md" });
}

// Drive the REAL sidebar filter input (#plan-filter): set its value + dispatch an `input` event so
// main.ts's listener runs applyFilterAndRender against the live query — exactly a user typing.
function setFilterText(text: string): void {
  const input = document.getElementById("plan-filter") as HTMLInputElement | null;
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Drive the REAL theme toggle (#theme-toggle) toward a target. Reads the current data-theme and clicks
// only if a flip is needed (the click handler owns the data-theme + persistence). Idempotent.
function setTheme(target: "dark" | "light"): void {
  const isDark = document.documentElement.dataset.theme === "dark";
  const wantDark = target === "dark";
  if (isDark === wantDark) return;
  document.getElementById("theme-toggle")?.click();
}

// Drive the REAL text-size steppers (#text-dec / #text-inc) toward a target px on the ladder. Clicks
// the appropriate stepper repeatedly until the CSS var matches (or the stepper clamps). The steppers
// own the ladder + persistence; we just press the buttons a user would.
function setTextSize(targetPx: number): void {
  const root = document.documentElement;
  const dec = document.getElementById("text-dec");
  const inc = document.getElementById("text-inc");
  const readPx = (): number =>
    parseInt(root.style.getPropertyValue("--reading-font-size") || "15", 10) || 15;
  // Bounded loop: the ladder has 6 rungs, so at most ~6 presses are ever needed; cap to avoid any
  // pathological non-convergence (a clamped stepper stops changing the value → we break).
  for (let i = 0; i < 12; i++) {
    const cur = readPx();
    if (cur === targetPx) break;
    const before = cur;
    (cur < targetPx ? inc : dec)?.click();
    if (readPx() === before) break; // clamped at a ladder end — stop pressing
  }
}

// The Sidebar knob group re-lists from the THREE sidebar knob values together (count / unread / tree),
// so changing any one re-derives a coherent list. Reads the current values from the store (seeded with
// the defaults) so a single knob change keeps the others.
function applySidebarFromKnobs(): void {
  const count = (getKnob<number>("sidebar.count") ?? 4);
  const unread = (getKnob<number>("sidebar.unread") ?? 1);
  const tree = (getKnob<boolean>("sidebar.tree") ?? true);
  setPlans(buildSidebarPlans({ count, unread, tree }));
  relistSidebar();
}

// ---- the knob registry ----------------------------------------------------------------------

export const KNOBS: Knob[] = [
  // ---- Global ----
  {
    id: "global.theme",
    group: "Global",
    label: "Theme",
    kind: "select",
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ],
    default: "dark",
    apply: (v) => setTheme(v === "light" ? "light" : "dark"),
  },
  {
    id: "global.textSize",
    group: "Global",
    label: "Reading text size",
    kind: "select",
    options: [13, 14, 15, 17, 19, 21].map((px) => ({ value: String(px), label: `${px}px` })),
    default: "15",
    apply: (v) => setTextSize(parseInt(String(v), 10) || 15),
  },

  // ---- Sidebar ----
  {
    id: "sidebar.count",
    group: "Sidebar",
    label: "Plan count",
    kind: "number",
    default: 4,
    apply: (v) => {
      setKnob("sidebar.count", Math.max(0, Math.floor(Number(v) || 0)));
      applySidebarFromKnobs();
    },
  },
  {
    id: "sidebar.unread",
    group: "Sidebar",
    label: "Unread count",
    kind: "number",
    default: 1,
    apply: (v) => {
      setKnob("sidebar.unread", Math.max(0, Math.floor(Number(v) || 0)));
      applySidebarFromKnobs();
    },
  },
  {
    id: "sidebar.tree",
    group: "Sidebar",
    label: "Tree (master + subs)",
    kind: "toggle",
    default: true,
    apply: (v) => {
      setKnob("sidebar.tree", Boolean(v));
      applySidebarFromKnobs();
    },
  },
  {
    id: "sidebar.placeholder",
    group: "Sidebar",
    label: "Live-run placeholder",
    kind: "toggle",
    default: false,
    apply: (v) => {
      // ON → fan a gate-less ACTIVE snapshot (main.ts mints `.plan.placeholder.active`); OFF →
      // clear the gate (deregisters the active orchestrator → the agent-exit/clear path drops it).
      if (v) emitPlaceholderSnapshot();
      else clearGate();
    },
  },
  {
    id: "sidebar.filter",
    group: "Sidebar",
    label: "Filter text",
    kind: "text",
    default: "",
    apply: (v) => setFilterText(String(v ?? "")),
  },

  // ---- Reading pane ----
  {
    id: "reading.doc",
    group: "Reading pane",
    label: "Sample doc",
    kind: "select",
    options: [
      { value: "mermaid", label: "Mermaid" },
      { value: "table", label: "Table" },
      { value: "code", label: "Code" },
      { value: "image", label: "Image" },
      { value: "error", label: "Error fallback" },
    ],
    default: "mermaid",
    // openDoc resets + opens the variant through the real openPlan path.
    apply: (v) => void window.__mock?.openDoc(v as never),
  },

  // ---- Conversation ----
  {
    id: "conv.session",
    group: "Conversation",
    label: "Session state",
    kind: "select",
    options: [
      { value: "none", label: "None" },
      { value: "active", label: "Active" },
      { value: "idle", label: "Idle" },
    ],
    default: "active",
    apply: (v) => {
      // none → clearConversation() routes the "none" sentinel through the reload seam so the LIVE model
      // is REBUILT FRESH and NOTHING is staged → a genuinely empty conversation pane. (A plain reset()
      // here would leave prior scene nodes on screen — the live ConversationModel has no in-place reset,
      // so an exit node just appends. See CONVERSATION-RESET in api.ts.) active → a scene with NO
      // terminal result (toolRunning stays generating). idle → a scene that ENDS with a result
      // (resultSuccess → idle, working indicator hidden). Each routes through the real scene player.
      if (v === "none") window.__mock?.clearConversation();
      else if (v === "idle") playScene("resultSuccess");
      else playScene("toolRunning");
    },
  },
  {
    id: "conv.paneSource",
    group: "Conversation",
    label: "Pane source",
    kind: "select",
    options: [
      { value: "live", label: "Live" },
      { value: "history", label: "History replay" },
      { value: "empty", label: "Empty" },
    ],
    default: "live",
    apply: (v) => {
      if (v === "history") void window.__mock?.showHistory();
      else if (v === "empty") void window.__mock?.showEmptyConversation();
      else playScene("assistantText");
    },
  },
  {
    id: "conv.tool",
    group: "Conversation",
    label: "Add tool",
    kind: "select",
    options: [
      { value: "running", label: "Running" },
      { value: "done", label: "Done" },
      { value: "error", label: "Error" },
    ],
    default: "done",
    apply: (v) => {
      const scene: SceneName =
        v === "running" ? "toolRunning" : v === "error" ? "toolError" : "toolDone";
      playScene(scene);
    },
  },
  {
    id: "conv.bubble",
    group: "Conversation",
    label: "Add bubble",
    kind: "select",
    options: [
      { value: "assistant", label: "Assistant" },
      { value: "user", label: "User" },
      { value: "system", label: "System" },
    ],
    default: "assistant",
    apply: (v) => {
      // assistant → the assistantText scene. user/system bubbles are appended on top of an
      // assistant scene via the live model echo seam (appendUserMessage / a system message in
      // history replay); the simplest faithful single-surface drive is the assistantText scene for
      // "assistant" and a history replay (which carries a user turn) for "user"/"system".
      if (v === "user" || v === "system") void window.__mock?.showHistory();
      else playScene("assistantText");
    },
  },
  {
    id: "conv.working",
    group: "Conversation",
    label: "Working indicator",
    kind: "toggle",
    default: false,
    // ON → a scene that stays ACTIVE (no result → the working indicator shows). OFF → a scene that
    // ENDS with a result (the indicator hides). Both through the real player.
    apply: (v) => playScene(v ? "toolRunning" : "resultSuccess"),
  },
  {
    id: "conv.subagent",
    group: "Conversation",
    label: "Subagent group",
    kind: "toggle",
    default: false,
    apply: (v) => playScene(v ? "subagentGroup" : "assistantText"),
  },
  {
    id: "conv.result",
    group: "Conversation",
    label: "Result kind",
    kind: "select",
    options: [
      { value: "success", label: "Success" },
      { value: "error", label: "Error" },
      { value: "interrupted", label: "Interrupted" },
    ],
    default: "success",
    apply: (v) => {
      const scene: SceneName =
        v === "error" ? "resultError" : v === "interrupted" ? "resultInterrupted" : "resultSuccess";
      playScene(scene);
    },
  },

  // ---- Question card ----
  // The three question knobs compose ONE question card (count / multiSelect / include-Other), so each
  // re-derives the whole card from the current trio. Driven through the REAL scene player via a custom
  // permission frame carrying buildQuestions(opts) — the same tool-permission-requested seam the
  // questionCard scene uses, so renderQuestionCard draws the interactive card.
  {
    id: "question.count",
    group: "Question card",
    label: "Question count",
    kind: "number",
    default: 2,
    apply: (v) => {
      setKnob("question.count", Math.max(1, Math.floor(Number(v) || 1)));
      // Capture the full trio+answered BEFORE driveQuestionCard's reset() wipes the knob store.
      driveQuestionCard(readQuestionCardOpts());
    },
  },
  {
    id: "question.multiSelect",
    group: "Question card",
    label: "multiSelect",
    kind: "toggle",
    default: false,
    apply: (v) => {
      setKnob("question.multiSelect", Boolean(v));
      driveQuestionCard(readQuestionCardOpts());
    },
  },
  {
    id: "question.other",
    group: "Question card",
    label: "Include Other…",
    kind: "toggle",
    default: true,
    apply: (v) => {
      setKnob("question.other", Boolean(v));
      driveQuestionCard(readQuestionCardOpts());
    },
  },
  {
    id: "question.answered",
    group: "Question card",
    label: "Answered vs pending",
    kind: "toggle",
    default: false,
    apply: (v) => {
      setKnob("question.answered", Boolean(v));
      driveQuestionCard(readQuestionCardOpts());
    },
  },

  // ---- Review bar ----
  {
    id: "review.mode",
    group: "Review bar",
    label: "Mode",
    kind: "select",
    options: [
      { value: "hidden", label: "Hidden" },
      { value: "viewing", label: "Viewing" },
      { value: "summary", label: "Summary" },
      { value: "prototype", label: "Prototype" },
      { value: "acceptance", label: "Acceptance" },
    ],
    default: "viewing",
    apply: (v) => {
      if (v === "hidden") window.__mock?.clearReview();
      // Capture the round + comment count BEFORE the driver's reset() wipes the knob store/count.
      else if (v === "prototype") emitReviewWithRound("prototype", readProtoRound());
      else if (v === "acceptance") emitReviewWithRound("acceptance", readProtoRound());
      else void window.__mock?.showReview(v as never, getKnob<number>("review.comments") ?? 0);
    },
  },
  {
    id: "review.comments",
    group: "Review bar",
    label: "Comment count",
    kind: "number",
    default: 0,
    apply: (v) => {
      // Capture the count, then RE-OPEN the reviewed plan via showReview("viewing", count) so main.ts's
      // cold-read (refreshCommentCount via openPlan) picks it up → the VIEWING bar's count + Submit
      // state reflect it. showReview's internal reset() zeroes the store's count, so we thread the count
      // EXPLICITLY (re-applied after that reset, before the cold-read) instead of setting it here only to
      // have it wiped. Also persist it in the knob store so review.mode + the reload-persistence read it.
      const count = Math.max(0, Math.floor(Number(v) || 0));
      setKnob("review.comments", count);
      void window.__mock?.showReview("viewing", count);
    },
  },
  {
    id: "review.protoRound",
    group: "Review bar",
    label: "Prototype round",
    kind: "select",
    options: [1, 2, 3].map((r) => ({ value: String(r), label: `Round ${r}` })),
    default: "1",
    apply: (v) => {
      const round = Math.min(3, Math.max(1, parseInt(String(v), 10) || 1));
      setKnob("review.protoRound", round);
      // Capture the round BEFORE emitReviewWithRound's reset() wipes the knob store.
      emitReviewWithRound("prototype", round);
    },
  },

  // ---- Modals ----
  {
    id: "modal.composer",
    group: "Modals",
    label: "Composer",
    kind: "toggle",
    default: false,
    apply: (v) => {
      if (v) window.__mock?.openComposer();
      else document.getElementById("composer-cancel")?.click();
    },
  },
  {
    id: "modal.auth",
    group: "Modals",
    label: "Auth onboarding",
    kind: "toggle",
    default: false,
    apply: (v) => {
      if (v) window.__mock?.showAuthOnboarding();
      else document.getElementById("composer-cancel")?.click();
    },
  },
];

// ---- composite drivers (multiple knobs → one surface) ---------------------------------------

// The four question-card knob values that compose ONE card. Captured from the store BEFORE reset()
// (which wipes the knob slice) and threaded in EXPLICITLY so each knob's value visibly takes effect.
interface QuestionCardOpts {
  count: number;
  multiSelect: boolean;
  includeOther: boolean;
  answered: boolean;
}

// Read the current question-card knob values from the store (with each knob's default as the fallback).
// Callers MUST read this BEFORE driveQuestionCard's reset() runs, then pass it in.
function readQuestionCardOpts(): QuestionCardOpts {
  return {
    count: getKnob<number>("question.count") ?? 2,
    multiSelect: getKnob<boolean>("question.multiSelect") ?? false,
    includeOther: getKnob<boolean>("question.other") ?? true,
    answered: getKnob<boolean>("question.answered") ?? false,
  };
}

// Drive the question card from EXPLICIT knob values (count / multiSelect / other / answered). Resets
// first (clean model), then stages a minimal scene — system_init + a permission frame carrying
// buildQuestions(opts) — through the REAL player so renderQuestionCard draws the card. When "answered"
// is on, a result frame follows so the card is no longer the active hold (the deck does not script a
// click; the answered variant is documented as the result-present state). Conversation-tab surface, so
// it routes through the clean-model reset (no reload needed in-place here — the deck calls this after a
// reset()). The opts are CAPTURED BY THE CALLER before reset() (which wipes the knob store), so the
// chosen values survive the reset and visibly take effect.
function driveQuestionCard(opts: QuestionCardOpts): void {
  reset();
  const { count, multiSelect, includeOther, answered } = opts;
  const questions = buildQuestions({ count, multiSelect, includeOther });
  const frames = [
    { event: "agent-stream" as const, payload: systemInitFrame(1) },
    questionPermissionFrame("ask-knob-1", questions),
    // The answered variant: a result frame ends the turn (the card stops being the active hold). The
    // interactive→answered click flip is exercised by the scenes test; here the deck shows the
    // pending vs result-present states.
    ...(answered ? [{ event: "agent-stream" as const, payload: resultFrame(3) }] : []),
  ];
  playSceneFrames(frames);
  // Show the Conversation tab so the card is visible.
  const row = document.querySelector<HTMLElement>(".reader-tab-row");
  if (row) {
    for (const tab of row.querySelectorAll<HTMLElement>(".tab")) {
      tab.classList.toggle("active", tab.dataset.tab === "conversation");
    }
    document.getElementById("tab-plan")?.classList.toggle("active", false);
    document.getElementById("tab-conversation")?.classList.toggle("active", true);
  }
}

// Read the current prototype-round knob value (default 1). Callers MUST read this BEFORE
// emitReviewWithRound's reset() runs, then pass it in.
function readProtoRound(): number {
  return getKnob<number>("review.protoRound") ?? 1;
}

// Drive a prototype/acceptance review bar carrying an EXPLICIT prototype round. Resets first, then fans
// the gate snapshot at that round through the fake orchestrator (the real applyPrototypeBar /
// applyAcceptanceBar render the bar). Plan-tab surface — the in-place reset is sufficient. The round is
// CAPTURED BY THE CALLER before reset() (which wipes the knob store), so the chosen round survives the
// reset and visibly takes effect in the bar label.
function emitReviewWithRound(which: "prototype" | "acceptance", round: number): void {
  reset();
  emitGate(which, round);
  const row = document.querySelector<HTMLElement>(".reader-tab-row");
  if (row) {
    for (const tab of row.querySelectorAll<HTMLElement>(".tab")) {
      tab.classList.toggle("active", tab.dataset.tab === "plan");
    }
    document.getElementById("tab-conversation")?.classList.toggle("active", false);
    document.getElementById("tab-plan")?.classList.toggle("active", true);
  }
}

// Seed every knob's default into the store so the composite drivers read coherent values before the
// first explicit change. Called by the deck on load. Does NOT apply (no surface re-drive) — just seeds.
// FILL-ONLY-WHERE-MISSING: a knob already present in the store (e.g. restored from sessionStorage after
// a conversation-jump reload — see state.restoreKnobsFromSession) is left UNTOUCHED, so a value that
// survived the reload is not clobbered back to its default. Knobs absent from the store get their default.
export function seedKnobDefaults(): void {
  for (const k of KNOBS) {
    if (getKnob(k.id) === undefined) setKnob(k.id, k.default);
  }
}
