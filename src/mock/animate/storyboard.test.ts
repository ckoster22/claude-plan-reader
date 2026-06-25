// Mock-ANIMATE storyboard tests — the PURE storyboard logic + the TRAILHEAD_BEAT fixture, driven
// through the REAL ConversationModel + renderTree (the same production code the live app uses).
//
// Falsifiable properties (each asserts an invariant of applyUpToTime, NOT current line-counts):
//   1. DETERMINISM — applyUpToTime at the same T twice ⇒ identical derived STRUCTURE (compared by a
//      (type,seq)+payload projection, never by node.id which is content-addressed).
//   2. NO DOUBLE-ACCUMULATION — apply at T=duration, then apply AGAIN at the same T ⇒ node count
//      unchanged (the reset() inside applyUpToTime is load-bearing; without it frames double).
//   3. MONOTONIC — count(T1) ≤ count(T2) for T1 < T2 (frames only ever appear as time advances).
//   4. NO STUCK TOOL (RECURSIVE) — at T=duration no top-level OR subagent-nested node has tool status
//      "running" (leaf tool_use+tool_result pairs share a tMs = atomic; the spanning Task tool's OWN
//      tool_result lands at the group's end, flipping it done — without it the Task row stays running).
//   5. LIVE DOM — renderTree(container, model.derive()) yields real .conv-text AND .conv-tool nodes.
//   6. FINISHED THOUGHT — working is non-null mid-run but null at T=duration (the terminal `result`
//      frame ends the turn, so the beat lands as a completed thought, not a perpetual "Working…").
//
// The TRAILHEAD_BEAT is a two-chapter beat ("Clarify" → "Scope recon"): a user kickoff, a streaming
// reply, an AskUserQuestion card answered with a free-text "Other" value (folded onto the card AND
// echoed as a user bubble), then a labeled `scope-recon` subagent group running four leaf tools, the
// Task's own deferred result, a wrap-up, and the terminal `result`.

import { describe, it, expect, beforeEach } from "vitest";

import { ConversationModel } from "../../conversation/stream";
import { renderTree } from "../../conversation/render";
import {
  applyUpToTime,
  storyDurationMs,
  modelSignature,
  projectSurfaceState,
  projectPulseSet,
  projectCursorState,
  projectFieldText,
  projectModalState,
  projectScroll,
  projectSidebarTab,
  SCROLL_TARGET,
  C4_SHIFT,
  C4_SCROLL_DOWN_FROM,
  C4_SCROLL_DOWN_TO,
  C4_SCROLL_UP_FROM,
  C4_SCROLL_UP_TO,
  C4_CONTENTS_TAB_SWITCH_MS,
  C4_PLANS_TAB_SWITCH_MS,
  C4_TOC_LOW_SELECTOR,
  C4_TOC_CONTEXT_SELECTOR,
  C4_CONTENTS_TAB_SELECTOR,
  C4_PLANS_TAB_SELECTOR,
  TRAILHEAD_BEAT,
  TRAILHEAD_COMMENT_1,
  TRAILHEAD_COMMENT_2,
  TRAILHEAD_COMMENT_3,
  TERMINAL_MS,
  TERMINAL_SEQ,
  EXEC_SHIFT,
  PROTO_ACT_SHIFT,
  CLARIFIER_SHIFT,
  PROTO_NARR_MS,
  PROTO_OPEN_MS,
  PROTO_CARD1_PULSE_FROM,
  PROTO_FEEDBACK_TYPE_FROM,
  PROTO_FEEDBACK_TYPE_TO,
  PROTO_ROUND2_MS,
  PROTO_CARD2_PULSE_FROM,
  PROTO_CLOSE_MS,
  PROTO_FEEDBACK_MS,
  PROTO_ACK_MS,
  // (P5 #1/#3/#10) pacing/cursor-travel constants — the field→button moves + dwell pulses.
  B1_REQUEST_DWELL_MS,
  B1_START_MOVE_MS,
  B1_START_MOVE_DUR,
  B1_START_PULSE_FROM,
  B1_START_PULSE_TO,
  B1_START_CLICK_MS,
  B2_ANSWER_DWELL_MS,
  B2_SUBMIT_MOVE_MS,
  B2_SUBMIT_MOVE_DUR,
  B2_SUBMIT_PULSE_FROM,
  B2_SUBMIT_PULSE_TO,
  B2_SUBMIT_CLICK_MS,
  PROTO_APPROVE_PULSE_FROM,
  PROTO_APPROVE_PULSE_TO,
  PROTO_APPROVE_ORIGIN_MS,
  PROTO_APPROVE_MOVE_MS,
  PROTO_APPROVE_MOVE_DUR,
  PROTO_APPROVE_CLICK_MS,
  B1_COMPOSER_OPEN_MS,
  B1_REQUEST_TYPE_FROM,
  B1_REQUEST_TYPE_TO,
  B1_COMPOSER_CLOSE_MS,
  B1_USER_MSG_MS,
  B1_REPLY_MS,
  B1B_LEAD_MS,
  B1B_TASK_MS,
  B1B_LEAF_START_MS,
  B1B_TASK_RESULT_MS,
  B2_QUESTION_MS,
  B2_ANSWER_TYPE_FROM,
  B2_ANSWER_TYPE_TO,
  B2_ANSWER_MS,
  B3_LEAF_START_MS,
  B4_SIZER_MS,
  B4_OUTCOME_MS,
  EXEC_BASE_MS,
  // (c5) in-process "Request changes" review-bar constants.
  REVIEW_GATE_ON_MS,
  REVIEW_GATE_OFF_MS,
  REVIEW_SUBMIT_MOVE_MS,
  REVIEW_SUBMIT_CLICK_MS,
  type StoryFrame,
} from "./storyboard";
import { applyReviewBarState } from "../../review";
import { WAITING_INPUT_LABEL } from "../../conversation/stream";
import type { ToolPermissionRequested } from "../../conversation/types";
import type { CommentRecord, PlanRecord, ReviewRequest } from "../../types";
import { clonePlans } from "../fixtures/plans";
import { PROTO_PREVIEW_PATH } from "../fixtures/markdown";
import {
  TRAILHEAD_PLANS,
  TRAILHEAD_MASTER_PATH,
  TRAILHEAD_MASTER_V2_PATH,
  TRAILHEAD_MASTER_DOC,
  TRAILHEAD_MASTER_V2_DOC,
} from "../fixtures/trailhead-plan";
import { renderInto, applyComments } from "../../render";

// A structure projection that is STABLE across re-derives: it captures node type + seq + a tool's
// status, but deliberately EXCLUDES node.id (which the model derives from frame ids — stable here,
// but we compare structure, not identity, so determinism is about the SHAPE, not the address).
function projectNodes(model: ConversationModel): string {
  return JSON.stringify(
    model.derive().nodes.map((n) => {
      const base: Record<string, unknown> = { type: n.type, seq: n.seq };
      if (n.type === "tool") {
        base.tool = n.tool;
        base.status = n.status;
        base.input = n.input;
        base.result = n.result;
        base.isError = n.isError;
      }
      if (n.type === "text") base.text = n.text;
      return base;
    }),
  );
}

function nodeCount(model: ConversationModel, T: number): number {
  applyUpToTime(model, TRAILHEAD_BEAT, T);
  return model.derive().nodes.length;
}

describe("storyboard — applyUpToTime invariants", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  it("1. DETERMINISM — same T twice ⇒ identical derived structure", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    const T = Math.floor(duration / 2);
    applyUpToTime(model, TRAILHEAD_BEAT, T);
    const first = projectNodes(model);
    applyUpToTime(model, TRAILHEAD_BEAT, T);
    const second = projectNodes(model);
    expect(second).toBe(first);
  });

  it("2. NO DOUBLE-ACCUMULATION — re-applying at T=duration does not double the node count", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    const once = model.derive().nodes.length;
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    const twice = model.derive().nodes.length;
    expect(twice).toBe(once);
  });

  it("3. MONOTONIC — count(T1) ≤ count(T2) for T1 < T2", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    // Sample across the whole timeline; each later snapshot must have ≥ the prior count.
    const samples = [0, duration / 4, duration / 2, (3 * duration) / 4, duration];
    let prev = -1;
    for (const T of samples) {
      const count = nodeCount(model, T);
      expect(count).toBeGreaterThanOrEqual(prev);
      prev = count;
    }
  });

  it("4. NO STUCK TOOL (RECURSIVE) — at T=duration no top-level OR nested tool is 'running'", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    // Flatten subagent groups so a leaf tool nested INSIDE a group is checked too. The spanning Task
    // tool itself lives at the top level — its OWN deferred tool_result (seq 19) is what flips it done.
    const running = model
      .derive()
      .nodes.flatMap((n) => (n.type === "subagent" ? n.children : [n]))
      .filter((t) => t.type === "tool" && t.status === "running");
    expect(running).toHaveLength(0);
  });

  it("5. LIVE DOM — renderTree yields real .conv-text AND .conv-tool nodes", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderTree(container, model.derive());
    expect(container.querySelector(".conv-text")).not.toBeNull();
    expect(container.querySelector(".conv-tool")).not.toBeNull();
  });

  // 6. FINISHED THOUGHT (FIX 1) — the beat must END as a completed turn, not a perpetual "Working…"
  //    spinner. During playback (a mid-run T) `working` is non-null (live feel); at T = duration the
  //    terminal `result` frame has landed so derive() cleared `active` and `working` is null. This
  //    asserts the INVARIANT (a finished beat has no working indicator), independent of frame counts.
  //    FALSIFIABILITY: remove the terminal `result` frame from TRAILHEAD_BEAT and the
  //    `working === null at duration` assertion goes RED (working stays non-null forever).
  it("6. FINISHED THOUGHT — working is non-null mid-run but null at T=duration", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    expect(duration).toBe(TERMINAL_MS); // pinned: the terminal `result` lands at TERMINAL_MS.

    // Inside the "Scope recon" chapter (the subagent is mid-run, no terminal result yet) — the turn is
    // generating, so working is live. B3_LEAF_START_MS is squarely inside the leaf-tool run.
    applyUpToTime(model, TRAILHEAD_BEAT, B3_LEAF_START_MS);
    expect(model.derive().working).not.toBeNull();

    // Inside the "Prototype review" chapter (mid prototype act) — still generating, working is live.
    applyUpToTime(model, TRAILHEAD_BEAT, PROTO_CARD1_PULSE_FROM);
    expect(model.derive().working).not.toBeNull();

    // Inside the "Execution" chapter (old 33000 + all shifts) — still generating, working is live.
    applyUpToTime(model, TRAILHEAD_BEAT, EXEC_BASE_MS + 6000);
    expect(model.derive().working).not.toBeNull();

    // At the end of the story the terminal `result` frame has landed → the turn is complete.
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    const finished = model.derive();
    expect(finished.working).toBeNull();
    // Belt-and-suspenders: the same terminal frame that clears `working` also flips `complete`.
    expect(finished.complete).toBe(true);
  });
});

// ---- TRAILHEAD_BEAT — interactive question + labeled subagent chapters -------------------------
//
// These assert the CONTENT shape the two-chapter beat must hold, independent of frame counts:
//   (a) while the question is open (request shown, answer not yet applied) the card has answers===null
//       AND the working indicator says WAITING_INPUT_LABEL;
//   (b) at duration the card's answers equal the typed free-text "Other" value AND working===null;
//   (c) a standalone user echo bubble carrying the typed answer exists;
//   (d) a labeled `scope-recon` subagent GROUP with ≥1 child exists;
//   (e) (covered by invariant #4) recursive no-stuck-tool;
//   (f) StoryFrames open chapters "Clarify" and "Scope recon";
//   (g) the labeled path: the group's subagentType is "scope-recon".

describe("storyboard — TRAILHEAD_BEAT interactive + subagent content", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  // The exact question text the card keys its answer by, and the typed free-text "Other" value.
  const PLATFORM_QUESTION = "Which platform should the first cut target?";
  const PLATFORM_ANSWER = "Android first — that's where most of our trail users are";

  it("(a) mid-question the card is OPEN and working = Waiting for your input", () => {
    // A T AFTER the request (B2_QUESTION_MS) but BEFORE the answer (B2_ANSWER_MS) → the form is open.
    applyUpToTime(model, TRAILHEAD_BEAT, B2_QUESTION_MS + 500);
    const tree = model.derive();
    const q = tree.nodes.find((n) => n.type === "question_request") as
      | { answers: unknown }
      | undefined;
    expect(q).toBeDefined();
    expect(q!.answers).toBeNull();
    expect(tree.working?.label).toBe(WAITING_INPUT_LABEL);
  });

  it("(b) at duration the card's answers equal the typed 'Other' value and working is null", () => {
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const tree = model.derive();
    const q = tree.nodes.find((n) => n.type === "question_request") as
      | { answers: Record<string, unknown> }
      | undefined;
    expect(q).toBeDefined();
    // FALSIFIABLE: the value is a FREE-TEXT string matching no option label (the "Other" demo). If the
    // beat keyed the answer wrong or used an option label, this exact-string compare goes RED.
    expect(q!.answers).toEqual({ [PLATFORM_QUESTION]: PLATFORM_ANSWER });
    expect(tree.working).toBeNull();
  });

  it("(c) a standalone user echo bubble carries the typed answer", () => {
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const echoes = model
      .derive()
      .nodes.filter((n) => n.type === "user" && (n as { text: string }).text === PLATFORM_ANSWER);
    expect(echoes).toHaveLength(1);
  });

  it("(d)(g) a LABELED scope-recon subagent group with ≥1 child exists", () => {
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const groups = model.derive().nodes.filter((n) => n.type === "subagent") as Array<{
      agentId: string;
      children: unknown[];
      subagentType: string | null;
      description: string | null;
    }>;
    // (P5) the beat now has MULTIPLE subagent groups (scope-recon + one per Execution subplan). Assert the
    // scope-recon group specifically: labeled, with >=1 child. FALSIFIABILITY: drop the subagent_started
    // frame and subagentType goes null (label lost).
    const recon = groups.find((g) => g.agentId === "toolu_trailhead_task_scope_recon");
    expect(recon, "scope-recon subagent group").toBeDefined();
    expect(recon!.children.length).toBeGreaterThanOrEqual(1);
    // (g) The labeled path was taken — the `subagent_started` frame named the group.
    expect(recon!.subagentType).toBe("scope-recon");
    expect(recon!.description).toBe("Scope the Trailhead source tree");
  });

  it("(f) StoryFrames open the 'Clarify' and 'Scope recon' chapters", () => {
    const labels = TRAILHEAD_BEAT.map((sf) => sf.chapterLabel).filter(Boolean);
    expect(labels).toContain("Clarify");
    expect(labels).toContain("Scope recon");
  });
});

// ---- TRAILHEAD_BEAT — P3 rewritten FRONT (beats 1-4): opening, clarify, scope×20, plan-sizer ----
//
// Beats 1-4 replace the old pre-filled prompt with the real composer flow, drive the question answer
// through the card's Other input, expand scope-recon to ~20 atomic leaf tools, and add a plan-sizer
// right-sizing gate. Each test below was verified FALSIFIABLE (the cited inversion turns it RED).

describe("storyboard — P3 front (opening / clarify / scope×20 / plan-sizer)", () => {
  // Helper: the StoryFrames carrying a field_type for a given target selector.
  function fieldTypeFor(target: string): StoryFrame[] {
    return TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "field_type" && (sf.frame as { target: string }).target === target,
    );
  }

  it("BEAT 1 — there is NO pre-filled user_message before the composer; the first user bubble lands AFTER the typed request", () => {
    // The first user_message's tMs must be AFTER the composer's #composer-request field_type window AND
    // after the composer closes — i.e. the request bubble appears only once the composer flow is done.
    const requestType = fieldTypeFor("#composer-request");
    expect(requestType).toHaveLength(1);
    const typeWindowEnd = (requestType[0].frame as { toMs: number }).toMs;
    expect(typeWindowEnd).toBe(B1_REQUEST_TYPE_TO);

    const firstUserMsg = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "user_message").sort(
      (a, b) => a.tMs - b.tMs,
    )[0];
    expect(firstUserMsg).toBeDefined();
    // FALSIFIABILITY: re-add a pre-filled seq-1 user_message at tMs 0 (the old behavior) and this goes
    // RED (the first user bubble would precede the composer typing window).
    expect(firstUserMsg.tMs).toBeGreaterThan(B1_REQUEST_TYPE_TO);
    expect(firstUserMsg.tMs).toBeGreaterThanOrEqual(B1_COMPOSER_CLOSE_MS);
    expect(firstUserMsg.tMs).toBe(B1_USER_MSG_MS);
    // The seq-1 bubble carries the SAME text typed into the composer (no separate prompt string).
    const typed = (requestType[0].frame as { text: string }).text;
    expect((firstUserMsg.frame as { text: string }).text).toBe(typed);
  });

  it("BEAT 1 — the composer opens (overlay_modal on) BEFORE the request is typed and closes (off) AFTER", () => {
    const opens = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "overlay_modal" && (sf.frame as { kind: string; on: boolean }).kind === "composer",
    );
    const on = opens.find((sf) => (sf.frame as { on: boolean }).on === true);
    const off = opens.find((sf) => (sf.frame as { on: boolean }).on === false);
    expect(on).toBeDefined();
    expect(off).toBeDefined();
    // FALSIFIABILITY: swap the open/close tMs and these orderings go RED.
    expect(on!.tMs).toBeLessThan(B1_REQUEST_TYPE_FROM);
    expect(off!.tMs).toBeGreaterThan(B1_REQUEST_TYPE_TO);
    // The modal is OPEN across the typing window, CLOSED at the duration (pure last-≤-T per kind).
    expect(projectModalState(TRAILHEAD_BEAT, B1_COMPOSER_OPEN_MS).composer).toBe(true);
    expect(projectModalState(TRAILHEAD_BEAT, B1_REQUEST_TYPE_FROM + 100).composer).toBe(true);
    expect(projectModalState(TRAILHEAD_BEAT, B1_COMPOSER_CLOSE_MS).composer).toBe(false);
    expect(projectModalState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).composer).toBe(false);
  });

  it("BEAT 2 — the question card's [data-other=\"text\"] has a field_type frame typing the Android answer", () => {
    const answerType = fieldTypeFor('[data-other="text"]');
    // FALSIFIABILITY: remove the answer field_type frame (drive the answer some other way) and this goes RED.
    expect(answerType).toHaveLength(1);
    expect((answerType[0].frame as { text: string }).text).toBe(
      "Android first — that's where most of our trail users are",
    );
    // It types AFTER the question request and is fully done by the answer fold (the source of truth).
    expect((answerType[0].frame as { fromMs: number }).fromMs).toBeGreaterThan(B2_QUESTION_MS);
    expect((answerType[0].frame as { toMs: number }).toMs).toBeLessThanOrEqual(B2_ANSWER_MS);
    // Mid-window the projection grows a PREFIX into the Other input (a pure fn of T).
    const mid = (B2_ANSWER_TYPE_FROM + B2_ANSWER_TYPE_TO) / 2;
    const prefix = projectFieldText(TRAILHEAD_BEAT, mid).get('[data-other="text"]');
    expect(prefix).toBeDefined();
    expect(prefix!.length).toBeGreaterThan(0);
    expect(prefix!.length).toBeLessThan(
      "Android first — that's where most of our trail users are".length,
    );
  });

  it("BEAT 3 — scope-recon has ~20 leaf tool pairs, ALL parented to TASK_ID, each atomic (use+result share a tMs)", () => {
    // Collect every leaf tool_use whose parent is the scope-recon Task, and pair each with its result.
    const convFrames = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "conv");
    const leafUses = convFrames.filter((sf) => {
      const ev = (sf.frame as { ev: { kind: string; parent_tool_use_id: string | null; tool?: string } }).ev;
      return (
        ev.kind === "tool_use" &&
        ev.parent_tool_use_id === "toolu_trailhead_task_scope_recon" &&
        ev.tool !== "Task"
      );
    });
    // ~20 leaf pairs (the plan asks for roughly 20).
    expect(leafUses.length).toBeGreaterThanOrEqual(20);
    expect(leafUses.length).toBeLessThanOrEqual(22);

    // Each leaf tool_use has a matching tool_result with the SAME tool_use_id AND the SAME tMs (atomic).
    // FALSIFIABILITY: move any leaf's result to a later tMs and the shared-tMs assertion goes RED (and a
    // mid-T sample would then show a stuck "running" leaf — covered by the no-stuck-tool invariant too).
    for (const useSf of leafUses) {
      const useEv = (useSf.frame as { ev: { id: string } }).ev;
      const resultSf = convFrames.find((sf) => {
        const ev = (sf.frame as { ev: { kind: string; tool_use_id?: string } }).ev;
        return ev.kind === "tool_result" && ev.tool_use_id === useEv.id;
      });
      expect(resultSf).toBeDefined();
      expect(resultSf!.tMs).toBe(useSf.tMs);
      // The result is also parented to the Task (it renders inside the group).
      expect(
        (resultSf!.frame as { ev: { parent_tool_use_id: string | null } }).ev.parent_tool_use_id,
      ).toBe("toolu_trailhead_task_scope_recon");
    }

    // The leaf tool MIX is realistic (Glob/Read/Grep/Bash present).
    const tools = new Set(
      leafUses.map((sf) => (sf.frame as { ev: { tool: string } }).ev.tool),
    );
    expect(tools.has("Glob")).toBe(true);
    expect(tools.has("Read")).toBe(true);
    expect(tools.has("Grep")).toBe(true);
    expect(tools.has("Bash")).toBe(true);
  });

  it("BEAT 3 — no leaf tool is left 'running' anywhere in the scope-recon group (recursive, at duration)", () => {
    const model = new ConversationModel();
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    // Select the scope-recon group BY agentId — the beat now has MULTIPLE subagent groups (the
    // intent-clarifier beat runs its own smaller group EARLIER, so it sorts first); the scope-recon group
    // is the one keyed by the scope-recon Task id.
    const group = model.derive().nodes.find(
      (n) => n.type === "subagent" && (n as { agentId: string }).agentId === "toolu_trailhead_task_scope_recon",
    ) as { children: Array<{ type: string; status?: string }> } | undefined;
    expect(group).toBeDefined();
    const leafTools = group!.children.filter((c) => c.type === "tool");
    // ~20 leaf tools nested in the group, none running.
    expect(leafTools.length).toBeGreaterThanOrEqual(20);
    for (const t of leafTools) expect(t.status).not.toBe("running");
  });

  it("BEAT 4 — a plan-sizer Task is present, atomic, returning the master+3-subplans / 04→4-leaves split", () => {
    const sizerUse = TRAILHEAD_BEAT.find((sf) => {
      const f = sf.frame;
      return (
        f.t === "conv" &&
        (f as { ev: { kind: string; id?: string } }).ev.kind === "tool_use" &&
        (f as { ev: { id?: string } }).ev.id === "toolu_trailhead_plan_sizer"
      );
    });
    const sizerResult = TRAILHEAD_BEAT.find((sf) => {
      const f = sf.frame;
      return (
        f.t === "conv" &&
        (f as { ev: { kind: string; tool_use_id?: string } }).ev.kind === "tool_result" &&
        (f as { ev: { tool_use_id?: string } }).ev.tool_use_id === "toolu_trailhead_plan_sizer"
      );
    });
    // FALSIFIABILITY: remove the plan-sizer pair and both finds go undefined → RED.
    expect(sizerUse).toBeDefined();
    expect(sizerResult).toBeDefined();
    // Atomic: the use + result share a tMs (no lingering running leaf).
    expect(sizerResult!.tMs).toBe(sizerUse!.tMs);
    expect(sizerUse!.tMs).toBe(B4_SIZER_MS);
    // It is a Task labeled plan-sizer; the result carries the SPLIT decision verbatim.
    expect((sizerUse!.frame as { ev: { tool: string } }).ev.tool).toBe("Task");
    expect((sizerUse!.frame as { ev: { input: { subagent_type: string } } }).ev.input.subagent_type).toBe(
      "plan-sizer",
    );
    const resultText = (sizerResult!.frame as { ev: { content: string } }).ev.content;
    expect(resultText).toMatch(/master \+ 3 subplans/i);
    expect(resultText).toMatch(/04.*decomposed into 4 leaves/i);
    // A 'Plan sizer' chapter label opens the beat.
    const labels = TRAILHEAD_BEAT.map((sf) => sf.chapterLabel).filter(Boolean);
    expect(labels).toContain("Plan sizer");
    // The plan-sizer Task node is NOT left running at duration (atomic pair flips it done).
    const model = new ConversationModel();
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const sizerNode = model
      .derive()
      .nodes.find((n) => n.type === "tool" && (n as { input?: { subagent_type?: string } }).input?.subagent_type === "plan-sizer") as
      | { status: string }
      | undefined;
    expect(sizerNode).toBeDefined();
    expect(sizerNode!.status).not.toBe("running");
  });

  it("BEAT 4 — the plan-sizer narration outcome lands AFTER scope-recon completes and BEFORE the prototype review", () => {
    // The plan-sizer outcome (B4_OUTCOME_MS) is the last front beat before the (shifted) prototype review.
    expect(B4_OUTCOME_MS).toBeLessThan(13000 + EXEC_SHIFT + CLARIFIER_SHIFT); // the prototype-review chapter's shifted open.
    // And it follows the scope-recon Task's deferred result.
    const taskResult = TRAILHEAD_BEAT.find(
      (sf) =>
        sf.frame.t === "conv" &&
        (sf.frame as { ev: { kind: string; tool_use_id?: string } }).ev.kind === "tool_result" &&
        (sf.frame as { ev: { tool_use_id?: string } }).ev.tool_use_id === "toolu_trailhead_task_scope_recon",
    );
    expect(taskResult).toBeDefined();
    expect(B4_SIZER_MS).toBeGreaterThan(taskResult!.tMs);
  });
});

// ---- TRAILHEAD_BEAT — Prototype-review chapter -------------------------------------------------
//
// The final chapter narrates a visual prototype, brackets it with an open_plan + prototype_gate
// window (so both the gate AND the active tab are pure fns of T), then lands feedback + an approval
// echo and the terminal result. These assert the CONTENT + SURFACE shape that chapter must hold:
//   • the prototype-gate ON surface frame, the open_plan bracket, and the feedback/approval model
//     frames all exist (at their pinned tMs);
//   • a "Prototype review" chapter label opens it;
//   • projectSurfaceState makes prototypeGate.on AND activeTab="plan" true exactly inside the window;
//   • the terminal result is still STRICTLY the last frame (highest seq AND tMs).

// ---- (P4 #2) TRAILHEAD_BEAT — intent-clarifier RUNNING beat (before the question card) ----------
//
// Before the clarify question card lands (B2_QUESTION_MS) the intent-clarifier agent is shown RUNNING:
// a top-level `intent-clarifier` Task + a `subagent_started` label + >=3 atomic leaf tool pairs + an
// in-group summary + a DEFERRED top-level Task tool_result (which flips the spanning Task done). These
// assert that group exists and resolves BEFORE the question — so the viewer sees the clarifier work the
// codebase before it asks. The seqs are FRACTIONAL (2.x) so no downstream renumbering. Each is FALSIFIABLE
// (the cited inversion turns it RED — verified by hand).

describe("storyboard — (P4 #2) intent-clarifier running beat (before the question)", () => {
  const CLARIFIER_TASK_ID = "toolu_trailhead_task_intent_clarifier";

  // Every leaf tool_use whose parent is the clarifier Task (excluding the Task itself).
  function clarifierLeafUses(): StoryFrame[] {
    return TRAILHEAD_BEAT.filter((sf) => {
      if (sf.frame.t !== "conv") return false;
      const ev = (sf.frame as { ev: { kind: string; parent_tool_use_id: string | null; tool?: string } }).ev;
      return ev.kind === "tool_use" && ev.parent_tool_use_id === CLARIFIER_TASK_ID && ev.tool !== "Task";
    });
  }

  it("a labeled intent-clarifier Task + subagent_started group with >=3 ATOMIC leaves runs BEFORE the question card", () => {
    // (1) The top-level Task tool_use launching the clarifier subagent, before the question.
    const taskUse = TRAILHEAD_BEAT.find(
      (sf) =>
        sf.frame.t === "conv" &&
        (sf.frame as { ev: { kind: string; id?: string; tool?: string } }).ev.kind === "tool_use" &&
        (sf.frame as { ev: { id?: string } }).ev.id === CLARIFIER_TASK_ID &&
        (sf.frame as { ev: { tool?: string } }).ev.tool === "Task",
    );
    // FALSIFIABILITY: remove the clarifier Task tool_use and this find goes undefined → RED.
    expect(taskUse, "clarifier Task tool_use").toBeDefined();
    expect(taskUse!.tMs).toBe(B1B_TASK_MS);
    expect((taskUse!.frame as { ev: { parent_tool_use_id: string | null } }).ev.parent_tool_use_id).toBeNull();
    expect((taskUse!.frame as { ev: { input: { subagent_type: string } } }).ev.input.subagent_type).toBe(
      "intent-clarifier",
    );
    // The whole clarifier group runs BEFORE the question card.
    expect(taskUse!.tMs).toBeLessThan(B2_QUESTION_MS);

    // (2) The `subagent_started` LABEL frame keyed to the Task id (names the group).
    const started = TRAILHEAD_BEAT.find(
      (sf) =>
        sf.frame.t === "conv" &&
        (sf.frame as { ev: { kind: string; tool_use_id?: string } }).ev.kind === "subagent_started" &&
        (sf.frame as { ev: { tool_use_id?: string } }).ev.tool_use_id === CLARIFIER_TASK_ID,
    );
    // FALSIFIABILITY: drop the subagent_started frame → undefined → RED (and the derived group loses its label).
    expect(started, "clarifier subagent_started label").toBeDefined();

    // (3) >=3 leaf tool pairs, ALL parented to the Task, EACH atomic (use+result share a tMs), ALL before
    // the question. FALSIFIABILITY: move a leaf's result to a later tMs → the shared-tMs assert goes RED.
    const leafUses = clarifierLeafUses();
    expect(leafUses.length, "clarifier leaf count").toBeGreaterThanOrEqual(3);
    for (const useSf of leafUses) {
      const useEv = (useSf.frame as { ev: { id: string } }).ev;
      expect(useSf.tMs, "leaf before question").toBeLessThan(B2_QUESTION_MS);
      expect(useSf.tMs, "leaf at/after clarifier leaf-start").toBeGreaterThanOrEqual(B1B_LEAF_START_MS);
      const resultSf = TRAILHEAD_BEAT.find(
        (sf) =>
          sf.frame.t === "conv" &&
          (sf.frame as { ev: { kind: string; tool_use_id?: string } }).ev.kind === "tool_result" &&
          (sf.frame as { ev: { tool_use_id?: string } }).ev.tool_use_id === useEv.id,
      );
      expect(resultSf, `tool_result for clarifier leaf ${useEv.id}`).toBeDefined();
      expect(resultSf!.tMs, `atomic tMs for clarifier leaf ${useEv.id}`).toBe(useSf.tMs);
      expect(
        (resultSf!.frame as { ev: { parent_tool_use_id: string | null } }).ev.parent_tool_use_id,
        "leaf result parented to clarifier Task",
      ).toBe(CLARIFIER_TASK_ID);
    }
    // The leaf MIX is realistic (Glob/Read/Grep present — the clarifier's grounding scan).
    const tools = new Set(leafUses.map((sf) => (sf.frame as { ev: { tool: string } }).ev.tool));
    expect(tools.has("Glob")).toBe(true);
    expect(tools.has("Read")).toBe(true);
    expect(tools.has("Grep")).toBe(true);
  });

  it("the clarifier lead + group all precede the question card (lead < Task < result < question)", () => {
    // The reasoning lead, the Task, its deferred result, and the question card are strictly ordered in tMs.
    expect(B1B_LEAD_MS).toBeLessThan(B1B_TASK_MS);
    expect(B1B_TASK_MS).toBeLessThan(B1B_TASK_RESULT_MS);
    // FALSIFIABILITY: if the question were hoisted before the clarifier result (no shift), this goes RED.
    expect(B1B_TASK_RESULT_MS).toBeLessThan(B2_QUESTION_MS);
  });

  it("the clarifier Task RESOLVES — a deferred top-level Task tool_result flips it done (no stuck tool)", () => {
    // The DEFERRED result: a top-level tool_result (parent null) whose tool_use_id = the clarifier Task id.
    const deferred = TRAILHEAD_BEAT.find(
      (sf) =>
        sf.frame.t === "conv" &&
        (sf.frame as { ev: { kind: string; tool_use_id?: string; parent_tool_use_id: string | null } }).ev.kind === "tool_result" &&
        (sf.frame as { ev: { tool_use_id?: string } }).ev.tool_use_id === CLARIFIER_TASK_ID &&
        (sf.frame as { ev: { parent_tool_use_id: string | null } }).ev.parent_tool_use_id === null,
    );
    // FALSIFIABILITY: delete the deferred clarifier Task tool_result → undefined here, AND the derived
    // clarifier Task node is left 'running' at duration (the assertion below + no-stuck invariant go RED).
    expect(deferred, "deferred clarifier Task tool_result").toBeDefined();
    expect(deferred!.tMs).toBe(B1B_TASK_RESULT_MS);

    // Derived: at duration the clarifier group exists, is LABELED, has >=3 child tools, NONE running.
    const model = new ConversationModel();
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const group = model.derive().nodes.find(
      (n) => n.type === "subagent" && (n as { agentId: string }).agentId === CLARIFIER_TASK_ID,
    ) as { children: Array<{ type: string; status?: string }>; subagentType: string | null } | undefined;
    expect(group, "derived clarifier subagent group").toBeDefined();
    expect(group!.subagentType).toBe("intent-clarifier");
    const childTools = group!.children.filter((c) => c.type === "tool");
    expect(childTools.length, "clarifier child tools").toBeGreaterThanOrEqual(3);
    for (const c of childTools) expect(c.status).not.toBe("running");

    // The spanning clarifier Task node itself is NOT running at duration (the deferred result flipped it).
    const taskNode = model
      .derive()
      .nodes.find((n) => n.type === "tool" && (n as { input?: { subagent_type?: string } }).input?.subagent_type === "intent-clarifier") as
      | { status: string }
      | undefined;
    expect(taskNode, "clarifier Task node").toBeDefined();
    expect(taskNode!.status).not.toBe("running");
  });

  it("at a T inside the clarifier window (before the question) the clarifier group is rendering and the question card is ABSENT", () => {
    // Sample a T after the leaves start but before the question: the clarifier subagent group is present
    // (the agent is visibly working) and NO question_request node exists yet.
    const model = new ConversationModel();
    const midClarifier = B1B_LEAF_START_MS + 100;
    expect(midClarifier).toBeLessThan(B2_QUESTION_MS);
    applyUpToTime(model, TRAILHEAD_BEAT, midClarifier);
    const tree = model.derive();
    const group = tree.nodes.find(
      (n) => n.type === "subagent" && (n as { agentId: string }).agentId === CLARIFIER_TASK_ID,
    );
    // FALSIFIABILITY: if the clarifier group were dropped (or moved after the question) this group find →
    // undefined → RED; and the question would appear cold (no preceding agent activity).
    expect(group, "clarifier group rendering mid-window").toBeDefined();
    expect(tree.nodes.some((n) => n.type === "question_request"), "question absent before its tMs").toBe(false);
    // The turn is still generating while the clarifier runs (working non-null).
    expect(tree.working).not.toBeNull();
  });
});

describe("storyboard — TRAILHEAD_BEAT prototype-review chapter", () => {
  // P4: the gate + open_plan bracket span the WHOLE scripted prototype act — opening at PROTO_OPEN_MS,
  // closing at PROTO_CLOSE_MS (after the round-1→round-2 card morph). Named constants, not magic numbers.
  const GATE_OPEN_MS = PROTO_OPEN_MS;
  const GATE_CLOSE_MS = PROTO_CLOSE_MS;
  const FEEDBACK_MS = PROTO_FEEDBACK_MS;

  it("the prototype-gate ON surface frame exists at gate-open (round 1)", () => {
    const gateOn = TRAILHEAD_BEAT.find(
      (sf) =>
        sf.frame.t === "prototype_gate" &&
        sf.frame.on === true &&
        sf.frame.round === 1 &&
        sf.tMs === GATE_OPEN_MS,
    );
    expect(gateOn).toBeDefined();
  });

  it("the card MORPHS: a round-2 prototype_gate frame exists AFTER round 1 (drives the bigger badged card)", () => {
    const round2 = TRAILHEAD_BEAT.find(
      (sf) =>
        sf.frame.t === "prototype_gate" &&
        sf.frame.on === true &&
        sf.frame.round === 2 &&
        sf.tMs === PROTO_ROUND2_MS,
    );
    expect(round2).toBeDefined();
    // Ordering: round 2 lands strictly after round 1's open and strictly before the gate closes.
    expect(PROTO_ROUND2_MS).toBeGreaterThan(GATE_OPEN_MS);
    expect(PROTO_ROUND2_MS).toBeLessThan(GATE_CLOSE_MS);
    // And the projection reflects the morph: round 1 mid-act, round 2 after PROTO_ROUND2_MS.
    expect(projectSurfaceState(TRAILHEAD_BEAT, PROTO_CARD1_PULSE_FROM).prototypeGate.round).toBe(1);
    expect(projectSurfaceState(TRAILHEAD_BEAT, PROTO_CARD2_PULSE_FROM).prototypeGate.round).toBe(2);
    // FALSIFIABILITY: if the round-2 gate were dropped, the round at PROTO_CARD2_PULSE_FROM would stay 1.
  });

  it("the prototype feedback is TYPED into #prototype-feedback (a field_type frame), then echoed as the user bubble", () => {
    const typed = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "field_type" && sf.frame.target === "#prototype-feedback",
    );
    expect(typed).toBeDefined();
    // The typed text fully resolves by the end of its window (the same string the user bubble carries).
    const fullAtEnd = projectFieldText(TRAILHEAD_BEAT, PROTO_FEEDBACK_TYPE_TO).get("#prototype-feedback");
    expect(fullAtEnd).toBeTruthy();
    // … and is PARTIAL mid-window (a real growing prefix, not an instant set).
    const midLen = (projectFieldText(TRAILHEAD_BEAT, (PROTO_FEEDBACK_TYPE_FROM + PROTO_FEEDBACK_TYPE_TO) / 2).get("#prototype-feedback") ?? "").length;
    expect(midLen).toBeGreaterThan(0);
    expect(midLen).toBeLessThan((fullAtEnd ?? "").length);
    // The user bubble echo carries the SAME feedback text (compose-then-echo, like Beat 1).
    const userBubble = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "user_message" && sf.tMs === FEEDBACK_MS,
    );
    expect(userBubble).toBeDefined();
    expect((userBubble!.frame as { text: string }).text).toBe(fullAtEnd);
  });

  it("the INLINE prototype pane is PULSED in both rounds (#reading-pane pulse frames), never a floating card", () => {
    const panePulses = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "pulse" && sf.frame.target === "#reading-pane",
    );
    expect(panePulses.length).toBeGreaterThanOrEqual(2);
    // REGRESSION GUARD (review2 c3): the deleted floating overlay (#demo-proto-card) must NEVER reappear in
    // ANY frame. Re-adding the card path (a pulse/cursor/anything targeting it) turns this RED.
    const cardRefs = TRAILHEAD_BEAT.filter(
      (sf) => "target" in sf.frame && (sf.frame as { target?: string }).target === "#demo-proto-card",
    );
    expect(cardRefs).toHaveLength(0);
  });

  it("the open_plan bracket opens PROTO_PREVIEW_PATH at gate-open and closes (null) at gate-close", () => {
    const open = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "open_plan" && sf.frame.path === PROTO_PREVIEW_PATH && sf.tMs === GATE_OPEN_MS,
    );
    const close = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "open_plan" && sf.frame.path === null && sf.tMs === GATE_CLOSE_MS,
    );
    expect(open).toBeDefined();
    expect(close).toBeDefined();
  });

  it("the feedback user_message + approval system_message land together at the feedback tMs", () => {
    const fb = TRAILHEAD_BEAT.filter((sf) => sf.tMs === FEEDBACK_MS);
    const user = fb.find((sf) => sf.frame.t === "user_message");
    const system = fb.find((sf) => sf.frame.t === "system_message");
    expect(user).toBeDefined();
    expect(system).toBeDefined();
  });

  it("a 'Prototype review' chapter label opens the chapter", () => {
    const labels = TRAILHEAD_BEAT.map((sf) => sf.chapterLabel).filter(Boolean);
    expect(labels).toContain("Prototype review");
  });

  it("projectSurfaceState: prototypeGate.on is true across the act window, off at the edges", () => {
    // Just before the open → off.
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_OPEN_MS - 1).prototypeGate.on).toBe(false);
    // Inside the window (round 1 phase) → on.
    expect(projectSurfaceState(TRAILHEAD_BEAT, PROTO_CARD1_PULSE_FROM).prototypeGate.on).toBe(true);
    // Still on in the round-2 phase.
    expect(projectSurfaceState(TRAILHEAD_BEAT, PROTO_CARD2_PULSE_FROM).prototypeGate.on).toBe(true);
    // At/after the close → off again (a backward scrub reverts cleanly).
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_CLOSE_MS).prototypeGate.on).toBe(false);
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).prototypeGate.on).toBe(false);
  });

  it("projectSurfaceState: activeTab tracks the prototype bracket AND flips to conversation for Execution", () => {
    // Before the open the conversation is showing (no plan open in the whole beat before this).
    expect(projectSurfaceState(TRAILHEAD_BEAT, PROTO_NARR_MS).activeTab).toBe("conversation");
    // Inside the prototype bracket the prototype plan is open → Plan tab.
    expect(projectSurfaceState(TRAILHEAD_BEAT, PROTO_CARD1_PULSE_FROM).activeTab).toBe("plan");
    // After the prototype bracket closes the tab flips back to conversation (the ack bubble is on Conversation).
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_CLOSE_MS).activeTab).toBe("conversation");
    expect(projectSurfaceState(TRAILHEAD_BEAT, PROTO_ACK_MS).activeTab).toBe("conversation");
    // INCLUDING at duration (the terminal lands on the Conversation tab; master/V2 no longer shown).
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).activeTab).toBe("conversation");
  });

  it("the terminal result is STRICTLY the last frame (highest seq AND tMs)", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    // The terminal result is the model frame with the highest tMs AND it is a `result` kind.
    const last = TRAILHEAD_BEAT.reduce((a, b) => (b.tMs >= a.tMs ? b : a));
    expect(last.tMs).toBe(duration);
    expect(last.frame.t).toBe("conv");
    expect((last.frame as { ev: { kind: string } }).ev.kind).toBe("result");
    // No model frame has a higher seq than the terminal's seq (TERMINAL_SEQ).
    const seqs = TRAILHEAD_BEAT.flatMap((sf) => {
      const f = sf.frame;
      if (f.t === "conv") return [f.ev.seq];
      if (f.t === "question_request") return [f.ev.seq];
      if (f.t === "user_message" || f.t === "system_message" || f.t === "question_answered") return [f.seq];
      return [];
    });
    expect(Math.max(...seqs)).toBe(TERMINAL_SEQ);
    expect((last.frame as { ev: { seq: number } }).ev.seq).toBe(TERMINAL_SEQ);
  });
});

// ---- TRAILHEAD_BEAT — "Nested plan" reveal chapter --------------------------------------------
//
// The closing chapter reveals the drafted Trailhead plan tree: the sidebar is EMPTY for the whole
// beat (an explicit empty plan_changed at tMs 0) until the plan_changed at 19800 pops TRAILHEAD_PLANS
// in, and the master open_plan at 20200 reveals the master on the Plan tab. The Execution chapter then
// closes the pane (open_plan{null} at 27000) so the beat ends on the Conversation tab. The terminal
// result (40000) is strictly last and clears `working` (a finished thought).

describe("storyboard — TRAILHEAD_BEAT nested-plan reveal chapter", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  // Nested-plan + comment chapters shift by + PROTO_ACT_SHIFT (the P4 prototype act lengthened the
  // upstream chapter) + CLARIFIER_SHIFT (the P4#2 intent-clarifier beat slid the whole back half later);
  // the literals are unchanged, the shift is added.
  const NESTED_SHIFT = EXEC_SHIFT + PROTO_ACT_SHIFT + CLARIFIER_SHIFT;
  const PLAN_CHANGED_MS = 19800 + NESTED_SHIFT;

  it("(P1) sidebar is EMPTY ([]) before the reveal, then ONLY the master appears (NOT the whole tree); the full tree lands only at duration", () => {
    // The explicit empty plan_changed at tMs 0 pins the sidebar to [] from the start (NOT the seed).
    expect(projectSurfaceState(TRAILHEAD_BEAT, 0).plans).toEqual([]);
    expect(projectSurfaceState(TRAILHEAD_BEAT, 10000).plans).toEqual([]);
    expect(projectSurfaceState(TRAILHEAD_BEAT, PLAN_CHANGED_MS - 1).plans).toEqual([]);
    // (P1) At the Nested-plan reveal ONLY the master row appears — the subplan rows appear ONE AT A TIME
    // later in the progressive Execution chapter. FALSIFIABILITY: revert to the all-at-once full-tree
    // plan_changed and the master-only length-1 assertion here goes RED (it would be the full 9 rows).
    const atReveal = projectSurfaceState(TRAILHEAD_BEAT, PLAN_CHANGED_MS).plans;
    expect(atReveal).toHaveLength(1);
    expect(atReveal[0].flavor).toBe("master");
    expect(atReveal[0]).toEqual(TRAILHEAD_PLANS[0]);
    // The full tree is present only once the progressive Execution chapter has grown it (at duration).
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).plans).toEqual(TRAILHEAD_PLANS);
  });

  it("at the master-open moment the V1 master is open (Plan tab)", () => {
    const at = projectSurfaceState(TRAILHEAD_BEAT, 20200 + NESTED_SHIFT);
    expect(at.openPlanPath).toBe(TRAILHEAD_MASTER_PATH);
    expect(at.activeTab).toBe("plan");
  });

  it("the V2 master is open just before Execution but closed at duration (Execution)", () => {
    // Just before the Execution chapter the open_plan{V2} is still the last open_plan, so the revised
    // master is on the Plan tab. (P2) the Execution chapter is built directly at FINAL tMs from
    // EXEC_BASE_MS (its first frame is the open_plan{null}); sample just before that close.
    const execOpenNull = EXEC_BASE_MS;
    const beforeExec = projectSurfaceState(TRAILHEAD_BEAT, execOpenNull - 1);
    expect(beforeExec.openPlanPath).toBe(TRAILHEAD_MASTER_V2_PATH);
    expect(beforeExec.openPlanPath).not.toBe(TRAILHEAD_MASTER_PATH);
    expect(beforeExec.activeTab).toBe("plan");
    // The Execution chapter's open_plan{null} closes the pane, so at duration NO plan is open and the
    // tab is back on the conversation (the master is no longer the final on-screen surface).
    const at = projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    expect(at.openPlanPath).toBeNull();
    expect(at.activeTab).toBe("conversation");
  });

  it("the terminal result is STRICTLY last (highest tMs); no later frame exists", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    const later = TRAILHEAD_BEAT.filter((sf) => sf.tMs > duration);
    expect(later).toHaveLength(0);
    const last = TRAILHEAD_BEAT.reduce((a, b) => (b.tMs >= a.tMs ? b : a));
    expect(last.tMs).toBe(duration);
    expect((last.frame as { ev: { kind: string } }).ev.kind).toBe("result");
  });

  it("FINISHED THOUGHT — working is non-null in the nested-plan gap but null at duration", () => {
    // Inside the "Nested plan" gap (after the plan_changed reveal, before the terminal result) — still
    // generating, so working is live.
    applyUpToTime(model, TRAILHEAD_BEAT, 20000 + EXEC_SHIFT + PROTO_ACT_SHIFT + CLARIFIER_SHIFT);
    expect(model.derive().working).not.toBeNull();
    // At duration the terminal result has landed → the turn is complete, working is null.
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    expect(model.derive().working).toBeNull();
  });
});

// ---- (P1) TRAILHEAD_BEAT — PROGRESSIVE multiplan reveal (the structural core) ------------------
//
// The back half now plays PROGRESSIVELY: the master appears alone, then each subplan's ROW materializes
// ONE AT A TIME (a fresh `plan_changed` snapshot = the tree grown so far) just before that subplan is
// planned + executed, with a parent-review beat between siblings. These tests assert that growth on the
// ordered `plan_changed` SurfaceFrames — pinned to the subplan order, NOT to magic tMs numbers.

describe("storyboard — (P1) progressive multiplan reveal", () => {
  // The ordered `plan_changed` snapshots across the WHOLE beat (story order = ascending tMs).
  function planChangedFrames(): Array<{ tMs: number; plans: PlanRecord[] }> {
    return TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "plan_changed").map((sf) => ({
      tMs: sf.tMs,
      plans: (sf.frame as { plans: PlanRecord[] }).plans,
    }));
  }

  // The nn_path set of a snapshot's subplan rows (master excluded — it carries nn_path null).
  function subPaths(plans: PlanRecord[]): string[] {
    return plans.filter((p) => p.flavor === "sub").map((p) => p.nn_path as string);
  }

  // The subplan reveal STAGES, in execution order. Each stage's snapshot must contain EXACTLY the master
  // + the cumulative sub nn_paths up to and including that stage (02..04.04 ABSENT before their turn).
  // Stage 04.01 also pulls in the "04" decomposition parent (it must precede its first leaf).
  const STAGES: ReadonlyArray<{ id: string; cumulative: string[] }> = [
    { id: "01", cumulative: ["01"] },
    { id: "02", cumulative: ["01", "02"] },
    { id: "03", cumulative: ["01", "02", "03"] },
    { id: "04.01", cumulative: ["01", "02", "03", "04", "04.01"] },
    { id: "04.02", cumulative: ["01", "02", "03", "04", "04.01", "04.02"] },
    { id: "04.03", cumulative: ["01", "02", "03", "04", "04.01", "04.02", "04.03"] },
    { id: "04.04", cumulative: ["01", "02", "03", "04", "04.01", "04.02", "04.03", "04.04"] },
  ];

  it("the first snapshot is the EMPTY sidebar; the second is the MASTER ALONE (the Nested-plan reveal)", () => {
    const snaps = planChangedFrames();
    // tMs-0 empty sidebar.
    expect(snaps[0].plans).toEqual([]);
    // The Nested-plan reveal: master alone (NOT the whole tree). FALSIFIABILITY: an all-at-once tree here
    // makes subPaths non-empty → RED.
    const masterReveal = snaps.find((s) => s.plans.length > 0)!;
    expect(masterReveal.plans).toHaveLength(1);
    expect(masterReveal.plans[0].flavor).toBe("master");
    expect(subPaths(masterReveal.plans)).toEqual([]);
  });

  it("PROGRESSIVE APPEARANCE — at stage K the snapshot contains EXACTLY master + subs 01..K (later subs ABSENT before their turn)", () => {
    const snaps = planChangedFrames();
    // The progressive (non-empty, growing) snapshots are those AFTER the master-only reveal. There is one
    // execution-stage snapshot per STAGE, in order. Match them by their cumulative sub-path set.
    const growing = snaps.filter((s) => subPaths(s.plans).length > 0);
    expect(growing.length).toBe(STAGES.length);
    for (let k = 0; k < STAGES.length; k++) {
      const stage = STAGES[k];
      const snap = growing[k];
      // EXACTLY the cumulative subs (a Set compare — order asserted separately by the orphan-free test).
      // FALSIFIABILITY: include a LATER node early (e.g. push "02" into stage 01's reveals) and stage 0's
      // set would gain "02" → this exact-set compare goes RED.
      expect(new Set(subPaths(snap.plans)), `stage ${stage.id} cumulative subs`).toEqual(new Set(stage.cumulative));
      // Master always present.
      expect(snap.plans.some((p) => p.flavor === "master")).toBe(true);
    }
    // Concretely: stage 01's snapshot has 01 but NOT 02/03/04 (the headline invariant).
    const stage01 = growing[0];
    expect(subPaths(stage01.plans)).toContain("01");
    for (const absent of ["02", "03", "04", "04.01"]) {
      expect(subPaths(stage01.plans)).not.toContain(absent);
    }
  });

  it("ORPHAN-FREE SNAPSHOTS — every `plan_changed` payload is master-first and parent-before-child (never trips the sidebar orphan path)", () => {
    for (const { plans } of planChangedFrames()) {
      if (plans.length === 0) continue;
      // (1) master-first: the first row (if any sub exists) is the master.
      if (plans.some((p) => p.flavor === "sub")) {
        expect(plans[0].flavor, "master-first").toBe("master");
      }
      // (2) parent-before-child: for every dotted sub (04.0x) its parent prefix (04) appears EARLIER, and
      // for every depth-1 sub its master appears earlier. We assert the dotted-parent rule (the one the
      // sidebar's orphan path guards) AND that NO sub precedes the master.
      const seen = new Set<string>();
      let masterIdx = -1;
      plans.forEach((p, i) => {
        if (p.flavor === "master") masterIdx = i;
      });
      plans.forEach((p, i) => {
        if (p.flavor !== "sub") {
          seen.add(p.nn_path ?? "");
          return;
        }
        // No sub before the master.
        expect(i, "sub after master").toBeGreaterThan(masterIdx);
        const nn = p.nn_path as string;
        const parentPrefix = nn.split(".").slice(0, -1).join(".");
        if (parentPrefix !== "") {
          // A dotted sub (04.0x): its parent prefix (04) must already have appeared. FALSIFIABILITY:
          // reorder a snapshot so 04.01 precedes 04 and this goes RED (the orphan path would fire live).
          expect(seen.has(parentPrefix), `parent ${parentPrefix} before ${nn}`).toBe(true);
        }
        seen.add(nn);
      });
    }
  });

  it("ORDERING — subplan N's row appears at a tMs AFTER subplan N-1's done + parent-review beat", () => {
    const growing = planChangedFrames().filter((s) => subPaths(s.plans).length > 0);
    // Each stage's appearance tMs strictly increases (the rows appear one at a time, in order).
    for (let k = 1; k < growing.length; k++) {
      expect(growing[k].tMs, `stage ${STAGES[k].id} appears after stage ${STAGES[k - 1].id}`).toBeGreaterThan(growing[k - 1].tMs);
    }
    // Stronger: stage N's row appears AFTER stage N-1's DEFERRED execution-Task result (its "done" signal)
    // AND after the parent-review narration that follows it. Find stage N-1's execution Task deferred
    // result tMs, and assert stage N's appearance is strictly later.
    const execTaskIds = [
      "toolu_th_exec_sp01",
      "toolu_th_exec_sp02",
      "toolu_th_exec_sp03",
      "toolu_th_exec_sp0401",
      "toolu_th_exec_sp0402",
      "toolu_th_exec_sp0403",
    ];
    for (let k = 1; k < growing.length; k++) {
      const priorTaskId = execTaskIds[k - 1];
      const deferred = TRAILHEAD_BEAT.find(
        (sf) =>
          sf.frame.t === "conv" &&
          (sf.frame as { ev: { kind: string; tool_use_id?: string; parent_tool_use_id: string | null } }).ev.kind === "tool_result" &&
          (sf.frame as { ev: { tool_use_id?: string } }).ev.tool_use_id === priorTaskId &&
          (sf.frame as { ev: { parent_tool_use_id: string | null } }).ev.parent_tool_use_id === null,
      );
      expect(deferred, `deferred exec result for ${priorTaskId}`).toBeDefined();
      // The next stage's row appears strictly AFTER the prior subplan's done signal.
      // FALSIFIABILITY: hoist the row appearance before the prior subplan's done and this goes RED.
      expect(growing[k].tMs, `stage ${STAGES[k].id} after ${priorTaskId} done`).toBeGreaterThan(deferred!.tMs);
    }
  });

  it("(#7) a master→01 'thinking' planning-lead group precedes the FIRST subplan row appearing", () => {
    // The planning-lead Task (the agent reasoning about where to start) must land BEFORE subplan 01's row
    // snapshot. FALSIFIABILITY: drop the planning-lead group and this find goes undefined → RED.
    const lead = TRAILHEAD_BEAT.find(
      (sf) =>
        sf.frame.t === "conv" &&
        (sf.frame as { ev: { kind: string; id?: string } }).ev.kind === "tool_use" &&
        (sf.frame as { ev: { id?: string } }).ev.id === "toolu_th_plan_lead",
    );
    expect(lead).toBeDefined();
    const growing = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "plan_changed" && (sf.frame as { plans: PlanRecord[] }).plans.some((p) => p.flavor === "sub"),
    );
    const firstRow = growing[0];
    expect(lead!.tMs).toBeLessThan(firstRow.tMs);
  });

  it("(#11) each subplan is PLANNED just-in-time: its planning Task lands AFTER its row appears and BEFORE its execution Task", () => {
    const stages = [
      { reveal: ["01"], planId: "toolu_th_plan_sp01", execId: "toolu_th_exec_sp01" },
      { reveal: ["02"], planId: "toolu_th_plan_sp02", execId: "toolu_th_exec_sp02" },
      { reveal: ["03"], planId: "toolu_th_plan_sp03", execId: "toolu_th_exec_sp03" },
      { reveal: ["04.01"], planId: "toolu_th_plan_sp0401", execId: "toolu_th_exec_sp0401" },
      { reveal: ["04.02"], planId: "toolu_th_plan_sp0402", execId: "toolu_th_exec_sp0402" },
      { reveal: ["04.03"], planId: "toolu_th_plan_sp0403", execId: "toolu_th_exec_sp0403" },
      { reveal: ["04.04"], planId: "toolu_th_plan_sp0404", execId: "toolu_th_exec_sp0404" },
    ];
    const taskTMs = (id: string): number => {
      const sf = TRAILHEAD_BEAT.find(
        (f) =>
          f.frame.t === "conv" &&
          (f.frame as { ev: { kind: string; id?: string } }).ev.kind === "tool_use" &&
          (f.frame as { ev: { id?: string } }).ev.id === id,
      );
      expect(sf, `Task tool_use ${id}`).toBeDefined();
      return sf!.tMs;
    };
    for (const st of stages) {
      // The row snapshot whose sub set newly contains this stage's last reveal path.
      const path = st.reveal[st.reveal.length - 1];
      const rowSnap = TRAILHEAD_BEAT.find(
        (sf) => sf.frame.t === "plan_changed" && (sf.frame as { plans: PlanRecord[] }).plans.some((p) => p.nn_path === path),
      );
      expect(rowSnap, `row snapshot for ${path}`).toBeDefined();
      const planMs = taskTMs(st.planId);
      const execMs = taskTMs(st.execId);
      // row appears ≤ planning Task < execution Task — the plan is drafted JUST-IN-TIME at the row's turn.
      // FALSIFIABILITY: move a subplan's planning Task before its row (or after its execution) → RED.
      expect(rowSnap!.tMs).toBeLessThanOrEqual(planMs);
      expect(planMs).toBeLessThan(execMs);
    }
  });
});

// ---- TRAILHEAD_BEAT — "Comment & iterate" chapter (Slice 06) ----------------------------------
//
// With the V1 master still open on the Plan tab, the user leaves THREE comments (set_comments ×3, full
// set growing [c1] → [c1,c2] → [c1,c2,c3]); projectSurfaceState.comments follows 1 → 2 → 3 (the
// reconciler paints that many inline `.cmt-hl` highlights). The pane then switches to the REVISED
// master (open_plan{V2} at 24800). Because comments are scoped to the OPEN path and V2 has none,
// projectSurfaceState.comments drops to 0 on V2 (a clean iteration reveal). A system echo (seq 26)
// announces the revision; the Execution chapter then closes the pane (open_plan{null} at 27000) and the
// terminal result (seq 49 / 40000) closes the turn (finished thought). HIGHLIGHTS-ONLY: no
// pending_reviews frame is driven, so there is no review-bar count to assert (and none exists).

describe("storyboard — TRAILHEAD_BEAT comment-and-iterate chapter", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  // The comment chapter lives in DOWNSTREAM_AFTER_PROTOTYPE — its literals already bake in EXEC_SHIFT
  // (they continue the nested-plan scheme), and the push adds + PROTO_ACT_SHIFT (inner overlay windows
  // included). (P2) the chapter LENGTHENED: a slow-scroll beat now plays before the comments AND comment
  // c2 got its OWN full popover act, so each comment's highlight paints AFTER its act: set_comments land
  // at literal 59800 ([c1]) / 63800 ([c1,c2]) / 67800 ([c1,c2,c3]); V2 opens at literal 69000 (all +
  // PROTO_ACT_SHIFT).
  // + CLARIFIER_SHIFT: the intent-clarifier beat slid the whole back half (incl. this comment chapter)
  // later by CLARIFIER_SHIFT, applied via the DOWNSTREAM_AFTER_PROTOTYPE splice .map.
  // (c4) + C4_SHIFT: the c4 ToC-navigation beat (which now plays BEFORE the comments) is longer than the
  // old generic slow-scroll beat it replaced, so the comment chapter slid later by C4_SHIFT (applied in
  // the DOWNSTREAM splice loop to every comment-chapter frame).
  const CMT_SHIFT = PROTO_ACT_SHIFT + CLARIFIER_SHIFT + C4_SHIFT;
  const C1_PAINT_MS = 59800 + CMT_SHIFT;
  const C2_PAINT_MS = 63800 + CMT_SHIFT;
  const C3_PAINT_MS = 67800 + CMT_SHIFT;
  // (c5) The V2 reveal slid from literal 69000 → 69500 (the in-process review-bar dwell + the slower
  // cursor travel to "Request changes" + the gate-OFF frame now sit between the 3rd comment and V2).
  const V2_OPEN_MS = 69500 + CMT_SHIFT;

  it("projectSurfaceState.comments grows 1 → 2 → 3 over the set_comments frames (on the open V1 master)", () => {
    // The V1 master is open; comments are scoped to that open path.
    expect(projectSurfaceState(TRAILHEAD_BEAT, C1_PAINT_MS).openPlanPath).toBe(TRAILHEAD_MASTER_PATH);
    expect(projectSurfaceState(TRAILHEAD_BEAT, C1_PAINT_MS).comments).toHaveLength(1);
    expect(projectSurfaceState(TRAILHEAD_BEAT, C2_PAINT_MS).comments).toHaveLength(2);
    expect(projectSurfaceState(TRAILHEAD_BEAT, C3_PAINT_MS).comments).toHaveLength(3);
    // Just BEFORE the first comment lands the open master has no comments yet.
    expect(projectSurfaceState(TRAILHEAD_BEAT, C1_PAINT_MS - 1).comments).toHaveLength(0);
  });

  it("(P2) COMMENT-ACT-COUNT — ALL THREE comments have a typed-text act: 3 popover-on overlays + 3 #sp-text field_types, each preceding its highlight", () => {
    // (P2) EVERY comment now gets a full popover act (c2 was previously a plain set_comments with NO act).
    // Assert the ordering popover-on → typing → highlight for all three. FALSIFIABILITY: remove c2's act
    // (delete its popover-on + #sp-text field_type frames) and these length-3 assertions go RED (back to 2).
    const popoverOns = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "overlay_modal" && sf.frame.kind === "popover" && sf.frame.on === true,
    );
    expect(popoverOns.length).toBe(3);
    const spTextTypes = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "field_type" && sf.frame.target === "#sp-text",
    );
    expect(spTextTypes.length).toBe(3);
    // The three typed comments are c1, c2, c3 in order (each act types its own comment text).
    expect((spTextTypes[0].frame as { text: string }).text).toBe(TRAILHEAD_COMMENT_1.comment);
    expect((spTextTypes[1].frame as { text: string }).text).toBe(TRAILHEAD_COMMENT_2.comment);
    expect((spTextTypes[2].frame as { text: string }).text).toBe(TRAILHEAD_COMMENT_3.comment);
    // Per-comment ordering: each comment's popover-on + #sp-text typing precede its highlight paint, and
    // the act lands AFTER the prior comment's paint (distinct, sequential acts).
    const paints = [C1_PAINT_MS, C2_PAINT_MS, C3_PAINT_MS];
    for (let i = 0; i < 3; i++) {
      expect(popoverOns[i].tMs, `c${i + 1} popover before paint`).toBeLessThan(paints[i]);
      expect(spTextTypes[i].tMs, `c${i + 1} typing before paint`).toBeLessThan(paints[i]);
      if (i > 0) {
        expect(popoverOns[i].tMs, `c${i + 1} act after c${i} paint`).toBeGreaterThan(paints[i - 1]);
      }
    }
  });

  it("(P2) each comment EMPHASIZES its target block before typing: a pulse on the block precedes the #sp-text typing", () => {
    // Each comment's act begins by pulsing its anchor block (a "look here" cue) BEFORE the popover types.
    // FALSIFIABILITY: drop a block-pulse frame and the per-comment block-pulse-before-typing find goes RED.
    const spTextTypes = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "field_type" && sf.frame.target === "#sp-text",
    );
    expect(spTextTypes.length).toBe(3);
    // c1 + c2 anchor data-source-line="4"; c3 anchors data-source-line="53".
    const blockSelectors = [
      '#reading-pane [data-source-line="4"]',
      '#reading-pane [data-source-line="4"]',
      '#reading-pane [data-source-line="53"]',
    ];
    for (let i = 0; i < 3; i++) {
      const typingFrom = (spTextTypes[i].frame as { fromMs: number }).fromMs;
      const blockPulse = TRAILHEAD_BEAT.find(
        (sf) =>
          sf.frame.t === "pulse" &&
          sf.frame.target === blockSelectors[i] &&
          sf.frame.toMs <= typingFrom + 200 && // the block pulse spans up to (around) when typing starts
          sf.frame.fromMs < typingFrom,
      );
      expect(blockPulse, `block emphasis pulse before c${i + 1} typing`).toBeDefined();
    }
  });

  it("after switching to V2 the open path is V2 and its comments are [] (highlights clear)", () => {
    for (const T of [V2_OPEN_MS, V2_OPEN_MS + 200, V2_OPEN_MS + 400]) {
      const at = projectSurfaceState(TRAILHEAD_BEAT, T);
      expect(at.openPlanPath).toBe(TRAILHEAD_MASTER_V2_PATH);
      // V2 has NO set_comments frame → comments scoped to the open path are empty (the V1 highlights
      // do not bleed onto the revised doc). FALSIFIABILITY: scope comments globally and this goes RED.
      expect(at.comments).toHaveLength(0);
      expect(at.activeTab).toBe("plan");
    }
  });

  it("a 'Comment & iterate' chapter label opens the chapter", () => {
    const labels = TRAILHEAD_BEAT.map((sf) => sf.chapterLabel).filter(Boolean);
    expect(labels).toContain("Comment & iterate");
  });

  it("the terminal result is STRICTLY last (highest tMs TERMINAL_MS) and clears working; nothing later", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    expect(duration).toBe(TERMINAL_MS);
    const later = TRAILHEAD_BEAT.filter((sf) => sf.tMs > duration);
    expect(later).toHaveLength(0);
    // Exactly ONE frame lands in (TERMINAL_MS-1, TERMINAL_MS] — the terminal result.
    const inWindow = TRAILHEAD_BEAT.filter((sf) => sf.tMs > TERMINAL_MS - 1 && sf.tMs <= TERMINAL_MS);
    expect(inWindow).toHaveLength(1);
    expect((inWindow[0].frame as { ev: { kind: string } }).ev.kind).toBe("result");
  });

  it("FINISHED THOUGHT — working non-null mid-Execution but null at TERMINAL_MS", () => {
    // Inside the Execution chapter (old 33000 + all shifts, before the terminal result) — still
    // generating, so working is live. FALSIFIABILITY: relocate the terminal to a non-last tMs and the
    // `working === null at duration` assertion goes RED (working stays non-null at the end).
    applyUpToTime(model, TRAILHEAD_BEAT, EXEC_BASE_MS + 6000);
    expect(model.derive().working).not.toBeNull();
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    expect(model.derive().working).toBeNull();
  });
});

// ---- (c5 — review2) IN-PROCESS "Request changes" review bar ------------------------------------
//
// review2 c5: the comment chapter was MISSING the review surface the real app shows at the TOP of the
// reading column. We now drive the REAL in-process #review-bar (VIEWING / IN-PROCESS mode → Submit
// "Request changes") for the OPEN master, THEN travel the cursor to "Request changes" + click. The bar
// must coexist with the inline comment highlights at the SAME T (the c5 invariant), Submit must be
// DISABLED at 0 comments and ENABLED at >=1 (applyReviewBarState keyed on the count), and the FAITHFUL
// source MUST be "in-process" (the EXTERNAL path yields "Submit" + would wipe highlights — falsified
// below). Live tMs = the COMMENT_AND_V2 literal + CMT_SHIFT (= PROTO_ACT_SHIFT + CLARIFIER_SHIFT +
// C4_SHIFT), exactly like the comment-chapter tests above.
describe("storyboard — (c5) in-process Request-changes review bar", () => {
  const CMT_SHIFT = PROTO_ACT_SHIFT + CLARIFIER_SHIFT + C4_SHIFT;
  const GATE_ON_MS = REVIEW_GATE_ON_MS + CMT_SHIFT;
  const GATE_OFF_MS = REVIEW_GATE_OFF_MS + CMT_SHIFT;
  const SUBMIT_MOVE_MS = REVIEW_SUBMIT_MOVE_MS + CMT_SHIFT;
  const SUBMIT_CLICK_MS = REVIEW_SUBMIT_CLICK_MS + CMT_SHIFT;
  const C3_PAINT_MS = 67800 + CMT_SHIFT; // the 3rd comment lands (count = 3)

  it("at the comment-chapter T the in-process review_gate is ON for the open master AND the inline highlights are present at the SAME T", () => {
    // THE c5 INVARIANT: pick a T AFTER all three comments land (count=3) and inside the gate window —
    // both the in-process gate (the "Request changes" bar) AND the comment highlights are live.
    const T = C3_PAINT_MS;
    const at = projectSurfaceState(TRAILHEAD_BEAT, T);
    // (1) the open plan is the master and (2) it carries all THREE comment records (the highlights).
    expect(at.openPlanPath).toBe(TRAILHEAD_MASTER_PATH);
    expect(at.comments).toHaveLength(3);
    // (3) the in-process review gate is ON for THAT SAME open plan (so viewingGate() matches without a
    // re-open). FALSIFIABILITY: drive the EXTERNAL pending-reviews path instead of review_gate and
    // at.reviewGate.on stays false → RED.
    expect(at.reviewGate.on).toBe(true);
    expect(at.reviewGate.planPath).toBe(TRAILHEAD_MASTER_PATH);

    // (4) the highlights actually PAINT: render the master + applyComments and count the .cmt-hl spans.
    const pane = document.createElement("div");
    pane.id = "reading-pane";
    document.body.appendChild(pane);
    renderInto(pane, TRAILHEAD_MASTER_DOC, "/Users/mock/.claude/plans");
    applyComments(pane, at.comments);
    expect(pane.querySelectorAll(".cmt-hl").length).toBeGreaterThanOrEqual(3);
    document.body.removeChild(pane);

    // (5) the REAL bar derivation at this T (in-process, 3 comments) → VISIBLE, "Request changes",
    // ENABLED. This is the production derivation main.ts feeds from orchSnapshot — the bar would render
    // exactly this. FALSIFIABILITY: source "external" → submitLabel "Submit" (asserted below).
    const bar = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 3, source: "in-process" });
    expect(bar.barVisible).toBe(true);
    expect(bar.submitLabel).toBe("Request changes");
    expect(bar.submitDisabled).toBe(false);
  });

  it("applyReviewBarState transitions Submit DISABLED→ENABLED keyed on the comment count (in-process)", () => {
    // 0 comments → DISABLED; >=1 → ENABLED. This is the disabled→enabled gate the comment-chapter beat
    // exercises (gate ON at 0 comments, then the three set_comments enable it). FALSIFIABILITY: if
    // submitDisabled were keyed on something other than the count (e.g. always false), the 0-comment
    // assertion goes RED.
    const at0 = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 0, source: "in-process" });
    expect(at0.barVisible).toBe(true);
    expect(at0.submitDisabled).toBe(true);
    expect(at0.submitLabel).toBe("Request changes");

    const at1 = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 1, source: "in-process" });
    expect(at1.submitDisabled).toBe(false);

    const at3 = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 3, source: "in-process" });
    expect(at3.submitDisabled).toBe(false);
  });

  it("FALSIFIABILITY — the EXTERNAL source yields 'Submit' (NOT 'Request changes'): the in-process source is load-bearing", () => {
    // The naive/wrong path (emitReviewRequested → source "external") produces the WRONG label. This
    // pins WHY the c5 surface must be in-process. If applyReviewBarState ever returned "Request changes"
    // for an external review, this goes RED.
    const ext = applyReviewBarState({ pendingCount: 1, viewing: true, viewedCommentCount: 3, source: "external" });
    expect(ext.submitLabel).toBe("Submit");
  });

  it("the gate window brackets the cursor's Request-changes click: ON < the 3rd comment < cursor click < OFF", () => {
    // Ordering: the bar appears BEFORE the comments finish, the cursor clicks "Request changes" while the
    // gate is still ON, and the gate clears AFTER the click (the user requested changes). The cursor
    // move/click target #review-submit — the REAL in-process bar button.
    expect(GATE_ON_MS).toBeLessThan(C3_PAINT_MS);
    expect(C3_PAINT_MS).toBeLessThan(SUBMIT_MOVE_MS);
    expect(SUBMIT_MOVE_MS).toBeLessThan(SUBMIT_CLICK_MS);
    expect(SUBMIT_CLICK_MS).toBeLessThan(GATE_OFF_MS);

    // The gate is ON across the click and OFF after it (pure projection of T).
    expect(projectSurfaceState(TRAILHEAD_BEAT, SUBMIT_CLICK_MS).reviewGate.on).toBe(true);
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_OFF_MS).reviewGate.on).toBe(false);

    // The cursor's move + click target #review-submit (the "Request changes" button).
    const moves = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "cursor_move" && sf.frame.target === "#review-submit");
    const clicks = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "cursor_click" && sf.frame.target === "#review-submit");
    // (one #review-submit move/click also lives in the prototype chapter — assert the c5 pair lands in
    // the comment-chapter window, after the gate turns on).
    expect(moves.some((sf) => sf.tMs >= GATE_ON_MS && sf.tMs <= GATE_OFF_MS)).toBe(true);
    expect(clicks.some((sf) => sf.tMs >= GATE_ON_MS && sf.tMs <= GATE_OFF_MS)).toBe(true);
  });

  it("after the gate turns OFF (and the master/V2 reveal) the review_gate is off at duration", () => {
    // A backward-revertible pure projection: the gate is OFF at the very end (no stuck in-process bar).
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).reviewGate.on).toBe(false);
    // And it was genuinely ON earlier (so the off-at-duration assertion is meaningful, not vacuous).
    expect(projectSurfaceState(TRAILHEAD_BEAT, C3_PAINT_MS).reviewGate.on).toBe(true);
  });
});

// ---- (P2) projectScroll — PURE scroll-timeline projection + scrub-revert ------------------------
//
// projectScroll(story, T) returns the active scroll window's {target, frac} lerped fromFrac→toFrac over
// [fromMs, toMs), or null outside any window. These tests pin to the named SCROLL_* constants and assert
// it is a PURE fn of T (scrub-forward-then-back yields the identical frac). FALSIFIABILITY (verified by
// hand): make projectScroll stateful/incremental (accumulate from the last call rather than re-derive
// from fromMs each call) and the scrub-revert property test goes RED — the back-scrub frac would carry
// forward-sweep state instead of matching the direct value.

describe("storyboard — (P2) projectScroll purity + scrub-revert", () => {
  // A self-contained two-window scroll story (down 0→1 then up 1→0) at the named constants, mirroring
  // the comment chapter's beat shape but isolated so the assertions don't depend on the full-beat tMs.
  const scrollStory: StoryFrame[] = [
    { tMs: C4_SCROLL_DOWN_FROM, frame: { t: "scroll", target: SCROLL_TARGET, fromFrac: 0, toFrac: 1, fromMs: C4_SCROLL_DOWN_FROM, toMs: C4_SCROLL_DOWN_TO } },
    { tMs: C4_SCROLL_UP_FROM, frame: { t: "scroll", target: SCROLL_TARGET, fromFrac: 1, toFrac: 0, fromMs: C4_SCROLL_UP_FROM, toMs: C4_SCROLL_UP_TO } },
  ];

  it("null OUTSIDE any window; exact frac at the window EDGES; lerped MID-window", () => {
    // Before the first window → null (no override).
    expect(projectScroll(scrollStory, C4_SCROLL_DOWN_FROM - 1)).toBeNull();
    // Down window: frac 0 at the start edge, 0.5 at the midpoint, near-1 just before the end edge.
    expect(projectScroll(scrollStory, C4_SCROLL_DOWN_FROM)).toEqual({ target: SCROLL_TARGET, frac: 0 });
    const downMid = (C4_SCROLL_DOWN_FROM + C4_SCROLL_DOWN_TO) / 2;
    expect(projectScroll(scrollStory, downMid)!.frac).toBeCloseTo(0.5, 5);
    // The end edge toMs is HALF-OPEN [fromMs, toMs): at toMs the down window no longer contains T. The
    // GAP between the down and up windows → null (no active window in the dwell).
    expect(projectScroll(scrollStory, C4_SCROLL_DOWN_TO)).toBeNull();
    expect(projectScroll(scrollStory, (C4_SCROLL_DOWN_TO + C4_SCROLL_UP_FROM) / 2)).toBeNull();
    // Up window: frac 1 at the start edge, 0.5 at the midpoint.
    expect(projectScroll(scrollStory, C4_SCROLL_UP_FROM)).toEqual({ target: SCROLL_TARGET, frac: 1 });
    const upMid = (C4_SCROLL_UP_FROM + C4_SCROLL_UP_TO) / 2;
    expect(projectScroll(scrollStory, upMid)!.frac).toBeCloseTo(0.5, 5);
    // After the last window → null again.
    expect(projectScroll(scrollStory, C4_SCROLL_UP_TO)).toBeNull();
    expect(projectScroll(scrollStory, C4_SCROLL_UP_TO + 1000)).toBeNull();
  });

  it("SCRUB-REVERT (property): evaluating at T after sweeping forward equals evaluating at T directly", () => {
    // A grid of forward sweep stops across both windows + the surrounding gaps, then for each early
    // target assert projectScroll(early) is IDENTICAL whether reached directly or after the sweep. Because
    // projectScroll is a pure re-derivation from the frame set (NOT an incremental accumulator), the two
    // are byte-identical. FALSIFIABILITY: a stateful/incremental implementation drifts here → RED.
    const lo = C4_SCROLL_DOWN_FROM - 500;
    const hi = C4_SCROLL_UP_TO + 500;
    const grid = Array.from({ length: 61 }, (_, i) => Math.round(lo + (i / 60) * (hi - lo)));
    const ser = (s: ReturnType<typeof projectScroll>): string => JSON.stringify(s ?? null);
    for (const earlyT of [lo, C4_SCROLL_DOWN_FROM, downMidOf(), C4_SCROLL_UP_FROM, hi]) {
      const direct = ser(projectScroll(scrollStory, earlyT));
      // "Sweep forward" is just evaluating across the grid (the fn is stateless), then evaluate at earlyT.
      for (const T of grid) projectScroll(scrollStory, T);
      const afterSweep = ser(projectScroll(scrollStory, earlyT));
      expect(afterSweep, `projectScroll(${earlyT}) forward-then-back == direct`).toBe(direct);
    }
    function downMidOf(): number {
      return (C4_SCROLL_DOWN_FROM + C4_SCROLL_DOWN_TO) / 2;
    }
  });

  it("the REAL TRAILHEAD_BEAT carries the c4 scroll beat over #reader-scroll (down 0→1 then up 1→0)", () => {
    const scrolls = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "scroll");
    expect(scrolls.length).toBe(2);
    for (const sf of scrolls) {
      expect((sf.frame as { target: string }).target).toBe(SCROLL_TARGET);
    }
    const down = scrolls.find((sf) => (sf.frame as { fromFrac: number; toFrac: number }).toFrac === 1);
    const up = scrolls.find((sf) => (sf.frame as { fromFrac: number; toFrac: number }).toFrac === 0);
    expect(down, "down-scroll 0→1").toBeDefined();
    expect(up, "up-scroll 1→0").toBeDefined();
    // The down beat precedes the up beat (down then back up), and BOTH precede the first comment paint.
    expect(down!.tMs).toBeLessThan(up!.tMs);
    // FALSIFIABILITY: drop the up-scroll frame and the `up` find goes undefined → RED.
  });

  it("(c4) the two scroll windows DO NOT overlap (projectScroll is last-window-wins)", () => {
    // The c4 beat replaced the generic slow-scroll with a down→up pair paired to the ToC-entry clicks.
    // If the two scroll windows overlapped, the later (up) window would silently mask the (down) one for
    // any T inside the overlap — projectScroll is last-active-window-wins. Assert the down window CLOSES
    // (toMs) at or before the up window OPENS (fromMs), in the LIVE shifted beat. FALSIFIABILITY: widen
    // C4_SCROLL_DOWN_TO past C4_SCROLL_UP_FROM and this goes RED.
    const scrolls = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "scroll");
    const down = scrolls.find((sf) => (sf.frame as { toFrac: number }).toFrac === 1)!.frame as { fromMs: number; toMs: number };
    const up = scrolls.find((sf) => (sf.frame as { toFrac: number }).toFrac === 0)!.frame as { fromMs: number; toMs: number };
    expect(down.toMs).toBeLessThanOrEqual(up.fromMs);
    // And there is NO T at which both windows are active (a direct overlap check across the union span).
    for (let T = down.fromMs; T < up.toMs; T += 50) {
      const inDown = down.fromMs <= T && T < down.toMs;
      const inUp = up.fromMs <= T && T < up.toMs;
      expect(inDown && inUp, `no overlap at T=${T}`).toBe(false);
    }
  });
});

// ---- (c4) Contents-tab ToC navigation beat — sidebar-tab projection + sequence ordering ---------
//
// (c4 — review2) BEFORE commenting, the demo clicks the SIDEBAR "Contents" tab (revealing the ToC),
// clicks a LOW ToC entry (pane scrolls down), clicks the "Context" ToC entry (pane scrolls back up),
// then restores the Plans tab. projectSidebarTab is a PURE last-≤-T fn (default "plans"); the cursor
// visibly targets the real `.toc-item` / tab elements. These tests pin the live (shifted) frame times.

describe("storyboard — (c4) Contents-tab ToC navigation beat", () => {
  // The c4 frames live in DOWNSTREAM_HEAD (literal < the comment-chapter boundary), so the splice .map
  // shifts them by + PROTO_ACT_SHIFT + CLARIFIER_SHIFT (NOT + C4_SHIFT — that extra is comment-chapter
  // only). The switch constants are authored in that literal space, so the LIVE time adds the head shift.
  const HEAD_SHIFT = PROTO_ACT_SHIFT + CLARIFIER_SHIFT;
  const CONTENTS_SWITCH_LIVE = C4_CONTENTS_TAB_SWITCH_MS + HEAD_SHIFT;
  const PLANS_SWITCH_LIVE = C4_PLANS_TAB_SWITCH_MS + HEAD_SHIFT;

  it("projectSidebarTab defaults to 'plans', flips to 'contents' at the Contents switch, restores 'plans'", () => {
    // Default before any sidebar_tab frame.
    expect(projectSidebarTab(TRAILHEAD_BEAT, 0)).toBe("plans");
    // Just BEFORE the Contents switch → still Plans.
    expect(projectSidebarTab(TRAILHEAD_BEAT, CONTENTS_SWITCH_LIVE - 1)).toBe("plans");
    // AT the Contents switch (and through the navigation) → Contents.
    expect(projectSidebarTab(TRAILHEAD_BEAT, CONTENTS_SWITCH_LIVE)).toBe("contents");
    expect(projectSidebarTab(TRAILHEAD_BEAT, PLANS_SWITCH_LIVE - 1)).toBe("contents");
    // AT the Plans restore (and through commenting) → Plans again.
    expect(projectSidebarTab(TRAILHEAD_BEAT, PLANS_SWITCH_LIVE)).toBe("plans");
    expect(projectSidebarTab(TRAILHEAD_BEAT, PLANS_SWITCH_LIVE + 5000)).toBe("plans");
    // FALSIFIABILITY: drop the "contents" sidebar_tab frame and the mid-window assertion goes RED (stays "plans").
  });

  it("SCRUB-REVERT (property): projectSidebarTab forward-then-back equals direct (pure last-≤-T)", () => {
    const grid = Array.from({ length: 41 }, (_, i) => Math.round((i / 40) * storyDurationMs(TRAILHEAD_BEAT)));
    for (const earlyT of [0, CONTENTS_SWITCH_LIVE, PLANS_SWITCH_LIVE, PLANS_SWITCH_LIVE + 1000]) {
      const direct = projectSidebarTab(TRAILHEAD_BEAT, earlyT);
      for (const T of grid) projectSidebarTab(TRAILHEAD_BEAT, T);
      expect(projectSidebarTab(TRAILHEAD_BEAT, earlyT)).toBe(direct);
    }
  });

  it("the c4 beat plays in order: Contents tab → low ToC entry (scroll down) → Context entry (scroll up) → Plans, all BEFORE the first comment", () => {
    // The cursor targets the REAL tab + .toc-item selectors, in order. Assert the move-to-Contents-tab
    // precedes the move-to-low-entry precedes the move-to-Context-entry precedes the move-to-Plans-tab,
    // and that the LAST of those precedes the first comment's #sp-text typing. FALSIFIABILITY: reorder the
    // Context-entry move after the Plans-tab move and the ordering chain goes RED.
    const moveTo = (sel: string): number | undefined =>
      TRAILHEAD_BEAT.find((sf) => sf.frame.t === "cursor_move" && sf.frame.target === sel)?.tMs;
    const contentsTab = moveTo(C4_CONTENTS_TAB_SELECTOR);
    const lowEntry = moveTo(C4_TOC_LOW_SELECTOR);
    const contextEntry = moveTo(C4_TOC_CONTEXT_SELECTOR);
    const plansTab = moveTo(C4_PLANS_TAB_SELECTOR);
    expect(contentsTab).toBeDefined();
    expect(lowEntry).toBeDefined();
    expect(contextEntry).toBeDefined();
    expect(plansTab).toBeDefined();
    expect(contentsTab!).toBeLessThan(lowEntry!);
    expect(lowEntry!).toBeLessThan(contextEntry!);
    expect(contextEntry!).toBeLessThan(plansTab!);
    // The whole c4 beat precedes the first comment's #sp-text typing.
    const firstCommentType = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "field_type" && sf.frame.target === "#sp-text",
    )!.tMs;
    expect(plansTab!).toBeLessThan(firstCommentType);
  });

  it("the LOW ToC entry's scroll is DOWN (0→1) and the Context entry's scroll is UP (1→0)", () => {
    // The down-scroll window is paired with (starts at/after) the low-entry click; the up-scroll window is
    // paired with the Context-entry click. Assert the down window opens AFTER the low-entry move and the up
    // window opens AFTER the Context-entry move. FALSIFIABILITY: swap the two scroll directions and this fails.
    const moveTo = (sel: string): number =>
      TRAILHEAD_BEAT.find((sf) => sf.frame.t === "cursor_move" && sf.frame.target === sel)!.tMs;
    const scrolls = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "scroll");
    const down = scrolls.find((sf) => (sf.frame as { toFrac: number }).toFrac === 1)!;
    const up = scrolls.find((sf) => (sf.frame as { toFrac: number }).toFrac === 0)!;
    expect(down.tMs).toBeGreaterThanOrEqual(moveTo(C4_TOC_LOW_SELECTOR));
    expect(up.tMs).toBeGreaterThanOrEqual(moveTo(C4_TOC_CONTEXT_SELECTOR));
    expect(down.tMs).toBeLessThan(up.tMs);
  });
});

// ---- TRAILHEAD_BEAT — "Execution" chapter (the FINAL beat, P5: per-subplan subagents) ----------
//
// (P5) The plan is approved → the assistant EXECUTES it as a SEQUENCE OF SUBAGENTS: subplans 01/02/03 +
// the 04.01–04.04 trail-detail leaves, EACH run via its OWN `Task` subagent (top-level Task tool_use +
// `subagent_started` label + 4–6 nested ATOMIC leaf tool calls + an in-group summary + a DEFERRED
// top-level Task tool_result that flips the spanning Task done — mirroring scope-recon). CONTEXT
// THREADING is now LITERAL: each subplan's deferred Task result names the ARTIFACT it produced, and the
// NEXT subplan's Task.input.prompt VERBATIM references that artifact (the falsifiable substring test).
// The chapter opens with a SURFACE open_plan{null} (EXEC_BASE_MS) → activeTab "conversation"; the
// terminal result (TERMINAL_SEQ / TERMINAL_MS) is strictly last and clears `working` (a finished thought).

// The seven subplan Task ids (the subagent group keys) + the prior-artifact name each subplan's Task
// prompt MUST reference, in EXECUTION ORDER. Each `priorArtifact` is the IMMEDIATELY-PRIOR subplan's
// produced artifact name — the literal substring the threading test asserts inside the later Task prompt.
const EXEC_SUBPLAN_TASK_IDS = [
  "toolu_th_exec_sp01",
  "toolu_th_exec_sp02",
  "toolu_th_exec_sp0401",
  "toolu_th_exec_sp0402",
  "toolu_th_exec_sp0403",
  "toolu_th_exec_sp0404",
  "toolu_th_exec_sp03",
] as const;
// The threading pairs: [laterTaskId, priorArtifactSubstring]. The later subplan's Task prompt MUST
// contain the prior subplan's produced-artifact name VERBATIM. (03 threads from 02; the 04.* chain
// threads 01→04.01→04.02→04.03→04.04 — each entry pins a real artifact handoff.)
const EXEC_THREADING: ReadonlyArray<readonly [string, string]> = [
  ["toolu_th_exec_sp02", "TrailRepository"], // 02 builds on 01's TrailRepository
  ["toolu_th_exec_sp03", "MapScreen.tsx"], // 03 builds on 02's MapScreen
  ["toolu_th_exec_sp0401", "TrailRepository"], // 04.01 reuses 01's palette (in TrailRepository)
  ["toolu_th_exec_sp0402", "<DifficultyBadge>"], // 04.02 reuses 04.01's badge
  ["toolu_th_exec_sp0403", "ElevationChart.tsx"], // 04.03 wires 04.02's chart
  ["toolu_th_exec_sp0404", "Reviews.tsx"], // 04.04 surfaces 04.03's reviews
];

// Find a raw storyboard frame by predicate over its conv ev.
function findConvFrame(pred: (ev: Record<string, unknown>) => boolean): StoryFrame | undefined {
  return TRAILHEAD_BEAT.find(
    (sf) => sf.frame.t === "conv" && pred((sf.frame as unknown as { ev: Record<string, unknown> }).ev),
  );
}

describe("storyboard — TRAILHEAD_BEAT execution chapter (the final beat)", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  it("(P5 a) each subplan is a Task subagent group with >=4 nested ATOMIC leaf tools, all parented to its Task id", () => {
    // For each subplan Task id: (1) a top-level Task tool_use exists; (2) >=4 nested LEAF tool pairs carry
    // parent_tool_use_id = that Task id; (3) each leaf tool_use shares its tMs with its matching
    // tool_result (atomic — no lingering "running" leaf). FALSIFIABILITY: drop a leaf's tool_result, or
    // split it to a later tMs, and the atomic/count assertion goes RED.
    for (const taskId of EXEC_SUBPLAN_TASK_IDS) {
      // (1) the top-level Task tool_use.
      const taskUse = findConvFrame((ev) => ev.kind === "tool_use" && ev.id === taskId && ev.tool === "Task");
      expect(taskUse, `Task tool_use for ${taskId}`).toBeDefined();
      expect((taskUse!.frame as { ev: { parent_tool_use_id: string | null } }).ev.parent_tool_use_id).toBeNull();

      // (2) the nested leaf tool_use frames (parent = taskId).
      const leafUses = TRAILHEAD_BEAT.filter((sf) => {
        if (sf.frame.t !== "conv") return false;
        const ev = (sf.frame as { ev: { kind: string; parent_tool_use_id: string | null; tool?: string } }).ev;
        return ev.kind === "tool_use" && ev.parent_tool_use_id === taskId;
      });
      expect(leafUses.length, `leaf tool_use count for ${taskId}`).toBeGreaterThanOrEqual(4);

      // (3) each leaf is atomic: its tool_result shares the SAME tMs (and same parent).
      for (const useSf of leafUses) {
        const useEv = (useSf.frame as { ev: { id: string } }).ev;
        const resultSf = TRAILHEAD_BEAT.find(
          (sf) => sf.frame.t === "conv" && (sf.frame as { ev: { kind: string; tool_use_id?: string } }).ev.kind === "tool_result" && (sf.frame as { ev: { tool_use_id?: string } }).ev.tool_use_id === useEv.id,
        );
        expect(resultSf, `tool_result for leaf ${useEv.id}`).toBeDefined();
        expect(resultSf!.tMs, `atomic tMs for leaf ${useEv.id}`).toBe(useSf.tMs);
        expect(
          (resultSf!.frame as { ev: { parent_tool_use_id: string | null } }).ev.parent_tool_use_id,
        ).toBe(taskId);
      }
    }
  });

  it("(P5 a-derived) each subplan derives as a LABELED subagent group with >=4 child tool nodes, none running at duration", () => {
    // Derive the WHOLE beat at duration. There must be one subagent group per Execution Task id, each with
    // >=4 child tool nodes, and (recursive no-stuck) none of those child tools left 'running'.
    // FALSIFIABILITY: remove a subplan's leaves and the >=4 child-count goes RED.
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const groups = model.derive().nodes.filter((n) => n.type === "subagent") as Array<{
      type: string;
      agentId: string;
      children: Array<{ type: string; status?: string }>;
    }>;
    const byId = new Map(groups.map((g) => [g.agentId, g]));
    for (const taskId of EXEC_SUBPLAN_TASK_IDS) {
      const g = byId.get(taskId);
      expect(g, `subagent group for ${taskId}`).toBeDefined();
      const childTools = g!.children.filter((c) => c.type === "tool");
      expect(childTools.length, `child tools for ${taskId}`).toBeGreaterThanOrEqual(4);
      for (const c of childTools) expect(c.status).not.toBe("running");
    }
  });

  it("(P5 b) each subplan has a DEFERRED top-level Task tool_result (no stuck Task at duration)", () => {
    // The DEFERRED result: a top-level tool_result whose tool_use_id = the Task id (parent null). It flips
    // the spanning Task running→done. FALSIFIABILITY: delete a subplan's deferred Task tool_result and
    // that Task node is left 'running' at duration (and this assertion + the no-stuck invariant go RED).
    for (const taskId of EXEC_SUBPLAN_TASK_IDS) {
      const deferred = findConvFrame(
        (ev) => ev.kind === "tool_result" && ev.tool_use_id === taskId && ev.parent_tool_use_id === null,
      );
      expect(deferred, `deferred Task tool_result for ${taskId}`).toBeDefined();
    }
    // And at duration the Task tool nodes are NOT running (deferred results flipped them done).
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const taskNodes = model
      .derive()
      .nodes.filter((n) => n.type === "tool" && (n as { tool?: string }).tool === "Task");
    for (const t of taskNodes) expect((t as { status: string }).status).not.toBe("running");
  });

  it("(P5 c) CONTEXT THREADING — each later subplan's Task prompt VERBATIM contains the prior subplan's artifact name", () => {
    // The literal handoff: the later subplan's Task.input.prompt string CONTAINS the prior subplan's
    // produced-artifact name (e.g. 02's prompt contains "TrailRepository", 04.02's contains
    // "<DifficultyBadge>"). FALSIFIABILITY: change a prompt to drop the prior artifact name (or rename the
    // artifact in only one place) and the substring assertion goes RED.
    for (const [laterTaskId, priorArtifact] of EXEC_THREADING) {
      const taskUse = findConvFrame((ev) => ev.kind === "tool_use" && ev.id === laterTaskId && ev.tool === "Task");
      expect(taskUse, `Task tool_use for ${laterTaskId}`).toBeDefined();
      const prompt = (taskUse!.frame as { ev: { input: { prompt: string } } }).ev.input.prompt;
      expect(prompt, `${laterTaskId} prompt threading ${priorArtifact}`).toContain(priorArtifact);
    }
  });

  it("projectSurfaceState: openPlanPath null + activeTab 'conversation' for the Execution chapter (incl. duration)", () => {
    // (P5) The Execution chapter is built directly at FINAL tMs from EXEC_BASE_MS — its first frame is the
    // SURFACE open_plan{null} that closes the V2 master and flips activeTab → conversation for the rest of
    // the beat. Sample the open, a couple of mid-execution Ts, and the duration.
    const execOpenNull = EXEC_BASE_MS; // the Execution open_plan{null} (first Execution frame).
    for (const T of [execOpenNull, EXEC_BASE_MS + 12000, EXEC_BASE_MS + 24000, storyDurationMs(TRAILHEAD_BEAT)]) {
      const at = projectSurfaceState(TRAILHEAD_BEAT, T);
      expect(at.openPlanPath).toBeNull();
      expect(at.activeTab).toBe("conversation");
    }
    // And just BEFORE the Execution open_plan{null} the V2 master is still open on the Plan tab.
    const at = projectSurfaceState(TRAILHEAD_BEAT, execOpenNull - 1);
    expect(at.openPlanPath).toBe(TRAILHEAD_MASTER_V2_PATH);
    expect(at.activeTab).toBe("plan");
  });

  it("an 'Execution' chapter label opens the chapter; the terminal 'Done' is strictly last", () => {
    const labels = TRAILHEAD_BEAT.map((sf) => sf.chapterLabel).filter(Boolean);
    expect(labels).toContain("Execution");
    // The terminal result is the strictly highest-tMs frame AND a `result` kind.
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    const later = TRAILHEAD_BEAT.filter((sf) => sf.tMs > duration);
    expect(later).toHaveLength(0);
    const last = TRAILHEAD_BEAT.reduce((a, b) => (b.tMs >= a.tMs ? b : a));
    expect(last.tMs).toBe(duration);
    expect((last.frame as { ev: { kind: string } }).ev.kind).toBe("result");
  });

  it("NO STUCK TOOL (recursive) at duration AND finished thought (working null at terminal, non-null mid-Execution)", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    // Recursive no-stuck-tool: flatten subagent groups; no tool is 'running' at duration.
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    const running = model
      .derive()
      .nodes.flatMap((n) => (n.type === "subagent" ? n.children : [n]))
      .filter((t) => t.type === "tool" && (t as { status: string }).status === "running");
    expect(running).toHaveLength(0);
    // Finished thought: working is live mid-Execution (old 33000 + all shifts) and null once the terminal lands.
    applyUpToTime(model, TRAILHEAD_BEAT, EXEC_BASE_MS + 6000);
    expect(model.derive().working).not.toBeNull();
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    expect(model.derive().working).toBeNull();
  });
});

// ---- TRAILHEAD comment quotes anchor as inline highlights (the KEY falsifiable test) ----------
//
// The reconciler's reading-pane rebuild is: renderInto(pane, markdown, dir) then applyComments(pane,
// records). This test exercises that EXACT real path in jsdom: render the V1 master through the real
// `renderInto`, then apply the storyboard's comment records via the real `applyComments`, and count the
// resulting `.cmt-hl[data-c]` highlight GROUPS. Each comment's quote is verbatim V1 PROSE (outside the
// ```mermaid fence), so each anchors to exactly one group. Rendering V2 with [] yields zero highlights.

describe("storyboard — comment quotes anchor as .cmt-hl highlights (real renderInto + applyComments)", () => {
  function renderPane(markdown: string): HTMLElement {
    const pane = document.createElement("div");
    pane.id = "reading-pane";
    document.body.appendChild(pane);
    renderInto(pane, markdown, "/Users/mock/.claude/plans");
    return pane;
  }

  // Count DISTINCT highlight groups (a multi-element selection yields sibling spans sharing one data-c).
  function highlightGroups(pane: HTMLElement): number {
    const ids = new Set<string>();
    for (const span of pane.querySelectorAll<HTMLElement>(".cmt-hl[data-c]")) {
      ids.add(span.dataset.c ?? "");
    }
    return ids.size;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("applying [c1] → 1 highlight, [c1,c2] → 2, [c1,c2,c3] → 3 on the V1 master", () => {
    const one = renderPane(TRAILHEAD_MASTER_DOC);
    applyComments(one, [TRAILHEAD_COMMENT_1]);
    expect(highlightGroups(one)).toBe(1);

    const two = renderPane(TRAILHEAD_MASTER_DOC);
    applyComments(two, [TRAILHEAD_COMMENT_1, TRAILHEAD_COMMENT_2]);
    expect(highlightGroups(two)).toBe(2);

    const three = renderPane(TRAILHEAD_MASTER_DOC);
    applyComments(three, [TRAILHEAD_COMMENT_1, TRAILHEAD_COMMENT_2, TRAILHEAD_COMMENT_3]);
    // All three quotes are verbatim V1 prose → all three anchor. FALSIFIABILITY: swap any quote for text
    // that does NOT occur in the rendered prose (a nonexistent phrase, or whitespace findRangeForRecord
    // can't locate) and that record silently fails to anchor → this drops below 3 → RED (verified by
    // temporarily replacing TRAILHEAD_COMMENT_3.quote with a nonexistent phrase: count fell 3 → 2).
    expect(highlightGroups(three)).toBe(3);
  });

  it("rendering the REVISED master (V2) with [] comments yields zero .cmt-hl highlights", () => {
    const pane = renderPane(TRAILHEAD_MASTER_V2_DOC);
    applyComments(pane, []);
    expect(highlightGroups(pane)).toBe(0);
  });

  // The block (the nearest enclosing element with [data-source-line]) that the highlight for `record`
  // resolves into — applying ONLY that record so the single resulting .cmt-hl group is unambiguous.
  function blockOfHighlight(record: CommentRecord): HTMLElement | null {
    const pane = renderPane(TRAILHEAD_MASTER_DOC);
    applyComments(pane, [record]);
    const span = pane.querySelector<HTMLElement>(".cmt-hl[data-c]");
    if (span === null) return null;
    return span.closest<HTMLElement>("[data-source-line]");
  }

  it("STRENGTHENED — each comment highlight resolves into its INTENDED prose block (not merely count==3)", () => {
    // The reading-pane block each quote lives in, asserted by the block's TEXT (robust to source-line
    // renumbering) AND its tag. This is stronger than counting: it proves the highlight anchored to the
    // RIGHT prose, so a richer-mermaid rewrite that accidentally duplicated a quote substring earlier in
    // the prose (re-anchoring it to the wrong block) would FAIL here even while the count stayed 3.

    // c1 + c2 both live in the Context paragraph (the <p> after "## Context").
    const c1Block = blockOfHighlight(TRAILHEAD_COMMENT_1);
    expect(c1Block).not.toBeNull();
    expect(c1Block!.tagName).toBe("P");
    expect((c1Block!.textContent ?? "")).toContain("decomposes the build into four subplans");

    const c2Block = blockOfHighlight(TRAILHEAD_COMMENT_2);
    expect(c2Block).not.toBeNull();
    expect(c2Block!.tagName).toBe("P");
    expect((c2Block!.textContent ?? "")).toContain("the difficulty-badge work the reviewer asked for has a home");
    // c1 + c2 anchor to the SAME Context paragraph (the source-line is identical).
    expect(c2Block!.getAttribute("data-source-line")).toBe(c1Block!.getAttribute("data-source-line"));

    // c3 lives in the CLOSING paragraph — a DISTINCT block from c1/c2.
    const c3Block = blockOfHighlight(TRAILHEAD_COMMENT_3);
    expect(c3Block).not.toBeNull();
    expect(c3Block!.tagName).toBe("P");
    expect((c3Block!.textContent ?? "")).toContain("Subplans run in order");
    expect(c3Block!.getAttribute("data-source-line")).not.toBe(c1Block!.getAttribute("data-source-line"));

    // FALSIFIABILITY: confirmed by temporarily duplicating "Subplans run in order" into the Context
    // paragraph — c3 then re-anchored to the Context <p> (its source-line matched c1's) and the
    // distinct-block assertion above flipped RED while the count==3 test stayed green.
  });
});

// ---- Token reveal (pure fn of T) ---------------------------------------------------------------
//
// A single revealMs assistant_text frame streams a PREFIX of its text while tMs <= T < tMs+revealMs,
// the full text once past the window. The prefix length is a pure fn of T (floor of the linear
// fraction × full length). The two TRAILHEAD_BEAT text frames carry revealMs so the demo streams.

describe("storyboard — token reveal", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  // The FIRST node is now a USER kickoff (seq 1, lands after the composer beat); the first STREAMING
  // assistant_text is seq 2 (the "Happy to…" reply), at B1_REPLY_MS with revealMs 900. Target it by seq 2.
  const REVEAL_TMS = B1_REPLY_MS;
  const REVEAL_MS = 900;
  const FULL = "Happy to. One quick question before I scope the codebase.";

  function textNodeAtSeq(seq: number): string {
    return (
      (model.derive().nodes.find((n) => n.type === "text" && n.seq === seq) as
        | { text: string }
        | undefined)?.text ?? ""
    );
  }

  it("reveals a PREFIX at mid-window T and the FULL text past the window", () => {
    // Mid-window: half-way through the [REVEAL_TMS, REVEAL_TMS+REVEAL_MS) reveal window → ~half the chars.
    const T = REVEAL_TMS + Math.floor(REVEAL_MS / 2);
    applyUpToTime(model, TRAILHEAD_BEAT, T);
    const midText = textNodeAtSeq(2);
    // EXACT slice — the same linear floor the player uses. FALSIFIABLE: a wrong divisor here makes the
    // expected cut diverge from the player's, and this assertion goes RED.
    const expectedCut = Math.floor(((T - REVEAL_TMS) / REVEAL_MS) * FULL.length);
    expect(midText).toBe(FULL.slice(0, expectedCut));
    expect(midText.length).toBeGreaterThan(0);
    expect(midText.length).toBeLessThan(FULL.length);

    // Past the window: T=1800 (end of [900,1800)) → the full text (no more streaming).
    applyUpToTime(model, TRAILHEAD_BEAT, REVEAL_TMS + REVEAL_MS);
    expect(textNodeAtSeq(2)).toBe(FULL);
  });

  it("modelSignature changes as the reveal prefix grows but is identical at the same T", () => {
    const mid = REVEAL_TMS + Math.floor(REVEAL_MS / 2);
    // Same T twice → identical signature.
    expect(modelSignature(TRAILHEAD_BEAT, mid)).toBe(modelSignature(TRAILHEAD_BEAT, mid));
    // A later mid-window T reveals more chars → a different signature.
    expect(modelSignature(TRAILHEAD_BEAT, mid)).not.toBe(modelSignature(TRAILHEAD_BEAT, mid + 150));
  });
});

// ---- Backward seek == from-zero rebuild --------------------------------------------------------

describe("storyboard — backward seek equals from-zero rebuild", () => {
  it("scrubbing forward then back to T equals a fresh rebuild at T (no residue)", () => {
    // T inside the seq-2 reveal window [B1_REPLY_MS, +900) — a mid-stream prefix, richer than an idle T.
    const T = B1_REPLY_MS + 450;
    const forward = new ConversationModel();
    applyUpToTime(forward, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)); // go to the end…
    applyUpToTime(forward, TRAILHEAD_BEAT, T); // …then scrub back to T.

    const fresh = new ConversationModel();
    applyUpToTime(fresh, TRAILHEAD_BEAT, T); // a from-zero rebuild at T.

    expect(JSON.stringify(forward.derive().nodes)).toBe(JSON.stringify(fresh.derive().nodes));
  });
});

// ---- (P6) Overlay projections are PURE fns of T — scrub-revert across the WHOLE timeline ----------
//
// EXTENDS the backward-seek-equals-rebuild guarantee (above, for the conversation MODEL) to the new
// overlay PROJECTIONS. The conversation model is rebuilt from scratch each apply; the overlay
// projections (projectPulseSet / projectCursorState / projectFieldText / projectModalState) are
// likewise full re-derivations from the frame set, so each is a pure fn of (story, T) alone — its value
// at T must NOT depend on whether a LATER T was evaluated first. We assert exactly that: for a
// representative sweep across [0, TERMINAL_MS], evaluating at T AFTER first evaluating at a later T (the
// "forward-then-back" path) deep-equals evaluating at T directly. Since the fns are stateless this is
// trivially true today — the test's value is as a TRIPWIRE: introduce any order-dependence (e.g. a
// mutable module-level cache memoizing the last-seen state) and it goes RED.
//
// FALSIFIABILITY (verified): temporarily wrapping projectModalState with a module-level `let last` that
// returns the cached value when `T < lastT` (a forward-delta accumulator instead of a re-derivation)
// makes the forward-then-back result for an EARLIER T differ from the direct result → this test goes
// RED. Restoring the pure projection turns it green again. Confirmed locally before commit.
describe("storyboard — (P6) overlay projections are pure fns of T (forward-then-back == direct)", () => {
  // Serialize each projection's result into a stable, deep-comparable string. Set/Map have no useful
  // JSON.stringify, so normalize them to SORTED arrays of entries (order-independent equality).
  const serPulse = (s: ReadonlySet<string>): string =>
    JSON.stringify([...s].sort());
  const serField = (m: ReadonlyMap<string, string>): string =>
    JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const serCursor = (c: ReturnType<typeof projectCursorState>): string => JSON.stringify(c);
  const serModal = (m: ReturnType<typeof projectModalState>): string => JSON.stringify(m);

  // A representative sweep of T across the whole TRAILHEAD_BEAT timeline: the two endpoints plus an even
  // grid of interior samples (lands inside typing windows, cursor moves, gate brackets, comment acts).
  function sweepTimes(): number[] {
    const end = TERMINAL_MS;
    const grid = Array.from({ length: 41 }, (_, i) => Math.round((i / 40) * end));
    // Dedupe + ensure 0 and TERMINAL_MS are present, ascending.
    return [...new Set([0, ...grid, end])].sort((a, b) => a - b);
  }

  it("projectPulseSet/CursorState/FieldText/ModalState: evaluating at T after a LATER T equals direct", () => {
    const times = sweepTimes();
    // The "direct" baseline: each projection at each T, computed from a fresh scan (no prior eval).
    const direct = times.map((T) => ({
      T,
      pulse: serPulse(projectPulseSet(TRAILHEAD_BEAT, T)),
      cursor: serCursor(projectCursorState(TRAILHEAD_BEAT, T)),
      field: serField(projectFieldText(TRAILHEAD_BEAT, T)),
      modal: serModal(projectModalState(TRAILHEAD_BEAT, T)),
    }));

    // Forward-then-back: sweep ALL the way to TERMINAL_MS first (the "latest" eval), then walk BACK down
    // through every T in DESCENDING order, re-evaluating each. A pure fn yields the same value as direct;
    // any order-dependence (a stateful cache) would diverge on this back-walk.
    for (let i = times.length - 1; i >= 0; i--) {
      const T = times[i];
      // Touch a strictly-later T first (when one exists) so this T is evaluated AFTER a later one.
      if (i + 1 < times.length) {
        const later = times[i + 1];
        projectPulseSet(TRAILHEAD_BEAT, later);
        projectCursorState(TRAILHEAD_BEAT, later);
        projectFieldText(TRAILHEAD_BEAT, later);
        projectModalState(TRAILHEAD_BEAT, later);
      }
      const back = {
        pulse: serPulse(projectPulseSet(TRAILHEAD_BEAT, T)),
        cursor: serCursor(projectCursorState(TRAILHEAD_BEAT, T)),
        field: serField(projectFieldText(TRAILHEAD_BEAT, T)),
        modal: serModal(projectModalState(TRAILHEAD_BEAT, T)),
      };
      const want = direct[i];
      expect(back.pulse, `projectPulseSet purity at T=${T}`).toBe(want.pulse);
      expect(back.cursor, `projectCursorState purity at T=${T}`).toBe(want.cursor);
      expect(back.field, `projectFieldText purity at T=${T}`).toBe(want.field);
      expect(back.modal, `projectModalState purity at T=${T}`).toBe(want.modal);
    }
  });
});

// ---- Model-direct variants (question / user / system / permission_resolved) --------------------
//
// A small fixture story exercising each new ModelFrame variant. The QUESTION INVARIANT holds:
// request.seq (1) < answer.seq (3) AND request.tMs (1000) <= answer.tMs (3000). The user_message (seq
// 2) and a closing result (seq 4) round out the turn.

const QUESTION_ID = "toolu_ask_1";

function askRequest(): ToolPermissionRequested {
  return {
    seq: 1,
    kind: "tool_permission_requested",
    id: QUESTION_ID,
    tool: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Pick a color",
          header: "Color",
          options: [
            { label: "Red" },
            { label: "Blue" },
          ],
          multiSelect: false,
        },
      ],
    },
    agent_id: null,
  };
}

const VARIANT_STORY: StoryFrame[] = [
  { tMs: 1000, frame: { t: "question_request", ev: askRequest() } },
  { tMs: 2000, frame: { t: "user_message", text: "I prefer blue", seq: 2 } },
  { tMs: 3000, frame: { t: "question_answered", id: QUESTION_ID, answers: { "Pick a color": "Blue" }, seq: 3 } },
  { tMs: 3500, frame: { t: "system_message", text: "[system: tool completed]", seq: 3.5 } },
  // The held permission resolved + a terminal result so the turn finishes (working clears).
  { tMs: 4000, frame: { t: "permission_resolved", id: QUESTION_ID, seq: 4 } },
  {
    tMs: 4500,
    frame: {
      t: "conv",
      ev: {
        seq: 5,
        kind: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        num_turns: 1,
        duration_ms: 1,
        total_cost_usd: 0,
        session_id: "s",
      },
    },
  },
];

describe("storyboard — model-direct variants under reset+replay", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  it("question folds onto ONE node (no dup) once answered, and no stuck Waiting…", () => {
    // While only the request is in (T between request.tMs and answer.tMs), the form is OPEN and the
    // working indicator says Waiting for your input.
    applyUpToTime(model, VARIANT_STORY, 2500);
    const open = model.derive();
    const qNodesOpen = open.nodes.filter((n) => n.type === "question_request");
    expect(qNodesOpen).toHaveLength(1);
    expect((qNodesOpen[0] as { answers: unknown }).answers).toBeNull();
    expect(open.working?.label).toBe(WAITING_INPUT_LABEL);

    // After the answer + resolve + result, there is STILL exactly one question node (folded, not
    // duplicated), it carries the answers, and the working indicator is gone (no stuck Waiting…).
    applyUpToTime(model, VARIANT_STORY, storyDurationMs(VARIANT_STORY));
    const done = model.derive();
    const qNodesDone = done.nodes.filter((n) => n.type === "question_request");
    expect(qNodesDone).toHaveLength(1);
    expect((qNodesDone[0] as { answers: unknown }).answers).toEqual({ "Pick a color": "Blue" });
    expect(done.working).toBeNull();
  });

  it("user_message + system_message produce standalone nodes", () => {
    applyUpToTime(model, VARIANT_STORY, storyDurationMs(VARIANT_STORY));
    const nodes = model.derive().nodes;
    expect(nodes.filter((n) => n.type === "user")).toHaveLength(1);
    expect((nodes.find((n) => n.type === "user") as { text: string }).text).toBe("I prefer blue");
    expect(nodes.filter((n) => n.type === "system")).toHaveLength(1);
  });

  it("backward seek re-shows the OPEN question form (request without answer)", () => {
    // Forward to the answered state…
    applyUpToTime(model, VARIANT_STORY, storyDurationMs(VARIANT_STORY));
    expect((model.derive().nodes.find((n) => n.type === "question_request") as { answers: unknown }).answers).not.toBeNull();
    // …then scrub BACK to before the answer: the form is OPEN again (answers null) — a from-scratch
    // rebuild dropped the later question_answered frame.
    applyUpToTime(model, VARIANT_STORY, 1500);
    const back = model.derive();
    const q = back.nodes.find((n) => n.type === "question_request") as { answers: unknown };
    expect(q.answers).toBeNull();
    expect(back.working?.label).toBe(WAITING_INPUT_LABEL);
  });

  it("QUESTION INVARIANT holds for the fixture (request before answer in seq AND tMs)", () => {
    const reqSf = VARIANT_STORY.find((s) => s.frame.t === "question_request")!;
    const ansSf = VARIANT_STORY.find((s) => s.frame.t === "question_answered")!;
    const reqSeq = (reqSf.frame as { ev: { seq: number } }).ev.seq;
    const ansSeq = (ansSf.frame as { seq: number }).seq;
    expect(reqSeq).toBeLessThan(ansSeq);
    expect(reqSf.tMs).toBeLessThanOrEqual(ansSf.tMs);
  });
});

// ---- Model memo: terminal result entering yields working===null --------------------------------

describe("storyboard — model memo & terminal result", () => {
  it("modelSignature differs the instant ONLY the terminal result newly enters, and working derives null", () => {
    const beforeResult = storyDurationMs(TRAILHEAD_BEAT) - 1; // 39999 — every frame but the result.
    const atResult = storyDurationMs(TRAILHEAD_BEAT); // 40000 — the terminal result lands.

    // The signature MUST change when the terminal result enters the ≤T frame set (so the reconciler
    // re-renders the now-complete turn). FALSIFIABILITY: if modelSignature ignored non-tool frames the
    // result would not bump the count and these would be equal → the memo would skip the final render.
    expect(modelSignature(TRAILHEAD_BEAT, beforeResult)).not.toBe(modelSignature(TRAILHEAD_BEAT, atResult));

    const model = new ConversationModel();
    applyUpToTime(model, TRAILHEAD_BEAT, atResult);
    expect(model.derive().working).toBeNull();
  });
});

// ---- Surface projection (pure) -----------------------------------------------------------------

describe("storyboard — projectSurfaceState purity + reversion", () => {
  const PLAN = "/Users/mock/.claude/plans/x.md";

  function cmt(id: number): CommentRecord {
    return { quote: `q${id}`, block_line: null, block_end_line: null, occurrence: 0, comment: `c${id}`, id };
  }

  const SURFACE_STORY: StoryFrame[] = [
    { tMs: 0, frame: { t: "open_plan", path: PLAN } },
    { tMs: 100, frame: { t: "set_comments", path: PLAN, comments: [cmt(1), cmt(2), cmt(3)] } },
    { tMs: 200, frame: { t: "set_comments", path: PLAN, comments: [] } },
    { tMs: 300, frame: { t: "prototype_gate", on: true, round: 2 } },
  ];

  it("is PURE — same (story, T) twice yields a deep-equal state", () => {
    const a = projectSurfaceState(SURFACE_STORY, 150);
    const b = projectSurfaceState(SURFACE_STORY, 150);
    expect(a).toEqual(b);
  });

  it("activeTab is 'plan' when a plan is open and 'conversation' otherwise", () => {
    expect(projectSurfaceState(SURFACE_STORY, 0).activeTab).toBe("plan");
    // Before any open_plan, no plan is open → conversation tab.
    expect(projectSurfaceState(SURFACE_STORY, -1).activeTab).toBe("conversation");
  });

  it("reverts 3 comments → 0 across the set_comments frames", () => {
    expect(projectSurfaceState(SURFACE_STORY, 150).comments).toHaveLength(3);
    expect(projectSurfaceState(SURFACE_STORY, 250).comments).toHaveLength(0);
    // And a backward scrub to T=150 re-shows all 3 (pure fn of T).
    expect(projectSurfaceState(SURFACE_STORY, 150).comments).toHaveLength(3);
  });

  it("prototypeGate is the last-≤-T value (off before the frame, on after)", () => {
    expect(projectSurfaceState(SURFACE_STORY, 250).prototypeGate.on).toBe(false);
    const at = projectSurfaceState(SURFACE_STORY, 300).prototypeGate;
    expect(at.on).toBe(true);
    expect(at.round).toBe(2);
  });

  it("plans falls back to the fixture seed before any plan_changed", () => {
    const seed = clonePlans().map((p) => p.absolute_path);
    expect(projectSurfaceState(SURFACE_STORY, 300).plans.map((p) => p.absolute_path)).toEqual(seed);
  });

  it("plan_changed projects the full set and reverts on rewind", () => {
    const custom: PlanRecord[] = clonePlans().slice(0, 1);
    const story: StoryFrame[] = [
      { tMs: 100, frame: { t: "plan_changed", plans: custom } },
    ];
    expect(projectSurfaceState(story, 100).plans.map((p) => p.absolute_path)).toEqual(custom.map((p) => p.absolute_path));
    // Rewind before the frame → seed fallback (full length again).
    expect(projectSurfaceState(story, 0).plans.length).toBe(clonePlans().length);
  });

  it("pendingReviews projects the full set", () => {
    const rev: ReviewRequest[] = [
      {
        schema: 1,
        review_id: "r1",
        session_id: "s",
        cwd: "/Users/mock/work",
        transcript_path: "/Users/mock/.claude/projects/x/r1.jsonl",
        plan_text: "# r1",
        plan_file_path: PLAN,
        created_ms: 1,
      },
    ];
    const story: StoryFrame[] = [{ tMs: 50, frame: { t: "pending_reviews", reviews: rev } }];
    expect(projectSurfaceState(story, 50).pendingReviews).toHaveLength(1);
    expect(projectSurfaceState(story, 0).pendingReviews).toHaveLength(0);
  });
});

// ---- Overlay projections (PURE fns of (story, T)) ----------------------------------------------
//
// P0 of the mock-animate fidelity rewrite: four pure projections of the new OverlayFrame family
// (pulse / cursor / field_type / overlay_modal). Each is a full re-derivation from the frame set so it
// scrubs forward AND backward cleanly. NO DOM — selectors stay symbolic (resolved to pixels later in
// the reconciler). Every assertion below was verified FALSIFIABLE: after writing it, the cited
// projection inversion was applied, the test was confirmed to go RED, then the projection was restored.

describe("storyboard — projectPulseSet (additive half-open windows)", () => {
  // Two pulses; the second OVERLAPS the first so an interior T can have BOTH present (additive, not
  // last-≤-T). tMs on the StoryFrame is irrelevant to the pulse window — fromMs/toMs are intrinsic.
  const STORY: StoryFrame[] = [
    { tMs: 0, frame: { t: "pulse", target: "#a", fromMs: 100, toMs: 300 } },
    { tMs: 0, frame: { t: "pulse", target: "#b", fromMs: 250, toMs: 500 } },
  ];

  it("includes a target iff fromMs <= T < toMs (half-open), at BOTH edges", () => {
    // Before the window → absent.
    expect(projectPulseSet(STORY, 99).has("#a")).toBe(false);
    // At fromMs (inclusive lower edge) → present.
    // FALSIFIABILITY: flipping the lower guard `fromMs <= T` to `fromMs < T` makes T=100 drop #a → RED.
    expect(projectPulseSet(STORY, 100).has("#a")).toBe(true);
    // Strictly inside → present.
    expect(projectPulseSet(STORY, 200).has("#a")).toBe(true);
    // At toMs (EXCLUSIVE upper edge) → absent.
    // FALSIFIABILITY: flipping the upper guard `T < toMs` to `T <= toMs` makes T=300 keep #a → RED.
    expect(projectPulseSet(STORY, 300).has("#a")).toBe(false);
    // After the window → absent.
    expect(projectPulseSet(STORY, 400).has("#a")).toBe(false);
  });

  it("is ADDITIVE — overlapping windows both contribute (not last-≤-T)", () => {
    // T=275 is inside #a [100,300) AND inside #b [250,500) → both present.
    // FALSIFIABILITY: if the projection took last-≤-T instead of unioning, #a would be dropped at 275 → RED.
    const at = projectPulseSet(STORY, 275);
    expect(at.has("#a")).toBe(true);
    expect(at.has("#b")).toBe(true);
    expect(at.size).toBe(2);
  });
});

describe("storyboard — projectCursorState (symbolic lerp)", () => {
  // Two waypoints: move to #a starting at tMs 1000 over 200ms (arrive 1200); move to #b starting at
  // tMs 2000 over 400ms (arrive 2400). A press window via cursor_click.
  const STORY: StoryFrame[] = [
    { tMs: 1000, frame: { t: "cursor_move", target: "#a", moveMs: 200 } },
    { tMs: 2000, frame: { t: "cursor_move", target: "#b", moveMs: 400 } },
    { tMs: 1500, frame: { t: "cursor_click", target: "#a", pressMs: 180 } },
  ];

  it("returns null BEFORE the first cursor_move frame", () => {
    // FALSIFIABILITY: returning a non-null default (e.g. resting at the first target) before any move
    // makes this expect(...).toBeNull() go RED.
    expect(projectCursorState(STORY, 999)).toBeNull();
  });

  it("rests at the waypoint target with t01=1 when not traveling", () => {
    // T=1200 is exactly at #a's arrival; before #b's move begins → rest at #a, t01=1.
    const at = projectCursorState(STORY, 1200);
    expect(at).not.toBeNull();
    expect(at!.fromTarget).toBe("#a");
    expect(at!.toTarget).toBe("#a");
    // FALSIFIABILITY: hardcoding the rest branch to t01=0 makes this go RED.
    expect(at!.t01).toBe(1);
  });

  it("lerps t01 along the active move (boundaries + midpoint)", () => {
    // The #b move spans [2000, 2400). At its start t01=0, halfway (2200) t01=0.5, and traveling
    // fromTarget #a → toTarget #b.
    const start = projectCursorState(STORY, 2000)!;
    expect(start.fromTarget).toBe("#a");
    expect(start.toTarget).toBe("#b");
    // FALSIFIABILITY: a wrong divisor (e.g. (T - tMs)/(moveMs*2)) shifts t01 off 0/0.5 → RED.
    expect(start.t01).toBe(0);

    const mid = projectCursorState(STORY, 2200)!;
    expect(mid.fromTarget).toBe("#a");
    expect(mid.toTarget).toBe("#b");
    expect(mid.t01).toBeCloseTo(0.5, 10);
  });

  it("pressing is true ONLY inside the cursor_click press window", () => {
    // Click at 1500, pressMs 180 → window [1500, 1680).
    expect(projectCursorState(STORY, 1499)!.pressing).toBe(false);
    // FALSIFIABILITY: flip the press guard `tMs <= T` to `tMs < T` and T=1500 stops pressing → RED.
    expect(projectCursorState(STORY, 1500)!.pressing).toBe(true);
    expect(projectCursorState(STORY, 1679)!.pressing).toBe(true);
    // FALSIFIABILITY: flip the upper press guard `T < tMs+pressMs` to `<=` and T=1680 stays pressing → RED.
    expect(projectCursorState(STORY, 1680)!.pressing).toBe(false);
  });

  it("default press duration applies when pressMs omitted", () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "cursor_move", target: "#a", moveMs: 100 } },
      { tMs: 50, frame: { t: "cursor_click", target: "#a" } },
    ];
    // Default press is 180ms → window [50, 230).
    expect(projectCursorState(story, 229)!.pressing).toBe(true);
    expect(projectCursorState(story, 230)!.pressing).toBe(false);
  });
});

// (P5 #1/#3/#10) PACING & CURSOR TRAVEL on the REAL TRAILHEAD_BEAT. For each of the three submit
// moments the cursor must TRAVEL — a real field→button move (t01 strictly in (0,1) at the move's
// midpoint, with fromTarget = the input field and toTarget = the button), NOT an instant jump — and a
// DWELL pulse must mark the button before the cosmetic click. Every assertion is pinned to the named
// constants (re-time = one-line change). Each "travels" assertion is FALSIFIABLE by removing/retargeting
// the field-origin re-anchor waypoint (so fromTarget ≠ the field) → RED.
describe("storyboard — (P5) pacing & cursor TRAVEL at the three submit moments", () => {
  // Helper: assert the cursor is mid-TRAVEL from `field` → `button` at the midpoint of [moveMs, moveMs+dur).
  const expectMidTravel = (moveMs: number, dur: number, field: string, button: string) => {
    const midT = moveMs + dur / 2;
    const c = projectCursorState(TRAILHEAD_BEAT, midT);
    expect(c, `cursor state at mid-travel T=${midT}`).not.toBeNull();
    // TRAVELING (not jumped/rested): a real move segment from the FIELD to the BUTTON.
    expect(c!.fromTarget, `fromTarget at T=${midT}`).toBe(field);
    expect(c!.toTarget, `toTarget at T=${midT}`).toBe(button);
    // t01 STRICTLY between 0 and 1 — proves a genuine in-flight travel, not an instant arrival.
    expect(c!.t01).toBeGreaterThan(0);
    expect(c!.t01).toBeLessThan(1);
  };

  // Helper: assert a pulse window on `target` spanning the dwell exists and contains a sampled interior T.
  const expectDwellPulse = (target: string, fromMs: number, toMs: number) => {
    expect(toMs).toBeGreaterThan(fromMs); // a real (non-degenerate) dwell window
    const mid = Math.floor((fromMs + toMs) / 2);
    expect(projectPulseSet(TRAILHEAD_BEAT, mid).has(target), `pulse on ${target} at dwell-mid ${mid}`).toBe(true);
  };

  it("#1 New-Plan submit: a fresh #composer-request origin waypoint precedes the start move", () => {
    // The re-anchor waypoint is the SOURCE OF the travel's origin. FALSIFIABILITY: retarget it to
    // #composer-start and the #1 travel below loses its #composer-request fromTarget → that test goes RED.
    const reAnchor = TRAILHEAD_BEAT.find(
      (sf) => sf.tMs === B1_REQUEST_DWELL_MS && sf.frame.t === "cursor_move" && sf.frame.target === "#composer-request",
    );
    expect(reAnchor, "fresh #composer-request origin waypoint at B1_REQUEST_DWELL_MS").toBeDefined();
  });

  it("#1 New-Plan submit: the cursor TRAVELS #composer-request → #composer-start (slow, legible)", () => {
    // The slow move is deliberately legible: not a near-instant jump.
    expect(B1_START_MOVE_DUR).toBeGreaterThanOrEqual(700);
    expectMidTravel(B1_START_MOVE_MS, B1_START_MOVE_DUR, "#composer-request", "#composer-start");
  });

  it("#1 New-Plan submit: a dwell pulse marks #composer-start before the cosmetic click", () => {
    expectDwellPulse("#composer-start", B1_START_PULSE_FROM, B1_START_PULSE_TO);
    // The click lands AT/after the dwell ends (the viewer reads the button first).
    expect(B1_START_CLICK_MS).toBeGreaterThanOrEqual(B1_START_PULSE_TO - 1);
  });

  it("#3 Clarify submit: a fresh [data-other=text] origin waypoint precedes the submit move", () => {
    const reAnchor = TRAILHEAD_BEAT.find(
      (sf) => sf.tMs === B2_ANSWER_DWELL_MS && sf.frame.t === "cursor_move" && sf.frame.target === '[data-other="text"]',
    );
    expect(reAnchor, "fresh [data-other=text] origin waypoint at B2_ANSWER_DWELL_MS").toBeDefined();
  });

  it("#3 Clarify submit: the cursor TRAVELS [data-other=text] → .conv-question-submit (slow, legible)", () => {
    expect(B2_SUBMIT_MOVE_DUR).toBeGreaterThanOrEqual(700);
    expectMidTravel(B2_SUBMIT_MOVE_MS, B2_SUBMIT_MOVE_DUR, '[data-other="text"]', ".conv-question-submit");
  });

  it("#3 Clarify submit: a dwell pulse marks .conv-question-submit before the cosmetic click", () => {
    expectDwellPulse(".conv-question-submit", B2_SUBMIT_PULSE_FROM, B2_SUBMIT_PULSE_TO);
    expect(B2_SUBMIT_CLICK_MS).toBeGreaterThanOrEqual(B2_SUBMIT_PULSE_TO - 1);
  });

  it("#10 Prototype Approve: a fresh #prototype-feedback origin waypoint precedes the approve move", () => {
    const reAnchor = TRAILHEAD_BEAT.find(
      (sf) => sf.tMs === PROTO_APPROVE_ORIGIN_MS && sf.frame.t === "cursor_move" && sf.frame.target === "#prototype-feedback",
    );
    expect(reAnchor, "fresh #prototype-feedback origin waypoint at PROTO_APPROVE_ORIGIN_MS").toBeDefined();
  });

  it("#10 Prototype Approve: the cursor TRAVELS #prototype-feedback → #review-approve (slow, legible)", () => {
    expect(PROTO_APPROVE_MOVE_DUR).toBeGreaterThanOrEqual(700);
    expectMidTravel(PROTO_APPROVE_MOVE_MS, PROTO_APPROVE_MOVE_DUR, "#prototype-feedback", "#review-approve");
  });

  it("#10 Prototype Approve: #review-approve is pulsed (button reads clearly) before the cosmetic click", () => {
    // The pulse spans the move up to the click, so the review-bar button is clearly shown the whole time.
    expectDwellPulse("#review-approve", PROTO_APPROVE_PULSE_FROM, PROTO_APPROVE_PULSE_TO);
    // The pulse is still active AT the mid-travel moment (button visible while the cursor crosses to it).
    const midTravel = PROTO_APPROVE_MOVE_MS + PROTO_APPROVE_MOVE_DUR / 2;
    expect(projectPulseSet(TRAILHEAD_BEAT, midTravel).has("#review-approve")).toBe(true);
    expect(PROTO_APPROVE_CLICK_MS).toBeGreaterThanOrEqual(PROTO_APPROVE_PULSE_TO - 1);
  });
});

describe("storyboard — projectFieldText (growing prefix)", () => {
  const TEXT = "Android first"; // length 13
  const STORY: StoryFrame[] = [
    { tMs: 0, frame: { t: "field_type", target: "#f", text: TEXT, fromMs: 1000, toMs: 2000 } },
  ];

  it("contributes NOTHING before fromMs (target absent from the map)", () => {
    // FALSIFIABILITY: if the projection emitted an empty string for T<fromMs it would still .has() the
    // key; we assert ABSENCE so a premature writer is caught.
    const at = projectFieldText(STORY, 999);
    expect(at.has("#f")).toBe(false);
  });

  it("at fromMs the prefix is empty (floor(0))", () => {
    // T=1000 → fraction 0 → slice(0,0) = "".
    expect(projectFieldText(STORY, 1000).get("#f")).toBe("");
  });

  it("mid-window the prefix is the EXACT linear slice", () => {
    // T=1500 → fraction 0.5 → cut = floor(0.5*13) = 6 → "Androi".
    // FALSIFIABILITY: returning the FULL text always makes this expect("Androi") go RED (got full).
    const expectedCut = Math.floor(0.5 * TEXT.length);
    expect(expectedCut).toBe(6);
    expect(projectFieldText(STORY, 1500).get("#f")).toBe(TEXT.slice(0, expectedCut));
    expect(projectFieldText(STORY, 1500).get("#f")).toBe("Androi");
  });

  it("at/after toMs the full text is shown", () => {
    // FALSIFIABILITY: flipping `T >= toMs` to `T > toMs` makes T=2000 fall into the lerp branch (cut =
    // floor(clamp01(1)*len) = full anyway) — to make this falsifiable we assert the strictly-after case
    // too AND that the at-edge value equals the full text (a broken upper guard returning a short slice
    // for an off-by-one fraction would go RED).
    expect(projectFieldText(STORY, 2000).get("#f")).toBe(TEXT);
    expect(projectFieldText(STORY, 3000).get("#f")).toBe(TEXT);
  });

  it("last-writer-wins per target across frames", () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "field_type", target: "#f", text: "first", fromMs: 0, toMs: 10 } },
      { tMs: 0, frame: { t: "field_type", target: "#f", text: "second", fromMs: 0, toMs: 10 } },
    ];
    // Both complete by T=100; the later frame in story order wins.
    expect(projectFieldText(story, 100).get("#f")).toBe("second");
  });
});

describe("storyboard — projectModalState (last-≤-T per kind, backward scrub)", () => {
  const STORY: StoryFrame[] = [
    { tMs: 1000, frame: { t: "overlay_modal", kind: "composer", on: true } },
    { tMs: 2000, frame: { t: "overlay_modal", kind: "composer", on: false } },
    { tMs: 1500, frame: { t: "overlay_modal", kind: "popover", on: true, target: "#blk" } },
    { tMs: 2500, frame: { t: "overlay_modal", kind: "popover", on: false } },
  ];

  it("defaults both OFF / null target before any frame", () => {
    const at = projectModalState(STORY, 0);
    expect(at.composer).toBe(false);
    expect(at.popover).toEqual({ on: false, target: null });
  });

  it("composer is the last-≤-T value per kind", () => {
    // Open at 1000, closed at 2000.
    // FALSIFIABILITY: ignoring tMs (taking the FIRST frame, or never updating) keeps composer true at
    // T=2500 → the expect(false) goes RED.
    expect(projectModalState(STORY, 1000).composer).toBe(true);
    expect(projectModalState(STORY, 1999).composer).toBe(true);
    expect(projectModalState(STORY, 2000).composer).toBe(false);
    expect(projectModalState(STORY, 2500).composer).toBe(false);
  });

  it("popover carries its target while on, independent of the composer kind", () => {
    const at1500 = projectModalState(STORY, 1500);
    expect(at1500.popover).toEqual({ on: true, target: "#blk" });
    // composer is still open at 1500 (its close is at 2000) — kinds are tracked independently.
    expect(at1500.composer).toBe(true);
  });

  it("BACKWARD SCRUB — a modal opened later is CLOSED at an earlier T", () => {
    // Forward: at T=2600 BOTH are closed (their last-≤-T frames are the `off`s).
    const late = projectModalState(STORY, 2600);
    expect(late.composer).toBe(false);
    expect(late.popover.on).toBe(false);
    // Scrub BACK to T=1700: composer's last-≤-T is its `on` (1000), popover's is its `on` (1500) → both
    // re-open. A pure re-derivation reverts; a forward-delta accumulator would have stayed closed.
    // FALSIFIABILITY: if projectModalState memoized state instead of re-deriving last-≤-T, the backward
    // scrub would keep composer=false → expect(true) goes RED.
    const back = projectModalState(STORY, 1700);
    expect(back.composer).toBe(true);
    expect(back.popover).toEqual({ on: true, target: "#blk" });
  });
});
