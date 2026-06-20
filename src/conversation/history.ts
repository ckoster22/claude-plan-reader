// Conversation domain — past-conversation reconstruction (Phase 1).
//
// PURE transform: raw Claude Code CLI transcript jsonl records -> the app's `AgentStream`
// vocabulary (types.ts is the SINGLE SOURCE OF TRUTH for those frame shapes), replayed through the
// existing ConversationModel + renderer. No DOM, no I/O — the caller supplies the already-read lines
// and a small meta blob; this module just maps records to frames.
//
// Sequencing: ONE monotonic counter, incremented per EMITTED frame in file order, starting at 0. A
// synthesized SystemInit is always emitted FIRST at seq 0, so the rest of the conversation orders
// against it deterministically. User turns are emitted as a distinct `user` HistoryEvent carrying the
// same monotonic seq, so `applyTranscriptToModel` can replay them via
// `ConversationModel.appendUserMessageAt(text, seq)` — i.e. by their TRUE file position rather than
// the live `lastWireSeq + 0.5` rule.
//
// Phase 1 scope: top-level conversation only. Every `parent_tool_use_id` is null; no ResultMsg is
// fabricated (no turn/cost totals). Subagent nesting is deferred to Phase 3.

import type { AgentStream } from "./types";
import type { ConversationModel } from "./stream";

// A replayable history entry: either a fully-built AgentStream frame, or a user turn carrying the
// verbatim text + its file-position seq (replayed via appendUserMessageAt, which has no AgentStream
// equivalent — the live user echo is a host-side ModelEvent, not a wire frame).
export type HistoryEvent =
  | { kind: "stream"; stream: AgentStream }
  | { kind: "user"; text: string; seq: number }
  // A harness-injected, role:"user" transcript record that is NOT something the human typed —
  // a plumbing turn (subagent task-notification, local-command stdout/stderr, bash-input/-stdout,
  // system-reminder, or any generic leading XML-ish tag that is not a slash command). Rendered as a
  // de-emphasized SYSTEM bubble, NEVER as an orange user message. See classifyUserText.
  | { kind: "system"; text: string; seq: number };

// Meta supplied by the caller (from the Rust `read_plan_transcript` result): the resolved cwd and
// session id of the authoring transcript. Either may be null when resolution was partial.
export interface TranscriptMeta {
  cwd: string | null;
  sessionId: string | null;
}

// ---- raw wire shapes (intentionally loose — this is the un-typed CLI jsonl layer) --------------

interface RawBlock {
  type?: unknown;
  text?: unknown;
  // tool_use
  id?: unknown;
  name?: unknown; // tool NAME lives under `name` at this raw layer (NOT `tool`)
  input?: unknown;
  // tool_result
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface RawRecord {
  type?: unknown;
  isMeta?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

// Bracketed system notices the CLI injects as synthetic user-text blocks (e.g. an interrupt). These
// are not real user turns and must not render as user bubbles.
const SYNTHETIC_USER_TEXT = /^\s*\[Request interrupted/i;

// Plumbing-turn leading tags: harness-injected role:"user" records whose text BEGINS with one of
// these wrapper tags is not a human message — it is infrastructure (subagent results, command
// output, bash plumbing, system reminders). These render as a DIM "SYSTEM" bubble, never orange.
const PLUMBING_TAGS = [
  "task-notification",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "system-reminder",
];

// A generic catch-all for any OTHER leading XML-ish tag (lowercase + hyphens) the harness may inject
// that is NOT a `<command-...>` wrapper. Investigation confirmed genuine human prose never starts
// with a `<tag>`, so a leading tag that is not a slash-command is plumbing by definition.
const LEADING_TAG = /^<([a-z][a-z-]*)>/;

// Extract the inner text of the FIRST `<tag>…</tag>` pair for the given tag name. Returns "" when the
// tag is absent or empty. Used to unwrap a `<command-name>` slash-command invocation.
function innerTag(text: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(text);
  return m ? m[1].trim() : "";
}

// The three-way classification of a role:"user" text record. The investigation confirmed the three
// categories never mix within a single record — each record is wholly one kind, and genuine human
// prose never starts with a `<tag>`.
//   - { kind: "user", text }   → a genuine human message OR an unwrapped slash-command invocation.
//   - { kind: "system", text } → a plumbing turn (rendered as a dim SYSTEM bubble).
// Slash-command shape:
//   <command-name>/write-plan</command-name>
//   <command-message>write-plan</command-message>
//   <command-args>…the real user request…</command-args>
// The wrapper CONTAINS the user's real prompt. We STRIP it and surface the command name + a blank
// line + the args (just the command name when args are empty), since this IS genuine user intent.
function classifyUserText(text: string): { kind: "user" | "system"; text: string } {
  // (b) Slash-command invocation — unwrap to the genuine user intent (command name + args).
  if (/^\s*<command-name>/.test(text)) {
    const command = innerTag(text, "command-name"); // e.g. "/write-plan"
    const args = innerTag(text, "command-args"); // the real user request (may be empty)
    const cleaned = args ? `${command}\n\n${args}` : command;
    return { kind: "user", text: cleaned };
  }

  // (c) Plumbing turn — a known plumbing tag OR any generic leading tag that is NOT a command wrapper.
  const tagMatch = LEADING_TAG.exec(text);
  if (tagMatch) {
    const tag = tagMatch[1];
    if (PLUMBING_TAGS.includes(tag) || !tag.startsWith("command-")) {
      return { kind: "system", text };
    }
  }

  // (d) Genuine human prose — no leading wrapper tag.
  return { kind: "user", text };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Parse the transcript lines into an ordered HistoryEvent list. Pure: never throws on bad input —
// unparseable lines and non-object records are skipped.
export function parseTranscript(lines: string[], meta: TranscriptMeta): HistoryEvent[] {
  let seq = 0;
  const events: HistoryEvent[] = [];

  // Synthesized SystemInit FIRST, at seq 0 (consumes the counter's first value).
  events.push({
    kind: "stream",
    stream: {
      seq: seq++,
      kind: "system_init",
      model: "",
      cwd: meta.cwd ?? "",
      tools: [],
      skills: [],
      slash_commands: [],
      permission_mode: "plan",
      session_id: meta.sessionId ?? "",
    },
  });

  for (const line of lines) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip unparseable lines
    }
    if (!isPlainObject(rec)) continue;
    const record = rec as RawRecord;

    // Defense-in-depth meta filter (Rust pre-filters server-side, but the transform must stand alone).
    if (
      record.isMeta === true ||
      record.isVisibleInTranscriptOnly === true ||
      record.isSidechain === true ||
      record.isCompactSummary === true
    ) {
      continue;
    }

    const type = record.type;
    if (type !== "user" && type !== "assistant") continue;

    const message = record.message;
    if (!isPlainObject(message)) continue;
    const role = message.role;

    // Normalize content: a string becomes a single text block; otherwise iterate the array. Anything
    // else (missing/object) yields no blocks.
    let blocks: RawBlock[];
    if (typeof message.content === "string") {
      blocks = [{ type: "text", text: message.content }];
    } else if (Array.isArray(message.content)) {
      blocks = message.content.filter(isPlainObject) as RawBlock[];
    } else {
      blocks = [];
    }

    for (const block of blocks) {
      const btype = block.type;

      if (btype === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (role === "assistant") {
          if (text.trim() === "") continue; // skip empty/whitespace-only assistant text
          events.push({
            kind: "stream",
            stream: {
              seq: seq++,
              kind: "assistant_text",
              text,
              parent_tool_use_id: null,
            },
          });
        } else if (role === "user") {
          if (text.trim() === "") continue;
          if (SYNTHETIC_USER_TEXT.test(text)) continue; // skip synthetic interrupt notices
          // Attribute the record: a genuine human message, an unwrapped slash-command (both USER),
          // or a harness-injected plumbing turn (SYSTEM — dim bubble, never orange). The three
          // categories never mix; genuine prose never starts with a `<tag>`.
          const classified = classifyUserText(text);
          events.push({ kind: classified.kind, text: classified.text, seq: seq++ });
        }
        continue;
      }

      if (btype === "tool_use") {
        events.push({
          kind: "stream",
          stream: {
            seq: seq++,
            kind: "tool_use",
            id: typeof block.id === "string" ? block.id : "",
            tool: typeof block.name === "string" ? block.name : "", // NAME, not `tool`
            input: block.input,
            parent_tool_use_id: null,
          },
        });
        continue;
      }

      if (btype === "tool_result") {
        events.push({
          kind: "stream",
          stream: {
            seq: seq++,
            kind: "tool_result",
            tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
            content: block.content,
            is_error: block.is_error === true,
            parent_tool_use_id: null,
          },
        });
        continue;
      }
      // Any other block type (thinking, image, etc.) is ignored in Phase 1.
    }
  }

  return events;
}

// Replay a parsed HistoryEvent list into a ConversationModel in order: stream frames via
// appendStream, user turns via appendUserMessageAt (explicit file-position seq). The caller then
// calls model.derive() to render.
export function applyTranscriptToModel(
  model: ConversationModel,
  events: HistoryEvent[],
): void {
  for (const ev of events) {
    if (ev.kind === "stream") {
      model.appendStream(ev.stream);
    } else if (ev.kind === "system") {
      model.appendSystemMessageAt(ev.text, ev.seq);
    } else {
      model.appendUserMessageAt(ev.text, ev.seq);
    }
  }
}
