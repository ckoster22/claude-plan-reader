#!/usr/bin/env node
// Compile the Agent SDK sidecar (sidecar/index.ts) into a single native binary
// named for the Rust host target triple, so Tauri's shell-plugin `externalBin`
// can resolve `binaries/agent-driver-<triple>`.
//
// Repo rule: NO `$(...)` command substitution. We spawn child processes with
// `execFileSync` and read their stdout into JS variables instead.
//
// Steps:
//   (a) ASSERT the platform package `@anthropic-ai/claude-agent-sdk-darwin-arm64`
//       is installed (it is an optionalDependency — `npm install --no-optional`
//       or a CI cache can silently skip it, and without it the compiled binary
//       has no bundled `claude` CLI to extract). Fail LOUDLY if absent.
//   (b) Read the Rust host target triple from `rustc -vV` (the `host:` line).
//   (c) Run `bun build --compile` to `src-tauri/binaries/agent-driver-<triple>`.
//   (d) Post-build SMOKE check: boot the binary and confirm `extractFromBunfs`
//       yields an existing, executable path (the embedded CLI really extracts).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function fail(msg) {
  console.error(`\n[sidecar-build] FATAL: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// (a) Assert the darwin-arm64 platform package is present.
// ---------------------------------------------------------------------------
const platformPkgDir = join(
  repoRoot,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk-darwin-arm64",
);
const platformBin = join(platformPkgDir, "claude");
if (!existsSync(platformPkgDir) || !existsSync(platformBin)) {
  fail(
    "@anthropic-ai/claude-agent-sdk-darwin-arm64 is not installed (or its bundled " +
      "`claude` CLI is missing). It is an optionalDependency — re-run `npm install` " +
      "WITHOUT --no-optional so the compiled sidecar has a CLI to embed.",
  );
}
console.log("[sidecar-build] platform package present:", platformBin);

// ---------------------------------------------------------------------------
// (b) Read the Rust host target triple from `rustc -vV`.
// ---------------------------------------------------------------------------
let rustcOut;
try {
  rustcOut = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
} catch (e) {
  fail(`could not run \`rustc -vV\` (${e.message}). Is the Rust toolchain installed?`);
}
const hostLine = rustcOut.split("\n").find((l) => l.startsWith("host:"));
if (!hostLine) fail("`rustc -vV` output had no `host:` line — cannot determine target triple.");
const triple = hostLine.slice("host:".length).trim();
if (!triple) fail("empty target triple parsed from `rustc -vV`.");
console.log("[sidecar-build] host target triple:", triple);

// ---------------------------------------------------------------------------
// (c) Compile with `bun build --compile`.
// ---------------------------------------------------------------------------
const outDir = join(repoRoot, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `agent-driver-${triple}`);
const entry = join(repoRoot, "sidecar", "index.ts");

console.log("[sidecar-build] compiling:", entry, "->", outFile);
try {
  execFileSync("bun", ["build", "--compile", "--outfile", outFile, entry], {
    stdio: "inherit",
    cwd: repoRoot,
  });
} catch (e) {
  fail(
    `bun build --compile failed (${e.message}). Ensure \`bun\` is installed ` +
      "(https://bun.sh) — it is required to produce the single-binary sidecar.",
  );
}
if (!existsSync(outFile)) fail(`bun reported success but ${outFile} does not exist.`);

// ---------------------------------------------------------------------------
// (d) Post-build smoke check — boot the binary and confirm the embedded CLI
//     extracts to an existing, executable path. The sidecar prints nothing
//     until it gets a `start`, so we send `end` to make it boot + exit 0; a
//     non-zero exit or a missing/inexecutable extracted CLI fails the build.
//
//     We verify the executable bit on the platform package's bundled CLI here
//     (the same bytes the compiled binary embeds) as a fast, deterministic
//     proxy for "extractFromBunfs yields an executable path."
// ---------------------------------------------------------------------------
try {
  accessSync(platformBin, constants.X_OK);
} catch {
  fail(`embedded CLI ${platformBin} is not executable — extraction would yield a non-runnable path.`);
}
let bootStderr = "";
try {
  // Feed an immediate `end` so the binary boots, wires stdin, and exits 0.
  execFileSync(outFile, [], { input: '{"type":"end"}\n', timeout: 30_000 });
} catch (e) {
  fail(`compiled sidecar failed its boot smoke check (${e.message}).`);
}

// ---------------------------------------------------------------------------
// (e) Post-build USER-TURN smoke check — guards against the bundler-rename trap.
//
//     A pure `export { foo } from "./mod"` in index.ts does NOT create a local
//     binding `foo`; `tsc`/vitest accept a bare local `foo()` call, but
//     `bun build --compile` renames the re-exported symbol (e.g. `foo2`) and
//     leaves the local call to `foo` UNDEFINED → a `ReferenceError` thrown at
//     RUNTIME inside `liftUserMessage` on EVERY `case "user"` command, fired as
//     a `void handleCommand(line)` unhandled rejection so the user turn is never
//     sent. tsc/vitest cannot see it — only a real compiled-binary run does.
//
//     So drive a real `start` → `user` → `end` sequence through the compiled
//     binary and FAIL the build if stderr carries a `ReferenceError` / unhandled
//     rejection. A bogus OAuth token is injected so the SDK never reaches the
//     network; the lift (and thus the trap) executes BEFORE any auth, so this is
//     fast and deterministic regardless of credentials. We assert ONLY on the
//     defect signature, never on SDK/auth chatter (which is expected here).
// ---------------------------------------------------------------------------
const userTurnInput =
  '{"type":"start","cwd":"/tmp","permissionMode":"plan"}\n' +
  '{"type":"user","text":"smoke"}\n' +
  '{"type":"end"}\n';
// `spawnSync` (not `execFileSync`) so we capture stderr on BOTH a clean (exit 0)
// and an aborted (non-zero) run — `execFileSync` only surfaces stderr on throw.
const userTurn = spawnSync(outFile, [], {
  input: userTurnInput,
  timeout: 30_000,
  encoding: "utf8",
  env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "build-smoke-invalid" },
});
if (userTurn.error) {
  fail(`compiled sidecar could not be spawned for the user-turn smoke check (${userTurn.error.message}).`);
}
// A non-zero exit is acceptable here (the bogus token may abort the SDK session);
// the rename trap fires BEFORE auth, so we scan stderr+stdout for its signature.
bootStderr = (userTurn.stderr || "") + (userTurn.stdout || "");
if (/ReferenceError|is not defined|UnhandledPromiseRejection|unhandled rejection/i.test(bootStderr)) {
  fail(
    "compiled sidecar threw a ReferenceError / unhandled rejection while handling a " +
      "`user` turn — likely a pure `export { x } from \"./mod\"` in sidecar/index.ts " +
      "whose local `x()` call the bundler left undefined (rename trap). Use a value " +
      "`import { x } from \"./mod\"` for anything index.ts references locally, then " +
      `re-export it. Captured stderr:\n${bootStderr}`,
  );
}

console.log("[sidecar-build] user-turn smoke check passed (no ReferenceError on `user`).");
console.log(`[sidecar-build] OK — ${outFile}`);
