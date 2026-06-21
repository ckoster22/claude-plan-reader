// Pure resolver for the composer's "Auto-resume after quota" setting.
//
// The New-plan composer offers a small toggle: when an orchestrated run hits an Anthropic usage
// limit, should the orchestrator auto-resume the interrupted turn once the quota refreshes? The
// chosen option id is persisted in localStorage under AUTO_RESUME_KEY and resolved to the concrete
// per-run budget the reducer needs ({budget}). This module is UI- and transport-free: the composer
// DOM, the orchestrator wiring, and the Rust/sidecar surface all live elsewhere. Dependency-injected
// storage keeps it unit-testable in jsdom. Mirrors src/model-picker.ts's settings discipline.

// localStorage key for the persisted auto-resume choice.
export const AUTO_RESUME_KEY = "plan-reader-auto-resume";

// The two options, in display order. `as const` makes this the source of truth for both the runtime
// membership check and the AutoResumeOption union.
export const AUTO_RESUME_OPTIONS = ["off", "once"] as const;

// Union of the two option ids.
export type AutoResumeOption = (typeof AUTO_RESUME_OPTIONS)[number];

// The option used when nothing valid is persisted. "Once" is the UI DEFAULT (a brand-new user gets
// one free auto-resume) — distinct from the reducer's fail-closed budget default of 0 (an absent
// QUOTA_BUDGET_SET never auto-resumes). This default only governs the composer pre-selection.
export const DEFAULT_AUTO_RESUME: AutoResumeOption = "once";

// The concrete per-run budget an option resolves to: how many times the orchestrator may auto-resume
// after a quota wall. off → 0 (never), once → 1 (a single auto-resume).
export interface AutoResumeBudget {
  budget: number;
}

// Option id → budget. `off` grants no budget (the run dies the today's-fatal way on a quota wall);
// `once` grants a single auto-resume.
const OPTION_BUDGET: Readonly<Record<AutoResumeOption, number>> = {
  off: 0,
  once: 1,
};

// Type guard: is `value` one of the known option ids?
function isAutoResumeOption(value: unknown): value is AutoResumeOption {
  return (
    typeof value === "string" &&
    (AUTO_RESUME_OPTIONS as readonly string[]).includes(value)
  );
}

// Defensively read the persisted option, falling back to DEFAULT_AUTO_RESUME on ANY failure. Mirrors
// model-picker's readStoredPreset: tolerates storage being null/undefined, `getItem` not being a
// function, `getItem` throwing (private-mode / disabled storage in a WebView), or a stored value that
// isn't a known option. It must NEVER throw — the budget resolver below runs at session start.
export function readStoredAutoResume(
  storage: Pick<Storage, "getItem"> | null | undefined = localStorage,
): AutoResumeOption {
  try {
    const raw = storage?.getItem?.(AUTO_RESUME_KEY);
    return isAutoResumeOption(raw) ? raw : DEFAULT_AUTO_RESUME;
  } catch {
    return DEFAULT_AUTO_RESUME;
  }
}

// Resolve the persisted option to its per-run budget. Falls back to DEFAULT_AUTO_RESUME when the
// stored value is absent, unreadable, or not a known option. Never throws — reads go through
// readStoredAutoResume. The orchestrator's defaultDeps adapter calls this at the START boundary and
// threads {budget} into a QUOTA_BUDGET_SET dispatch (the resolveModelOptions precedent).
export function resolveAutoResumeBudget(
  storage: Pick<Storage, "getItem"> | null | undefined = localStorage,
): AutoResumeBudget {
  const option = readStoredAutoResume(storage);
  return { budget: OPTION_BUDGET[option] };
}

// Wire the composer's auto-resume select control. Pure & dependency-injected (default storage =
// localStorage) so jsdom tests can pass a fake store + a programmatically-built <select>.
//   - on init: select the option matching the persisted choice (DEFAULT_AUTO_RESUME when nothing
//     valid is stored)
//   - on change: validate the chosen value and persist it to AUTO_RESUME_KEY
// No-op (safe) when `select` is null. The orchestrator READS the persisted option at session start
// (via resolveAutoResumeBudget); this initializer only writes on change.
export function initAutoResumeSetting(
  select: HTMLSelectElement | null,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  if (!select) return;

  // Reflect the persisted choice (default when nothing valid is stored).
  select.value = readStoredAutoResume(storage);

  select.addEventListener("change", () => {
    const value = select.value;
    if (!isAutoResumeOption(value)) return;
    // Guard the write: an unavailable/disabled storage (private mode, quota, etc.) must not make a
    // change throw. The select still reflects the new value regardless.
    try {
      storage?.setItem?.(AUTO_RESUME_KEY, value);
    } catch {
      // Persistence failed; the selection is still reflected in the UI.
    }
  });
}
