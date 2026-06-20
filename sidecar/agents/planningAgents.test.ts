import { describe, expect, it } from "vitest";
import { planningAgents } from "./planningAgents";

// The multiplan orchestrator prompts (src/conversation/orchestrator.ts) invoke
// these four sub-agents BY NAME via the Agent tool. The bundled `agents` map
// passed to the SDK in sidecar/index.ts buildOptions MUST carry exactly these
// keys, each with a usable system prompt, or the corresponding planning phase
// silently falls back to ambient ~/.claude/agents discovery (the dependency
// this feature removes) or breaks entirely if the host has no global copy.
//
// [FALSIFIED: dropped the "scope-recon" key from the map → "contains all four
// role keys" went RED; set scopeRecon.model back to "haiku"/"opus" → "scope-recon
// pinned to sonnet" went RED; set devilsAdvocateReviewer.model back to "sonnet" →
// "devils-advocate-reviewer kept on opus" went RED; emptied a prompt string →
// "non-empty prompt" went RED. Restored → GREEN.]
const ROLE_KEYS = [
  "intent-clarifier",
  "plan-sizer",
  "scope-recon",
  "devils-advocate-reviewer",
] as const;

describe("planningAgents", () => {
  it("contains all four planning role keys the orchestrator invokes by name", () => {
    for (const key of ROLE_KEYS) {
      expect(planningAgents[key]).toBeDefined();
    }
    // No stray/typo'd keys that would never be invoked.
    expect(Object.keys(planningAgents).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it("gives every agent a non-empty system prompt and a description", () => {
    for (const key of ROLE_KEYS) {
      const def = planningAgents[key];
      expect(typeof def.prompt).toBe("string");
      expect(def.prompt.trim().length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("inlines the load-bearing plan-sizer rubric into the single prompt string", () => {
    // plan-sizer.md `Read`s the rubric at runtime; an AgentDefinition.prompt is
    // one string and cannot reference external files, so the rubric MUST be
    // inlined. Pin a few load-bearing rubric markers so a silent drop is caught.
    const p = planningAgents["plan-sizer"].prompt;
    expect(p).toContain("Plan Sizer Rubric");
    expect(p).toContain("Recursion Cap");
    expect(p).toContain("escalate");
  });

  it("inlines the bounded-working-prototype override (DEFAULT SMALL) into the plan-sizer rubric", () => {
    // R1: a bounded, working prototype is empirical proof the work fits one context, so the sizer
    // must bias to `single` and NOT shatter it into a layer tree. FALSIFY: delete the override
    // paragraph from the rubric in planningAgents.ts → these assertions go RED.
    const p = planningAgents["plan-sizer"].prompt;
    expect(p).toContain("Bounded-working-prototype override");
    expect(p).toContain("empirical proof the whole thing fits in one context");
    expect(p).toContain('bias the decision to `single`');
    expect(p).toContain("do not shatter a working artifact into a layer tree");
    expect(p).toContain("genuinely too large to port in one pass");
  });

  it("pins scope-recon to the sonnet model alias (deliberate cost optimization)", () => {
    // scope-recon has no model in its frontmatter, so it inherited the session
    // model (default opus). It is deliberately pinned DOWN to sonnet for shallow
    // recon. Reverting the alias (to haiku or opus) makes THIS assertion fail.
    expect(planningAgents["scope-recon"].model).toBe("sonnet");
  });

  it("keeps devils-advocate-reviewer on opus (the adversarial gate must not be downgraded)", () => {
    // Matches its 'opus' frontmatter; this is the quality gate, so it is NOT
    // downgraded. Reverting the alias to sonnet makes THIS assertion fail.
    expect(planningAgents["devils-advocate-reviewer"].model).toBe("opus");
  });

  it("keeps intent-clarifier and plan-sizer on the capable model", () => {
    expect(planningAgents["intent-clarifier"].model).toBe("opus");
    expect(planningAgents["plan-sizer"].model).toBe("opus");
  });
});
