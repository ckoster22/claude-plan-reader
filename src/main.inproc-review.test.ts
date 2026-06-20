import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Sub-Plan 03 — IN-PROCESS plan-review intercept (the Agent SDK canUseTool seam).
//
// When the in-app session emits ExitPlanMode, main.ts's tool-permission-requested handler:
//   • writes the plan markdown to a REAL file (write_agent_plan → abs path),
//   • registers an in-process pending review keyed by the SDK toolUseId,
//   • opens that file via the NORMAL plan flow + flips to the Plan tab,
//   • HOLDS — it NEVER calls resolve_tool_permission. The ONLY allow path is #review-approve.
//
// The conversation FACADE also subscribes to tool-permission-requested (it appends a stream marker
// and, for non-ExitPlanMode, flips to the Conversation tab). For ExitPlanMode the facade must SKIP
// its onActivity() so it does not race main.ts's switchToPlanTab(). This test registers BOTH listeners
// (by booting the real DOM, which calls initConversation AND main.ts's own listen) so the tab race is
// real: the FINAL active tab is asserted.
//
// The ./render facade is REAL (not mocked) so the genuine comment save/clear path runs end-to-end,
// mirroring main.review.test.ts. The listen mock stores handlers as ARRAYS so a single event name can
// fan out to multiple subscribers (facade + main.ts).
// ---------------------------------------------------------------------------------------------

type Rec = { quote: string; comment: string; block_line: number | null; block_end_line: number | null; occurrence: number; id: number };

const H = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  // Every invoke recorded as { cmd, args } so command-level invariants are checkable.
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  // listeners[event] = array of handlers (multiple subscribers per event name).
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
  // The path write_agent_plan returns (set per test so openPlan can select the row).
  writtenPath: "/home/u/.claude/plans/agent-plan.md",
  // When true, the invoke mock makes write_agent_plan REJECT (the save-failure fallback test).
  failWriteAgentPlan: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    const path = (a.path as string) ?? "";
    if (cmd === "write_agent_plan") {
      if (H.failWriteAgentPlan) return Promise.reject(new Error("disk full"));
      return Promise.resolve(H.writtenPath);
    }
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
    // resolve_tool_permission / set_agent_permission_mode / respond_to_review / set_open_plan /
    // mark_viewed / focus_main_window / start_agent_session / … — recorded above, resolve benignly.
    return Promise.resolve(undefined);
  }),
}));

// listen mock: push EACH handler into an array keyed by event name (fan-out to multiple subscribers).
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    (H.listeners[name] ??= []).push(handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));
// ./render and ./conversation are intentionally NOT mocked — we need the real comment IO path AND the
// real conversation facade listener (so the tab race between facade + main.ts is genuine).

import { __resetReviewStateForTest } from "./main";

function planRow(absPath: string, stem: string): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd: null,
    unread: false,
    flavor: "standalone",
    tree_id: null,
    nn: null,
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

// Fire a tool-permission-requested event through ALL registered handlers (facade + main.ts) so the
// dual-listener tab race is exercised. Returns after the chains flush.
async function fireToolPermission(payload: {
  id: string;
  tool: string;
  input?: unknown;
  agent_id?: string | null;
}): Promise<void> {
  const ev = {
    payload: {
      seq: 1,
      kind: "tool_permission_requested",
      id: payload.id,
      tool: payload.tool,
      input: payload.input ?? {},
      agent_id: payload.agent_id ?? null,
    },
  };
  for (const h of H.listeners["tool-permission-requested"] ?? []) h(ev);
  await flush();
}

// Fire all tool-permission-requested handlers SYNCHRONOUSLY (no await) and observe the tab IMMEDIATELY.
// The conversation facade's handler is SYNCHRONOUS (it calls onActivity inline); main.ts's handler is
// async (chained on a promise + awaits write/open before switchToPlanTab), so it has NOT run yet at this
// point. Thus the tab observed right after this call reflects ONLY the facade's synchronous decision —
// isolating whether the facade flipped on this tool. (main.ts's later switchToPlanTab would otherwise
// mask a facade regression by winning the combined race because it runs last.)
function fireSyncObserveFacade(payload: { id: string; tool: string; input?: unknown; agent_id?: string | null }): void {
  const ev = {
    payload: {
      seq: 1,
      kind: "tool_permission_requested",
      id: payload.id,
      tool: payload.tool,
      input: payload.input ?? {},
      agent_id: payload.agent_id ?? null,
    },
  };
  for (const h of H.listeners["tool-permission-requested"] ?? []) h(ev);
}

async function fireAgentExit(): Promise<void> {
  for (const h of H.listeners["agent-exit"] ?? []) h({ payload: { code: 0 } });
  await flush();
}

// Fire an EXTERNAL plan-review-requested event through all registered handlers, then flush.
async function fireReviewRequested(payload: {
  review_id: string;
  plan_text: string;
  plan_file_path: string;
}): Promise<void> {
  for (const h of H.listeners["plan-review-requested"] ?? []) h({ payload });
  await flush();
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

function calls(cmd: string): Array<Record<string, unknown>> {
  return H.invokeCalls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

function activeReaderTab(): string | undefined {
  const t = document.querySelector<HTMLElement>(".reader-tab-row .tab.active");
  return t?.dataset.tab;
}

beforeEach(() => {
  H.store = {};
  H.invokeCalls = [];
  H.listeners = {};
  H.rows = [];
  H.writtenPath = "/home/u/.claude/plans/agent-plan.md";
  H.failWriteAgentPlan = false;
  __resetReviewStateForTest();
});

// ---------------------------------------------------------------------------------------------
// HOLD — write + open + Plan tab, NO resolve. Both listeners registered (the tab race is real).
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — HOLD on ExitPlanMode", () => {
  it("writes the plan once, opens the returned file, ends on the Plan tab, never resolves", async () => {
    const path = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = path;
    H.rows = [planRow(path, "agent-plan")];
    bootDom();
    await flush();

    // Sanity: BOTH the facade and main.ts registered a tool-permission-requested listener.
    expect((H.listeners["tool-permission-requested"] ?? []).length).toBe(2);

    // Move OFF the Plan tab first so switchToPlanTab() is load-bearing: the DOM boots with Plan
    // active, so a no-op switch would still leave us on "plan" and pass vacuously. Park on
    // Conversation, assert we're there, THEN fire ExitPlanMode and require it to flip BACK to Plan.
    document.querySelector<HTMLElement>('.reader-tab-row .tab[data-tab="conversation"]')!.click();
    expect(activeReaderTab()).toBe("conversation");

    await fireToolPermission({ id: "tu_1", tool: "ExitPlanMode", input: { plan: "# A real plan\n" }, agent_id: null });
    await flush();

    // write_agent_plan called exactly once with the plan markdown.
    expect(calls("write_agent_plan")).toHaveLength(1);
    expect(calls("write_agent_plan")[0].plan).toBe("# A real plan\n");
    // openPlan rendered the returned path (header filename = its basename).
    expect(document.querySelector("#doc-filename")!.textContent).toBe("agent-plan.md");
    expect(document.querySelector<HTMLElement>(`[data-path="${path}"]`)!.classList.contains("active")).toBe(true);
    // FINAL active tab is Plan (main.ts owns it; the facade skipped onActivity for ExitPlanMode).
    expect(activeReaderTab()).toBe("plan");
    // HOLD: resolve_tool_permission was NOT called.
    expect(calls("resolve_tool_permission")).toHaveLength(0);
    // The bar is in VIEWING mode with the in-process affordances: Approve visible, Submit relabeled.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-submit")!.textContent).toBe("Request changes");
  });

  it("the facade does NOT flip to the Conversation tab on an ExitPlanMode request (skip onActivity)", async () => {
    bootDom();
    await flush();
    // Start on the Plan tab.
    expect(activeReaderTab()).toBe("plan");
    // Fire ExitPlanMode and observe the tab SYNCHRONOUSLY (only the facade's inline decision has run;
    // main.ts's async switchToPlanTab has not). The facade must NOT have flipped to Conversation.
    // FALSIFY: removing the `tool !== "ExitPlanMode"` skip in conversation/index.ts makes the facade
    // flip to Conversation synchronously and this assertion goes RED.
    fireSyncObserveFacade({ id: "tu_skip", tool: "ExitPlanMode", input: { plan: "# p\n" }, agent_id: null });
    expect(activeReaderTab()).toBe("plan");
    await flush(); // let main.ts's chained handler settle (cleanup)

    // Control: a NON-ExitPlanMode request DOES flip via the facade synchronously (proves onActivity is
    // wired and the skip is specific to ExitPlanMode, not a blanket no-op).
    fireSyncObserveFacade({ id: "tu_bash", tool: "Bash", input: {}, agent_id: null });
    expect(activeReaderTab()).toBe("conversation");
    await flush();
  });
});

// ---------------------------------------------------------------------------------------------
// APPROVE — single click → allow + acceptEdits + Conversation tab.
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — APPROVE (single click)", () => {
  it("one click on #review-approve → resolve(allow,null) + set acceptEdits + Conversation tab", async () => {
    const path = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = path;
    H.rows = [planRow(path, "agent-plan")];
    bootDom();
    await flush();
    await fireToolPermission({ id: "tu_1", tool: "ExitPlanMode", input: { plan: "# plan\n" }, agent_id: null });
    await flush();

    document.querySelector<HTMLButtonElement>("#review-approve")!.click();
    await flush();

    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toEqual({ id: "tu_1", allow: true, message: null });
    const modes = calls("set_agent_permission_mode");
    expect(modes).toHaveLength(1);
    expect(modes[0]).toEqual({ mode: "acceptEdits" });
    expect(activeReaderTab()).toBe("conversation");
    // Removed from pending → bar hidden.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// REQUEST CHANGES — add a comment (Submit enables) → click Submit → resolve(deny, feedback).
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — REQUEST CHANGES (deny + feedback)", () => {
  it("Submit is disabled at 0 comments, enables on the first, and denies with buildFeedbackPrompt", async () => {
    const path = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = path;
    H.rows = [planRow(path, "agent-plan")];
    bootDom();
    await flush();
    await fireToolPermission({ id: "tu_1", tool: "ExitPlanMode", input: { plan: "# plan\n" }, agent_id: null });
    await flush();

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(true); // 0 comments

    addCommentViaPopover("rename the second module");
    await flush();
    expect(H.store[path]).toHaveLength(1);
    expect(submit.disabled).toBe(false); // enabled on the first comment

    submit.click();
    await flush();

    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    expect(resolves[0].id).toBe("tu_1");
    expect(resolves[0].allow).toBe(false);
    // The message is the assembled feedback prompt (buildFeedbackPrompt output) carrying the comment.
    expect(String(resolves[0].message)).toContain("rename the second module");
    expect(String(resolves[0].message)).toContain("Please revise the plan based on this feedback:");
    // No external respond_to_review for an in-process review.
    expect(calls("respond_to_review")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// SAFETY / SUBAGENT — agent_id set still blocks; approve round-trips the SAME id.
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — SAFETY: subagent plan (agent_id != null) still blocks, same id on approve", () => {
  it("a subagent ExitPlanMode holds (no resolve pre-action) and approves with the SAME toolUseId", async () => {
    const path = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = path;
    H.rows = [planRow(path, "agent-plan")];
    bootDom();
    await flush();

    await fireToolPermission({ id: "tu_sub", tool: "ExitPlanMode", input: { plan: "# sub plan\n" }, agent_id: "agent_42" });
    await flush();

    // STILL BLOCKS: a review registered (bar visible), and NOTHING resolved yet.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(false);
    expect(calls("resolve_tool_permission")).toHaveLength(0);

    // Approve → resolve with the SAME id (no agent_id branching anywhere).
    document.querySelector<HTMLButtonElement>("#review-approve")!.click();
    await flush();
    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    expect(resolves[0].id).toBe("tu_sub");
    expect(resolves[0].allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// POLICY — non-ExitPlanMode tools NEVER reach the frontend (Part A). The sidecar now AUTO-ALLOWS
// every non-ExitPlanMode tool SYNCHRONOUSLY in-process (canUseTool) and never emits a
// tool-permission-requested event for them, so the per-tool frontend round-trip — and its
// ZodError / "Stream closed" failure modes — is eliminated. If such an event ever arrives anyway
// (an older sidecar), the frontend handler is a defensive NO-OP: it must NOT call
// resolve_tool_permission (there is no pending entry; the sidecar already allowed it), write a plan,
// or register a review.
// Test #1 (falsifiable): FALSIFY by re-adding the auto-allow invoke in handleToolPermissionRequested
// → the "no resolve_tool_permission" assertion goes RED.
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — POLICY: non-ExitPlanMode is a frontend no-op (Part A)", () => {
  it("a stray Read tool-permission event is a NO-OP: no resolve, no plan written, no review registered", async () => {
    bootDom();
    await flush();
    await fireToolPermission({ id: "tu_x", tool: "Read", input: { file_path: "/etc/hosts" }, agent_id: null });
    await flush();

    // FALSIFY: re-add the resolve_tool_permission(allow:true) call → this length-0 assertion goes RED.
    expect(calls("resolve_tool_permission")).toHaveLength(0);
    // No plan written; the review bar stays hidden (nothing registered).
    expect(calls("write_agent_plan")).toHaveLength(0);
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
  });

  it("a stray WebSearch tool-permission event is likewise a NO-OP (no resolve)", async () => {
    bootDom();
    await flush();
    await fireToolPermission({ id: "tu_ws", tool: "WebSearch", input: { query: "x" }, agent_id: null });
    await flush();
    expect(calls("resolve_tool_permission")).toHaveLength(0);
  });

  // Test #2 (falsifiable): ExitPlanMode does NOT auto-resolve — it enters the hold/review path
  // (resolve_tool_permission NOT called immediately; the plan is written + opened + registered).
  // FALSIFY: make ExitPlanMode fall through to the auto-allow branch → resolve fires immediately and
  // the "HOLD: not resolved" assertion goes RED.
  it("an ExitPlanMode request does NOT auto-resolve — it holds and registers a review", async () => {
    const path = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = path;
    H.rows = [planRow(path, "agent-plan")];
    bootDom();
    await flush();
    await fireToolPermission({ id: "tu_plan", tool: "ExitPlanMode", input: { plan: "# plan\n" }, agent_id: null });
    await flush();

    // HOLD: resolve_tool_permission was NOT called immediately for the held plan.
    expect(calls("resolve_tool_permission")).toHaveLength(0);
    // The plan was written + a review registered (bar visible, Approve visible).
    expect(calls("write_agent_plan")).toHaveLength(1);
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// LIVENESS — write_agent_plan FAILURE: auto-deny + release the seam, register NO review.
// (Regression guard for the degraded-fallback hang: an empty-planFilePath fake review can never be
// opened/approved, so the held canUseTool promise would never resolve — the agent hangs forever.)
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — LIVENESS: write_agent_plan failure auto-denies (no hang)", () => {
  it("ExitPlanMode whose write_agent_plan rejects → resolve(allow:false), NO pending review", async () => {
    H.failWriteAgentPlan = true; // make ONLY write_agent_plan reject
    H.rows = [];
    bootDom();
    await flush();

    await fireToolPermission({ id: "tu_fail", tool: "ExitPlanMode", input: { plan: "# doomed\n" }, agent_id: null });
    await flush();

    // (a) The seam is RELEASED (no hang): resolve_tool_permission(allow:false) for THIS id.
    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    expect(resolves[0].id).toBe("tu_fail");
    expect(resolves[0].allow).toBe(false);

    // (b) NO pending review registered: the bar never enters viewing/summary, Approve stays hidden,
    // and there is no resume target (Resume click resolves nothing).
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(true);
    document.querySelector<HTMLButtonElement>("#review-resume")!.click();
    await flush();
    expect(calls("resolve_tool_permission")).toHaveLength(1); // unchanged — no phantom to resume/approve

    // The save failure is surfaced on the existing #hook-status error affordance.
    const status = document.querySelector<HTMLElement>("#hook-status")!;
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// LIVENESS — in-process review whose REAL plan file is UN-OPENABLE (refuseUnopenableReview).
// write_agent_plan RESOLVES but with an empty path (no real file to open through the normal flow),
// so openReviewPlanFile hits the !planFilePath branch → refuseUnopenableReview(review). Because the
// review is in-process, the held canUseTool seam MUST be released with a DENY (resolve_tool_permission
// allow:false) — exactly like the write-failure path — or the agent hangs forever (no timeout). The
// status message MUST NOT point at a terminal (there is no terminal for an in-process review).
// FALSIFY: revert refuseUnopenableReview to the non-releasing version → (a) goes RED (no resolve fires).
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — LIVENESS: un-openable plan file refuses + releases the seam (no hang)", () => {
  it("ExitPlanMode whose written path is empty → resolve(allow:false) for its id, NO pending review, non-terminal #hook-status error", async () => {
    H.writtenPath = ""; // write_agent_plan SUCCEEDS but returns no real path → review is un-openable
    H.rows = [];
    bootDom();
    await flush();

    await fireToolPermission({ id: "tu_unopenable", tool: "ExitPlanMode", input: { plan: "# unopenable\n" }, agent_id: null });
    await flush();

    // (a) The seam is RELEASED with a DENY (no hang): resolve_tool_permission(allow:false) for THIS id.
    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    expect(resolves[0].id).toBe("tu_unopenable");
    expect(resolves[0].allow).toBe(false);

    // (b) NOT counted in pendingReviews: the bar is fully hidden, Approve hidden, Resume resolves nothing.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(true);
    document.querySelector<HTMLButtonElement>("#review-resume")!.click();
    await flush();
    expect(calls("resolve_tool_permission")).toHaveLength(1); // unchanged — no phantom to resume/approve

    // (c) The failure is surfaced on the existing #hook-status error affordance.
    const status = document.querySelector<HTMLElement>("#hook-status")!;
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);

    // (d) The in-process message MUST NOT point at a terminal (there is no terminal for an in-process
    //     review — the prior message "approve/deny in the terminal" was wrong for this source).
    expect(status.textContent!.toLowerCase()).not.toContain("terminal");
  });
});

// ---------------------------------------------------------------------------------------------
// LIFECYCLE PURGE — agent-exit while an in-process review is pending → purged, Approve resolves nothing.
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — LIFECYCLE PURGE on agent-exit", () => {
  it("agent-exit purges the held in-process review; a later Approve click resolves nothing", async () => {
    const path = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = path;
    H.rows = [planRow(path, "agent-plan")];
    bootDom();
    await flush();
    await fireToolPermission({ id: "tu_1", tool: "ExitPlanMode", input: { plan: "# plan\n" }, agent_id: null });
    await flush();
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);

    await fireAgentExit();

    // Bar reflects the purge (no pending reviews → hidden).
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    // A stale Approve click now resolves NOTHING (the phantom is gone).
    document.querySelector<HTMLButtonElement>("#review-approve")!.click();
    await flush();
    expect(calls("resolve_tool_permission")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// EXTERNAL — un-openable plan file: refuse-and-surface (mirror the in-process write-failure path).
// (Regression guard for bug #1: the degraded detached render NEVER set openPath, so currentReviewId()
// stayed null → the bar dropped to SUMMARY mode (Submit hidden, handlers bail on the null
// guards) while the dead review was STILL counted ("1 plan awaiting review"). An un-openable external
// review must be REFUSED — purged from pending so it is not counted, and the failure surfaced on
// #hook-status — never rendered as an unactionable phantom.)
// ---------------------------------------------------------------------------------------------
describe("external review — un-openable plan refuses and surfaces (no unactionable phantom)", () => {
  it("an external review with no openable file is NOT viewing, NOT counted, and shows a #hook-status error", async () => {
    // Empty plan_file_path → the review has no real file to open through the normal flow.
    H.rows = [];
    bootDom();
    await flush();
    // Nothing pending yet → bar hidden.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);

    await fireReviewRequested({ review_id: "ext_dead", plan_text: "# orphan\n", plan_file_path: "" });
    await flush();

    // (a) NOT in viewing mode: no Submit (the bar is not acting on a review).
    expect(document.querySelector("#review-submit")!.classList.contains("hidden")).toBe(true);

    // (b) NOT counted in the pending total: the bar is fully hidden (pendingCount === 0). If the dead
    //     review were still counted, the bar would show SUMMARY mode ("1 plan awaiting review" + Resume).
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#review-bar-label")!.textContent).not.toContain("awaiting review");

    // (b2) The EXTERNAL producer is RELEASED with a DENY (not left hanging until its ~570s timeout):
    //      an un-openable plan can't be reviewed, so the terminal hook is freed with a deny so Claude
    //      stays in plan mode and can retry. The deny fires DURING the refuse (before any Resume click).
    //      FALSIFY: revert refuseUnopenableReview to the non-releasing version → this goes RED.
    const denies = calls("respond_to_review");
    expect(denies).toHaveLength(1);
    expect(denies[0].reviewId).toBe("ext_dead");
    expect(denies[0].decision).toBe("deny");

    // And a stray Resume click resolves nothing further (the phantom is already gone).
    document.querySelector<HTMLButtonElement>("#review-resume")!.click();
    await flush();
    expect(calls("respond_to_review")).toHaveLength(1);

    // (c) The failure is surfaced on the existing #hook-status error affordance.
    const status = document.querySelector<HTMLElement>("#hook-status")!;
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent!.length).toBeGreaterThan(0);
  });

  // POSITIVE CONTROL: a SUCCESSFUL external open lands in VIEWING mode with Submit visible, so
  // the fix did not just disable the bar wholesale.
  it("an external review WITH an openable file lands in viewing mode (Submit visible)", async () => {
    const extPath = "/home/u/.claude/plans/External.md";
    H.rows = [planRow(extPath, "External")];
    bootDom();
    await flush();

    await fireReviewRequested({ review_id: "ext_ok", plan_text: "# ext\n\nselect this phrase here\n", plan_file_path: extPath });
    await flush();

    // Opened the real file (header reflects its basename) and the bar is in VIEWING mode.
    expect(document.querySelector("#doc-filename")!.textContent).toBe("External.md");
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-submit")!.classList.contains("hidden")).toBe(false);
    // External review → Approve stays hidden (no in-process approve affordance).
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// COEXISTENCE — external + in-process resolve via their OWN paths; currentReviewSource matches.
// ---------------------------------------------------------------------------------------------
describe("in-process intercept — COEXISTENCE with an external review (no cross-talk)", () => {
  it("in-process resolves via resolve_tool_permission while a pending external review is untouched (no cross-talk)", async () => {
    const extPath = "/home/u/.claude/plans/External.md";
    const inPath = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = inPath;
    H.rows = [planRow(extPath, "External"), planRow(inPath, "agent-plan")];
    bootDom();
    await flush();

    // External review arrives first (opens + selects External, viewing mode).
    for (const h of H.listeners["plan-review-requested"] ?? []) {
      h({ payload: { review_id: "ext_1", plan_text: "# ext\n\nselect this phrase here\n", plan_file_path: extPath } });
    }
    await flush();
    expect(document.querySelector("#doc-filename")!.textContent).toBe("External.md");
    // External viewing → Approve hidden, Submit keeps its external label.
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#review-submit")!.textContent).toBe("Submit feedback");

    // In-process review arrives while external is being viewed → registered but NOT yanked (count rises).
    await fireToolPermission({ id: "tu_1", tool: "ExitPlanMode", input: { plan: "# in\n" }, agent_id: null });
    await flush();
    // Still viewing the external plan (no yank when a review is already viewed).
    expect(document.querySelector("#doc-filename")!.textContent).toBe("External.md");

    // Approve the in-process review by resuming it first (so it becomes the viewed review).
    document.querySelector<HTMLButtonElement>("#review-resume")!.click();
    await flush();
    // Resume opens the NEWEST pending review = the in-process one → its file selected, Approve visible.
    expect(document.querySelector("#doc-filename")!.textContent).toBe("agent-plan.md");
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(false);

    document.querySelector<HTMLButtonElement>("#review-approve")!.click();
    await flush();
    // In-process resolved via resolve_tool_permission ONLY.
    expect(calls("resolve_tool_permission")).toHaveLength(1);
    expect(calls("resolve_tool_permission")[0].id).toBe("tu_1");
    // The external review is still pending (no cross-talk): no respond_to_review fired — resolving the
    // in-process review must never leak into the external review's file-IPC path.
    expect(calls("respond_to_review")).toHaveLength(0);

    // The external review remains pending + resumable (resolving in-process did not consume it). Resume
    // re-opens it; with the in-process review gone it is now the newest pending review.
    document.querySelector<HTMLButtonElement>("#review-resume")!.click();
    await flush();
    expect(document.querySelector("#doc-filename")!.textContent).toBe("External.md");
    // Still no external resolution fired — the only in-app external-resolve affordance (Dismiss) was
    // removed; the external review can only be resolved from the terminal now.
    expect(calls("respond_to_review")).toHaveLength(0);
  });
});
