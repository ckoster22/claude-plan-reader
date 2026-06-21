// GOLDEN DEPTH-1 EQUIVALENCE ORACLE — recorded against the CURRENT (flat) orchestrator BEFORE the
// recursive-representation refactor. Phase 1 of that refactor must keep depth-1 observable behavior
// EXACTLY identical; these two scenario traces are the oracle it is checked against.
//
// SCOPING (deliberate — the oracle must SURVIVE the refactor):
//   - It pins BEHAVIOR (the wire surface), not types: the ordered sequence of injected-dep calls
//     (sendMessage with BYTE-EXACT prompt text, writePlanTreeFile name+contents, writeAgentPlan
//     treeId+nn, setMode, resolvePermission id+allow, interrupt, startSession, resetPlanTreeDir)
//     plus the ordered observer event KINDS.
//   - It does NOT assert on internal state shapes, snapshot objects, pointer values, or observer
//     ARGUMENTS. onSnapshot is excluded entirely (too chatty); only the
//     onAwaitingApproval/onSummaryWritten/onDone/onFatal kinds are pinned. Observer argument shapes
//     are intended Phase-1 deltas, asserted in their own suites — this oracle pins the ordered
//     event kinds only.
//   - Determinism: a FIXED injected now() clock (deps.now) stamps every ledger persist; Date.now and
//     Math.random are mocked so newTreeId() mints the same stable tree_id every run; the watchdog
//     timer seam is a fake that never fires. The traces are therefore byte-stable across runs.
//
// CUTOVER AMENDMENT (Phase-1 representation swap): the `state.json` writePlanTreeFile CONTENTS in
// these snapshots are the SCHEMA-2 recursive ledger now. This is the ONE intended Phase-1 delta the
// recorded oracle over-pinned (the plan's Phase-1 verification explicitly requires "state.json is
// schema 2", and schema-1 bytes cannot coexist with that deliverable). The cutover diff was audited
// line-by-line: EXACTLY the state.json contents strings changed (schema 1 → schema 2, 26 lines per
// run); every sendMessage text, every other writePlanTreeFile name+contents (INTENT.md / recon.md /
// master.md / NN-summary.md), every writeAgentPlan arg, setMode, resolvePermission, interrupt, and
// the ordered observer event kinds are BYTE-IDENTICAL to the pre-refactor recording. The persist
// CADENCE (one state.json write per persist effect, same positions in the trace) is also unchanged.
//
// CUTOVER AMENDMENT 2 (Phase-2 dotted-id wire change): `write_agent_plan`'s `nn` argument became
// the canonical zero-padded dotted STRING (Rust `Option<String>`; a bare JSON number is now
// serde-REJECTED), so the recorded `writeAgentPlan` trace entries carry "01"/"02" instead of 1/2.
// This is a mandated WIRE-SHAPE delta (same precedent as the schema-2 amendment above): EXACTLY
// the three `"nn"` lines inside writeAgentPlan entries changed (Scenario A: 1 → "01"; Scenario B:
// 1 → "01" and 2 → "02"; the master's `nn: null` is unchanged). The recording fake de-pads the nn
// in its RETURNED path so every state.json contents string (which embeds planPath) stays
// byte-identical; every other entry — sendMessage texts, writePlanTreeFile names+contents,
// treeIds, setMode, resolvePermission, interrupt, observer kinds, ordering — is untouched.
//
// CUTOVER AMENDMENT 3 (Phase-4 per-node sizer): Phase 4 mandates that EVERY non-root node runs the
// per-node sizer turn after its recon (recon → sizer → leaf|split) — EXCEPT the root single-collapse
// child, which inherited the root sizer's `single` verdict and skips it (the root-only special case
// the plan ties to "preserves current golden behavior"). Consequences for the recorded oracle:
//   - Scenario A (confident single → collapse child): BYTE-IDENTICAL, zero changes — the collapse
//     child still goes recon → draft directly. This pins the collapse-skip rule.
//   - Scenario B (2-way split): each root-split child now runs a sizer turn between its recon and
//     its draft. The trace gains, per child, EXACTLY two inserted entries — one state.json persist
//     (the child's open/sizing window) and one sendMessage (the sizer prompt, byte-identical to the
//     root's) — plus the harness feeds each child a `SIZER: single / 1 / 0.95` line. The diff was
//     audited entry-by-entry: every other entry (prompt texts, write names+contents, writeAgentPlan
//     args, setMode, resolvePermission, interrupt, observer kinds, ordering) is BYTE-IDENTICAL to
//     the pre-Phase-4 recording. A separate sizer TURN at depth 1 cannot coexist with the literal
//     pre-Phase-4 trace (it inserts a send by definition), so this is the mandated minimal delta,
//     same precedent as amendments 1-2.
//
// CUTOVER AMENDMENT 4 (Phase-5 parent review turn): Phase 5 mandates that after each NON-FINAL
// child's summary the PARENT runs an active review turn (parent `reviewing`; a no-tools prompt
// carrying the child's summary + the remaining siblings' frozen mandates; the turn ends
// `ADJUST: <note>` | `NONE`) BEFORE the next sibling's recon is sent. Consequences for the oracle:
//   - Scenario A (confident single → ONE child): BYTE-IDENTICAL, zero changes — the single child
//     is the last child, and review is skipped after the last child. This pins the skip rule.
//   - Scenario B (2-way split): exactly ONE review turn inserts between sub-01 and sub-02. The
//     harness answers NONE, so sub-02's recon/draft prompts stay BYTE-IDENTICAL (the empty-note
//     pin). Audited entry-by-entry against the pre-Phase-5 recording, the diff is:
//       • INSERTED: one state.json persist whose contents show the REVIEW WINDOW (root
//         split/reviewing, sub-02 still open/pending) — lands right after the 01-summary.md write;
//       • INSERTED: one sendMessage (the parentReviewPrompt — sub-01's summary verbatim + sub-02's
//         frozen mandate + the ADJUST/NONE protocol);
//       • INSERTED: one state.json persist for PARENT_REVIEW_DONE (root back to running-children,
//         sub-02 open/recon) — its contents are BYTE-IDENTICAL to the pre-Phase-5 post-summary
//         persist, which equivalently means that old persist MOVED from before the setMode("plan")
//         to after the review turn (3 insertions + 1 deletion of an identical string).
//     Every other entry — every sendMessage text (sub-02's recon/draft prompts included), every
//     other writePlanTreeFile name+contents, writeAgentPlan args, setMode positions/values,
//     resolvePermission, interrupt, and the ordered observer kinds — is BYTE-IDENTICAL.
//
// CUTOVER AMENDMENT 5 (root-single nn=null fix): the root single-collapse child is the ONLY plan
// its tree will ever hold — no master file is ever written (root.planPath stays null) — so writing
// it with nn="01" minted an ORPHAN flavor:sub the Rust arranger demoted to a standalone with its
// tree_id NULLED (live bug: the sidebar's tree_id-matched "drafting…" placeholder never ceded to
// the real row). The leaf write site now keys nn = null for isRootCollapseChild paths, so Rust
// stamps the root-level flavor and keeps the tree_id. Consequences for the oracle:
//   - Scenario A: EXACTLY one writeAgentPlan entry changed (nn "01" → null) plus the four
//     state.json contents lines that embed the recording fake's returned path
//     ("/abs/plans/1.md" → "/abs/plans/master.md" for the child's planPath/plansDirPath). Every
//     other entry — sendMessage texts, other write names+contents, setMode, resolvePermission,
//     interrupt, observer kinds, ordering — is BYTE-IDENTICAL (audited line-by-line).
//   - Scenario B (2-way split): BYTE-IDENTICAL, zero changes — split subs keep their dotted nn.
//     This pins that the root-single exception does NOT leak into real split trees.
//
// Scenario A: confident single (SIZER: single / 1 / 0.95) → one sub, gate, approve, exec, summary, done.
// Scenario B: 2-way split (SIZER: split / 2 / 0.9) → master draft, master gate, approveMaster,
//   interrupted resume result, then sub-01, the parent review turn (NONE), then sub-02 through
//   per-node sizer + gate/approve/exec/summary, done.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createOrchestrator, type OrchestratorDeps, type OrchestratorHandle } from "./orchestrator";
import type { AssistantText, ResultMsg, ToolPermissionRequested } from "./types";

// ---- the ordered trace ------------------------------------------------------------------------

type TraceEntry =
  | { kind: "startSession"; cwd: string; permissionMode: string }
  | { kind: "sendMessage"; text: string }
  | { kind: "setMode"; mode: string }
  | { kind: "resolvePermission"; id: string; allow: boolean }
  | { kind: "interrupt" }
  | { kind: "cancelRun" }
  | { kind: "endSession" }
  | { kind: "resetPlanTreeDir"; cwd: string }
  | { kind: "writePlanTreeFile"; name: string; contents: string }
  | { kind: "writeAgentPlan"; treeId: string; nn: string | null }
  | { kind: "observer"; event: "onAwaitingApproval" | "onSummaryWritten" | "onDone" | "onFatal" };

// ---- determinism seams -------------------------------------------------------------------------

// The fixed injected clock (deps.now): every persisted ledger carries this stamp.
const FIXED_MS = 1_750_000_000_000;

beforeEach(() => {
  // newTreeId() (production, not injectable) reads the GLOBAL Date.now + Math.random — pin both so
  // the minted tree_id is the same stable value every run (it appears in writeAgentPlan entries and
  // inside persisted state.json contents).
  vi.spyOn(Date, "now").mockReturnValue(FIXED_MS);
  vi.spyOn(Math, "random").mockReturnValue(0.123456789);
  seq = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- recording fakes (pattern reused from orchestrator.test.ts, recording into ONE trace) ------

function makeGolden(): { h: OrchestratorHandle; trace: TraceEntry[] } {
  const trace: TraceEntry[] = [];
  const deps: OrchestratorDeps = {
    startSession: async (args) =>
      void trace.push({ kind: "startSession", cwd: args.cwd, permissionMode: args.permissionMode }),
    sendMessage: async (text) => void trace.push({ kind: "sendMessage", text }),
    setMode: async (mode) => void trace.push({ kind: "setMode", mode }),
    resolvePermission: async (args) =>
      void trace.push({ kind: "resolvePermission", id: args.id, allow: args.allow }),
    cancelRun: async () => void trace.push({ kind: "cancelRun" }),
    interrupt: async () => void trace.push({ kind: "interrupt" }),
    endSession: async () => void trace.push({ kind: "endSession" }),
    writePlanTreeFile: async (_cwd, name, contents) => {
      trace.push({ kind: "writePlanTreeFile", name, contents });
      return `/abs/.plan-tree/${name}`;
    },
    writeAgentPlan: async (_plan, treeId, nn) => {
      trace.push({ kind: "writeAgentPlan", treeId, nn });
      // RETURN-PATH STABILITY (Phase-2 cutover): the wire nn became the dotted STRING ("01"), but
      // this fake's returned path is de-padded back to the old numeric form so the planPath that
      // leaks into the recorded state.json contents stays BYTE-IDENTICAL ("/abs/plans/1.md") —
      // only the writeAgentPlan trace entries themselves change shape (see the header amendment).
      return `/abs/plans/${nn === null ? "master" : Number.parseInt(nn, 10)}.md`;
    },
    resetPlanTreeDir: async (cwd) => void trace.push({ kind: "resetPlanTreeDir", cwd }),
    // Fake timer seam: the resume watchdog is armed but never fires (the scenarios always deliver
    // the boundary result), so no real timer leaks out of a test.
    setTimeout: () => ({}),
    clearTimeout: () => undefined,
    now: () => FIXED_MS,
  };
  const h = createOrchestrator(deps);
  h.subscribe({
    // onSnapshot deliberately NOT recorded (chatty; argument shapes are Phase-1 deltas).
    onAwaitingApproval: () => void trace.push({ kind: "observer", event: "onAwaitingApproval" }),
    onSummaryWritten: () => void trace.push({ kind: "observer", event: "onSummaryWritten" }),
    onDone: () => void trace.push({ kind: "observer", event: "onDone" }),
    onFatal: () => void trace.push({ kind: "observer", event: "onFatal" }),
  });
  return { h, trace };
}

// ---- scripted live-frame builders (same shapes orchestrator.test.ts uses) ----------------------

let seq = 0;

function textFrame(text: string, parentToolUseId: string | null = null): AssistantText {
  return { seq: ++seq, kind: "assistant_text", text, parent_tool_use_id: parentToolUseId };
}

function resultFrame(): ResultMsg {
  return {
    seq: ++seq,
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

function exitPlanModeReq(id: string, plan: string): ToolPermissionRequested {
  return {
    seq: ++seq,
    kind: "tool_permission_requested",
    id,
    tool: "ExitPlanMode",
    input: { plan },
    agent_id: null,
  };
}

// Drive one sub-plan from its armed recon turn through gate → approve → exec → summary. After the
// summary result the orchestrator either auto-advances to the next sub's recon or finishes (done).
// (Cutover note: the handle's approve surface takes a pathKey string now — "0<nn>" at depth 1. The
// TRACE this harness records is unchanged; only the driving call signature moved.)
// AMENDMENT 3: `viaSizer` feeds the Phase-4 per-node sizer turn (a SIZER line + result) between the
// sub's recon and its draft. Scenario B's root-split children pass true; Scenario A's collapse
// child keeps false (it skips the sizer — the rule the unchanged Scenario A trace pins).
// AMENDMENT 4: `reviewAfter` answers the Phase-5 parent-review turn that follows a NON-FINAL
// child's summary (NONE — no note, so the next child's prompts stay byte-identical). Scenario B's
// sub-01 passes true; the LAST child of either scenario keeps false (review skipped after the
// last child — the rule the unchanged Scenario A trace pins for the single-child case).
async function driveSub(
  h: OrchestratorHandle,
  nn: number,
  toolUseId: string,
  viaSizer = false,
  reviewAfter = false,
): Promise<void> {
  await h.ingestStream(textFrame(`sub ${nn} recon report`));
  await h.ingestStream(resultFrame());
  if (viaSizer) {
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.95"));
    await h.ingestStream(resultFrame());
  }
  await h.ingestPermission(exitPlanModeReq(toolUseId, `# Sub-Plan 0${nn}\n\nthe sub ${nn} plan body\n`));
  await h.approve(String(nn).padStart(2, "0"));
  await h.ingestStream(textFrame(`exec chatter ${nn}`));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame(`## Changes\nsummary of sub ${nn}\n## Findings\n## Next-step inputs`));
  await h.ingestStream(resultFrame());
  if (reviewAfter) {
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());
  }
}

// Drive a fresh handle through start → intent → recon → the sizer text (caller supplies the SIZER line).
async function driveToSizer(h: OrchestratorHandle, sizerLine: string): Promise<void> {
  await h.start({ cwd: "/golden", request: "build a widget" });
  await h.ingestStream(textFrame("the confirmed intent: a widget with constraint Y", "agent-intent"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("recon report body"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame(sizerLine));
  await h.ingestStream(resultFrame());
}

// ---- the two golden scenarios -------------------------------------------------------------------

describe("golden depth-1 equivalence oracle (pre-refactor wire traces)", () => {
  it("Scenario A — confident single: intent → recon → sizer(single 0.95) → sub-01 recon/draft/gate/approve/exec/summary → done", async () => {
    const { h, trace } = makeGolden();

    await driveToSizer(h, "SIZER: single / 1 / 0.95");
    await driveSub(h, 1, "sub1-tu");

    // Terminal: natural completion ENDS the SDK session (cancelRun → endSession) BEFORE firing the
    // onDone observer — mirroring cancel()/notifyFatal — so index.ts gets an agent-exit and the
    // post-completion New-plan + Send-resume affordances work. The trace pins this exact terminal order.
    expect(trace).toMatchInlineSnapshot(`
      [
        {
          "cwd": "/golden",
          "kind": "resetPlanTreeDir",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"clarifying-intent"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "cwd": "/golden",
          "kind": "startSession",
          "permissionMode": "prototype",
        },
        {
          "kind": "sendMessage",
          "text": "We are running the multiplan planning flow. Before reconnaissance, YOU (this agent) must confirm
      what the user actually wants from this request:

      build a widget

      Step 1 — ASSESS via the subagent. Invoke the **intent-clarifier** subagent to assess the request
      AND produce a rapid, variable-fidelity VISUAL of the intended end product (humans react far
      better to a visual than to prose).
      Spawn it IN VISUAL MODE: include this directive block VERBATIM in its spawn prompt (it
      activates the subagent's visual-prototype mode and names its output directory):

      ---VISUAL-MODE---
      output_dir: .plan-tree/prototype/
      ---END-VISUAL-MODE---

      In its spawn prompt also give it this guard verbatim:

        - You MUST NOT deeply explore the codebase — a separate scope-recon step does that next. At
          most a couple of quick reads, only if strictly necessary — and never outside this working
          directory. Prototype artifacts go under .plan-tree/prototype/ ONLY, written with the Write
          tool (never cat/echo/Bash redirection — the output directory already exists, so no mkdir
          is needed).

      SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).
      Do NOT read, glob, grep, or list sibling projects or parent directories — prior art
      means prior art WITHIN this directory tree only. Pass this constraint verbatim to any
      subagent you spawn.

      In visual mode the subagent returns EXACTLY ONE JSON object (no prose, no markdown): the usual
      shape PLUS an optional \`prototype\` object:

        { "intent_clear": <bool>, "questions": [
          { "question": "<text>", "header": "<=12 chars>", "multiSelect": <bool>,
            "options": [ {"label": "<text>", "description": "<text>"}, ... ] }, ... ],
          "prototype": { "kind": "html | mermaid | ascii | table", "paths": ["<artifact path>", ...],
            "screenshot": "<path or null>", "inline_preview": "<text or null>",
            "variants": [ {"label": "<short>", "path": "<path or null>", "inline_preview": "<text or null>"} ] } }

      The MEDIUM is the subagent's discretion: UI / layout / visual / game work → a WORKING
      single-file HTML prototype with realistic mock data (the DEFAULT); backend / data / API /
      refactor work → a mermaid diagram, an ASCII mockup, or a sample input/output table — whatever
      communicates intent fastest. The guarantee is "always SOME visual", never "always HTML". It
      may produce 2-4 labeled variants when the right direction is genuinely ambiguous. Screenshots
      (chrome-devtools) are BEST-EFFORT: if unavailable or erroring it must skip them
      (screenshot: null) without failing.

      When \`intent_clear\` is true, \`questions\` is empty. When it is false, \`questions\` holds 1–4
      decision-forcing questions (each with 2–4 options). This MUST be a FAST, lightweight clarification
      that converges in ONE short turn.

      Step 2 — PARSE and DECIDE. Read (JSON.parse) the object the subagent returned:

        - If \`intent_clear\` is false, YOU (the main agent — NOT the subagent) ask its \`questions\` to the
          user using the **AskUserQuestion** tool ONCE, mapping each question/header/multiSelect and its
          options (label + description) directly into AskUserQuestion's question format. AskUserQuestion
          is the MAIN agent's job; the subagent must never call it. Incorporate the user's answers.
        - If \`intent_clear\` is true, proceed without asking the user anything.

      Step 3 — FINALIZE. Your final message MUST be the CONCISE confirmed INTENT as CLEAN PROSE — a
      short paragraph stating the goal, key constraints, and success criteria (never the raw JSON,
      no markdown) — and then, AS THE VERY LAST CONTENT of that final message, EXACTLY ONE of:

        - when the subagent returned a \`prototype\` object, this block with the subagent's
          \`prototype\` JSON object copied VERBATIM as its body:

      ---PROTOTYPE---
      {the subagent's \`prototype\` JSON object, verbatim}
      ---END-PROTOTYPE---

        - or, when it returned no \`prototype\`, the single literal line:

      NO-PROTOTYPE

      Nothing may follow the block (or the line). Do not call any other tool after stating the intent.",
        },
        {
          "contents": "the confirmed intent: a widget with constraint Y",
          "kind": "writePlanTreeFile",
          "name": "INTENT.md",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"recon"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "setMode",
          "mode": "plan",
        },
        {
          "kind": "sendMessage",
          "text": "Confirmed intent (from clarification):

      the confirmed intent: a widget with constraint Y

      We are running the multiplan planning flow for this request:

      build a widget

      SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).
      Do NOT read, glob, grep, or list sibling projects or parent directories — prior art
      means prior art WITHIN this directory tree only. Pass this constraint verbatim to any
      subagent you spawn.

      Use the **scope-recon** subagent to perform broad reconnaissance of the codebase and the
      request's scope: relevant files, modules, prior art, constraints, and risks. Return the
      subagent's full report verbatim as your final message — do not call any other tool.",
        },
        {
          "contents": "recon report body",
          "kind": "writePlanTreeFile",
          "name": "recon.md",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"sizing"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Use the **plan-sizer** subagent to decide how to decompose the request, given the recon report.
      Pass the recon report along with this decomposition-bias block:

      ---DECOMPOSITION-BIAS---
      Greenfield projects (recon verdict: \`non-repo\`) with multiple subsystem concerns (rendering,
      physics, controls, UI, persistence, networking, audio, asset loading, etc.) should default to
      \`split\`.

      **Quantitative rule:** if the recon verdict is \`non-repo\` AND the request implicates 2 or more
      of those subsystems, the decision MUST be \`split\` unless the user's request contains an explicit
      scope-narrowing clause like "just X", "only Y", or "minimal Z".

      A \`single\` decision is only appropriate when:
      - The work is genuinely single-volatility (one concern, one module), OR
      - The user's request contains an explicit scope-narrowing clause (above), OR
      - An existing codebase already establishes the cross-cutting layers and the new work is one
        concern within them.

      **Bounded-working-prototype override (DEFAULT SMALL):** when a bounded, working prototype or
      reference implementation already exists for the request, that is empirical proof the whole thing
      fits in one context. In that case bias the decision to \`single\` (a single-plan port). The
      greenfield 'request implicates 2+ subsystems => MUST split' rule above does NOT apply when such
      a bounded working prototype exists — do not shatter a working artifact into a layer tree. Only
      split if the prototype itself is genuinely too large to port in one pass. This override keys on
      an actual BOUNDED WORKING prototype existing — not on mere mention of a prototype, and not for
      genuinely large systems.

      When in doubt: lean split. A master plan with one or two sub-plans is easy to collapse if the
      user wants; an oversized single plan is painful to retroactively decompose.
      ---END-DECOMPOSITION-BIAS---

      After it returns, emit exactly one line at the top level of the form:

      SIZER: <single|split> / <num_plans> / <confidence>

      e.g. \`SIZER: split / 3 / 0.82\`. Those are the ONLY two decisions — when uncertain, choose
      \`split\` (the master plan gate is the human checkpoint for an uncertain decomposition).

      Emit nothing else after the SIZER line.",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"Plan","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"recon"}}],"planPath":null,"summaryPath":null,"plansDirPath":null}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "We are now working sub-plan 01. Its mandate from the master plan:

      ### Sub-Plan 01: Plan

      Use the **scope-recon** subagent to perform reconnaissance scoped to THIS sub-plan only.

      SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).
      Do NOT read, glob, grep, or list sibling projects or parent directories — prior art
      means prior art WITHIN this directory tree only. Pass this constraint verbatim to any
      subagent you spawn.

      Return its report verbatim as your final message — do not call any other tool.",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"Plan","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"drafting","planPath":null,"summaryPath":null,"plansDirPath":null}}],"planPath":null,"summaryPath":null,"plansDirPath":null}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Draft the implementation plan for sub-plan 01. Its mandate from the master plan:

      ### Sub-Plan 01: Plan

      Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.
      Then call **ExitPlanMode** with the full sub-plan as \`plan\` to hold for approval.",
        },
        {
          "kind": "writeAgentPlan",
          "nn": null,
          "treeId": "tree-mbxstdz4-1f9add37",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"Plan","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"awaiting-approval","planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}],"planPath":null,"summaryPath":null,"plansDirPath":null}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "event": "onAwaitingApproval",
          "kind": "observer",
        },
        {
          "allow": true,
          "id": "sub1-tu",
          "kind": "resolvePermission",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"Plan","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"executing","planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}],"planPath":null,"summaryPath":null,"plansDirPath":null}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "setMode",
          "mode": "acceptEdits",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"Plan","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"executing","planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}],"planPath":null,"summaryPath":null,"plansDirPath":null}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Sub-plan 01 has finished executing. Output a concise summary with these sections:

      ## Changes
      ## Findings
      ## Next-step inputs

      Output ONLY the summary markdown as your final message — do not call any tool.",
        },
        {
          "contents": "## Changes
      summary of sub 1
      ## Findings
      ## Next-step inputs",
          "kind": "writePlanTreeFile",
          "name": "01-summary.md",
        },
        {
          "event": "onSummaryWritten",
          "kind": "observer",
        },
        {
          "kind": "cancelRun",
        },
        {
          "kind": "endSession",
        },
        {
          "event": "onDone",
          "kind": "observer",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"summarized","children":[{"nn":1,"title":"Plan","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/master.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/master.md"}}],"planPath":null,"summaryPath":null,"plansDirPath":null}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
      ]
    `);
  });

  it("Scenario B — 2-way split: … sizer(split 0.9) → master draft/gate/approveMaster → interrupted resume → sub-01 → (auto-advance) sub-02 → done", async () => {
    const { h, trace } = makeGolden();

    await driveToSizer(h, "SIZER: split / 2 / 0.9");

    // The master ExitPlanMode hold (the master gate), carrying the decomposition.
    const masterPlan =
      "# Master Plan\n\nshared preamble context\n\n" +
      "### Sub-Plan 01: First\nscope of sub one\n\n" +
      "### Sub-Plan 02: Second\nscope of sub two\n";
    await h.ingestPermission(exitPlanModeReq("master-tu", masterPlan));

    // The ROOT decomposition gate is approved through the UNIFIED surface: pathKey "" is the root.
    // (Cutover note: approveMaster() was superseded by approve("") — the recorded TRACE is unchanged.)
    await h.approve("");
    // The interrupted resume turn's terminal result — the boundary that fires the deferred sub-recon.
    await h.ingestStream(resultFrame());

    // AMENDMENT 4: sub-01 is non-final, so the ROOT's review turn follows its summary (the harness
    // answers NONE — sub-02's prompts stay byte-identical); sub-02 is the LAST child (no review).
    await driveSub(h, 1, "sub1-tu", true, true);
    await driveSub(h, 2, "sub2-tu", true);

    expect(trace).toMatchInlineSnapshot(`
      [
        {
          "cwd": "/golden",
          "kind": "resetPlanTreeDir",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"clarifying-intent"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "cwd": "/golden",
          "kind": "startSession",
          "permissionMode": "prototype",
        },
        {
          "kind": "sendMessage",
          "text": "We are running the multiplan planning flow. Before reconnaissance, YOU (this agent) must confirm
      what the user actually wants from this request:

      build a widget

      Step 1 — ASSESS via the subagent. Invoke the **intent-clarifier** subagent to assess the request
      AND produce a rapid, variable-fidelity VISUAL of the intended end product (humans react far
      better to a visual than to prose).
      Spawn it IN VISUAL MODE: include this directive block VERBATIM in its spawn prompt (it
      activates the subagent's visual-prototype mode and names its output directory):

      ---VISUAL-MODE---
      output_dir: .plan-tree/prototype/
      ---END-VISUAL-MODE---

      In its spawn prompt also give it this guard verbatim:

        - You MUST NOT deeply explore the codebase — a separate scope-recon step does that next. At
          most a couple of quick reads, only if strictly necessary — and never outside this working
          directory. Prototype artifacts go under .plan-tree/prototype/ ONLY, written with the Write
          tool (never cat/echo/Bash redirection — the output directory already exists, so no mkdir
          is needed).

      SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).
      Do NOT read, glob, grep, or list sibling projects or parent directories — prior art
      means prior art WITHIN this directory tree only. Pass this constraint verbatim to any
      subagent you spawn.

      In visual mode the subagent returns EXACTLY ONE JSON object (no prose, no markdown): the usual
      shape PLUS an optional \`prototype\` object:

        { "intent_clear": <bool>, "questions": [
          { "question": "<text>", "header": "<=12 chars>", "multiSelect": <bool>,
            "options": [ {"label": "<text>", "description": "<text>"}, ... ] }, ... ],
          "prototype": { "kind": "html | mermaid | ascii | table", "paths": ["<artifact path>", ...],
            "screenshot": "<path or null>", "inline_preview": "<text or null>",
            "variants": [ {"label": "<short>", "path": "<path or null>", "inline_preview": "<text or null>"} ] } }

      The MEDIUM is the subagent's discretion: UI / layout / visual / game work → a WORKING
      single-file HTML prototype with realistic mock data (the DEFAULT); backend / data / API /
      refactor work → a mermaid diagram, an ASCII mockup, or a sample input/output table — whatever
      communicates intent fastest. The guarantee is "always SOME visual", never "always HTML". It
      may produce 2-4 labeled variants when the right direction is genuinely ambiguous. Screenshots
      (chrome-devtools) are BEST-EFFORT: if unavailable or erroring it must skip them
      (screenshot: null) without failing.

      When \`intent_clear\` is true, \`questions\` is empty. When it is false, \`questions\` holds 1–4
      decision-forcing questions (each with 2–4 options). This MUST be a FAST, lightweight clarification
      that converges in ONE short turn.

      Step 2 — PARSE and DECIDE. Read (JSON.parse) the object the subagent returned:

        - If \`intent_clear\` is false, YOU (the main agent — NOT the subagent) ask its \`questions\` to the
          user using the **AskUserQuestion** tool ONCE, mapping each question/header/multiSelect and its
          options (label + description) directly into AskUserQuestion's question format. AskUserQuestion
          is the MAIN agent's job; the subagent must never call it. Incorporate the user's answers.
        - If \`intent_clear\` is true, proceed without asking the user anything.

      Step 3 — FINALIZE. Your final message MUST be the CONCISE confirmed INTENT as CLEAN PROSE — a
      short paragraph stating the goal, key constraints, and success criteria (never the raw JSON,
      no markdown) — and then, AS THE VERY LAST CONTENT of that final message, EXACTLY ONE of:

        - when the subagent returned a \`prototype\` object, this block with the subagent's
          \`prototype\` JSON object copied VERBATIM as its body:

      ---PROTOTYPE---
      {the subagent's \`prototype\` JSON object, verbatim}
      ---END-PROTOTYPE---

        - or, when it returned no \`prototype\`, the single literal line:

      NO-PROTOTYPE

      Nothing may follow the block (or the line). Do not call any other tool after stating the intent.",
        },
        {
          "contents": "the confirmed intent: a widget with constraint Y",
          "kind": "writePlanTreeFile",
          "name": "INTENT.md",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"recon"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "setMode",
          "mode": "plan",
        },
        {
          "kind": "sendMessage",
          "text": "Confirmed intent (from clarification):

      the confirmed intent: a widget with constraint Y

      We are running the multiplan planning flow for this request:

      build a widget

      SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).
      Do NOT read, glob, grep, or list sibling projects or parent directories — prior art
      means prior art WITHIN this directory tree only. Pass this constraint verbatim to any
      subagent you spawn.

      Use the **scope-recon** subagent to perform broad reconnaissance of the codebase and the
      request's scope: relevant files, modules, prior art, constraints, and risks. Return the
      subagent's full report verbatim as your final message — do not call any other tool.",
        },
        {
          "contents": "recon report body",
          "kind": "writePlanTreeFile",
          "name": "recon.md",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"sizing"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Use the **plan-sizer** subagent to decide how to decompose the request, given the recon report.
      Pass the recon report along with this decomposition-bias block:

      ---DECOMPOSITION-BIAS---
      Greenfield projects (recon verdict: \`non-repo\`) with multiple subsystem concerns (rendering,
      physics, controls, UI, persistence, networking, audio, asset loading, etc.) should default to
      \`split\`.

      **Quantitative rule:** if the recon verdict is \`non-repo\` AND the request implicates 2 or more
      of those subsystems, the decision MUST be \`split\` unless the user's request contains an explicit
      scope-narrowing clause like "just X", "only Y", or "minimal Z".

      A \`single\` decision is only appropriate when:
      - The work is genuinely single-volatility (one concern, one module), OR
      - The user's request contains an explicit scope-narrowing clause (above), OR
      - An existing codebase already establishes the cross-cutting layers and the new work is one
        concern within them.

      **Bounded-working-prototype override (DEFAULT SMALL):** when a bounded, working prototype or
      reference implementation already exists for the request, that is empirical proof the whole thing
      fits in one context. In that case bias the decision to \`single\` (a single-plan port). The
      greenfield 'request implicates 2+ subsystems => MUST split' rule above does NOT apply when such
      a bounded working prototype exists — do not shatter a working artifact into a layer tree. Only
      split if the prototype itself is genuinely too large to port in one pass. This override keys on
      an actual BOUNDED WORKING prototype existing — not on mere mention of a prototype, and not for
      genuinely large systems.

      When in doubt: lean split. A master plan with one or two sub-plans is easy to collapse if the
      user wants; an oversized single plan is painful to retroactively decompose.
      ---END-DECOMPOSITION-BIAS---

      After it returns, emit exactly one line at the top level of the form:

      SIZER: <single|split> / <num_plans> / <confidence>

      e.g. \`SIZER: split / 3 / 0.82\`. Those are the ONLY two decisions — when uncertain, choose
      \`split\` (the master plan gate is the human checkpoint for an uncertain decomposition).

      Emit nothing else after the SIZER line.",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"decomposing"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Confirmed intent (from clarification):

      the confirmed intent: a widget with constraint Y

      Draft the MASTER decomposition plan for this request:

      build a widget

      Break the work into sequential sub-plans. For each, write a header of the exact form
      \`### Sub-Plan NN: <title>\` (NN is a zero-padded number, e.g. 01) followed by its scope.

      SLICE-FIRST (capability-first, NOT layer-first): decompose by capability / vertical slice, not
      by subsystem / horizontal layer. Sub-Plan 01 MUST be the thinnest runnable END-TO-END vertical
      slice — a thinnest-playable/usable version that actually runs — and every subsequent sub-plan
      MUST enhance that already-running artifact rather than add an isolated horizontal layer. This is
      the same vertical-slice principle the plan template already mandates.
      Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.
      Then call **ExitPlanMode** with the full master plan as \`plan\` to hold for approval.",
        },
        {
          "kind": "writeAgentPlan",
          "nn": null,
          "treeId": "tree-mbxstdz4-1f9add37",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"decomposing"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "contents": "# Master Plan

      shared preamble context

      ### Sub-Plan 01: First
      scope of sub one

      ### Sub-Plan 02: Second
      scope of sub two
      ",
          "kind": "writePlanTreeFile",
          "name": "master.md",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"awaiting-decomposition-approval"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "event": "onAwaitingApproval",
          "kind": "observer",
        },
        {
          "allow": true,
          "id": "master-tu",
          "kind": "resolvePermission",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"recon"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"pending"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "setMode",
          "mode": "plan",
        },
        {
          "kind": "interrupt",
        },
        {
          "kind": "sendMessage",
          "text": "We are now working sub-plan 01. Its mandate from the master plan:

      ### Sub-Plan 01: First

      scope of sub one

      Master-plan preamble (shared context for every sub-plan):

      # Master Plan

      shared preamble context

      Use the **scope-recon** subagent to perform reconnaissance scoped to THIS sub-plan only.

      SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).
      Do NOT read, glob, grep, or list sibling projects or parent directories — prior art
      means prior art WITHIN this directory tree only. Pass this constraint verbatim to any
      subagent you spawn.

      Return its report verbatim as your final message — do not call any other tool.",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"sizing"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"pending"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Use the **plan-sizer** subagent to decide how to decompose the request, given the recon report.
      Pass the recon report along with this decomposition-bias block:

      ---DECOMPOSITION-BIAS---
      Greenfield projects (recon verdict: \`non-repo\`) with multiple subsystem concerns (rendering,
      physics, controls, UI, persistence, networking, audio, asset loading, etc.) should default to
      \`split\`.

      **Quantitative rule:** if the recon verdict is \`non-repo\` AND the request implicates 2 or more
      of those subsystems, the decision MUST be \`split\` unless the user's request contains an explicit
      scope-narrowing clause like "just X", "only Y", or "minimal Z".

      A \`single\` decision is only appropriate when:
      - The work is genuinely single-volatility (one concern, one module), OR
      - The user's request contains an explicit scope-narrowing clause (above), OR
      - An existing codebase already establishes the cross-cutting layers and the new work is one
        concern within them.

      **Bounded-working-prototype override (DEFAULT SMALL):** when a bounded, working prototype or
      reference implementation already exists for the request, that is empirical proof the whole thing
      fits in one context. In that case bias the decision to \`single\` (a single-plan port). The
      greenfield 'request implicates 2+ subsystems => MUST split' rule above does NOT apply when such
      a bounded working prototype exists — do not shatter a working artifact into a layer tree. Only
      split if the prototype itself is genuinely too large to port in one pass. This override keys on
      an actual BOUNDED WORKING prototype existing — not on mere mention of a prototype, and not for
      genuinely large systems.

      When in doubt: lean split. A master plan with one or two sub-plans is easy to collapse if the
      user wants; an oversized single plan is painful to retroactively decompose.
      ---END-DECOMPOSITION-BIAS---

      After it returns, emit exactly one line at the top level of the form:

      SIZER: <single|split> / <num_plans> / <confidence>

      e.g. \`SIZER: split / 3 / 0.82\`. Those are the ONLY two decisions — when uncertain, choose
      \`split\` (the master plan gate is the human checkpoint for an uncertain decomposition).

      Emit nothing else after the SIZER line.",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"drafting","planPath":null,"summaryPath":null,"plansDirPath":null}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"pending"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Draft the implementation plan for sub-plan 01. Its mandate from the master plan:

      ### Sub-Plan 01: First

      scope of sub one

      Master-plan preamble (shared context for every sub-plan):

      # Master Plan

      shared preamble context

      Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.
      Then call **ExitPlanMode** with the full sub-plan as \`plan\` to hold for approval.",
        },
        {
          "kind": "writeAgentPlan",
          "nn": "01",
          "treeId": "tree-mbxstdz4-1f9add37",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"awaiting-approval","planPath":"/abs/plans/1.md","summaryPath":null,"plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"pending"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "event": "onAwaitingApproval",
          "kind": "observer",
        },
        {
          "allow": true,
          "id": "sub1-tu",
          "kind": "resolvePermission",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"executing","planPath":"/abs/plans/1.md","summaryPath":null,"plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"pending"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "setMode",
          "mode": "acceptEdits",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"executing","planPath":"/abs/plans/1.md","summaryPath":null,"plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"pending"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Sub-plan 01 has finished executing. Output a concise summary with these sections:

      ## Changes
      ## Findings
      ## Next-step inputs

      Output ONLY the summary markdown as your final message — do not call any tool.",
        },
        {
          "contents": "## Changes
      summary of sub 1
      ## Findings
      ## Next-step inputs",
          "kind": "writePlanTreeFile",
          "name": "01-summary.md",
        },
        {
          "event": "onSummaryWritten",
          "kind": "observer",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"reviewing","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"pending"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "setMode",
          "mode": "plan",
        },
        {
          "kind": "sendMessage",
          "text": "Sub-plan 01 has completed; its summary is below. You are the PARENT plan
      reviewing that summary BEFORE the next sibling sub-plan begins. The remaining sibling mandates
      are FROZEN — you cannot re-decompose, reorder, or rescope them; you may only pass ONE short
      adjustment note into the next sub-plan's prompts.

      Summary of sub-plan 01 (verbatim):

      ## Changes
      summary of sub 1
      ## Findings
      ## Next-step inputs

      Remaining sibling sub-plans (mandates frozen):

      ### Sub-Plan 02: Second

      scope of sub two

      Do NOT call any tool in this turn. Review the summary against the remaining mandates, then END
      your final message with EXACTLY ONE line of this strict form (nothing after it):

      ADJUST: <one short adjustment note for the next sub-plan>

      or, when no adjustment is needed:

      NONE",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"recon"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "We are now working sub-plan 02. Its mandate from the master plan:

      ### Sub-Plan 02: Second

      scope of sub two

      Master-plan preamble (shared context for every sub-plan):

      # Master Plan

      shared preamble context

      Use the **scope-recon** subagent to perform reconnaissance scoped to THIS sub-plan only.

      SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).
      Do NOT read, glob, grep, or list sibling projects or parent directories — prior art
      means prior art WITHIN this directory tree only. Pass this constraint verbatim to any
      subagent you spawn.

      Return its report verbatim as your final message — do not call any other tool.

      Summaries of the sub-plans completed so far (use them as context):

      ## Changes
      summary of sub 1
      ## Findings
      ## Next-step inputs
      ",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"open","phase":"sizing"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Use the **plan-sizer** subagent to decide how to decompose the request, given the recon report.
      Pass the recon report along with this decomposition-bias block:

      ---DECOMPOSITION-BIAS---
      Greenfield projects (recon verdict: \`non-repo\`) with multiple subsystem concerns (rendering,
      physics, controls, UI, persistence, networking, audio, asset loading, etc.) should default to
      \`split\`.

      **Quantitative rule:** if the recon verdict is \`non-repo\` AND the request implicates 2 or more
      of those subsystems, the decision MUST be \`split\` unless the user's request contains an explicit
      scope-narrowing clause like "just X", "only Y", or "minimal Z".

      A \`single\` decision is only appropriate when:
      - The work is genuinely single-volatility (one concern, one module), OR
      - The user's request contains an explicit scope-narrowing clause (above), OR
      - An existing codebase already establishes the cross-cutting layers and the new work is one
        concern within them.

      **Bounded-working-prototype override (DEFAULT SMALL):** when a bounded, working prototype or
      reference implementation already exists for the request, that is empirical proof the whole thing
      fits in one context. In that case bias the decision to \`single\` (a single-plan port). The
      greenfield 'request implicates 2+ subsystems => MUST split' rule above does NOT apply when such
      a bounded working prototype exists — do not shatter a working artifact into a layer tree. Only
      split if the prototype itself is genuinely too large to port in one pass. This override keys on
      an actual BOUNDED WORKING prototype existing — not on mere mention of a prototype, and not for
      genuinely large systems.

      When in doubt: lean split. A master plan with one or two sub-plans is easy to collapse if the
      user wants; an oversized single plan is painful to retroactively decompose.
      ---END-DECOMPOSITION-BIAS---

      After it returns, emit exactly one line at the top level of the form:

      SIZER: <single|split> / <num_plans> / <confidence>

      e.g. \`SIZER: split / 3 / 0.82\`. Those are the ONLY two decisions — when uncertain, choose
      \`split\` (the master plan gate is the human checkpoint for an uncertain decomposition).

      Emit nothing else after the SIZER line.",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"drafting","planPath":null,"summaryPath":null,"plansDirPath":null}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Draft the implementation plan for sub-plan 02. Its mandate from the master plan:

      ### Sub-Plan 02: Second

      scope of sub two

      Master-plan preamble (shared context for every sub-plan):

      # Master Plan

      shared preamble context

      Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.
      Then call **ExitPlanMode** with the full sub-plan as \`plan\` to hold for approval.

      Summaries of the sub-plans completed so far (use them as context):

      ## Changes
      summary of sub 1
      ## Findings
      ## Next-step inputs
      ",
        },
        {
          "kind": "writeAgentPlan",
          "nn": "02",
          "treeId": "tree-mbxstdz4-1f9add37",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"awaiting-approval","planPath":"/abs/plans/2.md","summaryPath":null,"plansDirPath":"/abs/plans/2.md"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "event": "onAwaitingApproval",
          "kind": "observer",
        },
        {
          "allow": true,
          "id": "sub2-tu",
          "kind": "resolvePermission",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"executing","planPath":"/abs/plans/2.md","summaryPath":null,"plansDirPath":"/abs/plans/2.md"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "setMode",
          "mode": "acceptEdits",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"running-children","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"executing","planPath":"/abs/plans/2.md","summaryPath":null,"plansDirPath":"/abs/plans/2.md"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
        {
          "kind": "sendMessage",
          "text": "Sub-plan 02 has finished executing. Output a concise summary with these sections:

      ## Changes
      ## Findings
      ## Next-step inputs

      Output ONLY the summary markdown as your final message — do not call any tool.",
        },
        {
          "contents": "## Changes
      summary of sub 2
      ## Findings
      ## Next-step inputs",
          "kind": "writePlanTreeFile",
          "name": "02-summary.md",
        },
        {
          "event": "onSummaryWritten",
          "kind": "observer",
        },
        {
          "kind": "cancelRun",
        },
        {
          "kind": "endSession",
        },
        {
          "event": "onDone",
          "kind": "observer",
        },
        {
          "contents": "{"schema":2,"tree_id":"tree-mbxstdz4-1f9add37","created_ms":1750000000000,"updated_ms":1750000000000,"root":{"nn":1,"title":"build a widget","redraftCount":0,"lastFeedback":null,"state":{"stage":"split","phase":"summarized","children":[{"nn":1,"title":"First","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/1.md","summaryPath":"/abs/.plan-tree/01-summary.md","plansDirPath":"/abs/plans/1.md"}},{"nn":2,"title":"Second","redraftCount":0,"lastFeedback":null,"state":{"stage":"leaf","phase":"summarized","planPath":"/abs/plans/2.md","summaryPath":"/abs/.plan-tree/02-summary.md","plansDirPath":"/abs/plans/2.md"}}],"planPath":"/abs/plans/master.md","summaryPath":null,"plansDirPath":"/abs/plans/master.md"}}}",
          "kind": "writePlanTreeFile",
          "name": "state.json",
        },
      ]
    `);
  });
});
