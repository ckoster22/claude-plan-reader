// REAL-WIRING reproduction for the minecraft-clone halt bug.
//
// The existing orchestrator tests script the run through h.dispatch(...) with idealized synthetic
// frames; they NEVER replay the actual sidecar frame sequence through the REAL index.ts bridge +
// REAL orchestrator. This file does exactly that: it replays the EXACT frame sequence the sidecar
// emits for a recon turn that used the scope-recon SUBAGENT (extracted from the failed run's SDK
// transcript at ~/.claude/projects/-Users-…-scratch-minecraft/18fcd059-…), through the real
// `initConversation` agent-stream listener into the real `createOrchestrator()` handle.
//
// The invariant under test: when the recon turn's top-level `result` frame arrives, the orchestrator
// MUST dispatch RECON_DONE — i.e. it must leave master.phase "recon" and send the sizer prompt. The
// live app halts at recon ("Run complete", state.json never updated), so this test pins the boundary.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversationElements } from "./index";

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    H.invokeCalls.push({ cmd, args: args ?? {} });
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "write_plan_tree_file") return Promise.resolve("/abs/.plan-tree/state.json");
    if (cmd === "write_agent_plan") return Promise.resolve("/abs/plans/x.md");
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    (H.listeners[name] ??= []).push(handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import { initConversation } from "./index";
import {
  createOrchestrator,
  isOrchestrationActive,
  __setOrchestratorForTest,
  __resetOrchestratorForTest,
  type OrchestratorHandle,
} from "./orchestrator";

// "stage/phase" of the root node — the gen-2 spelling of the old master.phase assertions.
function rootPhase(h: OrchestratorHandle): string {
  const r = h.snapshot().root;
  return `${r.state.stage}/${r.state.phase}`;
}

function el<T extends HTMLElement>(tag: string): T {
  return document.createElement(tag) as T;
}
function makeEls(): ConversationElements {
  const composer = {
    modal: el<HTMLElement>("div"),
    request: el<HTMLTextAreaElement>("textarea"),
    dirField: el<HTMLInputElement>("input"),
    chooseDirBtn: el<HTMLButtonElement>("button"),
    modeToggle: null,
    startBtn: el<HTMLButtonElement>("button"),
    cancelBtn: el<HTMLButtonElement>("button"),
    tokenInput: el<HTMLInputElement>("input"),
    error: el<HTMLElement>("div"),
  };
  const status = {
    pill: el<HTMLElement>("span"),
    authBlock: el<HTMLElement>("div"),
    tokenInput: composer.tokenInput,
    tokenSubmit: el<HTMLButtonElement>("button"),
    error: composer.error,
  };
  status.authBlock.className = "hidden";
  const stream = el<HTMLElement>("div");
  document.body.appendChild(stream);
  return {
    stream,
    cancelBtn: el<HTMLButtonElement>("button"),
    pauseBtn: el<HTMLButtonElement>("button"),
    resumeBtn: el<HTMLButtonElement>("button"),
    newPlanBtn: el<HTMLButtonElement>("button"),
    messageInput: el<HTMLTextAreaElement>("textarea"),
    sendBtn: el<HTMLButtonElement>("button"),
    composer,
    status,
  } as ConversationElements;
}

function fire(name: string, payload: unknown): void {
  for (const h of H.listeners[name] ?? []) h({ payload });
}
async function flush(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
function calls(cmd: string): Array<Record<string, unknown>> {
  return H.invokeCalls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  document.body.innerHTML = "";
  __resetOrchestratorForTest();
});

// The EXACT recon-turn frame sequence the sidecar emits for "create a minecraft clone" (the run that
// used the scope-recon subagent). Reconstructed from the SDK transcript + sidecar/index.ts normalize():
//   system_init → status → subagent_started(Agent) → tool_use(Agent) →
//   [subagent child assistant_text frames, parent_tool_use_id = the Agent id] →
//   tool_result(Agent) → assistant_text(verbatim report, parent null) → result(success).
const AGENT_TU_ID = "toolu_01QYQEN4Sx1GR5UiGgEra8SV";
const INTENT_TU_ID = "toolu_01INTENTCLARIFIER0000000";

// The OPENING intent turn the sidecar emits for a run that used the intent-clarifier subagent (the
// genesis turn now). Same frame shape as recon (subagent → verbatim final message → result); its
// top-level `result` must dispatch INTENT_CLARIFIED, advancing clarifying-intent → recon.
function fireIntentTurn(): void {
  fire("agent-stream", { seq: 101, kind: "system_init", model: "m", cwd: "/work", tools: [], skills: [], slash_commands: [], permission_mode: "plan", session_id: "s1" });
  fire("agent-stream", { seq: 102, kind: "subagent_started", tool_use_id: INTENT_TU_ID, subagent_type: "intent-clarifier", description: "Clarify intent", prompt: "…" });
  fire("agent-stream", { seq: 103, kind: "tool_use", id: INTENT_TU_ID, tool: "Agent", input: { subagent_type: "intent-clarifier" }, parent_tool_use_id: null });
  fire("agent-stream", { seq: 104, kind: "tool_result", tool_use_id: INTENT_TU_ID, content: "Intent …", is_error: false, parent_tool_use_id: null });
  fire("agent-stream", { seq: 105, kind: "assistant_text", text: "INTENT: build a minecraft clone; offline; runs in browser", parent_tool_use_id: null });
  fire("agent-stream", { seq: 106, kind: "result", subtype: "success", is_error: false, result: "INTENT …", num_turns: 1, duration_ms: 100, total_cost_usd: 0.01, session_id: "s1" });
}

function fireReconTurn(): void {
  fire("agent-stream", { seq: 1, kind: "system_init", model: "m", cwd: "/work", tools: [], skills: [], slash_commands: [], permission_mode: "plan", session_id: "s1" });
  fire("agent-stream", { seq: 2, kind: "status", label: "thinking…" });
  fire("agent-stream", { seq: 3, kind: "subagent_started", tool_use_id: AGENT_TU_ID, subagent_type: "scope-recon", description: "Scope recon for Minecraft clone request", prompt: "…" });
  fire("agent-stream", { seq: 4, kind: "tool_use", id: AGENT_TU_ID, tool: "Agent", input: { subagent_type: "scope-recon" }, parent_tool_use_id: null });
  // The subagent's OWN child assistant_text frames carry parent_tool_use_id = the Agent id.
  fire("agent-stream", { seq: 5, kind: "assistant_text", text: "Surveying the working directory…", parent_tool_use_id: AGENT_TU_ID });
  fire("agent-stream", { seq: 6, kind: "tool_result", tool_use_id: AGENT_TU_ID, content: "Scope-Recon Report …", is_error: false, parent_tool_use_id: null });
  // The top-level verbatim report (parent null).
  fire("agent-stream", { seq: 7, kind: "assistant_text", text: "**Scope-Recon Report**\n\n**Verdict**: non-repo", parent_tool_use_id: null });
  // The turn-ending top-level result.
  fire("agent-stream", { seq: 8, kind: "result", subtype: "success", is_error: false, result: "**Scope-Recon Report** …", num_turns: 1, duration_ms: 1234, total_cost_usd: 0.01, session_id: "s1" });
}

describe("REAL wiring — recon turn (with scope-recon subagent) must advance past recon", () => {
  it("the recon `result` dispatches RECON_DONE: master leaves 'recon' and the sizer prompt is sent", async () => {
    const orch = createOrchestrator(); // REAL deps bound to the mocked invoke
    __setOrchestratorForTest(orch);
    await orch.start({ cwd: "/work", request: "create a minecraft clone" });
    expect(isOrchestrationActive()).toBe(true);
    // After start(): the run opens in the intent-clarification phase, with the intent prompt sent #1.
    expect(rootPhase(orch)).toBe("open/clarifying-intent");

    // Boot the REAL controller AFTER start (mirrors the live app: composer.start() runs, THEN frames
    // stream in through the agent-stream listener initConversation registers).
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // The OPENING intent turn advances clarifying-intent → recon (the recon turn now FOLLOWS intent).
    fireIntentTurn();
    await flush(40);
    expect(rootPhase(orch)).toBe("open/recon");
    const sendsAfterIntent = calls("send_agent_message").length;

    // Replay the REAL recon frame sequence through the REAL bridge.
    fireReconTurn();
    await flush(40);

    // INVARIANT: the recon result advanced the orchestrator off the recon phase. The live bug halts
    // here — the root stays open/recon and no sizer prompt is sent.
    // FALSIFY: if NODE_RECON_DONE never fires, the root stays open/recon → RED.
    expect(rootPhase(orch)).not.toBe("open/recon");
    // The sizer prompt was sent as the next turn (a NEW send_agent_message beyond the recon send).
    expect(calls("send_agent_message").length).toBeGreaterThan(sendsAfterIntent);
  });
});
