// Multiplan orchestration domain (Sub-Plan 03) — orchestrator driver tests.
//
// The orchestrator is the IMPURE driver over the PURE plan-tree reducer. These tests inject a FAKE
// OrchestratorDeps (mirroring composer.test.ts's injected-invoker pattern) so the driver is exercised
// with NO real Tauri, NO listen, NO DOM. We record the ORDERED list of side-effects the fakes saw and
// assert against it; we also assert the observer fan-out and the module-level active-guard.
//
// Falsifiability is load-bearing: each behavioral test is written so that inverting the behavior under
// test turns it RED (notes inline).

import { describe, it, expect, vi } from "vitest";

import {
  createOrchestrator,
  isOrchestrationActive,
  reconPrompt,
  intentPrompt,
  refinePrototypePrompt,
  parsePrototypeBlock,
  composeIntentMd,
  subReconPrompt,
  subDraftPrompt,
  summaryPrompt,
  WORKDIR_SCOPE_GUARD,
  VISUAL_MODE_DIRECTIVE,
  BASELINE_FRAMING,
  masterDraftPrompt,
  nestedDecompositionDraftPrompt,
  sizerPrompt,
  parseSubPlanHeaders,
  PlanValidationError,
  type Mandate,
  type OrchestratorDeps,
  type OrchestratorObserver,
  type OrchestratorHandle,
} from "./orchestrator";
import type { PrototypeGate, AcceptanceGate } from "./plan-tree";
import { parseNn, pathKey } from "./plan-tree";
import type { PlanTreeEvent2, PlanTreeFilePath, TreeNode } from "./plan-tree";
import { diag } from "./diag";

// diag is a guarded no-op in tests (no Tauri runtime); mock it so the "coerce loudly" tests can
// assert the dev-terminal line actually fires. Behavior-neutral for every other test.
vi.mock("./diag", () => ({ diag: vi.fn() }));
import type {
  AgentStream,
  AssistantText,
  ResultMsg,
  SystemInit,
  ToolPermissionRequested,
} from "./types";

// Branded-value mints for scripted dispatches. parseNn is the REAL production boundary;
// PlanTreeFilePath has NO production mint outside the driver's write wrapper, so tests cast
// explicitly — the cast is the test's declaration that this string plays a written file's path.
const nnOf = (n: number) => parseNn(n);
const pathOf = (p: string) => p as PlanTreeFilePath;

// ---- gen-2 snapshot helpers (the flat master.phase/pointer/subplans surface is GONE) ----------

// "stage/phase" of the root node — the gen-2 spelling of the old master.phase assertions.
function rootPhase(h: OrchestratorHandle): string {
  const r = h.snapshot().root;
  return `${r.state.stage}/${r.state.phase}`;
}

// Resolve depth-1 child n under the (split) root, loudly.
function childOf(h: OrchestratorHandle, n: number): TreeNode {
  const r = h.snapshot().root;
  if (r.state.stage !== "split") throw new Error(`root is ${r.state.stage}, expected split`);
  const c = r.state.children.find((c) => c.nn === n);
  if (!c) throw new Error(`no child ${n} under root`);
  return c;
}

// "stage/phase" of depth-1 child n — the gen-2 spelling of subplans[i].lifecycle assertions.
function childPhase(h: OrchestratorHandle, n: number): string {
  const c = childOf(h, n);
  return `${c.state.stage}/${c.state.phase}`;
}

// The active node's pathKey ("" = the root itself) or null — the gen-2 spelling of the pointer.
function activeKey(h: OrchestratorHandle): string | null {
  const p = h.snapshot().activePath;
  return p === null ? null : pathKey(p);
}

// The root's children nns in order (the gen-2 spelling of subplans.map(s => s.nn)).
function childNns(h: OrchestratorHandle): number[] {
  const r = h.snapshot().root;
  if (r.state.stage !== "split") return [];
  return r.state.children.map((c) => c.nn);
}

// Narrow a node to its leaf state, loudly (for planPath/summaryPath assertions).
function leafState(node: TreeNode): Extract<TreeNode["state"], { stage: "leaf" }> {
  if (node.state.stage !== "leaf") throw new Error(`expected leaf, got ${node.state.stage}`);
  return node.state;
}

// ---- scripted live-frame builders (drive ingestStream / ingestPermission) --------------------

let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

function textFrame(text: string, parentToolUseId: string | null = null): AssistantText {
  return { seq: nextSeq(), kind: "assistant_text", text, parent_tool_use_id: parentToolUseId };
}

function systemInitFrame(sessionId: string): SystemInit {
  return {
    seq: nextSeq(),
    kind: "system_init",
    model: "claude-test",
    cwd: "/work",
    tools: [],
    skills: [],
    slash_commands: [],
    permission_mode: "plan",
    session_id: sessionId,
  };
}

function resultFrame(): ResultMsg {
  return {
    seq: nextSeq(),
    kind: "result",
    subtype: "success",
    is_error: false,
    result: "",
    num_turns: 1,
    duration_ms: 1,
    total_cost_usd: 0,
    session_id: "s",
  };
}

function exitPlanModeReq(id: string, plan: string): ToolPermissionRequested {
  return {
    seq: nextSeq(),
    kind: "tool_permission_requested",
    id,
    tool: "ExitPlanMode",
    input: { plan },
    agent_id: null,
  };
}

function askUserQuestionReq(
  id: string,
  questions: ToolPermissionRequested["input"],
): ToolPermissionRequested {
  return {
    seq: nextSeq(),
    kind: "tool_permission_requested",
    id,
    tool: "AskUserQuestion",
    input: questions,
    agent_id: null,
  };
}

// ---- a recording fake OrchestratorDeps ------------------------------------------------------

interface Recorded {
  calls: string[]; // ordered, human-readable trace of every dep call
  writeAgentPlan: Array<{ plan: string; treeId: string; nn: string | null }>;
  writePlanTreeFile: Array<{ cwd: string; name: string; contents: string }>;
  deletePlanTreeFile: Array<{ cwd: string; name: string }>;
  resolvePermission: Array<{ id: string; allow: boolean; message?: string; updatedInput?: unknown }>;
  setMode: string[];
  cancelRun: number;
  interrupt: number;
  endSession: number;
  startSession: Array<{ cwd: string; permissionMode: string }>;
  sendMessage: string[];
  resetPlanTreeDir: string[];
  ensurePrototypeDir: string[];
  ensureBaselineDir: string[];
  freezeBaseline: string[];
  openBaseline: Array<{ cwd: string; path: string }>;
}

function makeDeps(): { deps: OrchestratorDeps; rec: Recorded } {
  const rec: Recorded = {
    calls: [],
    writeAgentPlan: [],
    writePlanTreeFile: [],
    deletePlanTreeFile: [],
    resolvePermission: [],
    setMode: [],
    cancelRun: 0,
    interrupt: 0,
    endSession: 0,
    startSession: [],
    sendMessage: [],
    resetPlanTreeDir: [],
    ensurePrototypeDir: [],
    ensureBaselineDir: [],
    freezeBaseline: [],
    openBaseline: [],
  };
  const deps: OrchestratorDeps = {
    startSession: vi.fn(async (args) => {
      rec.calls.push(`startSession:${args.cwd}:${args.permissionMode}`);
      rec.startSession.push(args);
    }),
    sendMessage: vi.fn(async (text) => {
      rec.calls.push(`sendMessage:${text}`);
      rec.sendMessage.push(text);
    }),
    setMode: vi.fn(async (mode) => {
      rec.calls.push(`setMode:${mode}`);
      rec.setMode.push(mode);
    }),
    resolvePermission: vi.fn(async (args) => {
      rec.calls.push(`resolvePermission:${args.id}:${args.allow}:${args.message ?? ""}`);
      rec.resolvePermission.push({
        id: args.id,
        allow: args.allow,
        message: args.message,
        updatedInput: args.updatedInput,
      });
    }),
    cancelRun: vi.fn(async () => {
      rec.calls.push("cancelRun");
      rec.cancelRun++;
    }),
    interrupt: vi.fn(async () => {
      rec.calls.push("interrupt");
      rec.interrupt++;
    }),
    endSession: vi.fn(async () => {
      rec.calls.push("endSession");
      rec.endSession++;
    }),
    writePlanTreeFile: vi.fn(async (cwd, name, contents) => {
      rec.calls.push(`writePlanTreeFile:${name}`);
      rec.writePlanTreeFile.push({ cwd, name, contents });
      return `/abs/.plan-tree/${name}`;
    }),
    deletePlanTreeFile: vi.fn(async (cwd, name) => {
      rec.calls.push(`deletePlanTreeFile:${name}`);
      rec.deletePlanTreeFile.push({ cwd, name });
    }),
    writeAgentPlan: vi.fn(async (plan, treeId, nn) => {
      rec.calls.push(`writeAgentPlan:${treeId}:${nn}`);
      rec.writeAgentPlan.push({ plan, treeId, nn });
      return `/abs/plans/${nn}.md`;
    }),
    resetPlanTreeDir: vi.fn(async (cwd) => {
      rec.calls.push(`resetPlanTreeDir:${cwd}`);
      rec.resetPlanTreeDir.push(cwd);
    }),
    ensurePrototypeDir: vi.fn(async (cwd) => {
      rec.calls.push(`ensurePrototypeDir:${cwd}`);
      rec.ensurePrototypeDir.push(cwd);
      return `${cwd}/.plan-tree/prototype`;
    }),
    ensureBaselineDir: vi.fn(async (cwd) => {
      rec.calls.push(`ensureBaselineDir:${cwd}`);
      rec.ensureBaselineDir.push(cwd);
      return `${cwd}/.plan-tree/baseline`;
    }),
    freezeBaseline: vi.fn(async (cwd) => {
      rec.calls.push(`freezeBaseline:${cwd}`);
      rec.freezeBaseline.push(cwd);
      return `${cwd}/.plan-tree/baseline`;
    }),
    openBaseline: vi.fn(async (cwd, path) => {
      rec.calls.push(`openBaseline:${cwd}:${path}`);
      rec.openBaseline.push({ cwd, path });
    }),
  };
  return { deps, rec };
}

// A recording observer + the buffers it fills. GEN-2 SHAPES: the unified gate is recorded as its
// pathKey ("" = root) + kind + toolUseId (the nn:-1 sentinel is gone); summaries are path-keyed.
interface ObsRec {
  obs: OrchestratorObserver;
  awaiting: Array<{ key: string; kind: "decomposition" | "leaf"; toolUseId: string }>;
  summaries: Array<{ key: string; summaryPath: string }>;
  prototypes: PrototypeGate[];
  acceptances: AcceptanceGate[];
  done: number;
  fatal: string[];
  snapshots: number;
}

function makeObserver(): ObsRec {
  const rec: ObsRec = {
    awaiting: [],
    summaries: [],
    prototypes: [],
    acceptances: [],
    done: 0,
    fatal: [],
    snapshots: 0,
    obs: {},
  };
  rec.obs = {
    onSnapshot: () => {
      rec.snapshots++;
    },
    onAwaitingApproval: (g) =>
      rec.awaiting.push({ key: pathKey(g.path), kind: g.kind, toolUseId: g.toolUseId }),
    onSummaryWritten: (path, p) => rec.summaries.push({ key: pathKey(path), summaryPath: p }),
    onPrototypeReview: (g) => rec.prototypes.push(g),
    onAcceptanceReview: (g) => rec.acceptances.push(g),
    onDone: () => {
      rec.done++;
    },
    onFatal: (m) => rec.fatal.push(m),
  };
  return rec;
}

// The internal dispatch funnel (events with no public method: NODE_RECON_DONE, SIZER_DONE, …).
function dispatchOf(h: OrchestratorHandle): (e: PlanTreeEvent2) => Promise<void> {
  return (e) => h.dispatch(e);
}

// Drain the microtask queue (the resume watchdog fires its FATAL through the serialized ingest
// queue, so observers see it only after a few microtask hops — never a real sleep).
async function flush(n = 32): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// A recording fake timer seam for OrchestratorDeps.setTimeout/clearTimeout: tests fire/inspect the
// watchdog WITHOUT sleeping. `cleared` flips when the orchestrator cancels the handle.
interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}
function installFakeTimers(deps: OrchestratorDeps): FakeTimer[] {
  const timers: FakeTimer[] = [];
  deps.setTimeout = (fn, ms) => {
    const t: FakeTimer = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  deps.clearTimeout = (handle) => {
    (handle as FakeTimer).cleared = true;
  };
  return timers;
}

// ---- intent-clarification phase (precedes recon) --------------------------------------------
//
// Drive the intent turn that now opens every run: start() arms `intent` + sends the intentPrompt;
// the turn's `result` dispatches INTENT_CLARIFIED (writing INTENT.md), then sends the recon prompt
// and arms `recon`. After that boundary, recon→sizer→sub-plan behavior is UNCHANGED.

// Drive a started handle through the opening intent turn to the recon arm. After this returns the
// run is exactly where it used to be right after start() pre-feature: phase recon, recon prompt sent.
async function driveIntentToRecon(
  h: OrchestratorHandle,
  intentText = "the confirmed intent",
): Promise<void> {
  await h.ingestStream(textFrame(intentText, "agent-intent"));
  await h.ingestStream(resultFrame());
}

// ---- prompt threading: confirmed intent flows into recon + master-draft -----------------------
//
// The confirmed intent (the intent-clarifier's final message) MUST be threaded into the planning-
// decision prompts (recon, master-draft). These pure-function tests pin the labeled-block format and
// the byte-identical no-op when intent is null/empty.

describe("orchestrator — reconPrompt threads the confirmed intent", () => {
  it("includes the intent text in a labeled 'Confirmed intent' block when provided", () => {
    const withIntent = reconPrompt("the original request", "make it multiplayer");
    // The labeled block + the intent text are present. FALSIFY: ignore the intent arg (return the
    // plain prompt) → these assertions go RED.
    expect(withIntent).toContain("Confirmed intent");
    expect(withIntent).toContain("make it multiplayer");
  });

  it("is byte-identical to the no-arg prompt when intent is null or empty (no empty block)", () => {
    const plain = reconPrompt("the original request");
    // null, undefined, empty string, and whitespace-only all collapse to the plain prompt — no empty
    // "Confirmed intent" block. FALSIFY: always emit the block → these equalities go RED.
    expect(reconPrompt("the original request", null)).toBe(plain);
    expect(reconPrompt("the original request", "")).toBe(plain);
    expect(reconPrompt("the original request", "   ")).toBe(plain);
    expect(plain).not.toContain("Confirmed intent");
  });
});

describe("orchestrator — WORKDIR_SCOPE_GUARD is spliced into every exploration-capable prompt", () => {
  // FALSIFY (verified): temporarily remove the WORKDIR_SCOPE_GUARD splice from any ONE of the three
  // prompts → that prompt's contains-pin goes RED. Restore the splice → GREEN.
  it("reconPrompt contains the guard", () => {
    expect(reconPrompt("x")).toContain(WORKDIR_SCOPE_GUARD);
  });

  it("intentPrompt contains the guard", () => {
    expect(intentPrompt("x")).toContain(WORKDIR_SCOPE_GUARD);
  });

  it("subReconPrompt contains the guard", () => {
    const prompt = subReconPrompt(
      [nnOf(1)],
      { title: "t", sectionBody: "", masterPreamble: "" },
      [],
    );
    expect(prompt).toContain(WORKDIR_SCOPE_GUARD);
  });
});

describe("orchestrator — masterDraftPrompt threads the confirmed intent", () => {
  it("includes the intent text in a labeled 'Confirmed intent' block when provided", () => {
    const withIntent = masterDraftPrompt("the original request", undefined, "ship a CLI tool");
    expect(withIntent).toContain("Confirmed intent");
    expect(withIntent).toContain("ship a CLI tool");
  });

  it("is byte-identical to the intent-less prompt when intent is null or empty", () => {
    const plain = masterDraftPrompt("the original request");
    expect(masterDraftPrompt("the original request", undefined, null)).toBe(plain);
    expect(masterDraftPrompt("the original request", undefined, "")).toBe(plain);
    expect(masterDraftPrompt("the original request", undefined, "   ")).toBe(plain);
    expect(plain).not.toContain("Confirmed intent");
    // Feedback threading is independent of intent threading — both can coexist.
    const both = masterDraftPrompt("req", "address this feedback", "the confirmed intent");
    expect(both).toContain("address this feedback");
    expect(both).toContain("the confirmed intent");
  });
});

describe("orchestrator — START reconciliation resets .plan-tree on disk", () => {
  it("start() invokes the resetPlanTreeDir dep with the cwd BEFORE the genesis state.json persist", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    await h.start({ cwd: "/work", request: "do it" });

    const resetIdx = rec.calls.indexOf("resetPlanTreeDir:/work");
    const persistIdx = rec.calls.indexOf("writePlanTreeFile:state.json");
    // The driver executed the reducer's resetPlanTreeDir effect against the injected dep, with the
    // run's cwd. FALSIFY: drop the runEffect case (or the reducer emission) → indexOf -1 → RED.
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    // ORDER: the on-disk sweep MUST precede the genesis persist, or the fresh state.json would be
    // archived along with the stale files. FALSIFY: emit persist before resetPlanTreeDir → RED.
    expect(resetIdx).toBeLessThan(persistIdx);

    await h.cancel();
  });

  it("start() that throws mid-flight tears down the guard: rejects, inactive, and retryable", async () => {
    const { deps } = makeDeps();
    // The first awaitable inside start() that can reject: the START dispatch's resetPlanTreeDir
    // effect (a real disk failure shape — e.g. .plan-tree unwritable).
    deps.resetPlanTreeDir = vi.fn(async () => {
      throw new Error("disk");
    });
    const h = createOrchestrator(deps);

    // The rejection must ESCAPE (the composer surfaces it) …
    await expect(h.start({ cwd: "/work", request: "do it" })).rejects.toThrow("disk");
    // … AND the guard must be torn down, not wedged for the session. FALSIFY: remove start()'s
    // try/catch cleanup → active stays true, activeOrchestrator stays registered → RED here.
    expect(isOrchestrationActive()).toBe(false);

    // A subsequent start() on the SAME handle with a healthy dep succeeds (the idempotency guard
    // `if (active) return false` would otherwise eat it). deps is captured by reference, so healing
    // the fake heals the handle.
    deps.resetPlanTreeDir = vi.fn(async () => undefined);
    const ok = await h.start({ cwd: "/work", request: "do it" });
    expect(ok).toBe(true);
    expect(isOrchestrationActive()).toBe(true);

    await h.cancel();
  });
});

// ---- resume support: system_init session_id captured + self-persisted ------------------------
//
// Phase 1 of the resume plan: the SDK's session_id arrives on the system_init frame; the driver
// must self-persist it onto state.json (via SESSION_INITIALIZED) WITHOUT perturbing the armed
// sequencer (`awaiting`). These tests inject a system_init frame and assert the captured
// writePlanTreeFile("state.json") JSON carries sdk_session_id AND that the still-armed `intent`
// turn is unharmed (its result is still consumed by the intent branch).
describe("orchestrator — system_init captures + persists the SDK session_id (resume support)", () => {
  it("a system_init frame persists sdk_session_id into state.json", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });

    await h.ingestStream(systemInitFrame("sess-xyz"));

    // The latest state.json write carries the session_id (the self-persist effect ran).
    const stateWrites = rec.writePlanTreeFile.filter((w) => w.name === "state.json");
    expect(stateWrites.length).toBeGreaterThan(0);
    const last = stateWrites[stateWrites.length - 1];
    const ledger = JSON.parse(last.contents) as { sdk_session_id?: string };
    // FALSIFY: drop the SESSION_INITIALIZED persist effect (or the dispatch in ingestStreamImpl) →
    // no state.json carries the id → RED.
    expect(ledger.sdk_session_id).toBe("sess-xyz");

    await h.cancel();
  });

  it("system_init does NOT perturb the armed `intent` turn (awaiting unchanged across the frame)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    // After start(): exactly one message sent (the intent prompt), root in clarifying-intent.
    expect(rec.sendMessage).toHaveLength(1);
    expect(rootPhase(h)).toBe("open/clarifying-intent");

    // Feed the system_init frame. It must send NO further message and NOT advance the phase.
    await h.ingestStream(systemInitFrame("sess-xyz"));
    expect(rec.sendMessage).toHaveLength(1); // no extra send — the sequencer was untouched
    expect(rootPhase(h)).toBe("open/clarifying-intent");

    // PROOF the `intent` arm survived the frame: the intent turn's text+result still flow through
    // the intent branch (INTENT_CLARIFIED → INTENT.md written + recon prompt sent). If system_init
    // had clobbered `awaiting`, the result below would be swallowed and recon would never send.
    // FALSIFY: have the system_init branch reset `awaiting = {tag:"idle"}` → recon never sends → RED.
    await h.ingestStream(textFrame("the user wants X", "agent-intent"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/recon");
    expect(rec.writePlanTreeFile.some((w) => w.name === "INTENT.md")).toBe(true);
    expect(
      rec.sendMessage.some((m) => m.includes("perform broad reconnaissance of the codebase")),
    ).toBe(true);

    await h.cancel();
  });

  it("re-sending the SAME session_id does not churn state.json (idempotent)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });

    await h.ingestStream(systemInitFrame("sess-xyz"));
    const afterFirst = rec.writePlanTreeFile.filter((w) => w.name === "state.json").length;
    await h.ingestStream(systemInitFrame("sess-xyz"));
    const afterSecond = rec.writePlanTreeFile.filter((w) => w.name === "state.json").length;
    // The second identical frame emits no persist (the reducer's idempotency guard) → no new write.
    expect(afterSecond).toBe(afterFirst);

    await h.cancel();
  });
});

describe("orchestrator — intent-clarification phase precedes recon", () => {
  it("start() arms intent and sends the intentPrompt (NOT the recon prompt)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    await h.start({ cwd: "/work", request: "build a widget" });

    // START landed in clarifying-intent, NOT recon.
    expect(rootPhase(h)).toBe("open/clarifying-intent");
    // Exactly one message was sent: the intent prompt, naming the intent-clarifier subagent + request.
    // FALSIFY: send reconPrompt in start() (scope-recon) → "intent-clarifier" assertion goes RED.
    expect(rec.sendMessage).toHaveLength(1);
    const intentSent = rec.sendMessage[0];
    expect(intentSent).toContain("intent-clarifier");
    expect(intentSent).toContain("build a widget");
    // The recon (scope-recon) prompt was NOT sent yet — recon follows intent, not START. Match on the
    // recon prompt's distinctive instruction text (the intent prompt itself now *names* scope-recon
    // when forbidding deep exploration, so a bare "scope-recon" substring no longer distinguishes them).
    expect(
      rec.sendMessage.some((m) => m.includes("perform broad reconnaissance of the codebase")),
    ).toBe(false);

    // JSON-CONTRACT ALIGNMENT (the prompt↔agent mismatch fix): the intent-clarifier's own definition
    // HARD-MANDATES "Return EXACTLY ONE JSON object on stdout. No prose, no markdown" of the shape
    // {intent_clear, questions[...]}. The prompt MUST match that real contract — reference the JSON
    // output and instruct the main agent to PARSE it. FALSIFY: this is RED on the OLD free-text prompt
    // (which asked the subagent for prose, never named the {intent_clear, questions} JSON).
    expect(intentSent).toContain("intent_clear");
    expect(intentSent).toContain("questions");
    expect(intentSent).toMatch(/EXACTLY ONE JSON object/);
    expect(intentSent).toMatch(/JSON\.parse/);
    expect(intentSent).toMatch(/FAST, lightweight clarification/);

    // VISUAL-PROTOTYPE MODE: the prompt now CARRIES the byte-exact
    // ---VISUAL-MODE--- directive (so the clarifier builds the rapid visual under
    // .plan-tree/prototype/), the Write-tool-only artifact guard, the medium-discretion guidance,
    // the best-effort screenshot rule, and the trailing FINALIZE contract (---PROTOTYPE--- block or
    // NO-PROTOTYPE line as the LAST content). It keeps the "no deep exploration" guard (the
    // subagent could otherwise wander before scope-recon). FALSIFY: drop the directive splice (or
    // any of these contract lines) from intentPrompt → RED.
    expect(intentSent).toContain(VISUAL_MODE_DIRECTIVE);
    expect(intentSent).toContain("---VISUAL-MODE---\noutput_dir: .plan-tree/prototype/\n---END-VISUAL-MODE---");
    expect(intentSent).toMatch(/MUST NOT deeply explore the codebase/);
    expect(intentSent).toMatch(/written with the Write\s+tool/);
    expect(intentSent).toMatch(/always SOME visual/);
    expect(intentSent).toMatch(/BEST-EFFORT/);
    expect(intentSent).toContain("---PROTOTYPE---");
    expect(intentSent).toContain("---END-PROTOTYPE---");
    expect(intentSent).toContain("NO-PROTOTYPE");

    // OWNERSHIP INVARIANT (the core hang fix): AskUserQuestion is the MAIN agent's job, NOT the
    // subagent's, and the trigger is `intent_clear` being false. The prompt MUST (a) gate the ask on
    // `intent_clear` false, (b) direct the MAIN agent to call AskUserQuestion mapping the subagent's
    // questions/options into AskUserQuestion's format, and (c) state the subagent must never call it.
    // A subagent's AskUserQuestion errors ("not available inside subagents") and surfaces zero
    // tool_permission frames to the app, so the run hangs. FALSIFY: the OLD prompt told the subagent
    // itself to "use AskUserQuestion ONCE" with no main-vs-sub distinction and no JSON gate → RED.
    expect(intentSent).toMatch(/If `intent_clear` is false/);
    expect(intentSent).toMatch(/main agent[^.]*ask its `questions` to the\s+user using the \*\*AskUserQuestion\*\* tool/);
    expect(intentSent).toMatch(/the subagent must never call it/);
    // It still asks at most once for genuine ambiguity.
    expect(intentSent).toMatch(/ONCE/);
    // It must demand a concise confirmed INTENT as CLEAN PROSE (not the raw JSON) as the final message.
    expect(intentSent).toMatch(/CONCISE confirmed INTENT as CLEAN PROSE/);
    expect(intentSent).toMatch(/never the raw JSON/);
    expect(intentSent).toMatch(/Do not call any other tool/);

    await h.cancel();
  });

  it("the intent turn result dispatches INTENT_CLARIFIED (writes INTENT.md) then sends the recon prompt + arms recon", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    await h.ingestStream(textFrame("the user wants X with constraint Y", "agent-intent"));
    await h.ingestStream(resultFrame());

    // INTENT_CLARIFIED wrote INTENT.md with the buffered intent-clarifier confirmation.
    // FALSIFY: don't dispatch INTENT_CLARIFIED on the intent result → no INTENT.md write → RED.
    const intent = rec.writePlanTreeFile.find((w) => w.name === "INTENT.md");
    expect(intent?.contents).toBe("the user wants X with constraint Y");
    // The phase advanced clarifying-intent → recon.
    expect(rootPhase(h)).toBe("open/recon");
    // The recon (scope-recon) prompt was sent as the NEXT turn, and `recon` is now armed.
    expect(rec.sendMessage.at(-1)).toContain("scope-recon");

    // Prove recon is armed: the recon turn's result must advance to sizing (NOT be swallowed).
    await h.ingestStream(textFrame("recon report body"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/sizing");
    expect(rec.sendMessage.at(-1)).toContain("plan-sizer");

    await h.cancel();
  });

  it("an AskUserQuestion raised during the intent turn surfaces as a clarify gate and CLARIFY_ANSWERED resolves it", async () => {
    // REUSE of the existing CLARIFY gate for the intent phase: the intent-clarifier may ask the user
    // a clarifying question mid-turn. It must surface as pendingClarify and resolve via answerClarify,
    // WITHOUT leaving the clarifying-intent phase.
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });
    expect(rootPhase(h)).toBe("open/clarifying-intent");

    const questions = {
      questions: [
        {
          question: "Which platform?",
          header: "Platform",
          options: [{ label: "iOS" }, { label: "web" }],
          multiSelect: false,
        },
      ],
    };
    await h.ingestPermission(askUserQuestionReq("intent-q", questions));

    // The clarify gate surfaced while still in the intent phase.
    // FALSIFY: route AskUserQuestion away from the CLARIFY gate → pendingClarify stays null → RED.
    expect(h.snapshot().pendingClarify?.toolUseId).toBe("intent-q");
    expect(rootPhase(h)).toBe("open/clarifying-intent");

    await h.answerClarify("intent-q", { "Which platform?": "iOS" });
    const resolved = rec.resolvePermission.at(-1)!;
    expect(resolved.id).toBe("intent-q");
    expect(resolved.allow).toBe(true);
    expect(resolved.updatedInput).toEqual({
      questions: questions.questions,
      answers: { "Which platform?": "iOS" },
    });
    // Still in the intent phase; the intent turn continues until its `result`.
    expect(rootPhase(h)).toBe("open/clarifying-intent");

    await h.cancel();
  });
});

// ============================================================================================
// VISUAL-PROTOTYPE LOOP — the /multiplan visual intent loop, ported in-driver (4b).
// ============================================================================================

// A valid clarifier `prototype` JSON body (the clarifier's snake_case spelling, carried verbatim
// inside the ---PROTOTYPE--- block per the FINALIZE contract).
function protoJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "html",
    paths: [".plan-tree/prototype/index.html"],
    screenshot: ".plan-tree/prototype/shot.png",
    inline_preview: null,
    variants: [],
    ...over,
  });
}

function protoBlock(json: string): string {
  return `---PROTOTYPE---\n${json}\n---END-PROTOTYPE---`;
}

// Drive a started handle's intent turn to a held prototype gate: prose + the trailing block.
async function driveToPrototypeGate(h: OrchestratorHandle, json = protoJson()): Promise<void> {
  await h.ingestStream(textFrame(`the confirmed intent prose\n\n${protoBlock(json)}`, "agent-intent"));
  await h.ingestStream(resultFrame());
}

describe("orchestrator — visual prototype gate (intent result carries a trailing block)", () => {
  it("(a) a valid trailing block fires onPrototypeReview with the parsed gate, sends NO recon, parks open/prototype-review, awaiting idle", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await h.start({ cwd: "/work", request: "build a widget" });

    const sendsBefore = rec.sendMessage.length;
    await driveToPrototypeGate(h);

    // The gate fired with the parsed prototype + the DRIVER-minted round/cwd. FALSIFY (verified):
    // skip the parsePrototypeBlock branch in the intent consume (always INTENT_CLARIFIED) → no
    // onPrototypeReview fires and the phase lands open/recon → RED.
    expect(obsRec.prototypes).toHaveLength(1);
    expect(obsRec.prototypes[0]).toMatchObject({
      kind: "html",
      paths: [".plan-tree/prototype/index.html"],
      screenshot: ".plan-tree/prototype/shot.png",
      inlinePreview: null,
      variants: [],
      round: 1,
      cwd: "/work",
    });
    expect(h.snapshot().pendingPrototype).toMatchObject({ kind: "html", round: 1 });
    expect(rootPhase(h)).toBe("open/prototype-review");
    // NO recon (or any other prompt) was sent off the intent result.
    expect(rec.sendMessage.length).toBe(sendsBefore);
    // awaiting went IDLE: a stray trailing result is swallowed (no advance, no send, no throw) —
    // PROTOTYPE_READY is signaled by turn completion; nothing is armed or held.
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/prototype-review");
    expect(rec.sendMessage.length).toBe(sendsBefore);
    // INTENT.md is NOT written at the gate — it lands at approvePrototype.
    expect(rec.writePlanTreeFile.some((w) => w.name === "INTENT.md")).toBe(false);

    await h.cancel();
  });

  it("(b) refinePrototype: PROTOTYPE_REFINED dispatched, intent re-armed, refine prompt carries directive + feedback; rounds are DRIVER-owned (gate 2 after one refine, ≥3 after three)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(h);
    expect(obsRec.prototypes.at(-1)!.round).toBe(1);

    await h.refinePrototype("make it blue");
    // PROTOTYPE_REFINED looped the root back to clarifying-intent and cleared the held gate.
    expect(rootPhase(h)).toBe("open/clarifying-intent");
    expect(h.snapshot().pendingPrototype).toBeNull();
    // The refine prompt was sent, carrying the byte-exact directive AND the feedback verbatim.
    // FALSIFY (verified): drop the feedback splice from refinePrototypePrompt → RED.
    const refineSent = rec.sendMessage.at(-1)!;
    expect(refineSent).toContain(VISUAL_MODE_DIRECTIVE);
    expect(refineSent).toContain("make it blue");
    expect(refineSent).toContain("intent-clarifier");

    // The intent turn was RE-ARMED: the next turn's trailing block opens gate round 2 — the round
    // is the driver's counter, NOT clarifier-supplied (the block carries no round at all).
    await driveToPrototypeGate(h);
    expect(obsRec.prototypes.at(-1)!.round).toBe(2);

    // Two more refines: after 3 refines the gate round is ≥ 3 REGARDLESS of clarifier output.
    await h.refinePrototype("rounder corners");
    await driveToPrototypeGate(h);
    await h.refinePrototype("darker theme");
    await driveToPrototypeGate(h);
    expect(obsRec.prototypes.at(-1)!.round).toBeGreaterThanOrEqual(3);

    await h.cancel();
  });

  it("(c) approvePrototype: INTENT.md = prose + embeddable block (absolutized screenshot_abs); recon sent with the confirmed intent; setMode('plan') BEFORE the recon send", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(
      h,
      protoJson({
        kind: "mermaid",
        paths: [".plan-tree/prototype/flow.mmd"],
        screenshot: "./.plan-tree/prototype/shot.png", // relative WITH "./" — must absolutize
        inline_preview: "graph TD;\n  A-->B",
      }),
    );

    const callsBefore = rec.calls.length;
    await h.approvePrototype();

    // INTENT.md was written via writePlanTreeFile with BOTH the prose and the SKILL-exact block.
    // FALSIFY (verified): make approvePrototype dispatch with intentContents = prose only (drop
    // composeIntentMd) → the block assertions go RED.
    const intentWrite = rec.writePlanTreeFile.find((w) => w.name === "INTENT.md");
    expect(intentWrite).toBeDefined();
    expect(intentWrite!.contents).toContain("the confirmed intent prose");
    expect(intentWrite!.contents).toContain("## Embeddable visual (for plan embedding)");
    expect(intentWrite!.contents).toContain("- kind: mermaid");
    expect(intentWrite!.contents).toContain("- screenshot_abs: /work/.plan-tree/prototype/shot.png");
    expect(intentWrite!.contents).toContain("- artifacts: .plan-tree/prototype/flow.mmd");
    expect(intentWrite!.contents).toContain("- inline_preview: |");
    expect(intentWrite!.contents).toContain("    graph TD;");
    expect(intentWrite!.contents).toContain("      A-->B");

    // The recon prompt followed, threading the confirmed intent — never the raw block.
    const reconSent = rec.sendMessage.at(-1)!;
    expect(reconSent).toContain("scope-recon");
    expect(reconSent).toContain("Confirmed intent");
    expect(reconSent).toContain("the confirmed intent prose");
    expect(reconSent).not.toContain("---PROTOTYPE---");

    // ORDERED within the approve window: the derived "plan" policy was asserted BEFORE the recon
    // send (the seam runs inside the PROTOTYPE_APPROVED dispatch) — recon never starts in the
    // genesis "prototype" mode. FALSIFY: send the recon prompt before the dispatch → RED.
    const seq = rec.calls.slice(callsBefore);
    const iPlan = seq.indexOf("setMode:plan");
    const iRecon = seq.findIndex(
      (c) => c.startsWith("sendMessage:") && c.includes("broad reconnaissance"),
    );
    expect(iPlan).toBeGreaterThanOrEqual(0);
    expect(iRecon).toBeGreaterThan(iPlan);
    expect(rootPhase(h)).toBe("open/recon");
    expect(h.snapshot().pendingPrototype).toBeNull();

    // The recon arm is live: its result advances to sizing (not swallowed).
    await h.ingestStream(textFrame("recon body"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/sizing");

    await h.cancel();
  });

  it("(c2) WORKING REFERENCE: approvePrototype({asWorkingReference:true}) freezes prototype→baseline BEFORE the dispatch and records baseline_ on the persisted ledger", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(
      h,
      protoJson({
        kind: "html",
        paths: [".plan-tree/prototype/index.html"],
        screenshot: null,
        inline_preview: null,
      }),
    );

    await h.approvePrototype({ asWorkingReference: true });

    // The freeze ran: ensureBaselineDir + freezeBaseline both called with the run cwd.
    expect(rec.ensureBaselineDir).toEqual(["/work"]);
    expect(rec.freezeBaseline).toEqual(["/work"]);
    // ORDERED: the freeze happened BEFORE the INTENT.md write (the PROTOTYPE_APPROVED dispatch),
    // so the on-disk baseline exists when the reducer records baseline_ + persists.
    // FALSIFY: dispatch first, freeze after → this ordering assertion goes RED.
    const iFreeze = rec.calls.indexOf("freezeBaseline:/work");
    const iIntent = rec.calls.indexOf("writePlanTreeFile:INTENT.md");
    expect(iFreeze).toBeGreaterThanOrEqual(0);
    expect(iIntent).toBeGreaterThan(iFreeze);

    // The persisted state.json records the frozen baseline. FALSIFY: drop the asWorkingReference
    // branch in the reducer → baseline_ is undefined here → RED.
    const stateWrite = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(stateWrite.contents) as { baseline_?: { frozen: true; frozen_ms: number } };
    expect(ledger.baseline_).toBeDefined();
    expect(ledger.baseline_!.frozen).toBe(true);
    expect(typeof ledger.baseline_!.frozen_ms).toBe("number");

    // Behavior beyond the baseline is unchanged: still advanced to recon, gate cleared.
    expect(rootPhase(h)).toBe("open/recon");
    expect(h.snapshot().pendingPrototype).toBeNull();

    await h.cancel();
  });

  it("(c3) SKETCH (default): plain approvePrototype() freezes NOTHING and records NO baseline_ (today's behavior unchanged)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(
      h,
      protoJson({
        kind: "html",
        paths: [".plan-tree/prototype/index.html"],
        screenshot: null,
        inline_preview: null,
      }),
    );

    await h.approvePrototype();

    // FALSIFY: if the default path froze, these would be non-empty → RED. The sketch path is the
    // byte-identical pre-feature behavior.
    expect(rec.ensureBaselineDir).toEqual([]);
    expect(rec.freezeBaseline).toEqual([]);
    const stateWrite = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(stateWrite.contents) as { baseline_?: unknown };
    expect(ledger.baseline_).toBeUndefined();
    expect(rootPhase(h)).toBe("open/recon");

    await h.cancel();
  });

  it("(c4) WORKING REFERENCE, FREEZE FAILS: the freeze rejecting records NO baseline_ (a presence record must match disk) yet recon STILL proceeds", async () => {
    const { deps, rec } = makeDeps();
    // The on-disk freeze fails (e.g. ensureBaselineDir/freezeBaseline throws). The ledger must NOT
    // claim a baseline that does not exist on disk — but the recon hop must still advance (the freeze
    // failure is non-fatal to the run). The dispatch must carry asWorkingReference=false (the freeze
    // did not actually run), so the reducer records no baseline_.
    deps.freezeBaseline = vi.fn(async (cwd: string) => {
      rec.calls.push(`freezeBaseline:${cwd}`);
      rec.freezeBaseline.push(cwd);
      throw new Error("disk full");
    });
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(
      h,
      protoJson({
        kind: "html",
        paths: [".plan-tree/prototype/index.html"],
        screenshot: null,
        inline_preview: null,
      }),
    );

    await h.approvePrototype({ asWorkingReference: true });

    // The freeze was ATTEMPTED (ensureBaselineDir succeeded, freezeBaseline threw)…
    expect(rec.ensureBaselineDir).toEqual(["/work"]);
    expect(rec.freezeBaseline).toEqual(["/work"]);
    // …but because it rejected, NO baseline_ is on the persisted ledger. FALSIFY: dispatch the raw
    // user flag instead of `froze` → the reducer records baseline_ here despite no on-disk copy → RED.
    const stateWrite = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(stateWrite.contents) as { baseline_?: unknown };
    expect(ledger.baseline_).toBeUndefined();

    // Recon STILL proceeded — the freeze failure never blocked the hop.
    expect(rootPhase(h)).toBe("open/recon");
    expect(h.snapshot().pendingPrototype).toBeNull();
    const reconSent = rec.sendMessage.at(-1)!;
    expect(reconSent).toContain("scope-recon");

    await h.cancel();
  });

  it("(d) a NO-PROTOTYPE final message follows the INTENT_CLARIFIED flow (marker line stripped from INTENT.md), no gate", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await h.start({ cwd: "/work", request: "do it" });

    await h.ingestStream(textFrame("the user wants X with constraint Y\n\nNO-PROTOTYPE", "agent-intent"));
    await h.ingestStream(resultFrame());

    // Identical to the pre-feature INTENT_CLARIFIED flow: INTENT.md written (the marker stripped),
    // phase advanced to recon, recon prompt sent threading the intent — and NO prototype gate.
    // FALSIFY (verified): treat NO-PROTOTYPE as a block opener (gate it) → RED here.
    expect(obsRec.prototypes).toHaveLength(0);
    expect(h.snapshot().pendingPrototype).toBeNull();
    const intent = rec.writePlanTreeFile.find((w) => w.name === "INTENT.md");
    expect(intent?.contents).toBe("the user wants X with constraint Y");
    expect(rootPhase(h)).toBe("open/recon");
    const reconSent = rec.sendMessage.at(-1)!;
    expect(reconSent).toContain("scope-recon");
    expect(reconSent).toContain("the user wants X with constraint Y");
    expect(reconSent).not.toContain("NO-PROTOTYPE");

    await h.cancel();
  });

  it("(f) approvePrototype / refinePrototype throw loudly when no prototype gate is pending", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    // Still clarifying intent — no gate held. FALSIFY: drop the null-gate guard → these resolve
    // (and dispatch an ILLEGAL PROTOTYPE_APPROVED, which the reducer would throw on) → RED.
    await expect(h.approvePrototype()).rejects.toThrow("no pending prototype gate");
    await expect(h.refinePrototype("feedback")).rejects.toThrow("no pending prototype gate");

    await h.cancel();
  });

  it("(g) ensurePrototypeDir(cwd) is called in start() BEFORE the intent prompt send", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    // Called exactly once with the run cwd, strictly BEFORE the first sendMessage (the clarifier
    // is told the output dir already exists — it must). FALSIFY (verified): move the
    // ensurePrototypeDir call after the intentPrompt send in start() → ordering assertion RED.
    expect(rec.ensurePrototypeDir).toEqual(["/work"]);
    const iDir = rec.calls.findIndex((c) => c.startsWith("ensurePrototypeDir:"));
    const iSend = rec.calls.findIndex((c) => c.startsWith("sendMessage:"));
    expect(iDir).toBeGreaterThanOrEqual(0);
    expect(iSend).toBeGreaterThan(iDir);

    await h.cancel();
  });
});

// ============================================================================================
// COMBINED apply-and-approve — the user types feedback AND clicks approve: the driver loops the
// prototype back ONE round to apply the feedback, then auto-resolves the revised gate forward to
// recon WITHOUT surfacing another review round. The latch (autoApproveNext) is driver-owned.
// ============================================================================================

describe("orchestrator — combined apply-and-approve (refinePrototype autoApprove)", () => {
  it("auto-approves the NEXT prototype turn: PROTOTYPE_READY → PROTOTYPE_APPROVED → recon, no lingering gate, no throw", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(h);
    expect(rootPhase(h)).toBe("open/prototype-review");

    // The user typed feedback AND clicked approve: refine WITH autoApprove. The root loops back to
    // clarifying-intent (the refine round) and the latch is armed.
    await h.refinePrototype("tighten the spacing", { autoApprove: true });
    expect(rootPhase(h)).toBe("open/clarifying-intent");
    expect(h.snapshot().pendingPrototype).toBeNull();

    const protosBefore = obsRec.prototypes.length;
    // The revised prototype block arrives. The latch drives the FULL legal arc — PROTOTYPE_READY
    // (clarifying-intent → prototype-review) THEN PROTOTYPE_APPROVED (prototype-review → recon).
    // CRUCIALLY this MUST NOT throw an illegal-transition (the blocker the PROTOTYPE_READY step
    // exists to avoid — see the falsifiable variant below).
    await driveToPrototypeGate(h, protoJson({ inline_preview: "<div>revised</div>" }));

    // Landed in recon, NO lingering review gate. The intermediate PROTOTYPE_READY is SILENT: its
    // notifyPrototypeReview view effect is suppressed on the auto-approve arc, so NO new
    // onPrototypeReview fires (the combined action skips the user-facing review round entirely).
    // FALSIFY (verified): drop { suppressNotifyPrototypeReview: true } from the auto-approve
    // PROTOTYPE_READY dispatch → obsRec.prototypes grows by 1 (a round-2 review surfaces) → RED.
    expect(rootPhase(h)).toBe("open/recon");
    expect(h.snapshot().pendingPrototype).toBeNull();
    expect(obsRec.prototypes.length).toBe(protosBefore);
    // INTENT.md was written (the approve arc), and the recon prompt followed.
    expect(rec.writePlanTreeFile.some((w) => w.name === "INTENT.md")).toBe(true);
    expect(rec.sendMessage.at(-1)!).toContain("scope-recon");

    // The latch CLEARED: a SUBSEQUENT prototype block would NOT auto-approve again. Prove it by
    // checking the run is past the prototype loop (in recon) — the recon arm is live.
    await h.ingestStream(textFrame("recon body"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/sizing");

    await h.cancel();
  });

  it("FALSIFIABLE: dispatching PROTOTYPE_APPROVED WITHOUT the PROTOTYPE_READY step (root in clarifying-intent) THROWS — this is the blocker the ready→approved sequence avoids", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(h);
    // Refine loops the root to clarifying-intent — exactly the state the auto-approve branch is in
    // when the revised block arrives.
    await h.refinePrototype("tighten the spacing", { autoApprove: true });
    expect(rootPhase(h)).toBe("open/clarifying-intent");

    // If the ingestion branch skipped PROTOTYPE_READY and dispatched PROTOTYPE_APPROVED directly
    // from clarifying-intent, the reducer would throw. Prove the reducer rejects it (this is the
    // RED the real path turns GREEN by transitioning through PROTOTYPE_READY first).
    await expect(
      h.dispatch({
        type: "PROTOTYPE_APPROVED",
        intentContents: "would-be intent",
        asWorkingReference: false,
        frozenMs: 0,
      }),
    ).rejects.toThrow("PROTOTYPE_APPROVED illegal");

    await h.cancel();
  });

  it("composes INTENT.md from THIS turn's parsed.intentText, not a stale prior round's prose", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "build a widget" });

    // Round 1 prose — this is the value that MUST NOT leak into the auto-approved INTENT.md.
    await h.ingestStream(textFrame(`STALE round-one prose\n\n${protoBlock(protoJson())}`, "agent-intent"));
    await h.ingestStream(resultFrame());
    await h.refinePrototype("apply the change", { autoApprove: true });

    // Round 2 (the auto-approved turn) carries DIFFERENT prose.
    await h.ingestStream(
      textFrame(`FRESH round-two prose\n\n${protoBlock(protoJson())}`, "agent-intent"),
    );
    await h.ingestStream(resultFrame());

    const intentWrite = rec.writePlanTreeFile.find((w) => w.name === "INTENT.md");
    expect(intentWrite).toBeDefined();
    // FALSIFY: if the branch reused pendingIntentText from before reassigning it to THIS turn's
    // value, the stale prose would appear instead → RED.
    expect(intentWrite!.contents).toContain("FRESH round-two prose");
    expect(intentWrite!.contents).not.toContain("STALE round-one prose");

    await h.cancel();
  });

  it("no-block auto-approve case: the revised turn emits NO prototype block → INTENT_CLARIFIED → recon, latch cleared, NO PROTOTYPE_APPROVED", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(h);
    await h.refinePrototype("just confirm it", { autoApprove: true });
    const protosBefore = obsRec.prototypes.length;

    // The revised turn applied the feedback but produced NO block — fall through to INTENT_CLARIFIED.
    await h.ingestStream(textFrame("the user wants X with constraint Y\n\nNO-PROTOTYPE", "agent-intent"));
    await h.ingestStream(resultFrame());

    // INTENT_CLARIFIED path: INTENT.md written from the prose, recon sent, NO new gate opened.
    expect(obsRec.prototypes.length).toBe(protosBefore);
    expect(h.snapshot().pendingPrototype).toBeNull();
    expect(rootPhase(h)).toBe("open/recon");
    const intent = rec.writePlanTreeFile.find((w) => w.name === "INTENT.md");
    expect(intent?.contents).toBe("the user wants X with constraint Y");
    expect(rec.sendMessage.at(-1)!).toContain("scope-recon");

    // The latch cleared: the recon arm is live (no second auto-approve hanging around).
    await h.ingestStream(textFrame("recon body"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/sizing");

    await h.cancel();
  });

  it("REGRESSION / POSITIVE CONTROL: ordinary refinePrototype (no opts) does NOT arm the latch and DOES surface the round-2 review (onPrototypeReview fires)", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(h);

    // Ordinary refine: no autoApprove. The next prototype block must NOT auto-resolve — it parks in
    // prototype-review for another interactive round.
    const protosBefore = obsRec.prototypes.length;
    await h.refinePrototype("make it blue");
    await driveToPrototypeGate(h);
    expect(rootPhase(h)).toBe("open/prototype-review");
    expect(h.snapshot().pendingPrototype).toMatchObject({ round: 2 });
    // The review VIEW notification DID fire for the round-2 gate — this is the surface the
    // auto-approve arc suppresses. (Same dispatch, opts-free → notifyPrototypeReview runs.) This is
    // the positive control proving the suppression test's assertion is meaningful, not vacuous.
    expect(obsRec.prototypes.length).toBe(protosBefore + 1);
    expect(obsRec.prototypes.at(-1)!.round).toBe(2);

    await h.cancel();
  });
});

describe("orchestrator — intent turn watchdog (new with the prototype-building intent turn)", () => {
  const clarifyInput = {
    questions: [
      { question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
    ],
  };

  it("start() arms a 300s intent watchdog; a held AskUserQuestion PAUSES it; answerClarify re-arms; the intent result clears it", async () => {
    const { deps } = makeDeps();
    const timers = installFakeTimers(deps);
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });

    const live = () => timers.filter((t) => !t.cleared);
    // Armed at start with the intent-specific (wider) window — distinct from the 120s turn
    // watchdog so timer-count pins can tell them apart.
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(300_000);

    // PAUSE: a held clarify waits on the USER (arbitrarily long) — the watchdog must not FATAL a
    // healthy run parked on the gate. FALSIFY: drop the pause in the AskUserQuestion ingest →
    // live() stays 1 here → RED.
    await h.ingestPermission(askUserQuestionReq("intent-q", clarifyInput));
    expect(live()).toHaveLength(0);
    // Liveness frames arriving DURING the hold must NOT re-arm it (the user is still thinking;
    // the liveness reset respects the pause — answerClarify alone owns the resume).
    // FALSIFY: drop the `turnWatchdog !== null` guard from the liveness reset → live() is 1 → RED.
    await h.ingestStream(textFrame("still narrating…", "agent-intent"));
    await h.ingestStream({ seq: nextSeq(), kind: "status", label: "thinking…" });
    expect(live()).toHaveLength(0);
    // RESUME: answering re-arms it (the turn is generating again).
    await h.answerClarify("intent-q", { "Which?": "A" });
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(300_000);

    // The intent result consumes the turn and CLEARS the watchdog — no late false fatal.
    await h.ingestStream(textFrame("the intent", "agent-intent"));
    await h.ingestStream(resultFrame());
    expect(timers.filter((t) => !t.cleared && t.ms === 300_000)).toHaveLength(0);
    expect(fatal).toHaveLength(0);

    await h.cancel();
  });

  it("the intent watchdog measures SILENCE, not total duration: activity frames re-arm the window (no FATAL across a long streaming turn); pure silence still fires", async () => {
    const { deps } = makeDeps();
    const timers = installFakeTimers(deps);
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });

    const live = () => timers.filter((t) => !t.cleared);
    expect(live()).toHaveLength(1);
    const armedAtStart = live()[0];

    // Five liveness frames — each proves the intent turn is still generating (a prototype build
    // streams text/tool activity the whole time, legitimately for longer than 300s TOTAL). Each
    // frame must RESET the watchdog: the previously-armed timer is cleared and a fresh full
    // 300s-of-SILENCE window armed in its place.
    // FALSIFY (verified): without the liveness reset, `armedAtStart` stays live across all five
    // frames — firing it FATALs a turn that streamed activity the entire time → RED below.
    const frames: AgentStream[] = [
      textFrame("building the prototype…", "agent-intent"),
      { seq: nextSeq(), kind: "tool_use", id: "t1", tool: "Write", input: {}, parent_tool_use_id: "agent-intent" },
      { seq: nextSeq(), kind: "tool_result", tool_use_id: "t1", content: "ok", is_error: false, parent_tool_use_id: "agent-intent" },
      { seq: nextSeq(), kind: "status", label: "running subagent" },
      { seq: nextSeq(), kind: "subagent_started", tool_use_id: "t2", subagent_type: "intent-clarifier", description: null, prompt: null },
    ];
    for (const f of frames) await h.ingestStream(f);
    // The timer armed at start was reset away by the activity (it never fires)…
    expect(armedAtStart.cleared).toBe(true);
    // …and exactly ONE fresh 300s window is live — per-silence, never cumulative.
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(300_000);
    expect(fatal).toHaveLength(0);

    // SILENCE > the window (no further frames): the live timer fires → loud terminal FATAL.
    live()[0].fn();
    await flush();
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain("intent");
    expect(h.orchestrationActive()).toBe(false);
  });

  it("a stuck intent turn (no result ever) surfaces a terminal FATAL — never a silent hang", async () => {
    const { deps } = makeDeps();
    const timers = installFakeTimers(deps);
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });

    // FALSIFY (verified): drop the armTurnWatchdog("intent", []) in start() → no timer exists,
    // nothing fires, `fatal` stays empty and the run sits active forever → RED.
    const armed = timers.filter((t) => !t.cleared);
    expect(armed).toHaveLength(1);
    armed[0].fn();
    await flush();
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain("intent");
    expect(h.orchestrationActive()).toBe(false);
    expect(isOrchestrationActive()).toBe(false);
  });
});

describe("orchestrator — parsePrototypeBlock (pure, trailing-anchored)", () => {
  const valid = protoJson();

  it("parses a valid trailing block (prose stripped into intentText; snake_case inline_preview accepted)", () => {
    const text = `the prose intent\n\n${protoBlock(valid)}`;
    const r = parsePrototypeBlock(text);
    expect(r.intentText).toBe("the prose intent");
    expect(r.prototype).toEqual({
      kind: "html",
      paths: [".plan-tree/prototype/index.html"],
      screenshot: ".plan-tree/prototype/shot.png",
      inlinePreview: null,
      variants: [],
    });
  });

  it("tolerates trailing whitespace after the block and coerces missing optional fields", () => {
    const minimal = JSON.stringify({ kind: "ascii", paths: ["a.txt"] });
    const r = parsePrototypeBlock(`p\n${protoBlock(minimal)}\n\n  `);
    expect(r.prototype).toEqual({
      kind: "ascii",
      paths: ["a.txt"],
      screenshot: null,
      inlinePreview: null,
      variants: [],
    });
  });

  it("garbled JSON → null prototype + the FULL text (never throws)", () => {
    const text = `prose\n${protoBlock("{not json!!")}`;
    expect(parsePrototypeBlock(text)).toEqual({ intentText: text, prototype: null });
  });

  it("kind outside the closed set → null + full text; non-array/empty/non-string paths → null + full text", () => {
    const badKind = `p\n${protoBlock(protoJson({ kind: "video" }))}`;
    expect(parsePrototypeBlock(badKind)).toEqual({ intentText: badKind, prototype: null });
    for (const paths of [[], "x", [1, 2], undefined]) {
      const t = `p\n${protoBlock(protoJson({ paths }))}`;
      expect(parsePrototypeBlock(t)).toEqual({ intentText: t, prototype: null });
    }
  });

  it("mid-text delimiters with no trailing block do NOT mis-parse (no false positive)", () => {
    const text = `prose mentioning ---PROTOTYPE--- and ---END-PROTOTYPE--- mid-sentence\nand more prose`;
    expect(parsePrototypeBlock(text)).toEqual({ intentText: text, prototype: null });
    const fullMidText = `prose\n${protoBlock(valid)}\nbut the block is not last`;
    expect(parsePrototypeBlock(fullMidText)).toEqual({ intentText: fullMidText, prototype: null });
  });

  it("the LAST block wins when several exist", () => {
    const first = protoBlock(protoJson({ kind: "table" }));
    const second = protoBlock(protoJson({ kind: "mermaid" }));
    const r = parsePrototypeBlock(`p\n${first}\n${second}`);
    expect(r.prototype?.kind).toBe("mermaid");
  });

  it("NO-PROTOTYPE as the last line → null prototype with the line stripped from intentText", () => {
    const r = parsePrototypeBlock("the prose intent\n\nNO-PROTOTYPE\n");
    expect(r).toEqual({ intentText: "the prose intent", prototype: null });
    // …but a NO-PROTOTYPE mentioned mid-text is NOT a marker.
    const mid = "prose with NO-PROTOTYPE mid-sentence\nmore prose";
    expect(parsePrototypeBlock(mid)).toEqual({ intentText: mid, prototype: null });
  });

  it("contract violation — a complete block FOLLOWED by a trailing NO-PROTOTYPE → null prototype AND the block stripped (no delimiter leaks into intentText/INTENT.md)", () => {
    // The FINALIZE contract says EXACTLY ONE of block-or-line; a model emitting BOTH must not leak
    // the raw block into the intent prose. FALSIFY (verified): strip only the NO-PROTOTYPE line in
    // that branch (the old behavior) → intentText still carries both delimiters → RED.
    const r = parsePrototypeBlock(`the prose intent\n\n${protoBlock(valid)}\nNO-PROTOTYPE`);
    expect(r.prototype).toBeNull();
    expect(r.intentText).toContain("the prose intent");
    expect(r.intentText).not.toContain("---PROTOTYPE---");
    expect(r.intentText).not.toContain("---END-PROTOTYPE---");
    // An UNCLOSED opener mid-prose is NOT a block — it survives the strip (no false positive).
    const unclosed = parsePrototypeBlock("prose\n---PROTOTYPE---\nnever closed\nNO-PROTOTYPE");
    expect(unclosed.prototype).toBeNull();
    expect(unclosed.intentText).toBe("prose\n---PROTOTYPE---\nnever closed");
  });

  it("plain prose (no marker, no block) passes through untouched — the inert shape", () => {
    const text = "just a confirmed intent paragraph";
    expect(parsePrototypeBlock(text)).toEqual({ intentText: text, prototype: null });
  });

  it("coerces malformed variants entries away and accepts well-formed ones", () => {
    const r = parsePrototypeBlock(
      `p\n${protoBlock(
        protoJson({
          variants: [
            { label: "A", path: "a.html", inline_preview: "ascii art" },
            { nope: true },
            "garbage",
          ],
        }),
      )}`,
    );
    expect(r.prototype?.variants).toEqual([{ label: "A", path: "a.html", inlinePreview: "ascii art" }]);
  });
});

describe("orchestrator — composeIntentMd (pure)", () => {
  const proto = (over: Record<string, unknown> = {}) =>
    ({
      kind: "mermaid",
      paths: ["flow.mmd"],
      screenshot: null,
      inlinePreview: "graph TD;\n  A-->B",
      variants: [],
      ...over,
    }) as Parameters<typeof composeIntentMd>[1];

  it("null prototype → the prose only (no block)", () => {
    expect(composeIntentMd("the prose", null, "/work")).toBe("the prose");
  });

  it("html kind OMITS the inline_preview key entirely (the screenshot carries the visual)", () => {
    const md = composeIntentMd("p", proto({ kind: "html", screenshot: "shot.png", inlinePreview: "<div/>" }), "/work");
    expect(md).toContain("- kind: html");
    expect(md).not.toContain("inline_preview");
    // FALSIFY (verified): include the key for html in composeIntentMd → RED here.
  });

  it("mermaid/ascii/table include the verbatim inline_preview, indented under the literal marker", () => {
    const md = composeIntentMd("p", proto(), "/work");
    expect(md).toContain("- inline_preview: |\n    graph TD;\n      A-->B");
  });

  it("includes the prototype artifact paths under the block: '- artifacts: <paths joined with \", \">'", () => {
    // Downstream plan turns may want the exact file list (the external SKILL's INTENT.md carries
    // it). FALSIFY (verified): drop the artifacts line from composeIntentMd → RED.
    const md = composeIntentMd("p", proto({ paths: ["flow.mmd", "alt.html"] }), "/work");
    expect(md).toContain("- artifacts: flow.mmd, alt.html");
  });

  it("screenshot absolutization table: '/abs' verbatim; './rel' and 'rel' joined onto cwd; null → none", () => {
    const at = (s: string | null) =>
      composeIntentMd("p", proto({ screenshot: s }), "/work").match(/- screenshot_abs: (.*)/)![1];
    expect(at("/abs/shot.png")).toBe("/abs/shot.png");
    expect(at("./rel/shot.png")).toBe("/work/rel/shot.png");
    expect(at("rel/shot.png")).toBe("/work/rel/shot.png");
    expect(at(null)).toBe("none");
  });
});

describe("orchestrator — refinePrototypePrompt (pure)", () => {
  it("carries the directive, the scope guard, the FINALIZE contract, and the feedback verbatim", () => {
    const p = refinePrototypePrompt("make the header sticky");
    expect(p).toContain(VISUAL_MODE_DIRECTIVE);
    expect(p).toContain(WORKDIR_SCOPE_GUARD);
    expect(p).toContain("make the header sticky");
    expect(p).toContain("---PROTOTYPE---");
    expect(p).toContain("NO-PROTOTYPE");
    expect(p).toContain("intent-clarifier");
  });
});

describe("orchestrator — confirmed intent is threaded into downstream planning prompts", () => {
  it("a NON-EMPTY intent buffer makes the recon prompt sent contain the confirmed intent text", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    // Drive the intent turn with a non-empty confirmed intent.
    await h.ingestStream(textFrame("user wants a multiplayer game", "agent-intent"));
    await h.ingestStream(resultFrame());

    // The recon prompt actually sent to the SDK threads the confirmed intent. FALSIFY: revert the
    // intent branch to `reconPrompt(request)` (no intent) → the intent text is absent → RED.
    const reconSent = rec.sendMessage.at(-1)!;
    expect(reconSent).toContain("scope-recon");
    expect(reconSent).toContain("Confirmed intent");
    expect(reconSent).toContain("user wants a multiplayer game");

    await h.cancel();
  });

  it("an EMPTY/whitespace intent buffer sends the PLAIN recon prompt (no 'Confirmed intent' block)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    // Drive the intent turn with a whitespace-only confirmed intent (graceful empty case).
    await h.ingestStream(textFrame("   ", "agent-intent"));
    await h.ingestStream(resultFrame());

    // The recon prompt sent is the plain one — byte-identical to reconPrompt(request), with no empty
    // intent block. FALSIFY: thread the (empty) intent unconditionally → a "Confirmed intent" label
    // appears → RED.
    const reconSent = rec.sendMessage.at(-1)!;
    expect(reconSent).toBe(reconPrompt("do it"));
    expect(reconSent).not.toContain("Confirmed intent");

    await h.cancel();
  });

  it("the master-draft prompt on the split path contains the confirmed intent", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    // intent → recon → sizer(split): the split branch sends the master-draft prompt.
    await h.ingestStream(textFrame("user wants a multiplayer game", "agent-intent"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 3 / 0.82"));
    await h.ingestStream(resultFrame());

    // The master-draft prompt sent on the split path threads the confirmed intent. FALSIFY: drop the
    // confirmedIntent arg at the split-branch masterDraftPrompt call → RED.
    const masterSent = rec.sendMessage.at(-1)!;
    expect(masterSent).toContain("MASTER decomposition plan");
    expect(masterSent).toContain("Confirmed intent");
    expect(masterSent).toContain("user wants a multiplayer game");

    await h.cancel();
  });
});

describe("orchestrator — module-level active guard", () => {
  it("isOrchestrationActive() is false before start, true after start, false after terminal", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    expect(isOrchestrationActive()).toBe(false); // FALSIFY: register on construct -> RED here
    await h.start({ cwd: "/work", request: "do it" });
    expect(isOrchestrationActive()).toBe(true);
    expect(h.orchestrationActive()).toBe(true);
    await h.cancel();
    expect(isOrchestrationActive()).toBe(false);
    expect(h.orchestrationActive()).toBe(false);
  });
});

// Dispatch a split run's pre-execution prologue via the funnel (gen-2 events). The gen-1 prologue
// dispatched RECON_DONE directly after START; gen-2 is stricter — the root must pass
// INTENT_CLARIFIED first (clarifying-intent → recon), and the decomposition gate is a first-class
// reducer arc (DECOMPOSITION_DRAFTED holds the unified gate; DECOMPOSITION_APPROVED resolves it).
async function dispatchSplitPrologue(h: OrchestratorHandle, titles: string[]): Promise<void> {
  const dispatch = dispatchOf(h);
  await dispatch({ type: "INTENT_CLARIFIED", intent: "i" });
  await dispatch({ type: "NODE_RECON_DONE", path: [] });
  await dispatch({
    type: "SIZER_DONE",
    path: [],
    outcome: { decision: "split", confidence: 0.9, num_plans: titles.length },
  });
  await dispatch({
    type: "DECOMPOSITION_DRAFTED",
    path: [],
    planPath: "/p/master.md",
    plansDirPath: "/p/master.md",
    toolUseId: "master-tu",
  });
  await dispatch({
    type: "CHILDREN_PARSED",
    path: [],
    children: titles.map((t, idx) => ({ nn: nnOf(idx + 1), title: t })),
  });
  await dispatch({ type: "DECOMPOSITION_APPROVED", path: [] });
}

describe("orchestrator — full split-of-3 run", () => {
  it("records the ordered side-effects, tagging every writeAgentPlan with the real treeId + correct nn", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, awaiting, summaries } = makeObserver();
    h.subscribe(obs);

    await h.start({ cwd: "/work", request: "do it" });
    const treeId = h.snapshot().treeId;
    expect(treeId).toMatch(/^tree-/); // a real tree id was minted by START

    await dispatchSplitPrologue(h, ["A", "B", "C"]);

    const dispatch = dispatchOf(h);
    for (const nnRaw of [1, 2, 3]) {
      const nn = nnOf(nnRaw);
      await dispatch({ type: "NODE_RECON_DONE", path: [nn] });
      // PHASE 4: every non-root node runs the per-node sizer (single ⇒ the node IS the leaf).
      await dispatch({
        type: "SIZER_DONE",
        path: [nn],
        outcome: { decision: "single", confidence: 0.9, num_plans: 1 },
      });
      // The draft lands through the REAL interactive path (gen-2: the DRIVER is the single
      // authoritative plan writer — Effect2 has no writeAgentPlan kind, so a raw NODE_DRAFTED
      // dispatch would record no write at all).
      await h.ingestPermission(exitPlanModeReq(`sub-${nn}-tu`, `sub ${nn} plan`));
      await h.approve(pathKey([nn]));
      await dispatch({ type: "EXEC_DONE", path: [nn] });
      await dispatch({
        type: "SUMMARY_WRITTEN",
        path: [nn],
        summaryText: `summary ${nn}`,
        summaryPath: pathOf(`/p/${nn}-summary.md`),
      });
      // PHASE 5: a non-final child's summary parks the root in `reviewing`; the review turn's
      // PARENT_REVIEW_DONE is the arc that activates the next sibling. Skipped after the last.
      if (nnRaw < 3) await dispatch({ type: "PARENT_REVIEW_DONE", path: [], note: null });
    }

    // Every writeAgentPlan carried the REAL treeId and the correct per-node nn — a mistagged node
    // (wrong / undefined treeId) would be classified as a master by the backend. FALSIFY: pass
    // `undefined` for treeId at the ingestPermission write site and this exact-args assertion goes RED.
    expect(rec.writeAgentPlan).toEqual([
      { plan: "sub 1 plan", treeId, nn: "01" },
      { plan: "sub 2 plan", treeId, nn: "02" },
      { plan: "sub 3 plan", treeId, nn: "03" },
    ]);
    for (const w of rec.writeAgentPlan) {
      expect(w.treeId).toBe(treeId);
      expect(typeof w.treeId).toBe("string");
      expect(w.treeId.length).toBeGreaterThan(0);
    }

    // onAwaitingApproval fired for the ROOT decomposition gate (the unified gate — key "" — the
    // gen-1 driver-side sentinel surface is gone) and once per leaf draft (3×); onSummaryWritten 3×
    // path-keyed.
    expect(awaiting).toEqual([
      { key: "", kind: "decomposition", toolUseId: "master-tu" },
      { key: "01", kind: "leaf", toolUseId: "sub-1-tu" },
      { key: "02", kind: "leaf", toolUseId: "sub-2-tu" },
      { key: "03", kind: "leaf", toolUseId: "sub-3-tu" },
    ]);
    expect(summaries).toEqual([
      { key: "01", summaryPath: "/p/1-summary.md" },
      { key: "02", summaryPath: "/p/2-summary.md" },
      { key: "03", summaryPath: "/p/3-summary.md" },
    ]);

    // The decomposition approval resolved the held master permission; each leaf APPROVE resolved its
    // held permission (allow) and set acceptEdits.
    expect(rec.resolvePermission).toEqual([
      { id: "master-tu", allow: true, message: undefined },
      { id: "sub-1-tu", allow: true, message: undefined },
      { id: "sub-2-tu", allow: true, message: undefined },
      { id: "sub-3-tu", allow: true, message: undefined },
    ]);
    // The DERIVED write policy: the session OPENS in the genesis "prototype" policy (no setMode —
    // startSession carries it), "plan" first asserted at the INTENT_CLARIFIED boundary
    // (clarifying-intent → recon), re-asserted at the decomposition approval (the allow resolve
    // makes the SDK mode unknown), acceptEdits asserted at each APPROVE (leaf → executing), and
    // "plan" re-asserted at each SUMMARY_WRITTEN advance (next sibling → recon). The final summary
    // is terminal (done) so no trailing re-assert. FALSIFY: drop the derived assertion in dispatch →
    // this exact trace collapses → RED.
    expect(rec.setMode).toEqual(["plan", "plan", "acceptEdits", "plan", "acceptEdits", "plan", "acceptEdits"]);

    // The run reached terminal done.
    expect(h.snapshot().done).toBe(true);
    expect(isOrchestrationActive()).toBe(false);
  });

  it("persists state.json after EVERY transition that emits a persist effect", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    // Count the dispatched events that the reducer emits a `persist` effect for. From plan-tree.ts
    // (reduce2): persist is emitted by START, INTENT_CLARIFIED, NODE_RECON_DONE, SIZER_DONE,
    // DECOMPOSITION_DRAFTED, CHILDREN_PARSED, DECOMPOSITION_APPROVED, NODE_DRAFTED, APPROVE,
    // REQUEST_CHANGES, DECOMPOSITION_CHANGES_REQUESTED, EXEC_DONE, SUMMARY_WRITTEN,
    // PARENT_REVIEW_DONE (PHASE 5).
    // (CLARIFY_REQUESTED / CLARIFY_ANSWERED / FATAL do NOT persist.) Our split run dispatches:
    //   START(1) INTENT_CLARIFIED(1) NODE_RECON_DONE(1) SIZER_DONE(1) DECOMPOSITION_DRAFTED(1)
    //   CHILDREN_PARSED(1) DECOMPOSITION_APPROVED(1)
    //   + per child × 3: NODE_RECON_DONE, SIZER_DONE (PHASE 4: per-node sizer), NODE_DRAFTED,
    //     APPROVE, EXEC_DONE, SUMMARY_WRITTEN (6 each)
    //   + PARENT_REVIEW_DONE × 2 (PHASE 5: between siblings — skipped after the last child)
    //   = 7 + 18 + 2 = 27 persist-emitting events.
    let expectedPersists = 0;

    await h.start({ cwd: "/work", request: "do it" });
    expectedPersists++; // START

    await dispatchSplitPrologue(h, ["A", "B", "C"]);
    expectedPersists += 6; // INTENT_CLARIFIED + RECON + SIZER + DRAFTED + PARSED + APPROVED

    const dispatch = dispatchOf(h);
    for (const nnRaw of [1, 2, 3]) {
      const nn = nnOf(nnRaw);
      await dispatch({ type: "NODE_RECON_DONE", path: [nn] });
      expectedPersists++;
      await dispatch({
        type: "SIZER_DONE",
        path: [nn],
        outcome: { decision: "single", confidence: 0.9, num_plans: 1 },
      });
      expectedPersists++;
      await dispatch({
        type: "NODE_DRAFTED",
        path: [nn],
        toolUseId: `t${nn}`,
        planPath: `/p/${nn}`,
        plansDirPath: "/p",
      });
      expectedPersists++;
      await h.approve(pathKey([nn]));
      expectedPersists++;
      await dispatch({ type: "EXEC_DONE", path: [nn] });
      expectedPersists++;
      await dispatch({
        type: "SUMMARY_WRITTEN",
        path: [nn],
        summaryText: `s${nn}`,
        summaryPath: pathOf(`/p/${nn}-s.md`),
      });
      expectedPersists++;
      // PHASE 5: the between-siblings review hop (PARENT_REVIEW_DONE persists too).
      if (nnRaw < 3) {
        await dispatch({ type: "PARENT_REVIEW_DONE", path: [], note: null });
        expectedPersists++;
      }
    }

    const persistCount = rec.writePlanTreeFile.filter((w) => w.name === "state.json").length;
    // FALSIFY: drop the `persist` effect from runEffect (skip writing state.json) and this equality
    // goes RED (count would fall to 0).
    expect(persistCount).toBe(expectedPersists);
    expect(persistCount).toBe(27);
    // The persisted contents are the schema-2 ledger (no transient gates) and re-parse cleanly.
    const last = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(last.contents);
    expect(ledger.schema).toBe(2);
    expect(ledger.root.state.stage).toBe("split");
    expect(ledger.root.state.phase).toBe("summarized"); // run completion is DERIVED from the root
    expect(ledger.pendingApproval).toBeUndefined(); // transient gates excluded from the ledger
    expect(ledger.parsedChildren).toBeUndefined();
  });
});

// ============================================================================================
// PHASE 5 — the forced acceptance gate at the completion seam (baseline floor enforcement).
// ============================================================================================

describe("orchestrator — forced acceptance gate (baseline present)", () => {
  // Drive a started handle through the WORKING-REFERENCE prototype gate (records baseline_) then a
  // single-collapse run up to the LAST (only) child's summary turn — the completion seam. Stops with
  // the summary turn's `result` already ingested, so the gate decision is observable.
  async function driveBaselineRunToCompletionSeam(h: OrchestratorHandle): Promise<void> {
    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(
      h,
      protoJson({ kind: "html", paths: [".plan-tree/prototype/index.html"], screenshot: null, inline_preview: null }),
    );
    // WORKING REFERENCE → freezes prototype→baseline and records baseline_ on the ledger.
    await h.approvePrototype({ asWorkingReference: true });
    // Root recon → confident single → COLLAPSE to one child "01" (which skips the per-node sizer).
    await h.ingestStream(textFrame("root recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    // Child 01: recon → draft → approve → exec → summary.
    await h.ingestStream(textFrame("child recon"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    await h.ingestStream(resultFrame()); // exec completion → summary prompt + arm summary
    await h.ingestStream(textFrame("## Changes\nbuilt it\n## Findings\nf\n## Next-step inputs\nn"));
    await h.ingestStream(resultFrame()); // summary result → SUMMARY_WRITTEN → completion seam
  }

  it("the last child's summary ARMS pendingAcceptance + fires notifyAcceptanceReview, WITHHOLDS notifyDone, opens the baseline, and sends NO rollup turn", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);

    const sendsBeforeSummary = rec.sendMessage.length;
    await driveBaselineRunToCompletionSeam(h);

    // FALSIFIABLE (the orchestrator headline): remove the reducer's baseline gate (or the runEffect
    // notifyAcceptanceReview case) → onAcceptanceReview never fires AND onDone fires here → BOTH
    // assertions below go RED.
    const acceptances = obsRec.acceptances;
    expect(acceptances).toHaveLength(1);
    expect(h.snapshot().pendingAcceptance).not.toBeNull();
    // notifyDone is WITHHELD — the run is NOT done at the gate.
    expect(obsRec.done).toBe(0);
    expect(h.snapshot().done).toBe(false);
    expect(isOrchestrationActive()).toBe(true); // still active — markTerminal only runs at notifyDone

    // The driver opened the baseline (best-effort) with the run cwd + the augmented open target.
    expect(rec.openBaseline).toEqual([{ cwd: "/work", path: "index.html" }]);
    // The augmented gate carried the run cwd into the snapshot (so the UI bar can resolve it).
    expect(h.snapshot().pendingAcceptance!.cwd).toBe("/work");
    expect(acceptances[0].cwd).toBe("/work");

    // CRITICAL: NO rollup/summary turn was sent for the root at the gate (the acceptance window is
    // structurally identical to a roll-up window — without the consume short-circuit the driver would
    // erroneously send a root roll-up prompt). FALSIFY: drop the `nextPath.length===0 &&
    // pendingAcceptance` short-circuit in the summary consume branch → an extra rollup sendMessage
    // lands here → RED. The only sends after the summary turn are NONE (no rollup, no recon).
    const sendsAfter = rec.sendMessage.slice(sendsBeforeSummary);
    expect(sendsAfter.some((s) => s.toLowerCase().includes("roll-up") || s.toLowerCase().includes("rollup"))).toBe(false);

    await h.cancel();
  });

  it("approveAcceptance() finalizes the run: notifyDone fires, treeIsDone, verdict 'approved' persisted, gate cleared", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await driveBaselineRunToCompletionSeam(h);
    expect(obsRec.done).toBe(0); // withheld at the gate

    await h.approveAcceptance();

    // The deferred finalize ran now.
    expect(obsRec.done).toBe(1);
    expect(h.snapshot().done).toBe(true);
    expect(h.snapshot().pendingAcceptance).toBeNull();
    expect(isOrchestrationActive()).toBe(false); // notifyDone → markTerminal
    // The verdict is persisted on the ledger.
    const lastState = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(lastState.contents) as { acceptance_?: { verdict: string } };
    expect(ledger.acceptance_).toEqual({ verdict: "approved", decided_ms: expect.any(Number) });
  });

  it("divergeAcceptance(reason) finalizes the run AND persists the divergence reason on the ledger", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await driveBaselineRunToCompletionSeam(h);

    await h.divergeAcceptance("perf below the floor; documented follow-up filed");

    expect(obsRec.done).toBe(1);
    expect(h.snapshot().done).toBe(true);
    const lastState = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(lastState.contents) as {
      acceptance_?: { verdict: string; reason?: string };
    };
    // FALSIFY: drop the reason from the ACCEPTANCE_DIVERGED record or toLedger2 → reason missing → RED.
    expect(ledger.acceptance_).toEqual({
      verdict: "diverged",
      reason: "perf below the floor; documented follow-up filed",
      decided_ms: expect.any(Number),
    });
  });

  it("approveAcceptance() / divergeAcceptance() throw when no acceptance gate is pending", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await expect(h.approveAcceptance()).rejects.toThrow("no pending acceptance gate");
    await expect(h.divergeAcceptance("x")).rejects.toThrow("no pending acceptance gate");
    await h.cancel();
  });

  it("refineAcceptance(target) resets the sub-plan, deletes its NN files, clears the gate, and drives a fresh recon turn (re-execution)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);
    await driveBaselineRunToCompletionSeam(h);
    // Parked at the gate (single-collapse → one child "01").
    expect(h.snapshot().pendingAcceptance).not.toBeNull();
    expect(obsRec.done).toBe(0);

    const sendsBefore = rec.sendMessage.length;
    await h.refineAcceptance([nnOf(1)]);

    // The gate is cleared (back to executing); NO verdict was recorded, baseline still present.
    expect(h.snapshot().pendingAcceptance).toBeNull();
    expect(h.snapshot().done).toBe(false);
    expect(obsRec.done).toBe(0);
    // The reset node's NN-plan.md AND NN-summary.md were deleted (containment-guarded, allow-list names).
    expect(rec.deletePlanTreeFile.map((d) => d.name)).toEqual(["01-plan.md", "01-summary.md"]);
    for (const d of rec.deletePlanTreeFile) {
      expect(d.cwd).toBe("/work");
      expect(d.name).toMatch(/^\d{2}-(plan|summary)\.md$/);
    }
    // A fresh recon turn was driven for the reset target (re-execution resumes there).
    const sendsAfter = rec.sendMessage.slice(sendsBefore);
    expect(sendsAfter.some((s) => /sub-plan 01/i.test(s) && /scope-recon/i.test(s))).toBe(true);
    // Still active — markTerminal only runs at notifyDone (which the refine withheld).
    expect(isOrchestrationActive()).toBe(true);

    await h.cancel();
  });

  it("refineAcceptance() throws when no acceptance gate is pending", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await expect(h.refineAcceptance([nnOf(1)])).rejects.toThrow("no pending acceptance gate");
    await h.cancel();
  });

  it("NO baseline (sketch run): the last child's summary fires notifyDone immediately — no acceptance gate (regression guard)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const obsRec = makeObserver();
    h.subscribe(obsRec.obs);

    await h.start({ cwd: "/work", request: "build a widget" });
    await driveToPrototypeGate(
      h,
      protoJson({ kind: "html", paths: [".plan-tree/prototype/index.html"], screenshot: null, inline_preview: null }),
    );
    // SKETCH (default) — NO baseline frozen.
    await h.approvePrototype();
    await h.ingestStream(textFrame("root recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("child recon"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("## Changes\nbuilt it\n## Findings\nf\n## Next-step inputs\nn"));
    await h.ingestStream(resultFrame()); // summary result → completion

    // FALSIFIABLE regression guard: the no-baseline path finalizes immediately — no gate, no
    // open_baseline. FALSIFY: arm the gate unconditionally (drop the baseline_ condition) →
    // obsRec.done would be 0 and acceptances non-empty → RED.
    expect(obsRec.acceptances).toHaveLength(0);
    expect(rec.openBaseline).toEqual([]);
    expect(obsRec.done).toBe(1);
    expect(h.snapshot().done).toBe(true);
    expect(isOrchestrationActive()).toBe(false);
  });
});

describe("orchestrator — requestChanges mid-run", () => {
  it("denies with feedback, does NOT advance the active path, increments redraftCount, and a re-draft+approve proceeds", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await dispatchSplitPrologue(h, ["A", "B"]);
    const dispatch = dispatchOf(h);
    await dispatch({ type: "NODE_RECON_DONE", path: [nnOf(1)] });
    await dispatch({
      type: "SIZER_DONE",
      path: [nnOf(1)],
      outcome: { decision: "single", confidence: 0.9, num_plans: 1 },
    });
    await dispatch({
      type: "NODE_DRAFTED",
      path: [nnOf(1)],
      toolUseId: "tu-1a",
      planPath: "/p/1",
      plansDirPath: "/p",
    });

    expect(activeKey(h)).toBe("01");

    await h.requestChanges("01", "needs more detail");

    // Denied the held permission WITH the feedback message.
    expect(rec.resolvePermission.at(-1)).toEqual({
      id: "tu-1a",
      allow: false,
      message: "needs more detail",
    });
    // Active path unchanged (re-draft is in place — FALSIFY: advance the active node in
    // REQUEST_CHANGES -> RED).
    expect(activeKey(h)).toBe("01");
    // redraftCount incremented; the node is back to leaf/drafting.
    const sub1 = childOf(h, 1);
    expect(sub1.redraftCount).toBe(1);
    expect(childPhase(h, 1)).toBe("leaf/drafting");
    expect(sub1.lastFeedback).toBe("needs more detail");

    // A re-draft + APPROVE then proceeds normally.
    await dispatch({
      type: "NODE_DRAFTED",
      path: [nnOf(1)],
      toolUseId: "tu-1b",
      planPath: "/p/1",
      plansDirPath: "/p",
    });
    await h.approve("01");
    expect(childPhase(h, 1)).toBe("leaf/executing");
    expect(rec.resolvePermission.at(-1)).toEqual({ id: "tu-1b", allow: true, message: undefined });

    await h.teardown(); // leave the module guard clean for the next test
  });
});

describe("orchestrator — cancel purges a held approval", () => {
  it("cancel() calls cancelRun+endSession, deactivates, and purges (denies) a held approval", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await dispatchSplitPrologue(h, ["A"]);
    const dispatch = dispatchOf(h);
    await dispatch({ type: "NODE_RECON_DONE", path: [nnOf(1)] });
    await dispatch({
      type: "SIZER_DONE",
      path: [nnOf(1)],
      outcome: { decision: "single", confidence: 0.9, num_plans: 1 },
    });
    await dispatch({
      type: "NODE_DRAFTED",
      path: [nnOf(1)],
      toolUseId: "held-tu",
      planPath: "/p/1",
      plansDirPath: "/p",
    });

    // A permission is held (awaiting approval).
    expect(h.snapshot().pendingApproval?.toolUseId).toBe("held-tu");

    await h.cancel();

    // The held approval was purged (denied) so the sidecar resolver is not stranded.
    expect(rec.resolvePermission.at(-1)).toEqual({
      id: "held-tu",
      allow: false,
      message: "Run cancelled.",
    });
    expect(rec.cancelRun).toBe(1);
    expect(rec.endSession).toBe(1);
    expect(isOrchestrationActive()).toBe(false);
    expect(h.orchestrationActive()).toBe(false);

    // No further approval is possible — a second cancel does not re-purge (id already cleared).
    const denyCountBefore = rec.resolvePermission.length;
    await h.cancel();
    expect(rec.resolvePermission.length).toBe(denyCountBefore);
  });
});

// ============================================================================================
// Sub-Plan 03 DRIVER CORE — live bridge / sequencer tests (drive ingest* entry points).
// ============================================================================================

describe("orchestrator — bootstrap + idempotent no-op", () => {
  it("start() opens a plan-mode session, sends the intent prompt, returns true; a 2nd start returns false", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    const started = await h.start({ cwd: "/work", request: "build a widget" });
    expect(started).toBe(true);

    // Opened the SDK session in the derived GENESIS policy ("prototype": the root opens in
    // clarifying-intent — start() carries the mode so no pre-start setMode is needed).
    expect(rec.startSession).toEqual([{ cwd: "/work", permissionMode: "prototype" }]);
    // Sent exactly one message: the INTENT prompt (the opening turn now), naming the intent-clarifier
    // subagent + the request. (Recon follows intent, so the scope-recon prompt is NOT the first send.)
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toContain("intent-clarifier");
    expect(rec.sendMessage[0]).toContain("build a widget");

    // A second start while active is the idempotent no-op: returns false, opens no new session.
    // FALSIFY: make start() always return true (drop the `if (active) return false`) -> RED here.
    const again = await h.start({ cwd: "/other", request: "again" });
    expect(again).toBe(false);
    expect(rec.startSession).toHaveLength(1);

    await h.cancel();
  });
});

describe("orchestrator — sequencer via scripted frames", () => {
  it("recon → sizer(split) advances and sends the master-draft prompt", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below

    // recon turn completes.
    await h.ingestStream(textFrame("recon report body", "agent-recon"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/sizing");
    // RECON_DONE wrote recon.md with the buffered subagent report.
    const recon = rec.writePlanTreeFile.find((w) => w.name === "recon.md");
    expect(recon?.contents).toBe("recon report body");

    // sizer turn: a SIZER split line then result.
    await h.ingestStream(textFrame("SIZER: split / 3 / 0.82"));
    await h.ingestStream(resultFrame());

    // (Schema 2 stores no sizer field — the split verdict is fully encoded in the decomposing arc.)
    expect(rootPhase(h)).toBe("open/decomposing");
    // The master-draft prompt was sent (last message). FALSIFY: route split to sub-recon -> RED.
    expect(rec.sendMessage.at(-1)).toContain("MASTER decomposition plan");

    await h.cancel();
  });

  it("recon → sizer(single) collapses to sub-recon and sends NO master-draft prompt", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());

    await h.ingestStream(textFrame("SIZER: single / 1 / 0.95"));
    await h.ingestStream(resultFrame());

    // The reducer collapsed single → running, pointer 0, sub 0 in recon.
    expect(rootPhase(h)).toBe("split/running-children");
    expect(activeKey(h)).toBe("01");
    // A sub-recon prompt was sent; NO master-draft prompt anywhere.
    expect(rec.sendMessage.at(-1)).toContain("reconnaissance scoped to THIS sub-plan");
    expect(rec.sendMessage.some((m) => m.includes("MASTER decomposition plan"))).toBe(false);

    await h.cancel();
  });

  it("recon → sizer(LOW-confidence single) routes to decomposing: sends the master-draft prompt, NOT a sub-recon prompt", async () => {
    // The DRIVER branch for a single decision below the 0.6 confidence gate. The reducer half (routing
    // a low-confidence single to `decomposing`, treated as a split) is already tested; this pins the
    // DRIVER's mirror of that gate: it must send the MASTER-DRAFT prompt and leave the sequencer idle
    // (the next signal is the master ExitPlanMode hold, not a `result`), NOT drive the pointed sub's
    // recon the way a CONFIDENT single does.
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());

    // SIZER: single / 1 / 0.5 — a single decision BELOW the 0.6 confidence gate.
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.5"));
    await h.ingestStream(resultFrame());

    // The reducer routed the low-confidence single to the pre-execution `decomposing` phase (a real
    // sub is NOT yet pointed). FALSIFY: change the driver's confidence gate (`>= 0.6`) so a low-conf
    // single takes the confident branch → it sends a sub-recon prompt instead → the next two asserts go
    // RED (no master-draft prompt; a sub-recon prompt present).
    expect(rootPhase(h)).toBe("open/decomposing");
    // The MASTER-DRAFT prompt was sent (last message), mirroring the split branch.
    expect(rec.sendMessage.at(-1)).toContain("MASTER decomposition plan");
    // NO sub-recon prompt was sent off the low-confidence single (that is the confident-single path).
    expect(rec.sendMessage.some((m) => m.includes("reconnaissance scoped to THIS sub-plan"))).toBe(false);

    // The sequencer is idle: the next signal is the master ExitPlanMode hold, not a `result`. A stray
    // `result` here must therefore be SWALLOWED (no further prompt). FALSIFY: arm a sub-recon variant in
    // the low-conf branch → this result would advance and send another prompt → sendMessage count rises.
    const beforeStray = rec.sendMessage.length;
    await h.ingestStream(resultFrame());
    expect(rec.sendMessage.length).toBe(beforeStray);

    await h.cancel();
  });

  // (The old "omitting the SIZER line goes FATAL" test was REMOVED 2026-06-10: the two-outcome
  // sizer COERCES an unparseable sizer turn to split instead of ending the run — see
  // "orchestrator — TWO-OUTCOME sizer: unknown decisions coerce to split" below. The SIZER-scan
  // strictness it also pinned — chatter never parses as a decision — lives in plan-tree.test.ts's
  // parseSizerDecision unit tests.)
});

describe("orchestrator — master-write contract via the REAL ingestPermission path", () => {
  // REGRESSION (the sidebar nesting bug): the master decomposition plan reached ~/.claude/plans/
  // through the LIVE ingestPermission path (a real ExitPlanMode hold while `decomposing`), NOT the
  // dispatch/effect path the other writeAgentPlan tests exercise. The bug was that the master was
  // mis-stamped, so the sidebar found no master record and the subs orphaned to a flat list. This
  // test drives the ACTUAL un-mocked path (ingestPermission → writeAgentPlan) and pins the exact
  // (plan, treeId, nn) args: the MASTER is written with nn === null (⇒ Rust flavor:master) and the
  // SUB with nn === <pointed>, both carrying the SAME treeId the run minted (so the sidebar nests).
  it("the master ExitPlanMode hold writes nn=null (master) with the run's treeId; the sub writes nn=1 (same treeId)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    const treeId = h.snapshot().treeId;
    expect(treeId).toMatch(/^tree-/);
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below

    // Recon → sizer(split) so the master enters `decomposing` (the phase the master ExitPlanMode
    // hold is recognized in). All via live frames — the same substrate the live run uses.
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).toBe("open/decomposing");

    // The MASTER ExitPlanMode hold: a real tool-permission frame carrying the master decomposition,
    // whose body has two Sub-Plan headers so SUBPLANS_PARSED materializes the ledger.
    const masterPlan =
      "# Master Plan\n\n### Sub-Plan 01: First\nscope\n\n### Sub-Plan 02: Second\nscope\n";
    await h.ingestPermission(exitPlanModeReq("master-tu", masterPlan));

    // CONTRACT: the FIRST writeAgentPlan call is the master — nn === null, the run's treeId. FALSIFY:
    // if the driver passed an nn (or a different treeId) for the master, OR if the master went through
    // the generic no-args write, this exact-args assertion goes RED.
    expect(rec.writeAgentPlan[0]).toEqual({ plan: masterPlan, treeId, nn: null });
    expect(rootPhase(h)).toBe("open/awaiting-decomposition-approval");

    // Approve the decomposition → the stashed children materialize (gen-2: parsed children live in
    // a transient stash while the gate is held; the open→split replacement happens at approval) and
    // child 01 enters recon. The recon prompt is DEFERRED until the approval-resumed turn's result
    // arrives; then finish child 01's recon so it is leaf/drafting and a LEAF ExitPlanMode hold is
    // recognized for path [1].
    await h.approve(""); // root decomposition gate (pathKey "")
    expect(childNns(h)).toEqual([1, 2]);
    expect(activeKey(h)).toBe("01");
    await h.ingestStream(resultFrame()); // the resume turn's result → deferred sub-recon send
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    expect(childPhase(h, 1)).toBe("leaf/drafting");

    // The SUB ExitPlanMode hold for nn=1.
    const subPlan = "# Sub-Plan 01\n\nthe sub body\n";
    await h.ingestPermission(exitPlanModeReq("sub1-tu", subPlan));

    // CONTRACT: the SUB write carries nn === "01" (the dotted PathKey string — Phase-2 wire) and
    // the SAME treeId as the master. FALSIFY: a mistagged sub (different treeId, or nn null) would
    // be classified as a master by the backend → RED here.
    const subWrite = rec.writeAgentPlan.find((w) => w.nn === "01");
    expect(subWrite).toEqual({ plan: subPlan, treeId, nn: "01" });

    // Exactly ONE master write (nn===null) and ONE write for nn==="01" — no duplicate sub write.
    expect(rec.writeAgentPlan.filter((w) => w.nn === null)).toHaveLength(1);
    expect(rec.writeAgentPlan.filter((w) => w.nn === "01")).toHaveLength(1);
    // Every write shares the one minted treeId (a master+subs of ONE tree the sidebar can nest).
    for (const w of rec.writeAgentPlan) expect(w.treeId).toBe(treeId);

    await h.cancel();
  });
});

describe("orchestrator — TWO-OUTCOME sizer: unknown decisions coerce to split", () => {
  it("a literal `escalate` sizer decision coerces to split (loudly): master-draft sent, run NOT ended", async () => {
    vi.mocked(diag).mockClear();
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below

    // recon completes.
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());

    // sizer turn: a STALE `escalate` decision (the prompt no longer offers it), then result.
    await h.ingestStream(
      textFrame("SIZER: escalate / 0 / 0.3\nTell me which database to target."),
    );
    await h.ingestStream(resultFrame());

    // COERCED to split: phase is `decomposing`, a synthetic split outcome is recorded, and the
    // master-draft prompt was sent.
    // FALSIFIED 2026-06-10: temporarily restored an escalate branch mapping (unparseable decision
    // → FATAL instead of the split coercion) → all three assertions went RED; restored → GREEN.
    expect(rootPhase(h)).toBe("open/decomposing");
    // (Schema 2 stores no sizer field — the coerced split is observable via the decomposing arc +
    // the master-draft prompt below.)
    expect(rec.sendMessage.some((m) => m.includes("MASTER decomposition plan"))).toBe(true);

    // LOUD: the coercion is diag-logged to the dev terminal (not silent, not fatal).
    expect(
      vi.mocked(diag).mock.calls.some(([m]) => m.includes("COERCING to split")),
    ).toBe(true);

    // NOT terminal: no FATAL surfaced, the SDK session was NOT ended, the run continues.
    expect(fatal).toEqual([]);
    expect(rec.cancelRun).toBe(0);
    expect(rec.endSession).toBe(0);
    expect(isOrchestrationActive()).toBe(true);
    expect(h.orchestrationActive()).toBe(true);

    await h.cancel();
  });

  it("an unparseable sizer turn (no SIZER line at all) coerces to split, never FATAL", async () => {
    vi.mocked(diag).mockClear();
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below

    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());

    // sizer turn emits prose with NO parseable SIZER line.
    await h.ingestStream(textFrame("I could not really size this request."));
    await h.ingestStream(resultFrame());

    // FALSIFIED 2026-06-10: restored the old FATAL("plan-sizer emitted no SIZER decision line")
    // branch → fatal captured the message + phase stayed `sizing` → RED; restored → GREEN.
    expect(fatal).toEqual([]);
    expect(rootPhase(h)).toBe("open/decomposing");
    // (Schema 2 stores no sizer field — the coerced split is observable via the decomposing arc +
    // the master-draft prompt below.)
    expect(rec.sendMessage.some((m) => m.includes("MASTER decomposition plan"))).toBe(true);
    expect(
      vi.mocked(diag).mock.calls.some(([m]) => m.includes("COERCING to split")),
    ).toBe(true);

    await h.cancel();
  });
});

describe("orchestrator — ingest frame throw drives a visible fatal terminal state", () => {
  it("a thrown ingest frame surfaces FATAL and deactivates instead of stalling silently", async () => {
    const { deps } = makeDeps();
    // writePlanTreeFile works during start() (the START persist), then is armed to throw — so the
    // throw happens INSIDE a queued ingest frame (RECON_DONE's persist), not at start.
    let breakWrites = false;
    deps.writePlanTreeFile = vi.fn(async (_cwd, name) => {
      if (breakWrites) throw new Error("disk exploded");
      return `/abs/.plan-tree/${name}`;
    });
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });
    breakWrites = true;

    // The opening intent frame triggers INTENT_CLARIFIED → writePlanTreeFile throws inside the queued
    // frame (same FATAL-isolation behavior the recon write previously exercised).
    await h.ingestStream(textFrame("the confirmed intent", "agent-intent"));
    await h.ingestStream(resultFrame());

    // The run was driven to a VISIBLE terminal fatal state (onFatal fired) and deactivated — it did
    // NOT silently stall. FALSIFY: revert enqueueIngest's .catch to console.error-only → no FATAL is
    // dispatched, fatal stays empty AND the run stays active → both asserts RED.
    expect(fatal.length).toBeGreaterThanOrEqual(1);
    expect(fatal[0]).toContain("ingest frame failed");
    expect(h.orchestrationActive()).toBe(false);
    expect(isOrchestrationActive()).toBe(false);
  });
});

describe("orchestrator — approval-resume swallow rule", () => {
  it("the post-approval resume result triggers NO *_DONE (it lands while pendingStep is disarmed)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    // Master gate.
    await h.ingestPermission(exitPlanModeReq("m", "### Sub-Plan 01: Only\nbody"));
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // the resume turn's result → deferred sub-01 recon send
    // sub 01 recon → draft → hold.
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    expect(childPhase(h, 1)).toBe("leaf/awaiting-approval");

    // Approve → reducer resolves the held ExitPlanMode (allow) + acceptEdits. The SDK resumes the
    // SAME turn to execute; arming "exec" is done inside approve().
    await h.approve("01");
    expect(childPhase(h, 1)).toBe("leaf/executing");

    // The EXEC-completion result fires (armed "exec") → EXEC_DONE + summary prompt.
    await h.ingestStream(resultFrame());
    expect(rec.sendMessage.at(-1)).toContain("## Changes");

    // Now the summary turn completes. THEN, crucially, simulate a spurious post-approval-resume
    // result that lands while pendingStep is null after summary advanced the (only) sub to done.
    await h.ingestStream(textFrame("## Changes\nx\n## Findings\ny\n## Next-step inputs\nz"));
    await h.ingestStream(resultFrame());
    expect(h.snapshot().done).toBe(true);

    // A stray, unarmed result after done must be SWALLOWED — no throw, no extra effect.
    const sendCountBefore = rec.sendMessage.length;
    await h.ingestStream(resultFrame());
    expect(rec.sendMessage.length).toBe(sendCountBefore);
    expect(h.snapshot().done).toBe(true);
  });

  it("FALSIFIABILITY: arming a step before the resume result double-advances (RED guard via direct dispatch absence)", async () => {
    // This documents the inverse: if the swallow rule were removed (a `result` acted unconditionally),
    // the post-approve resume `result` would be mistaken for EXEC_DONE *before* the real exec finished,
    // double-advancing. We assert the GUARDED behavior: after approve() arms exactly "exec", a SINGLE
    // result fires EXEC_DONE once (one summary prompt), not twice.
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");

    const summaryPromptsBefore = rec.sendMessage.filter((m) => m.includes("## Changes")).length;
    await h.ingestStream(resultFrame()); // exec completion
    const summaryPromptsAfter = rec.sendMessage.filter((m) => m.includes("## Changes")).length;
    // Exactly ONE summary prompt was sent off the single exec result.
    expect(summaryPromptsAfter - summaryPromptsBefore).toBe(1);

    await h.cancel();
  });
});

describe("orchestrator — deferred send: the next prompt WAITS for the resume turn's result", () => {
  // THE NO-GATE INCIDENT: resolving the held master ExitPlanMode (allow:true) makes the SDK RESUME
  // the SAME turn — with its canned "You can now start coding" injection. A prompt sent inline at
  // that moment is delivered as a QUEUED ATTACHMENT merged into that still-in-flight turn, so the
  // model implemented a whole sub-plan inside one turn with no gate. The fix: approveMaster sends
  // NOTHING — it arms `{tag:"resuming", nn}` (the deferred sub-recon step), then INTERRUPTS the
  // resumed turn (the live phase-1 incident: left alone, the "start coding" turn free-runs and
  // never yields a result — the watchdog FATALed and stranded the run). The interrupted turn's
  // aborted `result` consumes the hold and fires the deferred send. The resuming tag is the
  // disambiguator: that result can never be attributed to any other step.
  //
  // The POST-SUMMARY advance is DIFFERENT (audited against the real frame flow): the summary
  // turn's `result` is the terminal frame of an already-ended turn — nothing is in flight, so the
  // next sub-recon prompt is sent INLINE there (after the dispatch seam asserted "plan"), never
  // deferred (a deferred hold there waits for a result that can never come → watchdog FATAL at
  // every sub→sub transition — the second live phase-1 defect).

  async function driveToMasterGate(h: OrchestratorHandle, numSubs = 2): Promise<void> {
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame(`SIZER: split / ${numSubs} / 0.8`));
    await h.ingestStream(resultFrame());
    const headers =
      numSubs === 1
        ? "### Sub-Plan 01: First\nx"
        : "### Sub-Plan 01: First\nx\n### Sub-Plan 02: Second\ny";
    await h.ingestPermission(exitPlanModeReq("master-tu", headers));
  }

  it("approve(\"\") (decomposition): resolve → interrupt; NO sendMessage until the boundary result; then EXACTLY the child recon prompt", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);

    const sendsBefore = rec.sendMessage.length;
    const callsBefore = rec.calls.length;
    await h.approve(""); // root decomposition gate (pathKey "")

    // The master resolve + MASTER_APPROVED advance happened…
    expect(rec.resolvePermission.at(-1)).toMatchObject({ id: "master-tu", allow: true });
    expect(rootPhase(h)).toBe("split/running-children");
    expect(activeKey(h)).toBe("01");
    // …and the approval-resumed turn was INTERRUPTED, exactly once, AFTER the resolve (the resolve
    // is what resumes the turn; the interrupt cuts it before the model can act on "start coding").
    // FALSIFY: drop the deps.interrupt() call in the decomposition branch → rec.interrupt stays 0 → RED.
    expect(rec.interrupt).toBe(1);
    const gateCalls = rec.calls.slice(callsBefore);
    const iResolve = gateCalls.indexOf("resolvePermission:master-tu:true:");
    const iInterrupt = gateCalls.indexOf("interrupt");
    expect(iResolve).toBeGreaterThanOrEqual(0);
    expect(iInterrupt).toBeGreaterThan(iResolve);
    // …but NO prompt was sent: the approval-resumed master turn is STILL IN FLIGHT until its
    // (interrupt-aborted) result arrives, and an inline send here is merged into that turn (the
    // no-gate incident). FALSIFY: restore the inline `deps.sendMessage(subReconPrompt(...))` in
    // the decomposition-approve branch → a send exists here → RED.
    expect(rec.sendMessage.length).toBe(sendsBefore);

    // The interrupted turn's terminal `result` (the boundary frame) consumes the hold → EXACTLY
    // ONE new message: sub 01's recon prompt.
    await h.ingestStream(resultFrame());
    expect(rec.sendMessage.length).toBe(sendsBefore + 1);
    expect(rec.sendMessage.at(-1)).toContain("reconnaissance scoped to THIS sub-plan");
    expect(rec.sendMessage.at(-1)).toContain("sub-plan 01");

    // The deferred send armed sub-recon: its turn's result advances to drafting (not swallowed).
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    expect(childPhase(h, 1)).toBe("leaf/drafting");

    await h.cancel();
  });

  it("approve() (sub approval) does NOT interrupt — the approval-resumed turn IS the execution", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // the interrupt-boundary result → deferred sub-01 recon send
    expect(rec.interrupt).toBe(1); // the one master-approval interrupt

    // Sub 01: recon → draft → APPROVE. The SDK resumes the held turn to EXECUTE the sub-plan —
    // interrupting here would abort the user-approved execution itself.
    await h.ingestStream(textFrame("sub01 recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    expect(childPhase(h, 1)).toBe("leaf/executing");
    // FALSIFY: add a deps.interrupt() call inside approve() → this count becomes 2 → RED.
    expect(rec.interrupt).toBe(1);

    // requestChanges (leaf AND decomposition) never interrupts either (the deny resumes the turn to
    // RE-DRAFT — cutting it off would kill the re-draft).
    await h.ingestStream(resultFrame()); // exec completion → summary prompt
    expect(rec.interrupt).toBe(1);

    await h.cancel();
  });

  it("post-summary advance: the next sub-recon prompt fires INLINE off the summary result (no extra frame, no interrupt), after the plan-policy assert", async () => {
    // REAL FRAME FLOW (audited): the summary turn's `result` is the LAST frame the SDK emits — it
    // is then parked awaiting the next user message. NO further turn is in flight, so no further
    // `result` will EVER arrive. This test deliberately feeds ONLY that real sequence: a deferred
    // (resuming-style) advance here would hang forever and FATAL on the watchdog — exactly the
    // previous deadlock, which slipped through because the old test fabricated an extra result
    // frame the live flow never produces.
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // the interrupt-boundary result → deferred sub-01 recon send

    // Sub 01: recon → draft → approve → exec → summary text + result.
    await h.ingestStream(textFrame("sub01 recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    await h.ingestStream(resultFrame()); // exec completion → summary prompt
    await h.ingestStream(textFrame("## Changes\nbuilt the thing\n## Findings\nf\n## Next-step inputs\nn"));
    const callsBefore = rec.calls.length;
    const interruptsBefore = rec.interrupt;
    await h.ingestStream(resultFrame()); // summary result → SUMMARY_WRITTEN parks the root reviewing…

    // …PHASE 5: the parent-review prompt fires INLINE off that same frame (the root is reviewing;
    // sub 02 stays pending until the review turn ends). FALSIFY: restore the deferred
    // armResuming(nextNn) in the summary branch → no send lands here (and the run deadlocks) → RED.
    expect(activeKey(h)).toBe(""); // the reviewing ROOT is the active node
    const reviewSent = rec.sendMessage.at(-1)!;
    expect(reviewSent).toContain("Sub-plan 01 has completed");
    expect(reviewSent).toContain("built the thing"); // the child summary rides the review prompt

    // The review turn answers NONE → PARENT_REVIEW_DONE → sub 02's recon fires INLINE.
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());
    expect(activeKey(h)).toBe("02");
    const sent = rec.sendMessage.at(-1)!;
    expect(sent).toContain("reconnaissance scoped to THIS sub-plan");
    expect(sent).toContain("sub-plan 02");
    expect(sent).toContain("built the thing"); // threads sub 01's summary

    // Ordered within the advance window: the derived "plan" policy was asserted at the
    // SUMMARY_WRITTEN dispatch seam BEFORE the inline send — the recon turn can't start writable.
    const seq = rec.calls.slice(callsBefore);
    const iPlan = seq.indexOf("setMode:plan");
    const iSend = seq.findIndex(
      (c) => c.startsWith("sendMessage:") && c.includes("reconnaissance scoped to THIS sub-plan"),
    );
    expect(iPlan).toBeGreaterThanOrEqual(0);
    expect(iSend).toBeGreaterThan(iPlan);

    // And NO interrupt fired at this site — nothing is in flight to interrupt (the interrupt is
    // scoped to the master approval). FALSIFY: call deps.interrupt() in the summary branch → RED.
    expect(rec.interrupt).toBe(interruptsBefore);

    // The inline send armed sub-recon: sub 02's recon turn advances normally (not swallowed).
    await h.ingestStream(textFrame("sub02 recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    expect(childPhase(h, 2)).toBe("leaf/drafting");

    await h.cancel();
  });

  it("watchdog: a resuming hold whose result NEVER arrives surfaces a terminal FATAL (injected timer, no hang)", async () => {
    const { deps, rec } = makeDeps();
    const timers = installFakeTimers(deps);
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await driveToMasterGate(h);
    await h.approve(""); // root decomposition gate (pathKey "")

    // A single backstop watchdog is armed on the resuming hold (short — the hold is now
    // interrupt-bounded, so the watchdog only covers a lost/failed interrupt).
    const armed = timers.filter((t) => !t.cleared);
    expect(armed).toHaveLength(1);
    expect(armed[0].ms).toBe(30_000);

    // The resume result never arrives; the watchdog fires → a LOUD terminal error through the
    // notify/fatal path, never a silent hang. FALSIFY: drop the watchdog (or its FATAL dispatch) →
    // `fatal` stays empty and the run sits active forever → RED.
    armed[0].fn();
    await flush();
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain("resume watchdog");
    expect(fatal[0]).toContain("sub-plan 01");
    expect(h.orchestrationActive()).toBe(false);
    expect(isOrchestrationActive()).toBe(false);
    // The deferred sub-recon prompt was never sent for the dead hold.
    expect(rec.sendMessage.some((m) => m.includes("reconnaissance scoped to THIS sub-plan"))).toBe(false);
  });

  it("a boundary result arriving DURING the decomposition-approve awaits is NOT swallowed (armed before the first await; no watchdog FATAL)", async () => {
    // REAL ORDERING HAZARD (the start()/intent genesis-arm race, at the master gate): the
    // resolve_tool_permission round-trip yields to the event loop, and the interrupt/abort-boundary
    // `result` frame can reach ingestStream BEFORE the resolve (or the MASTER_APPROVED dispatch)
    // settles. If armResuming ran only AFTER those awaits, that result landed while awaiting was
    // idle and was SWALLOWED — the deferred sub-recon never fired and the 30s watchdog FATALed a
    // healthy run. The fake resolvePermission below injects the result frame mid-resolve.
    const { deps, rec } = makeDeps();
    const timers = installFakeTimers(deps);
    let h!: OrchestratorHandle;
    const originalResolve = deps.resolvePermission;
    deps.resolvePermission = vi.fn(async (args) => {
      // Deliver the boundary result INTO the ingest path before the master resolve settles.
      if (args.id === "master-tu" && args.allow) {
        await h.ingestStream(resultFrame());
      }
      await originalResolve(args);
    });
    h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await driveToMasterGate(h);

    await h.approve(""); // root decomposition gate (pathKey "")

    // The early result was CONSUMED by the resuming hold (armed synchronously BEFORE the first
    // await), so the deferred sub-01 recon prompt fired — with no further frames delivered.
    // FALSIFY: restore the old ordering (armResuming only after resolve + MASTER_APPROVED) → the
    // injected result lands while awaiting is idle and is swallowed → no recon send → RED.
    expect(rec.sendMessage.at(-1)).toContain("reconnaissance scoped to THIS sub-plan");
    expect(rec.sendMessage.at(-1)).toContain("sub-plan 01");
    // …and consuming the hold cleared the watchdog — no spurious 30s FATAL is pending (with the
    // old ordering the re-armed watchdog would sit on a hold whose result already passed → FATAL).
    expect(timers.every((t) => t.cleared)).toBe(true);
    expect(fatal).toHaveLength(0);

    // The deferred send armed sub-recon: the run still advances normally (not swallowed).
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    expect(childPhase(h, 1)).toBe("leaf/drafting");

    await h.cancel();
  });

  it("the resume result CLEARS the watchdog (a late fire is impossible — no false fatal)", async () => {
    const { deps } = makeDeps();
    const timers = installFakeTimers(deps);
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await driveToMasterGate(h);
    await h.approve(""); // root decomposition gate (pathKey "")
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);

    // The resume result consumes the hold → the watchdog handle is cleared.
    await h.ingestStream(resultFrame());
    expect(timers.every((t) => t.cleared)).toBe(true);
    expect(fatal).toHaveLength(0);

    await h.cancel();
  });
});

describe("orchestrator — pendingStep must be armed BEFORE sendMessage resolves", () => {
  // REAL ORDERING HAZARD: `send_agent_message` (the Rust command) writes a line to the sidecar
  // stdin queue and returns. In the live app, the `result` frame for the turn can be delivered to
  // the stream listener (and thus ingestStream) BEFORE — or as part of the same microtask flush as
  // — the `invoke("send_agent_message", …)` promise settling on the next prompt. If the driver arms
  // `pendingStep` only AFTER awaiting sendMessage, that result lands while pendingStep is null and is
  // SWALLOWED by the swallow rule — the phase never advances and the run halts (the minecraft bug:
  // scope-recon ran, then nothing; state.json stuck at the opening phase).
  //
  // The OPENING turn is now the intent turn (start() arms `intent` + sends the intentPrompt). This
  // test makes the intent-prompt sendMessage deliver the intent `result` frame as part of its own
  // resolution. The driver MUST have armed "intent" BEFORE that frame arrives. If it arms after the
  // await, the result is swallowed and the run stays stuck at clarifying-intent (the genesis-arm race).
  it("intent result delivered during sendMessage resolution still advances past intent (no swallow)", async () => {
    const { deps, rec } = makeDeps();

    // Wrap sendMessage so that the FIRST sendMessage (the intent prompt sent inside start()) delivers
    // the intent `result` frame to the orchestrator BEFORE it resolves — simulating the invoke
    // settling only after the turn's result already reached the listener.
    let h!: OrchestratorHandle;
    let firstSend = true;
    const originalSend = deps.sendMessage;
    deps.sendMessage = vi.fn(async (text: string) => {
      await originalSend(text);
      if (firstSend) {
        firstSend = false;
        // The agent's intent turn already finished: its assistant text + result arrive here, while the
        // caller (start) is still awaiting this very sendMessage — i.e. pendingStep is whatever the
        // driver armed BEFORE the await. Correct code armed "intent"; buggy code armed nothing yet.
        await h.ingestStream(textFrame("the confirmed intent", "agent-intent"));
        await h.ingestStream(resultFrame());
      }
    });

    h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    // The intent result was NOT swallowed: INTENT_CLARIFIED dispatched, phase advanced to recon, and the
    // recon (scope-recon) prompt was sent. With pendingStep armed AFTER the await, this is RED (phase
    // stays "clarifying-intent", no recon prompt — the genesis-arm halt analog of the minecraft bug).
    expect(rootPhase(h)).toBe("open/recon");
    expect(rec.sendMessage.some((m) => m.includes("scope-recon"))).toBe(true);

    await h.cancel();
  });
});

describe("orchestrator — single authoritative plan write", () => {
  it("ingestPermission(ExitPlanMode) for a drafting sub writes the plan exactly once; gate.planPath === returned path", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, awaiting } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());

    const writesBefore = rec.writeAgentPlan.length;
    await h.ingestPermission(exitPlanModeReq("sub-1", "the sub plan body"));

    // Exactly ONE physical write for this sub (the reducer's effect no-ops via wrotePlanForNn).
    // FALSIFY: drop the wrotePlanForNn no-op in runEffect -> count becomes 2 -> RED.
    expect(rec.writeAgentPlan.length - writesBefore).toBe(1);
    const w = rec.writeAgentPlan.at(-1)!;
    // ROOT-SINGLE: this run's sole plan is the root single-collapse child — NO master file will
    // ever exist for the tree, so the write carries nn = null (Rust stamps the root-level flavor
    // and the record keeps its tree_id; a dotted nn here minted an orphan flavor:sub the Rust
    // arranger demoted to a standalone with tree_id NULLED, so the live sidebar placeholder never
    // ceded). FALSIFY: replace isRootCollapseChild(...) ? null : pathKey(path) with pathKey(path)
    // at the leaf write site -> nn === "01" -> RED. (Confirmed red 2026-06-12.)
    expect(w.nn).toBe(null);
    expect(w.plan).toBe("the sub plan body");

    // The gate's planPath equals the path the single write returned (fake returns /abs/plans/<nn>.md).
    expect(h.snapshot().pendingApproval?.planPath).toBe("/abs/plans/null.md");
    expect(awaiting.at(-1)).toEqual({ key: "01", kind: "leaf", toolUseId: "sub-1" });

    await h.cancel();
  });
});

describe("orchestrator — master decomposition gate", () => {
  async function driveToMasterGate(h: OrchestratorHandle) {
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("master-tu", "### Sub-Plan 01: First\nbody\n### Sub-Plan 02: Second\nmore"),
    );
  }

  it("parses sub-plan headers, drafts the master, and surfaces the master gate with phase awaiting-approval", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, awaiting } = makeObserver();
    h.subscribe(obs);
    await driveToMasterGate(h);

    // CHILDREN_PARSED stashed 2 children from the headers (gen-2: the stash is transient until the
    // gate resolves — the root deliberately STAYS open while the gate is held, so the children are
    // observable in the tree only AFTER approval; see the approve test below for that half).
    // DECOMPOSITION_DRAFTED moved the root to awaiting-decomposition-approval and holds the
    // UNIFIED gate (kind decomposition, path "") in pendingApproval.
    expect(rootPhase(h)).toBe("open/awaiting-decomposition-approval");
    expect(h.snapshot().pendingApproval).toMatchObject({ kind: "decomposition", toolUseId: "master-tu" });
    // The master plan was written once (flavor master: nn === null).
    const masterWrite = rec.writeAgentPlan.find((w) => w.nn === null);
    expect(masterWrite).toBeDefined();
    // onAwaitingApproval fired with the master sentinel nn and the held master tool id + written path.
    expect(awaiting.at(-1)).toEqual({ key: "", kind: "decomposition", toolUseId: "master-tu" });
    expect(activeKey(h)).toBe(""); // the gated ROOT is the active node (no child activated yet)

    await h.cancel();
  });

  it("approve(\"\") resolves the master id (allow), advances to running-children/child 01, defers the child recon to the resume result; never the leaf branch", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);

    await h.approve(""); // root decomposition gate (pathKey "")

    // Resolved the held MASTER ExitPlanMode with allow=true (no message, no feedback).
    expect(rec.resolvePermission.at(-1)).toMatchObject({ id: "master-tu", allow: true });
    // Advanced to running with pointer 0. The sub 01 recon prompt is NOT sent yet — the approval-
    // resumed turn is still in flight, so the send is deferred to its result (the merged-turn fix).
    expect(rootPhase(h)).toBe("split/running-children");
    expect(activeKey(h)).toBe("01");
    expect(rec.sendMessage.at(-1)).not.toContain("reconnaissance scoped to THIS sub-plan");
    // The resume turn's result fires the deferred sub 01 recon prompt.
    await h.ingestStream(resultFrame());
    expect(rec.sendMessage.at(-1)).toContain("reconnaissance scoped to THIS sub-plan");
    // The phase went via MASTER_APPROVED, never APPROVE (which would throw at pointer -1). If APPROVE
    // had been dispatched at the gate it would have thrown; reaching running proves it did not.

    await h.cancel();
  });

  it("requestChanges(\"\", …) denies with feedback, does NOT advance to running-children, sends NOTHING (deny-resumed turn re-drafts)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);

    const sendsBefore = rec.sendMessage.length;
    await h.requestChanges("", "split it differently");

    // Denied with the feedback message.
    expect(rec.resolvePermission.at(-1)).toMatchObject({
      id: "master-tu",
      allow: false,
      message: "split it differently",
    });
    // Did NOT advance to running-children (the root is still pre-execution). GEN-2 DELTA (intent
    // preserved, resting phase refined): DECOMPOSITION_CHANGES_REQUESTED is a first-class reducer
    // event that moves the node BACK to open/decomposing for the same-turn redraft (gen-1 had no
    // event and rested at awaiting-approval). FALSIFY: dispatch DECOMPOSITION_APPROVED in the
    // decomposition branch of requestChanges -> the root becomes split/running-children -> RED.
    expect(rootPhase(h)).toBe("open/decomposing");
    expect(activeKey(h)).toBe(""); // the ROOT is still the active node (no child activated)
    // NO message was sent — symmetric with the per-sub requestChanges: the SDK feeds the deny
    // reason back to the model as the tool error and RESUMES THE SAME TURN to re-draft; an inline
    // send here would be merged into that still-in-flight turn (the same hazard the decomposition-
    // approve branch's no-inline-send rule defers around). FALSIFY: re-add an inline
    // masterDraftPrompt sendMessage in the decomposition deny branch → a send lands here → RED.
    expect(rec.sendMessage.length).toBe(sendsBefore);

    // The re-draft's ExitPlanMode is STILL routed as the master gate (not mistaken for a sub draft).
    await h.ingestPermission(exitPlanModeReq("master-tu-2", "### Sub-Plan 01: Redo\nz"));
    expect(rootPhase(h)).toBe("open/awaiting-decomposition-approval");
    expect(activeKey(h)).toBe(""); // the gated ROOT is the active node (no child activated yet)

    await h.cancel();
  });
});

describe("orchestrator — derived write policy (mode is a pure function of the ledger)", () => {
  // THE POST-MASTER-APPROVAL INCIDENT: approving the master ExitPlanMode (allow) flips the SDK out
  // of plan mode, but the planning phases (sub recon/draft) follow — the session sat WRITABLE for a
  // whole turn because the only re-arm was the imperative setMode("plan") at the sub-recon result.
  // The fix: the driver asserts writePolicyFor(state) after EVERY transition, so the mode is
  // corrected at the MASTER_APPROVED dispatch itself — BEFORE the sub-recon prompt is sent.
  async function driveToMasterGate(h: OrchestratorHandle) {
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("master-tu", "### Sub-Plan 01: First\nx\n### Sub-Plan 02: Second\ny"),
    );
  }

  it("approve(\"\") (decomposition) asserts setMode('plan') AFTER the master resolve and BEFORE the child recon prompt", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);

    const gateStart = rec.calls.length;
    await h.approve(""); // root decomposition gate (pathKey "")
    // The sub-recon send is deferred to the approval-resumed turn's result (the merged-turn fix);
    // include that boundary in the window so the ordering is asserted across the whole gate.
    await h.ingestStream(resultFrame());
    const seq = rec.calls.slice(gateStart);

    const iResolve = seq.indexOf("resolvePermission:master-tu:true:");
    const iPlan = seq.indexOf("setMode:plan");
    const iSubRecon = seq.findIndex(
      (c) => c.startsWith("sendMessage:") && c.includes("reconnaissance scoped to THIS sub-plan"),
    );

    // The plan-mode re-assert happened, AFTER the resolve (which is what flipped the SDK out of plan
    // mode) and BEFORE the sub-recon send — so the sub planning turn can NEVER start writable.
    // FALSIFY: revert to the old imperative scheme (re-arm only at the sub-recon result) → no
    // setMode:plan exists inside this approveMaster window → iPlan === -1 → RED.
    expect(iResolve).toBeGreaterThanOrEqual(0);
    expect(iPlan).toBeGreaterThan(iResolve);
    expect(iSubRecon).toBeGreaterThan(iPlan);

    await h.cancel();
  });

  it("the derivation is idempotent: no redundant setMode at the sub-recon result; acceptEdits only at APPROVE", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // the resume turn's result → deferred sub-recon send

    // TWO plan-asserts so far — the INTENT_CLARIFIED boundary (genesis "prototype" → "plan") and
    // the gate (the allow resolve nulls the cache); the sub-recon result (the OLD imperative
    // re-arm site) must NOT re-assert it — the derived policy is unchanged there.
    const planAsserts = () => rec.setMode.filter((m) => m === "plan").length;
    expect(planAsserts()).toBe(2);
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    // FALSIFY: keep the old unconditional setMode("plan") in the sub-recon branch → count becomes 3 → RED.
    expect(planAsserts()).toBe(2);

    // Approving the sub draft flips the derived policy to acceptEdits.
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    expect(rec.setMode.at(-1)).not.toBe("acceptEdits"); // not writable while awaiting approval
    await h.approve("01");
    expect(rec.setMode.at(-1)).toBe("acceptEdits");

    await h.cancel();
  });

  it("after a sub's summary, setMode('plan') is asserted BEFORE the next sub's recon prompt (not one turn late)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await driveToMasterGate(h);
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // the resume turn's result → deferred sub-01 recon send

    // Sub 01: recon → draft → approve → exec → summary.
    await h.ingestStream(textFrame("sub01 recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    expect(rec.setMode.at(-1)).toBe("acceptEdits");
    await h.ingestStream(resultFrame()); // exec completion → summary prompt
    const boundary = rec.calls.length;
    await h.ingestStream(textFrame("## Changes\nx\n## Findings\ny\n## Next-step inputs\nz"));
    await h.ingestStream(resultFrame()); // summary → SUMMARY_WRITTEN → root reviewing + review prompt
    // PHASE 5: the parent-review turn sits between the siblings; NONE → INLINE sub-02 recon send.
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());

    // Within the advance window: the plan-mode re-assert lands BEFORE sub 02's recon prompt, so
    // sub 02's ENTIRE planning phase (recon included) runs in plan mode. FALSIFY: re-arm only at the
    // sub-recon result (the old one-turn-late scheme) → no setMode:plan before the send → RED.
    const seq = rec.calls.slice(boundary);
    const iPlan = seq.indexOf("setMode:plan");
    const iSub02Recon = seq.findIndex(
      (c) => c.startsWith("sendMessage:") && c.includes("reconnaissance scoped to THIS sub-plan"),
    );
    expect(iPlan).toBeGreaterThanOrEqual(0);
    expect(iSub02Recon).toBeGreaterThan(iPlan);

    await h.cancel();
  });
});

describe("orchestrator — clarify reshape (CLARIFY_ANSWERED → updatedInput)", () => {
  const questions = {
    questions: [
      {
        question: "Which database?",
        header: "DB",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
        multiSelect: false,
      },
    ],
  };

  it("answerClarify resolves with updatedInput:{questions, answers} (populated, no raw message)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });

    await h.ingestPermission(askUserQuestionReq("q-1", questions));
    expect(h.snapshot().pendingClarify?.toolUseId).toBe("q-1");

    await h.answerClarify("q-1", { "Which database?": "Postgres" });

    const resolved = rec.resolvePermission.at(-1)!;
    expect(resolved.id).toBe("q-1");
    expect(resolved.allow).toBe(true);
    // The raw JSON message is DROPPED; updatedInput carries the original questions + the answers.
    // FALSIFY: drop the clarifyQuestions retain (pass empty questions) -> questions:[] -> RED.
    expect(resolved.message).toBeUndefined();
    expect(resolved.updatedInput).toEqual({
      questions: questions.questions,
      answers: { "Which database?": "Postgres" },
    });

    await h.cancel();
  });
});

describe("orchestrator — summary threading", () => {
  it("sub 02's recon prompt contains sub 01's summary text", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("m", "### Sub-Plan 01: First\nx\n### Sub-Plan 02: Second\ny"),
    );
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // the resume turn's result → deferred sub-01 recon send

    // ---- sub 01: recon → draft → approve → exec → summary ----
    await h.ingestStream(textFrame("sub01 recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    await h.ingestStream(resultFrame()); // exec completion → summary prompt + arm summary
    const SUB01_SUMMARY = "## Changes\nbuilt the thing for sub01\n## Findings\nok\n## Next-step inputs\nuse X";
    await h.ingestStream(textFrame(SUB01_SUMMARY));
    await h.ingestStream(resultFrame()); // summary turn completes → SUMMARY_WRITTEN + review prompt
    // PHASE 5: the parent-review turn sits between the siblings; NONE → INLINE sub-02 recon send.
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());

    // The run advanced to sub 02 and a sub-recon prompt for it was just sent.
    expect(activeKey(h)).toBe("02");
    const sub02ReconPrompt = rec.sendMessage.at(-1)!;
    expect(sub02ReconPrompt).toContain("reconnaissance scoped to THIS sub-plan");
    // It threads sub 01's summary forward. FALSIFY: stop populating `summaries` -> RED here.
    expect(sub02ReconPrompt).toContain("built the thing for sub01");

    await h.cancel();
  });
});

// ============================================================================================
// PHASE 1 — characterization tests pinning CURRENT correct behavior that a later refactor touches.
//
// These pin the ORDER of side-effects (not just end-state) across the approval gates, plus one
// documented buggy-but-real observable (T1.5) that a later phase will intentionally fix. They MUST
// pass against UNMODIFIED orchestrator.ts / plan-tree.ts.
//
// ARM-BEFORE-AWAIT RACE ORACLE: the existing regression test at orchestrator.test.ts:617-661
// ("recon result delivered during sendMessage resolution still advances past recon (no swallow)")
// is the canonical guard that the driver arms `pendingStep` BEFORE awaiting `sendMessage`. A later
// refactor of this Phase-1 surface MUST keep that test green — do NOT duplicate it here (T1.4).
// ============================================================================================

describe("orchestrator — PHASE 1: sub-plan change-request round trip (ordered trace)", () => {
  // T1.1 — drive a SPLIT run to a held sub-plan gate, then exercise the full
  // REQUEST_CHANGES → SUB_DRAFTED → APPROVE → exec-result cycle and assert the ORDERED rec.calls
  // trace: deny-resolve BEFORE re-draft notifyAwaitingApproval BEFORE approve-resolve + acceptEdits
  // BEFORE exactly one `## Changes` summary prompt off the post-approve result frame.
  it("orders deny-resolve → re-draft await → approve-resolve+acceptEdits → one summary prompt", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, awaiting } = makeObserver();
    h.subscribe(obs);

    // Drive a SPLIT run to a held sub-01 gate via scripted frames (the live path: master gate then
    // approve("") then child-01 recon → draft → hold).
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("master-tu", "### Sub-Plan 01: First\nx\n### Sub-Plan 02: Second\ny"),
    );
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // the resume turn's result → deferred sub-01 recon send
    await h.ingestStream(textFrame("sub01 recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1a", "first draft"));
    expect(childPhase(h, 1)).toBe("leaf/awaiting-approval");

    // Snapshot the trace boundary so we assert ORDER within the change-request cycle only.
    const cycleStart = rec.calls.length;

    // REQUEST_CHANGES: deny the held permission with feedback; pointer stays put (re-draft in place).
    await h.requestChanges("01", "needs more detail");
    expect(activeKey(h)).toBe("01"); // pointer NOT advanced by requestChanges

    // Re-draft holds a fresh ExitPlanMode → notifyAwaitingApproval for sub-1b.
    await h.ingestPermission(exitPlanModeReq("sub-1b", "second draft"));

    // The user-facing re-draft hold actually fired: the observer's awaiting surface now ends with the
    // re-drafted sub gate (same shape the first-draft test at :689 asserts). This proves the re-draft
    // gate surfaced directly, not merely that a plan write landed (the indirect proxy below).
    // FALSIFY: stop the re-draft from firing (e.g. don't notifyAwaitingApproval on SUB_DRAFTED) ->
    // awaiting.at(-1) stays the first-draft {sub-1a} gate -> RED.
    expect(awaiting.at(-1)).toEqual({ key: "01", kind: "leaf", toolUseId: "sub-1b" });

    // APPROVE the re-draft: resolve allow + acceptEdits; arms exec.
    await h.approve("01");
    expect(childPhase(h, 1)).toBe("leaf/executing");

    // The post-approve exec-completion result fires → exactly one summary prompt.
    await h.ingestStream(resultFrame());

    // The ORDERED trace within the cycle.
    const cycle = rec.calls.slice(cycleStart);
    const iDeny = cycle.indexOf("resolvePermission:sub-1a:false:needs more detail");
    // The re-draft hold surfaces via notifyAwaitingApproval, which does not push to rec.calls; the
    // re-draft's single physical plan write (writeAgentPlan) is the observable that occurs in its
    // place. Use it as the re-draft boundary marker.
    const iRedraftWrite = cycle.findIndex((c, k) => k > iDeny && c.startsWith("writeAgentPlan:"));
    const iApprove = cycle.indexOf("resolvePermission:sub-1b:true:");
    const iAcceptEdits = cycle.indexOf("setMode:acceptEdits");
    const iSummary = cycle.findIndex((c) => c.startsWith("sendMessage:") && c.includes("## Changes"));

    // deny-resolve happened.
    expect(iDeny).toBeGreaterThanOrEqual(0);
    // re-draft write occurred AFTER the deny (FALSIFY: advance the pointer in REQUEST_CHANGES so the
    // re-draft targets the wrong/absent sub, or arm exec instead of idle after redraft — the ordering
    // collapses and these indices go out of order -> RED).
    expect(iRedraftWrite).toBeGreaterThan(iDeny);
    // approve-resolve + acceptEdits occurred AFTER the re-draft write.
    expect(iApprove).toBeGreaterThan(iRedraftWrite);
    expect(iAcceptEdits).toBeGreaterThan(iRedraftWrite);
    // the single summary prompt occurred AFTER the approve-resolve (it is sent off the exec result).
    expect(iSummary).toBeGreaterThan(iApprove);
    expect(iSummary).toBeGreaterThan(iAcceptEdits);

    // EXACTLY ONE `## Changes` summary prompt was sent in the whole cycle.
    expect(cycle.filter((c) => c.startsWith("sendMessage:") && c.includes("## Changes")).length).toBe(
      1,
    );

    await h.cancel();
  });
});

describe("orchestrator — PHASE 1: decomposition gate → approve(\"\") → first-child routing SEQUENCE", () => {
  // T1.3 — from a held master gate, assert the ORDER (not just the end state, which :731-748 covers):
  // approve("") resolves {id:"master-tu", allow:true} BEFORE the first child recon sendMessage, and
  // NO APPROVE was dispatched (reaching running/sub-recon proves it — APPROVE at pointer -1 throws).
  it("resolves the master id BEFORE the first sub-recon prompt; never dispatches APPROVE", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("master-tu", "### Sub-Plan 01: First\nx\n### Sub-Plan 02: Second\ny"),
    );
    expect(rootPhase(h)).toBe("open/awaiting-decomposition-approval");
    expect(activeKey(h)).toBe(""); // the gated ROOT is the active node (no child activated yet)

    const gateStart = rec.calls.length;
    await h.approve(""); // root decomposition gate (pathKey "")
    // The sub-recon send is deferred to the approval-resumed turn's result (the merged-turn fix);
    // deliver it so the whole gate window — resolve → [resume result] → recon prompt — is in scope.
    await h.ingestStream(resultFrame());
    const seq = rec.calls.slice(gateStart);

    const iResolve = seq.indexOf("resolvePermission:master-tu:true:");
    const iSubRecon = seq.findIndex(
      (c) => c.startsWith("sendMessage:") && c.includes("reconnaissance scoped to THIS sub-plan"),
    );

    expect(iResolve).toBeGreaterThanOrEqual(0);
    expect(iSubRecon).toBeGreaterThanOrEqual(0);
    // The master id was resolved (allow) BEFORE the first sub-recon prompt was sent. FALSIFY: send the
    // sub-recon prompt before resolving the master id -> iResolve > iSubRecon -> RED.
    expect(iResolve).toBeLessThan(iSubRecon);

    // The run reached running / pointer 0 via MASTER_APPROVED — NOT APPROVE. Dispatching APPROVE at
    // pointer -1 throws in the reducer; reaching this state proves APPROVE was never dispatched.
    expect(rootPhase(h)).toBe("split/running-children");
    expect(activeKey(h)).toBe("01");

    await h.cancel();
  });
});

describe("orchestrator — PHASE 2: re-arm null-nn falls back to idle", () => {
  // After the LAST sub's summary, the reducer advances the master to `done` (pointer past the end),
  // so the summary branch's next-sub re-arm finds NO pointed sub. Under the union, that re-arm site
  // captures `pointedNn()` AT ARM TIME and, being null, leaves `awaiting = {tag:"idle"}` rather than
  // arming a `sub-recon` variant with a bogus nn. The observable: a subsequent stray `result` (the
  // post-done resume turn) is SWALLOWED — no further *_DONE, no send, no throw.
  //
  // FALSIFY: arm a `sub-recon` with a bogus nn (e.g. the just-finished sub's nn) at this site instead
  // of idle → the next stray `result` mis-dispatches SUB_RECON_DONE against the wrong/absent pointed
  // sub → it throws in requirePointer (or sends a spurious sub-recon prompt) → this test goes RED.
  it("the final summary leaves the sequencer idle so a stray post-done result is swallowed", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    await h.ingestStream(resultFrame()); // exec → summary prompt (arms summary)
    await h.ingestStream(textFrame("## Changes\nx\n## Findings\ny\n## Next-step inputs\nz"));
    await h.ingestStream(resultFrame()); // summary → SUMMARY_WRITTEN → done; re-arm site finds null nn

    expect(h.snapshot().done).toBe(true);

    // A stray post-done result must be swallowed — armed `idle`, not a bogus `sub-recon`. If a bogus
    // nn had been armed, this result would mis-dispatch SUB_RECON_DONE and throw / send a prompt.
    const sendCountBefore = rec.sendMessage.length;
    await expect(h.ingestStream(resultFrame())).resolves.toBeUndefined();
    expect(rec.sendMessage.length).toBe(sendCountBefore);
    expect(h.snapshot().done).toBe(true);
  });
});

describe("orchestrator — PHASE 2: exec→summary buffer isolation (REALIZED fix)", () => {
  // T1.5 — REALIZED PHASE 2 FIX. Under the `Awaiting` union, the `exec` variant carries its OWN
  // buffer:"" (unread by design) and the `summary` variant gets a FRESH per-variant buffer:"" at arm
  // time. So assistant_text emitted DURING execution (before the exec result) appends to the exec
  // variant's buffer and is DROPPED at the exec→summary boundary — it can NEVER prepend onto the
  // summary capture. (Pre-refactor, a single shared assistantBuffer was never cleared at the exec
  // boundary, so exec chatter leaked into the next summary; this test pinned that buggy observable and
  // is now updated to assert the CLEAN one.) We assert the written summary file contains ONLY the real
  // summary text, with the exec-phase chatter absent.
  it("summary capture DROPS exec-phase assistant_text (clean summary, no carry-over)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    // Single-plan run to a held sub-01 gate, then approve to arm exec.
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h); // intent turn first (now opens every run), then recon below
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01"); // arms exec
    expect(childPhase(h, 1)).toBe("leaf/executing");

    // assistant_text emitted DURING execution (before the exec result). It appends to the exec
    // variant's own buffer (unread by design), which is discarded at the exec→summary boundary.
    const EXEC_CHATTER = "EXEC-PHASE-CHATTER: editing files now";
    await h.ingestStream(textFrame(EXEC_CHATTER));
    // The exec-completion result → EXEC_DONE + summary prompt (arms a FRESH summary variant, buffer:"").
    await h.ingestStream(resultFrame());
    expect(rec.sendMessage.at(-1)).toContain("## Changes");

    // The real summary text, then the summary result.
    const SUMMARY_TEXT = "## Changes\nthe real summary\n## Findings\nf\n## Next-step inputs\nn";
    await h.ingestStream(textFrame(SUMMARY_TEXT));
    await h.ingestStream(resultFrame());

    // The single-plan run completed; the DRIVER physically wrote NN-summary.md with the captured
    // summary text (SUMMARY_WRITTEN carries the write's returned PATH — the text-as-path shape is
    // now uncompilable). We assert the WRITTEN summary file contains ONLY the real summary text —
    // the exec-phase chatter is GONE (the realized Phase 2 fix: per-variant buffers isolate the
    // exec phase from the summary capture).
    const summaryWrite = rec.writePlanTreeFile.find((w) => w.name === "01-summary.md");
    expect(summaryWrite).toBeDefined();
    const captured = summaryWrite!.contents;
    // The exec chatter is ABSENT; only the real summary survives. FALSIFY: thread the exec variant's
    // buffer into the summary variant (instead of buffer:"") and the chatter reappears -> RED.
    expect(captured).not.toContain(EXEC_CHATTER);
    expect(captured).toContain("the real summary");
    // The captured summary is EXACTLY the real summary text (no prepended chatter, no leading newline).
    expect(captured).toBe(SUMMARY_TEXT);

    expect(h.snapshot().done).toBe(true);
  });
});

// ============================================================================================
// PHASE 3 — primitive-obsession eliminations: branded summary path (driver-side write), Nn range
// validation, structured Mandate prompts, sizer decomposition bias, and updated_ms stamping.
// ============================================================================================

describe("orchestrator — PHASE 3: onSummaryWritten carries the written FILE's path, never the text", () => {
  it("observers receive the write's returned path; the recorded write's contents === summaryText", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, summaries } = makeObserver();
    h.subscribe(obs);

    // Single-plan run to the summary boundary (live frames — the driver's own write seam).
    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("sub recon"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub-1", "sub 1 plan"));
    await h.approve("01");
    await h.ingestStream(resultFrame()); // exec completion → summary prompt
    const SUMMARY_TEXT = "## Changes\nreal summary body\n## Findings\nf\n## Next-step inputs\nn";
    await h.ingestStream(textFrame(SUMMARY_TEXT));
    await h.ingestStream(resultFrame()); // summary result → driver writes 01-summary.md, then SUMMARY_WRITTEN

    // The driver PHYSICALLY wrote the summary file with the summary TEXT as contents…
    const write = rec.writePlanTreeFile.find((w) => w.name === "01-summary.md");
    expect(write).toBeDefined();
    expect(write!.contents).toBe(SUMMARY_TEXT);

    // …and the observer received the write's RETURNED PATH (the fake returns /abs/.plan-tree/<name>),
    // NEVER the summary text (the old text-as-path bug). FALSIFY: re-introduce text-as-path in the
    // summary branch (dispatch summaryText as summaryPath via a cast) → summaryPath here becomes the
    // markdown body → both assertions go RED.
    expect(summaries).toEqual([{ key: "01", summaryPath: "/abs/.plan-tree/01-summary.md" }]);
    expect(summaries[0].summaryPath).not.toBe(SUMMARY_TEXT);

    // The ledger recorded the same real path on the sub.
    expect(leafState(childOf(h, 1)).summaryPath).toBe("/abs/.plan-tree/01-summary.md");
    expect(h.snapshot().done).toBe(true);
  });
});

describe("orchestrator — PHASE 3: nn > 99 is a LOUD master-plan validation failure, not truncation", () => {
  it("parseSubPlanHeaders accepts 1-99 and throws (naming the header) on Sub-Plan 100", () => {
    // In-range headers parse with their section bodies (no silent drop).
    const ok = parseSubPlanHeaders("intro\n### Sub-Plan 01: A\na body\n### Sub-Plan 99: Z\nz body");
    expect(ok.subplans.map((s) => s.nn)).toEqual([1, 99]);
    // FALSIFY: narrow the matcher to \d{1,2} (silent drop) or clamp the value → no throw → RED.
    expect(() => parseSubPlanHeaders("### Sub-Plan 100: Too Many\nbody")).toThrow(/Sub-Plan 100/);
  });

  it("a live master draft containing Sub-Plan 100 DENIES the held master permission for a redraft — never a FATAL, never a truncated ledger", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, fatal, awaiting } = makeObserver();
    h.subscribe(obs);

    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(
      exitPlanModeReq("master-tu", "### Sub-Plan 01: First\nx\n### Sub-Plan 100: Overflow\ny"),
    );
    await flush();

    // RECOVERABLE failure: the held master ExitPlanMode is resolved as DENY with the validation
    // message (the requestChanges deny mechanism), so the model redrafts a valid decomposition.
    // FALSIFY: revert the parse-site try/catch to propagate-only → the throw escapes to the ingest
    // queue's catch → FATAL fires, the run goes terminal, and no DENY is recorded → every
    // assertion below goes RED.
    expect(rec.resolvePermission).toHaveLength(1);
    expect(rec.resolvePermission[0].id).toBe("master-tu");
    expect(rec.resolvePermission[0].allow).toBe(false);
    expect(rec.resolvePermission[0].message).toContain("Sub-Plan 100");
    expect(rec.resolvePermission[0].message).toContain("1-99");
    // The run STAYS ACTIVE awaiting the redraft — no FATAL, no terminal.
    expect(fatal).toHaveLength(0);
    expect(h.orchestrationActive()).toBe(true);
    // NOT truncation: no partial child list was materialized (the root never left open/decomposing,
    // so no split exists), no decomposition gate surfaced.
    expect(h.snapshot().root.state.stage).toBe("open");
    expect(h.snapshot().pendingApproval).toBeNull();
    expect(awaiting).toHaveLength(0);
  });
});

describe("orchestrator — INV-2: a HEADER-LESS decomposition draft denies-for-redraft (typed, never FATAL, master not persisted)", () => {
  it("PlanValidationError class identity: parseSubPlanHeaders throws it for BOTH zero-header and nn>99", () => {
    // Zero `### Sub-Plan` headers is a validation failure of the SAME class as nn>99 — both are
    // recoverable redraft errors, discriminated by instanceof (not message string).
    // FALSIFY: leave parseSubPlanHeaders returning {subplans:[]} for zero-header (no throw) → RED;
    // make it throw a bare Error (not PlanValidationError) → the instanceof assertion goes RED.
    expect(() => parseSubPlanHeaders("just prose, no headers at all")).toThrow(PlanValidationError);
    expect(() => parseSubPlanHeaders("### Sub-Plan 100: Too Many\nbody")).toThrow(PlanValidationError);
    // And the in-range case still parses cleanly (no over-broad throw).
    const ok = parseSubPlanHeaders("### Sub-Plan 01: A\nbody");
    expect(ok.subplans.map((s) => s.nn)).toEqual([1]);
  });

  it("a live master draft with ZERO Sub-Plan headers → DENY for redraft, run stays active, no FATAL, master NOT persisted", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, fatal, awaiting } = makeObserver();
    h.subscribe(obs);

    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    // The master draft has NO `### Sub-Plan NN:` headers at all (the O1 finding's header-less draft).
    await h.ingestPermission(
      exitPlanModeReq("master-tu", "Here is my plan in prose with no sub-plan headers whatsoever."),
    );
    await flush();

    // RECOVERABLE: the held master ExitPlanMode is DENIED with a redraft message — the same deny
    // mechanism the nn>99 path uses. FALSIFY: let the empty-array reach the CHILDREN_PARSED reducer
    // where nonEmpty throws a generic (non-PlanValidationError) Error → the deny-for-redraft catch
    // misses it → the outer enqueueIngest catch dispatches FATAL → every assertion below goes RED.
    expect(rec.resolvePermission).toHaveLength(1);
    expect(rec.resolvePermission[0].id).toBe("master-tu");
    expect(rec.resolvePermission[0].allow).toBe(false);
    expect(rec.resolvePermission[0].message).toBeTruthy();
    // The run STAYS ACTIVE awaiting the redraft — no FATAL, no terminal.
    expect(fatal).toHaveLength(0);
    expect(h.orchestrationActive()).toBe(true);
    // The MALFORMED MASTER WAS NOT PERSISTED: writeAgentPlan was never called (validation runs
    // BEFORE the live write). FALSIFY: move validation back after writeAgentPlan → this RED.
    expect(rec.writeAgentPlan).toHaveLength(0);
    // No partial children materialized; the root never left open/decomposing; no gate surfaced.
    expect(h.snapshot().root.state.stage).toBe("open");
    expect(h.snapshot().root.state.phase).toBe("decomposing");
    expect(h.snapshot().pendingApproval).toBeNull();
    expect(awaiting).toHaveLength(0);
  });

  it("parseSubPlanHeaders throws PlanValidationError when two headers parse to the SAME nn", () => {
    // "Sub-Plan 1" and "Sub-Plan 01" both parse to nn 1 → a duplicate-nn collision. It must throw
    // the recoverable PlanValidationError (not a bare Error), so the held ExitPlanMode is denied-for-
    // redraft rather than FATALing. FALSIFY: drop the duplicate-nn check in parseSubPlanHeaders →
    // this returns two subplans instead of throwing → RED.
    expect(() =>
      parseSubPlanHeaders("### Sub-Plan 1: First\nbody one\n### Sub-Plan 01: Dup\nbody two"),
    ).toThrow(PlanValidationError);
    // Distinct nn still parses cleanly (the check is duplicate-only).
    const ok = parseSubPlanHeaders("### Sub-Plan 01: A\nbody\n### Sub-Plan 02: B\nbody2");
    expect(ok.subplans.map((s) => s.nn)).toEqual([1, 2]);
  });

  it("a live master draft with DUPLICATE Sub-Plan nn → DENY for redraft, run stays active, no FATAL, master NOT persisted", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, fatal, awaiting } = makeObserver();
    h.subscribe(obs);

    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    // Two headers collide on nn 1 ("Sub-Plan 1" and "Sub-Plan 01") — the duplicate-nn draft that
    // would otherwise wedge the run mid-execution.
    await h.ingestPermission(
      exitPlanModeReq(
        "master-tu",
        "### Sub-Plan 1: First\nbody one\n\n### Sub-Plan 01: Collides\nbody two",
      ),
    );
    await flush();

    // RECOVERABLE: the held master ExitPlanMode is DENIED with a redraft message. FALSIFY: drop the
    // duplicate-nn validation entirely → the duplicate-nn children reach CHILDREN_PARSED (now throwing
    // a PlanValidationError there) AFTER writeAgentPlan already ran → the master IS persisted and the
    // held permission is never denied → the writeAgentPlan / resolvePermission assertions go RED.
    expect(rec.resolvePermission).toHaveLength(1);
    expect(rec.resolvePermission[0].id).toBe("master-tu");
    expect(rec.resolvePermission[0].allow).toBe(false);
    expect(rec.resolvePermission[0].message).toBeTruthy();
    // The run STAYS ACTIVE awaiting the redraft — no FATAL, no terminal.
    expect(fatal).toHaveLength(0);
    expect(h.orchestrationActive()).toBe(true);
    // The MALFORMED MASTER WAS NOT PERSISTED: writeAgentPlan was never called (validation runs BEFORE
    // the live write).
    expect(rec.writeAgentPlan).toHaveLength(0);
    // No partial children materialized; the root never left open/decomposing; no gate surfaced.
    expect(h.snapshot().root.state.stage).toBe("open");
    expect(h.snapshot().root.state.phase).toBe("decomposing");
    expect(h.snapshot().pendingApproval).toBeNull();
    expect(awaiting).toHaveLength(0);

    await h.teardown();
  });

  it("COMPLEMENT (falsifiability): a GENUINE non-validation error in the SAME ingest path STILL FATALs", async () => {
    // The discriminator must not be over-broad: only PlanValidationError denies-for-redraft; every
    // OTHER error in the decomposition ingest path must still drive the run to FATAL. We inject a
    // real (non-validation) failure by making the live decomposition write reject AFTER validation
    // passes (the plan here is VALID — one in-range header), so the throw is unambiguously a
    // non-PlanValidationError reaching the outer enqueueIngest catch.
    const { deps } = makeDeps();
    (deps.writeAgentPlan as unknown as { mockImplementation: (f: () => Promise<string>) => void })
      .mockImplementation(async () => {
        throw new Error("disk exploded writing the master plan");
      });
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);

    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("master-tu", "### Sub-Plan 01: Valid\nbody"));
    await flush();

    // FATAL fired (the non-validation error was NOT swallowed by the redraft-deny catch). FALSIFY:
    // widen the deny-for-redraft catch to `instanceof Error` (over-broad) → this generic Error would
    // be denied-for-redraft instead of FATALing → fatal stays empty → RED.
    expect(fatal.length).toBeGreaterThanOrEqual(1);
    expect(h.orchestrationActive()).toBe(false);
    // The validation PASSED first (writeAgentPlan was REACHED exactly once), so this proves the FATAL
    // came from the write, not from validation. The throwing override REPLACES the recorder body, so
    // `rec.writeAgentPlan` is never pushed — the load-bearing observable is the mock's own call count.
    // FALSIFY: move validation back BEFORE the write (so the invalid path never reaches writeAgentPlan)
    // → mock.calls.length is 0 → RED. (Replaces the old vacuous `length + 1 >= 1`, which always passed.)
    expect((deps.writeAgentPlan as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});

describe("orchestrator — PHASE 3: the Mandate carries the master section body into sub prompts", () => {
  const MASTER_PLAN = [
    "Shared context: use the existing event bus for everything.",
    "",
    "### Sub-Plan 01: Renderer",
    "Build the renderer with WebGL; it must reuse the scene graph module.",
    "",
    "### Sub-Plan 02: Physics",
    "Integrate the physics engine behind the tick scheduler seam.",
  ].join("\n");

  it("sub-recon AND sub-draft prompts include the sub's section body + the master preamble, not just the title", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);

    await h.start({ cwd: "/work", request: "do it" });
    await driveIntentToRecon(h);
    await h.ingestStream(textFrame("recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.8"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("master-tu", MASTER_PLAN));
    await h.approve(""); // root decomposition gate (pathKey "")
    await h.ingestStream(resultFrame()); // interrupt-boundary result → deferred sub-01 recon send

    // The sub-01 RECON prompt carries the structured mandate: title, ITS section body, and the
    // master preamble — not sub-02's body. FALSIFY: revert mandateFor to title-only → the
    // section-body/preamble assertions go RED.
    const reconPrompt01 = rec.sendMessage.at(-1)!;
    expect(reconPrompt01).toContain("Sub-Plan 01: Renderer");
    expect(reconPrompt01).toContain("Build the renderer with WebGL");
    expect(reconPrompt01).toContain("use the existing event bus");
    expect(reconPrompt01).not.toContain("Integrate the physics engine");

    // The sub-01 DRAFT prompt (sent off the recon result) carries the same mandate body.
    await h.ingestStream(textFrame("sub01 recon"));
    await h.ingestStream(resultFrame());
    // PHASE 4: the per-node sizer turn follows every non-root recon (single ⇒ this node is the leaf).
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    const draftPrompt01 = rec.sendMessage.at(-1)!;
    expect(draftPrompt01).toContain("Draft the implementation plan for sub-plan 01");
    expect(draftPrompt01).toContain("Build the renderer with WebGL");
    expect(draftPrompt01).toContain("use the existing event bus");

    await h.cancel();
  });
});

describe("orchestrator — PHASE 3: sizerPrompt carries the decomposition-bias block", () => {
  it("pins the bias prose ported from the /multiplan skill (Gate 3)", () => {
    // FALSIFY: drop the bias block from sizerPrompt() → every contains-assertion goes RED.
    const p = sizerPrompt();
    expect(p).toContain("---DECOMPOSITION-BIAS---");
    expect(p).toContain("---END-DECOMPOSITION-BIAS---");
    expect(p).toContain("should default to");
    expect(p).toContain("2 or more");
    expect(p).toContain("scope-narrowing clause");
    expect(p).toContain("When in doubt: lean split.");
  });

  it("carries the bounded-working-prototype override (DEFAULT SMALL)", () => {
    // FALSIFY: delete the override clause from sizerPrompt()'s DECOMPOSITION-BIAS block → RED.
    // This pins the R1 default-small rule: a bounded working prototype biases to `single`, and the
    // greenfield 2+-subsystem split rule does NOT apply when one exists.
    const p = sizerPrompt();
    expect(p).toContain("bounded, working prototype");
    expect(p).toContain("empirical proof the whole thing");
    expect(p).toContain("bias the decision to `single`");
    expect(p).toContain("does NOT apply when such");
    expect(p).toContain("do not shatter a working artifact into a layer tree");
    expect(p).toContain("genuinely too large to port in one pass");
  });
});

describe("orchestrator — PHASE 2: decomposition drafts are slice-first (capability-first)", () => {
  const MANDATE: Mandate = {
    title: "Some node",
    sectionBody: "the node scope",
    masterPreamble: "shared preamble",
  };

  it("masterDraftPrompt requires Sub-Plan 01 to be the thinnest runnable end-to-end vertical slice", () => {
    // FALSIFY: remove the SLICE-FIRST paragraph from masterDraftPrompt() → every assertion goes RED.
    const p = masterDraftPrompt("build a thing");
    expect(p).toContain("SLICE-FIRST (capability-first, NOT layer-first)");
    expect(p).toContain("decompose by capability / vertical slice, not");
    expect(p).toContain("Sub-Plan 01 MUST be the thinnest runnable END-TO-END vertical");
    expect(p).toContain("that actually runs");
    expect(p).toContain("enhance that already-running artifact rather than add an isolated horizontal");
  });

  it("nestedDecompositionDraftPrompt requires child Sub-Plan 01 to be the thinnest end-to-end slice", () => {
    // FALSIFY: remove the SLICE-FIRST paragraph from nestedDecompositionDraftPrompt() → RED.
    const p = nestedDecompositionDraftPrompt([parseNn(2)], MANDATE, []);
    expect(p).toContain("SLICE-FIRST (capability-first, NOT layer-first)");
    expect(p).toContain("decompose by capability / vertical slice, not");
    expect(p).toContain("Child Sub-Plan 01 MUST be the thinnest runnable END-TO-END");
    expect(p).toContain("that actually runs");
    expect(p).toContain(
      "enhance that already-running artifact rather than add an isolated horizontal",
    );
  });
});

// ============================================================================================
// PHASE 4 (R4 + R5) — baseline-gated prompt clauses. When a frozen working-reference baseline
// exists (hasBaseline=true) the master draft injects the OUTCOME-bar acceptance criterion (R4) and
// the sub-plan draft/summary prompts inject the integrated behavioral-envelope-test mandate (R5).
// When NO baseline exists (hasBaseline=false, the default) every prompt is BYTE-IDENTICAL to its
// pre-Phase-4 form. Every test below is gated BOTH directions: it asserts the clause is PRESENT with
// the flag true AND ABSENT (and byte-identical to the default) with the flag false.
// ============================================================================================
describe("orchestrator — PHASE 4: baseline-gated acceptance bar (R4) + envelope test (R5)", () => {
  const MANDATE: Mandate = {
    title: "Sim node",
    sectionBody: "the node scope",
    masterPreamble: "shared preamble",
  };
  const PATH = [parseNn(1)];

  // ---- R4: masterDraftPrompt OUTCOME-bar acceptance criterion ----------------------------------

  it("R4: masterDraftPrompt injects the OUTCOME-bar acceptance criterion when a baseline exists", () => {
    // FALSIFY: drop baselineAcceptanceLines() (or its `if (!hasBaseline) return []` true-branch
    // body) from masterDraftPrompt → every assertion below goes RED.
    const p = masterDraftPrompt("build a sim", undefined, "intent: a sim", true);
    expect(p).toContain("ACCEPTANCE CRITERION (top-level — a frozen working reference exists):");
    // Anchored on the shared BASELINE_FRAMING constant (a silent drop of that constant would be
    // invisible without this pin).
    expect(p).toContain(BASELINE_FRAMING);
    expect(p).toContain("phrased in OUTCOME terms");
    expect(p).toContain("the core loop works end-to-end");
    // The bar is NOT "match the prototype" and NOT pinned to its exact numbers.
    expect(p).toContain('Do NOT phrase it as "match the prototype"');
    expect(p).toContain("do NOT pin it to the");
    expect(p).toContain("exact numbers");
    // Divergence ABOVE the floor is explicitly permitted (improvements, not regressions).
    expect(p).toContain("divergences ABOVE the floor are GOOD");
    expect(p).toContain("not regressions to flag");
  });

  it("R4: masterDraftPrompt is BYTE-IDENTICAL with no baseline (default false === explicit false)", () => {
    // The default arg path and an explicit false must both produce TODAY's exact prompt, and that
    // prompt must NOT contain any acceptance-criterion clause. FALSIFY: emit the R4 block in the
    // false branch → the toBe equality AND the not.toContain both go RED.
    const dflt = masterDraftPrompt("build a sim", undefined, "intent: a sim");
    const explicitFalse = masterDraftPrompt("build a sim", undefined, "intent: a sim", false);
    expect(explicitFalse).toBe(dflt);
    expect(dflt).not.toContain("ACCEPTANCE CRITERION (top-level");
    expect(dflt).not.toContain("divergences ABOVE the floor are GOOD");
  });

  // ---- R4 (nested): nestedDecompositionDraftPrompt OUTCOME-bar acceptance criterion -------------
  // A baseline'd tree that decomposes a sub-plan FURTHER (depth >= 2) drafts a nested master via
  // nestedDecompositionDraftPrompt; it must carry the SAME OUTCOME-bar acceptance criterion the root
  // master draft injects, so the outcome-bar reminder is not lost at the nested master.

  it("R4 (nested): nestedDecompositionDraftPrompt injects the OUTCOME-bar acceptance criterion when a baseline exists", () => {
    // FALSIFY: drop baselineAcceptanceLines() from nestedDecompositionDraftPrompt → every assertion
    // below goes RED.
    const p = nestedDecompositionDraftPrompt([parseNn(2)], MANDATE, [], null, true);
    expect(p).toContain("ACCEPTANCE CRITERION (top-level — a frozen working reference exists):");
    // Anchored on the shared BASELINE_FRAMING constant (proves the helper, not a forked copy, runs).
    expect(p).toContain(BASELINE_FRAMING);
    expect(p).toContain("phrased in OUTCOME terms");
    expect(p).toContain("the core loop works end-to-end");
    expect(p).toContain('Do NOT phrase it as "match the prototype"');
    expect(p).toContain("divergences ABOVE the floor are GOOD");
    expect(p).toContain("not regressions to flag");
  });

  it("R4 (nested): nestedDecompositionDraftPrompt is BYTE-IDENTICAL with no baseline (default false === explicit false)", () => {
    // The default-arg path and an explicit false must both produce TODAY's exact prompt, and that
    // prompt must NOT contain any acceptance-criterion clause (the false branch adds zero lines).
    // FALSIFY: emit the R4 block in the false branch → the toBe equality AND both not.toContain go RED.
    const dflt = nestedDecompositionDraftPrompt([parseNn(2)], MANDATE, []);
    const explicitFalse = nestedDecompositionDraftPrompt([parseNn(2)], MANDATE, [], null, false);
    expect(explicitFalse).toBe(dflt);
    expect(dflt).not.toContain("ACCEPTANCE CRITERION (top-level");
    expect(dflt).not.toContain("divergences ABOVE the floor are GOOD");
  });

  // ---- R5: subDraftPrompt + summaryPrompt integrated behavioral-envelope-test mandate ----------

  it("R5: subDraftPrompt injects the envelope-test mandate (a/b/c) when a baseline exists", () => {
    // FALSIFY: drop baselineEnvelopeTestLines() from subDraftPrompt → every assertion goes RED.
    const p = subDraftPrompt(PATH, MANDATE, [], null, true);
    expect(p).toContain("RUNNABLE-ARTIFACT REQUIREMENT (a frozen working reference exists)");
    expect(p).toContain("IF this sub-plan produces a");
    // (a) core/sim logic separated from rendering/DOM, headless-drivable.
    expect(p).toContain("the core / simulation logic SEPARATED from rendering/DOM");
    expect(p).toContain("importable and headless-drivable");
    // (b) at least one integrated envelope test, bound INTENT-tied not prototype-tied.
    expect(p).toContain("integrated behavioral-envelope test that ASSEMBLES the loop and drives it for");
    expect(p).toContain("the bound comes from the INTENDED envelope in");
    expect(p).toContain("INTENT.md");
    expect(p).toContain("NOT from the prototype's exact numbers");
    // (c) falsifiability: break → red → restore.
    expect(p).toContain("a falsifiability step: temporarily BREAK the loop, confirm the envelope test goes RED");
    expect(p).toContain("an envelope test that cannot go red is unfalsifiable");
  });

  it("R5: subDraftPrompt is BYTE-IDENTICAL with no baseline (default false === explicit false)", () => {
    // FALSIFY: emit the R5 block in the false branch → toBe AND not.toContain go RED.
    const dflt = subDraftPrompt(PATH, MANDATE, []);
    const explicitFalse = subDraftPrompt(PATH, MANDATE, [], null, false);
    expect(explicitFalse).toBe(dflt);
    expect(dflt).not.toContain("RUNNABLE-ARTIFACT REQUIREMENT");
    expect(dflt).not.toContain("behavioral-envelope test");
  });

  it("R5: summaryPrompt injects the same envelope-test mandate when a baseline exists", () => {
    // FALSIFY: drop baselineEnvelopeTestLines() from summaryPrompt → every assertion goes RED.
    const p = summaryPrompt(PATH, true);
    expect(p).toContain("RUNNABLE-ARTIFACT REQUIREMENT (a frozen working reference exists)");
    expect(p).toContain("integrated behavioral-envelope test that ASSEMBLES the loop and drives it for");
    expect(p).toContain("the bound comes from the INTENDED envelope in");
    expect(p).toContain("NOT from the prototype's exact numbers");
    expect(p).toContain("a falsifiability step: temporarily BREAK the loop");
  });

  it("R5: summaryPrompt is BYTE-IDENTICAL with no baseline (default false === explicit false)", () => {
    // FALSIFY: emit the R5 block in the false branch → toBe AND not.toContain go RED.
    const dflt = summaryPrompt(PATH);
    const explicitFalse = summaryPrompt(PATH, false);
    expect(explicitFalse).toBe(dflt);
    expect(dflt).not.toContain("RUNNABLE-ARTIFACT REQUIREMENT");
    expect(dflt).not.toContain("behavioral-envelope test");
  });
});

describe("orchestrator — PHASE 3: updated_ms is stamped fresh at every persist (injected clock)", () => {
  it("every persist reads a FRESH now() through the clock seam (injected strictly-increasing clock; NOT a wall-clock strict-monotonicity guarantee)", async () => {
    const { deps, rec } = makeDeps();
    // Injected strictly-increasing clock: this test pins the SEAM WIRING — each persist must call
    // now() anew (never echo a frozen created_ms / cached stamp). It does NOT assert wall-clock
    // strict monotonicity: under production Date.now(), two persists in the same millisecond carry
    // EQUAL updated_ms (non-decreasing only). updated_ms is a last-modified stamp, not an ordering
    // sequence — see the runEffect persist site.
    let t = 5_000;
    deps.now = () => ++t;
    const h = createOrchestrator(deps);

    await h.start({ cwd: "/work", request: "do it" }); // START → persist #1
    await h.dispatch({ type: "INTENT_CLARIFIED", intent: "i" }); // dispatch directly persists #2…
    const persisted = rec.writePlanTreeFile
      .filter((w) => w.name === "state.json")
      .map((w) => JSON.parse(w.contents) as { updated_ms: number; created_ms: number });
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    // STRICTLY increasing across consecutive persists. FALSIFY: restore the reducer's old self-max
    // no-op (and drop the driver stamp) → updated_ms stays frozen at created_ms → RED.
    for (let i = 1; i < persisted.length; i++) {
      expect(persisted[i].updated_ms).toBeGreaterThan(persisted[i - 1].updated_ms);
    }
    // The last write's stamp is fresher than genesis — the field is live, not created_ms echoed.
    expect(persisted.at(-1)!.updated_ms).toBeGreaterThan(persisted[0].created_ms);

    await h.cancel();
  });
});

// ============================================================================================
// Stop → New plan FRESH-SESSION semantics — every terminal path must leave the SDK session
// DEAD, and the next start must open a brand-new session (never reuse the prior one).
// ============================================================================================

describe("orchestrator — every terminal path ends the SDK session (fresh session after stop)", () => {
  it("FATAL ends the SDK session (cancelRun + endSession), not just deactivation", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const { obs, fatal } = makeObserver();
    h.subscribe(obs);
    await h.start({ cwd: "/work", request: "do it" });

    // Drive a terminal FATAL through the funnel (the watchdog / ingest-throw path dispatches the
    // same event). Pre-fix, notifyFatal only flipped `active` false and DEREGISTERED — the SDK
    // session (with the run's full conversation context) stayed ALIVE in the sidecar, exactly the
    // Stop-routing desync: Stop then routes down the legacy path, and a
    // later start collides with (or bleeds context from) the surviving session.
    await h.dispatch({ type: "FATAL", message: "boom" });

    expect(fatal).toEqual(["boom"]);
    expect(h.orchestrationActive()).toBe(false);
    // THE FIX UNDER TEST: the session was actually ended (cancel + end), same as cancel().
    // FALSIFY: revert notifyFatal to markTerminal-only → endSession stays 0 → RED.
    expect(rec.cancelRun).toBe(1);
    expect(rec.endSession).toBe(1);

    // Idempotent: a second FATAL (already terminal) must NOT end the session again.
    await h.dispatch({ type: "FATAL", message: "boom again" });
    expect(rec.endSession).toBe(1);
  });

  it("stop → start issues the fresh-session primitive: end_agent_session, THEN a brand-new plan-mode start_agent_session", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.start({ cwd: "/work", request: "first plan" });

    // Stop (the #conversation-cancel route while an orchestration owns the seam).
    await h.cancel();
    expect(rec.endSession).toBe(1);

    // New plan after the stop: a REAL start (not the idempotent no-op) that opens a brand-new
    // SDK session in the genesis "prototype" policy. The fresh-session primitive is
    // start_agent_session — the second run must NEVER reach the prior session via
    // sendMessage-only reuse.
    const again = await h.start({ cwd: "/work", request: "second plan" });
    expect(again).toBe(true);
    expect(rec.startSession).toEqual([
      { cwd: "/work", permissionMode: "prototype" },
      { cwd: "/work", permissionMode: "prototype" },
    ]);

    // ORDERED trace: the old session's end strictly precedes the new session's start — the new
    // run can never share a live session with the old one. FALSIFY: make cancel() skip
    // endSession (markTerminal-only) → no "endSession" entry before the 2nd start → RED.
    const endIdx = rec.calls.indexOf("endSession");
    const secondStartIdx = rec.calls.lastIndexOf("startSession:/work:prototype");
    expect(endIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeLessThan(secondStartIdx);

    // The new session opens with the host policy re-asserted to the genesis "prototype" mode (the
    // sidecar derives its hostPolicy backstop from this start command, so a stale "acceptEdits"
    // from a stopped mid-execution run can never leak into the new planning phase).
    expect(rec.startSession[1].permissionMode).toBe("prototype");

    await h.cancel();
  });
});
