// Mock-mode fixtures — AskUserQuestion question sets.
//
// An `AskUserQuestionItem[]` (the EXACT shape the real `AskUserQuestion` tool input carries, lifted
// verbatim from src/conversation/types.ts) so the real `renderQuestionCard()` draws an INTERACTIVE
// card. Surfaced through a `tool-permission-requested` frame (see scenes.ts `questionCard`), whose
// `input.questions` the conversation model reads to build the card.
//
// Coverage (every distinct affordance the card supports):
//   • a RADIO question (multiSelect:false) WITH per-option descriptions,
//   • a CHECKBOX question (multiSelect:true) for multi-pick,
//   • the free-text "Other…" affordance — note the renderer ALWAYS appends an "Other…" row to every
//     section, so any question here automatically exercises it; the radio question's description text
//     simply makes the card visually richer.
//
// PHASE 4 — the Question-card knobs (count / multiSelect / include-Other) need a PARAMETERIZED
// builder, not just the canonical fixed set. `buildQuestions(opts)` below produces a question set of
// the requested SIZE, with each question's multiSelect chosen per the `multiSelect` knob, and an
// `includeOther` flag controlling whether the synthetic "Other…" free-text affordance is exercised.
// NOTE: the renderer ALWAYS appends an "Other…" row to every section — the host can't suppress it —
// so `includeOther:false` is expressed by giving a section a SINGLE option (still has the Other row,
// but the knob's intent is documented and the test asserts the option count, not the absence of
// Other). The canonical two-question set is kept as MOCK_QUESTIONS / cloneQuestions for the existing
// scenes + tests (their answer-key assertions pin the exact question text), so this is additive.

import type { AskUserQuestionItem } from "../../conversation/types";

// The canonical demo question set. Two questions so the card shows BOTH a radio section (with option
// descriptions) and a checkbox section, and the auto-appended "Other…" row appears under each.
export const MOCK_QUESTIONS: AskUserQuestionItem[] = [
  {
    question: "Which rendering approach should the prototype use?",
    header: "Rendering",
    multiSelect: false,
    options: [
      {
        label: "Canvas 2D",
        description: "Immediate-mode draws; simplest, great for a quick visual pass.",
      },
      {
        label: "SVG",
        description: "Retained DOM nodes; crisp at any zoom, easy to inspect.",
      },
      {
        label: "WebGL",
        description: "GPU-accelerated; needed only for very large scenes.",
      },
    ],
  },
  {
    question: "Which platforms must the first cut support?",
    header: "Platforms",
    multiSelect: true,
    options: [
      { label: "macOS" },
      { label: "iPadOS" },
      { label: "Web" },
    ],
  },
];

// Deep-copy so a consumer mutating a question set never aliases the module-level fixture.
export function cloneQuestions(): AskUserQuestionItem[] {
  return MOCK_QUESTIONS.map((q) => ({
    ...q,
    options: q.options.map((o) => ({ ...o })),
  }));
}

// ---- PHASE 4 parameterized builder (the Question-card knobs) --------------------------------

// Options for buildQuestions — the Question-card knob group's tunables.
export interface QuestionBuildOpts {
  // How many question SECTIONS the card shows (clamped to >= 1). Default 2 (matches the canonical set).
  count?: number;
  // When true, EVERY question is a multiSelect (checkbox) section; when false, every question is a
  // radio section. (The canonical set mixes the two; this knob makes the kind uniform + predictable.)
  multiSelect?: boolean;
  // When true, each section carries MULTIPLE concrete options (so the answer is a real choice among
  // several, alongside the always-present "Other…" free-text row). When false, each section carries a
  // SINGLE concrete option — the minimal card that still renders the "Other…" affordance.
  includeOther?: boolean;
}

// A small pool of header/option templates so generated questions read sensibly at any count.
const TEMPLATES: ReadonlyArray<{ header: string; question: string; options: string[] }> = [
  { header: "Rendering", question: "Which rendering approach should the prototype use?", options: ["Canvas 2D", "SVG", "WebGL"] },
  { header: "Platforms", question: "Which platforms must the first cut support?", options: ["macOS", "iPadOS", "Web"] },
  { header: "Storage", question: "Where should the prototype persist its state?", options: ["In-memory", "localStorage", "SQLite"] },
  { header: "Theme", question: "Which theme should ship first?", options: ["Dark", "Light", "System"] },
  { header: "Layout", question: "Which layout density do you prefer?", options: ["Compact", "Comfortable", "Spacious"] },
];

// Build a parameterized question set. Each section uses a template (cycled when count exceeds the
// template pool) and is given the chosen multiSelect kind. `includeOther:false` collapses each
// section to a single concrete option (the always-present "Other…" row still renders — the renderer
// owns it). Always returns a FRESH (non-aliased) array, exactly like cloneQuestions.
export function buildQuestions(opts: QuestionBuildOpts = {}): AskUserQuestionItem[] {
  const count = Math.max(1, Math.floor(opts.count ?? 2));
  const multiSelect = opts.multiSelect ?? false;
  const includeOther = opts.includeOther ?? true;

  const out: AskUserQuestionItem[] = [];
  for (let i = 0; i < count; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    const labels = includeOther ? t.options : t.options.slice(0, 1);
    out.push({
      // Disambiguate the question text when the template pool wraps so answer keys stay unique.
      question: i < TEMPLATES.length ? t.question : `${t.question} (set ${i + 1})`,
      header: t.header,
      multiSelect,
      options: labels.map((label) => ({ label })),
    });
  }
  return out;
}
