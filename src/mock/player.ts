// Mock-mode scene PLAYER — the single place that turns a scene's ordered SceneFrame[] into the
// REAL conversation pipeline's inputs.
//
// Two consumers share this one module so they can never drift:
//   • LIVE mock playback (core.ts start_agent_session / api.playScene): each frame is pushed onto the
//     mock event bus via emitMockEvent so the unmodified conversation listeners receive it exactly as
//     they would a real Tauri event.
//   • TESTS (scenes.test.ts): each frame is applied DIRECTLY onto a ConversationModel via
//     applySceneToModel, so the pure model + renderTree can be asserted without the DOM controller.
//
// REPLAY-BUFFER SCENE-SCOPING (load-bearing): before staging a new scene's frames the player clears
// the mock event buffer for EVERY agent event name, so a switched-to scene never replays the PREVIOUS
// scene's frames to a listener that subscribes later (the boot/teardown race). See clearAgentBuffers.

import type { ConversationModel } from "../conversation/stream";
import type { AgentStream, ToolPermissionRequested, AgentError, AgentExit } from "../conversation/types";
import { emitMockEvent, clearMockBuffer } from "./event";
import type { SceneFrame } from "./fixtures/scenes";

// The agent event names the conversation domain subscribes to AND the player emits on. Cleared
// per-scene-load so a stale scene's history can never replay to a fresh subscriber. (`agent-stream`
// and `tool-permission-requested` are the buffered render channels; the error/exit channels are
// included for completeness so a prior scene's terminal error can't bleed into the next scene.)
export const AGENT_EVENT_NAMES = [
  "agent-stream",
  "tool-permission-requested",
  "agent-error",
  "agent-exit",
] as const;

// Clear the buffered emissions for EVERY agent event name. Called at the start of every scene load
// (playScene / start_agent_session) BEFORE staging the new scene's frames, so a later subscriber
// (e.g. after a conversation teardown + re-init) never replays the previous scene's frames.
export function clearAgentBuffers(): void {
  for (const name of AGENT_EVENT_NAMES) clearMockBuffer(name);
}

// Emit a single scene frame onto the LIVE event bus. Every scene channel maps to a REAL Tauri event,
// so a scene's live playback always matches its model-direct test path (no no-wire-route channel that
// would render nothing live while its test still passed — see fixtures/scenes.ts SceneEvent note).
function emitSceneFrame(frame: SceneFrame): void {
  switch (frame.event) {
    case "agent-stream":
      emitMockEvent("agent-stream", frame.payload as AgentStream);
      break;
    case "tool-permission-requested":
      emitMockEvent("tool-permission-requested", frame.payload as ToolPermissionRequested);
      break;
    case "agent-error":
      emitMockEvent("agent-error", frame.payload as AgentError);
      break;
    case "agent-exit":
      emitMockEvent("agent-exit", frame.payload as AgentExit);
      break;
  }
}

// Stage + play a scene on the LIVE event bus. Clears the agent buffers FIRST (scene-scoping), then
// emits each frame. `delayMs` 0 (default) emits synchronously → the final state appears instantly;
// >0 spaces the emissions so you can "watch it stream". Returns a cancel fn that stops any pending
// delayed emissions (so a scene switch mid-stream does not interleave the old scene's tail).
export function playSceneFrames(frames: SceneFrame[], delayMs = 0): () => void {
  clearAgentBuffers();

  if (delayMs <= 0) {
    for (const frame of frames) emitSceneFrame(frame);
    return () => {};
  }

  // Delayed playback: schedule each frame `delayMs` apart. Track the timer so a cancel stops the
  // tail (a scene switch mid-stream).
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  frames.forEach((frame, i) => {
    timers.push(
      setTimeout(() => {
        if (!cancelled) emitSceneFrame(frame);
      }, delayMs * i),
    );
  });
  return () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
  };
}

// Apply a scene's frames DIRECTLY onto a ConversationModel (the test path — no DOM controller, no
// event bus). Mirrors how the real controller (conversation/index.ts) feeds each event into the
// model, so the derived tree is identical to the live render. `agent-error` / `agent-exit` carry no
// wire seq, so a monotonic synthetic seq is assigned (exactly as the controller's synthSeq does),
// ordered after every scene frame so they interleave at their arrival point.
export function applySceneToModel(model: ConversationModel, frames: SceneFrame[]): void {
  let synthSeq = 1_000_000_000;
  for (const frame of frames) {
    switch (frame.event) {
      case "agent-stream":
        model.appendStream(frame.payload as AgentStream);
        break;
      case "tool-permission-requested":
        model.appendPermissionRequest(frame.payload as ToolPermissionRequested);
        break;
      case "agent-error":
        model.appendError(frame.payload as AgentError, synthSeq++);
        break;
      case "agent-exit":
        model.appendExit(frame.payload as AgentExit, synthSeq++);
        break;
    }
  }
}
