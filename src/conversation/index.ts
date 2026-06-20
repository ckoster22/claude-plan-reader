// Conversation domain (Sub-Plan 02) — facade / controller.
//
// The single entry point main.ts calls: initConversation(). It subscribes to the FIVE frozen
// Tauri events, feeds them into the pure ConversationModel, re-renders the DOM, and owns the UI
// side of cancel (cancel_agent_run) + session teardown (end_agent_session). The composer and the
// status controller are constructed here with their real Tauri invokers.
//
// Disjoint from src/render/* and the sidebar — converges with the app only at main.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ConversationModel, WORKING_SEED_LABEL, WAITING_INPUT_LABEL } from "./stream";
import { parseTranscript, applyTranscriptToModel } from "./history";
import { renderTree } from "./render";
import { createMinimap } from "./minimap";
import { Composer } from "./composer";
import { StatusController } from "./status";
import { getOrchestrator, isOrchestrationActive, isOrchestratorResuming } from "./orchestrator";
import { createImageAttachments, type ImageAttachments } from "./attachments";
import { imagesToDataUrls } from "./images";
import { diag } from "./diag";
import type {
  AgentStream,
  ToolPermissionRequested,
  AgentError,
  AgentExit,
  AgentAuthStatus,
  AskUserQuestionAnswers,
} from "./types";

// Sticky-scroll threshold (px): the user counts as "at the bottom" when the distance from the
// bottom of the scroll viewport is within this slack. A few px of slack absorbs sub-pixel rounding
// and the gap that a freshly-appended frame opens between measuring and re-rendering.
export const STICK_THRESHOLD_PX = 40;

// PURE: is the scroll position within STICK_THRESHOLD_PX of the bottom? Operates on the three raw
// geometry numbers so it is testable without a real layout engine. scrollHeight - scrollTop -
// clientHeight is the remaining distance to the bottom (0 ⇔ pinned). EXPORTED for unit tests.
export function isAtBottom(geom: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return geom.scrollHeight - geom.scrollTop - geom.clientHeight <= STICK_THRESHOLD_PX;
}

// All DOM handles the controller needs (resolved by main.ts from index.html).
export interface ConversationElements {
  // The #conversation-stream render container.
  stream: HTMLElement | null;
  // The #conversation-minimap right-margin gutter (sibling of `stream`). Optional — when absent the
  // minimap controller is a no-op, so the rest of the controller can call minimap.rebuild() freely.
  minimap?: HTMLElement | null;
  // ---- Conversation-tab session controls (the 3-state machine) ----
  // Stop: full-stop (interrupt the turn AND end the session) → state none. Enabled ⇔ active|idle.
  // `cancelBtn` is the legacy name for this exact control (today's Cancel = full-stop), kept as an
  // alias so existing wiring/tests compile; `stopBtn` is the canonical name. When both are present
  // they refer to the SAME element.
  cancelBtn: HTMLButtonElement | null;
  stopBtn?: HTMLButtonElement | null;
  // Pause: interrupt the current turn ONLY (session stays alive) → state idle. Enabled ⇔ active.
  pauseBtn?: HTMLButtonElement | null;
  // Resume: push a "Continue." user turn into the live (idle) session → state active. Enabled ⇔ idle.
  resumeBtn?: HTMLButtonElement | null;
  // The titlebar "+ New plan" button. Disabled while a session is live so the composer can't be opened
  // mid-run (Fix 4). Optional so older callers/tests compile.
  newPlanBtn?: HTMLButtonElement | null;
  // ---- Free-text message composer (human-in-the-loop) ----
  // A persistent input + Send button at the bottom of the Conversation tab. Enabled ⇔ a session is
  // live (active OR idle); disabled when none. Sending pushes a user turn via send_agent_message.
  // Optional so older callers/tests compile.
  messageInput?: HTMLTextAreaElement | null;
  sendBtn?: HTMLButtonElement | null;
  // ---- Multimodal image input for the in-conversation follow-up surface ----
  // Optional so older callers/tests compile. When attachStrip is present an image-attachment
  // controller is wired onto the messageInput (paste/drop) + attachBtn/fileInput (file-pick); chips
  // render into attachStrip and attach-time rejections show in attachError.
  attachStrip?: HTMLElement | null;
  attachBtn?: HTMLElement | null;
  fileInput?: HTMLInputElement | null;
  attachError?: HTMLElement | null;
  // Composer modal handles.
  composer: import("./composer").ComposerElements;
  // Status pill + onboarding handles.
  status: import("./status").StatusElements;
}

// What initConversation returns to main.ts so it can open the composer + tear down.
export interface ConversationHandle {
  // Open the New-plan composer modal (wired to #new-plan-btn).
  openComposer(): void;
  // Surface a plain NOTICE into the conversation stream (a rendered `conv-notice` row — NO "Error:"
  // prefix, no error face). The general informational channel for non-error orchestrator messages.
  // Routes through the model's dedicated notice node so it survives re-derive.
  surfaceMessage(text: string): void;
  // Echo a VERBATIM user message as a user-attributed bubble in the conversation stream. Used by the
  // out-of-band feedback submission sites in main.ts (prototype "Request changes", plan-review
  // comment submit) so the user's own words appear in the conversation. MUST be called only AFTER the
  // corresponding dispatch SUCCEEDS — a failed send must never leave an orphan bubble. (The free-text
  // composer echoes its own sends internally and does not use this.) Routes through the model so it
  // interleaves in stream order and survives re-derive.
  echoUserMessage(text: string): void;
  // The held interactive permission `id` (SDK toolUseID) was just resolved from a frontend resolve
  // path (ExitPlanMode Approve / Request-changes — the paths with NO question_answered). Clears the
  // model's waiting-for-your-input working label deterministically at resolve time instead of
  // waiting for the SDK's next inbound frame. Idempotent / inert for an unknown or already-cleared id.
  notifyPermissionResolved(id: string): void;
  // Idle-waiting override: some review gates (the visual-prototype gate) are TURN-COMPLETION
  // signaled — the intent turn ends with a `result` frame, the session goes idle, and the working
  // indicator would normally hide even though the app is blocked on the user's approve/refine.
  // When ON and the session is idle (live, no active turn), the working indicator renders
  // WAITING_INPUT_LABEL instead of hiding; when OFF, normal behavior. It never interferes with an
  // ACTIVE turn (the model-derived label wins) or with the "none" state (no session → never show).
  // Toggling triggers a rerender; setting the same value is a no-op.
  setIdleWaitingHint(on: boolean): void;
  // Reconstruct + replay a plan's PAST conversation into the pane (silent populate on plan-select).
  // A NO-OP whenever a live session OR an orchestration owns the pane (the live model always wins);
  // otherwise it loads the plan's transcript via read_plan_transcript and renders it as history, or
  // an explicit empty state when no transcript is resolvable / it yields no renderable content. Fully
  // guarded against supersession (a newer load) and a live run starting mid-await via historyGen +
  // the liveness re-check. Fire-and-forget from main.ts's openPlan; never throws.
  loadHistoryForPlan(stem: string): Promise<void>;
  // Repaint the right-margin minimap with current geometry. main.ts calls this when the Conversation
  // pane transitions display:none → visible (a reader-tab switch), where nothing mutates the stream
  // subtree so no rerender()/observer fires — the first paint of the just-revealed pane would
  // otherwise rely implicitly on a ResizeObserver crossing the visibility flip. No-op when the
  // minimap element is absent (the controller is the null stub).
  refreshMinimap(): void;
  // Tear down: unsubscribe events + end the session. Idempotent.
  teardown(): Promise<void>;
}

// Subscribe to the five events, drive the model -> renderer, own cancel + teardown.
// `onActivity` is called on the first stream/permission event so the controller can flip the
// reading-pane to the Conversation tab (main.ts supplies it). Returns a handle.
export async function initConversation(
  els: ConversationElements,
  onActivity: () => void,
): Promise<ConversationHandle> {
  const model = new ConversationModel();
  // Monotonic synthetic seq for events that carry no wire seq (agent-error / agent-exit /
  // question-answered).
  let synthSeq = 1_000_000_000;

  // ---- PaneSource: the SINGLE discriminated source of truth for what the pane renders ----
  //
  // The pane can never mix live + history: it is driven by EXACTLY ONE of these at a time.
  //   "live"    — the live `model` above drives the pane (default; the live agent-run stream).
  //   "history" — a replayed transcript `model` drives the pane (a past plan's reconstruction). `gen`
  //               is the historyGen at the time the load committed (for traceability; the freshness
  //               guard runs in loadHistoryForPlan, not in rerender).
  //   "empty"   — an explicit empty state for a selected plan (no transcript / no renderable content).
  //
  // Two chokepoints mutate it: loadHistoryForPlan (sets history/empty) and applySessionState (any
  // transition into a live state forces {kind:"live"} and bumps historyGen, so a live run always
  // SUPERSEDES history and any in-flight history load is dropped on its post-await freshness check).
  type PaneSource =
    | { kind: "live" }
    | { kind: "history"; model: ConversationModel; gen: number }
    | { kind: "empty"; stem: string; reason: "no-transcript" | "no-content" };
  let paneSource: PaneSource = { kind: "live" };
  // Monotonic generation for history loads — bumped on every loadHistoryForPlan start AND on every
  // live takeover, so a stale resolve (a later load superseded it, or a live run started) drops.
  let historyGen = 0;

  // AskUserQuestion: remember each request's ORIGINAL `questions` array (keyed by toolUseID) so the
  // submit handler can return `updatedInput: { questions, answers }` — the SDK expects the original
  // questions echoed alongside the answers. Captured when the tool-permission-requested event lands.
  const pendingQuestions = new Map<string, unknown>();

  // Submit handler for a question card: resolve the held AskUserQuestion request with the answers,
  // then record the submission so the card re-renders read-only (and the input affordance is removed).
  const submitQuestion = (id: string, answers: AskUserQuestionAnswers): void => {
    const questions = pendingQuestions.get(id) ?? [];
    pendingQuestions.delete(id);
    void invoke("resolve_tool_permission", {
      id,
      allow: true,
      message: null,
      updatedInput: { questions, answers },
    }).catch((err) => console.error("resolve_tool_permission (AskUserQuestion) failed", err));
    // Record the answers so the stream keeps a permanent record and drops the form.
    model.appendQuestionAnswered(id, answers, synthSeq++);
    rerender();
  };

  // ---- SessionState: the SINGLE source of truth for session liveness ----
  //
  // "none"   — no backend agent session is live (never started / ended / fully stopped).
  // "active" — a backend session is live AND a turn is generating (streaming / awaiting a permission).
  // "idle"   — a backend session is live but NO turn is active (after a `result`, or after Pause).
  //
  // This one value gates EVERY liveness-derived control. No consumer keeps its own copy: New-plan,
  // Stop/Pause/Resume, the status pill's building/idle face, and the composer modal are all DERIVED
  // from it in applySessionState() below, called on every transition. That makes the impossible states
  // — "New-plan modal open while a session is live", "pill building while none", "Resume enabled while
  // active" — unrepresentable rather than guarded after the fact.
  type SessionState = "none" | "active" | "idle";
  let session: SessionState = "none";

  // Idle-waiting override (see ConversationHandle.setIdleWaitingHint): while ON and the session is
  // idle, rerender() shows WAITING_INPUT_LABEL instead of hiding the working indicator. Set from
  // main.ts off the orchestrator snapshot (pendingPrototype != null). Never consulted while a turn
  // is active (the model-derived label wins) or while no session exists.
  let idleWaitingHint = false;

  // Resume-after-end seam: retain enough to re-open the SAME session when the user types into the
  // (now always-enabled) composer after Stop / natural exit. `lastCwd` is captured at session start
  // (the cwd passed to the orchestrator start thunk — the authoritative running-session cwd, more
  // correct than the composer's last-chosen-dir localStorage). `lastSessionId` is the latest SDK
  // session id seen on any agent-stream frame that carries one (system_init / result); resuming with
  // it makes the next turn continue the prior transcript. Both are null until a session has started.
  // They are NOT cleared on session-end on purpose — they ARE the resume target after end.
  let lastCwd: string | null = null;
  let lastSessionId: string | null = null;

  // A backend session exists in BOTH active and idle (only `none` has no child). New-plan is blocked
  // whenever a session exists; the pill shows "building" only while a turn actively generates.
  const isLive = (s: SessionState): boolean => s !== "none";

  // Apply a transition and re-derive ALL liveness-dependent UI from the new state. Idempotent: a
  // repeated transition to the same state is harmless (so a late agent-exit after an explicit Stop
  // does nothing). This is the ONLY place that mutates `session`.
  const applySessionState = (next: SessionState): void => {
    session = next;
    const live = isLive(session); // a child exists (active OR idle)

    // Live takeover: a session going live ALWAYS reclaims the pane from any history/empty source and
    // invalidates any in-flight history load (the historyGen bump fails its post-await freshness
    // check). EVERY live transition funnels through applySessionState (composer onStarted, the
    // agent-stream listener, the tool-permission-requested listener), so this is the single chokepoint
    // for the takeover. Idempotent: a repeated transition while already live is harmless.
    if (live && paneSource.kind !== "live") {
      paneSource = { kind: "live" };
      ++historyGen;
    }

    const active = session === "active"; // a turn is generating
    const idle = session === "idle"; // session alive, no active turn

    // Sub-Plan 03: while a multiplan orchestration owns the session, Pause/Resume are DISABLED — the
    // orchestrator drives its own turns via the sequencer, and an out-of-band interrupt or "Continue."
    // would inject a turn the sequencer does not expect (corrupting pendingStep). Stop stays available
    // (it routes through the orchestrator's cancel()).
    const orchActive = isOrchestrationActive();

    // Derive the controls PURELY from state — they cannot disagree.
    // Stop: enabled ⇔ a session exists (active or idle). (cancelBtn === stopBtn — same element.)
    const stopEl = els.stopBtn ?? els.cancelBtn;
    if (stopEl) stopEl.disabled = !live;
    // Pause: enabled ⇔ a turn is actively generating AND no orchestration owns the turns.
    if (els.pauseBtn) els.pauseBtn.disabled = !active || orchActive;
    // Resume: enabled ⇔ the session is idle (alive, no active turn) AND no orchestration owns the turns.
    if (els.resumeBtn) els.resumeBtn.disabled = !idle || orchActive;
    // New-plan: disabled ⇔ a session exists (live blocks a new plan).
    if (els.newPlanBtn) els.newPlanBtn.disabled = live;
    // Free-text composer: the textarea is ALWAYS typable, including after Stop / natural session-end
    // (state "none"). The next Send then RESUMES the prior session id (same conversation context) by
    // re-opening the SDK session and pushing the typed text as a user turn (see sendMessage). Send is
    // likewise always enabled so that resume affordance is reachable by click, not only by Enter; the
    // empty-text guard in sendMessage prevents firing on a blank field, and the none-branch there owns
    // the resume-vs-no-retained-session gating. (Stop/Pause/Resume/New-plan above stay state-derived.)
    if (els.messageInput) els.messageInput.disabled = false;
    if (els.sendBtn) els.sendBtn.disabled = false;

    // Derive the pill's building/idle face: only an ACTIVE turn shows "building". none/idle force
    // building=false (the pill can never show "building" while idle or stopped); a more-urgent
    // sub-state (auth/fatal/complete) overrides it inside StatusController.
    statusController.setBuilding(active);

    // Belt-and-suspenders: a session going live can never coexist with an open composer. Opening the
    // composer while live is already blocked (openComposer no-op), and Start closes the modal itself;
    // this closes it from the OTHER direction (a session started out-of-band while the modal was open).
    if (live) {
      composer.close();
    }
  };

  const statusController = new StatusController(els.status, {
    authStatus: () => invoke<AgentAuthStatus>("agent_auth_status"),
    setToken: (token) => invoke("set_agent_oauth_token", { token }).then(() => undefined),
  });

  const composer = new Composer(
    els.composer,
    {
      // Sub-Plan 03: Start delegates to the shared orchestrator. start() opens the SDK session in
      // plan mode AND sends the first (recon) prompt itself, so the composer no longer fires
      // start_agent_session / send_agent_message. It returns true on a real start, false on the
      // idempotent no-op (a run is already active) — the composer only closes + runs onStarted on true.
      start: (args) => {
        // Capture the running-session cwd so a later post-end Send can re-open the SAME session under
        // the SAME root (the authoritative session cwd). Set it ONLY after start() RESOLVES TRUE: a
        // false return is the idempotent no-op (a run is already active) and must NOT overwrite the
        // already-captured cwd of the in-flight session with this dead start's args.
        //
        // Multimodal: thread the composer's attached images straight through to the orchestrator's
        // first intent send. OMITTED-WHEN-EMPTY — `args.images` is only present when ≥1 image was
        // attached (the composer never sends an empty `images`), so a text-only start passes no key.
        return getOrchestrator()
          .start(
            args.images && args.images.length
              ? { cwd: args.cwd, request: args.request, images: args.images }
              : { cwd: args.cwd, request: args.request },
          )
          .then((started) => {
            if (started) {
              lastCwd = args.cwd;
              // COMPOSER FIRST-TURN ECHO (gated on images-present). The orchestrator sends
              // intentPrompt(request) and never echoes the raw request as a bubble, so without this
              // there is nothing to attach thumbnails to. When ≥1 image is attached, echo the RAW
              // `request` (NOT the intentPrompt wrapper) + the display image URLs so the user's
              // attachments appear in history. GATED on images: a text-only start echoes NO first-turn
              // bubble, keeping the text-only composer flow byte-identical to today. Echoed only on a
              // TRUE start (mirroring the in-conversation echo-on-success discipline).
              if (args.images && args.images.length) {
                model.appendUserMessage(args.request, imagesToDataUrls(args.images));
                rerender();
              }
            }
            return started;
          });
      },
    },
    () => {
      // A run just started successfully. Start provably persisted/used a token, so force auth to
      // "present" (defense against a stale "no token" banner on a later composer reopen). Then
      // transition to active — applySessionState derives the pill (building), New-plan (disabled),
      // Stop/Pause (enabled), Resume (disabled), and closes the modal.
      statusController.markTokenPresent();
      applySessionState("active");
      onActivity();
      // Paint the immediate "Starting…" working indicator NOW (before the first agent-stream event)
      // so there is no dead gap right after Start. rerender() seeds it from the active session state.
      rerender();
    },
    // Default storage (localStorage last-dir memory).
    undefined,
    // Token seam — lets Start honor a typed-but-unsaved token (persist via the SAME path
    // "Save token" uses) and tell "typed nothing + none stored" apart. The StatusController's
    // saveToken/tokenPresent satisfy the TokenSaver interface directly.
    {
      saveToken: (token) => statusController.saveToken(token),
      tokenPresent: () => statusController.tokenPresent(),
    },
  );
  composer.init();
  await statusController.init();

  // Right-margin minimap controller. createMinimap already returns a no-op controller when either
  // element is null; the explicit guard here keeps that contract obvious and lets rerender() call
  // minimap.rebuild() unconditionally. Constructed AFTER the stream handle is known so the controller
  // can attach its scroll/resize/mutation observers to the real container.
  const minimap =
    els.stream && els.minimap
      ? createMinimap(els.stream, els.minimap)
      : { rebuild: (): void => {}, destroy: (): void => {} };

  // ---- Multimodal: in-conversation image-attachment controller ----
  // Bound to the follow-up textarea (paste/drop) + attach button / hidden file input (file-pick).
  // Null when the surface has no attach elements (older callers / tests) — sendMessage then forwards
  // no images. Per-instance closure state in the controller keeps it disjoint from the composer's.
  const attachments: ImageAttachments | null =
    els.messageInput && els.attachStrip
      ? createImageAttachments({
          inputEl: els.messageInput,
          chipStrip: els.attachStrip,
          attachBtn: els.attachBtn ?? undefined,
          fileInput: els.fileInput ?? undefined,
          errorEl: els.attachError ?? undefined,
        })
      : null;

  const rerender = (): void => {
    if (!els.stream) return;
    // Sticky scroll-to-bottom: measure BEFORE re-rendering whether the user is pinned to the
    // bottom of the stream. .conv-stream is the scroll container (overflow-y:auto). If they were
    // pinned, we re-pin after the new frame lands; if they had scrolled up to read history, we
    // leave their position alone (no yank). Captured pre-render because appending content changes
    // scrollHeight, which would otherwise make the "at bottom" test read against the new geometry.
    const wasAtBottom = isAtBottom(els.stream);

    // ---- Source-select: derive the pane from the active PaneSource (live | history | empty) ----
    // "empty": paint a single explicit empty-state row and stop (no model derive, no working seed).
    if (paneSource.kind === "empty") {
      const div = document.createElement("div");
      div.className = "conv-empty";
      div.textContent =
        paneSource.reason === "no-transcript"
          ? "No conversation history found for this plan."
          : "No conversation content to display for this plan.";
      els.stream.replaceChildren(div);
      if (wasAtBottom) els.stream.scrollTop = els.stream.scrollHeight;
      minimap.rebuild();
      return;
    }

    // "history": derive the REPLAYED model and force working=null (a replay is never "working").
    // Rendered through the SAME renderTree path as live, reusing the sticky-scroll measure/restore.
    if (paneSource.kind === "history") {
      const tree = paneSource.model.derive();
      tree.working = null;
      renderTree(els.stream, tree, { onSubmitQuestion: submitQuestion });
      if (wasAtBottom) els.stream.scrollTop = els.stream.scrollHeight;
      minimap.rebuild();
      return;
    }

    // "live": existing behavior, unchanged — derive the live model + the working-indicator seeding.
    const tree = model.derive();
    if (session === "active") {
      // The instant a session goes active (Start / Resume), the working indicator must appear EVEN
      // before the first backend event arrives — otherwise there is a dead gap right after Start that
      // looks broken. The model only derives `working` once events land, so seed the generic
      // "Starting…" label here when active-but-no-events-yet; real `status` frames (e.g. "thinking…",
      // "running subagent") replace it as soon as they arrive.
      if (!tree.working) tree.working = { label: WORKING_SEED_LABEL };
    } else if (session === "idle" && idleWaitingHint) {
      // Idle-waiting override: a turn-completion-signaled review gate (visual prototype) is blocking
      // on the user while the session sits idle. Without this, the gate-off branch below would hide
      // the indicator entirely even though the app is waiting for the user's approve/refine. Only
      // "idle" qualifies — "none" (no session) never shows, and an active turn takes the branch above.
      tree.working = { label: WAITING_INPUT_LABEL };
    } else {
      // Shown ONLY while actively generating: gate it off whenever the session is not "active" — so
      // Pause/Stop (which interrupt without necessarily emitting a result) hide it immediately and it
      // never lingers in the idle/none states.
      tree.working = null;
    }
    renderTree(els.stream, tree, { onSubmitQuestion: submitQuestion });
    // Re-pin to the bottom only if the user was already there (sticky follow). Scrolling up to read
    // history suppresses this, and scrolling back to the bottom resumes it on the next frame.
    if (wasAtBottom) els.stream.scrollTop = els.stream.scrollHeight;
    minimap.rebuild();
  };

  // ---- event subscriptions (the five frozen events) ----
  const unlisteners: UnlistenFn[] = [];

  unlisteners.push(
    await listen<AgentStream>("agent-stream", (e) => {
      model.appendStream(e.payload);
      // Cache the SDK session id from every frame that carries one (system_init at turn open, result
      // at turn close). This is the resume target a post-end Send threads to keep the conversation
      // context (see sendMessage's none-branch). Neither agent-exit nor Stop carry an id, so this is
      // the only place it can be captured. Latest-wins is correct: the SDK keeps one session id for
      // the conversation, so re-reads simply re-confirm the same value.
      if (e.payload.kind === "system_init" || e.payload.kind === "result") {
        if (e.payload.session_id) lastSessionId = e.payload.session_id;
      }
      // Deliberate-interrupt tagging (BEFORE rerender so the first paint is already muted): the
      // orchestrator's post-decomposition-approval interrupt surfaces as an is_error `result` with
      // no text. Only the orchestrator knows it was deliberate — it armed `resuming` before firing.
      // CRITICAL MECHANISM: mutate e.payload, the SAME object reference appendStream just
      // accumulated, so derive() re-reads the verdict from the stored frame on every rebuild — by
      // later rebuilds the orchestrator has long de-armed `resuming`, so the verdict must be
      // persisted here, never re-derived from live orchestrator state.
      if (
        e.payload.kind === "result" &&
        e.payload.is_error &&
        isOrchestrationActive() &&
        isOrchestratorResuming()
      ) {
        e.payload.deliberateInterrupt = true;
      }
      // A `result` frame means the turn COMPLETED — the session stays alive but goes idle (Resume
      // becomes available, Pause disabled, the pill drops out of building). Any OTHER stream frame
      // (system_init / assistant_text / tool_use / status / …) means a turn is generating → active.
      // system_init also confirms a live session even if the run was started out-of-band.
      applySessionState(e.payload.kind === "result" ? "idle" : "active");
      onActivity();
      rerender();
      // Sub-Plan 03 live bridge: forward the frame to the orchestrator's turn-completion sequencer so
      // a `result` advances the run. Only while an orchestration owns the seam (otherwise the legacy
      // single-shot path is untouched). Fired AFTER rendering so the Conversation tab still shows it.
      // DIAGNOSTIC (minecraft-clone halt investigation): on a `result` frame, log whether the bridge
      // gate is open and the frame is forwarded to ingestStream. If a recon `result` arrives with
      // orchActive=false, the result renders "Run complete" but never advances the orchestrator — the
      // halt. Log-only; remove after the root cause is confirmed.
      if (e.payload.kind === "result") {
        const orchActive = isOrchestrationActive();
        // Route the gate decision to the dev terminal via diag_log (the console.log only reaches the
        // WebView devtools). If a recon `result` arrives with isOrchestrationActive=false, the result
        // renders "Run complete" but never advances the orchestrator — the halt.
        diag(
          `result frame: isOrchestrationActive=${orchActive} -> ingestStream ${
            orchActive ? "CALLED" : "SKIPPED"
          }`,
        );
      }
      if (isOrchestrationActive()) void getOrchestrator().ingestStream(e.payload);
    }),
  );

  unlisteners.push(
    await listen<ToolPermissionRequested>("tool-permission-requested", (e) => {
      model.appendPermissionRequest(e.payload);
      // AskUserQuestion: stash the original `questions` array so the submit handler can echo it back
      // under updatedInput (the SDK expects { questions, answers }).
      if (e.payload.tool === "AskUserQuestion") {
        // ALWAYS capture the original `questions` array, whether or not a multiplan orchestration is
        // active, so submitQuestion resolves with the correct updatedInput { questions, answers } shape
        // the SDK expects (a populated questions echo, never []). The orchestrator clarify-ledger
        // integration (CLARIFY_REQUESTED / CLARIFY_ANSWERED, and reconciling that effect's missing
        // updatedInput) is deferred to Sub-Plan 03 — for now the existing card round-trip stays correct.
        const input = e.payload.input as { questions?: unknown } | null | undefined;
        pendingQuestions.set(e.payload.id, input?.questions ?? []);
      }
      // A pending tool permission means a turn is live + generating (awaiting review) → active
      // (belt-and-suspenders with onStarted / system_init). Derive liveness from this activity too so
      // the controls can't lag the backend.
      applySessionState("active");
      // Sub-Plan 03: main.ts OWNS the reading-pane tab for an ExitPlanMode review (it flips to the
      // Plan tab via switchToPlanTab()). Calling onActivity() here would race that by flipping to the
      // Conversation tab, so SKIP it for ExitPlanMode. Other tools (including AskUserQuestion, whose
      // card lives in the Conversation stream) keep the conversation-tab flip so the user sees it.
      if (e.payload.tool !== "ExitPlanMode") onActivity();
      rerender();
      // Sub-Plan 03 live bridge: forward the interactive-tool request (ExitPlanMode / AskUserQuestion)
      // to the orchestrator so it owns the hold/redraft/approve flow. Only while an orchestration is
      // active (otherwise main.ts's legacy in-process review path handles it).
      if (isOrchestrationActive()) void getOrchestrator().ingestPermission(e.payload);
    }),
  );

  unlisteners.push(
    await listen<AgentError>("agent-error", (e) => {
      const err = e.payload;
      model.appendError(err, synthSeq++);
      // Auth errors drive the onboarding; other fatal errors flip the pill to error.
      if (err.kind === "auth") statusController.markAuthRequired();
      else if (err.fatal) statusController.markFatalError();
      // A fatal error ends the backend session — transition to none so New-plan reopens, Cancel
      // disables, and the pill drops out of building. (markFatalError already set the error face;
      // applySessionState("none") forces building=false, which a fatal/error sub-state survives.)
      if (err.fatal) applySessionState("none");
      rerender();
    }),
  );

  unlisteners.push(
    await listen<AgentExit>("agent-exit", (e) => {
      model.appendExit(e.payload, synthSeq++);
      // The backend session ended — transition to none (idempotent: harmless if an explicit Cancel
      // already moved us to none). applySessionState forces the pill out of building.
      applySessionState("none");
      rerender();
    }),
  );

  unlisteners.push(
    await listen("agent-auth-required", () => {
      statusController.markAuthRequired();
    }),
  );

  // ---- Stop (full-stop: interrupt the turn AND end the session) ----
  // Stop is the today's-Cancel behavior: it interrupts the in-flight turn AND kills the child so the
  // one-session slot is released and a new plan can start (the reported bug was leaving the sidecar
  // alive). Steps:
  //   1. cancel_agent_run — interrupt the in-flight turn.
  //   2. end_agent_session — kill the sidecar child. Do NOT rely on an agent-exit event (the killed
  //      child may not emit one).
  //   3. transition SessionState -> none locally (idempotent), so the controls + pill update now.
  // Gated: a no-op unless a session exists (active OR idle), so it never calls cancel_agent_run with
  // no session (which the backend rejects).
  const stopEl = els.stopBtn ?? els.cancelBtn;
  stopEl?.addEventListener("click", () => {
    if (!isLive(session)) return;
    applySessionState("none");
    // Sub-Plan 03: when a multiplan orchestration owns the seam, route Stop through the orchestrator's
    // cancel() (it does cancelRun + endSession + purge of any held permission + deregister from the
    // active-guard). Calling the raw cancel_agent_run / end_agent_session here would strand
    // activeOrchestrator (isOrchestrationActive() stays true → the next composer open is blocked) and
    // leave a held interactive permission un-purged. Else keep the legacy direct path.
    if (isOrchestrationActive()) {
      void getOrchestrator()
        .cancel()
        .catch((err) => console.error("orchestrator cancel failed", err));
      return;
    }
    void invoke("cancel_agent_run").catch((err) => console.error("cancel_agent_run failed", err));
    void invoke("end_agent_session").catch((err) => console.error("end_agent_session failed", err));
  });

  // ---- Pause (interrupt the turn ONLY — session stays alive) ----
  // Pause interrupts the generating turn WITHOUT ending the session, leaving it idle so the user can
  // Resume. It calls ONLY cancel_agent_run (never end_agent_session — that distinction IS the Pause
  // vs Stop contract). Gated: a no-op unless a turn is actively generating.
  els.pauseBtn?.addEventListener("click", () => {
    if (session !== "active") return;
    // Sub-Plan 03: disabled while an orchestration owns the turns (an out-of-band interrupt corrupts
    // the sequencer). Stop is the only valid teardown during orchestration.
    if (isOrchestrationActive()) return;
    applySessionState("idle");
    rerender(); // drop the working indicator immediately (state is now idle)
    void invoke("cancel_agent_run").catch((err) => console.error("cancel_agent_run failed", err));
  });

  // ---- Resume (push a "Continue." user turn into the idle session) ----
  // Resume pushes a fresh user turn into the live (idle) session and goes active. It calls ONLY
  // send_agent_message (the session is already alive — never start a new one). Gated: a no-op unless
  // the session is idle.
  els.resumeBtn?.addEventListener("click", () => {
    if (session !== "idle") return;
    // Sub-Plan 03: disabled while an orchestration owns the turns (an out-of-band "Continue." injects
    // a turn the sequencer does not expect).
    if (isOrchestrationActive()) return;
    applySessionState("active");
    rerender(); // show the working indicator immediately (state is now active)
    void invoke("send_agent_message", { text: "Continue." }).catch((err) =>
      console.error("send_agent_message failed", err),
    );
  });

  // ---- Free-text composer (human-in-the-loop): send an additional user turn ----
  // Send the textarea contents as a user turn via send_agent_message, then clear the field. Gated: a
  // no-op unless a session is live (active OR idle) and the trimmed text is non-empty. Sending mid-run
  // is allowed — the SDK queues additional user turns. This covers the case where the agent did not use
  // AskUserQuestion (and the subagent case, where AskUserQuestion can't fire).
  const sendMessage = (): void => {
    const field = els.messageInput;
    if (!field) return;
    const text = field.value.trim();
    // Multimodal: collect any attached images. OMIT-WHEN-EMPTY downstream (no `images` key when none).
    const images = attachments?.getImages() ?? [];
    // RELAXED empty-text guard: a send proceeds when text is empty BUT ≥1 image is attached
    // (images-only send). Still a no-op when BOTH are empty (nothing to dispatch).
    if (text.length === 0 && images.length === 0) return;
    // Build the send args once: include `images` ONLY when ≥1 is attached, so a text-only follow-up
    // is byte-identical to today (`{ text }`), preserving exact-match assertions + the cached shape.
    const sendArgs = images.length > 0 ? { text, images } : { text };
    // DISPLAY URLs for the history thumbnail render — captured NOW (before attachments.clear()) since
    // both success branches below clear the chips. Undefined when text-only (omit-when-empty) so a
    // text-only echo stays appendUserMessage(text) exactly.
    const displayImages = images.length > 0 ? imagesToDataUrls(images) : undefined;

    // POST-END RESUME: the session ended (Stop / natural exit → "none"). Re-open the SAME SDK session
    // (resuming the prior session id so the agent keeps the conversation context) and push the typed
    // text as the next user turn. This is the genuinely-conversational continuation: it does NOT go
    // through the orchestrator's start()/genesis (which would reset .plan-tree/ and replay the intent
    // prompt over the resumed transcript). Instead it mirrors the live free-text path — open + send —
    // using the same Rust commands, just with `resumeSessionId` threaded into the session open.
    if (!isLive(session)) {
      // Guard: without a retained cwd there is no session to resume into (no run has started this
      // launch). Leave the field intact; nothing to dispatch.
      if (lastCwd === null) return;
      // Flip UI to active NOW (controls + working indicator), mirroring the composer onStarted path.
      applySessionState("active");
      onActivity();
      rerender();
      const resumeCwd = lastCwd;
      // PERMISSION POLICY — resumed turns run in permissionMode "default" DELIBERATELY, to stay
      // consistent with an ordinary (non-orchestrated) live free-text follow-up turn: the LIVE PATH
      // below pushes send_agent_message into the session WITHOUT asserting any elevated write policy,
      // so a plain follow-up turn is gated only by host PreToolUse policy. By the time this resume
      // branch runs the session is "none" (Stop / natural end tore the orchestrator down), so there is
      // no live orchestrator mode to inherit — we re-open and must pick a mode explicitly. "default"
      // keeps file-writes gated by the host's "prototype permission seam" (PreToolUse hook +
      // settings.json allow rules), NOT the orchestrator's elevated genesis "prototype"/"acceptEdits"
      // policies. A missing session id ⇒ omit resumeSessionId ⇒ a fresh session under the same cwd (the
      // sidecar's expired-transcript fallback also lands here). Open FIRST, then send; on a failed open,
      // revert to "none" and leave the field intact (no orphan bubble).
      void invoke("start_agent_session", {
        cwd: resumeCwd,
        permissionMode: "default",
        ...(lastSessionId !== null ? { resumeSessionId: lastSessionId } : {}),
      })
        .then(() =>
          invoke("send_agent_message", sendArgs).then(() => {
            model.appendUserMessage(text, displayImages);
            field.value = ""; // clear only after the turn is dispatched
            attachments?.clear(); // drop the chips alongside the field, only on a dispatched turn
            rerender();
          }),
        )
        .catch((err) => {
          // The re-open or send failed — no live session exists. The most common cause is a RACE: the
          // previous session is still draining (Stop drains the old child on a background task; a
          // natural end frees the Rust slot asynchronously), so start_agent_session rejects with "a
          // session is already running (one session per launch)". Surface a NON-FATAL, user-visible
          // notice via the SAME mechanism the public surfaceMessage handle uses (model.appendNotice →
          // a `.conv-notice` row), keep the typed text in the field, and drop back to "none" so the
          // user can simply Send again. Kept generic/actionable because other open failures are
          // possible too; the field is NOT cleared (no orphan bubble, nothing to retype).
          console.error("resume start_agent_session/send failed", err);
          model.appendNotice("Previous session is still shutting down — try sending again.", synthSeq++);
          applySessionState("none");
          rerender();
        });
      return;
    }

    // LIVE PATH (active OR idle) — unchanged: push an additional user turn into the running session.
    // CRITICAL ORDERING: dispatch FIRST; echo the bubble + clear the field ONLY after the send
    // resolves. On a thrown/failed dispatch, leave the field intact and add NO bubble — a failed send
    // must never leave an orphan bubble implying the agent received a message it did not.
    void invoke("send_agent_message", sendArgs)
      .then(() => {
        // appendUserMessage stamps the bubble at lastWireSeq + 0.5 (NOT synthSeq) so it sorts before
        // the agent's reply (the next wire frame), not after every frame in the session.
        model.appendUserMessage(text, displayImages);
        field.value = ""; // clear only on success
        attachments?.clear(); // drop the chips alongside the field, only on a successful send
        rerender();
      })
      .catch((err) => console.error("send_agent_message failed", err));
  };

  els.sendBtn?.addEventListener("click", () => sendMessage());
  // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
  els.messageInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Reflect the initial (none) liveness state on all derived controls.
  applySessionState("none");

  let torn = false;
  return {
    // Open the New-plan composer. PREVENTED while a session is live (Fix 4) so the modal can't be open
    // mid-run. Refreshes the live auth status FIRST (Fix 3) so the banner + Start token-guard reflect
    // current backend token state, not the one-shot startup read.
    openComposer: () => {
      if (isLive(session)) return;
      void statusController.refresh().finally(() => composer.open());
    },
    surfaceMessage: (text) => {
      // Render a plain NOTICE row through the same model so it appears in the conversation stream
      // and survives re-derive. It is NOT an error: no "Error:" prefix, no error face, no
      // session-state flip.
      model.appendNotice(text, synthSeq++);
      rerender();
    },
    echoUserMessage: (text) => {
      // Echo the user's verbatim text as a user-attributed bubble. Callers MUST invoke this only on a
      // SUCCESSFUL dispatch (post-await), never before — a failed send must add no bubble. The bubble
      // is placed at lastWireSeq + 0.5 inside appendUserMessage (NOT synthSeq) so it sorts before the
      // agent's reply rather than after every frame in the session.
      model.appendUserMessage(text);
      rerender();
    },
    notifyPermissionResolved: (id) => {
      // Mirror of submitQuestion's appendQuestionAnswered, for the ExitPlanMode resolve paths.
      model.appendPermissionResolved(id, synthSeq++);
      rerender();
    },
    setIdleWaitingHint: (on) => {
      // Idle-waiting override toggle (visual-prototype gate). Idempotent: same value → no rerender.
      if (idleWaitingHint === on) return;
      idleWaitingHint = on;
      rerender();
    },
    loadHistoryForPlan: async (stem) => {
      // (1) Live/orchestration owns the pane → do nothing. The live model always wins; we never let a
      // background history load disturb an in-progress run. (isOrchestrationActive() closes the window
      // where the orchestrator made a Rust session live BEFORE the first agent-stream frame flipped
      // `session`.)
      if (session !== "none" || isOrchestrationActive()) return;
      // (2) Claim a generation. A later loadHistoryForPlan OR any live takeover bumps historyGen,
      // invalidating this load at its post-await freshness check below.
      const gen = ++historyGen;
      // (3) Locate + read the authoring transcript (server-filtered user/assistant lines).
      let res: {
        found: boolean;
        path: string | null;
        cwd: string | null;
        session_id: string | null;
        lines: string[];
      };
      try {
        res = await invoke("read_plan_transcript", { stem });
      } catch (err) {
        console.error("read_plan_transcript failed", err);
        return;
      }
      // (4) Post-await freshness: drop if a newer load superseded us OR a live run started during the
      // await (either flips historyGen / session). Never clobber a now-live pane.
      if (gen !== historyGen || session !== "none" || isOrchestrationActive()) return;
      // (5) No resolvable transcript → explicit empty state (distinct from a silently blank pane).
      if (!res.found) {
        paneSource = { kind: "empty", stem, reason: "no-transcript" };
        rerender();
        return;
      }
      // (6) Replay the transcript into a FRESH model. If it yields no renderable nodes, show the
      // no-content empty state; otherwise the history model drives the pane.
      const replayModel = new ConversationModel();
      applyTranscriptToModel(
        replayModel,
        parseTranscript(res.lines, { cwd: res.cwd ?? null, sessionId: res.session_id ?? null }),
      );
      if (replayModel.derive().nodes.length === 0) {
        paneSource = { kind: "empty", stem, reason: "no-content" };
      } else {
        paneSource = { kind: "history", model: replayModel, gen };
      }
      rerender();
    },
    refreshMinimap: () => {
      // Explicit repaint for the display:none → visible transition (a reader-tab switch to the
      // Conversation pane). Nothing mutated the stream subtree, so rerender()/observers did not fire;
      // this reads the now-laid-out child offsets and tiles the gutter. No-op stub when no minimap el.
      minimap.rebuild();
    },
    teardown: async () => {
      if (torn) return;
      torn = true;
      // Detach the minimap's scroll/resize/mutation observers (no-op when the controller is the null
      // stub). Done first so no observer fires mid-teardown.
      minimap.destroy();
      for (const un of unlisteners) {
        try {
          un();
        } catch (err) {
          console.error("unlisten failed", err);
        }
      }
      try {
        await invoke("end_agent_session");
      } catch (err) {
        console.error("end_agent_session failed", err);
      }
    },
  };
}
