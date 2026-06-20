// Agent SDK sidecar — model/effort precedence merge (pure, unit-testable).
//
// The session's model + effort can come from two sources:
//   1. the header picker, carried on the `start` command (start.model/start.effort)
//   2. the test-harness env overrides (AGENT_MODEL/AGENT_EFFORT)
//
// Net precedence: env overrides > picker > SDK default. The picker values are
// applied first (via conditional assignment — only non-empty strings), then the
// env overrides are spread on top so AGENT_MODEL/AGENT_EFFORT WIN, keeping live
// tests cheap (see the "live tests use low effort" convention).
//
// KEY-OMISSION INVARIANT (applies to both model AND effort): an absent value must
// yield an ABSENT key, never a key present-with-undefined/null/empty. If neither
// picker nor env supplies effort, `"effort" in result` is false.

import { isEffortLevel, type OptionOverrides } from "./env-overrides";

export interface ModelEffortInput {
  model?: string;
  effort?: string;
}

export function resolveModelEffort(
  start: ModelEffortInput,
  env: OptionOverrides,
): OptionOverrides {
  const merged: OptionOverrides = {};
  if (typeof start.model === "string" && start.model.length > 0) {
    merged.model = start.model;
  }
  if (isEffortLevel(start.effort)) {
    merged.effort = start.effort;
  }
  // Env overrides spread last → they win over the picker.
  return { ...merged, ...env };
}
