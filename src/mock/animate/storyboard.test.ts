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
  TRAILHEAD_BEAT,
  TRAILHEAD_COMMENT_1,
  TRAILHEAD_COMMENT_2,
  TRAILHEAD_COMMENT_3,
  TERMINAL_MS,
  TERMINAL_SEQ,
  EXEC_SHIFT,
  PROTO_ACT_SHIFT,
  COMMENT_ACT_SHIFT,
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
  B1_COMPOSER_OPEN_MS,
  B1_REQUEST_TYPE_FROM,
  B1_REQUEST_TYPE_TO,
  B1_COMPOSER_CLOSE_MS,
  B1_USER_MSG_MS,
  B1_REPLY_MS,
  B2_QUESTION_MS,
  B2_ANSWER_TYPE_FROM,
  B2_ANSWER_TYPE_TO,
  B2_ANSWER_MS,
  B3_LEAF_START_MS,
  B4_SIZER_MS,
  B4_OUTCOME_MS,
  EXEC_BASE_MS,
  type StoryFrame,
} from "./storyboard";
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
    applyUpToTime(model, TRAILHEAD_BEAT, 33000 + EXEC_SHIFT + PROTO_ACT_SHIFT + COMMENT_ACT_SHIFT);
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
    const group = model.derive().nodes.find((n) => n.type === "subagent") as
      | { children: Array<{ type: string; status?: string }> }
      | undefined;
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
    expect(B4_OUTCOME_MS).toBeLessThan(13000 + EXEC_SHIFT); // the prototype-review chapter's shifted open.
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

  it("the card overlay is PULSED in both rounds (#demo-proto-card pulse frames)", () => {
    const cardPulses = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "pulse" && sf.frame.target === "#demo-proto-card",
    );
    expect(cardPulses.length).toBeGreaterThanOrEqual(2);
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
  // upstream chapter); the literals are unchanged, the shift is added.
  const NESTED_SHIFT = EXEC_SHIFT + PROTO_ACT_SHIFT;
  const PLAN_CHANGED_MS = 19800 + NESTED_SHIFT;

  it("sidebar is EMPTY ([]) before the plan_changed reveal and TRAILHEAD_PLANS at/after it", () => {
    // The explicit empty plan_changed at tMs 0 pins the sidebar to [] from the start (NOT the seed).
    expect(projectSurfaceState(TRAILHEAD_BEAT, 0).plans).toEqual([]);
    expect(projectSurfaceState(TRAILHEAD_BEAT, 10000).plans).toEqual([]);
    expect(projectSurfaceState(TRAILHEAD_BEAT, PLAN_CHANGED_MS - 1).plans).toEqual([]);
    // At/after the reveal the drafted tree is revealed.
    expect(projectSurfaceState(TRAILHEAD_BEAT, PLAN_CHANGED_MS).plans).toEqual(TRAILHEAD_PLANS);
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).plans).toEqual(TRAILHEAD_PLANS);
  });

  it("at the master-open moment the V1 master is open (Plan tab)", () => {
    const at = projectSurfaceState(TRAILHEAD_BEAT, 20200 + NESTED_SHIFT);
    expect(at.openPlanPath).toBe(TRAILHEAD_MASTER_PATH);
    expect(at.activeTab).toBe("plan");
  });

  it("the V2 master is open just before Execution but closed at duration (Execution)", () => {
    // Just before the Execution chapter the open_plan{V2} is still the last open_plan, so the revised
    // master is on the Plan tab. Execution's open_plan{null} is at old 27000 + EXEC + PROTO_ACT +
    // COMMENT_ACT, so sample just before that close.
    const execOpenNull = 27000 + EXEC_SHIFT + PROTO_ACT_SHIFT + COMMENT_ACT_SHIFT;
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
    applyUpToTime(model, TRAILHEAD_BEAT, 20000 + EXEC_SHIFT + PROTO_ACT_SHIFT);
    expect(model.derive().working).not.toBeNull();
    // At duration the terminal result has landed → the turn is complete, working is null.
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    expect(model.derive().working).toBeNull();
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
  // (they continue the nested-plan scheme), and the push adds + PROTO_ACT_SHIFT. The P4 popover act
  // paints each highlight AFTER its popover act: set_comments land at literal 52200 ([c1]) / 52800
  // ([c1,c2]) / 56800 ([c1,c2,c3]); V2 opens at literal 58000 (all + PROTO_ACT_SHIFT).
  const CMT_SHIFT = PROTO_ACT_SHIFT;
  const C1_PAINT_MS = 52200 + CMT_SHIFT;
  const C2_PAINT_MS = 52800 + CMT_SHIFT;
  const C3_PAINT_MS = 56800 + CMT_SHIFT;
  const V2_OPEN_MS = 58000 + CMT_SHIFT;

  it("projectSurfaceState.comments grows 1 → 2 → 3 over the set_comments frames (on the open V1 master)", () => {
    // The V1 master is open; comments are scoped to that open path.
    expect(projectSurfaceState(TRAILHEAD_BEAT, C1_PAINT_MS).openPlanPath).toBe(TRAILHEAD_MASTER_PATH);
    expect(projectSurfaceState(TRAILHEAD_BEAT, C1_PAINT_MS).comments).toHaveLength(1);
    expect(projectSurfaceState(TRAILHEAD_BEAT, C2_PAINT_MS).comments).toHaveLength(2);
    expect(projectSurfaceState(TRAILHEAD_BEAT, C3_PAINT_MS).comments).toHaveLength(3);
    // Just BEFORE the first comment lands the open master has no comments yet.
    expect(projectSurfaceState(TRAILHEAD_BEAT, C1_PAINT_MS - 1).comments).toHaveLength(0);
  });

  it("PER COMMENT the popover act precedes the highlight: a popover-on overlay + an #sp-text field_type land BEFORE the set_comments paint", () => {
    // For comment 1 and comment 3 (the two SCRIPTED ones), assert the ordering popover-on → typing →
    // highlight. The popover-on overlay_modal and the #sp-text field_type must precede the set_comments.
    const popoverOns = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "overlay_modal" && sf.frame.kind === "popover" && sf.frame.on === true,
    );
    // Two scripted popovers (c1 + c3).
    expect(popoverOns.length).toBe(2);
    const spTextTypes = TRAILHEAD_BEAT.filter(
      (sf) => sf.frame.t === "field_type" && sf.frame.target === "#sp-text",
    );
    expect(spTextTypes.length).toBe(2);
    // Comment 1: the first popover-on + the first #sp-text typing both precede C1_PAINT_MS.
    expect(popoverOns[0].tMs).toBeLessThan(C1_PAINT_MS);
    expect(spTextTypes[0].tMs).toBeLessThan(C1_PAINT_MS);
    // Comment 3: the second popover-on + the second #sp-text typing both precede C3_PAINT_MS.
    expect(popoverOns[1].tMs).toBeLessThan(C3_PAINT_MS);
    expect(spTextTypes[1].tMs).toBeLessThan(C3_PAINT_MS);
    // … and the second popover act lands AFTER comment 1's paint (a distinct, later act).
    expect(popoverOns[1].tMs).toBeGreaterThan(C1_PAINT_MS);
    // FALSIFIABILITY: if the highlight painted BEFORE the popover (set_comments hoisted above the act),
    // popoverOns[0].tMs < C1_PAINT_MS would flip false.
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
    applyUpToTime(model, TRAILHEAD_BEAT, 33000 + EXEC_SHIFT + PROTO_ACT_SHIFT + COMMENT_ACT_SHIFT);
    expect(model.derive().working).not.toBeNull();
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    expect(model.derive().working).toBeNull();
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
    applyUpToTime(model, TRAILHEAD_BEAT, 33000 + EXEC_SHIFT + PROTO_ACT_SHIFT + COMMENT_ACT_SHIFT);
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
