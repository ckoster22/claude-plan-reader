// Tests for the env → session-option override mapping (sidecar/env-overrides.ts).
//
// FALSIFIABILITY: these assert exact override objects, so accepting an invalid
// effort, dropping a valid one, or leaking unrelated env keys all go red.

import { describe, it, expect } from "vitest";
import { optionOverridesFromEnv, isEffortLevel } from "./env-overrides";
import { resolveModelEffort } from "./model-effort";


describe("isEffortLevel — shared effort whitelist", () => {
  it("accepts each valid SDK effort level", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(isEffortLevel(level)).toBe(true);
    }
  });

  it("rejects garbage / empty / non-string values", () => {
    for (const bad of ["", "LOW", "minimal", "mediumm", "1", " low ", undefined, null, 0, 5, {}, []]) {
      expect(isEffortLevel(bad)).toBe(false);
    }
  });
});


describe("optionOverridesFromEnv", () => {
  it("returns no overrides when neither var is set (normal app behavior)", () => {
    expect(optionOverridesFromEnv({})).toEqual({});
  });

  it("passes through each valid AGENT_EFFORT level", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(optionOverridesFromEnv({ AGENT_EFFORT: level })).toEqual({
        effort: level,
      });
    }
  });

  it("omits effort entirely for invalid AGENT_EFFORT values", () => {
    for (const bad of ["", "LOW", "minimal", "1", " low "]) {
      expect(optionOverridesFromEnv({ AGENT_EFFORT: bad })).toEqual({});
    }
  });

  it("passes AGENT_MODEL through as model", () => {
    expect(optionOverridesFromEnv({ AGENT_MODEL: "claude-haiku-4-5" })).toEqual({
      model: "claude-haiku-4-5",
    });
  });

  it("omits model when AGENT_MODEL is empty", () => {
    expect(optionOverridesFromEnv({ AGENT_MODEL: "" })).toEqual({});
  });

  it("combines both overrides when both are set and valid", () => {
    expect(
      optionOverridesFromEnv({ AGENT_EFFORT: "low", AGENT_MODEL: "claude-haiku-4-5" }),
    ).toEqual({ effort: "low", model: "claude-haiku-4-5" });
  });

  it("keeps a valid model even when effort is invalid (and vice versa)", () => {
    expect(
      optionOverridesFromEnv({ AGENT_EFFORT: "bogus", AGENT_MODEL: "claude-haiku-4-5" }),
    ).toEqual({ model: "claude-haiku-4-5" });
    expect(
      optionOverridesFromEnv({ AGENT_EFFORT: "medium", AGENT_MODEL: "" }),
    ).toEqual({ effort: "medium" });
  });

  it("ignores unrelated env keys", () => {
    expect(optionOverridesFromEnv({ PATH: "/usr/bin", HOME: "/tmp" })).toEqual({});
  });
});

describe("resolveModelEffort — env overrides beat the picker, key-omission holds", () => {
  it("env AGENT_MODEL wins over the start-command (picker) model", () => {
    // FALSIFY: spread the picker last (env first) → resolved model becomes the
    // picker's claude-opus-4-8 → RED. The live-test cost control depends on env winning.
    const resolved = resolveModelEffort(
      { model: "claude-opus-4-8" },
      optionOverridesFromEnv({ AGENT_MODEL: "claude-haiku-4-5-20251001" }),
    );
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
  });

  it("uses the picker model when env is unset", () => {
    const resolved = resolveModelEffort({ model: "claude-opus-4-8" }, optionOverridesFromEnv({}));
    expect(resolved.model).toBe("claude-opus-4-8");
  });

  it("env AGENT_EFFORT wins over the picker effort", () => {
    const resolved = resolveModelEffort(
      { effort: "medium" },
      optionOverridesFromEnv({ AGENT_EFFORT: "low" }),
    );
    expect(resolved.effort).toBe("low");
  });

  it("uses the picker effort when env is unset", () => {
    const resolved = resolveModelEffort({ effort: "medium" }, optionOverridesFromEnv({}));
    expect(resolved.effort).toBe("medium");
  });

  it("omits effort entirely when neither picker nor env supplies it (no undefined key)", () => {
    // FALSIFY: change resolveModelEffort to assign `merged.effort = start.effort`
    // unconditionally → the key exists with value undefined → `"effort" in resolved`
    // becomes true → RED.
    const resolved = resolveModelEffort({ model: "claude-opus-4-8" }, optionOverridesFromEnv({}));
    expect("effort" in resolved).toBe(false);
    expect(resolved).toEqual({ model: "claude-opus-4-8" });
  });

  it("omits effort entirely for an INVALID picker effort string (symmetric with env path)", () => {
    // FALSIFY: if model-effort.ts went back to `start.effort.length > 0` (accepting
    // any non-empty string) instead of isEffortLevel, "mediumm" would leak through →
    // `"effort" in resolved` becomes true → RED.
    const resolved = resolveModelEffort(
      { model: "claude-opus-4-8", effort: "mediumm" },
      optionOverridesFromEnv({}),
    );
    expect("effort" in resolved).toBe(false);
    expect(resolved).toEqual({ model: "claude-opus-4-8" });
  });

  it("passes a VALID picker effort through", () => {
    const resolved = resolveModelEffort({ effort: "high" }, optionOverridesFromEnv({}));
    expect(resolved.effort).toBe("high");
  });

  it("env effort wins over the picker when BOTH are valid", () => {
    const resolved = resolveModelEffort(
      { effort: "high" },
      optionOverridesFromEnv({ AGENT_EFFORT: "low" }),
    );
    expect(resolved.effort).toBe("low");
  });

  it("treats null/empty/non-string picker values as absent (no leaked keys)", () => {
    const resolved = resolveModelEffort(
      { model: "", effort: undefined },
      optionOverridesFromEnv({}),
    );
    expect("model" in resolved).toBe(false);
    expect("effort" in resolved).toBe(false);
    expect(resolved).toEqual({});
  });
});
