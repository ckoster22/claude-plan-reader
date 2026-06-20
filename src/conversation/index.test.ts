// Conversation domain — controller (initConversation) tests.
//
// Covers Fix 3 (auth refresh on composer open) and Fix 4 (session-liveness guard). The real
// StatusController + Composer are constructed inside initConversation; we mock only the Tauri seams
// (invoke/listen/path) and the dialog plugin (so wd-picker is inert). Events are driven through the
// captured listen handlers; commands are recorded for command-level assertions.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversationElements } from "./index";

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  hasToken: true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    H.invokeCalls.push({ cmd, args: args ?? {} });
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: H.hasToken });
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
import { WAITING_INPUT_LABEL, ConversationModel } from "./stream";
import { renderTree } from "./render";
import {
  createOrchestrator,
  isOrchestrationActive,
  __setOrchestratorForTest,
  __setActiveOrchestratorForTest,
  __resetOrchestratorForTest,
  __ingestSeenForTest,
  type OrchestratorHandle,
} from "./orchestrator";
import { open as _open } from "@tauri-apps/plugin-dialog";
const dialogOpen = vi.mocked(_open);
import { invoke as _invoke } from "@tauri-apps/api/core";
// The mocked invoke (records into H.invokeCalls by default). Tests that need a SPECIFIC command to
// reject use mockImplementationOnce on this handle (the override replaces the default body for that
// one call, so the recording is skipped for the overridden call only).
const mockInvoke = vi.mocked(_invoke);

// A fully fake OrchestratorHandle whose start() returns a controllable boolean — lets the composer
// Start tests assert the true (real start) vs false (idempotent no-op) branches without a real run.
// orchestrationActive() is irrelevant here (isOrchestrationActive() reads the module guard, which a
// fake handle does not register in), so these composer tests exercise ONLY the start-boolean contract.
function makeFakeHandle(startResult: boolean): OrchestratorHandle & { start: ReturnType<typeof vi.fn> } {
  const noop = vi.fn(async () => {});
  return {
    start: vi.fn(async () => startResult),
    snapshot: vi.fn(() => ({}) as never),
    approve: noop,
    requestChanges: noop,
    answerClarify: noop,
    ingestStream: noop,
    ingestPermission: noop,
    cancel: noop,
    subscribe: vi.fn(() => () => {}),
    teardown: noop,
    orchestrationActive: vi.fn(() => false),
    resuming: vi.fn(() => false),
    dispatch: noop,
  } as never;
}

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
  attachStrip: HTMLElement;
  fileInput: HTMLInputElement;
} {
  const modal = el<HTMLElement>("div");
  modal.className = "hidden";
  const cancelBtn = el<HTMLButtonElement>("button");
  const pauseBtn = el<HTMLButtonElement>("button");
  const resumeBtn = el<HTMLButtonElement>("button");
  const newPlanBtn = el<HTMLButtonElement>("button");
  const messageInput = el<HTMLTextAreaElement>("textarea");
  const sendBtn = el<HTMLButtonElement>("button");
  // Multimodal in-conversation image input. The attach strip + hidden file input let the
  // createImageAttachments controller be constructed; tests attach images via the file-input change.
  const attachStrip = el<HTMLElement>("div");
  const attachBtn = el<HTMLButtonElement>("button");
  const fileInput = el<HTMLInputElement>("input");
  fileInput.type = "file";
  const attachError = el<HTMLElement>("div");
  // Composer multimodal image input — present so the composer's attachment controller is constructed
  // and the first-turn echo test can attach images through it.
  const composerFileInput = el<HTMLInputElement>("input");
  composerFileInput.type = "file";
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
    attachStrip: el<HTMLElement>("div"),
    attachBtn: el<HTMLButtonElement>("button"),
    fileInput: composerFileInput,
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
  // Attach the stream to the document so rendered question cards are queryable / clickable.
  document.body.appendChild(stream);
  return {
    stream,
    cancelBtn,
    stopBtn: cancelBtn, // Stop === the legacy cancel element (same button)
    pauseBtn,
    resumeBtn,
    newPlanBtn,
    messageInput,
    sendBtn,
    attachStrip,
    attachBtn,
    fileInput,
    attachError,
    composer,
    status,
    modal,
  };
}

// Attach images to the in-conversation surface by driving the hidden file input's `change` event with
// fabricated PNG Files (jsdom's FileReader.readAsDataURL encodes a real Blob to a data: URL, which the
// controller splits into { media_type, data }). Returns once the async encode + render settles.
async function attachImagesViaFileInput(
  fileInput: HTMLInputElement,
  chipStrip: HTMLElement,
  files: File[],
): Promise<void> {
  // A minimal FileList stand-in: indexed entries + length + iterator + item(). attachments.ts reads it
  // via Array.from(fileInput.files), which uses the iterator.
  const fakeList: Record<PropertyKey, unknown> = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      yield* files;
    },
  };
  files.forEach((f, i) => {
    fakeList[i] = f;
  });
  Object.defineProperty(fileInput, "files", { configurable: true, value: fakeList });
  fileInput.dispatchEvent(new Event("change"));
  // FileReader.onload fires asynchronously in jsdom; POLL until every file has produced a chip (or a
  // small budget elapses), yielding to real timers between checks so the encode + render settle.
  for (let i = 0; i < 50; i++) {
    if (chipStrip.querySelectorAll(".conv-attach-chip").length >= files.length) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  await flush();
}

// A minimal PNG File whose base64 payload is deterministic enough for assertions. The 1x1 PNG bytes
// keep it a valid image/png under the controller's media-type guard.
function pngFile(name = "shot.png"): File {
  // 1x1 transparent PNG.
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: "image/png" });
}

function fire(name: string, payload: unknown): void {
  for (const h of H.listeners[name] ?? []) h({ payload });
}
// Microtask budget: must cover the LONGEST awaited chain behind a single user action. The real
// orchestrator's start() awaits startSession + START's effects (resetPlanTreeDir, persist) + the
// intent send, each an invoke().then hop — 8 ticks stopped covering it when START grew the
// resetPlanTreeDir effect, so the budget is 16.
async function flush(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
function calls(cmd: string): Array<Record<string, unknown>> {
  return H.invokeCalls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  H.hasToken = true;
  document.body.innerHTML = "";
  // Reset the shared orchestrator singleton AND the module-level active guard between tests so a
  // leaked isOrchestrationActive()===true never bleeds into a later test.
  __resetOrchestratorForTest();
});

// ---------------------------------------------------------------------------------------------
// Fix 3 — auth refresh on composer open.
// ---------------------------------------------------------------------------------------------
describe("controller — Fix 3: openComposer refreshes auth BEFORE showing", () => {
  it("openComposer re-reads agent_auth_status; with a token present the banner is hidden", async () => {
    const els = makeEls();
    H.hasToken = false; // startup read sees NO token (banner would be shown)
    const handle = await initConversation(els, () => {});
    await flush();
    // init() read once and showed the banner.
    expect(calls("agent_auth_status")).toHaveLength(1);
    expect(els.status.authBlock!.classList.contains("hidden")).toBe(false);

    // A token is added out-of-band; opening the composer must refresh and HIDE the stale banner.
    H.hasToken = true;
    handle.openComposer();
    await flush();
    // FALSIFY: drop the statusController.refresh() in openComposer → this 2nd read never happens (RED).
    expect(calls("agent_auth_status")).toHaveLength(2);
    expect(els.status.authBlock!.classList.contains("hidden")).toBe(true);
    // The modal is shown after the refresh.
    expect(els.modal.classList.contains("hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix 4 — session-liveness guard. Test #5 (falsifiable).
// ---------------------------------------------------------------------------------------------
describe("controller — Fix 4: session-liveness gates New-plan + Cancel", () => {
  it("idle: New-plan enabled, Cancel disabled; a live session inverts both and blocks openComposer", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Idle initial state: New-plan ENABLED, Cancel DISABLED.
    // FALSIFY: remove updateCancelEnabled()/the guard → Cancel stays enabled at idle (RED).
    expect(els.newPlanBtn.disabled).toBe(false);
    expect(els.cancelBtn.disabled).toBe(true);

    // A run starts (system_init stream frame marks the session live).
    fire("agent-stream", { seq: 1, kind: "system_init", model: "m", cwd: "/w", tools: [], skills: [], slash_commands: [], permission_mode: "plan", session_id: "s1" });
    await flush();
    // LIVE: New-plan DISABLED, Cancel ENABLED.
    expect(els.newPlanBtn.disabled).toBe(true);
    expect(els.cancelBtn.disabled).toBe(false);

    // openComposer is a NO-OP while live (modal stays hidden, no extra auth read).
    const before = calls("agent_auth_status").length;
    handle.openComposer();
    await flush();
    expect(els.modal.classList.contains("hidden")).toBe(true);
    expect(calls("agent_auth_status")).toHaveLength(before);

    // The run ends (agent-exit) → liveness clears: New-plan re-enabled, Cancel disabled again.
    fire("agent-exit", { code: 0 });
    await flush();
    expect(els.newPlanBtn.disabled).toBe(false);
    expect(els.cancelBtn.disabled).toBe(true);
  });

  it("Cancel is a no-op (does not invoke cancel_agent_run) unless a session is live", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // Idle: clicking Cancel must NOT invoke cancel_agent_run.
    // FALSIFY: remove the `if (session !== "running") return` guard → cancel_agent_run fires at idle (RED).
    els.cancelBtn.click();
    await flush();
    expect(calls("cancel_agent_run")).toHaveLength(0);

    // Go live, then Cancel DOES invoke once and clears liveness.
    fire("agent-stream", { seq: 1, kind: "system_init", model: "m", cwd: "/w", tools: [], skills: [], slash_commands: [], permission_mode: "plan", session_id: "s1" });
    await flush();
    els.cancelBtn.click();
    await flush();
    expect(calls("cancel_agent_run")).toHaveLength(1);
    // After cancel, liveness cleared → a second click is a no-op again.
    els.cancelBtn.click();
    await flush();
    expect(calls("cancel_agent_run")).toHaveLength(1);
  });

  it("a fatal agent-error clears liveness (New-plan re-enabled)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", { seq: 1, kind: "system_init", model: "m", cwd: "/w", tools: [], skills: [], slash_commands: [], permission_mode: "plan", session_id: "s1" });
    await flush();
    expect(els.newPlanBtn.disabled).toBe(true);

    fire("agent-error", { kind: "sdk", message: "boom", fatal: true });
    await flush();
    expect(els.newPlanBtn.disabled).toBe(false);
    expect(els.cancelBtn.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Single-source SessionState — the leaking-invariant fix. SessionState owned by the controller is
// THE source of truth; New-plan/Cancel/pill are all DERIVED from it so they cannot disagree.
// ---------------------------------------------------------------------------------------------

// system_init stream payload helper (marks a session live).
const SYSTEM_INIT = { seq: 1, kind: "system_init", model: "m", cwd: "/w", tools: [], skills: [], slash_commands: [], permission_mode: "plan", session_id: "s1" } as const;

describe("controller — single-source SessionState: Cancel ends the session (the reported bug)", () => {
  // Test #1: reproduce the EXACT reported failure — Start → Cancel must END the backend session
  // (interrupt + end), reset the pill out of "building", and re-enable New-plan. Before cancel,
  // openComposer is a hard no-op while running.
  it("Start → running (New-plan disabled, Cancel enabled, modal closed, openComposer no-op); Cancel → interrupt+end, none, pill not building, New-plan re-enabled", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Simulate a successful Start via the composer onStarted path: open the modal, fill it, Start.
    // The composer reads its cwd from pickDir (folder picker), so drive that via the mocked dialog.
    dialogOpen.mockResolvedValueOnce("/work");
    handle.openComposer();
    await flush();
    els.composer.chooseDirBtn!.click();
    await flush();
    els.composer.request!.value = "do a thing";
    els.composer.startBtn!.click();
    await flush();

    // After a successful Start: session running.
    expect(els.newPlanBtn.disabled).toBe(true); // New-plan DISABLED ⇔ running
    expect(els.cancelBtn.disabled).toBe(false); // Cancel ENABLED ⇔ running
    expect(els.modal.classList.contains("hidden")).toBe(true); // composer closed by Start
    expect(els.status.pill!.dataset.status).toBe("building"); // pill shows building while running

    // While running, openComposer is a HARD no-op (modal stays hidden).
    handle.openComposer();
    await flush();
    expect(els.modal.classList.contains("hidden")).toBe(true);

    // Cancel: must invoke BOTH cancel_agent_run (interrupt) AND end_agent_session (release slot).
    // FALSIFY: drop end_agent_session from the cancel handler → this assertion goes RED.
    els.cancelBtn.click();
    await flush();
    expect(calls("cancel_agent_run")).toHaveLength(1);
    expect(calls("end_agent_session")).toHaveLength(1);

    // State → none, derived everywhere: pill NOT building, New-plan re-enabled, Cancel disabled.
    // FALSIFY: leave the pill driven by StatusController.building alone (not reset on cancel) → pill
    // stays "building" here → RED.
    expect(els.status.pill!.dataset.status).not.toBe("building");
    expect(els.newPlanBtn.disabled).toBe(false);
    expect(els.cancelBtn.disabled).toBe(true);

    // A late agent-exit (the killed child may or may not emit one) is harmless / idempotent.
    fire("agent-exit", { code: 0 });
    await flush();
    expect(els.newPlanBtn.disabled).toBe(false);
    expect(els.status.pill!.dataset.status).not.toBe("building");
  });
});

describe("controller — single-source SessionState: pill and New-plan cannot disagree", () => {
  // Test #2: drive EVERY transition and assert the derived control triple is internally consistent.
  // The forbidden states are: {none, newPlan.disabled:true}, {running, newPlan.disabled:false},
  // {none, pill:"building"}. Any transition must land in one of the two legal tuples.
  it("every transition yields a consistent {state, newPlanDisabled, pillBuilding} tuple", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // Invariant assertion: New-plan disabled ⇔ pill building ⇔ session running. We derive the
    // intended state from the controls and assert they all agree.
    const assertConsistent = (): void => {
      const newPlanDisabled = els.newPlanBtn.disabled;
      const cancelEnabled = !els.cancelBtn.disabled;
      const pillBuilding = els.status.pill!.dataset.status === "building";
      // FALSIFY: invert any single derivation in applySessionState → one of these equalities breaks → RED.
      expect(newPlanDisabled).toBe(cancelEnabled); // New-plan disabled ⇔ Cancel enabled
      // pill "building" can only appear when running (i.e. when New-plan is disabled). It is allowed
      // to NOT be building while running (e.g. completed-but-not-exited), but never building while idle.
      if (!newPlanDisabled) expect(pillBuilding).toBe(false); // idle ⇒ never building
    };

    assertConsistent(); // idle

    // start (system_init)
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    expect(els.newPlanBtn.disabled).toBe(true);
    assertConsistent();

    // agent-exit
    fire("agent-exit", { code: 0 });
    await flush();
    expect(els.newPlanBtn.disabled).toBe(false);
    assertConsistent();

    // start again, then fatal error
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    assertConsistent();
    fire("agent-error", { kind: "sdk", message: "boom", fatal: true });
    await flush();
    expect(els.newPlanBtn.disabled).toBe(false);
    assertConsistent();

    // start again, then cancel
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    assertConsistent();
    els.cancelBtn.click();
    await flush();
    expect(els.newPlanBtn.disabled).toBe(false);
    assertConsistent();

    void handle;
  });
});

describe("controller — single-source SessionState: modal auto-closes if a session goes running while open", () => {
  // Test #3 (belt-and-suspenders): "modal open while running" must be unrepresentable from BOTH
  // directions — opening while running is blocked (Test #1), and a session going running while the
  // modal is open closes the modal.
  it("modal open (state none) then system_init → modal hidden", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    handle.openComposer();
    await flush();
    expect(els.modal.classList.contains("hidden")).toBe(false); // modal open while idle

    // A session goes live out-of-band while the modal is open.
    // FALSIFY: remove the composer.close() on the running transition → modal stays open → RED.
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    expect(els.modal.classList.contains("hidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PART C — Stop / Pause / Resume: the 3-state SessionState machine (none | active | idle).
// Enabled/disabled is derived PURELY from state in applySessionState, so the controls cannot
// disagree. Stop = interrupt + end (→ none); Pause = interrupt ONLY (→ idle); Resume =
// send_agent_message("Continue.") (→ active).
// ---------------------------------------------------------------------------------------------

const RESULT = { seq: 9, kind: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, duration_ms: 1, total_cost_usd: 0, session_id: "s1" } as const;

describe("controller — 3-state buttons: enabled/disabled matrix across none/active/idle", () => {
  it("none: only New-plan enabled; active: Stop+Pause enabled; idle: Stop+Resume enabled", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // none — Stop disabled, Pause disabled, Resume disabled, New-plan enabled.
    // FALSIFY: derive Pause from `live` instead of `active` → Pause becomes enabled at none/idle → RED.
    expect(els.cancelBtn.disabled).toBe(true);  // Stop
    expect(els.pauseBtn.disabled).toBe(true);   // Pause
    expect(els.resumeBtn.disabled).toBe(true);  // Resume
    expect(els.newPlanBtn.disabled).toBe(false);

    // active (a non-result stream frame) — Stop ENABLED, Pause ENABLED, Resume DISABLED, New-plan DISABLED.
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    expect(els.cancelBtn.disabled).toBe(false);
    expect(els.pauseBtn.disabled).toBe(false);
    expect(els.resumeBtn.disabled).toBe(true);
    expect(els.newPlanBtn.disabled).toBe(true);

    // idle (a result frame: turn done, session alive) — Stop ENABLED, Pause DISABLED, Resume ENABLED,
    // New-plan still DISABLED (a session exists).
    // FALSIFY: keep treating `result` as active → Resume stays disabled, Pause stays enabled → RED.
    fire("agent-stream", RESULT);
    await flush();
    expect(els.cancelBtn.disabled).toBe(false);
    expect(els.pauseBtn.disabled).toBe(true);
    expect(els.resumeBtn.disabled).toBe(false);
    expect(els.newPlanBtn.disabled).toBe(true);
  });
});

describe("controller — Pause interrupts ONLY (cancel_agent_run, not end) and goes idle", () => {
  it("Pause → cancel_agent_run once, NO end_agent_session; Resume + Stop become available", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    fire("agent-stream", SYSTEM_INIT); // active
    await flush();

    els.pauseBtn.click();
    await flush();
    // FALSIFY: have Pause also call end_agent_session → the end_agent_session length-0 assertion goes RED.
    expect(calls("cancel_agent_run")).toHaveLength(1);
    expect(calls("end_agent_session")).toHaveLength(0);
    // State is idle: Resume enabled, Pause disabled, New-plan still disabled (session alive).
    expect(els.resumeBtn.disabled).toBe(false);
    expect(els.pauseBtn.disabled).toBe(true);
    expect(els.newPlanBtn.disabled).toBe(true);

    // A second Pause click at idle is a no-op (no extra interrupt).
    els.pauseBtn.click();
    await flush();
    expect(calls("cancel_agent_run")).toHaveLength(1);
  });
});

describe("controller — Resume sends a 'Continue.' user turn and goes active", () => {
  it("Resume (from idle) → send_agent_message('Continue.') once; state active", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    fire("agent-stream", SYSTEM_INIT);
    await flush();
    els.pauseBtn.click(); // → idle
    await flush();

    els.resumeBtn.click();
    await flush();
    // FALSIFY: have Resume call start_agent_session instead → this send_agent_message assertion goes RED.
    const sends = calls("send_agent_message");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe("Continue.");
    // State active: Pause re-enabled, Resume disabled, pill building.
    expect(els.pauseBtn.disabled).toBe(false);
    expect(els.resumeBtn.disabled).toBe(true);
    expect(els.status.pill!.dataset.status).toBe("building");

    // A second Resume click at active is a no-op.
    els.resumeBtn.click();
    await flush();
    expect(calls("send_agent_message")).toHaveLength(1);
  });
});

describe("controller — Stop interrupts AND ends the session, goes none", () => {
  it("Stop → cancel_agent_run + end_agent_session; state none (New-plan re-enabled, pill not building)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    fire("agent-stream", SYSTEM_INIT);
    await flush();
    els.cancelBtn.click();
    await flush();
    // FALSIFY: drop end_agent_session from Stop → this assertion goes RED (Stop would then equal Pause).
    expect(calls("cancel_agent_run")).toHaveLength(1);
    expect(calls("end_agent_session")).toHaveLength(1);
    expect(els.newPlanBtn.disabled).toBe(false);
    expect(els.status.pill!.dataset.status).not.toBe("building");

    // Stop is also valid from idle (session alive, no active turn): interrupt+end still fire.
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    fire("agent-stream", RESULT); // → idle
    await flush();
    expect(els.cancelBtn.disabled).toBe(false); // Stop enabled at idle
    els.cancelBtn.click();
    await flush();
    expect(calls("cancel_agent_run")).toHaveLength(2);
    expect(calls("end_agent_session")).toHaveLength(2);
    expect(els.newPlanBtn.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// PART B — the single in-place "working…" indicator. Appears immediately on run start (before any
// status), updates its label from `status` events, and hides on result / exit / Stop / Pause.
// ---------------------------------------------------------------------------------------------

function workingEl(stream: HTMLElement): HTMLElement | null {
  return stream.querySelector<HTMLElement>(".conv-working");
}
function workingLabel(stream: HTMLElement): string | null {
  return stream.querySelector<HTMLElement>(".conv-working-label")?.textContent ?? null;
}

describe("controller — working indicator: immediate on start, label from status, hidden on completion", () => {
  it("seeds Working… on the first frame, updates from status events, single in-place node", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // No session yet → no indicator.
    expect(workingEl(els.stream)).toBeNull();

    // First frame (system_init) → indicator appears IMMEDIATELY with the generic seed.
    // FALSIFY: gate the indicator on a status frame having arrived → no node here → RED.
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    expect(workingEl(els.stream)).not.toBeNull();
    expect(workingLabel(els.stream)).toBe("Working…");

    // A status event updates the label in place (still exactly ONE indicator node).
    fire("agent-stream", { seq: 2, kind: "status", label: "thinking…" });
    await flush();
    expect(els.stream.querySelectorAll(".conv-working")).toHaveLength(1);
    expect(workingLabel(els.stream)).toBe("thinking…");

    // A later status updates again (single node, latest label).
    fire("agent-stream", { seq: 3, kind: "status", label: "running subagent" });
    await flush();
    expect(els.stream.querySelectorAll(".conv-working")).toHaveLength(1);
    expect(workingLabel(els.stream)).toBe("running subagent");
  });

  it("FIX 3: shows the indicator the INSTANT Start succeeds (onStarted), before ANY agent-stream event", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    // No session yet → no indicator.
    expect(workingEl(els.stream)).toBeNull();

    // Drive a successful Start via the composer onStarted path (open → choose dir → fill → Start),
    // mirroring the Cancel-ends-session test's Start sequence.
    dialogOpen.mockResolvedValueOnce("/work");
    handle.openComposer();
    await flush();
    els.composer.chooseDirBtn!.click();
    await flush();
    els.composer.request!.value = "do a thing";
    els.composer.startBtn!.click();
    await flush();

    // CRITICAL: NO agent-stream / status event has been fired yet. The indicator MUST already be
    // visible (state active ⇒ seeded indicator), with the generic seed label — otherwise there is a
    // dead gap after Start that looks broken.
    // FALSIFY: gate the indicator on the first event only (remove the active-state seed in rerender)
    // → no node exists here → RED.
    expect(workingEl(els.stream)).not.toBeNull();
    expect(workingLabel(els.stream)).toBe("Working…");
    expect(els.stream.querySelectorAll(".conv-working")).toHaveLength(1);
  });

  it("hidden on result (turn complete) and on agent-exit (session ended)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "status", label: "thinking…" });
    await flush();
    expect(workingEl(els.stream)).not.toBeNull();

    // result → indicator hidden (turn complete).
    // FALSIFY: keep showing the indicator while complete → this null assertion goes RED.
    fire("agent-stream", RESULT);
    await flush();
    expect(workingEl(els.stream)).toBeNull();

    // A fresh turn re-shows it; agent-exit then hides it again.
    fire("agent-stream", { seq: 10, kind: "status", label: "thinking…" });
    await flush();
    expect(workingEl(els.stream)).not.toBeNull();
    fire("agent-exit", { code: 0 });
    await flush();
    expect(workingEl(els.stream)).toBeNull();
  });

  it("RENDER LAYER: a held ExitPlanMode shows 'Waiting for your input…' in .conv-working-label; resolve reverts it without any new frame", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "status", label: "thinking…" });
    await flush();
    expect(workingLabel(els.stream)).toBe("thinking…");

    // The SDK holds ExitPlanMode at the canUseTool seam → the agent is blocked on the user. The
    // label must reach the DOM through the controller's rerender (session "active" — the
    // session-state gate at rerender() must not null tree.working here).
    // FALSIFY: drop the pendingInteractive override in stream.ts derive → the stale "thinking…"
    // survives in the DOM → RED. (Confirmed red 2026-06-12.)
    fire("tool-permission-requested", {
      seq: 3,
      kind: "tool_permission_requested",
      id: "perm-1",
      tool: "ExitPlanMode",
      input: { plan: "# plan" },
      agent_id: null,
    });
    await flush();
    expect(workingLabel(els.stream)).toBe(WAITING_INPUT_LABEL);
    expect(els.stream.querySelectorAll(".conv-working")).toHaveLength(1);

    // The resolve path (Approve / Request changes in main.ts) notifies the handle — the waiting
    // label must clear IMMEDIATELY, before any inbound frame arrives.
    // FALSIFY: drop the appendPermissionResolved call in notifyPermissionResolved → label sticks → RED.
    handle.notifyPermissionResolved("perm-1");
    await flush();
    expect(workingLabel(els.stream)).toBe("thinking…");
  });

  it("RENDER LAYER: an AskUserQuestion hold shows the waiting label; submitting the card reverts it", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "status", label: "thinking…" });
    fire("tool-permission-requested", {
      seq: 3,
      kind: "tool_permission_requested",
      id: "q-1",
      tool: "AskUserQuestion",
      input: {
        questions: [
          { question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
        ],
      },
      agent_id: null,
    });
    await flush();
    expect(workingLabel(els.stream)).toBe(WAITING_INPUT_LABEL);

    // Submit the rendered question card (the controller appends question_answered + resolves).
    const radio = els.stream.querySelector<HTMLInputElement>(".conv-question input");
    expect(radio).not.toBeNull();
    radio!.click();
    const submit = els.stream.querySelector<HTMLButtonElement>(".conv-question-submit");
    expect(submit).not.toBeNull();
    submit!.click();
    await flush();
    expect(workingLabel(els.stream)).toBe("thinking…");
  });

  it("Pause hides the indicator immediately (state idle gates it off)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "status", label: "thinking…" });
    await flush();
    expect(workingEl(els.stream)).not.toBeNull();

    // Pause interrupts without a result event, but the controller gates the indicator off at idle.
    // FALSIFY: drop the `if (session !== "active") tree.working = null` gate in rerender → the
    // indicator lingers after Pause (no result fired) → this null assertion goes RED.
    els.pauseBtn.click();
    await flush();
    expect(workingEl(els.stream)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Idle-waiting override (setIdleWaitingHint) — the turn-completion-signaled prototype gate.
// The session goes idle on the intent turn's `result` frame, but the app is still blocked on the
// user (approve/refine the prototype): the hint keeps "Waiting for your input…" showing at idle.
// ---------------------------------------------------------------------------------------------
describe("controller — setIdleWaitingHint shows WAITING_INPUT_LABEL while idle", () => {
  it("session idle + hint ON → waiting label; hint OFF → indicator hidden again", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();
    // Run a turn to completion: result → session idle → indicator normally hidden.
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", RESULT);
    await flush();
    expect(workingEl(els.stream)).toBeNull();

    // The prototype gate appears (main.ts sees pendingPrototype in the snapshot) → hint ON.
    // FALSIFY: invert the idle-hint check in rerender (`!idleWaitingHint`) → no indicator → RED.
    handle.setIdleWaitingHint(true);
    await flush();
    expect(workingEl(els.stream)).not.toBeNull();
    expect(workingLabel(els.stream)).toBe(WAITING_INPUT_LABEL);
    expect(els.stream.querySelectorAll(".conv-working")).toHaveLength(1);

    // The gate resolves (approve/refine nulls pendingPrototype) → hint OFF → normal idle (hidden).
    handle.setIdleWaitingHint(false);
    await flush();
    expect(workingEl(els.stream)).toBeNull();
  });

  it("hint ON during an ACTIVE turn does not clobber the model-derived label; it applies only once idle", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", { seq: 2, kind: "status", label: "thinking…" });
    await flush();
    expect(workingLabel(els.stream)).toBe("thinking…");

    // Hint ON mid-turn: the active-turn branch wins — the model-derived label stays.
    // FALSIFY: apply the hint regardless of session state → label becomes the waiting label → RED.
    handle.setIdleWaitingHint(true);
    await flush();
    expect(workingLabel(els.stream)).toBe("thinking…");

    // The turn completes (idle) while the hint is still on → the waiting label takes over.
    fire("agent-stream", RESULT);
    await flush();
    expect(workingLabel(els.stream)).toBe(WAITING_INPUT_LABEL);
  });

  it("hint ON with NO session (none) never shows an indicator", async () => {
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();
    // No session was ever started — state is "none". The hint must not conjure an indicator.
    handle.setIdleWaitingHint(true);
    await flush();
    expect(workingEl(els.stream)).toBeNull();

    // Same after a session ENDED (agent-exit → none), even with the hint still on.
    fire("agent-stream", SYSTEM_INIT);
    fire("agent-stream", RESULT);
    await flush();
    expect(workingLabel(els.stream)).toBe(WAITING_INPUT_LABEL); // idle + hint: sanity
    fire("agent-exit", { code: 0 });
    await flush();
    // FALSIFY: drop the `session === "idle"` qualifier (any non-active state shows the hint) →
    // the indicator survives agent-exit → RED.
    expect(workingEl(els.stream)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Feature 2 — free-text message composer (human-in-the-loop).
// ---------------------------------------------------------------------------------------------
describe("controller — free-text composer sends a user turn and clears; disabled when none", () => {
  it("Send invokes send_agent_message with the typed text and clears the field (live session)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // Go live so the composer is enabled.
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    expect(els.messageInput.disabled).toBe(false);
    expect(els.sendBtn.disabled).toBe(false);

    els.messageInput.value = "  hello agent  ";
    els.sendBtn.click();
    await flush();

    // FALSIFY: don't trim/send, or don't clear → these go RED.
    const sent = calls("send_agent_message");
    expect(sent).toContainEqual({ text: "hello agent" });
    expect(els.messageInput.value).toBe("");
  });

  it("the composer is TYPABLE when no session is live; Send with no retained session is a no-op", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // New contract (user decision): the textarea is ALWAYS typable, including in state "none" after
    // Stop / natural exit — the next Send resumes the prior session. With NO run ever started this
    // launch (lastCwd null), there is nothing to resume into, so a Send is still a no-op at the
    // command tier (no send_agent_message, no start_agent_session) and the field is left intact.
    expect(els.messageInput.disabled).toBe(false);
    expect(els.sendBtn.disabled).toBe(false);

    // Clicking Send while none with no retained session must NOT invoke either command.
    els.messageInput.value = "should not send";
    els.sendBtn.click();
    await flush();
    expect(calls("send_agent_message")).toHaveLength(0);
    expect(calls("start_agent_session")).toHaveLength(0);
    expect(els.messageInput.value).toBe("should not send");
  });

  it("Enter sends; Shift+Enter does not (newline)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    await flush();

    els.messageInput.value = "via enter";
    els.messageInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true }),
    );
    await flush();
    expect(calls("send_agent_message")).toContainEqual({ text: "via enter" });

    // Shift+Enter must NOT send (it inserts a newline).
    const before = calls("send_agent_message").length;
    els.messageInput.value = "with shift";
    els.messageInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    await flush();
    expect(calls("send_agent_message")).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Multimodal — in-conversation follow-up image attachments.
// ---------------------------------------------------------------------------------------------
describe("controller — in-conversation image attachments on send", () => {
  it("Send with images forwards send_agent_message({ text, images }) on the LIVE path; field + chips clear", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    await flush();

    await attachImagesViaFileInput(els.fileInput, els.attachStrip, [pngFile()]);
    // The chip rendered.
    expect(els.attachStrip.querySelectorAll(".conv-attach-chip").length).toBe(1);

    els.messageInput.value = "look at this";
    els.sendBtn.click();
    await flush();

    const sent = calls("send_agent_message");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("look at this");
    expect(Array.isArray(sent[0].images)).toBe(true);
    expect((sent[0].images as unknown[]).length).toBe(1);
    expect((sent[0].images as Array<{ media_type: string }>)[0].media_type).toBe("image/png");
    // Field + chips clear on success.
    expect(els.messageInput.value).toBe("");
    expect(els.attachStrip.querySelectorAll(".conv-attach-chip").length).toBe(0);

    // Part G — the submitted image renders as a thumbnail in the conversation-history user bubble.
    // FALSIFY: drop `displayImages` from the appendUserMessage call (or stop rendering node.images in
    // render.ts) → the user bubble carries no <img> → this goes RED.
    const userBubble = els.stream.querySelector(".conv-text-user");
    expect(userBubble).not.toBeNull();
    const thumbs = userBubble!.querySelectorAll("img.conv-user-image");
    expect(thumbs).toHaveLength(1);
    expect((thumbs[0] as HTMLImageElement).src.startsWith("data:image/png;base64,")).toBe(true);
    expect(userBubble!.textContent).toContain("look at this");
  });

  it("images-only send (empty text) is dispatched (relaxed empty-text guard)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    await flush();

    await attachImagesViaFileInput(els.fileInput, els.attachStrip, [pngFile()]);
    els.messageInput.value = "   "; // blank text, image attached
    els.sendBtn.click();
    await flush();

    // FALSIFY: restore the strict `if (text.length === 0) return;` guard → an images-only send is a
    // no-op → this length-1 expectation goes RED.
    const sent = calls("send_agent_message");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("");
    expect((sent[0].images as unknown[]).length).toBe(1);
  });

  it("text-only follow-up carries NO images key (omit-when-empty, exact arg shape)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("agent-stream", SYSTEM_INIT);
    await flush();

    els.messageInput.value = "just text";
    els.sendBtn.click();
    await flush();

    const sent = calls("send_agent_message");
    expect(sent).toHaveLength(1);
    // FALSIFY: always include `images` (even when empty) → `"images" in sent[0]` is true → RED.
    expect(sent[0]).toEqual({ text: "just text" });
    expect("images" in sent[0]).toBe(false);

    // Part G inverse — a text-only user bubble renders NO thumbnails. FALSIFY: always pass display
    // images to appendUserMessage → an <img> appears → RED.
    const userBubble = els.stream.querySelector(".conv-text-user");
    expect(userBubble).not.toBeNull();
    expect(userBubble!.querySelectorAll("img.conv-user-image")).toHaveLength(0);
    expect(userBubble!.textContent).toContain("just text");
  });

  it("Send with images forwards images on the RESUME (post-end) path", async () => {
    dialogOpen.mockResolvedValueOnce("/work/dir" as never);
    const fake = makeFakeHandle(true);
    __setOrchestratorForTest(fake);

    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // Start a real run so lastCwd is captured, surface a session id, then end the session → none.
    els.composer.chooseDirBtn!.click();
    await flush();
    els.composer.request!.value = "build a thing";
    els.composer.startBtn!.click();
    await flush();
    fire("agent-stream", {
      seq: 1, kind: "system_init", model: "m", cwd: "/work/dir", tools: [], skills: [],
      slash_commands: [], permission_mode: "default", session_id: "sess-xyz",
    });
    await flush();
    fire("agent-exit", { code: 0 });
    await flush();
    expect(els.messageInput.disabled).toBe(false);

    // Attach an image + type, then Send in state none → resume re-opens the session and forwards images.
    await attachImagesViaFileInput(els.fileInput, els.attachStrip, [pngFile()]);
    H.invokeCalls = []; // isolate the resume invokes from setup noise
    els.messageInput.value = "continue with this";
    els.sendBtn.click();
    await flush();

    const starts = calls("start_agent_session");
    expect(starts).toHaveLength(1);
    expect(starts[0].resumeSessionId).toBe("sess-xyz");
    const sends = calls("send_agent_message");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe("continue with this");
    // FALSIFY: forward only `{ text }` on the resume path → no images key → these go RED.
    expect((sends[0].images as unknown[]).length).toBe(1);
    expect((sends[0].images as Array<{ media_type: string }>)[0].media_type).toBe("image/png");
    // Field + chips clear on success.
    expect(els.messageInput.value).toBe("");
    expect(els.attachStrip.querySelectorAll(".conv-attach-chip").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Part G — shared user-bubble thumbnail render path (covers BOTH surfaces; render is shared).
// ---------------------------------------------------------------------------------------------
describe("render — user bubble renders submitted images as thumbnails", () => {
  const URL_A = "data:image/png;base64,AAAA";
  const URL_B = "data:image/jpeg;base64,BBBB";

  it("a UserMessageNode with two images renders exactly two <img> thumbnails plus the text", () => {
    const model = new ConversationModel();
    model.appendUserMessage("look at these", [URL_A, URL_B]);
    const container = document.createElement("div");
    renderTree(container, model.derive());

    const bubble = container.querySelector(".conv-text-user");
    expect(bubble).not.toBeNull();
    const thumbs = bubble!.querySelectorAll("img.conv-user-image");
    // FALSIFY: stop rendering node.images in render.ts → zero thumbnails → RED.
    expect(thumbs).toHaveLength(2);
    expect((thumbs[0] as HTMLImageElement).src).toBe(URL_A);
    expect((thumbs[1] as HTMLImageElement).src).toBe(URL_B);
    expect(bubble!.textContent).toContain("look at these");
  });

  it("a UserMessageNode with NO images renders no <img> (thumbnails disappear when images dropped)", () => {
    const model = new ConversationModel();
    // No images argument — the inverse of the above. FALSIFY: always render a thumbnail row → an <img>
    // would appear here → RED.
    model.appendUserMessage("plain text only");
    const container = document.createElement("div");
    renderTree(container, model.derive());

    const bubble = container.querySelector(".conv-text-user");
    expect(bubble).not.toBeNull();
    expect(bubble!.querySelectorAll("img.conv-user-image")).toHaveLength(0);
    expect(bubble!.textContent).toContain("plain text only");
  });
});

// ---------------------------------------------------------------------------------------------
// Part G — composer first-turn echo: gated on images-present. With images, echo the RAW request +
// thumbnails; without images, echo NO first-turn bubble (text-only flow stays byte-identical).
// ---------------------------------------------------------------------------------------------
describe("controller — composer first-turn echo is gated on images-present", () => {
  it("starting WITH images echoes a user bubble carrying the RAW request + the image thumbnail", async () => {
    const fake = makeFakeHandle(true);
    __setOrchestratorForTest(fake);
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    dialogOpen.mockResolvedValueOnce("/work" as never);
    handle.openComposer();
    await flush();
    els.composer.chooseDirBtn!.click();
    await flush();
    // Attach an image through the composer's own attachment controller.
    await attachImagesViaFileInput(els.composer.fileInput!, els.composer.attachStrip!, [pngFile()]);
    els.composer.request!.value = "design from my screenshot";
    els.composer.startBtn!.click();
    await flush();

    // The orchestrator received the images on its first intent send.
    expect(fake.start).toHaveBeenCalledTimes(1);
    const startArg = fake.start.mock.calls[0][0] as { request: string; images?: unknown[] };
    expect(startArg.request).toBe("design from my screenshot");
    expect(startArg.images && startArg.images.length).toBe(1);

    // The echoed history bubble carries the RAW request (NOT the intentPrompt wrapper) + the thumbnail.
    // FALSIFY: remove the images-present echo in the start invoker → no .conv-text-user bubble → RED.
    const bubble = els.stream.querySelector(".conv-text-user");
    expect(bubble).not.toBeNull();
    expect(bubble!.textContent).toContain("design from my screenshot");
    const thumbs = bubble!.querySelectorAll("img.conv-user-image");
    expect(thumbs).toHaveLength(1);
    expect((thumbs[0] as HTMLImageElement).src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("starting WITHOUT images echoes NO first-turn user bubble (text-only stays unchanged)", async () => {
    const fake = makeFakeHandle(true);
    __setOrchestratorForTest(fake);
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    await driveComposerStart(els, handle);

    // FALSIFY: always echo the request on start → a .conv-text-user bubble would appear here → RED.
    expect(els.stream.querySelector(".conv-text-user")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Feature 1 — AskUserQuestion: card submit resolves the permission with the answers shape.
// ---------------------------------------------------------------------------------------------
describe("controller — AskUserQuestion card resolves resolve_tool_permission with the answers", () => {
  function askPayload() {
    return {
      seq: 5,
      kind: "tool_permission_requested",
      id: "ask-1",
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Pick one",
            header: "H1",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
          {
            question: "Pick many",
            header: "H2",
            options: [{ label: "X" }, { label: "Y" }],
            multiSelect: true,
          },
        ],
      },
      agent_id: null,
    };
  }

  it("submitting the card calls resolve_tool_permission(allow:true) with { questions, answers }", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    fire("tool-permission-requested", askPayload());
    await flush();

    // The card rendered into the stream.
    const card = els.stream.querySelector(".conv-question")!;
    expect(card).toBeTruthy();
    const radios = card.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const checkboxes = card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

    radios[1].checked = true; // B
    radios[1].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[0].checked = true; // X
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));

    card.querySelector<HTMLButtonElement>(".conv-question-submit")!.click();
    await flush();

    // FALSIFY: send the answers under wrong keys, or omit updatedInput → RED.
    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toEqual({
      id: "ask-1",
      allow: true,
      message: null,
      updatedInput: {
        questions: askPayload().input.questions,
        answers: { "Pick one": "B", "Pick many": ["X"] },
      },
    });

    // After submit the card re-renders read-only (no inputs left).
    const after = els.stream.querySelector(".conv-question")!;
    expect(after.querySelectorAll("input")).toHaveLength(0);
  });

  it("AskUserQuestion does NOT route to the ExitPlanMode review path (no write_agent_plan)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    fire("tool-permission-requested", askPayload());
    await flush();
    // The conversation domain renders the card; it never writes a plan file.
    // FALSIFY: route AskUserQuestion through the plan path → write_agent_plan would be called → RED.
    expect(calls("write_agent_plan")).toHaveLength(0);
  });

  // Sub-Plan 02 — the clarify card must resolve with the CORRECT { questions, answers } shape even
  // while a multiplan orchestration is active. The earlier bug skipped the pendingQuestions capture
  // when isOrchestrationActive(), so submitQuestion resolved with an EMPTY questions echo. With the
  // capture always running, an active orchestration must still echo the original questions populated.
  it("WHILE an orchestration is active, the card still resolves with NON-EMPTY updatedInput.questions", async () => {
    // Force isOrchestrationActive()===true by installing a started shared orchestrator. The default
    // deps bind to the mocked invoke, so start() makes no real Tauri call.
    const orch = createOrchestrator();
    __setOrchestratorForTest(orch);
    await orch.start({ cwd: "/work", request: "do it" });
    expect(isOrchestrationActive()).toBe(true);

    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    fire("tool-permission-requested", askPayload());
    await flush();

    const card = els.stream.querySelector(".conv-question")!;
    expect(card).toBeTruthy();
    const radios = card.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const checkboxes = card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    radios[0].checked = true; // A
    radios[0].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[1].checked = true; // Y
    checkboxes[1].dispatchEvent(new Event("change", { bubbles: true }));

    card.querySelector<HTMLButtonElement>(".conv-question-submit")!.click();
    await flush();

    // The card resolved with the ORIGINAL questions echoed (NON-EMPTY) alongside the answers — not [].
    // FALSIFY: restore the `if (!isOrchestrationActive())` skip around the pendingQuestions capture →
    // questions becomes [] here → the toEqual(original questions) assertion goes RED.
    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    const updatedInput = resolves[0].updatedInput as { questions: unknown[]; answers: unknown };
    expect(updatedInput.questions).toEqual(askPayload().input.questions);
    expect((updatedInput.questions as unknown[]).length).toBeGreaterThan(0);
    expect(updatedInput.answers).toEqual({ "Pick one": "A", "Pick many": ["Y"] });
  });
});

// ---------------------------------------------------------------------------------------------
// Sub-Plan 03 — §1 composer entry: Start delegates to getOrchestrator().start() and runs
// onStarted()/close() ONLY when start() resolves TRUE; on FALSE (idempotent no-op) it shows an
// error and the modal stays open (a dead start must not masquerade as success).
// ---------------------------------------------------------------------------------------------
async function driveComposerStart(els: ReturnType<typeof makeEls>, handle: { openComposer(): void }): Promise<void> {
  dialogOpen.mockResolvedValueOnce("/work");
  handle.openComposer();
  await flush();
  els.composer.chooseDirBtn!.click();
  await flush();
  els.composer.request!.value = "do a thing";
  els.composer.startBtn!.click();
  await flush();
}

describe("controller — §1 composer Start delegates to orchestrator.start() (true vs idempotent no-op)", () => {
  it("start() TRUE → onStarted runs (session goes live, modal closed) and start() got {cwd,request}", async () => {
    const fake = makeFakeHandle(true);
    __setOrchestratorForTest(fake);
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    await driveComposerStart(els, handle);

    // FALSIFY: ignore the boolean and never call start() → start.mock.calls is empty (RED).
    expect(fake.start).toHaveBeenCalledWith({ cwd: "/work", request: "do a thing" });
    // onStarted ran: the session went live (New-plan disabled) and the modal closed.
    expect(els.newPlanBtn.disabled).toBe(true);
    expect(els.modal.classList.contains("hidden")).toBe(true);
  });

  it("start() FALSE (already active) → modal stays OPEN, an error shows, onStarted did NOT run", async () => {
    const fake = makeFakeHandle(false);
    __setOrchestratorForTest(fake);
    const els = makeEls();
    const handle = await initConversation(els, () => {});
    await flush();

    await driveComposerStart(els, handle);

    expect(fake.start).toHaveBeenCalledWith({ cwd: "/work", request: "do a thing" });
    // FALSIFY: run onStarted()/close() unconditionally → the modal would close + New-plan disable (RED).
    expect(els.modal.classList.contains("hidden")).toBe(false); // still open
    expect(els.newPlanBtn.disabled).toBe(false); // session NOT live (onStarted skipped)
    expect(els.composer.error!.textContent ?? "").toMatch(/already active/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Sub-Plan 03 — §2 live bridge: agent-stream / tool-permission-requested forward to
// ingestStream / ingestPermission ONLY while an orchestration is active; and Stop routes to
// getOrchestrator().cancel() when active (not the raw cancel_agent_run/end_agent_session).
// ---------------------------------------------------------------------------------------------
describe("controller — §2 live bridge forwards frames to the orchestrator only while active", () => {
  it("when an orchestration is active, agent-stream → ingestStream and tool-permission → ingestPermission", async () => {
    // A real handle so isOrchestrationActive() flips true; spy on its ingest methods.
    const orch = createOrchestrator();
    __setOrchestratorForTest(orch);
    await orch.start({ cwd: "/work", request: "do it" });
    expect(isOrchestrationActive()).toBe(true);
    const ingestStream = vi.spyOn(orch, "ingestStream");
    const ingestPermission = vi.spyOn(orch, "ingestPermission");

    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    fire("agent-stream", SYSTEM_INIT);
    await flush();
    fire("tool-permission-requested", {
      seq: 5,
      kind: "tool_permission_requested",
      id: "tp-1",
      tool: "ExitPlanMode",
      input: { plan: "# p" },
      agent_id: null,
    });
    await flush();

    // FALSIFY: drop the `if (isOrchestrationActive()) void getOrchestrator().ingest*` lines → these
    // spies are never called (RED).
    expect(ingestStream).toHaveBeenCalledTimes(1);
    expect(ingestPermission).toHaveBeenCalledTimes(1);
  });

  // T1.6 — the SERIALIZATION + ERROR-ISOLATION + TERMINAL-GUARD oracle. The handle's
  // ingestStream/ingestPermission chain each frame's work onto a single tail promise (enqueueIngest),
  // so two frames delivered unawaited through the bridge complete in strict SUBMISSION order. This test
  // pins THREE distinct, independently-falsifiable properties of a throw in FRAME 1 (the sizer result,
  // whose sub-recon sendMessage we arm to throw → the enqueue .catch drives the run to FATAL/terminal):
  //
  //   (0) FRAME 1 threw → FATAL fired. The throw landed inside the queued work and the run went
  //       terminal (observed via the orchestrator observer's onFatal). [Falsify: don't arm the throw.]
  //   (a) QUEUE NOT POISONED: FRAME 2's queued thunk was still DEQUEUED and INVOKED by the queue —
  //       __ingestSeenForTest rises to 2 (both impls bumped their top-of-function counter). This is
  //       observed BEFORE the terminal guard, so it survives the guard suppressing FRAME 2's effects.
  //       [Falsify: change `ingestQueue = run.catch(...)` to `ingestQueue = run` → the rejected tail
  //        short-circuits FRAME 2's `.then(work)` → its thunk never runs → ingestSeen stays 1 → RED.]
  //   (b) NO EFFECTS AFTER TERMINAL: FRAME 2 ran but, because the run is already terminal, the terminal
  //       guard early-returned BEFORE any effect — so it wrote NO plan (`order` is empty) and surfaced
  //       no approval bar on the dead run. [Falsify: remove `if (!active) return;` from the impls →
  //       FRAME 2 writes the plan on a terminal run → order === ["writeAgentPlan:01"] → RED.]
  //
  // Crucially this drives the REAL queue end-to-end: we do NOT replace ingestStream/ingestPermission
  // (that would bypass the queue). Instead we observe through the injected OrchestratorDeps + the
  // orchestrator observer + the test-only ingest-seen counter.
  it("T1.6: the ingest queue isolates a throwing frame, still invokes the next, and runs no effects after terminal", async () => {
    // A recording deps whose sendMessage throws the FIRST time it is called (the recon-prompt send
    // inside start() is allowed; we arm the throw to land on the FIRST bridged frame's work). We
    // record the order in which the two bridged frames' work reaches the deps.
    const order: string[] = [];
    let throwOnNextSend = false;
    let firstFrameThrew = false;
    const deps = {
      startSession: async () => {},
      // The recon prompt (sent in start()) plus later prompts. We tag the recon send so it does not
      // consume the armed throw, then arm the throw to hit the FIRST bridged frame.
      sendMessage: async (text: string) => {
        if (throwOnNextSend) {
          throwOnNextSend = false;
          firstFrameThrew = true;
          throw new Error("frame-1 handling boom");
        }
        void text;
      },
      setMode: async () => {},
      resolvePermission: async () => {},
      cancelRun: async () => {},
      interrupt: async () => {},
      endSession: async () => {},
      writePlanTreeFile: async (_cwd: string, name: string) => `/abs/.plan-tree/${name}`,
      writeAgentPlan: async (_plan: string, _treeId: string, nn: string | null) => {
        order.push(`writeAgentPlan:${nn}`);
        return `/abs/plans/${nn}.md`;
      },
      resetPlanTreeDir: async () => {},
    };
    const orch = createOrchestrator(deps as never);
    // Observe the terminal FATAL the enqueue .catch drives when FRAME 1's send throws.
    let fatalCount = 0;
    orch.subscribe({ onFatal: () => fatalCount++ });
    __setOrchestratorForTest(orch);
    await orch.start({ cwd: "/work", request: "do it" });
    expect(isOrchestrationActive()).toBe(true);

    // Drive the orchestrator to the recon-armed state's NEXT boundary: deliver a recon text + result so
    // it is poised, then a SIZER single line + result so the next `result` frame (FRAME 1) triggers a
    // sendMessage (the sub-recon prompt) — which we arm to THROW. FRAME 2 is an ExitPlanMode permission
    // whose handling calls writeAgentPlan (recorded), proving the SECOND frame still ran after the throw.
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // recon turn.
    fire("agent-stream", { seq: 2, kind: "assistant_text", text: "recon", parent_tool_use_id: null });
    fire("agent-stream", { ...RESULT, seq: 3 });
    await flush();
    // sizer turn (single) → on the next result the driver sends the sub-recon prompt.
    fire("agent-stream", { seq: 4, kind: "assistant_text", text: "SIZER: single / 1 / 0.9", parent_tool_use_id: null });
    await flush();

    // Arm the throw so FRAME 1 (the sizer-completion result, which sends the sub-recon prompt) throws.
    throwOnNextSend = true;
    // Snapshot the ingest-thunk count BEFORE the two bridged frames so we can assert it rises by exactly
    // 2 (the earlier recon/sizer driving frames already bumped it — we measure the delta, not the total).
    const seenBefore = __ingestSeenForTest(orch);

    // Deliver FRAME 1 (result → sizer-done → sub-recon sendMessage THROWS) and FRAME 2 (an ExitPlanMode
    // permission whose handling writes the plan) BACK-TO-BACK, unawaited, through the real bridge.
    fire("agent-stream", { ...RESULT, seq: 5 });
    fire("tool-permission-requested", {
      seq: 6,
      kind: "tool_permission_requested",
      id: "sub-1",
      tool: "ExitPlanMode",
      input: { plan: "the sub plan" },
      agent_id: null,
    });
    // Deeper microtask drain: the enqueue catch now ALSO drives the run to a terminal FATAL on a
    // frame throw (Phase 3 ingest-throw hardening), which adds await depth before FRAME 2's work
    // settles. Error isolation is unchanged — FRAME 2 still runs — it just resolves a few ticks later.
    await flush(40);

    // (0) FRAME 1's handling threw (the throw landed inside the queued work) and drove the run to a
    // terminal FATAL via the enqueue .catch. Falsify: don't arm the throw → no throw, no FATAL.
    expect(firstFrameThrew).toBe(true);
    expect(fatalCount).toBe(1);
    expect(isOrchestrationActive()).toBe(false); // the run is now terminal (active flipped false)

    // (a) QUEUE NOT POISONED: BOTH ingest thunks were dequeued+invoked by the queue — FRAME 1 (the
    // sizer result) AND FRAME 2 (the ExitPlanMode permission). __ingestSeenForTest counts thunks that
    // reached the top of an impl (BEFORE the terminal guard), so it proves the chain survived FRAME 1's
    // throw regardless of whether the guard then suppressed FRAME 2's effects.
    // FALSIFY: change `ingestQueue = run.catch(...)` to `ingestQueue = run` → FRAME 2's thunk is skipped
    // → the delta is 1, not 2 → RED.
    expect(__ingestSeenForTest(orch) - seenBefore).toBe(2);

    // (b) NO EFFECTS AFTER TERMINAL: FRAME 2 ran but the run was already terminal, so the terminal guard
    // early-returned BEFORE any effect — it wrote NO plan (order is empty) and surfaced no approval bar
    // on the dead run.
    // FALSIFY: remove `if (!active) return;` from the ingest impls → FRAME 2 writes on the terminal run
    // → order === ["writeAgentPlan:01"] → RED.
    expect(order).toEqual([]);
  });

  it("when NO orchestration is active, neither ingest method is called", async () => {
    // A handle is installed but NOT started → isOrchestrationActive() is false.
    const orch = createOrchestrator();
    __setOrchestratorForTest(orch);
    expect(isOrchestrationActive()).toBe(false);
    const ingestStream = vi.spyOn(orch, "ingestStream");
    const ingestPermission = vi.spyOn(orch, "ingestPermission");

    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    fire("agent-stream", SYSTEM_INIT);
    fire("tool-permission-requested", {
      seq: 5,
      kind: "tool_permission_requested",
      id: "tp-1",
      tool: "AskUserQuestion",
      input: { questions: [] },
      agent_id: null,
    });
    await flush();

    // FALSIFY: forward unconditionally (drop the isOrchestrationActive() guard) → these go RED.
    expect(ingestStream).not.toHaveBeenCalled();
    expect(ingestPermission).not.toHaveBeenCalled();
  });

  // (T1.7, the escalate → notice wired-path oracle, was REMOVED 2026-06-10: the sizer is now
  // TWO-OUTCOME — "single" | "split" — so the onHandoff/escalate path it pinned is unrepresentable.
  // `surfaceMessage` → `.conv-notice` rendering itself remains covered by render.test.ts.)
});

describe("controller — §2 Stop routes through orchestrator.cancel() while active; Pause/Resume disabled", () => {
  it("Stop calls getOrchestrator().cancel() (not the raw cancel_agent_run/end_agent_session)", async () => {
    const orch = createOrchestrator();
    __setOrchestratorForTest(orch);
    await orch.start({ cwd: "/work", request: "do it" });
    const cancel = vi.spyOn(orch, "cancel");

    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // Go active so Stop is enabled, then Stop.
    fire("agent-stream", SYSTEM_INIT);
    await flush();
    // Pause/Resume are DISABLED while an orchestration owns the turns.
    // FALSIFY: drop the `|| orchActive` from the Pause/Resume derivation → Pause is enabled here (RED).
    expect(els.pauseBtn.disabled).toBe(true);
    expect(els.resumeBtn.disabled).toBe(true);

    els.cancelBtn.click();
    await flush();

    // FALSIFY: keep the legacy direct path while active → cancel() is never called (RED).
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Deliberate-interrupt tagging: the controller tags an error `result` ON THE STORED FRAME (the
// same object reference model.appendStream accumulated) when the orchestrator armed `resuming`
// (a deliberate post-decomposition-approval interrupt). derive()/render read ONLY the stored
// field — never live orchestrator state, which de-arms before later rebuilds.
// ---------------------------------------------------------------------------------------------

// An error result with NO result text — what the sidecar forwards for an interrupted turn. Spread
// into a FRESH object per fire (the tag mutates the payload; reuse would leak across fires).
const ERROR_RESULT = { kind: "result", subtype: "error_during_execution", is_error: true, result: null, num_turns: 1, duration_ms: 1, total_cost_usd: 0, session_id: "s1" } as const;

describe("controller — deliberate-interrupt tagging on error results", () => {
  // A fake handle whose resuming() tracks the mutable cell, registered BOTH as the singleton (so
  // the forwarded ingestStream is a noop) and as the module-level active guard (so
  // isOrchestrationActive()/isOrchestratorResuming() read it).
  function installFake(resuming: { value: boolean }): void {
    const h = makeFakeHandle(true);
    (h as unknown as { resuming: () => boolean }).resuming = () => resuming.value;
    __setOrchestratorForTest(h);
    __setActiveOrchestratorForTest(h);
  }

  it("tag_applied_only_while_resuming: tags iff orchestration active AND resuming AND is_error", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    const resuming = { value: true };
    installFake(resuming);

    // RESUMING + error result → tagged → the muted interrupted row.
    fire("agent-stream", { ...ERROR_RESULT, seq: 9 });
    await flush();
    expect(els.stream.querySelectorAll(".conv-result-interrupted")).toHaveLength(1);

    // RESUMING + SUCCESS result → NOT tagged → plain "Run complete".
    fire("agent-stream", { ...ERROR_RESULT, seq: 10, is_error: false, result: "done" });
    await flush();
    expect(els.stream.querySelectorAll(".conv-result-interrupted")).toHaveLength(1);

    // De-armed (NOT resuming) + error result → NOT tagged → loud "Run failed (no details)".
    // FALSIFY: tag unconditionally on error results in index.ts → this renders muted → RED.
    resuming.value = false;
    fire("agent-stream", { ...ERROR_RESULT, seq: 11 });
    await flush();
    const rows = els.stream.querySelectorAll(".conv-result");
    const last = rows[rows.length - 1];
    expect(last.classList.contains("conv-result-interrupted")).toBe(false);
    expect(last.textContent).toBe("Run failed (no details)");
  });

  it("tag_survives_rebuild: the verdict persists on the stored frame after the orchestrator de-arms", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    const resuming = { value: true };
    installFake(resuming);

    // Tagged at ingest while the resuming hold is armed.
    fire("agent-stream", { ...ERROR_RESULT, seq: 9 });
    await flush();
    expect(els.stream.querySelector(".conv-result-interrupted")).toBeTruthy();

    // The orchestrator consumes the result and DE-ARMS (awaiting → recon). A later frame forces a
    // full re-derive — the model rebuilds every node from scratch from the accumulated frames.
    resuming.value = false;
    fire("agent-stream", { seq: 10, kind: "assistant_text", text: "continuing", parent_tool_use_id: null });
    await flush();
    // FALSIFY: compute the tag in derive()/render from live orchestrator state instead of the
    // stored frame field → the rebuilt row loses the tag → RED.
    const row = els.stream.querySelector(".conv-result-interrupted");
    expect(row).toBeTruthy();
    expect(row!.textContent).toBe("Turn interrupted — continuing");
  });
});

// ---------------------------------------------------------------------------------------------
// Composer-after-end: the textarea stays typable in state "none", and the next Send RESUMES the
// prior session id (same conversation context) instead of being a no-op.
// ---------------------------------------------------------------------------------------------
describe("controller — composer re-enabled after session end + resume-on-send", () => {
  it("messageInput is enabled in initial state none (applySessionState('none'))", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    // No events fired → state is "none" (initConversation calls applySessionState('none') at init).
    // FALSIFY: restore `els.messageInput.disabled = !live` at index.ts → in 'none' live=false ⇒
    // disabled=true ⇒ this expectation is RED.
    expect(els.messageInput.disabled).toBe(false);
    expect(els.sendBtn.disabled).toBe(false);
  });

  it("Send in state none re-opens the SAME session (resumeSessionId) under the retained cwd, then sends", async () => {
    // jsdom's global localStorage is inert in this setup, so the composer's cwd cannot be seeded that
    // way — drive the native folder picker instead (the dialog mock returns the chosen dir).
    dialogOpen.mockResolvedValueOnce("/work/dir" as never);
    // Provide a fake orchestrator handle whose start() resolves true (a real start) so onStarted runs.
    // Installed BEFORE init so initConversation's getOrchestrator() binding hits the fake.
    const fake = makeFakeHandle(true);
    __setOrchestratorForTest(fake);

    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // 1) Choose a working dir (sets composer.cwd) and start a real run so the controller captures
    //    lastCwd (= the cwd passed to the start thunk).
    els.composer.chooseDirBtn!.click();
    await flush();
    els.composer.request!.value = "build a thing";
    els.composer.startBtn!.click();
    await flush();
    // The start thunk passed cwd to the orchestrator → lastCwd captured.
    expect(fake.start).toHaveBeenCalledWith({ cwd: "/work/dir", request: "build a thing" });

    // 2) A live turn opens and the SDK session id arrives on system_init, then the turn ends.
    fire("agent-stream", {
      seq: 1, kind: "system_init", model: "m", cwd: "/work/dir", tools: [], skills: [],
      slash_commands: [], permission_mode: "default", session_id: "sess-xyz",
    });
    await flush();
    fire("agent-exit", { code: 0 });
    await flush();
    // Session ended → state none → textarea typable.
    expect(els.messageInput.disabled).toBe(false);

    // 3) Type into the (now-enabled) textarea and Send. This must RE-OPEN the same session.
    H.invokeCalls = []; // isolate the resume invokes from setup noise
    els.messageInput.value = "keep going please";
    els.sendBtn.click();
    await flush();

    // FALSIFY: revert sendMessage's none-branch to `if (!isLive(session)) return;` → no start_agent_session
    // is invoked on Send after end ⇒ this is RED.
    const starts = calls("start_agent_session");
    expect(starts).toHaveLength(1);
    expect(starts[0].cwd).toBe("/work/dir");
    // RESUME: the captured session id is threaded so the agent keeps conversation context.
    expect(starts[0].resumeSessionId).toBe("sess-xyz");
    // And the typed text is dispatched as the next user turn after the re-open resolves.
    const sends = calls("send_agent_message");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe("keep going please");
  });

  it("Send in state none where start_agent_session REJECTS (session still draining) surfaces a non-fatal notice and KEEPS the field", async () => {
    // RACE: the user Sends while the previous session is still draining → start_agent_session rejects
    // with "a session is already running (one session per launch)". The resume .catch must surface a
    // NON-FATAL notice (a .conv-notice row — the same mechanism surfaceMessage uses), keep the typed
    // text in the field, and revert to "none" so the user can retry.
    dialogOpen.mockResolvedValueOnce("/work/dir" as never);
    const fake = makeFakeHandle(true);
    __setOrchestratorForTest(fake);

    const els = makeEls();
    await initConversation(els, () => {});
    await flush();

    // Start a real run so lastCwd is captured, surface a session id, then end the session → none.
    els.composer.chooseDirBtn!.click();
    await flush();
    els.composer.request!.value = "build a thing";
    els.composer.startBtn!.click();
    await flush();
    fire("agent-stream", {
      seq: 1, kind: "system_init", model: "m", cwd: "/work/dir", tools: [], skills: [],
      slash_commands: [], permission_mode: "default", session_id: "sess-xyz",
    });
    await flush();
    fire("agent-exit", { code: 0 });
    await flush();
    expect(els.messageInput.disabled).toBe(false);

    // Arm the NEXT invoke (= the resume start_agent_session) to REJECT, mimicking the drain race.
    mockInvoke.mockImplementationOnce(() =>
      Promise.reject(new Error("a session is already running (one session per launch)")),
    );

    els.messageInput.value = "keep going please";
    els.sendBtn.click();
    await flush();

    // FALSIFY: drop the `model.appendNotice(...)` line in the resume .catch → no .conv-notice row → RED.
    const notice = els.stream.querySelector(".conv-notice");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toBe("Previous session is still shutting down — try sending again.");
    // The typed text is PRESERVED (no clear on failure) so the user can retry by Sending again.
    // FALSIFY: clear the field in the .catch → this expectation is RED.
    expect(els.messageInput.value).toBe("keep going please");
    // Reverted to "none": the textarea stays typable for the retry, no orphan user bubble was added.
    expect(els.messageInput.disabled).toBe(false);
    expect(els.stream.querySelector(".conv-text-user")).toBeNull();
  });

  it("Send in state none with NO retained cwd is a no-op (nothing to resume into)", async () => {
    const els = makeEls();
    await initConversation(els, () => {});
    await flush();
    // No run ever started → lastCwd is null. Typing + Send must NOT open a session.
    H.invokeCalls = [];
    els.messageInput.value = "hello?";
    els.sendBtn.click();
    await flush();
    // FALSIFY: drop the `if (lastCwd === null) return;` guard → start_agent_session fires with a null
    // cwd ⇒ this length-0 expectation is RED.
    expect(calls("start_agent_session")).toHaveLength(0);
    expect(calls("send_agent_message")).toHaveLength(0);
    // The field is left intact (no clear on a non-dispatch).
    expect(els.messageInput.value).toBe("hello?");
  });
});
