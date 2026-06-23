// Conversation domain (Sub-Plan 02) — DOM renderer.
//
// Renders a RenderTree (stream.ts) into a container. ALL element classes are namespaced
// `.conv-*` (styled tokens-only in styles.css). Security rules (explicit, not assumed):
//   - Assistant text is model-influenceable. We render markdown via renderMarkdown() (which is
//     html:false but does NOT sanitize) and pass the result through a NEW HTML-profile
//     DOMPurify.sanitize() BEFORE assigning innerHTML. `renderMarkdown` and `attachLinkHandler`
//     are the only imports from the render/ domain (both public exports); we never reach into
//     src/render/* internals.
//   - Links in a bubble (DOMPurify keeps `href`; markdown-it linkify makes bare URLs live) must
//     NEVER navigate the single WebView. The SHARED `attachLinkHandler` policy — external → openUrl,
//     `#frag` → in-pane scroll, everything else → inert no-op — is attached ONCE to the persistent
//     stream container in renderTree (INV-5). The reading and conversation panes stay disjoint
//     domains; we reuse the one link policy rather than couple them via a shared renderer.
//   - Tool input / result / Bash output are code/text — rendered via textContent (never raw
//     innerHTML), so no markup in them can ever execute.
//
// This module is import-only-public and disjoint from src/render/*.

import DOMPurify from "dompurify";
import { renderMarkdown } from "../render/markdown";
import { attachLinkHandler } from "../render/links";
import type {
  RenderTree,
  TopNode,
  RenderNode,
  ToolNode,
  ToolStatus,
  QuestionRequestNode,
  QuotaBannerNode,
} from "./stream";
import type { AskUserQuestionAnswers } from "./types";

// Optional handlers the renderer wires into interactive affordances. `onSubmitQuestion` is invoked
// when the user submits a question card (id = the request's toolUseID, answers keyed by question
// text). The controller maps it to resolve_tool_permission + appendQuestionAnswered. Omitted in
// pure-render tests that only inspect DOM structure.
export interface RenderHandlers {
  onSubmitQuestion?: (id: string, answers: AskUserQuestionAnswers) => void;
  // Invoked when the user clicks "Cancel session" in an EXHAUSTED quota banner (the once-per-session
  // auto-resume budget is spent — no auto-resume will happen, so the only affordance is to end the
  // session). The controller maps it to the SAME full-stop path the Stop button uses (orchestrator
  // cancel() when an orchestration owns the seam, else cancel_agent_run + end_agent_session). Omitted
  // in pure-render tests that only inspect DOM structure.
  onCancelSession?: () => void;
}

// HTML-profile sanitize config for assistant-text bubbles. Distinct from mermaid.ts's SVG
// profile (that one is wrong for HTML). Default DOMPurify HTML profile strips <script> and
// on* handlers; we keep it explicit and minimal — no SVG/MathML, no data attributes needed.
const TEXT_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
};

// Sanitize markdown-rendered HTML for safe innerHTML injection. EXPORTED so the XSS guard is
// directly unit-testable (feed a payload, assert it is neutralized). The default profile (no
// RETURN_TRUSTED_TYPE) returns a string — mirrors render/mermaid.ts's sanitizeSvg.
export function sanitizeAssistantHtml(markdownHtml: string): string {
  return DOMPurify.sanitize(markdownHtml, TEXT_SANITIZE_CONFIG);
}

// Single-letter badge + accessible label for a tool, by observed name. Best-effort only —
// the "Skill" inference is from the OBSERVED tool name (no frozen skill discriminator). Never
// asserted against a synthetic payload in tests.
function toolBadge(tool: string): string {
  // First letter, uppercased; a couple of well-known tools get a nicer glyph.
  if (tool === "Bash") return "$";
  return (tool.charAt(0) || "?").toUpperCase();
}

// Whether an observed tool name is (best-effort) a Skill invocation. Inferred from the name
// only — NOT a committed wire shape. Used purely for the optional chip.
function isSkillTool(tool: string): boolean {
  return tool === "Skill";
}

// Whether an observed tool name is a subagent launch (Task is the SDK's name; "Agent" is the
// historical alias). For these we render the `description` legibly instead of raw JSON.
function isAgentTool(tool: string): boolean {
  return tool === "Task" || tool === "Agent";
}

// Legible one-line label for a Task/Agent tool_use input: the human `description`, suffixed with
// the `subagent_type` when present (e.g. "Design Minecraft clone (general-purpose)"). Returns null
// when the input has no usable description so the caller can fall back to the generic summary — we
// never want to silently swallow an unexpected Task shape into an empty row.
function agentSummary(input: unknown): string | null {
  if (input == null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  if (!description) return null;
  const subagentType = typeof obj.subagent_type === "string" ? obj.subagent_type.trim() : "";
  return subagentType ? `${description} (${subagentType})` : description;
}

// Render a value to a compact one-line summary for the collapsed tool row (textContent).
function summarize(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Prefer the most common single-arg tools' primary field.
    for (const key of ["command", "file_path", "path", "pattern", "query", "url"]) {
      const v = obj[key];
      if (typeof v === "string") return v;
    }
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }
  return String(input);
}

// Stringify a value for the EXPANDED block (full content, textContent).
function fullText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function statusLabel(status: ToolStatus): string {
  return status === "running" ? "running…" : status === "error" ? "error" : "done";
}

// Build a collapsible tool-call row. The row header is clickable: it toggles `.expanded` on the
// wrapper, revealing the args/result block. Input/result are textContent only.
function renderToolRow(node: ToolNode): HTMLElement {
  const row = document.createElement("div");
  row.className = "conv-tool";
  row.dataset.status = node.status;
  if (isSkillTool(node.tool)) row.classList.add("conv-tool-skill");

  const header = document.createElement("button");
  header.type = "button";
  header.className = "conv-tool-head";

  const badge = document.createElement("span");
  badge.className = "conv-tool-badge";
  badge.textContent = toolBadge(node.tool);

  const name = document.createElement("span");
  name.className = "conv-tool-name";
  name.textContent = node.tool;

  header.appendChild(badge);
  header.appendChild(name);

  // Best-effort Skill chip (observed-name only — never a frozen shape).
  if (isSkillTool(node.tool)) {
    const chip = document.createElement("span");
    chip.className = "conv-chip conv-chip-skill";
    chip.textContent = "skill";
    header.appendChild(chip);
  }

  const summary = document.createElement("span");
  summary.className = "conv-tool-summary";
  // Task/Agent tool_use carries {description, subagent_type, prompt, …}; show the human description
  // (NOT the raw JSON blob). Fall back to the generic summary for every other tool — and for a Task
  // with no usable description (defensive: never render an empty row).
  const agentLabel = isAgentTool(node.tool) ? agentSummary(node.input) : null;
  summary.textContent = agentLabel ?? summarize(node.input); // textContent — never innerHTML
  header.appendChild(summary);

  const status = document.createElement("span");
  status.className = "conv-tool-status";
  // Running rows get a live pulsing dot alongside the label; done/error rows do not. The label
  // lives in a child span (NOT status.textContent) so the appended pulse child is not clobbered.
  if (node.status === "running") {
    const pulse = document.createElement("span");
    pulse.className = "conv-tool-pulse";
    pulse.setAttribute("aria-hidden", "true");
    status.appendChild(pulse);
  }
  const statusText = document.createElement("span");
  statusText.className = "conv-tool-status-text";
  statusText.textContent = statusLabel(node.status);
  status.appendChild(statusText);
  header.appendChild(status);

  const chevron = document.createElement("span");
  chevron.className = "conv-tool-chevron";
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  header.appendChild(chevron);

  // Expanded body: full input (and result, once it lands). textContent only.
  const body = document.createElement("div");
  body.className = "conv-tool-body";

  const inputPre = document.createElement("pre");
  inputPre.className = "conv-tool-input";
  inputPre.textContent = fullText(node.input);
  body.appendChild(inputPre);

  if (node.result !== null) {
    const resultPre = document.createElement("pre");
    resultPre.className = "conv-tool-result";
    if (node.isError) resultPre.classList.add("conv-tool-result-error");
    resultPre.textContent = fullText(node.result);
    body.appendChild(resultPre);
  }

  header.addEventListener("click", () => {
    row.classList.toggle("expanded");
  });

  row.appendChild(header);
  row.appendChild(body);
  return row;
}

// Render an AskUserQuestion card. While `node.answers` is null this draws the interactive form:
// one section per question (header + question text + radio/checkbox options) and a Submit button
// disabled until EVERY question has at least one selection. On submit it builds the answers record
// (question text → chosen label | [labels]) and hands it to `onSubmit`. Once answered it instead
// renders the chosen answers read-only (no form), so there is a permanent record in the stream.
//
// All text is set via textContent (model-influenceable). Inputs use `name` per question so radios
// group correctly; ids are NOT used (multiple cards can coexist — query within the card element).
function renderQuestionCard(
  node: QuestionRequestNode,
  onSubmit?: (id: string, answers: AskUserQuestionAnswers) => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "conv-question";
  card.dataset.requestId = node.id;

  // ---- Answered state: render the chosen answers read-only (no form). ----
  if (node.answers !== null) {
    card.classList.add("conv-question-answered");
    for (const q of node.questions) {
      const section = document.createElement("div");
      section.className = "conv-question-section";

      const header = document.createElement("div");
      header.className = "conv-question-header";
      header.textContent = q.header;
      section.appendChild(header);

      const qtext = document.createElement("div");
      qtext.className = "conv-question-text";
      qtext.textContent = q.question;
      section.appendChild(qtext);

      const chosen = node.answers[q.question];
      const labels = Array.isArray(chosen) ? chosen : chosen != null ? [chosen] : [];
      const answer = document.createElement("div");
      answer.className = "conv-question-answer";
      answer.textContent = labels.join(", ");
      section.appendChild(answer);

      card.appendChild(section);
    }
    return card;
  }

  // ---- Pending state: the interactive form. ----
  const sections: HTMLElement[] = [];

  for (let qi = 0; qi < node.questions.length; qi++) {
    const q = node.questions[qi];
    const section = document.createElement("div");
    section.className = "conv-question-section";
    section.dataset.qIndex = String(qi);
    section.dataset.multiSelect = q.multiSelect ? "true" : "false";
    section.dataset.question = q.question;

    const header = document.createElement("div");
    header.className = "conv-question-header";
    header.textContent = q.header;
    section.appendChild(header);

    const qtext = document.createElement("div");
    qtext.className = "conv-question-text";
    qtext.textContent = q.question;
    section.appendChild(qtext);

    const inputType = q.multiSelect ? "checkbox" : "radio";
    const groupName = `conv-q-${node.id}-${qi}`;

    for (const opt of q.options) {
      const optLabel = document.createElement("label");
      optLabel.className = "conv-question-option";

      const input = document.createElement("input");
      input.type = inputType;
      input.name = groupName;
      input.value = opt.label;
      input.className = "conv-question-input";
      optLabel.appendChild(input);

      const labelText = document.createElement("span");
      labelText.className = "conv-question-option-label";
      labelText.textContent = opt.label;
      optLabel.appendChild(labelText);

      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "conv-question-option-desc";
        desc.textContent = opt.description;
        optLabel.appendChild(desc);
      }

      section.appendChild(optLabel);
    }

    // ---- Synthetic "Other…" row (free-text affordance, every section). ----
    // The toggle shares the SAME group name as the predefined options, so for single-select
    // (radio) selecting a predefined option auto-clears "Other" and vice-versa. The real value
    // is carried by the sibling text input (the toggle's value="" is filtered out of answers by
    // its data-other="toggle" marker, so it can never leak). Built with createElement only.
    const otherLabel = document.createElement("label");
    otherLabel.className = "conv-question-option conv-question-other-option";

    const otherToggle = document.createElement("input");
    otherToggle.type = inputType;
    otherToggle.name = groupName;
    otherToggle.value = "";
    otherToggle.className = "conv-question-input conv-question-other-toggle";
    otherToggle.dataset.other = "toggle";
    otherLabel.appendChild(otherToggle);

    const otherLabelText = document.createElement("span");
    otherLabelText.className = "conv-question-option-label";
    otherLabelText.textContent = "Other…";
    otherLabel.appendChild(otherLabelText);

    section.appendChild(otherLabel);

    // The free-text input is a SIBLING of the option label (not wrapped by it), so it needs an
    // explicit accessible name (a placeholder is not a reliable one). Starts hidden + disabled so
    // a stale value can never participate in the gate or the answer until "Other" is selected.
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "conv-question-other-input";
    otherInput.dataset.other = "text";
    otherInput.placeholder = "Type your answer…";
    otherInput.setAttribute("aria-label", "Other answer");
    otherInput.hidden = true;
    otherInput.disabled = true;
    section.appendChild(otherInput);

    sections.push(section);
    card.appendChild(section);
  }

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "conv-question-submit";
  submit.textContent = "Submit";
  // Submit is enabled only when EVERY question is answered (see sectionAnswered).
  submit.disabled = true;

  // A section is "answered" under the STRICT rule shared by the gate AND the submit guard (so they
  // can never disagree): if the "Other" toggle is checked, the section is answered ONLY when the
  // text input has non-whitespace content; otherwise it is answered when any PREDEFINED input
  // (a :checked input whose data-other !== "toggle") is selected.
  const sectionAnswered = (s: HTMLElement): boolean => {
    const otherToggle = s.querySelector<HTMLInputElement>('[data-other="toggle"]');
    const otherInput = s.querySelector<HTMLInputElement>('[data-other="text"]');
    if (otherToggle?.checked) {
      return (otherInput?.value.trim().length ?? 0) > 0;
    }
    return Array.from(s.querySelectorAll<HTMLInputElement>("input:checked")).some(
      (i) => i.dataset.other !== "toggle",
    );
  };

  // Recompute the disabled state. Each pass also reflects every toggle's checked state onto its
  // text input (un-hide/enable when on, hide/disable when off) — this also collapses the box when
  // a single-select predefined radio steals the selection from "Other".
  const refresh = (): void => {
    for (const s of sections) {
      const otherToggle = s.querySelector<HTMLInputElement>('[data-other="toggle"]');
      const otherInput = s.querySelector<HTMLInputElement>('[data-other="text"]');
      if (otherToggle && otherInput) {
        const otherOn = otherToggle.checked;
        otherInput.hidden = !otherOn;
        otherInput.disabled = !otherOn;
      }
    }
    submit.disabled = !sections.every(sectionAnswered);
  };

  // Live typing in the free-text box must re-evaluate the gate per keystroke — `change` alone does
  // not fire mid-edit, so we bind `input` too. Both are bound to refresh (NOT focus).
  card.addEventListener("change", refresh);
  card.addEventListener("input", refresh);

  // Focus-on-reveal: a SEPARATE change-only listener (registered AFTER refresh so the input is
  // already un-hidden/enabled). Never focus from inside refresh() — refresh is also bound to
  // `input`, so focusing there would re-assert focus on every keystroke and break text selection.
  card.addEventListener("change", (e) => {
    const target = e.target;
    if (
      target instanceof HTMLInputElement &&
      target.dataset.other === "toggle" &&
      target.checked
    ) {
      const sibling = target
        .closest(".conv-question-section")
        ?.querySelector<HTMLInputElement>('[data-other="text"]');
      sibling?.focus();
    }
  });

  submit.addEventListener("click", () => {
    // Build answers: question text → label (single, replace) | [labels] (multi, additive).
    const answers: AskUserQuestionAnswers = {};
    for (const s of sections) {
      // Per-section guard mirrors the gate exactly (belt-and-suspenders — should be disabled).
      if (!sectionAnswered(s)) return;
      const question = s.dataset.question ?? "";
      const multi = s.dataset.multiSelect === "true";
      // Predefined = checked inputs EXCLUDING the synthetic toggle, in DOM order.
      const predefined = Array.from(
        s.querySelectorAll<HTMLInputElement>("input:checked"),
      )
        .filter((i) => i.dataset.other !== "toggle")
        .map((i) => i.value);
      const otherToggle = s.querySelector<HTMLInputElement>('[data-other="toggle"]');
      const otherInput = s.querySelector<HTMLInputElement>('[data-other="text"]');
      const otherOn = !!otherToggle?.checked;
      const otherText = otherInput?.value.trim() ?? "";
      if (multi) {
        // Additive: predefined first, Other text appended last (toggle "" never leaks).
        answers[question] = otherOn && otherText ? [...predefined, otherText] : predefined;
      } else {
        // Replace: Other text wins when selected, else the single predefined label.
        answers[question] = otherOn ? otherText : predefined[0];
      }
    }
    onSubmit?.(node.id, answers);
  });

  card.appendChild(submit);
  return card;
}

// Render a text bubble. `role` distinguishes the assistant bubble (default) from a user-attributed
// bubble (verbatim echo of what the user submitted, `.conv-text-user`) and a dim SYSTEM bubble (a
// harness-injected plumbing turn, `.conv-text-system`).
//
// SECURITY / FORMAT divergence by role:
//   - assistant / user → markdown-rendered, then DOMPurify-SANITIZED before innerHTML. Both share the
//     SAME sanitize path (user text is no more trusted than assistant text). Removing the sanitize
//     call lets an XSS payload through (the falsification target).
//   - system → raw XML/plaintext (subagent results, command output) — NOT markdown. Rendered as
//     textContent so no markup can ever be parsed or executed (no innerHTML, no DOMPurify needed).
function renderTextBubble(
  text: string,
  role: "assistant" | "user" | "system" = "assistant",
  // Multimodal (user role only): DISPLAY data URLs rendered as a thumbnail row ABOVE the text. Each
  // becomes one `<img class="conv-user-image">` inside a `.conv-user-images` container. Omitted/empty →
  // no thumbnail row (a text-only user bubble is unchanged). Ignored for assistant/system roles.
  images?: string[],
): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = "conv-text";
  if (role === "user") bubble.classList.add("conv-text-user");
  if (role === "system") {
    // Dim, de-emphasized, left-aligned. textContent ONLY — these are raw XML/plaintext plumbing
    // records, never markdown; rendering as text guarantees no HTML injection.
    bubble.classList.add("conv-text-system");
    bubble.textContent = text;
    return bubble;
  }
  // Multimodal (user bubbles only): when images are attached, render a thumbnail row ABOVE the text —
  // one <img> per display data URL, in attach order — then the text in a child <div>. Built with DOM
  // APIs (no bubble.innerHTML, which would wipe the row). When NO images, the text path is byte-
  // identical to today (bubble.innerHTML directly), preserving existing assistant/user assertions.
  if (role === "user" && images && images.length) {
    const row = document.createElement("div");
    row.className = "conv-user-images";
    for (const url of images) {
      const img = document.createElement("img");
      img.className = "conv-user-image";
      img.src = url;
      row.appendChild(img);
    }
    bubble.appendChild(row);
    const body = document.createElement("div");
    body.className = "conv-user-text";
    // SANITIZE: same DOMPurify path as the no-image branch (user text is no more trusted than
    // assistant text). Removing it lets an XSS payload through (the falsification target).
    body.innerHTML = sanitizeAssistantHtml(renderMarkdown(text));
    bubble.appendChild(body);
    return bubble;
  }
  // SANITIZE: renderMarkdown does NOT sanitize; the text is model/user-influenceable, so the
  // HTML MUST pass through DOMPurify before innerHTML. Removing this call lets an XSS payload
  // through (the falsification target).
  bubble.innerHTML = sanitizeAssistantHtml(renderMarkdown(text));
  return bubble;
}

// ---- Quota-banner countdown: a SINGLE live wall-clock interval (leak-guarded) ----------------
//
// The countdown is driven by ONE module-level setInterval that, every tick, recomputes the TRUE
// remaining time as `resetAt - Date.now()` (wall-clock — NOT a stored decrementing counter, which
// would freeze/drift while the WebView is occluded/suspended and resume from a stale value). Each
// renderTree() call rebuilds the DOM (replaceChildren), so any prior interval/listener would point at
// detached nodes — we therefore CLEAR the prior interval + visibilitychange listener at the top of
// every render and re-arm at most one for the waiting banner present in the new tree. This guarantees
// EXACTLY ONE live interval ever exists, so intervals never leak across rebuilds/teardowns.
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownVisHandler: (() => void) | null = null;

// Clear the single live countdown interval + visibilitychange listener (idempotent). Called at the top
// of every renderTree (before re-arming) and on teardown, so no stale interval survives a rebuild.
function teardownCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (countdownVisHandler !== null) {
    document.removeEventListener("visibilitychange", countdownVisHandler);
    countdownVisHandler = null;
  }
}

// EXPORTED teardown for the controller (index.ts) to call on pane teardown — clears the lone interval
// so it never ticks against a torn-down pane. A bare alias of teardownCountdown.
export function teardownQuotaCountdown(): void {
  teardownCountdown();
}

// Format a millisecond remaining-duration as HH:MM:SS, clamped at 0 (00:00:00). Wall-clock driven —
// the caller passes `resetAt - Date.now()`, so a negative (past-reset) value clamps to zero.
export function formatCountdown(remainingMs: number): string {
  const secs = Math.max(0, Math.floor(remainingMs / 1000));
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// Format an epoch-ms reset time as a human clock time (e.g. "6:00 PM"). Locale-aware, hour:minute only.
// Returns "" for the degraded sentinel (resetAt <= 0, an undeterminable reset) so the banner falls back
// to its "…when your quota refreshes" copy instead of printing a bogus epoch-1970 clock.
function formatResetClock(resetAt: number): string {
  if (!(Number.isFinite(resetAt) && resetAt > 0)) return "";
  try {
    return new Date(resetAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// Render the quota banner (waiting OR exhausted). The WAITING variant arms the lone wall-clock
// interval (driving the `.qb-countdown` element) + a visibilitychange recompute; the EXHAUSTED variant
// arms NO interval (no countdown — the budget is spent) and wires the Cancel-session button.
function renderQuotaBanner(node: QuotaBannerNode, handlers?: RenderHandlers): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "conv-quota-banner";
  banner.dataset.state = node.state;

  const head = document.createElement("div");
  head.className = "conv-qb-head";
  const dot = document.createElement("span");
  dot.className = "conv-qb-dot";
  dot.setAttribute("aria-hidden", "true");
  head.appendChild(dot);
  const headText = document.createElement("span");
  headText.className = "conv-qb-head-text";
  head.appendChild(headText);
  banner.appendChild(head);

  const sub = document.createElement("div");
  sub.className = "conv-qb-sub";
  banner.appendChild(sub);

  if (node.state === "waiting") {
    banner.classList.add("conv-quota-banner-waiting");
    headText.textContent = "Usage limit reached — waiting for quota to refresh";
    sub.textContent =
      "The session paused mid-turn. There's nothing to do — resuming before the quota resets isn't possible. The app will pick the turn back up automatically the moment your quota refreshes.";

    // The live wall-clock countdown element. Seeded with the current true remaining; the lone interval
    // (armed below) keeps it current. NO Resume button — resuming before refresh is impossible.
    const countdown = document.createElement("div");
    countdown.className = "conv-qb-countdown";
    countdown.textContent = formatCountdown(node.resetAt - Date.now());
    banner.appendChild(countdown);

    const refreshAt = document.createElement("div");
    refreshAt.className = "conv-qb-refresh-at";
    const clock = formatResetClock(node.resetAt);
    refreshAt.textContent = clock ? `Resets at ${clock}` : "Resets when your quota refreshes";
    banner.appendChild(refreshAt);

    // The auto-resume note (the "will auto-resume" reassurance with a spinner).
    const autoNote = document.createElement("div");
    autoNote.className = "conv-qb-auto-note";
    const spin = document.createElement("span");
    spin.className = "conv-qb-spin";
    spin.setAttribute("aria-hidden", "true");
    autoNote.appendChild(spin);
    const autoText = document.createElement("span");
    autoText.textContent = "Will auto-resume the in-flight turn when quota refreshes";
    autoNote.appendChild(autoText);
    banner.appendChild(autoNote);

    // The "auto-resume armed · N attempt(s) left" pill.
    const pill = document.createElement("div");
    pill.className = "conv-qb-pill";
    const n = node.remaining;
    pill.textContent = `⟳ Auto-resume armed · ${n} attempt${n === 1 ? "" : "s"} left this session`;
    banner.appendChild(pill);

    // ---- Arm the SINGLE wall-clock countdown interval + visibilitychange recompute. ----
    // (renderTree already cleared any prior interval before calling us, so this is the only live one.)
    const tick = (): void => {
      // Recompute TRUE remaining each tick from wall-clock — never decrement a stored counter (so an
      // occluded/suspended WebView shows the correct value the instant it wakes).
      countdown.textContent = formatCountdown(node.resetAt - Date.now());
    };
    countdownTimer = setInterval(tick, 1000);
    countdownVisHandler = () => {
      // On un-occlusion the displayed value may be stale (the interval was throttled/suspended) —
      // recompute immediately so it corrects without waiting for the next tick.
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", countdownVisHandler);
  } else {
    // EXHAUSTED: the once-per-session auto-resume budget is spent — no countdown, no auto-resume.
    banner.classList.add("conv-quota-banner-exhausted");
    headText.textContent = "Usage limit reached again — auto-resume already used";
    sub.textContent =
      "This session already auto-resumed once, so it won't wait or resume again. Cancel this session and start a new plan when your quota refreshes.";

    const refreshAt = document.createElement("div");
    refreshAt.className = "conv-qb-refresh-at";
    const clock = formatResetClock(node.resetAt);
    refreshAt.textContent = clock ? `Next reset at ${clock}` : "Next reset when your quota refreshes";
    banner.appendChild(refreshAt);

    // Cancel-session affordance ONLY (no Resume — resuming is impossible; no countdown — no wait).
    const actions = document.createElement("div");
    actions.className = "conv-qb-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "conv-qb-cancel";
    cancel.textContent = "Cancel session";
    cancel.addEventListener("click", () => handlers?.onCancelSession?.());
    actions.appendChild(cancel);
    banner.appendChild(actions);
  }

  return banner;
}

// Render a single top-level OR nested node (everything except a subagent group, which is
// top-level only and handled in renderTree).
function renderNode(node: RenderNode, handlers?: RenderHandlers): HTMLElement {
  const elem = renderNodeInner(node, handlers);
  // Stamp the node's seq as a harmless data attribute so the mock-animate demo can target a SPECIFIC
  // bubble for pulse/cursor overlays (`[data-seq="N"]`). No effect on layout or app behavior.
  elem.dataset.seq = String(node.seq);
  return elem;
}

function renderNodeInner(node: RenderNode, handlers?: RenderHandlers): HTMLElement {
  switch (node.type) {
    case "text":
      return renderTextBubble(node.text);
    case "user":
      return renderTextBubble(node.text, "user", node.images);
    case "system":
      return renderTextBubble(node.text, "system");
    case "tool":
      return renderToolRow(node);
    case "question_request":
      return renderQuestionCard(node, handlers?.onSubmitQuestion);
    case "mode": {
      // Plan -> Build (or any) mode chip.
      const chip = document.createElement("div");
      chip.className = "conv-mode";
      // acceptEdits is the approved/Build mode — give it the distinct build chip.
      if (node.mode === "acceptEdits") {
        chip.classList.add("conv-mode-build");
        chip.textContent = `Build mode — ${node.mode}`;
      } else {
        chip.textContent = `Mode — ${node.mode}`;
      }
      return chip;
    }
    case "permission_request": {
      // Sub-Plan 03: an ExitPlanMode request is held by main.ts and surfaced on the Plan tab (it owns
      // the tab + the review affordances). This stream marker is a neutral pointer to that, not a hang.
      const notice = document.createElement("div");
      notice.className = "conv-perm-request";
      // Only ExitPlanMode is ever emitted as a tool-permission-requested event now: the sidecar
      // auto-allows every OTHER tool synchronously in-process and never round-trips them, so the
      // non-ExitPlanMode "permitted" row that used to flood the stream is no longer produced. The
      // else branch is retained as a defensive (muted) fallback for an older sidecar only.
      if (node.tool === "ExitPlanMode") {
        notice.textContent = "Plan ready — reviewing in the Plan tab";
      } else {
        notice.classList.add("conv-perm-muted");
        notice.textContent = `${node.tool} permitted`;
      }
      return notice;
    }
    case "permission_denied": {
      const row = document.createElement("div");
      row.className = "conv-perm-denied";
      row.textContent = `Permission denied: ${node.tool} (${node.reasonType})${node.message ? " — " + node.message : ""}`;
      return row;
    }
    case "result": {
      // Three-way, keyed EXCLUSIVELY on deliberateInterrupt for the muted branch (never subtype —
      // error_during_execution also covers genuine mid-run failures and would mislabel them).
      const row = document.createElement("div");
      row.className = "conv-result";
      if (node.deliberateInterrupt) {
        // A deliberate orchestrator interrupt (the gate boundary) — calm and truthful, NOT an error.
        row.classList.add("conv-result-interrupted");
        row.textContent = "Turn interrupted — continuing";
      } else if (node.isError) {
        // Genuine failure: loud, with a readable fallback when the SDK provided no result text
        // (the sidecar forwards null — never interpolate it as the string "null").
        row.classList.add("conv-result-error");
        row.textContent = `Run failed${node.result ? ": " + node.result : " (no details)"}`;
      } else {
        row.textContent = `Run complete`;
      }
      return row;
    }
    case "error": {
      const row = document.createElement("div");
      row.className = "conv-error";
      if (node.fatal) row.classList.add("conv-error-fatal");
      row.textContent = `Error (${node.errorKind}): ${node.message}`;
      return row;
    }
    case "exit": {
      const row = document.createElement("div");
      row.className = "conv-exit";
      row.textContent = `Session ended (exit ${node.code})`;
      return row;
    }
    case "notice": {
      // A plain notice (an informational message). Bare message — NO "Error:" prefix, no error face.
      const row = document.createElement("div");
      row.className = "conv-notice";
      row.textContent = node.message;
      return row;
    }
    case "quota-banner":
      return renderQuotaBanner(node, handlers);
    default: {
      const _x: never = node;
      return _x;
    }
  }
}

// Render the full tree into `container` (replacing prior content). EXPORTED — the renderer entry
// point used by index.ts. A SINGLE in-place working indicator is appended last (never per-event)
// when `tree.working` is set, so it always sits at the bottom of the stream while a turn generates
// and disappears when the turn completes / the session exits / it is gated off by the controller.
export function renderTree(
  container: HTMLElement,
  tree: RenderTree,
  handlers?: RenderHandlers,
): void {
  container.replaceChildren();
  // Leak guard: tear down any prior countdown interval + visibilitychange listener BEFORE rebuilding.
  // replaceChildren() above detached the old banner node, so its interval would tick against a dead
  // element; renderQuotaBanner re-arms exactly one for a waiting banner present in THIS tree. This
  // keeps the invariant "at most one live countdown interval" across every rebuild.
  teardownCountdown();
  // Ids of subagent groups present in this tree — used to SUPPRESS the redundant standalone Task/Agent
  // tool_use row (the group header is now the primary display of that subagent's identity + task, so
  // showing both the "Agent {…json…} running" row AND the labeled group is duplicative). The group's
  // agentId equals the Task tool_use's id, so we match the suppressed row by tool node id.
  const subagentGroupIds = new Set<string>();
  for (const node of tree.nodes) {
    if (node.type === "subagent") subagentGroupIds.add(node.agentId);
  }

  for (const node of tree.nodes) {
    if (node.type === "subagent") {
      // Accent-bordered nested subagent group, keyed by agent_id. When `subagent_started` metadata is
      // present, a labeled header identifies the subagent + its task; otherwise it falls back to the
      // anonymous box (older sidecar with no metadata).
      const group = document.createElement("div");
      group.className = "conv-subagent";
      group.dataset.agentId = node.agentId;
      // Stamp the group's seq (mirrors renderNode) for mock-animate pulse/cursor targeting.
      group.dataset.seq = String(node.seq);

      if (node.subagentType !== null || node.description !== null) {
        const header = document.createElement("div");
        header.className = "conv-subagent-header";

        const title = document.createElement("span");
        title.className = "conv-subagent-title";
        // textContent only — subagent_type/description are model-influenceable.
        title.textContent = node.subagentType
          ? `Subagent · ${node.subagentType}`
          : "Subagent";
        header.appendChild(title);

        if (node.description) {
          const desc = document.createElement("span");
          desc.className = "conv-subagent-desc";
          desc.textContent = node.description; // textContent — never innerHTML
          header.appendChild(desc);
        }

        if (node.prompt) {
          const prompt = document.createElement("div");
          prompt.className = "conv-subagent-prompt";
          prompt.textContent = node.prompt; // textContent — never innerHTML
          header.appendChild(prompt);
        }

        group.appendChild(header);
      }

      for (const child of node.children) {
        // Backstop for whitespace-only text nodes from older stored state (derive() now drops
        // them, but persisted trees may still carry them) — never draw an empty bubble.
        if (child.type === "text" && child.text.trim() === "") continue;
        group.appendChild(renderNode(child, handlers));
      }
      container.appendChild(group);
    } else {
      // Backstop for whitespace-only text nodes from older stored state (derive() now drops
      // them, but persisted trees may still carry them) — never draw an empty bubble.
      if (node.type === "text" && node.text.trim() === "") continue;
      // Suppress the standalone Task/Agent tool_use row when a subagent group exists for its id — the
      // group header already shows that subagent's identity + task.
      if (
        node.type === "tool" &&
        isAgentTool(node.tool) &&
        subagentGroupIds.has(node.id)
      ) {
        continue;
      }
      container.appendChild(renderNode(node as TopNode as RenderNode, handlers));
    }
  }
  if (tree.working) {
    const working = document.createElement("div");
    working.className = "conv-working";
    working.setAttribute("role", "status");
    working.setAttribute("aria-live", "polite");
    const dot = document.createElement("span");
    dot.className = "conv-working-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "conv-working-label";
    label.textContent = tree.working.label; // textContent — label only, never markup
    working.appendChild(dot);
    working.appendChild(label);
    container.appendChild(working);
  }

  // INV-5 — govern this pane's links with the ONE shared policy. The container is the persistent
  // #conversation-stream element (stable across the per-frame replaceChildren() above), and the
  // listener is DELEGATED on it, so attaching here every frame is safe: attachLinkHandler is
  // idempotent (WeakSet-keyed on the container), so repeat calls are a no-op — a single delegated
  // listener survives every rebuild. Without this, a live bubble <a href> would top-level-navigate
  // and brick the single WebView.
  attachLinkHandler(container);
}
