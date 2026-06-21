// Mock-mode reproduction — history-view Send RESUMES the selected plan's session (the user's REAL bug).
//
// The user's failure: a plan COMPLETED, they came back to it AFTER THE FACT, SELECTED it from the
// sidebar (→ the REAL openPlan → loadPlanHistory → loadHistoryForPlan), switched to the Conversation
// tab, typed, and hit Send — and NOTHING happened. No run was started this launch, so lastCwd was null
// and Send's none-branch silently returned at `if (lastCwd === null) return;`.
//
// This test boots the REAL frontend (main.ts → initConversation → the REAL index.ts controller) against
// the REAL mock Tauri shim (`./core`) — the SAME backend `npm run mock` serves — token-free. It then:
//   1. drives the REAL history-select path via __mock.showHistory (→ the REAL openPlan(HISTORY_STEM) →
//      loadPlanHistory → the REAL index.ts loadHistoryForPlan(stem)), whose mock read_plan_transcript
//      returns found:true with a cwd + session_id, exactly like the live backend / sidebar selection of
//      a completed plan,
//   2. types into the REAL composer textarea + clicks the REAL Send button,
//   3. asserts the REAL mock core received start_agent_session (with resumeSessionId = the plan's
//      session_id) THEN send_agent_message — i.e. Send DISPATCHED A RESUME instead of dead-ending —
//      AND that the mock's send-reply ("You said: …") actually rendered into the live stream.
//
// CROSS-BOUNDARY: unlike index.test.ts (which mocks invoke), this exercises the real index.ts logic
// against the real mock invoke dispatch — the boundary the project memory warns mocked unit tests hide.
// We capture the dispatched commands by wrapping the mock dispatcher (diag_log) — see recordedInvokes.
//
// Falsifiable: revert the loadHistoryForPlan resume-target capture (lastCwd/lastSessionId from
// res.cwd/res.session_id) → Send's none-branch returns → ZERO start_agent_session + no send-reply → RED.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture every invoke the REAL frontend makes by intercepting at the mock's `invoke` entry. We do this
// by mocking the @tauri-apps/api/core module with a WRAPPER around the real mock core, so main.ts's
// imported `invoke` binding IS the wrapper (the recording is observed at the true call boundary).
const recordedInvokes: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

vi.mock("@tauri-apps/api/core", async () => {
  const real = await import("./core");
  return {
    ...real,
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      recordedInvokes.push({ cmd, args });
      return real.invoke(cmd, args);
    },
  };
});
vi.mock("@tauri-apps/api/event", async () => await import("./event"));
vi.mock("@tauri-apps/api/path", async () => await import("./path"));
vi.mock("@tauri-apps/api/window", async () => await import("./window"));
vi.mock("@tauri-apps/plugin-opener", async () => await import("./opener"));
vi.mock("@tauri-apps/plugin-dialog", async () => await import("./dialog"));
vi.mock("../titlebar", () => ({
  initTitlebar: vi.fn(),
  initThemeToggle: vi.fn(),
  initTextSize: vi.fn(),
}));

import { clearMockBuffer } from "./event";
import { resetState } from "./state";
import { installMockApi } from "./api";
import { installMockOrchestrator } from "./orchestrator";
import { HISTORY_STEM, transcriptFor } from "./fixtures/transcripts";
import { openPlan } from "../main";
import { asAbsPath, asStem } from "../types";

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button class="conv-new-plan" id="new-plan-btn"></button>
    </div></div>
    <div class="tab-pane active" id="tab-plans"><div class="plan-list" id="plan-list"></div>
      <span id="plan-count"></span>
      <div class="sidebar-status"><span class="conv-status" id="sdk-status"></span></div></div>
    <main id="reader-scroll"><div class="reader-inner">
      <div class="tab-row reader-tab-row">
        <span class="tab active" data-tab="plan">Plan</span>
        <span class="tab" data-tab="conversation">Conversation</span>
      </div>
      <div class="tab-pane active" id="tab-plan"><div class="md" id="reading-pane"></div></div>
      <div class="tab-pane" id="tab-conversation">
        <button class="conv-cancel" id="conversation-cancel"></button>
        <button id="conversation-pause"></button>
        <button id="conversation-resume"></button>
        <div class="conv-stream" id="conversation-stream"></div>
        <textarea id="conversation-input-field"></textarea>
        <button id="conversation-send"></button>
      </div>
    </div></main>
    <div class="conv-modal hidden" id="composer-modal">
      <textarea id="composer-request"></textarea><input id="composer-dir" />
      <button id="composer-choose-dir"></button>
      <div id="composer-mode"><button class="conv-mode-btn active" data-mode="plan"></button></div>
      <button id="composer-start"></button><button id="composer-cancel"></button>
      <div class="conv-auth hidden" id="composer-auth"><input id="composer-token" /><button id="composer-token-submit"></button></div>
    </div>
    <div id="composer-status"></div>
    <div class="toast hidden" id="toast"></div>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

describe("history-view Send RESUMES the selected plan's session (REAL frontend + REAL mock invoke)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    recordedInvokes.length = 0;
    clearMockBuffer();
    resetState();
    window.__mockNoReload = true;
    installMockOrchestrator();
    installMockApi();
  });

  it("select a completed plan (history replay) → type → Send dispatches start_agent_session(resume) + send_agent_message", async () => {
    bootDom();
    await flush();

    // Sanity: the mock backend serves THIS completed plan with a resumable session_id (the precondition
    // for the bug — without a session_id there'd be nothing to resume). Mirrors the live backend's
    // read_plan_transcript for an app-authored / tree plan.
    const fixture = transcriptFor(HISTORY_STEM);
    expect(fixture.found).toBe(true);
    expect(fixture.cwd).toBe("/Users/mock/work/notes");
    expect(fixture.session_id).toBe("mock-history-session");

    // Drive the REAL sidebar-selection path EXACTLY as a plan click does: call the REAL main.ts
    // openPlan(path, stem) for the completed plan. openPlan fires loadPlanHistory(stem) →
    // the REAL index.ts loadHistoryForPlan(stem) (fire-and-forget) → mock read_plan_transcript. No live
    // session is started (the user is just opening a finished plan), so the controller stays "none" and
    // the history pane replays — precisely the conditions of the user's bug.
    await openPlan(
      asAbsPath(`/Users/mock/.claude/plans/${HISTORY_STEM}.md`),
      asStem(HISTORY_STEM),
    );
    await flush();

    // The Conversation tab now shows the REPLAYED history (proof the history-view path actually ran).
    const stream = document.querySelector("#conversation-stream")!;
    expect(stream.textContent ?? "").toContain("Here is the plan I drafted earlier.");

    // Isolate the Send's invokes from the history-load noise.
    recordedInvokes.length = 0;

    // Type into the REAL composer textarea and click the REAL Send button.
    const input = document.querySelector<HTMLTextAreaElement>("#conversation-input-field")!;
    const sendBtn = document.querySelector<HTMLButtonElement>("#conversation-send")!;
    // Composer is force-enabled in the controller — confirm the user sees a live Send affordance.
    expect(input.disabled).toBe(false);
    expect(sendBtn.disabled).toBe(false);

    input.value = "now do the next thing";
    sendBtn.click();
    await flush();

    // BEFORE THE FIX: lastCwd was null → Send's none-branch returned → ZERO start_agent_session.
    // AFTER THE FIX: loadHistoryForPlan captured cwd+session_id → Send re-opens (resumes) the session.
    const starts = recordedInvokes.filter((c) => c.cmd === "start_agent_session");
    expect(starts).toHaveLength(1);
    expect(starts[0].args?.cwd).toBe("/Users/mock/work/notes");
    expect(starts[0].args?.resumeSessionId).toBe("mock-history-session");
    const sends = recordedInvokes.filter((c) => c.cmd === "send_agent_message");
    expect(sends).toHaveLength(1);
    expect(sends[0].args?.text).toBe("now do the next thing");

    // CROSS-BOUNDARY OUTCOME: the mock backend's send_agent_message reply actually rendered into the
    // live stream — proof the dispatch reached the real mock backend and drove a real turn, not just a
    // recorded call. (The mock echoes `You said: "<text>". Here is a follow-up reply.`)
    expect(stream.textContent ?? "").toContain('You said: "now do the next thing"');
  });
});
