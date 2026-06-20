// Mock-mode SCENE tests (Phase 2) — vitest + jsdom.
//
// Three falsifiable properties:
//   1. PER-SCENE SIGNATURE: every scene in the registry, fed through the REAL ConversationModel →
//      renderTree() into a jsdom container, yields its signature selector. Falsifiability: each
//      scene's signature node is produced by ONE key frame — removing that frame fails the assertion
//      (proven below with a removeKeyFrame mutation guard that is asserted to go RED).
//   2. SCENE-SWITCH BUFFER-SCOPING: loading scene A then scene B through the SAME path playScene
//      uses (the mock event bus + replay-on-subscribe + clearAgentBuffers) renders ONLY scene B's
//      signature, never scene A's leftover frames. This is the regression guard for the buffer-leak
//      contract: it is asserted to FAIL when the clear is skipped.
//   3. QUESTION CARD: the question frame renders an interactive `.conv-question` (pending); answering
//      it transitions to `.conv-question-answered` and resolves resolve_tool_permission with the
//      chosen label(s).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConversationModel } from "../conversation/stream";
import { renderTree } from "../conversation/render";
import type { AskUserQuestionAnswers, AgentStream } from "../conversation/types";
import { SCENES, SCENE_NAMES, type SceneFrame, type SceneName } from "./fixtures/scenes";
import { applySceneToModel, playSceneFrames } from "./player";
import { listen, emitMockEvent, clearMockBuffer } from "./event";
import { invoke } from "./core";
import { resetState } from "./state";

// The signature selector each scene must produce when rendered through the real pipeline.
const SIGNATURE: Record<SceneName, string> = {
  assistantText: ".conv-text",
  toolRunning: '.conv-tool[data-status="running"]',
  toolDone: '.conv-tool[data-status="done"]',
  toolError: '.conv-tool[data-status="error"]',
  subagentGroup: ".conv-subagent",
  resultSuccess: ".conv-result",
  resultError: ".conv-result-error",
  resultInterrupted: ".conv-result-interrupted",
  errorFatal: ".conv-error-fatal",
  permissionDenied: ".conv-perm-denied",
  questionCard: ".conv-question",
  exitPlanMode: ".conv-perm-request",
  // The mixed scene leads with a seq-less permission frame (an AskUserQuestion card) — its card is the
  // signature; the seq-less ordering is asserted separately in the Finding-1 block below.
  permissionThenReply: ".conv-question",
};

// Render a scene's frames through the real model + renderer into a fresh container; return it.
function renderScene(frames: SceneFrame[]): HTMLElement {
  const model = new ConversationModel();
  applySceneToModel(model, frames);
  const container = document.createElement("div");
  document.body.appendChild(container);
  renderTree(container, model.derive());
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Each test starts with empty buffers so a prior test's emissions never replay here.
  clearMockBuffer();
});

// ---------------------------------------------------------------------------------------------
// 1. Per-scene signature (falsifiable per scene).
// ---------------------------------------------------------------------------------------------
describe("scenes — each scene yields its signature node through the real pipeline", () => {
  for (const name of SCENE_NAMES) {
    it(`${name} → ${SIGNATURE[name]}`, () => {
      const frames = SCENES[name]();
      const container = renderScene(frames);
      // resultSuccess's signature is a PLAIN .conv-result — assert it is NOT the error/interrupted
      // variant (those are distinct scenes), so the success scene can't accidentally satisfy via a
      // failure row.
      if (name === "resultSuccess") {
        const row = container.querySelector(".conv-result");
        expect(row).not.toBeNull();
        expect(row!.classList.contains("conv-result-error")).toBe(false);
        expect(row!.classList.contains("conv-result-interrupted")).toBe(false);
      } else {
        expect(container.querySelector(SIGNATURE[name])).not.toBeNull();
      }
    });
  }

  // FALSIFIABILITY PROOF: removing the LAST frame of a representative scene (its key signature
  // frame) makes the signature assertion fail. This is the committed in-test guard that the per-scene
  // assertions above are not vacuous — each scene's signature depends on a specific frame.
  it("FALSIFY: dropping the signature frame fails the assertion (assistantText loses .conv-text)", () => {
    // assistantText's signature node is the assistant_text frame (index 1). Remove it → no .conv-text.
    const frames = SCENES.assistantText();
    const withoutText = frames.filter(
      (f) => !(f.event === "agent-stream" && (f.payload as { kind?: string }).kind === "assistant_text"),
    );
    const container = renderScene(withoutText);
    expect(container.querySelector(".conv-text")).toBeNull();
  });

  it("FALSIFY: dropping the tool_result frame downgrades toolDone away from data-status=done", () => {
    const frames = SCENES.toolDone();
    const withoutResult = frames.filter(
      (f) => !(f.event === "agent-stream" && (f.payload as { kind?: string }).kind === "tool_result"),
    );
    const container = renderScene(withoutResult);
    expect(container.querySelector('.conv-tool[data-status="done"]')).toBeNull();
    // It is still a tool row — just left "running" (proves the downgrade, not a vanished row).
    expect(container.querySelector('.conv-tool[data-status="running"]')).not.toBeNull();
  });

  // FALSIFIABILITY PROOF for the permissionDenied scene (its signature is .conv-perm-denied, which the
  // minimap maps to the red "danger" tier). The signature node is produced by the SINGLE
  // permission_denied agent-stream frame — removing it leaves only the assistant_text + tool_use +
  // failed result, so NO .conv-perm-denied node exists. (Verified RED-then-GREEN: with the frame
  // present the per-scene loop above asserts the row exists; here we assert removing it removes the
  // row, and that the tool row that attempted the write still renders — proving the deny row vanished,
  // not the whole turn.)
  it("FALSIFY: dropping the permission_denied frame removes .conv-perm-denied from permissionDenied", () => {
    const frames = SCENES.permissionDenied();
    const withoutDenial = frames.filter(
      (f) => !(f.event === "agent-stream" && (f.payload as { kind?: string }).kind === "permission_denied"),
    );
    const container = renderScene(withoutDenial);
    expect(container.querySelector(".conv-perm-denied")).toBeNull();
    // The tool the agent attempted to run still renders — proving only the deny row vanished.
    expect(container.querySelector(".conv-tool")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Scene-switch buffer-scoping (the buffer-leak regression guard).
//
// Mimics the controller's subscribe → model → rerender wiring against the REAL mock event bus, so
// the test exercises clearAgentBuffers + replay-on-subscribe + renderTree exactly as the live app
// does. A subscriber that attaches AFTER both scenes are played (the boot/teardown race) must see
// ONLY the most-recently-loaded scene's frames.
// ---------------------------------------------------------------------------------------------
describe("scenes — scene switch does not leak the prior scene's frames", () => {
  // A minimal live harness: subscribe to the two render channels, feed the model, render on each
  // frame. Returns the container so the test can query the rendered DOM after a late subscribe.
  async function liveHarness(): Promise<HTMLElement> {
    const model = new ConversationModel();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const rerender = (): void => renderTree(container, model.derive());
    await listen("agent-stream", (e) => {
      model.appendStream(e.payload as never);
      rerender();
    });
    await listen("tool-permission-requested", (e) => {
      model.appendPermissionRequest(e.payload as never);
      rerender();
    });
    return container;
  }

  it("load scene A, then scene B; a late subscriber renders ONLY scene B's signature", async () => {
    // Play scene A (subagentGroup) then scene B (toolError) through the SAME path playScene uses.
    // playSceneFrames clears the agent buffers BEFORE each scene's frames, so only B remains buffered.
    playSceneFrames(SCENES.subagentGroup());
    playSceneFrames(SCENES.toolError());

    // A subscriber attaches AFTER both loads (the boot/teardown race). Replay-on-subscribe flushes
    // the (now B-only) buffer to it.
    const container = await liveHarness();

    // Scene B's signature is present…
    expect(container.querySelector('.conv-tool[data-status="error"]')).not.toBeNull();
    // …and scene A's signature (the subagent group) is NOT — its frames were cleared, not replayed.
    expect(container.querySelector(".conv-subagent")).toBeNull();
  });

  it("FALSIFY: WITHOUT the per-scene clear, scene A's frames leak into the late subscriber", async () => {
    // Emit BOTH scenes' frames onto the bus WITHOUT clearing between them (the broken Phase-1
    // behavior). The late subscriber then replays BOTH scenes — scene A's subagent group leaks in.
    // This is the proof the clear is load-bearing: with it (the test above) A is absent; without it
    // (here) A is present.
    for (const f of SCENES.subagentGroup()) emitMockEvent(f.event, f.payload);
    for (const f of SCENES.toolError()) emitMockEvent(f.event, f.payload);

    const container = await liveHarness();

    // Scene B is present AND scene A leaked in (the bug the clear prevents).
    expect(container.querySelector('.conv-tool[data-status="error"]')).not.toBeNull();
    expect(container.querySelector(".conv-subagent")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Question card — pending → answered, resolve_tool_permission receives the chosen labels.
//
// Drives the REAL renderQuestionCard via renderTree with an onSubmitQuestion handler that mirrors the
// controller's submitQuestion: it invokes resolve_tool_permission, appends question_answered, and
// re-renders so the card flips to its answered state.
// ---------------------------------------------------------------------------------------------
describe("scenes — questionCard renders interactive, answering flips to answered + resolves", () => {
  it("pending .conv-question → answer → .conv-question-answered with chosen labels in resolve", () => {
    const resolveSpy = vi.fn();
    const model = new ConversationModel();
    applySceneToModel(model, SCENES.questionCard());

    const container = document.createElement("div");
    document.body.appendChild(container);
    let synthSeq = 1;

    // The controller's submitQuestion, in miniature: resolve + record + re-render.
    const onSubmitQuestion = (id: string, answers: AskUserQuestionAnswers): void => {
      resolveSpy({ id, allow: true, message: null, updatedInput: { answers } });
      model.appendQuestionAnswered(id, answers, synthSeq++);
      renderTree(container, model.derive(), { onSubmitQuestion });
    };

    renderTree(container, model.derive(), { onSubmitQuestion });

    // PENDING: the interactive card is present with inputs (radios + checkboxes).
    const card = container.querySelector(".conv-question");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("conv-question-answered")).toBe(false);
    const radios = card!.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const checkboxes = card!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(radios.length).toBeGreaterThan(0);
    expect(checkboxes.length).toBeGreaterThan(0);

    // Answer BOTH questions: pick the first radio (the radio question) and the first checkbox (the
    // multiSelect question). The fixture's first question is the radio, second is the checkbox.
    radios[0].checked = true;
    radios[0].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));

    const submit = card!.querySelector<HTMLButtonElement>(".conv-question-submit");
    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(false); // gate satisfied once every question has a selection
    submit!.click();

    // resolve_tool_permission received the chosen labels keyed by question text.
    // FALSIFY: send answers under wrong keys / omit updatedInput → this toMatchObject goes RED.
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    const callArg = resolveSpy.mock.calls[0][0];
    expect(callArg.id).toBe("ask-mock-1");
    expect(callArg.allow).toBe(true);
    expect(callArg.updatedInput.answers).toEqual({
      "Which rendering approach should the prototype use?": "Canvas 2D",
      "Which platforms must the first cut support?": ["macOS"],
    });

    // ANSWERED: the card re-rendered read-only (no inputs) with the answered class + chosen labels.
    const answered = container.querySelector(".conv-question");
    expect(answered!.classList.contains("conv-question-answered")).toBe(true);
    expect(answered!.querySelectorAll("input")).toHaveLength(0);
    expect(answered!.textContent).toContain("Canvas 2D");
    expect(answered!.textContent).toContain("macOS");
  });

  it("FALSIFY: dropping the permission frame removes the question card entirely", () => {
    const frames = SCENES.questionCard().filter((f) => f.event !== "tool-permission-requested");
    const container = renderScene(frames);
    expect(container.querySelector(".conv-question")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 4. AgentStream UNION EXHAUSTIVENESS GUARD.
//
// THE INVARIANT (two-layered, rot-proof + falsifiable): every discriminant of the REAL
// `AgentStream["kind"]` union (conversation/types.ts) is consciously classified — either DRIVEN by the
// mock (a scene builder frame and/or a core.ts command-handler emission) or listed in KNOWN_UNCOVERED
// with a one-line reason. When someone adds an 11th union member, this goes RED two ways:
//
//   • COMPILE-TIME (the rot-proof spine): COVERAGE is typed `Record<AgentStream["kind"], …>`, so tsc
//     forces a key for EVERY union member and rejects any key that is not a real discriminant. A new
//     member with no COVERAGE key fails `tsc --noEmit`; a typo'd / removed member fails too. This is
//     the deliberate "add a scene or allowlist it" gate — it cannot silently rot because the key set
//     is derived from the union type itself, not hand-listed.
//
//   • RUN-TIME (the falsifiability layer): the kinds COVERAGE marks "scene"/"core" are cross-checked
//     against the kinds the scene builders + core.ts command handlers ACTUALLY produce at runtime
//     (derived by iterating the builders and by driving the real core handlers through invoke()). So a
//     bogus extra discriminant, or removing a covered kind from every scene, flips a check RED — the
//     classification can never drift from what the mock genuinely drives.
// ---------------------------------------------------------------------------------------------
describe("scenes — AgentStream union exhaustiveness guard", () => {
  // The single conscious classification of every AgentStream discriminant. Keyed by the REAL union's
  // `kind`, so tsc rejects a missing/typo'd/bogus key — the compile-time half of the guard.
  //   "scene"     — produced by at least one scene builder's agent-stream frame.
  //   "core"      — emitted by a core.ts command handler (a follow-up frame outside any scene builder).
  //   "uncovered" — intentionally not driven by the mock (see KNOWN_UNCOVERED for the reason).
  const COVERAGE = {
    system_init: "scene",
    assistant_text: "scene",
    tool_use: "scene",
    tool_result: "scene",
    subagent_started: "scene",
    result: "scene",
    mode_change: "core",
    status: "uncovered",
    permission_denied: "scene",
    resume_fallback: "uncovered",
  } as const satisfies Record<AgentStream["kind"], "scene" | "core" | "uncovered">;

  // The explicit allowlist of NOT-driven kinds, each with a one-line reason. MUST stay in lockstep with
  // the "uncovered" entries in COVERAGE (asserted below) so an uncovered kind always carries a reason.
  const KNOWN_UNCOVERED: Record<string, string> = {
    status:
      "throttled in-place working signal; the deck drives the working indicator via session state, not a status frame.",
    resume_fallback:
      "non-fatal SDK resume-miss notice; the mock never resumes a (non-existent) prior SDK session.",
  };

  // Every classified kind (the tsc-validated key universe). Object.keys(COVERAGE) is exactly the real
  // union's discriminant set because COVERAGE is typed against AgentStream["kind"].
  const ALL_KINDS = Object.keys(COVERAGE) as Array<AgentStream["kind"]>;

  const kindsClassifiedAs = (label: "scene" | "core" | "uncovered"): string[] =>
    ALL_KINDS.filter((k) => COVERAGE[k] === label).sort();

  // RUNTIME derivation #1: the agent-stream kinds the SCENE BUILDERS actually produce. Iterates every
  // registered builder's frames and collects each agent-stream payload's `kind`. (agent-error /
  // tool-permission-requested frames carry their OWN discriminants — AgentError.kind /
  // ToolPermissionRequested.kind — which are NOT AgentStream members, so they are excluded here.)
  function sceneProducedKinds(): Set<string> {
    const kinds = new Set<string>();
    for (const name of SCENE_NAMES) {
      for (const frame of SCENES[name]()) {
        if (frame.event === "agent-stream") {
          kinds.add((frame.payload as AgentStream).kind);
        }
      }
    }
    return kinds;
  }

  // RUNTIME derivation #2: the agent-stream kinds CORE.TS COMMAND HANDLERS emit OUTSIDE a scene builder
  // (the follow-up frames the dispatch switch pushes onto the bus). We subscribe to the bus, drive the
  // real handlers through invoke(), and collect every emitted `kind`. This is faithful (it runs the
  // actual handlers) and falsifiable (drop the mode_change emit and this set shrinks → the "core" check
  // below goes RED). NOTE: many handlers also emit assistant_text/result, which scenes already cover —
  // we only ASSERT the kinds COVERAGE attributes specifically to "core" are present here.
  async function coreEmittedKinds(): Promise<Set<string>> {
    resetState();
    clearMockBuffer();
    const kinds = new Set<string>();
    await listen("agent-stream", (e) => void kinds.add((e.payload as AgentStream).kind));
    // Drive the command handlers that emit follow-up agent-stream frames (mirrors the live UI seams:
    // free-text send, mode toggle, resolve a held permission, cancel a turn).
    await invoke("send_agent_message", { text: "hello" });
    await invoke("set_agent_permission_mode", { mode: "acceptEdits" });
    await invoke("resolve_tool_permission", { id: "x", allow: true, message: null });
    await invoke("cancel_agent_run");
    return kinds;
  }

  it("COVERAGE classifies EVERY AgentStream discriminant (compile-time) and only real ones", () => {
    // Belt-and-suspenders runtime sanity behind the tsc spine: the classified universe is non-empty and
    // has no duplicate keys. (tsc already proves the keys ARE the union; this guards a silently-empty
    // map if the type ever degraded to `any`.)
    expect(ALL_KINDS.length).toBeGreaterThan(0);
    expect(new Set(ALL_KINDS).size).toBe(ALL_KINDS.length);
  });

  it("every COVERAGE 'scene' kind is actually produced by a scene builder (falsifiable)", () => {
    const produced = sceneProducedKinds();
    const claimedScene = kindsClassifiedAs("scene");
    // FALSIFY: removing a covered kind from every scene (or mis-marking an unproduced kind "scene")
    // makes `produced` miss a claimed kind → this fails, naming it.
    const missing = claimedScene.filter((k) => !produced.has(k));
    expect(missing, `COVERAGE marks these 'scene' but no scene builder produces them: [${missing}]`).toEqual([]);
    // And NO scene-produced kind may be left unclassified as scene/core (a scene producing a kind
    // marked "uncovered" is a contradiction — it IS covered).
    const producedButUncovered = [...produced].filter((k) => COVERAGE[k as AgentStream["kind"]] === "uncovered").sort();
    expect(
      producedButUncovered,
      `these kinds ARE produced by a scene yet marked 'uncovered': [${producedButUncovered}]`,
    ).toEqual([]);
  });

  it("every COVERAGE 'core' kind is actually emitted by a core.ts command handler (falsifiable)", async () => {
    const emitted = await coreEmittedKinds();
    const claimedCore = kindsClassifiedAs("core");
    // FALSIFY: drop the mode_change emit in core.ts (or mis-mark a non-emitted kind "core") → `emitted`
    // misses a claimed kind → this fails.
    const missing = claimedCore.filter((k) => !emitted.has(k));
    expect(missing, `COVERAGE marks these 'core' but no command handler emits them: [${missing}]`).toEqual([]);
  });

  it("KNOWN_UNCOVERED matches the 'uncovered' classification exactly, each with a reason", () => {
    const uncovered = kindsClassifiedAs("uncovered");
    // The allowlist keys MUST equal the uncovered classification (no uncovered kind without a reason;
    // no stale reason for a now-covered kind).
    expect(Object.keys(KNOWN_UNCOVERED).sort()).toEqual(uncovered);
    // Every reason is a non-empty one-liner.
    for (const k of uncovered) {
      expect(KNOWN_UNCOVERED[k]?.trim().length ?? 0).toBeGreaterThan(0);
    }
    // Confirm the expected uncovered set (status / resume_fallback — permission_denied is now driven by
    // the permissionDenied scene, so it is "scene", not "uncovered").
    expect(uncovered).toEqual(["resume_fallback", "status"]);
  });
});
