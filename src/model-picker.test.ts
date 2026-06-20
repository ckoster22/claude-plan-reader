import { describe, it, expect, vi } from "vitest";
import {
  MODEL_PRESET_KEY,
  MODEL_PRESETS,
  PRESET_OPTIONS,
  DEFAULT_PRESET,
  EFFORT_KEY,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  buildOptions,
  resolveModelOptions,
  initModelPicker,
  type ModelPreset,
  type EffortLevel,
} from "./model-picker";
// Drift-guard (test-only): the FRONTEND effort whitelist must stay in sync with
// the sidecar's SDK-derived isEffortLevel. Vitest includes sidecar/**; the
// production src tsc graph does NOT, so this import is confined to the test file.
import { isEffortLevel as sidecarIsEffortLevel } from "../sidecar/env-overrides";

// Dependency-injected fake storage, mirroring the Map-backed `{getItem}` pattern
// in src/titlebar.test.ts. Only getItem is needed by resolveModelOptions.
function fakeStorage(initial?: Record<string, string>): Pick<Storage, "getItem"> {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return { getItem: (k: string) => store.get(k) ?? null };
}

describe("PRESET_OPTIONS table", () => {
  // 1. Each preset id maps to the exact {model, effort} pair. Opus is now
  // effort-less (the static `effort:"medium"` is superseded by the global
  // plan-reader-opus-effort selector).
  it("maps each preset id to its exact model/effort options", () => {
    expect(PRESET_OPTIONS["opus-4-8"]).toEqual({ model: "claude-opus-4-8" });
    // Opus carries NO static effort — its effort is the user's global choice.
    expect("effort" in PRESET_OPTIONS["opus-4-8"]).toBe(false);
    expect(PRESET_OPTIONS["fable-5"]).toEqual({
      model: "claude-fable-5",
      effort: "low",
    });
    expect(PRESET_OPTIONS["sonnet-4-6"]).toEqual({
      model: "claude-sonnet-4-6",
      effort: "medium",
    });
  });

  it("lists the three presets in the documented order", () => {
    expect([...MODEL_PRESETS]).toEqual(["opus-4-8", "fable-5", "sonnet-4-6"]);
  });

  it("lists the five effort levels in the documented order, default high", () => {
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(DEFAULT_EFFORT).toBe("high");
  });
});

describe("resolveModelOptions", () => {
  // Opus's effort now comes from the global EFFORT_KEY store (default "high").
  const OPUS_DEFAULT = { model: "claude-opus-4-8", effort: "high" };

  // 2. Empty storage → Opus 4.8 / high default (the new global default effort).
  it("falls back to the Opus 4.8 / high default when storage is empty", () => {
    expect(DEFAULT_PRESET).toBe("opus-4-8");
    expect(resolveModelOptions(fakeStorage())).toEqual(OPUS_DEFAULT);
  });

  // 3. Unknown/garbage stored value → default (no throw, no undefined).
  it("falls back to the default for an unknown stored value", () => {
    const storage = fakeStorage({ [MODEL_PRESET_KEY]: "totally-bogus-id" });
    const result = resolveModelOptions(storage);
    expect(result).toEqual(OPUS_DEFAULT);
    expect(result).not.toBeUndefined();
  });

  // 4. A persisted valid preset → that preset's options.
  it("resolves a persisted valid preset to its options", () => {
    const storage = fakeStorage({ [MODEL_PRESET_KEY]: "fable-5" });
    expect(resolveModelOptions(storage)).toEqual({
      model: "claude-fable-5",
      effort: "low",
    });
  });

  // NEW (#1): Opus emits the stored effort, not the default. With "max" stored,
  // Opus resolves to effort:"max" — NOT "high"/"medium".
  it("emits the stored global effort for Opus", () => {
    const storage = fakeStorage({
      [MODEL_PRESET_KEY]: "opus-4-8",
      [EFFORT_KEY]: "max",
    });
    const result = resolveModelOptions(storage);
    expect(result).toEqual({ model: "claude-opus-4-8", effort: "max" });
    expect(result.effort).not.toBe("high");
    expect(result.effort).not.toBe("medium");
  });

  // NEW (#2): non-Opus presets keep their OWN static effort; the global Opus
  // effort must NEVER leak onto them.
  it("never leaks the global Opus effort onto non-Opus presets", () => {
    const fableStore = fakeStorage({
      [MODEL_PRESET_KEY]: "fable-5",
      [EFFORT_KEY]: "max",
    });
    expect(resolveModelOptions(fableStore)).toEqual({
      model: "claude-fable-5",
      effort: "low",
    });
    const sonnetStore = fakeStorage({
      [MODEL_PRESET_KEY]: "sonnet-4-6",
      [EFFORT_KEY]: "max",
    });
    expect(resolveModelOptions(sonnetStore)).toEqual({
      model: "claude-sonnet-4-6",
      effort: "medium",
    });
  });

  // Every current preset carries an effort (Opus derives "high" from the empty
  // store), so every resolved result must have the effort key present.
  it("includes the effort key for every current preset (which all carry one)", () => {
    for (const preset of MODEL_PRESETS) {
      const storage = fakeStorage({ [MODEL_PRESET_KEY]: preset });
      const result = resolveModelOptions(storage);
      expect("effort" in result).toBe(true);
    }
  });

  // NEW (#6): an invalid stored effort for Opus degrades to the default "high".
  it("degrades an invalid stored Opus effort to the default", () => {
    const storage = fakeStorage({
      [MODEL_PRESET_KEY]: "opus-4-8",
      [EFFORT_KEY]: "ultra",
    });
    expect(resolveModelOptions(storage)).toEqual(OPUS_DEFAULT);
  });

  // DEFENSIVE: session start (orchestrator) calls resolveModelOptions through
  // the real defaultDeps.startSession. A WebView with disabled/private-mode
  // storage would make getItem throw or be absent — that must NEVER crash
  // startup. Every degenerate storage shape falls back to the Opus 4.8 default,
  // and the effort read degrades to "high" without throwing.
  it("falls back to the default (no throw) when getItem throws", () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error("storage unavailable (private mode)");
      },
    };
    let result: ReturnType<typeof resolveModelOptions> | undefined;
    expect(() => {
      result = resolveModelOptions(throwingStorage);
    }).not.toThrow();
    expect(result).toEqual(OPUS_DEFAULT);
  });

  // FALSIFIABILITY: a throwing getItem invoked WITHOUT the try/catch wrapper
  // propagates — proving the catch in readStoredPreset/readStoredEffort is what
  // suppresses it.
  it("(falsifiability) a raw getItem call without the guard would throw", () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error("boom");
      },
    };
    expect(() => throwingStorage.getItem()).toThrow("boom");
  });

  it("falls back to the default when storage has no getItem (e.g. {})", () => {
    // `{}` has no getItem at all — `storage?.getItem?.(...)` must short-circuit
    // for BOTH the preset read and the effort read.
    expect(resolveModelOptions({} as unknown as Pick<Storage, "getItem">)).toEqual(
      OPUS_DEFAULT,
    );
  });

  it("falls back to the default when storage is null", () => {
    expect(resolveModelOptions(null)).toEqual(OPUS_DEFAULT);
  });

  it("does not throw and yields a valid result with the localStorage default arg", () => {
    // No-arg call uses the default `localStorage`. In jsdom this may be a stub
    // whose getItem throws; readStoredPreset/readStoredEffort must absorb that
    // and still return a usable options object (never undefined, never a throw).
    let result: ReturnType<typeof resolveModelOptions> | undefined;
    expect(() => {
      result = resolveModelOptions();
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(typeof result!.model).toBe("string");
  });
});

// 5. DEFENSIVE: the key-omission invariant, exercised directly on the pure
// builder with an effort-less synthetic input. resolveModelOptions routes every
// preset through buildOptions, so pinning the builder pins the invariant for any
// hypothetical effort-less preset without over-exposing extra API.
describe("buildOptions key-omission invariant", () => {
  it("omits the effort key entirely when no effort is supplied", () => {
    const result = buildOptions("some-model");
    expect(result).toEqual({ model: "some-model" });
    // Genuine absence, not `effort: undefined`.
    expect("effort" in result).toBe(false);
    expect(Object.keys(result)).toEqual(["model"]);
  });

  it("includes the effort key when an effort is supplied", () => {
    const result = buildOptions("some-model", "low");
    expect(result).toEqual({ model: "some-model", effort: "low" });
    expect("effort" in result).toBe(true);
  });
});

// Drift-guard (#9, non-tautological): the frontend EFFORT_LEVELS list must agree
// with the sidecar's SDK-derived isEffortLevel. Iterate the FRONTEND list and
// assert each is accepted; assert genuine non-levels are rejected. If the two
// whitelists drift, this goes red.
describe("effort whitelist drift-guard", () => {
  it("accepts every FRONTEND effort level under the sidecar guard", () => {
    for (const level of EFFORT_LEVELS) {
      expect(sidecarIsEffortLevel(level)).toBe(true);
    }
  });

  it("rejects non-levels under the sidecar guard", () => {
    expect(sidecarIsEffortLevel("ultra")).toBe(false);
    expect(sidecarIsEffortLevel("medium-high")).toBe(false);
  });
});

// Header-bar picker UI. initModelPicker is pure & dependency-injected (Map-backed
// fake storage + a programmatically-built DOM subtree, mirroring the DI pattern in
// src/titlebar.test.ts). It highlights the persisted preset on load and, on click,
// persists the chosen preset and moves the .active class. The effort segment
// (.titlebar-effort) is a SIBLING of the model picker inside .titlebar-controls,
// revealed only when Opus is active.
describe("initModelPicker", () => {
  // Read/write fake storage. setItem is a spy so we can assert the persisted key/value.
  function rwStorage(initial?: Record<string, string>) {
    const store = new Map<string, string>(Object.entries(initial ?? {}));
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: vi.fn((k: string, v: string) => {
        store.set(k, v);
      }),
    };
    return { storage, store };
  }

  // Build the picker subtree (.titlebar-model-picker with one .model-preset per
  // preset) PLUS its SIBLING .titlebar-effort segment (five .effort-level
  // buttons, initially hidden), both inside a .titlebar-controls wrapper —
  // matching index.html's markup. Returns the .titlebar-model-picker (the
  // initModelPicker `container` arg); the sibling is reachable via
  // container.closest(".titlebar-controls").
  function mountPicker() {
    const controls = document.createElement("div");
    controls.className = "titlebar-controls";

    const picker = document.createElement("div");
    picker.className = "titlebar-model-picker";
    for (const preset of MODEL_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-preset";
      btn.dataset.preset = preset;
      picker.appendChild(btn);
    }
    controls.appendChild(picker);

    const effort = document.createElement("div");
    effort.className = "titlebar-effort";
    effort.hidden = true;
    effort.setAttribute("role", "group");
    for (const level of EFFORT_LEVELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "effort-level";
      btn.dataset.effort = level;
      btn.setAttribute("aria-pressed", "false");
      effort.appendChild(btn);
    }
    controls.appendChild(effort);

    return picker;
  }

  const btn = (container: Element, preset: ModelPreset) =>
    container.querySelector<HTMLElement>(`.model-preset[data-preset="${preset}"]`)!;

  // The .titlebar-effort sibling for a given model-picker container.
  const effortGroup = (container: Element): HTMLElement =>
    container
      .closest(".titlebar-controls")!
      .querySelector<HTMLElement>(".titlebar-effort")!;

  const effortBtn = (container: Element, level: EffortLevel): HTMLElement =>
    effortGroup(container).querySelector<HTMLElement>(
      `.effort-level[data-effort="${level}"]`,
    )!;

  it("no-op when container is null (does not throw)", () => {
    const { storage } = rwStorage();
    expect(() => initModelPicker(null, storage)).not.toThrow();
  });

  it("highlights the persisted preset on load (fable-5 active, others not)", () => {
    const container = mountPicker();
    const { storage } = rwStorage({ [MODEL_PRESET_KEY]: "fable-5" });
    initModelPicker(container, storage);

    expect(btn(container, "fable-5").classList.contains("active")).toBe(true);
    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(false);
    expect(btn(container, "sonnet-4-6").classList.contains("active")).toBe(false);

    // aria-pressed must be in lockstep with .active: exactly the active button true.
    expect(btn(container, "fable-5").getAttribute("aria-pressed")).toBe("true");
    expect(btn(container, "opus-4-8").getAttribute("aria-pressed")).toBe("false");
    expect(btn(container, "sonnet-4-6").getAttribute("aria-pressed")).toBe("false");
  });

  it("defaults to opus-4-8 active when storage is empty", () => {
    const container = mountPicker();
    const { storage } = rwStorage();
    initModelPicker(container, storage);

    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(true);
    expect(btn(container, "fable-5").classList.contains("active")).toBe(false);
    expect(btn(container, "sonnet-4-6").classList.contains("active")).toBe(false);
  });

  it("falls back to the default active button for an unknown stored preset", () => {
    const container = mountPicker();
    const { storage } = rwStorage({ [MODEL_PRESET_KEY]: "bogus-id" });
    initModelPicker(container, storage);

    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(true);
  });

  it("clicking a preset persists it and moves .active to it", () => {
    const container = mountPicker();
    const { storage } = rwStorage(); // starts on the opus-4-8 default
    initModelPicker(container, storage);

    btn(container, "sonnet-4-6").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Persistence: exact key + value.
    expect(storage.setItem).toHaveBeenCalledWith(MODEL_PRESET_KEY, "sonnet-4-6");
    // .active moved to the clicked button and OFF the previously-active default.
    expect(btn(container, "sonnet-4-6").classList.contains("active")).toBe(true);
    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(false);
  });

  // FALSIFIABILITY: after clicking sonnet-4-6, the OTHER buttons must NOT be
  // active. If the highlight logic were inverted (e.g. classList.toggle's
  // boolean flipped, marking every non-matching button active), these
  // assertions would go red.
  it("does NOT activate the wrong buttons after a click (falsifiable)", () => {
    const container = mountPicker();
    const { storage } = rwStorage();
    initModelPicker(container, storage);

    btn(container, "sonnet-4-6").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(false);
    expect(btn(container, "fable-5").classList.contains("active")).toBe(false);
    // Exactly one active button total.
    expect(container.querySelectorAll(".model-preset.active").length).toBe(1);
  });

  // A11y: aria-pressed must track .active so screen readers announce the
  // selected state. After a click, exactly the clicked button is aria-pressed
  // "true" and the others "false".
  it("syncs aria-pressed with the active button after load and click (exactly one true)", () => {
    const container = mountPicker();
    const { storage } = rwStorage(); // starts on the opus-4-8 default
    initModelPicker(container, storage);

    // On load: opus-4-8 (default) is the only pressed button.
    expect(btn(container, "opus-4-8").getAttribute("aria-pressed")).toBe("true");
    expect(
      [...container.querySelectorAll(".model-preset")].filter(
        (b) => b.getAttribute("aria-pressed") === "true",
      ).length,
    ).toBe(1);

    btn(container, "sonnet-4-6").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // After click: aria-pressed moved to sonnet-4-6, off all others.
    expect(btn(container, "sonnet-4-6").getAttribute("aria-pressed")).toBe("true");
    expect(btn(container, "opus-4-8").getAttribute("aria-pressed")).toBe("false");
    expect(btn(container, "fable-5").getAttribute("aria-pressed")).toBe("false");
    expect(
      [...container.querySelectorAll(".model-preset")].filter(
        (b) => b.getAttribute("aria-pressed") === "true",
      ).length,
    ).toBe(1);
  });

  // DEFENSIVE: a disabled/quota-exceeded storage makes setItem throw. A click
  // must NOT throw, and the UI must still move .active to the clicked button.
  it("does not throw and still toggles .active when setItem throws", () => {
    const container = mountPicker();
    const store = new Map<string, string>(); // getItem works, setItem throws
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {
        throw new Error("setItem unavailable (quota / private mode)");
      },
    };
    initModelPicker(container, storage); // loads on opus-4-8 default

    expect(() =>
      btn(container, "sonnet-4-6").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    ).not.toThrow();

    // UI moved despite the persistence failure.
    expect(btn(container, "sonnet-4-6").classList.contains("active")).toBe(true);
    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(false);
    expect(btn(container, "sonnet-4-6").getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores clicks that miss a .model-preset (no persist, no change)", () => {
    const container = mountPicker();
    const { storage } = rwStorage();
    initModelPicker(container, storage);

    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(true);
  });

  // ---- Effort segment (.titlebar-effort) — sibling of the model picker ----

  // NEW (#1): Opus active → the effort segment is revealed and the
  // stored/default effort is the single active effort button.
  it("reveals the effort segment when Opus is active and highlights the stored effort", () => {
    const container = mountPicker();
    const { storage } = rwStorage({
      [MODEL_PRESET_KEY]: "opus-4-8",
      [EFFORT_KEY]: "max",
    });
    initModelPicker(container, storage);

    expect(effortGroup(container).hidden).toBe(false);
    expect(effortBtn(container, "max").classList.contains("active")).toBe(true);
    // exactly one active effort button, and it is NOT the default/medium.
    expect(effortGroup(container).querySelectorAll(".effort-level.active").length).toBe(1);
    expect(effortBtn(container, "high").classList.contains("active")).toBe(false);
    expect(effortBtn(container, "medium").classList.contains("active")).toBe(false);
  });

  // NEW (#1): default effort "high" is active when none is stored.
  it("highlights the default effort 'high' when none is stored (Opus)", () => {
    const container = mountPicker();
    const { storage } = rwStorage({ [MODEL_PRESET_KEY]: "opus-4-8" });
    initModelPicker(container, storage);

    expect(effortGroup(container).hidden).toBe(false);
    expect(effortBtn(container, "high").classList.contains("active")).toBe(true);
    expect(effortGroup(container).querySelectorAll(".effort-level.active").length).toBe(1);
  });

  // NEW (#2): non-Opus active → the segment is hidden (removed from layout).
  it("hides the effort segment when a non-Opus preset is active on load", () => {
    const container = mountPicker();
    const { storage } = rwStorage({ [MODEL_PRESET_KEY]: "fable-5" });
    initModelPicker(container, storage);
    expect(effortGroup(container).hidden).toBe(true);
  });

  // NEW (#2 + #3): switching presets toggles segment visibility, and the stored
  // effort is RETAINED across switches (never cleared). Switching does NOT write
  // the EFFORT_KEY.
  it("retains the chosen effort across model switches and never writes EFFORT_KEY on switch", () => {
    const container = mountPicker();
    const { storage } = rwStorage({
      [MODEL_PRESET_KEY]: "opus-4-8",
      [EFFORT_KEY]: "xhigh",
    });
    initModelPicker(container, storage);

    expect(effortGroup(container).hidden).toBe(false);
    expect(effortBtn(container, "xhigh").classList.contains("active")).toBe(true);

    // Switch to a non-Opus preset → segment hides.
    btn(container, "sonnet-4-6").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(effortGroup(container).hidden).toBe(true);

    // Back to Opus → segment re-appears with xhigh STILL active.
    btn(container, "opus-4-8").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(effortGroup(container).hidden).toBe(false);
    expect(effortBtn(container, "xhigh").classList.contains("active")).toBe(true);

    // Resolving Opus now yields xhigh.
    expect(resolveModelOptions(storage)).toEqual({
      model: "claude-opus-4-8",
      effort: "xhigh",
    });

    // EFFORT_KEY was never written during the model switches.
    const effortWrites = storage.setItem.mock.calls.filter(
      (c) => c[0] === EFFORT_KEY,
    );
    expect(effortWrites.length).toBe(0);
  });

  // NEW (#4): clicking an effort button persists it (EFFORT_KEY) and moves the
  // active effort — exactly one .active and exactly one aria-pressed="true".
  it("clicking an effort button persists it and moves the active effort", () => {
    const container = mountPicker();
    const { storage } = rwStorage({ [MODEL_PRESET_KEY]: "opus-4-8" });
    initModelPicker(container, storage);

    effortBtn(container, "max").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(storage.setItem).toHaveBeenCalledWith(EFFORT_KEY, "max");
    expect(effortBtn(container, "max").classList.contains("active")).toBe(true);
    expect(effortGroup(container).querySelectorAll(".effort-level.active").length).toBe(1);
    expect(
      [...effortGroup(container).querySelectorAll(".effort-level")].filter(
        (b) => b.getAttribute("aria-pressed") === "true",
      ).length,
    ).toBe(1);
    expect(effortBtn(container, "max").getAttribute("aria-pressed")).toBe("true");
  });

  // NEW (#5): persistence round-trip — click "low", a fresh init over the same
  // store shows "low" active and resolves Opus+low.
  it("persists the effort across a fresh init (round-trip)", () => {
    const container = mountPicker();
    const { storage, store } = rwStorage({ [MODEL_PRESET_KEY]: "opus-4-8" });
    initModelPicker(container, storage);

    effortBtn(container, "low").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(store.get(EFFORT_KEY)).toBe("low");

    const container2 = mountPicker();
    initModelPicker(container2, storage);
    expect(effortBtn(container2, "low").classList.contains("active")).toBe(true);
    expect(resolveModelOptions(storage)).toEqual({
      model: "claude-opus-4-8",
      effort: "low",
    });
  });

  // NEW (#6): an invalid/absent stored effort → "high" active on load.
  it("highlights 'high' for an invalid stored effort on load", () => {
    const container = mountPicker();
    const { storage } = rwStorage({
      [MODEL_PRESET_KEY]: "opus-4-8",
      [EFFORT_KEY]: "ultra",
    });
    initModelPicker(container, storage);
    expect(effortBtn(container, "high").classList.contains("active")).toBe(true);
    expect(effortGroup(container).querySelectorAll(".effort-level.active").length).toBe(1);
  });

  it("does not throw on init when getItem throws (effort degrades to high)", () => {
    const container = mountPicker();
    const throwingStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: vi.fn(),
    };
    expect(() => initModelPicker(container, throwingStorage)).not.toThrow();
    // Opus is the default preset → segment visible, high active.
    expect(effortGroup(container).hidden).toBe(false);
    expect(effortBtn(container, "high").classList.contains("active")).toBe(true);
  });

  // NEW (#7): effort write failure is non-fatal — setItem throws → no throw, and
  // the active effort still moves.
  it("does not throw and still moves the active effort when EFFORT setItem throws", () => {
    const container = mountPicker();
    const store = new Map<string, string>([[MODEL_PRESET_KEY, "opus-4-8"]]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {
        throw new Error("setItem unavailable");
      },
    };
    initModelPicker(container, storage);

    expect(() =>
      effortBtn(container, "max").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    ).not.toThrow();
    expect(effortBtn(container, "max").classList.contains("active")).toBe(true);
    expect(effortGroup(container).querySelectorAll(".effort-level.active").length).toBe(1);
  });

  // NEW (#8): disjoint handlers — an effort click does NOT change the active
  // preset, and a preset click does NOT change the active effort.
  it("keeps the preset and effort handlers disjoint", () => {
    const container = mountPicker();
    const { storage } = rwStorage({ [MODEL_PRESET_KEY]: "opus-4-8" });
    initModelPicker(container, storage);

    // Effort click → active preset unchanged (opus still active).
    effortBtn(container, "low").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(btn(container, "opus-4-8").classList.contains("active")).toBe(true);
    expect(container.querySelectorAll(".model-preset.active").length).toBe(1);
    expect(effortBtn(container, "low").classList.contains("active")).toBe(true);

    // Preset click within Opus family doesn't disturb the active effort: stay on
    // Opus by re-clicking opus → effort "low" remains active.
    btn(container, "opus-4-8").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(effortBtn(container, "low").classList.contains("active")).toBe(true);
    expect(effortGroup(container).querySelectorAll(".effort-level.active").length).toBe(1);
  });

  // NEW (#10): clicks on the effort container that miss a .effort-level do
  // nothing (no persist, no change).
  it("ignores clicks that miss a .effort-level (no persist, no change)", () => {
    const container = mountPicker();
    const { storage } = rwStorage({ [MODEL_PRESET_KEY]: "opus-4-8" });
    initModelPicker(container, storage);

    const before = effortBtn(container, "high").classList.contains("active");
    effortGroup(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(
      storage.setItem.mock.calls.filter((c) => c[0] === EFFORT_KEY).length,
    ).toBe(0);
    expect(effortBtn(container, "high").classList.contains("active")).toBe(before);
    expect(effortGroup(container).querySelectorAll(".effort-level.active").length).toBe(1);
  });
});

// Type-level sanity: ModelPreset is the union of the three ids; EffortLevel the
// five effort ids. (Compile-time guard; harmless at runtime.)
const _presetTypeCheck: ModelPreset = "opus-4-8";
void _presetTypeCheck;
const _effortTypeCheck: EffortLevel = "high";
void _effortTypeCheck;
