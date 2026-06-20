// Multiplan orchestration domain (Sub-Plan 03) — the IMPURE driver.
//
// This file is the impure counterpart of plan-tree.ts (the PURE reducer). It mirrors the
// stream.ts/index.ts and composer.ts split exactly: the reducer DECIDES side effects (returns an
// Effect2[]); THIS driver EXECUTES them against an injected dependency interface (OrchestratorDeps),
// persists the ledger to .plan-tree/state.json after every transition, fires observer hooks, and
// exposes the frozen OrchestratorHandle.
//
// GENERATION 2 (recursive representation, Phase 1): the driver now runs on the recursive
// TreeNode/NodePath/schema-2 core. Every node is addressed by its NodePath (root []), every gate is
// the unified ApprovalGate2 (the gen-1 nn:-1 master sentinel and the approveMaster /
// requestMasterChanges split methods are GONE — approve(pathKey)/requestChanges(pathKey) route by
// gate.kind). Depth-1 observable behavior is byte-identical to gen 1 (pinned by
// golden-depth1.test.ts).
//
// Testability: like Composer's ComposerInvoker, every Tauri command the effects need is wrapped in
// OrchestratorDeps. `defaultDeps()` binds them to real `invoke(...)`; tests inject fakes so the
// driver is unit-tested with NO real Tauri, NO listen, NO DOM.
//
// Seam ownership: while an orchestration is active, IT is the sole resolver of interactive tools
// (ExitPlanMode / AskUserQuestion). A MODULE-LEVEL registry lets legacy handlers (main.ts's
// handleToolPermissionRequested, index.ts's AskUserQuestion path) consult isOrchestrationActive()
// WITHOUT holding the handle — they early-return when an orchestration owns the seam. This module
// must NOT import main.ts / index.ts (no cycle): the dependency arrow points one way only.

import { invoke } from "@tauri-apps/api/core";
import { resolveModelOptions } from "../model-picker";
import { diag } from "./diag";
import {
  reduce2,
  toLedger2,
  toSnapshot2,
  parseSizerDecision,
  parseNn,
  PlanValidationError,
  pathKey,
  parsePathKey,
  summaryName2,
  planName2,
  inRollupWindow,
  isRootCollapseChild,
  writePolicyFor2,
  nodeAtPath,
  activePathOf,
  treeIsDone,
  rehydrateState2,
  resumeScopeForRoot,
  activePhaseLabel,
  type ResumePlan,
  type ResumeScope,
  type RecursiveLedger,
  type TreeNode,
  type Nn,
  type NodePath,
  type PathKey,
  type PlanTreeFilePath,
  type PlanTreeState2,
  type PlanTreeEvent2,
  type PlanTreeSnapshot2,
  type ApprovalGate2,
  type ClarifyGate,
  type WritePolicy,
  type Effect2,
  type PrototypeInfo,
  type PrototypeGate,
  type AcceptanceGate,
} from "./plan-tree";
import type {
  AgentStream,
  AskUserQuestionAnswers,
  AskUserQuestionInput,
  AskUserQuestionItem,
  ToolPermissionRequested,
} from "./types";
import type { AttachedImage } from "./images";

// Re-export the frozen public types so consumers import the orchestrator surface from one module.
export type {
  PlanTreeSnapshot2,
  ApprovalGate2,
  ClarifyGate,
  PlanTreeEvent2,
  WritePolicy,
  Nn,
  NodePath,
  PathKey,
  PlanTreeFilePath,
  PrototypeInfo,
  PrototypeGate,
  AcceptanceGate,
  RecursiveLedger,
  ResumePlan,
  ResumeScope,
} from "./plan-tree";
// Re-export the PathKey mint/inverse so UI consumers (main.ts) can render/parse gate path keys
// without importing plan-tree directly.
export { pathKey, parsePathKey } from "./plan-tree";
// Re-export the typed plan-validation error (INV-2) so consumers/tests import the discriminator from
// the orchestrator surface — it is the single class both parseSubPlanHeaders and nonEmpty throw.
export { PlanValidationError } from "./plan-tree";

// ---- prompt templates (faithful to /multiplan; subagents resolve via settingSources) --------
//
// These are the per-step prompts the driver sends over the single SDK session. They name the
// user-level subagents (scope-recon / plan-sizer / devils-advocate-reviewer) the /multiplan skill
// relies on. Each step's prompt is sent right before the driver arms the matching `awaiting` variant.
// Node ids are rendered via pathKey — at depth 1 ("01", "02", …) the text is byte-identical to the
// gen-1 pad2 rendering (the golden oracle pins this).

// Intent clarification: the GENESIS turn. The MAIN agent (this orchestrated session) owns the user
// interaction. It invokes the intent-clarifier subagent ONLY to ASSESS the request; the subagent
// returns a STRICT machine-readable JSON object — NOT prose — of the shape it documents:
//   { "intent_clear": <bool>, "questions": [ { question, header(<=12c), multiSelect, options:[{label,
//   description}, ...2-4] }, ...0-4 ] }
// (`intent_clear:true` ⇒ `questions:[]`). The subagent CANNOT touch the user or the disk. The MAIN
// agent PARSES that JSON: if `intent_clear` is false it surfaces the `questions` to the user via
// AskUserQuestion — mapping the subagent's question/option structure straight into AskUserQuestion's
// format (a top-level AskUserQuestion DOES surface through the app's CLARIFY gate; a subagent's does
// NOT — it errors with "AskUserQuestion is not available inside subagents", which is why ownership
// lives here). The MAIN agent's FINAL message is the confirmed INTENT as CLEAN PROSE (never the raw
// JSON), captured by the driver (→ INTENT.md) and threaded forward into recon.
//
// WHY this prompt matches the subagent's JSON contract (evidence-driven): the intent-clarifier's own
// definition HARD-MANDATES "Return EXACTLY ONE JSON object on stdout. No prose, no markdown" with the
// {intent_clear, questions} shape above. The earlier free-text version of this prompt FOUGHT that
// contract: it asked the subagent for prose, the subagent emitted JSON anyway, and the driver captured
// the raw JSON buffer as the confirmed intent — polluting INTENT.md and IGNORING the `intent_clear`/
// `questions` ambiguity signal (ambiguous requests proceeded unclarified). The fix aligns the prompt
// to the real schema: parse the JSON, act on `intent_clear`, and emit clean prose as the final word.
//
// VISUAL-PROTOTYPE MODE (the /multiplan "visual intent loop", ported in-driver): the spawn prompt
// carries the `---VISUAL-MODE---` directive, so the clarifier builds a rapid throwaway visual of
// the intended end product under .plan-tree/prototype/ (the sidecar's "prototype" write policy
// confines writes to exactly that subtree) and the main agent's final message carries the
// clarifier's `prototype` JSON back to the driver via the trailing ---PROTOTYPE--- block (or the
// literal NO-PROTOTYPE line). The driver parses that (parsePrototypeBlock) and opens the
// prototype-review gate. We still keep the "no deep exploration" guard because the subagent has
// Read/Glob/Grep/Bash tools and could otherwise wander before scope-recon runs.
//
// Rollback story: `git revert` the feature commits. (A runtime revert valve was considered and
// removed: start() opens the session in the "prototype" permission mode unconditionally, so a
// valve-off run would NOT restore the pre-feature posture anyway.)

// The byte-exact visual-mode directive the intent-clarifier contract keys on (SKILL.md "SHARED
// CONTRACT — visual-mode intent-clarifier"). Exported so contains-pins catch a silent drift.
export const VISUAL_MODE_DIRECTIVE = [
  "---VISUAL-MODE---",
  "output_dir: .plan-tree/prototype/",
  "---END-VISUAL-MODE---",
].join("\n");

// The shared visual-mode clarifier contract: how to spawn the clarifier IN VISUAL MODE (directive +
// guard + scope), the JSON shape it returns (the usual object PLUS the optional `prototype` key),
// and the medium/variants/screenshot guidance mirroring the external skill + agent definitions.
// Spliced into BOTH visual-mode prompts (intentPrompt and refinePrototypePrompt).
function visualClarifierContractLines(): string[] {
  return [
    "Spawn it IN VISUAL MODE: include this directive block VERBATIM in its spawn prompt (it",
    "activates the subagent's visual-prototype mode and names its output directory):",
    "",
    VISUAL_MODE_DIRECTIVE,
    "",
    "In its spawn prompt also give it this guard verbatim:",
    "",
    "  - You MUST NOT deeply explore the codebase — a separate scope-recon step does that next. At",
    "    most a couple of quick reads, only if strictly necessary — and never outside this working",
    "    directory. Prototype artifacts go under .plan-tree/prototype/ ONLY, written with the Write",
    "    tool (never cat/echo/Bash redirection — the output directory already exists, so no mkdir",
    "    is needed).",
    "",
    WORKDIR_SCOPE_GUARD,
    "",
    "In visual mode the subagent returns EXACTLY ONE JSON object (no prose, no markdown): the usual",
    "shape PLUS an optional `prototype` object:",
    "",
    '  { "intent_clear": <bool>, "questions": [',
    '    { "question": "<text>", "header": "<=12 chars>", "multiSelect": <bool>,',
    '      "options": [ {"label": "<text>", "description": "<text>"}, ... ] }, ... ],',
    '    "prototype": { "kind": "html | mermaid | ascii | table", "paths": ["<artifact path>", ...],',
    '      "screenshot": "<path or null>", "inline_preview": "<text or null>",',
    '      "variants": [ {"label": "<short>", "path": "<path or null>", "inline_preview": "<text or null>"} ] } }',
    "",
    "The MEDIUM is the subagent's discretion: UI / layout / visual / game work → a WORKING",
    "single-file HTML prototype with realistic mock data (the DEFAULT); backend / data / API /",
    "refactor work → a mermaid diagram, an ASCII mockup, or a sample input/output table — whatever",
    'communicates intent fastest. The guarantee is "always SOME visual", never "always HTML". It',
    "may produce 2-4 labeled variants when the right direction is genuinely ambiguous. Screenshots",
    "(chrome-devtools) are BEST-EFFORT: if unavailable or erroring it must skip them",
    "(screenshot: null) without failing.",
  ];
}

// The shared FINALIZE contract for visual-mode turns: clean prose intent first, then — as the very
// last content of the final message — either the ---PROTOTYPE--- block carrying the clarifier's
// `prototype` JSON verbatim, or the literal NO-PROTOTYPE line. parsePrototypeBlock consumes exactly
// this trailing-anchored shape.
function visualFinalizeLines(step: string): string[] {
  return [
    `${step}FINALIZE. Your final message MUST be the CONCISE confirmed INTENT as CLEAN PROSE — a`,
    "short paragraph stating the goal, key constraints, and success criteria (never the raw JSON,",
    "no markdown) — and then, AS THE VERY LAST CONTENT of that final message, EXACTLY ONE of:",
    "",
    "  - when the subagent returned a `prototype` object, this block with the subagent's",
    "    `prototype` JSON object copied VERBATIM as its body:",
    "",
    "---PROTOTYPE---",
    "{the subagent's `prototype` JSON object, verbatim}",
    "---END-PROTOTYPE---",
    "",
    "  - or, when it returned no `prototype`, the single literal line:",
    "",
    "NO-PROTOTYPE",
    "",
    "Nothing may follow the block (or the line). Do not call any other tool after stating the intent.",
  ];
}

export function intentPrompt(request: string, hasImages = false): string {
  return [
    "We are running the multiplan planning flow. Before reconnaissance, YOU (this agent) must confirm",
    "what the user actually wants from this request:",
    "",
    request,
    "",
    // When the user attached image(s), they are inlined in THIS message and only YOU (this agent) can
    // see them. The planning flow delegates to TEXT-ONLY subagents (intent-clarifier, recon, planner),
    // which cannot receive inline images — so you MUST carry the visual context forward in words.
    ...(hasImages
      ? [
          "The user attached one or more IMAGES to this request (inlined above as [Image #N]). Only YOU",
          "can see them — the subagents you spawn are TEXT-ONLY and will NOT receive the image bytes.",
          "Before delegating, study each image and, in every subagent prompt you write (the",
          "intent-clarifier and any later subagents), include a faithful TEXTUAL description of the",
          "relevant image content (layout, components, colors, labels, data — whatever the request",
          "depends on) so the subagent can act on the user's visual intent.",
          "",
        ]
      : []),
    "Step 1 — ASSESS via the subagent. Invoke the **intent-clarifier** subagent to assess the request",
    "AND produce a rapid, variable-fidelity VISUAL of the intended end product (humans react far",
    "better to a visual than to prose).",
    ...visualClarifierContractLines(),
    "",
    "When `intent_clear` is true, `questions` is empty. When it is false, `questions` holds 1–4",
    "decision-forcing questions (each with 2–4 options). This MUST be a FAST, lightweight clarification",
    "that converges in ONE short turn.",
    "",
    "Step 2 — PARSE and DECIDE. Read (JSON.parse) the object the subagent returned:",
    "",
    "  - If `intent_clear` is false, YOU (the main agent — NOT the subagent) ask its `questions` to the",
    "    user using the **AskUserQuestion** tool ONCE, mapping each question/header/multiSelect and its",
    "    options (label + description) directly into AskUserQuestion's question format. AskUserQuestion",
    "    is the MAIN agent's job; the subagent must never call it. Incorporate the user's answers.",
    "  - If `intent_clear` is true, proceed without asking the user anything.",
    "",
    ...visualFinalizeLines("Step 3 — "),
  ].join("\n");
}

// The refine-loop prompt: the user reviewed the held prototype and asked for changes. Re-invoke the
// intent-clarifier IN VISUAL MODE (same directive + scope guard), instructing it to REVISE the
// existing prototype per the user's feedback (appended verbatim), under the same FINALIZE contract
// — so the next turn's result re-enters parsePrototypeBlock and re-opens the gate.
export function refinePrototypePrompt(feedback: string): string {
  return [
    "The user reviewed the visual prototype and wants it REFINED. Re-invoke the **intent-clarifier**",
    "subagent to revise the prototype (and the confirmed intent, if the feedback changes it) per the",
    "user's feedback below.",
    ...visualClarifierContractLines(),
    "",
    "Instruct it to REVISE the existing prototype under .plan-tree/prototype/ according to this",
    "feedback from the user (pass it to the subagent verbatim):",
    "",
    feedback,
    "",
    ...visualFinalizeLines(""),
  ].join("\n");
}

// ---- the trailing prototype-block parser (pure) ----------------------------------------------

// Parse the visual-mode FINALIZE contract out of the intent turn's buffered final text.
// TRAILING-ANCHORED: the ---PROTOTYPE--- block (or the NO-PROTOTYPE line) must be the LAST content
// of the message (modulo trailing whitespace). Mid-text delimiters never mis-parse (no trailing
// closer ⇒ no block); when several blocks exist the LAST one wins (the closer is scanned upward to
// its NEAREST opener). The body is JSON.parsed and validated: `kind` must be in the closed set,
// `paths` must be a non-empty string array (else the block is garbled); missing/odd optional
// fields COERCE (screenshot→null, inline_preview/inlinePreview→null, variants→[]). ANY failure —
// garbled JSON, bad kind, bad paths — returns { intentText: fullText, prototype: null } and NEVER
// throws (a garbled block must not kill the run; the no-prototype fallback path handles it). The
// NO-PROTOTYPE line yields the same null prototype with the line stripped from intentText — and,
// as a contract-violation guard, any COMPLETE ---PROTOTYPE---…---END-PROTOTYPE--- block in the
// remaining text is stripped too (a model emitting BOTH must not leak the raw block into INTENT.md).
export function parsePrototypeBlock(text: string): {
  intentText: string;
  prototype: PrototypeInfo | null;
} {
  const fallback = { intentText: text, prototype: null };
  const trimmed = text.replace(/\s+$/, "");
  const lines = trimmed.split(/\r?\n/);
  const lastLine = (lines.at(-1) ?? "").trim();
  if (lastLine === "NO-PROTOTYPE") {
    // CONTRACT-VIOLATION GUARD: the FINALIZE contract says EXACTLY ONE of block-or-line, but a
    // model emitting BOTH (a complete ---PROTOTYPE--- block AND a trailing NO-PROTOTYPE) must not
    // leak the raw block into intentText (→ INTENT.md). Strip every COMPLETE opener…closer block
    // from the remaining lines; an unclosed opener is not a block and survives (no false strip).
    const restLines = lines.slice(0, -1);
    const kept: string[] = [];
    for (let i = 0; i < restLines.length; i++) {
      if (restLines[i].trim() === "---PROTOTYPE---") {
        let close = -1;
        for (let j = i + 1; j < restLines.length; j++) {
          if (restLines[j].trim() === "---END-PROTOTYPE---") {
            close = j;
            break;
          }
        }
        if (close !== -1) {
          i = close; // skip the whole block (opener..closer inclusive)
          continue;
        }
      }
      kept.push(restLines[i]);
    }
    return { intentText: kept.join("\n").replace(/\s+$/, ""), prototype: null };
  }
  if (lastLine !== "---END-PROTOTYPE---") return fallback;
  // Scan upward from the trailing closer to its NEAREST opener line — last block wins.
  let open = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (lines[i].trim() === "---PROTOTYPE---") {
      open = i;
      break;
    }
  }
  if (open === -1) return fallback;
  const body = lines.slice(open + 1, lines.length - 1).join("\n");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return fallback;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "html" && kind !== "mermaid" && kind !== "ascii" && kind !== "table") return fallback;
  const paths = o.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
    return fallback; // garbled paths ⇒ the whole block is garbled (no artifact to review)
  }
  // Accept BOTH spellings for the preview key: the clarifier's JSON is snake_case (inline_preview,
  // per its contract — the block carries it verbatim); PrototypeInfo is camelCase.
  const preview = (v: Record<string, unknown>): string | null =>
    typeof v.inlinePreview === "string"
      ? v.inlinePreview
      : typeof v.inline_preview === "string"
        ? v.inline_preview
        : null;
  const variants = Array.isArray(o.variants)
    ? o.variants.flatMap((v): PrototypeInfo["variants"] => {
        if (typeof v !== "object" || v === null) return [];
        const vo = v as Record<string, unknown>;
        if (typeof vo.label !== "string") return [];
        return [
          { label: vo.label, path: typeof vo.path === "string" ? vo.path : null, inlinePreview: preview(vo) },
        ];
      })
    : [];
  const prototype: PrototypeInfo = {
    kind,
    paths: paths as string[],
    screenshot: typeof o.screenshot === "string" ? o.screenshot : null,
    inlinePreview: preview(o),
    variants,
  };
  return { intentText: lines.slice(0, open).join("\n").replace(/\s+$/, ""), prototype };
}

// ---- INTENT.md composition (pure) -------------------------------------------------------------

// Compose the INTENT.md contents PROTOTYPE_APPROVED writes: the confirmed-intent prose, then (when
// a prototype exists) the SKILL-exact "## Embeddable visual (for plan embedding)" block, so later
// plan drafts can embed the approved visual directly. screenshot_abs is absolutized HERE in TS
// (the skill's plan-mode-OFF `pwd` dance is unnecessary — the driver knows cwd): an absolute path
// passes verbatim; a relative path drops any leading "./" and joins `cwd + "/" + rel`; null →
// "none". The block also carries `- artifacts: <paths joined with ", ">` — the prototype's exact
// file list, for downstream plan turns. inline_preview is included ONLY for the text-renderable
// kinds (mermaid/ascii/table) with
// the verbatim preview indented under the YAML-ish literal marker; for html the key is omitted
// entirely (the screenshot carries the visual). No block at all when `proto` is null.
export function composeIntentMd(
  intentText: string,
  proto: PrototypeInfo | null,
  cwd: string,
): string {
  if (!proto) return intentText;
  const screenshotAbs =
    proto.screenshot === null
      ? "none"
      : proto.screenshot.startsWith("/")
        ? proto.screenshot
        : `${cwd}/${proto.screenshot.replace(/^\.\//, "")}`;
  const lines = [
    intentText,
    "",
    "## Embeddable visual (for plan embedding)",
    `- kind: ${proto.kind}`,
    `- screenshot_abs: ${screenshotAbs}`,
    // The exact artifact file list (the external SKILL's INTENT.md carries it too) — downstream
    // plan turns may want to read/embed the approved files directly.
    `- artifacts: ${proto.paths.join(", ")}`,
  ];
  if (proto.kind !== "html" && proto.inlinePreview !== null) {
    lines.push("- inline_preview: |");
    for (const l of proto.inlinePreview.split(/\r?\n/)) lines.push(`    ${l}`);
  }
  return lines.join("\n");
}

// A labeled context block carrying the confirmed intent (the intent-clarifier's final message),
// threaded ABOVE a planning prompt's instructions. Returns [] when intent is null/empty so the
// prompt is byte-identical to its pre-feature form (graceful empty-intent). Callers spread these
// lines into their prompt's line array before the instruction lines.
function confirmedIntentBlock(intent?: string | null): string[] {
  const text = intent?.trim();
  if (!text) return [];
  return ["Confirmed intent (from clarification):", "", text, ""];
}

// Working-directory scope guard: spliced into every exploration-capable prompt (intent, root
// recon, sub-recon) so neither the main agent nor any subagent it spawns crawls SIBLING projects
// or parent directories when hunting "prior art". Exported so contains-pins in
// orchestrator.test.ts catch a silent drop from any of the three prompts.
export const WORKDIR_SCOPE_GUARD = [
  "SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).",
  "Do NOT read, glob, grep, or list sibling projects or parent directories — prior art",
  "means prior art WITHIN this directory tree only. Pass this constraint verbatim to any",
  "subagent you spawn.",
].join("\n");

// BASELINE FRAMING (Phase 3 — framing only; full use lands in Phase 4): the wording threaded into
// any prompt that references the frozen working-reference baseline. The baseline is a FLOOR on the
// outcome dimensions captured in INTENT.md — the minimum bar the build must clear — NOT a
// behavioral match-target to reproduce. Intentional improvements ABOVE the floor are good. Exported
// so Phase 4's prompt(s) reuse the identical constant (and a contains-pin catches a silent drop).
export const BASELINE_FRAMING = [
  "BASELINE (working reference): a FLOOR on the outcome dimensions captured in INTENT.md — the",
  "minimum bar the build must clear — NOT a behavioral match-target to reproduce. The frozen",
  "prototype under `.plan-tree/baseline/` shows one way the floor was met; intentional improvements",
  "ABOVE the floor are good. Do NOT treat the baseline as a spec to copy.",
].join("\n");

// Root recon: delegate broad codebase/scope reconnaissance to the scope-recon subagent. When a
// confirmed `intent` is provided it is threaded in as a labeled context block ABOVE the recon
// instructions; null/empty intent yields the exact pre-feature prompt.
export function reconPrompt(request: string, intent?: string | null): string {
  return [
    ...confirmedIntentBlock(intent),
    "We are running the multiplan planning flow for this request:",
    "",
    request,
    "",
    WORKDIR_SCOPE_GUARD,
    "",
    "Use the **scope-recon** subagent to perform broad reconnaissance of the codebase and the",
    "request's scope: relevant files, modules, prior art, constraints, and risks. Return the",
    "subagent's full report verbatim as your final message — do not call any other tool.",
  ].join("\n");
}

// Sizer: delegate the decompose/size decision to the plan-sizer subagent and demand the SIZER line.
// Carries the /multiplan skill's decomposition-bias block (Gate 3) verbatim-in-spirit: without it
// the sizer under-splits greenfield multi-subsystem requests (the bias the CLI skill encodes).
// Exported so the bias prose is pinned by a contains-test (a silent drop would otherwise be invisible).
export function sizerPrompt(): string {
  return [
    "Use the **plan-sizer** subagent to decide how to decompose the request, given the recon report.",
    "Pass the recon report along with this decomposition-bias block:",
    "",
    "---DECOMPOSITION-BIAS---",
    "Greenfield projects (recon verdict: `non-repo`) with multiple subsystem concerns (rendering,",
    "physics, controls, UI, persistence, networking, audio, asset loading, etc.) should default to",
    "`split`.",
    "",
    "**Quantitative rule:** if the recon verdict is `non-repo` AND the request implicates 2 or more",
    'of those subsystems, the decision MUST be `split` unless the user\'s request contains an explicit',
    'scope-narrowing clause like "just X", "only Y", or "minimal Z".',
    "",
    "A `single` decision is only appropriate when:",
    "- The work is genuinely single-volatility (one concern, one module), OR",
    "- The user's request contains an explicit scope-narrowing clause (above), OR",
    "- An existing codebase already establishes the cross-cutting layers and the new work is one",
    "  concern within them.",
    "",
    "**Bounded-working-prototype override (DEFAULT SMALL):** when a bounded, working prototype or",
    "reference implementation already exists for the request, that is empirical proof the whole thing",
    "fits in one context. In that case bias the decision to `single` (a single-plan port). The",
    "greenfield 'request implicates 2+ subsystems => MUST split' rule above does NOT apply when such",
    "a bounded working prototype exists — do not shatter a working artifact into a layer tree. Only",
    "split if the prototype itself is genuinely too large to port in one pass. This override keys on",
    "an actual BOUNDED WORKING prototype existing — not on mere mention of a prototype, and not for",
    "genuinely large systems.",
    "",
    "When in doubt: lean split. A master plan with one or two sub-plans is easy to collapse if the",
    "user wants; an oversized single plan is painful to retroactively decompose.",
    "---END-DECOMPOSITION-BIAS---",
    "",
    "After it returns, emit exactly one line at the top level of the form:",
    "",
    "SIZER: <single|split> / <num_plans> / <confidence>",
    "",
    "e.g. `SIZER: split / 3 / 0.82`. Those are the ONLY two decisions — when uncertain, choose",
    "`split` (the master plan gate is the human checkpoint for an uncertain decomposition).",
    "",
    "Emit nothing else after the SIZER line.",
  ].join("\n");
}

// PHASE 4 (R4) — the top-level acceptance-criterion block injected into the MASTER draft prompt ONLY
// when a frozen working-reference baseline exists. It anchors on BASELINE_FRAMING (the baseline is a
// FLOOR on the OUTCOME DIMENSIONS captured in INTENT.md, NOT a behavioral match-target) and states
// the acceptance bar in OUTCOME terms — never "match the prototype" and never pinned to the
// prototype's exact numbers/behavior. It explicitly PERMITS intentional, justified divergences ABOVE
// the floor (improvements, not regressions to flag). Returns [] when no baseline exists so the
// no-baseline prompt stays BYTE-IDENTICAL (pinned by golden-depth1 + masterDraftPrompt contains-tests).
function baselineAcceptanceLines(hasBaseline: boolean): string[] {
  if (!hasBaseline) return [];
  return [
    "",
    "ACCEPTANCE CRITERION (top-level — a frozen working reference exists):",
    "",
    BASELINE_FRAMING,
    "",
    "State this as a top-level acceptance criterion of the master plan, phrased in OUTCOME terms",
    "drawn from INTENT.md (e.g. \"the core loop works end-to-end; nothing runs away; the headline",
    "mechanics all fire\"). Do NOT phrase it as \"match the prototype\" and do NOT pin it to the",
    "prototype's exact numbers or exact behavior — the bar is the intended outcome dimensions, the",
    "baseline is merely a FLOOR proving those dimensions are reachable. Intentional, justified",
    "divergences ABOVE the floor are GOOD (improvements to call out, not regressions to flag).",
  ];
}

// Decomposition draft (root: the master plan): draft the decomposition, self-review, then hold via
// ExitPlanMode. When a confirmed `intent` is provided it is threaded in as a labeled context block
// ABOVE the draft instructions; null/empty intent yields the exact pre-feature prompt (feedback
// threading is independent — both may coexist).
// PHASE 4 (R4): when `hasBaseline` is true, a top-level OUTCOME-bar acceptance criterion is injected
// (baselineAcceptanceLines). Default false ⇒ existing callers/tests are byte-unchanged.
export function masterDraftPrompt(
  request: string,
  feedback?: string,
  intent?: string | null,
  hasBaseline = false,
): string {
  const lines = [
    ...confirmedIntentBlock(intent),
    "Draft the MASTER decomposition plan for this request:",
    "",
    request,
    "",
    "Break the work into sequential sub-plans. For each, write a header of the exact form",
    "`### Sub-Plan NN: <title>` (NN is a zero-padded number, e.g. 01) followed by its scope.",
    "",
    "SLICE-FIRST (capability-first, NOT layer-first): decompose by capability / vertical slice, not",
    "by subsystem / horizontal layer. Sub-Plan 01 MUST be the thinnest runnable END-TO-END vertical",
    "slice — a thinnest-playable/usable version that actually runs — and every subsequent sub-plan",
    "MUST enhance that already-running artifact rather than add an isolated horizontal layer. This is",
    "the same vertical-slice principle the plan template already mandates.",
    ...baselineAcceptanceLines(hasBaseline),
    "Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.",
    "Then call **ExitPlanMode** with the full master plan as `plan` to hold for approval.",
  ];
  if (feedback) {
    lines.push(
      "",
      "The previous master draft was sent back with this feedback — address it fully:",
      "",
      feedback,
    );
  }
  return lines.join("\n");
}

// The structured mandate a child node carries out of its parent's decomposition. A bare string no
// longer compiles as a mandate: the section BODY (the scope paragraphs under the `### Sub-Plan NN:`
// header) and the decomposition PREAMBLE (shared context above the first header) travel WITH the
// title, so a node prompt can never silently degrade to title-only (the lost-mandate bug).
export interface Mandate {
  title: string;
  sectionBody: string;
  masterPreamble: string;
}

// Render a Mandate into the prompt lines shared by node recon and node draft: the header line, the
// decomposition section body, and (when present) the preamble as shared context. Empty/whitespace
// parts are omitted so degenerate-single mandates (no decomposition plan exists) stay minimal.
// The node id is rendered via pathKey — depth-1 byte-identical to gen-1's pad2.
function mandateLines(path: NodePath, mandate: Mandate): string[] {
  const lines = [`### Sub-Plan ${pathKey(path)}: ${mandate.title}`];
  if (mandate.sectionBody.trim()) lines.push("", mandate.sectionBody.trim());
  if (mandate.masterPreamble.trim()) {
    lines.push(
      "",
      "Master-plan preamble (shared context for every sub-plan):",
      "",
      mandate.masterPreamble.trim(),
    );
  }
  return lines;
}

// PHASE 5 — the labeled adjustment-note block threaded into the NEXT sibling's recon AND draft
// prompts after a parent review answered `ADJUST: <note>`. Returns [] when the note is null/empty
// so those prompts stay BYTE-IDENTICAL to their note-free form (pinned by parent-review.test.ts).
// Callers spread these lines directly after the mandate lines.
function adjustNoteLines(note?: string | null): string[] {
  const text = note?.trim();
  if (!text) return [];
  return ["", "Adjustment from the parent's review of the previous sibling:", "", text];
}

// Node recon: reconnaissance scoped to one node's mandate, threading prior sibling summaries forward.
// PHASE 5: `adjustNote` (the parent review's ADJUST note for THIS node) injects as a labeled block;
// null/empty yields the exact pre-Phase-5 prompt. Exported so the byte-identical pin is testable.
export function subReconPrompt(
  path: NodePath,
  mandate: Mandate,
  summaries: string[],
  adjustNote?: string | null,
): string {
  const lines = [
    `We are now working sub-plan ${pathKey(path)}. Its mandate from the master plan:`,
    "",
    ...mandateLines(path, mandate),
    ...adjustNoteLines(adjustNote),
    "",
    "Use the **scope-recon** subagent to perform reconnaissance scoped to THIS sub-plan only.",
    "",
    WORKDIR_SCOPE_GUARD,
    "",
    "Return its report verbatim as your final message — do not call any other tool.",
  ];
  appendPriorSummaries(lines, summaries);
  return lines.join("\n");
}

// PHASE 4 (R5) — the behavioral-envelope-test mandate injected into the sub-plan DRAFT and SUMMARY
// prompts ONLY when a frozen working-reference baseline exists. It is GATED on the sub-plan producing
// a runnable artifact (the prompt says "IF this sub-plan produces a runnable artifact"). The bound is
// INTENT-tied — the INTENDED envelope captured in INTENT.md — explicitly NOT the prototype's exact
// numbers. Returns [] when no baseline exists so the no-baseline prompts stay BYTE-IDENTICAL (pinned
// by golden-depth1 + sub/summary contains-tests). The three clauses map to R5 (a)/(b)/(c).
function baselineEnvelopeTestLines(hasBaseline: boolean): string[] {
  if (!hasBaseline) return [];
  return [
    "",
    "RUNNABLE-ARTIFACT REQUIREMENT (a frozen working reference exists). IF this sub-plan produces a",
    "runnable artifact, it MUST ship all three of the following:",
    "  (a) the core / simulation logic SEPARATED from rendering/DOM — importable and headless-drivable",
    "      so it can be stepped in a test without a browser or a render loop;",
    "  (b) at least ONE integrated behavioral-envelope test that ASSEMBLES the loop and drives it for",
    "      N steps, asserting an intent-tied bound — the bound comes from the INTENDED envelope in",
    "      INTENT.md (the outcome dimensions / floor), NOT from the prototype's exact numbers or its",
    "      exact behavior;",
    "  (c) a falsifiability step: temporarily BREAK the loop, confirm the envelope test goes RED, then",
    "      RESTORE it — an envelope test that cannot go red is unfalsifiable and does not count.",
  ];
}

// Node draft: draft this node's plan, self-review, then hold via ExitPlanMode. Threads prior
// summaries. PHASE 5: threads the parent review's ADJUST note exactly like subReconPrompt (the
// note lands in BOTH of the next sibling's prompts). Exported for the byte-identical pin.
// PHASE 4 (R5): when `hasBaseline` is true, the runnable-artifact envelope-test mandate is injected
// (baselineEnvelopeTestLines). Default false ⇒ existing callers/tests are byte-unchanged.
export function subDraftPrompt(
  path: NodePath,
  mandate: Mandate,
  summaries: string[],
  adjustNote?: string | null,
  hasBaseline = false,
): string {
  const lines = [
    `Draft the implementation plan for sub-plan ${pathKey(path)}. Its mandate from the master plan:`,
    "",
    ...mandateLines(path, mandate),
    ...adjustNoteLines(adjustNote),
    "",
    "Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.",
    "Then call **ExitPlanMode** with the full sub-plan as `plan` to hold for approval.",
    ...baselineEnvelopeTestLines(hasBaseline),
  ];
  appendPriorSummaries(lines, summaries);
  return lines.join("\n");
}

// Summary: after a node executes, produce its structured summary (threaded into later siblings).
// PHASE 4 (R5): when `hasBaseline` is true, the same runnable-artifact envelope-test mandate is
// injected so the summary turn reports whether the integrated behavioral-envelope test + its
// falsifiability proof actually landed. Default false ⇒ byte-unchanged from today's prompt.
// Exported so the Phase-4 gated-both-directions pin is testable directly.
export function summaryPrompt(path: NodePath, hasBaseline = false): string {
  return [
    `Sub-plan ${pathKey(path)} has finished executing. Output a concise summary with these sections:`,
    "",
    "## Changes",
    "## Findings",
    "## Next-step inputs",
    "",
    "Output ONLY the summary markdown as your final message — do not call any tool.",
    ...baselineEnvelopeTestLines(hasBaseline),
  ].join("\n");
}

// RESUME (Phase 3) — the LEAF-approval continuation prompt. On a RESUMED leaf gate the live
// ExitPlanMode resolver is dead, so approving cannot "resume the same turn into execution" the way a
// live approve does. Instead the driver sends this explicit instruction into the resumed
// conversation: implement the already-approved plan. It NAMES the plan file and FORBIDS rewriting/
// re-outputting it (the double-write guard — the plan is approved as-is; re-drafting it would burn a
// turn and risk diverging from the reviewed artifact).
export function resumedLeafApprovalPrompt(planPath: string): string {
  return [
    `The plan at ${planPath} is approved. Begin implementing it now.`,
    "Do not rewrite or re-output the plan — it is already approved as written; implement it directly.",
  ].join("\n");
}

// RESUME (Phase 3b) — the LEAF EXECUTING continuation prompt (the AUDIT-AND-CONTINUE variant). A
// leaf/executing node was killed MID-implementation: its plan is already approved AND some of its
// edits may ALREADY be on disk (invariant I3 — the executing turn may have partially applied). Unlike
// resumedLeafApprovalPrompt ("Begin implementing it now") — which would RESTART implementation from
// scratch and re-apply edits already on disk — this prompt instructs the model to FIRST inspect the
// current working tree for edits already made from this plan, then CONTINUE with only the remaining
// steps. It NAMES the plan file and explicitly FORBIDS restarting / re-applying completed edits.
export function resumedLeafContinuePrompt(planPath: string): string {
  return [
    `Implementation of the approved plan at ${planPath} was interrupted partway through and is being resumed.`,
    "Some of this plan's edits may ALREADY be applied to the working tree. Before doing anything else,",
    "inspect the CURRENT state of the working tree to determine which steps of the plan are already done.",
    "Then CONTINUE implementing ONLY the remaining, not-yet-applied steps.",
    "Do NOT restart from scratch and do NOT re-apply edits that are already present — that would duplicate",
    "or corrupt completed work. Do not rewrite or re-output the plan; it is already approved as written.",
  ].join("\n");
}

// RESUME (Phase 3) — the LEAF request-changes continuation prompt. On a RESUMED leaf gate a live
// deny (which would resume the held turn to re-draft) is impossible, so the driver sends the user's
// feedback explicitly and asks for a fresh re-draft held via ExitPlanMode (the next signal is that
// re-draft's ExitPlanMode hold, exactly as the live redraft path produces).
export function resumedLeafChangesPrompt(feedback: string): string {
  return [
    "The plan you drafted was sent back for changes. Revise it to address this feedback fully:",
    "",
    feedback,
    "",
    "Then call ExitPlanMode with the full revised plan as `plan` to hold for approval again.",
  ].join("\n");
}

// RESUME (Phase 3) — the DECOMPOSITION request-changes continuation prompt. Mirrors
// resumedLeafChangesPrompt but for a held decomposition/master gate: re-draft the DECOMPOSITION with
// the same `### Sub-Plan NN:` header contract and hold it via ExitPlanMode.
export function resumedDecompositionChangesPrompt(feedback: string): string {
  return [
    "The decomposition plan you drafted was sent back for changes. Revise it to address this",
    "feedback fully:",
    "",
    feedback,
    "",
    "Keep the `### Sub-Plan NN: <title>` header format for each sub-plan. Then call ExitPlanMode",
    "with the full revised decomposition plan as `plan` to hold for approval again.",
  ].join("\n");
}

// PHASE 4 — nested decomposition draft: a NON-ROOT split node drafts its own decomposition, scoped
// to its mandate (the nested-master preamble travels with it), then holds via ExitPlanMode exactly
// like the root's master draft. Child headers are PER-LEVEL `### Sub-Plan NN:` numbers (the full
// dotted id derives from nesting: <pathKey>.NN) — parseSubPlanHeaders is reused verbatim on the
// draft, so the 1-99 validation (deny-for-redraft on overflow) is identical at every depth.
// PHASE 4 (R4): when `hasBaseline` is true, the same top-level OUTCOME-bar acceptance criterion the
// root master draft injects (baselineAcceptanceLines) is injected at this nested master too, so a
// baseline'd tree that decomposes a sub-plan further does not lose the outcome-bar reminder. Default
// false ⇒ existing callers/tests are byte-unchanged.
export function nestedDecompositionDraftPrompt(
  path: NodePath,
  mandate: Mandate,
  summaries: string[],
  adjustNote?: string | null,
  hasBaseline = false,
): string {
  const key = pathKey(path);
  const lines = [
    `Sub-plan ${key} is itself too large for a single plan. Draft its DECOMPOSITION plan. Its mandate`,
    "from the parent plan:",
    "",
    ...mandateLines(path, mandate),
    ...adjustNoteLines(adjustNote),
    "",
    "Break THIS sub-plan's work into sequential child sub-plans. For each, write a header of the",
    "exact form `### Sub-Plan NN: <title>` (NN is a zero-padded number local to this sub-plan,",
    `e.g. 01 — the full id will be ${key}.NN) followed by its scope.`,
    "",
    "SLICE-FIRST (capability-first, NOT layer-first): decompose by capability / vertical slice, not",
    "by subsystem / horizontal layer. Child Sub-Plan 01 MUST be the thinnest runnable END-TO-END",
    "vertical slice — a thinnest-playable/usable version that actually runs — and every subsequent",
    "child sub-plan MUST enhance that already-running artifact rather than add an isolated horizontal",
    "layer. This is the same vertical-slice principle the plan template already mandates.",
    ...baselineAcceptanceLines(hasBaseline),
    "Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.",
    "Then call **ExitPlanMode** with the full decomposition plan as `plan` to hold for approval.",
  ];
  appendPriorSummaries(lines, summaries);
  return lines.join("\n");
}

// PHASE 4 — roll-up summary: after a non-root split node's LAST child summarizes, the parent gets
// its own summary turn synthesizing the children's summaries (so every completed sibling — leaf or
// split — contributes exactly ONE summary to per-level threading). The ROOT never gets this turn
// (it writes no roll-up; done is derived).
export function rollupSummaryPrompt(path: NodePath, childSummaries: string[]): string {
  const lines = [
    `All child sub-plans of sub-plan ${pathKey(path)} have finished. Output a concise ROLL-UP summary`,
    `of sub-plan ${pathKey(path)} AS A WHOLE, with these sections:`,
    "",
    "## Changes",
    "## Findings",
    "## Next-step inputs",
    "",
    "Synthesize it from the children's summaries below — do not merely concatenate them.",
    "",
    "Output ONLY the summary markdown as your final message — do not call any tool.",
  ];
  if (childSummaries.length > 0) {
    lines.push("", "Summaries of the child sub-plans (synthesize these):", "");
    for (const s of childSummaries) lines.push(s, "");
  }
  return lines.join("\n");
}

// PHASE 5 — the parent-review prompt: a NO-TOOLS turn the parent runs after a non-final child's
// summary lands. Carries the reviewed child's summary VERBATIM plus the remaining siblings'
// mandates (titles + section bodies — FROZEN: the review may only pass one adjustment note, never
// re-decompose) and the strict ADJUST/NONE output protocol parseParentReview consumes.
export function parentReviewPrompt(
  reviewedChild: NodePath,
  childSummary: string,
  remainingSiblings: ReadonlyArray<{ path: NodePath; mandate: Mandate }>,
): string {
  const lines = [
    `Sub-plan ${pathKey(reviewedChild)} has completed; its summary is below. You are the PARENT plan`,
    "reviewing that summary BEFORE the next sibling sub-plan begins. The remaining sibling mandates",
    "are FROZEN — you cannot re-decompose, reorder, or rescope them; you may only pass ONE short",
    "adjustment note into the next sub-plan's prompts.",
    "",
    `Summary of sub-plan ${pathKey(reviewedChild)} (verbatim):`,
    "",
    childSummary,
    "",
    "Remaining sibling sub-plans (mandates frozen):",
    "",
  ];
  for (const sib of remainingSiblings) {
    lines.push(`### Sub-Plan ${pathKey(sib.path)}: ${sib.mandate.title}`);
    if (sib.mandate.sectionBody.trim()) lines.push("", sib.mandate.sectionBody.trim());
    lines.push("");
  }
  lines.push(
    "Do NOT call any tool in this turn. Review the summary against the remaining mandates, then END",
    "your final message with EXACTLY ONE line of this strict form (nothing after it):",
    "",
    "ADJUST: <one short adjustment note for the next sub-plan>",
    "",
    "or, when no adjustment is needed:",
    "",
    "NONE",
  );
  return lines.join("\n");
}

// PHASE 5 — parse the parent-review turn's ADJUST/NONE protocol from the buffered assistant text.
// Scans every line; the LAST matching line wins (avoids a stray echo earlier in the turn).
//   `ADJUST: <note>` (non-empty note) → { note }   |   `NONE` → { note: null }
// Returns null when NO line matches (including a bare/empty `ADJUST:`) — the DRIVER coerces that
// to NONE with a loud diag, never fatally (a garbled review must not kill the run).
export function parseParentReview(text: string): { note: string | null } | null {
  let result: { note: string | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const adjust = /^\s*ADJUST:\s*(.*\S)\s*$/i.exec(line);
    if (adjust) {
      result = { note: adjust[1] };
      continue;
    }
    if (/^\s*NONE\s*$/i.test(line)) result = { note: null };
  }
  return result;
}

function appendPriorSummaries(lines: string[], summaries: string[]): void {
  if (summaries.length === 0) return;
  lines.push("", "Summaries of the sub-plans completed so far (use them as context):", "");
  for (const s of summaries) lines.push(s, "");
}

// Exhaustiveness sentinel: reached only if a discriminated-union case is missing from a switch.
// Because every case `return`s, a missing branch leaves the discriminant non-`never` at this call —
// a compile-time error — and, defensively at runtime, throws.
function assertNever(x: never): never {
  throw new Error(`unreachable discriminant: ${String(x)}`);
}

// The decomposition plan, parsed into its shared preamble + per-child sections (header, title, body
// span).
export interface ParsedMasterPlan {
  // Everything ABOVE the first sub-plan header — shared context threaded into every child's mandate.
  preamble: string;
  subplans: Array<{ nn: Nn; title: string; body: string }>;
}

// Parse `### Sub-Plan NN: <title>` headers (case-insensitive) from a decomposition plan body into
// the ordered {nn,title,body} sections CHILDREN_PARSED + the per-child Mandates consume. `body` is
// the section span between this header and the next (or end of plan). The matcher stays at \d{1,3}
// ON PURPOSE: a header like `Sub-Plan 100` MUST match and then fail parseNn LOUDLY (a decomposition
// validation error the driver surfaces) — narrowing the regex to \d{1,2} would silently DROP it,
// truncating the decomposition.
export function parseSubPlanHeaders(plan: string): ParsedMasterPlan {
  const raw: Array<{ nnText: string; title: string; start: number; bodyStart: number }> = [];
  const re = /^\s*#{1,6}\s*Sub-Plan\s+(\d{1,3})\s*[:\-—]\s*(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plan)) !== null) {
    raw.push({ nnText: m[1], title: m[2].trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  // INV-2: ZERO `### Sub-Plan NN:` headers is a RECOVERABLE validation failure (the O1 header-less
  // draft), of the SAME typed class as the nn>99 case below. Throwing HERE — before the empty array
  // could reach the CHILDREN_PARSED reducer's nonEmpty boundary — lets the orchestrator's
  // `instanceof PlanValidationError` catch deny the held ExitPlanMode for a redraft (run stays
  // active) instead of FATALing. (nonEmpty also throws PlanValidationError as a backstop.)
  if (raw.length === 0) {
    throw new PlanValidationError(
      "master plan validation failed: the decomposition draft contains no `### Sub-Plan NN: <title>` " +
        "headers — redraft it with at least one sub-plan section using that exact header format",
    );
  }
  const subplans = raw.map((h, i) => {
    const n = Number.parseInt(h.nnText, 10);
    let nn: Nn;
    try {
      nn = parseNn(n);
    } catch {
      throw new PlanValidationError(
        `master plan validation failed: header "Sub-Plan ${h.nnText}: ${h.title}" is outside the ` +
          "supported 1-99 sub-plan range — redraft the master decomposition with at most 99 sub-plans",
      );
    }
    const bodyEnd = i + 1 < raw.length ? raw[i + 1].start : plan.length;
    return { nn, title: h.title, body: plan.slice(h.bodyStart, bodyEnd).trim() };
  });
  const preamble = plan.slice(0, raw[0].start).trim();
  return { preamble, subplans };
}

// ---- injected dependency interface (mirror ComposerInvoker) ---------------------------------

// Every Tauri command an Effect needs, wrapped so tests inject fakes. `defaultDeps()` binds these
// to real `invoke(...)`. Async throughout — the driver awaits each effect in order.
export interface OrchestratorDeps {
  // start_agent_session({ cwd, permissionMode, resumeSessionId? }). RESUME (Phase 3): the optional
  // `resumeSessionId` is forwarded to Rust as `resumeSessionId` (camelCase → Rust `resume_session_id`
  // → sidecar `"resume"`). Absent/undefined ⇒ a fresh session (omitted from the invoke args, never
  // sent as `undefined`). start() never passes it; resume() passes state.sdk_session_id (which may
  // itself be undefined → fresh, the expired-transcript fallback the sidecar handles).
  startSession(args: { cwd: string; permissionMode: string; resumeSessionId?: string }): Promise<void>;
  // send_agent_message({ text }) — or, for the multimodal first-turn send, send_agent_message({ text,
  // images }). `images` is OPTIONAL and OMITTED-WHEN-EMPTY: every text-only send (all but the first
  // intent send) passes no `images` arg, so defaultDeps forwards the byte-identical `{ text }` shape.
  sendMessage(text: string, images?: AttachedImage[]): Promise<void>;
  // set_agent_permission_mode({ mode }) — only the two derived write policies are ever asserted.
  setMode(mode: WritePolicy): Promise<void>;
  // resolve_tool_permission({ id, allow, message?, updatedInput? })
  resolvePermission(args: {
    id: string;
    allow: boolean;
    message?: string;
    updatedInput?: unknown;
  }): Promise<void>;
  // cancel_agent_run() — used by cancel()/teardown alongside endSession.
  cancelRun(): Promise<void>;
  // cancel_agent_run() — the TURN-INTERRUPT boundary. The Rust command sends `{type:"interrupt"}`
  // to the sidecar, which calls the SDK query's `interrupt()` (Query.interrupt, sdk.d.ts): the
  // in-flight turn is aborted and emits its terminal `result` frame (an SDKResultError, subtype
  // `error_during_execution`) — the sidecar normalizes EVERY result subtype to a `result` frame, so
  // the resuming consume-path accepts it. A distinct dep from cancelRun (same wire command) so the
  // call sites — and the tests asserting interrupt IS/IS-NOT fired — read as intent, not teardown.
  interrupt(): Promise<void>;
  // end_agent_session()
  endSession(): Promise<void>;
  // plan_tree::write_plan_tree_file({ cwd, name, contents }) -> the absolute path written.
  writePlanTreeFile(cwd: string, name: string, contents: string): Promise<string>;
  // PHASE 6 — plan_tree::delete_plan_tree_file({ cwd, name }) — delete <cwd>/.plan-tree/<name>,
  // containment-guarded + allow-list-validated EXACTLY like writePlanTreeFile (it reuses the same
  // guarded_plan_tree_path). Absent file ⇒ graceful no-op (Ok), never an error. Used by the refine
  // branch to clear each reset node's NN-plan.md / NN-summary.md so the re-run overwrites a clean
  // slate. OPTIONAL + additive (like the resume/baseline seams) so pre-Phase-6 fakes still compile;
  // absent ⇒ the driver skips the delete (the overwrite-on-re-run still corrects the summary).
  deletePlanTreeFile?(cwd: string, name: string): Promise<void>;
  // plan_tree::read_plan_tree_file({ cwd, name }) -> the file's text, or null when it does not exist
  // (the Rust command returns Option<String>). RESUME (Phase 3): used to reload the non-serialized
  // driver state (summaries, mandates) from the on-disk .plan-tree/ artifacts on resume(). OPTIONAL
  // like the prototype/timer seams so pre-resume fakes still compile; absent ⇒ the reload is skipped
  // (the resumed run threads no prior summaries/mandates — degraded, not broken).
  readPlanTreeFile?(cwd: string, name: string): Promise<string | null>;
  // read_plan_contents({ path }) -> the plan file's text. Unlike readPlanTreeFile (the `.plan-tree/`
  // allow-listed channel), this reads the PLANS STORE by absolute `~/.claude/plans/...` path — the
  // channel a LEAF plan lives in (writeAgentPlan writes leaf plans into `~/.claude/plans/`, NOT
  // `.plan-tree/`). The Rust command REJECTS (throws — not Ok(None)) on a missing/out-of-bounds path.
  // RESUME (Phase 3b): the leaf/executing audit-and-continue verifies the leaf's durable plan through
  // THIS, keyed by the node's absolute planPath — reading it through readPlanTreeFile would ALWAYS
  // miss (the file is not under `.plan-tree/`, and the Rust allow-list rejects an absolute name).
  // OPTIONAL like the other resume seams so pre-Phase-3b fakes still compile; absent ⇒ the durable
  // check is skipped (the continuation proceeds on the node's planPath, the same trust the gate path
  // gives planPath).
  readPlanContents?(path: string): Promise<string>;
  // plan_tree::reset_plan_tree_dir({ cwd }) — archive every current <cwd>/.plan-tree/ entry into
  // .plan-tree/.archive/ (replacing any prior archive). Run by START before the genesis persist.
  resetPlanTreeDir(cwd: string): Promise<void>;
  // ensure_prototype_dir({ cwd }) -> the absolute prototype dir path. Creates
  // <cwd>/.plan-tree/prototype/ (idempotent) BEFORE the visual-mode intent prompt is sent, so the
  // clarifier never needs Bash/mkdir (the sidecar's "prototype" policy only allows writes UNDER the
  // dir — it cannot create it). OPTIONAL like the timer seam: fakes that predate the
  // visual-prototype loop still compile; absent ⇒ the driver skips the call.
  // (The Rust command lands in a parallel task — defaultDeps just wires the invoke.)
  ensurePrototypeDir?(cwd: string): Promise<string>;
  // BASELINE FREEZE (Phase 3): create + populate <cwd>/.plan-tree/baseline/ when the user marks the
  // visual prototype a "working reference". ensureBaselineDir creates the contained dir;
  // freezeBaseline recursively copies the prototype subtree into it (both Rust-side containment-
  // guarded). OPTIONAL like ensurePrototypeDir so pre-baseline fakes still compile; absent ⇒ the
  // driver skips the freeze and records NO baseline_ (a presence record must match disk — the recon
  // hop still proceeds, but no baseline is claimed when the freeze did not actually run).
  ensureBaselineDir?(cwd: string): Promise<string>;
  freezeBaseline?(cwd: string): Promise<string>;
  // PHASE 5 — open a frozen-baseline artifact in the OS default handler (the Rust `open_baseline`
  // command; `path` is relative to <cwd>/.plan-tree/baseline/, containment-guarded Rust-side). The
  // forced-acceptance gate calls this so the user can exercise the baseline against the just-built
  // result. OPTIONAL like the other baseline seams: absent ⇒ the gate still surfaces, but the
  // "open baseline" step is skipped (the verdict actions remain available).
  openBaseline?(cwd: string, path: string): Promise<void>;
  // write_agent_plan({ plan, treeId, nn }) -> the absolute path written. `nnPath` is null for the
  // root decomposition plan (flavor master, for sidebar nesting), else the node's canonical
  // zero-padded dotted PathKey string ("01", "02.01", …). Phase 2 wire: the Rust side takes
  // Option<String> and REJECTS a bare JSON number — every caller must send the string form.
  writeAgentPlan(plan: string, treeId: string, nnPath: string | null): Promise<string>;
  // INJECTABLE TIMER SEAM (optional — defaults to the global timers): the resume watchdog schedules
  // through these so tests fire/inspect it without sleeping. The handle type is opaque (`unknown`)
  // so DOM-number and Node-Timeout environments both fit.
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  // INJECTABLE CLOCK SEAM (optional — defaults to Date.now): the driver stamps `updated_ms` at its
  // single persist path through this, so every ledger write carries a fresh timestamp and tests
  // assert monotonicity without sleeping.
  now?(): number;
}

// Bind the dependency interface to the real Tauri commands (the same `invoke` the rest of the code
// uses). Tests never call this — they inject a fake OrchestratorDeps instead.
export function defaultDeps(): OrchestratorDeps {
  return {
    startSession: (args) =>
      // Resolve the header-picker selection (reads localStorage directly) and forward
      // model/effort to Rust. Key-omission: `resolveModelOptions` returns a fresh
      // {model, effort?} with NO effort key when absent, so spreading it never sends
      // `effort: undefined`. The OrchestratorDeps.startSession interface stays narrow
      // ({cwd, permissionMode}) — this resolution lives only in the impure adapter.
      invoke("start_agent_session", {
        cwd: args.cwd,
        permissionMode: args.permissionMode,
        // RESUME (Phase 3): forward `resumeSessionId` only when present (key-omission otherwise, so a
        // fresh start never sends `resumeSessionId: undefined`). Rust maps it to `resume_session_id`.
        ...(args.resumeSessionId !== undefined ? { resumeSessionId: args.resumeSessionId } : {}),
        ...resolveModelOptions(),
      }).then(() => undefined),
    sendMessage: (text, images) =>
      invoke(
        "send_agent_message",
        images && images.length ? { text, images } : { text },
      ).then(() => undefined),
    setMode: (mode) => invoke("set_agent_permission_mode", { mode }).then(() => undefined),
    resolvePermission: (args) =>
      invoke("resolve_tool_permission", {
        id: args.id,
        allow: args.allow,
        message: args.message ?? null,
        updatedInput: args.updatedInput ?? null,
      }).then(() => undefined),
    cancelRun: () => invoke("cancel_agent_run").then(() => undefined),
    // Same Tauri command as cancelRun: `cancel_agent_run` IS the graceful q.interrupt() of the
    // current turn (agent.rs sends {type:"interrupt"} to the sidecar). See the interface comment.
    interrupt: () => invoke("cancel_agent_run").then(() => undefined),
    endSession: () => invoke("end_agent_session").then(() => undefined),
    writePlanTreeFile: (cwd, name, contents) =>
      invoke<string>("write_plan_tree_file", { cwd, name, contents }),
    deletePlanTreeFile: (cwd, name) =>
      invoke("delete_plan_tree_file", { cwd, name }).then(() => undefined),
    readPlanTreeFile: (cwd, name) =>
      invoke<string | null>("read_plan_tree_file", { cwd, name }),
    readPlanContents: (path) => invoke<string>("read_plan_contents", { path }),
    resetPlanTreeDir: (cwd) => invoke("reset_plan_tree_dir", { cwd }).then(() => undefined),
    ensurePrototypeDir: (cwd) => invoke<string>("ensure_prototype_dir", { cwd }),
    ensureBaselineDir: (cwd) => invoke<string>("ensure_baseline_dir", { cwd }),
    freezeBaseline: (cwd) => invoke<string>("freeze_baseline", { cwd }),
    openBaseline: (cwd, path) => invoke("open_baseline", { cwd, path }).then(() => undefined),
    writeAgentPlan: (plan, treeId, nnPath) =>
      invoke<string>("write_agent_plan", { plan, treeId, nn: nnPath }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

// ---- observer + handle (frozen public surface) ----------------------------------------------

// The observer the renderer/main.ts subscribes to. Every hook is optional so a partial observer
// compiles. These are fired by the matching notify* effects + onSnapshot after every transition.
export interface OrchestratorObserver {
  // Fired after EVERY transition with the fresh snapshot (so the UI can re-render).
  onSnapshot?(snap: PlanTreeSnapshot2): void;
  // A node is awaiting the user's approval — the UNIFIED gate (decomposition AND leaf; the root
  // decomposition gate included — the gen-1 nn:-1 sentinel is gone).
  onAwaitingApproval?(gate: ApprovalGate2): void;
  // A held AskUserQuestion is awaiting the user's answers.
  onClarify?(clarify: ClarifyGate): void;
  // A visual prototype is awaiting the user's review (the root prototype gate). Fired by the
  // notifyPrototypeReview effect; resolved via approvePrototype()/refinePrototype() — by TURN
  // COMPLETION, not a held tool, so there is nothing to purge on cancel.
  onPrototypeReview?(gate: PrototypeGate): void;
  // PHASE 5 — the forced acceptance gate is awaiting the user's verdict against the frozen baseline.
  // Fired by the notifyAcceptanceReview effect (the driver has already opened the baseline). The run
  // is built but NOT done — notifyDone is withheld until approveAcceptance()/divergeAcceptance().
  // `gate` is the driver-AUGMENTED AcceptanceGate (cwd/openTarget/runCommand filled in). Like the
  // prototype gate, resolution is by an explicit user action, not a held tool — nothing to purge.
  onAcceptanceReview?(gate: AcceptanceGate): void;
  // A node's summary was written. `summaryPath` is the written FILE's real path (write-minted
  // brand) — never the summary text.
  onSummaryWritten?(path: NodePath, summaryPath: PlanTreeFilePath): void;
  // The whole tree finished (terminal). `snap` is the final snapshot.
  onDone?(snap: PlanTreeSnapshot2): void;
  // A fatal error occurred (terminal). The driver tears down after dispatching this.
  onFatal?(message: string): void;
}

// The frozen handle main.ts / the renderer hold to drive the orchestration.
export interface OrchestratorHandle {
  // Begin a run for `request` rooted at `cwd`. Idempotent-guarded: a second call while active is a
  // no-op. Stores `cwd` for all subsequent .plan-tree/ writes. Returns true when a run was really
  // started, false when this was the idempotent no-op (so the composer can avoid closing on a dead
  // start). On a real start it opens the SDK session and sends the first (intent) prompt.
  start(args: { cwd: string; request: string; images?: AttachedImage[] }): Promise<boolean>;
  // RESUME (Phase 3): continue a non-terminal plan-tree from disk WITHOUT reset. Mirrors start() but
  // does NOT dispatch START and does NOT call resetPlanTreeDir — it seeds `state` from the ledger
  // (rehydrateState2), reloads non-serialized driver state (summaries/mandates) from the on-disk
  // .plan-tree/ artifacts, opens the SDK session in the DERIVED policy resuming the prior transcript
  // (resumeSessionId: ledger.sdk_session_id), and either re-presents the held approval gate purely
  // from disk or re-sends the current step's prompt. Idempotent-guarded like start(): a call while a
  // run is active returns false. Returns false (no run started) when the ledger's active phase is not
  // resumable (the frontend should not offer Resume for those, but guard anyway).
  resume(args: { cwd: string; ledger: RecursiveLedger }): Promise<boolean>;
  // The current read-only snapshot (throws if never started).
  snapshot(): PlanTreeSnapshot2;
  // Approve the HELD gate addressed by its pathKey string (the UNIFIED approve surface — routes by
  // gate.kind: a decomposition approval arms the resuming hold + interrupts; a leaf approval
  // resolves + arms exec and NEVER interrupts). Throws loudly if the key parses to a path no held
  // gate matches.
  approve(pathKeyStr: string): Promise<void>;
  // Request changes to the HELD gate addressed by its pathKey string (denies with feedback; the
  // deny resumes the held turn to re-draft in place — NOTHING is sent inline).
  requestChanges(pathKeyStr: string, feedback: string): Promise<void>;
  // Answer a held AskUserQuestion (resolves it with the user's selections).
  answerClarify(toolUseId: string, answers: AskUserQuestionAnswers): Promise<void>;
  // Approve the held visual prototype: composes + writes INTENT.md (prose + the embeddable-visual
  // block) via PROTOTYPE_APPROVED, then continues into recon exactly like INTENT_CLARIFIED's
  // continuation. Throws loudly when no prototype gate is pending.
  //
  // WORKING-REFERENCE classification (Phase 3): pass { asWorkingReference: true } when the user
  // marked the prototype a "working reference" (a FLOOR on the outcome dimensions, never a match-
  // target) rather than the default "just a sketch". On true the driver freezes
  // .plan-tree/prototype/ → .plan-tree/baseline/ and records the frozen baseline on the ledger; the
  // default (omitted/false) is byte-identical to the prior behavior (nothing is frozen).
  approvePrototype(opts?: { asWorkingReference?: boolean }): Promise<void>;
  // Send the held prototype back for another round with the user's feedback: dispatches
  // PROTOTYPE_REFINED (root loops to clarifying-intent), re-arms the intent turn, and sends the
  // refine prompt. The session is idle (the intent turn already ended) — no interrupt. Throws
  // loudly when no prototype gate is pending.
  //
  // COMBINED apply-and-approve: pass { autoApprove: true } when the user typed feedback AND clicked
  // approve. The driver loops the prototype back for one round (applying the feedback) but arms an
  // internal latch so the revised prototype block auto-resolves the gate forward to recon WITHOUT
  // surfacing another review round. The flag is driver-owned — never model/agent-controlled.
  refinePrototype(feedback: string, opts?: { autoApprove?: boolean }): Promise<void>;
  // PHASE 5 — RESOLVE THE FORCED ACCEPTANCE GATE (baseline-bearing runs only). Both perform the
  // deferred finalize (root → summarized + notifyDone) and clear the gate; the verdict is recorded on
  // the ledger (acceptance_). Throw loudly when no acceptance gate is pending.
  //   - approveAcceptance(): the built result clears the baseline floor.
  //   - divergeAcceptance(reason): the user accepts a result below the floor and records WHY (the
  //     reason is persisted as the audit trail).
  approveAcceptance(): Promise<void>;
  divergeAcceptance(reason: string): Promise<void>;
  // PHASE 6 — RE-PLAN (refine) a chosen sub-plan from the forced acceptance gate (the THIRD gate
  // action, beside approve and accept-divergence). `target` is the sub-plan to re-plan (a direct root
  // child today — the top-level sub-plans the gate surfaces). RESETS the target node AND its
  // right-siblings to a fresh re-execution shape (the target re-runs recon→draft→exec→summary and its
  // right-siblings re-run after it), deletes their stale on-disk NN-plan.md/NN-summary.md, clears the
  // gate, and records NO verdict. The re-run OVERWRITES the reset nodes' summaries; on the tree's
  // re-completion the acceptance gate RE-ARMS automatically. Throws loudly when no acceptance gate is
  // pending.
  refineAcceptance(target: NodePath): Promise<void>;
  // Feed a live agent-stream frame to the turn-completion sequencer (see the Sequencing rule).
  ingestStream(frame: AgentStream): Promise<void>;
  // Feed a live tool-permission-requested frame (ExitPlanMode / AskUserQuestion) to the driver.
  ingestPermission(req: ToolPermissionRequested): Promise<void>;
  // Cancel the run: cancel the turn + end the session + purge any held interactive permission. The
  // on-disk ledger is left intact.
  cancel(): Promise<void>;
  // Subscribe an observer; returns an unsubscribe fn.
  subscribe(obs: OrchestratorObserver): () => void;
  // Tear down: unsubscribe all observers + cancel. Idempotent.
  teardown(): Promise<void>;
  // True between start and a terminal done/cancel/fatal.
  orchestrationActive(): boolean;
  // INTERNAL READ-ONLY PROBE (not part of the public UI contract): true iff the sequencer currently
  // holds the `{tag:"resuming"}` arm — i.e. the orchestrator deliberately interrupted the in-flight
  // post-decomposition-approval turn and is waiting on its aborted `result`. index.ts's result
  // tagger consults this (via isOrchestratorResuming()) AT INGEST to mark that aborted result as a
  // deliberate interrupt rather than a genuine failure.
  resuming(): boolean;
  // INTERNAL FUNNEL (not part of the public UI contract): feed a reducer event directly. The handle
  // methods call this; the live agent-stream listener (later sub-plan) will too, and tests script a
  // run through it. Exposed so events with no public method (NODE_RECON_DONE, SIZER_DONE, …) are
  // drivable.
  dispatch(event: PlanTreeEvent2): Promise<void>;
}

// ---- module-level active-guard registry -----------------------------------------------------
//
// Legacy handlers (main.ts, index.ts) don't hold the handle, but must know whether an orchestration
// owns the interactive-tool seam. An active orchestrator registers ITSELF here on start and
// deregisters on any terminal (done/cancel/fatal). The accessor reads this registry. We intentionally
// allow at most ONE active orchestration at a time (the app is single-session); registering a second
// while one is active is prevented by the per-handle idempotency guard.

let activeOrchestrator: OrchestratorHandle | null = null;

// Consult the guard WITHOUT holding the handle. main.ts / index.ts import this to decide whether to
// early-return (the orchestrator owns the seam) in their tool-permission handlers.
export function isOrchestrationActive(): boolean {
  return activeOrchestrator !== null;
}

// True iff the ACTIVE orchestration's sequencer holds the `resuming` arm (a deliberate
// post-decomposition-approval interrupt is in flight). Null-safe: false when no orchestration is
// active. index.ts consults this AT INGEST to tag the interrupted turn's error `result` on the
// stored frame — the tag MUST be persisted there, because the orchestrator de-arms `resuming` the
// moment it consumes that result (reading this live at derive/render time would lose the verdict
// on every later rebuild).
export function isOrchestratorResuming(): boolean {
  return activeOrchestrator !== null && activeOrchestrator.resuming();
}

// ---- the driver -----------------------------------------------------------------------------

// Construct an orchestrator. `deps` defaults to the real Tauri-bound deps; tests inject fakes.
export function createOrchestrator(deps: OrchestratorDeps = defaultDeps()): OrchestratorHandle {
  // The current in-memory state (null until start). Every transition replaces it via dispatch().
  let state: PlanTreeState2 | null = null;
  // The cwd for all .plan-tree/ writes (captured at start).
  let cwd = "";
  // Whether this orchestration is active (true between start and terminal).
  let active = false;
  // Observers + a held interactive permission id (for purge on cancel).
  const observers = new Set<OrchestratorObserver>();
  // The id of any currently-held interactive permission (ExitPlanMode/AskUserQuestion) so cancel()
  // can purge it (deny) rather than strand the sidecar's held resolver.
  let heldPermissionId: string | null = null;
  let torn = false;

  // ---- driver-owned sequencer state (NOT part of the frozen reducer/ledger) ------------------
  //
  // THE SEQUENCER, in one discriminated union. `awaiting` is the step whose turn-completion `result`
  // the driver is waiting on; it CARRIES that step's own assistant-text buffer (and captured path,
  // where the step is per-node). Three illegal states a split step-flag + shared text-buffer pair
  // could represent are now UNREPRESENTABLE by construction:
  //   • swallow: a `result` while `{tag:"idle"}` is dropped (no armed step to advance);
  //   • double-advance: each branch reads ITS OWN buffer/path and re-arms exactly one successor;
  //   • buffer-merge: assistant_text appends to the CURRENT variant's buffer only, never a shared
  //     one, so one step's chatter can never leak into the next step's capture.
  // The ingest queue (handle.ingestStream/ingestPermission) serializes frames so these invariants
  // hold even under concurrent delivery.
  //
  // GEN-2 RE-KEY: every per-node variant carries the node's NodePath. `recon` UNIFIES the gen-1
  // root recon (path []) and sub-recon (path [nn]) variants — the consume branch routes on
  // path.length.
  type Awaiting =
    | { tag: "idle" } // a `result` here is SWALLOWED by construction
    | { tag: "intent"; buffer: string }
    | { tag: "recon"; path: NodePath; buffer: string }
    | { tag: "sizer"; path: NodePath; buffer: string }
    | { tag: "exec"; path: NodePath; buffer: string } // buffer is unread by design
    | { tag: "summary"; path: NodePath; buffer: string }
    // PHASE 5 — THE PARENT-REVIEW TURN: armed after a non-final child's SUMMARY_WRITTEN moved the
    // parent to `reviewing`. The buffer captures the review turn's ADJUST/NONE protocol text;
    // `reviewedChild` is the just-summarized child (its summary rode the prompt). Consumed by the
    // parent-review branch below: PARENT_REVIEW_DONE + the next child's recon sent INLINE (the
    // review result IS the boundary — nothing is in flight, so no resuming arm).
    | { tag: "parent-review"; parentPath: NodePath; reviewedChild: NodePath; buffer: string }
    // RESUMING: a turn is still in flight after a DECOMPOSITION approval-resolve (the SDK resumes
    // the SAME turn on allow, with its canned "start coding" injection). The next step — the recon
    // turn for `nextPath` — is DEFERRED: it is sent only when that in-flight turn's `result`
    // arrives (the `resuming` branch below). Sending it inline would queue it INTO the in-flight
    // turn (the no-gate incident: a whole sub-plan implemented in one merged turn). The resumed
    // turn must NOT be left to finish voluntarily either — the model has just been told "start
    // coding" and will free-run (the live phase-1 incident: background impl agents spawned, no
    // result for minutes, watchdog FATAL) — so the decomposition-approve branch of approve()
    // interrupts it (deps.interrupt) right after arming this hold; the interrupted turn's aborted
    // `result` is the boundary that fires the deferred send. The tag itself is the disambiguator:
    // a `result` landing here can ONLY mean "the resumed turn ended", never a
    // recon/sizer/exec/summary boundary. No buffer — resume-turn chatter is dropped by design (it
    // must not leak into the deferred step's capture).
    | { tag: "resuming"; nextPath: NodePath };
  // The original request (threaded into draft prompts) and a per-node mandate map.
  let request = "";
  // The current armed step + its own buffer (idle = no armed step). See the sequencer header above.
  let awaiting: Awaiting = { tag: "idle" };
  // pathKey -> the completed node's summary text (threaded forward into later sibling prompts).
  // Keyed by the branded PathKey so a bare string cannot address it.
  const summaries = new Map<PathKey, string>();
  // pathKey -> the node's structured Mandate, rebuilt from the decomposition plan body at every
  // decomposition ExitPlanMode parse (so re-drafts replace stale sections). Empty in the degenerate
  // single path (no decomposition plan exists) — mandateFor falls back to a title-only Mandate from
  // the tree.
  let mandates = new Map<PathKey, Mandate>();
  // toolUseId -> the AskUserQuestion's questions (retained for the CLARIFY_ANSWERED updatedInput
  // reshape; the reducer nulls pendingClarify before the effect runs, so state can't supply them).
  const clarifyQuestions = new Map<string, AskUserQuestionItem[]>();
  // The confirmed intent (the intent-clarifier's final message), captured at the intent boundary and
  // threaded into the planning-decision prompts (recon + decomposition-draft). null when no/empty
  // intent was confirmed — in which case those prompts are byte-identical to their pre-feature form.
  let confirmedIntent: string | null = null;
  // VISUAL-PROTOTYPE driver state (transient, never persisted — same boundary as confirmedIntent):
  // the prose intent captured alongside a held prototype (composeIntentMd's first argument at
  // approvePrototype), and the DRIVER-OWNED refinement-round counter. ROUND DISCIPLINE
  // (documented): prototypeRound counts COMPLETED refine requests — reset to 0 in start(),
  // incremented ONLY in refinePrototype() (never clarifier-supplied), and the gate is minted with
  // round = prototypeRound + 1 (1-based "which prototype round produced this gate"). So the first
  // gate is round 1, the gate after one refine is round 2, and after 3 refines the gate carries
  // round 4 ≥ 3 REGARDLESS of anything the clarifier outputs — the UI's loop-escape threshold
  // ("after 3 rounds always offer proceed-as-is") can never be gamed by model output.
  let pendingIntentText: string | null = null;
  let prototypeRound = 0;
  // COMBINED apply-and-approve driver flag (transient, driver-owned — NEVER model/agent-controlled,
  // same boundary as prototypeRound). When the user types feedback AND clicks approve,
  // refinePrototype(feedback, { autoApprove: true }) loops the prototype back for one more round
  // BUT arms this flag so that, when the revised prototype block arrives at the intent-ingestion
  // branch, the driver auto-resolves the gate forward (PROTOTYPE_READY → PROTOTYPE_APPROVED → recon)
  // WITHOUT surfacing another review round. Reset to false everywhere prototypeRound is reset.
  let autoApproveNext = false;
  // RESUME SUPPORT — the SDK session_id captured off the system_init frame. Held in a plain driver
  // variable the instant the frame arrives (so the id is never lost even if the dispatch below is
  // a no-op), in parallel with the ledger's self-persisted sdk_session_id (SESSION_INITIALIZED).
  let sdkSessionId: string | null = null;
  // RESUME (Phase 3) — THE resumed-gate flag. When resume() re-presents an approval gate purely from
  // disk (no live ExitPlanMode is held — the sidecar's held resolver died with the prior process),
  // the gate's toolUseId is a SYNTHETIC `"resumed:<pathKey>"` sentinel, NOT a live permission id.
  // At most ONE gate is ever pending (single-session), so a single boolean disambiguates the held
  // gate's provenance. approve()/requestChanges() read it to take the resumed continuation-prompt
  // path (send an explicit prompt into the resumed conversation) instead of resolving the dead id.
  // This is DELIBERATELY a driver-local transient — it is never serialized into the ledger (the
  // ApprovalGate2 type is owned by Phase 1/2 and the field would otherwise ride clone2/state.json).
  // Set when resumeActionForPhase reconstructs a gate; cleared the moment that gate resolves.
  let resumedGate = false;
  // PHASE 5 — THE single pending adjustment note from the most recent parent review (driver-side
  // only, NEVER persisted — same boundary as summaries/mandates). Deliberately a single nullable
  // field, NOT a Map: at most one note can be pending by construction (the review turn sits
  // between the reviewed child and the next sibling — no second review can run before the note is
  // consumed). `parentKey` scopes it: only children of THAT parent (adjustNoteFor) ever see it.
  // LIFECYCLE: set (or nulled, on NONE) at every PARENT_REVIEW_DONE; injected into the next
  // child's recon AND draft prompts; CLEARED when that child's DRAFTED event (NODE_DRAFTED or a
  // nested DECOMPOSITION_DRAFTED) is dispatched — i.e. after BOTH prompt injections have been sent.
  let adjustNote: { parentKey: PathKey; note: string } | null = null;
  // DERIVED WRITE POLICY tracking: the last permission mode this driver KNOWS the session is in.
  // The session opens in plan mode (start()); `null` means UNKNOWN — set whenever an ExitPlanMode is
  // resolved allow (the SDK exits plan mode out-of-band on approval), forcing the next dispatch to
  // re-assert writePolicyFor2(state.root). Mode is a PURE function of the ledger; this is only the
  // cache that avoids redundant set_agent_permission_mode calls.
  let assertedPolicy: WritePolicy | null = "plan";
  // TURN WATCHDOG (one shared slot — only one turn is ever in flight): the live timer handle armed
  // alongside every `{tag:"resuming"}` hold AND (PHASE 5, DA P4 follow-up) every `summary` and
  // `parent-review` turn. If the awaited turn's `result` never arrives, a silently-stuck hold
  // would hang the run with no terminal signal — so the watchdog drives it to a LOUD terminal
  // FATAL instead (through the same serialized-queue + notifyFatal path enqueueIngest uses for a
  // throwing frame). Cleared when a result consumes the armed variant, when a new arm replaces it,
  // and at every terminal (Stop / FATAL / done via markTerminal).
  let turnWatchdog: unknown = null;
  // TEST-ONLY OBSERVABILITY: how many ingest-impl thunks the queue actually DEQUEUED and INVOKED (each
  // impl bumps this at its very top, BEFORE the terminal guard). Lets the error-isolation test prove a
  // throw in one frame did NOT poison the queue — the next frame's thunk still ran up to the guard —
  // independently of whether the guard then suppressed its effects. NOT part of the frozen UI contract.
  let ingestSeen = 0;

  // PHASE 4 — PER-LEVEL summary threading: the summaries of `parentPath`'s DIRECT children only,
  // in pathKey order (PathKeys are fixed-width zero-padded per segment, so lexicographic order ==
  // per-segment numeric order). A nested level threads ONLY its own siblings: 02.02's prompts see
  // 02.01's summary but never 01's; a later ROOT sibling sees 02's ROLL-UP summary (one entry per
  // completed sibling), never the grandchildren's. The map stays keyed by full PathKey — roll-up
  // summaries land under the parent's own key by the same summaries.set the leaves use.
  const priorSummaries = (parentPath: NodePath): string[] => {
    const parentKey = pathKey(parentPath);
    const prefix = parentKey === "" ? "" : `${parentKey}.`;
    return [...summaries.entries()]
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("."))
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, text]) => text);
  };

  // The parent path of a node (the level its sibling summaries thread at). Root has no parent —
  // callers never ask (the root threads no sibling summaries).
  const parentPathOf = (path: NodePath): NodePath => path.slice(0, -1);

  // PHASE 5 — the pending adjustment note FOR a node's prompts: non-null only when a note is
  // pending AND `path` is a child of the parent that issued it (the parentKey scope guard — a
  // stale note can never leak into another level's prompts). Root prompts never carry one.
  const adjustNoteFor = (path: NodePath): string | null => {
    if (!adjustNote || path.length === 0) return null;
    return adjustNote.parentKey === pathKey(parentPathOf(path)) ? adjustNote.note : null;
  };

  // PHASE 5 — the adjust-note CLEAR POINT (see the adjustNote lifecycle note): called when a
  // child's DRAFTED event lands. By then BOTH prompt injections (the child's recon and draft
  // prompts) have been sent, so the note has fully served its one-sibling scope.
  const clearAdjustNoteOnDraft = (path: NodePath): void => {
    if (adjustNote && path.length > 0 && adjustNote.parentKey === pathKey(parentPathOf(path))) {
      adjustNote = null;
    }
  };

  // The structured Mandate for a node — its `### Sub-Plan NN:` section (title + body) plus the
  // decomposition preamble, captured at the decomposition ExitPlanMode parse. Falls back to a
  // title-only Mandate read from the tree node itself (the degenerate single path, where no
  // decomposition plan exists).
  const mandateFor = (path: NodePath): Mandate => {
    const parsed = mandates.get(pathKey(path));
    if (parsed) return parsed;
    const node = state ? nodeAtPath(state.root, path) : null;
    return {
      title: node ? node.title : `Sub-plan ${pathKey(path)}`,
      sectionBody: "",
      masterPreamble: "",
    };
  };

  // The path of the currently-active node (or null when nothing is in flight).
  const activePath = (): NodePath | null => (state ? activePathOf(state.root) : null);

  // The ONLY PlanTreeFilePath mint in the codebase: wrap the plan-tree write command and brand the
  // absolute path it RETURNS. No exported cast helper exists, so a path-typed slot (SUMMARY_WRITTEN
  // / onSummaryWritten) can only ever be fed by a real completed write — never prose.
  const writePlanTreeFileMinted = async (
    name: string,
    contents: string,
  ): Promise<PlanTreeFilePath> =>
    (await deps.writePlanTreeFile(cwd, name, contents)) as PlanTreeFilePath;

  // The injected clock (defaults to Date.now): stamps updated_ms at the single persist path.
  const nowFn = deps.now ?? ((): number => Date.now());

  const emitSnapshot = (snap: PlanTreeSnapshot2): void => {
    for (const o of observers) o.onSnapshot?.(snap);
  };

  // Mark this orchestration terminal: flip `active` false and deregister from the module registry.
  // Idempotent. Called on notifyDone / cancel / notifyFatal. `reason` is a caller
  // tag so the dev terminal shows WHICH terminal cause deactivated the orchestrator — and, crucially,
  // whether one fired BEFORE the recon result (the prime suspect for the bridge gate being false).
  const markTerminal = (reason: string): void => {
    // Log every call (even idempotent repeats) with whether this is the active->terminal transition.
    diag(`markTerminal() called via ${reason} (wasActive=${active})`);
    active = false;
    // A pending turn watchdog (resuming/summary/parent-review) must not outlive the run (a late
    // fire against a NEW hold would be a false fatal; the !active guard also covers it, defense in
    // depth).
    clearTurnWatchdog();
    // Tear down the combined apply-and-approve latch with the session: a flag left set across a
    // terminal could auto-resolve a future run's first gate. (Reset alongside prototypeRound in
    // start()/resume() too; this covers cancel()/FATAL/Stop where those resets don't run.)
    autoApproveNext = false;
    if (activeOrchestrator === handle) activeOrchestrator = null;
  };

  // End the live SDK session exactly as cancel() does: cancel the in-flight turn then end the
  // session, so index.ts receives an `agent-exit` and resets its controls. Idempotent at the
  // call-site via the `wasActive` guard the callers pass. Shared by cancel() and the fatal path
  // (notifyFatal) so a plain markTerminal() can never leave the session live while
  // isOrchestrationActive()===false (a Stop-routing desync).
  const endSdkSession = async (): Promise<void> => {
    try {
      await deps.cancelRun();
    } catch (err) {
      console.error("cancel_agent_run failed", err);
    }
    try {
      await deps.endSession();
    } catch (err) {
      console.error("end_agent_session failed", err);
    }
  };

  // The shared PROTOTYPE-APPROVE arc. Precondition: the root is in prototype-review holding `gate`.
  // Composes INTENT.md (prose + the embeddable-visual block) and resolves the gate forward — the
  // reducer writes INTENT.md and moves the root prototype-review → recon; the dispatch seam then
  // re-derives the policy and asserts setMode("plan") BEFORE the recon send below (exactly the
  // INTENT_CLARIFIED continuation's ordering). Called by approvePrototype() (interactive approve)
  // and by the intent-ingestion auto-approve branch (combined apply-and-approve). The session is
  // IDLE at both call sites (the intent turn ended; the gate was turn-completion-signaled), so the
  // recon prompt opens a fresh turn — no resuming hold, no interrupt.
  const resolveApprove = async (gate: PrototypeGate, asWorkingReference = false): Promise<void> => {
    const intentContents = composeIntentMd(pendingIntentText ?? "", gate, cwd);
    // WORKING-REFERENCE FREEZE (Phase 3): when the user marked the prototype a working reference,
    // freeze .plan-tree/prototype/ → .plan-tree/baseline/ BEFORE dispatching, so the on-disk copy
    // exists when the reducer records baseline_ + persists. The freeze is best-effort for the RECON
    // HOP — a failure is logged but does NOT block recon (the user's intent to floor the build still
    // advances the run). But baseline_ is a PRESENCE record that must match disk: it is recorded ONLY
    // when the freeze actually succeeded. `froze` is true iff BOTH ensureBaselineDir and freezeBaseline
    // resolved without throwing; if either optional dep is undefined, the freeze could not happen, so
    // froze stays false (no baseline is claimed). The dispatch carries `froze` (not the raw user flag)
    // so the reducer never records a baseline that does not exist on disk (Phase 5 open_baseline trusts
    // it). The default sketch path (asWorkingReference=false) skips this entirely — byte-identical.
    let froze = false;
    if (asWorkingReference) {
      try {
        if (deps.ensureBaselineDir && deps.freezeBaseline) {
          await deps.ensureBaselineDir(cwd);
          await deps.freezeBaseline(cwd);
          froze = true;
          diag("resolveApprove: working reference — froze .plan-tree/prototype/ → .plan-tree/baseline/");
        } else {
          diag("resolveApprove: working-reference freeze skipped (deps absent) — no baseline recorded");
        }
      } catch (err) {
        console.error("freeze_baseline failed (non-fatal)", err);
        diag(`resolveApprove: working-reference freeze failed (non-fatal): ${String(err)} — no baseline recorded`);
      }
    }
    await dispatch({ type: "PROTOTYPE_APPROVED", intentContents, asWorkingReference: froze, frozenMs: nowFn() });
    pendingIntentText = null;
    // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
    awaiting = { tag: "recon", path: [], buffer: "" };
    diag("resolveApprove: INTENT.md written, armed recon, sending reconPrompt");
    await deps.sendMessage(reconPrompt(request, confirmedIntent));
  };

  // Execute a single effect against the injected deps. Persist writes the schema-2 ledger to
  // state.json. The notify* effects fan out to the observers. resolvePermission also clears the
  // held-permission id (the held resolver is now resolved, so cancel no longer needs to purge it).
  // EXHAUSTIVE over Effect2 (assertNever) — a new effect kind cannot be silently dropped. NOTE:
  // Effect2 has NO writeAgentPlan kind — the driver writes every plans-dir copy ITSELF in
  // ingestPermission (the single authoritative write; the gen-1 wrotePlanForNn one-shot guard is
  // gone because there is no reducer effect left to no-op).
  const runEffect = async (eff: Effect2): Promise<void> => {
    switch (eff.kind) {
      case "persist": {
        if (!state) return;
        // THE SINGLE updated_ms STAMP: every ledger write carries the write's own fresh injected-
        // now() time (the reducer deliberately never touches updated_ms — its old self-max was a
        // no-op that froze the field at created_ms). NOTE: updated_ms is a LAST-MODIFIED stamp,
        // not an ordering sequence — under the production Date.now() clock, two persists within
        // the same millisecond carry equal stamps (non-decreasing, not strictly increasing).
        state = { ...state, updated_ms: nowFn() };
        await deps.writePlanTreeFile(cwd, "state.json", JSON.stringify(toLedger2(state)));
        return;
      }
      case "writePlanTreeFile": {
        await deps.writePlanTreeFile(cwd, eff.name, eff.contents);
        return;
      }
      case "deletePlanTreeFile": {
        // PHASE 6 — the refine branch's per-reset-node cleanup. Containment-guarded + allow-list-
        // validated Rust-side (delete_plan_tree_file reuses guarded_plan_tree_path), so a name that
        // is not an NN-plan.md / NN-summary.md / literal control file is rejected before any unlink.
        // Best-effort: a delete failure (e.g. the optional dep absent, or a transient FS error) is
        // logged but never throws — the re-run still OVERWRITES the file, so a stale copy cannot
        // survive the refine even if the pre-delete missed.
        if (!deps.deletePlanTreeFile) {
          diag(`deletePlanTreeFile skipped (dep absent): ${eff.name}`);
          return;
        }
        try {
          await deps.deletePlanTreeFile(cwd, eff.name);
        } catch (err) {
          console.error(`delete_plan_tree_file failed (non-fatal): ${eff.name}`, err);
          diag(`deletePlanTreeFile failed (non-fatal): ${eff.name}: ${String(err)}`);
        }
        return;
      }
      case "resetPlanTreeDir": {
        // START reconciliation: sweep stale prior-run files into .plan-tree/.archive/ BEFORE the
        // genesis persist lands (effect ordering is the reducer's responsibility).
        await deps.resetPlanTreeDir(cwd);
        return;
      }
      case "resolvePermission": {
        // RESUMED-GATE SHORT-CIRCUIT (Phase 3): a synthetic `resumed:` id addresses a permission the
        // sidecar NO LONGER HOLDS (the live ExitPlanMode resolver died with the prior process). The
        // resumed-gate approve/requestChanges branches send an explicit continuation prompt into the
        // resumed conversation INSTEAD of resolving the gate — so when the reducer (DECOMPOSITION_
        // APPROVED/APPROVE/…) still emits a resolvePermission for the gate's id, drop it rather than
        // call a dead resolver. The allow-side policy invalidation is preserved (the SDK still leaves
        // plan mode on the equivalent continuation), as is the held-id clear. Real ids never carry
        // this prefix, so the NON-resumed path is untouched.
        if (eff.id.startsWith("resumed:")) {
          if (heldPermissionId === eff.id) heldPermissionId = null;
          if (eff.allow) assertedPolicy = null;
          return;
        }
        // CLARIFY_ANSWERED reshape: the reducer can only carry the answers (it nulls pendingClarify
        // before this effect runs). For a known clarify id, rebuild the SDK's expected
        // updatedInput:{questions, answers} from the driver-retained questions + the answers parsed
        // from the reducer's JSON message, and DROP the raw message.
        if (clarifyQuestions.has(eff.id)) {
          const questions = clarifyQuestions.get(eff.id)!;
          let answers: AskUserQuestionAnswers = {};
          if (eff.message) {
            try {
              const parsed = JSON.parse(eff.message) as { answers?: AskUserQuestionAnswers };
              answers = parsed.answers ?? {};
            } catch {
              answers = {};
            }
          }
          await deps.resolvePermission({
            id: eff.id,
            allow: eff.allow,
            updatedInput: { questions, answers },
          });
          clarifyQuestions.delete(eff.id);
          if (heldPermissionId === eff.id) heldPermissionId = null;
          return;
        }
        await deps.resolvePermission({ id: eff.id, allow: eff.allow, message: eff.message });
        // The held resolver is now resolved — no longer needs purging on cancel.
        if (heldPermissionId === eff.id) heldPermissionId = null;
        // A non-clarify allow resolution is an ExitPlanMode approval: the SDK exits plan mode
        // out-of-band, so the session mode is now UNKNOWN — the dispatch seam re-asserts the
        // derived policy right after this effect loop.
        if (eff.allow) assertedPolicy = null;
        return;
      }
      case "notifyAwaitingApproval": {
        // Remember the held ExitPlanMode id so cancel() can purge it. The UNIFIED gate: this fires
        // for decomposition gates (root included) AND leaf gates alike.
        heldPermissionId = eff.gate.toolUseId;
        for (const o of observers) o.onAwaitingApproval?.(eff.gate);
        return;
      }
      case "notifyPrototypeReview": {
        // Surface the held visual-prototype gate to the observers (the UI's review pane). NOTE:
        // unlike notifyAwaitingApproval there is NO heldPermissionId to remember — the gate is
        // signaled by TURN COMPLETION (the intent turn's result), not a held tool resolver, so
        // cancel() has nothing to purge for it.
        for (const o of observers) o.onPrototypeReview?.(eff.gate);
        return;
      }
      case "notifyAcceptanceReview": {
        // PHASE 5 — THE FORCED ACCEPTANCE GATE. The reducer parked the root in its acceptance window
        // (no notifyDone yet) and emitted this effect with a gate whose display fields it could not
        // know (cwd/openTarget/runCommand — driver concerns). AUGMENT the gate with the run's cwd and
        // the baseline open target, then (a) PATCH it back into state.pendingAcceptance so the
        // snapshot the dispatch loop emits next carries the augmented gate (the UI's bar binds to the
        // snapshot — self-clearing, same discipline as pendingPrototype) and (b) fan the augmented
        // gate to observers AND (c) best-effort OPEN the baseline so the user can exercise it. Like
        // the prototype gate there is no heldPermissionId — the gate resolves by an explicit user
        // action (approveAcceptance/divergeAcceptance), not a held tool, so cancel purges nothing.
        const openTarget = eff.gate.openTarget ?? "index.html";
        const augmented: AcceptanceGate = {
          ...eff.gate,
          cwd,
          openTarget,
          runCommand: eff.gate.runCommand,
        };
        if (state && state.pendingAcceptance) {
          state = { ...state, pendingAcceptance: augmented };
        }
        for (const o of observers) o.onAcceptanceReview?.(augmented);
        if (deps.openBaseline && openTarget !== null) {
          try {
            await deps.openBaseline(cwd, openTarget);
            diag(`notifyAcceptanceReview: opened baseline "${openTarget}"`);
          } catch (err) {
            console.error("open_baseline failed (non-fatal)", err);
            diag(`notifyAcceptanceReview: open_baseline failed (non-fatal): ${String(err)}`);
          }
        }
        return;
      }
      case "notifySummaryWritten": {
        for (const o of observers) o.onSummaryWritten?.(eff.path, eff.summaryPath);
        return;
      }
      case "notifyDone": {
        markTerminal("notifyDone");
        const snap = state ? toSnapshot2(state) : null;
        if (snap) for (const o of observers) o.onDone?.(snap);
        return;
      }
      case "notifyFatal": {
        // FATAL is terminal — and like cancel() it must END the SDK session, not merely flip
        // `active` false. A plain markTerminal() left the session (and the run's full conversation
        // context, possibly in a widened mode) ALIVE in the sidecar while
        // isOrchestrationActive()===false — the Stop-routing desync endSdkSession exists to
        // prevent, and the seam where a later "new plan" collided with or bled context from the
        // surviving session. wasActive-guarded so a repeated FATAL never re-ends.
        const wasActive = active;
        markTerminal(`notifyFatal: ${eff.message}`);
        if (wasActive) await endSdkSession();
        for (const o of observers) o.onFatal?.(eff.message);
        return;
      }
    }
    assertNever(eff);
  };

  // THE SINGLE FUNNEL. Every event flows through here: reduce2 -> apply new state -> run effects in
  // order -> emit the fresh snapshot. The handle methods (and, later, the live agent-stream listener)
  // all call dispatch. Effects run sequentially so persist-ordering is deterministic.
  // `opts.suppressNotifyPrototypeReview` drops ONLY the `notifyPrototypeReview` view effect for this
  // one transition — used by the combined apply-and-approve arc, where PROTOTYPE_READY is a purely
  // internal clarifying-intent → prototype-review hop (so the immediately-following PROTOTYPE_APPROVED
  // is legal). The state mutation and the `persist` effect still run; only the user-facing review
  // surface (switchToPlanTab / preview render / bar flip via onPrototypeReview) is suppressed.
  const dispatch = async (
    event: PlanTreeEvent2,
    opts?: { suppressNotifyPrototypeReview?: boolean },
  ): Promise<void> => {
    // START is the genesis event: it ignores prior state, so feed reduce2 a throwaway base if none.
    const base: PlanTreeState2 =
      state ??
      ({
        schema: 2,
        tree_id: "",
        created_ms: 0,
        updated_ms: 0,
        root: {
          nn: parseNn(1),
          title: "",
          redraftCount: 0,
          lastFeedback: null,
          state: { stage: "open", phase: "clarifying-intent" },
        },
        pendingApproval: null,
        pendingClarify: null,
        pendingAcceptance: null,
        parsedChildren: null,
      } as PlanTreeState2);
    const { state: next, effects } = reduce2(base, event);
    state = next;
    for (const eff of effects) {
      // SILENT auto-approve hop: skip the prototype-review VIEW notification (state + persist still
      // run). See the dispatch opts doc above.
      if (opts?.suppressNotifyPrototypeReview && eff.kind === "notifyPrototypeReview") continue;
      await runEffect(eff);
    }
    // DERIVED WRITE POLICY (the single mode seam): permission mode is a PURE function of the tree
    // (writePolicyFor2 — the tree-wide existential), asserted here after EVERY transition — never
    // imperatively at scattered call sites. Whenever the derived policy differs from the last KNOWN
    // session mode (null = unknown, e.g. right after an ExitPlanMode approval flipped the SDK out
    // of plan mode), correct it. This runs BEFORE any subsequent sendMessage at the dispatch call
    // sites, so a planning turn can never start in a stale writable mode (the post-decomposition-
    // approval incident). Skipped once terminal — the session is concluding/dead and must not be
    // poked.
    if (active) {
      const policy = writePolicyFor2(next.root);
      if (policy !== assertedPolicy) {
        await deps.setMode(policy);
        assertedPolicy = policy;
      }
    }
    emitSnapshot(toSnapshot2(next));
  };

  const requireState = (): PlanTreeState2 => {
    if (!state) throw new Error("orchestrator not started");
    return state;
  };

  // PHASE 4 (R4/R5) — does the ROOT ledger carry a frozen working-reference baseline? When true, the
  // master-draft prompt gains the OUTCOME-bar acceptance criterion (R4) and every sub-plan
  // draft/summary prompt gains the integrated behavioral-envelope-test mandate (R5). When false (no
  // working reference frozen) all prompts stay BYTE-IDENTICAL to their pre-Phase-4 form. baseline_
  // lives on the ROOT ledger only (it is a per-tree presence record), so read it off `state`.
  const hasBaseline = (): boolean => Boolean(state?.baseline_);

  // ---- the deferred-send (resuming) hold ------------------------------------------------------
  //
  // How long a `{tag:"resuming"}` hold may sit without the in-flight turn's `result` before the
  // watchdog declares the run stuck. The hold is now interrupt-bounded (the decomposition-approve
  // branch fires deps.interrupt right after arming, and the aborted turn yields its result within
  // seconds), so this is a BACKSTOP against a lost/failed interrupt — short enough to fail loud,
  // generous enough for a slow tool-abort wind-down.
  const RESUME_RESULT_TIMEOUT_MS = 30_000;

  // PHASE 5 (DA P4 follow-up) — THE GENERALIZED TURN TIMEOUT for the `summary` and `parent-review`
  // awaiting variants (ONE constant for both — documented choice). These are REAL generation turns
  // (the model writes a summary / runs the review), not interrupt-bounded boundary waits, so the
  // window is wider than RESUME_RESULT_TIMEOUT_MS — but still finite and LOUD: their prompts
  // forbid tools, yet that instruction is prompt-only (the sidecar backstop auto-allows Task/
  // read-Bash), so an errant tool call could otherwise stall the turn silently forever.
  const TURN_RESULT_TIMEOUT_MS = 120_000;

  // VISUAL-PROTOTYPE follow-up — THE INTENT-TURN TIMEOUT. The intent turn previously had NO
  // watchdog coverage (verified before this change: start() armed `intent` with no timer — a turn
  // that never produced a result hung the run silently at clarifying-intent). Now that the turn
  // can BUILD prototypes (write artifacts, take best-effort screenshots) it is the longest
  // planning turn, so it gets the same loud-FATAL treatment with a WIDER window than
  // TURN_RESULT_TIMEOUT_MS (and a distinct ms value, so timer-counting test pins can tell the
  // watchdog kinds apart). The window measures SILENCE, not total turn duration: every stream
  // frame proving the intent turn is alive (text, tool activity, status/progress, a subagent
  // spawning) RE-ARMS it (the liveness reset in ingestStreamImpl), so a legitimately long
  // prototype build that streams the whole time never trips it — only 300s of dead air does.
  // The watchdog is PAUSED while an AskUserQuestion is held inside the intent turn (the user may
  // take arbitrarily long to answer) and re-armed when the clarify resolves — see the
  // AskUserQuestion ingest branch + answerClarify.
  const INTENT_RESULT_TIMEOUT_MS = 300_000;

  // Bind the injectable timer seam (tests inject fakes so they never sleep; the live app uses the
  // global timers via defaultDeps).
  const scheduleTimer =
    deps.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const cancelTimer =
    deps.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));

  const clearTurnWatchdog = (): void => {
    if (turnWatchdog !== null) {
      cancelTimer(turnWatchdog);
      turnWatchdog = null;
    }
  };

  // PHASE 5 (DA P4 follow-up) — arm the generalized turn watchdog for an awaited `summary` or
  // `parent-review` turn. No result within TURN_RESULT_TIMEOUT_MS ⇒ the established loud-FATAL
  // path (serialized through enqueueIngest, exactly like the resuming watchdog). The fire guard
  // re-checks BOTH the tag and the armed path so a fired-but-not-yet-run callback racing a fresh
  // arm of the same tag can never FATAL the wrong turn.
  const armTurnWatchdog = (label: "summary" | "parent-review" | "intent", forPath: NodePath): void => {
    clearTurnWatchdog();
    const armedKey = pathKey(forPath);
    const timeoutMs = label === "intent" ? INTENT_RESULT_TIMEOUT_MS : TURN_RESULT_TIMEOUT_MS;
    diag(`armTurnWatchdog: ${label} turn at "${armedKey}"; watchdog ${timeoutMs}ms`);
    turnWatchdog = scheduleTimer(() => {
      turnWatchdog = null;
      void enqueueIngest(async () => {
        if (!active || awaiting.tag !== label) return; // the result won the race (or terminal)
        const armed =
          awaiting.tag === "summary"
            ? awaiting.path
            : awaiting.tag === "parent-review"
              ? awaiting.parentPath
              : []; // the intent turn is the ROOT's genesis turn (no per-node path)
        if (pathKey(armed) !== armedKey) return; // a different turn of the same tag is in flight
        awaiting = { tag: "idle" };
        await dispatch({
          type: "FATAL",
          message:
            `turn watchdog: no turn result arrived within ${timeoutMs}ms for the ` +
            `${label} turn at "${armedKey}" — the turn is stuck`,
        });
      });
    }, timeoutMs);
  };

  // Arm the RESUMING hold: the next step (the recon turn for `nextPath`) is DEFERRED until the
  // in-flight resumed turn's `result` arrives — sending it now would merge it into that turn (the
  // no-gate incident). The caller (the decomposition-approve branch of approve() — the ONLY armer)
  // interrupts the resumed turn right after this returns, so the boundary result arrives within
  // seconds; the watchdog is the backstop guaranteeing a missing result still surfaces as a loud
  // terminal FATAL, never a silent hang. The fire path runs through enqueueIngest so it is
  // serialized with live frames and inherits the queue's error isolation (the established fatal
  // pattern).
  const armResuming = (nextPath: NodePath): void => {
    clearTurnWatchdog();
    awaiting = { tag: "resuming", nextPath };
    diag(
      `armResuming: deferred recon for "${pathKey(nextPath)}"; watchdog ${RESUME_RESULT_TIMEOUT_MS}ms`,
    );
    turnWatchdog = scheduleTimer(() => {
      turnWatchdog = null;
      void enqueueIngest(async () => {
        // The result won the race (or the run already concluded) — no fatal.
        if (!active || awaiting.tag !== "resuming") return;
        const stuckPath = awaiting.nextPath;
        awaiting = { tag: "idle" };
        await dispatch({
          type: "FATAL",
          message:
            `resume watchdog: no turn result arrived within ${RESUME_RESULT_TIMEOUT_MS}ms after ` +
            `decomposition approval (the interrupt boundary result is missing) — the deferred recon ` +
            `for sub-plan ${pathKey(stuckPath)} was never sent`,
        });
      });
    }, RESUME_RESULT_TIMEOUT_MS);
  };

  // ---- the live turn-completion sequencer ----------------------------------------------------
  //
  // THE SEQUENCER (see the `Awaiting` union above): the `result` branch acts ONLY when `awaiting` is
  // armed (non-idle), then re-arms exactly one successor variant (or `idle`, when the next signal is
  // an ExitPlanMode hold rather than a `result`). Each branch reads ITS OWN buffer/path — captured at
  // ARM TIME — so swallow / double-advance / cross-step buffer-merge are all UNREPRESENTABLE. An
  // armed variant is always set BEFORE the matching `deps.sendMessage(...)` so a `result` delivered
  // as that send resolves (see start()) is never swallowed. Re-arm sites capture the active path at
  // arm time; if it is null there, we arm `{tag:"idle"}` (the moved-forward null-path guard) rather
  // than a variant with a bogus path.
  async function ingestStreamImpl(frame: AgentStream): Promise<void> {
    // TERMINAL GUARD (structural invariant): once the run is terminal (FATAL/done both flip
    // `active` false via markTerminal), a frame already sitting in the ingest queue must run NO effects.
    // The queue still DEQUEUES and INVOKES this thunk (error-isolation), but we early-return before any
    // dispatch/sendMessage so a same-tick trailing frame can't act on a dead run. ingestSeen++ records
    // that the queued work reached this guard (a falsifiability hook for the chain-not-poisoned test).
    ingestSeen++;
    diag(`ingestStreamImpl: kind=${frame.kind} active=${active} awaiting=${awaiting.tag}`);
    if (!active) {
      diag("ingestStreamImpl: SWALLOWED by !active guard (terminal)");
      return;
    }
    // INTENT-WATCHDOG LIVENESS RESET: the intent watchdog measures SILENCE, not total turn
    // duration — a legitimately long prototype build (the clarifier writing HTML + taking
    // screenshots, streaming the whole time) must not FATAL at 300s. Any frame proving the
    // active intent turn is alive (text, tool activity, status/progress, a subagent spawning)
    // re-arms the per-silence window. The `turnWatchdog !== null` guard preserves the
    // AskUserQuestion PAUSE: a held clarify clears the timer, and liveness frames arriving
    // during the hold must NOT re-arm it — answerClarify alone owns the resume. The `result`
    // frame is deliberately excluded: the intent branch below consumes it and disarms.
    if (
      awaiting.tag === "intent" &&
      turnWatchdog !== null &&
      (frame.kind === "assistant_text" ||
        frame.kind === "tool_use" ||
        frame.kind === "tool_result" ||
        frame.kind === "status" ||
        frame.kind === "subagent_started")
    ) {
      armTurnWatchdog("intent", []);
    }
    if (frame.kind === "system_init") {
      // RESUME-SUPPORT SESSION CAPTURE: the SDK announced this conversation's session_id. Capture it
      // into the driver-local immediately (so it survives even if the dispatch is a no-op), then
      // self-persist it onto the ledger via SESSION_INITIALIZED. This is NOT a sequencer boundary:
      // it touches NO `awaiting` variant and runs regardless of the armed tag — the reducer arc is
      // a pure ledger stamp (idempotent; re-dispatching the same id is a no-op). Returns here so the
      // frame never falls through to the `result`-only sequencer below.
      sdkSessionId = frame.session_id;
      diag(`system_init: captured sdk session_id=${sdkSessionId}`);
      if (frame.session_id && frame.session_id !== state?.sdk_session_id) {
        await dispatch({ type: "SESSION_INITIALIZED", sessionId: frame.session_id });
      }
      return;
    }
    if (frame.kind === "assistant_text") {
      // Append to the CURRENT variant's buffer only; drop while idle OR resuming (no cross-step
      // merge — resume-turn chatter must never leak into the deferred step's capture).
      if (awaiting.tag !== "idle" && awaiting.tag !== "resuming") {
        awaiting = { ...awaiting, buffer: awaiting.buffer + (awaiting.buffer ? "\n" : "") + frame.text };
      }
      return;
    }
    if (frame.kind !== "result") return;
    // Swallow rule: an unarmed (`idle`) `result` is no boundary. (A post-approval/advance resume
    // result is NOT idle anymore — it lands while `{tag:"resuming"}` holds the deferred next step,
    // and is consumed by the `resuming` branch below.)
    if (awaiting.tag === "idle") return;

    switch (awaiting.tag) {
      case "resuming": {
        // The in-flight decomposition-approval-resumed turn just ended — normally because the
        // approve() decomposition branch interrupted it (the aborted turn's `result`, subtype
        // error_during_execution, normalized by the sidecar like any other result), or voluntarily
        // if it won the race. Either way THIS result is the boundary the deferred send was waiting
        // on — by construction it can belong to no other step (the resuming tag was armed in place
        // of any inline send). Consume the hold, disarm the watchdog, and fire the deferred recon
        // turn.
        const nextPath = awaiting.nextPath;
        clearTurnWatchdog();
        diag(`resuming branch: resume result consumed, firing deferred recon for "${pathKey(nextPath)}"`);
        // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
        // PER-LEVEL threading: the deferred first child sees ITS OWN level's completed siblings
        // (none yet, by construction — it is the first), never another level's. The first child of
        // a fresh decomposition has no pending adjust note either (adjustNoteFor is the scope guard).
        awaiting = { tag: "recon", path: nextPath, buffer: "" };
        await deps.sendMessage(
          subReconPrompt(
            nextPath,
            mandateFor(nextPath),
            priorSummaries(parentPathOf(nextPath)),
            adjustNoteFor(nextPath),
          ),
        );
        return;
      }
      case "intent": {
        // The GENESIS turn: the intent-clarifier confirmed the user's intent (and, in visual mode,
        // may have built a prototype). Parse the FINALIZE contract off the buffered final text:
        //   • a trailing ---PROTOTYPE--- block ⇒ open the prototype-review gate (PROTOTYPE_READY)
        //     and go IDLE — the gate resolves through approvePrototype()/refinePrototype() (turn
        //     completion signaled the gate; no tool is held, nothing for cancel() to purge);
        //   • NO-PROTOTYPE / no block (incl. the plain-prose case, where
        //     parsePrototypeBlock returns the buffer untouched) ⇒ the pre-feature path
        //     byte-identical: INTENT_CLARIFIED (writes INTENT.md), then send recon + arm `recon`.
        const buffered = awaiting.buffer;
        awaiting = { tag: "idle" };
        clearTurnWatchdog(); // the awaited intent result arrived — disarm its watchdog
        const parsed = parsePrototypeBlock(buffered);
        // Capture the confirmed intent for downstream prompt threading (recon + decomposition-
        // draft). A whitespace-only confirmation collapses to null so those prompts stay byte-
        // identical to their pre-feature form.
        confirmedIntent = parsed.intentText.trim() ? parsed.intentText.trim() : null;
        if (parsed.prototype !== null) {
          // ALWAYS capture THIS turn's intent text for downstream composition (never a stale prior
          // round's value) — both the interactive gate and the auto-approve arc compose from it.
          pendingIntentText = parsed.intentText;
          const gate: PrototypeGate = { ...parsed.prototype, round: prototypeRound + 1, cwd };
          if (autoApproveNext) {
            // COMBINED apply-and-approve: the user typed feedback AND clicked approve last round, so
            // the revised prototype is a DOWNSTREAM SPEC — do not surface another review round. The
            // root is currently in clarifying-intent (refinePrototype moved it there), so we CANNOT
            // dispatch PROTOTYPE_APPROVED directly (the reducer requires prototype-review and would
            // throw an illegal-transition). Replicate the FULL legal arc: PROTOTYPE_READY moves the
            // root clarifying-intent → prototype-review, THEN resolveApprove(gate) composes
            // INTENT.md from THIS turn's gate and dispatches PROTOTYPE_APPROVED (now legal) →
            // prototype-review → recon. Clear the latch before resolving so a throw can't strand it.
            // SUPPRESS the review VIEW notification on this PROTOTYPE_READY: it is a purely internal
            // state hop to make PROTOTYPE_APPROVED legal — surfacing it would flip to the Plan tab and
            // paint the review bar for one frame before resolveApprove immediately approves, which is
            // exactly the review round this combined action is designed to skip.
            diag(
              `intent branch (auto-approve): prototype block parsed (kind=${gate.kind}, round=${gate.round}) — silent PROTOTYPE_READY → resolveApprove`,
            );
            autoApproveNext = false;
            await dispatch({ type: "PROTOTYPE_READY", gate }, { suppressNotifyPrototypeReview: true });
            await resolveApprove(gate);
            return;
          }
          diag(
            `intent branch: trailing prototype block parsed (kind=${gate.kind}, round=${gate.round}) — dispatching PROTOTYPE_READY`,
          );
          await dispatch({ type: "PROTOTYPE_READY", gate });
          // awaiting stays idle: the next signal is a HANDLE METHOD (approve/refine), not a frame.
          return;
        }
        // NO BLOCK on an auto-approve round: the agent applied the feedback but emitted no prototype
        // block, so there is nothing to re-surface — fall through to the normal INTENT_CLARIFIED →
        // recon path (the feedback was already applied). Clear the latch; do NOT route through
        // PROTOTYPE_APPROVED (the root is in clarifying-intent and INTENT_CLARIFIED is the legal
        // transition from there).
        if (autoApproveNext) {
          diag("intent branch (auto-approve): no prototype block — falling through to INTENT_CLARIFIED");
          autoApproveNext = false;
        }
        diag("intent branch: dispatching INTENT_CLARIFIED");
        await dispatch({ type: "INTENT_CLARIFIED", intent: parsed.intentText });
        // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
        awaiting = { tag: "recon", path: [], buffer: "" };
        diag("intent branch: armed recon, sending reconPrompt");
        await deps.sendMessage(reconPrompt(request, confirmedIntent));
        return;
      }
      case "recon": {
        // UNIFIED recon: the ROOT ([]) routes to the sizer; a child node routes to its draft turn
        // (gen-1's root-recon + sub-recon branches, keyed on path depth).
        const path = awaiting.path;
        const reconText = awaiting.buffer;
        awaiting = { tag: "idle" };
        if (path.length === 0) {
          // ROOT recon. DRIVER-WRITE BOUNDARY (the cutover seam): gen-2 NODE_RECON_DONE carries no
          // text and emits no write effect — the driver physically writes recon.md FIRST (matching
          // the gen-1 effect ordering: recon.md before the persist), then dispatches.
          diag("recon branch (root): writing recon.md + dispatching NODE_RECON_DONE");
          await deps.writePlanTreeFile(cwd, "recon.md", reconText);
          await dispatch({ type: "NODE_RECON_DONE", path });
          // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
          awaiting = { tag: "sizer", path: [], buffer: "" };
          await deps.sendMessage(sizerPrompt());
          return;
        }
        // NON-ROOT recon (gen-1 sub-recon, PHASE-4 generalized). No imperative setMode("plan")
        // here: the derived policy (writePolicyFor2, asserted at the dispatch seam) already
        // corrected the mode at the transition that ACTIVATED this node.
        await dispatch({ type: "NODE_RECON_DONE", path });
        const reconState = requireState();
        const reconNode = nodeAtPath(reconState.root, path);
        if (reconNode && reconNode.state.stage === "leaf") {
          // ROOT-COLLAPSE CHILD (the reducer forced leaf/drafting — it inherited the root sizer's
          // single verdict and skips the per-node sizer): draft directly, gen-1 golden behavior.
          // The next signal is the node's ExitPlanMode hold (not a `result`), so stay idle.
          await deps.sendMessage(
            subDraftPrompt(
              path,
              mandateFor(path),
              priorSummaries(parentPathOf(path)),
              adjustNoteFor(path),
              hasBaseline(),
            ),
          );
          return;
        }
        // PHASE 4 — EVERY OTHER non-root node runs the per-node sizer next (the prompt sequence
        // mirrors the root: recon → sizer). Arm BEFORE sending (see start()).
        awaiting = { tag: "sizer", path, buffer: "" };
        await deps.sendMessage(sizerPrompt());
        return;
      }
      case "sizer": {
        // Scan buffered lines; take the LAST SIZER match (avoid a stray top-level echo).
        const path = awaiting.path;
        let sizer = null as ReturnType<typeof parseSizerDecision>;
        for (const line of awaiting.buffer.split(/\r?\n/)) {
          const parsed = parseSizerDecision(line);
          if (parsed) sizer = parsed;
        }
        const sizerBuffer = awaiting.buffer;
        awaiting = { tag: "idle" };
        if (!sizer) {
          // TWO-OUTCOME SIZER: the decision union is "single" | "split" — anything else (a stale
          // `escalate` from an old prompt, an unknown decision word, or no SIZER line at all) is
          // COERCED to split, LOUDLY but not fatally. Split is the safe default: the decomposition
          // gate is already the human checkpoint, so an uncertain sizer must decompose, never end
          // the run.
          diag(
            `sizer: no parseable single/split SIZER decision — COERCING to split. buffer head: ${JSON.stringify(sizerBuffer.slice(0, 200))}`,
          );
          sizer = { decision: "split", confidence: 0, num_plans: 0 };
        }
        // EXHAUSTIVE dispatch over the sizer decision. Each case ends in `return`; the trailing
        // assertNever(sizer.decision) makes a missing case a compile error (the value is no longer
        // narrowed to `never`). The reducer enforces the confidence threshold; the driver must mirror
        // its branch so the RIGHT next prompt is sent for each outcome.
        // The decomposition-draft prompt for THIS node: the root drafts the MASTER plan from the
        // raw request; a non-root node (PHASE 4) drafts its own nested decomposition from its
        // mandate. Either way the next signal is the ExitPlanMode hold (not a `result`) — idle.
        const sendDecompositionDraft = async (): Promise<void> => {
          if (path.length === 0) {
            await deps.sendMessage(masterDraftPrompt(request, undefined, confirmedIntent, hasBaseline()));
          } else {
            await deps.sendMessage(
              nestedDecompositionDraftPrompt(
                path,
                mandateFor(path),
                priorSummaries(parentPathOf(path)),
                adjustNoteFor(path),
                hasBaseline(),
              ),
            );
          }
        };
        switch (sizer.decision) {
          case "single": {
            if (sizer.confidence >= 0.6) {
              await dispatch({ type: "SIZER_DONE", path, outcome: sizer });
              if (path.length === 0) {
                // ROOT CONFIDENT single: the reducer collapsed the root to a single child 01
                // already in recon (the root single-collapse). Drive that child's recon INLINE
                // (gen-1 golden behavior — the sizer turn's result is the boundary; nothing is in
                // flight).
                const childPath = activePath();
                if (childPath !== null) {
                  // Arm BEFORE sending (the result may arrive as this sendMessage resolves).
                  awaiting = { tag: "recon", path: childPath, buffer: "" };
                  await deps.sendMessage(
                    subReconPrompt(
                      childPath,
                      mandateFor(childPath),
                      priorSummaries(parentPathOf(childPath)),
                      adjustNoteFor(childPath),
                    ),
                  );
                }
                return;
              }
              // PHASE 4 — NON-ROOT confident single: the node ITSELF became the leaf
              // (leaf/drafting). Send its draft prompt; the next signal is the leaf's ExitPlanMode
              // hold, so arm idle.
              await deps.sendMessage(
                subDraftPrompt(
                  path,
                  mandateFor(path),
                  priorSummaries(parentPathOf(path)),
                  adjustNoteFor(path),
                  hasBaseline(),
                ),
              );
              return;
            }
            // LOW-confidence single: the reducer routes it to `decomposing` (treated as a split).
            await dispatch({ type: "SIZER_DONE", path, outcome: sizer });
            await sendDecompositionDraft();
            return;
          }
          case "split": {
            // SPLIT → decomposing, at ANY depth.
            await dispatch({ type: "SIZER_DONE", path, outcome: sizer });
            await sendDecompositionDraft();
            return;
          }
        }
        assertNever(sizer.decision);
      }
      // eslint-disable-next-line no-fallthrough -- unreachable: every sizer arm returns above.
      case "exec": {
        const path = awaiting.path;
        awaiting = { tag: "idle" };
        await dispatch({ type: "EXEC_DONE", path });
        // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()). The
        // fresh `summary` variant gets buffer:"" — exec-phase chatter is dropped, not threaded.
        // PHASE 5: every summary turn is watchdog-bounded (no result ⇒ loud FATAL, never a hang).
        awaiting = { tag: "summary", path, buffer: "" };
        armTurnWatchdog("summary", path);
        await deps.sendMessage(summaryPrompt(path, hasBaseline()));
        return;
      }
      case "summary": {
        const path = awaiting.path;
        const summaryText = awaiting.buffer;
        awaiting = { tag: "idle" };
        clearTurnWatchdog(); // the awaited summary result arrived — disarm its watchdog
        summaries.set(pathKey(path), summaryText);
        // DRIVER-SIDE WRITE (mirrors the plan write seam): physically write summaryName2(path) FIRST
        // and mint the brand from the write's returned path — so SUMMARY_WRITTEN carries the FILE's
        // path, never its text (the old text-as-path bug, now uncompilable). The reducer then
        // records the path, activates the next sibling (or completes the root), and fires
        // notifyDone when the last child summarizes.
        const summaryPath = await writePlanTreeFileMinted(summaryName2(path), summaryText);
        await dispatch({ type: "SUMMARY_WRITTEN", path, summaryText, summaryPath });
        if (state && !treeIsDone(state.root)) {
          // THE COMPLETION-ASCENT HOPS (all INLINE — see the audit note below). After a summary
          // lands, exactly one of three nodes is active:
          //   • the PARENT in `reviewing` (right-siblings remain) → send the parent-review prompt
          //     (PHASE 5: the next sibling's recon fires ONLY from PARENT_REVIEW_DONE);
          //   • a NON-ROOT ANCESTOR resting in its ROLL-UP WINDOW (running-children, all children
          //     summarized) → send its roll-up summary prompt, fed its DIRECT children's summaries
          //     (per-level threading); its summary result re-enters THIS branch one level up,
          //     continuing the ascent (next sibling of the parent / grandparent roll-up / done);
          //   • nothing (done — handled above).
          // AUDIT FINDING (live phase-1 run): NO turn is in flight at ANY of these hops. The
          // `result` this branch just consumed IS the summary turn's terminal frame — in
          // streaming-input mode the SDK is parked awaiting the next user message, and the summary
          // prompt forbids tool calls, so there is no held ExitPlanMode whose resolve could resume
          // anything. The decomposition-approval merge hazard (sending into a still-in-flight
          // resumed turn) does NOT apply here; arming the deferred `resuming` hold at any of these
          // hops would wait for a turn result that can never arrive → a guaranteed watchdog FATAL
          // (pinned per-hop by orchestrator-depth2.test.ts). Decomposition approvals are the ONLY
          // resuming-arming sites. Arm BEFORE sending (see start()); if no node is active, stay
          // idle rather than arm a bogus path.
          const nextPath = activePath();
          if (nextPath !== null) {
            const nextNode = nodeAtPath(state.root, nextPath);
            if (nextPath.length === 0 && state.pendingAcceptance) {
              // PHASE 5 — THE FORCED ACCEPTANCE GATE held. The reducer parked the ROOT in its
              // acceptance window (running-children, all children summarized) instead of finalizing,
              // and emitted notifyAcceptanceReview. The root is NOT done (treeIsDone false) yet there
              // is NO turn to send — the user must record a verdict (approveAcceptance /
              // divergeAcceptance) before the deferred finalize runs. CRITICAL: this guard MUST sit
              // BEFORE the inRollupWindow branch — the root acceptance window is structurally
              // identical to a roll-up window (inRollupWindow(root) is true here), so without this
              // short-circuit the driver would erroneously send a roll-up summary prompt for the
              // root (which writes no roll-up). Arm idle and wait for the user's verdict.
              awaiting = { tag: "idle" };
              diag("summary consume: root parked at the forced acceptance gate — awaiting verdict");
            } else if (nextNode && nextNode.state.stage === "split" && nextNode.state.phase === "reviewing") {
              // PHASE 5 — THE PARENT-REVIEW TURN: the reducer moved the parent (nextPath) to
              // `reviewing` because right-siblings remain. Send the no-tools review prompt — the
              // just-written child summary VERBATIM plus the remaining (pending) siblings' FROZEN
              // mandates — and arm `parent-review` + its watchdog. The next child's recon fires
              // ONLY from the parent-review consume branch (PARENT_REVIEW_DONE).
              const remaining = nextNode.state.children
                .filter((c) => c.state.stage === "open" && c.state.phase === "pending")
                .map((c) => {
                  const sibPath: NodePath = [...nextPath, c.nn];
                  return { path: sibPath, mandate: mandateFor(sibPath) };
                });
              awaiting = { tag: "parent-review", parentPath: nextPath, reviewedChild: path, buffer: "" };
              armTurnWatchdog("parent-review", nextPath);
              await deps.sendMessage(parentReviewPrompt(path, summaryText, remaining));
            } else if (nextNode && inRollupWindow(nextNode)) {
              // ROLL-UP turn for the parent: its summary is awaited like any node summary — the
              // `summary` variant re-armed with the PARENT's path (PHASE 5: watchdog-bounded).
              awaiting = { tag: "summary", path: nextPath, buffer: "" };
              armTurnWatchdog("summary", nextPath);
              await deps.sendMessage(rollupSummaryPrompt(nextPath, priorSummaries(nextPath)));
            } else {
              // IMPOSSIBLE STATE (mutation-audit finding, 2026-06-11): a direct sibling recon hop
              // no longer exists. advanceAfterSummary produces exactly three post-summary shapes —
              // parent `reviewing` (sibling remains; PHASE 5 intercepts EVERY non-final sibling
              // activation, leaf and roll-up alike), a non-root ancestor's roll-up window, or done
              // (activePath() === null, handled above). The only reducer arcs that mint open/recon
              // are INTENT_CLARIFIED, the sizer root-collapse, DECOMPOSITION_APPROVED, and
              // PARENT_REVIEW_DONE — none fire inside SUMMARY_WRITTEN. Reaching here means the
              // reducer and driver have diverged: throw loudly rather than send a recon prompt the
              // state machine never authorized.
              throw new Error(
                `summary consume: active node "${pathKey(nextPath)}" is ${nextNode ? `${nextNode.state.stage}/${nextNode.state.phase}` : "missing"} after SUMMARY_WRITTEN — expected reviewing parent, roll-up window, or done (unreachable)`,
              );
            }
          }
        }
        // If done, the reducer already fired notifyDone — nothing to send. (notifyDone keeps the
        // SDK session itself alive exactly as gen 1 did — markTerminal deregisters but does not
        // end the session; the user's Stop / a new start owns that.)
        return;
      }
      case "parent-review": {
        // PHASE 5 — consume the review turn's result: parse ADJUST/NONE (last matching line wins;
        // unparseable COERCES to NONE loudly, never fatally), dispatch PARENT_REVIEW_DONE (which
        // activates the next sibling's recon in the tree), stash the single pending note, then
        // send the next child's recon INLINE — the review result IS the boundary (nothing is in
        // flight; arming `resuming` here would wait for a result that can never arrive).
        const parentPath = awaiting.parentPath;
        const reviewBuffer = awaiting.buffer;
        awaiting = { tag: "idle" };
        clearTurnWatchdog(); // the awaited review result arrived — disarm its watchdog
        const parsed = parseParentReview(reviewBuffer);
        if (parsed === null) {
          diag(
            `parent-review: no parseable ADJUST/NONE line — COERCING to NONE. buffer head: ${JSON.stringify(reviewBuffer.slice(0, 200))}`,
          );
        }
        const note = parsed ? parsed.note : null;
        await dispatch({ type: "PARENT_REVIEW_DONE", path: parentPath, note });
        // THE SINGLE NOTE SLOT: set on ADJUST, NULLED on NONE/unparseable (a stale prior note can
        // never survive a NONE review). Scoped to this parent's children via parentKey.
        adjustNote = note !== null ? { parentKey: pathKey(parentPath), note } : null;
        diag(
          `parent-review: done for "${pathKey(parentPath)}" — ${note !== null ? `ADJUST note stashed (${JSON.stringify(note.slice(0, 120))})` : "NONE (no note)"}`,
        );
        const nextPath = activePath();
        if (nextPath !== null) {
          // Arm BEFORE sending (see start()). The note (if any) injects into THIS recon prompt —
          // and into the same child's draft prompt later — then clears at its DRAFTED dispatch.
          awaiting = { tag: "recon", path: nextPath, buffer: "" };
          await deps.sendMessage(
            subReconPrompt(
              nextPath,
              mandateFor(nextPath),
              priorSummaries(parentPathOf(nextPath)),
              adjustNoteFor(nextPath),
            ),
          );
        }
        return;
      }
    }
  }

  // ---- the live interactive-tool path --------------------------------------------------------
  async function ingestPermissionImpl(req: ToolPermissionRequested): Promise<void> {
    // TERMINAL GUARD (structural invariant): see ingestStreamImpl. After the run is terminal a queued
    // permission frame (e.g. a same-tick trailing ExitPlanMode) must NOT dispatch NODE_DRAFTED /
    // notifyAwaitingApproval — that would surface an approval bar whose heldPermissionId nothing ever
    // resolves. ingestSeen++ records the queued work reached this guard (chain-not-poisoned hook).
    ingestSeen++;
    if (!active) return;
    if (req.tool === "ExitPlanMode") {
      const plan = (req.input as { plan?: string } | null)?.plan ?? "";
      // GEN-2 ROUTING: an ExitPlanMode is routed by the ACTIVE node's discriminated state, not a
      // master-phase string. open/decomposing (first draft) OR open/awaiting-decomposition-approval
      // ⇒ the DECOMPOSITION flow (the redraft-after-changes case re-enters at open/decomposing —
      // DECOMPOSITION_CHANGES_REQUESTED moves the node back there); leaf/drafting ⇒ the LEAF flow.
      const st = requireState();
      const path = activePath();
      const node = path !== null ? nodeAtPath(st.root, path) : null;
      if (path === null || node === null) return;
      // PHASE 5 (DA P4 follow-up) — ROGUE ExitPlanMode DENY: an ExitPlanMode arriving while the
      // active node matches NO legal drafting branch — a summary turn (leaf summary OR roll-up),
      // the roll-up window, or a parent-review window — must NOT be silently dropped (that strands
      // the sidecar's held resolver and stalls the turn forever). Resolve it as a DENY with a
      // corrective message so the SDK feeds it back as the tool error and the turn finishes its
      // text instead. LOUD diag either way.
      const inReviewWindow =
        awaiting.tag === "parent-review" ||
        (node.state.stage === "split" && node.state.phase === "reviewing");
      const inSummaryWindow =
        awaiting.tag === "summary" || (node.state.stage === "split" && inRollupWindow(node));
      if (inReviewWindow || inSummaryWindow) {
        const turnLabel = inReviewWindow ? "review" : "summary";
        diag(
          `rogue ExitPlanMode DENIED: id=${req.id} during the ${turnLabel} window (node=${node.state.stage}/${node.state.phase}, awaiting=${awaiting.tag}) — this turn must not draft`,
        );
        await deps.resolvePermission({
          id: req.id,
          allow: false,
          message: `this turn must not call ExitPlanMode — finish the ${turnLabel} text`,
        });
        return;
      }
      if (
        node.state.stage === "open" &&
        (node.state.phase === "decomposing" || node.state.phase === "awaiting-decomposition-approval")
      ) {
        // The DECOMPOSITION plan (root: the master plan; PHASE 4 non-root: the node's own nested
        // decomposition). Parse + VALIDATE its sub-plan headers FIRST — BEFORE the live
        // writeAgentPlan — then write the plans-dir copy for sidebar nesting (root: flavor master,
        // nn = null; non-root: flavor sub, nn = the node's dotted PathKey), then land CHILDREN_PARSED
        // + DECOMPOSITION_DRAFTED (the reducer sets the unified gate + notifies).
        // INV-2 — VALIDATE-BEFORE-WRITE: a header-less draft, a header outside the 1-99 range, or an
        // empty children list throws a PlanValidationError — a RECOVERABLE drafting error, not a
        // crash. We DENY the held ExitPlanMode with the validation message (the same mechanism
        // requestChanges uses) so the SDK feeds it back as the tool error and the model redrafts a
        // valid decomposition. The run stays active; no FATAL, no terminal — and crucially the
        // MALFORMED MASTER IS NEVER PERSISTED (writeAgentPlan runs only after validation passes).
        // The discriminator is TYPED (`instanceof PlanValidationError`), never a message string
        // match: any OTHER (non-validation) error propagates to the ingest queue's catch → FATAL.
        // On success, capture each child's structured Mandate (section body + preamble); a re-draft
        // replaces the whole map so stale sections never leak across drafts.
        let parsed: ParsedMasterPlan;
        try {
          parsed = parseSubPlanHeaders(plan);
        } catch (err) {
          if (err instanceof PlanValidationError) {
            diag(`master-write: decomposition rejected, denying for redraft — ${err.message}`);
            await deps.resolvePermission({ id: req.id, allow: false, message: err.message });
            return;
          }
          throw err;
        }
        // DIAG: log the decomposition-write decision so a live run's dev-terminal trace confirms
        // the flavor keying (nn=null ⇒ Rust stamps flavor:master; dotted nn ⇒ flavor:sub nested
        // under the same tree_id). Reached ONLY after validation passed.
        const decompNn = path.length === 0 ? null : pathKey(path);
        diag(
          `master-write: path=writeAgentPlan tree_id=${st.tree_id} nn=${decompNn ?? "null"} flavor=${decompNn === null ? "master" : "sub"} node=${node.state.stage}/${node.state.phase}`,
        );
        const masterPath = await deps.writeAgentPlan(plan, st.tree_id, decompNn);
        diag(`master-write: wrote -> ${masterPath}`);
        // Child paths are minted as [...parentPath, parseNn(headerNn)] — the header NN is the
        // PER-LEVEL segment; the full dotted id derives from nesting. The mandate map stays keyed
        // by full PathKey: a (re-)draft REPLACES this node's descendant entries (so stale sections
        // never leak across drafts) while every OTHER level's mandates survive — a nested
        // decomposition must not wipe its ancestors'/siblings' mandates. At the root the filter
        // degenerates to the gen-1 full replace (every key descends from "").
        const parentKey = pathKey(path);
        const childPrefix = parentKey === "" ? "" : `${parentKey}.`;
        mandates = new Map([
          ...[...mandates.entries()].filter(([k]) => !k.startsWith(childPrefix)),
          ...parsed.subplans.map(
            (s): [PathKey, Mandate] => [
              pathKey([...path, s.nn]),
              { title: s.title, sectionBody: s.body, masterPreamble: parsed.preamble },
            ],
          ),
        ]);
        await dispatch({
          type: "CHILDREN_PARSED",
          path,
          children: parsed.subplans.map((s) => ({ nn: s.nn, title: s.title })),
        });
        // DRIVER-WRITE BOUNDARY: the decomposition's .plan-tree copy is a driver write (gen-2
        // DECOMPOSITION_DRAFTED carries no plan text) — "master.md" at the root, the dotted
        // "<pathKey>-plan.md" for a nested split (planName2). Written BETWEEN the two dispatches
        // to preserve the gen-1 wire order: writeAgentPlan → state.json (children persist) →
        // plan file → state.json (gate persist) → onAwaitingApproval.
        await deps.writePlanTreeFile(cwd, planName2(path), plan);
        // THE UNIFIED GATE: DECOMPOSITION_DRAFTED sets pendingApproval (kind "decomposition") and
        // emits notifyAwaitingApproval — the reducer owns the gate surface now (no driver-side
        // sentinel, no masterToolUseId).
        await dispatch({
          type: "DECOMPOSITION_DRAFTED",
          path,
          planPath: masterPath,
          plansDirPath: masterPath,
          toolUseId: req.id,
        });
        // PHASE 5 — ADJUST-NOTE CLEAR POINT (split child): this node's draft (its nested
        // decomposition) has landed; both prompt injections are behind us.
        clearAdjustNoteOnDraft(path);
        return;
      }
      if (node.state.stage === "leaf") {
        // A LEAF plan being drafted: SINGLE authoritative write here (learn the real path), then
        // dispatch NODE_DRAFTED carrying it (gen-2 events carry no plan text and Effect2 has no
        // writeAgentPlan kind — this is THE write).
        // DIAG: log the leaf-write decision so a live run's dev-terminal trace confirms each node is
        // written via the nn=<pathKey> path with the SAME tree_id as the master (⇒ Rust stamps
        // flavor:sub and the sidebar nests it under the master). One write per draft — re-drafts
        // overwrite the ledger entry, not duplicate it. Phase-2 wire: nn is the canonical dotted
        // PathKey STRING ("01" at depth 1, "02.01" deeper) — Rust rejects a bare number.
        // ROOT-SINGLE EXCEPTION: the root single-collapse child is the ONLY plan its tree will
        // ever hold — no decomposition/master file is ever written (root.planPath stays null), so
        // a dotted nn would mint an ORPHAN flavor:sub that the Rust arranger demotes to a
        // standalone with its tree_id NULLED (and the live sidebar placeholder, matched by
        // tree_id, never cedes to the real row). Write it nn=null instead: Rust stamps the
        // root-level flavor (a master with 0 children renders as a normal flat row) and the
        // record keeps its tree_id. isRootCollapseChild is the canonical predicate — the sole
        // child of a planPath-less root split, the shape ONLY the root confident-single collapse
        // mints — so genuine sub-plans of split trees (any depth) keep their dotted nn.
        const nnPath = isRootCollapseChild(st.root, path) ? null : pathKey(path);
        diag(
          `sub-write: path=writeAgentPlan tree_id=${st.tree_id} nn=${nnPath ?? "null"} flavor=${nnPath === null ? "master (root-single)" : "sub"} node=${node.state.stage}/${node.state.phase}`,
        );
        const realPath = await deps.writeAgentPlan(plan, st.tree_id, nnPath);
        diag(`sub-write: wrote -> ${realPath}`);
        await dispatch({
          type: "NODE_DRAFTED",
          path,
          toolUseId: req.id,
          planPath: realPath,
          plansDirPath: realPath,
        });
        // PHASE 5 — ADJUST-NOTE CLEAR POINT (leaf child): the note was injected into this child's
        // recon AND draft prompts; its DRAFTED dispatch ends the note's one-sibling scope.
        clearAdjustNoteOnDraft(path);
        return;
      }
      // Any other node state (open/recon, open/sizing, …): an ExitPlanMode here is not a draft
      // boundary the machine recognizes — ignore it (gen-1 behavior for an unpointed sub).
      return;
    }
    if (req.tool === "AskUserQuestion") {
      const questions = (req.input as AskUserQuestionInput).questions;
      clarifyQuestions.set(req.id, questions);
      // INTENT-WATCHDOG PAUSE: a held AskUserQuestion inside the intent turn waits on the USER —
      // arbitrarily long, legitimately. The intent watchdog must not FATAL a healthy run parked on
      // a clarify gate; it re-arms when answerClarify resolves the hold.
      if (awaiting.tag === "intent") clearTurnWatchdog();
      await dispatch({ type: "CLARIFY_REQUESTED", toolUseId: req.id, questions });
      return;
    }
  }

  // ---- RESUME (Phase 3): non-serialized driver-state reload + per-phase continuation -----------
  //
  // The ledger captures every node's stage×phase, but the DRIVER also holds state nothing on disk
  // describes directly: the prior-sibling `summaries` text (threaded into later recon/draft prompts)
  // and the per-child `mandates` (parsed from each split's decomposition plan). resume() reloads BOTH
  // from the on-disk .plan-tree/ artifacts (summary files + plan files) so a resumed run threads the
  // same context a never-killed run would. Without this reload, multi-sibling resume is silently
  // context-stripped (a re-sent recon/draft prompt would carry NO prior summaries/mandates).

  // Walk the tree and reload `summaries` + `mandates` from disk. Clears both maps first (a resume must
  // not inherit a previous run's leftovers — resume() guarantees no run was active, but defense in
  // depth). Skips entirely when no readPlanTreeFile dep is wired (older fakes) — the resumed run then
  // threads no prior context (degraded, not broken).
  const reloadDriverStateFromDisk = async (root: TreeNode): Promise<void> => {
    summaries.clear();
    mandates = new Map();
    const read = deps.readPlanTreeFile;
    if (!read) return;
    // Depth-first walk minting each node's NodePath. For EVERY node whose state carries a non-null
    // summaryPath, read summaryName2(path) into summaries[pathKey]. For EVERY split node with a
    // non-null decomposition plan (planPath), read planName2(path) and parse its sub-plan headers
    // into mandates keyed EXACTLY as the live ingestPermission decomposition path keys them
    // (pathKey([...path, childNn]) -> {title, sectionBody, masterPreamble}).
    const visit = async (node: TreeNode, path: NodePath): Promise<void> => {
      // SUMMARIES: a summarized node (leaf or split) recorded its summary file at summaryName2(path).
      // The root never writes a summary file (summaryName2 throws on []), and a summarized split's
      // own roll-up file IS summaryName2(path) — so guard out the root explicitly.
      if (
        path.length > 0 &&
        node.state.stage !== "open" &&
        node.state.summaryPath !== null
      ) {
        const text = await read(cwd, summaryName2(path));
        if (text !== null) summaries.set(pathKey(path), text);
      }
      // MANDATES: a split node that actually drafted a decomposition (planPath non-null) records its
      // children's mandates from that plan file. A planPath-less split is the root confident-single
      // collapse (no decomposition plan exists) — nothing to parse.
      if (node.state.stage === "split" && node.state.planPath !== null) {
        const plan = await read(cwd, planName2(path));
        if (plan !== null) {
          // BEST-EFFORT reload (degraded, not broken). INV-2: a malformed on-disk decomposition
          // (header-less or out-of-range — a PlanValidationError) must NOT abort the whole resume;
          // it just means this subtree's mandates can't be reloaded (the resumed run threads no
          // prior mandate for it, the same degraded outcome as a missing plan file). The
          // resumed-APPROVE re-parse (which DOES need valid headers to materialize children) keeps
          // its own throw — there a malformed master is a genuine redraft signal handled upstream.
          try {
            const parsed = parseSubPlanHeaders(plan);
            for (const s of parsed.subplans) {
              mandates.set(pathKey([...path, s.nn]), {
                title: s.title,
                sectionBody: s.body,
                masterPreamble: parsed.preamble,
              });
            }
          } catch (err) {
            if (!(err instanceof PlanValidationError)) throw err;
            diag(
              `resume reload: decomposition plan ${planName2(path)} failed validation (skipping mandate reload, degraded): ${err.message}`,
            );
          }
        }
      }
      if (node.state.stage === "split") {
        for (const child of node.state.children) {
          await visit(child, [...path, child.nn]);
        }
      }
    };
    await visit(root, []);
  };

  // The synthetic toolUseId a resumed gate carries (its live permission id died with the prior
  // process). Prefixed `resumed:` so a stray live-id match is impossible.
  const resumedToolUseId = (path: NodePath): string => `resumed:${pathKey(path)}`;

  // Continue from the resolved ResumePlan. Mirrors the live phase boundaries:
  //   - "gate": re-present the held approval gate PURELY from disk (no tokens). Build an in-memory
  //     ApprovalGate2 from the on-disk artifact, set state.pendingApproval directly (NOT via the
  //     reducer — there is no DRAFTED event to replay), set heldPermissionId to the synthetic id,
  //     mark resumedGate, fire onAwaitingApproval + emit a snapshot. Send NO prompt.
  //   - "resend": ARM the matching `awaiting` variant (arm-before-send) then re-send that step's
  //     existing prompt. Prior summaries thread in via priorSummaries(path) (reloaded above).
  const resumeActionForPhase = async (plan: ResumePlan): Promise<void> => {
    if (plan.kind === "gate") {
      // Resolve the artifact the user reviews. LEAF: planPath/plansDirPath came straight off the
      // node (real paths). DECOMPOSITION: planPath is a FILENAME relative to .plan-tree/ (from
      // planName2 — "master.md" or "<pathKey>-plan.md"; plansDirPath is null) — resolve it to the
      // real on-disk path the user reviews by joining it under <cwd>/.plan-tree/. The live
      // decomposition write used the SAME path for both planPath and plansDirPath, so mirror that.
      const planPath =
        plan.gateKind === "decomposition" ? `${cwd}/.plan-tree/${plan.planPath}` : plan.planPath;
      const plansDirPath = plan.plansDirPath ?? planPath;
      // INV-3 — PHASE-ONLY RE-ARM. recoveryFor returns the SAME opaque decomposition gate ResumePlan
      // for BOTH `open/decomposing` (a draft that survived but whose DRAFTED gate event died) and
      // `open/awaiting-decomposition-approval` (the gate already armed at kill). Only the FORMER needs
      // a phase fix: re-present from `decomposing` and the node stays `decomposing`, so a later Approve
      // dispatches DECOMPOSITION_APPROVED whose guard requires `awaiting-decomposition-approval` →
      // THROW → FATAL (the dead-end this fixes). Dispatch GATE_RE_PRESENTED — keyed on the REHYDRATED
      // node actually being `open/decomposing` with a decomposition gate — to advance ONLY the phase
      // (no persist, no notify; the driver presents the gate below). The already-armed
      // `awaiting-decomposition-approval` case skips this (the guard would reject it) and is unchanged.
      if (state && plan.gateKind === "decomposition") {
        const reNode = nodeAtPath(state.root, plan.path);
        if (reNode && reNode.state.stage === "open" && reNode.state.phase === "decomposing") {
          await dispatch({ type: "GATE_RE_PRESENTED", path: plan.path });
        }
      }
      const gate: ApprovalGate2 = {
        path: plan.path,
        kind: plan.gateKind,
        toolUseId: resumedToolUseId(plan.path),
        planPath,
        plansDirPath,
        redraftCount: plan.redraftCount,
      };
      if (state) state.pendingApproval = gate;
      heldPermissionId = gate.toolUseId;
      resumedGate = true;
      awaiting = { tag: "idle" };
      diag(
        `resume: re-presenting ${gate.kind} gate at "${pathKey(gate.path)}" from disk (planPath=${planPath}, synthetic id=${gate.toolUseId})`,
      );
      for (const o of observers) o.onAwaitingApproval?.(gate);
      if (state) emitSnapshot(toSnapshot2(state));
      return;
    }
    if (plan.kind === "acceptance") {
      // PHASE 5 — RE-MINT THE FORCED ACCEPTANCE GATE on resume. The root is parked in its acceptance
      // window (running-children, all children summarized, baseline frozen, no verdict) — the build is
      // COMPLETE and the only missing thing is the human verdict. There is NO model turn to re-send;
      // we just re-arm the transient gate exactly as the live notifyAcceptanceReview path does so the
      // acceptance bar (Approve / Accept-divergence / Open baseline) re-appears. After this,
      // approveAcceptance()/divergeAcceptance() drive the deferred finalize to done.
      //
      // The gate is re-derived (NOT persisted): cwd is the resume cwd; openTarget defaults to
      // "index.html" (mirroring the runEffect augmentation); runCommand is unknown on resume (the
      // reducer never knew it and it was never serialized). round is 1 (single-round acceptance today).
      const gate: AcceptanceGate = {
        cwd,
        openTarget: "index.html",
        runCommand: null,
        round: 1,
      };
      if (state) state.pendingAcceptance = gate;
      awaiting = { tag: "idle" }; // no turn in flight — the gate waits on a human verdict.
      diag(`resume: re-minting the forced acceptance gate (cwd=${cwd}, openTarget=${gate.openTarget})`);
      for (const o of observers) o.onAcceptanceReview?.(gate);
      // Best-effort OPEN the baseline so the user can exercise the just-built result against it — the
      // same non-fatal best-effort the live notifyAcceptanceReview effect performs.
      if (deps.openBaseline && gate.openTarget !== null) {
        try {
          await deps.openBaseline(cwd, gate.openTarget);
          diag(`resume acceptance: opened baseline "${gate.openTarget}"`);
        } catch (err) {
          console.error("open_baseline failed (non-fatal)", err);
          diag(`resume acceptance: open_baseline failed (non-fatal): ${String(err)}`);
        }
      }
      if (state) emitSnapshot(toSnapshot2(state));
      return;
    }
    // PHASE 2b NEW RESUME KINDS — `restart` / `prototype-gate` / `rewind`. The pure scope layer
    // (resumeScopeForRoot) now surfaces these as resumable verdicts; this is their DRIVER continuation.
    // (`leaf/executing` is NOT here — Phase 3 owns the duplicate-write recovery; its rewind stays
    // non-offerable, so it never reaches resumeActionForPhase as a resumable.)
    if (plan.kind === "restart") {
      // RE-ENTER THE GENESIS CLARIFY STEP. The rehydrated root is open/clarifying-intent (the genesis
      // window); the session was already opened above in the DERIVED policy, which writePolicyFor2
      // pins to "prototype" for clarifying-intent (so the prototype-write containment hook is already
      // installed — same as a fresh start()'s `permissionMode: "prototype"`). All we replay is the
      // fresh-start clarify SEND: pre-create the prototype dir (the visual clarifier may write into it),
      // ARM the `intent` awaiting BEFORE the send (arm-before-send — the result can land as the send
      // resolves, exactly the start() discipline), arm the intent watchdog, and re-send intentPrompt
      // SEEDED FROM THE ROOT TITLE (`request`, the original request read in resume()). The next
      // clarifier turn is then handled by the SAME `case "intent"` consume branch a fresh run uses.
      await deps.ensurePrototypeDir?.(cwd);
      awaiting = { tag: "intent", buffer: "" };
      armTurnWatchdog("intent", []);
      diag(`resume: re-entering genesis clarify (restart from "${plan.from}"), sending intentPrompt seeded from title`);
      await deps.sendMessage(intentPrompt(request));
      return;
    }
    if (plan.kind === "prototype-gate") {
      // RE-PRESENT THE PROTOTYPE REVIEW GATE FROM DISK. The rehydrated root is open/prototype-review;
      // the session was opened above in the DERIVED "prototype" policy (writePolicyFor2 pins
      // prototype-review → "prototype"), so the PreToolUse containment hook (createPrototypePreToolUseHook
      // / prototypeHookDecision in sidecar/permissions.ts) is ACTIVE — a resumed prototype-review
      // session's writes stay confined under <cwd>/.plan-tree/prototype/, NOT lost. (The containment is
      // installed purely by startSession's `permissionMode: "prototype"`; nothing else to replicate.)
      //
      // The transient PrototypeGate died with the prior process (it is never serialized — see
      // pendingPrototype), so RECONSTRUCT a minimal gate from the durable on-disk artifacts: the
      // prototype dir is <cwd>/.plan-tree/prototype/ and its primary visual is index.html (the same
      // convention the acceptance gate's openTarget uses). round is prototypeRound+1 (=1 — resume reset
      // prototypeRound to 0). INTENT.md does not exist yet at prototype-review (PROTOTYPE_APPROVED is
      // what writes it), so pendingIntentText stays null; the user re-approves (composing INTENT.md from
      // the visual block) or refines (regenerating the intent prose). Set pendingPrototype directly (NOT
      // via the reducer — there is no PROTOTYPE_READY to replay; the root is ALREADY prototype-review),
      // fire onPrototypeReview, emit a snapshot. Send NO prompt — the gate resolves through the
      // approvePrototype()/refinePrototype() handle methods, exactly like a live prototype gate.
      const protoDir = `${cwd}/.plan-tree/prototype`;
      const gate: PrototypeGate = {
        kind: "html",
        paths: [`${protoDir}/index.html`],
        screenshot: null,
        inlinePreview: null,
        variants: [],
        round: prototypeRound + 1,
        cwd,
      };
      if (state) state.pendingPrototype = gate;
      awaiting = { tag: "idle" };
      diag(`resume: re-presenting prototype-review gate from disk (dir=${protoDir}, round=${gate.round})`);
      for (const o of observers) o.onPrototypeReview?.(gate);
      if (state) emitSnapshot(toSnapshot2(state));
      return;
    }
    // REWIND — re-present the NEAREST DURABLE GATE rather than discard the run.
    if (plan.kind === "rewind") {
      if (plan.toGate === "decomposition") {
        // THE THROWING-GATE PATH, NOW UNREACHABLE-BY-CONSTRUCTION. A `decomposition` rewind would
        // re-present a node's decomposition approval gate. That is ONLY coherent for a node STILL at
        // open/awaiting-decomposition-approval — but recoveryFor no longer emits an OFFERABLE
        // decomposition rewind for ANY phase (the rollup / between-children-review cases that used to
        // dead-end here now `resend` their in-flight turn instead). If a decomposition rewind ever
        // reaches here, the node is already split, so approving the re-presented gate would dispatch
        // CHILDREN_PARSED / DECOMPOSITION_APPROVED against a non-open node and THROW — a wedged Resume
        // button. Refuse loudly up front (a clear FATAL) rather than re-present a gate that dead-ends on
        // click. The branch is retained as a guard, not as a live path.
        const node = nodeAtPath(state!.root, plan.path);
        const reason =
          `resume: refusing to re-present a decomposition gate at "${pathKey(plan.path)}" — the node is ` +
          `${node ? `${node.state.stage}/${node.state.phase}` : "missing"}, not ` +
          `open/awaiting-decomposition-approval (approving it would dead-end). Start a new plan.`;
        diag(reason);
        awaiting = { tag: "idle" };
        await dispatch({ type: "FATAL", message: reason });
        return;
      }
      // PHASE 3b — THE EXECUTING-CONTINUE PATH. A leaf/executing rewind is fundamentally different
      // from a torn leaf-approval gate: the plan is ALREADY approved and the node is ALREADY at
      // leaf/executing on disk — re-presenting its APPROVAL gate would (on approve) send
      // resumedLeafApprovalPrompt ("Begin implementing it now"), RESTARTING implementation from scratch
      // and re-applying edits already on disk (violates invariant I3). Instead we re-ENTER execution
      // directly with the AUDIT-AND-CONTINUE prompt: the rehydrated node is ALREADY leaf/executing, so
      // we DON'T dispatch APPROVE (that would be illegal against a non-gate node) — we just ARM `exec`
      // (arm-before-send, the EXEC_DONE the next result fires is legal against leaf/executing) and send
      // resumedLeafContinuePrompt so the model inspects the working tree and finishes the remaining
      // steps. Detected from the NODE's state at `path` (the model's `requiresConfirm` marker is the
      // banner's P3c concern, not the routing trigger here). The banner gates REACHING here behind the
      // partial-apply confirm (P3c).
      const rewindNode = nodeAtPath(state!.root, plan.path);
      if (
        plan.planPath !== null &&
        rewindNode?.state.stage === "leaf" &&
        rewindNode.state.phase === "executing"
      ) {
        // BEST-EFFORT durable-plan check: a LEAF plan lives in the PLANS STORE at its absolute
        // `~/.claude/plans/...` planPath (writeAgentPlan's write seam — leaves never write `.plan-tree/`
        // plans; only decomposition splits do). Verify it through the PLANS channel by that absolute
        // path — NOT readPlanTreeFile(cwd, planName2(path)), which targets `.plan-tree/<NN-plan.md>` (a
        // file a leaf NEVER writes; the Rust allow-list also rejects an absolute name), so it would
        // ALWAYS read null and FATAL every real executing-continue. Read it so the continuation
        // references a plan that is actually on disk; if it is genuinely gone (torn artifact, the Rust
        // command REJECTS) degrade SAFELY to a clear terminal rather than tell the model to "continue" a
        // plan it cannot read. Skipped when the read dep is absent (older fakes) — then we proceed on the
        // planPath off the node, the same trust the gate path gives planPath.
        if (deps.readPlanContents) {
          let missing = false;
          try {
            // read_plan_contents resolves the text or REJECTS — a throw means absent/out-of-bounds.
            await deps.readPlanContents(plan.planPath);
          } catch {
            missing = true;
          }
          if (missing) {
            const reason =
              `resume: cannot continue executing leaf at "${pathKey(plan.path)}" — its approved plan ` +
              `(${plan.planPath}) is gone from disk` +
              (plan.hazard ? ` (${plan.hazard})` : "") +
              ". Start a new plan.";
            diag(reason);
            awaiting = { tag: "idle" };
            await dispatch({ type: "FATAL", message: reason });
            return;
          }
        }
        // ARM BEFORE SEND (the continue turn's result may land as sendMessage resolves — start()
        // discipline). The node STAYS leaf/executing (no APPROVE); EXEC_DONE on the next result then
        // advances it to summary exactly as a normal execution completion does.
        awaiting = { tag: "exec", path: plan.path, buffer: "" };
        diag(
          `resume: CONTINUING leaf/executing at "${pathKey(plan.path)}" (audit-and-continue, planPath=${plan.planPath}) — armed exec, NOT re-presenting the approval gate`,
        );
        await deps.sendMessage(resumedLeafContinuePrompt(plan.planPath));
        return;
      }
      // toGate "leaf-approval" / "leaf" — a torn/degenerate leaf checkpoint. When the leaf plan
      // artifact survived (planPath non-null) re-present its approval gate; when it is gone (planPath
      // null — a torn ledger, or the runtime-degenerate no-active-node rewind) there is NOTHING durable
      // to re-present, so surface a SAFE TERMINAL state (mark terminal + a clear FATAL message) rather
      // than crash — I1 (no dead-ends) at runtime.
      if (plan.planPath !== null) {
        const gate: ApprovalGate2 = {
          path: plan.path,
          kind: "leaf",
          toolUseId: resumedToolUseId(plan.path),
          planPath: plan.planPath,
          plansDirPath: plan.planPath,
          redraftCount: nodeAtPath(state!.root, plan.path)?.redraftCount ?? 0,
        };
        if (state) state.pendingApproval = gate;
        heldPermissionId = gate.toolUseId;
        resumedGate = true;
        awaiting = { tag: "idle" };
        diag(`resume: rewinding to leaf-approval gate at "${pathKey(plan.path)}" from disk (planPath=${plan.planPath})`);
        for (const o of observers) o.onAwaitingApproval?.(gate);
        if (state) emitSnapshot(toSnapshot2(state));
        return;
      }
      // NO durable plan artifact — there is nothing to re-present. Surface a clear terminal message
      // (the hazard names what made the node unrecoverable) and END the run cleanly via the FATAL
      // path (markTerminal + endSdkSession + onFatal), instead of throwing into the resume catch.
      const reason =
        `resume: cannot rewind to a leaf gate at "${pathKey(plan.path)}" — its plan artifact is gone` +
        (plan.hazard ? ` (${plan.hazard})` : "") +
        ". Start a new plan.";
      diag(reason);
      awaiting = { tag: "idle" };
      await dispatch({ type: "FATAL", message: reason });
      return;
    }
    // RESEND: arm the matching variant BEFORE sending its prompt (the result may arrive as the send
    // resolves — same discipline as start()). confirmedIntent is null on resume (the genesis turn's
    // capture is gone); that is acceptable — the recon prompt simply omits the intent block.
    const path = plan.path;
    switch (plan.awaiting) {
      case "recon": {
        awaiting = { tag: "recon", path, buffer: "" };
        const prompt =
          path.length === 0
            ? reconPrompt(request, confirmedIntent)
            : subReconPrompt(path, mandateFor(path), priorSummaries(parentPathOf(path)), adjustNoteFor(path));
        diag(`resume: re-sending recon prompt for "${pathKey(path)}"`);
        await deps.sendMessage(prompt);
        return;
      }
      case "sizer": {
        awaiting = { tag: "sizer", path, buffer: "" };
        diag(`resume: re-sending sizer prompt for "${pathKey(path)}"`);
        await deps.sendMessage(sizerPrompt());
        return;
      }
      case "draft": {
        // A "draft" resend is ONLY ever a leaf/drafting node (resumeScopeForRoot maps it there). A
        // leaf is always drafted via subDraftPrompt in the live code — even the root single-collapse
        // child (line: recon branch leaf send). masterDraftPrompt is the DECOMPOSITION draft, which
        // is a "gate" phase here, never "draft". So subDraftPrompt is the faithful re-send. The next
        // signal is the node's ExitPlanMode hold (not a `result`), so stay idle.
        awaiting = { tag: "idle" };
        diag(`resume: re-sending leaf draft prompt for "${pathKey(path)}"`);
        await deps.sendMessage(
          subDraftPrompt(
            path,
            mandateFor(path),
            priorSummaries(parentPathOf(path)),
            adjustNoteFor(path),
            hasBaseline(),
          ),
        );
        return;
      }
      case "decompose": {
        // `open/decomposing` with NO decomposition artifact on disk (the disk probe said ABSENT — see
        // recoveryFor's open/decomposing case): the draft was never produced, so RE-SEND the decompose
        // turn fresh. This is the faithful mirror of the live SIZER_DONE→sendDecompositionDraft step:
        // the root re-drafts its MASTER plan from the request; a nested split re-drafts its own
        // decomposition from its mandate. We do NOT re-dispatch SIZER_DONE — the rehydrated node is
        // ALREADY at open/decomposing (the sizer's verdict is durable on the tree), so re-sizing would
        // double-size the same scope. redraftCount is carried by the rehydrated node untouched (the
        // prompts thread any feedback via mandateFor/adjustNoteFor, exactly as a live redraft does).
        //
        // The driver's non-serialized state (summaries/mandates) for THIS tree is already reloaded:
        // resume() runs reloadDriverStateFromDisk BEFORE dispatching to resumeActionForPhase, so a nested
        // re-draft's mandateFor(path)/priorSummaries(...) already thread the same prior context a
        // never-killed run would. No second reload here.
        // The next signal after the draft is the node's ExitPlanMode hold (routed by the active node's
        // open/decomposing state in ingestPermissionImpl), NOT a `result` — so arm idle, exactly as the
        // live decompose step leaves `awaiting` idle.
        awaiting = { tag: "idle" };
        diag(`resume: re-sending decompose draft prompt for "${pathKey(path)}"`);
        if (path.length === 0) {
          await deps.sendMessage(masterDraftPrompt(request, undefined, confirmedIntent, hasBaseline()));
        } else {
          await deps.sendMessage(
            nestedDecompositionDraftPrompt(
              path,
              mandateFor(path),
              priorSummaries(parentPathOf(path)),
              adjustNoteFor(path),
              hasBaseline(),
            ),
          );
        }
        return;
      }
      case "rollup": {
        // DEFECT FIX — RE-RUN THE IN-FLIGHT ROLL-UP SUMMARY TURN. The active node is a NON-ROOT split
        // resting in its roll-up window (running-children, all children summarized). The decomposition
        // is already approved+durable; the only lost work is the un-landed roll-up summary turn.
        // reloadDriverStateFromDisk (run by resume() before this) has reloaded the DIRECT children's
        // summaries, so priorSummaries(path) feeds rollupSummaryPrompt exactly as the live ascent does.
        // Arm `summary` (arm-before-send) + its watchdog; the result re-enters the `summary` consume
        // branch, which OVERWRITES summaryName2(path) (idempotent) and dispatches SUMMARY_WRITTEN{path}
        // to complete the split and continue the ascent. NO decomposition gate is re-presented (the node
        // is already split — a re-presented gate would dead-end on approve).
        awaiting = { tag: "summary", path, buffer: "" };
        armTurnWatchdog("summary", path);
        diag(`resume: re-running roll-up summary turn for "${pathKey(path)}"`);
        await deps.sendMessage(rollupSummaryPrompt(path, priorSummaries(path)));
        return;
      }
      case "review": {
        // DEFECT FIX — RE-RUN THE IN-FLIGHT PARENT-REVIEW TURN. The active node is a split in `reviewing`
        // (between children). The decomposition is already approved+durable; the only lost work is the
        // un-landed parent-review turn — a NO-TOOLS turn, so re-running it has no duplicate side effects.
        // The REVIEWED child is the rightmost SUMMARIZED direct child (the one whose summary just landed
        // when the parent entered reviewing); the remaining siblings are the pending children. Their
        // mandates were reloaded by reloadDriverStateFromDisk; the reviewed child's summary is in
        // `summaries` after the same reload. Re-send parentReviewPrompt and arm `parent-review`; the
        // result re-enters the `parent-review` consume branch, which dispatches PARENT_REVIEW_DONE{path}
        // (legal from split/reviewing) and advances to the next pending child's recon.
        const node = nodeAtPath(state!.root, path);
        if (!node || node.state.stage !== "split" || node.state.phase !== "reviewing") {
          throw new Error(
            `resume review: node "${pathKey(path)}" is ${node ? `${node.state.stage}/${node.state.phase}` : "missing"}, expected split/reviewing`,
          );
        }
        const summarized = node.state.children.filter(
          (c) => c.state.stage !== "open" && c.state.phase === "summarized",
        );
        const reviewedChildNode = summarized[summarized.length - 1];
        if (!reviewedChildNode) {
          // assertCoherent2 forbids reviewing without ≥1 summarized child — loud, never silent.
          throw new Error(`resume review: reviewing node "${pathKey(path)}" has no summarized child to review`);
        }
        const reviewedChild: NodePath = [...path, reviewedChildNode.nn];
        const childSummary = summaries.get(pathKey(reviewedChild)) ?? "";
        const remaining = node.state.children
          .filter((c) => c.state.stage === "open" && c.state.phase === "pending")
          .map((c) => {
            const sibPath: NodePath = [...path, c.nn];
            return { path: sibPath, mandate: mandateFor(sibPath) };
          });
        awaiting = { tag: "parent-review", parentPath: path, reviewedChild, buffer: "" };
        armTurnWatchdog("parent-review", path);
        diag(`resume: re-running parent-review turn for "${pathKey(path)}" (reviewed child "${pathKey(reviewedChild)}")`);
        await deps.sendMessage(parentReviewPrompt(reviewedChild, childSummary, remaining));
        return;
      }
    }
    assertNever(plan.awaiting);
  };

  // ---- serialized ingest queue ---------------------------------------------------------------
  //
  // Live frames (agent-stream, tool-permission-requested) reach the handle fire-and-forget through
  // the index.ts bridge, possibly back-to-back within one tick. enqueueIngest chains each frame's
  // work onto a single tail promise so frames are processed in strict submission order — the union's
  // single-armed-step invariant only holds if no two frames interleave mid-await. ERROR ISOLATION:
  // the tail is rebuilt with `.catch` so a throw in one frame is logged and the tail stays RESOLVED,
  // letting the next frame still run (a poisoned chain would silently drop every later frame).
  let ingestQueue: Promise<void> = Promise.resolve();
  const enqueueIngest = (work: () => Promise<void>): Promise<void> => {
    const run = ingestQueue.then(work);
    // ERROR ISOLATION + VISIBLE FAILURE: a throw in one frame must not silently stall the run (it
    // would hang with no terminal signal). Log it, then drive the run to a terminal FATAL state so
    // the UI surfaces the error and resets. The fatal-dispatch itself is wrapped so a throw there
    // (e.g. the run is already terminal) still leaves the tail RESOLVED — the chain is never
    // poisoned and later frames (if any) can still run.
    ingestQueue = run.catch(async (err) => {
      console.error("orchestrator ingest frame failed", err);
      // LOUD diag: if a pre-result frame throws here it dispatches FATAL -> markTerminal, which would
      // deactivate the orchestrator BEFORE the recon result lands (making the bridge gate false — the
      // prime suspect for the halt). Surface it in the dev terminal with the error text.
      const message = err instanceof Error ? err.message : String(err);
      diag(`enqueueIngest CATCH: ingest frame threw active=${active} err=${message}`);
      // INV-2 — TYPED NON-FATAL: a PlanValidationError must NEVER FATAL the run (it is a recoverable
      // redraft signal). The live decomposition-draft path already catches it at the parse site and
      // denies-for-redraft; this is the BACKSTOP for the resume re-parse / reloadDriverStateFromDisk
      // paths (a malformed on-disk master rehydrated on resume) where it can reach the queue
      // unguarded. Discriminated by TYPE (instanceof), never a message string. Log it, leave the run
      // active, and let the held gate / redraft flow continue.
      if (err instanceof PlanValidationError) {
        diag(`enqueueIngest CATCH: PlanValidationError (recoverable, NOT fatal) — ${message}`);
        return;
      }
      try {
        if (active) {
          await dispatch({ type: "FATAL", message: `orchestrator ingest frame failed: ${message}` });
        }
      } catch (fatalErr) {
        console.error("orchestrator FATAL dispatch after ingest failure also failed", fatalErr);
      }
    });
    return ingestQueue;
  };

  const handle: OrchestratorHandle = {
    start: async ({ cwd: startCwd, request: startRequest, images: startImages }) => {
      // Idempotent-guarded: a second start while active is a no-op (the seam is single-owner). Return
      // false so the composer does not treat a dead start as a real one (and close its modal).
      if (active) return false;
      cwd = startCwd;
      request = startRequest;
      // Fresh run: no intent confirmed yet (captured at the intent boundary below), no pending
      // adjust note, and no prototype state (a stale round count must never leak across runs).
      confirmedIntent = null;
      adjustNote = null;
      pendingIntentText = null;
      prototypeRound = 0;
      autoApproveNext = false;
      // The session below opens in the DERIVED GENESIS policy ("prototype": the root opens in
      // clarifying-intent, where writePolicyFor2 derives "prototype" — throwaway prototype
      // artifacts may be written under .plan-tree/prototype/, nothing else). Initializing the
      // cache to the same value means the START dispatch's policy seam fires NO setMode — which
      // matters because the session is not open yet at that dispatch (the sidecar drops a
      // pre-start set-permission-mode). The first real assert is "plan" at the
      // INTENT_CLARIFIED/PROTOTYPE_APPROVED boundary, when the session is live.
      assertedPolicy = "prototype";
      active = true;
      activeOrchestrator = handle;
      diag("start(): active set true, activeOrchestrator registered");
      // CLEANUP-ON-THROW: everything past this point can reject (the START dispatch's
      // resetPlanTreeDir effect is the first awaitable — a disk failure lands here), and the guard
      // is already armed. Without the catch the rejection escapes with `active` stuck true and
      // `activeOrchestrator` registered: the composer shows the error but isOrchestrationActive()
      // stays true and every retry hits the idempotency guard — the orchestrator is wedged for the
      // session. markTerminal performs the same terminal bookkeeping every other terminal path uses
      // (active=false, watchdog cleared, deregistered); disarm `awaiting` too (markTerminal does
      // not own it), then RETHROW so the composer still surfaces the message.
      try {
        const treeId = newTreeId();
        // Genesis: build the fresh tree (persists state.json). START now lands in `clarifying-intent`.
        await dispatch({ type: "START", treeId, request, nowMs: nowFn() });
        // Open the single SDK session in the derived genesis policy ("prototype" — see the
        // assertedPolicy note above), then send the INTENT prompt and arm "intent" so the first
        // turn-completion `result` advances the sequencer (intent → recon/prototype-review → …).
        await deps.startSession({ cwd, permissionMode: "prototype" });
        // VISUAL MODE: pre-create <cwd>/.plan-tree/prototype/ BEFORE the intent prompt goes out —
        // the sidecar's "prototype" policy only allows writes UNDER the dir (it cannot mkdir it),
        // and the prompt tells the clarifier the dir already exists. Optional dep (older fakes):
        // absent ⇒ skipped.
        await deps.ensurePrototypeDir?.(cwd);
        // Arm BEFORE sending: send_agent_message returns once the line is queued, and the turn's
        // `result` frame can reach ingestStream before/at the same flush as this await settling. If we
        // armed after the await, that result would land while awaiting is idle and be swallowed —
        // the run would halt at the opening phase (the minecraft-clone bug, now at the intent arm).
        awaiting = { tag: "intent", buffer: "" };
        armTurnWatchdog("intent", []);
        diag("start(): armed intent, sending intentPrompt");
        // Multimodal first turn: thread the user's attached images into ONLY this first intent send
        // (omit-when-empty — every other deps.sendMessage in the driver stays text-only). When images
        // are present, intentPrompt also gets the forwarding directive so the main agent relays the
        // visual context into the text-only subagents it spawns.
        const hasStartImages = !!(startImages && startImages.length);
        await deps.sendMessage(
          intentPrompt(request, hasStartImages),
          hasStartImages ? startImages : undefined,
        );
      } catch (err) {
        markTerminal("start() threw");
        awaiting = { tag: "idle" };
        // Best-effort: if startSession already opened the SDK session before the throw, end it so a
        // live session can never coexist with isOrchestrationActive()===false (the Stop-routing
        // desync endSdkSession exists to prevent). Both inner calls are individually caught.
        await endSdkSession();
        throw err;
      }
      return true;
    },

    // RESUME (Phase 3). Mirrors start()'s setup discipline — register the active guard, prime the
    // policy cache, open the session, arm-before-send — but seeds from the ledger and re-presents/
    // re-sends instead of dispatching a fresh START.
    resume: async ({ cwd: resumeCwd, ledger }) => {
      // Idempotent-guarded exactly like start(): a second entry while active is a no-op.
      if (active) return false;
      // Seed the in-memory state from the ledger (pure: runs assertCoherent2, copies sdk_session_id,
      // nulls all transient gates). A torn ledger throws here — let it propagate to the caller (the
      // frontend wraps the click), nothing is registered yet.
      state = rehydrateState2(ledger);
      cwd = resumeCwd;
      request = ledger.root.title;
      // DISK-PROBE SEAM (real wiring): resumeScopeForRoot is PURE+synchronous, but the decomposing
      // disambiguation needs a real on-disk check (does planName2(activePath) exist under
      // <cwd>/.plan-tree/?). recoveryFor only ever probes the ACTIVE node's path (the open/decomposing
      // case), so pre-read that single artifact ASYNCHRONOUSLY here and back the synchronous predicate
      // with the cached result. A successful NON-NULL read ⇒ "present" (re-present the decomposition
      // gate, no re-draft); null/absent or no readPlanTreeFile dep (older fakes) ⇒ "absent" (re-send
      // the decompose draft) — the conservative default. The predicate matches on pathKey so a probe of
      // any other path (none today) falls through to the absent default rather than a phantom hit.
      const decompositionArtifactCache = new Map<string, boolean>();
      const activeForProbe = activePathOf(state.root);
      if (activeForProbe !== null && deps.readPlanTreeFile) {
        const text = await deps.readPlanTreeFile(cwd, planName2(activeForProbe));
        decompositionArtifactCache.set(pathKey(activeForProbe), text !== null);
      }
      const decompositionArtifactExists = (path: NodePath): boolean =>
        decompositionArtifactCache.get(pathKey(path)) ?? false;
      // Resolve the resume scope. If the active phase is not resumable, do NOT start a run — the
      // frontend should have shown the blocked message instead of a Resume button, but guard anyway.
      // Pass the run-level facts (baseline_ / acceptance_) so the PHASE-5 acceptance window can be
      // classified as resumable (a baseline-bearing root parked awaiting a verdict), and the real
      // disk-probe predicate so open/decomposing is classified gate-vs-resend by what is on disk.
      const scope: ResumeScope = resumeScopeForRoot(state.root, state, decompositionArtifactExists);
      if (!scope.resumable) {
        diag(`resume: active phase "${activePhaseLabel(state.root)}" is not resumable (${scope.reason}) — refusing`);
        state = null;
        return false;
      }
      // Reset the genuinely-unrecoverable transients (the genesis-window captures are gone on a
      // restart): no confirmed intent, no pending adjust note, no prototype round. summaries/mandates
      // are reloaded from disk below (NOT left stale).
      confirmedIntent = null;
      adjustNote = null;
      pendingIntentText = null;
      prototypeRound = 0;
      autoApproveNext = false;
      resumedGate = false;
      sdkSessionId = state.sdk_session_id ?? null;
      // DERIVED POLICY: the session must open in the policy the rehydrated tree implies — executing →
      // acceptEdits (SDK default), planning → plan, genesis window → prototype. Per the CLAUDE.md
      // "prototype permission seam" gotcha the startSession dep already maps policy → SDK mode; prime
      // the cache to the SAME value so the first post-resume dispatch's policy seam fires no redundant
      // setMode (and a pre-send setMode can't race a not-yet-live session).
      const policy = writePolicyFor2(state.root);
      assertedPolicy = policy;
      active = true;
      activeOrchestrator = handle;
      diag(`resume(): active set true, activeOrchestrator registered (policy=${policy}, phase=${activePhaseLabel(state.root)})`);
      // CLEANUP-ON-THROW (mirrors start()): everything past here can reject (session open, disk
      // reads, the resume action's send). The guard is armed, so a rejection would otherwise wedge the
      // orchestrator active forever — tear down + rethrow exactly as start() does.
      try {
        // Reload the non-serialized driver state (summaries/mandates) from disk BEFORE acting, so the
        // re-sent prompts thread the same prior context a never-killed run would.
        await reloadDriverStateFromDisk(state.root);
        // Open the single SDK session in the derived policy, RESUMING the prior transcript. A missing/
        // undefined sdk_session_id ⇒ the dep omits resumeSessionId ⇒ a fresh session (the sidecar's
        // expired-transcript fallback emits a non-fatal resume_fallback frame and runs the step fresh).
        await deps.startSession({
          cwd,
          permissionMode: policy,
          ...(state.sdk_session_id !== undefined ? { resumeSessionId: state.sdk_session_id } : {}),
        });
        // Continue from the resolved phase: re-present the gate (no prompt) or re-send the step.
        await resumeActionForPhase(scope.plan);
      } catch (err) {
        markTerminal("resume() threw");
        awaiting = { tag: "idle" };
        await endSdkSession();
        throw err;
      }
      return true;
    },

    snapshot: () => toSnapshot2(requireState()),

    // THE UNIFIED APPROVE SURFACE. `pathKeyStr` is parsed at the UI boundary (parsePathKey throws
    // loudly on garbage); the held gate is looked up and the action routes by gate.kind through an
    // EXHAUSTIVE switch ending in assertNever — the dangerous branch (interrupt) stays lexically
    // INSIDE the decomposition case so it can never be hoisted to cover a leaf approval.
    approve: async (pathKeyStr) => {
      const path = parsePathKey(pathKeyStr);
      const gate = state?.pendingApproval ?? null;
      if (!gate || pathKey(gate.path) !== pathKey(path)) {
        throw new Error(
          `approve("${pathKeyStr}"): no held approval gate for that path (held: ${
            gate ? `"${pathKey(gate.path)}"` : "none"
          })`,
        );
      }
      // RESUMED-GATE APPROVAL (Phase 3): the gate was reconstructed from disk; its toolUseId is the
      // synthetic `resumed:` sentinel and the live ExitPlanMode resolver is dead. There is NO
      // in-flight turn here (the gate came from a freshly-resumed session, not a held tool), so the
      // merge-into-in-flight-turn hazard the live decomposition branch defers around does NOT apply —
      // we send the continuation prompt INLINE and never interrupt. The reducer transitions the tree
      // exactly as the live path does (leaf→executing / open→split); its resolvePermission effect
      // against the synthetic id is dropped by runEffect's resumed short-circuit.
      if (resumedGate) {
        resumedGate = false;
        switch (gate.kind) {
          case "leaf": {
            // The reducer moves the leaf to executing (policy → acceptEdits at the dispatch seam),
            // resolving the synthetic id is a no-op. Then instruct the resumed conversation to
            // implement the approved plan and arm `exec` (arm-before-send) for the exec result.
            await dispatch({ type: "APPROVE", path });
            awaiting = { tag: "exec", path, buffer: "" };
            diag(`resumed approve (leaf) at "${pathKey(path)}": sending implement prompt, armed exec`);
            await deps.sendMessage(resumedLeafApprovalPrompt(gate.planPath));
            return;
          }
          case "decomposition": {
            // parsedChildren is null on resume — re-derive the children by re-parsing the on-disk
            // decomposition plan (the gate's own artifact), then replay CHILDREN_PARSED (rebuilds the
            // stash) + DECOMPOSITION_APPROVED (materializes the split with child[0] in recon). Finally
            // fire the first child's recon INLINE — nothing is in flight, so no resuming hold / no
            // interrupt (unlike the live decomposition approve).
            const read = deps.readPlanTreeFile;
            const planText = read ? await read(cwd, planName2(path)) : null;
            if (planText === null) {
              throw new Error(
                `resumed approve (decomposition) at "${pathKey(path)}": decomposition plan ${planName2(path)} not found on disk — cannot re-derive children`,
              );
            }
            // INV-2 ON RESUME — DENY-FOR-REDRAFT, never a silent wedge. approve() is NOT wrapped in
            // enqueueIngest (it is a direct UI call), so a PlanValidationError thrown by the re-parse
            // here would escape to main.ts's generic catch — leaving the gate held with no redraft and
            // no FATAL (a stuck Resume→Approve). A malformed on-disk master (stale write-then-parse
            // copy, or hand-edited between kill and resume) is RECOVERABLE: move the node back to
            // open/decomposing (DECOMPOSITION_CHANGES_REQUESTED — legal from awaiting-decomposition-
            // approval, drops the dead synthetic id's resolve via runEffect) and send the resumed
            // redraft prompt carrying the validation message. The run stays active; the next signal is
            // the re-draft's fresh ExitPlanMode hold (a live turn now exists — resumedGate is already
            // cleared above), routed through the normal live decomposition path. Non-validation errors
            // (I/O, bugs) still propagate (rethrown) — same typed discriminator as the live path.
            let parsed: ParsedMasterPlan;
            try {
              parsed = parseSubPlanHeaders(planText);
            } catch (err) {
              if (err instanceof PlanValidationError) {
                diag(`resumed approve (decomposition) at "${pathKey(path)}": on-disk master malformed, denying for redraft — ${err.message}`);
                await dispatch({ type: "DECOMPOSITION_CHANGES_REQUESTED", path, feedback: err.message });
                awaiting = { tag: "idle" };
                await deps.sendMessage(resumedDecompositionChangesPrompt(err.message));
                return;
              }
              throw err;
            }
            // Repopulate this node's mandates from the re-parsed plan (reloadDriverStateFromDisk could
            // not — the node was still open/awaiting-decomposition-approval, artifact-free at rest).
            const parentKey = pathKey(path);
            const childPrefix = parentKey === "" ? "" : `${parentKey}.`;
            mandates = new Map([
              ...[...mandates.entries()].filter(([k]) => !k.startsWith(childPrefix)),
              ...parsed.subplans.map(
                (s): [PathKey, Mandate] => [
                  pathKey([...path, s.nn]),
                  { title: s.title, sectionBody: s.body, masterPreamble: parsed.preamble },
                ],
              ),
            ]);
            await dispatch({
              type: "CHILDREN_PARSED",
              path,
              children: parsed.subplans.map((s) => ({ nn: s.nn, title: s.title })),
            });
            await dispatch({ type: "DECOMPOSITION_APPROVED", path });
            // The first child is now active in recon. Send its recon prompt INLINE + arm `recon`
            // (arm-before-send). activePath() reads the freshly-materialized first child.
            const nextPath = activePath();
            if (nextPath !== null) {
              awaiting = { tag: "recon", path: nextPath, buffer: "" };
              diag(`resumed approve (decomposition) at "${pathKey(path)}": firing recon for first child "${pathKey(nextPath)}"`);
              await deps.sendMessage(
                subReconPrompt(
                  nextPath,
                  mandateFor(nextPath),
                  priorSummaries(parentPathOf(nextPath)),
                  adjustNoteFor(nextPath),
                ),
              );
            }
            return;
          }
        }
        assertNever(gate.kind);
      }
      switch (gate.kind) {
        case "decomposition": {
          // DECOMPOSITION APPROVAL (the gen-1 approveMaster body, path-keyed). The deferred-recon
          // target is the stash's FIRST child: DECOMPOSITION_APPROVED materializes the split with
          // child[0] active, so the path is known PRE-dispatch (activePath() would still read the
          // gated node here). Known up-front because the resuming hold must be armed before any
          // await below.
          const stash = state?.parsedChildren ?? null;
          const firstNn =
            stash && pathKey(stash.path) === pathKey(path) ? stash.children[0].nn : null;
          const nextPath: NodePath | null = firstNn !== null ? [...path, firstNn] : null;
          if (nextPath !== null) {
            // ARM BEFORE THE FIRST AWAIT. The resolve round-trip (inside the dispatch below) yields
            // to the event loop, and the approval-resumed turn's `result` frame can reach
            // ingestStream during those awaits. If the hold were armed only after them (the old
            // ordering), that result landed while awaiting was idle and was SWALLOWED — the
            // deferred recon never fired and the watchdog FATALed a healthy run. DO NOT send the
            // recon prompt here either: resolving the approval makes the SDK resume the SAME
            // (still in-flight) decomposition turn — with its canned "You can now start coding"
            // injection — and a message sent now is delivered as a queued attachment merged INTO
            // that turn: the model implemented a whole sub-plan inside one turn with no gate (the
            // confirmed incident). The resumed turn's `result` fires it.
            armResuming(nextPath);
          }
          // The reducer resolves the held permission (allow) + persists; the resolve effect nulls
          // assertedPolicy so the dispatch seam re-asserts the derived "plan" policy BEFORE the
          // deferred recon prompt can fire. This closes the incident where the planning phases
          // after decomposition approval ran in a writable mode.
          await dispatch({ type: "DECOMPOSITION_APPROVED", path });
          if (nextPath !== null) {
            // Do NOT wait for the approval-resumed turn to end voluntarily: the model has just
            // been told "start coding" and will free-run inside it (the live phase-1 incident — it
            // spawned background implementation agents, every write was denied by the sidecar's
            // plan backstop, NO result arrived for minutes, and the watchdog FATALed the run).
            // INTERRUPT it instead: the sidecar's `interrupt` command calls Query.interrupt(), the
            // aborted turn emits its terminal `result` within seconds, and the `resuming` branch
            // consumes that as the boundary that fires the deferred recon. Armed-then-interrupt
            // (no await between arm and the dispatch above) so the boundary result can never land
            // on an unarmed sequencer. NOTE: this interrupt is SCOPED — lexically INSIDE the
            // decomposition case — because the leaf case below must never interrupt: there the
            // approval-resumed turn IS the execution. A failed interrupt is logged, not rethrown:
            // the watchdog backstop still turns a missing boundary into a loud FATAL.
            try {
              await deps.interrupt();
            } catch (err) {
              console.error(
                "interrupt after decomposition approval failed (watchdog will backstop)",
                err,
              );
            }
          }
          return;
        }
        case "leaf": {
          // LEAF APPROVAL (the gen-1 approve body). The reducer resolves the held ExitPlanMode
          // (allow); the derived policy flips to acceptEdits at the dispatch seam; the SDK resumes
          // the SAME turn and executes. NO prompt is sent here — the resumed turn IS the execution,
          // so there is no inline-send-into-an-in-flight-turn hazard at this site (unlike the
          // decomposition case, which must defer via the resuming hold) — and for the same reason
          // it must NEVER call deps.interrupt(): interrupting here would abort the very execution
          // the user just approved. Arm "exec" (capturing the path at arm time) so the NEXT
          // `result` (exec completion) is caught.
          await dispatch({ type: "APPROVE", path });
          awaiting = { tag: "exec", path, buffer: "" };
          return;
        }
      }
      assertNever(gate.kind);
    },

    // THE UNIFIED REQUEST-CHANGES SURFACE: deny the held gate with feedback. For BOTH kinds the SDK
    // feeds the deny reason back to the model as the tool error and RESUMES THE SAME TURN to
    // re-draft — send NOTHING inline (a message sent now would be merged into that still-in-flight
    // turn, the same hazard the approve decomposition branch defers around). The next signal is the
    // re-draft's fresh ExitPlanMode hold, not a `result` — nothing to arm.
    requestChanges: async (pathKeyStr, feedback) => {
      const path = parsePathKey(pathKeyStr);
      const gate = state?.pendingApproval ?? null;
      if (!gate || pathKey(gate.path) !== pathKey(path)) {
        throw new Error(
          `requestChanges("${pathKeyStr}"): no held approval gate for that path (held: ${
            gate ? `"${pathKey(gate.path)}"` : "none"
          })`,
        );
      }
      // RESUMED-GATE REQUEST-CHANGES (Phase 3): the synthetic id cannot be denied (the live resolver
      // is dead), so a live deny's "resume the held turn to re-draft" is impossible. The reducer still
      // moves the node back to the drafting phase (open/decomposing or leaf/drafting) — its
      // resolvePermission-deny effect against the synthetic id is dropped by runEffect — and we send
      // an explicit redraft prompt carrying the feedback INLINE. The next signal is the re-draft's
      // fresh ExitPlanMode hold (a permission frame, not a `result`), so arm idle.
      if (resumedGate) {
        resumedGate = false;
        switch (gate.kind) {
          case "decomposition": {
            await dispatch({ type: "DECOMPOSITION_CHANGES_REQUESTED", path, feedback });
            awaiting = { tag: "idle" };
            diag(`resumed requestChanges (decomposition) at "${pathKey(path)}": sending redraft prompt`);
            await deps.sendMessage(resumedDecompositionChangesPrompt(feedback));
            return;
          }
          case "leaf": {
            await dispatch({ type: "REQUEST_CHANGES", path, feedback });
            awaiting = { tag: "idle" };
            diag(`resumed requestChanges (leaf) at "${pathKey(path)}": sending redraft prompt`);
            await deps.sendMessage(resumedLeafChangesPrompt(feedback));
            return;
          }
        }
        assertNever(gate.kind);
      }
      switch (gate.kind) {
        case "decomposition": {
          // The reducer denies the held permission with the feedback, discards the stale child
          // parse, and moves the node back to open/decomposing for the same-turn redraft.
          await dispatch({ type: "DECOMPOSITION_CHANGES_REQUESTED", path, feedback });
          awaiting = { tag: "idle" };
          return;
        }
        case "leaf": {
          // The reducer denies with feedback; the node re-drafts IN PLACE (active path fixed,
          // redraftCount incremented).
          await dispatch({ type: "REQUEST_CHANGES", path, feedback });
          awaiting = { tag: "idle" };
          return;
        }
      }
      assertNever(gate.kind);
    },

    answerClarify: async (toolUseId, answers) => {
      await dispatch({ type: "CLARIFY_ANSWERED", toolUseId, answers });
      // INTENT-WATCHDOG RESUME: the clarify hold resolved, the intent turn is generating again —
      // re-arm the paused watchdog (see the AskUserQuestion ingest branch).
      if (awaiting.tag === "intent") armTurnWatchdog("intent", []);
    },

    approvePrototype: async (opts) => {
      const gate = state?.pendingPrototype ?? null;
      if (!gate) throw new Error("approvePrototype(): no pending prototype gate");
      // The root is already in prototype-review with this gate held; resolveApprove composes
      // INTENT.md, dispatches PROTOTYPE_APPROVED (legal from prototype-review), arms recon and
      // sends the recon prompt. `asWorkingReference` (DEFAULT false — "just a sketch") additionally
      // freezes .plan-tree/prototype/ → .plan-tree/baseline/ and records baseline_ on the ledger.
      await resolveApprove(gate, opts?.asWorkingReference === true);
    },

    refinePrototype: async (feedback, opts) => {
      const gate = state?.pendingPrototype ?? null;
      if (!gate) throw new Error("refinePrototype(): no pending prototype gate");
      // DRIVER-OWNED round increment (see the prototypeRound discipline note): count the refine
      // request itself, so the NEXT gate is minted round prototypeRound+1 regardless of clarifier
      // output.
      prototypeRound++;
      await dispatch({ type: "PROTOTYPE_REFINED", feedback });
      // COMBINED apply-and-approve: arm the auto-approve latch LAST, only after the dispatch above
      // has resolved — so a dispatch throw can never leave the flag set with no turn in flight.
      // The intent-ingestion branch reads this flag when the revised prototype block arrives and
      // auto-resolves the gate forward (PROTOTYPE_READY → PROTOTYPE_APPROVED) instead of surfacing
      // another review round.
      if (opts?.autoApprove) autoApproveNext = true;
      // Re-arm the intent turn (same genesis arm + watchdog) BEFORE sending. The session is idle
      // — the intent turn that surfaced this gate already ended — so nothing is in flight to
      // interrupt; the refine prompt simply opens the next visual round's turn.
      awaiting = { tag: "intent", buffer: "" };
      armTurnWatchdog("intent", []);
      diag(
        `refinePrototype: round=${prototypeRound}, autoApprove=${opts?.autoApprove === true}, re-armed intent, sending refine prompt`,
      );
      await deps.sendMessage(refinePrototypePrompt(feedback));
    },

    approveAcceptance: async () => {
      // PHASE 5 — APPROVE THE FORCED ACCEPTANCE GATE. The root is parked in its acceptance window
      // with pendingAcceptance held; ACCEPTANCE_APPROVED performs the deferred finalize (root →
      // summarized + notifyDone) and records acceptance_={verdict:"approved"}. The clock rides the
      // event (nowFn). No turn is in flight (the gate is a post-completion hold), so nothing to
      // interrupt; markTerminal runs inside notifyDone's effect.
      if (!state?.pendingAcceptance) throw new Error("approveAcceptance(): no pending acceptance gate");
      await dispatch({ type: "ACCEPTANCE_APPROVED", decidedMs: nowFn() });
    },

    divergeAcceptance: async (reason) => {
      // PHASE 5 — ACCEPT DIVERGENCE FROM THE BASELINE FLOOR, recording WHY. Same finalize as approve;
      // ACCEPTANCE_DIVERGED additionally persists the reason (the audit trail for the waived floor).
      if (!state?.pendingAcceptance) throw new Error("divergeAcceptance(): no pending acceptance gate");
      await dispatch({ type: "ACCEPTANCE_DIVERGED", reason, decidedMs: nowFn() });
    },

    refineAcceptance: async (target) => {
      // PHASE 6 — RE-PLAN A SUB-PLAN from the forced acceptance gate (the third gate action). The
      // reducer RESETS the target node + its right-siblings to a fresh re-execution shape (target →
      // open/recon active, right-siblings → open/pending), clears pendingAcceptance, deletes each
      // reset node's on-disk NN-plan.md/NN-summary.md, and persists. There is NO turn in flight at the
      // gate (it is a post-completion hold), so nothing to interrupt — we drive the target's recon
      // turn ourselves (mirroring the PARENT_REVIEW_DONE recon hop). On the tree's re-completion
      // (baseline still present, no verdict) the Phase-5 gate re-arms automatically.
      if (!state?.pendingAcceptance) throw new Error("refineAcceptance(): no pending acceptance gate");
      // Compute the reset set (target + right-siblings at the target's level) BEFORE dispatch so we can
      // drop their STALE summaries from the driver's per-level threading map — a refine re-runs them,
      // so a leftover entry would thread a stale summary into the re-run AND survive as a phantom
      // sibling summary. The reducer re-validates the same set (it is the source of truth).
      const parentPath = target.slice(0, -1);
      const parentNode = nodeAtPath(state.root, parentPath);
      const resetKeys: PathKey[] = [];
      if (parentNode && parentNode.state.stage === "split") {
        const idx = parentNode.state.children.findIndex((c) => c.nn === target[target.length - 1]);
        if (idx >= 0) {
          for (let i = idx; i < parentNode.state.children.length; i++) {
            resetKeys.push(pathKey([...parentPath, parentNode.state.children[i].nn]));
          }
        }
      }
      await dispatch({ type: "ACCEPTANCE_REFINED", target });
      // Drop the reset nodes' stale summaries (the reducer already deleted the on-disk files via the
      // deletePlanTreeFile effects; this clears the in-memory threading map to match). A reset node
      // may itself be a SPLIT node (its own depth-2 sub-plans 01.01/01.02 + a roll-up under "01"),
      // so drop the ENTIRE SUBTREE of each reset node, not just its direct key — otherwise a re-run
      // that re-decomposes with colliding child NNs would thread the stale "01."-prefixed entries as
      // phantom prior-sibling summaries. Scope is strictly the reset nodes' subtrees (target +
      // right-siblings); left-siblings and their subtrees are never matched.
      for (const resetKey of resetKeys) {
        const subtreePrefix = `${resetKey}.`;
        for (const k of [...summaries.keys()]) {
          if (k === resetKey || k.startsWith(subtreePrefix)) summaries.delete(k);
        }
      }
      // Drive the target's recon turn. The session is idle (the gate was a post-completion hold), so
      // the recon prompt opens a fresh turn — no resuming hold, no interrupt. Arm BEFORE sending.
      const nextPath = activePath();
      if (nextPath !== null) {
        awaiting = { tag: "recon", path: nextPath, buffer: "" };
        diag(`refineAcceptance: reset "${pathKey(target)}" + right-siblings, armed recon at "${pathKey(nextPath)}"`);
        await deps.sendMessage(
          subReconPrompt(
            nextPath,
            mandateFor(nextPath),
            priorSummaries(parentPathOf(nextPath)),
            adjustNoteFor(nextPath),
          ),
        );
      }
    },

    ingestStream: (frame) => enqueueIngest(() => ingestStreamImpl(frame)),

    ingestPermission: (req) => enqueueIngest(() => ingestPermissionImpl(req)),

    cancel: async () => {
      // Cancel is terminal: stop the turn + end the session, purge any held interactive permission so
      // the sidecar's held resolver is not stranded, and deregister from the active-guard. The on-disk
      // ledger is intentionally LEFT INTACT for inspection — there is no resume-from-disk path; the
      // next START sweeps it into .plan-tree/.archive/, where exactly one generation survives.
      const wasActive = active;
      markTerminal("cancel()");
      // RESUMED-GATE GUARD (Phase 3): a resumed gate's heldPermissionId is the synthetic `resumed:`
      // sentinel — the sidecar holds NO resolver for it, so purging it would call a dead id. Skip the
      // purge for synthetic ids (clear the local state + the resumed flag). Real held ids purge as
      // before.
      resumedGate = false;
      if (heldPermissionId && heldPermissionId.startsWith("resumed:")) {
        heldPermissionId = null;
      } else if (heldPermissionId) {
        const id = heldPermissionId;
        heldPermissionId = null;
        try {
          await deps.resolvePermission({
            id,
            allow: false,
            message: "Run cancelled.",
          });
        } catch (err) {
          console.error("resolve_tool_permission (cancel purge) failed", err);
        }
      }
      if (wasActive) {
        await endSdkSession();
      }
    },

    subscribe: (obs) => {
      observers.add(obs);
      return () => {
        observers.delete(obs);
      };
    },

    teardown: async () => {
      if (torn) return;
      torn = true;
      await handle.cancel();
      observers.clear();
    },

    orchestrationActive: () => active,

    resuming: () => awaiting.tag === "resuming",

    dispatch: (event) => dispatch(event),
  };

  // TEST-ONLY: register this handle's ingest-seen counter accessor so __ingestSeenForTest(handle) can
  // observe how many ingest thunks the queue actually invoked. Off the frozen interface (a side table).
  ingestSeenAccessors.set(handle, () => ingestSeen);

  return handle;
}

// TEST-ONLY side table: handle -> a getter for its private ingestSeen counter (the count of ingest
// thunks the queue dequeued+invoked). Used by the error-isolation test to prove the queue chain was
// not poisoned by a throwing frame, independently of the terminal guard suppressing effects.
const ingestSeenAccessors = new WeakMap<OrchestratorHandle, () => number>();

// TEST-ONLY: read how many ingest-impl thunks `handle`'s queue has dequeued+invoked. Returns 0 for an
// unknown handle. NOT part of the frozen UI contract.
export function __ingestSeenForTest(handle: OrchestratorHandle): number {
  return ingestSeenAccessors.get(handle)?.() ?? 0;
}

// ---- shared singleton + test hooks ----------------------------------------------------------
//
// The live app shares ONE orchestrator instance between this gate controller (Sub-Plan 02) and
// 03's composer-entry, so both drive the SAME handle. Constructed lazily on first access bound to
// the real Tauri deps. Tests install a fake via __setOrchestratorForTest and reset module state in
// beforeEach via __resetOrchestratorForTest.

let singleton: OrchestratorHandle | null = null;

// The shared orchestrator instance for the live app (lazy, real-deps-bound).
export function getOrchestrator(): OrchestratorHandle {
  if (!singleton) singleton = createOrchestrator();
  return singleton;
}

// TEST-ONLY: install a fake handle (e.g. createOrchestrator(fakeDeps)) as the shared singleton.
export function __setOrchestratorForTest(h: OrchestratorHandle | null): void {
  singleton = h;
}

// TEST-ONLY: register `h` as the module-level active-guard entry (what isOrchestrationActive() /
// isOrchestratorResuming() read) without driving a real start(). Cleared by __resetOrchestratorForTest.
export function __setActiveOrchestratorForTest(h: OrchestratorHandle | null): void {
  activeOrchestrator = h;
}

// TEST-ONLY: reset module state between tests. Nulls the singleton AND the module-level
// activeOrchestrator guard so a leaked active singleton cannot bleed across tests — a stale
// isOrchestrationActive()===true would make handleToolPermissionRequested early-return and silently
// disable the entire main.inproc-review.test.ts suite.
export function __resetOrchestratorForTest(): void {
  singleton = null;
  activeOrchestrator = null;
}

// A fresh tree id. Mirrors the backend's seed style (a short random hex) without colliding with the
// backend-seeded ids — START establishes the canonical tree_id the driver tags every writeAgentPlan
// with, so a sub is never mistagged as a master.
function newTreeId(): string {
  const rand = Math.random().toString(16).slice(2, 10);
  return `tree-${Date.now().toString(36)}-${rand}`;
}
