// Conversation domain (Sub-Plan 02) — dark-mode guard.
//
// Asserts that NO `.conv-*` style RULE (and the composer modal) hardcodes a literal color
// (hex / rgb( / rgba( / hsl( / hsla( ). Every color in a .conv-* rule must resolve through a
// var(--*) token, so the whole Conversation surface re-themes via :root[data-theme="dark"].
//
// The `--conv-*` token DECLARATIONS in the :root / :root[data-theme="dark"] blocks legitimately
// carry literal values (they ARE the tokens) — those blocks are excluded; only conv-* SELECTOR
// rule bodies are scanned.
//
// Falsifiability: introduce a hardcoded color in any .conv-* rule and this goes red (confirmed
// red-then-green during development).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Read the REAL stylesheet's RAW text so a drift in the actual CSS turns this red. Vite's CSS
// plugin intercepts BOTH a `?raw` import and an import.meta.glob `?raw` of a .css file (it returns
// an empty/processed module), so we read the file straight off disk via node:fs (vitest runs under
// Node from the project root; @types/node is a devDep). This is the verbatim source — no CSS
// pipeline.
const CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

// A literal color: #rgb / #rrggbb / #rrggbbaa, or an rgb()/rgba()/hsl()/hsla() function.
const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;

// Crude but sufficient CSS rule splitter: matches `selector { body }` blocks. The stylesheet has
// no nested at-rules inside the .conv-* block, so a flat split is correct here.
function ruleBlocks(css: string): Array<{ selector: string; body: string }> {
  // Strip CSS comments first so a `{` or color literal inside a comment never pollutes a
  // selector/body or trips the literal-color scan.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    blocks.push({ selector: m[1].trim(), body: m[2] });
  }
  return blocks;
}

describe("dark-mode guard — .conv-* rules are tokens-only", () => {
  const blocks = ruleBlocks(CSS);

  // Every rule whose selector targets a .conv-* class (covers the composer modal, status pill,
  // stream rows, etc. — they are ALL namespaced .conv-*).
  const convRules = blocks.filter((b) => b.selector.includes(".conv-"));

  it("the stylesheet actually contains .conv-* rules (guard is exercising something)", () => {
    // If this is 0, the selector namespacing changed and the guard below would be vacuously true.
    expect(convRules.length).toBeGreaterThan(10);
  });

  it("NO .conv-* rule body contains a literal hex/rgb/rgba/hsl/hsla color", () => {
    const offenders = convRules
      .filter((b) => LITERAL_COLOR.test(b.body))
      .map((b) => b.selector + " { " + b.body.trim() + " }");
    expect(offenders).toEqual([]);
  });

  it("every new --conv-* token is declared in BOTH :root and :root[data-theme=\"dark\"]", () => {
    // Collect the token names declared in the light :root block and the dark block, and assert
    // the dark block redefines each --conv-* the light block introduces (so it re-themes).
    const rootBlock = blocks.find((b) => b.selector === ":root");
    const darkBlock = blocks.find((b) => b.selector === ':root[data-theme="dark"]');
    expect(rootBlock).toBeTruthy();
    expect(darkBlock).toBeTruthy();
    const names = (body: string): string[] =>
      Array.from(body.matchAll(/(--conv-[a-z-]+)\s*:/g)).map((m) => m[1]);
    const light = new Set(names(rootBlock!.body));
    const dark = new Set(names(darkBlock!.body));
    expect(light.size).toBeGreaterThan(0);
    for (const tok of light) {
      expect(dark.has(tok), `--conv token ${tok} missing from the dark block`).toBe(true);
    }
  });
});
