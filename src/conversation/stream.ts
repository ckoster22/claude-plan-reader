// Conversation domain (Sub-Plan 02) — PURE in-memory stream model.
//
// Consumes the committed agent-stream vocabulary (types.ts) and produces a normalized,
// renderable tree. NO DOM. Responsibilities:
//   - order strictly by `seq`;
//   - correlate tool_use.id -> tool_result.tool_use_id (status running -> done/error);
//   - group subagent sub-streams keyed by the frozen `parent_tool_use_id` (= the parent
//     tool_use's id, which the SDK reuses as the subagent's agent_id) — NO name label
//     (none is frozen; the visible name is deferred to live smoke);
//   - track `permission_mode` for the mode chip;
//   - record a tool-permission-requested marker, permission_denied rows, errors, exit;
//   - mark the run complete on `result`.
//
// The model is rebuilt from scratch on every event apply (events are accumulated and the
// derived tree recomputed) so ordering-by-seq and late-arriving correlations are always
// consistent regardless of wire arrival order.

import type {
  AgentStream,
  ToolPermissionRequested,
  AgentError,
  AgentExit,
  AskUserQuestionItem,
  AskUserQuestionAnswers,
} from "./types";

export type ToolStatus = "running" | "done" | "error";

// A rendered tool-call row (a tool_use, possibly correlated with its tool_result).
export interface ToolNode {
  type: "tool";
  seq: number;
  id: string;
  tool: string;
  input: unknown;
  status: ToolStatus;
  // The correlated tool_result content + error flag, once it lands (else null/running).
  result: unknown | null;
  isError: boolean;
}

// An assistant-text bubble.
export interface TextNode {
  type: "text";
  seq: number;
  text: string;
}

// A user-attributed bubble: the verbatim text the user typed/submitted (free-text message, prototype
// refine feedback, or plan-review comments). Echoed into the stream AFTER a successful dispatch so the
// user's own words are visible in the conversation (they were previously wrapped into a system prompt
// and never shown). Placed at `lastWireSeq + 0.5` (a fractional tiebreaker — see appendUserMessage) so
// it sorts after every frame seen so far but strictly BEFORE the agent's reply (the next wire frame).
export interface UserMessageNode {
  type: "user";
  seq: number;
  text: string;
  // Multimodal: DISPLAY data URLs (`data:<media_type>;base64,<data>`) for images the user attached to
  // this message, in attach order. Rendered as a thumbnail row ABOVE the text in the user bubble.
  // OPTIONAL + OMITTED when the message carried no images (a text-only send is byte-identical to today).
  images?: string[];
}

// A de-emphasized SYSTEM bubble: a harness-injected role:"user" transcript record that the human
// did NOT type — a plumbing turn (subagent task-notification, command stdout/stderr, bash I/O,
// system reminder). Held verbatim (raw XML/plaintext) and rendered DIM + left-aligned, visually
// distinct from both the orange user bubble and the grey assistant bubble. NEVER markdown-rendered.
export interface SystemMessageNode {
  type: "system";
  seq: number;
  text: string;
}

// A Plan->Build (or any) mode-change chip.
export interface ModeNode {
  type: "mode";
  seq: number;
  mode: string;
}

// The "awaiting review (wired in Sub-Plan 03)" marker for a tool-permission-requested event.
export interface PermissionRequestNode {
  type: "permission_request";
  seq: number;
  id: string;
  tool: string;
  agentId: string | null;
}

// An interactive AskUserQuestion request derived from a tool-permission-requested event whose tool
// is "AskUserQuestion". While unanswered it carries the questions so the renderer can draw the input
// card (radios/checkboxes + Submit) and the controller can resolve it. Once answered (the controller
// appends a question_answered event), `answers` is set: the renderer drops the form and shows the
// chosen answers as a record. The hold lives in the sidecar; this node is the host-side affordance.
export interface QuestionRequestNode {
  type: "question_request";
  seq: number;
  // The SDK toolUseID — what the controller round-trips via resolve_tool_permission.
  id: string;
  questions: AskUserQuestionItem[];
  // null while pending (render the form); set once the user submitted (render the chosen answers).
  answers: AskUserQuestionAnswers | null;
}

// A visible permission_denied row (a tool decided OUTSIDE the canUseTool seam).
export interface PermissionDeniedNode {
  type: "permission_denied";
  seq: number;
  tool: string;
  toolUseId: string;
  reasonType: string;
  message: string;
}

// The terminal result row.
export interface ResultNode {
  type: "result";
  seq: number;
  isError: boolean;
  result: string;
  // The SDK result subtype (e.g. "success" | "error_during_execution") — RECORD ONLY, never keyed
  // on for rendering (error_during_execution also covers genuine mid-run failures).
  subtype: string;
  // True when the controller tagged the stored frame as a deliberate orchestrator interrupt (the
  // post-decomposition-approval boundary). Read from the STORED frame field — never from live
  // orchestrator state, which de-arms `resuming` before later rebuilds. The render branch keys
  // EXCLUSIVELY on this flag.
  deliberateInterrupt: boolean;
}

// An error row (fatal or diagnostic).
export interface ErrorNode {
  type: "error";
  seq: number;
  errorKind: AgentError["kind"];
  message: string;
  fatal: boolean;
}

// An exit row.
export interface ExitNode {
  type: "exit";
  seq: number;
  code: number;
}

// A plain, non-error notice row (an informational orchestrator message). Carries
// NO error semantics — it never flips session state, never renders an "Error:" prefix or error face.
export interface NoticeNode {
  type: "notice";
  seq: number;
  message: string;
}

// A quota auto-resume banner row — a PURE render node owned by the orchestrator observer wiring (NOT
// the agent-stream reducer; the `quota_exceeded` frame stays inert). It NEVER flips session/complete
// state. There is at most ONE in the tree at a time: a second pause UPDATES the single node in place
// (state waiting -> exhausted) rather than appending a duplicate (the model keys it as a singleton).
//   - "waiting":   the session paused mid-turn, auto-resume is armed; the renderer draws a live
//                  wall-clock countdown to `resetAt` and the "auto-resume armed · N left" pill. NO
//                  Resume button (resuming before the quota refreshes is impossible).
//   - "exhausted": the once-per-session auto-resume budget was already spent; the renderer draws the
//                  next reset time + a Cancel-session affordance ONLY (no countdown, no auto-resume).
// `resetAt` is epoch-MILLISECONDS (already normalized by the orchestrator — never re-scaled here).
// `remaining` is the auto-resume attempts left (only meaningful for "waiting"; 0 for "exhausted").
export interface QuotaBannerNode {
  type: "quota-banner";
  seq: number;
  state: "waiting" | "exhausted";
  resetAt: number;
  remaining: number;
  source: string;
  // DEMO-ONLY override (mock-animate scrubbable countdown): when present the WAITING banner renders
  // this static remaining-ms instead of arming a live wall-clock countdown, so the value is a pure
  // function of scrub-time T. Production NEVER sets it — the live wall-clock path is unchanged.
  frozenRemainingMs?: number;
}

// A subagent group: an accent-bordered container keyed by agent_id, holding nested nodes.
// When a `subagent_started` frame is seen for this group's id, its identity + task are attached so
// the renderer draws a labeled header ("Subagent · {subagentType} — {description}"); absent that
// frame (older sidecar) these stay null and the renderer falls back to the anonymous box.
export interface SubagentGroupNode {
  type: "subagent";
  // The earliest seq among the group's children (so the group sorts into the timeline). When the
  // group was seeded by a `subagent_started` frame BEFORE any child, this is that frame's seq so the
  // group appears immediately at the point the subagent started.
  seq: number;
  agentId: string;
  // Subagent identity + task from the `subagent_started` frame (null until/unless it arrives).
  subagentType: string | null;
  description: string | null;
  prompt: string | null;
  children: RenderNode[];
}

// Any node that can appear at the top level of the timeline OR inside a subagent group.
// (A subagent group only appears at the top level.)
export type RenderNode =
  | ToolNode
  | TextNode
  | UserMessageNode
  | SystemMessageNode
  | ModeNode
  | PermissionRequestNode
  | QuestionRequestNode
  | PermissionDeniedNode
  | ResultNode
  | ErrorNode
  | ExitNode
  | NoticeNode
  | QuotaBannerNode;

export type TopNode = RenderNode | SubagentGroupNode;

// The single, in-place "working…" indicator state. Non-null while a turn is active (events have
// arrived but no `result`/`exit` yet); carries the latest `status` label, or a generic seed
// ("Working…") before any status frame arrives. The renderer shows ONE indicator from this (never
// appended per-event); null hides it. The controller may additionally force it null when the session
// is not actively generating (e.g. after Pause), so the indicator never lingers.
export interface WorkingState {
  label: string;
}

// The full derived, renderable tree.
export interface RenderTree {
  // Top-level nodes in `seq` order (subagent groups interleaved at their earliest child seq).
  nodes: TopNode[];
  // The current permission mode (last mode_change / system_init), or null if never set.
  permissionMode: string | null;
  // True once a `result` frame has landed.
  complete: boolean;
  // The live "working…" indicator, or null when no turn is active (idle / complete / exited).
  working: WorkingState | null;
}

// The generic label shown the instant a turn starts, before any `status` frame arrives.
export const WORKING_SEED_LABEL = "Working…";

// Shown INSTEAD of the latest status label while the agent is blocked on the user — a held
// interactive permission (AskUserQuestion answers / ExitPlanMode plan review). While a canUseTool
// hold is pending the SDK emits no further frames, so without this override the indicator would
// show a stale "thinking…" forever.
export const WAITING_INPUT_LABEL = "Waiting for your input…";

// Every event this model accepts. agent-error / agent-exit / tool-permission-requested are
// tagged so they can share one accumulation list with the agent-stream union. We give them
// synthetic seqs at append time (they carry their own seq for the first two; agent-error /
// agent-exit do NOT carry a seq on the wire, so the controller assigns a monotonic one).
export type ModelEvent =
  | AgentStream
  | ToolPermissionRequested
  | ({ __event: "error"; seq: number } & AgentError)
  | ({ __event: "exit"; seq: number } & AgentExit)
  | { __event: "notice"; seq: number; message: string }
  | {
      // A verbatim user-message echo, appended AFTER a user-submitted feedback/message dispatch
      // SUCCEEDS. `seq` is `lastWireSeq + 0.5` (assigned inside appendUserMessage, NOT controller-
      // assigned) so it sorts after every frame seen so far but strictly before the agent's reply (the
      // next wire frame). On derive it produces a standalone UserMessageNode.
      __event: "user_message";
      seq: number;
      text: string;
      // Multimodal: DISPLAY data URLs of images attached to this message (attach order). OMITTED when
      // the message had no images, so a text-only echo carries no images key.
      images?: string[];
    }
  | {
      // A verbatim SYSTEM-message echo (history-replay only): a harness-injected role:"user" plumbing
      // record that the human did not type. Carries its TRUE file-position seq (like user_message in
      // replay). On derive it produces a standalone SystemMessageNode (dim bubble).
      __event: "system_message";
      seq: number;
      text: string;
    }
  | {
      // A synthetic "the user submitted answers for this AskUserQuestion request" marker, appended by
      // the controller after a successful resolve_tool_permission. It carries no wire seq; the
      // controller assigns one (its `seq` only positions it in the ordering — the derive folds it onto
      // the matching question_request node by `id`, it never produces a standalone node).
      __event: "question_answered";
      seq: number;
      id: string;
      answers: AskUserQuestionAnswers;
    }
  | {
      // A synthetic "the held permission `id` was resolved (allow OR deny)" marker, appended from
      // the frontend resolve path (ExitPlanMode has no question_answered — its resolution is the
      // review Approve/Request-changes click). It clears the waiting-for-input override
      // DETERMINISTICALLY at resolve time instead of waiting for the next inbound frame. Produces
      // no timeline node; `seq` is controller-assigned, like question_answered.
      __event: "permission_resolved";
      seq: number;
      id: string;
    }
  | {
      // The quota-banner singleton (Phase 5). Appended/updated by the orchestrator observer wiring on
      // onQuotaPaused/onQuotaExhausted; cleared on onQuotaResumed. There is at most ONE in the event
      // list at a time — the model methods (appendQuotaBanner / updateQuotaBanner / clearQuotaBanner)
      // mutate THIS single accumulated event rather than pushing a second, so a pause-then-exhaust
      // transition updates the node in place and never duplicates. `state` "cleared" tombstones it so
      // a resumed banner produces NO node on derive (the singleton is logically removed). `seq` is
      // `lastWireSeq + 0.5` so the banner sorts after every frame seen so far (the paused turn's last
      // frame) but before the next wire frame (the resumed turn's reply). `resetAt` is epoch-ms.
      __event: "quota_banner";
      seq: number;
      state: "waiting" | "exhausted" | "cleared";
      resetAt: number;
      remaining: number;
      source: string;
      // DEMO-ONLY (mock-animate): a static remaining-ms override carried onto the derived node. See
      // QuotaBannerNode.frozenRemainingMs. Production never sets it.
      frozenRemainingMs?: number;
    };

// The pure model. Accumulates raw events; derives the tree on demand.
export class ConversationModel {
  private events: ModelEvent[] = [];
  // The highest WIRE seq observed so far (from real agent-stream / tool-permission-requested frames
  // — NOT the controller's 1e9-based synthSeq, which would poison the tiebreaker below). Used to
  // place an echoed user bubble at `lastWireSeq + 0.5`: AFTER every frame seen so far, but strictly
  // BEFORE the next wire frame (`lastWireSeq + 1`, the agent's reply to that message). Frozen into the
  // event at append time so the placement is stable across re-derives.
  private lastWireSeq = -1;

  // Append a committed agent-stream frame.
  appendStream(ev: AgentStream): void {
    this.events.push(ev);
    if (ev.seq > this.lastWireSeq) this.lastWireSeq = ev.seq;
  }

  // Append a tool-permission-requested marker.
  appendPermissionRequest(ev: ToolPermissionRequested): void {
    this.events.push(ev);
    if (ev.seq > this.lastWireSeq) this.lastWireSeq = ev.seq;
  }

  // Append a normalized agent-error. `seq` is assigned by the controller (the wire shape
  // carries no seq) so errors interleave deterministically at their arrival point.
  appendError(ev: AgentError, seq: number): void {
    this.events.push({ __event: "error", seq, ...ev });
  }

  // Append an agent-exit. `seq` assigned by the controller.
  appendExit(ev: AgentExit, seq: number): void {
    this.events.push({ __event: "exit", seq, ...ev });
  }

  // Append a plain notice (non-error). `seq` assigned by the controller. Renders as a `.conv-notice`
  // row with the bare message — no error face, no session-state change.
  appendNotice(message: string, seq: number): void {
    this.events.push({ __event: "notice", seq, message });
  }

  // Echo a verbatim user message into the stream. The bubble is placed at `lastWireSeq + 0.5` — a
  // fractional tiebreaker that sorts it AFTER every frame seen so far but strictly BEFORE the agent's
  // reply (the next wire frame at `lastWireSeq + 1`). The seq is NOT taken from the controller's
  // 1e9-based synthSeq: that base sorts after EVERY wire frame in the session — including the agent's
  // reply to this very message — so the user bubble would visibly render BELOW the response it
  // prompted. The placement is frozen into the event here, so it is stable across re-derives.
  // MUST be called only AFTER the corresponding dispatch (send_agent_message / refinePrototype /
  // requestChanges) SUCCEEDS — a failed send must never leave an orphan bubble implying the agent
  // received feedback it did not.
  // Multimodal: `images` (optional) are DISPLAY data URLs rendered as thumbnails in the bubble. OMITTED
  // when absent/empty so a text-only echo is unchanged. Stored verbatim on the event (frozen across
  // re-derives like the seq).
  appendUserMessage(text: string, images?: string[]): void {
    this.events.push({
      __event: "user_message",
      seq: this.lastWireSeq + 0.5,
      text,
      ...(images && images.length ? { images } : {}),
    });
  }

  // Echo a verbatim user message at an EXPLICIT seq (the history-replay counterpart to
  // appendUserMessage). Unlike the live echo — which derives its seq from `lastWireSeq + 0.5` so a
  // freshly-submitted message sorts after the frames seen so far — replayed transcript user turns
  // carry their TRUE file position as the seq, so they order against the surrounding assistant /
  // tool frames exactly as they appeared on disk. Does NOT touch `lastWireSeq` (replay assigns every
  // frame's seq from one external monotonic counter; there is no live wire to track).
  appendUserMessageAt(text: string, seq: number): void {
    this.events.push({ __event: "user_message", seq, text });
  }

  // Echo a verbatim SYSTEM message at an EXPLICIT seq (history-replay only). Mirrors
  // appendUserMessageAt but produces a dim SystemMessageNode instead of a user bubble — used for
  // harness-injected role:"user" plumbing records that the human did not type. Never touches
  // session state or `lastWireSeq` (replay assigns every seq from one external monotonic counter).
  appendSystemMessageAt(text: string, seq: number): void {
    this.events.push({ __event: "system_message", seq, text });
  }

  // Record that the user submitted answers for the AskUserQuestion request `id`. `seq` is assigned by
  // the controller. On derive this folds onto the matching question_request node (form → answers).
  appendQuestionAnswered(id: string, answers: AskUserQuestionAnswers, seq: number): void {
    this.events.push({ __event: "question_answered", seq, id, answers });
  }

  // Record that the held permission `id` was resolved (allow OR deny) — the ExitPlanMode resolve
  // path's counterpart to appendQuestionAnswered. `seq` is assigned by the controller. On derive
  // this clears the waiting-for-input override (no timeline node).
  appendPermissionResolved(id: string, seq: number): void {
    this.events.push({ __event: "permission_resolved", seq, id });
  }

  // The single accumulated quota-banner event, or null when none. The banner is a SINGLETON — at most
  // one node in the tree at a time — so we hold its event by reference and mutate it in place (a
  // waiting -> exhausted transition, or a resumed clear) rather than pushing a second event that would
  // derive into a duplicate row. Held separately from `events` (it is also pushed into `events` so it
  // sorts into the timeline) only to support the in-place update/clear.
  private quotaBanner: Extract<ModelEvent, { __event: "quota_banner" }> | null = null;

  // Append OR update the quota banner as a SINGLETON. The first call creates the event (placed at
  // `lastWireSeq + 0.5`, after the paused turn's last frame but before the resumed reply); subsequent
  // calls UPDATE the same event in place (e.g. waiting -> exhausted), so the banner is never
  // duplicated. The `state` "cleared" tombstone is set via clearQuotaBanner (onQuotaResumed), not here.
  appendQuotaBanner(info: {
    state: "waiting" | "exhausted";
    resetAt: number;
    remaining: number;
    source: string;
    // DEMO-ONLY (mock-animate): static remaining-ms override; production omits it. See
    // QuotaBannerNode.frozenRemainingMs.
    frozenRemainingMs?: number;
  }): void {
    if (this.quotaBanner) {
      // Update the existing singleton in place — no new event, no duplicate node.
      this.quotaBanner.state = info.state;
      this.quotaBanner.resetAt = info.resetAt;
      this.quotaBanner.remaining = info.remaining;
      this.quotaBanner.source = info.source;
      this.quotaBanner.frozenRemainingMs = info.frozenRemainingMs;
      return;
    }
    const ev: Extract<ModelEvent, { __event: "quota_banner" }> = {
      __event: "quota_banner",
      seq: this.lastWireSeq + 0.5,
      state: info.state,
      resetAt: info.resetAt,
      remaining: info.remaining,
      source: info.source,
      ...(info.frozenRemainingMs !== undefined
        ? { frozenRemainingMs: info.frozenRemainingMs }
        : {}),
    };
    this.quotaBanner = ev;
    this.events.push(ev);
  }

  // Update the quota banner to a new state (e.g. waiting -> exhausted) — an alias for appendQuotaBanner
  // when one is known to exist, retained for call-site clarity. If none exists yet it creates one (so a
  // direct exhausted-without-prior-pause is still a single node).
  updateQuotaBanner(info: {
    state: "waiting" | "exhausted";
    resetAt: number;
    remaining: number;
    source: string;
    // DEMO-ONLY (mock-animate): static remaining-ms override; production omits it. Forwarded as-is.
    frozenRemainingMs?: number;
  }): void {
    this.appendQuotaBanner(info);
  }

  // Clear (tombstone) the quota banner — the onQuotaResumed counterpart. The singleton's `state` is set
  // to "cleared" so derive() produces NO node for it (the banner is logically removed) while the event
  // stays in `events` (harmless; it contributes nothing). Idempotent / inert when no banner exists.
  clearQuotaBanner(): void {
    if (this.quotaBanner) this.quotaBanner.state = "cleared";
  }

  // Reset (new session).
  reset(): void {
    this.events = [];
    this.lastWireSeq = -1;
    this.quotaBanner = null;
  }

  // Derive the renderable tree from the accumulated events. Pure (no mutation of `events`).
  derive(): RenderTree {
    // 1. Order strictly by seq (a stable sort on a copy — never mutate the source list).
    const ordered = [...this.events].sort((a, b) => seqOf(a) - seqOf(b));

    // 2. First pass: build tool nodes keyed by id and correlate results onto them.
    const toolById = new Map<string, ToolNode>();
    let permissionMode: string | null = null;
    let complete = false;
    // Working-indicator derivation: a turn is "active" once any event has arrived and stays active
    // until a `result` lands or the session exits. The latest `status` label (if any) is shown;
    // before the first status frame we show a generic seed so the indicator appears IMMEDIATELY on
    // run start. `result`/`exit` clear active; an arriving status re-activates (e.g. a new turn).
    let active = false;
    let latestStatusLabel: string | null = null;
    let exited = false;
    // The id of the latest UNRESOLVED interactive permission hold (the agent is blocked on the
    // user — AskUserQuestion or ExitPlanMode). Set on a tool-permission-requested event; cleared
    // by its resolution (question_answered / permission_resolved with a MATCHING id — id-matched
    // so a late synthetic resolve, whose controller-assigned seq sorts after every wire frame,
    // can never clear a NEWER hold) or by any frame proving the turn progressed (the SDK emits
    // nothing while a canUseTool hold is pending, so any progress frame means it was released).
    let pendingInteractiveId: string | null = null;

    // We collect "placed" nodes (everything except tool_results, which fold into their tool)
    // alongside the parent_tool_use_id they belong under (null = top level).
    const placed: Array<{ node: RenderNode; parent: string | null }> = [];

    // Subagent metadata from `subagent_started` frames, keyed by tool_use_id (= the group key =
    // the children's parent_tool_use_id). Built in one pass so a frame arriving BEFORE its children
    // (seed an empty group) OR AFTER them (annotate an existing group) both resolve — wire order is
    // irrelevant. `seq` is retained so a metadata-only group sorts into the timeline at its start.
    interface SubagentMeta {
      seq: number;
      subagentType: string | null;
      description: string | null;
      prompt: string | null;
    }
    const subagentMeta = new Map<string, SubagentMeta>();

    // AskUserQuestion answers, keyed by request id — folded onto the matching question_request node
    // (so a submitted card shows the chosen answers and drops its input form). Built in one pass so a
    // late-arriving answered event still resolves regardless of wire order.
    const answersById = new Map<string, AskUserQuestionAnswers>();
    // The question_request nodes, by id, so we can set `.answers` after the loop.
    const questionNodes = new Map<string, QuestionRequestNode>();

    for (const ev of ordered) {
      if (isStream(ev)) {
        // Any non-terminal stream frame implies a turn is generating → activate the indicator
        // (the per-kind cases below de-activate on `result`). This makes the indicator appear on the
        // first frame (system_init) before any explicit `status` arrives.
        if (ev.kind !== "result") active = true;
        // Any frame proving the turn progressed means the interactive hold (if any) was released —
        // the SDK emits no frames for the turn while a canUseTool hold is pending.
        switch (ev.kind) {
          case "assistant_text":
          case "tool_use":
          case "tool_result":
          case "status":
          case "mode_change":
          case "result":
            pendingInteractiveId = null;
            break;
        }
        switch (ev.kind) {
          case "system_init":
            permissionMode = ev.permission_mode;
            break;
          case "status":
            // Label-only progress signal — update the live indicator (does NOT add a timeline node).
            latestStatusLabel = ev.label;
            break;
          case "quota_exceeded":
            // INERT here. A non-fatal quota notice that travels via agent-stream (NOT agent-error).
            // It adds NO timeline node, does NOT flip `complete`, and does NOT clear/seed `working`
            // or `active`. The waiting banner + auto-resume are owned by the orchestrator observer
            // in a LATER phase — this reducer stays a pure inert pass-through so the exhaustive
            // discriminated-union switch remains sound.
            break;
          case "subagent_started":
            // Record the subagent's identity + task, keyed by its tool_use_id (= the group key). This
            // adds NO timeline node directly — it seeds/annotates the subagent group in the grouping
            // pass below, so the group appears (labeled) even before its first child arrives.
            subagentMeta.set(ev.tool_use_id, {
              seq: ev.seq,
              subagentType: ev.subagent_type,
              description: ev.description,
              prompt: ev.prompt,
            });
            break;
          case "assistant_text":
            // Whitespace-only text frames render as empty bubbles (and a blank subagent child
            // would seed an empty group via its parent_tool_use_id) — drop them entirely.
            if (ev.text.trim() === "") break;
            placed.push({
              node: { type: "text", seq: ev.seq, text: ev.text },
              parent: ev.parent_tool_use_id,
            });
            break;
          case "tool_use": {
            const node: ToolNode = {
              type: "tool",
              seq: ev.seq,
              id: ev.id,
              tool: ev.tool,
              input: ev.input,
              status: "running",
              result: null,
              isError: false,
            };
            toolById.set(ev.id, node);
            placed.push({ node, parent: ev.parent_tool_use_id });
            break;
          }
          case "tool_result": {
            // Correlate onto the matching tool_use by id. A result with no matching tool_use
            // is dropped (no orphan row) — the tool row is the unit of display.
            const target = toolById.get(ev.tool_use_id);
            if (target) {
              target.status = ev.is_error ? "error" : "done";
              target.result = ev.content;
              target.isError = ev.is_error;
            }
            break;
          }
          case "mode_change":
            permissionMode = ev.mode;
            placed.push({
              node: { type: "mode", seq: ev.seq, mode: ev.mode },
              parent: null,
            });
            break;
          case "result":
            complete = true;
            // The turn finished — the working indicator must hide. A later status frame (next turn)
            // re-activates it; latestStatusLabel is cleared so the next turn re-seeds cleanly.
            active = false;
            latestStatusLabel = null;
            placed.push({
              node: {
                type: "result",
                seq: ev.seq,
                isError: ev.is_error,
                result: ev.result,
                subtype: ev.subtype,
                // The verdict survives rebuilds ONLY because it lives on the stored frame.
                deliberateInterrupt: ev.deliberateInterrupt ?? false,
              },
              parent: null,
            });
            break;
          case "permission_denied":
            placed.push({
              node: {
                type: "permission_denied",
                seq: ev.seq,
                tool: ev.tool,
                toolUseId: ev.tool_use_id,
                reasonType: ev.decision_reason_type,
                message: ev.message,
              },
              parent: null,
            });
            break;
        }
      } else if (isPermissionRequest(ev)) {
        active = true; // a pending permission means the turn is live (awaiting review)
        // The agent is now blocked on the user (AskUserQuestion answers / ExitPlanMode review) —
        // the working indicator must say so instead of repeating a stale status label.
        pendingInteractiveId = ev.id;
        if (ev.tool === "AskUserQuestion") {
          // An interactive question request: render the answer card. Pull the questions array off the
          // tool input (defensively coerced); the controller resolves it via resolve_tool_permission.
          const input = ev.input as { questions?: unknown } | null | undefined;
          const questions = Array.isArray(input?.questions)
            ? (input!.questions as AskUserQuestionItem[])
            : [];
          const node: QuestionRequestNode = {
            type: "question_request",
            seq: ev.seq,
            id: ev.id,
            questions,
            answers: null,
          };
          questionNodes.set(ev.id, node);
          placed.push({ node, parent: null });
        } else {
          placed.push({
            node: {
              type: "permission_request",
              seq: ev.seq,
              id: ev.id,
              tool: ev.tool,
              agentId: ev.agent_id,
            },
            parent: null,
          });
        }
      } else if (ev.__event === "question_answered") {
        // A submitted answer set — record it; folded onto the matching question_request node below.
        // It produces NO standalone node, so a stray answered event with no matching request is inert.
        answersById.set(ev.id, ev.answers);
        if (ev.id === pendingInteractiveId) pendingInteractiveId = null;
      } else if (ev.__event === "permission_resolved") {
        // The held permission was resolved from the frontend (ExitPlanMode approve/deny) — clear
        // the waiting-for-input override NOW; the SDK's next frames may lag the click.
        if (ev.id === pendingInteractiveId) pendingInteractiveId = null;
      } else if (ev.__event === "error") {
        // A fatal error ends the session → hide the working indicator (a non-fatal error leaves the
        // turn running, so it does NOT deactivate).
        if (ev.fatal) {
          exited = true;
          active = false;
        }
        placed.push({
          node: {
            type: "error",
            seq: ev.seq,
            errorKind: ev.kind,
            message: ev.message,
            fatal: ev.fatal,
          },
          parent: null,
        });
      } else if (ev.__event === "notice") {
        // A plain notice — never touches session state (no exited/active flip). Pure render row.
        placed.push({
          node: { type: "notice", seq: ev.seq, message: ev.message },
          parent: null,
        });
      } else if (ev.__event === "user_message") {
        // A verbatim user-message echo — a top-level bubble. Never touches session state (it is a
        // record of what the user sent, not an agent signal); sorts into the timeline by its seq.
        placed.push({
          node: {
            type: "user",
            seq: ev.seq,
            text: ev.text,
            // Carry the display image URLs onto the node ONLY when present (omitted otherwise so a
            // text-only bubble renders no thumbnail row).
            ...(ev.images && ev.images.length ? { images: ev.images } : {}),
          },
          parent: null,
        });
      } else if (ev.__event === "system_message") {
        // A verbatim SYSTEM-message echo (harness-injected plumbing turn) — a top-level dim bubble.
        // Never touches session state; sorts into the timeline by its seq, exactly like user_message.
        placed.push({
          node: { type: "system", seq: ev.seq, text: ev.text },
          parent: null,
        });
      } else if (ev.__event === "quota_banner") {
        // The quota-banner singleton — a PURE render row. Never touches session state (no complete/
        // active/exited flip). A "cleared" tombstone (onQuotaResumed) produces NO node, so the banner
        // is logically removed; "waiting"/"exhausted" each derive the single banner node.
        if (ev.state !== "cleared") {
          placed.push({
            node: {
              type: "quota-banner",
              seq: ev.seq,
              state: ev.state,
              resetAt: ev.resetAt,
              remaining: ev.remaining,
              source: ev.source,
              // DEMO-ONLY (mock-animate) static-countdown override; undefined in production.
              frozenRemainingMs: ev.frozenRemainingMs,
            },
            parent: null,
          });
        }
      } else {
        // exit — the session ended; the working indicator must hide.
        exited = true;
        active = false;
        placed.push({
          node: { type: "exit", seq: ev.seq, code: ev.code },
          parent: null,
        });
      }
    }

    // 2b. Fold submitted answers onto their question_request nodes (form → chosen answers).
    for (const [id, answers] of answersById) {
      const node = questionNodes.get(id);
      if (node) node.answers = answers;
    }

    // 3. Group: nodes with a non-null parent fold into a subagent group keyed by that parent.
    // The group's seq is the EARLIEST child seq so it sorts into the top-level timeline at the
    // point its first activity appears. (Grouping key is the frozen parent_tool_use_id; NO
    // name label is attached — none is frozen.)
    const topNodes: TopNode[] = [];
    const groups = new Map<string, SubagentGroupNode>();

    // Create-or-fetch a subagent group for `id`, applying any known metadata. Metadata may have
    // arrived before OR after the first child; this is order-independent because both the metadata
    // pass (above) and the placed-node pass funnel through here.
    const groupFor = (id: string): SubagentGroupNode => {
      let group = groups.get(id);
      if (!group) {
        const meta = subagentMeta.get(id);
        group = {
          type: "subagent",
          // Seed seq from metadata when present; the earliest-child fold below lowers it further.
          seq: meta ? meta.seq : Number.MAX_SAFE_INTEGER,
          agentId: id,
          subagentType: meta?.subagentType ?? null,
          description: meta?.description ?? null,
          prompt: meta?.prompt ?? null,
          children: [],
        };
        groups.set(id, group);
        topNodes.push(group);
      }
      return group;
    };

    // 3a. Seed groups for every `subagent_started` frame FIRST — so a group appears (labeled) the
    // instant the subagent starts, even before any child node has arrived.
    for (const id of subagentMeta.keys()) {
      groupFor(id);
    }

    for (const { node, parent } of placed) {
      if (parent === null) {
        topNodes.push(node);
        continue;
      }
      const group = groupFor(parent);
      group.children.push(node);
      // The group's seq tracks the earliest child so it sorts correctly in the timeline.
      if (node.seq < group.seq) group.seq = node.seq;
    }

    // 4. Final top-level order by seq (groups already carry their earliest-child seq); children
    // within a group are already in seq order (placed was iterated in seq order).
    topNodes.sort((a, b) => a.seq - b.seq);

    // The working indicator: shown while active (and not exited), carrying the latest status label
    // or the generic seed before any status frame arrives. `exited` is belt-and-suspenders (active is
    // already cleared on exit/result/fatal-error).
    // An unresolved interactive hold OVERRIDES the status label — the agent is blocked on the
    // user, not "thinking…".
    const working: WorkingState | null =
      active && !exited
        ? {
            label:
              pendingInteractiveId !== null
                ? WAITING_INPUT_LABEL
                : (latestStatusLabel ?? WORKING_SEED_LABEL),
          }
        : null;

    return { nodes: topNodes, permissionMode, complete, working };
  }
}

// ---- internal type guards / helpers --------------------------------------------------------

function seqOf(ev: ModelEvent): number {
  return ev.seq;
}

function isStream(ev: ModelEvent): ev is AgentStream {
  // agent-stream frames carry one of the committed `kind` strings and no __event tag.
  return (
    !("__event" in ev) &&
    "kind" in ev &&
    ev.kind !== "tool_permission_requested"
  );
}

function isPermissionRequest(ev: ModelEvent): ev is ToolPermissionRequested {
  return (
    !("__event" in ev) &&
    "kind" in ev &&
    ev.kind === "tool_permission_requested"
  );
}
