// App-owned planning sub-agent definitions.
//
// The multiplan planning flow (src/conversation/orchestrator.ts) invokes four
// sub-agents BY NAME via the Agent tool: `intent-clarifier`, `plan-sizer`,
// `scope-recon`, `devils-advocate-reviewer`. Historically those names resolved
// AMBIENTLY from Claude Code's global `~/.claude/agents/` directory, which made
// the planning flow depend on the host machine's global config and on the
// target cwd's project/local agents. By passing these definitions through the
// SDK `query()` `agents` option (wired in sidecar/index.ts buildOptions), the
// app OWNS them: they resolve regardless of cwd and regardless of whether the
// host has the global definitions installed.
//
// PRECEDENCE: explicitly-passed `agents` definitions take precedence over
// settings-discovered ones of the same name, so keeping `settingSources`
// unchanged is safe — these four keys shadow any ambient copies.
//
// EFFORT IS SET SESSION-GLOBALLY, NOT PER-AGENT — BY CHOICE. AgentDefinition
// DOES expose a per-agent `effort` field (sdk.d.ts:86-88), but we deliberately
// omit it: the reasoning-effort level is baked into the SDK `query()` at
// construction (see resolveModelEffort in sidecar/model-effort.ts) and applies
// uniformly to the whole session. We tune only `model` per agent below; effort
// stays a single session-wide knob on purpose.
//
// The four PROMPTS below are FAITHFUL (byte-identical) ports of the global `.md`
// definitions (~/.claude/agents/*.md) — do not paraphrase. The plan-sizer
// prompt additionally INLINES the rubric (the global .md `Read`s
// plan-sizer-prompts/rubric.md at runtime; an AgentDefinition.prompt is a
// single string and cannot reference external files, so the load-bearing
// rubric content lives directly in the prompt here). NOTE: the prompts are
// faithful, but the OTHER fields are not all verbatim — in particular the
// devils-advocate-reviewer's `description` is condensed and its `tools` are a
// deliberately reduced read/research subset (see that agent's note below).

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { intentClarifier } from "./intentClarifier";
import { planSizer } from "./planSizer";
import { scopeRecon } from "./scopeRecon";
import { devilsAdvocateReviewer } from "./devilsAdvocateReviewer";

// The map keys MUST exactly match the names the orchestrator prompts invoke via
// the Agent tool (src/conversation/orchestrator.ts): "scope-recon",
// "plan-sizer", "intent-clarifier", "devils-advocate-reviewer". Renaming a key
// here silently breaks the corresponding planning phase.
export const planningAgents: Record<string, AgentDefinition> = {
  "intent-clarifier": intentClarifier,
  "plan-sizer": planSizer,
  "scope-recon": scopeRecon,
  "devils-advocate-reviewer": devilsAdvocateReviewer,
};
