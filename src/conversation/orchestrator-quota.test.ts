// Multiplan orchestration domain — PHASE 4 quota auto-resume driver tests (falsifiable).
//
// These tests exercise the orchestrator's quota_exceeded → pause → wall-clock-aware auto-resume path
// with a FAKE OrchestratorDeps (no Tauri, no DOM): an injected fake timer seam (setTimeout/clearTimeout)
// + a fake `now` clock + a captured `onWake` callback. We drive a run to an in-flight turn, dispatch
// QUOTA_BUDGET_SET (the composer opt-in), ingest a quota_exceeded frame, and assert:
//   - the pause arms a timer to `resetAt`, keeps `active` true, clears the turn watchdog;
//   - firing the timer past `resetAt` calls startSession({resumeSessionId}) once + sends the resume
//     prompt re-arming the captured variant + dispatches QUOTA_RESUMED (budget decremented);
//   - wall-clock-on-wake: a fake `now` jump past resetAt resumes immediately; a `now` still before
//     resetAt re-schedules and does NOT resume;
//   - budget 1: a SECOND quota after one resume arms NO timer and fires onQuotaExhausted;
//   - cancel() while paused clears the timer (later fire is inert);
//   - near-immediate reset: a fire before the prior session's exit waits for notifyAgentExit;
//   - a resume_fallback during auto-resume does not wedge the run.
//
// Falsifiability is load-bearing: each behavioral assertion goes RED when the guard/logic is inverted
// (notes inline; the report lists which breaks were confirmed RED).

import { describe, it, expect, vi } from "vitest";

import {
  createOrchestrator,
  type OrchestratorDeps,
  type OrchestratorObserver,
  type OrchestratorHandle,
  QUOTA_RESUME_NOTE,
  QUOTA_RESUME_GENERIC,
  quotaResumeWrap,
  intentPrompt,
  reconPrompt,
  sizerPrompt,
  summaryPrompt,
  resumedLeafContinuePrompt,
} from "./orchestrator";
import { parseNn, type NodePath } from "./plan-tree";

const nnOf = (n: number): ReturnType<typeof parseNn> => parseNn(n);
const path = (...ns: number[]): NodePath => ns.map(nnOf);

vi.mock("./diag", () => ({ diag: vi.fn() }));

import type { AgentStream, AssistantText, ResultMsg } from "./types";

// ---- scripted frame builders -----------------------------------------------------------------

let seqCounter = 0;
const nextSeq = (): number => ++seqCounter;

const textFrame = (text: string, parent: string | null = null): AssistantText => ({
  seq: nextSeq(),
  kind: "assistant_text",
  text,
  parent_tool_use_id: parent,
});

const resultFrame = (): ResultMsg => ({
  seq: nextSeq(),
  kind: "result",
  subtype: "success",
  is_error: false,
  result: "",
  num_turns: 1,
  duration_ms: 1,
  total_cost_usd: 0,
  session_id: "s",
});

// A GENUINE failed turn: an `is_error:true` result that is NOT an orchestrator-initiated interrupt
// (no `deliberateInterrupt`, a non-interrupt subtype) — e.g. a real usage/session-limit result whose
// only payload is the human limit string. `subtype` defaults to "error" (NOT "error_during_execution").
const failedResultFrame = (
  text = "Run failed",
  subtype = "error",
): ResultMsg => ({
  seq: nextSeq(),
  kind: "result",
  subtype,
  is_error: true,
  result: text,
  num_turns: 1,
  duration_ms: 1,
  total_cost_usd: 0,
  session_id: "s",
});

// An orchestrator-DELIBERATE interrupt result: `is_error:true`, subtype "error_during_execution", and
// the host-side `deliberateInterrupt` annotation index.ts stamps on the resuming-boundary frame.
const deliberateInterruptResultFrame = (): ResultMsg => ({
  seq: nextSeq(),
  kind: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "",
  num_turns: 1,
  duration_ms: 1,
  total_cost_usd: 0,
  session_id: "s",
  deliberateInterrupt: true,
});

const quotaFrame = (
  resetAt: number,
  source: "rate_limit_event" | "thrown_error" | "result_error" = "rate_limit_event",
): AgentStream => ({
  seq: nextSeq(),
  kind: "quota_exceeded",
  resetAt,
  source,
});

const resumeFallbackFrame = (): AgentStream => ({
  seq: nextSeq(),
  kind: "resume_fallback",
  reason: "transcript expired",
});

// ---- fake deps with injectable timers, clock, and wake seam ----------------------------------

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

interface Rec {
  startSession: Array<{ cwd: string; permissionMode: string; resumeSessionId?: string }>;
  sendMessage: string[];
  timers: FakeTimer[];
  wakeFns: Array<() => void>;
}

interface Clock {
  t: number;
}

function makeDeps(
  clock: Clock,
  autoResumeBudget?: number,
): { deps: OrchestratorDeps; rec: Rec } {
  const rec: Rec = { startSession: [], sendMessage: [], timers: [], wakeFns: [] };
  const deps: OrchestratorDeps = {
    // PHASE 6 — the auto-resume budget seam start() dispatches at START. Present only when a budget
    // is supplied (so the "absent seam ⇒ no QUOTA_BUDGET_SET" path is also testable).
    ...(autoResumeBudget !== undefined
      ? { resolveAutoResumeBudget: () => ({ budget: autoResumeBudget }) }
      : {}),
    startSession: vi.fn(async (args) => {
      rec.startSession.push(args);
    }),
    sendMessage: vi.fn(async (text) => {
      rec.sendMessage.push(text);
    }),
    setMode: vi.fn(async () => {}),
    resolvePermission: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    writePlanTreeFile: vi.fn(async (_cwd, name) => `/abs/.plan-tree/${name}`),
    writeAgentPlan: vi.fn(async (_p, _t, nn) => `/abs/plans/${nn}.md`),
    resetPlanTreeDir: vi.fn(async () => {}),
    ensurePrototypeDir: vi.fn(async (cwd) => `${cwd}/.plan-tree/prototype`),
    setTimeout: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cleared: false };
      rec.timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as FakeTimer).cleared = true;
    },
    now: () => clock.t,
    onWake: (fn) => {
      rec.wakeFns.push(fn);
      return () => {
        const i = rec.wakeFns.indexOf(fn);
        if (i >= 0) rec.wakeFns.splice(i, 1);
      };
    },
  };
  return { deps, rec };
}

interface Obs {
  obs: OrchestratorObserver;
  paused: Array<{ resetAt: number; remaining: number; source: string }>;
  exhausted: Array<{ resetAt: number; source: string }>;
  resumed: number;
  fatal: string[];
}

function makeObserver(): Obs {
  const o: Obs = { obs: {}, paused: [], exhausted: [], resumed: 0, fatal: [] };
  o.obs = {
    onQuotaPaused: (i) => o.paused.push(i),
    onQuotaExhausted: (i) => o.exhausted.push(i),
    onQuotaResumed: () => {
      o.resumed++;
    },
    onFatal: (m) => o.fatal.push(m),
  };
  return o;
}

// Drain the microtask queue (the timer/wake fire routes through the serialized ingest queue, so
// observers/effects land only after a few microtask hops — never a real sleep).
async function flush(n = 32): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const live = (rec: Rec): FakeTimer[] => rec.timers.filter((t) => !t.cleared);

// Drive a fresh run to the in-flight `intent` turn with the SDK session captured + a budget set.
// After this returns: the run is active, `intent` is armed, sdk_session_id == "sess-q",
// auto_resume_ = {budget, remaining: budget}, and the only live timer is the intent watchdog.
async function startWithBudget(
  h: OrchestratorHandle,
  budget: number,
): Promise<void> {
  await h.start({ cwd: "/work", request: "build it" });
  await h.ingestStream({
    seq: nextSeq(),
    kind: "system_init",
    model: "m",
    cwd: "/work",
    tools: [],
    skills: [],
    slash_commands: [],
    permission_mode: "plan",
    session_id: "sess-q",
  });
  await h.dispatch({ type: "QUOTA_BUDGET_SET", budget });
}

describe("orchestrator — Phase 4 quota auto-resume", () => {
  it("quota_exceeded (budget 1) arms a timer to resetAt, keeps active true, clears the turn watchdog, fires onQuotaPaused", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);

    // The intent watchdog is the only live timer before the wall.
    expect(live(rec).some((t) => t.ms === 300_000)).toBe(true);

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));

    // Active stays TRUE through the pause (not torn down). FALSIFY: mark terminal in the ingest
    // branch → orchestrationActive() goes false → RED.
    expect(h.orchestrationActive()).toBe(true);
    expect(h.quotaPaused()).toBe(true);
    // The intent watchdog was cleared (so it cannot FATAL the long wait). FALSIFY: drop the
    // clearTurnWatchdog() in the quota branch → the 300s watchdog stays live → RED.
    expect(live(rec).some((t) => t.ms === 300_000)).toBe(false);
    // Exactly one quota timer is armed, to the wall-clock delta (resetAt - now). FALSIFY: schedule
    // no timer (exhausted path) → this timer is absent → RED.
    const qt = live(rec).filter((t) => t.ms === 60_000);
    expect(qt).toHaveLength(1);
    // onQuotaPaused fired with the reset + remaining (budget, not yet decremented). FALSIFY: route
    // to exhausted → paused stays empty → RED.
    expect(o.paused).toEqual([{ resetAt, remaining: 1, source: "rate_limit_event" }]);
    expect(o.exhausted).toHaveLength(0);

    await h.cancel();
  });

  // DA-I5 (integration fix) — the SYNCHRONOUS pause-pending probe shared by BOTH agent-exit listeners
  // (index.ts + main.ts). main.ts cannot read index.ts's private closure flag, so the pending state is
  // promoted onto the handle: quotaPaused() must read true the INSTANT markQuotaPausePending() is
  // called — BEFORE the microtask-deferred QUOTA_PAUSED dispatch (enqueueIngest) installs the
  // established pause. This is the probe main.ts's agent-exit guard reads to skip its destructive
  // purgeInprocReviews() during a same-tick quota pause.
  it("DA-I5: markQuotaPausePending() makes quotaPaused() SYNCHRONOUSLY true, then resets on resume", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);

    // BASELINE: no pause yet.
    expect(h.quotaPaused()).toBe(false);

    // Simulate the agent-stream listener seeing a quota_exceeded frame: it calls markQuotaPausePending()
    // SYNCHRONOUSLY, BEFORE the fire-and-forget ingestStream schedules the deferred QUOTA_PAUSED
    // dispatch. We do NOT flush/await any microtask here — so the established `quotaPause` is NOT yet
    // installed; only the pending flag is.
    h.markQuotaPausePending();

    // SYNCHRONOUSLY TRUE — this is the same-tick window main.ts's agent-exit guard runs in. FALSIFY:
    // make quotaPaused() ignore the pending flag (return `quotaPause !== null` only) → this assertion
    // goes RED (quotaPause is still null because the QUOTA_PAUSED dispatch has not drained).
    expect(h.quotaPaused()).toBe(true);

    // Now drain the deferred dispatch: the established pause installs and SUBSUMES the pending flag.
    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));
    expect(h.quotaPaused()).toBe(true);

    // Resume past the reset: clearQuotaPause (in fireResume → QUOTA_RESUMED) clears BOTH the established
    // pause and the pending flag, so the probe resets. FALSIFY: drop quotaPausePending=false from
    // clearQuotaPause → the flag lingers → quotaPaused() stays true here → RED (a later genuine exit
    // would mis-classify as paused).
    h.notifyAgentExit();
    await flush();
    clock.t = resetAt;
    const qt = live(rec).find((t) => t.ms === 60_000)!;
    qt.fn();
    await flush();
    expect(h.quotaPaused()).toBe(false);

    await h.cancel();
  });

  // DA-I5 — the pending flag must also reset on cancel()/teardown (markTerminal → clearQuotaPause), so
  // a pending flag set without an ensuing established pause cannot linger past the run's teardown.
  it("DA-I5: markQuotaPausePending() then cancel() resets quotaPaused() (no lingering pending flag)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps } = makeDeps(clock);
    const h = createOrchestrator(deps);
    await startWithBudget(h, 1);

    h.markQuotaPausePending();
    expect(h.quotaPaused()).toBe(true);

    await h.cancel(); // markTerminal → clearQuotaPause clears the pending flag.
    expect(h.quotaPaused()).toBe(false);
  });

  it("advancing past resetAt resumes the captured turn exactly once: startSession({resumeSessionId}) + resume prompt + QUOTA_RESUMED", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);
    const startSessions = rec.startSession.length;

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));
    h.notifyAgentExit(); // the prior paused session exited (precondition for respawn)
    await flush();

    const qt = live(rec).find((t) => t.ms === 60_000)!;
    expect(qt).toBeDefined();

    // The wall clock has reached the reset; fire the timer.
    clock.t = resetAt;
    qt.fn();
    await flush();

    // startSession was called ONE more time, resuming the captured sdk_session_id. FALSIFY: omit
    // resumeSessionId → undefined here → RED; call twice (no clearQuotaPause guard) → length 2 → RED.
    expect(rec.startSession).toHaveLength(startSessions + 1);
    const respawn = rec.startSession[rec.startSession.length - 1];
    expect(respawn.resumeSessionId).toBe("sess-q");
    // The resume prompt was sent: the captured `intent` turn re-issued fresh, wrapped with the
    // quota-resume note (Phase 7). FALSIFY: skip the sendMessage in fireResume → no resume prompt → RED.
    expect(rec.sendMessage.some((m) => m.includes("RESUMING AFTER A QUOTA PAUSE"))).toBe(true);
    expect(rec.sendMessage.some((m) => m === quotaResumeWrap(intentPrompt("build it")))).toBe(true);
    // QUOTA_RESUMED fired → onQuotaResumed + the pause cleared. FALSIFY: drop the QUOTA_RESUMED
    // dispatch/observer → resumed stays 0 → RED.
    expect(o.resumed).toBe(1);
    expect(h.quotaPaused()).toBe(false);

    await h.cancel();
  });

  it("wall-clock-on-wake: a `now` jump PAST resetAt resumes; a `now` still BEFORE resetAt re-schedules and does NOT resume", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);
    const startSessions = rec.startSession.length;

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));
    h.notifyAgentExit();
    await flush();

    // EARLY WAKE: the page woke but the reset has not passed. fireResume must re-check the wall
    // clock and NOT resume early — it re-schedules. FALSIFY: drop the now()<resetAt re-check in
    // fireResume → it would resume at clock.t=1000 → startSession bumps → RED.
    clock.t = resetAt - 5_000; // still before the reset
    expect(rec.wakeFns).toHaveLength(1);
    rec.wakeFns[0]();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions); // no early resume
    expect(o.resumed).toBe(0);
    expect(h.quotaPaused()).toBe(true);
    // A fresh timer was re-scheduled for the remaining delta (5_000). FALSIFY: don't re-schedule on
    // early fire → no live quota timer → RED.
    expect(live(rec).some((t) => t.ms === 5_000)).toBe(true);

    // LATE WAKE: the suspension overran the reset (the in-page timer was suspended; now jumped
    // past). The wake recomputes and resumes immediately. FALSIFY: ignore the wake seam → no resume
    // until a (suspended) timer fires → RED.
    clock.t = resetAt + 10_000;
    rec.wakeFns[0]();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions + 1);
    expect(o.resumed).toBe(1);
    expect(h.quotaPaused()).toBe(false);

    await h.cancel();
  });

  it("budget 1: a SECOND quota after one resume arms NO timer and fires onQuotaExhausted (fail-closed)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);

    // First wall → pause → resume (budget 1 → remaining 0 after).
    const resetAt1 = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt1));
    h.notifyAgentExit();
    await flush();
    clock.t = resetAt1;
    live(rec).find((t) => t.ms === 60_000)!.fn();
    await flush();
    expect(o.resumed).toBe(1);

    // Second wall: budget is spent (remaining 0) → exhausted. FALSIFY: don't decrement remaining on
    // QUOTA_RESUMED → the second pause would route to paused again (arm a timer) → exhausted empty → RED.
    const resetAt2 = clock.t + 120_000;
    await h.ingestStream(quotaFrame(resetAt2));
    expect(o.exhausted).toEqual([{ resetAt: resetAt2, source: "rate_limit_event" }]);
    expect(o.paused).toHaveLength(1); // only the first pause ever surfaced as paused
    // NO new resume timer was armed (only the timer count for a 120_000-delta is checked).
    expect(live(rec).some((t) => t.ms === 120_000)).toBe(false);
    // Still paused/active (Cancel-only surface), not torn down.
    expect(h.quotaPaused()).toBe(true);
    expect(h.orchestrationActive()).toBe(true);

    await h.cancel();
  });

  it("DEGRADED quota_exceeded (resetAt 0) WITH budget remaining → onQuotaExhausted, NO timer, NO resume (can't re-loop)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1); // budget IS available — the degraded reset must still exhaust.

    const startSessions = rec.startSession.length;
    const timersBefore = rec.timers.length;

    // A degraded result-carrier quota: undeterminable reset → sentinel 0. The reducer's usableReset
    // guard FORCES exhausted despite remaining 1.
    await h.ingestStream(quotaFrame(0, "result_error"));
    await flush();

    // EXHAUSTED, not paused. FALSIFY: drop the reducer usableReset guard → routes to paused (a timer
    // armed, onQuotaPaused) → these go RED.
    expect(o.exhausted).toEqual([{ resetAt: 0, source: "result_error" }]);
    expect(o.paused).toHaveLength(0);
    // NO new timer was armed (belt-and-suspenders: scheduleQuotaTimer's resetAt>0 guard also blocks it).
    expect(rec.timers.length).toBe(timersBefore);

    // Even if a stray fire/wake tried to resume, fireResume's resetAt>0 guard blocks it: NO startSession
    // re-fire. Drive a wake to prove the degraded path can never re-loop.
    expect(rec.wakeFns.length).toBeGreaterThan(0);
    rec.wakeFns[0]();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions); // no respawn — the wall can't re-loop
    expect(o.resumed).toBe(0);
    // Still active/paused (Cancel-only surface), not torn down.
    expect(h.orchestrationActive()).toBe(true);
    expect(h.quotaPaused()).toBe(true);

    await h.cancel();
  });

  it("FUTURE resetAt → onQuotaPaused + a resume timer (the positive control for the degraded case)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);

    const resetAt = clock.t + 90_000;
    await h.ingestStream(quotaFrame(resetAt, "result_error"));

    expect(o.paused).toEqual([{ resetAt, remaining: 1, source: "result_error" }]);
    expect(o.exhausted).toHaveLength(0);
    expect(live(rec).some((t) => t.ms === 90_000)).toBe(true);

    await h.cancel();
  });

  it("no QUOTA_BUDGET_SET → the first quota is exhausted immediately (fail-closed default 0)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    // NO budget dispatched.
    await h.start({ cwd: "/work", request: "build it" });

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));

    // The reducer is fail-closed: absent auto_resume_ ⇒ remaining 0 ⇒ exhausted. FALSIFY: default
    // remaining to a positive value in the reducer → this routes to paused → RED.
    expect(o.exhausted).toEqual([{ resetAt, source: "rate_limit_event" }]);
    expect(o.paused).toHaveLength(0);
    expect(live(rec).some((t) => t.ms === 60_000)).toBe(false);

    await h.cancel();
  });

  it("cancel() while paused clears the quota timer (a later fire triggers no resume)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);
    const startSessions = rec.startSession.length;

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));
    const qt = rec.timers.find((t) => t.ms === 60_000 && !t.cleared)!;
    expect(qt).toBeDefined();

    await h.cancel();
    // The quota timer was cleared by cancel(). FALSIFY: drop clearQuotaPause from markTerminal →
    // qt.cleared stays false → the fire below resumes a dead run → RED.
    expect(qt.cleared).toBe(true);

    // Even if a stale fire slips through (the !active guard is the backstop), it must not resume.
    clock.t = resetAt + 1;
    qt.fn();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions);
    expect(o.resumed).toBe(0);
  });

  it("near-immediate reset: a timer firing BEFORE the prior session's exit waits for notifyAgentExit before startSession (no double-start)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);
    const startSessions = rec.startSession.length;

    const resetAt = clock.t; // reset is NOW (near-immediate) → delay 0
    await h.ingestStream(quotaFrame(resetAt));
    const qt = rec.timers.find((t) => t.ms === 0 && !t.cleared)!;
    expect(qt).toBeDefined();

    // Fire the timer BEFORE the prior session exited. fireResume must DEFER (prior-exit guard).
    // FALSIFY: drop the priorExited guard in fireResume → startSession fires now (a double-start the
    // Rust one-session guard would reject) → RED.
    qt.fn();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions);
    expect(o.resumed).toBe(0);
    expect(h.quotaPaused()).toBe(true);

    // Now the prior session exits → the deferred resume kicks.
    h.notifyAgentExit();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions + 1);
    expect(o.resumed).toBe(1);
    expect(h.quotaPaused()).toBe(false);

    await h.cancel();
  });

  it("backstop: a deferred resume where notifyAgentExit NEVER arrives eventually PROCEEDS within the bounded attempts (does not hang forever)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);
    const startSessions = rec.startSession.length;

    const resetAt = clock.t; // near-immediate reset → delay 0
    await h.ingestStream(quotaFrame(resetAt));
    const qt = rec.timers.find((t) => t.ms === 0 && !t.cleared)!;
    expect(qt).toBeDefined();

    // Fire the resume timer BEFORE the prior session exited and NEVER call notifyAgentExit. fireResume
    // defers (prior-exit guard) but arms a BOUNDED backstop timer. We pump the backstop timer the
    // bounded number of times; on the final pump the resume PROCEEDS anyway (no exit ever arrived).
    qt.fn();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions); // first defer — no resume yet

    // Each backstop timer is a 5_000ms re-check. Pump them; after the bounded max the resume fires.
    // (We rely only on the OBSERVABLE: the resume eventually proceeds, not the exact attempt count.)
    let guard = 20;
    while (rec.startSession.length === startSessions && guard-- > 0) {
      const bt = live(rec).find((t) => t.ms === 5_000);
      if (!bt) break;
      clock.t = resetAt; // keep the wall-clock re-check satisfied
      bt.fn();
      await flush();
    }

    // The resume PROCEEDED despite no notifyAgentExit ever arriving — the run did not hang forever.
    // FALSIFY: remove the bounded fall-through (defer forever on !priorExited) → startSession never
    // bumps and there is always another 5_000 backstop timer → the loop exhausts `guard` → RED.
    expect(rec.startSession).toHaveLength(startSessions + 1);
    expect(o.resumed).toBe(1);
    expect(h.quotaPaused()).toBe(false);

    await h.cancel();
  });

  it("backstop: notifyAgentExit arriving DURING a backstop defer proceeds immediately (primary path beats the backstop)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);
    const startSessions = rec.startSession.length;

    const resetAt = clock.t;
    await h.ingestStream(quotaFrame(resetAt));
    const qt = rec.timers.find((t) => t.ms === 0 && !t.cleared)!;
    qt.fn();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions); // deferred, backstop armed

    // The exit lands while the backstop is pending → the PRIMARY notifyAgentExit path proceeds now.
    clock.t = resetAt;
    h.notifyAgentExit();
    await flush();
    expect(rec.startSession).toHaveLength(startSessions + 1);
    expect(o.resumed).toBe(1);

    await h.cancel();
  });

  it("a resume_fallback frame during auto-resume does not wedge the run (no fatal, run stays live)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));
    h.notifyAgentExit();
    await flush();
    clock.t = resetAt;
    live(rec).find((t) => t.ms === 60_000)!.fn();
    await flush();
    expect(o.resumed).toBe(1);

    // The transcript expired over the long wait → the sidecar emits resume_fallback into the freshly
    // re-opened session. It must be tolerated (dropped, no fatal, run still live). FALSIFY: route
    // resume_fallback to a fatal/terminal path → fatal non-empty / inactive → RED.
    await h.ingestStream(resumeFallbackFrame());
    expect(o.fatal).toHaveLength(0);
    expect(h.orchestrationActive()).toBe(true);

    await h.cancel();
  });

  it("the captured in-flight variant is re-armed on resume (a recon turn resumes as recon, not idle)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);

    // Advance the run to a `recon` turn: the intent turn completes → recon prompt sent + `recon` armed.
    await h.ingestStream(textFrame("the confirmed intent\n\nNO-PROTOTYPE", "agent-intent"));
    await h.ingestStream(resultFrame());
    const sendsBeforeWall = rec.sendMessage.length;

    // Wall during the recon turn → capture `recon`, pause.
    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));
    h.notifyAgentExit();
    await flush();
    clock.t = resetAt;
    live(rec).find((t) => t.ms === 60_000)!.fn();
    await flush();

    // The resume prompt was sent (re-issuing the captured turn). Then a recon `result` must advance
    // the sequencer OFF recon (proving `recon` was re-armed, not left idle which would swallow it).
    // FALSIFY: re-arm idle for every captured variant → the result below is swallowed, root stays in
    // recon → RED.
    expect(rec.sendMessage.length).toBeGreaterThan(sendsBeforeWall);
    expect(rootPhase(h)).toBe("open/recon");
    await h.ingestStream(textFrame("recon report body"));
    await h.ingestStream(resultFrame());
    expect(rootPhase(h)).not.toBe("open/recon");

    await h.cancel();
  });
});

describe("orchestrator — Phase 0 session-limit loop-stop guard", () => {
  // Test A (loop-stops): a GENUINE failed `is_error` result in an ARMED turn (here: `intent`) must
  // terminate the run — never advance/re-prompt the next phase (the infinite "Run failed: You've hit
  // your session limit…" loop). RED before the guard (the result is consumed as a turn boundary →
  // intent advances → recon prompt sent), GREEN after (FATAL, no new send).
  it("A: a non-quota is_error result in an armed turn FATALs the run and does NOT re-prompt (no loop)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1); // run is active, `intent` armed, intent prompt already sent.

    const sendsBefore = rec.sendMessage.length;

    // The session-limit result: is_error, a non-interrupt subtype, the human limit string is the
    // only payload. No `deliberateInterrupt` annotation (the orchestrator was NOT resuming).
    await h.ingestStream(
      failedResultFrame(
        "You've hit your session limit · resets 2:10pm (America/Chicago)",
        "error",
      ),
    );
    await flush();

    // NO re-prompt: sendMessage must NOT grow. FALSIFY: remove the guard → the `intent` boundary
    // consumes the error result, advances to recon, and sends the recon prompt → sendMessage grows → RED.
    expect(rec.sendMessage.length).toBe(sendsBefore);
    // The run TERMINATED: onFatal fired (with the limit text) and the run is no longer active.
    // FALSIFY: remove the guard → no FATAL, the run keeps running → RED.
    expect(o.fatal).toEqual([
      "You've hit your session limit · resets 2:10pm (America/Chicago)",
    ]);
    expect(h.orchestrationActive()).toBe(false);

    await h.cancel();
  });

  // Test B (no regression — DA CRITICAL-1): the orchestrator's OWN deliberate interrupt is an
  // `is_error` result too (subtype "error_during_execution", `deliberateInterrupt` stamped) and it
  // lands in the `resuming` flow as the boundary that fires the deferred recon. The guard MUST NOT
  // FATAL it — decomposition must continue. RED if the guard is made blanket (`if (frame.is_error)`).
  it("B: a deliberate-interrupt is_error result in the resuming flow does NOT FATAL — decomposition continues", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock);
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startWithBudget(h, 1);

    // Drive to a SPLIT master decomposition gate, then approve it: approve("") arms `resuming` and
    // interrupts the in-flight turn. The interrupt surfaces as an is_error result (subtype
    // error_during_execution); index.ts stamps it `deliberateInterrupt` while the orchestrator is
    // resuming. That boundary result must fire child 01's recon, NOT FATAL.
    await h.ingestStream(textFrame("the confirmed intent\n\nNO-PROTOTYPE", "agent-intent"));
    await h.ingestStream(resultFrame()); // intent → recon
    await h.ingestStream(textFrame("root recon report"));
    await h.ingestStream(resultFrame()); // recon → sizer
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
    await h.ingestStream(resultFrame()); // sizer → decomposition draft

    await h.ingestPermission({
      seq: nextSeq(),
      kind: "tool_permission_requested",
      id: "master-tu",
      tool: "ExitPlanMode",
      input: {
        plan: "# Preamble\n\n### Sub-Plan 01: First\nscope one\n\n### Sub-Plan 02: Second\nscope two\n",
      },
      agent_id: null,
    });
    await flush();
    await h.approve(""); // arms `resuming` + interrupts the in-flight turn.
    await flush();
    const sendsBeforeBoundary = rec.sendMessage.length;

    // THE BOUNDARY: the aborted turn's deliberate-interrupt result (is_error, error_during_execution,
    // deliberateInterrupt). The `resuming` branch must consume it and fire child 01's deferred recon.
    await h.ingestStream(deliberateInterruptResultFrame());
    await flush();

    // NOT FATAL — the run stays live and the deferred recon was sent (decomposition continues).
    // FALSIFY: make the guard blanket (`if (frame.is_error) FATAL`) → this is FATAL'd → onFatal
    // non-empty / inactive / no new send → RED.
    expect(o.fatal).toHaveLength(0);
    expect(h.orchestrationActive()).toBe(true);
    expect(rec.sendMessage.length).toBeGreaterThan(sendsBeforeBoundary);

    await h.cancel();
  });
});

describe("orchestrator — Phase 6 start() threads the composer budget into QUOTA_BUDGET_SET", () => {
  // Drive a fresh run to the in-flight intent turn WITHOUT a manual QUOTA_BUDGET_SET dispatch — the
  // budget must come from start()'s deps.resolveAutoResumeBudget() seam, exactly like the live app.
  async function startNoManualBudget(h: OrchestratorHandle): Promise<void> {
    await h.start({ cwd: "/work", request: "build it" });
    await h.ingestStream({
      seq: nextSeq(),
      kind: "system_init",
      model: "m",
      cwd: "/work",
      tools: [],
      skills: [],
      slash_commands: [],
      permission_mode: "plan",
      session_id: "sess-q",
    });
  }

  it("budget 'once' (1) → start() dispatches QUOTA_BUDGET_SET{1} → a quota PAUSES (auto-resume armed)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock, 1); // composer chose "once"
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startNoManualBudget(h);

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));

    // The budget threaded from start() → remaining 1 → PAUSED (a timer armed). FALSIFY: drop the
    // QUOTA_BUDGET_SET dispatch in start() → fail-closed default 0 → exhausted, no timer → RED.
    expect(o.paused).toEqual([{ resetAt, remaining: 1, source: "rate_limit_event" }]);
    expect(o.exhausted).toHaveLength(0);
    expect(live(rec).some((t) => t.ms === 60_000)).toBe(true);

    await h.cancel();
  });

  it("budget 'off' (0) → start() dispatches QUOTA_BUDGET_SET{0} → a quota is EXHAUSTED immediately (no auto-resume)", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps, rec } = makeDeps(clock, 0); // composer chose "off"
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startNoManualBudget(h);

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));

    // budget 0 → exhausted (no timer). FALSIFY: map "off" to a positive budget anywhere in the chain
    // → this routes to paused (a timer armed) → RED.
    expect(o.exhausted).toEqual([{ resetAt, source: "rate_limit_event" }]);
    expect(o.paused).toHaveLength(0);
    expect(live(rec).some((t) => t.ms === 60_000)).toBe(false);

    await h.cancel();
  });

  it("absent resolveAutoResumeBudget seam → start() dispatches NO budget → fail-closed exhausted", async () => {
    const clock: Clock = { t: 1_000 };
    const { deps } = makeDeps(clock); // no budget seam at all
    const h = createOrchestrator(deps);
    const o = makeObserver();
    h.subscribe(o.obs);
    await startNoManualBudget(h);

    const resetAt = clock.t + 60_000;
    await h.ingestStream(quotaFrame(resetAt));

    // No seam ⇒ no QUOTA_BUDGET_SET ⇒ reducer fail-closed default 0 ⇒ exhausted.
    expect(o.exhausted).toEqual([{ resetAt, source: "rate_limit_event" }]);
    expect(o.paused).toHaveLength(0);

    await h.cancel();
  });
});

// "stage/phase" of the root node.
function rootPhase(h: OrchestratorHandle): string {
  const r = h.snapshot().root;
  return `${r.state.stage}/${r.state.phase}`;
}

// ---- Phase 7: resume-context injection (the per-variant quotaResumePrompt + the buffer contract) --
//
// These tests DRIVE the live orchestrator to each in-flight variant, hit a quota wall, auto-resume,
// and assert the EXACT resume message the driver sends. The message must be the variant's ORIGINAL
// turn prompt (the same pure builder a never-interrupted turn used) WRAPPED with QUOTA_RESUME_NOTE —
// a full, self-contained re-emission, never a "continue from the partial". The buffer-contract test
// is the load-bearing carry-forward fix: the discarded partial buffer must NOT prefix the fresh
// result.

const REQUEST = "build it";

// Drive a fresh run with budget 1 to the in-flight `intent` turn (system_init captured).
async function freshAtIntent(): Promise<{
  h: OrchestratorHandle;
  rec: Rec;
  clock: Clock;
  o: Obs;
  deps: OrchestratorDeps;
}> {
  const clock: Clock = { t: 1_000 };
  const { deps, rec } = makeDeps(clock);
  const h = createOrchestrator(deps);
  const o = makeObserver();
  h.subscribe(o.obs);
  await h.start({ cwd: "/work", request: REQUEST });
  await h.ingestStream({
    seq: nextSeq(),
    kind: "system_init",
    model: "m",
    cwd: "/work",
    tools: [],
    skills: [],
    slash_commands: [],
    permission_mode: "plan",
    session_id: "sess-q",
  });
  await h.dispatch({ type: "QUOTA_BUDGET_SET", budget: 1 });
  return { h, rec, clock, o, deps };
}

// Read the contents written to recon.md from the writePlanTreeFile mock (3rd arg of the matching call).
function reconMdContent(deps: OrchestratorDeps): string | undefined {
  const fake = deps.writePlanTreeFile as unknown as {
    mock: { calls: Array<[string, string, string]> };
  };
  const call = [...fake.mock.calls].reverse().find((c) => c[1] === "recon.md");
  return call?.[2];
}

// Complete the intent turn → root recon armed (path []).
async function advanceIntentToRecon(h: OrchestratorHandle): Promise<void> {
  await h.ingestStream(textFrame("the confirmed intent\n\nNO-PROTOTYPE", "agent-intent"));
  await h.ingestStream(resultFrame());
}

// Complete the root recon → root sizer armed (path []).
async function advanceReconToSizer(h: OrchestratorHandle): Promise<void> {
  await h.ingestStream(textFrame("root recon report"));
  await h.ingestStream(resultFrame());
}

// Complete the root sizer with a CONFIDENT single → root collapses to child [01]'s recon (sub-recon).
async function advanceSizerToChildRecon(h: OrchestratorHandle): Promise<void> {
  await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
  await h.ingestStream(resultFrame());
}

// Complete the child [01] recon → child is the collapse leaf → its draft is sent (awaiting idle).
async function advanceChildReconToDraft(h: OrchestratorHandle): Promise<void> {
  await h.ingestStream(textFrame("child recon report"));
  await h.ingestStream(resultFrame());
}

// Hold the leaf's plan via ExitPlanMode + approve → exec armed (path [01]).
async function advanceDraftToExec(h: OrchestratorHandle): Promise<void> {
  await h.ingestPermission({
    seq: nextSeq(),
    kind: "tool_permission_requested",
    id: "leaf-exit-1",
    tool: "ExitPlanMode",
    input: { plan: "leaf plan body" },
    agent_id: null,
  });
  await flush();
  await h.approve("01");
  await flush();
}

// Complete the exec turn → summary armed (path [01]) + summaryPrompt sent.
async function advanceExecToSummary(h: OrchestratorHandle): Promise<void> {
  await h.ingestStream(resultFrame());
}

// Fire the quota wall on the currently in-flight turn, resume, and return the LAST sendMessage (the
// resume prompt). Asserts exactly one resume startSession happened.
async function quotaWallAndResume(
  h: OrchestratorHandle,
  rec: Rec,
  clock: Clock,
): Promise<string> {
  const startsBefore = rec.startSession.length;
  const resetAt = clock.t + 60_000;
  await h.ingestStream(quotaFrame(resetAt));
  h.notifyAgentExit();
  await flush();
  clock.t = resetAt;
  live(rec).find((t) => t.ms === 60_000)!.fn();
  await flush();
  expect(rec.startSession).toHaveLength(startsBefore + 1);
  return rec.sendMessage[rec.sendMessage.length - 1];
}

describe("orchestrator — Phase 7 quotaResumeWrap / note primitives (pure)", () => {
  it("quotaResumeWrap prepends the quota-resume note then the original turn body, in order", () => {
    const wrapped = quotaResumeWrap("ORIGINAL BODY");
    expect(wrapped).toBe(`${QUOTA_RESUME_NOTE}\n\nORIGINAL BODY`);
    // The note appears BEFORE the body. FALSIFY: append instead of prepend → indexOf(note) > indexOf(body) → RED.
    expect(wrapped.indexOf(QUOTA_RESUME_NOTE)).toBeLessThan(wrapped.indexOf("ORIGINAL BODY"));
  });

  it("QUOTA_RESUME_NOTE states quota threshold + refresh + DISCARDED partial + complete fresh re-emission", () => {
    // The four load-bearing instructions of the contract. FALSIFY: drop any clause → its match → RED.
    expect(QUOTA_RESUME_NOTE).toMatch(/quota limit was reached/i);
    expect(QUOTA_RESUME_NOTE).toMatch(/refreshed/i);
    expect(QUOTA_RESUME_NOTE).toMatch(/DISCARDED/);
    expect(QUOTA_RESUME_NOTE).toMatch(/complete.*fresh|fresh.*re-emission/i);
    expect(QUOTA_RESUME_NOTE).toMatch(/do NOT try to continue it/i);
  });

  it("QUOTA_RESUME_GENERIC is the no-clean-turn fallback (quota note + continue current step)", () => {
    expect(QUOTA_RESUME_GENERIC).toMatch(/quota/i);
    expect(QUOTA_RESUME_GENERIC).toMatch(/continue where\s+you left off/i);
    expect(QUOTA_RESUME_GENERIC).toMatch(/complete result for the current step/i);
  });
});

describe("orchestrator — Phase 7 per-variant resume-context injection (live drive)", () => {
  it("intent: resume re-issues quotaResumeWrap(intentPrompt(request))", async () => {
    const { h, rec, clock } = await freshAtIntent();
    const msg = await quotaWallAndResume(h, rec, clock);
    // FALSIFY: return the old generic placeholder for intent → msg !== expected → RED.
    expect(msg).toBe(quotaResumeWrap(intentPrompt(REQUEST)));
    expect(msg).toContain(QUOTA_RESUME_NOTE);
    await h.cancel();
  });

  it("recon (root, path []): resume re-issues quotaResumeWrap(reconPrompt(request, intent))", async () => {
    const { h, rec, clock } = await freshAtIntent();
    await advanceIntentToRecon(h);
    expect(rootPhase(h)).toBe("open/recon");
    const msg = await quotaWallAndResume(h, rec, clock);
    // confirmedIntent was captured at the intent boundary ("the confirmed intent").
    expect(msg).toBe(quotaResumeWrap(reconPrompt(REQUEST, "the confirmed intent")));
    // It re-uses the recon body, not the intent body. FALSIFY: route recon→intentPrompt → RED.
    expect(msg).toContain("scope-recon");
    await h.cancel();
  });

  it("sizer (path []): resume re-issues quotaResumeWrap(sizerPrompt())", async () => {
    const { h, rec, clock } = await freshAtIntent();
    await advanceIntentToRecon(h);
    await advanceReconToSizer(h);
    expect(rootPhase(h)).toBe("open/sizing");
    const msg = await quotaWallAndResume(h, rec, clock);
    expect(msg).toBe(quotaResumeWrap(sizerPrompt()));
    expect(msg).toContain("SIZER:");
    await h.cancel();
  });

  it("recon (child [01]): resume re-issues quotaResumeWrap of the SAME sub-recon body the live turn sent", async () => {
    const { h, rec, clock } = await freshAtIntent();
    await advanceIntentToRecon(h);
    await advanceReconToSizer(h);
    await advanceSizerToChildRecon(h);
    // The child [01] sub-recon is now in flight. The ORIGINAL child sub-recon prompt is the last send
    // before the wall — the resume must re-emit EXACTLY that body, wrapped with the quota note (proving
    // the sub-recon path: child id + mandate + scope guard, not the root reconPrompt or intentPrompt).
    const originalChildRecon = rec.sendMessage[rec.sendMessage.length - 1];
    expect(originalChildRecon).toContain("sub-plan 01");
    const msg = await quotaWallAndResume(h, rec, clock);
    expect(msg).toBe(quotaResumeWrap(originalChildRecon));
    expect(msg).toContain("scope-recon");
    await h.cancel();
  });

  it("exec (path [01]): resume re-issues quotaResumeWrap(resumedLeafContinuePrompt(planName)) — audit-and-continue, not restart", async () => {
    const { h, rec, clock } = await freshAtIntent();
    await advanceIntentToRecon(h);
    await advanceReconToSizer(h);
    await advanceSizerToChildRecon(h);
    await advanceChildReconToDraft(h);
    await advanceDraftToExec(h);
    // The exec turn (implementing the approved leaf plan) is in flight.
    const msg = await quotaWallAndResume(h, rec, clock);
    expect(msg).toBe(quotaResumeWrap(resumedLeafContinuePrompt("01-plan.md")));
    // It is the AUDIT-AND-CONTINUE prompt (inspect the tree, finish remaining), not a from-scratch
    // restart. FALSIFY: route exec→resumedLeafApprovalPrompt ("Begin implementing it now") → RED.
    expect(msg).toContain("inspect the CURRENT state of the working tree");
    await h.cancel();
  });

  it("summary (path [01]): resume re-issues quotaResumeWrap(summaryPrompt([01]))", async () => {
    const { h, rec, clock } = await freshAtIntent();
    await advanceIntentToRecon(h);
    await advanceReconToSizer(h);
    await advanceSizerToChildRecon(h);
    await advanceChildReconToDraft(h);
    await advanceDraftToExec(h);
    await advanceExecToSummary(h);
    // The summary turn is in flight.
    const msg = await quotaWallAndResume(h, rec, clock);
    expect(msg).toBe(quotaResumeWrap(summaryPrompt(path(1), false)));
    expect(msg).toContain("Output a concise summary");
    await h.cancel();
  });

  it("idle (no clean captured turn): resume sends the generic fallback, not a variant body", async () => {
    const { h, rec, clock } = await freshAtIntent();
    // Drive PAST a boundary into an idle window: the child draft was sent (awaiting idle, waiting for
    // the ExitPlanMode hold — no in-flight result turn).
    await advanceIntentToRecon(h);
    await advanceReconToSizer(h);
    await advanceSizerToChildRecon(h);
    await advanceChildReconToDraft(h); // now awaiting idle (leaf draft sent, awaiting ExitPlanMode)
    const msg = await quotaWallAndResume(h, rec, clock);
    expect(msg).toBe(QUOTA_RESUME_GENERIC);
    await h.cancel();
  });

  it("parent-review (split): resume re-issues quotaResumeWrap of the SAME review body the live turn sent (child summary + frozen sibling mandates + ADJUST/NONE)", async () => {
    const { h, rec, clock } = await freshAtIntent();
    // SPLIT into a 2-child master, approve it, run child 01 to its summary → the parent enters
    // `reviewing` and the NO-TOOLS parent-review turn is in flight.
    await advanceIntentToRecon(h);
    await advanceReconToSizer(h);
    await h.ingestStream(textFrame("SIZER: split / 2 / 0.9"));
    await h.ingestStream(resultFrame());
    // The master decomposition gate holds; approve it (arms `resuming` + interrupts; the boundary
    // result fires child 01's recon).
    await h.ingestPermission({
      seq: nextSeq(),
      kind: "tool_permission_requested",
      id: "master-tu",
      tool: "ExitPlanMode",
      input: { plan: "# Preamble\n\n### Sub-Plan 01: First\nscope one\n\n### Sub-Plan 02: Second\nscope two\n" },
      agent_id: null,
    });
    await flush();
    await h.approve("");
    await h.ingestStream(resultFrame()); // boundary result → child 01 recon
    await flush();
    // Run child 01: recon → sizer(single) → draft → approve → exec → summary.
    await h.ingestStream(textFrame("01 recon"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("SIZER: single / 1 / 0.9"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission({
      seq: nextSeq(),
      kind: "tool_permission_requested",
      id: "leaf-01-tu",
      tool: "ExitPlanMode",
      input: { plan: "01 plan body" },
      agent_id: null,
    });
    await flush();
    await h.approve("01");
    await h.ingestStream(resultFrame()); // exec completion → summary prompt
    await h.ingestStream(textFrame("## Changes\nSUMMARY-01-MARKER\n## Findings\nf\n## Next-step inputs\nn"));
    await h.ingestStream(resultFrame()); // summary result → parent enters reviewing, review turn in flight

    // The parent-review turn is now the LAST send (carries 01's summary + 02's frozen mandate + the
    // ADJUST/NONE protocol). The resume must re-emit EXACTLY that body, wrapped with the quota note.
    const originalReview = rec.sendMessage[rec.sendMessage.length - 1];
    expect(originalReview).toContain("Sub-plan 01 has completed");
    expect(originalReview).toContain("SUMMARY-01-MARKER");
    expect(originalReview).toContain("### Sub-Plan 02: Second");
    expect(originalReview).toContain("ADJUST:");

    const msg = await quotaWallAndResume(h, rec, clock);
    // FALSIFY: route parent-review→QUOTA_RESUME_GENERIC (drop the variant case) → msg !== expected → RED.
    expect(msg).toBe(quotaResumeWrap(originalReview));
    expect(msg).toContain(QUOTA_RESUME_NOTE);
    await h.cancel();
  });
});

describe("orchestrator — Phase 7 buffer contract (the carry-forward fix)", () => {
  it("a partial recon buffer at quota time is DISCARDED: recon.md holds ONLY the fresh re-emission (no stale prefix)", async () => {
    const { h, rec, clock, deps } = await freshAtIntent();
    await advanceIntentToRecon(h); // root recon armed (path [])

    // The interrupted recon turn accumulated a PARTIAL buffer before the wall.
    await h.ingestStream(textFrame("STALE PARTIAL RECON FRAGMENT"));

    // The quota wall captures the recon variant WITH its partial buffer; auto-resume re-arms it with
    // buffer:"" (the Phase 7 fix). Then the model produces the COMPLETE fresh recon.
    await quotaWallAndResume(h, rec, clock);
    await h.ingestStream(textFrame("FRESH COMPLETE RECON REPORT"));
    await h.ingestStream(resultFrame());

    // recon.md is written from the captured buffer in the recon consume branch. The result is ONLY
    // the fresh output — the stale partial prefix is GONE (no concatenation).
    // FALSIFY: revert the `buffer:""` reset in fireResume (carry the stale buffer) → recon.md becomes
    // "STALE PARTIAL RECON FRAGMENT\nFRESH COMPLETE RECON REPORT" → this assertion RED.
    const reconWrite = reconMdContent(deps);
    expect(reconWrite).toBe("FRESH COMPLETE RECON REPORT");
    expect(reconWrite).not.toContain("STALE PARTIAL");

    await h.cancel();
  });
});
