import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Sub-Plan 02 — the approval-gate controller ↔ frozen OrchestratorHandle wiring (the live app's
// consumer side). main.ts subscribes to the SHARED orchestrator's observer; when a sub-plan reaches
// SUB_DRAFTED (awaiting approval) the controller opens the pointed-at plan file, flips to the Plan tab,
// and shows the approval bar in IN-PROCESS mode (Approve & Build + Submit relabeled "Request changes").
//
// We install a createOrchestrator(fakeDeps) as the shared singleton via __setOrchestratorForTest BEFORE
// booting the DOM (so main.ts's getOrchestrator() subscribes to OUR handle), then script the run to a
// SUB_DRAFTED gate via the handle's own dispatch funnel — exactly mirroring orchestrator.test.ts. The
// fakeDeps record every effect (resolvePermission / setMode) so the button routing is asserted at the
// command level. The ./render facade + the conversation facade are REAL (mirroring main.inproc-review).
// ---------------------------------------------------------------------------------------------

type Rec = { quote: string; comment: string; block_line: number | null; block_end_line: number | null; occurrence: number; id: number };

const H = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    const path = (a.path as string) ?? "";
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nselect this phrase here\n");
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "get_comments") return Promise.resolve(H.store[path] ?? []);
    if (cmd === "get_comment_count") return Promise.resolve((H.store[path] ?? []).length);
    if (cmd === "set_comments") {
      const next = (a.comments as Rec[]) ?? [];
      if (next.length === 0) delete H.store[path];
      else H.store[path] = next;
      return Promise.resolve(next);
    }
    if (cmd === "clear_comments") {
      delete H.store[path];
      return Promise.resolve([]);
    }
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "hook_status") return Promise.resolve(false);
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    (H.listeners[name] ??= []).push(handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { __resetReviewStateForTest } from "./main";
import { parseNn } from "./conversation/plan-tree";
import {
  createOrchestrator,
  __setOrchestratorForTest,
  __resetOrchestratorForTest,
  type OrchestratorDeps,
  type OrchestratorHandle,
  type PlanTreeEvent2,
} from "./conversation/orchestrator";

// "stage/phase" of the root node — the gen-2 spelling of the old master.phase assertions.
function rootPhase(h: OrchestratorHandle): string {
  const r = h.snapshot().root;
  return `${r.state.stage}/${r.state.phase}`;
}

// The active node's pathKey ("" = root) — the gen-2 spelling of the pointer assertions.
function activeKey(h: OrchestratorHandle): string | null {
  const p = h.snapshot().activePath;
  return p === null ? null : p.map((nn) => String(nn).padStart(2, "0")).join(".");
}

// ---- recording fake OrchestratorDeps (mirror orchestrator.test.ts) --------------------------
interface Recorded {
  resolvePermission: Array<{ id: string; allow: boolean; message?: string }>;
  setMode: string[];
}
function makeDeps(): { deps: OrchestratorDeps; rec: Recorded } {
  const rec: Recorded = { resolvePermission: [], setMode: [] };
  const deps: OrchestratorDeps = {
    startSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    setMode: vi.fn(async (mode) => {
      rec.setMode.push(mode);
    }),
    resolvePermission: vi.fn(async (args) => {
      rec.resolvePermission.push({ id: args.id, allow: args.allow, message: args.message });
    }),
    cancelRun: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    writePlanTreeFile: vi.fn(async (_cwd, name) => `/abs/.plan-tree/${name}`),
    writeAgentPlan: vi.fn(async (_plan, _treeId, nn) => `/p/${nn}.md`),
    resetPlanTreeDir: vi.fn(async () => {}),
  };
  return { deps, rec };
}

function planRow(absPath: string, stem: string): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd: null,
    unread: false,
    flavor: "sub",
    tree_id: "t1",
    nn: 1,
    child_count: null,
    collapsed: false,
    h1s: [],
  };
}

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button class="conv-new-plan" id="new-plan-btn"></button>
      <button id="theme-toggle"></button>
    </div></div>
    <div class="tab-row"><span class="tab" data-tab="plans">Plans</span></div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span>
      <div class="sidebar-status"><span class="conv-status" id="sdk-status"></span></div>
      <div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="reader-inner">
      <div class="tab-row reader-tab-row">
        <span class="tab active" data-tab="plan">Plan</span>
        <span class="tab" data-tab="conversation">Conversation</span>
      </div>
      <div class="tab-pane active" id="tab-plan">
        <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
        <div class="review-bar hidden" id="review-bar">
          <span id="review-bar-label"></span>
          <button id="review-submit" disabled>Submit feedback</button>
          <button id="review-clear">Clear comments</button>
          <button id="review-approve" class="hidden">Approve &amp; Build</button>
          <button id="review-resume"></button>
        </div>
        <div class="md" id="reading-pane"></div>
      </div>
      <div class="tab-pane" id="tab-conversation">
        <button class="conv-cancel" id="conversation-cancel"></button>
        <div class="conv-stream" id="conversation-stream"></div>
      </div>
    </div></main>
    <div class="sel-popover hidden" id="sel-popover">
      <div id="sp-quote"></div><textarea id="sp-text"></textarea>
      <button id="sp-cancel"></button><button id="sp-save"></button>
    </div>
    <div class="conv-modal hidden" id="composer-modal">
      <textarea id="composer-request"></textarea>
      <input id="composer-dir" />
      <button id="composer-choose-dir"></button>
      <div id="composer-mode"><button class="conv-mode-btn active" data-mode="plan"></button><button class="conv-mode-btn" data-mode="acceptEdits"></button></div>
      <button id="composer-start"></button>
      <button id="composer-cancel"></button>
      <div class="conv-auth hidden" id="composer-auth"><input id="composer-token" /><button id="composer-token-submit"></button></div>
    </div>
    <button id="hook-setup"></button><button id="hook-remove"></button>
    <span id="hook-status"></span>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Script the installed handle through the gen-2 dispatch sequence to a held LEAF gate for child 01
// with the given planPath, so main.ts's onAwaitingApproval fires + opens that file. The confident-
// single collapse is used so NO decomposition gate is held along the way (its resolve would pollute
// the recorded resolvePermission trace these tests pin).
async function driveToSubDraftedGate(h: OrchestratorHandle, planPath: string): Promise<void> {
  await h.start({ cwd: "/work", request: "do it" });
  const dispatch = (e: PlanTreeEvent2) => h.dispatch(e);
  await dispatch({ type: "INTENT_CLARIFIED", intent: "i" });
  await dispatch({ type: "NODE_RECON_DONE", path: [] });
  await dispatch({ type: "SIZER_DONE", path: [], outcome: { decision: "single", confidence: 0.95, num_plans: 1 } });
  await dispatch({ type: "NODE_RECON_DONE", path: [parseNn(1)] });
  await dispatch({
    type: "NODE_DRAFTED",
    path: [parseNn(1)],
    toolUseId: "sub-1-tu",
    planPath,
    plansDirPath: "/p",
  });
  await flush();
}

// Drive the installed handle to the ROOT decomposition gate (root open/awaiting-decomposition-
// approval; the unified gate kind "decomposition" held in pendingApproval). Uses the real
// ingestPermission path (NOT a raw dispatch) so the driver writes + parses the decomposition and
// the reducer holds the gate + fires onAwaitingApproval — exactly mirroring a live split run. The
// plan body carries one Sub-Plan header so CHILDREN_PARSED has a child for DECOMPOSITION_APPROVED.
async function driveToMasterGate(h: OrchestratorHandle): Promise<void> {
  await h.start({ cwd: "/work", request: "do it" });
  const dispatch = (e: PlanTreeEvent2) => h.dispatch(e);
  await dispatch({ type: "INTENT_CLARIFIED", intent: "i" });
  await dispatch({ type: "NODE_RECON_DONE", path: [] });
  await dispatch({ type: "SIZER_DONE", path: [], outcome: { decision: "split", confidence: 0.82, num_plans: 1 } });
  // The live interactive-tool path: the master ExitPlanMode hold while decomposing.
  await h.ingestPermission({
    seq: 1,
    kind: "tool_permission_requested",
    id: "master-tu",
    tool: "ExitPlanMode",
    input: { plan: "# Master\n\n### Sub-Plan 01: Alpha\n\nscope\n" },
    agent_id: null,
  } as never);
  await flush();
}

function calls(cmd: string): Array<Record<string, unknown>> {
  return H.invokeCalls.filter((c) => c.cmd === cmd).map((c) => c.args);
}
function activeReaderTab(): string | undefined {
  const t = document.querySelector<HTMLElement>(".reader-tab-row .tab.active");
  return t?.dataset.tab;
}

function selectText(block: Element, needle: string, occurrence: number): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let tn = walker.nextNode() as Text | null;
  while (tn) {
    let from = 0;
    while (true) {
      const idx = tn.data.indexOf(needle, from);
      if (idx < 0) break;
      if (seen === occurrence) {
        const range = document.createRange();
        range.setStart(tn, idx);
        range.setEnd(tn, idx + needle.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      seen++;
      from = idx + needle.length;
    }
    tn = walker.nextNode() as Text | null;
  }
}
function addCommentViaPopover(comment: string): void {
  const pane = document.querySelector<HTMLElement>("#reading-pane")!;
  const block = pane.querySelector("p[data-source-line]") ?? pane;
  selectText(block, "select this phrase", 0);
  pane.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  (document.querySelector("#sp-text") as HTMLTextAreaElement).value = comment;
  document.querySelector<HTMLElement>("#sp-save")!.click();
}

beforeEach(() => {
  H.store = {};
  H.invokeCalls = [];
  H.listeners = {};
  H.rows = [];
  __resetReviewStateForTest();
  __resetOrchestratorForTest();
});

// ---------------------------------------------------------------------------------------------
// GATE OPENS — SUB_DRAFTED → bar in in-process mode (Approve & Build + "Request changes").
// ---------------------------------------------------------------------------------------------
describe("orchestrator gate — onAwaitingApproval opens the bar in in-process mode", () => {
  it("a SUB_DRAFTED gate opens the pointed-at plan, flips to Plan tab, and shows the in-process bar", async () => {
    const planPath = "/p/01.md";
    H.rows = [planRow(planPath, "1")];
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    __setOrchestratorForTest(h); // main.ts's getOrchestrator() will subscribe to OUR handle
    bootDom();
    await flush();

    // Park on Conversation first so switchToPlanTab is load-bearing.
    document.querySelector<HTMLElement>('.reader-tab-row .tab[data-tab="conversation"]')!.click();
    expect(activeReaderTab()).toBe("conversation");

    await driveToSubDraftedGate(h, planPath);
    await flush();

    // The pointed-at plan file is open (header = its basename) and selected; tab flipped back to Plan.
    expect(document.querySelector("#doc-filename")!.textContent).toBe("01.md");
    expect(activeReaderTab()).toBe("plan");
    // The bar is VIEWING the gate in IN-PROCESS mode: Approve visible, Submit relabeled "Request changes".
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-submit")!.textContent).toBe("Request changes");
  });
});

// ---------------------------------------------------------------------------------------------
// FIX 2 — the placeholder stays the ACTIVE stand-in through the gate handler when the gate
// plan's row is missing. The old ordering cleared placeholderSelected BEFORE refreshList ran
// (and openPath only updates inside openPlan afterwards), so the intermediate render — which is
// also the FINAL sidebar render here, no later re-render occurs — had ZERO active rows.
// Falsifiability (verified): restoring `placeholderSelected = false` to before refreshList makes
// the .active assertions go RED.
// ---------------------------------------------------------------------------------------------
describe("orchestrator gate — placeholder stays the active stand-in when the gate row is missing (FIX 2)", () => {
  it("gate arrives while list_plans has NO row for its plan → the placeholder is the single .active row", async () => {
    H.rows = []; // list_plans lags the plan write — no [data-path] row exists for the gate plan
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await driveToSubDraftedGate(h, "/p/01.md");
    await flush();

    const list = document.querySelector<HTMLElement>("#plan-list")!;
    const phRow = list.querySelector<HTMLElement>(".plan.placeholder");
    expect(phRow).toBeTruthy();
    expect(phRow!.classList.contains("active")).toBe(true);
    expect(list.querySelectorAll(".active")).toHaveLength(1);
    // The gate plan itself still opened normally into the pane.
    expect(document.querySelector("#doc-filename")!.textContent).toBe("01.md");
  });
});

// ---------------------------------------------------------------------------------------------
// APPROVE — #review-approve routes into the handle: allow + acceptEdits + Conversation tab.
// ---------------------------------------------------------------------------------------------
describe("orchestrator gate — #review-approve routes approve(nn) into the frozen handle", () => {
  it("one click → resolvePermission(allow) + setMode('acceptEdits') recorded; Conversation tab shown", async () => {
    const planPath = "/p/01.md";
    H.rows = [planRow(planPath, "1")];
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    __setOrchestratorForTest(h);
    bootDom();
    await flush();
    await driveToSubDraftedGate(h, planPath);
    await flush();

    document.querySelector<HTMLButtonElement>("#review-approve")!.click();
    await flush();

    // The handle's APPROVE effects ran: allow the held ExitPlanMode + set acceptEdits. (The
    // leading "plan" is the INTENT_CLARIFIED boundary assert — the session opened in the genesis
    // "prototype" policy carried by startSession, so the seam's first correction is at intent.)
    // FALSIFY: route #review-approve to the legacy resolveReview path instead of approve(nn) → no
    // pending review exists, so resolvePermission/setMode are never recorded and these go RED.
    expect(rec.resolvePermission).toEqual([{ id: "sub-1-tu", allow: true, message: undefined }]);
    expect(rec.setMode).toEqual(["plan", "acceptEdits"]);
    // Execution streams in place → Conversation tab shown.
    expect(activeReaderTab()).toBe("conversation");
    // The legacy in-process resolve path was NOT taken (no Tauri resolve_tool_permission invoke).
    expect(calls("resolve_tool_permission")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// REQUEST CHANGES — add a comment → #review-submit routes requestChanges(nn, feedback): deny with
// feedback, pointer unchanged, redraftCount === 1.
// ---------------------------------------------------------------------------------------------
describe("orchestrator gate — #review-submit routes requestChanges(nn, feedback) into the handle", () => {
  it("with >=1 comment → resolvePermission(deny, feedback); pointer unchanged; redraftCount === 1", async () => {
    const planPath = "/p/01.md";
    H.rows = [planRow(planPath, "1")];
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    __setOrchestratorForTest(h);
    bootDom();
    await flush();
    await driveToSubDraftedGate(h, planPath);
    await flush();

    const keyBefore = activeKey(h);

    // Submit is disabled at 0 comments; adding one enables it.
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(true);
    addCommentViaPopover("needs more detail");
    await flush();
    expect(submit.disabled).toBe(false);

    submit.click();
    await flush();

    // requestChanges denied the held permission WITH the assembled feedback (carrying the comment).
    expect(rec.resolvePermission).toHaveLength(1);
    expect(rec.resolvePermission[0].id).toBe("sub-1-tu");
    expect(rec.resolvePermission[0].allow).toBe(false);
    expect(String(rec.resolvePermission[0].message)).toContain("needs more detail");
    expect(String(rec.resolvePermission[0].message)).toContain("Please revise the plan based on this feedback:");
    // Pointer unchanged (re-draft in place) and redraftCount incremented to 1.
    expect(activeKey(h)).toBe(keyBefore);
    const root = h.snapshot().root;
    if (root.state.stage !== "split") throw new Error("root not split");
    expect(root.state.children[0].redraftCount).toBe(1);
    expect(root.state.children[0].state.phase).toBe("drafting");
  });
});

// ---------------------------------------------------------------------------------------------
// GEN-2 ROOT decomposition gate routing. The root gate is the UNIFIED ApprovalGate2 (kind
// "decomposition", path []) carried in pendingApproval like every other gate — the gen-1 master-
// phase keying / viewingMasterGate / approveMaster surface is gone. Both review handlers route
// through the ONE viewingGate() derivation into approve(pathKey)/requestChanges(pathKey); the
// decomposition-vs-leaf branching lives INSIDE the orchestrator (pinned by the invariant tests in
// orchestrator-gate-invariants.test.ts).
// ---------------------------------------------------------------------------------------------
describe("root gate — #review-approve routes approve(\"\") (the ROOT pathKey) into the handle", () => {
  it("at the root decomposition gate, a click calls approve(\"\") and fires the decomposition branch", async () => {
    const masterPath = "/p/null.md"; // writeAgentPlan(_,_,null) → `/p/null.md`
    H.rows = [planRow(masterPath, "null")];
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const approve = vi.spyOn(h, "approve");
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await driveToMasterGate(h);
    await flush();

    // The root gate is open + viewed: root awaiting-decomposition-approval, the unified gate (kind
    // decomposition) held, the decomposition plan file open, and the bar shows the in-process
    // affordances (Approve visible, Submit relabeled "Request changes").
    expect(rootPhase(h)).toBe("open/awaiting-decomposition-approval");
    expect(h.snapshot().pendingApproval?.kind).toBe("decomposition");
    expect(activeReaderTab()).toBe("plan");
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-submit")!.textContent).toBe("Request changes");

    document.querySelector<HTMLButtonElement>("#review-approve")!.click();
    await flush();

    // FALSIFY: pass a child pathKey (e.g. "01") from the click handler instead of the gate's own
    // path → approve throws (no held gate for that path) and the run never advances → RED below.
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][0]).toBe("");
    // The decomposition branch fired: the held master permission resolved allow, the resumed turn
    // was INTERRUPTED (the decomposition-only hardening), and the first child is now active.
    expect(rec.resolvePermission.at(-1)).toEqual({ id: "master-tu", allow: true, message: undefined });
    expect(deps.interrupt).toHaveBeenCalledTimes(1);
    expect(rootPhase(h)).toBe("split/running-children");
    expect(activeKey(h)).toBe("01");
    // Conversation tab shown (the first child's recon streams in place).
    expect(activeReaderTab()).toBe("conversation");
  });
});

describe("root gate — #review-submit routes requestChanges(\"\", feedback) into the handle", () => {
  it("with >=1 comment, a click calls requestChanges with the ROOT pathKey and the assembled feedback", async () => {
    const masterPath = "/p/null.md";
    H.rows = [planRow(masterPath, "null")];
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const requestChanges = vi.spyOn(h, "requestChanges");
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await driveToMasterGate(h);
    await flush();

    // Submit disabled at 0 comments; a comment enables it.
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(true);
    addCommentViaPopover("decompose differently");
    await flush();
    expect(submit.disabled).toBe(false);

    submit.click();
    await flush();

    // FALSIFY: pass a child pathKey from the click handler instead of the gate's own path →
    // requestChanges throws (no held gate for that path), no deny is recorded → RED below.
    expect(requestChanges).toHaveBeenCalledTimes(1);
    expect(requestChanges.mock.calls[0][0]).toBe("");
    expect(String(requestChanges.mock.calls[0][1])).toContain("decompose differently");
    // The decomposition deny landed (the held master permission resolved deny with the feedback)
    // and the root went BACK to open/decomposing for the same-turn redraft — never interrupted,
    // never advanced past the gate.
    expect(rec.resolvePermission.at(-1)?.id).toBe("master-tu");
    expect(rec.resolvePermission.at(-1)?.allow).toBe(false);
    expect(deps.interrupt).not.toHaveBeenCalled();
    expect(rootPhase(h)).toBe("open/decomposing");
    expect(activeKey(h)).toBe("");
  });
});

describe("root gate vs leaf gate — a leaf gate routes approve with the CHILD pathKey", () => {
  it("with the root running-children + a leaf pendingApproval, #review-approve calls approve(\"01\") and never interrupts", async () => {
    const planPath = "/p/01.md";
    H.rows = [planRow(planPath, "1")];
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    const approve = vi.spyOn(h, "approve");
    __setOrchestratorForTest(h);
    bootDom();
    await flush();
    await driveToSubDraftedGate(h, planPath);
    await flush();

    // The reducer holds a LEAF gate: root running-children, pendingApproval kind "leaf" at path [1].
    expect(rootPhase(h)).toBe("split/running-children");
    expect(h.snapshot().pendingApproval?.kind).toBe("leaf");

    document.querySelector<HTMLButtonElement>("#review-approve")!.click();
    await flush();

    // FALSIFY: derive the pathKey too loosely in the click handler (e.g. always "" — the root) →
    // approve("") throws (the held gate is at "01"), the leaf never executes → RED below.
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][0]).toBe("01");
    // The LEAF branch fired: resolve allow, NO interrupt (interrupting would abort the approved
    // execution — the leaf-never-interrupts invariant, also pinned at the orchestrator level).
    expect(deps.interrupt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// IDLE-WAITING HINT — the visual-prototype gate is TURN-COMPLETION signaled: the intent turn ends
// with a `result` frame, the conversation session goes idle, and the facade's working indicator
// would normally hide while the app is blocked on the user's approve/refine. main.ts's onSnapshot
// propagates `pendingPrototype != null` to conversationHandle.setIdleWaitingHint so the indicator
// shows "Waiting for your input…" at idle, and self-clears when the gate resolves.
// ---------------------------------------------------------------------------------------------
describe("orchestrator gate — pendingPrototype drives the conversation idle-waiting hint", () => {
  it("intent result with a prototype block → waiting label at idle; approvePrototype clears it", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await h.start({ cwd: "/work", request: "build a widget" });
    await flush();

    // Drive the intent turn THROUGH the agent-stream event (the live path): the conversation
    // facade renders each frame AND forwards it to the orchestrator's ingestStream. The text
    // frame carries the trailing ---PROTOTYPE--- block; the result frame both (a) drops the
    // facade's session to IDLE and (b) completes the intent turn, so the driver parses the block
    // and dispatches PROTOTYPE_READY → the next snapshot carries pendingPrototype.
    const fire = (payload: unknown): void => {
      for (const fn of H.listeners["agent-stream"] ?? []) fn({ payload });
    };
    const protoJson = JSON.stringify({
      kind: "html",
      paths: [".plan-tree/prototype/index.html"],
      screenshot: null,
      inline_preview: null,
      variants: [],
    });
    fire({
      seq: 1,
      kind: "assistant_text",
      text: `the confirmed intent prose\n\n---PROTOTYPE---\n${protoJson}\n---END-PROTOTYPE---`,
      parent_tool_use_id: "agent-intent",
    });
    fire({ seq: 2, kind: "result", subtype: "success", is_error: false, result: "", num_turns: 1, duration_ms: 1, total_cost_usd: 0, session_id: "s" });
    await flush();

    // The gate is held and the session is IDLE — yet the working indicator shows the waiting
    // label, because onSnapshot propagated the hint to the facade.
    // FALSIFY: drop the setIdleWaitingHint call in main.ts's onSnapshot → no indicator → RED.
    expect(h.snapshot().pendingPrototype).not.toBeNull();
    const label = document.querySelector<HTMLElement>("#conversation-stream .conv-working-label");
    expect(label?.textContent).toBe("Waiting for your input…");

    // Approve resolves the gate: the reducer nulls pendingPrototype, the very next snapshot turns
    // the hint OFF, and the indicator hides (the session is still idle — no new frames fired).
    await h.approvePrototype();
    await flush();
    expect(h.snapshot().pendingPrototype).toBeNull();
    expect(document.querySelector("#conversation-stream .conv-working")).toBeNull();

    await h.cancel();
  });
});
