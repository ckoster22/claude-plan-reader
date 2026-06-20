// Multiplan orchestration domain (Sub-Plan 03) — RESUME driver tests (Phase 3, falsifiable).
//
// These tests exercise the orchestrator's resume() entry with a FAKE OrchestratorDeps (no Tauri, no
// listen, no DOM). For every RESUMABLE active phase we build a coherent ledger in that phase, call
// resume({cwd, ledger}), and assert the resume contract:
//   (a) NO resetPlanTreeDir call (resume must not archive the prior tree),
//   (b) NO START dispatch (the tree is seeded from disk, not freshly created),
//   (c) the session-open dep received resumeSessionId === ledger.sdk_session_id,
//   (d) the right action: gate phases fire onAwaitingApproval with a gate whose resolved planPath
//       matches the expected artifact AND send NO message; resend phases send the correct prompt AND
//       arm the matching awaiting tag (observed via the next live-frame boundary).
//
// Plus: summaries/mandates reload (a re-sent recon/draft prompt CONTAINS a prior sibling's summary
// text — falsifiable by no-op'ing the reload), and resumed-gate approval (the continuation prompt is
// sent and the permission-resolve dep is NOT called against the dead synthetic id).
//
// Falsifiability is load-bearing: each behavioral assertion goes RED if the behavior is inverted
// (notes inline).

import { describe, it, expect, vi } from "vitest";

import {
  createOrchestrator,
  reconPrompt,
  sizerPrompt,
  subReconPrompt,
  masterDraftPrompt,
  resumedLeafApprovalPrompt,
  resumedLeafContinuePrompt,
  intentPrompt,
  rollupSummaryPrompt,
  parentReviewPrompt,
  type OrchestratorDeps,
  type OrchestratorObserver,
} from "./orchestrator";
import {
  parseNn,
  pathKey,
  nonEmpty,
  toLedger2,
  activePathOf,
  summaryName2,
  type TreeNode,
  type NodeState,
  type NodePath,
  type PlanTreeState2,
  type RecursiveLedger,
  type PlanTreeFilePath,
  type ApprovalGate2,
  type AcceptanceGate,
  type PrototypeGate,
} from "./plan-tree";

vi.mock("./diag", () => ({ diag: vi.fn() }));

// ---- tree fixtures (coherent by construction; mirror resume-rehydrate.test.ts) ----------------

const nnOf = (n: number) => parseNn(n);
const path = (...ns: number[]): NodePath => ns.map(nnOf);
const fileOf = (s: string) => s as PlanTreeFilePath;

function node(nn: number, title: string, state: NodeState): TreeNode {
  return { nn: nnOf(nn), title, redraftCount: 0, lastFeedback: null, state };
}
function openNode(nn: number, phase: Extract<NodeState, { stage: "open" }>["phase"], title = `node ${nn}`): TreeNode {
  return node(nn, title, { stage: "open", phase });
}
function leafNode(
  nn: number,
  phase: Extract<NodeState, { stage: "leaf" }>["phase"],
  paths: { planPath?: string | null; summaryPath?: PlanTreeFilePath | null; plansDirPath?: string | null } = {},
  title = `node ${nn}`,
): TreeNode {
  return node(nn, title, {
    stage: "leaf",
    phase,
    planPath: paths.planPath ?? null,
    summaryPath: paths.summaryPath ?? null,
    plansDirPath: paths.plansDirPath ?? null,
  });
}
function splitNode(
  nn: number,
  phase: Extract<NodeState, { stage: "split" }>["phase"],
  children: readonly TreeNode[],
  paths: { planPath?: string | null; summaryPath?: PlanTreeFilePath | null; plansDirPath?: string | null } = {},
  title = `node ${nn}`,
): TreeNode {
  return node(nn, title, {
    stage: "split",
    phase,
    children: nonEmpty(children),
    planPath: paths.planPath ?? null,
    summaryPath: paths.summaryPath ?? null,
    plansDirPath: paths.plansDirPath ?? null,
  });
}

// Build a coherent ledger from a root node, stamping a known sdk_session_id + title so resume() can
// be asserted against them. JSON round-tripped (the exact disk shape a resume reads).
function ledgerOf(
  root: TreeNode,
  sessionId: string | undefined = "sess-99",
  title = "the original request",
  extra: Partial<Pick<RecursiveLedger, "baseline_" | "acceptance_">> = {},
): RecursiveLedger {
  const state: PlanTreeState2 = {
    schema: 2,
    tree_id: "tree-resume",
    created_ms: 1,
    updated_ms: 2,
    root: { ...root, title: root.title === "" ? title : root.title },
    sdk_session_id: sessionId,
    baseline_: extra.baseline_,
    acceptance_: extra.acceptance_,
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    pendingAcceptance: null,
    parsedChildren: null,
  };
  // The ROOT carries the request title (ledger.root.title is what resume() uses as `request`).
  const rootWithTitle: TreeNode = { ...state.root, title };
  const withRootTitle: PlanTreeState2 = { ...state, root: rootWithTitle };
  const ledger = toLedger2(withRootTitle);
  return JSON.parse(JSON.stringify(ledger)) as RecursiveLedger;
}

// ---- recording fake deps ----------------------------------------------------------------------

interface Recorded {
  calls: string[];
  startSession: Array<{ cwd: string; permissionMode: string; resumeSessionId?: string }>;
  sendMessage: string[];
  setMode: string[];
  resetPlanTreeDir: string[];
  resolvePermission: Array<{ id: string; allow: boolean; message?: string }>;
  writePlanTreeFile: Array<{ name: string; contents: string }>;
  readRequests: string[];
  planContentsRequests: string[];
  openBaseline: Array<{ cwd: string; path: string }>;
}

// Model Rust's `valid_plan_tree_name` (plan_tree.rs ~40-75) so the fake `readPlanTreeFile` REJECTS the
// exact names the real command rejects — crucially ABSOLUTE leaf planPaths. This is the anti-regression:
// a leaf/executing continuation that (wrongly) reads its durable plan through the `.plan-tree/` channel
// keyed by the absolute planPath now THROWS here, exactly as production does, instead of the old fake's
// "any name in readMap, else null" that silently masked the mis-routed read.
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

// `readMap` keys `.plan-tree/` names (read via readPlanTreeFile); `plansMap` keys ABSOLUTE plans-store
// paths (read via readPlanContents — a LEAF's durable plan lives here, never `.plan-tree/`).
function makeDeps(
  readMap: Record<string, string> = {},
  plansMap: Record<string, string> = {},
): { deps: OrchestratorDeps; rec: Recorded } {
  const rec: Recorded = {
    calls: [],
    startSession: [],
    sendMessage: [],
    setMode: [],
    resetPlanTreeDir: [],
    resolvePermission: [],
    writePlanTreeFile: [],
    readRequests: [],
    planContentsRequests: [],
    openBaseline: [],
  };
  const deps: OrchestratorDeps = {
    startSession: vi.fn(async (args) => {
      rec.calls.push(`startSession:${args.cwd}:${args.permissionMode}:${args.resumeSessionId ?? "none"}`);
      rec.startSession.push(args);
    }),
    sendMessage: vi.fn(async (text) => {
      rec.calls.push(`sendMessage:${text.slice(0, 40)}`);
      rec.sendMessage.push(text);
    }),
    setMode: vi.fn(async (mode) => {
      rec.calls.push(`setMode:${mode}`);
      rec.setMode.push(mode);
    }),
    resolvePermission: vi.fn(async (args) => {
      rec.calls.push(`resolvePermission:${args.id}:${args.allow}`);
      rec.resolvePermission.push({ id: args.id, allow: args.allow, message: args.message });
    }),
    cancelRun: vi.fn(async () => {
      rec.calls.push("cancelRun");
    }),
    interrupt: vi.fn(async () => {
      rec.calls.push("interrupt");
    }),
    endSession: vi.fn(async () => {
      rec.calls.push("endSession");
    }),
    writePlanTreeFile: vi.fn(async (_cwd, name, contents) => {
      rec.calls.push(`writePlanTreeFile:${name}`);
      rec.writePlanTreeFile.push({ name, contents });
      return `/abs/.plan-tree/${name}`;
    }),
    readPlanTreeFile: vi.fn(async (_cwd, name) => {
      rec.calls.push(`readPlanTreeFile:${name}`);
      rec.readRequests.push(name);
      // ALLOW-LIST: the real Rust command REJECTS a name failing valid_plan_tree_name (e.g. an absolute
      // leaf planPath mis-routed through this channel). Mirror that throw so the bug cannot hide.
      if (!validPlanTreeName(name)) {
        throw new Error(`invalid plan-tree file name: ${JSON.stringify(name)}`);
      }
      return name in readMap ? readMap[name] : null;
    }),
    readPlanContents: vi.fn(async (path: string) => {
      rec.calls.push(`readPlanContents:${path}`);
      rec.planContentsRequests.push(path);
      // The real read_plan_contents RESOLVES the text or REJECTS (throws) on a missing/out-of-bounds
      // path — it never resolves null. Mirror that: absent path ⇒ throw.
      if (path in plansMap) return plansMap[path];
      throw new Error(`cannot resolve path: ${JSON.stringify(path)}`);
    }),
    writeAgentPlan: vi.fn(async (_plan, _treeId, nn) => {
      rec.calls.push(`writeAgentPlan:${nn}`);
      return `/abs/plans/${nn}.md`;
    }),
    resetPlanTreeDir: vi.fn(async (cwd) => {
      rec.calls.push(`resetPlanTreeDir:${cwd}`);
      rec.resetPlanTreeDir.push(cwd);
    }),
    ensurePrototypeDir: vi.fn(async (cwd) => {
      rec.calls.push(`ensurePrototypeDir:${cwd}`);
      return `${cwd}/.plan-tree/prototype`;
    }),
    openBaseline: vi.fn(async (cwd, path) => {
      rec.calls.push(`openBaseline:${cwd}:${path}`);
      rec.openBaseline.push({ cwd, path });
    }),
  };
  return { deps, rec };
}

interface ObsRec {
  obs: OrchestratorObserver;
  awaiting: ApprovalGate2[];
  acceptances: AcceptanceGate[];
  prototypes: PrototypeGate[];
  done: number;
  snapshots: number;
  fatal: string[];
}
function makeObserver(): ObsRec {
  const rec: ObsRec = { awaiting: [], acceptances: [], prototypes: [], done: 0, snapshots: 0, fatal: [], obs: {} };
  rec.obs = {
    onSnapshot: () => {
      rec.snapshots++;
    },
    onAwaitingApproval: (g) => rec.awaiting.push(g),
    onAcceptanceReview: (g) => rec.acceptances.push(g),
    onPrototypeReview: (g) => rec.prototypes.push(g),
    onDone: () => {
      rec.done++;
    },
    onFatal: (m) => rec.fatal.push(m),
  };
  return rec;
}

// Scripted live frames so we can probe the ARMED awaiting variant after a resend (the only way to
// observe `awaiting` from outside the handle — feed the matching boundary and watch the next step).
let seqCounter = 0;
const nextSeq = () => ++seqCounter;
function textFrame(text: string): import("./types").AssistantText {
  return { seq: nextSeq(), kind: "assistant_text", text, parent_tool_use_id: null };
}
function resultFrame(): import("./types").ResultMsg {
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

async function flush(n = 32): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ===============================================================================================
// resume() — the resumable phases
// ===============================================================================================

describe("resume() — no reset, no START, forwards resumeSessionId", () => {
  it("open/recon (root): resends reconPrompt, arms recon, forwards session id, no reset/START", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const ledger = ledgerOf(openNode(1, "recon"), "sess-abc", "build a game");

    const started = await h.resume({ cwd: "/work", ledger });
    expect(started).toBe(true);

    // (a) NO resetPlanTreeDir
    expect(rec.resetPlanTreeDir).toEqual([]);
    // (b) NO START dispatch → the tree_id is the ledger's (a START would mint a fresh tree-... id)
    expect(h.snapshot().treeId).toBe("tree-resume");
    // (c) session-open got resumeSessionId === ledger.sdk_session_id
    expect(rec.startSession).toHaveLength(1);
    expect(rec.startSession[0].resumeSessionId).toBe("sess-abc");
    expect(rec.startSession[0].permissionMode).toBe("plan");
    // (d) the recon prompt was sent (the original request "build a game" threads in)
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toBe(reconPrompt("build a game", null));
  });

  it("open/sizing (root): resends sizerPrompt, arms sizer", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const ledger = ledgerOf(openNode(1, "sizing"));

    await h.resume({ cwd: "/work", ledger });

    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(rec.startSession[0].resumeSessionId).toBe("sess-99");
    expect(rec.sendMessage).toEqual([sizerPrompt()]);
  });

  it("leaf/drafting (non-root child): resends subDraftPrompt, sends no gate", async () => {
    // A split root running its first child which is leaf/drafting; a pending right-sibling keeps the
    // root coherent. The active node is [01]. Decomposition plan on disk so the child mandate reloads.
    const masterPlan = "### Sub-Plan 01: First\nbody one\n\n### Sub-Plan 02: Second\nbody two";
    const { deps, rec } = makeDeps({ "master.md": masterPlan });
    const h = createOrchestrator(deps);
    const root = splitNode(
      1,
      "running-children",
      [leafNode(1, "drafting"), openNode(2, "pending")],
      { planPath: "/abs/plans/master.md", plansDirPath: "/abs/plans/master.md" },
    );
    const ledger = ledgerOf(root);

    await h.resume({ cwd: "/work", ledger });

    expect(rec.resetPlanTreeDir).toEqual([]);
    // A draft resend sends exactly one message: the subDraftPrompt for [01].
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toContain("Draft the implementation plan for sub-plan 01");
    // and it carries the reloaded mandate title/body
    expect(rec.sendMessage[0]).toContain("First");
  });

  it("leaf/awaiting-approval: re-presents leaf gate from disk, NO message sent", async () => {
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    // REAL leaf-plan shape: this app writes leaf plans into `~/.claude/plans/` and records the
    // ABSOLUTE path on the node (NOT a `.plan-tree/` path). The resumed leaf gate must re-present
    // that exact absolute path so onAwaitingApproval → openPlan opens the real held plan.
    const ABS_LEAF =
      "/Users/u/.claude/plans/agent-plan-tree-mqbsecev-52f1b6c9-00-000000000000000018B8866D18775858.md";
    const ledger = ledgerOf(
      leafNode(1, "awaiting-approval", {
        planPath: ABS_LEAF,
        plansDirPath: ABS_LEAF,
      }),
    );

    await h.resume({ cwd: "/work", ledger });

    expect(rec.resetPlanTreeDir).toEqual([]);
    // gate re-presented with the on-disk ABSOLUTE planPath (passed through verbatim — leaf gates are
    // NOT joined under <cwd>/.plan-tree/, unlike decomposition gates).
    expect(obs.awaiting).toHaveLength(1);
    expect(obs.awaiting[0].kind).toBe("leaf");
    expect(obs.awaiting[0].planPath).toBe(ABS_LEAF);
    expect(obs.awaiting[0].toolUseId).toBe("resumed:");
    // NO prompt sent (pure-disk re-presentation)
    expect(rec.sendMessage).toEqual([]);
    // the held gate is on the snapshot
    expect(h.snapshot().pendingApproval?.planPath).toBe(ABS_LEAF);
  });

  it("open/awaiting-decomposition-approval (root): re-presents decomposition gate resolved under .plan-tree/, NO message", async () => {
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    const ledger = ledgerOf(openNode(1, "awaiting-decomposition-approval"));

    await h.resume({ cwd: "/work", ledger });

    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(obs.awaiting).toHaveLength(1);
    expect(obs.awaiting[0].kind).toBe("decomposition");
    // the decomposition filename (planName2([]) = "master.md") resolves under <cwd>/.plan-tree/
    expect(obs.awaiting[0].planPath).toBe("/work/.plan-tree/master.md");
    expect(obs.awaiting[0].toolUseId).toBe("resumed:");
    expect(rec.sendMessage).toEqual([]);
  });

  it("PHASE 3b: resuming a leaf/executing node sends the AUDIT-AND-CONTINUE prompt and arms exec — NEVER the approval prompt, NEVER an approval gate", async () => {
    // PHASE 3a turned leaf/executing into an OFFERABLE-but-HAZARDOUS rewind (requiresConfirm —
    // invariant I3). PHASE 3b makes its CONTINUATION an audit-and-continue: the node is ALREADY
    // leaf/executing and its plan is ALREADY approved, so re-presenting the APPROVAL gate (which on
    // approve sends "Begin implementing it now") would RESTART the build from scratch and re-apply
    // edits already on disk. Instead the orchestrator re-enters execution directly: arm `exec` and
    // send resumedLeafContinuePrompt (inspect the working tree, continue the remaining steps). The
    // node stays leaf/executing; NO approval gate is fired. (The partial-apply confirm dialog that
    // GATES reaching here is P3c's concern.)
    const ABS_LEAF =
      "/Users/u/.claude/plans/agent-plan-tree-exec-00-000000000000000018B8866D18775858.md";
    // The durable approved LEAF plan lives in the PLANS STORE at its ABSOLUTE planPath (writeAgentPlan's
    // write seam — leaves never write `.plan-tree/`). Seed it in plansMap so the best-effort plans-channel
    // read (read_plan_contents) finds it.
    const { deps, rec } = makeDeps({}, { [ABS_LEAF]: "# the approved plan body" });
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    const ledger = ledgerOf(leafNode(1, "executing", { planPath: ABS_LEAF, plansDirPath: ABS_LEAF }));

    await h.resume({ cwd: "/work", ledger });

    // No reset (resume never archives). NO approval gate re-presented (the executing continuation does
    // NOT route through onAwaitingApproval).
    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(obs.awaiting).toEqual([]);
    expect(h.snapshot().pendingApproval).toBeNull();

    // The CONTINUE prompt was sent verbatim (exact message), and it is NOT the restart/approval prompt.
    expect(rec.sendMessage).toEqual([resumedLeafContinuePrompt(ABS_LEAF)]);
    expect(rec.sendMessage).not.toContain(resumedLeafApprovalPrompt(ABS_LEAF));

    // The node REMAINS leaf/executing (no APPROVE dispatched — APPROVE against a non-gate node would be
    // illegal; the rehydrated node was already executing). Derived policy is the writable acceptEdits.
    expect(h.snapshot().root.state.phase).toBe("executing");
    expect(h.snapshot().writePolicy).toBe("acceptEdits");

    // EXEC is armed: feeding the continue turn's result fires EXEC_DONE (legal only against
    // leaf/executing) → the node advances to its summary turn. If `exec` were NOT armed the result
    // would be swallowed and NO summary prompt would be sent.
    await h.ingestStream(textFrame("continued and finished the remaining steps"));
    await h.ingestStream(resultFrame());
    await flush();
    // the summary prompt followed exec completion (the EXEC_DONE→summary advance)
    expect(rec.sendMessage.at(-1)).toContain("Output a concise summary");
  });

  it("PHASE 3b FALSIFIABILITY: the executing continuation is the CONTINUE prompt, not the APPROVAL prompt", async () => {
    // If the routing were inverted to send resumedLeafApprovalPrompt (the restart prompt) — the bug
    // this phase fixes — this assertion would RED. (The exact-equality assertion above already pins
    // it; this isolates the negative for clarity: the two prompts are genuinely distinct strings.)
    const ABS_LEAF = "/Users/u/.claude/plans/exec-leaf.md";
    const { deps, rec } = makeDeps({}, { [ABS_LEAF]: "plan body" });
    const h = createOrchestrator(deps);
    const ledger = ledgerOf(leafNode(1, "executing", { planPath: ABS_LEAF, plansDirPath: ABS_LEAF }));

    await h.resume({ cwd: "/work", ledger });

    expect(rec.sendMessage[0]).toBe(resumedLeafContinuePrompt(ABS_LEAF));
    expect(resumedLeafContinuePrompt(ABS_LEAF)).not.toBe(resumedLeafApprovalPrompt(ABS_LEAF));
  });

  it("PHASE 3b DEGRADE: a leaf/executing whose approved plan is GONE from disk surfaces a clear terminal, never a continue prompt", async () => {
    // The durable LEAF plan (its absolute plans-store path) is ABSENT (plansMap empty → read_plan_contents
    // REJECTS) — telling the model to "continue" a plan it cannot read is incoherent, so degrade safely to
    // a FATAL terminal rather than crash or send a continue prompt that references a missing artifact.
    const ABS_LEAF = "/Users/u/.claude/plans/exec-leaf.md";
    const { deps, rec } = makeDeps(); // no plansMap → read_plan_contents rejects (plan gone)
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    const ledger = ledgerOf(leafNode(1, "executing", { planPath: ABS_LEAF, plansDirPath: ABS_LEAF }));

    await h.resume({ cwd: "/work", ledger });

    expect(rec.sendMessage).toEqual([]); // no continue prompt sent
    expect(obs.awaiting).toEqual([]); // no approval gate either
    expect(obs.fatal).toHaveLength(1);
    expect(obs.fatal[0]).toContain("Start a new plan");
  });

  it("CROSS-BOUNDARY: a REAL CHILD leaf/executing (path [01], absolute plans-store planPath) continues via the PLANS channel — no FATAL, no `.plan-tree/` probe", async () => {
    // THE PRODUCTION REPRO. A non-root child leaf [01] mid-execution: its durable plan is an ABSOLUTE
    // `~/.claude/plans/...` file (writeAgentPlan's seam — leaves NEVER write `.plan-tree/`). The OLD code
    // verified it via readPlanTreeFile(cwd, planName2([01])) = read of `.plan-tree/01-plan.md` — a file
    // a leaf never writes, AND the absolute-planPath shape the allow-list rejects — so it ALWAYS read
    // null and FATAL'd every real executing-continue. The fix reads the absolute planPath through the
    // PLANS channel (read_plan_contents). RED before the fix (FATAL, "01-plan.md gone"); GREEN after.
    const ABS_CHILD_LEAF =
      "/Users/u/.claude/plans/agent-plan-tree-exec-01-000000000000000018B8866D18775858.md";
    // Root split with a REAL decomposition (master.md) + child [01] executing + pending sibling [02], so
    // activePathOf → [01]. The leaf's durable plan is in the PLANS STORE (plansMap), NOT `.plan-tree/`.
    const { deps, rec } = makeDeps(
      { "master.md": "# decomposition" },
      { [ABS_CHILD_LEAF]: "# the child's approved plan" },
    );
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    const execChild = leafNode(1, "executing", { planPath: ABS_CHILD_LEAF, plansDirPath: ABS_CHILD_LEAF });
    const root = splitNode(1, "running-children", [execChild, openNode(2, "pending")], {
      planPath: "master.md",
      plansDirPath: "master.md",
    });
    // Sanity: the active node IS the executing child [01], not the root.
    expect(pathKey(activePathOf(root)!)).toBe(pathKey(path(1)));

    await h.resume({ cwd: "/work", ledger: ledgerOf(root) });

    // NO FATAL — the leaf plan is present in the plans store, so the continuation proceeds.
    expect(obs.fatal).toEqual([]);
    expect(obs.awaiting).toEqual([]); // no approval gate re-presented (audit-and-continue)
    // The CONTINUE prompt was sent with the child's ABSOLUTE planPath.
    expect(rec.sendMessage).toEqual([resumedLeafContinuePrompt(ABS_CHILD_LEAF)]);
    // THE LOAD-BEARING ASSERTION: the leaf's durable plan was verified through the PLANS channel by its
    // absolute planPath. With the OLD code this verification read read_plan_tree_file(cwd, "01-plan.md")
    // → null (a leaf never writes `.plan-tree/01-plan.md`) → FATAL; the fix reads read_plan_contents.
    expect(rec.planContentsRequests).toContain(ABS_CHILD_LEAF);
    // FALSIFIABILITY: the absolute leaf planPath must NEVER be handed to the `.plan-tree/` channel (the
    // allow-list rejects it; it would throw). Note: a bare `01-plan.md` DOES legitimately appear in
    // readRequests — it is the decomposing-disambiguation PROBE (resume pre-reads planName2(activePath)
    // for the open/decomposing case), NOT the executing-continue verification, so we assert on the
    // absolute path that uniquely identifies the mis-route.
    expect(rec.readRequests).not.toContain(ABS_CHILD_LEAF);
  });

  it("resume() while a run is already active is a no-op (returns false)", async () => {
    const { deps } = makeDeps();
    const h = createOrchestrator(deps);
    await h.resume({ cwd: "/work", ledger: ledgerOf(openNode(1, "recon")) });
    const second = await h.resume({ cwd: "/work", ledger: ledgerOf(openNode(1, "sizing")) });
    expect(second).toBe(false);
  });

  it("a ledger with NO sdk_session_id omits resumeSessionId (fresh-session fallback)", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const ledger = ledgerOf(openNode(1, "recon"));
    delete (ledger as { sdk_session_id?: string }).sdk_session_id; // simulate an old state.json with no field
    await h.resume({ cwd: "/work", ledger });
    expect(rec.startSession[0].resumeSessionId).toBeUndefined();
  });
});

// ---- the armed-tag probe: resend phases arm the matching awaiting (falsifiable via next frame) ----

describe("resume() — resend arms the matching awaiting variant", () => {
  it("recon resend arms recon: the next result writes recon.md + advances to sizer", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    await h.resume({ cwd: "/work", ledger: ledgerOf(openNode(1, "recon"), "s", "REQ") });
    // Feed the recon turn's result: if `recon` was armed at [], the consume branch writes recon.md
    // and sends the sizer prompt. If it were idle, the result would be swallowed (no recon.md).
    await h.ingestStream(textFrame("the recon report"));
    await h.ingestStream(resultFrame());
    await flush();
    expect(rec.writePlanTreeFile.map((w) => w.name)).toContain("recon.md");
    expect(rec.sendMessage.at(-1)).toBe(sizerPrompt());
  });
});

// ===============================================================================================
// summaries / mandates reload from disk
// ===============================================================================================

describe("resume() — reloads summaries + mandates from disk so prompts thread prior context", () => {
  // A tree where child 01 is summarized and child 02 is the active leaf/drafting node. Resuming at
  // [02] must thread 01's summary into the re-sent draft prompt — which requires reloading the
  // summary file AND 02's mandate from the master plan.
  function siblingTree(): TreeNode {
    return splitNode(
      1,
      "running-children",
      [
        leafNode(1, "summarized", { summaryPath: fileOf("/abs/.plan-tree/01-summary.md") }),
        leafNode(2, "drafting"),
      ],
      { planPath: "/abs/plans/master.md", plansDirPath: "/abs/plans/master.md" },
    );
  }

  it("a re-sent draft prompt CONTAINS the prior sibling's summary text (loaded from disk)", async () => {
    const SUMMARY_TEXT = "SUMMARY-OF-SIBLING-01-UNIQUE-MARKER";
    const MASTER_PLAN = "### Sub-Plan 01: First\nfirst body\n\n### Sub-Plan 02: Second\nsecond body";
    const { deps, rec } = makeDeps({
      "01-summary.md": SUMMARY_TEXT,
      "master.md": MASTER_PLAN,
    });
    const h = createOrchestrator(deps);

    await h.resume({ cwd: "/work", ledger: ledgerOf(siblingTree()) });

    // The draft prompt for [02] was re-sent and carries BOTH the reloaded mandate (Second) AND the
    // prior sibling's summary text.
    expect(rec.sendMessage).toHaveLength(1);
    const prompt = rec.sendMessage[0];
    expect(prompt).toContain("Draft the implementation plan for sub-plan 02");
    expect(prompt).toContain("Second"); // mandate title (from master.md parse)
    expect(prompt).toContain(SUMMARY_TEXT); // prior sibling summary (from 01-summary.md)
    // we actually requested the right files
    expect(rec.readRequests).toContain("01-summary.md");
    expect(rec.readRequests).toContain("master.md");
  });

  it("FALSIFIABILITY: with the reload no-op'd (readPlanTreeFile absent), the summary text is NOT threaded", async () => {
    // Drop the readPlanTreeFile dep → reloadDriverStateFromDisk skips → no summaries/mandates.
    const { deps, rec } = makeDeps();
    deps.readPlanTreeFile = undefined;
    const h = createOrchestrator(deps);

    await h.resume({ cwd: "/work", ledger: ledgerOf(siblingTree()) });

    expect(rec.sendMessage).toHaveLength(1);
    // Same draft prompt, but WITHOUT the summary marker (the reload that would have threaded it ran
    // as a no-op). This is the falsifiability proof: the previous test's assertion depends on the
    // reload actually happening.
    expect(rec.sendMessage[0]).not.toContain("SUMMARY-OF-SIBLING-01-UNIQUE-MARKER");
  });
});

// ===============================================================================================
// resumed-gate approval — continuation prompt, no dead-id resolve
// ===============================================================================================

describe("resumed-gate approval sends a continuation prompt and never resolves the dead id", () => {
  it("approve of a resumed LEAF gate: sends the implement prompt, arms exec, does NOT resolvePermission", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const ledger = ledgerOf(
      leafNode(1, "awaiting-approval", {
        planPath: "/abs/.plan-tree/01-plan.md",
        plansDirPath: "/abs/plans/01-plan.md",
      }),
    );
    await h.resume({ cwd: "/work", ledger });
    // No message sent yet (gate re-presented only).
    expect(rec.sendMessage).toEqual([]);

    // Approve the resumed gate (the active node is the root leaf → pathKey "").
    await h.approve(pathKey(path()));

    // The continuation prompt was sent (naming the plan path, forbidding rewrite).
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toBe(resumedLeafApprovalPrompt("/abs/.plan-tree/01-plan.md"));
    // The dead synthetic id was NEVER resolved.
    expect(rec.resolvePermission).toEqual([]);
    // The leaf moved to executing (policy → acceptEdits derived).
    expect(h.snapshot().root.state.phase).toBe("executing");
    expect(h.snapshot().writePolicy).toBe("acceptEdits");

    // CROSS-BOUNDARY: the derived policy flip is not just a snapshot value — it was actually PUSHED
    // to the session via setMode("acceptEdits") so the agent is in a writable mode BEFORE it is told
    // to build. Assert both membership AND ordering: setMode("acceptEdits") precedes the implement
    // prompt's sendMessage in the ordered combined call log (rec.calls). (Falsifiable: stub setMode to
    // a no-op — or invert the dispatch policy seam — and the membership assertion below goes RED.)
    expect(rec.setMode).toContain("acceptEdits");
    const implementSend = `sendMessage:${resumedLeafApprovalPrompt("/abs/.plan-tree/01-plan.md").slice(0, 40)}`;
    const setModeIdx = rec.calls.indexOf("setMode:acceptEdits");
    const sendIdx = rec.calls.indexOf(implementSend);
    expect(setModeIdx).toBeGreaterThanOrEqual(0); // the flip was pushed across the boundary
    expect(sendIdx).toBeGreaterThanOrEqual(0); // the implement prompt was sent
    expect(setModeIdx).toBeLessThan(sendIdx); // writable mode established BEFORE "go build"

    // Falsifiability of arm-exec: feed the exec result → the summary turn must start (arms summary +
    // sends summaryPrompt). If `exec` were not armed, the result would be swallowed.
    await h.ingestStream(resultFrame());
    await flush();
    expect(rec.sendMessage.at(-1)).toContain("has finished executing");
  });

  it("approve of a resumed DECOMPOSITION gate: re-derives children from disk and fires the first child's recon", async () => {
    const MASTER_PLAN = "Preamble line\n\n### Sub-Plan 01: Alpha\nalpha body\n\n### Sub-Plan 02: Beta\nbeta body";
    const { deps, rec } = makeDeps({ "master.md": MASTER_PLAN });
    const h = createOrchestrator(deps);
    const ledger = ledgerOf(openNode(1, "awaiting-decomposition-approval"), "s", "ROOT REQUEST");

    await h.resume({ cwd: "/work", ledger });
    expect(rec.sendMessage).toEqual([]); // gate only

    // Approve the resumed decomposition gate (root → pathKey "").
    await h.approve(pathKey(path()));

    // The root materialized into a split with two children; the first is active in recon.
    const snap = h.snapshot();
    expect(snap.root.state.stage).toBe("split");
    expect(snap.activePath && pathKey(snap.activePath)).toBe("01");
    // The first child's recon prompt was sent (no interrupt, no resolvePermission).
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toBe(
      subReconPrompt(path(1), { title: "Alpha", sectionBody: "alpha body", masterPreamble: "Preamble line" }, [], null),
    );
    expect(rec.resolvePermission).toEqual([]);
    expect(rec.calls).not.toContain("interrupt");
  });

  it("INV-2 on resume: approve of a resumed DECOMPOSITION gate whose on-disk master is MALFORMED denies-for-redraft (no FATAL, no silent wedge, no throw out of approve())", async () => {
    // The on-disk decomposition is header-less (a stale plan written by old write-then-parse code, or
    // hand-edited between kill and resume). The resumed-approve branch re-parses it to re-derive the
    // children; parseSubPlanHeaders throws a PlanValidationError. WITHOUT a guard that throw escapes
    // approve() (which is NOT under enqueueIngest) to main.ts's generic catch → the run silently
    // wedges at the gate (no redraft, no FATAL). The fix denies-for-redraft exactly like the live and
    // resumed requestChanges paths: send a redraft prompt, run stays active, node back to decomposing.
    const MALFORMED = "Here is my decomposition in prose with no sub-plan headers at all.";
    const { deps, rec } = makeDeps({ "master.md": MALFORMED });
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    const ledger = ledgerOf(openNode(1, "awaiting-decomposition-approval"), "s", "ROOT REQUEST");

    await h.resume({ cwd: "/work", ledger });
    expect(rec.sendMessage).toEqual([]); // gate only

    // Approve must NOT throw out of approve() (the silent-wedge bug rethrows here). FALSIFY: remove the
    // try/catch around the resumed-approve re-parse → this line throws → the test errors → RED.
    await h.approve(pathKey(path()));
    await flush();

    // NO FATAL, run STAYS ACTIVE — a malformed on-disk master is recoverable, never terminal.
    expect(obs.fatal).toEqual([]);
    expect(h.orchestrationActive()).toBe(true);
    // A REDRAFT prompt was sent (carrying the validation message as feedback) — the deny-for-redraft
    // recovery, mirroring the resumed requestChanges path.
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toContain("ExitPlanMode");
    // The synthetic dead id was never resolved; the node is back at open/decomposing for the redraft;
    // the malformed split was NOT materialized.
    expect(rec.resolvePermission).toEqual([]);
    expect(h.snapshot().root.state.stage).toBe("open");
    expect(h.snapshot().root.state.phase).toBe("decomposing");
    expect(h.snapshot().pendingApproval).toBeNull();

    // END-TO-END RECOVERABILITY (the gate is NOT a dead end). The model redrafts a WELL-FORMED
    // decomposition and holds it via a fresh LIVE ExitPlanMode — which routes through the normal live
    // decomposition path (resumedGate is now false), surfacing a NEW decomposition gate the user can
    // approve. FALSIFY: if the deny-for-redraft fix instead left the node wedged (no redraft / dead
    // gate), this live ExitPlanMode would have no decomposing node to land on and no fresh gate would
    // appear → these assertions go RED.
    await h.ingestPermission({
      seq: nextSeq(),
      kind: "tool_permission_requested",
      id: "redraft-1",
      tool: "ExitPlanMode",
      input: { plan: "Preamble\n\n### Sub-Plan 01: Alpha\nalpha body\n\n### Sub-Plan 02: Beta\nbeta body" },
      agent_id: null,
    });
    await flush();

    // A fresh decomposition gate surfaced (a LIVE one — real id, not the dead synthetic resumed id).
    expect(obs.awaiting.at(-1)?.kind).toBe("decomposition");
    expect(h.snapshot().pendingApproval?.kind).toBe("decomposition");
    expect(h.snapshot().pendingApproval?.toolUseId).toBe("redraft-1");

    // Approving the corrected draft materializes the split (the recovery completes). The live gate's
    // real id is resolved (allow), proving this is the live path, not the dead resumed one.
    await h.approve(pathKey(path()));
    await flush();
    expect(obs.fatal).toEqual([]);
    expect(h.snapshot().root.state.stage).toBe("split");
    expect(rec.resolvePermission.some((r) => r.id === "redraft-1" && r.allow === true)).toBe(true);
  });

  it("requestChanges of a resumed LEAF gate: sends a redraft prompt, does NOT resolvePermission", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    const ledger = ledgerOf(
      leafNode(1, "awaiting-approval", {
        planPath: "/abs/.plan-tree/01-plan.md",
        plansDirPath: "/abs/plans/01-plan.md",
      }),
    );
    await h.resume({ cwd: "/work", ledger });

    await h.requestChanges(pathKey(path()), "make it shorter");

    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toContain("make it shorter");
    expect(rec.sendMessage[0]).toContain("ExitPlanMode");
    expect(rec.resolvePermission).toEqual([]);
    // back to drafting in place
    expect(h.snapshot().root.state.phase).toBe("drafting");
  });
});

// ===============================================================================================
// PHASE 5 — resuming a baseline root PARKED in the forced acceptance window (the deadlock fix)
// ===============================================================================================
//
// THE BUG this covers: a baseline-bearing root rested in its acceptance window when the session ended
// (app closed/crash). On resume the gate (transient) was nulled and resumeScopeForRoot returned
// BLOCKED — a permanent dead-end (no orchestrator → no acceptance bar → tree un-completable). THE FIX:
// resume RE-MINTS the acceptance gate (no turn sent) so the bar reappears and approve/diverge finalize.

describe("resume() — PHASE 5 forced acceptance window (parked baseline root)", () => {
  // A single-collapse run frozen at the acceptance window: a single-child root split, child
  // summarized; baseline_ frozen, no verdict yet. assertCoherent2 allows this (acceptance-window
  // allowance), and writePolicyFor2 derives "plan" (no node executing).
  function acceptanceLedger(extra: Partial<Pick<RecursiveLedger, "acceptance_">> = {}): RecursiveLedger {
    const root = splitNode(1, "running-children", [
      leafNode(1, "summarized", { summaryPath: fileOf("/abs/.plan-tree/01-summary.md") }),
    ]);
    return ledgerOf(root, "sess-acc", "build a widget", {
      baseline_: { frozen: true, frozen_ms: 111 },
      ...extra,
    });
  }

  it("re-mints pendingAcceptance + fires onAcceptanceReview, sends NO turn, opens the baseline, no reset/START", async () => {
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);

    const started = await h.resume({ cwd: "/work", ledger: acceptanceLedger() });
    expect(started).toBe(true);

    // The gate is re-minted on the snapshot AND fanned to the observer (the acceptance bar binds to it).
    expect(h.snapshot().pendingAcceptance).not.toBeNull();
    expect(h.snapshot().pendingAcceptance!.cwd).toBe("/work");
    expect(obs.acceptances).toHaveLength(1);
    expect(obs.acceptances[0].cwd).toBe("/work");
    expect(obs.acceptances[0].openTarget).toBe("index.html");

    // NO model turn is sent — the tree is parked awaiting a HUMAN verdict, not an agent.
    expect(rec.sendMessage).toEqual([]);
    // Best-effort baseline open happened (so the user can exercise the build).
    expect(rec.openBaseline).toEqual([{ cwd: "/work", path: "index.html" }]);
    // Resume discipline: no archive of the prior tree, no fresh START (tree_id preserved).
    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(h.snapshot().treeId).toBe("tree-resume");
    // The session was opened resuming the prior transcript in the derived ("plan") policy.
    expect(rec.startSession).toHaveLength(1);
    expect(rec.startSession[0].resumeSessionId).toBe("sess-acc");
    expect(rec.startSession[0].permissionMode).toBe("plan");
    // The run is live but NOT done — the verdict is still pending.
    expect(h.snapshot().done).toBe(false);
    expect(obs.done).toBe(0);
  });

  it("after resume, approveAcceptance() finalizes the tree (root→summarized + notifyDone, verdict 'approved' persisted, gate cleared)", async () => {
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);

    await h.resume({ cwd: "/work", ledger: acceptanceLedger() });
    expect(obs.done).toBe(0); // withheld at the gate

    await h.approveAcceptance();

    // The deferred finalize ran: tree is done, gate cleared, verdict persisted.
    expect(obs.done).toBe(1);
    expect(h.snapshot().done).toBe(true);
    expect(h.snapshot().pendingAcceptance).toBeNull();
    const lastState = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(lastState.contents) as { acceptance_?: { verdict: string } };
    expect(ledger.acceptance_).toEqual({ verdict: "approved", decided_ms: expect.any(Number) });
  });

  it("after resume, divergeAcceptance(reason) finalizes the tree AND round-trips the reason on the ledger", async () => {
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);

    await h.resume({ cwd: "/work", ledger: acceptanceLedger() });
    await h.divergeAcceptance("perf below floor; follow-up filed");

    expect(obs.done).toBe(1);
    expect(h.snapshot().done).toBe(true);
    const lastState = rec.writePlanTreeFile.filter((w) => w.name === "state.json").at(-1)!;
    const ledger = JSON.parse(lastState.contents) as { acceptance_?: { verdict: string; reason?: string } };
    expect(ledger.acceptance_).toEqual({
      verdict: "diverged",
      reason: "perf below floor; follow-up filed",
      decided_ms: expect.any(Number),
    });
  });

  it("FALSIFIABILITY: a baseline-window ledger with the verdict ALREADY recorded is NOT resumable (returns false, no gate, no session)", async () => {
    // Proves the resume offer is gated on the run-level facts (acceptance_ absent). If resume ignored
    // the verdict and re-minted the gate anyway, `started` would be true and onAcceptanceReview would
    // fire — both go RED here. (And reverting the resumeScopeForRoot acceptance case to `blocked(...)`
    // makes the PRIOR three tests' `started===true` / re-mint assertions go RED — the genuine
    // falsifiability of the fix.)
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);

    const started = await h.resume({
      cwd: "/work",
      ledger: acceptanceLedger({ acceptance_: { verdict: "approved", decided_ms: 9 } }),
    });
    expect(started).toBe(false);
    expect(obs.acceptances).toEqual([]);
    expect(rec.startSession).toEqual([]);
    expect(h.orchestrationActive()).toBe(false);
  });
});

// ===============================================================================================
// open/decomposing — the disk-probe-driven gate-vs-resend split (Phase-1 behavioral change)
// ===============================================================================================
//
// A persisted open/decomposing root is AMBIGUOUS: either the decomposition draft was never produced,
// OR a draft WAS produced but the transient gate event died with the process. The resume path
// disambiguates by PROBING disk for planName2([]) = "master.md" under <cwd>/.plan-tree/:
//   - ABSENT  → re-send the decompose draft fresh (masterDraftPrompt at the root). No gate.
//   - PRESENT → re-present the EXISTING decomposition gate from disk (re-read path, no re-draft).
// Both tests are FALSIFIABLE: inverting the branch (gate-on-absent / draft-on-present) flips the
// assertions RED (notes inline).

describe("resume() — open/decomposing disk-probe (gate vs decompose-resend)", () => {
  it("NO artifact on disk: sends exactly ONE decompose draft (masterDraftPrompt), arms idle, NO gate, no reset/START", async () => {
    // readMap is EMPTY → the probe read of master.md returns null → ABSENT → resend("decompose").
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    const ledger = ledgerOf(openNode(1, "decomposing"), "sess-dec", "build a CRM");

    const started = await h.resume({ cwd: "/work", ledger });
    expect(started).toBe(true);

    // EXACTLY ONE message: the MASTER decomposition draft for the root, threaded with the original
    // request and the resume-path defaults (no confirmed intent, no baseline). Exact-equality is the
    // strongest falsifiable form: a gate re-present (the WRONG branch) sends NO message → this RED;
    // a leaf/sub draft (the wrong prompt) → this RED.
    expect(rec.sendMessage).toEqual([masterDraftPrompt("build a CRM", undefined, null, false)]);
    expect(rec.sendMessage[0]).toContain("Draft the MASTER decomposition plan for this request:");

    // NO decomposition gate was re-presented (the absent-artifact branch must NOT mint a phantom gate).
    expect(obs.awaiting).toEqual([]);
    expect(h.snapshot().pendingApproval).toBeNull();

    // The tree was NOT duplicated/materialized: the root stays open/decomposing (no children parsed —
    // a re-draft does not mutate the tree; the next ExitPlanMode drives that). Falsifiable: if the
    // resend wrongly re-dispatched SIZER_DONE or materialized children, stage/phase would change.
    expect(h.snapshot().root.state.stage).toBe("open");
    expect(h.snapshot().root.state.phase).toBe("decomposing");

    // Resume discipline preserved.
    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(h.snapshot().treeId).toBe("tree-resume");
    expect(rec.startSession).toHaveLength(1);
    expect(rec.startSession[0].resumeSessionId).toBe("sess-dec");
  });

  it("FALSIFIABILITY companion: armed-idle proof — after the decompose resend, the node's ExitPlanMode drives the gate (not a swallowed result)", async () => {
    // The decompose resend arms `awaiting=idle`; the next signal is the node's ExitPlanMode hold,
    // routed by the active open/decomposing state in ingestPermissionImpl. Feed that hold and assert
    // the decomposition gate is surfaced — proving the resend left the node in the correct shape to
    // accept the draft's hold (not an armed result-consumer that would mis-handle it).
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    await h.resume({ cwd: "/work", ledger: ledgerOf(openNode(1, "decomposing"), "s", "REQ") });
    expect(rec.sendMessage).toHaveLength(1); // the master draft

    // The agent drafts and holds via ExitPlanMode → the orchestrator surfaces the decomposition gate.
    await h.ingestPermission({
      seq: nextSeq(),
      kind: "tool_permission_requested",
      id: "exit-1",
      tool: "ExitPlanMode",
      input: { plan: "### Sub-Plan 01: A\nbody" },
      agent_id: null,
    });
    await flush();

    expect(obs.awaiting).toHaveLength(1);
    expect(obs.awaiting[0].kind).toBe("decomposition");
  });

  it("WITH artifact on disk: re-presents the decomposition gate (re-read from disk), sends NO draft prompt", async () => {
    // master.md PRESENT on disk → the probe read returns non-null → PRESENT → the SAME gate
    // re-presentation as open/awaiting-decomposition-approval (no re-draft, no tokens).
    const MASTER_PLAN = "Preamble\n\n### Sub-Plan 01: Alpha\nalpha body\n\n### Sub-Plan 02: Beta\nbeta body";
    const { deps, rec } = makeDeps({ "master.md": MASTER_PLAN });
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    const ledger = ledgerOf(openNode(1, "decomposing"), "sess-dec2", "build a CRM");

    const started = await h.resume({ cwd: "/work", ledger });
    expect(started).toBe(true);

    // The decomposition gate was re-presented from disk: a decomposition-kind gate whose planPath is
    // master.md resolved under <cwd>/.plan-tree/, carrying the synthetic resumed id.
    expect(obs.awaiting).toHaveLength(1);
    expect(obs.awaiting[0].kind).toBe("decomposition");
    expect(obs.awaiting[0].planPath).toBe("/work/.plan-tree/master.md");
    expect(obs.awaiting[0].toolUseId).toBe("resumed:");
    expect(h.snapshot().pendingApproval?.planPath).toBe("/work/.plan-tree/master.md");

    // NO draft prompt was sent — the PRESENT branch re-presents, it does NOT re-draft. Falsifiable:
    // if the probe were ignored (always-absent), a masterDraftPrompt sendMessage would appear → RED.
    expect(rec.sendMessage).toEqual([]);

    // The probe actually read master.md (the disambiguation is disk-driven, not guessed).
    expect(rec.readRequests).toContain("master.md");

    // Resume discipline preserved.
    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(h.snapshot().treeId).toBe("tree-resume");
  });

  // INV-3 — the resumed open/decomposing gate must NOT dead-end on Approve. The disk-probe gate
  // branch re-presents the gate from `open/decomposing` (NOT `open/awaiting-decomposition-approval`,
  // the only phase the resumed-DECOMPOSITION test above starts from). Before the phase-only re-arm,
  // approve dispatched CHILDREN_PARSED then DECOMPOSITION_APPROVED, whose reducer guard requires
  // `awaiting-decomposition-approval` and THREW → FATAL: the Resume button was a guaranteed dead-end.
  it("INV-3: resume at open/decomposing (artifact present) then approve() materializes the split, fires the first child's recon, NO throw, NO FATAL", async () => {
    const MASTER_PLAN = "Preamble line\n\n### Sub-Plan 01: Alpha\nalpha body\n\n### Sub-Plan 02: Beta\nbeta body";
    const { deps, rec } = makeDeps({ "master.md": MASTER_PLAN });
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    // The ACTIVE node is the ROOT at open/decomposing (NOT awaiting-decomposition-approval). With
    // master.md on disk, the disk-probe branch re-presents the decomposition gate.
    const ledger = ledgerOf(openNode(1, "decomposing"), "sess-dec3", "ROOT REQUEST");

    await h.resume({ cwd: "/work", ledger });
    // The gate was re-presented (exactly ONE awaiting card) and NO message was sent (gate only).
    expect(obs.awaiting).toHaveLength(1);
    expect(obs.awaiting[0].kind).toBe("decomposition");
    expect(rec.sendMessage).toEqual([]);

    // Approve the resumed decomposition gate (root → pathKey "").
    await h.approve(pathKey(path()));
    await flush();

    // NO FATAL, NO throw: the split materialized from disk with the first child active in recon.
    // FALSIFY: without the GATE_RE_PRESENTED phase-only re-arm the node stays open/decomposing, so
    // DECOMPOSITION_APPROVED's guard throws → the enqueueIngest catch FATALs → obs.fatal is non-empty,
    // the root never becomes split, and orchestrationActive flips false → every assertion below RED.
    expect(obs.fatal).toEqual([]);
    const snap = h.snapshot();
    expect(snap.root.state.stage).toBe("split");
    expect(snap.activePath && pathKey(snap.activePath)).toBe("01");
    expect(h.orchestrationActive()).toBe(true);

    // The first child's recon prompt was sent (children materialized from the on-disk master), with
    // NO interrupt and NO permission-resolve against the dead synthetic id.
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toBe(
      subReconPrompt(path(1), { title: "Alpha", sectionBody: "alpha body", masterPreamble: "Preamble line" }, [], null),
    );
    expect(rec.resolvePermission).toEqual([]);
    expect(rec.calls).not.toContain("interrupt");

    // EXACTLY ONE gate/snapshot was presented across the whole resume+approve — the re-arm must NOT
    // re-fire notifyAwaitingApproval (no double gate). FALSIFY: re-dispatch DECOMPOSITION_DRAFTED on
    // re-arm (the rejected design) → a SECOND awaiting card → this RED.
    expect(obs.awaiting).toHaveLength(1);
  });
});

// ===============================================================================================
// PHASE 2b — restart / prototype-gate / rewind resume continuations
// ===============================================================================================

describe("resume() — restart(clarify): re-enters the genesis clarify step", () => {
  it("re-sends intentPrompt SEEDED FROM THE TITLE, arms the clarify (intent) awaiting, in the prototype policy", async () => {
    const { deps, rec } = makeDeps();
    const h = createOrchestrator(deps);
    // A coherent ledger whose ACTIVE node is the root open/clarifying-intent (the genesis window). The
    // title is the original request resume() seeds the clarify send from.
    const ledger = ledgerOf(openNode(1, "clarifying-intent"), "sess-clar", "build a CRM");

    const started = await h.resume({ cwd: "/work", ledger });
    expect(started).toBe(true);

    // The clarify turn was re-sent, SEEDED FROM THE TITLE — byte-identical to the fresh-start send.
    // Exact-equality is the strongest falsifiable form (a recon/draft resend, or a title-less prompt,
    // makes this RED). Inverting the restart handler to a throw makes resume() reject → started!==true.
    expect(rec.sendMessage).toEqual([intentPrompt("build a CRM")]);

    // The genesis window derives the "prototype" write policy, so the session opened (and the
    // containment hook installed) in "prototype" — exactly like a fresh start()'s permissionMode.
    expect(rec.startSession).toHaveLength(1);
    expect(rec.startSession[0].permissionMode).toBe("prototype");
    expect(rec.startSession[0].resumeSessionId).toBe("sess-clar");

    // Resume discipline preserved (no archive, no fresh START).
    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(h.snapshot().treeId).toBe("tree-resume");

    // ARMED-TAG PROOF (falsifiable): the `intent` awaiting was armed BEFORE the send. Feed the
    // clarifier turn's result with NO prototype block → the intent consume branch dispatches
    // INTENT_CLARIFIED (root clarifying-intent → recon) and sends the recon prompt. If `intent` were
    // NOT armed, the result would be swallowed (no recon send), and the root would stay clarifying-intent.
    await h.ingestStream(textFrame("Confirmed: build a CRM.\nNO-PROTOTYPE"));
    await h.ingestStream(resultFrame());
    await flush();
    expect(rec.sendMessage.at(-1)).toBe(reconPrompt("build a CRM", "Confirmed: build a CRM."));
    expect(h.snapshot().root.state.phase).toBe("recon");
  });
});

describe("resume() — prototype-gate: re-presents the prototype review gate in the prototype policy", () => {
  it("fires onPrototypeReview from disk, sends NO turn, session opened in the prototype write-policy (containment hook active)", async () => {
    const { deps, rec } = makeDeps();
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);
    // ACTIVE node = root open/prototype-review (the visual-prototype gate window).
    const ledger = ledgerOf(openNode(1, "prototype-review"), "sess-proto", "build a CRM");

    const started = await h.resume({ cwd: "/work", ledger });
    expect(started).toBe(true);

    // The prototype gate was re-presented from disk (no turn sent — it resolves via approve/refine).
    expect(obs.prototypes).toHaveLength(1);
    expect(obs.prototypes[0].cwd).toBe("/work");
    expect(obs.prototypes[0].paths).toContain("/work/.plan-tree/prototype/index.html");
    expect(h.snapshot().pendingPrototype).not.toBeNull();
    expect(rec.sendMessage).toEqual([]);

    // CONTAINMENT: the session was opened in the "prototype" write-policy — the OBSERVABLE the fakes
    // expose for "the PreToolUse containment hook is installed". (The sidecar installs the hook purely
    // from startSession's permissionMode: "prototype"; the resume MUST select it or writes escape the
    // .plan-tree/prototype/ sandbox.) Falsifiable: if the resume opened the session in "plan"/
    // "acceptEdits", this assertion goes RED — and so would real containment.
    expect(rec.startSession).toHaveLength(1);
    expect(rec.startSession[0].permissionMode).toBe("prototype");
    expect(rec.startSession[0].resumeSessionId).toBe("sess-proto");
    expect(h.snapshot().writePolicy).toBe("prototype");

    // Resume discipline preserved.
    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(h.snapshot().treeId).toBe("tree-resume");
  });
});

// DEFECT FIX — REVIEWING / ROLL-UP resume re-RUNS the in-flight turn (no decomposition-gate
// re-presentation). A split node is ALREADY decomposed+approved, so re-presenting its (consumed)
// decomposition gate would dead-end on approve (CHILDREN_PARSED/DECOMPOSITION_APPROVED throw on a
// split node). Instead resume re-sends the in-flight turn — the parent-review turn for `reviewing`,
// the roll-up summary turn for the non-root roll-up window — fed by reloaded disk context, and drives
// it to COMPLETION. These tests prove the turn LANDS (the node advances), not just that a prompt fired.
describe("resume() — DEFECT FIX: reviewing / roll-up re-run the in-flight turn (no gate re-presentation)", () => {
  // A split root REVIEWING between children: child 01 summarized, child 02 pending. activePathOf
  // returns the reviewing PARENT ([]). recoveryFor maps split/reviewing → resend('review').
  function reviewingRoot(): TreeNode {
    return splitNode(
      1,
      "reviewing",
      [
        leafNode(1, "summarized", { summaryPath: fileOf("/abs/.plan-tree/01-summary.md") }),
        openNode(2, "pending"),
      ],
      { planPath: "/abs/plans/master.md", plansDirPath: "/abs/plans/master.md" },
    );
  }
  const REVIEW_MASTER = "Preamble line\n\n### Sub-Plan 01: Alpha\nalpha body\n\n### Sub-Plan 02: Beta\nbeta body";
  const SUMMARY_01 = "SUMMARY-OF-01-MARKER";

  it("REVIEWING re-sends the parent-review turn (NO decomposition gate, NO draft/clarify) fed by reloaded context", async () => {
    const { deps, rec } = makeDeps({ "master.md": REVIEW_MASTER, "01-summary.md": SUMMARY_01 });
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);

    const started = await h.resume({ cwd: "/work", ledger: ledgerOf(reviewingRoot(), "sess-rev", "build a CRM") });
    expect(started).toBe(true);

    // NO approval gate was surfaced — the buggy behavior re-presented a decomposition gate here, which
    // would have dead-ended on approve. Falsifiable: reverting to the gate rewind makes this RED.
    expect(obs.awaiting).toEqual([]);
    expect(h.snapshot().pendingApproval).toBeNull();

    // The parent-review turn was RE-SENT, carrying the reviewed child's summary (verbatim) and the
    // remaining sibling's frozen mandate (Beta) — exactly what reloadDriverStateFromDisk reconstructed.
    // reviewedChild is the rightmost SUMMARIZED child ([01]); the remaining pending sibling is [02].
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toBe(
      parentReviewPrompt(path(1), SUMMARY_01, [{ path: path(2), mandate: { title: "Beta", sectionBody: "beta body", masterPreamble: "Preamble line" } }]),
    );
    expect(rec.sendMessage[0]).toContain(SUMMARY_01); // reviewed child summary threaded
    expect(rec.sendMessage[0]).toContain("Beta"); // remaining sibling mandate threaded

    // reloadDriverStateFromDisk RAN: it read the summary + master plan. Resume discipline preserved.
    expect(rec.readRequests).toContain("01-summary.md");
    expect(rec.readRequests).toContain("master.md");
    expect(rec.resetPlanTreeDir).toEqual([]);
    expect(rec.startSession[0].resumeSessionId).toBe("sess-rev");
    expect(obs.prototypes).toEqual([]);
    expect(obs.acceptances).toEqual([]);
  });

  it("REVIEWING drives to COMPLETION: feeding the review result advances to the next child's recon (PARENT_REVIEW_DONE landed)", async () => {
    const { deps, rec } = makeDeps({ "master.md": REVIEW_MASTER, "01-summary.md": SUMMARY_01 });
    const h = createOrchestrator(deps);

    await h.resume({ cwd: "/work", ledger: ledgerOf(reviewingRoot(), "sess-rev", "build a CRM") });
    // Before the result: the parent is still reviewing (no advance yet).
    expect(activePathOf(h.snapshot().root) && pathKey(activePathOf(h.snapshot().root)!)).toBe(pathKey(path()));

    // Feed the review turn's result (a NONE verdict — no adjustment). The `parent-review` consume
    // branch must dispatch PARENT_REVIEW_DONE (legal from split/reviewing) and activate child 02's recon.
    await h.ingestStream(textFrame("Looks good.\nNONE"));
    await h.ingestStream(resultFrame());
    await flush();

    // THE COMPLETION ASSERTION: the tree advanced — child 02 is now the active recon node. If the resume
    // had wedged at a decomposition gate (the bug), no review result could land here and the active node
    // would stay [] (or the run would FATAL). Falsifiable: revert to the gate rewind → this goes RED.
    const advanced = h.snapshot().root;
    const active = activePathOf(advanced);
    expect(active && pathKey(active)).toBe(pathKey(path(2)));
    const node = advanced.state.stage === "split" ? advanced.state.children[1] : null;
    expect(node?.state.stage).toBe("open");
    expect(node?.state.phase).toBe("recon");
    // The next child's recon prompt was sent INLINE.
    expect(rec.sendMessage.at(-1)).toBe(
      subReconPrompt(path(2), { title: "Beta", sectionBody: "beta body", masterPreamble: "Preamble line" }, [SUMMARY_01], null),
    );
  });

  // A NON-ROOT roll-up window: root split running-children with child [01] a split resting in its OWN
  // roll-up window (its sole grandchild [01.01] summarized) and a pending right-sibling [02] keeping the
  // root coherent. activePathOf returns [01]; recoveryFor maps it → resend('rollup').
  function rollupRoot(): TreeNode {
    return splitNode(
      1,
      "running-children",
      [
        splitNode(
          1,
          "running-children",
          [leafNode(1, "summarized", { summaryPath: fileOf("/abs/.plan-tree/01.01-summary.md") })],
          { planPath: "/abs/plans/01-plan.md", plansDirPath: "/abs/plans/01-plan.md" },
        ),
        openNode(2, "pending"),
      ],
      { planPath: "/abs/plans/master.md", plansDirPath: "/abs/plans/master.md" },
    );
  }

  it("ROLL-UP window re-sends the roll-up summary turn (NO gate) then drives to COMPLETION: the split summarizes and the root advances to review", async () => {
    const GRANDCHILD_SUMMARY = "GRANDCHILD-01.01-SUMMARY";
    const NESTED_PLAN = "### Sub-Plan 01.01: Inner\ninner body";
    const MASTER = "### Sub-Plan 01: Alpha\nalpha\n\n### Sub-Plan 02: Beta\nbeta";
    const { deps, rec } = makeDeps({
      "01.01-summary.md": GRANDCHILD_SUMMARY,
      "01-plan.md": NESTED_PLAN,
      "master.md": MASTER,
    });
    const obs = makeObserver();
    const h = createOrchestrator(deps);
    h.subscribe(obs.obs);

    await h.resume({ cwd: "/work", ledger: ledgerOf(rollupRoot(), "sess-roll", "build a CRM") });

    // NO approval gate (the buggy behavior re-presented [01]'s decomposition gate, which would dead-end
    // on approve). The roll-up summary turn was re-sent for [01], fed its grandchild's summary.
    expect(obs.awaiting).toEqual([]);
    expect(h.snapshot().pendingApproval).toBeNull();
    expect(rec.sendMessage).toHaveLength(1);
    expect(rec.sendMessage[0]).toBe(rollupSummaryPrompt(path(1), [GRANDCHILD_SUMMARY]));
    expect(rec.sendMessage[0]).toContain(GRANDCHILD_SUMMARY);

    // Feed the roll-up summary result. The `summary` consume branch must WRITE 01-summary.md (overwrite —
    // idempotent) and dispatch SUMMARY_WRITTEN{[01]}, completing the split [01] and ascending: with a
    // pending sibling [02] remaining, the ROOT enters `reviewing` and the parent-review prompt fires.
    await h.ingestStream(textFrame("ROLLED-UP SUMMARY OF 01"));
    await h.ingestStream(resultFrame());
    await flush();

    // COMPLETION: [01]'s roll-up summary file was written (the turn LANDED).
    expect(rec.writePlanTreeFile.map((w) => w.name)).toContain(summaryName2(path(1))); // "01-summary.md"
    // The split [01] summarized and the root ascended to reviewing (a sibling [02] still pending).
    const snap = h.snapshot();
    const child01 = snap.root.state.stage === "split" ? snap.root.state.children[0] : null;
    expect(child01?.state.stage).toBe("split");
    expect(child01?.state.phase).toBe("summarized");
    expect(snap.root.state.stage === "split" && snap.root.state.phase).toBe("reviewing");
    // The next turn sent is the ROOT's parent-review (not a decomposition gate / not done).
    expect(rec.sendMessage.at(-1)).toContain("reviewing that summary BEFORE the next sibling");
    expect(obs.awaiting).toEqual([]);
    expect(obs.done).toBe(0);
  });
});
