// Mock-mode fixture tests — the "Trailhead" nested plan tree (src/mock/fixtures/trailhead-plan.ts).
//
// These assert the SHAPE the storyboard relies on, independent of incidental field values:
//   • the tree is ≥2 levels deep (master nn_path null; subs "01".."04"; sub-subs "04.01".."04.04");
//   • records arrive PRE-ORDERED master-first with strictly-descending mtimes (so the sidebar nests
//     them correctly near the top);
//   • the master doc carries a ```mermaid fence, and renderMarkdown (the REAL reading-pane renderer,
//     in jsdom) turns that fence into a `.mermaid-src` placeholder (NOT a plain <pre><code>).

import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../render/markdown";
import {
  TRAILHEAD_PLANS,
  TRAILHEAD_MASTER_PATH,
  TRAILHEAD_MASTER_DOC,
  TRAILHEAD_MASTER_V2_PATH,
  TRAILHEAD_MASTER_V2_DOC,
  TRAILHEAD_MARKDOWN,
} from "./trailhead-plan";

describe("trailhead-plan fixture — tree shape", () => {
  it("is ≥2 levels deep: master (nn_path null), subs 01..04, sub-subs 04.01..04.04", () => {
    const master = TRAILHEAD_PLANS.find((p) => p.flavor === "master");
    expect(master).toBeDefined();
    expect(master!.nn_path).toBeNull();
    expect(master!.child_count).toBe(4);
    expect(master!.absolute_path).toBe(TRAILHEAD_MASTER_PATH);

    const nnPaths = TRAILHEAD_PLANS.map((p) => p.nn_path);
    // Direct subs (level 1).
    for (const p of ["01", "02", "03", "04"]) expect(nnPaths).toContain(p);
    // Decomposition leaves (level 2 — this is what makes it ≥2 levels deep).
    for (const p of ["04.01", "04.02", "04.03", "04.04"]) expect(nnPaths).toContain(p);

    // The four 04.* leaves carry a DOTTED nn_path (a deeper level than their "04" parent).
    const leaves = TRAILHEAD_PLANS.filter((p) => p.nn_path?.startsWith("04."));
    expect(leaves).toHaveLength(4);
  });

  it("records are PRE-ORDERED master-first with strictly-descending mtimes", () => {
    expect(TRAILHEAD_PLANS[0].flavor).toBe("master");
    expect(TRAILHEAD_PLANS).toHaveLength(9);
    // nn_path document order: null, 01, 02, 03, 04, 04.01..04.04.
    expect(TRAILHEAD_PLANS.map((p) => p.nn_path)).toEqual([
      null,
      "01",
      "02",
      "03",
      "04",
      "04.01",
      "04.02",
      "04.03",
      "04.04",
    ]);
    // Strictly descending mtimes (so list_plans' newest-first order preserves the pre-order).
    for (let i = 1; i < TRAILHEAD_PLANS.length; i++) {
      expect(TRAILHEAD_PLANS[i].mtime_ms).toBeLessThan(TRAILHEAD_PLANS[i - 1].mtime_ms);
    }
    // All share one tree_id (so the sidebar groups them as one tree).
    const treeIds = new Set(TRAILHEAD_PLANS.map((p) => p.tree_id));
    expect(treeIds.size).toBe(1);
  });
});

describe("trailhead-plan fixture — master doc renders a mermaid placeholder", () => {
  it("TRAILHEAD_MASTER_DOC contains a ```mermaid fence and starts with its H1 (no leading ---)", () => {
    expect(TRAILHEAD_MASTER_DOC).toContain("```mermaid");
    expect(TRAILHEAD_MASTER_DOC.startsWith("# Master Plan: Trailhead")).toBe(true);
    // The doc is the master node's served markdown.
    expect(TRAILHEAD_MARKDOWN[TRAILHEAD_MASTER_PATH]).toBe(TRAILHEAD_MASTER_DOC);
  });

  it("renderMarkdown(TRAILHEAD_MASTER_DOC) emits a .mermaid-src placeholder (real renderer, jsdom)", () => {
    const html = renderMarkdown(TRAILHEAD_MASTER_DOC);
    // The reading pane lazy-renders this placeholder into an SVG. FALSIFIABILITY: remove the ```mermaid
    // fence from TRAILHEAD_MASTER_DOC and this assertion goes RED (the diagram becomes a plain code block).
    expect(html).toContain('class="mermaid-src"');
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("pre.mermaid-src")).not.toBeNull();
  });
});

describe("trailhead-plan fixture — revised master (V2) + comment anchor quotes", () => {
  // The three comment quotes the Slice-06 storyboard anchors on the V1 master. Each MUST be verbatim V1
  // PROSE (outside the ```mermaid fence) so applyComments anchors it. Kept in sync with the storyboard's
  // TRAILHEAD_COMMENT_1/2/3 quotes.
  const ANCHOR_QUOTES = [
    "decomposes the build into four subplans",
    "the difficulty-badge work the reviewer asked for has a home",
    "Subplans run in order",
  ];

  it("the V2 doc VISIBLY differs from V1 and is served at TRAILHEAD_MASTER_V2_PATH", () => {
    expect(TRAILHEAD_MASTER_V2_DOC).not.toBe(TRAILHEAD_MASTER_DOC);
    // The visible diff: a "Difficulty badge" subsection + a "larger trail cards" note (Slice-04 feedback).
    expect(TRAILHEAD_MASTER_V2_DOC).toContain("## Difficulty badge");
    expect(TRAILHEAD_MASTER_V2_DOC).toContain("larger trail cards");
    // V2 is served by the mock read_plan_contents but is NOT a sidebar row.
    expect(TRAILHEAD_MARKDOWN[TRAILHEAD_MASTER_V2_PATH]).toBe(TRAILHEAD_MASTER_V2_DOC);
    expect(TRAILHEAD_PLANS.some((p) => p.absolute_path === TRAILHEAD_MASTER_V2_PATH)).toBe(false);
  });

  it("each anchor quote appears verbatim in the V1 master PROSE (so it will anchor)", () => {
    // The mermaid fence body (between ```mermaid and the closing ```) — quotes must NOT come from here.
    const fenceStart = TRAILHEAD_MASTER_DOC.indexOf("```mermaid");
    const fenceEnd = TRAILHEAD_MASTER_DOC.indexOf("```", fenceStart + 3);
    const fenceBody = TRAILHEAD_MASTER_DOC.slice(fenceStart, fenceEnd + 3);
    for (const quote of ANCHOR_QUOTES) {
      expect(TRAILHEAD_MASTER_DOC).toContain(quote); // verbatim somewhere in the doc…
      expect(fenceBody).not.toContain(quote); // …and NOT inside the mermaid fence (it's prose).
    }
  });
});
