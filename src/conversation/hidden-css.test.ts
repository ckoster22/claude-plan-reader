// Guard test for the `.hidden` invariant.
//
// The conversation domain (composer modal, auth banner, inline error) hides those elements by
// toggling a `.hidden` class. That only works if `src/styles.css` actually backs `.hidden` with a
// `display: none` rule. A regression once shipped where NO generic `.hidden` rule existed, so the
// modal/banner/error were permanently visible. jsdom does not apply external-stylesheet display,
// so we assert at the CSS *source* level: the stylesheet must contain a generic `.hidden` rule
// setting `display: none` (whitespace- and `!important`-tolerant).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("styles.css .hidden invariant", () => {
  it("defines a generic `.hidden` rule that sets display: none", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

    // Match a bare `.hidden { ... display: none ... }` selector (no compound/descendant prefix on
    // the `.hidden` token). `display\s*:\s*none` tolerates whitespace; `!important` is optional.
    const genericHidden =
      /(^|[\s,{};])\.hidden\s*\{[^}]*display\s*:\s*none\s*(!important)?\s*;?[^}]*\}/m;

    expect(genericHidden.test(css)).toBe(true);
  });
});
