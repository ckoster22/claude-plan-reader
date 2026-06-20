// Conversation domain (Sub-Plan 02) — DOM renderer tests (jsdom, falsifiable).
//
// One assertion per frozen kind. We feed a model, derive its tree, render, and assert the DOM.
// The sanitization test feeds an XSS payload and asserts it is neutralized; removing the
// DOMPurify call (the falsification target) makes that assertion go red.
//
// We do NOT assert any Skill/subagent-NAME shape against a synthetic payload — the Skill chip is
// best-effort from the observed tool name only.

import { describe, it, expect, beforeEach, vi } from "vitest";

// links.ts (reached transitively via render → markdown → links) imports openUrl at module
// load; stub it so the import resolves AND so the external-link path is observable.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { ConversationModel } from "./stream";
import { renderTree, sanitizeAssistantHtml } from "./render";
import type {
  AssistantText,
  ToolUse,
  ToolResult,
  ModeChange,
  ResultMsg,
  PermissionDenied,
  ToolPermissionRequested,
} from "./types";

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
});

function renderModel(m: ConversationModel): void {
  renderTree(host, m.derive());
}

describe("render — assistant text bubble is SANITIZED markdown", () => {
  it("renders markdown (a <strong>) for normal assistant text", () => {
    const m = new ConversationModel();
    const ev: AssistantText = { seq: 1, kind: "assistant_text", text: "hello **world**", parent_tool_use_id: null };
    m.appendStream(ev);
    renderModel(m);
    const bubble = host.querySelector(".conv-text")!;
    expect(bubble).toBeTruthy();
    expect(bubble.querySelector("strong")?.textContent).toBe("world");
  });

  it("NEUTRALIZES an XSS payload in assistant text (no live <script>, no onerror element)", () => {
    const m = new ConversationModel();
    // markdown-it html:false escapes raw tags, but DOMPurify is the explicit defense-in-depth
    // guard. The security invariant is structural: no live <script> element and no element
    // carrying an on* handler may exist in the rendered bubble.
    const payload = `text <img src=x onerror="alert(1)"> and <script>alert(2)</script> end`;
    const ev: AssistantText = { seq: 1, kind: "assistant_text", text: payload, parent_tool_use_id: null };
    m.appendStream(ev);
    renderModel(m);
    const bubble = host.querySelector(".conv-text")!;
    // No live script element survives parse.
    expect(bubble.querySelector("script")).toBeNull();
    // No element carries an onerror handler.
    const withHandler = Array.from(bubble.querySelectorAll("*")).some((el) => el.hasAttribute("onerror"));
    expect(withHandler).toBe(false);
  });

  it("sanitizeAssistantHtml strips a <script> tag AND an onerror handler (falsifiable XSS guard)", () => {
    // This is the DIRECT DOMPurify boundary test: feed it raw dangerous HTML (any path that
    // produced unsanitized HTML would hand it here) and assert it is neutralized. Removing the
    // DOMPurify.sanitize call in render.ts makes BOTH assertions go red.
    const out = sanitizeAssistantHtml(
      `<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)">`,
    );
    const lower = out.toLowerCase();
    expect(lower).toContain("ok");
    expect(lower).not.toContain("<script");
    expect(lower).not.toContain("onerror");
  });
});

describe("render — collapsible tool row exposes args/result via textContent", () => {
  it("renders a collapsed tool row; expanding reveals input + result text", () => {
    const m = new ConversationModel();
    const use: ToolUse = { seq: 1, kind: "tool_use", id: "t1", tool: "Read", input: { file_path: "/a/b.ts" }, parent_tool_use_id: null };
    const res: ToolResult = { seq: 2, kind: "tool_result", tool_use_id: "t1", content: "FILE BODY", is_error: false, parent_tool_use_id: null };
    m.appendStream(use);
    m.appendStream(res);
    renderModel(m);

    const row = host.querySelector(".conv-tool")!;
    expect(row).toBeTruthy();
    expect(row.getAttribute("data-status")).toBe("done");
    // Collapsed: no .expanded yet.
    expect(row.classList.contains("expanded")).toBe(false);
    // The summary shows the file path via textContent (no injected markup).
    expect(row.querySelector(".conv-tool-summary")?.textContent).toBe("/a/b.ts");
    // The full input + result live in the body as textContent.
    expect(row.querySelector(".conv-tool-input")?.textContent).toContain("/a/b.ts");
    expect(row.querySelector(".conv-tool-result")?.textContent).toBe("FILE BODY");

    // Expanding toggles the .expanded class (the click handler on the header).
    const header = row.querySelector<HTMLElement>(".conv-tool-head")!;
    header.click();
    expect(row.classList.contains("expanded")).toBe(true);
  });

  it("a tool result NEVER renders as raw HTML (textContent guard)", () => {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "tool_use", id: "t1", tool: "Bash", input: "echo hi", parent_tool_use_id: null });
    m.appendStream({ seq: 2, kind: "tool_result", tool_use_id: "t1", content: "<b>not bold</b><script>x()</script>", is_error: false, parent_tool_use_id: null });
    renderModel(m);
    const resultPre = host.querySelector(".conv-tool-result")!;
    // The markup is shown literally as text, not parsed into elements.
    expect(resultPre.querySelector("b")).toBeNull();
    expect(resultPre.querySelector("script")).toBeNull();
    expect(resultPre.textContent).toContain("<b>not bold</b>");
  });

  it("an errored tool row carries the error status + error class", () => {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "tool_use", id: "t1", tool: "Bash", input: "false", parent_tool_use_id: null });
    m.appendStream({ seq: 2, kind: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true, parent_tool_use_id: null });
    renderModel(m);
    const row = host.querySelector(".conv-tool")!;
    expect(row.getAttribute("data-status")).toBe("error");
    expect(host.querySelector(".conv-tool-result-error")).toBeTruthy();
  });

  it("a running tool row shows the pulse; once done the pulse is gone", () => {
    // Dense Chat: the running affordance is a single .conv-tool-pulse dot emitted ONLY while the
    // row is running. Both directions are independent expectations:
    //  - drop the `if (node.status === "running")` guard (pulse always emits) → the done-row
    //    toBeNull() goes RED.
    //  - remove the pulse emission entirely → the running-row toBeTruthy() goes RED.
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "tool_use", id: "t1", tool: "Read",
                     input: { file_path: "/a" }, parent_tool_use_id: null });
    renderModel(m);
    let row = host.querySelector(".conv-tool")!;
    expect(row.getAttribute("data-status")).toBe("running");
    expect(row.querySelector(".conv-tool-pulse")).toBeTruthy();

    m.appendStream({ seq: 2, kind: "tool_result", tool_use_id: "t1",
                     content: "ok", is_error: false, parent_tool_use_id: null });
    renderModel(m);
    row = host.querySelector(".conv-tool")!;
    expect(row.getAttribute("data-status")).toBe("done");
    expect(row.querySelector(".conv-tool-pulse")).toBeNull();
  });
});

describe("render — subagent group gets the accent border container", () => {
  it("renders an accent-bordered .conv-subagent keyed by agent_id with nested children", () => {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "tool_use", id: "sub1", tool: "Grep", input: { pattern: "x" }, parent_tool_use_id: "agent-7" });
    renderModel(m);
    const group = host.querySelector<HTMLElement>(".conv-subagent")!;
    expect(group).toBeTruthy();
    expect(group.dataset.agentId).toBe("agent-7");
    // The nested tool row lives INSIDE the group.
    expect(group.querySelector(".conv-tool")).toBeTruthy();
    // No nested tool row sits directly at the top level (it must be inside the group).
    expect(host.querySelector(":scope > .conv-tool")).toBeNull();
  });
});

describe("render — subagent group header (identity + task from subagent_started)", () => {
  it("renders a header with the subagent_type + description, with nested tool rows beneath", () => {
    const m = new ConversationModel();
    m.appendStream({
      seq: 1,
      kind: "subagent_started",
      tool_use_id: "agent-X",
      subagent_type: "Explore",
      description: "Explore current directory structure",
      prompt: "List the files in this repo",
    });
    m.appendStream({
      seq: 2,
      kind: "tool_use",
      id: "sub-tool",
      tool: "Grep",
      input: { pattern: "foo" },
      parent_tool_use_id: "agent-X",
    });
    renderModel(m);

    const group = host.querySelector<HTMLElement>(".conv-subagent")!;
    expect(group).toBeTruthy();
    const header = group.querySelector(".conv-subagent-header")!;
    // FALSIFY: omit the header element → this query is null → RED.
    expect(header).toBeTruthy();
    // Identity: subagent_type appears in the title (textContent).
    expect(group.querySelector(".conv-subagent-title")?.textContent).toBe("Subagent · Explore");
    // Task: the description appears (textContent).
    expect(group.querySelector(".conv-subagent-desc")?.textContent).toBe(
      "Explore current directory structure",
    );
    // The nested tool row lives INSIDE the group, beneath the header.
    expect(group.querySelector(".conv-tool")).toBeTruthy();
  });

  it("falls back to an anonymous box (no header) when no subagent_started metadata arrived", () => {
    // Older sidecar: a child with parent_tool_use_id but no metadata frame → anonymous group.
    const m = new ConversationModel();
    m.appendStream({
      seq: 1,
      kind: "tool_use",
      id: "sub-tool",
      tool: "Grep",
      input: { pattern: "x" },
      parent_tool_use_id: "agent-Y",
    });
    renderModel(m);
    const group = host.querySelector<HTMLElement>(".conv-subagent")!;
    expect(group).toBeTruthy();
    expect(group.querySelector(".conv-subagent-header")).toBeNull();
  });

  it("SUPPRESSES the standalone Task tool_use row when a subagent group exists for its id", () => {
    // The Task tool_use id equals the group's agentId; the group header is the primary display, so the
    // redundant "Agent … running" row must NOT also appear at the top level.
    const m = new ConversationModel();
    m.appendStream({
      seq: 1,
      kind: "tool_use",
      id: "agent-Z",
      tool: "Task",
      input: { description: "Do the thing", subagent_type: "general-purpose" },
      parent_tool_use_id: null,
    });
    m.appendStream({
      seq: 2,
      kind: "subagent_started",
      tool_use_id: "agent-Z",
      subagent_type: "general-purpose",
      description: "Do the thing",
      prompt: null,
    });
    m.appendStream({
      seq: 3,
      kind: "tool_use",
      id: "child",
      tool: "Read",
      input: { file_path: "/a" },
      parent_tool_use_id: "agent-Z",
    });
    renderModel(m);

    // The labeled group is present...
    expect(host.querySelector(".conv-subagent-header")).toBeTruthy();
    // ...and NO top-level Task row survives (FALSIFY: drop the suppression → a .conv-tool with the
    // Task summary appears at top level → RED).
    const topTool = host.querySelector(":scope > .conv-tool");
    expect(topTool).toBeNull();
  });
});

describe("render — Task/Agent tool row is legible (description, not raw JSON)", () => {
  it("shows the Task `description` (with subagent_type) as the row summary, NOT the raw JSON blob", () => {
    const m = new ConversationModel();
    const use: ToolUse = {
      seq: 1,
      kind: "tool_use",
      id: "task1",
      tool: "Task",
      input: {
        description: "Design Minecraft clone in HTML",
        subagent_type: "general-purpose",
        prompt: "lots and lots of prompt text here",
        mode: "bypassPermissions",
      },
      parent_tool_use_id: null,
    };
    m.appendStream(use);
    renderModel(m);

    const summary = host.querySelector(".conv-tool-summary")!;
    // Legible: the human description (+ subagent_type), never the {"description":...,"mode":...} JSON.
    expect(summary.textContent).toBe("Design Minecraft clone in HTML (general-purpose)");
    expect(summary.textContent).not.toContain("{");
    expect(summary.textContent).not.toContain("bypassPermissions");
  });

  it("falls back to generic JSON summary for a NON-Task tool (the special-casing is Task-only)", () => {
    // Falsification guard: if the Task branch leaked to all tools, this Read row would lose its
    // path summary. A tool with a `description` field that is NOT Task must still summarize generically.
    const m = new ConversationModel();
    m.appendStream({
      seq: 1,
      kind: "tool_use",
      id: "r1",
      tool: "Read",
      input: { file_path: "/a/b.ts", description: "should be ignored for Read" },
      parent_tool_use_id: null,
    });
    renderModel(m);
    expect(host.querySelector(".conv-tool-summary")?.textContent).toBe("/a/b.ts");
  });

  it("renders the Task's final tool_result (the subagent RESULT) on the Task row", () => {
    const m = new ConversationModel();
    m.appendStream({
      seq: 1,
      kind: "tool_use",
      id: "task1",
      tool: "Task",
      input: { description: "Build the thing", subagent_type: "general-purpose" },
      parent_tool_use_id: null,
    });
    m.appendStream({
      seq: 2,
      kind: "tool_result",
      tool_use_id: "task1",
      content: "Subagent finished: created 4 files.",
      is_error: false,
      parent_tool_use_id: null,
    });
    renderModel(m);

    const row = host.querySelector(".conv-tool")!;
    expect(row.getAttribute("data-status")).toBe("done");
    // The Task's final result is rendered (the user sees what the subagent produced).
    expect(row.querySelector(".conv-tool-result")?.textContent).toBe(
      "Subagent finished: created 4 files.",
    );
  });

  it("nests assistant TEXT carrying parent_tool_use_id inside the subagent group (not only tool rows)", () => {
    // FIX 2(c): grouping must hold assistant-text children, not just Bash/tool rows.
    const m = new ConversationModel();
    m.appendStream({
      seq: 1,
      kind: "assistant_text",
      text: "subagent thinking out loud",
      parent_tool_use_id: "agent-9",
    });
    renderModel(m);
    const group = host.querySelector<HTMLElement>(".conv-subagent")!;
    expect(group).toBeTruthy();
    expect(group.dataset.agentId).toBe("agent-9");
    // The text bubble is INSIDE the group, not at the top level.
    expect(group.querySelector(".conv-text")?.textContent).toContain("subagent thinking out loud");
    expect(host.querySelector(":scope > .conv-text")).toBeNull();
  });
});

describe("render — system (plumbing) bubble is dim and NOT markdown-rendered", () => {
  it("renders a .conv-text-system bubble with the raw text as textContent (no HTML parsed)", () => {
    const m = new ConversationModel();
    // A harness-injected plumbing turn (subagent task-notification) replayed via the system path.
    m.appendSystemMessageAt("<task-notification>subagent A finished</task-notification>", 1);
    renderTree(host, m.derive());

    const bubble = host.querySelector(".conv-text-system");
    expect(bubble).toBeTruthy();
    // It is NOT the orange user bubble.
    expect(bubble!.classList.contains("conv-text-user")).toBe(false);
    // The raw XML is shown VERBATIM as text — the angle-bracket tag was NOT parsed into an element.
    expect(bubble!.textContent).toBe("<task-notification>subagent A finished</task-notification>");
  });

  it("does NOT parse embedded markup as HTML (textContent, never innerHTML)", () => {
    const m = new ConversationModel();
    // If this were run through innerHTML, the <img onerror> would become a real element.
    m.appendSystemMessageAt(`<local-command-stdout><img src=x onerror="alert(1)"></local-command-stdout>`, 1);
    renderTree(host, m.derive());

    const bubble = host.querySelector(".conv-text-system")!;
    // FALSIFY: rendering via innerHTML would create an <img> here; textContent never does.
    expect(bubble.querySelector("img")).toBeNull();
    expect(bubble.textContent).toContain("onerror");
  });
});

describe("render — mode chips", () => {
  it("renders a Build-mode chip on mode_change -> acceptEdits", () => {
    const m = new ConversationModel();
    const ev: ModeChange = { seq: 1, kind: "mode_change", mode: "acceptEdits" };
    m.appendStream(ev);
    renderModel(m);
    const chip = host.querySelector(".conv-mode")!;
    expect(chip).toBeTruthy();
    expect(chip.classList.contains("conv-mode-build")).toBe(true);
    expect(chip.textContent?.toLowerCase()).toContain("build");
  });

  it("a non-acceptEdits mode chip is NOT the build variant", () => {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "mode_change", mode: "plan" });
    renderModel(m);
    const chip = host.querySelector(".conv-mode")!;
    expect(chip.classList.contains("conv-mode-build")).toBe(false);
  });
});

describe("render — permission request / denied / result / error / exit rows", () => {
  it("renders the 'reviewing in the Plan tab' notice for tool-permission-requested (Sub-Plan 03)", () => {
    const m = new ConversationModel();
    const ev: ToolPermissionRequested = { seq: 1, kind: "tool_permission_requested", id: "tp1", tool: "ExitPlanMode", input: {}, agent_id: null };
    m.appendPermissionRequest(ev);
    renderModel(m);
    const notice = host.querySelector(".conv-perm-request")!;
    expect(notice).toBeTruthy();
    // Sub-Plan 03: the marker now points to the Plan tab (main.ts owns the review there).
    expect(notice.textContent?.toLowerCase()).toContain("reviewing in the plan tab");
  });

  it("renders a neutral 'permitted' notice (NOT 'blocked', NOT 'Plan ready') for a non-ExitPlanMode permission request", () => {
    const m = new ConversationModel();
    const ev: ToolPermissionRequested = { seq: 1, kind: "tool_permission_requested", id: "tp2", tool: "Bash", input: {}, agent_id: null };
    m.appendPermissionRequest(ev);
    renderModel(m);
    const notice = host.querySelector(".conv-perm-request")!;
    expect(notice).toBeTruthy();
    // Non-plan tools are now auto-ALLOWED, so the wording must be neutral — never "blocked" (misleading)
    // and never "Plan ready" (that's the ExitPlanMode-only note). It carries the muted modifier class.
    expect(notice.textContent).toContain("Bash permitted");
    expect(notice.textContent?.toLowerCase()).not.toContain("blocked");
    expect(notice.textContent?.toLowerCase()).not.toContain("plan ready");
    expect(notice.classList.contains("conv-perm-muted")).toBe(true);
  });

  it("renders a visible permission_denied row", () => {
    const m = new ConversationModel();
    const ev: PermissionDenied = { seq: 1, kind: "permission_denied", tool: "Bash", tool_use_id: "t1", agent_id: null, decision_reason_type: "deny_rule", message: "blocked" };
    m.appendStream(ev);
    renderModel(m);
    const row = host.querySelector(".conv-perm-denied")!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Bash");
  });

  it("renders a result row (the run completed) — success pin: 'Run complete', no error/interrupted face", () => {
    const m = new ConversationModel();
    const ev: ResultMsg = { seq: 1, kind: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, duration_ms: 5, total_cost_usd: 0, session_id: "s" };
    m.appendStream(ev);
    renderModel(m);
    const row = host.querySelector(".conv-result")!;
    expect(row).toBeTruthy();
    // PIN: the success row is byte-identical to before the three-way split.
    // FALSIFY: route success through the error or interrupted branch → text/class changes → RED.
    expect(row.textContent).toBe("Run complete");
    expect(row.classList.contains("conv-result-error")).toBe(false);
    expect(row.classList.contains("conv-result-interrupted")).toBe(false);
  });

  it("interrupted_result_renders_muted_continuing: a deliberateInterrupt-tagged error result renders the muted row, never 'Run failed'", () => {
    const m = new ConversationModel();
    // The wire shape of the orchestrator's deliberate post-approval interrupt — an
    // error_during_execution result with NO result text — AFTER index.ts tagged the stored frame.
    const ev: ResultMsg = { seq: 1, kind: "result", subtype: "error_during_execution", is_error: true, result: null as unknown as string, num_turns: 1, duration_ms: 5, total_cost_usd: 0, session_id: "s", deliberateInterrupt: true };
    m.appendStream(ev);
    renderModel(m);
    const row = host.querySelector(".conv-result")!;
    // FALSIFY: drop the deliberateInterrupt check in render's result case → error face + "Run failed…" → RED.
    expect(row.classList.contains("conv-result-interrupted")).toBe(true);
    expect(row.classList.contains("conv-result-error")).toBe(false);
    expect(row.textContent).toBe("Turn interrupted — continuing");
  });

  it("genuine_error_renders_run_failed_with_fallback: untagged is_error with result:null renders 'Run failed (no details)' — never the string 'null'", () => {
    const m = new ConversationModel();
    // A genuine failure the SDK reported with NO result text (the sidecar forwards result: null).
    const ev: ResultMsg = { seq: 1, kind: "result", subtype: "error_during_execution", is_error: true, result: null as unknown as string, num_turns: 1, duration_ms: 5, total_cost_usd: 0, session_id: "s" };
    m.appendStream(ev);
    renderModel(m);
    const row = host.querySelector(".conv-result")!;
    expect(row.classList.contains("conv-result-error")).toBe(true);
    expect(row.classList.contains("conv-result-interrupted")).toBe(false);
    // FALSIFY: restore the raw `Run failed: ${node.result}` interpolation → "Run failed: null" → RED.
    expect(row.textContent).toBe("Run failed (no details)");
    expect(row.textContent).not.toContain("null");

    // And a genuine failure WITH a message keeps it loud and readable.
    const m2 = new ConversationModel();
    m2.appendStream({ ...ev, result: "boom" });
    host.innerHTML = "";
    renderTree(host, m2.derive());
    expect(host.querySelector(".conv-result")!.textContent).toBe("Run failed: boom");
  });

  it("renders a FATAL error row", () => {
    const m = new ConversationModel();
    m.appendError({ kind: "auth", message: "expired", fatal: true }, 1);
    renderModel(m);
    const row = host.querySelector(".conv-error")!;
    expect(row).toBeTruthy();
    expect(row.classList.contains("conv-error-fatal")).toBe(true);
    expect(row.textContent).toContain("auth");
  });

  it("renders an exit row", () => {
    const m = new ConversationModel();
    m.appendExit({ code: 1 }, 1);
    renderModel(m);
    const row = host.querySelector(".conv-exit")!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("1");
  });

  it("renders a notice as a plain .conv-notice row — bare text, NO 'Error' prefix, no error face", () => {
    const m = new ConversationModel();
    m.appendNotice("the planner needs more input", 1);
    renderModel(m);
    const row = host.querySelector(".conv-notice")!;
    expect(row).toBeTruthy();
    // EXACT bare message — the whole point: a notice must not be mislabeled as a system error.
    expect(row.textContent).toBe("the planner needs more input");
    // Falsifiable: if surfaceMessage ever routes back through appendError, the row text gains an
    // "Error (...)" prefix and this assertion goes red.
    expect(row.textContent).not.toContain("Error");
    // It is NOT an error row: no error/fatal class, and no .conv-error rendered.
    expect(row.classList.contains("conv-error")).toBe(false);
    expect(row.classList.contains("conv-error-fatal")).toBe(false);
    expect(host.querySelector(".conv-error")).toBeNull();
  });

  it("a notice survives re-derive (re-rendering the same model reproduces the .conv-notice row)", () => {
    const m = new ConversationModel();
    m.appendNotice("re-derive me", 1);
    renderModel(m);
    expect(host.querySelector(".conv-notice")?.textContent).toBe("re-derive me");
    // Second derive of the SAME model — the notice persists (it is an accumulated event, not a
    // one-shot side effect).
    renderModel(m);
    expect(host.querySelector(".conv-notice")?.textContent).toBe("re-derive me");
  });
});

// ---- PART B: the single in-place working indicator (renderer) --------------------------------

import type { RenderTree } from "./stream";

function emptyTree(over: Partial<RenderTree> = {}): RenderTree {
  return { nodes: [], permissionMode: null, complete: false, working: null, ...over };
}

describe("render — working indicator", () => {
  it("renders ONE .conv-working with the label when tree.working is set", () => {
    renderTree(host, emptyTree({ working: { label: "thinking…" } }));
    const nodes = host.querySelectorAll(".conv-working");
    // FALSIFY: skip rendering tree.working → zero nodes → RED.
    expect(nodes).toHaveLength(1);
    expect(host.querySelector(".conv-working-label")?.textContent).toBe("thinking…");
  });

  it("renders NO indicator when tree.working is null", () => {
    renderTree(host, emptyTree({ working: null }));
    expect(host.querySelector(".conv-working")).toBeNull();
  });

  it("the label is textContent (markup is inert, not parsed)", () => {
    renderTree(host, emptyTree({ working: { label: "<b>x</b>" } }));
    const label = host.querySelector(".conv-working-label")!;
    // textContent means the angle brackets are literal text, no <b> element is created.
    expect(label.querySelector("b")).toBeNull();
    expect(label.textContent).toBe("<b>x</b>");
  });
});

// ---------------------------------------------------------------------------------------------
// AskUserQuestion card (interactive question + answers).
// ---------------------------------------------------------------------------------------------
describe("render — AskUserQuestion card renders the right inputs and submits the right answers", () => {
  function askEvent(): ToolPermissionRequested {
    return {
      seq: 5,
      kind: "tool_permission_requested",
      id: "tool-1",
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Pick a color",
            header: "Color",
            options: [
              { label: "Red", description: "warm" },
              { label: "Blue", description: "cool" },
            ],
            multiSelect: false,
          },
          {
            question: "Pick toppings",
            header: "Toppings",
            options: [{ label: "Cheese" }, { label: "Olives" }, { label: "Mushrooms" }],
            multiSelect: true,
          },
        ],
      },
      agent_id: null,
    };
  }

  it("renders radios for single-select and checkboxes for multiSelect; Submit disabled until all answered", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());
    renderTree(host, m.derive());

    const card = host.querySelector(".conv-question")!;
    expect(card).toBeTruthy();
    const sections = card.querySelectorAll(".conv-question-section");
    expect(sections).toHaveLength(2);

    // Single-select -> radios; multiSelect -> checkboxes. Scope to PREDEFINED options
    // (:not([data-other])) — the synthetic "Other…" toggle is a separate input of the same type.
    // FALSIFY: render the wrong input type (e.g. always radio) → one of these goes RED.
    const radios = sections[0].querySelectorAll<HTMLInputElement>(
      'input[type="radio"]:not([data-other])',
    );
    expect(radios).toHaveLength(2);
    const checkboxes = sections[1].querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:not([data-other])',
    );
    expect(checkboxes).toHaveLength(3);

    // Submit starts disabled (no selection yet).
    const submit = card.querySelector<HTMLButtonElement>(".conv-question-submit")!;
    expect(submit.disabled).toBe(true);

    // Answer only the first question → still disabled (second has no selection).
    radios[0].checked = true;
    radios[0].dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit.disabled).toBe(true);

    // Answer the second question → now enabled.
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit.disabled).toBe(false);
  });

  it("Submit calls onSubmitQuestion with single-string vs array answers keyed by question text", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());

    let submitted: { id: string; answers: Record<string, unknown> } | null = null;
    renderTree(host, m.derive(), {
      onSubmitQuestion: (id, answers) => {
        submitted = { id, answers };
      },
    });

    const card = host.querySelector(".conv-question")!;
    const radios = card.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const checkboxes = card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

    // Choose Blue (single) and Cheese + Mushrooms (multi).
    radios[1].checked = true; // Blue
    radios[1].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[0].checked = true; // Cheese
    checkboxes[2].checked = true; // Mushrooms
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));

    const submit = card.querySelector<HTMLButtonElement>(".conv-question-submit")!;
    submit.click();

    // FALSIFY: send labels under the wrong keys, or make multiSelect a string / single an array → RED.
    expect(submitted).not.toBeNull();
    expect(submitted!.id).toBe("tool-1");
    expect(submitted!.answers).toEqual({
      "Pick a color": "Blue", // single → string
      "Pick toppings": ["Cheese", "Mushrooms"], // multiSelect → array
    });
  });

  it("once answered, the card renders the chosen answers read-only (no inputs)", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());
    m.appendQuestionAnswered(
      "tool-1",
      { "Pick a color": "Red", "Pick toppings": ["Olives"] },
      6,
    );
    renderTree(host, m.derive());

    const card = host.querySelector(".conv-question")!;
    // FALSIFY: keep rendering the form after answered → these inputs exist → RED.
    expect(card.querySelectorAll("input")).toHaveLength(0);
    expect(card.querySelector(".conv-question-submit")).toBeNull();
    const answers = Array.from(card.querySelectorAll(".conv-question-answer")).map(
      (a) => a.textContent,
    );
    expect(answers).toEqual(["Red", "Olives"]);
  });

  // ---- Free-text "Other…" affordance ------------------------------------------------------
  // A question whose options include a literal {label:"Other"} — used to prove the synthetic
  // "Other…" row is addressed ONLY via [data-other="toggle"] and never collides with a
  // predefined option whose value is "Other".
  function askEventWithOther(): ToolPermissionRequested {
    return {
      seq: 7,
      kind: "tool_permission_requested",
      id: "tool-2",
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Pick a category",
            header: "Category",
            options: [{ label: "News" }, { label: "Other" }],
            multiSelect: false,
          },
        ],
      },
      agent_id: null,
    };
  }

  it("single-select Other replaces the answer with the typed free-text value (string, not array)", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());

    let submitted: { id: string; answers: Record<string, unknown> } | null = null;
    renderTree(host, m.derive(), {
      onSubmitQuestion: (id, answers) => {
        submitted = { id, answers };
      },
    });

    const card = host.querySelector(".conv-question")!;
    const sections = card.querySelectorAll(".conv-question-section");
    const colorSection = sections[0];

    // The synthetic "Other…" row exists, addressed ONLY via [data-other].
    const toggle = colorSection.querySelector<HTMLInputElement>('[data-other="toggle"]')!;
    const textInput = colorSection.querySelector<HTMLInputElement>('[data-other="text"]')!;
    expect(toggle).toBeTruthy();
    expect(textInput).toBeTruthy();
    // Text input starts hidden + disabled so a stale value can never participate.
    expect(textInput.hidden).toBe(true);
    expect(textInput.disabled).toBe(true);

    // Answer the second (multi) question so only the single-select matters here.
    const cheese = sections[1].querySelector<HTMLInputElement>('input[value="Cheese"]')!;
    cheese.checked = true;
    cheese.dispatchEvent(new Event("change", { bubbles: true }));

    // Select Other → text input revealed + enabled, but Submit stays disabled (empty text).
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textInput.hidden).toBe(false);
    expect(textInput.disabled).toBe(false);
    const submit = card.querySelector<HTMLButtonElement>(".conv-question-submit")!;
    expect(submit.disabled).toBe(true);

    // Type free text → Submit enabled.
    textInput.value = "Chartreuse";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit.disabled).toBe(false);

    submit.click();

    // FALSIFY: build the single answer from the toggle value ("") instead of the text → RED.
    expect(submitted).not.toBeNull();
    expect(submitted!.answers["Pick a color"]).toBe("Chartreuse");
    expect(Array.isArray(submitted!.answers["Pick a color"])).toBe(false);
  });

  it("single-select switch-away: Other typed then a predefined radio chosen → residual text never leaks", () => {
    // The user opens Other, types text, then changes their mind and picks a predefined radio.
    // Two invariants protect this: (1) the synthetic toggle shares the radio `name` group, so
    // selecting a predefined radio auto-UNCHECKS Other (browser radio exclusivity); (2) the answer
    // builder's `otherOn` guard means an unchecked toggle's residual text is never read.
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());

    let submitted: { id: string; answers: Record<string, unknown> } | null = null;
    renderTree(host, m.derive(), {
      onSubmitQuestion: (id, answers) => {
        submitted = { id, answers };
      },
    });

    const card = host.querySelector(".conv-question")!;
    const sections = card.querySelectorAll(".conv-question-section");
    const colorSection = sections[0];

    // Answer the second (multi) question so only the single-select matters here.
    const cheese = sections[1].querySelector<HTMLInputElement>('input[value="Cheese"]')!;
    cheese.checked = true;
    cheese.dispatchEvent(new Event("change", { bubbles: true }));

    // Open Other and type a sentinel.
    const toggle = colorSection.querySelector<HTMLInputElement>('[data-other="toggle"]')!;
    const textInput = colorSection.querySelector<HTMLInputElement>('[data-other="text"]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    textInput.value = "LeakMe";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Switch away: pick a PREDEFINED radio. Sharing the `name` group auto-unchecks Other.
    const blue = colorSection.querySelector<HTMLInputElement>('input[value="Blue"]:not([data-other])')!;
    blue.checked = true;
    blue.dispatchEvent(new Event("change", { bubbles: true }));
    // The shared radio group has cleared the synthetic toggle.
    expect(toggle.checked).toBe(false);

    const submit = card.querySelector<HTMLButtonElement>(".conv-question-submit")!;
    submit.click();

    // FALSIFY: (a) change the toggle's `name` so radio exclusivity breaks → toggle stays checked →
    // otherOn reads the residual "LeakMe" → RED. (b) drop the `otherOn` guard so residual text
    // leaks regardless → answer becomes "LeakMe" → RED.
    expect(submitted).not.toBeNull();
    expect(submitted!.answers["Pick a color"]).toBe("Blue");
    expect(Array.isArray(submitted!.answers["Pick a color"])).toBe(false);
    expect(submitted!.answers["Pick a color"]).not.toBe("LeakMe");
  });

  it("multi-select Other is additive: predefined options first, Other text appended last", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());

    let submitted: { id: string; answers: Record<string, unknown> } | null = null;
    renderTree(host, m.derive(), {
      onSubmitQuestion: (id, answers) => {
        submitted = { id, answers };
      },
    });

    const card = host.querySelector(".conv-question")!;
    const sections = card.querySelectorAll(".conv-question-section");

    // Answer the single-select so the whole card can submit.
    const red = sections[0].querySelector<HTMLInputElement>('input[value="Red"]')!;
    red.checked = true;
    red.dispatchEvent(new Event("change", { bubbles: true }));

    const toppings = sections[1];
    const cheese = toppings.querySelector<HTMLInputElement>('input[value="Cheese"]')!;
    cheese.checked = true;
    cheese.dispatchEvent(new Event("change", { bubbles: true }));

    const toggle = toppings.querySelector<HTMLInputElement>('[data-other="toggle"]')!;
    const textInput = toppings.querySelector<HTMLInputElement>('[data-other="text"]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    textInput.value = "Pineapple";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    const submit = card.querySelector<HTMLButtonElement>(".conv-question-submit")!;
    submit.click();

    // FALSIFY: drop the Other text from the array, or order it first → RED.
    expect(submitted).not.toBeNull();
    expect(submitted!.answers["Pick toppings"]).toEqual(["Cheese", "Pineapple"]);
    // The toggle's empty value never leaks into the array.
    expect((submitted!.answers["Pick toppings"] as string[]).includes("")).toBe(false);
  });

  it("strict gate: Other selected keeps Submit disabled until the text is non-whitespace (.trim())", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());
    renderTree(host, m.derive());

    const card = host.querySelector(".conv-question")!;
    const sections = card.querySelectorAll(".conv-question-section");
    const submit = card.querySelector<HTMLButtonElement>(".conv-question-submit")!;

    // Answer the single-select normally.
    const red = sections[0].querySelector<HTMLInputElement>('input[value="Red"]')!;
    red.checked = true;
    red.dispatchEvent(new Event("change", { bubbles: true }));

    const toppings = sections[1];
    const toggle = toppings.querySelector<HTMLInputElement>('[data-other="toggle"]')!;
    const textInput = toppings.querySelector<HTMLInputElement>('[data-other="text"]')!;

    // Strict-pin sub-case (multi-select): Other checked AND a predefined box checked, but empty
    // text → STILL disabled (text is mandatory once Other is opted into).
    const cheese = toppings.querySelector<HTMLInputElement>('input[value="Cheese"]')!;
    cheese.checked = true;
    cheese.dispatchEvent(new Event("change", { bubbles: true }));
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit.disabled).toBe(true);

    // Whitespace-only → still disabled.
    textInput.value = "   ";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
    // FALSIFY: drop the .trim() in the gate → whitespace counts as answered → RED.
    expect(submit.disabled).toBe(true);

    // A single non-whitespace char → enabled.
    textInput.value = "x";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit.disabled).toBe(false);
  });

  it("unchecking Other hides+disables the text input and its residual value does not leak", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());

    let submitted: { id: string; answers: Record<string, unknown> } | null = null;
    renderTree(host, m.derive(), {
      onSubmitQuestion: (id, answers) => {
        submitted = { id, answers };
      },
    });

    const card = host.querySelector(".conv-question")!;
    const sections = card.querySelectorAll(".conv-question-section");

    const red = sections[0].querySelector<HTMLInputElement>('input[value="Red"]')!;
    red.checked = true;
    red.dispatchEvent(new Event("change", { bubbles: true }));

    const toppings = sections[1];
    const olives = toppings.querySelector<HTMLInputElement>('input[value="Olives"]')!;
    olives.checked = true;
    olives.dispatchEvent(new Event("change", { bubbles: true }));

    const toggle = toppings.querySelector<HTMLInputElement>('[data-other="toggle"]')!;
    const textInput = toppings.querySelector<HTMLInputElement>('[data-other="text"]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    textInput.value = "Anchovies";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Now uncheck Other (multi-select checkbox can be unchecked by re-clicking).
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    // FALSIFY: leave the text input enabled/visible after uncheck → RED.
    expect(textInput.hidden).toBe(true);
    expect(textInput.disabled).toBe(true);

    const submit = card.querySelector<HTMLButtonElement>(".conv-question-submit")!;
    submit.click();

    // FALSIFY: read otherText regardless of toggle state → "Anchovies" leaks → RED.
    expect(submitted!.answers["Pick toppings"]).toEqual(["Olives"]);
  });

  it("a predefined option literally labeled \"Other\" does not collide with the synthetic Other… row", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEventWithOther());
    renderTree(host, m.derive());

    const card = host.querySelector(".conv-question")!;
    const section = card.querySelector(".conv-question-section")!;

    // Exactly one synthetic toggle; it is addressed ONLY via [data-other="toggle"].
    const toggles = section.querySelectorAll<HTMLInputElement>('[data-other="toggle"]');
    expect(toggles).toHaveLength(1);
    // The predefined value="Other" radio has no data-other attribute.
    const predefinedOther = Array.from(
      section.querySelectorAll<HTMLInputElement>('input[value="Other"]'),
    ).filter((i) => !i.dataset.other);
    expect(predefinedOther).toHaveLength(1);

    // Case A: select the PREDEFINED "Other" → answer is the label "Other".
    let submitted: { id: string; answers: Record<string, unknown> } | null = null;
    const handlers = {
      onSubmitQuestion: (id: string, answers: Record<string, unknown>) => {
        submitted = { id, answers };
      },
    };
    renderTree(host, m.derive(), handlers);
    const cardA = host.querySelector(".conv-question")!;
    const sectionA = cardA.querySelector(".conv-question-section")!;
    const predefinedOtherA = Array.from(
      sectionA.querySelectorAll<HTMLInputElement>('input[value="Other"]'),
    ).filter((i) => !i.dataset.other)[0];
    predefinedOtherA.checked = true;
    predefinedOtherA.dispatchEvent(new Event("change", { bubbles: true }));
    cardA.querySelector<HTMLButtonElement>(".conv-question-submit")!.click();
    // FALSIFY: address the row via input[value="Other"] (matches both) → the synthetic toggle
    // also gets selected/cleared → answer is wrong → RED.
    expect(submitted!.answers["Pick a category"]).toBe("Other");

    // Case B: select the SYNTHETIC Other… and type "Custom" → answer is "Custom".
    submitted = null;
    renderTree(host, m.derive(), handlers);
    const cardB = host.querySelector(".conv-question")!;
    const sectionB = cardB.querySelector(".conv-question-section")!;
    const toggleB = sectionB.querySelector<HTMLInputElement>('[data-other="toggle"]')!;
    const textB = sectionB.querySelector<HTMLInputElement>('[data-other="text"]')!;
    toggleB.checked = true;
    toggleB.dispatchEvent(new Event("change", { bubbles: true }));
    textB.value = "Custom";
    textB.dispatchEvent(new Event("input", { bubbles: true }));
    cardB.querySelector<HTMLButtonElement>(".conv-question-submit")!.click();
    expect(submitted!.answers["Pick a category"]).toBe("Custom");
  });

  it("free-text read-back: an answered card renders a free-text value unchanged (no-change path)", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());
    m.appendQuestionAnswered(
      "tool-1",
      { "Pick a color": "Chartreuse", "Pick toppings": ["Cheese", "Pineapple"] },
      6,
    );
    renderTree(host, m.derive());

    const card = host.querySelector(".conv-question")!;
    const answers = Array.from(card.querySelectorAll(".conv-question-answer")).map(
      (a) => a.textContent,
    );
    // FALSIFY: alter the read-back path so free text is dropped/mangled → RED.
    expect(answers).toEqual(["Chartreuse", "Cheese, Pineapple"]);
  });
});

describe("render — whitespace-only text nodes never draw a bubble (backstop)", () => {
  it("a whitespace-only text node produces zero .conv-text elements; a non-empty one exactly one", () => {
    // Hand renderTree a tree directly (bypassing derive(), which now drops blank frames) to
    // exercise the renderer backstop for whitespace-only nodes persisted in older stored state.
    renderTree(host, {
      nodes: [{ type: "text", seq: 1, text: "   \n" }],
      permissionMode: null,
      complete: false,
      working: null,
    });
    // FALSIFY: remove the renderTree skip → an empty bubble renders → RED.
    expect(host.querySelectorAll(".conv-text")).toHaveLength(0);

    renderTree(host, {
      nodes: [{ type: "text", seq: 1, text: "real text" }],
      permissionMode: null,
      complete: false,
      working: null,
    });
    expect(host.querySelectorAll(".conv-text")).toHaveLength(1);
  });

  it("a whitespace-only text node inside a subagent group is skipped too", () => {
    renderTree(host, {
      nodes: [
        {
          type: "subagent",
          seq: 1,
          agentId: "agent-1",
          subagentType: null,
          description: null,
          prompt: null,
          children: [
            { type: "text", seq: 2, text: " \n " },
            { type: "text", seq: 3, text: "child text" },
          ],
        },
      ],
      permissionMode: null,
      complete: false,
      working: null,
    });
    const group = host.querySelector(".conv-subagent")!;
    // FALSIFY: remove the children-loop skip → two bubbles render → RED.
    expect(group.querySelectorAll(".conv-text")).toHaveLength(1);
    expect(group.querySelector(".conv-text")!.textContent).toContain("child text");
  });
});

// ---------------------------------------------------------------------------------------------
// INV-5 — one link-handling policy across every markdown pane.
//
// The conversation stream renders model-influenceable markdown into bubbles; DOMPurify keeps
// `href`, and markdown-it linkify makes bare URLs live. Without the SHARED link handler attached
// to the persistent #conversation-stream container, clicking such an anchor performs a top-level
// navigation that bricks the single Tauri WebView with no way back. These tests assert the handler
// is wired in renderTree exactly like the reading pane: external → openUrl (no navigation),
// relative → inert no-op, #frag → in-pane scroll path, bare # → no throw.
// ---------------------------------------------------------------------------------------------
describe("render — conversation-bubble links are governed by the one link policy (INV-5)", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockClear();
  });

  // Render a single assistant-text bubble carrying `md`, then return the (only) anchor it produced.
  // The host is the persistent stream container the handler must be attached to.
  function renderBubbleAnchor(md: string): HTMLAnchorElement {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "assistant_text", text: md, parent_tool_use_id: null });
    renderTree(host, m.derive());
    const anchor = host.querySelector<HTMLAnchorElement>(".conv-text a");
    expect(anchor).toBeTruthy();
    return anchor!;
  }

  function click(anchor: HTMLAnchorElement): MouseEvent {
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(ev);
    return ev;
  }

  it("an EXTERNAL bubble link routes to openUrl and preventDefaults (no WebView navigation)", () => {
    const anchor = renderBubbleAnchor("[docs](https://example.com)");
    // markdown-it's link_open rule stamps data-external on http(s); the bubble keeps it.
    const ev = click(anchor);
    // FALSIFY: drop the attachLinkHandler call in renderTree → the click is not intercepted →
    // defaultPrevented is false and openUrl is never called → RED.
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("a RELATIVE bubble link (./03.md) is an inert no-op — preventDefaulted, never navigates / openUrl", () => {
    const anchor = renderBubbleAnchor("[p](./03.md)");
    const ev = click(anchor);
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("a #fragment bubble link is intercepted (in-pane scroll path), not navigated / openUrl", () => {
    const anchor = renderBubbleAnchor("[s](#sec)");
    const ev = click(anchor);
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("a bare '#' bubble link does NOT throw (empty fragment id guard) and does not navigate", () => {
    // A bare `#` href yields an empty fragment id; querySelector('#') throws a SyntaxError without
    // the guard. The conversation pane now routes fragment links, so this path must be safe.
    const anchor = renderBubbleAnchor("[top](#)");
    // FALSIFY: remove the empty-id guard in links.ts → querySelector('#') throws inside the handler.
    expect(() => click(anchor)).not.toThrow();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
