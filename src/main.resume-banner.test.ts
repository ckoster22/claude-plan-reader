import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 5 — the Resume banner + resume_fallback toast (the frontend resume seam).
//
// When the user opens a plan that belongs to a NON-terminal `.plan-tree/` whose tree_id matches the
// open plan and no orchestration is active, main.ts (detectResumable → renderResumeBanner) shows a
// #resume-banner: a "Resume — <phaseLabel>" button for a resumable phase, or a static muted message
// for a blocked phase. Clicking the button drives getOrchestrator().resume({cwd, ledger}). A
// `resume_fallback` agent-stream frame surfaces a non-blocking #toast.
//
// We fake invoke (so read_plan_tree_file returns a scripted state.json) and install a stub
// OrchestratorHandle (spy `resume`) as the shared singleton via __setOrchestratorForTest, plus
// __setActiveOrchestratorForTest to control isOrchestrationActive(). The orchestrator/plan-tree
// modules are NOT mocked, so the REAL resumeScopeForRoot / treeIsDone / activePhaseLabel run over the
// scripted ledger — the banner's verdict is the production derivation, not a test fiction.
// ---------------------------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
  // The text read_plan_tree_file returns for state.json (per-test), or null for "no file".
  stateJson: null as string | null,
  // Whether a gate artifact read (any non-state.json plan-tree file) resolves to text or null.
  artifactPresent: true,
  // When set, the state.json read REJECTS even for an absolute cwd (models a cwd/IO error in Rust)
  // so the distinct `state.json READ ERROR` diag path can be exercised independently of the ~-case.
  stateReadError: false,
}));

// Model Rust's `valid_plan_tree_name` (plan_tree.rs ~40-75): the `.plan-tree/` channel accepts ONLY a
// fixed set of literal control names plus the `NN-(plan|summary).md` dotted shape. Everything else —
// crucially ABSOLUTE paths (`/...` or `~/...`, the shape a LEAF planPath carries) — is REJECTED. The
// real Rust `read_plan_tree_file` returns Err (which `invoke` surfaces as a rejected Promise) when the
// name fails this allow-list. Mirroring it here is the ANTI-REGRESSION: a leaf/executing rewind that
// (mistakenly) probes `read_plan_tree_file` with its absolute planPath now REJECTS exactly as in
// production, instead of the old mock's blanket "any non-state.json name → text" that hid the bug.
function validPlanTreeName(name: string): boolean {
  if (["state.json", "INTENT.md", "recon.md", "master.md"].includes(name)) return true;
  const idAndStem = name.endsWith(".md") ? name.slice(0, -3) : null;
  if (idAndStem === null) return false;
  const dash = idAndStem.indexOf("-");
  if (dash < 0) return false;
  const id = idAndStem.slice(0, dash);
  const stem = idAndStem.slice(dash + 1);
  if (stem !== "plan" && stem !== "summary") return false;
  return id.split(".").every((seg) => /^\d\d$/.test(seg));
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    const path = (a.path as string) ?? "";
    if (cmd === "read_plan_tree_file") {
      const name = (a.name as string) ?? "";
      // Model Rust's `guarded_plan_tree_path`: it does NOT expand `~`, so a tilde-prefixed cwd is not
      // an existing directory → `is_dir()` is false → the command REJECTS. Mirror that here so an
      // unexpanded `~`-cwd leaking through (the resume-after-restart bug) actually breaks the read,
      // making the banner-visibility assertion a real guard — not just the cwd-equality checks.
      const cwd = (a.cwd as string) ?? "";
      if (cwd.startsWith("~")) {
        return Promise.reject(new Error(`cwd is not an existing directory: ${JSON.stringify(cwd)}`));
      }
      // ALLOW-LIST: a name failing `valid_plan_tree_name` REJECTS in Rust (e.g. an absolute leaf
      // planPath that should have gone through read_plan_contents instead). This makes a mis-routed
      // leaf probe fail here exactly as production does, rather than silently returning text.
      if (!validPlanTreeName(name)) {
        return Promise.reject(new Error(`invalid plan-tree file name: ${JSON.stringify(name)}`));
      }
      if (name === "state.json") {
        if (H.stateReadError) return Promise.reject(new Error("cwd is not an existing directory: \"/gone\""));
        return Promise.resolve(H.stateJson);
      }
      // Any other (allow-listed) name is a DECOMPOSITION gate-artifact existence probe (under
      // `.plan-tree/`).
      return Promise.resolve(H.artifactPresent ? "# plan body\n" : null);
    }
    if (cmd === "read_plan_contents") {
      // The LEAF gate artifact lives in `~/.claude/plans/` and is verified through this command. The
      // real Rust command REJECTS (throws) on a missing/out-of-bounds file — mirror that so a falsy
      // artifactPresent exercises the catch→blocked path, not a resolve(null).
      if (!H.artifactPresent) return Promise.reject(new Error("cannot resolve path: no such file"));
      return Promise.resolve("# plan\n\nbody here\n");
    }
    if (cmd === "read_plan_transcript") {
      // The history loader (conversation/index.ts loadHistoryForPlan) reads this when a plan is opened
      // with no live run. It expects a SHAPED object — a bare undefined makes `res.found` throw an
      // unhandled rejection. Return the explicit "no transcript" shape so the pane settles to empty.
      return Promise.resolve({ found: false, path: null, cwd: null, session_id: null, lines: [] });
    }
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "get_comments") return Promise.resolve([]);
    if (cmd === "get_comment_count") return Promise.resolve(0);
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "hook_status") return Promise.resolve(false);
    void path;
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

import { __resetReviewStateForTest, __setRunPlaceholderForTest, detectResumable } from "./main";
import {
  parseNn,
  toLedger2,
  resumeScopeForRoot,
  activePathOf,
  planName2,
  pathKey,
  type TreeNode,
  type NodeState,
  type NodePath,
  type PlanTreeState2,
  type RecursiveLedger,
  type ResumeScope,
} from "./conversation/plan-tree";
import {
  __setOrchestratorForTest,
  __setActiveOrchestratorForTest,
  __resetOrchestratorForTest,
  type OrchestratorHandle,
} from "./conversation/orchestrator";

// ---- ledger fixtures (mirror resume-rehydrate.test.ts constructors) ---------------------------
const nnOf = (n: number) => parseNn(n);

function node(nn: number, state: NodeState): TreeNode {
  return { nn: nnOf(nn), title: `node ${nn}`, redraftCount: 0, lastFeedback: null, state };
}
function openNode(nn: number, phase: Extract<NodeState, { stage: "open" }>["phase"]): TreeNode {
  return node(nn, { stage: "open", phase });
}
function leafNode(
  nn: number,
  phase: Extract<NodeState, { stage: "leaf" }>["phase"],
  paths: { planPath?: string | null; plansDirPath?: string | null } = {},
): TreeNode {
  return node(nn, {
    stage: "leaf",
    phase,
    planPath: paths.planPath ?? null,
    summaryPath: null,
    plansDirPath: paths.plansDirPath ?? null,
  });
}

// A coherent schema-2 ledger for `root` with the given tree_id, as the on-disk state.json string.
function ledgerJson(root: TreeNode, treeId: string): string {
  const state: PlanTreeState2 = {
    schema: 2,
    tree_id: treeId,
    created_ms: 1,
    updated_ms: 2,
    root,
    sdk_session_id: "sess-42",
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    pendingAcceptance: null,
    parsedChildren: null,
  };
  const ledger: RecursiveLedger = toLedger2(state);
  return JSON.stringify(ledger);
}

// A done tree: a single leaf summarized at the root (treeIsDone → true).
function doneRoot(): TreeNode {
  return node(1, { stage: "leaf", phase: "summarized", planPath: null, summaryPath: null, plansDirPath: null });
}

// A split node (PHASE-4 generic — used to mirror the root single-collapse shape).
function splitNode(
  nn: number,
  phase: Extract<NodeState, { stage: "split" }>["phase"],
  children: [TreeNode, ...TreeNode[]],
  paths: { planPath?: string | null; plansDirPath?: string | null } = {},
): TreeNode {
  return node(nn, {
    stage: "split",
    phase,
    children,
    planPath: paths.planPath ?? null,
    summaryPath: null,
    plansDirPath: paths.plansDirPath ?? null,
  });
}

// The EXACT solar-system ledger shape (the live bug repro): root is a planPath-less
// split/running-children with ONE child "Plan" at leaf/awaiting-approval whose planPath is an
// ABSOLUTE `~/.claude/plans/agent-plan-tree-...md` (NOT a `.plan-tree/` path). The active node is
// that child; resumeScopeForRoot classifies it as a resumable LEAF gate, verified through the plans
// channel. tree_id matches the open plan's tree_id.
const SOLAR_TREE = "tree-mqbsecev-52f1b6c9";
const SOLAR_LEAF_PLAN =
  "/home/u/.claude/plans/agent-plan-tree-mqbsecev-52f1b6c9-00-000000000000000018B8866D18775858.md";
function solarSystemRoot(): TreeNode {
  const child = leafNode(1, "awaiting-approval", {
    planPath: SOLAR_LEAF_PLAN,
    plansDirPath: SOLAR_LEAF_PLAN,
  });
  return splitNode(1, "running-children", [child]); // root planPath null ⇒ root single-collapse
}

// A REAL CHILD leaf (path [01], NOT a root-leaf) mid-EXECUTION. The root is a genuine split with a
// decomposition (planPath "master.md") and TWO children: child [01] at leaf/executing (the active
// node) and a pending right-sibling [02] keeping the split coherent. Child [01]'s planPath is the
// ABSOLUTE `~/.claude/plans/...` file writeAgentPlan wrote (leaves write the plans store, NEVER
// `.plan-tree/`). Because the child is a non-root leaf, planName2([01]) = "01-plan.md" — a file the
// app NEVER writes for a leaf (only decomposition splits write `.plan-tree/` plans). This is the
// shape the OLD code mis-verified through read_plan_tree_file (rejected by the allow-list → blocked).
const EXEC_CHILD_LEAF_PLAN =
  "/home/u/.claude/plans/agent-plan-tree-exec-01-000000000000000018B8866D18775858.md";
function executingChildRoot(): TreeNode {
  const execChild = leafNode(1, "executing", {
    planPath: EXEC_CHILD_LEAF_PLAN,
    plansDirPath: EXEC_CHILD_LEAF_PLAN,
  });
  // A split with a real decomposition (master.md present) and a pending sibling so activePathOf → [01].
  return splitNode(1, "running-children", [execChild, openNode(2, "pending")], {
    planPath: "master.md",
    plansDirPath: "master.md",
  });
}

// ---- DOM boot (mirror main.inproc-review.test.ts) --------------------------------------------
function planRow(absPath: string, stem: string, treeId: string | null, cwd: string | null): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd,
    unread: false,
    flavor: "standalone",
    tree_id: treeId,
    nn: null,
    nn_path: null,
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
        <div class="resume-banner hidden" id="resume-banner">
          <span id="resume-banner-msg"></span>
          <button id="resume-plan-btn" class="hidden">Resume</button>
          <span class="resume-confirm hidden" id="resume-confirm">
            <span id="resume-hazard"></span>
            <button id="resume-confirm-btn">Confirm</button>
            <button id="resume-cancel-btn">Cancel</button>
          </span>
        </div>
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
    <div class="toast hidden" id="toast"></div>
    <div class="conv-modal hidden" id="composer-modal">
      <textarea id="composer-request"></textarea>
      <input id="composer-dir" />
      <button id="composer-choose-dir"></button>
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

// A stub OrchestratorHandle with a spy `resume`. subscribe() is the only method main.ts calls at
// boot; everything else is a benign no-op. resume resolves true by default (a started run).
function makeStubHandle(resumeReturn: boolean | (() => Promise<boolean>) = true): {
  handle: OrchestratorHandle;
  resume: ReturnType<typeof vi.fn>;
} {
  const resume = vi.fn(async (_args: { cwd: string; ledger: RecursiveLedger }) =>
    typeof resumeReturn === "function" ? resumeReturn() : resumeReturn,
  );
  const noop = async () => {};
  const handle = {
    start: vi.fn(async () => true),
    resume,
    snapshot: vi.fn(() => {
      throw new Error("not started");
    }),
    approve: vi.fn(noop),
    requestChanges: vi.fn(noop),
    answerClarify: vi.fn(noop),
    approvePrototype: vi.fn(noop),
    refinePrototype: vi.fn(noop),
    ingestStream: vi.fn(noop),
    ingestPermission: vi.fn(noop),
    cancel: vi.fn(noop),
    subscribe: vi.fn(() => () => {}),
    teardown: vi.fn(noop),
    orchestrationActive: vi.fn(() => false),
    resuming: vi.fn(() => false),
    dispatch: vi.fn(noop),
  } as unknown as OrchestratorHandle;
  return { handle, resume };
}

const PLAN = "/home/u/.claude/plans/p.md";
const CWD = "/work/project";
const TREE = "tree-abc";

describe("Phase 5 — Resume banner", () => {
  beforeEach(() => {
    H.invokeCalls = [];
    H.listeners = {};
    H.rows = [];
    H.stateJson = null;
    H.artifactPresent = true;
    H.stateReadError = false;
    __resetReviewStateForTest();
    __resetOrchestratorForTest();
    __setActiveOrchestratorForTest(null);
    document.body.innerHTML = "";
  });

  // Drive an open of the single plan row and return the banner elements after the async banner read.
  async function openAndSettle(handle?: OrchestratorHandle): Promise<{
    banner: HTMLElement;
    msg: HTMLElement;
    btn: HTMLButtonElement;
    confirmRow: HTMLElement;
    hazard: HTMLElement;
    confirmBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
  }> {
    H.rows = [planRow(PLAN, "p", TREE, CWD)];
    __setOrchestratorForTest(handle ?? makeStubHandle().handle);
    bootDom();
    await flush();
    // Render the sidebar from list_plans, then click the row to open it.
    const row = document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`);
    expect(row, "sidebar row should have rendered from list_plans").not.toBeNull();
    row!.click();
    await flush();
    return {
      banner: document.querySelector<HTMLElement>("#resume-banner")!,
      msg: document.querySelector<HTMLElement>("#resume-banner-msg")!,
      btn: document.querySelector<HTMLButtonElement>("#resume-plan-btn")!,
      confirmRow: document.querySelector<HTMLElement>("#resume-confirm")!,
      hazard: document.querySelector<HTMLElement>("#resume-hazard")!,
      confirmBtn: document.querySelector<HTMLButtonElement>("#resume-confirm-btn")!,
      cancelBtn: document.querySelector<HTMLButtonElement>("#resume-cancel-btn")!,
    };
  }

  it("shows the Resume button with the active phaseLabel for a matching non-terminal ledger (leaf gate)", async () => {
    // leaf/awaiting-approval with an ABSOLUTE `~/.claude/plans/...` planPath → resumable gate; the
    // gate artifact is verified through read_plan_contents (the plans channel), present here.
    H.stateJson = ledgerJson(
      leafNode(1, "awaiting-approval", { planPath: "/home/u/.claude/plans/01.md" }),
      TREE,
    );
    H.artifactPresent = true;
    const { banner, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(btn.textContent).toBe("Resume — Awaiting your approval of the plan");
  });

  it("REGRESSION: solar-system tree (root single-collapse, leaf gate with ABSOLUTE ~/.claude/plans planPath) shows the Resume button", async () => {
    // EXACT live repro: root split/running-children (planPath null) with ONE child leaf/awaiting-
    // approval whose planPath is an absolute ~/.claude/plans/agent-plan-tree-...md file. The OLD code
    // verified the artifact via read_plan_tree_file(cwd, planName2(path)) → "01-plan.md" under
    // `.plan-tree/`, which does not exist for this app → false-negative blocked banner. The fix
    // verifies the REAL absolute path through read_plan_contents → Resume button.
    H.stateJson = ledgerJson(solarSystemRoot(), SOLAR_TREE);
    H.artifactPresent = true;
    H.rows = [planRow(PLAN, "p", SOLAR_TREE, CWD)];
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    bootDom();
    await flush();
    document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`)!.click();
    await flush();
    const banner = document.querySelector<HTMLElement>("#resume-banner")!;
    const btn = document.querySelector<HTMLButtonElement>("#resume-plan-btn")!;
    expect(banner.classList.contains("hidden"), "banner must be visible").toBe(false);
    expect(banner.classList.contains("blocked"), "must NOT be the blocked variant").toBe(false);
    expect(btn.classList.contains("hidden"), "the Resume button must be shown").toBe(false);
    expect(btn.textContent).toBe("Resume — Awaiting your approval of the plan");
    // The artifact was verified through the PLANS channel (read_plan_contents with the absolute LEAF
    // planPath), NOT through read_plan_tree_file (which would 403 on a non-`.plan-tree/` path).
    // (openPlan separately read_plan_contents the OPENED row — so match on the leaf planPath, not just
    // the first read_plan_contents call.)
    const verifyCall = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_contents" && c.args.path === SOLAR_LEAF_PLAN,
    );
    expect(verifyCall, "leaf gate must verify the absolute planPath via read_plan_contents").toBeTruthy();
    // And it must NOT have probed `.plan-tree/` for a leaf plan filename (the old broken path).
    const treeProbe = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_tree_file" && c.args.name !== "state.json",
    );
    expect(treeProbe, "leaf gate must NOT verify via read_plan_tree_file").toBeFalsy();
  });

  it("FALSIFIABILITY: solar-system leaf gate degrades to BLOCKED when the absolute plan file is absent", async () => {
    // Invert the artifact presence: read_plan_contents rejects (file gone) → the gate is no longer
    // resumable → blocked banner, no button. This is the red half of the regression test: if the fix
    // wrongly pointed the check back at `.plan-tree/`, the read_plan_tree_file mock would still return
    // text and this would FAIL (button shown), catching the regression.
    H.stateJson = ledgerJson(solarSystemRoot(), SOLAR_TREE);
    H.artifactPresent = false; // read_plan_contents rejects
    H.rows = [planRow(PLAN, "p", SOLAR_TREE, CWD)];
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    bootDom();
    await flush();
    document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`)!.click();
    await flush();
    const banner = document.querySelector<HTMLElement>("#resume-banner")!;
    const msg = document.querySelector<HTMLElement>("#resume-banner-msg")!;
    const btn = document.querySelector<HTMLButtonElement>("#resume-plan-btn")!;
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(true);
    expect(msg.textContent).toContain("resuming from here isn't supported yet");
  });

  it("shows the Resume button for a resend phase (open/recon) with the recon label", async () => {
    H.stateJson = ledgerJson(openNode(1, "recon"), TREE);
    const { banner, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(btn.textContent).toBe("Resume — Reconnaissance");
  });

  // ---- PHASE 2: the new RESUMABLE kinds render forward-action BUTTONS (not the "coming soon" msg) ----
  //
  // detectResumable previously DOWNGRADED restart/prototype-gate/rewind to a blocked verdict ("…resume
  // coming soon"). These tests assert each now renders a real one-click forward action button with the
  // honest per-kind label. FALSIFIABILITY: revert detectResumable's new-kind branch back to the blocked
  // fall-through and every `btn shown` assertion below goes RED (the button hides; the muted message
  // shows instead).

  it("PHASE 2 restart: open/clarifying-intent renders 'Restart from your original request' button", async () => {
    // GENESIS clarify window → recoveryFor restart{from:"clarify"} → resumable restart. No artifact.
    H.stateJson = ledgerJson(openNode(1, "clarifying-intent"), TREE);
    const { banner, msg, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.classList.contains("blocked"), "must be the resumable (not blocked) variant").toBe(false);
    expect(btn.classList.contains("hidden"), "the forward-action button must be shown").toBe(false);
    expect(btn.textContent).toBe("Restart from your original request");
    expect(msg.textContent ?? "").not.toContain("coming soon");
    expect(msg.textContent ?? "").not.toContain("isn't supported yet");
  });

  it("PHASE 2 prototype-gate: open/prototype-review renders 'Resume — Prototype review' button", async () => {
    // The root prototype-approval window → resume prototype-gate (durable .plan-tree/prototype dir +
    // INTENT.md the driver re-mints). No single-plan artifact verification.
    H.stateJson = ledgerJson(openNode(1, "prototype-review"), TREE);
    const { banner, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.classList.contains("blocked")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(btn.textContent).toBe("Resume — Prototype review");
  });

  it("DEFECT FIX (between-children review): renders 'Resume — Reviewing before the next sub-plan' (resend, NOT a decomposition-gate rewind)", async () => {
    // Root running-children with ONE active child that is split/reviewing (a summarized + a pending
    // grandchild — the between-children window). The active node is the reviewing split, now classified
    // as resend('review') — re-run the in-flight parent-review turn, NOT a rewind to a (consumed)
    // decomposition gate that would dead-end on approve. A resend reads NO plan artifact.
    const reviewing = splitNode(1, "reviewing", [
      leafNode(1, "summarized"),
      openNode(2, "pending"),
    ]);
    H.stateJson = ledgerJson(splitNode(1, "running-children", [reviewing]), TREE);
    H.artifactPresent = false; // a resend is artifact-INDEPENDENT (it re-runs a turn, not a gate)
    const { banner, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.classList.contains("blocked")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(btn.textContent).toBe("Resume — Reviewing before the next sub-plan");
    // FALSIFIABILITY: a resend must NOT probe `.plan-tree/` for a plan artifact (no gate re-presented).
    const treeProbe = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_tree_file" && c.args.name !== "state.json",
    );
    expect(treeProbe, "a resend('review') must not read a plan artifact").toBeFalsy();
    // FALSIFIABILITY: it must NOT read as a rewind button (the buggy dead-ending behavior).
    expect(btn.textContent).not.toContain("Rewind to");
  });

  it("DEFECT FIX (non-root roll-up window): renders 'Resume — Rolling up' (resend, NOT a decomposition-gate rewind)", async () => {
    // Root running-children with child [01] a NON-ROOT roll-up window (its sole grandchild summarized)
    // active, and a pending right-sibling [02] keeping the root coherent. activePathOf → [01];
    // resend('rollup') re-runs the in-flight roll-up summary turn — artifact-independent.
    const rollup = splitNode(1, "running-children", [leafNode(1, "summarized")]);
    H.stateJson = ledgerJson(splitNode(1, "running-children", [rollup, openNode(2, "pending")]), TREE);
    H.artifactPresent = false;
    const { banner, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.classList.contains("blocked")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(btn.textContent).toBe("Resume — Rolling up");
    expect(btn.textContent).not.toContain("Rewind to");
  });

  it("DEFECT FIX (degenerate no-active-node): renders the BLOCKED message, NO button (never a throwing Resume button)", async () => {
    // open/pending root: activePathOf → null, treeIsDone → false (open is never summarized) ⇒ the
    // runtime-degenerate no-active-node case. It is now honestly BLOCKED (no durable artifact; the
    // orchestrator would FATAL on click), so the banner shows the static message and HIDES the button.
    H.stateJson = ledgerJson(openNode(1, "pending"), TREE);
    H.artifactPresent = false;
    const { banner, msg, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.classList.contains("blocked")).toBe(true);
    expect(btn.classList.contains("hidden")).toBe(true);
    expect(msg.textContent).toContain("isn't supported yet");
    // FALSIFIABILITY: no forward-action button text leaks through.
    expect(btn.textContent ?? "").not.toContain("Rewind to");
  });

  it("hides the banner when the ledger is terminal (treeIsDone)", async () => {
    H.stateJson = ledgerJson(doneRoot(), TREE);
    const { banner, btn } = await openAndSettle();
    // FALSIFIABLE: a non-terminal ledger (the recon test above) shows the button; the done tree must hide it.
    expect(banner.classList.contains("hidden")).toBe(true);
    expect(btn.classList.contains("hidden")).toBe(true);
  });

  it("hides the banner when the ledger tree_id mismatches the open plan's tree_id", async () => {
    // The ledger on disk is for a DIFFERENT tree (stale .plan-tree/) — must not light up.
    H.stateJson = ledgerJson(openNode(1, "recon"), "some-other-tree");
    const { banner, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(true);
    expect(btn.classList.contains("hidden")).toBe(true);
  });

  // ---- PHASE 3c: leaf/executing is now a RESUMABLE-but-HAZARDOUS action (confirm-gated) ----
  //
  // P3a made resumeScopeForRoot return a RESUMABLE rewind verdict for leaf/executing whose plan carries
  // `requiresConfirm:true` + `hazard:"edits may be partially applied"` (the in-flight executing turn may
  // have partially applied edits). The banner must (1) offer it as a "Continue implementation" action
  // and (2) NOT fire resume() until the user confirms. These replace the stale "executing → blocked
  // message" assertion (executing is no longer blocked).

  it("leaf/executing renders the hazardous 'Continue implementation' action (resumable, NOT blocked)", async () => {
    H.stateJson = ledgerJson(
      leafNode(1, "executing", { planPath: "/home/u/.claude/plans/01.md" }),
      TREE,
    );
    const { banner, btn, confirmRow } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    // FALSIFIABLE: executing is now resumable — it must NOT be the blocked variant.
    expect(banner.classList.contains("blocked")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(false);
    expect(btn.textContent).toBe("Continue implementation");
    // The confirm row stays collapsed until the user clicks the primary button.
    expect(confirmRow.classList.contains("hidden")).toBe(true);
  });

  it("CROSS-BOUNDARY: a REAL CHILD leaf/executing (path [01], absolute ~/.claude/plans planPath) shows 'Continue implementation', verified via the PLANS channel", async () => {
    // THE PRODUCTION REPRO the old code broke. The rewind's planPath is the child leaf's ABSOLUTE
    // `~/.claude/plans/...` file. The OLD detectResumable verified it through read_plan_tree_file(cwd,
    // planPath) → the Rust allow-list REJECTS an absolute name → null → blocked → the "Continue
    // implementation" button NEVER appeared. The fix routes an absolute planPath through the PLANS
    // channel (read_plan_contents). There is NO `.plan-tree/01-plan.md` on disk for this leaf (leaves
    // write only the plans store) — so a probe of read_plan_tree_file for the leaf plan would (and must)
    // miss. RED before the fix (button hidden / blocked); GREEN after.
    H.stateJson = ledgerJson(executingChildRoot(), TREE);
    H.artifactPresent = true; // the absolute plans-store file IS present (read_plan_contents resolves)
    const { banner, btn, confirmRow } = await openAndSettle();
    expect(banner.classList.contains("hidden"), "banner must be visible").toBe(false);
    expect(banner.classList.contains("blocked"), "must NOT be the blocked variant").toBe(false);
    expect(btn.classList.contains("hidden"), "the Continue button must be shown").toBe(false);
    expect(btn.textContent).toBe("Continue implementation");
    expect(confirmRow.classList.contains("hidden")).toBe(true);
    // The leaf artifact was verified through the PLANS channel with the ABSOLUTE child planPath.
    const verifyCall = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_contents" && c.args.path === EXEC_CHILD_LEAF_PLAN,
    );
    expect(verifyCall, "executing leaf must verify its absolute planPath via read_plan_contents").toBeTruthy();
    // FALSIFIABILITY: it must NOT have probed `.plan-tree/` with the absolute leaf planPath (the old bug)
    // — the only allow-listed `.plan-tree/` read here is state.json (and master.md for the decomposition).
    const badProbe = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_tree_file" && c.args.name === EXEC_CHILD_LEAF_PLAN,
    );
    expect(badProbe, "executing leaf must NOT probe read_plan_tree_file with the absolute planPath").toBeFalsy();
  });

  it("CROSS-BOUNDARY FALSIFIABILITY: the executing child leaf degrades to BLOCKED when its absolute plan file is gone", async () => {
    // Invert artifact presence: read_plan_contents REJECTS (file gone) → not resumable → blocked, no
    // button. If the fix wrongly pointed the check at `.plan-tree/` (the old bug), this would FAIL —
    // but with the allow-list-modeling mock the absolute name rejects regardless, so this stays a clean
    // honest-blocked signal driven by the plans-channel miss.
    H.stateJson = ledgerJson(executingChildRoot(), TREE);
    H.artifactPresent = false; // read_plan_contents rejects (plans-store file absent)
    const { banner, msg, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(true);
    expect(msg.textContent).toContain("resuming from here isn't supported yet");
  });

  it("clicking 'Continue implementation' reveals the confirm step and does NOT resume yet", async () => {
    H.stateJson = ledgerJson(
      leafNode(1, "executing", { planPath: "/home/u/.claude/plans/01.md" }),
      TREE,
    );
    const { handle, resume } = makeStubHandle(true);
    const { btn, confirmRow, hazard } = await openAndSettle(handle);
    expect(btn.classList.contains("hidden")).toBe(false);
    btn.click();
    await flush();
    // The confirm row is now revealed with the hazard text; the primary button is hidden.
    expect(confirmRow.classList.contains("hidden")).toBe(false);
    expect(hazard.textContent).toContain("edits could be duplicated or corrupted");
    expect(btn.classList.contains("hidden")).toBe(true);
    // GATE: resume() must NOT have fired on the first click — only the confirm step did.
    expect(resume).not.toHaveBeenCalled();
  });

  it("confirming the hazardous resume fires getOrchestrator().resume; cancelling does NOT", async () => {
    // FALSIFIABILITY: this is the load-bearing gate test. Remove the `if (requiresConfirm) {…; return;}`
    // guard in resumeFromBanner and the FIRST click resumes without confirm → the post-click
    // `resume not called` assertion below goes RED.
    H.stateJson = ledgerJson(
      leafNode(1, "executing", { planPath: "/home/u/.claude/plans/01.md" }),
      TREE,
    );
    const { handle, resume } = makeStubHandle(true);
    const { btn, confirmRow, confirmBtn, cancelBtn } = await openAndSettle(handle);

    // Step 1 — primary click reveals the confirm step, no resume.
    btn.click();
    await flush();
    expect(resume).not.toHaveBeenCalled();
    expect(confirmRow.classList.contains("hidden")).toBe(false);

    // Step 2a — Cancel aborts: still no resume, confirm row collapses back to the one-click button.
    cancelBtn.click();
    await flush();
    expect(resume).not.toHaveBeenCalled();
    expect(confirmRow.classList.contains("hidden")).toBe(true);
    expect(btn.classList.contains("hidden")).toBe(false);

    // Step 2b — re-open the confirm step and Confirm: NOW resume fires with the parsed ledger + cwd.
    btn.click();
    await flush();
    confirmBtn.click();
    await flush();
    expect(resume).toHaveBeenCalledTimes(1);
    const arg = resume.mock.calls[0][0] as { cwd: string; ledger: RecursiveLedger };
    expect(arg.cwd).toBe(CWD);
    expect(arg.ledger.tree_id).toBe(TREE);
    // FALSIFIABLE: on a successful resume the banner hides.
    expect(document.querySelector<HTMLElement>("#resume-banner")!.classList.contains("hidden")).toBe(true);
  });

  it("FALSIFIABILITY: a NON-hazardous verdict (resend) resumes on the FIRST click — no confirm step", async () => {
    // The confirm gate is hazard-specific: an ordinary resumable verdict (recon resend, requiresConfirm
    // absent) must keep its one-click behavior. If the gate wrongly fired for every verdict, resume()
    // would NOT be called here and this would go RED.
    H.stateJson = ledgerJson(openNode(1, "recon"), TREE);
    const { handle, resume } = makeStubHandle(true);
    const { btn, confirmRow } = await openAndSettle(handle);
    expect(btn.textContent).toBe("Resume — Reconnaissance");
    btn.click();
    await flush();
    expect(confirmRow.classList.contains("hidden")).toBe(true); // never revealed
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("degrades a resumable gate to the blocked message when the gate artifact is missing on disk", async () => {
    H.stateJson = ledgerJson(
      leafNode(1, "awaiting-approval", { planPath: "/home/u/.claude/plans/01.md" }),
      TREE,
    );
    H.artifactPresent = false; // the plan file is gone → not actually resumable
    const { banner, msg, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(btn.classList.contains("hidden")).toBe(true);
    expect(msg.textContent).toContain("resuming from here isn't supported yet");
  });

  it("clicking Resume calls getOrchestrator().resume with the parsed ledger + cwd", async () => {
    H.stateJson = ledgerJson(openNode(1, "recon"), TREE);
    const { handle, resume } = makeStubHandle(true);
    __setOrchestratorForTest(handle);
    H.rows = [planRow(PLAN, "p", TREE, CWD)];
    bootDom();
    await flush();
    document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`)!.click();
    await flush();
    const btn = document.querySelector<HTMLButtonElement>("#resume-plan-btn")!;
    expect(btn.classList.contains("hidden")).toBe(false);
    btn.click();
    await flush();
    expect(resume).toHaveBeenCalledTimes(1);
    const arg = resume.mock.calls[0][0] as { cwd: string; ledger: RecursiveLedger };
    expect(arg.cwd).toBe(CWD);
    expect(arg.ledger.tree_id).toBe(TREE);
    expect(arg.ledger.root.state.stage).toBe("open");
    // FALSIFIABLE: on a successful resume the banner hides.
    expect(document.querySelector<HTMLElement>("#resume-banner")!.classList.contains("hidden")).toBe(true);
  });

  it("hides the banner (no resume offered) when an orchestration is already active", async () => {
    H.stateJson = ledgerJson(openNode(1, "recon"), TREE);
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    __setActiveOrchestratorForTest(handle); // isOrchestrationActive() → true
    H.rows = [planRow(PLAN, "p", TREE, CWD)];
    bootDom();
    await flush();
    document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`)!.click();
    await flush();
    expect(document.querySelector<HTMLElement>("#resume-banner")!.classList.contains("hidden")).toBe(true);
  });

  it("INVARIANT: a home-collapsed (~) cwd is EXPANDED to absolute before the plan-tree read", async () => {
    // Repro of the resume-after-restart bug: patchAllCwds syncs the home-COLLAPSED display string onto
    // rec.cwd (so the sidebar filter matches the visible ~-form). resolvedCwdFor must expand it back to
    // an ABSOLUTE path before read_plan_tree_file (which does NOT expand ~), else Rust is_dir()-fails
    // and the banner silently never appears. homeDir() is mocked to "/home/u", so a record with
    // cwd "~/project" MUST drive read_plan_tree_file with cwd "/home/u/project" — never the ~-form.
    H.stateJson = ledgerJson(openNode(1, "recon"), TREE);
    H.rows = [planRow(PLAN, "p", TREE, "~/project")];
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    bootDom();
    await flush();
    document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`)!.click();
    await flush();

    const stateRead = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_tree_file" && c.args.name === "state.json",
    );
    expect(stateRead, "the state.json read must have fired").toBeTruthy();
    // The load-bearing assertion: the cwd handed to Rust is the ABSOLUTE expansion, not the ~-path.
    expect(stateRead!.args.cwd).toBe("/home/u/project");
    expect(String(stateRead!.args.cwd).startsWith("~")).toBe(false);
    // End-to-end guard: the invoke mock REJECTS a ~-prefixed cwd (mirroring Rust's is_dir() failure),
    // so the banner is visible ONLY because the cwd was expanded to absolute. If the ~ leaked through,
    // the read would reject → no banner → this assertion fails too (not just the cwd-equality checks).
    expect(document.querySelector<HTMLElement>("#resume-banner")!.classList.contains("hidden")).toBe(
      false,
    );
  });

  it("a state.json READ ERROR degrades to no-banner via the DISTINCT diag (not the anonymous outer catch)", async () => {
    // An absolute cwd whose read_plan_tree_file(state.json) REJECTS (cwd/IO error) must degrade to no
    // banner AND emit the distinct `state.json READ ERROR` diag — so a future cwd failure here is
    // visible in the dev log, not silently absorbed by the outer catch as "UNEXPECTED ERROR".
    H.stateReadError = true; // reject even for the absolute cwd
    const { banner, btn } = await openAndSettle();
    expect(banner.classList.contains("hidden")).toBe(true);
    expect(btn.classList.contains("hidden")).toBe(true);
    // diag() forwards to invoke("diag_log", {msg}); assert the DISTINCT read-error diag fired and the
    // anonymous outer-catch diag did NOT (proving the inner try/catch caught it, not the outer one).
    const diagMsgs = H.invokeCalls
      .filter((c) => c.cmd === "diag_log")
      .map((c) => String(c.args.msg ?? ""));
    expect(diagMsgs.some((m) => m.includes("state.json READ ERROR"))).toBe(true);
    expect(diagMsgs.some((m) => m.includes("UNEXPECTED ERROR"))).toBe(false);
  });

  it("detectResumable returns null when there is no state.json (no .plan-tree)", async () => {
    H.stateJson = null;
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    bootDom();
    await flush();
    const verdict = await detectResumable(
      planRow(PLAN, "p", TREE, CWD) as unknown as Parameters<typeof detectResumable>[0],
    );
    expect(verdict).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// CROSS-BOUNDARY SYMMETRY — the banner (detectResumable, main.ts) and the engine
// (resumeScopeForRoot, orchestrator.resume) MUST classify a persisted `open/decomposing` node
// IDENTICALLY, because both are disk-probe driven: gate (re-present the decomposition gate) when
// planName2(activePath) exists under `.plan-tree/`, resend("decompose") when it is absent. Before
// the fix the banner omitted the predicate and ALWAYS resent — diverging from the engine whenever
// the artifact was present.
//
// FALSIFIABILITY: the present-case engine expectation is the decomposition GATE. If the banner side
// stopped passing the disk-probe predicate (the bug this fixes), detectResumable would degrade the
// present case to resend("decompose") and the "banner === engine (present)" assertion below would go
// RED while the absent case stayed green — exactly the divergence the symmetry test exists to catch.
// ---------------------------------------------------------------------------------------------
describe("Cross-boundary — banner and engine agree for open/decomposing", () => {
  beforeEach(() => {
    H.invokeCalls = [];
    H.listeners = {};
    H.rows = [];
    H.stateJson = null;
    H.artifactPresent = true;
    H.stateReadError = false;
    __resetReviewStateForTest();
    __resetOrchestratorForTest();
    __setActiveOrchestratorForTest(null);
    document.body.innerHTML = "";
  });

  // The engine's classification of a root open/decomposing node, given a disk-probe answer.
  function engineScope(root: TreeNode, artifactPresent: boolean): ResumeScope {
    const active = activePathOf(root)!;
    const pred = (p: NodePath): boolean =>
      pathKey(p) === pathKey(active) ? artifactPresent : false;
    return resumeScopeForRoot(root, undefined, pred);
  }

  // Drive detectResumable for a root open/decomposing ledger with the gate-artifact probe scripted
  // present/absent (the mock returns text for any non-state.json plan-tree read iff artifactPresent).
  async function bannerVerdict(root: TreeNode, artifactPresent: boolean) {
    H.stateJson = ledgerJson(root, TREE);
    H.artifactPresent = artifactPresent;
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    bootDom();
    await flush();
    return detectResumable(
      planRow(PLAN, "p", TREE, CWD) as unknown as Parameters<typeof detectResumable>[0],
    );
  }

  it("artifact PRESENT → both yield the decomposition gate", async () => {
    const root = openNode(1, "decomposing");

    // Engine side: the decomposition GATE (re-present, no re-draft).
    const engine = engineScope(root, true);
    expect(engine).toEqual({
      resumable: true,
      plan: {
        kind: "gate",
        gateKind: "decomposition",
        path: [],
        planPath: planName2([]),
        plansDirPath: null,
        redraftCount: 0,
      },
      phaseLabel: "Decomposing",
    } satisfies ResumeScope);

    // Banner side: same classification — a resumable decomposition gate (NOT a resend). The verdict
    // carries cwd/ledger on top of the scope, so assert the load-bearing scope fields.
    const verdict = await bannerVerdict(root, true);
    expect(verdict).not.toBeNull();
    expect(verdict!.resumable).toBe(true);
    if (!verdict!.resumable) throw new Error("unreachable");
    expect(verdict!.plan.kind).toBe("gate");
    if (verdict!.plan.kind !== "gate") throw new Error("unreachable");
    expect(verdict!.plan.gateKind).toBe("decomposition");
    // BANNER === ENGINE: the plan derived by the banner equals the engine's plan for this case.
    expect(verdict!.plan).toEqual(engine.resumable ? engine.plan : null);
    expect(verdict!.phaseLabel).toBe(engine.phaseLabel);
  });

  it("artifact ABSENT → both yield resend('decompose')", async () => {
    const root = openNode(1, "decomposing");

    // Engine side: resend the decompose step fresh.
    const engine = engineScope(root, false);
    expect(engine).toEqual({
      resumable: true,
      plan: { kind: "resend", awaiting: "decompose", path: [] },
      phaseLabel: "Decomposing",
    } satisfies ResumeScope);

    // Banner side: same — a resumable resend("decompose").
    const verdict = await bannerVerdict(root, false);
    expect(verdict).not.toBeNull();
    expect(verdict!.resumable).toBe(true);
    if (!verdict!.resumable) throw new Error("unreachable");
    expect(verdict!.plan.kind).toBe("resend");
    if (verdict!.plan.kind !== "resend") throw new Error("unreachable");
    expect(verdict!.plan.awaiting).toBe("decompose");
    // BANNER === ENGINE for the absent case.
    expect(verdict!.plan).toEqual(engine.resumable ? engine.plan : null);
    expect(verdict!.phaseLabel).toBe(engine.phaseLabel);
  });
});

describe("Phase 5 — resume_fallback toast", () => {
  beforeEach(() => {
    H.invokeCalls = [];
    H.listeners = {};
    H.rows = [];
    H.stateJson = null;
    H.artifactPresent = true;
    H.stateReadError = false;
    __resetReviewStateForTest();
    __resetOrchestratorForTest();
    __setActiveOrchestratorForTest(null);
    document.body.innerHTML = "";
  });

  it("renders the toast when a resume_fallback agent-stream frame arrives", async () => {
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    bootDom();
    await flush();
    const toast = document.querySelector<HTMLElement>("#toast")!;
    expect(toast.classList.contains("hidden")).toBe(true);
    // Fire the frame through main.ts's agent-stream subscriber.
    for (const h of H.listeners["agent-stream"] ?? []) {
      h({ payload: { seq: 1, kind: "resume_fallback", reason: "transcript expired" } });
    }
    await flush();
    expect(toast.classList.contains("hidden")).toBe(false);
    expect(toast.textContent).toContain("re-running the current step fresh");
  });

  it("does NOT render the toast for a non-resume_fallback agent-stream frame", async () => {
    // FALSIFIABLE: only resume_fallback shows the toast; an ordinary result frame must not.
    const { handle } = makeStubHandle();
    __setOrchestratorForTest(handle);
    bootDom();
    await flush();
    const toast = document.querySelector<HTMLElement>("#toast")!;
    for (const h of H.listeners["agent-stream"] ?? []) {
      h({ payload: { seq: 2, kind: "result", is_error: false } });
    }
    await flush();
    expect(toast.classList.contains("hidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 4b — synthetic "resume" sidebar rows (plan-tree-resume:// sentinel).
//
// `list_plans` synthesizes a childless master `PlanRecord` for a mid-decompose tree with NO plan
// `.md` file yet; its `absolute_path` is the SENTINEL `plan-tree-resume://<tree_id>` (no file behind
// it). Opening such a row must: (a) NOT call read_plan_contents for the sentinel (it would reject —
// no file), (b) render a graceful placeholder pane (prefer the tree's INTENT.md, else a static note),
// and (c) still surface the resume banner with the forward action (the banner reads the row's cwd +
// state.json, independent of the absolute_path being a real file). See CONTRACT.md §"Amendment
// 2026-06-17 — Synthetic resume sidebar rows".
// ---------------------------------------------------------------------------------------------

const SENTINEL_TREE = "tree-synth-01";
const SENTINEL_PATH = `plan-tree-resume://${SENTINEL_TREE}`;
const SENTINEL_TITLE = "Build the WebGL floor-plan renderer";

// A synthetic-row PlanRecord exactly as the backend mints it: childless MASTER, sentinel path, cwd
// set, title riding h1s[0], no nn/nn_path.
function sentinelRow(): Record<string, unknown> {
  return {
    absolute_path: SENTINEL_PATH,
    filename_stem: SENTINEL_TREE, // tree_id (display-incidental)
    mtime_ms: 5,
    cwd: CWD,
    unread: false,
    flavor: "master",
    tree_id: SENTINEL_TREE,
    nn: null,
    nn_path: null,
    child_count: 0,
    collapsed: false,
    h1s: [SENTINEL_TITLE],
  };
}

describe("Phase 4b — synthetic resume sentinel rows", () => {
  beforeEach(() => {
    H.invokeCalls = [];
    H.listeners = {};
    H.rows = [];
    H.stateJson = null;
    H.artifactPresent = true;
    H.stateReadError = false;
    __resetReviewStateForTest();
    __resetOrchestratorForTest();
    __setActiveOrchestratorForTest(null);
    document.body.innerHTML = "";
  });

  // Boot with a single sentinel row, render the sidebar, click it open, and return the key elements.
  async function openSentinel(): Promise<{
    banner: HTMLElement;
    msg: HTMLElement;
    btn: HTMLButtonElement;
    pane: HTMLElement;
    row: HTMLElement;
  }> {
    H.rows = [sentinelRow()];
    __setOrchestratorForTest(makeStubHandle().handle);
    bootDom();
    await flush();
    const row = document.querySelector<HTMLElement>(`[data-path="${SENTINEL_PATH}"]`);
    expect(row, "synthetic sentinel row should render in the sidebar").not.toBeNull();
    row!.click();
    await flush();
    return {
      banner: document.querySelector<HTMLElement>("#resume-banner")!,
      msg: document.querySelector<HTMLElement>("#resume-banner-msg")!,
      btn: document.querySelector<HTMLButtonElement>("#resume-plan-btn")!,
      pane: document.querySelector<HTMLElement>("#reading-pane")!,
      row: row!,
    };
  }

  it("surfaces the resume banner with a forward action when opening a sentinel row", async () => {
    // open/recon → resumable resend → "Resume — Reconnaissance" forward-action button. The banner
    // derives from the row's cwd + state.json — NOT from the (non-file) absolute_path.
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    const { banner, btn } = await openSentinel();
    expect(banner.classList.contains("hidden"), "banner must be visible").toBe(false);
    expect(banner.classList.contains("blocked"), "must be the resumable variant").toBe(false);
    expect(btn.classList.contains("hidden"), "the forward-action button must be shown").toBe(false);
    expect(btn.textContent).toBe("Resume — Reconnaissance");
  });

  it("does NOT call read_plan_contents for the sentinel path", async () => {
    // The sentinel has no file — read_plan_contents would reject. Opening it must never invoke that
    // command with the sentinel path. FALSIFIABLE: drop the sentinel guard in openPlan's read branch
    // and this records a read_plan_contents call for SENTINEL_PATH → the assertion goes RED.
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    await openSentinel();
    const sentinelRead = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_contents" && c.args.path === SENTINEL_PATH,
    );
    expect(sentinelRead, "read_plan_contents must never be called for the sentinel path").toBeFalsy();
    // Nor set_open_plan / mark_viewed (both reject a sentinel path Rust-side).
    const sentinelOpen = H.invokeCalls.find(
      (c) =>
        (c.cmd === "set_open_plan" || c.cmd === "mark_viewed") && c.args.path === SENTINEL_PATH,
    );
    expect(sentinelOpen, "set_open_plan/mark_viewed must never run for the sentinel path").toBeFalsy();
  });

  it("renders the tree's INTENT.md into the pane when readable", async () => {
    // The mock's read_plan_tree_file returns text for the allow-listed INTENT.md (artifactPresent),
    // so the placeholder pane renders that markdown, not the static fallback. The render must not
    // throw and must have read INTENT.md via the plan-tree channel (cwd set, name "INTENT.md").
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    H.artifactPresent = true;
    const { pane } = await openSentinel();
    const intentRead = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_tree_file" && c.args.name === "INTENT.md" && c.args.cwd === CWD,
    );
    expect(intentRead, "the sentinel pane should read INTENT.md from the tree's cwd").toBeTruthy();
    // The mock INTENT.md body is "# plan body\n" → renders into the pane (non-empty, no crash).
    expect(pane.textContent ?? "").toContain("plan body");
  });

  it("renders a static in-progress placeholder when INTENT.md is absent", async () => {
    // FALSIFIABLE: with INTENT.md absent (artifactPresent=false → read_plan_tree_file resolves null),
    // the pane must fall back to the static note rather than crash or stay empty.
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    H.artifactPresent = false;
    const { pane } = await openSentinel();
    expect(pane.textContent ?? "").toContain("This plan is in progress");
  });

  it("shows the tree's h1 title (not the tree_id stem) on the sidebar row and in the reader header", async () => {
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    const { row } = await openSentinel();
    const title = row.querySelector<HTMLElement>(".plan-title");
    expect(title?.textContent, "sidebar row title rides h1s[0]").toBe(SENTINEL_TITLE);
    const filename = document.querySelector<HTMLElement>("#doc-filename");
    expect(filename?.textContent, "reader header shows the title, not <tree_id>.md").toBe(SENTINEL_TITLE);
    // And the reader header cwd comes from the record's cwd (home-collapsed), not an empty resolve.
    const src = document.querySelector<HTMLElement>("#doc-src");
    expect(src?.textContent ?? "", "reader header cwd derives from the record cwd").toContain("project");
  });

  // Concern 3 (LOW) — opening a sentinel must NOT fire the conversation-history corpus scan. The
  // sentinel's `stem` is the tree_id (not a transcript-resolvable filename stem), so loadPlanHistory
  // would issue a read_plan_transcript that always misses and paints a misleading empty Conversation
  // tab. FALSIFIABLE: drop the `if (!sentinel)` guard on the loadPlanHistory call in openPlan and this
  // records a read_plan_transcript invoke → the assertion goes RED.
  it("does NOT scan the transcript (loadPlanHistory) when opening a sentinel row", async () => {
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    await openSentinel();
    const transcriptScan = H.invokeCalls.find((c) => c.cmd === "read_plan_transcript");
    expect(
      transcriptScan,
      "read_plan_transcript must never run for a sentinel (its stem is a tree_id, not a transcript)",
    ).toBeFalsy();
  });

  // Concern 1 (MEDIUM) — stuck banner / dangling openPath when the OPEN sentinel vanishes from the
  // list via a NON-resume path (tree finished elsewhere, or a real row replaced it) with NO live-run
  // placeholder taking over. refreshList must reset to the empty pane: banner hidden, no stale
  // `.active` row. FALSIFIABLE: remove the resetToEmptyPane() call in refreshList and the banner stays
  // visible over the dangling sentinel → both assertions go RED.
  it("clears the banner and the active row when an open sentinel vanishes from the list", async () => {
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    const { banner } = await openSentinel();
    // Precondition: the banner is up and the sentinel row is the active one.
    expect(banner.classList.contains("hidden"), "banner shown before the sentinel vanishes").toBe(false);
    expect(
      document.querySelector(`[data-path="${SENTINEL_PATH}"].active`),
      "sentinel row is active before it vanishes",
    ).not.toBeNull();

    // The tree finishes elsewhere: list_plans no longer returns the synthetic row. Drive a
    // `plan-changed` event (some unrelated real file changed) → handlePlanChanged → refreshList.
    H.rows = [];
    const handlers = H.listeners["plan-changed"] ?? [];
    expect(handlers.length, "main.ts registered a plan-changed listener").toBeGreaterThan(0);
    for (const h of handlers) h({ payload: { path: "/home/u/.claude/plans/unrelated.md" } });
    await flush();

    expect(banner.classList.contains("hidden"), "banner cleared once the sentinel is gone").toBe(true);
    expect(
      document.querySelector(".plan.active"),
      "no stale active row remains after the sentinel vanishes",
    ).toBeNull();
    expect(
      document.querySelector<HTMLElement>("#reading-pane .empty-state"),
      "pane resets to the select-a-plan empty state",
    ).not.toBeNull();
  });

  // The happy resume→placeholder takeover must NOT be disrupted: when a live-run placeholder for the
  // same tree exists, the sentinel legitimately disappears as the placeholder stands in. refreshList
  // must NOT reset the pane in that case. FALSIFIABLE: drop the `placeholderStandsIn` guard and this
  // test reds (the banner/pane would be cleared out from under the live run).
  it("does NOT reset the pane when a live-run placeholder takes over the vanished sentinel", async () => {
    H.stateJson = ledgerJson(openNode(1, "recon"), SENTINEL_TREE);
    const { banner } = await openSentinel();
    expect(banner.classList.contains("hidden"), "banner shown before takeover").toBe(false);

    // Orchestrator minted a live-run placeholder for THIS tree (the happy resume path); the synthetic
    // row drops out of list_plans because the placeholder now stands in for it.
    __setRunPlaceholderForTest({ treeId: SENTINEL_TREE, label: "Resuming…" }, true);
    H.rows = [];
    const handlers = H.listeners["plan-changed"] ?? [];
    for (const h of handlers) h({ payload: { path: "/home/u/.claude/plans/unrelated.md" } });
    await flush();

    // openPath was left intact (no reset): the sentinel pane was NOT yanked to the empty state.
    expect(
      document.querySelector<HTMLElement>("#reading-pane .empty-state"),
      "pane must NOT reset while the placeholder stands in",
    ).toBeNull();
  });
});
