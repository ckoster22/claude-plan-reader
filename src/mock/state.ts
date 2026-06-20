// Mock-mode in-memory store — the single source of truth the Tauri shims read.
//
// Framework-free. The shims (core.ts / event.ts / …) read this; the control deck (deck.ts) and
// later scenes mutate it via the typed setters below. Seeded from src/mock/fixtures/* on module
// load. Keep this disjoint from any DOM concern — it holds DATA, not rendering.

import type { PlanRecord, ReviewRequest } from "../types";
import type { AgentStream, AskUserQuestionAnswers } from "../conversation/types";
import { clonePlans } from "./fixtures/plans";
import { MOCK_MARKDOWN, fallbackMarkdown } from "./fixtures/markdown";
import { DEFAULT_SCENE, type SceneName } from "./fixtures/scenes";

// The canned home directory the mock path.homeDir resolves to (drives "~/…" collapse in the
// sidebar). Exported so the shims and fixtures can agree on one value.
export const MOCK_HOME = "/Users/mock";

// A generic, untyped bag for knob values (Phase 4 fleshes out the deck). Kept loose on purpose —
// each knob owns its own value shape; the store just persists them.
export type Knobs = Record<string, unknown>;

// The whole mock state in one object so reset()/getters stay trivial and aliasing is contained.
interface MockState {
  // Sidebar plan records (what list_plans returns).
  plans: PlanRecord[];
  // path -> markdown document (what read_plan_contents returns).
  markdownByPath: Record<string, string>;
  // Pending plan reviews (what list_pending_reviews returns); default empty.
  pendingReviews: ReviewRequest[];
  // Auth status (what agent_auth_status returns).
  auth: { hasToken: boolean };
  // The active conversation scene's ordered frames (Phase 2 replays these through the event bus).
  // Held here so the deck can stage a scene before the conversation listeners exist.
  frames: AgentStream[];
  // The name of the ACTIVE conversation scene (the one start_agent_session / playScene replays).
  // Defaults to a sensible scene so a Start with no explicit scene selection still shows something.
  activeScene: SceneName;
  // Answers recorded from the most recent resolve_tool_permission, keyed by the held request id.
  // Lets a follow-up frame (or a test) read back what the user chose. Cleared on a new scene load.
  answersById: Record<string, AskUserQuestionAnswers>;
  // The comment count the mock `get_comment_count` returns for the open plan (the Review-bar
  // "comment count" knob drives this; a re-open cold-reads it so the bar's VIEWING count reflects it).
  commentCount: number;
  // Generic knob values bag.
  knobs: Knobs;
}

// Build a fresh state from the fixtures (used for init + reset).
function freshState(): MockState {
  return {
    plans: clonePlans(),
    markdownByPath: { ...MOCK_MARKDOWN },
    pendingReviews: [],
    auth: { hasToken: true },
    frames: [],
    activeScene: DEFAULT_SCENE,
    answersById: {},
    commentCount: 0,
    knobs: {},
  };
}

let state: MockState = freshState();

// ---- getters ----

export function getPlans(): PlanRecord[] {
  return state.plans;
}

// Markdown for a path; falls back to a "(mock) no fixture" document so a read never returns blank.
export function getMarkdown(path: string): string {
  return state.markdownByPath[path] ?? fallbackMarkdown(path);
}

export function hasMarkdown(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.markdownByPath, path);
}

export function getPendingReviews(): ReviewRequest[] {
  return state.pendingReviews;
}

export function getAuth(): { hasToken: boolean } {
  return state.auth;
}

export function getFrames(): AgentStream[] {
  return state.frames;
}

export function getActiveScene(): SceneName {
  return state.activeScene;
}

export function getAnswers(id: string): AskUserQuestionAnswers | undefined {
  return state.answersById[id];
}

export function getKnob<T = unknown>(id: string): T | undefined {
  return state.knobs[id] as T | undefined;
}

export function getCommentCount(): number {
  return state.commentCount;
}

// ---- setters ----

export function setPlans(plans: PlanRecord[]): void {
  state.plans = plans;
}

export function setMarkdown(path: string, doc: string): void {
  state.markdownByPath[path] = doc;
}

export function setPendingReviews(reviews: ReviewRequest[]): void {
  state.pendingReviews = reviews;
}

export function setAuth(auth: { hasToken: boolean }): void {
  state.auth = auth;
}

export function setFrames(frames: AgentStream[]): void {
  state.frames = frames;
}

export function setActiveScene(name: SceneName): void {
  state.activeScene = name;
}

export function recordAnswers(id: string, answers: AskUserQuestionAnswers): void {
  state.answersById[id] = answers;
}

// Clear all recorded answers (e.g. on a fresh scene load) so a previous scene's answers never leak.
export function clearAnswers(): void {
  state.answersById = {};
}

export function setKnob(id: string, value: unknown): void {
  state.knobs[id] = value;
}

// The comment count the mock get_comment_count returns (clamped to >= 0). The Review-bar "comment
// count" knob sets this; a re-open of the reviewed plan cold-reads it so the bar reflects it.
export function setCommentCount(n: number): void {
  state.commentCount = Math.max(0, Math.floor(n));
}

// Reset the entire store back to the fixture seed (handy for the deck / tests).
export function resetState(): void {
  state = freshState();
}

// ---- knob-store persistence ACROSS a conversation-jump reload --------------------------------
//
// Conversation jumps reload the page (the clean-model seam — see api.ts). A reload otherwise drops the
// in-memory knob store, so non-global knobs (sidebar count, etc.) silently revert to defaults and the
// deck rebuilds its controls at defaults. To keep the harness usable, the knob slice (+ commentCount,
// the one non-knob value a knob drives) is stashed in sessionStorage BEFORE the reload and restored on
// boot BEFORE seedKnobDefaults() + before the deck builds controls — so BOTH the applied state and the
// deck's control values survive the jump. Scoped to mock mode via the `mockdeck:` key prefix; never
// touches localStorage (theme/text-size already persist there via the production code). sessionStorage
// (not localStorage) so the persistence is scoped to the tab session and never leaks across launches.

const KNOBS_SESSION_KEY = "mockdeck:knobs";

// The serialized shape (knobs bag + the comment count a knob drives).
interface PersistedKnobs {
  knobs: Knobs;
  commentCount: number;
}

// Best-effort sessionStorage access (absent in some jsdom configs / privacy modes). Returns null when
// unavailable so callers no-op rather than throw.
function sessionStore(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

// Stash the current knob slice (+ commentCount) into sessionStorage. Called right BEFORE a
// conversation-jump reload. No-op (swallows) if sessionStorage is unavailable or serialization fails.
export function persistKnobsToSession(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    const payload: PersistedKnobs = { knobs: state.knobs, commentCount: state.commentCount };
    store.setItem(KNOBS_SESSION_KEY, JSON.stringify(payload));
  } catch {
    // ignore — persistence is a convenience, never load-bearing for correctness.
  }
}

// Restore the knob slice (+ commentCount) from sessionStorage into the current store, then CLEAR the
// stash (so a later manual refresh starts clean). Called on boot BEFORE seedKnobDefaults() + the deck's
// control build. Returns the restored knob bag (so the deck can seed its controls from it), or null
// when nothing was stashed / it was unreadable. Restored values OVERRIDE the fresh state; seedKnobDefaults
// then fills only the knobs NOT present in the restored bag (see deck.ts).
export function restoreKnobsFromSession(): Knobs | null {
  const store = sessionStore();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(KNOBS_SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  // Consume-once: clear the stash so a subsequent manual refresh (no fresh stash written) starts clean.
  try {
    store.removeItem(KNOBS_SESSION_KEY);
  } catch {
    // ignore
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedKnobs>;
    if (!parsed || typeof parsed !== "object" || !parsed.knobs || typeof parsed.knobs !== "object") {
      return null;
    }
    state.knobs = { ...parsed.knobs };
    if (typeof parsed.commentCount === "number") {
      state.commentCount = Math.max(0, Math.floor(parsed.commentCount));
    }
    return state.knobs;
  } catch {
    return null;
  }
}
