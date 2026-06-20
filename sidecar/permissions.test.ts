// Agent SDK sidecar — pure permission + status helper tests (falsifiable).
//
// These cover the load-bearing decisions of the canUseTool / resolve seam WITHOUT importing
// index.ts (top-level side effects). index.ts wires these exact helpers into the seam, so the
// behavior asserted here IS the behavior at the seam. The single gap — that index.ts actually
// returns allowResult(input) for non-ExitPlanMode tools synchronously, registers a pending entry
// + emits tool_permission_requested ONLY for ExitPlanMode, and echoes updatedInput on resolve — is
// covered by inspection (index.ts calls isReviewTool/allowResult/denyResult directly) and noted
// here: there is no end-to-end harness for the stdin/stdout JSON-lines loop.

import { describe, it, expect } from "vitest";
import {
  isReviewTool,
  INTERACTIVE_TOOLS,
  MUTATING_TOOLS,
  hostPolicyForMode,
  sdkPermissionMode,
  isPrototypeWritePath,
  PLAN_POLICY_WRITE_DENY,
  PROTOTYPE_POLICY_WRITE_DENY,
  allowResult,
  denyResult,
  resolveAllowInput,
  shouldDenyConcurrentInteractive,
  SEQUENTIAL_INTERACTIVE_DENY,
  BASH_WRITE_DENY_PATTERNS,
  isWriteShapedBashCommand,
  bashDecisionFor,
  createInteractivePermissionGate,
  prototypeHookDecision,
  createPrototypePreToolUseHook,
  statusLabelFor,
  StatusThrottle,
} from "./permissions";

describe("sidecar permissions — allow result ALWAYS carries updatedInput (the ZodError fix)", () => {
  it("allowResult echoes the tool input as updatedInput", () => {
    const input = { file_path: "/x", content: "hi" };
    const r = allowResult(input);
    // FALSIFY: return a bare { behavior: "allow" } (omit updatedInput) → these two assertions go RED.
    expect(r).toEqual({ behavior: "allow", updatedInput: input });
    expect((r as { updatedInput?: unknown }).updatedInput).toBe(input);
  });

  it("denyResult carries the feedback message", () => {
    expect(denyResult("nope")).toEqual({ behavior: "deny", message: "nope" });
  });
});

describe("sidecar permissions — the INTERACTIVE tools (ExitPlanMode + AskUserQuestion) are held", () => {
  it("ExitPlanMode and AskUserQuestion are interactive; every other tool is auto-allowed", () => {
    // FALSIFY: make isReviewTool always-true (round-trip everything) → the non-interactive cases
    // below flip to true → RED. Make it always-false → the interactive cases flip to false → RED.
    expect(isReviewTool("ExitPlanMode")).toBe(true);
    expect(isReviewTool("AskUserQuestion")).toBe(true);
    expect(isReviewTool("Bash")).toBe(false);
    expect(isReviewTool("Read")).toBe(false);
    expect(isReviewTool("Task")).toBe(false);
  });

  it("AskUserQuestion is in the INTERACTIVE_TOOLS set", () => {
    // FALSIFY: drop "AskUserQuestion" from INTERACTIVE_TOOLS → this assertion (and the one above)
    // go RED, proving AskUserQuestion would no longer be held / would be auto-allowed.
    expect(INTERACTIVE_TOOLS.has("AskUserQuestion")).toBe(true);
    expect(INTERACTIVE_TOOLS.has("ExitPlanMode")).toBe(true);
    expect(INTERACTIVE_TOOLS.has("Bash")).toBe(false);
  });
});

describe("sidecar resolve — allow honors a provided updatedInput, else echoes stored input", () => {
  const stored = { plan: "the plan" };
  const provided = { questions: [{ question: "Q?" }], answers: { "Q?": "A" } };

  it("uses the provided updatedInput when it is an object (AskUserQuestion answers path)", () => {
    // FALSIFY: make resolveAllowInput always return `stored` → this returns the plan, not the
    // answers → RED. Then allowResult wraps it, so the SDK would never receive the answers.
    const chosen = resolveAllowInput(provided, stored);
    expect(chosen).toBe(provided);
    expect(allowResult(chosen)).toEqual({ behavior: "allow", updatedInput: provided });
  });

  it("falls back to the stored input when no updatedInput is provided (ExitPlanMode path)", () => {
    // FALSIFY: make resolveAllowInput always return `provided` (or always {}) → these go RED.
    expect(resolveAllowInput(undefined, stored)).toBe(stored);
    expect(resolveAllowInput(null, stored)).toBe(stored);
    // A non-object provided value (e.g. a string) is NOT a valid updatedInput → fall back.
    expect(resolveAllowInput("nope", stored)).toBe(stored);
    expect(allowResult(resolveAllowInput(undefined, stored))).toEqual({
      behavior: "allow",
      updatedInput: stored,
    });
  });
});

describe("sidecar permissions — interactive holds are SERIALIZED (at most one live)", () => {
  // A controllable AbortSignal-like options factory. Each request gets a distinct toolUseID.
  function opts(id: string): { signal: AbortSignal; toolUseID: string; agentID?: string } {
    return { signal: new AbortController().signal, toolUseID: id, agentID: "agent-1" };
  }

  it("shouldDenyConcurrentInteractive: interactive+busy → true; interactive+free / non-interactive → false", () => {
    // FALSIFY: drop the `&& hasLiveInteractiveHold` term → the free case (line 2) flips to true → RED.
    //          drop the `isReviewTool(...)` term → the non-interactive busy case (line 4) flips to true → RED.
    expect(shouldDenyConcurrentInteractive("ExitPlanMode", true)).toBe(true);
    expect(shouldDenyConcurrentInteractive("ExitPlanMode", false)).toBe(false);
    expect(shouldDenyConcurrentInteractive("AskUserQuestion", true)).toBe(true);
    expect(shouldDenyConcurrentInteractive("Bash", true)).toBe(false);
  });

  it("a SINGLE interactive request holds: emits tool_permission_requested, registers a pending hold, awaits", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const gate = createInteractivePermissionGate((f) => emitted.push(f), () => "plan");

    let settled = false;
    const p = gate.canUseTool("ExitPlanMode", { plan: "P" }, opts("t1"));
    void p.then(() => {
      settled = true;
    });

    // FALSIFY: if canUseTool auto-allowed interactive tools, pendingCount would be 0 and no emit → RED.
    expect(gate.pendingCount()).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "tool_permission_requested", id: "t1", tool: "ExitPlanMode" });
    // Still awaiting — no resolution yet.
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("a SECOND interactive request while the first is unresolved is DENIED immediately and NOT registered", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const gate = createInteractivePermissionGate((f) => emitted.push(f), () => "plan");

    // First holds.
    void gate.canUseTool("ExitPlanMode", { plan: "P" }, opts("t1"));
    expect(gate.pendingCount()).toBe(1);

    // Second (a DIFFERENT interactive tool) arrives while the first is live.
    const second = await gate.canUseTool("AskUserQuestion", { questions: [] }, opts("t2"));

    // FALSIFY: remove the serialization guard in the gate → the second would register (pendingCount 2)
    // and AWAIT instead of resolving to a deny → both assertions below go RED.
    expect(second).toEqual({ behavior: "deny", message: SEQUENTIAL_INTERACTIVE_DENY });
    expect(gate.pendingCount()).toBe(1); // still only the FIRST hold; the second was not added
    // Only the first request emitted a tool_permission_requested; the denied second did not.
    expect(emitted.filter((f) => f.kind === "tool_permission_requested")).toHaveLength(1);
  });

  it("after the first hold RESOLVES, a new interactive request can hold again", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const gate = createInteractivePermissionGate((f) => emitted.push(f), () => "plan");

    const first = gate.canUseTool("ExitPlanMode", { plan: "P" }, opts("t1"));
    expect(gate.pendingCount()).toBe(1);

    // Resolve the first (allow). Slot frees.
    expect(gate.resolve("t1", allowResult({ plan: "P" }))).toBe(true);
    expect(await first).toEqual({ behavior: "allow", updatedInput: { plan: "P" } });
    expect(gate.pendingCount()).toBe(0);

    // A new interactive request now holds (slot is free again).
    void gate.canUseTool("AskUserQuestion", { questions: [] }, opts("t2"));
    // FALSIFY: if the slot never freed on resolve, this would be denied → pendingCount stays 0 → RED.
    expect(gate.pendingCount()).toBe(1);
    expect(emitted.filter((f) => f.kind === "tool_permission_requested")).toHaveLength(2);
  });

  it("after the first hold ABORTS (interrupt), the slot frees so the next interactive request can hold", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const gate = createInteractivePermissionGate((f) => emitted.push(f), () => "plan");

    const ctrl = new AbortController();
    const first = gate.canUseTool("ExitPlanMode", { plan: "P" }, {
      signal: ctrl.signal,
      toolUseID: "t1",
    });
    expect(gate.pendingCount()).toBe(1);

    // Abort (interrupt) — frees the slot, settles with deny("interrupted").
    ctrl.abort();
    expect(await first).toEqual({ behavior: "deny", message: "interrupted" });
    expect(gate.pendingCount()).toBe(0);

    // Next interactive request holds again.
    void gate.canUseTool("AskUserQuestion", { questions: [] }, opts("t2"));
    expect(gate.pendingCount()).toBe(1);
  });

  it("non-interactive tools AUTO-ALLOW regardless of a live interactive hold (never serialized)", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const gate = createInteractivePermissionGate((f) => emitted.push(f), () => "plan");

    // Hold an interactive request.
    void gate.canUseTool("ExitPlanMode", { plan: "P" }, opts("t1"));
    expect(gate.pendingCount()).toBe(1);

    // A non-interactive tool arrives DURING the live hold — must auto-allow, not deny, not hold.
    const bash = await gate.canUseTool("Bash", { command: "ls" }, opts("t2"));
    // FALSIFY: if the serialization guard ran for non-interactive tools, this would be a deny → RED.
    expect(bash).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(gate.pendingCount()).toBe(1); // unchanged — Bash did not register a hold
    // Bash emitted no tool_permission_requested (auto-allowed in-process).
    expect(emitted.filter((f) => f.kind === "tool_permission_requested")).toHaveLength(1);
  });
});

describe("sidecar permissions — host-asserted policy backstop (mutating tools denied under 'plan')", () => {
  // The incident this guards: the SDK silently flips itself out of plan mode when an
  // ExitPlanMode approval resolves, and the gate auto-allows every non-interactive tool —
  // so Write/Edit sailed through during planning phases. The HOST is the authority on the
  // phase; the gate consults the injected hostPolicy getter as a backstop.
  function opts(id: string): { signal: AbortSignal; toolUseID: string } {
    return { signal: new AbortController().signal, toolUseID: id };
  }

  it("Write/Edit/MultiEdit/NotebookEdit are DENIED when the host policy is 'plan'", async () => {
    const gate = createInteractivePermissionGate(() => {}, () => "plan");
    // FALSIFY: remove the MUTATING_TOOLS && "plan" check in canUseTool → these resolve to
    // allow (the auto-allow path) → every assertion below goes RED.
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const r = await gate.canUseTool(tool, { file_path: "/x" }, opts(`m-${tool}`));
      expect(r).toEqual({ behavior: "deny", message: PLAN_POLICY_WRITE_DENY });
    }
    // Denies are in-process: no hold registered.
    expect(gate.pendingCount()).toBe(0);
  });

  it("the same mutating tools are AUTO-ALLOWED when the host policy is 'acceptEdits'", async () => {
    const gate = createInteractivePermissionGate(() => {}, () => "acceptEdits");
    // FALSIFY: invert the policy comparison (deny under "acceptEdits") → these flip to deny → RED.
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const input = { file_path: "/x" };
      const r = await gate.canUseTool(tool, input, opts(`m-${tool}`));
      expect(r).toEqual({ behavior: "allow", updatedInput: input });
    }
  });

  it("the getter is consulted PER CALL (a live policy flip changes the verdict, no new gate needed)", async () => {
    let policy: "plan" | "acceptEdits" = "plan";
    const gate = createInteractivePermissionGate(() => {}, () => policy);
    // FALSIFY: capture the policy ONCE at gate construction instead of calling the getter per
    // request → the second verdict stays a deny → RED.
    expect((await gate.canUseTool("Write", { file_path: "/x" }, opts("w1"))).behavior).toBe("deny");
    policy = "acceptEdits";
    expect((await gate.canUseTool("Write", { file_path: "/x" }, opts("w2"))).behavior).toBe("allow");
  });

  it("Task/Read/Grep/Glob/Bash stay AUTO-ALLOWED under 'plan' (planning subagents need them)", async () => {
    const gate = createInteractivePermissionGate(() => {}, () => "plan");
    // FALSIFY: widen MUTATING_TOOLS to include any of these (or deny ALL tools under "plan")
    // → the corresponding assertion goes RED.
    for (const tool of ["Task", "Read", "Grep", "Glob", "Bash"]) {
      const input = { arg: tool };
      const r = await gate.canUseTool(tool, input, opts(`r-${tool}`));
      expect(r).toEqual({ behavior: "allow", updatedInput: input });
    }
  });

  it("MUTATING_TOOLS is exactly the closed four-member set", () => {
    // FALSIFY: add/remove a member → the size or membership assertions go RED.
    expect(MUTATING_TOOLS.size).toBe(4);
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(MUTATING_TOOLS.has(tool)).toBe(true);
    }
    expect(MUTATING_TOOLS.has("Bash")).toBe(false);
    expect(MUTATING_TOOLS.has("Task")).toBe(false);
  });

  it("interactive holds are unaffected by the 'plan' policy (ExitPlanMode still holds, not denied)", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const gate = createInteractivePermissionGate((f) => emitted.push(f), () => "plan");
    // FALSIFY: run the policy check against ALL tools instead of MUTATING_TOOLS only →
    // ExitPlanMode would deny in-process (pendingCount 0, no emit) → RED.
    void gate.canUseTool("ExitPlanMode", { plan: "P" }, opts("t1"));
    expect(gate.pendingCount()).toBe(1);
    expect(emitted.filter((f) => f.kind === "tool_permission_requested")).toHaveLength(1);
  });
});

describe("sidecar permissions — Bash write-deny backstop under 'plan' (best-effort, not a sandbox)", () => {
  // The accepted finding this closes: under the "plan" policy the gate denied Write/Edit/… but
  // auto-allowed Bash unconditionally, so `bash -c "echo x > file"` (or rm/mv/sed -i/git checkout)
  // sailed through the planning phases. The fix is a PATTERN backstop on the raw command string —
  // deliberately best-effort (interpreters like `python -c` / `node -e` can still write; the
  // interrupt-bounded window + SDK plan mode are the primary mitigations).
  function opts(id: string): { signal: AbortSignal; toolUseID: string } {
    return { signal: new AbortController().signal, toolUseID: id };
  }

  it("isWriteShapedBashCommand flags redirections and the known write-shaped commands", () => {
    // FALSIFY: drop any pattern from BASH_WRITE_DENY_PATTERNS (or make the helper always-false)
    // → the corresponding line below flips to false → RED.
    const denied = [
      "echo hi > out.txt",
      "echo hi >> log.txt",
      "cat a.txt | tee out.txt",
      "sed -i 's/a/b/' file.txt",
      "rm -rf build",
      "mv a.txt b.txt",
      "cp a.txt b.txt",
      "mkdir -p newdir",
      "touch marker",
      "truncate -s 0 file.txt",
      "dd if=/dev/zero of=blob bs=1m count=1",
      "git apply fix.patch",
      "git checkout -- src",
      "git restore .",
      "git clean -fd",
      "git reset --hard HEAD",
      "chmod +x run.sh",
      "ln -s target link",
    ];
    for (const command of denied) {
      expect(isWriteShapedBashCommand(command), command).toBe(true);
    }
  });

  it("read-shaped commands stay UNFLAGGED (grep/find/ls/cat/cargo test/npm test keep working)", () => {
    // FALSIFY: over-widen a pattern (e.g. flag all `git …` or any `>` including `2>&1`-free text)
    // → one of these flips to true → RED.
    const allowed = [
      "grep -rn pattern src",
      'find . -name "*.ts"',
      "ls -la src",
      "cat README.md",
      "cargo test --lib",
      "npm test",
      "git status",
      "git log --oneline -5",
      "git diff",
      "head -n 20 file.txt",
    ];
    for (const command of allowed) {
      expect(isWriteShapedBashCommand(command), command).toBe(false);
    }
  });

  it("BASH_WRITE_DENY_PATTERNS is exported as data (testable set, non-empty regexes)", () => {
    // FALSIFY: inline the patterns into the gate (drop the export) → import fails → RED.
    expect(BASH_WRITE_DENY_PATTERNS.length).toBeGreaterThan(0);
    for (const p of BASH_WRITE_DENY_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });

  it("the gate DENIES a write-shaped Bash command under 'plan' with the planning-phase message", async () => {
    const gate = createInteractivePermissionGate(() => {}, () => "plan");
    // FALSIFY: remove the Bash branch in canUseTool → this resolves to allow (auto-allow path) → RED.
    const r = await gate.canUseTool("Bash", { command: "rm -rf build" }, opts("b1"));
    expect(r).toEqual({ behavior: "deny", message: PLAN_POLICY_WRITE_DENY });
    expect(gate.pendingCount()).toBe(0); // in-process deny, no hold
  });

  it("the gate ALLOWS read-shaped Bash under 'plan' and write-shaped Bash under 'acceptEdits'", async () => {
    const planGate = createInteractivePermissionGate(() => {}, () => "plan");
    const readInput = { command: "cargo test --lib" };
    // FALSIFY: deny ALL Bash under "plan" → this flips to deny → RED.
    expect(await planGate.canUseTool("Bash", readInput, opts("b2"))).toEqual({
      behavior: "allow",
      updatedInput: readInput,
    });

    const editsGate = createInteractivePermissionGate(() => {}, () => "acceptEdits");
    const writeInput = { command: "rm -rf build" };
    // FALSIFY: run the Bash backstop regardless of policy → this flips to deny → RED.
    expect(await editsGate.canUseTool("Bash", writeInput, opts("b3"))).toEqual({
      behavior: "allow",
      updatedInput: writeInput,
    });
  });

  it("a Bash input with no string command is auto-allowed (the backstop never throws on shape)", async () => {
    const gate = createInteractivePermissionGate(() => {}, () => "plan");
    const input = { notACommand: 42 };
    expect(await gate.canUseTool("Bash", input, opts("b4"))).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });
});

// ---------------------------------------------------------------------------
// INV-1 — Prototype Bash containment is FAIL-CLOSED (S1+S2).
//
// The accepted High findings: under the "prototype" policy the old BLOCKLIST let the
// no-space/clobber redirects (`echo x>/f`, `cat a>>b`, `>|f`) and the interpreters
// (`python3 -c`, `node -e`, `tar -x`, `install`, …) slip through to write the tree.
// The fix replaces the prototype blocklist with a FAIL-CLOSED ALLOWLIST in one shared
// `bashDecisionFor(policy, command)` helper that BOTH the hook tier and the canUseTool
// gate call (so they cannot drift). Under "plan" the documented test-run capability
// (`cargo test`/`npm test`/`npx vitest`) is PRESERVED, but the same named write escapes
// are additionally denied.
// ---------------------------------------------------------------------------
describe("sidecar permissions — bashDecisionFor under 'prototype' is fail-closed (INV-1)", () => {
  // null = allow (provably read-only); a string = the deny reason.
  it("prototype_bash_fail_closed_denies_escapes: redirects/interpreters/git stash/find -delete/subshell/env-prefix are DENIED", () => {
    // FALSIFY: keep the old blocklist (deny-only on known-write patterns) → the no-space
    // redirects, interpreters, tar/install, find -delete, env-prefix all return null (allow) → RED.
    const denied = [
      "echo x>/p", // no-space output redirect
      "cat a>>b", // no-space append redirect
      ">|f", // clobber redirect, leading
      'python3 -c "open(\'/tmp/x\',\'w\')"',
      'node -e "require(\'fs\').writeFileSync(\'/tmp/x\',\'\')"',
      "tar -xf a.tar", // archive extraction writes files
      "install x y", // install copies/creates files
      'ls && python3 -c "open(\'/tmp/x\',\'w\')"', // a read verb chained with an interpreter
      "git stash", // mutates the working tree
      "find . -delete", // find with a write action
      "find . -exec rm {} +", // find with -exec
      "FOO=bar sh -c 'echo pwned > /tmp/x'", // env-assignment prefix + shell -c
      "echo $(rm -rf /)", // command substitution is never provably read-only
      "cat `whoami`", // backtick substitution
      "rm -rf build", // a plainly-write verb (unrecognized → fail closed)
      "perl -e 'unlink \"x\"'",
      "osascript -e 'do shell script \"rm x\"'",
      "tee out.txt", // file-write tool
      "ln -s a b", // symlink creation
      "cp a b", // copy
      "mv a b", // move
      "dd if=/dev/zero of=blob", // raw write
      "truncate -s 0 f", // truncation
      "unzip a.zip", // archive extraction
      "patch < d.diff", // applies a patch (writes)
    ];
    for (const command of denied) {
      // A deny is a non-null reason string.
      expect(bashDecisionFor("prototype", command), command).not.toBeNull();
    }
  });

  it("prototype_bash_allowlist_permits_read_only: read-only verbs + read-only git/find PASS (null)", () => {
    // FALSIFY: fail-close the whole allowlist (deny everything) → these flip to a reason → RED.
    const allowed = [
      "ls",
      "ls -la src",
      "cat foo",
      "head -n 20 file.txt",
      "tail -f log",
      "grep x f",
      "grep -rn pattern src",
      "rg x",
      "pwd",
      "wc -l f",
      "which node",
      "file f",
      "stat f",
      "echo hello", // echo with NO redirect is read-only
      "git status",
      "git log --oneline -5",
      "git diff",
      "git show HEAD",
      "git branch --list",
      "find . -name '*.md'", // find with no -exec/-delete is read-only
      "ls && grep x f", // both segments read-only
      "cat a | grep b", // pipe of read-only verbs
    ];
    for (const command of allowed) {
      expect(bashDecisionFor("prototype", command), command).toBeNull();
    }
  });

  it("prototype_bash_separator_escapes_denied: bare &, newline, process-substitution, grouping (F1/S1)", () => {
    // The confirmed HIGH (F1/S1): the segment splitter MISSED separators, so an allowlisted leading
    // verb (`ls`) could carry a chained write through a separator the splitter didn't recognize —
    // bare `&` (background), a literal newline, process-substitution `<(…)`/`>(…)`, and `|&`. Each of
    // these WRONGLY returned ALLOW (the write segment was never split out / was hidden inside a
    // substitution that read as part of a read-only verb's args).
    // FALSIFY: revert the splitter to /\|\||&&|;|\|/ (no `&`/`\n`/`\r`) and drop the `<(`/`>(`
    // process-sub rejection → every row below returns null (allow) → RED.
    const denied = [
      "ls & rm -rf build", // bare & (background) chains a write
      "ls\ntouch x", // literal newline separator
      "ls\r\ntouch x", // CRLF newline separator
      "cat <(touch x)", // process substitution — inner command is unconstrained (a write)
      "echo x >(tee f)", // output process substitution
      "ls & FOO=bar sh -c 'x'", // background + env-prefixed interpreter
      "ls |& rm f", // |& (pipe stdout+stderr) — the leading `|` splits, leaving `& rm f`
      "ls; (touch x)", // a subshell group is not a recognized read-only verb
      "{ touch x; }", // a brace group is not a recognized read-only verb
      "ls && (touch x)", // grouped write after a read-only verb
    ];
    for (const command of denied) {
      expect(bashDecisionFor("prototype", command), command).not.toBeNull();
    }
  });

  it("prototype: a trailing background `&` leaves an empty segment that fails CLOSED", () => {
    // `cmd &` splits into ["cmd", ""] once `&` is a separator; the trailing empty segment must hit
    // the existing empty-segment→deny rule rather than being silently dropped/allowed.
    // FALSIFY: if an empty segment ALLOWED, `ls &` (a bare background read) would pass — but a
    // background `&` is never provably read-only here (it forks), so it must DENY.
    expect(bashDecisionFor("prototype", "ls &"), "ls &").not.toBeNull();
  });

  it("prototype: a non-string command fails CLOSED (deny), never throws on shape", () => {
    // Malformed tool input under the fail-closed prototype policy must DENY (not allow, not throw).
    expect(bashDecisionFor("prototype", undefined)).not.toBeNull();
    expect(bashDecisionFor("prototype", 42)).not.toBeNull();
    expect(bashDecisionFor("prototype", null)).not.toBeNull();
    expect(bashDecisionFor("prototype", "")).not.toBeNull();
  });

  it("prototype: git is read-only ONLY for the safe subcommand set with no -C/-c/--git-dir global flag", () => {
    // Read-only git subcommands pass.
    expect(bashDecisionFor("prototype", "git status")).toBeNull();
    expect(bashDecisionFor("prototype", "git log")).toBeNull();
    expect(bashDecisionFor("prototype", "git diff --stat")).toBeNull();
    // Write-shaped git subcommands are denied.
    expect(bashDecisionFor("prototype", "git commit -m x")).not.toBeNull();
    expect(bashDecisionFor("prototype", "git checkout -- .")).not.toBeNull();
    expect(bashDecisionFor("prototype", "git stash")).not.toBeNull();
    expect(bashDecisionFor("prototype", "git apply p.diff")).not.toBeNull();
    // A global flag that can redirect the repo / run config-injected commands is denied even
    // with a read-only subcommand (`-c core.pager=…`, `-C dir`, `--git-dir`).
    expect(bashDecisionFor("prototype", "git -C /other status")).not.toBeNull();
    expect(bashDecisionFor("prototype", "git -c core.pager=touch log")).not.toBeNull();
    expect(bashDecisionFor("prototype", "git --git-dir=/x status")).not.toBeNull();
  });

  it("prototype: find is read-only ONLY without a write action token", () => {
    expect(bashDecisionFor("prototype", "find . -name '*.ts'")).toBeNull();
    expect(bashDecisionFor("prototype", "find src -type f")).toBeNull();
    // The COMPLETE findutils exec family (-exec/-execdir/-ok/-okdir), -delete, and the -f*
    // file-write family must ALL deny. -okdir is the interactive twin of -execdir (runs an
    // arbitrary command in the matched file's dir) — same write/exec class as the rest.
    for (const action of [
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-delete",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
    ]) {
      expect(bashDecisionFor("prototype", `find . ${action} foo`), action).not.toBeNull();
    }
  });

  it("prototype: find -okdir (interactive twin of -execdir) is DENIED (uncovered exec primary)", () => {
    // -okdir runs an arbitrary command in the matched file's directory — same escape class as
    // -exec/-execdir/-ok. It was the only findutils exec/write primary still omitted from
    // FIND_WRITE_ACTIONS after the -f* fix.
    // FALSIFY: drop "-okdir" from FIND_WRITE_ACTIONS → these return null (allow) → RED.
    const denied = [
      "find . -okdir cat {} ;",
      "find /etc -okdir cat {} +",
      "find . -name '*.ts' -okdir rm {} ;",
    ];
    for (const command of denied) {
      expect(bashDecisionFor("prototype", command), command).not.toBeNull();
    }
  });

  it("prototype: find -fls/-fprintf/-fprint0 (file-write actions) are DENIED (Medium escape)", () => {
    // The confirmed Medium escape: FIND_WRITE_ACTIONS omitted the -f* file-write actions
    // (`-fls FILE`, `-fprintf FILE FORMAT`, `-fprint0 FILE`), so `find . -fls out.txt` wrote
    // an arbitrary file yet returned ALLOW under the fail-closed prototype allowlist — defeating
    // INV-1 containment (writes confined to <cwd>/.plan-tree/prototype/) with no Write/Edit.
    // FALSIFY: revert FIND_WRITE_ACTIONS to {-exec,-execdir,-delete,-ok,-fprint} → these
    // file-writing find forms return null (allow) → every assertion below goes RED.
    const denied = [
      "find . -fls out.txt",
      "find . -fprintf out.txt %p",
      "find . -fprint0 out.txt",
      "find / -maxdepth 0 -fls /tmp/x",
      // an absolute-path write to a sensitive file is the concrete attack
      "find . -maxdepth 0 -fprintf /Users/alice/.claude/settings.json {}",
    ];
    for (const command of denied) {
      expect(bashDecisionFor("prototype", command), command).not.toBeNull();
    }
  });

  it("prototype: read-only -f* find primaries (-fstype/-follow) and -printf still ALLOW (no over-denial)", () => {
    // The fix must DENY the -f* WRITE actions without regressing the read-only -f* primaries:
    // `-fstype TYPE` is a filesystem-type TEST (filter), `-follow` is a symlink-follow option, and
    // `-printf FORMAT` prints to STDOUT (not a file — a stdout redirect would be caught by
    // OUTPUT_REDIRECT separately). None of these write a file by themselves.
    // FALSIFY: blanket-deny any `-f*` token → `-fstype`/`-follow` flip to a deny reason → RED.
    expect(bashDecisionFor("prototype", "find . -fstype apfs -name x"), "-fstype").toBeNull();
    expect(bashDecisionFor("prototype", "find . -follow -name x"), "-follow").toBeNull();
    expect(bashDecisionFor("prototype", "find . -printf %p"), "-printf").toBeNull();
  });

  it("prototype: echo is read-only ONLY without a redirect (a redirect makes it write-shaped)", () => {
    expect(bashDecisionFor("prototype", "echo hello")).toBeNull();
    expect(bashDecisionFor("prototype", "echo x > f")).not.toBeNull();
    expect(bashDecisionFor("prototype", "echo x>f")).not.toBeNull();
    expect(bashDecisionFor("prototype", "echo x >> f")).not.toBeNull();
  });

  it("prototype: an fd-to-FILE redirect is a WRITE (DENY); only an fd-DUP/close is a non-write (ALLOW)", () => {
    // The DA-found escape: a numbered/`&`-form fd redirect to a FILE writes arbitrary paths.
    // FALSIFY: exclude any `[0-9]`/`&` before `>` from the write detector → these PASS (verb
    // `echo`/`cat` recognized, redirect undetected) → RED, the escape is open.
    const fdWritesDenied = [
      "echo x 1>/tmp/evil", // numbered fd to file
      "echo x 2>out",
      "cat foo 1>out",
      "echo x &>file", // both stdout+stderr to file
      "echo x >&file", // `>&word` where word is a FILE (not a digit) is a file write
      "echo x 2>>out", // append numbered fd to file
      "echo x &>>file", // append both to file
    ];
    for (const command of fdWritesDenied) {
      expect(bashDecisionFor("prototype", command), command).not.toBeNull();
    }
    // fd-DUP/close to an EXISTING fd is NOT a file write — a read-only verb keeps it allowed.
    const dupAllowed = ["ls 2>&1", "grep x f 2>&1", "cat foo >&2"];
    for (const command of dupAllowed) {
      expect(bashDecisionFor("prototype", command), command).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// BUG FIXES — /dev/null discard is NOT a write (BUG 1) + `cd` is read-only (BUG 2).
//
// BUG 1: a redirect whose TARGET is the bit-bucket `/dev/null` is a DISCARD, not a tree write
//   (`rg … 2>/dev/null`, `cmd >/dev/null`, `&>/dev/null`). The old OUTPUT_REDIRECT regex matched
//   it and denied the (read-only) command. The fix excludes a `/dev/null` target. A REAL file
//   target (`> out.txt`, `2> err.log`, `>> log`) still matches and stays DENIED.
// BUG 2: `cd <dir> && rg …` was denied under PROTOTYPE because `cd` was absent from the read-only
//   verb set; the per-segment write check still runs, so adding `cd` opens no write hole.
// ---------------------------------------------------------------------------
describe("sidecar permissions — /dev/null discard is NOT a write (BUG 1)", () => {
  it("isWriteShapedBashCommand: a /dev/null target is a DISCARD, not a write (plan ALLOWS)", () => {
    // FALSIFY: revert OUTPUT_REDIRECT to `/(?:[0-9]*|&)>{1,2}\|?(?!&[0-9-])/` → the `/dev/null`
    // target matches the redirect → these flip to true → RED.
    const discardAllowed = [
      "rg -l '\"type\":\"image\"' ~/x --glob '*.jsonl' 2>/dev/null | head",
      "rg --files 2> /dev/null",
      "cmd >/dev/null",
      "ls &>/dev/null",
      "rg foo 1>/dev/null",
      "rg foo 2>/dev/null",
    ];
    for (const command of discardAllowed) {
      expect(isWriteShapedBashCommand(command), command).toBe(false);
      expect(bashDecisionFor("plan", command), command).toBeNull();
    }
  });

  it("isWriteShapedBashCommand: a REAL file target stays a WRITE (plan DENIES)", () => {
    // FALSIFY: over-widen the /dev/null exclusion to any target → these flip to false → RED.
    const writesDenied = [
      "echo hi > out.txt",
      "rg foo 2> err.log",
      "echo x >> log",
      "echo x > /dev/nullish", // a path that merely PREFIXES /dev/null is still a real file
      "echo x > /dev/null.bak",
    ];
    for (const command of writesDenied) {
      expect(isWriteShapedBashCommand(command), command).toBe(true);
      expect(bashDecisionFor("plan", command), command).not.toBeNull();
    }
  });

  it("prototype: a /dev/null discard on a read-only verb is ALLOWED; a real file target DENIED", () => {
    // FALSIFY: revert the OUTPUT_REDIRECT fix → isReadOnlyPrototypeSegment rejects the segment on
    // the redirect → these flip to a deny reason → RED.
    expect(bashDecisionFor("prototype", "rg --files 2>/dev/null"), "rg 2>/dev/null").toBeNull();
    expect(bashDecisionFor("prototype", "rg foo ~/x 2>/dev/null | head"), "pipe").toBeNull();
    expect(bashDecisionFor("prototype", "cat f >/dev/null"), "cat >/dev/null").toBeNull();
    // a real file target stays write-shaped → DENY under the fail-closed allowlist.
    expect(bashDecisionFor("prototype", "rg foo 2> err.log"), "2> err.log").not.toBeNull();
    expect(bashDecisionFor("prototype", "echo hi > out.txt"), "> out.txt").not.toBeNull();
  });

  it("isWriteShapedBashCommand: an APPEND (`>>`) discard to /dev/null is a DISCARD, not a write (plan ALLOWS)", () => {
    // FALSIFY: revert the OUTPUT_REDIRECT append broadening (drop the `>?` that lets the /dev/null
    // lookahead span `>>`) → the second `>` makes the lookahead miss → these flip to true → RED.
    const appendDiscardAllowed = [
      "rg foo 2>>/dev/null",
      "cmd &>>/dev/null",
      "cmd >>/dev/null",
      "rg foo 1>>/dev/null",
      "rg --files 2>> /dev/null",
    ];
    for (const command of appendDiscardAllowed) {
      expect(isWriteShapedBashCommand(command), command).toBe(false);
      expect(bashDecisionFor("plan", command), command).toBeNull();
    }
  });

  it("isWriteShapedBashCommand: an APPEND to a REAL file (or a discard MIXED with a real redirect) stays a WRITE (plan DENIES)", () => {
    // FALSIFY: over-widen the append exclusion so it matches any `>>` target, or so a /dev/null
    // discard suppresses a sibling real redirect → these flip to false → RED, a write bypass opens.
    const writesDenied = [
      "echo x >> log", // append-to-FILE is a write
      "cmd 2>>/dev/null > out.txt", // the real `> out.txt` is a write even alongside a discard
      "echo x >>/dev/null.bak", // a path that merely PREFIXES /dev/null is a real file
      "echo x >>/dev/nullish",
    ];
    for (const command of writesDenied) {
      expect(isWriteShapedBashCommand(command), command).toBe(true);
      expect(bashDecisionFor("plan", command), command).not.toBeNull();
    }
  });
});

describe("sidecar permissions — `cd` is a read-only prototype verb (BUG 2)", () => {
  it("prototype: `cd <dir> && rg …` is ALLOWED (cd is read-only, every segment provably read-only)", () => {
    // FALSIFY: remove "cd" from PROTOTYPE_READONLY_VERBS → the `cd ~/x` segment is unrecognized →
    // fails closed → these flip to a deny reason → RED.
    expect(bashDecisionFor("prototype", "cd ~/x && rg foo"), "cd && rg").toBeNull();
    expect(bashDecisionFor("prototype", "cd src && ls"), "cd && ls").toBeNull();
    expect(bashDecisionFor("prototype", "cd /tmp"), "bare cd").toBeNull();
  });

  it("prototype: `cd` does NOT open a write hole — a write segment after `cd` still DENIES", () => {
    // FALSIFY: short-circuit the per-segment check when the leading verb is `cd` → these flip to
    // null (allow) → RED, the hole is open.
    expect(bashDecisionFor("prototype", "cd /x > out.txt"), "cd > file").not.toBeNull();
    expect(bashDecisionFor("prototype", "cd /x; touch f"), "cd; touch").not.toBeNull();
    expect(bashDecisionFor("prototype", "cd /x && rm -rf y"), "cd && rm").not.toBeNull();
  });
});

describe("sidecar permissions — bashDecisionFor under 'plan' preserves test runs (INV-1)", () => {
  it("plan_bash_preserves_test_runs: cargo/npm/npx test runs REMAIN ALLOWED (regression guard)", () => {
    // FALSIFY: apply the prototype fail-closed allowlist to "plan" → cargo/npm/npx all DENY → RED.
    const allowed = [
      "cargo test --lib",
      "cargo test",
      "npm test",
      "npx vitest run sidecar/permissions.test.ts",
      "npx tsc --noEmit",
      "grep -rn pattern src",
      "find . -name '*.ts'",
      // read-only find primaries that must NOT be caught by the -f*/-okdir write-action fixes
      "find . -fstype apfs -name x", // -fstype is a TEST (filter), not a write
      "find . -follow -name x", // -follow is a symlink option, not a write
      "find . -printf %p", // -printf prints to STDOUT (not a file)
      "find . -print", // -print is a STDOUT action, not a write
      "find . -print0", // -print0 is a STDOUT action, not a write
      "find . -ls", // -ls is a STDOUT list action — must NOT be matched by `ok(dir)?`/-f* fixes
      "ls -la src",
      "cat README.md",
      "git status",
      "git log --oneline -5",
      "git diff",
      "head -n 20 file.txt",
      "ls 2>&1", // fd-DUP (stderr→stdout), not a file write → stays allowed under plan
    ];
    for (const command of allowed) {
      expect(bashDecisionFor("plan", command), command).toBeNull();
    }
  });

  it("plan: the named write escapes are DENIED (interpreters, redirects, file-write tools)", () => {
    // FALSIFY: leave the plan blocklist un-extended → the no-space redirect / `>|` / interpreters /
    // tar -x / install / find -delete return null (allow) → RED.
    const denied = [
      // redirect holes the finding identified
      "echo x>/p", // no-space output redirect (whitespace-insensitive)
      "cat a>>b", // no-space append redirect
      ">|f", // clobber redirect
      "echo hi > out.txt", // the original space-separated form still denied
      // fd-to-FILE redirects (the DA-found escape) — these WRITE files, not dup fds.
      "echo x 1>out",
      "echo x 2>out",
      "echo x &>out",
      "echo x >&out", // `>&word` where word is a file (not a digit) is a file write
      // xargs + interpreter here-string/heredoc feeds (low-stakes, flagged)
      "echo f | xargs rm",
      "python3 - <<< 'open(\"x\",\"w\")'",
      "python3 - << EOF",
      // interpreters with inline-code flags
      'python -c "open(\'x\',\'w\')"',
      'python3 -c "..."',
      'node -e "..."',
      "perl -e 'unlink \"x\"'",
      "ruby -e 'File.write(\"x\",\"\")'",
      "sh -c 'echo x > f'",
      "bash -c 'echo x > f'",
      "osascript -e 'do shell script \"rm x\"'",
      // file-write tools
      "tee out.txt",
      "dd if=/dev/zero of=blob",
      "install x y",
      "cp a b",
      "mv a b",
      "tar -xf a.tar",
      "unzip a.zip",
      "patch < d.diff",
      "truncate -s 0 f",
      "ln -s a b",
      // find write actions — the COMPLETE exec family (-exec/-execdir/-ok/-okdir).
      "find . -delete",
      "find . -exec rm {} +",
      "find . -execdir rm {} +",
      "find . -ok rm {} ;",
      // -okdir is the interactive twin of -execdir; the plan-tier `ok\b` (no boundary between `ok`
      // and `dir`) did NOT match it, so it escaped. `ok(dir)?` closes it.
      "find . -okdir cat {} ;",
      "find /etc -okdir cat {} +",
      // the -f* file-write find actions (the Medium escape) — the plan-tier regex must deny these
      // too. The trailing-\b pitfall in the old /…-(…|fprint)\b/ let `-fprintf` slip (the \b cannot
      // sit between `fprint` and the trailing `f`), and `-fls`/`-fprint0` were absent entirely.
      "find . -fls out.txt",
      "find . -fprintf out.txt %p",
      "find . -fprint0 out.txt",
      "find / -maxdepth 0 -fls /tmp/x",
      // the originally-covered write verbs stay denied
      "rm -rf build",
      "sed -i 's/a/b/' f",
      "git checkout -- .",
    ];
    for (const command of denied) {
      expect(bashDecisionFor("plan", command), command).not.toBeNull();
    }
  });

  it("acceptEdits: bashDecisionFor is UNRESTRICTED (every command allowed)", () => {
    // FALSIFY: run the blocklist/allowlist under acceptEdits → these flip to a reason → RED.
    for (const command of ["rm -rf build", "echo x>/p", 'python3 -c "..."', "tar -xf a", "ls"]) {
      expect(bashDecisionFor("acceptEdits", command), command).toBeNull();
    }
  });
});

describe("sidecar permissions — hostPolicyForMode (the set-permission-mode mapping)", () => {
  // index.ts is not importable (top-level side effects); the set-permission-mode handler is the
  // ONLY writer of hostPolicy and it maps the wire mode through this pure function (covered by
  // inspection, same as the other index.ts wiring notes at the top of this file). The default
  // hostPolicy in index.ts is "plan" — also by inspection.
  it("maps 'acceptEdits' to 'acceptEdits', 'prototype' to 'prototype', EVERYTHING ELSE to 'plan'", () => {
    // FALSIFY: return "acceptEdits" for unknown/SDK-only modes (e.g. "default",
    // "bypassPermissions") → those assertions go RED, proving the mapping fails closed.
    // FALSIFY (prototype): drop the "prototype" branch → its assertion returns "plan" → RED.
    expect(hostPolicyForMode("acceptEdits")).toBe("acceptEdits");
    expect(hostPolicyForMode("prototype")).toBe("prototype");
    expect(hostPolicyForMode("plan")).toBe("plan");
    expect(hostPolicyForMode("default")).toBe("plan");
    expect(hostPolicyForMode("bypassPermissions")).toBe("plan");
    expect(hostPolicyForMode(undefined)).toBe("plan");
    expect(hostPolicyForMode(null)).toBe("plan");
    expect(hostPolicyForMode(42)).toBe("plan");
  });
});

describe("sidecar permissions — sdkPermissionMode (the wire→SDK mode mapping)", () => {
  it("'plan'→'plan', 'acceptEdits'→'acceptEdits', 'prototype'→'default', unknown→'default'", () => {
    // The SDK's PermissionMode union has no "prototype"; passing it raw would be a type/protocol
    // error, and SDK "plan" mode hard-blocks Write at the CLI level regardless of canUseTool —
    // so "prototype" MUST run the SDK in "default" with the host gate enforcing containment.
    // FALSIFY: return the raw mode (identity) → the "prototype" and unknown rows go RED.
    expect(sdkPermissionMode("plan")).toBe("plan");
    expect(sdkPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(sdkPermissionMode("prototype")).toBe("default");
    expect(sdkPermissionMode("default")).toBe("default");
    expect(sdkPermissionMode("bypassPermissions")).toBe("default");
    expect(sdkPermissionMode(undefined)).toBe("default");
    expect(sdkPermissionMode(null)).toBe("default");
    expect(sdkPermissionMode(42)).toBe("default");
  });
});

describe("sidecar permissions — isPrototypeWritePath (prototype containment, pure)", () => {
  const cwd = "/Users/alice/proj";

  it("allows absolute paths strictly under <cwd>/.plan-tree/prototype/ (incl. nested)", () => {
    // FALSIFY: invert the startsWith check → these flip to false → RED.
    expect(isPrototypeWritePath(cwd, "/Users/alice/proj/.plan-tree/prototype/index.html")).toBe(true);
    expect(isPrototypeWritePath(cwd, "/Users/alice/proj/.plan-tree/prototype/assets/app.js")).toBe(true);
  });

  it("allows relative paths that resolve under the prototype root", () => {
    // FALSIFY: skip resolving relative paths against cwd (treat them as absolute) → RED.
    expect(isPrototypeWritePath(cwd, ".plan-tree/prototype/x.html")).toBe(true);
    expect(isPrototypeWritePath(cwd, ".plan-tree/prototype/css/site.css")).toBe(true);
  });

  it("denies paths outside the prototype root (src files, .plan-tree siblings, the root itself)", () => {
    expect(isPrototypeWritePath(cwd, "/Users/alice/proj/src/x.ts")).toBe(false);
    expect(isPrototypeWritePath(cwd, "/Users/alice/proj/.plan-tree/master.md")).toBe(false);
    expect(isPrototypeWritePath(cwd, "src/x.ts")).toBe(false);
    // The prototype DIRECTORY itself is not a writable target — only paths strictly under it.
    expect(isPrototypeWritePath(cwd, "/Users/alice/proj/.plan-tree/prototype")).toBe(false);
    // A sibling whose name merely shares the prefix must not slip past a string-prefix check.
    expect(isPrototypeWritePath(cwd, "/Users/alice/proj/.plan-tree/prototype-evil/x.html")).toBe(false);
  });

  it("denies '..' traversal even when it lexically starts under the prototype root", () => {
    // FALSIFY: drop the ".." segment rejection in isPrototypeWritePath (both the raw-path and
    // post-resolution checks) → the first path below STARTS WITH the prototype root segments
    // and, since the containment check deliberately never collapses "..", the escape passes
    // the segment-prefix comparison → RED. (Verified: removed both checks → RED; restored → GREEN.)
    expect(
      isPrototypeWritePath(cwd, "/Users/alice/proj/.plan-tree/prototype/../../etc/passwd"),
    ).toBe(false);
    expect(isPrototypeWritePath(cwd, ".plan-tree/prototype/../master.md")).toBe(false);
    expect(isPrototypeWritePath(cwd, "../proj/.plan-tree/prototype/x.html")).toBe(false);
  });

  it("denies non-string / empty targets (malformed tool input never allows)", () => {
    expect(isPrototypeWritePath(cwd, undefined)).toBe(false);
    expect(isPrototypeWritePath(cwd, null)).toBe(false);
    expect(isPrototypeWritePath(cwd, 42)).toBe(false);
    expect(isPrototypeWritePath(cwd, { path: ".plan-tree/prototype/x" })).toBe(false);
    expect(isPrototypeWritePath(cwd, "")).toBe(false);
  });
});

describe("sidecar permissions — the gate under the 'prototype' policy", () => {
  const cwd = "/Users/alice/proj";
  function opts(id: string): { signal: AbortSignal; toolUseID: string } {
    return { signal: new AbortController().signal, toolUseID: id };
  }
  function gateWith(policy: "plan" | "acceptEdits" | "prototype", cwdValue: string | null) {
    return createInteractivePermissionGate(() => {}, () => policy, () => cwdValue);
  }

  it("Write/Edit/MultiEdit to a prototype path is ALLOWED; NotebookEdit honors notebook_path", async () => {
    const gate = gateWith("prototype", cwd);
    // FALSIFY: treat "prototype" like "plan" (deny all mutating tools) → these flip to deny → RED.
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      const input = { file_path: `${cwd}/.plan-tree/prototype/index.html`, content: "<html>" };
      expect(await gate.canUseTool(tool, input, opts(`p-${tool}`))).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
    }
    const nb = { notebook_path: `${cwd}/.plan-tree/prototype/nb.ipynb` };
    expect(await gate.canUseTool("NotebookEdit", nb, opts("p-nb"))).toEqual({
      behavior: "allow",
      updatedInput: nb,
    });
  });

  it("Write OUTSIDE the prototype area is DENIED with the prototype-phase message", async () => {
    const gate = gateWith("prototype", cwd);
    // FALSIFY: treat "prototype" like "acceptEdits" (allow all mutating tools) → deny→allow → RED.
    const r = await gate.canUseTool("Write", { file_path: `${cwd}/src/x.ts` }, opts("p1"));
    expect(r).toEqual({ behavior: "deny", message: PROTOTYPE_POLICY_WRITE_DENY });
    const r2 = await gate.canUseTool("Edit", { file_path: `${cwd}/.plan-tree/master.md` }, opts("p2"));
    expect(r2).toEqual({ behavior: "deny", message: PROTOTYPE_POLICY_WRITE_DENY });
    expect(gate.pendingCount()).toBe(0); // in-process deny, no hold
  });

  it("a NULL cwd fails CLOSED: every mutating tool is denied under 'prototype'", async () => {
    const gate = gateWith("prototype", null);
    // FALSIFY: allow when cwd is null (skip the containment check) → these flip to allow → RED.
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const input = { file_path: `${cwd}/.plan-tree/prototype/x.html` };
      expect(await gate.canUseTool(tool, input, opts(`n-${tool}`))).toEqual({
        behavior: "deny",
        message: PROTOTYPE_POLICY_WRITE_DENY,
      });
    }
  });

  it("write-shaped Bash stays DENIED under 'prototype' (now via the fail-closed allowlist)", async () => {
    const gate = gateWith("prototype", cwd);
    // FALSIFY: scope the Bash check to "plan" only → this flips to allow → RED.
    const r = await gate.canUseTool("Bash", { command: "rm -rf build" }, opts("pb1"));
    expect(r).toEqual({ behavior: "deny", message: PLAN_POLICY_WRITE_DENY });
    // INV-1: anything NOT provably read-only is denied — including the test runners that "plan"
    // intentionally permits. `cargo test` is not on the prototype read-only allowlist.
    const cargo = await gate.canUseTool("Bash", { command: "cargo test --lib" }, opts("pb1b"));
    expect(cargo).toEqual({ behavior: "deny", message: PLAN_POLICY_WRITE_DENY });
  });

  it("read tools / read-only-allowlist Bash stay AUTO-ALLOWED under 'prototype'", async () => {
    const gate = gateWith("prototype", cwd);
    for (const tool of ["Task", "Read", "Grep", "Glob"]) {
      const input = { arg: tool };
      expect(await gate.canUseTool(tool, input, opts(`pr-${tool}`))).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
    }
    // Under the prototype fail-closed allowlist, only provably read-only verbs pass (NOT cargo/npm).
    const readBash = { command: "git status" };
    expect(await gate.canUseTool("Bash", readBash, opts("pb2"))).toEqual({
      behavior: "allow",
      updatedInput: readBash,
    });
  });

  it("the default getCwd is null → 'prototype' denies mutating tools on a 2-arg gate (fail closed)", async () => {
    // The 2-arg construction is exactly how the pre-prototype tests build gates; under
    // "prototype" it must fail closed rather than throw or allow.
    const gate = createInteractivePermissionGate(() => {}, () => "prototype");
    const r = await gate.canUseTool("Write", { file_path: `${cwd}/.plan-tree/prototype/x` }, opts("d1"));
    expect(r).toEqual({ behavior: "deny", message: PROTOTYPE_POLICY_WRITE_DENY });
  });
});

describe("sidecar permissions — prototypeHookDecision (PreToolUse hook tier, pure)", () => {
  const cwd = "/Users/alice/proj";

  it("under 'prototype': Write to a prototype path passes through (null)", () => {
    // FALSIFY: deny all mutating tools under "prototype" → this flips to a reason → RED.
    const r = prototypeHookDecision("prototype", cwd, "Write", {
      file_path: `${cwd}/.plan-tree/prototype/x.html`,
      content: "<html>",
    });
    expect(r).toBeNull();
  });

  it("under 'prototype': Write OUTSIDE the prototype area is denied with the prototype message", () => {
    // FALSIFY: pass mutating tools through under "prototype" → this flips to null → RED.
    const r = prototypeHookDecision("prototype", cwd, "Write", { file_path: `${cwd}/src/a.ts` });
    expect(r).toBe(PROTOTYPE_POLICY_WRITE_DENY);
  });

  it("under 'prototype': NotebookEdit honors notebook_path — outside is denied, inside passes", () => {
    expect(
      prototypeHookDecision("prototype", cwd, "NotebookEdit", {
        notebook_path: `${cwd}/notebooks/nb.ipynb`,
      }),
    ).toBe(PROTOTYPE_POLICY_WRITE_DENY);
    expect(
      prototypeHookDecision("prototype", cwd, "NotebookEdit", {
        notebook_path: `${cwd}/.plan-tree/prototype/nb.ipynb`,
      }),
    ).toBeNull();
  });

  it("under 'prototype': a NULL cwd fails CLOSED for every mutating tool", () => {
    for (const tool of MUTATING_TOOLS) {
      expect(
        prototypeHookDecision("prototype", null, tool, {
          file_path: `${cwd}/.plan-tree/prototype/x`,
        }),
      ).toBe(PROTOTYPE_POLICY_WRITE_DENY);
    }
  });

  it("under 'prototype': write-shaped Bash is denied with the SAME constant the gate uses", () => {
    // FALSIFY: drop the Bash branch → this flips to null → RED.
    const r = prototypeHookDecision("prototype", cwd, "Bash", { command: "echo hi > /tmp/x" });
    expect(r).toBe(PLAN_POLICY_WRITE_DENY);
  });

  it("under 'prototype': read-shaped Bash and read tools pass through", () => {
    expect(prototypeHookDecision("prototype", cwd, "Bash", { command: "ls" })).toBeNull();
    for (const tool of ["Task", "Read", "Grep", "Glob"]) {
      expect(prototypeHookDecision("prototype", cwd, tool, {})).toBeNull();
    }
  });

  it("under 'plan' and 'acceptEdits': EVERYTHING passes through (mode tier / permissive)", () => {
    // "plan" is protected at the SDK mode tier (which also precedes allow rules);
    // "acceptEdits" is intentionally permissive. The hook must not deny under either.
    for (const policy of ["plan", "acceptEdits"] as const) {
      expect(
        prototypeHookDecision(policy, cwd, "Write", { file_path: `${cwd}/src/a.ts` }),
      ).toBeNull();
      expect(
        prototypeHookDecision(policy, cwd, "Bash", { command: "echo hi > /tmp/x" }),
      ).toBeNull();
      expect(prototypeHookDecision(policy, null, "Edit", { file_path: "/etc/passwd" })).toBeNull();
    }
  });
});

describe("sidecar permissions — createPrototypePreToolUseHook (SDK deny-shape wrapper)", () => {
  const cwd = "/Users/alice/proj";
  const hookOpts = { signal: new AbortController().signal };

  function preToolUseInput(toolName: string, toolInput: unknown) {
    // The PreToolUseHookInput shape from sdk.d.ts (BaseHookInput + PreToolUse fields).
    return {
      hook_event_name: "PreToolUse" as const,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: "tu-1",
      session_id: "s-1",
      transcript_path: "/tmp/t",
      cwd,
    };
  }

  it("denied call returns the SDK PreToolUse hookSpecificOutput deny shape", async () => {
    const hook = createPrototypePreToolUseHook(() => "prototype", () => cwd);
    const out = await hook(
      preToolUseInput("Write", { file_path: `${cwd}/src/a.ts` }) as never,
      "tu-1",
      hookOpts,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: PROTOTYPE_POLICY_WRITE_DENY,
      },
    });
  });

  it("pass-through call returns an empty (no-op) hook output", async () => {
    const hook = createPrototypePreToolUseHook(() => "prototype", () => cwd);
    const out = await hook(
      preToolUseInput("Write", { file_path: `${cwd}/.plan-tree/prototype/x.html` }) as never,
      "tu-2",
      hookOpts,
    );
    expect(out).toEqual({});
  });

  it("reads the LIVE policy/cwd per call (a flip takes effect on the next call)", async () => {
    let policy: "plan" | "prototype" = "plan";
    const hook = createPrototypePreToolUseHook(() => policy, () => cwd);
    const input = preToolUseInput("Write", { file_path: `${cwd}/src/a.ts` }) as never;
    expect(await hook(input, "tu-3", hookOpts)).toEqual({});
    policy = "prototype";
    // FALSIFY: capture getHostPolicy() once at construction → this stays {} → RED.
    expect(await hook(input, "tu-4", hookOpts)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: PROTOTYPE_POLICY_WRITE_DENY,
      },
    });
  });

  it("malformed tool_input (non-object) fails CLOSED for mutating tools under 'prototype'", async () => {
    const hook = createPrototypePreToolUseHook(() => "prototype", () => cwd);
    const out = await hook(preToolUseInput("Write", "not-an-object") as never, "tu-5", hookOpts);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: PROTOTYPE_POLICY_WRITE_DENY,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// INV-1 — the HOOK tier and the canUseTool GATE must return IDENTICAL Bash decisions
// for the same command (no drift). Both route through the ONE shared bashDecisionFor.
// ---------------------------------------------------------------------------
describe("sidecar permissions — hook tier and canUseTool gate agree on Bash (INV-1, no drift)", () => {
  const cwd = "/Users/alice/proj";
  function opts(id: string): { signal: AbortSignal; toolUseID: string } {
    return { signal: new AbortController().signal, toolUseID: id };
  }

  // A representative span of commands across the allow/deny boundary under "prototype".
  const commands = [
    "ls",
    "cat foo",
    "grep x f",
    "git status",
    "find . -name '*.md'",
    "echo hi",
    "echo x>/p",
    "cat a>>b",
    "python3 -c '...'",
    "node -e '...'",
    "tar -xf a.tar",
    "install x y",
    "git stash",
    "find . -delete",
    "find . -fls out.txt", // -f* file-write find action (deny) — both tiers must agree (Medium escape)
    "find . -fprintf out.txt %p", // -fprintf writes to a FILE (deny)
    "find . -okdir cat {} ;", // -okdir exec primary (deny) — both tiers must agree (uncovered escape)
    "find . -fstype apfs -name x", // -fstype is a read-only TEST (allow) — must not over-deny
    "find . -ls", // -ls is a STDOUT action (allow) — must not over-deny
    "FOO=bar sh -c '...'",
    "rm -rf build",
    "echo x 1>out", // fd-to-file write (deny)
    "ls 2>&1", // fd-dup (allow under the read-only verb)
    "ls & rm build", // bare-& background chain (deny) — both tiers must agree (F1/S1)
  ];

  it("for every command, the hook deny-reason and the gate allow/deny verdict coincide", async () => {
    // FALSIFY: route the hook and the gate through DIFFERENT predicates → at least one boundary
    // command (e.g. `echo x>/p`) would disagree → RED.
    const gate = createInteractivePermissionGate(() => {}, () => "prototype", () => cwd);
    let i = 0;
    for (const command of commands) {
      const hookReason = prototypeHookDecision("prototype", cwd, "Bash", { command });
      const gateResult = await gate.canUseTool("Bash", { command }, opts(`agree-${i++}`));
      const hookDenied = hookReason !== null;
      const gateDenied = gateResult.behavior === "deny";
      expect(gateDenied, `${command} — gate vs hook drift`).toBe(hookDenied);
      // And both must agree with the shared helper directly.
      expect(bashDecisionFor("prototype", command) !== null, command).toBe(hookDenied);
    }
  });
});

describe("sidecar status — label mapping (label-only, never raw text)", () => {
  it("maps thinking / task lifecycle / rate-limit signals to short labels; unknown → null", () => {
    expect(statusLabelFor("thinking_tokens")).toBe("thinking…");
    expect(statusLabelFor("task_started")).toBe("running subagent");
    expect(statusLabelFor("task_progress")).toBe("running subagent");
    expect(statusLabelFor("task_notification")).toBe("running subagent");
    expect(statusLabelFor("rate_limit_event")).toBe("waiting (rate limit)");
    // Unknown signals are NOT statuses (caller drops + logs them).
    expect(statusLabelFor("system")).toBeNull();
    expect(statusLabelFor("totally_unknown")).toBeNull();
  });
});

describe("sidecar status — throttle emits only on label change", () => {
  it("dedupes repeated labels and re-emits after reset", () => {
    const t = new StatusThrottle();
    // FALSIFY: drop the `if (label === this.last) return []` guard → the 2nd/3rd calls would emit
    // duplicates → these length assertions go RED.
    expect(t.next("thinking…")).toEqual(["thinking…"]);
    expect(t.next("thinking…")).toEqual([]); // duplicate suppressed
    expect(t.next("running subagent")).toEqual(["running subagent"]); // change emits
    expect(t.next("running subagent")).toEqual([]); // duplicate suppressed
    // reset() (a turn boundary) lets the same label emit again.
    t.reset();
    expect(t.next("thinking…")).toEqual(["thinking…"]);
  });
});
