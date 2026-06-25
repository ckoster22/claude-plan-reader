// Mock-mode fixtures — reading-pane markdown documents.
//
// A path -> markdown map so the mock `read_plan_contents(path)` can return a real document for
// each fixture plan. Rendered through the UNMODIFIED reading-pane pipeline (markdown-it +
// highlight.js + DOMPurify; mermaid + images lazy/async), so these strings exercise the same code
// the live app uses. Phase 3 fleshes out the mermaid/image/error variants; Phase 1 ships one rich
// doc plus a doc per fixture plan so every sidebar row opens to something.
//
// Keys MUST match the absolute_path values in src/mock/fixtures/plans.ts.

import { NESTED_MARKDOWN } from "./nested";
import { TRAILHEAD_MARKDOWN } from "./trailhead-plan";

const PLANS = "/Users/mock/.claude/plans";

// A rich document: headings, lists, a GFM table, a fenced code block (highlight.js), and an
// external link. The canonical "does the reading pane render full-fidelity markdown?" fixture.
const RICH = `# Ship the widget pipeline

A standalone plan with **unread** edits. This document exercises the full reading-pane
render path: headings, lists, a table, fenced code, and an external link.

## Goals

- Stand up the ingestion stage
- Validate against the golden fixtures
- Wire the dashboard

### Ordered steps

1. Parse the manifest
2. Resolve dependencies
3. Emit the bundle

## Comparison table

| Stage    | Owner   | Status      |
| -------- | ------- | ----------- |
| Ingest   | Alice   | done        |
| Validate | Bob     | in progress |
| Publish  | Carol   | blocked     |

## A fenced code block

\`\`\`ts
export function greet(name: string): string {
  // highlight.js should colorize this
  return \`hello, \${name}\`;
}
\`\`\`

See the [project docs](https://example.com/docs) for more.
`;

const READ_STANDALONE = `# A read standalone plan

This plan has already been viewed (not bold in the sidebar).

- It is intentionally short.
- It still renders through the real pane.

> A blockquote, for good measure.
`;

const MASTER = `# Master: token-free harness

The master plan of a two-sub tree. The sidebar nests its subs beneath it.

## Sub-plans

1. Fake IPC shell
2. Conversation scenes
`;

const SUB01 = `# Sub-Plan 01 — Fake IPC shell

Alias every \`@tauri-apps/*\` import to a mock shim via \`vite.mock.config.ts\`.

\`\`\`bash
npm run mock
\`\`\`
`;

const SUB02 = `# Sub-Plan 02 — Conversation scenes

Replay canned \`AgentStream\` frames through the real \`renderTree()\` pipeline.
`;

// ---- Phase 3 reading-pane variant docs (one render concern each) ----------------------------

// A MERMAID-heavy doc: a ```mermaid fence the reading pane lazy-loads mermaid for and renders to an
// SVG (then DOMPurify-sanitizes). Multi-line node labels exercise the foreignObject/HTML path.
const MERMAID_DOC = `# Mermaid diagram

The reading pane renders this through the real (lazy-loaded) mermaid pipeline.

\`\`\`mermaid
flowchart TD
  A[Start] --> B{Has token?}
  B -- yes --> C[Run agent]
  B -- no --> D[Show onboarding]
  C --> E[Stream frames]
  E --> F[Render conversation]
\`\`\`

A second diagram (sequence) to prove repeat rendering:

\`\`\`mermaid
sequenceDiagram
  participant U as User
  participant A as App
  U->>A: Open plan
  A-->>U: Rendered markdown
\`\`\`
`;

// A TABLE-heavy doc: several GFM tables (alignment variants) to exercise markdown-it's table render.
const TABLE_DOC = `# Tables

## Left / center / right alignment

| Name    | Count | Owner   |
| :------ | :---: | ------: |
| Ingest  |   12  |   Alice |
| Validate|    7  |     Bob |
| Publish |    3  |   Carol |

## A wider table

| Stage    | Owner   | Status      | Notes                         |
| -------- | ------- | ----------- | ----------------------------- |
| Ingest   | Alice   | done        | golden fixtures pass          |
| Validate | Bob     | in progress | edge cases pending            |
| Publish  | Carol   | blocked     | waiting on the ingest rewrite |
`;

// A CODE-heavy doc: multiple fenced blocks in different languages so highlight.js colorizes each.
const CODE_DOC = `# Code highlighting

A TypeScript block:

\`\`\`ts
export async function run(cwd: string): Promise<number> {
  const plans = await invoke<PlanRecord[]>("list_plans");
  return plans.filter((p) => p.unread).length;
}
\`\`\`

A Rust block:

\`\`\`rust
#[tauri::command]
fn read_plan_contents(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
\`\`\`

A shell block:

\`\`\`bash
npm run mock
npx vitest run src/mock/
\`\`\`
`;

// An IMAGE doc: a local relative image. The reading pane's async image pass resolves the src through
// the mock read_image_as_data_url (which returns a real PNG data URL), so it renders — never broken.
const IMAGE_DOC = `# Local image

The reading pane resolves this relative image through \`read_image_as_data_url\`:

![a tiny inline image](./assets/diagram.png)

Text after the image, so the pane shows the image is inlined mid-document.
`;

// ---- ANIMATE prototype-review beat — the visual prototype the gate previews INLINE ------------
//
// The TRAILHEAD_BEAT (src/mock/animate/storyboard.ts) opens THIS plan in the reading pane during the
// prototype-gate window (its open_plan…open_plan{null} bracket). The prototype is rendered INLINE in
// `#reading-pane` exactly as the REAL app does it: main.ts's onPrototypeReview → renderPrototypePreview
// composes `composePreviewMarkdown(gate)` (a plain monospace ASCII fence) into the pane, with the
// review bar in `.review-bar.proto` mode. There is NO floating overlay card — the previous
// `#demo-proto-card` chrome (review2 c3: "this wouldn't appear in the app") was deleted.
//
// TWO-WRITER DETERMINISM: two writers paint `#reading-pane` during this window —
//   (a) the reconciler's reading-pane pass, which opens PROTO_PREVIEW_PATH → renders PROTO_PREVIEW_DOC,
//   (b) renderPrototypePreview, which renders composePreviewMarkdown(gate) (round-aware).
// To make the visible result deterministic regardless of which writer wins a given tick, PROTO_PREVIEW_DOC
// is byte-identical to composePreviewMarkdown's output for the ROUND-1 override (same plain ``` fence
// around the same ASCII card). So round-1 ticks settle to the same card no matter the race; round-2 ticks
// (only renderPrototypePreview re-fires — the open-plan key is unchanged, so the reconciler memoizes)
// morph the card to the difficulty-badge variant. Mermaid-free throughout (review item #6).
export const PROTO_PREVIEW_PATH = `${PLANS}/trailhead-prototype-preview.md`;

// The monospace trail-card ASCII the inline prototype shows. Round 1 = the clean card (name, photo
// placeholder, distance/elevation). Round 2 = the SAME card plus a difficulty badge line — the exact
// prototype feedback the storyboard types. Kept ASCII (no triple-backticks) so it nests cleanly inside a
// plain ``` fence in both writers below.
const TRAIL_CARD_R1_ASCII = [
  "┌─ Eagle Peak Loop ───────────────┐",
  "│                                 │",
  "│   [ ▟▙ trail photo ▟▙ ]         │",
  "│                                 │",
  "│   6.2 mi  ·  +1,400 ft          │",
  "│                                 │",
  "└─────────────────────────────────┘",
].join("\n");

const TRAIL_CARD_R2_ASCII = [
  "┌─ Eagle Peak Loop ───────────────┐",
  "│                                 │",
  "│   [ ▟▙ trail photo ▟▙ ]         │",
  "│                                 │",
  "│   6.2 mi  ·  +1,400 ft          │",
  "│   « Moderate »                  │",
  "│                                 │",
  "└─────────────────────────────────┘",
].join("\n");

// PURE: the mock-ANIMATE prototype gate's detached-preview override for a given 1-based round
// (kind:"ascii", non-mermaid). The Trailhead player passes the result to emitGate so main.ts's
// renderPrototypePreview composes the SAME ASCII trail card the open-plan backdrop shows. Round >= 2
// swaps in the difficulty-badge variant. The default MOCK_PROTOTYPE_GATE is kind:"mermaid" (a stray
// `flowchart LR`), so this override is what keeps the prototype chapter mermaid-free (review item #6).
export function trailheadProtoPreviewOverride(round: number): {
  kind: "ascii";
  inlinePreview: string;
} {
  return {
    kind: "ascii",
    inlinePreview: round >= 2 ? TRAIL_CARD_R2_ASCII : TRAIL_CARD_R1_ASCII,
  };
}

// Wrap a body in a plain ``` fence — byte-identical to prototype.ts's composePreviewMarkdown output for
// a no-variant kind:"ascii" gate (whose `fence("", body)` is exactly this when `body` has no ``` run, plus
// composePreviewMarkdown's single trailing newline). The ASCII bodies above contain no triple-backticks,
// so a fixed 3-backtick fence matches. This keeps PROTO_PREVIEW_DOC and the round-1 override in lockstep
// so the two writers settle to the same pane content (see the TWO-WRITER DETERMINISM note above).
function asciiFenceDoc(body: string): string {
  return "```\n" + body + "\n```\n";
}

// The reading-pane backdrop the open_plan bracket opens. Byte-identical to
// composePreviewMarkdown(trailheadProtoPreviewOverride(1)) so the reconciler's reading-pane writer and
// renderPrototypePreview never disagree on round 1.
const PROTO_PREVIEW_DOC = asciiFenceDoc(TRAIL_CARD_R1_ASCII);

// The path -> document map consumed by state.ts / the mock read_plan_contents.
export const MOCK_MARKDOWN: Record<string, string> = {
  [`${PLANS}/unread-standalone.md`]: RICH,
  [`${PLANS}/read-standalone.md`]: READ_STANDALONE,
  [`${PLANS}/master-harness.md`]: MASTER,
  [`${PLANS}/harness-sub01.md`]: SUB01,
  [`${PLANS}/harness-sub02.md`]: SUB02,
  // Phase 3 reading-pane variants (keys match the fixture plans in plans.ts).
  [`${PLANS}/variant-mermaid.md`]: MERMAID_DOC,
  [`${PLANS}/variant-table.md`]: TABLE_DOC,
  [`${PLANS}/variant-code.md`]: CODE_DOC,
  [`${PLANS}/variant-image.md`]: IMAGE_DOC,
  // The reviewed plan's file (its row is opened by the external-review flow).
  [`${PLANS}/review-pending.md`]: "# Plan under review\n\n- Step one\n- Step two\n\nReview this in the bar above.\n",
  // The ANIMATE prototype-review backdrop (opened by TRAILHEAD_BEAT's open_plan bracket). NOT a
  // sidebar/list plan — markdown map only, so read_plan_contents serves it. The doc IS the inline
  // trail-card prototype (an ASCII ``` fence), byte-identical to composePreviewMarkdown's round-1
  // output so it never disagrees with renderPrototypePreview.
  [PROTO_PREVIEW_PATH]: PROTO_PREVIEW_DOC,
  // The REAL "Chompy Asteroids" nested tree — nine VERBATIM plan files (frontmatter intact; the
  // mock read_plan_contents strips it on read, mirroring the real backend). Keys match NESTED_PLANS.
  ...NESTED_MARKDOWN,
  // The fictional "Trailhead" tree the ANIMATE storyboard drafts on-screen (master doc only — the
  // storyboard opens just the master). Keys match TRAILHEAD_PLANS. See trailhead-plan.ts.
  ...TRAILHEAD_MARKDOWN,
};

// Fallback document for a path with no fixture entry — so an unexpected open never renders blank.
export function fallbackMarkdown(path: string): string {
  return `# (mock) No fixture for this plan\n\nNo mock markdown is registered for:\n\n\`${path}\`\n`;
}

// A sentinel path the mock can map to a simulated read FAILURE (the reading pane's raw-error
// fallback). Phase 3 wires the deck to open it; for now it exists so callers have a stable handle.
export const ERROR_PLAN_PATH = `${PLANS}/__error__.md`;

// A real, minimal 1x1 transparent PNG as a data: URL — returned by the mock read_image_as_data_url
// so the reading pane's async image-resolution pass sets a valid <img src> (never a broken/empty
// one). Decodes to an actual image, so awaitImages() resolves on the load event.
export const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
