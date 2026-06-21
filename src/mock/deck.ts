// Mock-mode control deck — Phase 4, the payoff.
//
// A floating, collapsible control panel injected by vite.mock.config.ts (a module script AFTER
// main.ts). It offers:
//   • PRESETS — one-click jumps to every distinct visual state (each conversation scene + every
//     non-conversation surface), each calling an IDEMPOTENT window.__mock.* jumper (which resets the
//     app first, so presets are order-independent).
//   • KNOBS — live toggles/selects/number/text inputs (knobs.ts) grouped by surface; each calls
//     knob.apply(value) to re-drive ONLY the affected surface through the real production seams.
//
// STYLE ISOLATION: the deck owns a SINGLE namespaced stylesheet (every rule prefixed `mockdeck-`,
// injected into a <style id="mock-deck-style"> the deck creates). It uses NONE of the app's class
// names, sits at the max z-index, and is position:fixed so it never participates in the app's layout.
// All deck DOM ids/classes are `mock-deck` / `mockdeck-*` — disjoint from the production DOM contract.
//
// BOOT: the deck installs the fake orchestrator + window.__mock IMMEDIATELY (before DOM ready) so a
// scene can be staged as soon as this module evaluates; it mounts the panel on DOM ready; and once the
// app is ready it (a) replays any pending conversation jump carried in the URL (the clean-model reload
// seam — see api.ts), or (b) applies a sensible default scene if none is pending.

import {
  installMockApi,
  replayPendingConvJump,
  readPendingConvJump,
  bootEmptyDefault,
  playScene,
} from "./api";
import { installMockOrchestrator } from "./orchestrator";
import { KNOBS, seedKnobDefaults, type Knob, type KnobGroup } from "./knobs";
import { getKnob, restoreKnobsFromSession } from "./state";
import { SCENE_NAMES, type SceneName } from "./fixtures/scenes";

// ---- the deck's namespaced stylesheet --------------------------------------------------------

const DECK_CSS = `
#mock-deck.mockdeck-root {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 2147483647;
  width: 280px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #e8e8e8;
  background: rgba(22, 22, 26, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  user-select: none;
  overflow: hidden;
}
#mock-deck .mockdeck-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  flex: 0 0 auto;
}
#mock-deck .mockdeck-title { font-weight: 600; letter-spacing: 0.02em; }
#mock-deck .mockdeck-chevron { opacity: 0.7; }
#mock-deck .mockdeck-body {
  overflow-y: auto;
  padding: 8px 10px 10px;
  flex: 1 1 auto;
}
#mock-deck.mockdeck-collapsed .mockdeck-body { display: none; }
#mock-deck .mockdeck-section-title {
  margin: 10px 0 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.55;
}
#mock-deck .mockdeck-section-title:first-child { margin-top: 0; }
#mock-deck .mockdeck-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
#mock-deck .mockdeck-btn {
  font: inherit;
  color: #e8e8e8;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  padding: 3px 7px;
  cursor: pointer;
}
#mock-deck .mockdeck-btn:hover { background: rgba(255, 255, 255, 0.16); }
#mock-deck .mockdeck-btn:active { background: rgba(255, 255, 255, 0.22); }
#mock-deck .mockdeck-group { margin-top: 6px; }
#mock-deck .mockdeck-group-title {
  margin: 8px 0 3px;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.8;
}
#mock-deck .mockdeck-knob {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 3px 0;
}
#mock-deck .mockdeck-knob-label { flex: 1 1 auto; opacity: 0.92; }
#mock-deck .mockdeck-knob-input { flex: 0 0 auto; }
#mock-deck select.mockdeck-knob-input,
#mock-deck input.mockdeck-knob-input {
  font: inherit;
  color: #e8e8e8;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  padding: 2px 4px;
  max-width: 130px;
}
#mock-deck input.mockdeck-num { width: 56px; }
#mock-deck input.mockdeck-text { width: 110px; }
#mock-deck input[type="checkbox"].mockdeck-knob-input { width: 14px; height: 14px; accent-color: #6aa3ff; }
`;

// Non-conversation preset jumps (each calls an idempotent __mock.* method). Conversation scenes are
// rendered separately (from SCENE_NAMES) so the two preset families stay distinct + complete.
const STATE_PRESETS: ReadonlyArray<{ label: string; run: () => void }> = [
  { label: "Review · viewing", run: () => void window.__mock?.showReview("viewing") },
  { label: "Review · summary", run: () => void window.__mock?.showReview("summary") },
  { label: "Review · prototype", run: () => void window.__mock?.showReview("prototype") },
  { label: "Review · acceptance", run: () => void window.__mock?.showReview("acceptance") },
  { label: "Review · clear", run: () => window.__mock?.clearReview() },
  { label: "Resume · resumable", run: () => window.__mock?.showResume("resumable") },
  { label: "Resume · blocked", run: () => window.__mock?.showResume("blocked") },
  { label: "Resume · hide", run: () => window.__mock?.hideResume() },
  { label: "Quota · waiting", run: () => window.__mock?.showQuota("waiting") },
  { label: "Quota · exhausted", run: () => window.__mock?.showQuota("exhausted") },
  { label: "Quota · resumed", run: () => window.__mock?.showQuota("resumed") },
  { label: "Doc · mermaid", run: () => void window.__mock?.openDoc("mermaid") },
  { label: "Doc · table", run: () => void window.__mock?.openDoc("table") },
  { label: "Doc · code", run: () => void window.__mock?.openDoc("code") },
  { label: "Doc · image", run: () => void window.__mock?.openDoc("image") },
  { label: "Doc · error", run: () => void window.__mock?.openDoc("error") },
  { label: "Nested plan: Chompy Asteroids", run: () => void window.__mock?.openNested() },
  { label: "History replay", run: () => void window.__mock?.showHistory() },
  { label: "Empty conversation", run: () => void window.__mock?.showEmptyConversation() },
  { label: "Composer", run: () => window.__mock?.openComposer() },
  { label: "Auth onboarding", run: () => window.__mock?.showAuthOnboarding() },
  { label: "Reset", run: () => window.__mock?.reset() },
];

// Human labels for the conversation scenes (fall back to the raw name when unmapped).
const SCENE_LABELS: Partial<Record<SceneName, string>> = {
  assistantText: "Assistant text",
  toolRunning: "Tool · running",
  toolDone: "Tool · done",
  toolError: "Tool · error",
  subagentGroup: "Subagent group",
  resultSuccess: "Result · success",
  resultError: "Result · error",
  resultInterrupted: "Result · interrupted",
  errorFatal: "Fatal error",
  questionCard: "Question card",
  exitPlanMode: "ExitPlanMode review",
  permissionThenReply: "Permission → reply",
};

// ---- element builders ------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  return el("div", "mockdeck-section-title", text);
}

function presetButton(label: string, run: () => void): HTMLButtonElement {
  const b = el("button", "mockdeck-btn", label);
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

// The value a knob's CONTROL should initialize to: the persisted/restored store value (so a value that
// survived a conversation-jump reload re-appears in the deck) when present, else the knob's default. The
// store is seeded/restored BEFORE mountDeck builds controls (see boot()), so getKnob is authoritative.
function knobControlValue(knob: Knob): boolean | string | number {
  const stored = getKnob(knob.id);
  return stored === undefined ? knob.default : (stored as boolean | string | number);
}

// Render a single knob's control (toggle/select/number/text) wired to knob.apply.
function knobControl(knob: Knob): HTMLElement {
  const row = el("div", "mockdeck-knob");
  row.appendChild(el("span", "mockdeck-knob-label", knob.label));
  const initial = knobControlValue(knob);

  if (knob.kind === "toggle") {
    const input = el("input", "mockdeck-knob-input");
    input.type = "checkbox";
    input.checked = Boolean(initial);
    input.addEventListener("change", () => knob.apply(input.checked));
    row.appendChild(input);
    return row;
  }

  if (knob.kind === "select") {
    const sel = el("select", "mockdeck-knob-input");
    for (const opt of knob.options ?? []) {
      const o = el("option");
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    sel.value = String(initial);
    sel.addEventListener("change", () => knob.apply(sel.value));
    row.appendChild(sel);
    return row;
  }

  if (knob.kind === "number") {
    const input = el("input", "mockdeck-knob-input mockdeck-num");
    input.type = "number";
    input.min = "0";
    input.value = String(initial);
    input.addEventListener("change", () => knob.apply(Number(input.value)));
    row.appendChild(input);
    return row;
  }

  // text
  const input = el("input", "mockdeck-knob-input mockdeck-text");
  input.type = "text";
  input.value = String(initial);
  input.placeholder = "(filter…)";
  input.addEventListener("input", () => knob.apply(input.value));
  row.appendChild(input);
  return row;
}

// Group knobs by their `group` field, preserving the order each group first appears in KNOBS.
function groupKnobs(): Array<{ group: KnobGroup; knobs: Knob[] }> {
  const order: KnobGroup[] = [];
  const byGroup = new Map<KnobGroup, Knob[]>();
  for (const k of KNOBS) {
    if (!byGroup.has(k.group)) {
      byGroup.set(k.group, []);
      order.push(k.group);
    }
    byGroup.get(k.group)!.push(k);
  }
  return order.map((group) => ({ group, knobs: byGroup.get(group)! }));
}

// ---- mount -----------------------------------------------------------------------------------

function injectStyle(): void {
  if (document.getElementById("mock-deck-style")) return;
  const style = el("style");
  style.id = "mock-deck-style";
  style.textContent = DECK_CSS;
  document.head.appendChild(style);
}

function mountDeck(): void {
  // Idempotent: never mount twice (e.g. an HMR re-run).
  if (document.getElementById("mock-deck")) return;
  injectStyle();

  const deck = el("div", "mockdeck-root");
  deck.id = "mock-deck";

  // Header (click to collapse/expand).
  const header = el("div", "mockdeck-header");
  header.appendChild(el("span", "mockdeck-title", "Mock deck"));
  const chevron = el("span", "mockdeck-chevron", "▾");
  header.appendChild(chevron);
  header.addEventListener("click", () => {
    const collapsed = deck.classList.toggle("mockdeck-collapsed");
    chevron.textContent = collapsed ? "▸" : "▾";
  });
  deck.appendChild(header);

  const body = el("div", "mockdeck-body");

  // ---- Presets section ----
  body.appendChild(sectionTitle("Presets · conversation"));
  const convPresets = el("div", "mockdeck-presets");
  for (const name of SCENE_NAMES) {
    convPresets.appendChild(
      presetButton(SCENE_LABELS[name] ?? name, () => void playScene(name)),
    );
  }
  body.appendChild(convPresets);

  body.appendChild(sectionTitle("Presets · states"));
  const statePresets = el("div", "mockdeck-presets");
  for (const p of STATE_PRESETS) statePresets.appendChild(presetButton(p.label, p.run));
  body.appendChild(statePresets);

  // ---- Knobs section ----
  body.appendChild(sectionTitle("Knobs"));
  for (const { group, knobs } of groupKnobs()) {
    body.appendChild(el("div", "mockdeck-group-title", group));
    const groupEl = el("div", "mockdeck-group");
    for (const k of knobs) groupEl.appendChild(knobControl(k));
    body.appendChild(groupEl);
  }

  deck.appendChild(body);
  document.body.appendChild(deck);
}

// The knob groups whose APPLIED surface state is re-applied on boot after a conversation-jump reload.
// Restricted to Global + Sidebar — the persistent, conversation-independent surfaces the reload would
// otherwise silently revert (sidebar count/unread/tree/filter; theme/text size). Deliberately EXCLUDES:
//   • Conversation — its knobs route through the reload seam (playScene/clearConversation); re-applying
//     on boot would trigger ANOTHER reload → an infinite loop. The pending URL jump already reproduces
//     the conversation surface for the fresh model.
//   • Review bar / Question card — their drivers call reset(), which would clear the buffers the pending
//     conv jump is about to replay (fighting it). The deck control still SHOWS the restored value; the
//     user re-clicks to re-paint that transient surface.
//   • Modals — a composer/auth modal should not silently re-open itself on boot.
const REAPPLY_GROUPS: ReadonlySet<KnobGroup> = new Set(["Global", "Sidebar"]);

// Re-apply restored knobs (in REAPPLY_GROUPS) whose stored value differs from their default, so the
// APPLIED surface state — not just the deck control values — survives a conversation-jump reload. These
// applies are idempotent (theme/text-size click only when a flip is needed; the sidebar driver
// re-derives the list from the stored trio). Skips knobs still at their default (no-op) and no-ops
// entirely on a fresh launch (nothing restored).
function reapplyRestoredSurfaceKnobs(): void {
  for (const k of KNOBS) {
    if (!REAPPLY_GROUPS.has(k.group)) continue;
    const stored = getKnob(k.id);
    if (stored === undefined || stored === k.default) continue;
    try {
      k.apply(stored);
    } catch {
      // A single knob's re-apply failing must not abort the rest (or boot).
    }
  }
}

// Apply a sensible default + replay any pending conversation jump, ONCE the app is ready. The event
// buffer already replays-on-subscribe (so a frame staged before initConversation's listeners attach is
// not lost), but we still defer one frame to avoid racing the app's own DOMContentLoaded wiring.
function applyDefaultOnReady(): void {
  // Seed every knob's default into the store (fill-only-where-missing) so composite drivers read
  // coherent values without clobbering any value restored from a conversation-jump reload.
  seedKnobDefaults();
  // Re-apply restored Global/Sidebar knobs so the APPLIED surface state survives the reload too (the
  // deck controls already show the restored values via knobControlValue). No-op on a fresh launch.
  reapplyRestoredSurfaceKnobs();
  // If the URL carries a pending conversation jump (the clean-model reload seam), replay it into the
  // fresh post-reload model. Otherwise apply a sensible default scene so the app shows SOMETHING.
  if (readPendingConvJump()) {
    replayPendingConvJump();
  } else {
    // Boot with a CLEAN, empty live conversation (session stays "none") — exactly like a freshly
    // launched real app. We deliberately do NOT auto-play a scene here: an auto-played scene emits
    // agent-stream frames that flip the session live, which makes loadHistoryForPlan bail on its
    // live-session guard and blocks historical (tree_id) plan reconstruction. With the boot left clean,
    // selecting a historical plan reconstructs its conversation faithfully. Every deck preset scene
    // (Assistant text, openNested, History replay, …) remains one click away via its own reset+reload
    // seam. Staged IN PLACE (the page just loaded → the model is already fresh; no frames, no reload).
    bootEmptyDefault();
  }
}

// Install the FAKE orchestrator as the orchestrator singleton FIRST — BEFORE main.ts's
// DOMContentLoaded wiring calls getOrchestrator().subscribe(...). This module evaluates at mock boot
// (after main.ts's module body, which only registers a DOMContentLoaded listener), so the singleton is
// installed before that handler runs.
installMockOrchestrator();

// Install the window.__mock automation hook IMMEDIATELY so a script can call it as soon as this module
// evaluates. It only touches `window`; the DOM-touching jumpers are null-safe before the DOM is built.
installMockApi();

// Mount the panel on DOM ready (guarding the already-parsed case — this script loads after main.ts's
// defer, so DOMContentLoaded may have already fired), then apply the default/replay AFTER the app's own
// DOMContentLoaded handlers (a deferred microtask) so initConversation has registered its listeners.
function boot(): void {
  // Restore any knob store (+ commentCount) stashed before a conversation-jump reload, BEFORE the deck
  // builds its controls (so the controls show the surviving values) AND before applyDefaultOnReady's
  // seedKnobDefaults (which now fills only knobs NOT already present, so restored values are preserved).
  // No-op when nothing was stashed (a fresh launch / manual refresh).
  restoreKnobsFromSession();
  mountDeck();
  // Defer so main.ts's DOMContentLoaded wiring (which awaits initConversation) has a chance to attach
  // the conversation listeners before we stage the default scene. The replay-on-subscribe buffer makes
  // this safe even if it races slightly, but the defer keeps the first paint clean.
  setTimeout(applyDefaultOnReady, 0);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
