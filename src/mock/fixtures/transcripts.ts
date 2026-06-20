// Mock-mode fixtures — plan HISTORY transcripts (Phase 3).
//
// The conversation controller's loadHistoryForPlan(stem) invokes `read_plan_transcript({ stem })` and
// feeds its `lines` (raw CLI jsonl records) through the REAL parseTranscript → applyTranscriptToModel →
// renderTree history-replay path. We return a canned transcript for a designated stem so that path
// renders, and `found:false` / empty content for others so the explicit empty states render.
//
// `lines` are JSONL strings of CLI transcript records (the exact shape parseTranscript consumes — see
// src/conversation/history.ts and history.test.ts): an assistant text/tool_use record, a user
// tool_result, and a user text turn.

// The result shape `read_plan_transcript` returns (mirrors the backend; see conversation/index.ts).
export interface PlanTranscriptResult {
  found: boolean;
  path: string | null;
  cwd: string | null;
  session_id: string | null;
  lines: string[];
}

// VERBATIM raw import of the REAL Chompy-Asteroids session transcript (filtered to user/assistant,
// non-meta records — exactly replicating the Rust `filter_transcript_lines` server-side filter; see
// chompy-session.jsonl's header comment). Imported as a raw string via Vite's `?raw` suffix and split
// on newlines into the `lines: string[]` shape parseTranscript consumes. This makes selecting ANY of
// the nine Chompy plan nodes in the mock replay a real, explorable historical conversation — matching
// the live app, where every app-authored `tree_id` plan resolves (via resolve_tree_fallback /
// resolve_tree_session) to the SAME originating session transcript.
import CHOMPY_SESSION_RAW from "./chompy-session.jsonl?raw";
import { NODES_TITLES, NESTED_TREE_ID } from "./nested";

// The real cwd + session id captured from the source transcript's first records (the file these
// lines were sliced from: projects/<encoded>/248792f6-5bc1-4d4c-b10a-03f3ceb806f6.jsonl).
const CHOMPY_CWD = "/Users/user/Documents/repos/scratch/chompy-asteroids";
const CHOMPY_SESSION_ID = "248792f6-5bc1-4d4c-b10a-03f3ceb806f6";
const CHOMPY_PATH = `/Users/user/.claude/projects/-Users-user-Documents-repos-scratch-${NESTED_TREE_ID.split("-")[0]}/${CHOMPY_SESSION_ID}.jsonl`;

// Split the raw fixture into non-empty jsonl line strings (the exact shape parseTranscript wants:
// raw CLI transcript record strings, one JSON object per line). A trailing newline yields no empty tail.
const CHOMPY_LINES: string[] = CHOMPY_SESSION_RAW.split("\n").filter((l) => l.trim() !== "");

// The set of stems that resolve to the Chompy session. The mock sets each Chompy node's
// `filename_stem` to its real H1 title (see nested.ts), and loadPlanHistory(stem) passes that stem to
// read_plan_transcript — so we match on the nine titles. All nine share the tree_id, so the real app
// resolves them all to the same session: we replicate that (every node returns the tree transcript).
const CHOMPY_STEMS: ReadonlySet<string> = new Set(NODES_TITLES);

// One raw jsonl line from a record object (mirrors history.test.ts's `line` helper).
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
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  });
}

function userText(text: string): string {
  return line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

// The stem whose history pane renders a real replayed conversation. Selecting this plan opens the
// reading pane AND silently populates the Conversation tab with the replayed transcript.
export const HISTORY_STEM = "read-standalone";

// The stem with NO resolvable transcript → the "no-transcript" empty state.
export const NO_TRANSCRIPT_STEM = "unknown-cwd";

// The stem whose transcript IS found but yields zero renderable nodes → the "no-content" empty state.
export const NO_CONTENT_STEM = "variant-image";

// The canned transcript for HISTORY_STEM: a short assistant→tool→result→user exchange so the replayed
// model derives a text node, a done tool node, and a user node (in file order).
const HISTORY_LINES: string[] = [
  assistantText("Here is the plan I drafted earlier."),
  assistantToolUse("hist-tool-1", "Read", { file_path: "/Users/mock/work/notes/plan.md" }),
  userToolResult("hist-tool-1", "# Earlier plan\n\n- Outline\n- Draft\n- Review"),
  assistantText("I read the earlier plan; it still looks right."),
  userText("Great, let's proceed with this."),
];

// Return the transcript result for a stem. The designated history stem returns a found transcript with
// lines; the no-content stem returns found-but-empty (parseTranscript still synthesizes a SystemInit,
// but applyTranscriptToModel yields zero RENDERABLE nodes → the no-content empty state); every other
// stem returns found:false → the no-transcript empty state.
export function transcriptFor(stem: string): PlanTranscriptResult {
  // The nine Chompy nodes (matched by their real-title stems) all resolve to the SAME originating
  // session transcript — exactly as the live app's tree_id fallback does. Selecting the master OR any
  // sub-plan replays the real, explorable historical conversation.
  if (CHOMPY_STEMS.has(stem)) {
    return {
      found: true,
      path: CHOMPY_PATH,
      cwd: CHOMPY_CWD,
      session_id: CHOMPY_SESSION_ID,
      lines: CHOMPY_LINES,
    };
  }
  if (stem === HISTORY_STEM) {
    return {
      found: true,
      path: "/Users/mock/.claude/projects/mock/history.jsonl",
      cwd: "/Users/mock/work/notes",
      session_id: "mock-history-session",
      lines: HISTORY_LINES,
    };
  }
  if (stem === NO_CONTENT_STEM) {
    // found, but the lines yield no renderable nodes: a whitespace-ONLY assistant text record is
    // skipped by the transform (the proven no-content shape — see history-pane.test.ts), leaving only
    // the synthesized SystemInit, which is not a renderable node. So replayModel.derive().nodes.length
    // === 0 → the no-content empty state.
    return {
      found: true,
      path: "/Users/mock/.claude/projects/mock/empty.jsonl",
      cwd: "/Users/mock/work/widgets",
      session_id: "mock-empty-session",
      lines: [assistantText("   ")],
    };
  }
  return { found: false, path: null, cwd: null, session_id: null, lines: [] };
}
