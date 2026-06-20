// Agent SDK sidecar — pure frame-emission predicates.
//
// Extracted from index.ts (like permissions.ts / session-start.ts) so frame-shaping decisions
// are UNIT-TESTABLE without importing index.ts's top-level side effects. NO module-level state.

// True iff `text` is a string with renderable content (non-empty after trim). The SDK emits
// assistant text blocks that are empty or whitespace-only (e.g. around tool calls); emitting
// those as `assistant_text` frames produces empty bubbles in the host UI, so normalize() must
// drop them entirely — no frame at all, not an empty one.
export function isRenderableText(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0;
}
