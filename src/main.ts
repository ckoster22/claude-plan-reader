import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import {
  renderInto,
  settle,
  extractToc,
  applyComments,
  initComments,
  onCommentCountChanged,
  loadCommentsFor,
  clearAllComments,
  type TocEntry,
  type CommentsIO,
} from "./render";
import { buildFeedbackPrompt } from "./feedback";
import { applyReviewBarState } from "./review";
import { captureAnchor, applyDelta, scrollToHeading } from "./render/scroll";
import { collapseHome, expandHome } from "./cwd";
import { resolveCwds } from "./resolve";
import { filterRecords, highlightInto, planCountText } from "./filter";
import { RenderGuard } from "./render-guard";
import { initTitlebar, initThemeToggle, initTextSize } from "./titlebar";
import { initModelPicker } from "./model-picker";
import { initConversation, type ConversationHandle } from "./conversation";
import { diag } from "./conversation/diag";
import {
  isOrchestrationActive,
  getOrchestrator,
  pathKey,
  parsePathKey,
  type PlanTreeSnapshot2,
  type ApprovalGate2,
  type PrototypeGate,
  type AcceptanceGate,
  type RecursiveLedger,
  type ResumeScope,
  type ResumePlan,
} from "./conversation/orchestrator";
import {
  resumeScopeForRoot,
  treeIsDone,
  planName2,
  activePathOf,
  nodeAtPath,
  type TreeNode,
  type NodePath,
} from "./conversation/plan-tree";
import {
  composePreviewMarkdown,
  prototypeBarLabel,
  prototypeApproveLabel,
  prototypeGateActive,
  prototypeOpenTarget,
  acceptanceGateActive,
  acceptanceBarLabel,
  acceptanceApproveLabel,
  acceptanceDivergeLabel,
  acceptanceRefineLabel,
  acceptanceRefineTargets,
} from "./prototype";
import type { ToolPermissionRequested, AgentExit, AgentError, AgentStream } from "./conversation/types";
import type {
  PlanRecord,
  SidebarCtx,
  CommentRecord,
  ReviewRequest,
  ReviewRequested,
  ReviewCancelled,
} from "./types";
import { asAbsPath, asStem, cwdState, type AbsPath, type Stem } from "./types";

// ---- Frozen contract type (mirrors Rust PlanChanged in CONTRACT.md) ----
interface PlanChanged {
  path: string;
  kind: string;
}

// ---- DOM handles (the frozen selector contract — see CONTRACT.md) ----
let planListEl: HTMLElement | null;
let planCountEl: HTMLElement | null;
let readerScrollEl: HTMLElement | null;
let readingPaneEl: HTMLElement | null;
let docHeaderEl: HTMLElement | null;
let docFilenameEl: HTMLElement | null;
let docSrcEl: HTMLElement | null;
let tocListEl: HTMLElement | null;
let filterInputEl: HTMLInputElement | null;
let filterClearEl: HTMLElement | null;
let searchEl: HTMLElement | null;
// Review action bar (non-occluding affordance docked in the reading-pane column header so inline
// commenting in the pane stays fully usable). Shown whenever a review is pending (viewing OR
// summary mode); see applyReviewBarState.
let reviewBarEl: HTMLElement | null;
let reviewBarLabelEl: HTMLElement | null;
let reviewSubmitEl: HTMLButtonElement | null;
let reviewClearEl: HTMLButtonElement | null;
let reviewResumeEl: HTMLButtonElement | null;
// Sub-Plan 03: dedicated "Approve & Build" button — shown only while VIEWING an in-process review.
let reviewApproveEl: HTMLButtonElement | null;
// PHASE 6 — forced-acceptance REFINE button + its sub-plan picker — shown ONLY in ACCEPTANCE mode.
let reviewRefineEl: HTMLButtonElement | null = null;
let reviewRefineTargetEl: HTMLSelectElement | null = null;
// The external Submit button's original descriptive label (captured from the DOM at wire-time so an
// in-process review that relabeled it can be reverted exactly). Falls back to "Submit feedback".
let REVIEW_SUBMIT_EXTERNAL_LABEL = "Submit feedback";
// Visual-prototype review (Phase 4d): the bar's PROTOTYPE-mode controls. #prototype-feedback is the
// inline refine-feedback textarea (Request changes requires non-empty text); #prototype-open opens
// an HTML prototype in the default browser (visible only for kind "html"). Both are additive
// `.review-bar-actions` children, hidden outside PROTOTYPE mode.
let prototypeFeedbackEl: HTMLTextAreaElement | null = null;
let prototypeOpenEl: HTMLButtonElement | null = null;
// Working-reference classification (Phase 3): the PROTOTYPE-mode checkbox + its label. UNCHECKED
// (default) = "just a sketch" (today's approve behavior); CHECKED = "working reference" → approve
// freezes .plan-tree/prototype/ → .plan-tree/baseline/ and records baseline_ on the ledger.
let prototypeWorkingRefEl: HTMLInputElement | null = null;
let prototypeWorkingRefLabelEl: HTMLLabelElement | null = null;
// #review-approve's default label ("Approve & Build"), captured at wire-time so PROTOTYPE mode's
// relabel ("Approve visual" / "Proceed as-is") can be reverted exactly — same pattern as
// REVIEW_SUBMIT_EXTERNAL_LABEL.
let REVIEW_APPROVE_DEFAULT_LABEL = "Approve & Build";
// #hook-status is retained: setHookStatus() surfaces review-response / save-for-review errors on it
// (the titlebar Install/Remove plan-review hook buttons were removed — the app drives Claude in-process).
let hookStatusEl: HTMLElement | null;

// ---- Resume banner (Phase 5) — orthogonal to the review bar -----------------------------------
// #resume-banner is shown when the OPEN plan belongs to a NON-terminal `.plan-tree/` whose tree_id
// matches the open plan and no orchestration is already active (detectResumable). It is a SEPARATE
// surface from the review bar (#review-bar) and from the live-idle conversation #conversation-resume
// button — both may coexist. #resume-plan-btn is the resumable-state control (label
// "Resume — <phaseLabel>"); the banner shows a static muted message for blocked phases.
let resumeBannerEl: HTMLElement | null = null;
let resumeBannerMsgEl: HTMLElement | null = null;
let resumePlanBtnEl: HTMLButtonElement | null = null;
// PHASE 3c — the HAZARDOUS-resume confirmation step. A resumable verdict whose plan carries
// `requiresConfirm:true` (only leaf/executing today — edits may be partially applied) must not fire
// resume() on the first click. Clicking #resume-plan-btn for a hazardous verdict reveals an inline
// confirm row (#resume-confirm — the hazard text + Confirm/Cancel) instead of resuming; resume() only
// fires after #resume-confirm-btn. #resume-cancel-btn aborts back to the one-click button. Non-hazardous
// verdicts never show this row and keep their immediate one-click behavior.
let resumeHazardEl: HTMLElement | null = null;
let resumeConfirmRowEl: HTMLElement | null = null;
let resumeConfirmBtnEl: HTMLButtonElement | null = null;
let resumeCancelBtnEl: HTMLButtonElement | null = null;
// The resume context for the CURRENTLY-rendered resumable banner (cwd + parsed ledger), or null when
// the banner is hidden / showing a blocked message. The #resume-plan-btn click reads this — it is set
// by renderResumeBanner the moment a resumable verdict paints, and cleared on hide / blocked / success.
// `requiresConfirm` rides through from the verdict's plan (leaf/executing → true): a true value gates
// the click behind the inline confirm row; `hazard` is the human-readable risk note surfaced there.
let pendingResume: { cwd: string; ledger: RecursiveLedger; requiresConfirm: boolean; hazard: string | null } | null = null;

// #toast (Phase 5): the lightweight non-blocking notice element + its auto-dismiss timer. showToast
// is the sole writer of its text/`.hidden`. Currently used only for the `resume_fallback` frame.
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// ---- Sub-Plan 03: reading-pane [Plan | Conversation] tab handles (hoisted to module scope) ----
// Hoisted so switchToConversationTab / switchToPlanTab are module-level: main.ts OWNS the reading-pane
// tab for the in-process review case (it flips to Plan on a held ExitPlanMode, and to Conversation on
// Approve). Null under unit tests until the DOMContentLoaded wiring resolves them → the switchers no-op.
let readerTabRowEl: HTMLElement | null = null;
let tabPlanPaneEl: HTMLElement | null = null;
let tabConversationEl: HTMLElement | null = null;
// The conversation domain handle (assigned in the DOMContentLoaded .then() once initConversation
// resolves; null until then and under unit tests). Hoisted to module scope so the module-level
// reader-tab switchers can repaint the minimap when the Conversation pane becomes visible.
let conversationHandle: ConversationHandle | null = null;

// Switch the reading pane to the Conversation tab (used when an agent run starts/streams, and after
// an in-process Approve so execution is visible). Pure view switch — never rebuilds pane content.
function switchToConversationTab(): void {
  if (!readerTabRowEl || !tabPlanPaneEl || !tabConversationEl) return;
  for (const t of Array.from(readerTabRowEl.querySelectorAll<HTMLElement>(".tab"))) {
    t.classList.toggle("active", t.dataset.tab === "conversation");
  }
  tabPlanPaneEl.classList.remove("active");
  tabConversationEl.classList.add("active");
  // The Conversation pane just transitioned display:none → visible; nothing mutated the stream
  // subtree, so rerender()/observers did not fire. Repaint the minimap with real geometry on the next
  // frame (offsets are 0 until layout settles after the display toggle). Guarded: handle is null until
  // initConversation resolves; refreshMinimap is a no-op when the minimap element is absent.
  requestAnimationFrame(() => conversationHandle?.refreshMinimap());
}

// Mirror of switchToConversationTab: flip the reading pane to the Plan tab. Used by the in-process
// ExitPlanMode handler — main.ts owns the tab for the review case (the conversation facade skips its
// onActivity() for ExitPlanMode so this is not raced). Pure view switch.
function switchToPlanTab(): void {
  if (!readerTabRowEl || !tabPlanPaneEl || !tabConversationEl) return;
  for (const t of Array.from(readerTabRowEl.querySelectorAll<HTMLElement>(".tab"))) {
    t.classList.toggle("active", t.dataset.tab === "plan");
  }
  tabConversationEl.classList.remove("active");
  tabPlanPaneEl.classList.add("active");
}

// Absolute path of the currently-open plan (null when nothing selected).
let openPath: AbsPath | null = null;

// ---- Phase 6 — Plan Review (ExitPlanMode hook) — Option A: open the REAL plan file ----
//
// A plan review carries a BLOCKING PreToolUse hook; the app can only RELEASE it (decision "allow" →
// Claude Code shows its normal terminal plan-approval prompt) or DENY it with feedback (decision
// "deny" + assembled comments → Claude revises). There is no in-app auto-approve.
//
// NEW MODEL (the invariant fix): the reviewed plan is a REAL file under `~/.claude/plans/` (its
// absolute path rides on the review payload as `planFilePath`). A review now OPENS THAT FILE through
// the NORMAL plan-open flow, so it is SELECTED in the sidebar, its comments persist with the plan
// (keyed on its real path — no special store), and live-reload works. The review just adds an action
// bar + tracks that this plan has a pending blocking hook.
//
//   pendingReviews — every known pending review (each has a live blocking hook). Keyed by reviewId.
//                    Holds the plan file path (what we open) + planText (degraded fallback render).
//
// "Viewing a review" is a DERIVED condition: openPath equals some pending review's planFilePath.
// Browsing to another plan never touches pendingReviews — the bar simply drops to SUMMARY mode, so a
// pending review never traps navigation.
interface PendingReview {
  reviewId: string;
  planFilePath: string;
  planText: string;
  createdMs: number;
  // ---- Sub-Plan 03: in-process review support ----------------------------------------------
  // Which review surface this came from. "external" = a settings.json ExitPlanMode hook review
  // routed through the file-IPC path (respond_to_review). "in-process" = the in-app Agent SDK
  // canUseTool seam (resolve_tool_permission). planFilePath holds the REAL written plan path for
  // BOTH (in-process plans are materialized to ~/.claude/plans/ via write_agent_plan).
  source: "external" | "in-process";
  // The SDK toolUseID to round-trip on resolve_tool_permission (in-process only; matches the
  // tool-permission-requested payload's `id`). Undefined for external reviews.
  toolUseId?: string;
  // The originating subagent id (or null for the main agent). Captured for diagnostics ONLY — the
  // hold/resolve NEVER branch on it, so a subagent plan blocks + resolves identically (round-tripping
  // the same toolUseId). Undefined for external reviews.
  agentId?: string | null;
}
const pendingReviews = new Map<string, PendingReview>();

// The reviewId whose planFilePath === the currently-open plan, or null when the open plan is not a
// pending review (this is the single derivation of "viewing a review"). On ties (same path tracked
// by >1 review — should not happen) the last-iterated (newest-inserted) wins.
function currentReviewId(): string | null {
  if (openPath === null) return null;
  let match: string | null = null;
  for (const r of pendingReviews.values()) {
    if (r.planFilePath === openPath) match = r.reviewId;
  }
  return match;
}

// Sub-Plan 02: the latest PlanTreeSnapshot2 from the shared orchestrator's observer (null until a run
// is active / after it ends). The gate controller derives the approval bar from this — it holds the
// active node's pendingApproval gate while a node awaits the user's approval.
let orchSnapshot: PlanTreeSnapshot2 | null = null;

// ---- Live-run placeholder sidebar row (Bug A fix) ---------------------------------------------
// A running orchestration has NO sidebar row until the agent writes its plan file (and list_plans
// can lag the write), so the sidebar highlight would land on nothing/the wrong row while the pane
// shows the conversation. `runPlaceholder` is keyed by the run's treeId (set on the first snapshot
// of each run); the sidebar renders it as a `.plan.placeholder` row whenever no rendered record
// carries that tree_id. `placeholderSelected` is the user-intent half of its `.active` state: true
// on run start and on a placeholder click; false once the user opens any real plan or the gate
// handler opens the gate plan. (The other half — "a gate plan is open but its row is missing" — is
// derived live in makeSidebarCtx.)
let runPlaceholder: { treeId: string; label: string } | null = null;
let placeholderSelected = false;

// Pure helper (Bug B fix): should the onActivity conversation-tab flip be SUPPRESSED? Keyed
// STRICTLY on pendingApproval — while a gate is held, every non-result stream frame still fires
// onActivity, which would steal the tab from the Plan view the gate handler just opened. It must
// NOT consider pendingClarify: AskUserQuestion cards render in the Conversation tab and NEED the
// flip. EXPORTED for the unit-test truth table.
export function suppressConversationFlip(
  snap: Pick<PlanTreeSnapshot2, "pendingApproval"> | null,
): boolean {
  return snap?.pendingApproval != null;
}

// Pure helper (agent-exit × placeholder race): should an SDK SESSION exit clear the live-run
// placeholder? agent-exit is NOT 1:1 with the placeholder's run — a previous session's late exit
// can arrive AFTER a fresh run has minted its own placeholder. Clear ONLY when no orchestration is
// active OR the active snapshot's treeId differs from the placeholder's (a stale placeholder no
// ACTIVE orchestration claims). When the active run's treeId MATCHES, the placeholder belongs to a
// still-live run — its lifecycle is owned by onDone/onFatal, never by a session exit. EXPORTED for
// the unit-test truth table.
export function shouldClearPlaceholderOnExit(
  placeholder: { treeId: string } | null,
  orchestrationActive: boolean,
  activeSnapTreeId: string | null,
): boolean {
  if (placeholder === null) return false;
  const activeTreeId = orchestrationActive ? activeSnapTreeId : null;
  return activeTreeId !== placeholder.treeId;
}

// THE SINGLE GATE DERIVATION (gen-2 unified gate): the held ApprovalGate2 the user is currently
// VIEWING, or null. The root decomposition gate lives IN pendingApproval now (the gen-1 master-phase
// keying + masterGatePlanPath + the viewingMasterGate/viewingOrchestratorGate pair are GONE) — one
// derivation covers decomposition AND leaf gates. Every bar derivation (count, viewing, source) and
// the button routing consult it so they all agree; routing by gate.kind happens INSIDE the
// orchestrator's approve()/requestChanges(), not here. The gate's planPath is an absolute path;
// openPath is already branded AbsPath.
function viewingGate(): ApprovalGate2 | null {
  if (!isOrchestrationActive()) return null;
  const gate = orchSnapshot?.pendingApproval ?? null;
  if (!gate) return null;
  return openPath === asAbsPath(gate.planPath) ? gate : null;
}

// Visual-prototype gate (Phase 4d): the held PrototypeGate driving the bar's PROTOTYPE mode, or
// null. Derived STRICTLY from the orchestrator snapshot (pendingPrototype) — never module state —
// so the gate SELF-CLEARS: approvePrototype()/refinePrototype() null pendingPrototype in the
// reducer and the very next onSnapshot → refreshReviewBar() reverts the bar with no bookkeeping.
// Precedence lives in the pure prototypeGateActive: a held pendingApproval beats the prototype
// gate; the prototype gate beats the pendingReviews surfaces.
function activePrototypeGate(): PrototypeGate | null {
  return prototypeGateActive(orchSnapshot, isOrchestrationActive());
}

// PHASE 5 — the held forced-acceptance gate driving the bar's ACCEPTANCE mode, or null. Derived
// STRICTLY from the orchestrator snapshot (pendingAcceptance) — never module state — so it
// self-clears: approveAcceptance()/divergeAcceptance() null pendingAcceptance in the reducer and the
// very next onSnapshot → refreshReviewBar() reverts the bar. Precedence (pure acceptanceGateActive):
// pendingApproval and pendingPrototype both outrank the acceptance gate (it is a post-completion
// hold; those are mid-run interactive holds).
function activeAcceptanceGate(): AcceptanceGate | null {
  return acceptanceGateActive(orchSnapshot, isOrchestrationActive());
}

// Sub-Plan 03: the SOURCE of the review currently being viewed (external vs in-process). MUST read
// the SAME matched review currentReviewId() resolved (never re-iterate independently), so the bar's
// source-aware affordances (#review-approve / submit label) always agree with the resolve dispatch.
// Defaults to "external" when nothing is being viewed.
//
// Sub-Plan 02: the orchestrator approval gate is ALSO an in-process review surface (Approve & Build +
// "Request changes"), but it is NOT tracked in pendingReviews. Return "in-process" when viewing it so
// every consumer — both source checks in refreshReviewBar — agrees from this one source of truth.
function currentReviewSource(): "external" | "in-process" {
  if (viewingGate() !== null) return "in-process";
  const id = currentReviewId();
  if (id === null) return "external";
  return pendingReviews.get(id)?.source ?? "external";
}

// Test-only reader: the open plan's comment count (the review's comments are just the plan's
// comments now). Kept under the old name so existing review assertions still read it.
export function reviewCommentCount(): number {
  return currentReviewId() === null ? 0 : commentCount;
}

// Test-only: clear ALL review state (pending reviews). Module state persists across tests in a
// vitest file, so this gives each test a clean slate. Production code never calls it.
export function __resetReviewStateForTest(): void {
  pendingReviews.clear();
  // Also reset the open-plan pointer: module state persists across tests in a vitest file, so a plan
  // left open by a prior test could make currentReviewId() spuriously match a new review on the same
  // path (the "already viewing → don't yank" branch), breaking the next test's open. Production never
  // calls this.
  openPath = null;
  // Sub-Plan 02: drop any orchestrator gate snapshot so a leaked pendingApproval from a prior test
  // cannot spuriously drive the bar into "viewing the orchestrator gate" for the next test.
  orchSnapshot = null;
  // Bug A fix: drop any leaked live-run placeholder so a prior test's run can't paint a phantom
  // `.plan.placeholder` row (or steal `.active`) in the next test.
  runPlaceholder = null;
  placeholderSelected = false;
  // Phase 5: drop any leaked resume context so a prior test's resumable verdict can't drive the
  // #resume-plan-btn click in the next test.
  pendingResume = null;
}

// Test-only: install a live-run placeholder + its selection so tests can drive the module-level
// render paths (applyFilterAndRender's `.filter-empty` branch reads this state through
// makeSidebarCtx). Production code never calls it — the placeholder is minted exclusively by the
// orchestrator's onSnapshot observer.
export function __setRunPlaceholderForTest(
  ph: { treeId: string; label: string } | null,
  selected: boolean,
): void {
  runPlaceholder = ph;
  placeholderSelected = selected;
}

// Mock/automation hook: force a tree fully EXPANDED and repaint the sidebar. Clears any SESSION
// collapse intent for the master (collapseOverride) and for every internal sub node of the tree
// (subCollapse), so the master AND its decomposition (dotted) nodes render open regardless of a
// prior user collapse this session. Production never calls this -- the deck's nested-plan preset
// uses it so the user lands on a fully-expanded, explorable tree. Repaints via applyFilterAndRender
// (the same path refreshList uses), so the new expand state is visible immediately.
export function __expandTreeForMock(treeId: string): void {
  collapseOverride.set(treeId, false);
  // Drop every subCollapse entry for this tree (subCollapseKey joins tree_id + NUL + nn_path), so
  // all internal dotted nodes (e.g. the "04" decomposition parent) render expanded too.
  const prefix = treeId + "\u0000";
  for (const key of Array.from(subCollapse.keys())) {
    if (key.startsWith(prefix)) subCollapse.delete(key);
  }
  applyFilterAndRender();
}

// ---- Sidebar filter (Fix 1) ----
// The live filter query (raw input value) and the last full records array `list_plans`
// returned. The Plans tab renders `filterRecords(lastRecords, filterQuery)`; the Contents tab
// is never filtered. Held at module scope so a late cwd patch can re-run the filter (keeping
// highlights/matches alive) without a fresh `list_plans` round-trip.
let filterQuery = "";
let lastRecords: PlanRecord[] = [];

// Monotonic render-generation guard. Every open/reload of the pane takes a token at its
// start; after each `await` it bails if a newer render has begun, so only the most-recent
// open/reload mutates the pane (no stale render landing after its successor under bursts).
const renderGuard = new RenderGuard();

// ---- Sub-Plan 02/03: comment count (backend is the single source of truth) ----
// The backend owns the count; main.ts reads it via a command (never the DOM). The count drives the
// review bar's VIEWING label + Submit-enabled state (refreshReviewBar) — the former titlebar
// "Prompt Feedback" button that also surfaced it has been removed; commenting now goes through the
// conversation composer + review bar.
let commentCount = 0;

// Latest-wins request sequence (Sub-Plan 03). refreshCommentCount is fired un-awaited from open
// (openPlan), reload (reloadOpenPlan), and onCommentCountChanged — concurrent/bursty calls can
// resolve out of order. Each call takes a fresh `seq = ++countReqSeq` before its await and bails
// after if a newer call has begun. This defends BOTH the cross-plan A→B case (a slow get_comment_count
// for A resolving after B is open) AND the same-plan A→A bursty-reload reorder (an earlier request
// resolving last). Strictly stronger than capturing openPath.
let countReqSeq = 0;

// Commit-IF-CURRENT: apply an AUTHORITATIVE count for `path` synchronously to commentCount. This is
// the path used by onCommentCountChanged after an in-session save/clear: the facade hands us the
// MUTATED path + post-mutation count (the just-mutated cache array's length) so we do NOT cold-re-read
// get_comment_count — at fire time the backend write (set_comments) may not have landed yet, so a
// cold read would race it and return a stale 0.
//
// PLAN-AWARE guard (cross-plan race fix): a mutation's IPC can still be in flight when the user
// switches plans, so a FOREIGN-plan callback (e.g. a late clear-all for the plan we just left) can
// fire while a different plan is open. Such a callback must be a TOTAL no-op: it must NOT touch the
// count (it would be the wrong plan's) and — critically — must NOT bump countReqSeq, or it would
// strand the open plan's own in-flight cold refresh (whose seq would then be stale and bail). So we
// commit (and bump seq) ONLY when `path` is the currently-open plan. When it matches, the seq bump
// makes this synchronous commit the newest request, so an in-flight same-plan cold read bails
// instead of clobbering it (preserving latest-wins).
function applyCommentCount(path: AbsPath, count: number): void {
  if (path !== openPath) return; // foreign-plan callback: ignore entirely (no commit, no seq bump).
  ++countReqSeq;
  commentCount = count;
  // If the open plan IS a pending review, the bar's VIEWING label + Submit-enabled state derive from
  // this count — re-derive so the first comment enables Submit. Pass the authoritative count (commentCount
  // is already committed, but be explicit to mirror the override contract).
  refreshReviewBar(count);
}

// Cold-read the open plan's comment count from the backend (the count-path that works even when
// the array isn't loaded frontend-side — used on OPEN/RELOAD). The latest-wins seq guard ensures
// only the most-recent request commits to commentCount. After an in-session save/clear the count is
// delivered authoritatively via onCommentCountChanged → applyCommentCount (NOT this cold read),
// because the backend write may not be observed yet at fire time. EXPORTED so the count plumbing is
// unit-testable.
export async function refreshCommentCount(): Promise<void> {
  // Short-circuit: nothing open ⇒ count is 0 (no await needed; no stale landing to guard).
  if (openPath === null) {
    commentCount = 0;
    refreshReviewBar(0);
    return;
  }
  const seq = ++countReqSeq;
  try {
    const n = await invoke<number>("get_comment_count", { path: openPath });
    // A newer refresh (or an authoritative applyCommentCount) began while this one was in flight —
    // drop this stale landing so it cannot overwrite the newer count (cross-plan A→B, same-plan A→A
    // bursty-reorder, AND a fresh in-session add whose authoritative count must not be re-read away).
    if (seq !== countReqSeq) return;
    commentCount = n;
    // The open plan may BE a pending review — re-derive the bar so its VIEWING comment count is right.
    refreshReviewBar(n);
  } catch (e) {
    console.error("get_comment_count failed", e);
  }
}

// Test-only reader for the stashed count.
export function currentCommentCount(): number {
  return commentCount;
}

// ---- Review action bar (persistent, non-occluding, resumable) ----
//
// The slim bar docked in the reading-pane header is shown whenever one or more reviews are pending.
// It has two modes (pure derivation in applyReviewBarState):
//   • VIEWING  — the OPEN plan IS a pending review's plan file: Submit (deny + feedback, enabled
//                with >=1 comment). In-process reviews also show Approve & Build (#review-approve).
//   • SUMMARY  — reviews pending but the user is browsing a non-reviewed plan: count label + Resume
//                only, so a pending review never traps navigation.
//
// `viewing` is the DERIVED condition currentReviewId() !== null. `viewedCommentCount` is the OPEN
// plan's comment count (review comments are now the plan's normal persisted comments).
function refreshReviewBar(countOverride?: number): void {
  if (!reviewBarEl) return;
  // ---- PROTOTYPE mode (Phase 4d) — precedence: pendingApproval gate > prototype gate > -------
  // pendingReviews. activePrototypeGate() already yields null while pendingApproval is held, so
  // reaching this branch means the prototype gate is the highest-precedence pending surface.
  const protoGate = activePrototypeGate();
  if (protoGate !== null) {
    applyPrototypeBar(protoGate);
    return;
  }
  // ---- ACCEPTANCE mode (Phase 5) — precedence: pendingApproval > prototype > ACCEPTANCE > --------
  // pendingReviews. acceptanceGateActive() yields null while either higher gate is held, so reaching
  // here with a non-null gate means the forced acceptance gate is the highest-precedence pending
  // surface (the run is built; the user must record a verdict against the frozen baseline).
  const acceptGate = activeAcceptanceGate();
  if (acceptGate !== null) {
    applyAcceptanceBar(acceptGate);
    return;
  }
  // Leaving (or never in) PROTOTYPE mode: its additive controls hide and #review-approve's
  // relabel reverts so the modes below render exactly as before the prototype feature.
  // The `.proto` modifier scopes the prototype-only bar layout (see styles.css); strip it so the
  // shared bar reverts to its legacy/pendingApproval layout untouched.
  reviewBarEl.classList.remove("proto");
  prototypeFeedbackEl?.classList.add("hidden");
  prototypeOpenEl?.classList.add("hidden");
  prototypeWorkingRefLabelEl?.classList.add("hidden");
  // PHASE 6 — the REFINE button + its picker are ACCEPTANCE-mode-only; hide on every other mode.
  reviewRefineEl?.classList.add("hidden");
  reviewRefineTargetEl?.classList.add("hidden");
  if (reviewApproveEl) reviewApproveEl.textContent = REVIEW_APPROVE_DEFAULT_LABEL;
  // Sub-Plan 02: the orchestrator's pending approval gate is a pending review surface that is NOT in
  // pendingReviews, so add it to the count while a run is awaiting approval. `viewing` is true when
  // the user is on a tracked pending review's plan OR on the orchestrator gate's plan.
  // GEN-2 UNIFIED GATE: the pending gate — decomposition (the root's included) OR leaf — is ALWAYS
  // carried in pendingApproval now (the master-phase keying is gone). One pending review surface.
  const orchGatePending =
    isOrchestrationActive() && orchSnapshot?.pendingApproval != null ? 1 : 0;
  const state = applyReviewBarState({
    pendingCount: pendingReviews.size + orchGatePending,
    viewing: currentReviewId() !== null || viewingGate() !== null,
    viewedCommentCount: countOverride ?? commentCount,
    // Source-aware: drives #review-approve visibility + the Submit label ("Request changes" for
    // in-process, "Submit" for external). currentReviewSource() reads the SAME matched review (or the
    // orchestrator gate, which it reports as "in-process").
    source: currentReviewSource(),
  });
  reviewBarEl.classList.toggle("hidden", !state.barVisible);
  if (reviewBarLabelEl) reviewBarLabelEl.textContent = state.label;
  if (reviewSubmitEl) {
    reviewSubmitEl.classList.toggle("hidden", !state.submitVisible);
    reviewSubmitEl.disabled = state.submitDisabled;
    // Source-aware label. In-process deny RE-PLANS in the same session → relabel to "Request changes".
    // External keeps its richer HTML default ("Submit feedback"); the pure state's external submitLabel
    // is "Submit" (asserted in the pure test) but we deliberately do NOT overwrite the external button's
    // existing descriptive text — relabel ONLY for the in-process source so external display is unchanged.
    if (currentReviewSource() === "in-process") reviewSubmitEl.textContent = state.submitLabel;
    else reviewSubmitEl.textContent = REVIEW_SUBMIT_EXTERNAL_LABEL;
  }
  if (reviewApproveEl) {
    reviewApproveEl.classList.toggle("hidden", !state.approveVisible);
  }
  if (reviewClearEl) {
    reviewClearEl.classList.toggle("hidden", !state.clearVisible);
    // If the manual clear button just became hidden (mode change / count hit 0), disarm any pending
    // two-click confirm so it can't fire later in a stale state.
    if (!state.clearVisible) reviewClearDisarm?.();
  }
  if (reviewResumeEl) reviewResumeEl.classList.toggle("hidden", !state.resumeVisible);
}

// The bar's PROTOTYPE mode (Phase 4d). Shown while a visual-prototype gate is held (and no
// approval gate outranks it — see refreshReviewBar's precedence). Affordances:
//   • label — `Visual prototype — round N of 3` (pure prototypeBarLabel; rounds are 1-based,
//     display-clamped to 3).
//   • #review-approve — ALWAYS enabled → approvePrototype(). Relabeled "Approve visual"
//     ("Proceed as-is" from round 3 — the loop-escape affordance; pure prototypeApproveLabel).
//   • #review-submit — "Request changes" → refinePrototype(feedback). Enabled only while
//     #prototype-feedback holds non-empty text (the feedback IS the refine prompt's payload).
//   • #prototype-feedback — the inline feedback textarea (PROTOTYPE mode only).
//   • #prototype-open — visible ONLY for kind "html": opens the prototype in the default browser
//     via the open_prototype command (HTML cannot render inline in the pane).
// The comment-driven controls (clear/dismiss/resume) hide: prototype feedback is the textarea,
// not inline comments.
function applyPrototypeBar(gate: PrototypeGate): void {
  if (!reviewBarEl) return;
  reviewBarEl.classList.remove("hidden");
  // `.proto` scopes the prototype-only bar layout (textarea-grows, nowrap buttons, taller bar) so
  // the shared review-bar's other two modes are untouched. See styles.css `.review-bar.proto`.
  reviewBarEl.classList.add("proto");
  if (reviewBarLabelEl) reviewBarLabelEl.textContent = prototypeBarLabel(gate.round);
  if (reviewSubmitEl) {
    reviewSubmitEl.classList.remove("hidden");
    reviewSubmitEl.textContent = "Request changes";
    reviewSubmitEl.disabled = (prototypeFeedbackEl?.value.trim() ?? "") === "";
  }
  if (reviewApproveEl) {
    reviewApproveEl.classList.remove("hidden");
    // ADAPTIVE approve label: with non-empty feedback typed, approving APPLIES the feedback then
    // auto-advances to recon (combined apply-and-approve) — label "Apply changes & approve". With an
    // empty textarea it is the plain approve ("Approve visual" / "Proceed as-is" from round 3). The
    // #prototype-feedback `input` listener calls refreshReviewBar() so this recomputes live as the
    // user types — read the CURRENT textarea value here.
    const hasFeedback = (prototypeFeedbackEl?.value.trim() ?? "") !== "";
    reviewApproveEl.textContent = hasFeedback ? "Apply changes & approve" : prototypeApproveLabel(gate.round);
  }
  if (reviewClearEl) {
    reviewClearEl.classList.add("hidden");
    reviewClearDisarm?.();
  }
  reviewResumeEl?.classList.add("hidden");
  // PHASE 6 — the REFINE button + its picker are ACCEPTANCE-mode-only; keep hidden in PROTOTYPE mode.
  reviewRefineEl?.classList.add("hidden");
  reviewRefineTargetEl?.classList.add("hidden");
  if (prototypeFeedbackEl) {
    prototypeFeedbackEl.classList.remove("hidden");
    // Restore the prototype placeholder (ACCEPTANCE mode repurposes the same textarea).
    prototypeFeedbackEl.placeholder = "Describe what to change in the visual…";
  }
  // Restore the open-button's prototype label (ACCEPTANCE mode relabels it "Open baseline").
  if (prototypeOpenEl) prototypeOpenEl.textContent = "Open in browser";
  prototypeOpenEl?.classList.toggle("hidden", gate.kind !== "html");
  // Working-reference checkbox: shown for EVERY prototype kind (the floor classification applies to
  // any prototype, not just HTML). Its checked state is read at approve time (applyPrototypeBar
  // never forces it — the user's choice persists across live re-derivations while the gate is held).
  prototypeWorkingRefLabelEl?.classList.remove("hidden");
}

// The bar's ACCEPTANCE mode (Phase 5 — the forced acceptance gate). Shown while a held
// AcceptanceGate is the highest-precedence pending surface (a held approval/prototype gate outranks
// it — see refreshReviewBar's precedence). The run is built; the user must record a verdict against
// the frozen working-reference baseline before it is reported done. Reuses the prototype bar's
// layout/controls:
//   • label — `Acceptance — does the build meet the baseline floor?` (pure acceptanceBarLabel).
//   • #review-approve — ALWAYS enabled → approveAcceptance() ("Accept (meets baseline)").
//   • #review-submit — "Accept divergence…" → divergeAcceptance(reason). Enabled only while
//     #prototype-feedback holds a non-empty reason (the reason IS the persisted audit trail).
//   • #prototype-feedback — reused as the divergence-reason textarea (ACCEPTANCE mode only).
//   • #prototype-open — relabeled "Open baseline" → open_baseline (the driver auto-opens it once on
//     gate arming; this is the manual re-open affordance).
// The comment-driven controls (clear/dismiss/resume) and the working-reference checkbox hide.
function applyAcceptanceBar(_gate: AcceptanceGate): void {
  if (!reviewBarEl) return;
  reviewBarEl.classList.remove("hidden");
  // Reuse the `.proto` layout (textarea-grows, nowrap buttons, taller bar).
  reviewBarEl.classList.add("proto");
  if (reviewBarLabelEl) reviewBarLabelEl.textContent = acceptanceBarLabel();
  if (reviewSubmitEl) {
    reviewSubmitEl.classList.remove("hidden");
    reviewSubmitEl.textContent = acceptanceDivergeLabel();
    // Divergence REQUIRES a reason (the audit trail) — disabled until the textarea has non-empty text.
    reviewSubmitEl.disabled = (prototypeFeedbackEl?.value.trim() ?? "") === "";
  }
  if (reviewApproveEl) {
    reviewApproveEl.classList.remove("hidden");
    reviewApproveEl.textContent = acceptanceApproveLabel(); // always enabled — the floor is met
  }
  // PHASE 6 — the REFINE action (re-plan a sub-plan) is the THIRD acceptance action, shown ONLY in
  // ACCEPTANCE mode and only when there is at least one refinable sub-plan (a split root). The picker
  // (#review-refine-target) is the target-selection step; the button routes the picked target into
  // refineAcceptance. Populate the picker from the snapshot (DERIVED — acceptanceRefineTargets), then
  // toggle both controls together.
  const refineTargets = orchSnapshot ? acceptanceRefineTargets(orchSnapshot.root) : [];
  const hasTargets = refineTargets.length > 0;
  if (reviewRefineTargetEl) {
    // Preserve the user's prior selection across re-derivations when it still exists.
    const prior = reviewRefineTargetEl.value;
    reviewRefineTargetEl.innerHTML = "";
    for (const t of refineTargets) {
      const opt = document.createElement("option");
      opt.value = t.pathKey;
      opt.textContent = `${t.pathKey} — ${t.title}`;
      reviewRefineTargetEl.appendChild(opt);
    }
    if (refineTargets.some((t) => t.pathKey === prior)) reviewRefineTargetEl.value = prior;
    reviewRefineTargetEl.classList.toggle("hidden", !hasTargets);
  }
  if (reviewRefineEl) {
    reviewRefineEl.classList.toggle("hidden", !hasTargets);
    reviewRefineEl.textContent = acceptanceRefineLabel();
  }
  if (reviewClearEl) {
    reviewClearEl.classList.add("hidden");
    reviewClearDisarm?.();
  }
  reviewResumeEl?.classList.add("hidden");
  // The divergence-reason textarea (reused #prototype-feedback) is shown; the working-reference
  // checkbox is hidden (it belongs to the prototype gate, not the acceptance gate).
  if (prototypeFeedbackEl) {
    prototypeFeedbackEl.classList.remove("hidden");
    prototypeFeedbackEl.placeholder = "Why does the build diverge from the baseline floor?";
  }
  prototypeWorkingRefLabelEl?.classList.add("hidden");
  // Reuse #prototype-open as "Open baseline".
  if (prototypeOpenEl) {
    prototypeOpenEl.classList.remove("hidden");
    prototypeOpenEl.textContent = "Open baseline";
  }
}

// Render the held prototype's preview into the reading pane, DETACHED: composePreviewMarkdown's
// markdown goes through the normal renderInto/settle pipeline but openPath is NEVER touched — the
// preview is not a plan file, so the next openPlan naturally replaces it (its renderGuard
// generation supersedes ours). The filename header reads "prototype-preview"; gate.cwd is the
// render base dir (relative image/link resolution).
async function renderPrototypePreview(gate: PrototypeGate): Promise<void> {
  if (!readingPaneEl) return;
  const gen = renderGuard.begin();
  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  if (docFilenameEl) docFilenameEl.textContent = "prototype-preview";
  if (docSrcEl) docSrcEl.textContent = homePath ? collapseHome(gate.cwd, homePath) : gate.cwd;
  renderInto(readingPaneEl, composePreviewMarkdown(gate), gate.cwd);
  readerScrollEl?.scrollTo({ top: 0 });
  await settle(readingPaneEl);
  // settle() is async; a newer open/reload may have begun — bail so a late settle from this
  // superseded preview never touches the pane or the ToC (mirrors openPlan's guard discipline).
  if (!renderGuard.isCurrent(gen)) return;
  rebuildTocFromPane();
}

// Sub-Plan 03 — lifecycle cleanup. On agent-exit / fatal agent-error / user cancel, any in-process
// pending review describes a DEAD SDK seam: its held canUseTool promise is gone, so an Approve would
// resolve nothing (and must be impossible). Drop every in-process pending review (external reviews are
// untouched — they ride the independent file-IPC substrate) and refresh the bar. EXPORTED so the purge
// is directly unit-testable. Returns the count purged.
export function purgeInprocReviews(): number {
  let purged = 0;
  for (const [id, r] of Array.from(pendingReviews.entries())) {
    if (r.source === "in-process") {
      pendingReviews.delete(id);
      purged++;
    }
  }
  if (purged > 0) refreshReviewBar();
  return purged;
}

// Disarm hook for the #review-clear two-click confirm (set by its wiring; null under unit tests that
// never wire it). refreshReviewBar calls it when the button hides.
let reviewClearDisarm: (() => void) | null = null;

// Set once initConversation returns (the .then below): tells the conversation model a held
// interactive permission was resolved HERE (ExitPlanMode Approve / Request-changes — no
// question_answered exists for it), so its "Waiting for your input…" working label clears the
// instant the user clicks, not on the SDK's next inbound frame. Null until the handle exists.
let notifyPermissionResolved: ((toolUseId: string) => void) | null = null;

// Set once initConversation returns: echoes a VERBATIM user message as a user-attributed bubble in
// the conversation stream. Used by the out-of-band feedback sites (prototype "Request changes",
// plan-review comment submit) so the user's own words appear in the conversation. MUST be called only
// AFTER the corresponding dispatch SUCCEEDS — never before (a failed send must add no bubble). Null
// until the handle exists.
let echoUserMessage: ((text: string) => void) | null = null;

// Set once initConversation returns: reconstruct + replay a plan's PAST conversation into the
// CONVERSATION pane (silent populate on plan-select). Fired un-awaited from openPlan; a NO-OP while a
// live session / orchestration owns the pane (guarded inside the handle). Null until the handle exists.
let loadPlanHistory: ((stem: Stem) => void) | null = null;

// Build a STRUCTURED, human-readable echo of the plan-review comments the user submitted — one line
// per comment showing the anchor quote and the comment text. This is what the user SEES (their own
// words, attributed to them), NOT the wrapped buildFeedbackPrompt() output (that is the system text
// the agent receives). A whole-pane comment (no anchor quote) shows the comment alone. Empty input
// degrades to a bare "Requested changes" line so the bubble is never blank.
function echoCommentsText(records: CommentRecord[]): string {
  if (records.length === 0) return "Requested changes.";
  const lines = records.map((rec) => {
    const quote = rec.quote.trim();
    const comment = rec.comment.trim();
    if (quote && comment) return `Re: "${quote}" — ${comment}`;
    if (quote) return `Re: "${quote}"`;
    return comment || "(comment)";
  });
  return lines.join("\n");
}

// Shared review-response logic (the SINGLE place that calls respond_to_review), so the bar handlers
// never duplicate the invoke. On success, the review is removed from pendingReviews; the plan stays
// open + selected and its comments remain saved. The bar is then refreshed (drops to summary mode if
// other reviews remain, or hides entirely). Errors are surfaced in-DOM via #hook-status.
//   • Submit  = "deny" + buildFeedbackPrompt(the open plan's comments) → Claude revises.
//   • Approve = "allow" → IN-PROCESS reviews ONLY (the #review-approve "Approve & Build" click) allows
//               the held plan and begins building in-session. EXTERNAL reviews are NOT approvable from
//               the app: the external path below is DENY-ONLY (it guards "allow" and the Rust
//               respond_to_review command rejects "allow" too). External approvals happen only in the
//               terminal — the old "Dismiss → approve in terminal" button that once drove an in-app
//               external "allow" was removed and #review-approve is hidden for external reviews.
// Returns true iff the response was sent successfully (so callers — e.g. Submit — can take a
// success-only follow-up action such as clearing the submitted plan's now-consumed comments).
async function resolveReview(reviewId: string, decision: "allow" | "deny", reason: string): Promise<boolean> {
  const review = pendingReviews.get(reviewId);
  try {
    if (review?.source === "in-process") {
      // ---- In-process (Agent SDK canUseTool seam): round-trip the SAME toolUseId ----------------
      // The toolUseId is the SDK's id for the held ExitPlanMode request (= the reviewId here). It is
      // round-tripped IDENTICALLY whether or not this was a subagent plan (agentId is never branched
      // on), so a subagent's plan resolves exactly like the main agent's.
      const id = review.toolUseId ?? reviewId;
      if (decision === "allow") {
        // Approve & Build: allow the plan (no message), switch the live session to acceptEdits, and
        // flip to the Conversation tab so execution streams in place. This is the ONLY path that ever
        // calls resolve_tool_permission(allow) — reachable solely from the #review-approve click.
        await invoke("resolve_tool_permission", { id, allow: true, message: null });
        await invoke("set_agent_permission_mode", { mode: "acceptEdits" });
        switchToConversationTab();
      } else {
        // Request changes: deny with the assembled feedback prompt → the agent re-plans in the SAME
        // session (re-entering review when it re-emits ExitPlanMode).
        await invoke("resolve_tool_permission", { id, allow: false, message: reason });
      }
      // Either way the hold is released — drop the conversation's waiting-for-input label NOW.
      notifyPermissionResolved?.(id);
    } else {
      // ---- External (settings.json ExitPlanMode hook): the file-IPC path — DENY-ONLY ------------
      // External reviews can only be DENIED/Submitted from the app; approval happens exclusively in
      // the terminal (the old in-app "Dismiss → approve" affordance was removed, and #review-approve
      // is hidden for external reviews — review.ts approveVisible === source==="in-process"). Guard
      // the now-unreachable "allow" so a future caller can never silently re-introduce an in-app
      // external approval; the Rust respond_to_review command rejects it too (defense in depth).
      if (decision !== "deny") {
        throw new Error(
          `external reviews are deny-only from the app (got "${decision}"); approve in the terminal`,
        );
      }
      await invoke("respond_to_review", { reviewId, decision, reason });
    }
  } catch (e) {
    console.error(`resolveReview (${decision}, ${review?.source ?? "external"}) failed`, e);
    setHookStatus(hookStatusEl, `Could not send review response: ${String(e)}`, "error");
    setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
    return false;
  }
  pendingReviews.delete(reviewId);
  refreshReviewBar();
  return true;
}

// ---- Sub-Plan 03: cwd resolution + read/unread wiring (sidebar only) ----

// The user's home dir, fetched once at startup. Used to collapse a resolved absolute cwd
// into a `~/…` display path. Null until fetched (then we render the absolute path verbatim).
let homePath: string | null = null;

// filename_stem -> resolved cwd display string. Mirrors the backend cwd cache once a
// `resolve_cwds` call returns. `null` means "resolved but unknown" (show "unknown");
// an ABSENT key means "not yet resolved" (show empty — no "unknown" flash).
const cwdByStem = new Map<Stem, string | null>();

// filename_stem of every stem currently in-flight to the backend (or terminally resolved), so
// a stream of `plan-changed` events never re-triggers a full corpus rescan for a stem while one
// is in flight. A `null` (unknown) result under the attempt cap is RELEASED from this set so a
// later event can re-attempt it (see `resolve.ts`); once it hits the cap it stays here.
const attemptedStems = new Set<Stem>();

// Per-stem count of how many times we have asked the backend to resolve it. A stem that keeps
// resolving to `null` ("unknown") is re-attempted up to `MAX_RESOLVE_ATTEMPTS` times so a
// transcript written shortly after the plan file is eventually picked up; past the cap it is
// pinned "unknown" (no unbounded rescans).
const resolveAttemptCounts = new Map<Stem, number>();

// Map a resolved cwd (absolute) to its sidebar display form (home-collapsed, else verbatim).
function displayCwd(absCwd: string): string {
  return homePath ? collapseHome(absCwd, homePath) : absCwd;
}

// Mark a plan viewed on the backend (clears its unread state). Errors are non-fatal.
async function markViewed(path: AbsPath): Promise<void> {
  try {
    await invoke("mark_viewed", { path });
  } catch (e) {
    console.error("mark_viewed failed", e);
  }
}

// Parent directory of an absolute path — used as the base for resolving a plan's
// relative image srcs. Strips the trailing `/<filename>`; falls back to the path
// itself if it has no separator.
function dirOf(absPath: AbsPath): string {
  const idx = absPath.lastIndexOf("/");
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}

// Human-friendly relative time for the sidebar `.plan-meta .when` slot.
function relativeTime(mtimeMs: number): string {
  const now = Date.now();
  const diff = now - mtimeMs;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  const d = new Date(mtimeMs);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Decide the `.plan-src` text for a record. Precedence: backend-cached `rec.cwd` (absolute)
// wins; otherwise consult `cwdByStem` (populated by a completed `resolve_cwds`). The two
// states a row can be in before/after resolution:
//   - not yet resolved (no cache hit, stem absent from cwdByStem) ⇒ "" (empty — no flash)
//   - resolved to a path ⇒ home-collapsed display
//   - resolved but unknown (cwdByStem has null) ⇒ "unknown"
function planSrcText(rec: PlanRecord): string {
  // Prior gate (NOT part of the three-state machine): a backend-cached absolute cwd wins.
  if (rec.cwd) return displayCwd(rec.cwd);
  const s = cwdState(cwdByStem, rec.filename_stem);
  switch (s.state) {
    case "unresolved":
      return ""; // not yet resolved → empty (no "unknown" flash)
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// ---- Synthetic "resume" sidebar rows (Phase 4) ------------------------------------------------
//
// `list_plans` synthesizes a `PlanRecord` for a mid-decompose plan-tree that has NO real plan `.md`
// file yet, so the tree is still visible + its resume banner reachable (see CONTRACT.md §"Amendment
// 2026-06-17 — Synthetic resume sidebar rows"). The row carries a SENTINEL `absolute_path` of the
// form `plan-tree-resume://<tree_id>` — there is NO file behind it. Anything that would `invoke`
// `read_plan_contents` / `set_open_plan` / `mark_viewed` against the path MUST guard on this
// predicate first (the Rust commands reject a sentinel — canonicalize fails on the scheme string).
const RESUME_SENTINEL_SCHEME = "plan-tree-resume://";

// True iff `path` is a synthetic-row sentinel (no real `.md` file behind it).
function isResumeSentinel(path: string): boolean {
  return path.startsWith(RESUME_SENTINEL_SCHEME);
}

// The tree_id encoded in a sentinel path (`plan-tree-resume://<tree_id>` → `<tree_id>`). Caller MUST
// have already gated on `isResumeSentinel`. Used to test whether a live-run placeholder is standing in
// for the same tree (the happy resume→placeholder takeover) before clearing a vanished sentinel.
function resumeSentinelTreeId(path: string): string {
  return path.slice(RESUME_SENTINEL_SCHEME.length);
}

// ---- Resume detection (Phase 5) ---------------------------------------------------------------
//
// Resolve a plan record's originating cwd for the resume read path. Mirrors planSrcText's
// precedence (backend-cached absolute cwd wins; else the resolved cwdByStem path) but returns the
// ABSOLUTE path (never the home-collapsed display form) — the resume reads the real `.plan-tree/`.
// Returns null when the cwd is not yet resolved or resolved-but-unknown: with no real directory
// there is nothing to read, so detectResumable returns null (no banner).
function resolvedCwdFor(rec: PlanRecord): string | null {
  // BELT-AND-SUSPENDERS: expand a leading `~/` (or bare `~`) back to the absolute home path before
  // the resume read. `patchAllCwds` syncs the home-COLLAPSED display string onto `rec.cwd` (so the
  // sidebar filter matches the visible `~`-form); but `read_plan_tree_file` does NOT expand `~`, so a
  // `~`-path would `is_dir()`-fail in Rust and silently kill the Resume banner. expandHome is a no-op
  // on an already-absolute path, so resolved-from-cache (absolute) cwds are unaffected.
  const raw = rec.cwd ? rec.cwd : cwdStateResolvedPath(rec);
  if (raw === null) return null;
  return homePath ? expandHome(raw, homePath) : raw;
}

// The resolved (absolute) cwd for a record from the resolve cache alone, or null when it is not yet
// resolved or resolved-but-unknown. Split out of resolvedCwdFor so the `~`-expansion above applies
// uniformly to both the backend-cached cwd and the cache-resolved path.
function cwdStateResolvedPath(rec: PlanRecord): string | null {
  const s = cwdState(cwdByStem, rec.filename_stem);
  return s.state === "resolved" ? s.path : null;
}

// The verdict detectResumable hands back: the pure ResumeScope (resumable OR blocked) PLUS the cwd +
// parsed ledger the click handler needs to drive getOrchestrator().resume(). Null (returned by
// detectResumable) means "no banner at all".
export type ResumeVerdict = ResumeScope & { cwd: string; ledger: RecursiveLedger };

// Narrow shape-guard for a parsed `state.json`: schema-2 ledger with a `root` node and the tree_id we
// matched on. Deliberately shallow — assertCoherent2 (run inside resumeScopeForRoot/rehydrate) is the
// deep check; this only gates the obviously-wrong (wrong schema, missing root) before any helper that
// could throw runs.
function isLedgerShape(v: unknown): v is RecursiveLedger {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.schema === 2 && typeof o.tree_id === "string" && typeof o.root === "object" && o.root !== null;
}

// READ-ONLY resume detection (NO tokens, NO agent). Given the selected plan record, decide whether a
// Resume banner should appear and, if so, with what verdict. NEVER throws (every throwing step is
// wrapped) — a plan click must not be able to crash. Returns null whenever there is no resumable
// tree: cwd unresolved, no/absent state.json, parse failure, tree_id mismatch (a stale `.plan-tree/`
// for a DIFFERENT tree must not light up), the tree already done, an orchestration already active, or
// a coherence/scope helper that threw. Returns a verdict (resumable OR blocked) otherwise, so the
// banner can render BOTH the resume button and the blocked message.
export async function detectResumable(rec: PlanRecord): Promise<ResumeVerdict | null> {
  try {
    // tree_id is required: a standalone plan (no tree) is never part of a `.plan-tree/`.
    if (!rec.tree_id) {
      diag(`detectResumable: stem=${rec.filename_stem} no tree_id → no banner`);
      return null;
    }
    // An active orchestration owns the seam — never offer a competing resume.
    if (isOrchestrationActive()) {
      diag(`detectResumable: tree_id=${rec.tree_id} orchestrationActive → no banner`);
      return null;
    }
    const cwd = resolvedCwdFor(rec);
    if (cwd === null) {
      diag(`detectResumable: tree_id=${rec.tree_id} cwd UNRESOLVED → no banner`);
      return null; // cwd unresolved → no banner.
    }

    // The state.json read is wrapped in its OWN try/catch so a cwd/IO error here (e.g. a non-existent
    // or `~`-unexpanded cwd making Rust's `read_plan_tree_file` REJECT) is distinguished from the
    // benign "no tree" case (resolve to null) and is NOT silently absorbed by the outer catch as an
    // anonymous "UNEXPECTED ERROR". Both branches → no banner; the diag tells them apart in dev.
    let raw: string | null;
    try {
      raw = await invoke<string | null>("read_plan_tree_file", { cwd, name: "state.json" });
    } catch (e) {
      console.debug("detectResumable: read_plan_tree_file(state.json) rejected", e);
      diag(`detectResumable: tree_id=${rec.tree_id} cwd=${cwd} state.json READ ERROR (${e}) → no banner`);
      return null; // cwd/IO error reading the tree → not resumable (and now visibly diagnosed).
    }
    if (raw === null) {
      diag(`detectResumable: tree_id=${rec.tree_id} cwd=${cwd} state.json NOT FOUND → no banner`);
      return null; // no `.plan-tree/state.json` → not a resumable tree.
    }

    // Defensive parse + shape-guard — a torn/foreign file must degrade to no-banner, never throw.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.debug("detectResumable: state.json parse failed", e);
      diag(`detectResumable: tree_id=${rec.tree_id} state.json PARSE FAILED → no banner`);
      return null;
    }
    if (!isLedgerShape(parsed)) {
      diag(`detectResumable: tree_id=${rec.tree_id} state.json wrong shape → no banner`);
      return null;
    }
    const ledger = parsed;

    // STALE-TREE GUARD: a `.plan-tree/` left by a DIFFERENT tree must not light up this plan's banner.
    if (ledger.tree_id !== rec.tree_id) {
      diag(
        `detectResumable: tree_id MISMATCH (ledger=${ledger.tree_id} rec=${rec.tree_id}) → no banner`,
      );
      return null;
    }

    const root = ledger.root as TreeNode;

    // BANNER↔ENGINE DISK-PROBE SYMMETRY: the engine (orchestrator.resume) classifies a persisted
    // `open/decomposing` node by probing disk — does planName2(activePath) exist under `.plan-tree/`? —
    // and gates (re-present the decomposition gate) when present, resends ("decompose") when absent. The
    // banner MUST classify identically, so pre-read that SAME single artifact here and back a synchronous
    // predicate with the cached result. recoveryFor only ever probes the ACTIVE node's path, so probe the
    // DYNAMIC activePathOf(root) (nested decomposes resolve correctly), NOT a hardcoded root. A NON-NULL
    // read ⇒ "present"; null/absent/missing-file/IO-error ⇒ "absent" (the conservative default, matching
    // the engine). Every read is guarded so a missing file degrades to "absent" — never a throw
    // (detectResumable must never throw). The predicate keys on pathKey so a probe of any other path
    // falls through to absent rather than a phantom hit.
    // The probe fires ONLY when the active node is actually open/decomposing (the sole consumer of the
    // predicate in recoveryFor). A leaf gate or any other phase needs no `.plan-tree/` filename read,
    // and firing one there would be a wasted disk hit (and would wrongly probe `.plan-tree/` for a leaf
    // plan that lives under ~/.claude/plans/, tripping the leaf-gate "no plan-tree probe" invariant).
    const decompositionArtifactCache = new Map<string, boolean>();
    const activeForProbe = activePathOf(root);
    if (activeForProbe !== null) {
      const activeNode = nodeAtPath(root, activeForProbe);
      const isDecomposing =
        activeNode?.state.stage === "open" && activeNode.state.phase === "decomposing";
      if (isDecomposing) {
        let probed: string | null = null;
        try {
          probed = await invoke<string | null>("read_plan_tree_file", {
            cwd,
            name: planName2(activeForProbe),
          });
        } catch (e) {
          console.debug("detectResumable: decomposition-artifact probe failed", e);
          probed = null; // missing/IO-error ⇒ absent.
        }
        decompositionArtifactCache.set(pathKey(activeForProbe), probed !== null);
      }
    }
    const decompositionArtifactExists = (path: NodePath): boolean =>
      decompositionArtifactCache.get(pathKey(path)) ?? false;

    // treeIsDone is pure + total, but wrap defensively alongside resumeScopeForRoot (which CAN throw on
    // an unclassified node state via assertNeverRecovery). Any throw → no banner.
    let scope: ResumeScope;
    try {
      if (treeIsDone(root)) {
        diag(`detectResumable: tree_id=${rec.tree_id} treeIsDone=true → no banner`);
        return null; // a completed tree is not resumable.
      }
      // Pass the ledger so the PHASE-5 acceptance window (a baseline-bearing root parked awaiting a
      // verdict) classifies as resumable rather than blocked, and the disk-probe predicate so
      // open/decomposing is classified gate-vs-resend identically to the engine.
      scope = resumeScopeForRoot(root, ledger, decompositionArtifactExists);
    } catch (e) {
      console.debug("detectResumable: resume-scope derivation threw", e);
      diag(`detectResumable: tree_id=${rec.tree_id} resumeScopeForRoot THREW → no banner`);
      return null;
    }

    if (!scope.resumable) {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} scope=BLOCKED(${scope.reason}) phase="${scope.phaseLabel}" → blocked banner`,
      );
      return { ...scope, cwd, ledger };
    }

    // For a resumable GATE scope, the user reviews an on-disk plan artifact — verify it exists, else
    // the gate cannot be re-presented. The two gate kinds live in DIFFERENT trees on disk:
    //   - LEAF gate: `scope.plan.planPath` is the ABSOLUTE path recorded on the node at NODE_DRAFTED.
    //     This app writes leaf plans into `~/.claude/plans/` (NOT `.plan-tree/`), so the artifact is
    //     verified through the plans channel (`read_plan_contents`, which canon-checks containment in
    //     the plans dir). Using `read_plan_tree_file` here would ALWAYS miss (the file is not under
    //     `.plan-tree/`) and false-negative every real leaf gate into a blocked banner.
    //   - DECOMPOSITION gate: an `open/awaiting-decomposition-approval` node has no path field, so
    //     `scope.plan.planPath` is the FILENAME `planName2(path)` ("master.md" / "<pathKey>-plan.md")
    //     under `.plan-tree/` — verified through `read_plan_tree_file`.
    // Missing artifact → degrade to a BLOCKED verdict (banner shows the message, not a button).
    // Resend scopes need no artifact (the prompt is re-sent fresh).
    // PHASE 5 — the forced acceptance window: the build is COMPLETE; the only thing missing is the
    // user's verdict against the frozen baseline. There is NO plan artifact to verify (no model turn
    // resumes — the driver re-mints the acceptance gate and surfaces the bar). Surface it as a
    // resumable banner so reopening the app shows the acceptance bar, not the blocked message.
    if (scope.plan.kind === "acceptance") {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE acceptance window phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    if (scope.plan.kind === "gate") {
      const plan = scope.plan;
      let artifact: string | null = null;
      try {
        if (plan.gateKind === "leaf") {
          // The node's absolute `~/.claude/plans/...` path — verify through the plans channel.
          artifact = await invoke<string>("read_plan_contents", { path: plan.planPath });
        } else {
          // The decomposition plan lives under `.plan-tree/` by filename.
          artifact = await invoke<string | null>("read_plan_tree_file", {
            cwd,
            name: planName2(plan.path),
          });
        }
      } catch (e) {
        // read_plan_contents REJECTS (not resolves null) on a missing/out-of-bounds file — treat any
        // throw as "absent" rather than crashing the click.
        console.debug("detectResumable: gate-artifact read failed", e);
        artifact = null;
      }
      if (artifact === null) {
        diag(
          `detectResumable: tree_id=${rec.tree_id} ${plan.gateKind} gate artifact MISSING (planPath=${plan.planPath}) → blocked banner`,
        );
        return { resumable: false, reason: "plan artifact missing", phaseLabel: scope.phaseLabel, cwd, ledger };
      }
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE ${plan.gateKind} gate at "${pathKey(plan.path)}" planPath=${plan.planPath} phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    if (scope.plan.kind === "resend") {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE resend(${scope.plan.awaiting}) phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    // PHASE 2 NEW KINDS (restart / prototype-gate / rewind): the pure scope is now RESUMABLE and the
    // banner offers them as real one-click FORWARD actions. The orchestrator decides the concrete
    // action from the ledger (resume keys off cwd+ledger), so the banner only triggers resume.
    //   - restart{from:"clarify"} / prototype-gate: NO artifact verification — `restart` re-runs the
    //     clarify turn from the root title (no durable plan to read), and `prototype-gate`'s artifact
    //     is the `.plan-tree/prototype/` directory + INTENT.md the driver re-mints (not a single plan
    //     .md verified through the gate channels). Both are resumable as-is.
    //   - rewind: when `planPath` is non-null the rewind re-presents an on-disk plan artifact, but the
    //     CHANNEL depends on the artifact's SHAPE (mirroring how the gate branch above distinguishes
    //     leaf vs decomposition):
    //       * ABSOLUTE `~/.claude/plans/...` planPath ⇒ a LEAF artifact (the leaf/executing
    //         audit-and-continue rewind carries the node's own absolute planPath, recorded at
    //         NODE_DRAFTED — leaves write ONLY to the plans store, never `.plan-tree/`). Verify it
    //         through the PLANS channel (read_plan_contents). Using read_plan_tree_file here would
    //         ALWAYS miss — the Rust allow-list (valid_plan_tree_name) rejects an absolute name — so
    //         every real executing rewind would false-negative into a blocked banner (the "Continue
    //         implementation" button would never appear).
    //       * RELATIVE name ⇒ a decomposition plan filename under `.plan-tree/` (planName2(path)) —
    //         verify it like a DECOMPOSITION gate (read_plan_tree_file).
    //     A null planPath rewind (a torn leaf gate, the runtime-degenerate no-active-node case) has no
    //     single artifact to read → resumable with no verification.
    if (scope.plan.kind === "rewind" && scope.plan.planPath !== null) {
      const planPath = scope.plan.planPath;
      const isAbsolute = planPath.startsWith("/") || planPath.startsWith("~");
      let artifact: string | null = null;
      try {
        artifact = isAbsolute
          ? await invoke<string>("read_plan_contents", { path: planPath })
          : await invoke<string | null>("read_plan_tree_file", { cwd, name: planPath });
      } catch (e) {
        // read_plan_contents REJECTS (not resolves null) on a missing/out-of-bounds file, and
        // read_plan_tree_file rejects an invalid/out-of-bounds name — treat any throw as "absent"
        // rather than crashing the click.
        console.debug("detectResumable: rewind-artifact probe failed", e);
        artifact = null; // missing/IO-error ⇒ absent.
      }
      if (artifact === null) {
        diag(
          `detectResumable: tree_id=${rec.tree_id} rewind artifact MISSING (planPath=${planPath}) → blocked banner`,
        );
        return { resumable: false, reason: "plan artifact missing", phaseLabel: scope.phaseLabel, cwd, ledger };
      }
    }
    diag(
      `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE ${scope.plan.kind} phase="${scope.phaseLabel}" → Resume banner`,
    );
    return { ...scope, cwd, ledger };
  } catch (e) {
    // Belt-and-suspenders: detectResumable must NEVER throw on a plan click.
    console.debug("detectResumable: unexpected error", e);
    diag(`detectResumable: UNEXPECTED ERROR → no banner`);
    return null;
  }
}

// The HONEST one-click action label for a resumable ResumePlan. Each kind names the concrete forward
// action the user is about to take (the orchestrator decides HOW from the ledger; this label only
// describes WHAT). The classic gate/resend/acceptance shapes keep the "Resume — <phaseLabel>" form;
// the PHASE-2 kinds (restart / prototype-gate / rewind) read as their own forward actions:
//   - restart{from:"clarify"} → re-run the clarify turn from the original request.
//   - prototype-gate → a normal resume back into the prototype-review gate.
//   - rewind{toGate} → wind the run back to the nearest durable gate, named per `toGate`.
// PHASE-2 SCOPE: every label here is a NON-hazardous one-click action. The structured switch leaves
// room for PHASE 3 to add the confirmation-gated hazardous variant (leaf/executing) as a SECONDARY
// without reshaping this; today no hazardous resumable kind reaches the banner.
function resumeActionLabel(plan: ResumePlan, phaseLabel: string): string {
  switch (plan.kind) {
    case "restart":
      // `from` is "clarify" today (the only restart anchor).
      return "Restart from your original request";
    case "prototype-gate":
      return "Resume — Prototype review";
    case "rewind": {
      // PHASE 3c — the HAZARDOUS executing rewind (requiresConfirm) reads as a forward "continue", NOT a
      // "Rewind to …": the user is resuming the in-flight implementation behind a confirmation, not
      // discarding work. The honest risk ("edits may be partially applied") is surfaced in the confirm
      // row, not the button label.
      if (plan.requiresConfirm) return "Continue implementation";
      // Human-readable per `toGate`: a decomposition rewind re-presents the split's decomposition plan;
      // a leaf / leaf-approval rewind winds back to the node's own approved leaf plan.
      const target = plan.toGate === "decomposition" ? "decomposition plan" : "approved plan";
      return `Rewind to ${target}`;
    }
    case "gate":
    case "resend":
    case "acceptance":
      // The classic resumable kinds keep the "Resume — <active phase>" form (the active phase IS the
      // forward action for these — re-present the gate / re-send the step / re-mint the acceptance bar).
      return `Resume — ${phaseLabel}`;
  }
}

// Render the #resume-banner from a verdict (or hide it for null). Pure DOM derivation: resumable →
// the #resume-plan-btn labeled per-kind (see resumeActionLabel; the resume context stashed for its
// click); blocked → a static muted "<phaseLabel> — resuming from here isn't supported yet" message,
// no button; null → hidden + context cleared. Orthogonal to refreshReviewBar (both surfaces may show).
export function renderResumeBanner(verdict: ResumeVerdict | null): void {
  if (!resumeBannerEl) return;
  // Always start from the collapsed (one-click) confirm state — any prior verdict's open confirm row
  // must not bleed across a re-render onto a different/blocked/hidden verdict.
  hideResumeConfirmRow();
  if (verdict === null) {
    pendingResume = null;
    resumeBannerEl.classList.add("hidden");
    resumeBannerEl.classList.remove("blocked");
    resumePlanBtnEl?.classList.add("hidden");
    if (resumeBannerMsgEl) resumeBannerMsgEl.textContent = "";
    return;
  }
  resumeBannerEl.classList.remove("hidden");
  if (verdict.resumable) {
    // Only a `rewind` plan carries `requiresConfirm`/`hazard` (leaf/executing today); every other
    // resumable kind is one-click (requiresConfirm absent ⇒ false). Extract them onto pendingResume so
    // the click handler can gate the hazardous case without re-deriving the plan shape.
    const requiresConfirm = verdict.plan.kind === "rewind" && verdict.plan.requiresConfirm === true;
    const hazard =
      verdict.plan.kind === "rewind" && verdict.plan.hazard !== undefined ? verdict.plan.hazard : null;
    pendingResume = { cwd: verdict.cwd, ledger: verdict.ledger, requiresConfirm, hazard };
    resumeBannerEl.classList.remove("blocked");
    if (resumeBannerMsgEl) resumeBannerMsgEl.textContent = "";
    if (resumePlanBtnEl) {
      resumePlanBtnEl.classList.remove("hidden");
      resumePlanBtnEl.textContent = resumeActionLabel(verdict.plan, verdict.phaseLabel);
    }
  } else {
    pendingResume = null;
    resumeBannerEl.classList.add("blocked");
    resumePlanBtnEl?.classList.add("hidden");
    if (resumeBannerMsgEl) {
      resumeBannerMsgEl.textContent = `${verdict.phaseLabel} — resuming from here isn't supported yet`;
    }
  }
}

// Collapse the inline confirm row back to the one-click button (hide the confirm/cancel pair + hazard
// text, re-show the primary button). Idempotent — safe to call when the row was never opened.
function hideResumeConfirmRow(): void {
  resumeConfirmRowEl?.classList.add("hidden");
  if (resumeHazardEl) resumeHazardEl.textContent = "";
  resumePlanBtnEl?.classList.remove("hidden");
}

// Reveal the inline confirm row for a HAZARDOUS resume: hide the primary button, show the hazard text +
// Confirm/Cancel pair. resume() does NOT fire here — only #resume-confirm-btn fires it.
function showResumeConfirmRow(hazard: string | null): void {
  resumePlanBtnEl?.classList.add("hidden");
  if (resumeHazardEl) {
    resumeHazardEl.textContent = hazard
      ? `Are you sure? ${hazard}`
      : "Are you sure? The assistant will inspect the working tree and continue the remaining steps; " +
        "if it misjudges what's already applied, edits could be duplicated or corrupted.";
  }
  resumeConfirmRowEl?.classList.remove("hidden");
}

// Re-evaluate the resume banner for the currently-open record (fire-and-forget from openPlan). Reads
// the freshest record for `path` from lastRecords (its tree_id/cwd may have been patched since open),
// runs detectResumable, and paints the banner — but only if `path` is STILL the open plan when the
// async read lands (a fast A→B switch must not paint A's banner over B).
async function refreshResumeBanner(path: AbsPath): Promise<void> {
  const rec = lastRecords.find((r) => r.absolute_path === path);
  if (!rec) {
    if (openPath === path) renderResumeBanner(null);
    return;
  }
  const verdict = await detectResumable(rec);
  if (openPath !== path) return; // superseded — a newer open owns the banner.
  renderResumeBanner(verdict);
}

// #resume-plan-btn click → drive getOrchestrator().resume() and, on success, mirror the composer's
// onStarted path: the onSnapshot observer mints the live-run placeholder + selects it (real sidebar
// rows already exist for this tree, so placeholderVisible suppresses a phantom row), and for a gate
// phase the onAwaitingApproval observer opens the held plan + flips to the Plan tab. We flip to the
// Conversation tab up front (matching the composer start) and hide the banner on success.
async function resumeFromBanner(): Promise<void> {
  if (pendingResume === null) return;
  // PHASE 3c — HAZARDOUS gate: a verdict whose plan requiresConfirm (leaf/executing — edits may be
  // partially applied) must NOT resume on this first click. Reveal the inline confirm row and return;
  // resume() fires ONLY from the subsequent #resume-confirm-btn click (executeResume). Non-hazardous
  // verdicts fall through and fire immediately, exactly as before.
  if (pendingResume.requiresConfirm) {
    showResumeConfirmRow(pendingResume.hazard);
    return;
  }
  await executeResume();
}

// Cancel the hazardous confirm step: abort WITHOUT resuming, collapsing the confirm row back to the
// one-click button. pendingResume is untouched (the banner stays, the verdict remains resumable).
function cancelResumeConfirm(): void {
  hideResumeConfirmRow();
}

// Actually drive getOrchestrator().resume() for the pending verdict. Reached from the non-hazardous
// button click directly, OR from #resume-confirm-btn after the user confirmed a hazardous resume — so
// resume() is provably never invoked for a hazardous verdict until confirmation.
async function executeResume(): Promise<void> {
  if (pendingResume === null) return;
  const { cwd, ledger } = pendingResume;
  // Disable BOTH the primary and the confirm button to prevent a double-click re-entry while resume()
  // is in flight (either could be the visible control depending on the confirm step).
  if (resumePlanBtnEl) resumePlanBtnEl.disabled = true;
  if (resumeConfirmBtnEl) resumeConfirmBtnEl.disabled = true;
  try {
    const ok = await getOrchestrator().resume({ cwd, ledger });
    if (ok) {
      // Mirror the composer onStarted path: show the live run. The onSnapshot observer flips the
      // placeholder/selection and switches the tab; flip here too so the user sees the run immediately
      // even before the first snapshot lands. A gate-phase resume's onAwaitingApproval observer will
      // then re-assert the Plan tab on the held plan.
      switchToConversationTab();
      renderResumeBanner(null);
    }
  } catch (e) {
    console.error("resume() failed", e);
    showToast("Couldn't resume this plan — see the log for details.");
  } finally {
    if (resumePlanBtnEl) resumePlanBtnEl.disabled = false;
    if (resumeConfirmBtnEl) resumeConfirmBtnEl.disabled = false;
  }
}

// Show the lightweight #toast with `msg`, auto-dismissing after TOAST_MS. Non-blocking — it never
// changes session/tab state. A second call resets the timer (latest message wins).
const TOAST_MS = 6000;
function showToast(msg: string): void {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.add("hidden");
    toastTimer = null;
  }, TOAST_MS);
}

// ---- Nested sidebar rendering (Sub-Plan 02) ----------------------------------------------
//
// `list_plans` returns records PRE-ORDERED for direct nested rendering (see CONTRACT.md
// §"Nested master/sub hierarchy"): top-level masters + standalones interleaved by recency,
// each master IMMEDIATELY followed by its children in nn-ascending order, as a closed flavor
// set with orphans/duplicates already normalized. So `renderSidebar` walks top-to-bottom with
// NO re-aggregation and NO flavor-fallback logic.

// Apply the shared per-row classes/state and click → onOpen wiring to a `.plan` row.
function applyRowState(row: HTMLElement, rec: PlanRecord, ctx: SidebarCtx): void {
  row.dataset.path = rec.absolute_path;
  if (rec.unread) row.classList.add("unread");
  if (rec.absolute_path === ctx.openPath) row.classList.add("active");
  row.addEventListener("click", () => {
    ctx.onOpen(rec.absolute_path, rec.filename_stem);
  });
}

// Build a flat row matching the documented per-row template:
//   .plan[.active][.unread] data-path  >  .plan-row > .plan-title + .unread-dot
//                                          .plan-src (dimmed cwd; filled by 03)
//                                          .plan-meta (.when)
// Standalone rows and 0-child masters use this shape. A 0-child master keeps flavor=master
// semantics internally and opens normally (see the "0-child master ⇒ flat row" decision).
function buildFlatRow(rec: PlanRecord, ctx: SidebarCtx): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan";
  applyRowState(row, rec, ctx);

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const title = document.createElement("span");
  title.className = "plan-title";
  // A synthetic resume-sentinel row's `filename_stem` is the tree_id (display-incidental) — show the
  // tree's title instead, which rides `h1s[0]` (see CONTRACT.md §"Amendment 2026-06-17"). Real rows
  // keep the existing `filename_stem` title. A sentinel with no h1s falls back to the stem.
  title.textContent = isResumeSentinel(rec.absolute_path)
    ? rec.h1s[0] ?? rec.filename_stem
    : rec.filename_stem;

  const dot = document.createElement("span");
  dot.className = "unread-dot";

  planRow.appendChild(title);
  planRow.appendChild(dot);

  const src = document.createElement("div");
  src.className = "plan-src";
  src.textContent = planSrcText(rec);

  const meta = document.createElement("div");
  meta.className = "plan-meta";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relativeTime(rec.mtime_ms);
  meta.appendChild(when);

  row.appendChild(planRow);
  row.appendChild(src);
  row.appendChild(meta);

  return row;
}

// Build an expandable master: a `.master` wrapper holding a `.plan.master-row` (flat-row shape
// PLUS a leading `.twirl` and a trailing `.child-count`) and a `.children` container. Only built
// when child_count >= 1 (0-child masters render flat via buildFlatRow). Returns the wrapper and
// its `.children` box (the walk threads subs into the latter).
function buildMaster(rec: PlanRecord, ctx: SidebarCtx): { wrapper: HTMLElement; children: HTMLElement } {
  const treeId = rec.tree_id ?? "";
  const effectiveCollapsed = ctx.collapseOverride.get(treeId) ?? rec.collapsed;

  const wrapper = document.createElement("div");
  wrapper.className = "master";
  wrapper.dataset.treeId = treeId; // lets onToggleCollapse find this wrapper for instant feedback
  if (effectiveCollapsed) wrapper.classList.add("collapsed");

  const row = buildFlatRow(rec, ctx);
  row.classList.add("master-row");

  const planRow = row.querySelector(".plan-row") as HTMLElement;

  // Disclosure twirl — its OWN listener stops propagation so toggling never also opens the
  // master plan. Prepend it before the title.
  const twirl = document.createElement("span");
  twirl.className = "twirl";
  twirl.textContent = "▾"; // ▾
  twirl.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.onToggleCollapse(treeId, !(ctx.collapseOverride.get(treeId) ?? rec.collapsed));
  });
  planRow.insertBefore(twirl, planRow.firstChild);

  // "N sub-plans" count (singular at 1) appended after the title/dot.
  const n = rec.child_count ?? 0;
  const count = document.createElement("span");
  count.className = "child-count";
  count.textContent = `${n} sub-plan${n === 1 ? "" : "s"}`;
  planRow.appendChild(count);

  const children = document.createElement("div");
  children.className = "children";

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return { wrapper, children };
}

// Build a compact sub row: `.plan.sub[data-path]` > `.plan-row` = `.seq`(FULL dotted nn_path,
// e.g. "02.01") + title + unread dot ONLY (no cwd/timestamp). The seq label derives EXCLUSIVELY
// from `nn_path` — NEVER from first-segment `nn` (labelling a "02.01" child by `nn` would render
// a colliding duplicate "02" row). A null nn_path (legacy sub with no frontmatter nn) keeps the
// pre-existing "00" placeholder.
function buildSub(rec: PlanRecord, ctx: SidebarCtx): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan sub";
  applyRowState(row, rec, ctx);

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = rec.nn_path ?? "00";

  const title = document.createElement("span");
  title.className = "plan-title";
  title.textContent = rec.filename_stem;

  const dot = document.createElement("span");
  dot.className = "unread-dot";

  planRow.appendChild(seq);
  planRow.appendChild(title);
  planRow.appendChild(dot);
  row.appendChild(planRow);

  return row;
}

// Key for the SESSION-ONLY internal-node collapse map: tree_id + nn_path, NUL-joined so the two
// segments can never collide with each other's content. Deliberately disjoint from the persisted
// master collapse store (set_tree_collapsed) — internal-node collapse is never persisted.
function subCollapseKey(treeId: string, nnPath: string): string {
  return treeId + "\u0000" + nnPath;
}

// Build an INTERNAL sub node — a sub with nested dotted children. Mirrors buildMaster's
// affordances on the compact sub row: a `.sub-node` wrapper holding the `.plan.sub` row (PLUS a
// leading `.twirl` and a trailing per-node `.child-count` of its DIRECT children) and a nested
// `.children` container. Collapse is session-only: the twirl mutates ctx.subCollapse and flips
// the wrapper class directly (instant feedback, no backend call, no re-list).
function buildInternalSub(
  rec: PlanRecord,
  directCount: number,
  ctx: SidebarCtx,
): { wrapper: HTMLElement; children: HTMLElement } {
  const key = subCollapseKey(rec.tree_id ?? "", rec.nn_path ?? "");

  const wrapper = document.createElement("div");
  wrapper.className = "sub-node";
  wrapper.dataset.nnPath = rec.nn_path ?? "";
  if (ctx.subCollapse.get(key) ?? false) wrapper.classList.add("collapsed");

  const row = buildSub(rec, ctx);
  const planRow = row.querySelector(".plan-row") as HTMLElement;

  // Disclosure twirl — its OWN listener stops propagation so toggling never also opens the sub.
  const twirl = document.createElement("span");
  twirl.className = "twirl";
  twirl.textContent = "▾"; // ▾
  twirl.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = !(ctx.subCollapse.get(key) ?? false);
    ctx.subCollapse.set(key, next);
    wrapper.classList.toggle("collapsed", next);
  });
  planRow.insertBefore(twirl, planRow.firstChild);

  // Per-node "N sub-plans" count of DIRECT children only (singular at 1).
  const count = document.createElement("span");
  count.className = "child-count";
  count.textContent = `${directCount} sub-plan${directCount === 1 ? "" : "s"}`;
  planRow.appendChild(count);

  const children = document.createElement("div");
  children.className = "children";

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return { wrapper, children };
}

// A parsed sub-tree node for one master's run of sub records. `kids` is filled by the
// prefix-stack walk below; a node renders INTERNAL iff it actually accumulated kids (so a
// duplicate dotted id whose extensions attached to a LATER duplicate stays a plain leaf).
interface SubTreeNode {
  rec: PlanRecord;
  kids: SubTreeNode[];
}

// Render one parsed sub-tree into `container`: leaves via buildSub (byte-identical to the flat
// legacy shape — affordances appear ONLY when children exist), internal nodes via buildInternalSub
// with their kids rendered recursively into the nested `.children`.
function renderSubTree(node: SubTreeNode, container: HTMLElement, ctx: SidebarCtx): void {
  if (node.kids.length === 0) {
    container.appendChild(buildSub(node.rec, ctx));
    return;
  }
  const { wrapper, children } = buildInternalSub(node.rec, node.kids.length, ctx);
  container.appendChild(wrapper);
  for (const kid of node.kids) {
    renderSubTree(kid, children, ctx);
  }
}

// Build the `.plan.placeholder` row for a live run with no real sidebar row yet (Bug A fix).
// `.plan`-shaped (so it inherits row styling) but carries data-tree-id and NO data-path: there is
// no file to open, so openPlan's `[data-path]` selection loop structurally cannot touch it. Click
// routes to ctx.onPlaceholderOpen (flip to the Conversation tab + select the placeholder).
function buildPlaceholderRow(
  ph: { treeId: string; label: string; selected: boolean },
  ctx: SidebarCtx,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan placeholder";
  row.dataset.treeId = ph.treeId;
  if (ph.selected) row.classList.add("active");

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const dot = document.createElement("span");
  dot.className = "placeholder-dot";

  const title = document.createElement("span");
  title.className = "plan-title";
  title.textContent = ph.label;

  planRow.appendChild(dot);
  planRow.appendChild(title);
  row.appendChild(planRow);

  row.addEventListener("click", () => {
    ctx.onPlaceholderOpen?.();
  });
  return row;
}

// THE SINGLE placeholder-visibility predicate (shared by renderSidebar AND applyFilterAndRender's
// `.filter-empty` branch so the two sites cannot drift): the live-run placeholder renders only
// while NO rendered record carries its tree_id — once the real row exists it takes over. EXPORTED
// for unit tests.
export function placeholderVisible(
  ph: { treeId: string } | null,
  records: PlanRecord[],
): boolean {
  return ph !== null && !records.some((r) => r.tree_id === ph.treeId);
}

// Render the full nested sidebar from pre-ordered records into `listEl`. `arrange_plans` groups
// each master's subs contiguously in depth-first dotted order; VISUAL depth is built here from
// `nn_path` prefixes with a prefix-keyed stack: a sub whose nn_path extends the top frame's
// nn_path by exactly one segment nests inside it; otherwise frames pop until its parent prefix
// matches. The stack carries SubTreeNodes (not DOM) so "internal" = actually-accumulated kids.
// EXPORTED so the DOM logic is unit-testable.
export function renderSidebar(listEl: HTMLElement, records: PlanRecord[], ctx: SidebarCtx): void {
  listEl.replaceChildren();

  // Live-run placeholder (Bug A fix): when the ctx carries one AND no rendered record has its
  // tree_id (the agent hasn't written its plan file yet, or list_plans lags the write), prepend
  // the `.plan.placeholder` row as the FIRST entry. Once the real row exists the placeholder is
  // omitted — the real row takes over.
  const ph = ctx.placeholder ?? null;
  const phShown = placeholderVisible(ph, records);
  if (ph && phShown) {
    listEl.appendChild(buildPlaceholderRow(ph, ctx));
  }

  // The open master's children container + its parse state; null between masters.
  let currentChildren: HTMLElement | null = null;
  let roots: SubTreeNode[] = [];
  // Prefix stack over the open master's subs. nnPath "" is the master-level base (never pops).
  let stack: { nnPath: string; kids: SubTreeNode[] }[] = [];

  // Flush the open master's parsed sub-tree into its `.children` container.
  const flush = (): void => {
    if (!currentChildren) return;
    for (const root of roots) {
      renderSubTree(root, currentChildren, ctx);
    }
    currentChildren = null;
    roots = [];
    stack = [];
  };

  for (const rec of records) {
    if (rec.flavor === "master" && (rec.child_count ?? 0) >= 1) {
      flush();
      const { wrapper, children } = buildMaster(rec, ctx);
      listEl.appendChild(wrapper);
      currentChildren = children;
      roots = [];
      stack = [{ nnPath: "", kids: roots }];
    } else if (rec.flavor === "sub") {
      // Trust the contract (a sub always follows its master), but be LOUD not silent: a sub with
      // no open children container is a backend contract violation — log it and append flat so
      // the sidebar still renders (a visible diagnostic, never a quiet re-classification).
      if (!currentChildren) {
        console.error("renderSidebar: orphan sub with no master container", rec.absolute_path);
        listEl.appendChild(buildFlatRow(rec, ctx));
        continue;
      }
      const nnPath = rec.nn_path ?? "";
      const parentPrefix = nnPath.split(".").slice(0, -1).join("."); // "" for depth-1 subs
      // Pop deeper/sibling frames until the top frame IS this sub's parent (base never pops).
      while (stack.length > 1 && stack[stack.length - 1].nnPath !== parentPrefix) {
        stack.pop();
      }

      const node: SubTreeNode = { rec, kids: [] };
      if (stack[stack.length - 1].nnPath === parentPrefix) {
        stack[stack.length - 1].kids.push(node);
        // Only a properly-parented sub opens a frame; extensions of an ORPHAN stay orphans too
        // (each contract-violating row is individually loud rather than quietly re-grouped).
        stack.push({ nnPath, kids: node.kids });
      } else {
        // Generalized loud orphan: the dotted parent prefix has no preceding row in this tree —
        // a backend contract violation (arrange_plans orders a parent before its extensions).
        // Render FLAT at the master's depth-1 level, never silently re-parent.
        console.error(
          "renderSidebar: orphan dotted sub — parent prefix has no preceding row",
          rec.absolute_path,
          nnPath,
        );
        roots.push(node);
      }
    } else {
      // standalone, or a 0-child master ⇒ flat row.
      flush();
      listEl.appendChild(buildFlatRow(rec, ctx));
    }
  }
  flush();

  // While a rendered placeholder is SELECTED it is THE single active row (the user has been
  // flipped to the Conversation tab to watch the run) — real rows cede `.active` even when one
  // matches ctx.openPath, so a run start can never paint two active rows (the placeholder AND
  // the still-open prior plan). Applies only while the placeholder is actually rendered: once
  // the real row supersedes it, ctx.openPath drives `.active` normally again.
  if (ph && phShown && ph.selected) {
    for (const el of Array.from(listEl.querySelectorAll<HTMLElement>(".plan.active[data-path]"))) {
      el.classList.remove("active");
    }
  }
}

// Session record of the user's collapse intent for trees toggled THIS session. Resolved as
// `collapseOverride.get(tree_id) ?? rec.collapsed` in `buildMaster`, so an in-flight refreshList
// reading a not-yet-persisted (stale) `collapsed` value cannot revert the user's toggle — the
// override wins until the backend converges; the empty map on restart cedes to the persisted value.
const collapseOverride = new Map<string, boolean>();

// Session-ONLY collapse state for INTERNAL sub nodes (keyed by subCollapseKey). Never persisted
// and never routed through set_tree_collapsed — restarting the app re-expands all internal nodes
// while masters keep their persisted collapse exactly as before.
const subCollapse = new Map<string, boolean>();

// Optimistic collapse toggle: record intent, toggle `.collapsed` on the master wrapper instantly
// for feedback, then fire-and-forget the persist (errors logged, non-fatal). No re-list.
function onToggleCollapse(treeId: string, next: boolean): void {
  collapseOverride.set(treeId, next);
  if (planListEl) {
    for (const wrapper of Array.from(planListEl.querySelectorAll<HTMLElement>(".master"))) {
      if (wrapper.dataset.treeId === treeId) {
        wrapper.classList.toggle("collapsed", next);
      }
    }
  }
  void invoke("set_tree_collapsed", { treeId, collapsed: next }).catch((e) =>
    console.error("set_tree_collapsed failed", e),
  );
}

// Re-fetch the list and re-render the sidebar (re-sort by recency / nesting happens in Rust).
async function refreshList(): Promise<void> {
  if (!planListEl) return;
  let records: PlanRecord[];
  try {
    records = await invoke<PlanRecord[]>("list_plans");
  } catch (e) {
    console.error("list_plans failed", e);
    records = [];
  }

  // Stash the full records array so the filter can re-render from memory (a late cwd patch
  // re-applies the filter without a fresh list_plans round-trip), then render through the
  // filter path. The filter + count are owned by applyFilterAndRender.
  lastRecords = records;
  applyFilterAndRender();

  // Stale-sentinel cleanup (Phase 4 DA Concern 1): if the OPEN row is a resume sentinel that no longer
  // appears in the fresh records (the tree finished elsewhere, or a real row replaced the synthetic
  // one via a NON-resume path), its placeholder pane + resume banner would otherwise stay painted over
  // a dangling openPath with no matching `.active` row. Reset to the empty state so nothing stale
  // remains. GUARD the happy resume→placeholder path: when the orchestrator has minted a live-run
  // placeholder for THIS tree (runPlaceholder.treeId matches), the placeholder legitimately stands in
  // for the vanished sentinel — leave openPath/banner alone (placeholderVisible keeps the row showing).
  if (openPath !== null && isResumeSentinel(openPath)) {
    const treeId = resumeSentinelTreeId(openPath);
    const stillListed = records.some((r) => r.absolute_path === openPath);
    const placeholderStandsIn = runPlaceholder !== null && runPlaceholder.treeId === treeId;
    if (!stillListed && !placeholderStandsIn) {
      resetToEmptyPane();
    }
  }

  // Resolve any still-unknown cwds off the main path, then late-patch the rows.
  void resolveMissingCwds(records);
}

// Reset the reading pane to the no-plan-open empty state: clear openPath (so no stale row derives
// `.active`), hide the doc header, drop any resume banner, and repaint the pane's "select a plan"
// note + clear the ToC. Idempotent. Used when the currently-open resume sentinel vanishes from the
// list without a placeholder taking over (see refreshList). `renderResumeBanner(null)` (not
// `refreshResumeBanner`) is used directly here — openPath is being cleared, so there is no record to
// re-derive a verdict from; the banner must simply hide.
function resetToEmptyPane(): void {
  openPath = null;
  renderResumeBanner(null);
  docHeaderEl?.classList.add("hidden");
  if (readingPaneEl) {
    readingPaneEl.classList.remove("raw");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select a plan from the sidebar to read it.";
    readingPaneEl.replaceChildren(empty);
  }
  tocListEl?.replaceChildren();
  // Repaint the sidebar so the now-cleared openPath drops the stale `.active` row.
  applyFilterAndRender();
  refreshReviewBar();
}

// Build the FRESH sidebar render context (openPath read live, never a stale closure — keeps
// `.active` correct across re-lists). Shared by the filter render path.
function makeSidebarCtx(): SidebarCtx {
  // The placeholder's `.active` derivation (computed LIVE each render): explicit user intent
  // (placeholderSelected) OR "the gate plan is open but its row is missing" — when a held gate's
  // plan IS the open plan, openPlan's [data-path] loop may have found no row to mark `.active`,
  // so the placeholder stands in as the active row (renderSidebar omits it once the row exists,
  // at which point that row carries `.active` via ctx.openPath instead).
  const gate = orchSnapshot?.pendingApproval ?? null;
  const standsInForOpenGatePlan = gate != null && openPath === asAbsPath(gate.planPath);
  return {
    openPath,
    collapseOverride,
    subCollapse,
    onOpen: (path, stem) => {
      // Opening any real plan from the sidebar deselects the placeholder. openPlan's selection
      // loop only touches [data-path] rows, so clear the placeholder's `.active` here directly.
      placeholderSelected = false;
      if (planListEl) {
        for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>(".plan.placeholder"))) {
          el.classList.remove("active");
        }
      }
      void openPlan(path, stem);
    },
    onToggleCollapse,
    placeholder: runPlaceholder
      ? {
          treeId: runPlaceholder.treeId,
          label: runPlaceholder.label,
          selected: placeholderSelected || standsInForOpenGatePlan,
        }
      : null,
    onPlaceholderOpen: () => {
      switchToConversationTab();
      placeholderSelected = true;
      applyFilterAndRender();
    },
  };
}

// Filter the in-memory records by the live query and render the PLANS TAB only (never the
// Contents/ToC tab — buildToc is not called here). Updates `#plan-count` to the "N of M" form
// while filtering (N = shown files, M = total files), or the plain "M file(s)" form when the
// query is empty. An empty result under a non-empty query shows the `.filter-empty` affordance.
// After rendering, matched substrings are highlighted in the visible `.plan-title` / `.plan-src`
// (a heading-only match still shows its row, un-highlighted). EXPORTED for unit tests.
export function applyFilterAndRender(): void {
  if (!planListEl) return;
  const total = lastRecords.length;
  const shown = filterRecords(lastRecords, filterQuery);

  if (shown.length === 0 && filterQuery.trim() !== "") {
    // Non-empty query with no matches ⇒ empty-state affordance (NOT an empty list).
    planListEl.replaceChildren();
    // The live-run placeholder is ALWAYS visible regardless of the filter query (it represents
    // live work, not a record the filter can match) — prepend it above the empty-state note.
    // SAME visibility predicate as renderSidebar (checked against the rendered records — here
    // the empty `shown` set, so a set placeholder always passes) so the two sites cannot drift.
    const ctx = makeSidebarCtx();
    const ph = ctx.placeholder ?? null;
    if (ph && placeholderVisible(ph, shown)) planListEl.appendChild(buildPlaceholderRow(ph, ctx));
    const empty = document.createElement("div");
    empty.className = "filter-empty";
    empty.textContent = "No matching plans";
    planListEl.appendChild(empty);
  } else {
    renderSidebar(planListEl, shown, makeSidebarCtx());
    highlightVisibleRows(filterQuery);
  }

  if (planCountEl) {
    planCountEl.textContent = planCountText(shown.length, total, filterQuery);
  }
}

// Re-wrap the matched substring in a `<mark>` across every rendered `.plan-title` / `.plan-src`
// in #plan-list, reading each element's current text. Re-applied on every filter render and
// after a late cwd patch, so highlights survive a cwd arriving after the initial render. An
// empty query clears any marks (highlightInto emits plain text).
function highlightVisibleRows(query: string): void {
  if (!planListEl) return;
  for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>(".plan-title, .plan-src"))) {
    highlightInto(el, el.textContent ?? "", query);
  }
}

// Find rows with no resolved cwd, ask the backend to resolve any stems we haven't already
// attempted this session (ONE call), then patch each affected row's `.plan-src` and the
// reader header. Rows stay EMPTY until this completes (no "unknown" flash). The selection,
// the attempted-stems guard, and the retry-on-thrown-error policy live in `src/resolve.ts`
// (unit-tested); a thrown error un-attempts the stems so the next plan-changed retries them.
async function resolveMissingCwds(records: PlanRecord[]): Promise<void> {
  const ran = await resolveCwds(
    records,
    cwdByStem,
    attemptedStems,
    (stems) => invoke<Record<string, string | null>>("resolve_cwds", { stems }),
    resolveAttemptCounts,
  );
  if (ran) patchAllCwds();
}

// Apply newly-resolved cwds after a `resolve_cwds` round-trip (or once the home dir arrives).
// Each record's `.plan-src` text is the DISPLAYED cwd (home-collapsed) which the filter both
// matches against and highlights, so we sync the resolved DISPLAY cwd back onto the in-memory
// records and re-run the filter render. This is what keeps a late-arriving cwd both MATCHABLE
// (the filter sees it) and HIGHLIGHTED (re-rendered through highlightVisibleRows) — satisfying
// "re-apply the filter after late cwd patches". Also refreshes the reader header for the open
// plan. Cheap; safe to call after any resolution (no-op render when there are no records).
function patchAllCwds(): void {
  // Sync the DISPLAYED cwd onto the in-memory records so the (pure, record-based) filter both
  // matches and highlights the SAME string the user sees. `planSrcText` already yields the
  // displayed value (home-collapsed path, "unknown", or "" while unresolved); store it only
  // when it is a real path so an unresolved/unknown row's `cwd` is not poisoned with a
  // non-path placeholder.
  for (const rec of lastRecords) {
    const display = planSrcText(rec);
    if (display && display !== "unknown") rec.cwd = display as PlanRecord["cwd"];
  }
  applyFilterAndRender();
  patchDocSrc();
}

// The `.plan-src` / `#doc-src` text for a stem from the resolved cache alone (empty until
// resolved; "unknown" once resolved-but-null; home-collapsed path once resolved).
function cwdDisplayForStem(stem: Stem): string {
  const s = cwdState(cwdByStem, stem);
  switch (s.state) {
    case "unresolved":
      return "";
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// Filename stem (no `.md`) from an absolute plan path. Mirrors the backend stem.
function stemFromPath(absPath: AbsPath): Stem {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1);
  return asStem(base.endsWith(".md") ? base.slice(0, -3) : base);
}

// Update the reader header `#doc-src` for the currently-open plan via the same resolved
// cache + late-patch path as the sidebar. Empty until resolved; includes the `.folder`
// accent element the existing markup/CSS expect.
function patchDocSrc(): void {
  if (!docSrcEl) return;
  if (openPath === null) {
    docSrcEl.replaceChildren();
    return;
  }
  // A synthetic resume-sentinel row is not in the resolve cache (its stem is the tree_id, never
  // resolved through resolve_cwds) — its cwd rides the record's `cwd` instead. Read it from there so
  // the reader header shows the tree's cwd, not an empty string.
  const text = isResumeSentinel(openPath)
    ? displayCwd(lastRecords.find((r) => r.absolute_path === openPath)?.cwd ?? "")
    : cwdDisplayForStem(stemFromPath(openPath));
  docSrcEl.replaceChildren();
  if (!text) return;
  const folder = document.createElement("span");
  folder.className = "folder";
  folder.textContent = "📁";
  docSrcEl.appendChild(folder);
  const label = document.createElement("span");
  label.textContent = text;
  docSrcEl.appendChild(label);
}

// ---- Tabbed left panel + table of contents (sidebar domain) ------------------------------
//
// The ToC is the ONE sanctioned reading-pane → sidebar data flow, mediated entirely by the
// render facade: `extractToc(readingPaneEl)` produces a plain `TocEntry[]` (read-only on the
// pane), and `buildToc` consumes that list to populate `#toc-list`. This module never queries
// or mutates `#reading-pane` directly — only via `extractToc` / `scrollToHeading`.

// Wire tab switching: a click on a `.tab` makes it (and the matching `.tab-pane`) the only
// active one. Toggling tabs is a pure view switch — it never rebuilds either pane's content.
// EXPORTED so the toggle wiring is unit-testable against the real code.
export function initTabs(tabRowEl: HTMLElement, paneEls: HTMLElement[]): void {
  const tabs = Array.from(tabRowEl.querySelectorAll<HTMLElement>(".tab"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const pane of paneEls) {
        pane.classList.toggle("active", pane.id === `tab-${target}`);
      }
    });
  }
}

// Render a ToC into `listEl` from a plain entry list. One `.toc-item.toc-h1|.toc-h2` per entry
// carrying `data-line`; a click smooth-scrolls the reader to that heading and flashes the
// clicked row only (transient affordance — NOT scroll-spy). An EMPTY list renders the
// `.toc-empty` "No headings" affordance (caller only passes [] when a plan IS open — the
// nothing-open state clears the list instead). MUST NOT touch any `.tab`/`.tab-pane` `.active`
// class: the active tab is preserved across both open and live reload (no auto-switch).
// EXPORTED so the DOM logic + click wiring are unit-testable.
export function buildToc(listEl: HTMLElement, entries: TocEntry[]): void {
  listEl.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = "No headings";
    listEl.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("a");
    item.className = `toc-item toc-h${entry.level}`;
    item.dataset.line = String(entry.line);
    item.textContent = entry.text;
    item.addEventListener("click", () => {
      if (readerScrollEl && readingPaneEl) {
        scrollToHeading(readerScrollEl, readingPaneEl, entry.line);
      }
      // Flash the clicked row only, then clear (transient click affordance, no scroll-spy).
      for (const el of Array.from(listEl.querySelectorAll(".toc-item.flash"))) {
        el.classList.remove("flash");
      }
      item.classList.add("flash");
      setTimeout(() => item.classList.remove("flash"), 600);
    });
    listEl.appendChild(item);
  }
}

// Rebuild the ToC from the current rendered pane. Called ONLY from inside the render-generation
// guarded region in openPlan/reloadOpenPlan (after the final isCurrent check passes) so a
// superseded render can never clobber a newer render's ToC. Never changes the active tab.
function rebuildTocFromPane(): void {
  if (!tocListEl || !readingPaneEl) return;
  buildToc(tocListEl, extractToc(readingPaneEl));
}

// Open a plan: read raw text into #reading-pane, mark the row active, update the header.
// EXPORTED for testing the render-generation guard around the ToC rebuild (no behavior change).
export async function openPlan(path: AbsPath, stem: Stem): Promise<void> {
  if (!readingPaneEl) return;

  // Navigation is FREE and never touches pendingReviews. "Viewing a review" is derived from
  // openPath (see currentReviewId), so simply opening a plan flips the bar to VIEWING (if this is a
  // reviewed plan's file) or SUMMARY (if a review is pending elsewhere) via the refreshReviewBar()
  // call at the end of this function — no teardown/auto-resurface logic.
  openPath = path;

  // Take a render generation: any later open/reload bumps the guard and supersedes this
  // render, so its post-await pane mutations are skipped (no stale content landing late).
  const gen = renderGuard.begin();

  // A synthetic resume-sentinel row has NO real file behind it: never route its path through the
  // plans channel (read_plan_contents / set_open_plan / mark_viewed all reject a sentinel — Rust
  // canonicalize fails on the scheme string). Detect once up front so every file-touching step below
  // is skipped for it; the reading pane gets a graceful placeholder + the resume banner still fires.
  const sentinel = isResumeSentinel(path);

  // Record the open plan so the backend holds it read by fiat (live-edits won't re-bold it). Skipped
  // for a sentinel (set_open_plan would reject — no file).
  if (!sentinel) {
    try {
      await invoke("set_open_plan", { path });
    } catch (e) {
      console.error("set_open_plan failed", e);
    }
  }

  // A newer open superseded us while set_open_plan was in flight — bail before mutating the
  // sidebar/header so a slow A-then-fast-B double click can't leave the header/active row on A
  // while the (correctly guarded) pane shows B. openPath is already set synchronously and the
  // newer call owns the header, so the stale call must do nothing here.
  if (!renderGuard.isCurrent(gen)) return;

  // Reflect .active selection in the sidebar without a full re-list, and locally clear the
  // unread marker on the just-opened row (it is read the moment it's opened).
  if (planListEl) {
    // While a rendered live-run placeholder holds `.active`, IT is the single active row — real
    // rows cede `.active` here too (mirrors renderSidebar's suppression so the two sites agree).
    // Sidebar clicks never hit this: ctx.onOpen strips the placeholder's selection before calling
    // openPlan. The unread clearing below is unconditional — opening a plan always reads it.
    const placeholderHoldsActive = planListEl.querySelector(".plan.placeholder.active") !== null;
    // Rows are no longer all direct children of #plan-list — subs live inside .master > .children.
    // Iterate every row by data-path so nested sub rows also get .active/.unread updated.
    for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>("[data-path]"))) {
      const isThis = el.dataset.path === path;
      el.classList.toggle("active", isThis && !placeholderHoldsActive);
      if (isThis) el.classList.remove("unread");
    }
  }

  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  // A sentinel's `stem` is the tree_id (display-incidental, not a filename) — show the tree's title
  // (from its synthetic record's `h1s`) instead of an ugly `<tree_id>.md`. Real rows keep `<stem>.md`.
  const sentinelRec = sentinel ? lastRecords.find((r) => r.absolute_path === path) ?? null : null;
  if (docFilenameEl) {
    docFilenameEl.textContent = sentinel
      ? sentinelRec?.h1s?.[0] ?? "Plan in progress"
      : `${stem}.md`;
  }
  // Late-patch the reader header cwd from the resolved cache (empty until resolved).
  patchDocSrc();

  if (sentinel) {
    // SENTINEL PANE: there is no plan `.md` to read — render a graceful placeholder INSIDE the
    // render-generation guard (so a fast switch to/from this row can't land stale content). Prefer
    // the tree's INTENT.md (the original request, written under `.plan-tree/`) when readable, else a
    // static "in progress" note. The resume banner (fired below) carries the actual forward action.
    let intent: string | null = null;
    const cwd = sentinelRec ? resolvedCwdFor(sentinelRec) : null;
    if (cwd !== null) {
      try {
        intent = await invoke<string | null>("read_plan_tree_file", { cwd, name: "INTENT.md" });
      } catch (e) {
        console.debug("openPlan: sentinel INTENT.md read failed", e);
        intent = null; // missing/IO-error ⇒ fall back to the static placeholder.
      }
    }
    // A newer open superseded us while reading INTENT.md — drop this stale render.
    if (!renderGuard.isCurrent(gen)) return;
    if (intent !== null && intent.trim() !== "") {
      readingPaneEl.classList.remove("raw");
      renderInto(readingPaneEl, intent, cwd ?? dirOf(path));
      readerScrollEl?.scrollTo({ top: 0 });
      await settle(readingPaneEl);
      if (!renderGuard.isCurrent(gen)) return;
      rebuildTocFromPane();
    } else {
      readingPaneEl.classList.remove("raw");
      renderInto(
        readingPaneEl,
        "_This plan is in progress. Use **Resume** above to continue it._",
        cwd ?? dirOf(path),
      );
      readerScrollEl?.scrollTo({ top: 0 });
      await settle(readingPaneEl);
      if (!renderGuard.isCurrent(gen)) return;
      rebuildTocFromPane();
    }
  } else {
    try {
      const text = await invoke<string>("read_plan_contents", { path });
      // A newer open/reload superseded us while reading — drop this stale render.
      if (!renderGuard.isCurrent(gen)) return;
      // Sub-Plan 02: render full-fidelity markdown into #reading-pane. New opens
      // start at the top.
      renderInto(readingPaneEl, text, dirOf(path));
      readerScrollEl?.scrollTo({ top: 0 });
      await settle(readingPaneEl);
      // settle() is async; a newer render may have begun while it ran. Bail so a late
      // settle from a superseded render does not touch the pane.
      if (!renderGuard.isCurrent(gen)) return;
      // Rebuild the ToC INSIDE the guarded region (this render won) so a superseded
      // render can never clobber it with stale entries. Does not change the active tab.
      rebuildTocFromPane();
      // Sub-Plan 02: re-apply persisted highlights. loadCommentsFor is cached per-path (a
      // cache-miss is the only real IPC window). The post-await isCurrent re-check is MANDATORY:
      // it mirrors every other awaited mutation here, so a fast A→B switch can't let A's late
      // load resolve and applyComments mutate B's pane.
      const recs = await loadCommentsFor(readingPaneEl, path);
      if (!renderGuard.isCurrent(gen)) return;
      applyComments(readingPaneEl, recs);
      // Cold-read the authoritative count for the just-opened plan.
      void refreshCommentCount();
    } catch (e) {
      console.error("read_plan_contents failed", e);
      if (!renderGuard.isCurrent(gen)) return;
      readingPaneEl.classList.add("raw");
      readingPaneEl.textContent = `Could not read plan: ${String(e)}`;
      // Read failed — clear the ToC so no stale entries point at headings that no
      // longer rendered. (Cleared, not "No headings": there is no valid ToC here.)
      tocListEl?.replaceChildren();
    }
  }

  // Persist the view: clears the unread state for this plan (backend stamps
  // viewed = max(now, mtime+1)). Belt-and-suspenders alongside the open-path fiat. Skipped for a
  // sentinel (mark_viewed would reject — no file).
  if (!sentinel) await markViewed(path);

  // openPath is now set + the plan rendered: refresh the bar so it flips to VIEWING (this plan is a
  // pending review's file) or SUMMARY (a review is pending on a different plan) or hides (none
  // pending). NOT guarded by renderGuard — the bar reflects pending-review state + openPath, not the
  // rendered pane content. refreshCommentCount (fired un-awaited above) will re-refresh the bar once
  // the authoritative count lands, so the VIEWING label shows the right comment count.
  refreshReviewBar();

  // Resume banner (Phase 5): re-evaluate on EVERY open. Orthogonal to refreshReviewBar — this reads
  // the open plan's `.plan-tree/state.json` and shows a Resume button (resumable phase) / blocked
  // message / nothing. Fire-and-forget (a read-only IPC); refreshResumeBanner guards against a fast
  // A→B switch painting the stale plan's banner. NEVER throws (detectResumable wraps everything).
  void refreshResumeBanner(path);

  // Conversation-history reconstruction (silent populate): replay this plan's PAST conversation into
  // the CONVERSATION tab without switching tabs — the user stays on PLAN; the reconstruction is ready
  // when they click over. Fire-and-forget like refreshResumeBanner. A NO-OP whenever a live session
  // or an orchestration owns the conversation pane (guarded inside loadHistoryForPlan), so it can
  // never disturb an in-progress run; supersession of a fast A→B switch is guarded via historyGen.
  // SKIPPED for a sentinel: its `stem` is the tree_id (NOT a transcript-resolvable filename stem), so
  // loadPlanHistory would fire a full read_plan_transcript corpus scan that always misses and paints a
  // misleading empty Conversation tab. The live run (if any) owns that pane via the orchestrator.
  if (!sentinel) loadPlanHistory?.(stem);
}

// Live-reload the currently-open plan, preserving the reading position with an
// element/source-line anchor that survives async render height changes. We
// capture the anchored block BEFORE re-render, apply the delta once after the
// synchronous text lands, then re-apply after settle() so mermaid/image height
// shifts don't drift the viewport.
// EXPORTED for testing the render-generation guard around the ToC rebuild (no behavior change).
export async function reloadOpenPlan(): Promise<void> {
  if (!readingPaneEl || !readerScrollEl || openPath === null) return;
  // A reviewed plan is now a REAL file, so a live edit to it reloads normally (Claude revising the
  // plan after a deny updates the file in place — the user sees the revision live).
  const path = openPath;
  // A synthetic resume sentinel has no file to reload (read_plan_contents would reject). Its pane is
  // a static placeholder painted in openPlan; a live `.plan-tree/state.json` edit re-surfaces via the
  // banner, not a pane reload. Bail before the read so no spurious "reload failed" is logged.
  if (isResumeSentinel(path)) return;
  // Take a render generation BEFORE the read: a newer open/reload supersedes us and our
  // post-await pane mutations (renderInto + the two applyDelta calls) are skipped, so an
  // older reload can never clobber a newer one.
  const gen = renderGuard.begin();
  const anchor = captureAnchor(readerScrollEl);
  try {
    const text = await invoke<string>("read_plan_contents", { path });
    // Superseded while reading — drop this stale reload entirely.
    if (!renderGuard.isCurrent(gen)) return;
    renderInto(readingPaneEl, text, dirOf(path));
    applyDelta(readerScrollEl, anchor);
    await settle(readingPaneEl);
    // settle() is async; bail so a superseded reload's second applyDelta never runs.
    if (!renderGuard.isCurrent(gen)) return;
    applyDelta(readerScrollEl, anchor);
    // Rebuild the ToC INSIDE the guarded region so a live edit that adds/removes a
    // heading updates the Contents tab in place. Never changes the active tab.
    rebuildTocFromPane();
    // Sub-Plan 02: on a live reload the cache for this path is invalidated and re-read from the
    // backend (loadCommentsFor re-invokes io.load), then highlights re-apply. The post-await
    // isCurrent re-check is MANDATORY (see openPlan) so a superseded reload never wraps
    // highlights into a newer plan's pane.
    const recs = await loadCommentsFor(readingPaneEl, path);
    if (!renderGuard.isCurrent(gen)) return;
    applyComments(readingPaneEl, recs);
    void refreshCommentCount();
  } catch (e) {
    console.error("reload failed (plan may have been removed)", e);
  }
}

// Filename stem from an absolute plan path (no `.md`). Reuses stemFromPath for the basename rule.
function stemFromBasename(absPath: string): Stem {
  return stemFromPath(asAbsPath(absPath));
}

// REFUSE-and-surface: a pending review whose REAL plan file cannot be opened (empty planFilePath, or
// openPlan threw — file missing / outside plans dir) is UN-ACTIONABLE. Faking a detached render here
// would leave openPath untouched, so currentReviewId() returns null → the bar falls to SUMMARY mode
// (Submit/Dismiss hidden; their handlers bail on the null guards) while the dead review is STILL
// counted ("N plans awaiting review") — a phantom that traps navigation but can never be acted on.
//
// An un-openable plan can never be reviewed, so we RELEASE the held producer with a DENY before
// dropping the review — leaving it held would hang the agent. The release is SOURCE-AWARE (delegated
// to resolveReview, which dispatches per source AND already drops the review + refreshes the bar):
//   • in-process — resolveReview denies via resolve_tool_permission(allow:false), freeing the SDK
//     canUseTool seam (mirrors the write_agent_plan-failure path in handleToolPermissionRequested,
//     which auto-denies the same way). There is NO terminal for an in-process review.
//   • external   — resolveReview denies via respond_to_review("deny"), freeing the terminal hook so
//     Claude stays in plan mode and can retry, instead of leaving it blocked until its ~570s timeout.
// resolveReview surfaces #hook-status only on failure; we set the source-appropriate refuse message
// AFTER it so our message wins on the success path, and we belt-and-suspenders the drop + refresh in
// case resolveReview short-circuited (e.g. the entry was already gone under the chained-event race).
async function refuseUnopenableReview(review: PendingReview): Promise<void> {
  console.error("plan review: the review's plan file could not be opened; refusing", review.reviewId);
  await resolveReview(review.reviewId, "deny", "Could not open the plan for review; aborting.");
  pendingReviews.delete(review.reviewId);
  refreshReviewBar();
  setHookStatus(
    hookStatusEl,
    review.source === "in-process"
      ? "Couldn't open the plan for review — asked the agent to re-plan."
      : "Couldn't open the plan for review — released the hook so Claude can re-plan.",
    "error",
  );
  setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
}

// Open a pending review's REAL plan file through the NORMAL plan-open flow (Option A). Refresh the
// sidebar list FIRST so the just-written plan's `[data-path]` row exists, then openPlan(...) — which
// selects that row, persists/loads its comments on its real path, and live-reloads. The bar then
// derives VIEWING from openPath. If planFilePath is empty or the open fails (file missing / outside
// plans dir) the review is REFUSED (refuseUnopenableReview) rather than rendered as an unactionable
// phantom. `review` MUST already be tracked in pendingReviews (the caller adds it).
async function openReviewPlanFile(review: PendingReview): Promise<void> {
  if (!review.planFilePath) {
    await refuseUnopenableReview(review);
    return;
  }
  // Refresh the sidebar so the just-written plan row exists before we select it. (openPlan applies
  // .active by data-path; the row must be present at/after open for the selection invariant to hold.)
  await refreshList();
  try {
    await openPlan(asAbsPath(review.planFilePath), stemFromBasename(review.planFilePath));
  } catch (e) {
    console.error("plan review: openPlan of the real file failed", e);
    await refuseUnopenableReview(review);
    return;
  }
  refreshReviewBar();
}

// Max age (ms) before a pending review is considered STALE: its blocking hook has already timed
// out, so its request file describes a dead review whose Submit/Dismiss would be a silent no-op.
// Stale entries are filtered out of launch recovery.
const STALE_REVIEW_MS = 600_000;

// Pick the NEWEST pending review (max createdMs). Tie-break MUST favor the LATER-INSERTED review on
// equal createdMs: two reviews can arrive within the same millisecond (createdMs falls back to
// Date.now()), and `pendingReviews` is a Map iterated in INSERTION order, so the last-inserted entry
// is the genuinely most-recent arrival. `>=` picks the later-inserted entry, making this deterministic.
function newestPendingReview(): PendingReview | null {
  let newest: PendingReview | null = null;
  for (const r of pendingReviews.values()) {
    if (newest === null || r.createdMs >= newest.createdMs) newest = r;
  }
  return newest;
}

// Resume the NEWEST pending review: open its real plan file through the normal flow (re-selecting its
// sidebar row), switching the bar to VIEWING mode. No-op if nothing is pending. The hook is untouched.
function resumeNewestReview(): void {
  const newest = newestPendingReview();
  if (newest === null) return;
  void openReviewPlanFile(newest);
}

// One serialized `plan-changed` handler body. Runs to completion before the next queued
// event begins (chained on `pending` in the listener) so refreshList/reloadOpenPlan from
// different events never interleave.
async function handlePlanChanged(changedPath: AbsPath): Promise<void> {
  // Keep the backend's notion of the open plan current (belt-and-suspenders; the open
  // plan is also held read by fiat backend-side). A synthetic resume sentinel has no real file —
  // set_open_plan would reject — so skip it (a sentinel's read-state is not tracked backend-side).
  if (openPath !== null && !isResumeSentinel(openPath)) {
    try {
      await invoke("set_open_plan", { path: openPath });
    } catch (e) {
      console.error("set_open_plan failed", e);
    }
  }

  // If the OPEN plan changed, stamp it viewed BEFORE re-listing so list_plans never
  // momentarily bolds it (in addition to the open-path fiat). A sentinel is never a real
  // `changedPath` (no file watched), so this branch never runs for one — guard regardless.
  if (openPath !== null && changedPath === openPath && !isResumeSentinel(openPath)) {
    await markViewed(openPath);
  }

  await refreshList();

  if (openPath !== null && changedPath === openPath) {
    await reloadOpenPlan();
  }
}

/**
 * Append `body` to a serialized promise chain and return the new tail. The `.catch` makes the
 * chain self-healing: if `body` rejects, it is logged and the returned promise still RESOLVES,
 * so the next event chained onto the tail still runs (a single failed handler can never wedge
 * the chain in a permanently-rejected state and silently drop all future events). Exported so
 * this self-healing property is unit-testable against the real code, not a copy of the pattern.
 */
export function chainHandler(
  pending: Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  return pending.then(body).catch((e) => console.error("plan-changed handler failed", e));
}

// ---- Plan Review status line (DEPENDENCY-FREE in-DOM UX) ----
//
// WHY THIS REPLACES window.alert: in Tauri v2 (Wry + WKWebView on macOS) JS dialogs have no UI
// delegate — window.alert() is a no-op, so an error alert would be invisible. The review-response
// and save-for-review paths surface success/error on an in-DOM transient status line (#hook-status)
// via setHookStatus() instead. The #review-clear button keeps its own two-click confirm — that is a
// separate, destructive comment-wipe action.

// How long the #review-clear two-click confirm stays "armed" before reverting (ms), and how long a
// status message lingers before auto-clearing (ms). Module constants so the test can reason about them.
const HOOK_CONFIRM_MS = 4000;
const HOOK_STATUS_MS = 6000;

// Set the in-DOM hook status line. `kind` selects success (accent) vs error (red); empty text
// clears + hides it. EXPORTED so the status surface is directly unit-testable.
export function setHookStatus(
  statusEl: HTMLElement | null,
  text: string,
  kind: "success" | "error" = "success",
): void {
  if (!statusEl) return;
  if (!text) {
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    statusEl.classList.remove("error");
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.toggle("error", kind === "error");
  statusEl.classList.remove("hidden");
}

window.addEventListener("DOMContentLoaded", () => {
  planListEl = document.querySelector("#plan-list");
  planCountEl = document.querySelector("#plan-count");
  readerScrollEl = document.querySelector("#reader-scroll");
  readingPaneEl = document.querySelector("#reading-pane");
  docHeaderEl = document.querySelector(".doc-header");
  docFilenameEl = document.querySelector("#doc-filename");
  docSrcEl = document.querySelector("#doc-src");
  tocListEl = document.querySelector("#toc-list");
  filterInputEl = document.querySelector("#plan-filter");
  filterClearEl = document.querySelector(".search .clear");
  searchEl = document.querySelector(".search");
  // Persistent, non-occluding review action bar (reading-pane header).
  reviewBarEl = document.querySelector("#review-bar");
  reviewBarLabelEl = document.querySelector("#review-bar-label");
  reviewSubmitEl = document.querySelector("#review-submit");
  reviewClearEl = document.querySelector("#review-clear");
  reviewResumeEl = document.querySelector("#review-resume");
  reviewApproveEl = document.querySelector("#review-approve");
  // PHASE 6 — forced-acceptance REFINE button + sub-plan picker (ACCEPTANCE mode only).
  reviewRefineEl = document.querySelector("#review-refine");
  reviewRefineTargetEl = document.querySelector("#review-refine-target");
  // PROTOTYPE-mode controls (Phase 4d): feedback textarea + open-in-browser button.
  prototypeFeedbackEl = document.querySelector("#prototype-feedback");
  prototypeOpenEl = document.querySelector("#prototype-open");
  // Working-reference checkbox (Phase 3): classifies the prototype approval (sketch vs floor).
  prototypeWorkingRefEl = document.querySelector("#prototype-working-ref");
  prototypeWorkingRefLabelEl = document.querySelector("#prototype-working-ref-label");
  // Capture the external Submit button's descriptive label so an in-process relabel can be reverted
  // exactly (refreshReviewBar restores this for external reviews).
  if (reviewSubmitEl?.textContent) REVIEW_SUBMIT_EXTERNAL_LABEL = reviewSubmitEl.textContent;
  // Capture #review-approve's default label so PROTOTYPE mode's relabel reverts exactly.
  if (reviewApproveEl?.textContent) REVIEW_APPROVE_DEFAULT_LABEL = reviewApproveEl.textContent;
  hookStatusEl = document.querySelector("#hook-status");

  // Resume banner (Phase 5): resolve its handles + wire the resume button. Orthogonal to the review
  // bar — both surfaces may show. The button reads `pendingResume` (set by renderResumeBanner) and
  // drives getOrchestrator().resume(). The toast element is the resume_fallback notice target.
  resumeBannerEl = document.querySelector("#resume-banner");
  resumeBannerMsgEl = document.querySelector("#resume-banner-msg");
  resumePlanBtnEl = document.querySelector("#resume-plan-btn");
  resumePlanBtnEl?.addEventListener("click", () => void resumeFromBanner());
  // PHASE 3c — the HAZARDOUS-resume inline confirm row (hazard text + Confirm/Cancel). The primary
  // button reveals it (resumeFromBanner) for a requiresConfirm verdict; Confirm fires resume()
  // (executeResume), Cancel collapses back to the one-click button (cancelResumeConfirm).
  resumeConfirmRowEl = document.querySelector("#resume-confirm");
  resumeHazardEl = document.querySelector("#resume-hazard");
  resumeConfirmBtnEl = document.querySelector("#resume-confirm-btn");
  resumeCancelBtnEl = document.querySelector("#resume-cancel-btn");
  resumeConfirmBtnEl?.addEventListener("click", () => void executeResume());
  resumeCancelBtnEl?.addEventListener("click", () => cancelResumeConfirm());
  toastEl = document.querySelector("#toast");

  // Wire the sidebar filter (Plans tab only). Typing re-renders the filtered Plans list from
  // the in-memory records (no IPC per keystroke); the ✕ button clears the query and re-renders.
  // The `.has-text` class on `.search` reveals the clear button (CSS) only when there is text.
  if (filterInputEl) {
    filterInputEl.addEventListener("input", () => {
      filterQuery = filterInputEl?.value ?? "";
      searchEl?.classList.toggle("has-text", filterQuery.trim().length > 0);
      applyFilterAndRender();
    });
  }
  if (filterClearEl) {
    filterClearEl.addEventListener("click", () => {
      filterQuery = "";
      if (filterInputEl) {
        filterInputEl.value = "";
        filterInputEl.focus();
      }
      searchEl?.classList.remove("has-text");
      applyFilterAndRender();
    });
  }

  // Wire the Plans/Contents tab switching. Default-active tab is Plans (set in index.html);
  // opening/reloading a plan rebuilds the ToC silently without changing the active tab.
  const tabRowEl = document.querySelector<HTMLElement>(".tab-row");
  const tabPlansEl = document.querySelector<HTMLElement>("#tab-plans");
  const tabContentsEl = document.querySelector<HTMLElement>("#tab-contents");
  if (tabRowEl && tabPlansEl && tabContentsEl) {
    initTabs(tabRowEl, [tabPlansEl, tabContentsEl]);
  }
  // Nothing-open initial state: #toc-list stays blank (NOT the "No headings"
  // affordance — that is reserved for an OPEN plan with zero headings).

  // ---- Sub-Plan 02: reading-pane [Plan | Conversation] tab row + conversation domain ----
  // The reader tab row is a SECOND .tab-row; we select it by its specific .reader-tab-row class
  // so this never grabs the sidebar's (first) .tab-row, and the sidebar contract TOKENS
  // (data-tab="plans"/id="tab-plans") are unaffected. initTabs is the same generic toggle.
  // Resolve the hoisted module-scope reading-pane tab handles (used by switchToConversationTab /
  // switchToPlanTab — main.ts owns this tab for the in-process review case).
  readerTabRowEl = document.querySelector<HTMLElement>(".reader-tab-row");
  tabPlanPaneEl = document.querySelector<HTMLElement>("#tab-plan");
  tabConversationEl = document.querySelector<HTMLElement>("#tab-conversation");
  if (readerTabRowEl && tabPlanPaneEl && tabConversationEl) {
    initTabs(readerTabRowEl, [tabPlanPaneEl, tabConversationEl]);
    // User-click path: initTabs (generic, also used by the sidebar) toggles .active but knows nothing
    // about the minimap. Hook the Conversation tab's own click so the minimap repaints whenever the
    // user reveals the pane. initTabs's click listener runs on the SAME event and has already added
    // .active synchronously; the rAF defers the repaint until layout settles after the display toggle.
    // Guarded on the handle (null until initConversation resolves); refreshMinimap no-ops without a
    // minimap element. (The programmatic switchToConversationTab path repaints separately.)
    const conversationTabBtn = readerTabRowEl.querySelector<HTMLElement>('.tab[data-tab="conversation"]');
    conversationTabBtn?.addEventListener("click", () => {
      requestAnimationFrame(() => conversationHandle?.refreshMinimap());
    });
  }

  // Initialize the conversation domain: subscribes the 5 agent events, drives stream->render,
  // owns cancel + teardown. main.ts only hands it DOM handles + a tab-switch callback. The
  // composer modal + status pill live entirely inside the domain. Disjoint from the sidebar +
  // src/render/* — this is the single convergence point.
  void initConversation(
    {
      stream: document.querySelector<HTMLElement>("#conversation-stream"),
      // Right-margin minimap gutter (sibling of #conversation-stream). The controller no-ops if null.
      minimap: document.querySelector<HTMLElement>("#conversation-minimap"),
      // Stop (full-stop) — kept under its legacy id #conversation-cancel.
      cancelBtn: document.querySelector<HTMLButtonElement>("#conversation-cancel"),
      stopBtn: document.querySelector<HTMLButtonElement>("#conversation-cancel"),
      // Pause (interrupt the turn only) / Resume (continue the idle session). The 3-state machine in
      // initConversation derives their enabled/disabled state purely from SessionState.
      pauseBtn: document.querySelector<HTMLButtonElement>("#conversation-pause"),
      resumeBtn: document.querySelector<HTMLButtonElement>("#conversation-resume"),
      // New-plan button — the conversation controller disables it while a session is live (Fix 4).
      newPlanBtn: document.querySelector<HTMLButtonElement>("#new-plan-btn"),
      // Free-text message composer (human-in-the-loop) — enabled while a session is live.
      messageInput: document.querySelector<HTMLTextAreaElement>("#conversation-input-field"),
      sendBtn: document.querySelector<HTMLButtonElement>("#conversation-send"),
      // Multimodal image input for the in-conversation follow-up surface.
      attachStrip: document.querySelector<HTMLElement>("#conversation-attachments"),
      attachBtn: document.querySelector<HTMLElement>("#conversation-attach"),
      fileInput: document.querySelector<HTMLInputElement>("#conversation-file-input"),
      attachError: document.querySelector<HTMLElement>("#conversation-attach-error"),
      composer: {
        modal: document.querySelector<HTMLElement>("#composer-modal"),
        request: document.querySelector<HTMLTextAreaElement>("#composer-request"),
        dirField: document.querySelector<HTMLInputElement>("#composer-dir"),
        chooseDirBtn: document.querySelector<HTMLButtonElement>("#composer-choose-dir"),
        // Build mode removed — the composer is plan-only; no #composer-mode toggle exists.
        modeToggle: null,
        startBtn: document.querySelector<HTMLButtonElement>("#composer-start"),
        cancelBtn: document.querySelector<HTMLButtonElement>("#composer-cancel"),
        // Start reads the paste-token field so a typed-but-unsaved token is honored, and surfaces
        // failures inline (never a silent no-op).
        tokenInput: document.querySelector<HTMLInputElement>("#composer-token"),
        error: document.querySelector<HTMLElement>("#composer-error"),
        // Multimodal image input — chip strip, attach button, and hidden file input. Attach-time
        // rejections reuse #composer-error (passed as errorEl when the attachments controller is built).
        attachStrip: document.querySelector<HTMLElement>("#composer-attachments"),
        attachBtn: document.querySelector<HTMLElement>("#composer-attach"),
        fileInput: document.querySelector<HTMLInputElement>("#composer-file-input"),
        // Auto-resume-after-quota select (Phase 6). The composer self-persists its value on change;
        // the chosen budget is read at Start by the orchestrator's defaultDeps adapter.
        autoResume: document.querySelector<HTMLSelectElement>("#composer-auto-resume"),
      },
      status: {
        pill: document.querySelector<HTMLElement>("#sdk-status"),
        authBlock: document.querySelector<HTMLElement>("#composer-auth"),
        tokenInput: document.querySelector<HTMLInputElement>("#composer-token"),
        tokenSubmit: document.querySelector<HTMLButtonElement>("#composer-token-submit"),
        // Shared inline error line — "Save token" failures surface here (same element the
        // composer's Start path uses).
        error: document.querySelector<HTMLElement>("#composer-error"),
      },
    },
    // onActivity (Bug B fix): every non-result stream frame fires this. While an approval gate is
    // held (snapshot.pendingApproval set), the flip is SUPPRESSED so streaming frames cannot steal
    // the tab from the Plan view the gate handler just opened. pendingClarify deliberately does NOT
    // suppress — AskUserQuestion cards render in the Conversation tab and need the flip.
    () => {
      if (suppressConversationFlip(orchSnapshot)) return;
      switchToConversationTab();
    },
  )
    .then((handle) => {
      conversationHandle = handle;
      // Expose the resolve-time clear to the module-level resolve paths (resolveReview + the
      // orchestrator gate handlers).
      notifyPermissionResolved = (toolUseId) => handle.notifyPermissionResolved(toolUseId);
      echoUserMessage = (text) => handle.echoUserMessage(text);
      // Expose the silent plan-history reconstruction to openPlan (module-level). Fire-and-forget.
      loadPlanHistory = (stem) => void handle.loadHistoryForPlan(stem);
      // Wire the titlebar "+ New plan" button to open the composer modal.
      const newPlanBtn = document.querySelector<HTMLElement>("#new-plan-btn");
      newPlanBtn?.addEventListener("click", () => handle.openComposer());
    })
    .catch((e) => console.error("initConversation failed", e));

  // ---- Sub-Plan 02: approval-gate controller (observer-driven) -------------------------------
  // Subscribe to the SHARED orchestrator instance (the same handle 03's composer-entry drives). We
  // hold the latest snapshot in `orchSnapshot` and drive the approval bar off it:
  //   • onAwaitingApproval(gate) — a sub-plan is awaiting approval: open its plan file via the NORMAL
  //     plan flow, flip to the Plan tab, and refresh the bar (mirrors openReviewPlanFile + switchToPlanTab).
  //   • onSnapshot — re-derive the bar after every transition (so it clears when pendingApproval
  //     becomes null after Approve).
  //   • onDone / onFatal — terminal: drop the snapshot and refresh (the bar hides).
  getOrchestrator().subscribe({
    onSnapshot: (snap) => {
      orchSnapshot = snap;
      // Idle-waiting hint: the visual-prototype gate is TURN-COMPLETION signaled (the intent turn
      // ends with a `result` → session idle → the facade hides its working indicator), so while
      // pendingPrototype is held, tell the conversation facade to keep showing "Waiting for your
      // input…" in the idle state. Derived STRICTLY from the snapshot, so it self-clears:
      // approve/refine null pendingPrototype in the reducer and the very next snapshot turns it off.
      // PHASE 5 — also keep the idle-waiting hint up while the forced acceptance gate is held (it is
      // turn-completion signaled like the prototype gate: the run is built and the session is idle,
      // so the facade must not read "done" while the user owes a verdict).
      conversationHandle?.setIdleWaitingHint(snap.pendingPrototype != null || snap.pendingAcceptance != null);
      // Live-run placeholder (Bug A fix): the FIRST snapshot of each run (keyed by treeId) mints a
      // placeholder sidebar row + selects it — the run has no real row until its plan file lands.
      if (
        isOrchestrationActive() &&
        snap.treeId &&
        !snap.done &&
        runPlaceholder?.treeId !== snap.treeId
      ) {
        runPlaceholder = { treeId: snap.treeId, label: "New plan — drafting…" };
        placeholderSelected = true;
        applyFilterAndRender();
      }
      refreshReviewBar();
    },
    onAwaitingApproval: (gate) => {
      // GEN-2 UNIFIED GATE: decomposition (root included) and leaf gates arrive through the SAME
      // observer hook carrying the SAME ApprovalGate2 shape — no master sentinel, no side-channel
      // path capture. Open the gate's plan file via the NORMAL plan flow; viewingGate() matches the
      // open plan against snapshot.pendingApproval.planPath.
      //
      // ORDER MATTERS (Bug B fix): flip to the Plan tab SYNCHRONOUSLY FIRST — before any await —
      // so the user sees the plan view the instant the gate arrives. While the awaits below run,
      // stream frames keep firing onActivity; suppressConversationFlip (keyed on pendingApproval,
      // already set in the snapshot by the time this observer hook fires) keeps them from stealing
      // the tab back. The tab is re-asserted after the awaits as a belt-and-suspenders.
      void (async () => {
        diag(`gate: onAwaitingApproval enter kind=${gate.kind} planPath=${gate.planPath}`);
        switchToPlanTab();
        // Refresh the sidebar FIRST so the just-written plan's [data-path] row exists before
        // openPlan applies `.active` by data-path (mirrors openReviewPlanFile). The placeholder
        // deliberately stays SELECTED through this render: clearing it before openPlan sets
        // openPath left a window where NO row was active (the placeholder ceded, but the gate
        // row couldn't take over yet).
        await refreshList();
        try {
          await openPlan(asAbsPath(gate.planPath), stemFromBasename(gate.planPath));
          // The gate plan is now open — ONLY now does the placeholder cede explicit selection:
          // the real row carries `.active` via openPath, or (row still missing) the placeholder
          // keeps standing in via the gate-standby derivation in makeSidebarCtx. If openPlan
          // threw, the placeholder stays selected — it remains the only truthful active row.
          placeholderSelected = false;
        } catch (e) {
          console.error("orchestrator gate: openPlan of the pointed-at plan failed", e);
        }
        switchToPlanTab();
        refreshReviewBar();
        diag("gate: onAwaitingApproval exit (Plan tab asserted)");
      })();
    },
    onPrototypeReview: (gate) => {
      // Visual-prototype gate (Phase 4d): flip to the Plan tab and render the preview DETACHED
      // into the reading pane (openPath untouched — the next openPlan replaces it), then derive
      // the bar's PROTOTYPE mode. The gate itself is NOT stashed here: the bar derives it from
      // orchSnapshot.pendingPrototype (activePrototypeGate), so it self-clears when a later
      // snapshot nulls pendingPrototype — this hook only owns the one-shot view flip + render.
      diag(`prototype: review gate kind=${gate.kind} round=${gate.round}`);
      switchToPlanTab();
      void renderPrototypePreview(gate);
      refreshReviewBar();
    },
    onAcceptanceReview: (gate) => {
      // PHASE 5 — the forced acceptance gate arrived: the run is built and the user must record a
      // verdict against the frozen baseline. The driver has already opened the baseline. Flip to the
      // Plan tab and derive the bar's ACCEPTANCE mode. Like the prototype gate, the gate is NOT
      // stashed here — the bar derives it from orchSnapshot.pendingAcceptance (activeAcceptanceGate),
      // so it self-clears when a later snapshot nulls pendingAcceptance (approve/diverge).
      diag(`acceptance: review gate cwd=${gate.cwd} openTarget=${gate.openTarget}`);
      switchToPlanTab();
      refreshReviewBar();
    },
    onDone: () => {
      orchSnapshot = null;
      // The run is over — no gate can be blocking on the user; drop the idle-waiting hint.
      conversationHandle?.setIdleWaitingHint(false);
      // Run finished: the placeholder's run is over (its real rows exist by now or never will).
      runPlaceholder = null;
      placeholderSelected = false;
      applyFilterAndRender();
      refreshReviewBar();
    },
    onFatal: () => {
      orchSnapshot = null;
      // Fatal teardown: no gate survives it — drop the idle-waiting hint (same as onDone).
      conversationHandle?.setIdleWaitingHint(false);
      // Fatal teardown: same placeholder clear as onDone.
      runPlaceholder = null;
      placeholderSelected = false;
      applyFilterAndRender();
      refreshReviewBar();
    },
  });

  // End the agent session on window unload so quitting never leaves an orphaned run.
  window.addEventListener("beforeunload", () => {
    void conversationHandle?.teardown();
  });

  // Wire the custom overlay titlebar for window drag + double-click-to-zoom.
  initTitlebar();
  // Wire the icon-only dark/light theme toggle in the titlebar-controls slot.
  initThemeToggle(document.querySelector("#theme-toggle"));
  // Wire the A−/A+ reading-pane text-size steppers (left of the theme toggle).
  initTextSize(
    document.querySelector("#text-dec"),
    document.querySelector("#text-inc"),
    document.documentElement,
    localStorage,
    readingPaneEl,
  );
  // Wire the header-bar model/effort preset picker (left of the text-size steppers).
  initModelPicker(document.querySelector(".titlebar-model-picker"));

  // Sub-Plan 02: wire the highlight/comment feature behind the render facade. main.ts only
  // hands the pane element + a LIVE openPath reader + the IO adapters to the facade — it never
  // reaches into #reading-pane for this feature. The facade fires onCommentCountChanged after a
  // save/clear mutation; main.ts refreshes the (backend-owned) count in response.
  if (readingPaneEl) {
    // Comments are ALWAYS the open plan's normal persisted comments now (Option A): a reviewed plan
    // is a real file, so its comments key off its real path and persist to comments.json like any
    // other plan. There is no synthetic review store. The IO is the plain backend invoke path.
    const commentsIo: CommentsIO = {
      load: (p) => invoke<CommentRecord[]>("get_comments", { path: p }),
      save: (p, c) => invoke<CommentRecord[]>("set_comments", { path: p, comments: c }),
      clearAll: (p) => invoke<CommentRecord[]>("clear_comments", { path: p }),
    };
    // The comment-path reader is simply the open plan's real path.
    initComments(readingPaneEl, () => openPath, commentsIo);
    // The facade hands us the MUTATED path + AUTHORITATIVE post-mutation count after an in-session
    // save/clear. Route to applyCommentCount (the Prompt-Feedback badge path, guarded to the open
    // plan), which also re-derives the #review-bar — so if the open plan IS a review, Submit enables
    // on the first comment.
    onCommentCountChanged((path, count) => {
      applyCommentCount(asAbsPath(path), count);
    });
  }

  // ---- Review action bar wiring (the persistent, non-occluding, resumable affordance) ----
  // Unconditional: the review bar is the sole surface for acting on a pending plan review now that
  // the old titlebar "Prompt Feedback" button + overlay are gone (commenting goes through the
  // conversation composer + this bar). The individual `reviewXEl?.addEventListener` guards keep it
  // safe when a given button is absent (e.g. under unit tests with a partial DOM).
  {
    //   Submit  → deny + the assembled feedback prompt for the VIEWED review → Claude revises.
    //   Approve → (in-process reviews only, #review-approve) allow the held plan + begin building.
    //   Resume  → re-open the NEWEST pending review (summary mode → viewing mode).
    reviewSubmitEl?.addEventListener("click", () => {
      // GEN-2 UNIFIED GATE: "Request changes" on the orchestrator's held gate — decomposition (root
      // included) OR leaf — routes into the ONE handle method requestChanges(pathKey, feedback). The
      // kind-routing (deny-resumes-the-decomposition-turn vs re-draft-the-leaf-in-place) lives in the
      // orchestrator's exhaustive gate.kind switch, NOT here. Build the feedback from the OPEN plan's
      // comments EXACTLY like the legacy in-process deny path, then clear them only on a successful
      // dispatch (they've been consumed into the feedback).
      const gate = viewingGate();
      if (gate) {
        if (reviewSubmitEl?.disabled || openPath === null) return; // disabled at 0 comments
        const planPath = openPath;
        void (async () => {
          let records: CommentRecord[] = [];
          try {
            records = await invoke<CommentRecord[]>("get_comments", { path: planPath });
          } catch (e) {
            console.error("get_comments failed", e);
          }
          try {
            await getOrchestrator().requestChanges(pathKey(gate.path), buildFeedbackPrompt(records));
            // The held ExitPlanMode was resolved (deny + feedback) — drop the waiting label NOW.
            notifyPermissionResolved?.(gate.toolUseId);
          } catch (e) {
            console.error("orchestrator gate: requestChanges failed", e);
            return;
          }
          // Dispatch succeeded — echo a STRUCTURED, human-readable view of the comments the user
          // submitted (one line per comment: anchor quote + comment text). NOT the wrapped
          // buildFeedbackPrompt output (that is system text). Only after the send succeeded.
          echoUserMessage?.(echoCommentsText(records));
          if (readingPaneEl) await clearAllComments(readingPaneEl, planPath);
        })();
        return;
      }
      // PROTOTYPE mode (Phase 4d): "Request changes" on the held visual-prototype gate requires
      // non-empty feedback (#prototype-feedback) and routes into refinePrototype(feedback) — the
      // driver loops the root back to clarifying-intent and sends the refine prompt. The textarea
      // clears AFTER a successful dispatch (the feedback was consumed into the prompt).
      const protoGate = activePrototypeGate();
      if (protoGate) {
        const feedback = prototypeFeedbackEl?.value.trim() ?? "";
        if (reviewSubmitEl?.disabled || feedback === "") return;
        void (async () => {
          try {
            await getOrchestrator().refinePrototype(feedback);
          } catch (e) {
            console.error("prototype gate: refinePrototype failed", e);
            return;
          }
          // Dispatch succeeded — echo the user's verbatim feedback as a bubble, THEN clear the
          // textarea. (On the failure path above we returned without echoing or clearing.)
          echoUserMessage?.(feedback);
          if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
          refreshReviewBar();
        })();
        return;
      }
      // ACCEPTANCE mode (Phase 5): "Accept divergence…" on the held acceptance gate requires a
      // non-empty REASON (#prototype-feedback, reused) and routes into divergeAcceptance(reason) —
      // the run finalizes (notifyDone) AND the reason is persisted as the audit trail for the waived
      // floor. The textarea clears AFTER a successful dispatch.
      const acceptGate = activeAcceptanceGate();
      if (acceptGate) {
        const reason = prototypeFeedbackEl?.value.trim() ?? "";
        if (reviewSubmitEl?.disabled || reason === "") return;
        void (async () => {
          try {
            await getOrchestrator().divergeAcceptance(reason);
          } catch (e) {
            console.error("acceptance gate: divergeAcceptance failed", e);
            return;
          }
          echoUserMessage?.(`Accepted divergence from the baseline: ${reason}`);
          if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
          switchToConversationTab();
          refreshReviewBar();
        })();
        return;
      }
      const reviewId = currentReviewId();
      if (reviewSubmitEl?.disabled || reviewId === null || openPath === null) return; // disabled at 0 comments
      // Assemble the reason from the OPEN plan's persisted comments (the same gathering the overlay
      // Copy uses), then deny. ORDER MATTERS: build the reason from the comments FIRST, send the deny,
      // and ONLY on success CLEAR the comments (they've been consumed into the feedback). The plan
      // stays open + selected; clearing wipes its persisted comments + in-pane highlights.
      const planPath = openPath;
      void (async () => {
        let records: CommentRecord[] = [];
        try {
          records = await invoke<CommentRecord[]>("get_comments", { path: planPath });
        } catch (e) {
          console.error("get_comments failed", e);
        }
        const sent = await resolveReview(reviewId, "deny", buildFeedbackPrompt(records));
        // Clear the submitted plan's comments only AFTER the deny landed (the feedback carried them).
        // facade clearAllComments removes highlights for planPath, clears the backend (clear_comments),
        // and fires onCommentCountChanged → the count + review bar refresh to zero. planPath is still
        // the open plan (we just submitted it), so its highlights visibly disappear.
        if (sent && readingPaneEl) {
          await clearAllComments(readingPaneEl, planPath);
        }
      })();
    });
    reviewResumeEl?.addEventListener("click", () => resumeNewestReview());

    // ---- #review-approve (in-process ONLY): single-click Approve & Build -----------------------
    // One click allows the held ExitPlanMode plan and begins execution (no confirm step). This is the
    // SOLE path that reaches resolve_tool_permission(allow). resolveReview (in-process allow) round-
    // trips the review's toolUseId, sets the session to acceptEdits, and flips to the Conversation tab.
    reviewApproveEl?.addEventListener("click", () => {
      // GEN-2 UNIFIED GATE: ONE Approve button, ONE handle method — approve(pathKey(gate.path)). The
      // dangerous routing (a decomposition approval arms the resuming hold + interrupts; a leaf
      // approval resolves + arms exec and never interrupts) lives in the orchestrator's exhaustive
      // gate.kind switch, NOT here. Flip to the Conversation tab so the next turn streams in place.
      const gate = viewingGate();
      if (gate) {
        void (async () => {
          try {
            await getOrchestrator().approve(pathKey(gate.path));
            // The held ExitPlanMode was resolved — drop the waiting-for-input label NOW (the
            // orchestrator's next frames lag the click).
            notifyPermissionResolved?.(gate.toolUseId);
            switchToConversationTab();
          } catch (e) {
            console.error("orchestrator gate: approve failed", e);
          }
        })();
        return;
      }
      // PROTOTYPE mode (Phase 4d): approve the held visual prototype — always enabled ("Approve
      // visual"; "Proceed as-is" from round 3). approvePrototype() composes + writes INTENT.md and
      // continues into recon; the next snapshot (pendingPrototype nulled) reverts the bar. Flip to
      // the Conversation tab so the recon turn streams in place (mirrors the approval-gate flow).
      // The prototype gate resolves by TURN COMPLETION (no held tool → no notifyPermissionResolved).
      const protoGate = activePrototypeGate();
      if (protoGate) {
        // ADAPTIVE approve: with non-empty feedback typed, this is the COMBINED apply-and-approve —
        // refinePrototype(feedback, { autoApprove: true }) loops the prototype back to apply the
        // feedback, then the driver auto-advances to recon WITHOUT another review round. With an
        // empty textarea it is the plain approvePrototype() (straight to recon, no echo).
        const feedback = prototypeFeedbackEl?.value.trim() ?? "";
        // WORKING-REFERENCE classification (Phase 3): read the checkbox ONLY on the plain-approve
        // branch. With feedback typed (combined apply-and-approve) the prototype is still being
        // refined — it is not yet the final artifact — so the floor classification does not apply
        // there; the user re-checks it on the round they actually approve as-is.
        const asWorkingReference = prototypeWorkingRefEl?.checked === true;
        void (async () => {
          try {
            if (feedback !== "") {
              await getOrchestrator().refinePrototype(feedback, { autoApprove: true });
              // Dispatch succeeded — echo the verbatim feedback as a bubble, THEN clear the textarea
              // (mirrors the Request-changes success-only ordering; on the failure path below we
              // returned without echoing or clearing).
              echoUserMessage?.(feedback);
              if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
              refreshReviewBar();
            } else {
              await getOrchestrator().approvePrototype({ asWorkingReference });
              // Reset the checkbox so a later prototype gate (a fresh run) opens unchecked.
              if (prototypeWorkingRefEl) prototypeWorkingRefEl.checked = false;
            }
            switchToConversationTab();
          } catch (e) {
            console.error("prototype gate: apply-and-approve failed", e);
          }
        })();
        return;
      }
      // ACCEPTANCE mode (Phase 5): the Approve button is "Accept (meets baseline)" → approveAcceptance().
      // The build clears the baseline floor; the deferred finalize runs (notifyDone) and the next
      // snapshot (pendingAcceptance nulled) reverts the bar. The verdict resolves the gate by an
      // explicit action — no held tool to clear.
      const acceptGate = activeAcceptanceGate();
      if (acceptGate) {
        void (async () => {
          try {
            await getOrchestrator().approveAcceptance();
            switchToConversationTab();
          } catch (e) {
            console.error("acceptance gate: approve failed", e);
          }
        })();
        return;
      }
      const reviewId = currentReviewId();
      if (reviewId === null) return;
      void resolveReview(reviewId, "allow", "");
    });

    // ---- #prototype-feedback / #prototype-open (PROTOTYPE mode only — Phase 4d) ---------------
    // Typing re-derives the bar so "Request changes" enables on the first non-whitespace character
    // (and re-disables when cleared). Cheap: refreshReviewBar is a pure DOM re-derivation.
    prototypeFeedbackEl?.addEventListener("input", () => refreshReviewBar());
    // Open the HTML prototype in the default browser: the gate's index.html path when present,
    // else its first path (pure prototypeOpenTarget; paths may be relative — the open_prototype
    // Rust command resolves them against the gate's cwd and containment-guards the result).
    prototypeOpenEl?.addEventListener("click", () => {
      // ACCEPTANCE mode (Phase 5): the relabeled "Open baseline" button → open_baseline (the gate's
      // openTarget relative to <cwd>/.plan-tree/baseline/, containment-guarded Rust-side). Checked
      // FIRST so it wins while the acceptance gate is held (the prototype gate cannot co-exist).
      const acceptGate = activeAcceptanceGate();
      if (acceptGate) {
        const target = acceptGate.openTarget ?? "index.html";
        void invoke("open_baseline", { cwd: acceptGate.cwd, path: target }).catch((e) => {
          console.error("open_baseline failed", e);
          setHookStatus(hookStatusEl, `Could not open baseline: ${String(e)}`, "error");
          setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
        });
        return;
      }
      const gate = activePrototypeGate();
      if (!gate) return;
      const target = prototypeOpenTarget(gate);
      if (target === null) return;
      void invoke("open_prototype", { cwd: gate.cwd, path: target }).catch((e) => {
        console.error("open_prototype failed", e);
        setHookStatus(hookStatusEl, `Could not open prototype: ${String(e)}`, "error");
        setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
      });
    });

    // ---- #review-refine (ACCEPTANCE mode only — Phase 6): re-plan the picked sub-plan -----------
    // The THIRD acceptance action. Reads the picked target from #review-refine-target and routes it
    // into refineAcceptance(parsePathKey(target)) — the driver resets that sub-plan + its
    // right-siblings and re-runs them (the acceptance gate re-arms on re-completion). Flip to the
    // Conversation tab so the re-run streams in place; the next snapshot (pendingAcceptance nulled)
    // reverts the bar out of ACCEPTANCE mode while the re-execution runs.
    reviewRefineEl?.addEventListener("click", () => {
      const acceptGate = activeAcceptanceGate();
      if (!acceptGate) return;
      const value = reviewRefineTargetEl?.value ?? "";
      if (value === "") return; // no sub-plan picked (empty picker)
      let target;
      try {
        target = parsePathKey(value);
      } catch (e) {
        console.error("acceptance gate: invalid refine target pathKey", value, e);
        return;
      }
      void (async () => {
        try {
          await getOrchestrator().refineAcceptance(target);
        } catch (e) {
          console.error("acceptance gate: refineAcceptance failed", e);
          return;
        }
        echoUserMessage?.(`Refining sub-plan ${value} (resetting it and its right-siblings to re-run)`);
        switchToConversationTab();
        refreshReviewBar();
      })();
    });

    // ---- #review-clear: discoverable MANUAL clear during review (two-click confirm) ----
    // The bar offers a "Clear comments" button (visible in viewing mode with >=1 comment). It uses
    // the SAME dependency-free two-click "click again to confirm" pattern as the hook-setup buttons
    // (window.confirm is inert in this WebView): clearAllComments(pane, openPath) removes the plan's
    // highlights, clears the backend, and fires onCommentCountChanged → the bar refreshes (the button
    // hides at 0). Single click only ARMS (no clear); the second click clears.
    if (reviewClearEl) {
      const clearLabel = reviewClearEl.textContent ?? "Clear comments";
      let armed = false;
      let revertTimer: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        armed = false;
        reviewClearEl?.classList.remove("confirming");
        if (reviewClearEl) reviewClearEl.textContent = clearLabel;
        if (revertTimer !== null) {
          clearTimeout(revertTimer);
          revertTimer = null;
        }
      };
      // Expose disarm so refreshReviewBar can cancel a pending confirm when the button hides.
      reviewClearDisarm = disarm;
      reviewClearEl.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          reviewClearEl?.classList.add("confirming");
          if (reviewClearEl) reviewClearEl.textContent = "Click again to confirm";
          revertTimer = setTimeout(disarm, HOOK_CONFIRM_MS);
          return;
        }
        disarm();
        if (readingPaneEl && openPath !== null) {
          void clearAllComments(readingPaneEl, openPath);
        }
      });
    }
  }

  // The titlebar Install/Remove plan-review hook buttons were removed (the app drives Claude
  // in-process). The install_hook/uninstall_hook/hook_status Tauri commands remain backend-only.

  if (docHeaderEl) docHeaderEl.classList.add("hidden"); // hide until a plan is opened
  if (readingPaneEl) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select a plan from the sidebar to read it.";
    readingPaneEl.appendChild(empty);
  }

  // Fetch the home dir once (for `~/…` collapse). On success, re-patch any already-rendered
  // rows so a list that resolved before the home dir arrived still collapses.
  void homeDir()
    .then((h) => {
      homePath = h.endsWith("/") ? h.slice(0, -1) : h;
      patchAllCwds();
    })
    .catch((e) => console.error("homeDir failed (cwd shown verbatim)", e));

  void refreshList();

  // Live file-watch: re-list always; live-reload the open plan if it changed.
  // Serialize handler bodies on a single promise chain so a burst of `plan-changed`
  // events runs one-at-a-time (no interleaved refreshList/reloadOpenPlan); the
  // render-generation guard then ensures only the latest reload mutates the pane.
  let pending: Promise<void> = Promise.resolve();
  void listen<PlanChanged>("plan-changed", (event) => {
    const changedPath = asAbsPath(event.payload.path);
    // chainHandler appends this event's body to the serialized chain with a .catch backstop,
    // so a single failed handler can't wedge the chain rejected and drop ALL future events.
    pending = chainHandler(pending, () => handlePlanChanged(changedPath));
  });

  // ---- Phase 6 — Plan Review event listeners (mirror plan-changed's serialized chain) ----
  // Review events are serialized on their OWN chain (separate from plan-changed) so a request and
  // a cancel can't interleave their async open/refresh. chainHandler's .catch backstop keeps
  // a single failed handler from wedging the chain.
  let reviewPending: Promise<void> = Promise.resolve();

  // A new review request arrived (a new blocking hook). ALWAYS track it in pendingReviews (so it is
  // resumable and counted), then decide whether to YANK the pane to it:
  //   • If NO review is currently being viewed (currentReviewId() === null — the user is browsing a
  //     non-reviewed plan or nothing), focus the window and OPEN THE REAL plan file via the normal
  //     flow (selecting its sidebar row). Falls back to a detached planText render if that fails.
  //   • If a review is ALREADY being viewed, do NOT yank — just refresh the bar (the count rises;
  //     the user can finish the current one then Resume the rest).
  async function handleReviewRequested(payload: ReviewRequested): Promise<void> {
    // The event payload may not carry createdMs — stamp arrival time as a stable fallback so newest
    // resolution still works.
    const createdMs = (payload as { created_ms?: number }).created_ms ?? Date.now();
    const review: PendingReview = {
      reviewId: payload.review_id,
      planFilePath: payload.plan_file_path,
      planText: payload.plan_text,
      createdMs,
      source: "external",
    };
    pendingReviews.set(payload.review_id, review);

    if (currentReviewId() === null) {
      try {
        await invoke("focus_main_window");
      } catch (e) {
        console.error("focus_main_window failed", e);
      }
      // Open the REAL plan file through the normal flow (selects the sidebar row). openReviewPlanFile
      // refreshes the list first and falls back to a detached render if the open fails.
      await openReviewPlanFile(review);
      return;
    }
    // A review is already being viewed — do not yank. The bar's count goes up via summary/viewing.
    refreshReviewBar();
  }

  // A pending request was cancelled (hook gave up / timed out / removed its request). Drop it from
  // pendingReviews. The open plan stays open — only the bar changes (drops to summary/hidden if this
  // was the reviewed plan).
  function handleReviewCancelled(payload: ReviewCancelled): void {
    pendingReviews.delete(payload.review_id);
    refreshReviewBar();
  }

  void listen<ReviewRequested>("plan-review-requested", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, () => handleReviewRequested(payload));
  });
  void listen<ReviewCancelled>("plan-review-cancelled", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, async () => handleReviewCancelled(payload));
  });

  // ---- Sub-Plan 03 — in-process plan-review intercept (the Agent SDK canUseTool seam) ----------
  // The SDK emits `tool-permission-requested` when the in-app session wants to use a tool. This app
  // is a PLAN REVIEWER: it intercepts ExitPlanMode (the plan emission), materializes the plan as a
  // REAL file, registers an in-process pending review, and OPENS it through the normal plan flow on
  // the Plan tab — then HOLDS. The held request is NEVER resolved here: the only path to
  // resolve_tool_permission(allow) is the user clicking #review-approve. This hold is identical for
  // subagent plans (agent_id != null) — agentId is captured for diagnostics, never branched on.
  //
  // For any OTHER tool reaching the seam, AUTO-ALLOW so the seam never hangs (liveness) AND the session
  // is not flooded with "request blocked" errors during plan mode. Returning allow here does NOT defeat
  // plan mode: per the installed Agent SDK, plan mode enforces read-only at the CLI level regardless of
  // canUseTool, and the ONLY path that switches to acceptEdits is the post-approval
  // set_agent_permission_mode("acceptEdits") in resolveReview (the #review-approve click). This handler
  // writes NO plan and registers NO review for non-ExitPlanMode tools.
  //
  // Serialized on the SAME reviewPending chain as the external review events so a held ExitPlanMode and
  // an external review/cancel can't interleave their async open/refresh.
  async function handleToolPermissionRequested(payload: ToolPermissionRequested): Promise<void> {
    // Seam ownership (Sub-Plan 03): when a multiplan orchestration is active, IT is the sole resolver
    // of the interactive ExitPlanMode seam (it holds/redrafts/approves each sub-plan's plan via its
    // own ledger). The legacy single-shot review path below must NOT also write the plan / register a
    // pendingReview, or the seam would be double-owned. Early-return — no behavior change when no
    // orchestration is active.
    //
    // SUBSUMPTION (Sub-Plan 03): the composer now ALWAYS starts a run through getOrchestrator().start()
    // (src/conversation/index.ts), so EVERY composer-initiated plan mode session has an active
    // orchestration — the degenerate single-sub-plan ("single" sizer outcome) collapses the legacy
    // single-shot review into the orchestration's own per-sub gate. As a result the in-process
    // pendingReview minting below is unreachable from the composer flow: this early-return fires first.
    // It is retained ONLY as defensive in-process handling for a future bare-session entry point (a
    // session started WITHOUT an orchestration); it must stay gated behind this guard so two in-process
    // review entry points can NEVER coexist. External file-IPC reviews (the ExitPlanMode hook from other
    // Claude Code sessions) are untouched — they ride list_pending_reviews / respond_to_review, not this
    // seam.
    if (isOrchestrationActive()) return;

    if (payload.tool !== "ExitPlanMode") {
      // DEAD BRANCH (defensive no-op): the sidecar now AUTO-ALLOWS every non-ExitPlanMode tool
      // synchronously in-process (sidecar/index.ts canUseTool) and never emits a
      // tool-permission-requested event for them — eliminating the per-tool frontend round-trip
      // (and its "Stream closed" race) entirely. So this branch should never fire. If it ever does
      // (an older sidecar), log it and do nothing: there is no pending entry to resolve here, and
      // re-resolving a non-existent id would only log "unknown permission id" on the sidecar.
      console.warn(
        "tool-permission-requested for a non-ExitPlanMode tool — ignored (sidecar auto-allows these):",
        payload.tool,
      );
      return;
    }

    // ExitPlanMode: materialize the plan markdown as a REAL file under ~/.claude/plans/, then open it
    // via the normal plan flow. input is { plan: <markdown> } (no path) per the frozen contract.
    const planMarkdown =
      (payload.input as { plan?: unknown } | null | undefined)?.plan;
    const planText = typeof planMarkdown === "string" ? planMarkdown : "";

    let writtenPath: string;
    try {
      // Backend write_agent_plan returns the absolute path it wrote (frontmatter-tagged, atomic,
      // containment-guarded). tree_id / nn are left undefined for now (the backend seeds a fresh
      // tree_id); re-plan versioning is settled with the backend during live smoke.
      writtenPath = await invoke<string>("write_agent_plan", { plan: planText });
    } catch (e) {
      console.error("write_agent_plan failed", e);
      // Without a real file we cannot open + review it. Faking a pending review here (empty
      // planFilePath) would hang the seam: currentReviewId() returns null for it, so the bar falls
      // into summary mode, #review-approve stays hidden, and both the approve + submit handlers bail
      // on the null guards — the held canUseTool promise would never resolve. Instead AUTO-DENY so
      // the agent gets feedback and can retry/report, then release without registering any review.
      try {
        await invoke("resolve_tool_permission", {
          id: payload.id,
          allow: false,
          message: "Could not save the plan for review; aborting.",
        });
      } catch (e2) {
        console.error("resolve_tool_permission (write_agent_plan fallback) failed", e2);
      }
      setHookStatus(hookStatusEl, `Could not save the plan for review: ${String(e)}`, "error");
      setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
      return;
    }

    // Register the in-process pending review keyed by the SDK toolUseId (= payload.id). The hold IS
    // this registration — resolve_tool_permission is NEVER called here.
    const review: PendingReview = {
      reviewId: payload.id,
      planFilePath: writtenPath,
      planText,
      createdMs: Date.now(),
      source: "in-process",
      toolUseId: payload.id,
      agentId: payload.agent_id,
    };
    pendingReviews.set(payload.id, review);

    // If a review is already being viewed, don't yank focus (mirror handleReviewRequested): just
    // refresh the bar (the new plan still appears as a sidebar row via the watcher / refreshList).
    if (currentReviewId() !== null) {
      refreshReviewBar();
      return;
    }

    // Open the REAL plan file through the normal flow (selects its sidebar row, loads/persists comments
    // on its real path, live-reloads), then OWN the tab: flip to Plan + focus the window.
    await openReviewPlanFile(review);
    switchToPlanTab();
    try {
      await invoke("focus_main_window");
    } catch (e) {
      console.error("focus_main_window failed", e);
    }
    refreshReviewBar();
  }

  void listen<ToolPermissionRequested>("tool-permission-requested", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, () => handleToolPermissionRequested(payload));
  });

  // ---- Sub-Plan 03 — lifecycle purge of in-process reviews -------------------------------------
  // On agent-exit / fatal agent-error / user cancel the SDK seam is dead, so any held in-process review
  // must be purged (an Approve after the session died must be impossible). The conversation facade owns
  // its OWN listeners for these events (stream rendering); these are SEPARATE listeners purely for the
  // review-state purge. agent-error purges only when fatal (a non-fatal error keeps the seam alive).
  void listen<AgentExit>("agent-exit", () => {
    // PHASE 6 (DA-I5) — QUOTA-PAUSE RECONCILIATION. A quota wall makes the sidecar gracefulExit(0), so
    // this agent-exit can be a QUOTA PAUSE exit, not a genuine end-of-run. During a pause the run is
    // NOT over — the orchestrator will respawn a session and re-issue the interrupted turn (which may
    // be mid-ExitPlanMode review). So this listener must NOT destructively tear that state down:
    //   • SKIP purgeInprocReviews() — a held in-process ExitPlanMode review must survive the pause so
    //     the resumed turn can still resolve it. (purgeInprocReviews exists to drop reviews whose SDK
    //     seam is permanently dead; during a pause the seam is coming back.)
    //   • SKIP the live-run placeholder clear — the placeholder belongs to the still-paused run.
    // Quota-paused is detected via the orchestrator's quotaPaused() probe, which is SYNCHRONOUSLY
    // correct (DA-I5): the conversation facade's agent-stream listener calls the handle's
    // markQuotaPausePending() the instant a quota_exceeded frame is seen, so quotaPaused() is true
    // from that tick onward — through the microtask-deferred QUOTA_PAUSED dispatch and the auto-resume
    // — NOT only after the deferred dispatch drains. This closes the same-tick race where a
    // quota_exceeded frame and an agent-exit arrive in the SAME tick: without the pending flag,
    // quotaPaused() would still read false here and we would destructively purgeInprocReviews() during
    // a pause, dropping a held in-process ExitPlanMode review the resumed turn still needs.
    // shouldClearPlaceholderOnExit ALREADY no-ops while the active orchestration's treeId matches the
    // placeholder's, but we gate explicitly so the intent is unambiguous and the purge is skipped too.
    if (isOrchestrationActive() && getOrchestrator().quotaPaused()) return;
    purgeInprocReviews();
    // Live-run placeholder clear (Bug A fix) — the SAFE variant. agent-exit reports an SDK SESSION
    // ending, which is NOT 1:1 with the placeholder's run: notifyDone deregisters the orchestrator
    // BEFORE onDone fires. notifyDone now ends the SDK session on natural completion, so the exit is
    // prompt (it follows onDone closely) rather than arbitrarily late. The clear decision still lives
    // in the pure shouldClearPlaceholderOnExit because that logic stays defensively correct
    // regardless of exit timing — a slow drain could still, rarely, overlap a fast next start (which
    // has minted its own placeholder). See its truth table + tests:
    // clear ONLY a placeholder no ACTIVE orchestration claims.
    if (
      shouldClearPlaceholderOnExit(
        runPlaceholder,
        isOrchestrationActive(),
        orchSnapshot?.treeId ?? null,
      )
    ) {
      runPlaceholder = null;
      placeholderSelected = false;
      applyFilterAndRender();
    }
  });
  void listen<AgentError>("agent-error", (event) => {
    if (event.payload?.fatal) purgeInprocReviews();
  });

  // ---- Phase 5 — resume_fallback toast ---------------------------------------------------------
  // The sidecar emits a non-fatal `resume_fallback` agent-stream frame when a requested SDK resume
  // could not rehydrate the prior transcript (missing/expired) and it ran the current step FRESH
  // instead. Surface a non-blocking toast so the user knows history was dropped. This is a SEPARATE
  // agent-stream subscriber from the conversation facade's (which renders the live stream) — it does
  // NOT touch session/tab state. Other agent-stream kinds are ignored here.
  void listen<AgentStream>("agent-stream", (event) => {
    if (event.payload?.kind === "resume_fallback") {
      showToast("Couldn't resume the previous conversation — re-running the current step fresh.");
    }
  });
  // User cancel (the conversation facade fires cancel_agent_run on #conversation-cancel). interrupt()
  // may not surface as agent-exit, so purge here too — a cancelled session must not leave a held
  // in-process review whose Approve resolves a dead seam. Defensive; the facade still owns the invoke.
  document.querySelector<HTMLElement>("#conversation-cancel")?.addEventListener("click", () => {
    purgeInprocReviews();
    // Defense-in-depth: onDone/onFatal null orchSnapshot, but a user full-stop may not reach
    // either (cancel_agent_run tears the seam down out-of-band). A stale snapshot would keep a
    // dead gate driving the bar / the flip suppression / the agent-exit treeId comparison, so
    // drop it here too and re-derive the bar.
    orchSnapshot = null;
    // Same defense for the idle-waiting hint: a full-stop kills any pending prototype gate, so the
    // facade must not keep showing "Waiting for your input…" against a dead run.
    conversationHandle?.setIdleWaitingHint(false);
    refreshReviewBar();
  });

  // ---- Phase 6 — launch recovery ----
  // On startup, if reviews are already pending (the app launched while a hook is blocking), populate
  // pendingReviews with all non-stale entries and open the NEWEST one's real plan file via the normal
  // flow (no focus — the user just launched). console.warn if more than one is pending. Chained so it
  // serializes ahead of any live request that arrives during startup.
  reviewPending = chainHandler(reviewPending, async () => {
    let reviews: ReviewRequest[] = [];
    try {
      reviews = await invoke<ReviewRequest[]>("list_pending_reviews");
    } catch (e) {
      console.error("list_pending_reviews failed", e);
      return;
    }
    // Drop STALE entries (hook already timed out — its Submit/Dismiss would be a silent no-op).
    const now = Date.now();
    const fresh = reviews.filter((r) => now - r.created_ms < STALE_REVIEW_MS);
    if (fresh.length === 0) return;
    if (fresh.length > 1) {
      console.warn(`launch recovery: ${fresh.length} pending reviews; auto-showing the newest`);
    }
    // Track every non-stale pending review so all are resumable + counted.
    for (const r of fresh) {
      pendingReviews.set(r.review_id, {
        reviewId: r.review_id,
        planFilePath: r.plan_file_path,
        planText: r.plan_text,
        createdMs: r.created_ms,
        source: "external",
      });
    }
    if (currentReviewId() !== null) {
      // A live request already opened a reviewed plan during startup — leave it; just refresh.
      refreshReviewBar();
      return;
    }
    // Open the newest pending review's real plan file (newestPendingReview honors the >= tie-break).
    const newest = newestPendingReview();
    if (newest !== null) await openReviewPlanFile(newest);
  });
});
