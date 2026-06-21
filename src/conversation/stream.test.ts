// Conversation domain (Sub-Plan 02) — pure stream-model tests (falsifiable).
//
// These assert the model against ONLY the frozen vocabulary in CONTRACT.md. We do NOT assert
// any Skill or subagent-NAME shape (unfrozen — deferred to live smoke). Each key behavior was
// confirmed red-then-green by inverting it during development (mismatch ids, drop
// parent_tool_use_id, etc.); see 02-summary.md for the falsification log.

import { describe, it, expect } from "vitest";
import { ConversationModel } from "./stream";
import type {
  SystemInit,
  AssistantText,
  ToolUse,
  ToolResult,
  ModeChange,
  ResultMsg,
  PermissionDenied,
  ToolPermissionRequested,
  SubagentStarted,
} from "./types";

// ---- frozen-shape fixture builders (snake_case, field-for-field from CONTRACT.md) ----------

function sysInit(over: Partial<SystemInit> = {}): SystemInit {
  return {
    seq: 0,
    kind: "system_init",
    model: "claude",
    cwd: "/tmp",
    tools: [],
    skills: [],
    slash_commands: [],
    permission_mode: "plan",
    session_id: "s1",
    ...over,
  };
}

function text(seq: number, t: string, parent: string | null = null): AssistantText {
  return { seq, kind: "assistant_text", text: t, parent_tool_use_id: parent };
}

function toolUse(seq: number, id: string, tool: string, parent: string | null = null): ToolUse {
  return { seq, kind: "tool_use", id, tool, input: { path: "x" }, parent_tool_use_id: parent };
}

function toolResult(
  seq: number,
  toolUseId: string,
  content: unknown,
  isError = false,
  parent: string | null = null,
): ToolResult {
  return {
    seq,
    kind: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    parent_tool_use_id: parent,
  };
}

function modeChange(seq: number, mode: string): ModeChange {
  return { seq, kind: "mode_change", mode };
}

function result(seq: number, isError = false): ResultMsg {
  return {
    seq,
    kind: "result",
    subtype: "success",
    is_error: isError,
    result: "ok",
    num_turns: 1,
    duration_ms: 10,
    total_cost_usd: 0.01,
    session_id: "s1",
  };
}

function denied(seq: number, tool: string, toolUseId: string): PermissionDenied {
  return {
    seq,
    kind: "permission_denied",
    tool,
    tool_use_id: toolUseId,
    agent_id: null,
    decision_reason_type: "deny_rule",
    message: "denied by rule",
  };
}

function permReq(seq: number, id: string, tool: string, agentId: string | null = null): ToolPermissionRequested {
  return { seq, kind: "tool_permission_requested", id, tool, input: {}, agent_id: agentId };
}

describe("ConversationModel — ordering", () => {
  it("orders top-level nodes strictly by seq regardless of arrival order", () => {
    const m = new ConversationModel();
    // Append out of order: seq 2 before seq 1.
    m.appendStream(text(2, "second"));
    m.appendStream(text(1, "first"));
    const tree = m.derive();
    const texts = tree.nodes.filter((n) => n.type === "text") as Array<{ text: string }>;
    expect(texts.map((t) => t.text)).toEqual(["first", "second"]);
  });
});

describe("ConversationModel — tool correlation", () => {
  it("correlates tool_use.id -> tool_result.tool_use_id (running -> done)", () => {
    const m = new ConversationModel();
    m.appendStream(toolUse(1, "t1", "Read"));
    m.appendStream(toolResult(2, "t1", "file contents"));
    const tree = m.derive();
    const tool = tree.nodes.find((n) => n.type === "tool");
    expect(tool).toBeTruthy();
    expect(tool!.type === "tool" && tool!.status).toBe("done");
    expect(tool!.type === "tool" && tool!.result).toBe("file contents");
    expect(tool!.type === "tool" && tool!.isError).toBe(false);
  });

  it("a tool_result with is_error:true flips status to error", () => {
    const m = new ConversationModel();
    m.appendStream(toolUse(1, "t1", "Bash"));
    m.appendStream(toolResult(2, "t1", "boom", true));
    const tree = m.derive();
    const tool = tree.nodes.find((n) => n.type === "tool");
    expect(tool!.type === "tool" && tool!.status).toBe("error");
    expect(tool!.type === "tool" && tool!.isError).toBe(true);
  });

  it("a tool_use with NO matching result stays running", () => {
    const m = new ConversationModel();
    m.appendStream(toolUse(1, "t1", "Read"));
    const tree = m.derive();
    const tool = tree.nodes.find((n) => n.type === "tool");
    expect(tool!.type === "tool" && tool!.status).toBe("running");
  });

  it("MISMATCHED ids do NOT correlate — the tool stays running (falsification guard)", () => {
    // This is the inverse of the correlation test: if the model correlated by anything other
    // than id equality, this would wrongly mark the tool done.
    const m = new ConversationModel();
    m.appendStream(toolUse(1, "t1", "Read"));
    m.appendStream(toolResult(2, "DIFFERENT", "contents"));
    const tree = m.derive();
    const tool = tree.nodes.find((n) => n.type === "tool");
    expect(tool!.type === "tool" && tool!.status).toBe("running");
    expect(tool!.type === "tool" && tool!.result).toBeNull();
  });
});

describe("ConversationModel — subagent grouping (frozen keys only, NO name)", () => {
  it("nests a tool_use carrying parent_tool_use_id under a group keyed by that parent", () => {
    const m = new ConversationModel();
    // A subagent tool call: parent_tool_use_id = the parent Task tool's id.
    m.appendStream(toolUse(1, "sub-tool", "Grep", "agent-parent-1"));
    const tree = m.derive();
    const group = tree.nodes.find((n) => n.type === "subagent");
    expect(group).toBeTruthy();
    expect(group!.type === "subagent" && group!.agentId).toBe("agent-parent-1");
    expect(group!.type === "subagent" && group!.children.length).toBe(1);
    expect(group!.type === "subagent" && group!.children[0].type).toBe("tool");
    // No name field is asserted anywhere — none is frozen.
  });

  it("nests an assistant_text carrying parent_tool_use_id under the same group", () => {
    const m = new ConversationModel();
    m.appendStream(text(1, "subagent thinking", "agent-parent-1"));
    m.appendStream(toolUse(2, "sub-tool", "Glob", "agent-parent-1"));
    const tree = m.derive();
    const groups = tree.nodes.filter((n) => n.type === "subagent");
    expect(groups.length).toBe(1);
    expect(groups[0].type === "subagent" && groups[0].children.length).toBe(2);
  });

  it("nodes with NULL parent stay at top level (not grouped)", () => {
    const m = new ConversationModel();
    m.appendStream(text(1, "top level", null));
    const tree = m.derive();
    expect(tree.nodes.some((n) => n.type === "subagent")).toBe(false);
    expect(tree.nodes.some((n) => n.type === "text")).toBe(true);
  });

  it("DROPPING parent_tool_use_id (null) puts the node at top level — NOT in a group (falsification guard)", () => {
    // Inverse of grouping: with parent nulled, the same node must NOT form a subagent group.
    const m = new ConversationModel();
    m.appendStream(toolUse(1, "sub-tool", "Grep", null));
    const tree = m.derive();
    expect(tree.nodes.some((n) => n.type === "subagent")).toBe(false);
    expect(tree.nodes.some((n) => n.type === "tool")).toBe(true);
  });
});

describe("ConversationModel — subagent_started metadata (identity + task on the group)", () => {
  function subagentStarted(
    seq: number,
    toolUseId: string,
    subagentType: string | null = "Explore",
    description: string | null = "Explore current directory structure",
    prompt: string | null = "List the files...",
  ): SubagentStarted {
    return {
      seq,
      kind: "subagent_started",
      tool_use_id: toolUseId,
      subagent_type: subagentType,
      description,
      prompt,
    };
  }

  it("metadata BEFORE children: subagent_started seeds a labeled group; children nest under it", () => {
    const m = new ConversationModel();
    m.appendStream(subagentStarted(1, "agent-A"));
    // The group must EXIST already (labeled) even before any child arrives.
    let group = m.derive().nodes.find((n) => n.type === "subagent");
    expect(group).toBeTruthy();
    expect(group!.type === "subagent" && group!.subagentType).toBe("Explore");
    expect(group!.type === "subagent" && group!.description).toBe("Explore current directory structure");
    expect(group!.type === "subagent" && group!.children.length).toBe(0);
    // Now a child with matching parent_tool_use_id nests under that same group.
    m.appendStream(toolUse(2, "child-tool", "Grep", "agent-A"));
    group = m.derive().nodes.find((n) => n.type === "subagent");
    expect(group!.type === "subagent" && group!.agentId).toBe("agent-A");
    expect(group!.type === "subagent" && group!.children.length).toBe(1);
    // FALSIFY: if subagent_started is ignored, subagentType is null → RED.
    expect(group!.type === "subagent" && group!.subagentType).toBe("Explore");
  });

  it("children BEFORE metadata: a late subagent_started annotates the existing group", () => {
    const m = new ConversationModel();
    // Child arrives first → an anonymous group forms.
    m.appendStream(toolUse(1, "child-tool", "Glob", "agent-B"));
    let group = m.derive().nodes.find((n) => n.type === "subagent");
    expect(group!.type === "subagent" && group!.subagentType).toBeNull();
    // Late metadata for the SAME tool_use_id must annotate that group (order-independent).
    m.appendStream(subagentStarted(2, "agent-B", "general-purpose", "Build the thing", null));
    group = m.derive().nodes.find((n) => n.type === "subagent");
    expect(group!.type === "subagent" && group!.subagentType).toBe("general-purpose");
    expect(group!.type === "subagent" && group!.description).toBe("Build the thing");
    expect(group!.type === "subagent" && group!.children.length).toBe(1);
  });

  it("metadata for a NON-matching id does NOT annotate an unrelated group (falsification guard)", () => {
    const m = new ConversationModel();
    m.appendStream(toolUse(1, "child-tool", "Grep", "agent-C"));
    m.appendStream(subagentStarted(2, "DIFFERENT-ID", "Explore", "unrelated", null));
    const groups = m.derive().nodes.filter((n) => n.type === "subagent");
    const cGroup = groups.find((g) => g.type === "subagent" && g.agentId === "agent-C");
    // The agent-C group must stay anonymous — metadata keyed by a different id must not leak onto it.
    expect(cGroup!.type === "subagent" && cGroup!.subagentType).toBeNull();
  });
});

describe("ConversationModel — permission mode + completion", () => {
  it("system_init seeds the permission mode", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ permission_mode: "plan" }));
    expect(m.derive().permissionMode).toBe("plan");
  });

  it("mode_change flips the tracked permission mode and emits a mode node", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ permission_mode: "plan" }));
    m.appendStream(modeChange(1, "acceptEdits"));
    const tree = m.derive();
    expect(tree.permissionMode).toBe("acceptEdits");
    expect(tree.nodes.some((n) => n.type === "mode")).toBe(true);
  });

  it("is NOT complete until a result frame lands; result marks it complete", () => {
    const m = new ConversationModel();
    m.appendStream(text(1, "working"));
    expect(m.derive().complete).toBe(false);
    m.appendStream(result(2));
    expect(m.derive().complete).toBe(true);
  });
});

describe("ConversationModel — markers, denials, errors, exit", () => {
  it("records a tool-permission-requested marker node", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(permReq(1, "tp1", "ExitPlanMode"));
    const tree = m.derive();
    const node = tree.nodes.find((n) => n.type === "permission_request");
    expect(node).toBeTruthy();
    expect(node!.type === "permission_request" && node!.tool).toBe("ExitPlanMode");
  });

  it("records a permission_denied row (tool decided outside the seam stays visible)", () => {
    const m = new ConversationModel();
    m.appendStream(denied(1, "Bash", "t9"));
    const node = m.derive().nodes.find((n) => n.type === "permission_denied");
    expect(node).toBeTruthy();
    expect(node!.type === "permission_denied" && node!.tool).toBe("Bash");
  });

  it("records an error row carrying the kind/fatal", () => {
    const m = new ConversationModel();
    m.appendError({ kind: "auth", message: "token expired", fatal: true }, 1);
    const node = m.derive().nodes.find((n) => n.type === "error");
    expect(node!.type === "error" && node!.errorKind).toBe("auth");
    expect(node!.type === "error" && node!.fatal).toBe(true);
  });

  it("records an exit row carrying the code", () => {
    const m = new ConversationModel();
    m.appendExit({ code: 1 }, 1);
    const node = m.derive().nodes.find((n) => n.type === "exit");
    expect(node!.type === "exit" && node!.code).toBe(1);
  });

  it("reset clears the accumulated events", () => {
    const m = new ConversationModel();
    m.appendStream(text(1, "a"));
    m.reset();
    expect(m.derive().nodes.length).toBe(0);
  });
});

// ---- PART B: status kind + working indicator (pure model) -------------------------------------

import type { StatusMsg } from "./types";
import { WORKING_SEED_LABEL } from "./stream";

function statusMsg(seq: number, label: string): StatusMsg {
  return { seq, kind: "status", label };
}

describe("ConversationModel — status kind drives the working indicator (label only, no node)", () => {
  it("a status frame updates working.label but adds NO timeline node", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));
    const tree = m.derive();
    // FALSIFY: push a node for the status kind → nodes.length would grow → RED.
    expect(tree.nodes).toHaveLength(0); // system_init adds no node either; status adds none
    expect(tree.working).toEqual({ label: "thinking…" });
  });

  it("working is seeded BEFORE any status frame (immediate on first frame)", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    // FALSIFY: only set working when latestStatusLabel !== null → working would be null here → RED.
    expect(m.derive().working).toEqual({ label: WORKING_SEED_LABEL });
  });

  it("the latest status label wins when several arrive", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));
    m.appendStream(statusMsg(3, "running subagent"));
    expect(m.derive().working).toEqual({ label: "running subagent" });
  });

  it("working hides on result (turn complete) and re-seeds on the next turn", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));
    m.appendStream(result(3));
    // FALSIFY: don't clear active/latestStatusLabel on result → working stays non-null → RED.
    expect(m.derive().working).toBeNull();
    // A new turn's status re-activates with its own label.
    m.appendStream(statusMsg(4, "thinking…"));
    expect(m.derive().working).toEqual({ label: "thinking…" });
  });

  it("working hides on exit", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));
    m.appendExit({ code: 0 }, 99);
    expect(m.derive().working).toBeNull();
  });

  it("working hides on a FATAL error but survives a non-fatal one", () => {
    const m1 = new ConversationModel();
    m1.appendStream(sysInit({ seq: 1 }));
    m1.appendStream(statusMsg(2, "thinking…"));
    m1.appendError({ kind: "sdk", message: "boom", fatal: true }, 50);
    expect(m1.derive().working).toBeNull();

    const m2 = new ConversationModel();
    m2.appendStream(sysInit({ seq: 1 }));
    m2.appendStream(statusMsg(2, "thinking…"));
    m2.appendError({ kind: "io", message: "blip", fatal: false }, 50);
    expect(m2.derive().working).not.toBeNull();
  });
});

// ---- PART B2: waiting-for-input override (the agent is blocked on the user) --------------------

import { WAITING_INPUT_LABEL } from "./stream";

describe("ConversationModel — a pending interactive hold overrides the working label", () => {
  it("status 'thinking…' then a held ExitPlanMode → working.label is WAITING_INPUT_LABEL", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));
    m.appendPermissionRequest(permReq(3, "p1", "ExitPlanMode"));
    // FALSIFY: drop the pendingInteractive override in the working derivation → the stale
    // "thinking…" label survives the hold → RED. (Confirmed red 2026-06-12.)
    expect(m.derive().working).toEqual({ label: WAITING_INPUT_LABEL });
  });

  it("AskUserQuestion → waiting label; question_answered → reverts to the last status label", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));
    m.appendPermissionRequest(permReq(3, "q1", "AskUserQuestion"));
    expect(m.derive().working).toEqual({ label: WAITING_INPUT_LABEL });
    // The user submits answers (the controller appends the synthetic question_answered).
    m.appendQuestionAnswered("q1", { "Which?": "A" }, 1_000_000_000);
    // FALSIFY: never clear pendingInteractive on question_answered → waiting label sticks → RED.
    expect(m.derive().working).toEqual({ label: "thinking…" });
  });

  it("AskUserQuestion with NO prior status reverts to the generic seed after answering", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendPermissionRequest(permReq(2, "q1", "AskUserQuestion"));
    expect(m.derive().working).toEqual({ label: WAITING_INPUT_LABEL });
    m.appendQuestionAnswered("q1", { "Which?": "A" }, 1_000_000_000);
    expect(m.derive().working).toEqual({ label: WORKING_SEED_LABEL });
  });

  it("any frame proving the turn progressed clears the waiting label (assistant_text)", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendPermissionRequest(permReq(2, "p1", "ExitPlanMode"));
    expect(m.derive().working).toEqual({ label: WAITING_INPUT_LABEL });
    // The SDK emits no frames while a hold is pending — a fresh frame means it was released.
    m.appendStream(text(3, "continuing"));
    // FALSIFY: don't clear pendingInteractive on progress frames → waiting label sticks → RED.
    expect(m.derive().working).toEqual({ label: WORKING_SEED_LABEL });
  });

  it("a result after a hold yields working === null (turn-complete semantics pinned)", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendPermissionRequest(permReq(2, "p1", "ExitPlanMode"));
    m.appendStream(result(3));
    // FALSIFY: let the pending hold force a non-null working past result → RED.
    expect(m.derive().working).toBeNull();
  });

  it("appendPermissionResolved clears the waiting label IMMEDIATELY (no new frame needed)", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));
    m.appendPermissionRequest(permReq(3, "p1", "ExitPlanMode"));
    expect(m.derive().working).toEqual({ label: WAITING_INPUT_LABEL });
    // The ExitPlanMode resolve path (Approve / Request changes) — NO inbound frame has arrived.
    m.appendPermissionResolved("p1", 1_000_000_000);
    // FALSIFY: drop the permission_resolved branch in derive → waiting label sticks → RED.
    expect(m.derive().working).toEqual({ label: "thinking…" });
  });

  it("a resolve for a DIFFERENT id does not clear a newer hold (id-matched clear)", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendPermissionRequest(permReq(2, "p2", "ExitPlanMode"));
    // A stale resolve for an older hold must not release the live one.
    m.appendPermissionResolved("p1", 1_000_000_000);
    // FALSIFY: clear pendingInteractive on ANY resolve regardless of id → RED.
    expect(m.derive().working).toEqual({ label: WAITING_INPUT_LABEL });
  });
});

describe("ConversationModel — whitespace-only assistant_text is dropped", () => {
  it("a whitespace-only text frame yields zero text nodes; a real-text frame yields one", () => {
    const m = new ConversationModel();
    m.appendStream(text(1, "   \n"));
    // FALSIFY: keep placing whitespace-only frames in derive() → a text node appears → RED.
    expect(m.derive().nodes.filter((n) => n.type === "text")).toHaveLength(0);

    m.appendStream(text(2, "real text"));
    const texts = m.derive().nodes.filter((n) => n.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].type === "text" && texts[0].text).toBe("real text");
  });

  it("a whitespace-only frame with a parent_tool_use_id does NOT seed a subagent group", () => {
    const m = new ConversationModel();
    m.appendStream(text(1, "  \n  ", "agent-1"));
    const tree = m.derive();
    // FALSIFY: place the blank frame anyway → groupFor("agent-1") creates a group → RED.
    expect(tree.nodes.filter((n) => n.type === "subagent")).toHaveLength(0);
  });
});

describe("ConversationModel — appendUserMessage echoes a user node in stream order", () => {
  it("a user message after assistant content yields a UserMessageNode with that text, AFTER the assistant node", () => {
    const m = new ConversationModel();
    // Prior assistant content at wire seq 1.
    m.appendStream(text(1, "here is the plan"));
    // The user submits feedback — appendUserMessage stamps it at lastWireSeq + 0.5 (= 1.5), so it
    // sorts after the assistant frame.
    m.appendUserMessage("hello");

    const nodes = m.derive().nodes;
    const userNodes = nodes.filter((n) => n.type === "user");
    expect(userNodes).toHaveLength(1);
    expect(userNodes[0].type === "user" && userNodes[0].text).toBe("hello");

    const assistantIdx = nodes.findIndex((n) => n.type === "text");
    const userIdx = nodes.findIndex((n) => n.type === "user");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(assistantIdx);
  });

  it("the user bubble sorts BEFORE the agent's reply (the next wire frame), not after it", () => {
    // This mirrors the LIVE free-text composer path: the agent replies in the SAME session, so its
    // reply arrives as the next wire frame. The user bubble MUST sit between the prompt it answered
    // and the reply it prompted.
    const m = new ConversationModel();
    // Turn 1: the agent's prior message at wire seq 5.
    m.appendStream(text(5, "earlier assistant message"));
    // The user submits via the REAL production path (no hand-picked seq) — appendUserMessage stamps
    // it at lastWireSeq + 0.5 (= 5.5).
    m.appendUserMessage("please change the title");
    // Turn 2: the agent's REPLY arrives as the NEXT wire frame at seq 6.
    m.appendStream(text(6, "done — updated the title"));

    const nodes = m.derive().nodes;
    const userIdx = nodes.findIndex((n) => n.type === "user");
    const replyIdx = nodes.findIndex(
      (n) => n.type === "text" && n.text === "done — updated the title",
    );
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    // FALSIFY: under the old synthSeq scheme the bubble was stamped at ~1e9, which sorts AFTER the
    // reply (seq 6) → replyIdx < userIdx → this assertion goes RED. With lastWireSeq + 0.5 (= 5.5) the
    // bubble sorts before the reply → GREEN.
    expect(replyIdx).toBeGreaterThan(userIdx);
  });

  it("the placement is stable across repeated derives", () => {
    const m = new ConversationModel();
    m.appendStream(text(2, "a"));
    m.appendUserMessage("mid");
    m.appendStream(text(3, "b"));
    const order = (): string[] =>
      m
        .derive()
        .nodes.map((n) =>
          n.type === "user" ? "user" : n.type === "text" ? `text:${n.text}` : n.type,
        );
    // Two consecutive derives must yield IDENTICAL ordering (the 0.5 tiebreaker is frozen into the
    // stored event, not recomputed per-derive).
    expect(order()).toEqual(["text:a", "user", "text:b"]);
    expect(order()).toEqual(["text:a", "user", "text:b"]);
  });
});

// ---- PART C: quota_exceeded is INERT in the reducer (Phase 2) ----------------------------------
//
// The non-fatal `quota_exceeded` agent-stream frame carries the orchestrator's reset signal but the
// PURE reducer treats it as a no-op: no timeline node, no `complete` flip, no change to the working/
// active indicator state. (The waiting banner + auto-resume are owned by the orchestrator observer
// in a LATER phase — NOT this reducer.)

import type { QuotaExceeded } from "./types";

function quotaExceeded(seq: number, over: Partial<QuotaExceeded> = {}): QuotaExceeded {
  return {
    seq,
    kind: "quota_exceeded",
    resetAt: 1_700_000_000_000,
    source: "rate_limit_event",
    ...over,
  };
}

describe("ConversationModel — quota_exceeded is inert in the pure reducer", () => {
  it("adds NO timeline node, does NOT flip complete, does NOT change working/active state", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(statusMsg(2, "thinking…"));

    // Snapshot the state BEFORE the quota frame.
    const before = m.derive();
    expect(before.nodes).toHaveLength(0);
    expect(before.complete).toBe(false);
    expect(before.working).toEqual({ label: "thinking…" });

    m.appendStream(quotaExceeded(3, { source: "thrown_error", resetAt: 1_800_000_000_000 }));

    const after = m.derive();
    // FALSIFY: make the `quota_exceeded` case push a render node → after.nodes grows → RED.
    expect(after.nodes).toHaveLength(0);
    // FALSIFY: make the case set `complete = true` → this goes RED.
    expect(after.complete).toBe(false);
    // FALSIFY: make the case clear active / reset latestStatusLabel → working goes null/changes → RED.
    expect(after.working).toEqual({ label: "thinking…" });
  });
});
