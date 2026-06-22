// Graceful sidecar shutdown drain (INV-4).
//
// When the Rust host tears down (app quit), the PRIMARY path is the `{"type":"end"}`
// stdin line it sends; it then waits a BOUNDED interval (≤ DRAIN_TIMEOUT, ~2s, on a
// oneshot fired by the read task's CommandEvent::Terminated) and SIGKILLs only as the
// fallback — it does NOT SIGTERM the sidecar (see src-tauri/src/agent.rs `drain_child`
// / `shutdown_session`). For the SDK's `claude` GRANDCHILD to be reaped rather than
// orphaned, this process must — on ALL FOUR exit triggers (the `end` command, SIGTERM,
// SIGINT, and a bare stdin-close) — abort the in-flight turn and CLOSE the SDK query
// (the call that drives the SDK's own child teardown) and AWAIT that drain BEFORE
// exiting. A synchronous `process.exit` would cut the SDK's async teardown off
// mid-flight and re-orphan the grandchild — the exact bug INV-4 targets — so every
// trigger routes through the single awaited `gracefulExit` below.
//
// The drain is factored OUT of index.ts (which is a side-effecting entry point
// that boots readline + query() at import) so its ORDER — and the "await before
// exit" invariant — is unit-testable against a mock `q`/`userQueue` and an
// injected `exit`, without executing the boot.

/** The query surface the drain touches. Mirrors the SDK `Query` (interrupt +
 *  close) without importing the whole type — `close` is optional because older
 *  SDK shapes expose only the iterator. */
export interface DrainableQuery {
  interrupt(): Promise<void>;
  close?: () => void;
}

/** The user-message queue surface the drain touches (the push-queue's `end`). */
export interface DrainableQueue {
  end(): void;
}

export interface DrainDeps {
  /** The live SDK query, or null if a session never started. */
  q: DrainableQuery | null;
  /** The streaming-input queue, or null if a session never started. */
  userQueue: DrainableQueue | null;
  /** Diagnostics sink (fd 2). */
  logErr: (...parts: unknown[]) => void;
}

/**
 * Drain the SDK session gracefully so the `claude` grandchild is reaped, not
 * orphaned. Order (each step guarded so one failure cannot skip the rest):
 *   1. `await q.interrupt()` — abort the in-flight turn (same call the
 *      `interrupt` command uses); a reject (idle turn) is logged, not thrown.
 *   2. `q.close()` — end the SDK session; this triggers the SDK's own child
 *      teardown (the `process.on("exit")` reaper SIGTERMs the CLI child).
 *   3. `userQueue.end()` — release the parked async iterator so nothing keeps
 *      the event loop alive after close.
 * Never throws — a teardown path must always reach the caller's `process.exit`.
 */
export async function drainQuery(deps: DrainDeps): Promise<void> {
  const { q, userQueue, logErr } = deps;
  if (q) {
    try {
      await q.interrupt();
    } catch (e) {
      // Interrupting an idle/ended query may reject — that is fine on teardown.
      logErr("[sidecar] shutdown interrupt failed (turn may already be idle):", String(e));
    }
    try {
      q.close?.();
    } catch (e) {
      logErr("[sidecar] shutdown query close failed:", String(e));
    }
  }
  try {
    userQueue?.end();
  } catch (e) {
    logErr("[sidecar] shutdown queue end failed:", String(e));
  }
}

/** Mutable handle to the live session deps, read at drain time (q/userQueue are
 *  null until `start` arrives, then assigned). The functions read the LIVE values
 *  through getters so a drain triggered after start still sees the real query. */
export interface GracefulExitDeps {
  getQ: () => DrainableQuery | null;
  getUserQueue: () => DrainableQueue | null;
  logErr: (...parts: unknown[]) => void;
  /** Injected so tests assert the drain RESOLVED before exit; production passes
   *  `process.exit`. Typed to return `never` to match `process.exit`'s signature. */
  exit: (code: number) => never;
  /** OPTIONAL, fired ONCE at the VERY TOP of the FIRST trigger — before the drain `await` and
   *  before the latch could short-circuit a later trigger. index.ts wires this to
   *  `backoffAbort.abort()` so a SIGTERM/SIGINT/`end` during an in-flight 529 backoff sleep aborts
   *  the wait immediately (no up-to-30m hang) and lets the drain proceed. Guarded: a throw here is
   *  logged, never propagated, so teardown still reaches `exit`. Absent (the default, e.g. all
   *  shutdown unit tests) ⇒ behavior is byte-identical to before. */
  onBeforeDrain?: () => void;
}

/** A re-entrancy latch so a second trigger (e.g. SIGTERM arriving while the `end`
 *  command's drain is in flight) is a no-op rather than a double-drain/double-exit.
 *  Returned as a closure-bound flag from `makeGracefulExit` so each process (and
 *  each test) gets its own latch. */
export function makeGracefulExit(deps: GracefulExitDeps): (reason: string, code: number) => Promise<void> {
  let shuttingDown = false;
  return async function gracefulExit(reason: string, code: number): Promise<void> {
    if (shuttingDown) return; // a drain is already in flight — ignore the second trigger.
    shuttingDown = true;
    // FIRST thing, before the drain await: signal any in-flight 529 backoff sleep to abort so a
    // teardown trigger never waits out a multi-minute wait. Guarded — a throw must not skip the drain.
    if (deps.onBeforeDrain) {
      try {
        deps.onBeforeDrain();
      } catch (e) {
        deps.logErr("[sidecar] graceful shutdown onBeforeDrain failed:", String(e));
      }
    }
    deps.logErr("[sidecar] graceful shutdown:", reason);
    // AWAIT the drain (interrupt → close → queue-end) so the SDK reaps its CLI
    // grandchild BEFORE we exit. This is the fix for the `end`-command path, which
    // previously exited synchronously and could cut the async teardown off.
    await drainQuery({ q: deps.getQ(), userQueue: deps.getUserQueue(), logErr: deps.logErr });
    deps.exit(code);
  };
}
