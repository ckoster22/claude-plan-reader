// FALSIFIABLE regression for the empty-Conversation-pane bug.
//
// BUG: selecting the app-authored "Chompy Asteroids" master plan (tree_id tree-mqcobtz3-5632dc17)
// in the MOCK harness showed an almost-empty Conversation pane, because the mock's
// read_plan_transcript returned found:false for the Chompy stems. The live app resolves every
// app-authored tree_id plan to its originating session transcript (resolve_tree_fallback /
// resolve_tree_session) and replays it.
//
// INVARIANT (what SHOULD be true, independent of implementation): the mock read_plan_transcript for
// ANY of the nine Chompy node stems returns found:true with NON-EMPTY lines, AND feeding those lines
// through the REAL parseTranscript -> ConversationModel -> derive() yields > 0 renderable nodes.
//
// FALSIFIABILITY: if the fixture lines were empty (or the stem matched found:false), parseTranscript
// would only synthesize the SystemInit (not a renderable node) and derive().nodes.length would be 0 —
// the assertions below would fail. (Verified by temporarily emptying CHOMPY_LINES — see report.)

import { describe, it, expect } from "vitest";
import { invoke } from "./core";
import { transcriptFor, type PlanTranscriptResult } from "./fixtures/transcripts";
import { NODES_TITLES } from "./fixtures/nested";
import { parseTranscript, applyTranscriptToModel } from "../conversation/history";
import { ConversationModel } from "../conversation/stream";

describe("Chompy tree history replay (mock read_plan_transcript)", () => {
  const masterStem = NODES_TITLES[0];

  it("master stem returns found:true with non-empty lines", async () => {
    const res = await invoke<PlanTranscriptResult>("read_plan_transcript", { stem: masterStem });
    expect(res.found).toBe(true);
    expect(res.lines.length).toBeGreaterThan(0);
    expect(res.cwd).toBeTruthy();
    expect(res.session_id).toBeTruthy();
  });

  it("master transcript replays to > 0 renderable conversation nodes", async () => {
    const res = await invoke<PlanTranscriptResult>("read_plan_transcript", { stem: masterStem });
    const model = new ConversationModel();
    applyTranscriptToModel(
      model,
      parseTranscript(res.lines, { cwd: res.cwd, sessionId: res.session_id }),
    );
    expect(model.derive().nodes.length).toBeGreaterThan(0);
  });

  it("ALL NINE Chompy node stems resolve to the same non-empty tree transcript", () => {
    expect(NODES_TITLES.length).toBe(9);
    const master = transcriptFor(masterStem);
    for (const stem of NODES_TITLES) {
      const res = transcriptFor(stem);
      expect(res.found).toBe(true);
      expect(res.lines.length).toBeGreaterThan(0);
      // Faithful tree coverage: every node returns the SAME session (master-only would fail here).
      expect(res.session_id).toBe(master.session_id);
      expect(res.lines.length).toBe(master.lines.length);
    }
  });

  it("the replayed model contains assistant text, tool, and user nodes (richly explorable)", async () => {
    const res = await invoke<PlanTranscriptResult>("read_plan_transcript", { stem: masterStem });
    const events = parseTranscript(res.lines, { cwd: res.cwd, sessionId: res.session_id });
    const kinds = new Set(events.map((e) => (e.kind === "stream" ? e.stream.kind : e.kind)));
    expect(kinds.has("assistant_text")).toBe(true);
    expect(kinds.has("tool_use")).toBe(true);
    expect(kinds.has("tool_result")).toBe(true);
    expect(kinds.has("user")).toBe(true);
  });

  it("non-Chompy stems still return found:false (default empty state preserved)", () => {
    const res = transcriptFor("some-unrelated-plan-stem");
    expect(res.found).toBe(false);
    expect(res.lines.length).toBe(0);
  });
});
