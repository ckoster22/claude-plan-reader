import { describe, it, expect } from "vitest";
import {
  composePreviewMarkdown,
  prototypeBarLabel,
  prototypeApproveLabel,
  prototypeGateActive,
  prototypeOpenTarget,
  acceptanceGateActive,
  acceptanceBarLabel,
  acceptanceApproveLabel,
  acceptanceDivergeLabel,
  acceptanceRefineLabel,
  acceptanceRefineTargets,
  PROTOTYPE_MAX_ROUNDS,
} from "./prototype";
import type { PrototypeGate, AcceptanceGate, TreeNode, Nn, NonEmptyArray } from "./conversation/plan-tree";
import { parseNn, nonEmpty } from "./conversation/plan-tree";

// Mint a gate with overridable fields (defaults: mermaid, one path, inline preview, no variants).
function gate(over: Partial<PrototypeGate> = {}): PrototypeGate {
  return {
    kind: "mermaid",
    paths: [".plan-tree/prototype/diagram.mmd"],
    screenshot: null,
    inlinePreview: "graph TD; A-->B;",
    variants: [],
    round: 1,
    cwd: "/tmp/proj",
    ...over,
  };
}

describe("composePreviewMarkdown", () => {
  // Kind table: mermaid → ```mermaid fence; ascii/table → plain fence; html → notice + paths.
  // Falsifiability was exercised by inverting the mermaid fence language to plain ("") and
  // confirming the mermaid case below went red before restoring.
  it("mermaid kind fences the inline preview as a mermaid block", () => {
    const md = composePreviewMarkdown(gate({ kind: "mermaid", inlinePreview: "graph TD; A-->B;" }));
    expect(md).toContain("```mermaid\ngraph TD; A-->B;\n```");
  });

  it("ascii and table kinds fence the inline preview as a PLAIN block (no language)", () => {
    for (const kind of ["ascii", "table"] as const) {
      const md = composePreviewMarkdown(gate({ kind, inlinePreview: "+--+\n|##|\n+--+" }));
      expect(md).toContain("```\n+--+\n|##|\n+--+\n```");
      expect(md).not.toContain("```mermaid");
    }
  });

  it("html kind emits the open-in-browser notice and lists the paths (no fence)", () => {
    const md = composePreviewMarkdown(
      gate({
        kind: "html",
        inlinePreview: null,
        paths: [".plan-tree/prototype/index.html", ".plan-tree/prototype/style.css"],
      }),
    );
    expect(md).toContain("HTML prototype written to `.plan-tree/prototype/`");
    expect(md).toContain("**Open in browser**");
    expect(md).toContain("- `.plan-tree/prototype/index.html`");
    expect(md).toContain("- `.plan-tree/prototype/style.css`");
    expect(md).not.toContain("```");
  });

  it("variants each render under a ### <label> heading with their fenced inline preview", () => {
    const md = composePreviewMarkdown(
      gate({
        kind: "mermaid",
        variants: [
          { label: "Compact", path: null, inlinePreview: "graph LR; X-->Y;" },
          { label: "Detailed", path: ".plan-tree/prototype/detailed.mmd", inlinePreview: null },
        ],
      }),
    );
    expect(md).toContain("### Compact\n\n```mermaid\ngraph LR; X-->Y;\n```");
    // A variant without an inline preview degrades to its path (never a dangling empty fence).
    expect(md).toContain("### Detailed\n\n`.plan-tree/prototype/detailed.mmd`");
    // Order: main preview first, then variants in array order.
    expect(md.indexOf("graph TD")).toBeLessThan(md.indexOf("### Compact"));
    expect(md.indexOf("### Compact")).toBeLessThan(md.indexOf("### Detailed"));
  });

  it("a preview containing a triple-backtick run cannot break out of the fence", () => {
    const md = composePreviewMarkdown(gate({ kind: "ascii", inlinePreview: "x\n```\ninjected" }));
    // The wrapping fence must be LONGER than the embedded run (CommonMark longer-fence rule).
    expect(md).toContain("````\nx\n```\ninjected\n````");
  });

  it("a non-html kind with no inline preview degrades to a notice + paths", () => {
    const md = composePreviewMarkdown(gate({ kind: "ascii", inlinePreview: null }));
    expect(md).toContain("_No inline preview was provided._");
    expect(md).toContain("- `.plan-tree/prototype/diagram.mmd`");
  });
});

describe("prototypeBarLabel / prototypeApproveLabel (round boundaries)", () => {
  it("labels rounds 1..3 verbatim and clamps past the ceiling", () => {
    expect(prototypeBarLabel(1)).toBe("Visual prototype — round 1 of 3");
    expect(prototypeBarLabel(2)).toBe("Visual prototype — round 2 of 3");
    expect(prototypeBarLabel(3)).toBe("Visual prototype — round 3 of 3");
    // The driver can mint round 4+ after repeated refines — the label stays clamped at 3.
    expect(prototypeBarLabel(4)).toBe("Visual prototype — round 3 of 3");
  });

  it("approve label flips to Proceed as-is exactly at round 3 (the loop-escape boundary)", () => {
    expect(PROTOTYPE_MAX_ROUNDS).toBe(3);
    expect(prototypeApproveLabel(1)).toBe("Approve visual");
    expect(prototypeApproveLabel(2)).toBe("Approve visual");
    expect(prototypeApproveLabel(3)).toBe("Proceed as-is");
    expect(prototypeApproveLabel(4)).toBe("Proceed as-is");
  });
});

describe("prototypeGateActive (bar-mode precedence)", () => {
  const g = gate();

  it("yields the gate when orchestration is active and no approval gate is held", () => {
    expect(prototypeGateActive({ pendingApproval: null, pendingPrototype: g }, true)).toBe(g);
  });

  it("a held pendingApproval BEATS the prototype gate (precedence)", () => {
    expect(
      prototypeGateActive({ pendingApproval: { kind: "leaf" }, pendingPrototype: g }, true),
    ).toBeNull();
  });

  it("inactive orchestration or a missing snapshot yields null (bar falls through)", () => {
    expect(prototypeGateActive({ pendingApproval: null, pendingPrototype: g }, false)).toBeNull();
    expect(prototypeGateActive(null, true)).toBeNull();
  });

  it("self-clears: a snapshot with pendingPrototype null yields null", () => {
    expect(prototypeGateActive({ pendingApproval: null, pendingPrototype: null }, true)).toBeNull();
  });
});

describe("acceptanceGateActive (Phase 5 — forced acceptance bar precedence)", () => {
  const ag: AcceptanceGate = { cwd: "/work", openTarget: "index.html", runCommand: null, round: 1 };

  it("yields the gate when orchestration is active and no approval/prototype gate is held", () => {
    expect(
      acceptanceGateActive(
        { pendingApproval: null, pendingPrototype: null, pendingAcceptance: ag },
        true,
      ),
    ).toBe(ag);
  });

  it("a held pendingApproval BEATS the acceptance gate (precedence)", () => {
    expect(
      acceptanceGateActive(
        { pendingApproval: { kind: "leaf" }, pendingPrototype: null, pendingAcceptance: ag },
        true,
      ),
    ).toBeNull();
  });

  it("a held pendingPrototype BEATS the acceptance gate (precedence)", () => {
    expect(
      acceptanceGateActive(
        { pendingApproval: null, pendingPrototype: { round: 1 }, pendingAcceptance: ag },
        true,
      ),
    ).toBeNull();
  });

  it("inactive orchestration or a missing snapshot yields null (bar falls through)", () => {
    expect(
      acceptanceGateActive(
        { pendingApproval: null, pendingPrototype: null, pendingAcceptance: ag },
        false,
      ),
    ).toBeNull();
    expect(acceptanceGateActive(null, true)).toBeNull();
  });

  it("self-clears: a snapshot with pendingAcceptance null yields null", () => {
    expect(
      acceptanceGateActive(
        { pendingApproval: null, pendingPrototype: null, pendingAcceptance: null },
        true,
      ),
    ).toBeNull();
  });

  it("the bar labels are stable, descriptive strings", () => {
    expect(acceptanceBarLabel()).toMatch(/baseline/i);
    expect(acceptanceApproveLabel()).toMatch(/meets baseline/i);
    expect(acceptanceDivergeLabel()).toMatch(/divergence/i);
  });
});

describe("acceptanceRefineTargets / acceptanceRefineLabel (Phase 6 — refine bar action)", () => {
  const nn = (n: number): Nn => parseNn(n);
  // A summarized leaf child (the shape every root child has at the acceptance gate).
  function summarizedChild(n: number, title: string): TreeNode {
    return {
      nn: nn(n),
      title,
      redraftCount: 0,
      lastFeedback: null,
      state: { stage: "leaf", phase: "summarized", planPath: `/p${n}.md`, summaryPath: null, plansDirPath: null },
    };
  }
  // A split root resting in its acceptance window (all children summarized).
  function splitRoot(titles: string[]): TreeNode {
    return {
      nn: nn(1),
      title: "root",
      redraftCount: 0,
      lastFeedback: null,
      state: {
        stage: "split",
        phase: "running-children",
        children: nonEmpty(titles.map((t, i) => summarizedChild(i + 1, t))) as NonEmptyArray<TreeNode>,
        planPath: null,
        summaryPath: null,
        plansDirPath: null,
      },
    };
  }

  it("lists the ROOT's direct children as {pathKey, title} targets in order", () => {
    const targets = acceptanceRefineTargets(splitRoot(["Slice A", "Slice B", "Slice C"]));
    expect(targets).toEqual([
      { pathKey: "01", title: "Slice A" },
      { pathKey: "02", title: "Slice B" },
      { pathKey: "03", title: "Slice C" },
    ]);
  });

  it("returns [] for a non-split root (a single-leaf run has no sub-plans to refine)", () => {
    const leafRoot: TreeNode = {
      nn: nn(1),
      title: "root",
      redraftCount: 0,
      lastFeedback: null,
      state: { stage: "leaf", phase: "summarized", planPath: "/p.md", summaryPath: null, plansDirPath: null },
    };
    expect(acceptanceRefineTargets(leafRoot)).toEqual([]);
  });

  it("the refine label is a stable, descriptive string", () => {
    expect(acceptanceRefineLabel()).toMatch(/refine/i);
  });
});

describe("prototypeOpenTarget", () => {
  it("prefers the index.html path, else the first path, else null", () => {
    expect(
      prototypeOpenTarget({ paths: ["a.css", ".plan-tree/prototype/index.html", "b.html"] }),
    ).toBe(".plan-tree/prototype/index.html");
    expect(prototypeOpenTarget({ paths: ["index.html", "other.html"] })).toBe("index.html");
    expect(prototypeOpenTarget({ paths: ["solo.html"] })).toBe("solo.html");
    expect(prototypeOpenTarget({ paths: [] })).toBeNull();
    // A path merely CONTAINING "index.html" as a suffix of another name must not match.
    expect(prototypeOpenTarget({ paths: ["not-index.html.bak", "real.html"] })).toBe(
      "not-index.html.bak",
    );
  });
});
