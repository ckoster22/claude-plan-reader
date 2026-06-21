import { describe, it, expect } from "vitest";
import {
  AUTO_RESUME_KEY,
  AUTO_RESUME_OPTIONS,
  DEFAULT_AUTO_RESUME,
  readStoredAutoResume,
  resolveAutoResumeBudget,
  initAutoResumeSetting,
} from "./auto-resume-setting";

// Map-backed fake storage (mirrors model-picker.test.ts). getItem/setItem only.
function fakeStorage(initial?: Record<string, string>): Pick<Storage, "getItem" | "setItem"> {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

describe("auto-resume-setting — options + defaults", () => {
  it("lists the two options in display order", () => {
    expect([...AUTO_RESUME_OPTIONS]).toEqual(["off", "once"]);
  });

  it("the UI default is 'once'", () => {
    expect(DEFAULT_AUTO_RESUME).toBe("once");
  });
});

describe("resolveAutoResumeBudget", () => {
  it("off → budget 0", () => {
    const budget = resolveAutoResumeBudget(fakeStorage({ [AUTO_RESUME_KEY]: "off" }));
    // FALSIFY: map "off" → 1 in OPTION_BUDGET → RED.
    expect(budget).toEqual({ budget: 0 });
  });

  it("once → budget 1", () => {
    const budget = resolveAutoResumeBudget(fakeStorage({ [AUTO_RESUME_KEY]: "once" }));
    // FALSIFY: map "once" → 0 → RED.
    expect(budget).toEqual({ budget: 1 });
  });

  it("unset → default 'once' → budget 1", () => {
    const budget = resolveAutoResumeBudget(fakeStorage());
    // FALSIFY: change DEFAULT_AUTO_RESUME to "off" → budget 0 → RED.
    expect(budget).toEqual({ budget: 1 });
  });

  it("a garbage stored value falls back to the default (once → 1)", () => {
    const budget = resolveAutoResumeBudget(fakeStorage({ [AUTO_RESUME_KEY]: "twice" }));
    expect(budget).toEqual({ budget: 1 });
  });

  it("never throws when storage.getItem throws (private-mode WebView)", () => {
    const hostile: Pick<Storage, "getItem"> = {
      getItem: () => {
        throw new Error("storage disabled");
      },
    };
    // FALSIFY: drop the try/catch in readStoredAutoResume → this throws → RED.
    expect(() => resolveAutoResumeBudget(hostile)).not.toThrow();
    expect(resolveAutoResumeBudget(hostile)).toEqual({ budget: 1 });
  });

  it("never throws when storage is null/undefined", () => {
    expect(resolveAutoResumeBudget(null)).toEqual({ budget: 1 });
    expect(resolveAutoResumeBudget(undefined)).toEqual({ budget: 1 });
  });
});

describe("readStoredAutoResume", () => {
  it("returns the persisted option when valid", () => {
    expect(readStoredAutoResume(fakeStorage({ [AUTO_RESUME_KEY]: "off" }))).toBe("off");
    expect(readStoredAutoResume(fakeStorage({ [AUTO_RESUME_KEY]: "once" }))).toBe("once");
  });

  it("returns the default for an unknown stored value", () => {
    expect(readStoredAutoResume(fakeStorage({ [AUTO_RESUME_KEY]: "nope" }))).toBe("once");
  });
});

describe("initAutoResumeSetting — DOM round-trip", () => {
  function makeSelect(): HTMLSelectElement {
    const sel = document.createElement("select");
    for (const v of ["once", "off"]) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    return sel;
  }

  it("reflects the persisted choice on init (off)", () => {
    const sel = makeSelect();
    initAutoResumeSetting(sel, fakeStorage({ [AUTO_RESUME_KEY]: "off" }));
    expect(sel.value).toBe("off");
  });

  it("defaults to 'once' on init when nothing is stored", () => {
    const sel = makeSelect();
    initAutoResumeSetting(sel, fakeStorage());
    expect(sel.value).toBe("once");
  });

  it("persists the new value on change (round-trip)", () => {
    const storage = fakeStorage();
    const sel = makeSelect();
    initAutoResumeSetting(sel, storage);
    sel.value = "off";
    sel.dispatchEvent(new Event("change"));
    // FALSIFY: drop the setItem in the change handler → readStoredAutoResume still reads "once" → RED.
    expect(readStoredAutoResume(storage)).toBe("off");
    expect(storage.getItem(AUTO_RESUME_KEY)).toBe("off");
  });

  it("is a no-op (no throw) when select is null", () => {
    expect(() => initAutoResumeSetting(null, fakeStorage())).not.toThrow();
  });
});
