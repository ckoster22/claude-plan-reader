// Conversation domain — history reconstruction tests (Phase 1, falsifiable).
//
// These assert the PURE `parseTranscript` transform (raw CLI jsonl records -> AgentStream
// vocabulary) against the frozen types.ts shapes, and end-to-end through the real ConversationModel
// + derive() so the renderer's correlation/ordering is exercised, not just the frame list.
//
// Falsifiability log (each confirmed red-then-green during development):
//   - Flipping the tool_use id (so the result no longer correlates) breaks the "tool node status
//     done" assertion below — the tool would stay "running". Confirmed by temporarily emitting a
//     mismatched id.
//   - Reading the tool NAME from `block.tool` instead of `block.name` makes the tool name assertion
//     go RED (name becomes "" / undefined). Confirmed by swapping the field.
//   - Removing the per-frame seq increment collapses ordering — the strict-increase assertions fail.

import { describe, it, expect } from "vitest";
import { parseTranscript, applyTranscriptToModel } from "./history";
import type { HistoryEvent } from "./history";
import { ConversationModel } from "./stream";

const META = { cwd: "/work/dir", sessionId: "sess-1" };

// Build one raw jsonl line from a record object.
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function assistantText(text: string): string {
  return line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function assistantToolUse(id: string, name: string, input: unknown): string {
  return line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

function userToolResult(toolUseId: string, content: unknown, isError = false): string {
  return line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  });
}

function userText(text: string): string {
  return line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

describe("parseTranscript — exact ordered HistoryEvent[] mapping", () => {
  it("synthesizes SystemInit at seq 0 from meta, then maps text/tool_use/tool_result/user in file order", () => {
    const lines = [
      assistantText("here is the plan"),
      assistantToolUse("tool-1", "Read", { path: "/x" }),
      userToolResult("tool-1", "file contents"),
      userText("looks good, proceed"),
    ];

    const events = parseTranscript(lines, META);

    // 1 SystemInit + 1 assistant_text + 1 tool_use + 1 tool_result + 1 user = 5 events.
    expect(events.length).toBe(5);

    // seq is monotonic from 0, one per emitted frame, in file order.
    const seqs = events.map((e) => (e.kind === "stream" ? e.stream.seq : e.seq));
    expect(seqs).toEqual([0, 1, 2, 3, 4]);

    // SystemInit synthesized from meta.
    const init = events[0];
    expect(init.kind === "stream" && init.stream.kind).toBe("system_init");
    if (init.kind === "stream" && init.stream.kind === "system_init") {
      expect(init.stream.cwd).toBe("/work/dir");
      expect(init.stream.session_id).toBe("sess-1");
      expect(init.stream.model).toBe("");
      expect(init.stream.permission_mode).toBe("plan");
      expect(init.stream.tools).toEqual([]);
    }

    // assistant_text, parent null.
    const t = events[1];
    expect(t.kind === "stream" && t.stream.kind).toBe("assistant_text");
    if (t.kind === "stream" && t.stream.kind === "assistant_text") {
      expect(t.stream.text).toBe("here is the plan");
      expect(t.stream.parent_tool_use_id).toBeNull();
    }

    // tool_use — tool NAME read from `name`, parent null.
    const tu = events[2];
    expect(tu.kind === "stream" && tu.stream.kind).toBe("tool_use");
    if (tu.kind === "stream" && tu.stream.kind === "tool_use") {
      expect(tu.stream.id).toBe("tool-1");
      expect(tu.stream.tool).toBe("Read"); // falsifiable: reading block.tool yields "" here
      expect(tu.stream.input).toEqual({ path: "/x" });
      expect(tu.stream.parent_tool_use_id).toBeNull();
    }

    // tool_result correlates by tool_use_id.
    const tr = events[3];
    expect(tr.kind === "stream" && tr.stream.kind).toBe("tool_result");
    if (tr.kind === "stream" && tr.stream.kind === "tool_result") {
      expect(tr.stream.tool_use_id).toBe("tool-1");
      expect(tr.stream.content).toBe("file contents");
      expect(tr.stream.is_error).toBe(false);
      expect(tr.stream.parent_tool_use_id).toBeNull();
    }

    // user turn carries verbatim text + its file-position seq.
    const u = events[4];
    expect(u.kind).toBe("user");
    if (u.kind === "user") {
      expect(u.text).toBe("looks good, proceed");
      expect(u.seq).toBe(4);
    }
  });

  it("renders end-to-end through ConversationModel.derive(): text, tool(done), user nodes in file order", () => {
    const lines = [
      assistantText("here is the plan"),
      assistantToolUse("tool-1", "Read", { path: "/x" }),
      userToolResult("tool-1", "file contents"),
      userText("looks good, proceed"),
    ];
    const events = parseTranscript(lines, META);

    const model = new ConversationModel();
    applyTranscriptToModel(model, events);
    const nodes = model.derive().nodes;

    // Expect a text node, a tool node (done, result correlated by id), a user node — in file order.
    const types = nodes.map((n) => n.type);
    expect(types).toEqual(["text", "tool", "user"]);

    const toolNode = nodes.find((n) => n.type === "tool");
    expect(toolNode).toBeTruthy();
    // FALSIFY: if the tool_use id and tool_result.tool_use_id no longer match (e.g. id flipped in the
    // transform), correlation fails and status stays "running" — this assertion goes RED.
    expect(toolNode!.type === "tool" && toolNode!.status).toBe("done");
    expect(toolNode!.type === "tool" && toolNode!.tool).toBe("Read");
    expect(toolNode!.type === "tool" && toolNode!.result).toBe("file contents");

    const userNode = nodes.find((n) => n.type === "user");
    expect(userNode!.type === "user" && userNode!.text).toBe("looks good, proceed");
  });
});

describe("parseTranscript — content normalization", () => {
  it("a record whose message.content is a STRING produces one text node (not dropped/thrown)", () => {
    const lines = [
      line({ type: "assistant", message: { role: "assistant", content: "plain string body" } }),
    ];
    const events = parseTranscript(lines, META);
    // SystemInit + one assistant_text.
    expect(events.length).toBe(2);
    const t = events[1];
    expect(t.kind === "stream" && t.stream.kind).toBe("assistant_text");
    if (t.kind === "stream" && t.stream.kind === "assistant_text") {
      expect(t.stream.text).toBe("plain string body");
    }

    const model = new ConversationModel();
    applyTranscriptToModel(model, events);
    const textNodes = model.derive().nodes.filter((n) => n.type === "text");
    expect(textNodes).toHaveLength(1);
  });
});

describe("parseTranscript — user-turn ordering", () => {
  it("two consecutive user text turns produce user nodes in file order with strictly increasing seq", () => {
    const lines = [userText("first turn"), userText("second turn")];
    const events = parseTranscript(lines, META);

    const userEvents = events.filter((e): e is Extract<HistoryEvent, { kind: "user" }> => e.kind === "user");
    expect(userEvents.map((e) => e.text)).toEqual(["first turn", "second turn"]);
    // FALSIFY: drop the per-frame seq increment → seqs collapse → this strict-increase fails.
    expect(userEvents[1].seq).toBeGreaterThan(userEvents[0].seq);

    const model = new ConversationModel();
    applyTranscriptToModel(model, events);
    const userNodes = model.derive().nodes.filter((n) => n.type === "user");
    expect(userNodes.map((n) => (n.type === "user" ? n.text : ""))).toEqual([
      "first turn",
      "second turn",
    ]);
  });
});

describe("parseTranscript — role:user attribution (genuine vs slash-command vs plumbing)", () => {
  it("a <task-notification> record becomes ONE system event (NOT a user event)", () => {
    const lines = [userText("<task-notification>subagent A finished</task-notification>")];
    const events = parseTranscript(lines, META);
    // SystemInit + exactly one system event.
    expect(events.length).toBe(2);
    const ev = events[1];
    // FALSIFY: if the classifier let task-notification through as a user event, this fails.
    expect(ev.kind).toBe("system");
    if (ev.kind === "system") {
      expect(ev.text).toBe("<task-notification>subagent A finished</task-notification>");
      expect(ev.seq).toBe(1);
    }
    // It must NOT be a user event.
    expect(events.some((e) => e.kind === "user")).toBe(false);
  });

  it("a <bash-input> record becomes a system event", () => {
    const lines = [userText("<bash-input>ls -la</bash-input>")];
    const events = parseTranscript(lines, META);
    expect(events.length).toBe(2);
    expect(events[1].kind).toBe("system");
  });

  it("a generic non-command leading tag (<some-injected-thing>) becomes a system event", () => {
    const lines = [userText("<some-injected-thing>noise</some-injected-thing>")];
    const events = parseTranscript(lines, META);
    expect(events[1].kind).toBe("system");
  });

  it("a <command-name>/write-plan</command-name>…<command-args>X</command-args> record becomes ONE user event with the wrapper STRIPPED", () => {
    const raw =
      "<command-name>/write-plan</command-name>\n" +
      "<command-message>write-plan</command-message>\n" +
      "<command-args>To the right of the conversation view, add a minimap.</command-args>";
    const events = parseTranscript([userText(raw)], META);
    expect(events.length).toBe(2);
    const ev = events[1];
    // It is a USER event (genuine intent), NOT system.
    expect(ev.kind).toBe("user");
    if (ev.kind === "user") {
      // Wrapper stripped: command name + the real args are present; the raw <command-*> tags are gone.
      expect(ev.text).toContain("/write-plan");
      expect(ev.text).toContain("To the right of the conversation view");
      expect(ev.text).not.toContain("<command-name>");
      expect(ev.text).not.toContain("<command-args>");
      expect(ev.text).not.toContain("<command-message>");
      // Shape: command name, blank line, args.
      expect(ev.text).toBe(
        "/write-plan\n\nTo the right of the conversation view, add a minimap.",
      );
    }
  });

  it("a slash-command with EMPTY args becomes a user event of just the command name", () => {
    const raw =
      "<command-name>/clear</command-name>\n" +
      "<command-message>clear</command-message>\n" +
      "<command-args></command-args>";
    const events = parseTranscript([userText(raw)], META);
    const ev = events[1];
    expect(ev.kind).toBe("user");
    if (ev.kind === "user") expect(ev.text).toBe("/clear");
  });

  it("genuine human prose (no leading tag) stays a USER event, verbatim", () => {
    const events = parseTranscript([userText("please add a dark mode toggle")], META);
    const ev = events[1];
    expect(ev.kind).toBe("user");
    if (ev.kind === "user") expect(ev.text).toBe("please add a dark mode toggle");
  });

  it("a mixed transcript keeps seqs monotonic and preserves file order across user/system kinds", () => {
    const lines = [
      userText("genuine first message"),
      userText("<task-notification>subagent result</task-notification>"),
      assistantText("on it"),
      userText("<local-command-stdout>done</local-command-stdout>"),
    ];
    const events = parseTranscript(lines, META);
    // SystemInit(0) + user(1) + system(2) + assistant_text(3) + system(4).
    const seqs = events.map((e) => (e.kind === "stream" ? e.stream.seq : e.seq));
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    expect(events.map((e) => e.kind)).toEqual(["stream", "user", "system", "stream", "system"]);
  });

  it("end-to-end: a system record renders a SystemMessageNode in seq order", () => {
    const lines = [
      userText("genuine ask"),
      userText("<task-notification>subagent finished</task-notification>"),
    ];
    const events = parseTranscript(lines, META);
    const model = new ConversationModel();
    applyTranscriptToModel(model, events);
    const nodes = model.derive().nodes;
    expect(nodes.map((n) => n.type)).toEqual(["user", "system"]);
    const sys = nodes.find((n) => n.type === "system");
    expect(sys!.type === "system" && sys!.text).toBe(
      "<task-notification>subagent finished</task-notification>",
    );
  });
});

describe("parseTranscript — robustness / filtering", () => {
  it("a malformed (non-JSON) line is skipped; surrounding records still parse", () => {
    const lines = ["{ this is not valid json", assistantText("survived")];
    const events = parseTranscript(lines, META);
    // SystemInit + the one valid assistant_text (the garbage line dropped).
    expect(events.length).toBe(2);
    const t = events[1];
    expect(t.kind === "stream" && t.stream.kind === "assistant_text" && t.stream.text).toBe(
      "survived",
    );
  });

  it("parseTranscript([], meta) returns just the synthesized SystemInit", () => {
    const events = parseTranscript([], META);
    expect(events.length).toBe(1);
    expect(events[0].kind === "stream" && events[0].stream.kind).toBe("system_init");
  });

  it("a record flagged isMeta:true is skipped", () => {
    const lines = [
      line({
        type: "assistant",
        isMeta: true,
        message: { role: "assistant", content: [{ type: "text", text: "meta noise" }] },
      }),
      assistantText("real text"),
    ];
    const events = parseTranscript(lines, META);
    // SystemInit + only the non-meta assistant_text.
    expect(events.length).toBe(2);
    const t = events[1];
    expect(t.kind === "stream" && t.stream.kind === "assistant_text" && t.stream.text).toBe(
      "real text",
    );
  });

  it("null meta falls back to empty cwd/session_id on the SystemInit", () => {
    const events = parseTranscript([], { cwd: null, sessionId: null });
    const init = events[0];
    if (init.kind === "stream" && init.stream.kind === "system_init") {
      expect(init.stream.cwd).toBe("");
      expect(init.stream.session_id).toBe("");
    }
  });
});
