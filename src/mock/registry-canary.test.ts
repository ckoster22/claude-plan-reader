// Phase-5 COMMAND-REGISTRY DRIFT CANARY (vitest + Node fs).
//
// THE INVARIANT (falsifiable): every Tauri command the REAL, unmodified frontend issues via
// `invoke(...)` MUST be handled by the mock — i.e. `HANDLED_COMMAND_SET` (from ./core) is a SUPERSET
// of the set of command names statically derived from the production source. If a new
// `invoke("some_new_cmd")` call site is added without a corresponding mock handler, this test goes
// RED, naming the missing command(s). That is the entire point of the canary: it couples the mock's
// handled surface to the app's actual call sites at test time, since `tsc` cannot (the app's
// `invoke(cmd, args)` call sites are UNTYPED — `cmd` is a plain string, not linked to MockCommand).
//
// WHY STATIC (fs + regex), not dynamic: we scan the production .ts files on disk for `invoke(...)`
// literals rather than executing the app. This is deterministic, fast, and needs no DOM/agent.
//
// SCOPE: production source under src/, EXCLUDING src/mock/** (the mock itself, including this file)
// and any *.test.ts (test files mock invoke and would pollute the derived set). Dynamic / non-literal
// command names (e.g. `invoke(cmd)` where cmd is a variable) cannot be statically resolved — they are
// SKIPPED but COUNTED and logged, never silently ignored.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HANDLED_COMMAND_SET } from "./core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/mock/ -> src/
const SRC_DIR = path.resolve(__dirname, "..");

// Recursively collect production .ts files under src/, excluding the mock tree and test files.
function collectProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Exclude the mock harness entirely (it defines/handles the commands; including it would make
      // the canary self-referential and unable to catch a missing handler).
      if (full === path.join(SRC_DIR, "mock")) continue;
      out.push(...collectProductionTsFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    // Exclude test files: they mock invoke (e.g. `if (cmd === "hook_status") ...`) and reference
    // commands the frontend never actually issues, which would corrupt the derived set.
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

// Match `invoke` optionally followed by a generic type arg `<...>`, then `(`, then a string literal
// (single, double, or backtick — backtick only when it contains NO `${...}` interpolation, i.e. a
// static template). Captures the command name. Examples matched:
//   invoke("list_plans")
//   invoke<number>("get_comment_count", { path })
//   invoke<string | null>("read_plan_tree_file", { cwd, name })
// We then separately detect dynamic call sites (a non-literal first arg) to count skips.
const LITERAL_INVOKE = /\binvoke\s*(?:<[^>]*>)?\s*\(\s*(['"`])([a-zA-Z_][\w-]*)\1/g;

// A broader matcher for ANY `invoke(` opener that is a CALL (followed by `(`), used to detect
// dynamic/non-literal command args: count of all-call openers minus literal matches = skips.
// We exclude method-style `.invoke(` / identifiers like `invoker` / `invokeResolve` by requiring a
// word boundary before `invoke` and that it is not immediately preceded by `.` or another word char.
const ANY_INVOKE_CALL = /(?<![.\w])invoke\s*(?:<[^>]*>)?\s*\(/g;

interface Derived {
  commands: Set<string>;
  dynamicSkips: { file: string; snippet: string }[];
}

// Strip line (`// ...`) and block (`/* ... */`) comments so prose mentions of `invoke(...)` (which
// are common in this codebase's heavy doc-comments) are NOT miscounted as call sites. We blank the
// comment bodies (replacing with spaces of equal length) rather than deleting them, so byte offsets
// of the surviving CODE stay stable — important because the dynamic-skip detector compares match
// offsets between the two regexes. This is a deliberately simple stripper: it does not parse strings,
// so a `//` or `/*` INSIDE a string literal would also be blanked. That is acceptable here — it can
// only ever REMOVE candidate matches, never invent a command name, so it cannot cause a false RED
// (the safe failure direction is a missed real call site, and command-name literals never contain
// `//` or `/*`).
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      // Preserve newlines inside the block so line-snippet extraction still aligns.
      for (let j = i; j < stop; j++) out += src[j] === "\n" ? "\n" : " ";
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function deriveInvokedCommands(files: string[]): Derived {
  const commands = new Set<string>();
  const dynamicSkips: { file: string; snippet: string }[] = [];

  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));

    // 1) Collect every literal command name.
    for (const m of src.matchAll(LITERAL_INVOKE)) {
      commands.add(m[2]);
    }

    // 2) Detect dynamic call sites: every `invoke(`-call opener whose argument is NOT a literal we
    //    matched at that same offset. We compare match offsets so an opener is "literal" iff a
    //    LITERAL_INVOKE match starts at the same index.
    const literalOffsets = new Set<number>();
    for (const m of src.matchAll(LITERAL_INVOKE)) {
      if (m.index !== undefined) literalOffsets.add(m.index);
    }
    for (const m of src.matchAll(ANY_INVOKE_CALL)) {
      if (m.index === undefined) continue;
      if (literalOffsets.has(m.index)) continue; // this opener resolved to a literal — fine.
      // A non-literal invoke call (dynamic command name). Record a one-line snippet for the log.
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const lineEnd = src.indexOf("\n", m.index);
      const snippet = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
      dynamicSkips.push({ file: path.relative(SRC_DIR, file), snippet });
    }
  }

  return { commands, dynamicSkips };
}

describe("command-registry drift canary", () => {
  const files = collectProductionTsFiles(SRC_DIR);
  const { commands, dynamicSkips } = deriveInvokedCommands(files);

  it("derives a non-empty set of invoked command names from production source", () => {
    // Sanity: if this collapses to 0, the regex/glob broke and the superset assertion below would be
    // vacuously true. Guard against a silently-disabled canary.
    expect(files.length).toBeGreaterThan(0);
    expect(commands.size).toBeGreaterThan(0);
    // Log the derived inventory + any dynamic skips so a reviewer can audit what the canary saw.
    // eslint-disable-next-line no-console
    console.log(
      `[canary] scanned ${files.length} production files; derived ${commands.size} invoked commands:`,
      [...commands].sort(),
    );
    if (dynamicSkips.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[canary] SKIPPED ${dynamicSkips.length} dynamic (non-literal) invoke call site(s):`);
      for (const s of dynamicSkips) {
        // eslint-disable-next-line no-console
        console.log(`  - ${s.file}: ${s.snippet}`);
      }
    } else {
      // eslint-disable-next-line no-console
      console.log("[canary] dynamic (non-literal) invoke call sites skipped: 0");
    }
  });

  it("HANDLED_COMMAND_SET is a superset of every command the real app invokes", () => {
    const missing = [...commands].filter((c) => !HANDLED_COMMAND_SET.has(c)).sort();
    expect(
      missing,
      `The mock does not handle ${missing.length} command(s) the real app invokes via invoke(...): ` +
        `[${missing.join(", ")}]. Add a handler in src/mock/core.ts (dispatch switch) and list the ` +
        `name in HANDLED_COMMANDS, or remove the stray invoke() call site.`,
    ).toEqual([]);
  });
});
