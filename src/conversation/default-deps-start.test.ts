// Falsifiable test for the ONE seam the picker reaches the wire through: the
// real `defaultDeps().startSession` adapter. The orchestrator core's
// OrchestratorDeps.startSession interface stays narrow ({cwd, permissionMode}) —
// the model/effort resolution lives ONLY in this impure adapter, which reads
// localStorage directly via resolveModelOptions(). The orchestrator unit tests
// inject FAKE deps and never exercise defaultDeps, so without this test the
// frontend→Rust wire would be uncovered (cf. the documented "green mocked tests
// hid a cross-boundary bug" failure mode).
//
// We mock @tauri-apps/api/core's `invoke` so we can assert exactly what
// `start_agent_session` receives, and drive a known preset through jsdom's
// localStorage.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MODEL_PRESET_KEY } from "../model-picker";

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { defaultDeps } from "./orchestrator";

// jsdom's bundled localStorage is a non-functional stub in this harness (it warns
// `--localstorage-file was provided without a valid path` and lacks setItem/clear).
// Install a tiny Map-backed Storage so the real adapter's resolveModelOptions() —
// which reads the GLOBAL localStorage — sees our persisted preset.
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe("defaultDeps().startSession forwards the resolved picker model/effort to Rust", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage(),
      configurable: true,
      writable: true,
    });
  });

  it("forwards the persisted preset's model + effort alongside cwd/permissionMode", async () => {
    // Persist a non-default preset so a wrong (default) value would be detectable.
    localStorage.setItem(MODEL_PRESET_KEY, "fable-5");

    const deps = defaultDeps();
    await deps.startSession({ cwd: "/tmp/proj", permissionMode: "plan" });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    // FALSIFY: drop the `...resolveModelOptions()` spread in the adapter → the args
    // object lacks model/effort → RED.
    expect(invokeMock).toHaveBeenCalledWith("start_agent_session", {
      cwd: "/tmp/proj",
      permissionMode: "plan",
      model: "claude-fable-5",
      effort: "low",
    });
  });

  it("falls back to the default preset (Opus 4.8 / high) when nothing is persisted", async () => {
    // Opus's static effort was superseded by the global plan-reader-opus-effort
    // key (default "high"); an empty store now resolves Opus → effort "high".
    const deps = defaultDeps();
    await deps.startSession({ cwd: "/tmp/proj", permissionMode: "plan" });

    expect(invokeMock).toHaveBeenCalledWith("start_agent_session", {
      cwd: "/tmp/proj",
      permissionMode: "plan",
      model: "claude-opus-4-8",
      effort: "high",
    });
  });
});

describe("defaultDeps().ensurePrototypeDir wires invoke('ensure_prototype_dir', { cwd })", () => {
  beforeEach(() => invokeMock.mockClear());

  it("forwards the cwd to the Rust command (the visual-prototype dir pre-create seam)", async () => {
    const deps = defaultDeps();
    await deps.ensurePrototypeDir!("/tmp/proj");
    // FALSIFY: rename the command or drop the arg in the adapter → RED.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ensure_prototype_dir", { cwd: "/tmp/proj" });
  });
});
