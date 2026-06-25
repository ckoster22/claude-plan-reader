// Mock-mode PHASE 3 tests — review bar, resume banner, reading-pane/error fallback, history replay,
// and the two fidelity fixes (Findings 1 & 6). vitest + jsdom.
//
// Falsifiable properties, each through the REAL production code the live app uses:
//   1. REVIEW-BAR MODES: each fixture, fed through the real pure applier, yields its signature state
//      (viewing → submit+approve; summary → resume; prototype → proto label + request-changes;
//      acceptance → refine targets). Falsifiability noted per assertion.
//   2. RESUME BANNER: the resumable/blocked fixtures carry the fields renderResumeBanner reads.
//   3. FINDING 6: the mock write_agent_plan → read_plan_contents ROUND-TRIPS the ExitPlanMode plan
//      text (NOT the fallback) — the in-process review's Plan tab shows the right content.
//   4. FINDING 1: the seq-LESS permission frame renders/orders correctly; a following live user echo
//      lands at lastWireSeq + 0.5 (after the pre-permission frames, before the agent's reply).
//   5. HISTORY REPLAY: the canned transcript renders renderable nodes through the real parseTranscript
//      path; the no-transcript fixture is found:false.

import { describe, it, expect } from "vitest";

import { applyReviewBarState } from "../review";
import {
  prototypeGateActive,
  acceptanceGateActive,
  prototypeBarLabel,
  acceptanceRefineTargets,
  composePreviewMarkdown,
} from "../prototype";
import {
  trailheadProtoPreviewOverride,
  MOCK_MARKDOWN,
  PROTO_PREVIEW_PATH,
} from "./fixtures/markdown";

import { ConversationModel } from "../conversation/stream";
import { renderTree } from "../conversation/render";
import { parseTranscript, applyTranscriptToModel } from "../conversation/history";

import {
  MOCK_REVIEW,
  MOCK_PROTOTYPE_GATE,
  MOCK_ACCEPTANCE_GATE,
  MOCK_RESUME_RESUMABLE,
  MOCK_RESUME_BLOCKED,
  gateSnapshot,
} from "./fixtures/reviews";
import { transcriptFor, HISTORY_STEM, NO_TRANSCRIPT_STEM } from "./fixtures/transcripts";
import { SCENES, EXIT_PLAN_MODE_PLAN } from "./fixtures/scenes";
import { applySceneToModel } from "./player";
import { invoke } from "./core";

// ---------------------------------------------------------------------------------------------
// 1. Review-bar MODES through the real pure appliers.
// ---------------------------------------------------------------------------------------------
describe("review bar — each mode's signature state through the real applier", () => {
  it("VIEWING (external review open): submit visible (disabled at 0 comments), approve hidden", () => {
    const state = applyReviewBarState({
      pendingCount: 1,
      viewing: true,
      viewedCommentCount: 0,
      source: "external",
    });
    expect(state.mode).toBe("viewing");
    expect(state.submitVisible).toBe(true);
    expect(state.submitDisabled).toBe(true); // FALSIFY: 0 comments must keep submit disabled
    expect(state.approveVisible).toBe(false); // external review → no Approve & Build
    expect(state.resumeVisible).toBe(false);
  });

  it("VIEWING with >=1 comment enables submit", () => {
    const state = applyReviewBarState({
      pendingCount: 1,
      viewing: true,
      viewedCommentCount: 2,
      source: "external",
    });
    expect(state.submitDisabled).toBe(false); // FALSIFY: a comment must enable submit
  });

  it("VIEWING an IN-PROCESS review: Approve & Build visible, submit relabeled", () => {
    const state = applyReviewBarState({
      pendingCount: 1,
      viewing: true,
      viewedCommentCount: 0,
      source: "in-process",
    });
    expect(state.approveVisible).toBe(true); // the #review-approve "Approve & Build" affordance
    expect(state.submitLabel).toBe("Request changes"); // FALSIFY: in-process deny = "Request changes"
  });

  it("SUMMARY (pending review, non-reviewed plan open): count label + Resume; submit hidden", () => {
    const state = applyReviewBarState({
      pendingCount: 1,
      viewing: false,
      viewedCommentCount: 0,
      source: "external",
    });
    expect(state.mode).toBe("summary");
    expect(state.resumeVisible).toBe(true); // #review-resume is the summary-mode signature
    expect(state.submitVisible).toBe(false);
    expect(state.label).toContain("awaiting review");
  });

  it("HIDDEN: zero pending reviews hides the whole bar", () => {
    const state = applyReviewBarState({ pendingCount: 0, viewing: false, viewedCommentCount: 0 });
    expect(state.barVisible).toBe(false); // FALSIFY: a 0-count bar must be hidden
  });
});

// ---------------------------------------------------------------------------------------------
// 1b. PROTOTYPE / ACCEPTANCE gates through the real gate-active derivation.
// ---------------------------------------------------------------------------------------------
describe("review bar — prototype/acceptance gates drive the real gate-active functions", () => {
  it("the prototype snapshot yields the held PrototypeGate (orchestration active)", () => {
    const snap = gateSnapshot("prototype");
    const gate = prototypeGateActive(snap, true);
    expect(gate).not.toBeNull();
    expect(gate).toBe(MOCK_PROTOTYPE_GATE);
    // FALSIFY: with orchestration INACTIVE the gate is null (the bar never paints prototype mode).
    expect(prototypeGateActive(snap, false)).toBeNull();
    // The bar label the real applyPrototypeBar would render off gate.round.
    expect(prototypeBarLabel(gate!.round)).toBe("Visual prototype — round 1 of 3");
  });

  // Review item #6 + review2 c3: the mock-ANIMATE Trailhead prototype gate renders its prototype INLINE
  // in #reading-pane (no floating overlay — the deleted #demo-proto-card "wouldn't appear in the app").
  // main.ts's real renderPrototypePreview → composePreviewMarkdown paints the gate's inlinePreview. The
  // default fixture is kind:"mermaid"; the player passes trailheadProtoPreviewOverride(round) (kind:"ascii")
  // so composePreviewMarkdown emits a PLAIN fence, never a ```mermaid one, and round 2 adds the badge.
  it("the Trailhead inline preview composes the trail card WITHOUT mermaid (#6); round 2 adds the badge", () => {
    const round1Gate = gateSnapshot("prototype", 1, trailheadProtoPreviewOverride(1)).pendingPrototype!;
    expect(round1Gate.kind).toBe("ascii");
    const round1Md = composePreviewMarkdown(round1Gate);
    // The fix: NO mermaid fence ⇒ the reading-pane mermaid pipeline renders nothing.
    expect(round1Md).not.toContain("```mermaid");
    // The pane shows a COHERENT trail-list card (name + distance/elevation), not a near-empty title.
    expect(round1Md).toContain("Eagle Peak Loop");
    expect(round1Md).toContain("6.2 mi");
    expect(round1Md).toContain("+1,400 ft");
    // Round 1 has NO difficulty badge.
    expect(round1Md).not.toContain("Moderate");

    // Round 2 morphs the SAME card to add the difficulty badge (the typed-feedback result).
    const round2Gate = gateSnapshot("prototype", 2, trailheadProtoPreviewOverride(2)).pendingPrototype!;
    const round2Md = composePreviewMarkdown(round2Gate);
    expect(round2Md).not.toContain("```mermaid");
    expect(round2Md).toContain("Eagle Peak Loop");
    expect(round2Md).toContain("Moderate");

    // DETERMINISM (two-writer race): the reading-pane backdrop the reconciler opens (PROTO_PREVIEW_PATH →
    // PROTO_PREVIEW_DOC) is BYTE-IDENTICAL to composePreviewMarkdown's round-1 output, so whichever writer
    // wins a tick, the pane settles to the same card. This invariant is what makes repeated scrubs to the
    // same T deterministic.
    expect(MOCK_MARKDOWN[PROTO_PREVIEW_PATH]).toBe(round1Md);

    // FALSIFY: the DEFAULT (un-overridden) fixture is kind:"mermaid" and DOES emit a ```mermaid fence —
    // exactly the stray flowchart this fix removes from the Trailhead demo. If this assertion ever flips
    // (default no longer mermaid), the override-vs-default contract this test pins has rotted.
    const defaultMd = composePreviewMarkdown(gateSnapshot("prototype").pendingPrototype!);
    expect(defaultMd).toContain("```mermaid");
    expect(defaultMd).toContain("flowchart LR");
  });

  it("the acceptance snapshot yields the held AcceptanceGate and 2 refine targets", () => {
    const snap = gateSnapshot("acceptance");
    const gate = acceptanceGateActive(snap, true);
    expect(gate).not.toBeNull();
    expect(gate).toBe(MOCK_ACCEPTANCE_GATE);
    // FALSIFY: a held prototype gate would outrank acceptance — the prototype snapshot returns null here.
    expect(acceptanceGateActive(gateSnapshot("prototype"), true)).toBeNull();
    // The picker (#review-refine-target) the real applyAcceptanceBar populates from the split root.
    const targets = acceptanceRefineTargets(snap.root);
    expect(targets.map((t) => t.pathKey)).toEqual(["01", "02"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Resume banner fixtures carry the fields renderResumeBanner reads.
// ---------------------------------------------------------------------------------------------
describe("resume banner — fixtures expose the resumable/blocked render inputs", () => {
  it("the resumable fixture is resumable with a phase label (drives #resume-plan-btn)", () => {
    expect(MOCK_RESUME_RESUMABLE.resumable).toBe(true);
    expect(MOCK_RESUME_RESUMABLE.phaseLabel.length).toBeGreaterThan(0);
  });
  it("the blocked fixture is NOT resumable with a phase label (drives the muted message)", () => {
    expect(MOCK_RESUME_BLOCKED.resumable).toBe(false);
    expect(MOCK_RESUME_BLOCKED.phaseLabel.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. FINDING 6 — write_agent_plan → read_plan_contents round-trips the ExitPlanMode plan text.
// ---------------------------------------------------------------------------------------------
describe("Finding 6 — the in-process review plan round-trips through the mock", () => {
  it("read_plan_contents(writtenPath) returns the EXACT plan written, not the fallback", async () => {
    // Mirror handleToolPermissionRequested: write the ExitPlanMode plan, then open its written path.
    const written = await invoke<string>("write_agent_plan", { plan: EXIT_PLAN_MODE_PLAN });
    const contents = await invoke<string>("read_plan_contents", { path: written });
    // FALSIFY: if write_agent_plan ignored input.plan (the old behavior), this would be the
    // "(mock) No fixture" fallback markdown — assert it is the EXACT plan instead.
    expect(contents).toBe(EXIT_PLAN_MODE_PLAN);
    expect(contents).not.toContain("No fixture");
  });

  it("the exitPlanMode scene carries that exact plan as input.plan", () => {
    const frames = SCENES.exitPlanMode();
    const perm = frames.find((f) => f.event === "tool-permission-requested");
    expect(perm).toBeTruthy();
    const input = (perm!.payload as { input: { plan: string } }).input;
    // The scene's input.plan is the SAME text the round-trip serves back — proving they agree.
    expect(input.plan).toBe(EXIT_PLAN_MODE_PLAN);
  });
});

// ---------------------------------------------------------------------------------------------
// 3b. The error-fallback plan: read_plan_contents REJECTS (drives #reading-pane.raw in openPlan).
// ---------------------------------------------------------------------------------------------
describe("reading pane — the error-fallback plan rejects read_plan_contents", () => {
  it("the sentinel path rejects so openPlan's catch sets the raw error fallback", async () => {
    await expect(
      invoke("read_plan_contents", { path: "/Users/mock/.claude/plans/__error__.md" }),
    ).rejects.toThrow(/simulated read failure/);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. FINDING 1 — seq-LESS permission frame renders + orders correctly (lastWireSeq + 0.5 path).
// ---------------------------------------------------------------------------------------------
describe("Finding 1 — a seq-less permission frame renders and orders correctly", () => {
  it("the exitPlanMode permission frame has NO seq (matches the real wire)", () => {
    const frames = SCENES.exitPlanMode();
    const perm = frames.find((f) => f.event === "tool-permission-requested");
    // FALSIFY: re-adding a fabricated `seq` makes this assertion go RED (the fixture would drift from
    // the real sidecar wire, which emits no seq — see sidecar/permissions.ts).
    expect("seq" in (perm!.payload as object)).toBe(false);
  });

  it("the seq-less ExitPlanMode permission frame still renders its .conv-perm-request marker", () => {
    const model = new ConversationModel();
    applySceneToModel(model, SCENES.exitPlanMode());
    const container = document.createElement("div");
    renderTree(container, model.derive());
    // The marker renders even though the permission frame carries no seq (insertion-ordered).
    expect(container.querySelector(".conv-perm-request")).not.toBeNull();
  });

  it("a live user echo after the seq-less permission lands at lastWireSeq+0.5 (before the agent reply)", () => {
    // Mirror the live controller: apply system_init(1) + assistant_text(2) + the seq-less permission
    // frame, then echo a user message (appendUserMessage → lastWireSeq + 0.5), then the agent's reply
    // frames (assistant_text(3) + result(4)). The permission frame must NOT have advanced lastWireSeq
    // past 2, so the echo lands at 2.5 — AFTER the pre-permission assistant_text but BEFORE the reply.
    const frames = SCENES.permissionThenReply();
    const model = new ConversationModel();
    // Apply only the frames up to and including the permission (the controller would echo here).
    const upToPerm = frames.slice(0, 3); // system_init, assistant_text(2), permission (seq-less)
    applySceneToModel(model, upToPerm);
    model.appendUserMessage("My selection: SVG, macOS"); // live echo at lastWireSeq + 0.5 = 2.5
    applySceneToModel(model, frames.slice(3)); // assistant_text(3) + result(4)

    const nodes = model.derive().nodes;
    const texts = nodes
      .filter((n) => n.type === "text" || n.type === "user")
      .map((n) => (n.type === "text" || n.type === "user" ? n.text : ""));
    const echoIdx = texts.findIndex((t) => t.includes("My selection"));
    const preIdx = texts.findIndex((t) => t.includes("quick questions"));
    const replyIdx = texts.findIndex((t) => t.includes("proceeding with your selection"));
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(echoIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    // FALSIFY: if the permission frame advanced lastWireSeq (a fabricated high seq), the echo would
    // sort AFTER the reply — these ordering assertions would go RED.
    expect(echoIdx).toBeGreaterThan(preIdx);
    expect(echoIdx).toBeLessThan(replyIdx);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. HISTORY REPLAY — the canned transcript renders renderable nodes through the real path.
// ---------------------------------------------------------------------------------------------
describe("history replay — the canned transcript renders through the real parseTranscript path", () => {
  it("the history stem yields a found transcript that renders >=1 node", () => {
    const res = transcriptFor(HISTORY_STEM);
    expect(res.found).toBe(true);
    const model = new ConversationModel();
    applyTranscriptToModel(
      model,
      parseTranscript(res.lines, { cwd: res.cwd, sessionId: res.session_id }),
    );
    // FALSIFY: an empty transcript yields 0 nodes (the no-content state) — the history stem must not.
    expect(model.derive().nodes.length).toBeGreaterThan(0);
  });

  it("the no-transcript stem returns found:false (the no-transcript empty state)", () => {
    expect(transcriptFor(NO_TRANSCRIPT_STEM).found).toBe(false);
  });
});

// Reference MOCK_REVIEW so an accidental fixture shape regression (missing review_id) is caught here
// too (the external-review wire keys on it).
describe("review fixture — wire-shape sanity", () => {
  it("the review fixture carries a review_id and a plan_file_path", () => {
    expect(MOCK_REVIEW.review_id.length).toBeGreaterThan(0);
    expect(MOCK_REVIEW.plan_file_path.length).toBeGreaterThan(0);
  });
});
