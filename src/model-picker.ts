// Pure resolver for the header-bar model/effort preset picker.
//
// The picker offers three fixed presets; the chosen preset id is persisted in
// localStorage under MODEL_PRESET_KEY and resolved to the concrete agent
// options ({model, effort?}) the session needs. This module is UI- and
// transport-free: the orchestrator/Rust/sidecar wiring and the DOM live
// elsewhere. Dependency-injected storage keeps it unit-testable in jsdom.

// localStorage key for the persisted preset id.
export const MODEL_PRESET_KEY = "plan-reader-model-preset";

// The three preset ids, in display order. `as const` makes this the source of
// truth for both the runtime membership check and the ModelPreset union.
export const MODEL_PRESETS = ["opus-4-8", "fable-5", "sonnet-4-6"] as const;

// Union of the three preset ids.
export type ModelPreset = (typeof MODEL_PRESETS)[number];

// localStorage key for the user's global Opus reasoning-effort choice. Separate
// from MODEL_PRESET_KEY: effort is a single global setting applied whenever Opus
// is the selected preset, retained across model switches (never per-model
// persisted, never per-session reset).
export const EFFORT_KEY = "plan-reader-opus-effort";

// The five SDK effort levels, in display order. `as const` makes this the source
// of truth for both the runtime membership check and the EffortLevel union. This
// mirrors the SDK's EffortLevel union but is kept LOCAL to the frontend (do not
// import sidecar/env-overrides into production src/ — it pulls SDK types into the
// frontend graph). A test-only drift-guard keeps the two whitelists in sync.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

// Union of the five effort levels.
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// The Opus effort used when nothing valid is persisted (supersedes the prior
// static `effort:"medium"`).
export const DEFAULT_EFFORT: EffortLevel = "high";

// The concrete agent options a preset resolves to. `effort` is optional so the
// table can express effort-less presets — and so the key-omission invariant
// (below) can be exercised.
export interface ModelOptions {
  model: string;
  effort?: string;
}

// Preset id → agent options. All three current presets carry an effort, but the
// builder below is written so an absent effort means an absent key, not
// `effort: undefined` — preserving the defensive invariant for any future
// effort-less preset.
export const PRESET_OPTIONS: Readonly<Record<ModelPreset, ModelOptions>> = {
  "opus-4-8": { model: "claude-opus-4-8" },
  "fable-5": { model: "claude-fable-5", effort: "low" },
  "sonnet-4-6": { model: "claude-sonnet-4-6", effort: "medium" },
};

// The preset used when nothing valid is persisted.
export const DEFAULT_PRESET: ModelPreset = "opus-4-8";

// Build a ModelOptions object that applies the key-omission rule: when `effort`
// is undefined the returned object genuinely lacks the `effort` key (so
// `"effort" in result === false`), never `{effort: undefined}`. Conditional
// assignment, not an `{effort}` spread, is what guarantees this.
export function buildOptions(model: string, effort?: string): ModelOptions {
  const options: ModelOptions = { model };
  if (effort !== undefined) options.effort = effort;
  return options;
}

// Type guard: is `value` one of the known preset ids?
function isModelPreset(value: unknown): value is ModelPreset {
  return (
    typeof value === "string" &&
    (MODEL_PRESETS as readonly string[]).includes(value)
  );
}

// Type guard: is `value` one of the known effort levels? Mirrors isModelPreset.
// A test-only drift-guard pins this frontend whitelist against the sidecar's
// SDK-derived isEffortLevel.
export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

// Defensively read the persisted global Opus effort, falling back to
// DEFAULT_EFFORT on ANY failure. Mirrors readStoredPreset: tolerates storage
// being null/undefined, `getItem` not being a function, `getItem` throwing
// (private-mode / disabled storage in a WebView), or a stored value that isn't a
// known effort level. It must NEVER throw — session start (orchestrator) reaches
// this path for Opus, so a throw here would crash agent startup.
function readStoredEffort(
  storage: Pick<Storage, "getItem"> | null | undefined,
): EffortLevel {
  try {
    const raw = storage?.getItem?.(EFFORT_KEY);
    return isEffortLevel(raw) ? raw : DEFAULT_EFFORT;
  } catch {
    return DEFAULT_EFFORT;
  }
}

// Defensively read the persisted preset id, falling back to DEFAULT_PRESET on
// ANY failure. This is the single hardened entry point that both the resolver
// and the picker UI go through. It tolerates: storage being null/undefined,
// `getItem` not being a function, `getItem` throwing (e.g. private-mode /
// disabled storage in a WebView), or a stored value that isn't a known preset.
// It must NEVER throw — session start (orchestrator) calls into this path, so a
// throw here would crash agent startup.
function readStoredPreset(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ModelPreset {
  try {
    const raw = storage?.getItem?.(MODEL_PRESET_KEY);
    return isModelPreset(raw) ? raw : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

// Resolve the persisted preset to its agent options. Falls back to
// DEFAULT_PRESET when the stored value is absent, unreadable, or not a known
// preset. Returns a fresh object built via buildOptions so the key-omission
// invariant holds for any preset (including hypothetical effort-less ones).
// Never throws — reads go through readStoredPreset.
export function resolveModelOptions(
  storage: Pick<Storage, "getItem"> | null | undefined = localStorage,
): ModelOptions {
  const preset = readStoredPreset(storage);
  const { model, effort } = PRESET_OPTIONS[preset];
  // Opus has no static effort: its effort is the user's global choice (default
  // "high"). Every other preset keeps its own static effort. buildOptions still
  // omits the key when effort is undefined, so the global Opus effort cannot
  // leak onto a non-Opus preset.
  const resolvedEffort =
    preset === "opus-4-8" ? readStoredEffort(storage) : effort;
  return buildOptions(model, resolvedEffort);
}

// Wire the header-bar segmented model/effort picker. Pure & dependency-injected
// (default storage = localStorage) so jsdom tests can pass a fake store + a
// programmatically-built DOM subtree.
//   - on init: highlight the button whose data-preset matches the persisted
//     preset (DEFAULT_PRESET when nothing valid is stored)
//   - on click of a .model-preset (event-delegated on the container): validate
//     its data-preset, persist it to MODEL_PRESET_KEY, and move the .active class
// No-op (safe) when `container` is null. The orchestrator READS the persisted
// preset at session start; this initializer only writes on click.
export function initModelPicker(
  container: Element | null,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  if (!container) return;

  const buttons = Array.from(
    container.querySelectorAll<HTMLElement>(".model-preset"),
  );

  // The effort segment (.titlebar-effort) is a SIBLING of the model picker
  // inside .titlebar-controls — NOT a child (the model picker has overflow:hidden
  // + a fixed height that would clip extra buttons / focus outlines). Locate it
  // by walking up to the shared controls slot. May be absent (tests/older DOM):
  // every effort path below no-ops safely when it is null.
  const effortGroup =
    container.closest(".titlebar-controls")?.querySelector<HTMLElement>(
      ".titlebar-effort",
    ) ?? null;
  const effortButtons = effortGroup
    ? Array.from(effortGroup.querySelectorAll<HTMLElement>(".effort-level"))
    : [];

  const highlight = (preset: ModelPreset): void => {
    for (const btn of buttons) {
      const isActive = btn.dataset.preset === preset;
      btn.classList.toggle("active", isActive);
      // Keep aria-pressed in lockstep with .active so the selected state is
      // exposed to assistive tech, not just conveyed by CSS.
      btn.setAttribute("aria-pressed", String(isActive));
    }
  };

  // Separate from highlight(): toggle .active + aria-pressed across the five
  // effort buttons. Disjoint selectors (.effort-level vs .model-preset) keep the
  // two segments from interfering.
  const highlightEffort = (level: EffortLevel): void => {
    for (const btn of effortButtons) {
      const isActive = btn.dataset.effort === level;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    }
  };

  // Reveal the effort segment only when Opus is the active preset; otherwise
  // remove it from layout entirely (no greyed placeholder).
  const syncEffortVisibility = (preset: ModelPreset): void => {
    if (!effortGroup) return;
    if (preset === "opus-4-8") effortGroup.removeAttribute("hidden");
    else effortGroup.setAttribute("hidden", "");
  };

  highlight(readStoredPreset(storage));
  highlightEffort(readStoredEffort(storage));
  syncEffortVisibility(readStoredPreset(storage));

  container.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest(".model-preset") : null;
    if (!(target instanceof HTMLElement)) return;
    const preset = target.dataset.preset ?? null;
    if (!isModelPreset(preset)) return;
    // Guard the write: an unavailable/disabled storage (private mode, quota,
    // etc.) must not make a click throw. The UI still updates regardless.
    try {
      storage?.setItem?.(MODEL_PRESET_KEY, preset);
    } catch {
      // Persistence failed; the selection is still reflected in the UI below.
    }
    highlight(preset);
    syncEffortVisibility(preset);
  });

  // SEPARATE handler for the effort segment, guarded by closest(".effort-level")
  // so it never touches the model preset and vice-versa. Listens on the effort
  // group itself (a sibling, outside `container`).
  effortGroup?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest(".effort-level") : null;
    if (!(target instanceof HTMLElement)) return;
    const level = target.dataset.effort ?? null;
    if (!isEffortLevel(level)) return;
    // Same try/catch guard as the preset write: a failed persist still updates
    // the UI below.
    try {
      storage?.setItem?.(EFFORT_KEY, level);
    } catch {
      // Persistence failed; the selection is still reflected in the UI below.
    }
    highlightEffort(level);
  });
}
