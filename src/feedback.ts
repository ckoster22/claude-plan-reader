// Pure prompt-generation for the "Prompt Feedback" overlay.
//
// Standalone & pure (imports only the CommentRecord type) so it is unit-testable with no DOM /
// Tauri. main.ts (title-bar domain) consumes it; the render facade does NOT — the feedback
// button is title-bar chrome, not reading-pane content.
//
// Output is a lead line, then ONE numbered entry per record — `N. Re: "<quote>"` with the
// comment on the next indented line.

import type { CommentRecord } from "./types";

// Lead line — exactly the prototype's wording.
const LEAD = "Please revise the plan based on this feedback:";

// Quotes are clamped to this many characters (then an ellipsis) so an overlong selection does
// not flood the prompt. Matches the prototype's ~90-char rule.
const QUOTE_CLAMP = 90;

/** Clamp a quote to a short snippet for the prompt (display only). */
function clampQuote(s: string): string {
  return s.length > QUOTE_CLAMP ? s.slice(0, QUOTE_CLAMP) + "…" : s;
}

/**
 * The trailing ` (line N)` / ` (lines N-M)` suffix for a record's `Re: "..."` line, derived from
 * the block's source-line range. markdown-it's `token.map = [start, end)` is 0-based, end-exclusive;
 * the 1-based INCLUSIVE range is `start = block_line + 1`, `end = block_end_line` (converting the
 * 0-based exclusive end to 1-based inclusive is a no-op). Rules:
 *   - block_line == null                          → no suffix (whole-pane comment).
 *   - block_end_line == null OR end <= start      → ` (line {start})` (single line / unknown end).
 *   - else                                        → ` (lines {start}-{end})`.
 */
function lineSuffix(blockLine: number | null, blockEndLine: number | null): string {
  if (blockLine === null) return "";
  const start = blockLine + 1;
  if (blockEndLine === null) return ` (line ${start})`;
  const end = blockEndLine;
  if (end <= start) return ` (line ${start})`;
  return ` (lines ${start}-${end})`;
}

/**
 * Build the Claude Code feedback prompt from the open plan's comment records.
 *
 * - Lead line, then a blank line, then one numbered entry per record.
 * - Each entry: `N. Re: "<clamped quote>"` then (when the comment is non-empty) the comment text
 *   on the next indented line.
 * - **Emit one entry per record — do NOT skip empty-comment records.** 02's save flow does not
 *   reject an empty comment, so a record with `comment === ""` can exist on disk AND counts toward
 *   the badge. Skipping it would make the badge say "(1)" while the overlay renders blank. When the
 *   comment is empty we emit the `Re: "<quote>"` line alone (no comment line) so the entry count
 *   always equals the badge count.
 * - Empty input ⇒ the lead line alone (no entries).
 *
 * PURE: deterministic output for a given input, no side effects.
 */
export function buildFeedbackPrompt(
  records: Pick<CommentRecord, "quote" | "comment" | "block_line" | "block_end_line">[],
): string {
  const parts: string[] = [LEAD];
  records.forEach((rec, i) => {
    const n = i + 1;
    let entry = `${n}. Re: "${clampQuote(rec.quote)}"${lineSuffix(rec.block_line, rec.block_end_line)}`;
    // Empty comment → quote-only entry (no comment line) so entry count == record count.
    if (rec.comment.length > 0) {
      entry += `\n   ${rec.comment}`;
    }
    parts.push(entry);
  });
  // Lead line, blank line, then entries separated by a blank line.
  return parts.join("\n\n");
}
