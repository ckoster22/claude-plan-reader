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
  TRAILHEAD_BEAT,
  TRAILHEAD_COMMENT_1,
  TRAILHEAD_COMMENT_2,
  TRAILHEAD_COMMENT_3,
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
    expect(duration).toBe(40000); // pinned: the relocated terminal `result` lands at tMs 40000.

    // T=6400 is squarely inside the "Scope recon" chapter (the subagent is mid-run, no terminal result
    // yet) — the turn is generating, so working is live.
    applyUpToTime(model, TRAILHEAD_BEAT, 6400);
    expect(model.derive().working).not.toBeNull();

    // T=14500 is inside the "Prototype review" chapter (after the seq-21 narration, before the terminal
    // result at 40000) — still generating, so working is live. This pins the finished-thought invariant
    // to the NEW final beat, not just the scope-recon chapter.
    applyUpToTime(model, TRAILHEAD_BEAT, 14500);
    expect(model.derive().working).not.toBeNull();

    // T=33000 is inside the "Execution" chapter (mid-leaf 04.03, before the terminal result at 40000) —
    // still generating, so working is live. Pins the finished-thought invariant across the new gap.
    applyUpToTime(model, TRAILHEAD_BEAT, 33000);
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

  it("(a) mid-question (T in (2000,3600)) the card is OPEN and working = Waiting for your input", () => {
    // T=2800 is AFTER the request (tMs 2000) but BEFORE the answer (tMs 3600) → the form is open.
    applyUpToTime(model, TRAILHEAD_BEAT, 2800);
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
      children: unknown[];
      subagentType: string | null;
      description: string | null;
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].children.length).toBeGreaterThanOrEqual(1);
    // (g) The labeled path was taken — the `subagent_started` frame named the group.
    expect(groups[0].subagentType).toBe("scope-recon");
    expect(groups[0].description).toBe("Scope the Trailhead source tree");
  });

  it("(f) StoryFrames open the 'Clarify' and 'Scope recon' chapters", () => {
    const labels = TRAILHEAD_BEAT.map((sf) => sf.chapterLabel).filter(Boolean);
    expect(labels).toContain("Clarify");
    expect(labels).toContain("Scope recon");
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
  // The window the gate + the open_plan bracket span (exclusive of the edges' "before" but inclusive
  // at/after the opening edge): open at 13800, close at 15600.
  const GATE_OPEN_MS = 13800;
  const GATE_CLOSE_MS = 15600;
  const FEEDBACK_MS = 16000;

  it("the prototype-gate ON surface frame exists at tMs 13800", () => {
    const gateOn = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "prototype_gate" && sf.frame.on === true && sf.tMs === GATE_OPEN_MS,
    );
    expect(gateOn).toBeDefined();
  });

  it("the open_plan bracket opens PROTO_PREVIEW_PATH at 13800 and closes (null) at 15600", () => {
    const open = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "open_plan" && sf.frame.path === PROTO_PREVIEW_PATH && sf.tMs === GATE_OPEN_MS,
    );
    const close = TRAILHEAD_BEAT.find(
      (sf) => sf.frame.t === "open_plan" && sf.frame.path === null && sf.tMs === GATE_CLOSE_MS,
    );
    expect(open).toBeDefined();
    expect(close).toBeDefined();
  });

  it("the feedback user_message + approval system_message land together at tMs 16000", () => {
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

  it("projectSurfaceState: prototypeGate.on is true ONLY inside (13800, 15600)", () => {
    // Just before the open → off.
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_OPEN_MS - 1).prototypeGate.on).toBe(false);
    // Inside the window → on.
    expect(projectSurfaceState(TRAILHEAD_BEAT, 14500).prototypeGate.on).toBe(true);
    // At/after the close → off again (a backward scrub reverts cleanly).
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_CLOSE_MS).prototypeGate.on).toBe(false);
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).prototypeGate.on).toBe(false);
  });

  it("projectSurfaceState: activeTab tracks the prototype bracket AND flips to conversation for Execution", () => {
    // Before the open the conversation is showing (no plan open in the whole beat before this).
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_OPEN_MS - 1).activeTab).toBe("conversation");
    // Inside the prototype bracket the prototype plan is open → Plan tab.
    expect(projectSurfaceState(TRAILHEAD_BEAT, 14500).activeTab).toBe("plan");
    // After the prototype bracket closes (open_plan{null} at 15600) the tab flips back to conversation,
    // and stays there through the "Nested plan" narration (before the master opens at 20200).
    expect(projectSurfaceState(TRAILHEAD_BEAT, GATE_CLOSE_MS).activeTab).toBe("conversation");
    expect(projectSurfaceState(TRAILHEAD_BEAT, 20000).activeTab).toBe("conversation");
    // The Execution chapter opens with open_plan{null} at 27000 → the reading pane closes and the tab
    // flips back to conversation for the rest of the beat, INCLUDING at duration (the terminal lands on
    // the Conversation tab). The master/V2 are no longer shown once execution starts.
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).activeTab).toBe("conversation");
  });

  it("the terminal result is STRICTLY the last frame (highest seq AND tMs)", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    // The terminal result is the model frame with the highest tMs AND it is a `result` kind.
    const last = TRAILHEAD_BEAT.reduce((a, b) => (b.tMs >= a.tMs ? b : a));
    expect(last.tMs).toBe(duration);
    expect(last.frame.t).toBe("conv");
    expect((last.frame as { ev: { kind: string } }).ev.kind).toBe("result");
    // No model frame has a higher seq than the terminal's seq (49).
    const seqs = TRAILHEAD_BEAT.flatMap((sf) => {
      const f = sf.frame;
      if (f.t === "conv") return [f.ev.seq];
      if (f.t === "user_message" || f.t === "system_message") return [f.seq];
      return [];
    });
    expect(Math.max(...seqs)).toBe(49);
    expect((last.frame as { ev: { seq: number } }).ev.seq).toBe(49);
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

  const PLAN_CHANGED_MS = 19800;

  it("sidebar is EMPTY ([]) for 0 ≤ T < 19800 and TRAILHEAD_PLANS for T ≥ 19800", () => {
    // The explicit empty plan_changed at tMs 0 pins the sidebar to [] from the start (NOT the seed).
    expect(projectSurfaceState(TRAILHEAD_BEAT, 0).plans).toEqual([]);
    expect(projectSurfaceState(TRAILHEAD_BEAT, 10000).plans).toEqual([]);
    expect(projectSurfaceState(TRAILHEAD_BEAT, PLAN_CHANGED_MS - 1).plans).toEqual([]);
    // At/after 19800 the drafted tree is revealed.
    expect(projectSurfaceState(TRAILHEAD_BEAT, PLAN_CHANGED_MS).plans).toEqual(TRAILHEAD_PLANS);
    expect(projectSurfaceState(TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT)).plans).toEqual(TRAILHEAD_PLANS);
  });

  it("at the master-open moment (20200) the V1 master is open (Plan tab)", () => {
    const at = projectSurfaceState(TRAILHEAD_BEAT, 20200);
    expect(at.openPlanPath).toBe(TRAILHEAD_MASTER_PATH);
    expect(at.activeTab).toBe("plan");
  });

  it("the V2 master is open just before Execution (T=26999) but closed at duration (Execution)", () => {
    // Just before the Execution chapter the open_plan{V2} at 24800 is still the last open_plan, so the
    // revised master is on the Plan tab.
    const beforeExec = projectSurfaceState(TRAILHEAD_BEAT, 26999);
    expect(beforeExec.openPlanPath).toBe(TRAILHEAD_MASTER_V2_PATH);
    expect(beforeExec.openPlanPath).not.toBe(TRAILHEAD_MASTER_PATH);
    expect(beforeExec.activeTab).toBe("plan");
    // The Execution chapter's open_plan{null} at 27000 closes the pane, so at duration NO plan is open
    // and the tab is back on the conversation (the master is no longer the final on-screen surface).
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

  it("FINISHED THOUGHT — working is non-null at T=20000 (the new gap) but null at duration 40000", () => {
    // T=20000 is inside the "Nested plan" gap (after the seq-25 narration at 19000, before the terminal
    // result at 40000) — still generating, so working is live.
    applyUpToTime(model, TRAILHEAD_BEAT, 20000);
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

  it("projectSurfaceState.comments grows 1 → 2 → 3 over the set_comments frames (on the open V1 master)", () => {
    // The V1 master is open from 20200; comments are scoped to that open path.
    expect(projectSurfaceState(TRAILHEAD_BEAT, 22000).openPlanPath).toBe(TRAILHEAD_MASTER_PATH);
    expect(projectSurfaceState(TRAILHEAD_BEAT, 22000).comments).toHaveLength(1);
    expect(projectSurfaceState(TRAILHEAD_BEAT, 22800).comments).toHaveLength(2);
    expect(projectSurfaceState(TRAILHEAD_BEAT, 23600).comments).toHaveLength(3);
    // Just BEFORE the first comment lands the open master has no comments yet.
    expect(projectSurfaceState(TRAILHEAD_BEAT, 21999).comments).toHaveLength(0);
  });

  it("after switching to V2 (T ≥ 24800) the open path is V2 and its comments are [] (highlights clear)", () => {
    for (const T of [24800, 25200, 26000, 26500]) {
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

  it("the terminal result is STRICTLY last (highest tMs 40000) and clears working; nothing later", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    expect(duration).toBe(40000);
    const later = TRAILHEAD_BEAT.filter((sf) => sf.tMs > duration);
    expect(later).toHaveLength(0);
    // Exactly ONE frame lands in (39999, 40000] — the terminal result.
    const inWindow = TRAILHEAD_BEAT.filter((sf) => sf.tMs > 39999 && sf.tMs <= 40000);
    expect(inWindow).toHaveLength(1);
    expect((inWindow[0].frame as { ev: { kind: string } }).ev.kind).toBe("result");
  });

  it("FINISHED THOUGHT — working non-null at T=33000 (mid-Execution) but null at 40000", () => {
    // T=33000 is inside the Execution chapter (mid-leaf 04.03, after the seq-26 echo at 25200, before the
    // terminal result at 40000) — still generating, so working is live. FALSIFIABILITY: relocate the
    // terminal to a non-last tMs and the `working === null at duration` assertion goes RED (working stays
    // non-null at the end).
    applyUpToTime(model, TRAILHEAD_BEAT, 33000);
    expect(model.derive().working).not.toBeNull();
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    expect(model.derive().working).toBeNull();
  });
});

// ---- TRAILHEAD_BEAT — "Execution" chapter (the FINAL beat) -------------------------------------
//
// The plan is approved → the assistant executes the four 04.* trail-detail leaves FLAT (per-leaf, no
// Task wrapper). The chapter opens with a SURFACE open_plan{null} (27000) that closes the reading pane
// so projectSurfaceState flips activeTab "plan" → "conversation" for the rest of the beat. Each leaf is
// one atomic Write pair, a top-level OUTPUT assistant_text, and a DEMO-AUTHORED `[context]` system echo
// threading the next leaf. The `[context]` echoes are seq-adjacent immediately AFTER each leaf's OUTPUT
// (the falsifiable seq-adjacency pins outSeq → ctxSeq). The terminal result (seq 49 / 40000) is strictly
// last and clears `working` (a finished thought).

describe("storyboard — TRAILHEAD_BEAT execution chapter (the final beat)", () => {
  let model: ConversationModel;
  beforeEach(() => {
    model = new ConversationModel();
  });

  it("DEMO-AUTHORED [context] system_messages are seq-adjacent immediately AFTER each leaf OUTPUT", () => {
    // Derive the FULL beat at duration; the top-level nodes are seq-ordered. For each [outputSeq, ctxSeq]
    // pair the `[context]` system node MUST be the node immediately following the leaf's OUTPUT node, AND
    // its seq MUST equal the scripted ctxSeq. FALSIFIABILITY: move a `[context]` seq below its leaf output
    // (so it no longer sorts right after) and the `nodes[i+1]` adjacency goes RED.
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const nodes = model.derive().nodes;
    for (const [outSeq, ctxSeq] of [
      [31, 32],
      [36, 37],
      [41, 42],
      [46, 47],
    ] as const) {
      const i = nodes.findIndex((n) => n.seq === outSeq);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(nodes[i + 1].type).toBe("system");
      expect((nodes[i + 1] as { text: string }).text.startsWith("[context]")).toBe(true);
      expect(nodes[i + 1].seq).toBe(ctxSeq);
    }
  });

  it("each leaf's Write tool_use/tool_result is atomic (no leaf lingers 'running' at any T)", () => {
    // The four 04.* Write pairs share a tMs each (atomic). At duration none of the top-level tool nodes
    // is 'running'. FALSIFIABILITY: split a pair's result to a later tMs and a mid-T sample would catch a
    // running leaf — here we assert the at-duration invariant (recursive #4 also covers this globally).
    applyUpToTime(model, TRAILHEAD_BEAT, storyDurationMs(TRAILHEAD_BEAT));
    const writeTools = model
      .derive()
      .nodes.filter((n) => n.type === "tool" && (n as { tool: string }).tool === "Write");
    expect(writeTools.length).toBe(4);
    for (const t of writeTools) expect((t as { status: string }).status).not.toBe("running");
  });

  it("projectSurfaceState: openPlanPath null + activeTab 'conversation' for T ≥ 27000 (incl. duration)", () => {
    // The Execution open_plan{null} at 27000 closes the pane for the rest of the beat.
    for (const T of [27000, 33000, 37700, storyDurationMs(TRAILHEAD_BEAT)]) {
      const at = projectSurfaceState(TRAILHEAD_BEAT, T);
      expect(at.openPlanPath).toBeNull();
      expect(at.activeTab).toBe("conversation");
    }
    // And just BEFORE 27000 the V2 master is still open on the Plan tab (the flip is exactly at 27000).
    for (const T of [24800, 26999]) {
      const at = projectSurfaceState(TRAILHEAD_BEAT, T);
      expect(at.openPlanPath).toBe(TRAILHEAD_MASTER_V2_PATH);
      expect(at.activeTab).toBe("plan");
    }
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

  it("NO STUCK TOOL (recursive) at duration AND finished thought (working null at 40000, non-null at 33000)", () => {
    const duration = storyDurationMs(TRAILHEAD_BEAT);
    // Recursive no-stuck-tool: flatten subagent groups; no tool is 'running' at duration.
    applyUpToTime(model, TRAILHEAD_BEAT, duration);
    const running = model
      .derive()
      .nodes.flatMap((n) => (n.type === "subagent" ? n.children : [n]))
      .filter((t) => t.type === "tool" && (t as { status: string }).status === "running");
    expect(running).toHaveLength(0);
    // Finished thought: working is live mid-Execution (33000) and null once the terminal lands (40000).
    applyUpToTime(model, TRAILHEAD_BEAT, 33000);
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

  // The FIRST node is now a USER kickoff (seq 1); the first STREAMING assistant_text is seq 2 (the
  // "Happy to…" reply), at tMs 900 with revealMs 900. We target THAT frame's text node by seq 2.
  const REVEAL_TMS = 900;
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
    // Mid-window: T=1350 is half-way through the [900, 1800) reveal window → ~half the characters.
    const T = 1350;
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
    // Same T twice → identical signature.
    expect(modelSignature(TRAILHEAD_BEAT, 1350)).toBe(modelSignature(TRAILHEAD_BEAT, 1350));
    // A later mid-window T reveals more chars → a different signature.
    expect(modelSignature(TRAILHEAD_BEAT, 1350)).not.toBe(modelSignature(TRAILHEAD_BEAT, 1500));
  });
});

// ---- Backward seek == from-zero rebuild --------------------------------------------------------

describe("storyboard — backward seek equals from-zero rebuild", () => {
  it("scrubbing forward then back to T equals a fresh rebuild at T (no residue)", () => {
    // T inside the seq-2 reveal window [900,1800) — a mid-stream prefix, richer than an idle T.
    const T = 1350;
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
