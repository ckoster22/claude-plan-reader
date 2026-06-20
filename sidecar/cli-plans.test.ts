import { describe, expect, it } from "vitest";
import { isAbsolute } from "node:path";
import { cliPlanRedirectSettings } from "./cli-plans";

// The CLI's own plan-mode saves default to ~/.claude/plans/ when `plansDirectory`
// is unset — which is exactly the bug (a frontmatter-less duplicate of every
// agent-drafted plan rendered as a separate top-level sidebar row). These tests pin
// the redirect's two load-bearing properties.
//
// [FALSIFIED: returned `{ plansDirectory: "" }` from cliPlanRedirectSettings →
// "redirects the CLI's plan saves" went RED (empty value means "unset" to the CLI,
// reinstating the ~/.claude/plans default); returned an absolute "/tmp/cli-plans" →
// "stays a relative .plan-tree path" went RED (the CLI rejects/escapes the
// project-root containment). Restored → GREEN.]
describe("cliPlanRedirectSettings", () => {
  it("redirects the CLI's plan saves (a set, non-empty plansDirectory — unset would re-default to ~/.claude/plans and resurrect the duplicate top-level sidebar rows)", () => {
    const s = cliPlanRedirectSettings();
    expect(typeof s.plansDirectory).toBe("string");
    expect(s.plansDirectory.length).toBeGreaterThan(0);
  });

  it("stays a relative .plan-tree path with no traversal (the CLI requires plansDirectory to resolve INSIDE the project root)", () => {
    const s = cliPlanRedirectSettings();
    expect(isAbsolute(s.plansDirectory)).toBe(false);
    expect(s.plansDirectory.startsWith(".plan-tree/")).toBe(true);
    expect(s.plansDirectory.includes("..")).toBe(false);
  });
});
