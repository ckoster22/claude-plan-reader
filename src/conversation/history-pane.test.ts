// Conversation domain — plan-select history replay (loadHistoryForPlan) tests.
//
// Mirrors index.test.ts's harness: mock ONLY the Tauri seams (invoke/listen/path) + the dialog
// plugin; drive events through the captured listen handlers; record commands for assertions. These
// tests pin the PaneSource state machine through the PUBLIC handle + the observable DOM
// (#conversation-stream contents), never module-locals directly.
//
// FALSIFIABLE invariants:
//  - loadHistoryForPlan is a NO-OP while a session is live (history must never clobber live).
//  - loadHistoryForPlan is a NO-OP while isOrchestrationActive().
//  - happy path: found + lines → history nodes render into the stream.
//  - found=false → .conv-empty (no-transcript message).
//  - found=true but zero nodes → .conv-empty (no-content message).
//  - a live transition AFTER a history load flips the pane back to live (historyGen bump drops it).
//  - a stale resolve (gen mismatch from an A→B switch) is dropped.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversationElements } from "./index";

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  hasToken: true,
  // Per-test programmable resolver for read_plan_transcript. Returns the value (or a Promise the
  // test controls, to simulate out-of-order resolution). Defaults to a not-found result.
  transcript: undefined as undefined | ((args: Record<string, unknown>) => unknown),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    H.invokeCalls.push({ cmd, args: args ?? {} });
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: H.hasToken });
    if (cmd === "read_plan_transcript") {
      const out = H.transcript
        ? H.transcript(args ?? {})
        : { found: false, path: null, cwd: null, session_id: null, lines: [] };
      return Promise.resolve(out);
    }
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
} from "./orchestrator";

function el<T extends HTMLElement>(tag: string): T {
  return document.createElement(tag) as T;
}

function makeEls(): ConversationElements & {
  newPlanBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
  resumeBtn: HTMLButtonElement;
  stream: HTMLElement;
  modal: HTMLElement;
  messageInput: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
} {
  const modal = el<HTMLElement>("div");
  modal.className = "hidden";
  const cancelBtn = el<HTMLButtonElement>("button");
  const pauseBtn = el<HTMLButtonElement>("button");
  const resumeBtn = el<HTMLButtonElement>("button");
  const newPlanBtn = el<HTMLButtonElement>("button");
  const messageInput = el<HTMLTextAreaElement>("textarea");
  const sendBtn = el<HTMLButtonElement>("button");
  const composer = {
    modal,
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
    cancelBtn,
    stopBtn: cancelBtn,
    pauseBtn,
    resumeBtn,
    newPlanBtn,
    messageInput,
    sendBtn,
    composer,
    status,
    modal,
  };
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

// A system_init stream frame marks a session live (mirrors index.test.ts).
const SYSTEM_INIT = {
  seq: 1,
  kind: "system_init",
  model: "m",
  cwd: "/w",
  tools: [],
  skills: [],
  slash_commands: [],
  permission_mode: "plan",
  session_id: "s1",
} as const;

// A transcript jsonl line carrying one assistant text block — yields exactly one renderable node.
function assistantLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}
// A transcript jsonl line carrying one user text block.
function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  H.hasToken = true;
  H.transcript = undefined;
  document.body.innerHTML = "";
  __resetOrchestratorForTest();
});

// ---------------------------------------------------------------------------------------------
// NO-OP while live: history must never clobber the live model.
// ---------------------------------------------------------------------------------------------
describe("loadHistoryForPlan — no-op while a session is live", () => {
  it("while live, loadHistoryForPlan does NOT invoke read_plan_transcript and the live model keeps the pane", async () => {
    H.transcript = () => ({
      found: true,
      path: "/p",
      cwd: "/w",
      session_id: "s",
      lines: [assistantLine("HISTORY ASSISTANT TEXT")],
    });
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Go live: an assistant_text frame renders a live bubble.
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "assistant_text", text: "LIVE ASSISTANT TEXT", parent_tool_use_id: null });
    await flush();
    expect(els.stream.textContent).toContain("LIVE ASSISTANT TEXT");

    // Attempt to load history while live → guarded NO-OP.
    // FALSIFY: remove the `session !== "none"` guard in loadHistoryForPlan → read_plan_transcript
    // fires and HISTORY ASSISTANT TEXT overwrites the live pane → both assertions below go RED.
    await handle.loadHistoryForPlan("some-stem");
    await flush();
    expect(calls("read_plan_transcript")).toHaveLength(0);
    expect(els.stream.textContent).toContain("LIVE ASSISTANT TEXT");
    expect(els.stream.textContent).not.toContain("HISTORY ASSISTANT TEXT");
    expect(els.stream.querySelector(".conv-empty")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// NO-OP while an orchestration is active (the liveness guard covers orchestration too).
// ---------------------------------------------------------------------------------------------
describe("loadHistoryForPlan — no-op while isOrchestrationActive()", () => {
  it("with an active orchestration but session still none, the load is dropped before invoking", async () => {
    // Install + start a real orchestrator so isOrchestrationActive() === true. The default deps bind
    // to the mocked invoke, so start() makes no real Tauri call.
    const orch = createOrchestrator();
    __setOrchestratorForTest(orch);
    await orch.start({ cwd: "/work", request: "do it" });
    expect(isOrchestrationActive()).toBe(true);

    H.transcript = () => ({
      found: true,
      path: "/p",
      cwd: "/w",
      session_id: "s",
      lines: [assistantLine("HISTORY")],
    });
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Session is still "none" here (no agent-stream yet) — only the orchestration guard can stop it.
    // FALSIFY: drop `|| isOrchestrationActive()` from the guard → read_plan_transcript fires → RED.
    await handle.loadHistoryForPlan("stem");
    await flush();
    expect(calls("read_plan_transcript")).toHaveLength(0);
    expect(els.stream.querySelector(".conv-empty")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Happy path: idle session, transcript found with content → history nodes render.
// ---------------------------------------------------------------------------------------------
describe("loadHistoryForPlan — happy path renders history", () => {
  it("found + lines yielding nodes → the stream gets the replayed assistant + user text", async () => {
    H.transcript = () => ({
      found: true,
      path: "/p",
      cwd: "/w",
      session_id: "sess-1",
      lines: [assistantLine("replayed assistant turn"), userLine("replayed user turn")],
    });
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // FALSIFY: never set paneSource=history (e.g. skip the rerender) → the stream stays empty → RED.
    await handle.loadHistoryForPlan("a-plan");
    await flush();

    expect(calls("read_plan_transcript")).toHaveLength(1);
    expect(calls("read_plan_transcript")[0]).toEqual({ stem: "a-plan" });
    expect(els.stream.querySelector(".conv-empty")).toBeNull();
    expect(els.stream.textContent).toContain("replayed assistant turn");
    expect(els.stream.textContent).toContain("replayed user turn");
    // A replay is never "working" — no working indicator in the history pane.
    expect(els.stream.querySelector(".conv-working")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Empty states: found=false (no-transcript) and found=true w/ zero nodes (no-content).
// ---------------------------------------------------------------------------------------------
describe("loadHistoryForPlan — explicit empty states", () => {
  it("found=false → .conv-empty with the no-transcript message", async () => {
    H.transcript = () => ({ found: false, path: null, cwd: null, session_id: null, lines: [] });
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // FALSIFY: leave the pane blank on !found (no empty node) → the querySelector below is null → RED.
    await handle.loadHistoryForPlan("ghost-plan");
    await flush();
    const empty = els.stream.querySelector(".conv-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe("No conversation history found for this plan.");
  });

  it("found=true but lines yield ZERO renderable nodes → .conv-empty with the no-content message", async () => {
    // Lines that pass the filter but produce no nodes: an assistant record with ONLY whitespace text
    // (skipped by the transform) → the synthesized SystemInit alone yields zero render nodes.
    H.transcript = () => ({
      found: true,
      path: "/p",
      cwd: "/w",
      session_id: "s",
      lines: [assistantLine("   ")],
    });
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // FALSIFY: skip the `derive().nodes.length === 0` branch (always set history) → the pane renders
    // an empty history (no .conv-empty) → the no-content assertion goes RED.
    await handle.loadHistoryForPlan("contentless");
    await flush();
    const empty = els.stream.querySelector(".conv-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe("No conversation content to display for this plan.");
  });
});

// ---------------------------------------------------------------------------------------------
// Live takeover AFTER a history load: a live transition reclaims the pane.
// ---------------------------------------------------------------------------------------------
describe("loadHistoryForPlan — a live transition supersedes a loaded history", () => {
  it("after history renders, going live flips the pane back to the live model", async () => {
    H.transcript = () => ({
      found: true,
      path: "/p",
      cwd: "/w",
      session_id: "s",
      lines: [assistantLine("OLD HISTORY TURN")],
    });
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Load history first (session none) → history pane.
    await handle.loadHistoryForPlan("past-plan");
    await flush();
    expect(els.stream.textContent).toContain("OLD HISTORY TURN");

    // A live run starts: applySessionState("active") must reclaim the pane for the live model.
    // FALSIFY: remove the live-takeover block in applySessionState → the history stays + the live
    // frame never appears → the assertions below go RED.
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "assistant_text", text: "FRESH LIVE TURN", parent_tool_use_id: null });
    await flush();
    expect(els.stream.textContent).toContain("FRESH LIVE TURN");
    expect(els.stream.textContent).not.toContain("OLD HISTORY TURN");
  });

  it("a history load whose resolve lands AFTER a live run started is dropped (historyGen bump)", async () => {
    // A controllable transcript promise: we resolve it manually AFTER firing a live frame, so the
    // post-await freshness check (session !== none) drops the result.
    let release!: (v: unknown) => void;
    const pending = new Promise((res) => {
      release = res;
    });
    H.transcript = () => pending;
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Kick the load (session none) → it invokes read_plan_transcript and awaits the pending promise.
    const loadP = handle.loadHistoryForPlan("racy-plan");
    await flush();
    expect(calls("read_plan_transcript")).toHaveLength(1);

    // A live run starts DURING the await → historyGen bumped + session live.
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "assistant_text", text: "WINNER LIVE TURN", parent_tool_use_id: null });
    await flush();

    // Now the transcript resolves LATE with content. The post-await guard must drop it.
    // FALSIFY: remove the post-await `session !== "none"` / historyGen recheck → LATE HISTORY would
    // overwrite the live pane → RED.
    release({ found: true, path: "/p", cwd: "/w", session_id: "s", lines: [assistantLine("LATE HISTORY")] });
    await loadP;
    await flush();
    expect(els.stream.textContent).toContain("WINNER LIVE TURN");
    expect(els.stream.textContent).not.toContain("LATE HISTORY");
    expect(els.stream.querySelector(".conv-empty")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Stale resolve from a fast A→B plan switch: the first load's late resolve is dropped.
// ---------------------------------------------------------------------------------------------
describe("loadHistoryForPlan — stale resolve on an A→B switch", () => {
  it("two loads where A resolves LAST → only B's result lands (historyGen mismatch drops A)", async () => {
    // A's resolver is held; B's resolves immediately. We release A LAST.
    let releaseA!: (v: unknown) => void;
    const pendingA = new Promise((res) => {
      releaseA = res;
    });
    H.transcript = (args) => {
      if (args.stem === "plan-A") return pendingA;
      // plan-B resolves synchronously with content.
      return { found: true, path: "/b", cwd: "/w", session_id: "sb", lines: [assistantLine("PLAN B CONTENT")] };
    };
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Fire A (held), then B (resolves now). B's gen supersedes A's.
    const loadA = handle.loadHistoryForPlan("plan-A");
    const loadB = handle.loadHistoryForPlan("plan-B");
    await loadB;
    await flush();
    expect(els.stream.textContent).toContain("PLAN B CONTENT");

    // A resolves LATE with different content. The historyGen mismatch must drop it.
    // FALSIFY: remove the `gen !== historyGen` post-await check → A overwrites B → RED.
    releaseA({ found: true, path: "/a", cwd: "/w", session_id: "sa", lines: [assistantLine("PLAN A CONTENT")] });
    await loadA;
    await flush();
    expect(els.stream.textContent).toContain("PLAN B CONTENT");
    expect(els.stream.textContent).not.toContain("PLAN A CONTENT");
  });
});
