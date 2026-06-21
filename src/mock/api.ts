// Mock-mode automation hook — `window.__mock`.
//
// A small, typed scripting surface for driving the app's distinct VISUAL STATES without burning a
// single LLM token. Installed in mock mode by deck.ts (which imports installMockApi). Used by the
// visual checks (a human / chrome-devtools agent calls window.__mock.*), by the Phase-4 control deck
// (the same entry points), and by the mock test suite.
//
// Every method drives the REAL production render code through the narrowest faithful seam:
//   • playScene       — replays canned AgentStream frames through the real ConversationModel + renderTree.
//   • showReview      — paints the review bar's 4 modes through the real appliers (see per-case notes).
//   • showResume      — drives the exported renderResumeBanner with a fixture verdict.
//   • openDoc         — opens a reading-pane variant plan (mermaid/table/code/image/error) via openPlan.
//   • showHistory / showEmptyConversation — selects a plan whose mock transcript drives the history pane.
//   • openComposer / showAuthOnboarding   — opens the New-plan composer; the latter first flips auth off.
//
// ---- RESET SEAM (Phase 4, the deck's foundation) -------------------------------------------------
//
// reset() returns the app to a clean baseline by driving the REAL teardown paths, so EVERY jumper can
// call it FIRST and become order-independent (a jump's result never depends on the prior jump). The
// non-conversation surfaces (review bar, gate, resume banner, auth, session, mock store) all have
// reachable production teardown paths and are cleared IN PLACE. The CONVERSATION pane is the one
// exception (see CONVERSATION-RESET below): the live ConversationModel inside initConversation is a
// private closure with NO production reset hook, so a clean live stream is only obtainable the way the
// REAL app obtains one — a fresh page load. Conversation jumps therefore route through a scoped reload
// carrying the target jump in the URL; on boot the deck replays it into the FRESH model.

import { SCENES, SCENE_NAMES, type SceneName } from "./fixtures/scenes";
import { playSceneFrames, clearAgentBuffers } from "./player";
import {
  setActiveScene,
  clearAnswers,
  setPendingReviews,
  setAuth,
  setCommentCount,
  persistKnobsToSession,
  resetState,
} from "./state";
import { emitMockEvent } from "./event";
import {
  emitGate,
  clearGate,
  emitQuotaPaused,
  emitQuotaExhausted,
  emitQuotaResumed,
} from "./orchestrator";
import {
  MOCK_REVIEW,
  MOCK_RESUME_RESUMABLE,
  MOCK_RESUME_BLOCKED,
  MOCK_RESUME_HAZARDOUS,
} from "./fixtures/reviews";
import { HISTORY_STEM, NO_TRANSCRIPT_STEM } from "./fixtures/transcripts";
import {
  renderResumeBanner,
  openPlan,
  __resetReviewStateForTest,
  __expandTreeForMock,
} from "../main";
import { invoke } from "./core";
import { asAbsPath, asStem } from "../types";
import {
  NESTED_MASTER_PATH,
  NESTED_MASTER_STEM,
  NESTED_TREE_ID,
} from "./fixtures/nested";
import { SENTINEL_PATH, SENTINEL_TREE_ID } from "./fixtures/sentinel";

// The reading-pane variant docs openDoc can jump to (keys match the fixture plans + markdown.ts).
const VARIANT_PATHS = {
  mermaid: "/Users/mock/.claude/plans/variant-mermaid.md",
  table: "/Users/mock/.claude/plans/variant-table.md",
  code: "/Users/mock/.claude/plans/variant-code.md",
  image: "/Users/mock/.claude/plans/variant-image.md",
  error: "/Users/mock/.claude/plans/__error__.md",
} as const;
export type DocVariant = keyof typeof VARIANT_PATHS;

// The review-bar modes showReview can paint.
export type ReviewMode = "viewing" | "summary" | "prototype" | "acceptance";

// The shape installed on `window.__mock`.
export interface MockApi {
  // ---- reset (Phase 4) ----
  // Return the app to a clean baseline (review/gate/resume/auth/session/store all cleared via the
  // REAL teardown paths). EVERY jumper below calls this first, so jumps are order-independent.
  reset(): void;
  // ---- conversation scenes (Phase 2) ----
  playScene(name: SceneName | string, delayMs?: number): boolean;
  listScenes(): SceneName[];
  // ---- review bar (Phase 3) ----
  // Paint a review-bar mode. Returns a Promise for the modes whose seam awaits (viewing/summary open
  // a plan); prototype/acceptance are synchronous. clearReview() reverts gate + pending-review state.
  // `commentCount` (viewing/summary only) re-applies the mock comment count AFTER showReview's internal
  // reset() — the caller (the review.comments knob) sets it BEFORE reset() would wipe it, so threading
  // it explicitly lets the VIEWING bar's count + Submit-enabled state reflect the chosen value.
  showReview(mode: ReviewMode, commentCount?: number): Promise<void> | void;
  clearReview(): void;
  // ---- resume banner (Phase 3) ----
  // "resumable" — a one-click resend verdict ("Resume — <phase>").
  // "blocked"   — the muted, button-less "resuming … isn't supported yet" message.
  // "hazardous" — a leaf/executing rewind (requiresConfirm) → "Continue implementation"; clicking the
  //               button reveals the inline #resume-confirm row (hazard + Confirm/Cancel) WITHOUT resuming.
  showResume(kind: "resumable" | "blocked" | "hazardous"): void;
  hideResume(): void;
  // ---- quota auto-resume banner (Phase 5) ----
  // Drive the inline conversation-pane quota banner: "waiting" (live countdown + armed pill, no Resume
  // button), "exhausted" (next-reset + Cancel-session only), "resumed" (clears the banner + appends the
  // resumed notice). Stages a short scene first so the pane has content. Token-free.
  showQuota(state: "waiting" | "exhausted" | "resumed"): void;
  // ---- reading-pane variants (Phase 3) ----
  openDoc(variant: DocVariant): Promise<void>;
  // ---- history replay + empty states (Phase 3) ----
  showHistory(): Promise<void>;
  showEmptyConversation(): Promise<void>;
  // conv.session="none": clear the LIVE conversation model to a genuinely empty pane (reload seam).
  clearConversation(): void;
  // ---- composer + auth onboarding (Phase 3) ----
  openComposer(): void;
  showAuthOnboarding(): void;
  // ---- nested-plan example (the REAL Chompy Asteroids tree) ----
  // Land directly on the explorable nested tree: expand it (master + the 04 decomposition node) and
  // open the master plan in the reading pane. Token-free; the tree is already in the sidebar.
  openNested(): Promise<void>;
  // ---- synthetic resume-sentinel row (Phase 4b) ----
  // Open the plan-file-less sentinel row (plan-tree-resume://). Drives the REAL openPlan sentinel
  // branch: a placeholder pane (the tree's INTENT.md) PLUS the resume banner (derived from the row's
  // cwd + the tree's state.json the mock serves). Token-free.
  openSentinel(): Promise<void>;
}

declare global {
  interface Window {
    __mock?: MockApi;
    // Test-only escape hatch: when set truthy, a conversation jump does NOT reload the page (which is
    // unavailable / undesirable in jsdom). Instead it performs the in-place reset + buffer-stage so a
    // FRESH subscriber (a freshly-constructed ConversationModel, as a real reload would build) replays
    // ONLY the target scene's frames. The deck never sets this; only the test suite does.
    __mockNoReload?: boolean;
  }
}

// Flip the reading pane to the Conversation tab (mirrors switchToConversationTab) so a played scene
// or history pane is visible. Pure view switch; null-safe before the DOM is built.
function showConversationTab(): void {
  const row = document.querySelector<HTMLElement>(".reader-tab-row");
  if (!row) return;
  for (const tab of row.querySelectorAll<HTMLElement>(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === "conversation");
  }
  document.getElementById("tab-plan")?.classList.toggle("active", false);
  document.getElementById("tab-conversation")?.classList.toggle("active", true);
}

// Flip the reading pane to the Plan tab (mirrors switchToPlanTab) so the review bar / reading-pane
// variants are visible.
function showPlanTab(): void {
  const row = document.querySelector<HTMLElement>(".reader-tab-row");
  if (!row) return;
  for (const tab of row.querySelectorAll<HTMLElement>(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === "plan");
  }
  document.getElementById("tab-conversation")?.classList.toggle("active", false);
  document.getElementById("tab-plan")?.classList.toggle("active", true);
}

// Click an app button by id (the faithful "drive the real UI" path for the New-plan composer).
function clickById(id: string): void {
  document.getElementById(id)?.click();
}

// ---- reset() — drive the REAL teardown paths to a clean baseline -----------------------------
//
// Order matters: clear the gate + active-orchestrator FIRST (so isOrchestrationActive() is false and
// the in-process review purge below is not skipped), then end the agent session (purges in-process
// reviews + drops the facade to "none"), then clear the EXTERNAL review map via main.ts's reachable
// reset, then the resume banner, then restore auth, then reset the mock store + buffers.
export function reset(): void {
  // (1) Orchestrator gate + active registration → false. clearGate fires onDone, which nulls main.ts's
  // orchSnapshot and re-derives the bar; __setActiveOrchestratorForTest(null) makes
  // isOrchestrationActive() false so the agent-exit purge below actually runs.
  clearGate();

  // (2) End the agent session through the mock command: it stops in-flight playback and emits
  // agent-exit. main.ts's SEPARATE agent-exit listener then calls purgeInprocReviews() (clearing any
  // in-process pending review) and clears any live-run placeholder; the conversation facade's listener
  // drops SessionState → "none". Fire-and-forget (the mock resolves synchronously enough for the
  // emitted agent-exit to fan out before this returns).
  void invoke("end_agent_session");

  // (3) External review map: main.ts keeps its OWN pendingReviews Map that setPendingReviews(state)
  // does NOT touch. __resetReviewStateForTest() is the reachable production teardown that clears that
  // Map AND the open-plan pointer / orchSnapshot / live-run placeholder / pendingResume — a superset
  // of what we need, with no production edit. (We prefer it over firing plan-review-cancelled per id:
  // it also resets openPath so a stale "already viewing" pointer can't taint the next showReview.)
  __resetReviewStateForTest();
  // Drop the mock store's pending-review seed too so a later list_pending_reviews returns [].
  setPendingReviews([]);

  // (4) Resume banner: render null → the banner hides (the reachable production render path).
  renderResumeBanner(null);

  // (5) Auth: restore the default "token present" so a prior showAuthOnboarding() can't leave the
  // composer auth-blocked. (The next composer open re-reads agent_auth_status → hasToken:true.)
  setAuth({ hasToken: true });

  // (6) Mock store back to the fixture seed (plans, markdown, frames, activeScene, answers, comment
  // count, knobs) and clear the agent event buffers so no stale scene replays to a future subscriber.
  resetState();
  clearAgentBuffers();
}

// ---- conversation jump routing (the CONVERSATION-RESET seam) ---------------------------------
//
// CONVERSATION-RESET (Step 0.3 finding): the live ConversationModel (conversation/index.ts) is a
// private closure variable created ONCE at initConversation time; it accumulates every agent-stream
// frame and is NEVER reset by production (its public reset() is called only by stream.test.ts). The
// REAL app gets a fresh conversation stream EXACTLY ONE WAY — a fresh page load builds a fresh
// initConversation → a fresh model. There is no exported controller reset, and emitting agent-exit +
// a fresh system_init clears SESSION STATE but NOT the model's accumulated nodes. So the only FAITHFUL
// way for a conversation jump to start from a clean model is to reproduce that page load.
//
// Mechanism: a conversation jump writes the target into the URL (?mockjump=…) and reloads. On boot the
// deck reads the param and replays the jump into the now-FRESH model. The buffer-clear (in reset() +
// playSceneFrames) guarantees the freshly-subscribed listeners replay ONLY the target scene.
//
// TEST MODE (window.__mockNoReload): a jsdom test cannot reload. With the flag set, the jump performs
// reset() + buffer-stage WITHOUT a reload, and the test asserts cleanliness against a FRESH subscriber
// (which mirrors what the reload gives the live app). The buffer-clear is the load-bearing,
// falsifiable invariant either way.

// A conversation jump descriptor (what gets serialized to the URL on a reload).
//   • scene   — replay a canned scene into the fresh model.
//   • history — open the history-stem plan (its transcript drives the history pane).
//   • empty   — open the no-transcript plan (the history pane's no-transcript empty state).
//   • none    — the conv.session="none" SENTINEL: route through the reload seam but stage NOTHING, so
//               the post-reload model is genuinely empty (no scene nodes). This is the ONLY faithful
//               way to clear the LIVE ConversationModel — it is a private closure with no production
//               in-place reset, so the in-place `reset()` would leave prior scene nodes on screen (an
//               exit node merely appends). A fresh page load is exactly how the real app gets a clean
//               live stream; the sentinel reproduces that and then stages no frames. (Distinct from
//               "empty", which paints the HISTORY pane's no-transcript state, not a clean live model.)
type ConvJump =
  | { kind: "scene"; name: SceneName }
  | { kind: "history" }
  | { kind: "empty" }
  | { kind: "none" };

const JUMP_PARAM = "mockjump";

// Serialize a jump to a compact URL-param value. The "none" sentinel uses a reserved, namespaced value
// (`__none`) so it can never collide with a real scene name.
function encodeJump(j: ConvJump): string {
  return j.kind === "scene" ? `scene:${j.name}` : j.kind === "none" ? "__none" : j.kind;
}

// Parse the URL's pending conversation jump (consumed once on boot by the deck). Returns null when
// absent / malformed. EXPORTED so the deck can read + replay it on boot.
export function readPendingConvJump(): ConvJump | null {
  if (typeof window === "undefined" || !window.location?.search) return null;
  const raw = new URLSearchParams(window.location.search).get(JUMP_PARAM);
  if (!raw) return null;
  if (raw.startsWith("scene:")) {
    const name = raw.slice("scene:".length);
    return (SCENES as Record<string, unknown>)[name] ? { kind: "scene", name: name as SceneName } : null;
  }
  if (raw === "history" || raw === "empty") return { kind: raw };
  // The conv.session="none" sentinel. Validated explicitly so an unknown param value → null (no-op, no
  // throw), consistent with the scene/history/empty validation above.
  if (raw === "__none") return { kind: "none" };
  return null;
}

// Strip the jump param from the address bar after consuming it (so a manual refresh doesn't re-replay
// it, and the URL stays clean). No-op outside a browser. Uses replaceState — never navigates.
function clearPendingConvJumpFromUrl(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.delete(JUMP_PARAM);
  window.history.replaceState(null, "", url.toString());
}

// Route a conversation jump: in the live app, reset() + write the jump to the URL + reload (a fresh
// model). In test mode (__mockNoReload) or when reload is unavailable, perform the in-place jump so a
// fresh subscriber replays ONLY this jump's frames. Returns true if it ran the jump in-place (test /
// no-reload path), false if it triggered a reload (the caller should not also run the jump).
function routeConvJump(j: ConvJump): boolean {
  reset();
  const noReload =
    (typeof window !== "undefined" && window.__mockNoReload) ||
    typeof window === "undefined" ||
    typeof window.location?.reload !== "function";
  if (noReload) {
    runConvJumpInPlace(j);
    return true;
  }
  // Live path: stash the jump in the URL and reload so initConversation rebuilds a FRESH model.
  // FIRST persist the knob store (+ commentCount) to sessionStorage so the reload does NOT silently
  // revert non-global knobs to defaults — the deck restores it on boot before seeding/building controls.
  persistKnobsToSession();
  const url = new URL(window.location.href);
  url.searchParams.set(JUMP_PARAM, encodeJump(j));
  // Use replace so the reload doesn't pollute history with a jump-param entry per click.
  window.location.replace(url.toString());
  return false;
}

// Stage + replay a conversation jump into whatever conversation model is currently subscribed. Used
// by routeConvJump's in-place branch AND by the deck on boot (replaying the URL jump into the fresh
// post-reload model). Pure staging — assumes reset() already ran (boot is inherently fresh).
function runConvJumpInPlace(j: ConvJump): void {
  switch (j.kind) {
    case "scene":
      stagePlayScene(j.name);
      break;
    case "history":
      void stageHistory();
      break;
    case "empty":
      void stageEmptyConversation();
      break;
    case "none":
      // The conv.session="none" sentinel: stage NOTHING. routeConvJump's reset() already cleared the
      // agent buffers, so the freshly-subscribed (post-reload) model replays no frames → a genuinely
      // empty live conversation pane. Flip to the Conversation tab so the empty pane is visible.
      stageEmptyLiveConversation();
      break;
  }
}

// Replay the pending URL jump on boot (the deck calls this once initConversation's listeners exist).
// Reads + clears the param, then stages the jump into the fresh model. No-op when no jump is pending.
export function replayPendingConvJump(): void {
  const j = readPendingConvJump();
  if (!j) return;
  clearPendingConvJumpFromUrl();
  runConvJumpInPlace(j);
}

// Stage a DEFAULT scene on boot WITHOUT a reload. The page just loaded → the live model is already
// fresh, so we stage in place (never route through routeConvJump, which would reload again → an
// infinite boot loop). The deck calls this when no URL jump is pending so the app shows something.
export function bootDefaultScene(name: SceneName): void {
  stagePlayScene(name);
}

// Boot default with NO auto-played scene: leave the live model genuinely empty (session stays "none",
// exactly like a freshly launched real app). Staged in place (the page just loaded → model is already
// fresh) so no reload, and crucially NO agent-stream frames are emitted — so the conversation listener
// never flips the session live. This keeps the live-session guard in loadHistoryForPlan passable, so
// selecting a historical (tree_id) plan reconstructs its conversation faithfully. All deck scenes
// remain playable on demand via their own reset+reload seam.
export function bootEmptyDefault(): void {
  stageEmptyLiveConversation();
}

// ---- scene playback (staging, no reset) ------------------------------------------------------

// The single playScene STAGING implementation (no reset / no reload). Buffers the scene's frames
// (playSceneFrames clears the agent buffers first → scene-scoping) so a freshly-subscribed model
// replays ONLY this scene. Exported staging is internal; the public playScene() routes through the
// reset+reload seam.
function stagePlayScene(name: SceneName | string, delayMs = 0): boolean {
  const builder = (SCENES as Record<string, (typeof SCENES)[SceneName] | undefined>)[name];
  if (!builder) {
    console.warn("[mock] unknown scene:", name, "— known:", SCENE_NAMES.join(", "));
    return false;
  }
  setActiveScene(name as SceneName);
  clearAnswers();
  playSceneFrames(builder(delayMs), delayMs);
  showConversationTab();
  return true;
}

// Public playScene: a CONVERSATION jump → route through the reset+reload seam so the live model is
// clean. Returns false for an unknown scene (no jump); true once the jump is dispatched (reload) or
// run in-place (test mode). NOTE: under a reload the actual frames appear AFTER the reload, replayed
// by the deck — the return value reports that the jump was accepted, not that frames are on screen yet.
export function playScene(name: SceneName | string, delayMs = 0): boolean {
  const builder = (SCENES as Record<string, unknown>)[name];
  if (!builder) {
    console.warn("[mock] unknown scene:", name, "— known:", SCENE_NAMES.join(", "));
    return false;
  }
  // delayMs only matters for in-place staging; a reload-then-replay always uses the instant default
  // (the deck's boot replay does not thread a delay). The deck's "watch it stream" affordance uses the
  // in-place stage path directly when desired; the default jump is instant.
  if (delayMs > 0 && typeof window !== "undefined" && window.__mockNoReload) {
    reset();
    return stagePlayScene(name, delayMs);
  }
  routeConvJump({ kind: "scene", name: name as SceneName });
  return true;
}

// ---- quota auto-resume banner driver (Phase 5) ----------------------------------------------

// Drive the inline quota-banner in the Conversation pane through the REAL index.ts quota wiring (which
// subscribes to getOrchestrator() — the mock fake handle — in mock mode). We stage a short scene IN
// PLACE (so the conversation pane has content + the live model is subscribed), then fan the matching
// quota observer callback; index.ts's onQuotaPaused/onQuotaExhausted/onQuotaResumed appends/clears the
// SINGLE banner node + rerenders, exactly as the live app does. Token-free.
//   - "waiting":   armed banner with the live wall-clock countdown + "armed · N left" pill.
//   - "exhausted": next-reset + Cancel-session only.
//   - "resumed":   clears the waiting banner + appends the "Resumed after a quota threshold" notice.
function showQuota(state: "waiting" | "exhausted" | "resumed"): void {
  reset();
  stagePlayScene("assistantText");
  if (state === "waiting") emitQuotaPaused(1);
  else if (state === "exhausted") emitQuotaExhausted();
  else emitQuotaResumed();
}

// ---- review bar drivers ---------------------------------------------------------------------

// VIEWING / SUMMARY (external review): seed mock list_pending_reviews with the fixture, then emit a
// plan-review-requested event. main.ts's handleReviewRequested opens the review's REAL plan file
// (read_plan_contents serves it) → openPath === the review's plan → VIEWING. For SUMMARY, after the
// review is registered we open a DIFFERENT plan so a review is pending but a non-reviewed plan is open.
async function showExternalReview(mode: "viewing" | "summary"): Promise<void> {
  setPendingReviews([MOCK_REVIEW]);
  // Drive the REAL external-review wire: the plan-review-requested event → handleReviewRequested →
  // openReviewPlanFile → refreshReviewBar paints the bar.
  emitMockEvent("plan-review-requested", {
    review_id: MOCK_REVIEW.review_id,
    plan_text: MOCK_REVIEW.plan_text,
    plan_file_path: MOCK_REVIEW.plan_file_path,
    created_ms: MOCK_REVIEW.created_ms,
  });
  showPlanTab();
  if (mode === "summary") {
    // SUMMARY = the review stays pending but a DIFFERENT (non-reviewed) plan is open. Open one and let
    // a microtask elapse first so the event-driven openReviewPlanFile above settles, then navigate
    // away — refreshReviewBar (called by openPlan) then derives SUMMARY (count label + Resume).
    await Promise.resolve();
    await openPlan(
      asAbsPath("/Users/mock/.claude/plans/unread-standalone.md"),
      asStem("unread-standalone"),
    );
  }
}

// Idempotent: reset() FIRST (clears any prior gate / review / session) so a showReview after any other
// jump lands cleanly. NOTE: showReview is a REVIEW-bar/Plan-tab surface — it does NOT need the
// conversation-model reload (the live model never drives the Plan tab), so the in-place reset suffices.
// `commentCount` (viewing/summary) is RE-APPLIED after reset() (which zeroes the store's count) so the
// reviewed plan's cold-read (refreshCommentCount via openPlan) sees the caller's chosen value.
async function showReview(mode: ReviewMode, commentCount?: number): Promise<void> {
  reset();
  if (typeof commentCount === "number") setCommentCount(commentCount);
  if (mode === "viewing" || mode === "summary") {
    await showExternalReview(mode);
    return;
  }
  // PROTOTYPE / ACCEPTANCE: drive the orchestrator-gate seam (the fake handle fans a real snapshot to
  // main.ts's subscribed observer; the real prototypeGateActive/acceptanceGateActive + applyPrototypeBar/
  // applyAcceptanceBar render the bar).
  emitGate(mode);
  showPlanTab();
}

// Revert all review surfaces: drop pending reviews + clear any gate, so the bar hides.
function clearReview(): void {
  clearGate();
  setPendingReviews([]);
}

// ---- resume banner driver -------------------------------------------------------------------

// Idempotent: reset() FIRST. The resume banner is a Plan-tab overlay (no conversation-model concern),
// so the in-place reset is sufficient.
function showResume(kind: "resumable" | "blocked" | "hazardous"): void {
  reset();
  const verdict =
    kind === "resumable"
      ? MOCK_RESUME_RESUMABLE
      : kind === "hazardous"
        ? MOCK_RESUME_HAZARDOUS
        : MOCK_RESUME_BLOCKED;
  renderResumeBanner(verdict);
  showPlanTab();
}

function hideResume(): void {
  renderResumeBanner(null);
}

// ---- reading-pane variant + history drivers -------------------------------------------------

// Open a reading-pane variant plan through the REAL openPlan → read_plan_contents → renderInto path.
// Idempotent: reset() FIRST (a reading-pane doc has no conversation-model concern). openPlan ALSO
// fires loadHistoryForPlan fire-and-forget; since reset() drops the session to "none", that history
// load runs and would populate the Conversation tab — but we stay on the Plan tab, so it is harmless.
async function openDoc(variant: DocVariant): Promise<void> {
  reset();
  const path = VARIANT_PATHS[variant];
  const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  showPlanTab();
  await openPlan(asAbsPath(path), asStem(stem));
}

// Nested-plan example driver: land on the REAL "Chompy Asteroids" tree, fully expanded, with the
// master plan open in the reading pane. Idempotent: reset() FIRST (restores the fixture store, which
// already contains the nested tree, and clears any prior session state). The tree is a reading-pane /
// sidebar surface (no conversation-model concern), so the in-place reset suffices. Then force the tree
// expanded (master + the 04 decomposition node) via the real sidebar repaint path, flip to the Plan
// tab, and open the master through the REAL openPlan -> read_plan_contents -> renderInto path.
async function openNested(): Promise<void> {
  reset();
  __expandTreeForMock(NESTED_TREE_ID);
  showPlanTab();
  await openPlan(asAbsPath(NESTED_MASTER_PATH), asStem(NESTED_MASTER_STEM));
}

// Synthetic resume-sentinel driver: open the plan-file-less sentinel row through the REAL openPlan
// path. Idempotent: reset() FIRST (restores the fixture store, which already contains the sentinel
// row, and clears any prior session). The sentinel is a reading-pane/sidebar surface (no
// conversation-model concern), so the in-place reset suffices. openPlan detects the
// `plan-tree-resume://` scheme → renders the INTENT.md placeholder pane AND fires refreshResumeBanner
// (the mock's read_plan_tree_file serves the tree's state.json by cwd → a resumable resend verdict).
async function openSentinel(): Promise<void> {
  reset();
  showPlanTab();
  await openPlan(asAbsPath(SENTINEL_PATH), asStem(SENTINEL_TREE_ID));
}

// History replay STAGING (no reset / no reload): open the history-stem plan; its mock transcript
// drives the REAL loadHistoryForPlan path (fired fire-and-forget by openPlan), then flip to the
// Conversation tab. Used by the conversation-jump router (which already ran reset()/reload).
async function stageHistory(): Promise<void> {
  await openPlan(
    asAbsPath(`/Users/mock/.claude/plans/${HISTORY_STEM}.md`),
    asStem(HISTORY_STEM),
  );
  showConversationTab();
}

// Empty-conversation STAGING (no reset / no reload): open the no-transcript-stem plan; its
// read_plan_transcript returns found:false → the no-transcript empty state. Flip to the Conversation tab.
async function stageEmptyConversation(): Promise<void> {
  await openPlan(
    asAbsPath(`/Users/mock/.claude/plans/${NO_TRANSCRIPT_STEM}.md`),
    asStem(NO_TRANSCRIPT_STEM),
  );
  showConversationTab();
}

// Empty LIVE-conversation STAGING (no reset / no reload): stage NOTHING — the agent buffers were already
// cleared by routeConvJump's reset(), so the freshly-subscribed (post-reload) model has no nodes → a
// genuinely empty live conversation pane (the conv.session="none" target). Only flips to the
// Conversation tab so the empty pane is visible. Distinct from stageEmptyConversation, which opens a
// plan to paint the HISTORY pane's no-transcript state; here we want the live model itself to be empty.
function stageEmptyLiveConversation(): void {
  showConversationTab();
}

// Public history/empty jumps: CONVERSATION jumps (they render the Conversation tab via the live/
// history pane), so they route through the reset+reload seam for a clean model. In the live app the
// frames appear after the reload (the deck replays the URL jump); in test mode they run in-place.
async function showHistory(): Promise<void> {
  routeConvJump({ kind: "history" });
}

async function showEmptyConversation(): Promise<void> {
  routeConvJump({ kind: "empty" });
}

// conv.session="none": a CONVERSATION jump that clears the LIVE model. Routes through the SAME reset+
// reload seam the other conversation jumps use (the live ConversationModel has no production in-place
// reset — see CONVERSATION-RESET), carrying the "none" sentinel so the post-reload model is genuinely
// empty (no scene nodes staged). In test mode (__mockNoReload) it runs in place: reset() clears the
// buffers, then a fresh subscriber replays nothing.
function clearConversation(): void {
  routeConvJump({ kind: "none" });
}

// ---- composer + auth onboarding drivers -----------------------------------------------------

// Open the New-plan composer by clicking the REAL #new-plan-btn (drives statusController.refresh() +
// composer.open(), so the canned dialog dir + the auth block reflect current mock auth state).
// Idempotent: reset() FIRST restores auth (so a prior showAuthOnboarding can't leave it blocked) and
// drops the session (#new-plan-btn is disabled while a session is live).
function openComposer(): void {
  reset();
  clickById("new-plan-btn");
}

// Auth onboarding: reset() FIRST (clean baseline), then flip mock auth to no-token, then open the
// composer. The composer-open path calls statusController.refresh() (re-reads agent_auth_status →
// hasToken:false → status "auth"), so the #composer-auth onboarding block shows.
function showAuthOnboarding(): void {
  reset();
  setAuth({ hasToken: false });
  clickById("new-plan-btn");
}

// Install the hook on window. Idempotent — a second call (e.g. an HMR re-run) just rebinds.
export function installMockApi(): void {
  window.__mock = {
    reset,
    playScene,
    listScenes: () => [...SCENE_NAMES],
    showReview,
    clearReview,
    showResume,
    hideResume,
    showQuota,
    openDoc,
    showHistory,
    showEmptyConversation,
    clearConversation,
    openComposer,
    showAuthOnboarding,
    openNested,
    openSentinel,
  };
}
