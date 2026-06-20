// Visual-prototype review gate — PURE, DOM-free, invoke-free helpers.
//
// Mirrors review.ts's discipline: no imports from main.ts, no DOM, no Tauri. main.ts consumes
// these to (a) compose the detached reading-pane preview for a held PrototypeGate, (b) derive the
// review bar's PROTOTYPE mode (labels + precedence), and (c) pick the file the "Open in browser"
// button hands to the `open_prototype` Rust command. Everything here is unit-testable in
// isolation exactly like review.ts / feedback.ts.
//
// ROUND SEMANTICS (driver-owned — see orchestrator.ts's prototypeRound discipline): gates carry a
// 1-BASED round ("which prototype round produced this gate"); the driver mints round 1 first and
// increments ONLY on refinePrototype. The UI's loop-escape threshold is round >= 3: from the third
// round on, the approve affordance relabels to "Proceed as-is" so the loop always has an exit.

import type { PrototypeGate, AcceptanceGate, TreeNode } from "./conversation/plan-tree";
import { pathKey } from "./conversation/plan-tree";

// The displayed round ceiling (the loop-escape threshold). Display-only: the orchestrator never
// hard-stops the loop; the bar just stops counting past 3 and offers "Proceed as-is".
export const PROTOTYPE_MAX_ROUNDS = 3;

// Fence `body` as a markdown code block. `lang` "" yields a plain fence. If the body itself
// contains a triple-backtick run, the fence widens to one backtick more than the longest run so
// the preview can never be broken out of (standard CommonMark longer-fence rule).
function fence(lang: string, body: string): string {
  const runs = body.match(/`{3,}/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 2);
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${body}\n${f}`;
}

// The fence language for a gate kind: mermaid previews render through the existing mermaid fence
// pipeline; ascii/table previews are plain fenced blocks (monospace, no highlighting surprises).
function fenceLangFor(kind: PrototypeGate["kind"]): string {
  return kind === "mermaid" ? "mermaid" : "";
}

/**
 * PURE: compose the markdown the reading pane renders (detached — never written to disk, never
 * opening a plan path) for a held visual-prototype gate.
 *   - kind "mermaid"        → the inlinePreview in a ```mermaid fence (the pane's existing
 *                             mermaid pipeline renders it).
 *   - kind "ascii"/"table"  → the inlinePreview in a plain fence.
 *   - kind "html"           → a short notice (HTML cannot render inline) listing the on-disk
 *                             paths and pointing at the bar's "Open in browser" button.
 *   - variants (any kind)   → each appended under a `### <label>` heading with its own fenced
 *                             inlinePreview (or its path when no inline preview exists).
 */
export function composePreviewMarkdown(gate: PrototypeGate): string {
  const sections: string[] = [];
  if (gate.kind === "html") {
    const list = gate.paths.map((p) => `- \`${p}\``).join("\n");
    sections.push(
      "HTML prototype written to `.plan-tree/prototype/` — use **Open in browser** below." +
        (gate.paths.length > 0 ? `\n\n${list}` : ""),
    );
  } else if (gate.inlinePreview !== null && gate.inlinePreview !== "") {
    sections.push(fence(fenceLangFor(gate.kind), gate.inlinePreview));
  } else {
    // Non-HTML kinds are expected to carry an inline preview; degrade to the paths when absent.
    const list = gate.paths.map((p) => `- \`${p}\``).join("\n");
    sections.push(
      "_No inline preview was provided._" + (gate.paths.length > 0 ? `\n\n${list}` : ""),
    );
  }
  for (const v of gate.variants) {
    const lines = [`### ${v.label}`];
    if (v.inlinePreview !== null && v.inlinePreview !== "") {
      lines.push("", fence(fenceLangFor(gate.kind), v.inlinePreview));
    } else if (v.path !== null) {
      lines.push("", `\`${v.path}\``);
    }
    sections.push(lines.join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * PURE: the review bar's PROTOTYPE-mode label. Rounds are 1-based; display clamps to the
 * [1, PROTOTYPE_MAX_ROUNDS] window (the driver can mint round 4+ after repeated refines — the
 * label keeps reading "round 3 of 3" while the approve label has already flipped to
 * "Proceed as-is").
 */
export function prototypeBarLabel(round: number): string {
  const n = Math.min(Math.max(round, 1), PROTOTYPE_MAX_ROUNDS);
  return `Visual prototype — round ${n} of ${PROTOTYPE_MAX_ROUNDS}`;
}

/**
 * PURE: the approve button's PROTOTYPE-mode label. Always enabled; from round 3 on it relabels to
 * "Proceed as-is" — the loop-escape affordance (the action is identical: approvePrototype()).
 */
export function prototypeApproveLabel(round: number): string {
  return round >= PROTOTYPE_MAX_ROUNDS ? "Proceed as-is" : "Approve visual";
}

/**
 * PURE: the bar-mode precedence derivation — the active PrototypeGate, or null. Derives STRICTLY
 * from the orchestrator SNAPSHOT (never module state) so the gate self-clears: the reducer nulls
 * `pendingPrototype` on PROTOTYPE_APPROVED/PROTOTYPE_REFINED and the next onSnapshot reverts the
 * bar with no bookkeeping. Precedence (first match wins): a held approval gate (pendingApproval)
 * beats the prototype gate; the prototype gate beats the pendingReviews surfaces (the caller falls
 * through to those only when this returns null).
 */
export function prototypeGateActive(
  snap: { pendingApproval: unknown; pendingPrototype: PrototypeGate | null } | null,
  orchestrationActive: boolean,
): PrototypeGate | null {
  if (!orchestrationActive || snap === null) return null;
  if (snap.pendingApproval != null) return null; // approval gate takes precedence
  return snap.pendingPrototype;
}

/**
 * PURE: the file the "Open in browser" button targets — the gate's `index.html` path when one is
 * present, else the first path, else null (nothing to open; the caller no-ops). Paths may be
 * relative to the gate's cwd; the `open_prototype` Rust command resolves them.
 */
export function prototypeOpenTarget(gate: Pick<PrototypeGate, "paths">): string | null {
  const index = gate.paths.find((p) => p === "index.html" || p.endsWith("/index.html"));
  return index ?? gate.paths[0] ?? null;
}

// ---- PHASE 5: the forced ACCEPTANCE gate bar (mirrors the prototype-gate helpers) --------------

/**
 * PURE: the bar-mode precedence derivation for the forced acceptance gate — the active
 * AcceptanceGate, or null. Derives STRICTLY from the orchestrator SNAPSHOT (never module state) so
 * the gate self-clears: the reducer nulls `pendingAcceptance` on ACCEPTANCE_APPROVED/DIVERGED and
 * the next onSnapshot reverts the bar with no bookkeeping. Precedence (first match wins): a held
 * approval gate (pendingApproval) and a held prototype gate (pendingPrototype) BOTH beat the
 * acceptance gate (those are mid-run interactive holds; the acceptance gate is a post-completion
 * hold, so it can never legitimately co-exist with them — but the precedence is explicit and
 * defensive). The acceptance gate beats the pendingReviews surfaces (the caller falls through to
 * those only when this returns null).
 */
export function acceptanceGateActive(
  snap:
    | { pendingApproval: unknown; pendingPrototype: unknown; pendingAcceptance: AcceptanceGate | null }
    | null,
  orchestrationActive: boolean,
): AcceptanceGate | null {
  if (!orchestrationActive || snap === null) return null;
  if (snap.pendingApproval != null) return null; // approval gate takes precedence
  if (snap.pendingPrototype != null) return null; // prototype gate takes precedence
  return snap.pendingAcceptance;
}

/**
 * PURE: the acceptance bar's label. The run is built; the user must record a verdict against the
 * frozen working-reference baseline before the run is reported done.
 */
export function acceptanceBarLabel(): string {
  return "Acceptance — does the build meet the baseline floor?";
}

/** PURE: the acceptance bar's Approve-button label (the build clears the floor). */
export function acceptanceApproveLabel(): string {
  return "Accept (meets baseline)";
}

/** PURE: the acceptance bar's diverge-button label (accept a result below the floor, with a reason). */
export function acceptanceDivergeLabel(): string {
  return "Accept divergence…";
}

/** PURE: the acceptance bar's REFINE-button label (re-plan a sub-plan — the third gate action). */
export function acceptanceRefineLabel(): string {
  return "Refine a sub-plan…";
}

/**
 * PURE: the refinable sub-plan TARGETS for the forced-acceptance refine action — the ROOT's DIRECT
 * children (the top-level sub-plans the gate surfaces). Each carries its canonical dotted pathKey
 * (the `target` refineAcceptance takes, parsed back via parsePathKey) and its human title (for the
 * picker). Returns [] when the root is not a split (e.g. a single-leaf run has no sub-plans to
 * refine). DERIVES from the tree alone so the picker self-updates with the snapshot.
 */
export function acceptanceRefineTargets(root: TreeNode): Array<{ pathKey: string; title: string }> {
  if (root.state.stage !== "split") return [];
  return root.state.children.map((c) => ({ pathKey: pathKey([c.nn]), title: c.title }));
}
