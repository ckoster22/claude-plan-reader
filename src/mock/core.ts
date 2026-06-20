// Mock shim for "@tauri-apps/api/core".
//
// Re-implements `invoke(cmd, args?)` against the in-memory store (state.ts) + fixtures, so the
// UNMODIFIED app runs with zero real Tauri/sidecar calls. Every command the app's `invoke(...)`
// call sites use (derived by grepping `invoke[<(]` across src/) is enumerated in the `MockCommand`
// discriminated union below.
//
// WHAT THE UNION DOES AND DOES NOT CATCH (corrected — the earlier note overstated this): `tsc` does
// NOT link the app's UNTYPED `invoke(cmd, args)` call sites (cmd is a plain string) to MockCommand,
// so a renamed or reshaped command is NOT a compile error here. The union only documents the handled
// command surface and its arg shapes, and feeds HANDLED_COMMANDS below (the value the Phase-5
// registry canary diffs against the grepped call sites). Command-name / arg drift is caught by that
// registry canary at test time, NOT by the compiler. (`tsc --noEmit` over src/mock/** DOES catch
// render-data drift in the typed AgentStream fixtures — a different gate.)
//
// Two tiers (see the plan):
//   • BOOT-CRITICAL — must return a SHAPED value (never undefined where the caller dereferences).
//   • FIRE-AND-FORGET — resolve as a no-op.
// An UNKNOWN command warns + returns a benign default (never throws).

import type { PlanRecord, CommentRecord, ReviewRequest } from "../types";
import {
  getPlans,
  getMarkdown,
  setMarkdown,
  getPendingReviews,
  getAuth,
  getActiveScene,
  clearAnswers,
  recordAnswers,
  getCommentCount,
} from "./state";
import { TINY_PNG_DATA_URL, ERROR_PLAN_PATH } from "./fixtures/markdown";
import { stripFrontmatter } from "./fixtures/nested";
import type { AgentAuthStatus, AskUserQuestionAnswers, AgentStream } from "../conversation/types";
import { SCENES } from "./fixtures/scenes";
import { playSceneFrames, clearAgentBuffers } from "./player";
import { emitMockEvent } from "./event";
import { transcriptFor, type PlanTranscriptResult } from "./fixtures/transcripts";
import { MOCK_REVIEW } from "./fixtures/reviews";
import {
  SENTINEL_CWD,
  SENTINEL_INTENT_MD,
  sentinelStateJson,
} from "./fixtures/sentinel";

// One-time boot log so Phase 5 can confirm the alias actually applied (a real @tauri-apps module
// would never print this). Runs on first import of this shim — which only happens if the alias
// took effect.
console.log("[mock] Tauri IPC aliased to src/mock");

// ---- MockCommand: the union of every command name + its args the app invokes ----
//
// Grouped by tier for readability. Args mirror the real call sites' shapes. `void`-result commands
// are the fire-and-forget tier; the others return shaped values.
type MockCommand =
  // ---- boot-critical (shaped returns) ----
  | { cmd: "list_plans"; args?: undefined }
  | { cmd: "agent_auth_status"; args?: undefined }
  | { cmd: "resolve_cwds"; args: { stems: string[] } }
  | { cmd: "list_pending_reviews"; args?: undefined }
  | { cmd: "get_comments"; args: { path: string } }
  | { cmd: "get_comment_count"; args: { path: string } }
  | { cmd: "read_plan_contents"; args: { path: string } }
  | { cmd: "read_image_as_data_url"; args: { path: string } }
  | { cmd: "read_plan_tree_file"; args: { cwd: string; name: string } }
  | {
      cmd: "read_plan_transcript";
      args: { stem: string };
    }
  // The backend command that returns a pending review's plan text by id. Not invoked by the current
  // frontend (the review opens the real plan file via read_plan_contents), but the backend exposes it
  // and the brief asks the mock to cover it — seeded from the review fixture.
  | { cmd: "read_review_plan"; args: { reviewId: string } }
  // ---- comment mutations (shaped returns) ----
  | { cmd: "set_comments"; args: { path: string; comments: CommentRecord[] } }
  | { cmd: "clear_comments"; args: { path: string } }
  // ---- fire-and-forget (no-op) ----
  | { cmd: "set_open_plan"; args: { path: string } }
  | { cmd: "mark_viewed"; args: { path: string } }
  | { cmd: "set_tree_collapsed"; args: { treeId: string; collapsed: boolean } }
  | { cmd: "focus_main_window"; args?: undefined }
  | { cmd: "diag_log"; args: { msg: string } }
  | { cmd: "respond_to_review"; args: { reviewId: string; decision: string; reason: string | null } }
  | { cmd: "open_baseline"; args: { cwd: string; path: string } }
  | { cmd: "open_prototype"; args: { cwd: string; path: string } }
  | { cmd: "set_agent_oauth_token"; args: { token: string } }
  | { cmd: "hook_status"; args?: undefined }
  // ---- agent / orchestrator commands — Phase 2 drives these through scene playback ----
  // start_agent_session / send_agent_message / resolve_tool_permission etc. replay canned
  // AgentStream frames via emitMockEvent (see the dispatch cases below).
  | { cmd: "start_agent_session"; args: { cwd: string; permissionMode: string } }
  | {
      cmd: "send_agent_message";
      args: { text: string; images?: { media_type: string; data: string }[] };
    }
  | { cmd: "set_agent_permission_mode"; args: { mode: string } }
  | {
      cmd: "resolve_tool_permission";
      args: { id: string; allow: boolean; message: string | null; updatedInput?: unknown };
    }
  | { cmd: "cancel_agent_run"; args?: undefined }
  | { cmd: "end_agent_session"; args?: undefined }
  | { cmd: "write_agent_plan"; args: { plan: string; treeId?: string; nn?: string } }
  | { cmd: "write_plan_tree_file"; args: { cwd: string; name: string; contents: string } }
  | { cmd: "delete_plan_tree_file"; args: { cwd: string; name: string } }
  | { cmd: "reset_plan_tree_dir"; args: { cwd: string } }
  | { cmd: "ensure_prototype_dir"; args: { cwd: string } }
  | { cmd: "ensure_baseline_dir"; args: { cwd: string } }
  | { cmd: "freeze_baseline"; args: { cwd: string } };

// The exhaustive set of command names this mock HANDLES. Exported (and asserted in Phase 5's
// registry canary) so a new real call site without a mock handler is caught. Derived from the
// union above by listing each `cmd` literal exactly once.
export const HANDLED_COMMANDS = [
  // boot-critical
  "list_plans",
  "agent_auth_status",
  "resolve_cwds",
  "list_pending_reviews",
  "get_comments",
  "get_comment_count",
  "read_plan_contents",
  "read_image_as_data_url",
  "read_plan_tree_file",
  "read_plan_transcript",
  "read_review_plan",
  // comment mutations
  "set_comments",
  "clear_comments",
  // fire-and-forget
  "set_open_plan",
  "mark_viewed",
  "set_tree_collapsed",
  "focus_main_window",
  "diag_log",
  "respond_to_review",
  "open_baseline",
  "open_prototype",
  "set_agent_oauth_token",
  "hook_status",
  // agent / orchestrator
  "start_agent_session",
  "send_agent_message",
  "set_agent_permission_mode",
  "resolve_tool_permission",
  "cancel_agent_run",
  "end_agent_session",
  "write_agent_plan",
  "write_plan_tree_file",
  "delete_plan_tree_file",
  "reset_plan_tree_dir",
  "ensure_prototype_dir",
  "ensure_baseline_dir",
  "freeze_baseline",
] as const satisfies readonly MockCommand["cmd"][];

// A Set form for O(1) membership checks (used by the canary + the runtime dispatch guard).
export const HANDLED_COMMAND_SET: ReadonlySet<string> = new Set(HANDLED_COMMANDS);

// ---- scene playback (agent-command tier) ----
//
// start_agent_session / playScene both route here: stage the active scene fresh. clearAnswers()
// drops any prior scene's recorded answers; playSceneFrames() clears the agent event buffers FIRST
// (scene-scoping — so a switched-to scene never replays the prior scene's frames to a later
// subscriber) and then emits the scene's frames. `delayMs` 0 = instant final state.
let cancelActivePlayback: (() => void) | null = null;

function playActiveScene(delayMs = 0): void {
  // Stop any in-flight delayed playback so a restart never interleaves the old scene's tail.
  cancelActivePlayback?.();
  clearAnswers();
  const builder = SCENES[getActiveScene()];
  cancelActivePlayback = playSceneFrames(builder(delayMs), delayMs);
}

// A monotonic synthetic seq for follow-up frames the mock emits OUTSIDE a scene builder (e.g. the
// user echo on send_agent_message, the assistant reply after a question is answered). Starts high so
// these always sort AFTER a scene's frames; the model still orders by seq so interleaving is correct.
let followupSeq = 2_000_000;

function emitStream(frame: AgentStream): void {
  emitMockEvent("agent-stream", frame);
}

// ---- invoke ----
//
// The runtime entry point. `cmd` is a string (call sites are untyped); `args` is unknown. We narrow
// per command inside the switch. Returns `Promise<T>` to match the real API's generic signature.
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return dispatch(cmd, args) as Promise<T>;
}

// Dispatch returns the raw (untyped) result; invoke casts to the caller's T. Split out so the
// switch can return concrete shapes without fighting the generic.
async function dispatch(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    // ---- boot-critical ----
    case "list_plans":
      return getPlans() satisfies PlanRecord[];

    case "agent_auth_status":
      return getAuth() satisfies AgentAuthStatus;

    case "resolve_cwds": {
      // The sidebar passes the stems it wants resolved; return a path|null per requested stem. We
      // derive each stem's cwd from the matching plan record (or null = "unknown").
      const stems = (args?.stems as string[] | undefined) ?? [];
      const byStem = new Map(getPlans().map((p) => [String(p.filename_stem), p.cwd]));
      const out: Record<string, string | null> = {};
      for (const stem of stems) out[stem] = byStem.get(stem) ?? null;
      return out;
    }

    case "list_pending_reviews":
      return getPendingReviews() satisfies ReviewRequest[];

    case "get_comments":
      // Return N synthetic comment records so `get_comments`/`get_comment_count` agree (the
      // Review-bar "comment count" knob sets N). Each record is a minimal, wire-valid CommentRecord;
      // the bar only ever consumes their COUNT (VIEWING enables Submit at >= 1 comment).
      return Array.from({ length: getCommentCount() }, (_v, i) => ({
        quote: `mock comment ${i + 1}`,
        block_line: null,
        block_end_line: null,
        occurrence: 0,
        comment: `Synthetic review comment ${i + 1}.`,
        id: i + 1,
      })) satisfies CommentRecord[];

    case "get_comment_count":
      // The cold-read path main.ts runs on open/reload — return the knob-set count so the VIEWING
      // bar's comment count + Submit-enabled state reflect it.
      return getCommentCount();

    case "read_plan_contents": {
      const path = String(args?.path ?? "");
      // Phase 3 raw-error fallback: the sentinel path REJECTS so openPlan's catch sets
      // #reading-pane.raw. The real backend rejects when a file is missing / outside the plans dir.
      if (path === ERROR_PLAN_PATH) {
        throw new Error("simulated read failure (mock error-fallback plan)");
      }
      // Mirror the real backend's read_plan_contents: strip a leading YAML frontmatter block so the
      // reading pane never renders it. Frontmatter-less fixtures pass through unchanged (no-op).
      return stripFrontmatter(getMarkdown(path));
    }

    case "read_image_as_data_url":
      // A real 1x1 PNG data URL so the reading pane's async image pass sets a valid <img src>.
      return TINY_PNG_DATA_URL;

    case "read_plan_tree_file": {
      // The synthetic-sentinel tree is the ONLY tree with a `.plan-tree/` the mock models: its cwd
      // serves a schema-2 state.json (so detectResumable yields a resumable resend → the resume
      // banner) and an INTENT.md (so the sentinel placeholder pane renders the original request). Any
      // other tree / file → null (the backend's "file absent" answer), unchanged from before.
      const cwd = String(args?.cwd ?? "");
      const name = String(args?.name ?? "");
      if (cwd === SENTINEL_CWD) {
        if (name === "state.json") return sentinelStateJson();
        if (name === "INTENT.md") return SENTINEL_INTENT_MD;
      }
      return null;
    }

    case "read_plan_transcript":
      // Phase 3 history replay: return a canned transcript for the designated history stem, found-but-
      // empty for the no-content stem, and found:false for everything else (the no-transcript empty
      // state). The conversation controller feeds `lines` through the REAL parseTranscript path.
      return transcriptFor(String(args?.stem ?? "")) satisfies PlanTranscriptResult;

    case "read_review_plan":
      // The backend returns a pending review's plan text by id. Seed it from the review fixture so the
      // command is covered (the current frontend opens the real file instead, but the brief asks for it).
      return MOCK_REVIEW.plan_text;

    // ---- comment mutations: echo back the would-be persisted set ----
    case "set_comments":
      return ((args?.comments as CommentRecord[] | undefined) ?? []) satisfies CommentRecord[];

    case "clear_comments":
      return [] satisfies CommentRecord[];

    // ---- fire-and-forget: resolve as no-ops ----
    case "set_open_plan":
    case "mark_viewed":
    case "set_tree_collapsed":
    case "focus_main_window":
    case "diag_log":
    case "respond_to_review":
    case "open_baseline":
    case "open_prototype":
    case "set_agent_oauth_token":
      return undefined;

    case "hook_status":
      // The app expects a boolean; report "not installed".
      return false;

    // FINDING 6: write_agent_plan must round-trip its plan text. The live in-process review flow
    // (main.ts handleToolPermissionRequested) calls write_agent_plan({ plan: input.plan }) and then
    // opens the RETURNED path via read_plan_contents — so the Plan tab must show THAT text, not the
    // fallback. We register the plan text at a deterministic written path under the plans dir and
    // return that path, so the subsequent read_plan_contents(writtenPath) serves the exact plan.
    case "write_agent_plan": {
      const plan = String(args?.plan ?? "");
      const writtenPath = "/Users/mock/.claude/plans/in-process-review.md";
      setMarkdown(writtenPath, plan);
      return writtenPath;
    }

    // ---- other write paths: return a canned path (the real API returns the written file's path) ----
    case "write_plan_tree_file":
    case "ensure_prototype_dir":
    case "ensure_baseline_dir":
    case "freeze_baseline":
      return "/Users/mock/.plan-tree/mock-path";

    // ---- agent / orchestrator: drive scene playback through the event bus (Phase 2) ----

    case "start_agent_session":
      // A run begins: replay the ACTIVE scene's canned frames so the real ConversationModel +
      // renderTree produce the live conversation UI. No real agent, no tokens. (Note: the live app's
      // orchestrator usually starts the session itself and sends the first prompt; the mock just
      // replays the staged scene on any start so the visual states appear.)
      playActiveScene();
      return undefined;

    case "send_agent_message": {
      // A follow-up user turn. Echo the user's text as a user bubble (the app ALSO echoes its own
      // free-text sends, so to avoid a double bubble we do NOT echo here for the free-text composer
      // path — but Resume's "Continue." goes through here too). Then emit a short assistant reply so
      // the conversation visibly advances. Both at high follow-up seqs so they sort after the scene.
      const text = String(args?.text ?? "");
      // Multimodal: surface the attached-image count so a `npm run mock` send exercises the image
      // path token-free (the real send forwards `images: [{media_type, data}]` when ≥1 is attached).
      const imageCount = Array.isArray(args?.images) ? args!.images!.length : 0;
      const imageNote = imageCount > 0 ? ` [+${imageCount} image${imageCount === 1 ? "" : "s"}]` : "";
      emitStream({
        seq: followupSeq++,
        kind: "assistant_text",
        text:
          text === "Continue."
            ? "Continuing…"
            : `You said: "${text}"${imageNote}. Here is a follow-up reply.`,
        parent_tool_use_id: null,
      });
      emitStream({
        seq: followupSeq++,
        kind: "result",
        subtype: "success",
        is_error: false,
        result: "Run complete.",
        num_turns: 1,
        duration_ms: 100,
        total_cost_usd: 0,
        session_id: "mock-session",
      });
      return undefined;
    }

    case "resolve_tool_permission": {
      // The user answered a held interactive permission (AskUserQuestion card / ExitPlanMode review).
      // Record the answers so a follow-up frame / test can read them back, then emit a short
      // assistant reply + result so the conversation advances past the resolved hold.
      const id = String(args?.id ?? "");
      const updated = args?.updatedInput as { answers?: AskUserQuestionAnswers } | undefined;
      if (updated?.answers) recordAnswers(id, updated.answers);
      emitStream({
        seq: followupSeq++,
        kind: "assistant_text",
        text: "Thanks — proceeding with your selection.",
        parent_tool_use_id: null,
      });
      emitStream({
        seq: followupSeq++,
        kind: "result",
        subtype: "success",
        is_error: false,
        result: "Run complete.",
        num_turns: 1,
        duration_ms: 100,
        total_cost_usd: 0,
        session_id: "mock-session",
      });
      return undefined;
    }

    case "set_agent_permission_mode": {
      // The Build toggle / mode switch. Emit a mode_change frame so the mode chip updates.
      const mode = String(args?.mode ?? "plan");
      emitStream({ seq: followupSeq++, kind: "mode_change", mode });
      return undefined;
    }

    case "cancel_agent_run":
      // Cancel/Pause interrupts the current turn. Emit a deliberate-interrupt result so the muted
      // ".conv-result-interrupted" row appears (the calm "Turn interrupted — continuing" state).
      cancelActivePlayback?.();
      emitStream({
        seq: followupSeq++,
        kind: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        num_turns: 1,
        duration_ms: 100,
        total_cost_usd: 0,
        session_id: "mock-session",
        deliberateInterrupt: true,
      });
      return undefined;

    case "end_agent_session":
      // The session is torn down. Stop any in-flight playback and emit agent-exit so the controller
      // returns to the "none" state. Clear the buffers so a re-init does not replay this scene.
      cancelActivePlayback?.();
      emitMockEvent("agent-exit", { code: 0 });
      clearAgentBuffers();
      return undefined;

    case "delete_plan_tree_file":
    case "reset_plan_tree_dir":
      return undefined;

    // ---- unknown ----
    default:
      console.warn("[mock] unhandled invoke:", cmd, args);
      return undefined;
  }
}
