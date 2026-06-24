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

// ---- ANIMATE prototype-review beat — the visual prototype the gate previews -------------------
//
// The TRAILHEAD_BEAT (src/mock/animate/storyboard.ts) opens THIS plan in the reading pane during the
// prototype-gate window (its open_plan…open_plan{null} bracket). It is a TINY title-only doc that acts
// as the BACKDROP for the player-owned `#demo-proto-card` trail-card overlay (below) — the actual
// prototype is the HTML card, NOT markdown (the reading pane is MarkdownIt({ html: false }), so card
// HTML in a doc would be escaped). It is registered in the served markdown map (read_plan_contents
// serves it) but NOT in the plan LIST / sidebar fixtures.
export const PROTO_PREVIEW_PATH = `${PLANS}/trailhead-prototype-preview.md`;

// A deliberately TINY title-only reading-pane doc. The prototype is shown as a PLAYER OVERLAY (the
// `#demo-proto-card` trail card, below), NOT through this markdown — the reading pane uses
// MarkdownIt({ html: false }) so raw card HTML in a doc would be escaped. This doc is just the backdrop
// the open_plan bracket opens while the trail-card overlay floats over it. (The old trivial mermaid was
// removed; the card replaces it as the prototype's visual.)
const PROTO_PREVIEW_DOC = `# Trailhead prototype — trail card

A quick visual prototype of the trail-list card.
`;

// ---- ANIMATE prototype trail-card — the player-owned `#demo-proto-card` overlay -----------------
//
// PLAYER-AUTHORED, SAFE HTML (NOT user content): the reconciler injects these strings into the
// `#demo-proto-card` overlay node (src/mock/animate/index.ts setProtoCard). They are NOT rendered
// through a markdown doc — the reading pane is MarkdownIt({ html: false }), so card HTML in a doc
// would be escaped; the card is an overlay only.
//
// Round 1 = a clean trail card: a photo-placeholder block, a trail name, and distance/elevation stats.
// Round 2 = the SAME card but visibly LARGER (the player bumps `--tc-scale`) AND with a difficulty
// badge (`.tc-badge`, a green "Moderate" pill) — the exact prototype feedback the storyboard types.
//
// Markup is namespaced (`.tc-card`, `.tc-thumb`, `.tc-title`, `.tc-meta`, `.tc-badge`) so it cannot
// collide with app styles. `--tc-scale` is owned by the player (set on `#demo-proto-card`), so the same
// HTML scales by round; round 2 adds the badge node the player would otherwise omit.
export const TRAILHEAD_PROTO_CARD_R1_HTML =
  `<div class="tc-card">` +
  `<div class="tc-thumb" aria-hidden="true"></div>` +
  `<div class="tc-title">Eagle Peak Loop</div>` +
  `<div class="tc-meta">6.2 mi · +1,400 ft</div>` +
  `</div>`;

export const TRAILHEAD_PROTO_CARD_R2_HTML =
  `<div class="tc-card">` +
  `<div class="tc-thumb" aria-hidden="true"></div>` +
  `<div class="tc-title">Eagle Peak Loop</div>` +
  `<div class="tc-badge">Moderate</div>` +
  `<div class="tc-meta">6.2 mi · +1,400 ft</div>` +
  `</div>`;

// The mock-ANIMATE prototype gate's detached-preview override (kind:"ascii", non-mermaid). When the
// prototype gate fires, main.ts's real onPrototypeReview → renderPrototypePreview composes
// composePreviewMarkdown(gate) into #reading-pane. The default MOCK_PROTOTYPE_GATE is kind:"mermaid",
// which would paint a stray `flowchart LR` diagram BEHIND the floating trail card (review item #6 — the
// demo's prototype is the HTML card, NOT a mermaid). The Trailhead player passes THIS override so the
// detached preview renders as a short plain-fence note that COMPLEMENTS the card + title-only backdrop —
// no mermaid anywhere in the prototype-review chapter. (Mermaid lives only in TRAILHEAD_MASTER_DOC.)
export const TRAILHEAD_PROTO_PREVIEW_OVERRIDE = {
  kind: "ascii" as const,
  inlinePreview:
    "Trail card — Eagle Peak Loop\n6.2 mi · +1,400 ft\n(interactive preview floats over this pane →)",
};

// The trail-card CSS (namespaced to `#demo-proto-card` descendants). Injected by the player alongside
// ANIM_CSS. `--tc-scale` (set by the player per round) drives every size so round 2 is uniformly larger;
// `.tc-badge` is hidden by round 1's HTML omitting it (round 2's HTML adds it). The card chrome itself
// (`#demo-proto-card` position/background/shadow) lives in ANIM_CSS — this is the card INTERIOR only.
export const TRAILHEAD_PROTO_CARD_CSS = `
#demo-proto-card .tc-card {
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--tc-scale, 1));
}
#demo-proto-card .tc-thumb {
  height: calc(74px * var(--tc-scale, 1));
  border-radius: 8px;
  background: linear-gradient(135deg, #3a5f3a, #6aa3ff);
}
#demo-proto-card .tc-title {
  font-size: calc(15px * var(--tc-scale, 1));
  font-weight: 600;
}
#demo-proto-card .tc-meta {
  font-size: calc(12px * var(--tc-scale, 1));
  opacity: 0.75;
}
#demo-proto-card .tc-badge {
  align-self: flex-start;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: calc(11px * var(--tc-scale, 1));
  font-weight: 600;
  color: #10210f;
  background: #7ed47e;
}
`;

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
  // sidebar/list plan — markdown map only, so read_plan_contents serves it. The trail-card overlay
  // (#demo-proto-card) floats over it; the doc is just a title.
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
