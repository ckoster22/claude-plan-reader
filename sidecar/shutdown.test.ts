// Falsifiable unit tests for the sidecar's graceful shutdown drain (shutdown.ts).
//
// THE BUG UNDER TEST (INV-4 — orphaned CLI grandchild): on app quit the Rust host's
// PRIMARY path sends `{"type":"end"}` (it does NOT SIGTERM the sidecar — it waits a
// bounded interval on a oneshot, then SIGKILLs only as the fallback). For the SDK's
// `claude` grandchild to be reaped rather than orphaned, ALL FOUR exit triggers — the
// `end` command, SIGTERM, SIGINT, and a bare stdin-close — MUST abort the in-flight
// turn, close the SDK query (which drives the SDK's own child teardown), AND AWAIT
// that drain BEFORE the process exits. A synchronous exit (the old `end`-command bug)
// cuts the async teardown off mid-flight and re-orphans the grandchild. These tests
// assert (a) `drainQuery` runs interrupt → close → queue-end in order and never throws,
// and (b) `gracefulExit` awaits that drain before exit and is idempotent.

import { describe, it, expect, vi } from "vitest";
import {
  drainQuery,
  makeGracefulExit,
  type DrainableQuery,
  type DrainableQueue,
} from "./shutdown";

function noopLog(): void {}

describe("sidecar drainQuery — graceful agent-tree drain reaps the CLI grandchild", () => {
  it("interrupts the turn, closes the query, and ends the queue — in that order", async () => {
    const calls: string[] = [];
    const q: DrainableQuery = {
      interrupt: vi.fn(async () => {
        calls.push("interrupt");
      }),
      close: vi.fn(() => {
        calls.push("close");
      }),
    };
    const userQueue: DrainableQueue = {
      end: vi.fn(() => {
        calls.push("end");
      }),
    };

    await drainQuery({ q, userQueue, logErr: noopLog });

    // The whole point of the fix: the SDK query is closed (which reaps the CLI
    // child) — not left running while the process exits. interrupt MUST precede
    // close, and the parked queue MUST be released so nothing keeps the loop alive.
    expect(calls).toEqual(["interrupt", "close", "end"]);
    expect(q.interrupt).toHaveBeenCalledTimes(1);
    expect(q.close).toHaveBeenCalledTimes(1);
    expect(userQueue.end).toHaveBeenCalledTimes(1);
  });

  it("still closes the query and ends the queue when interrupt rejects (idle turn)", async () => {
    // An interrupt against an already-idle query may reject; the drain must NOT
    // abort there — close + end still have to run or the grandchild leaks. Falsify
    // by re-throwing in drainQuery and `close`/`end` go uncalled → this goes RED.
    const calls: string[] = [];
    const q: DrainableQuery = {
      interrupt: vi.fn(async () => {
        throw new Error("turn already idle");
      }),
      close: vi.fn(() => {
        calls.push("close");
      }),
    };
    const userQueue: DrainableQueue = {
      end: vi.fn(() => {
        calls.push("end");
      }),
    };

    await expect(drainQuery({ q, userQueue, logErr: noopLog })).resolves.toBeUndefined();
    expect(calls).toEqual(["close", "end"]);
  });

  it("ends the queue even when no query exists (start never arrived)", async () => {
    // Stdin-close before any `start`: q is null. The drain must not blow up and
    // must still release the queue if one was created.
    const userQueue: DrainableQueue = { end: vi.fn() };
    await expect(
      drainQuery({ q: null, userQueue, logErr: noopLog }),
    ).resolves.toBeUndefined();
    expect(userQueue.end).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (never throws) when neither query nor queue exists", async () => {
    await expect(
      drainQuery({ q: null, userQueue: null, logErr: noopLog }),
    ).resolves.toBeUndefined();
  });
});

describe("sidecar gracefulExit — the PRIMARY `end`-command path awaits the drain before exit", () => {
  it("awaits interrupt → close → queue-end and exits ONLY after they all complete", async () => {
    // This is the `end`-command teardown path (the host's normal app-quit). The
    // old handler exited SYNCHRONOUSLY (`finally { process.exit(0) }`) with no
    // interrupt and no awaited drain — so the SDK's async child teardown could be
    // cut off and the `claude` grandchild orphaned. The fix routes `end` through
    // this awaited gracefulExit. We assert exit is the LAST call, after the full
    // drain. Falsify by exiting before/without awaiting the drain (e.g. a sync
    // `process.exit`) and "exit" no longer trails interrupt/close/end → RED.
    const calls: string[] = [];
    let interruptResolved = false;
    const q: DrainableQuery = {
      interrupt: vi.fn(async () => {
        // Defer a tick so a non-awaited exit would race AHEAD of this resolving.
        await Promise.resolve();
        interruptResolved = true;
        calls.push("interrupt");
      }),
      close: vi.fn(() => calls.push("close")),
    };
    const userQueue: DrainableQueue = { end: vi.fn(() => calls.push("end")) };

    const exit = vi.fn((_code: number) => {
      calls.push("exit");
      // The drain MUST be fully done before exit — interrupt resolved, all steps ran.
      expect(interruptResolved).toBe(true);
      return undefined as never;
    });

    const gracefulExit = makeGracefulExit({
      getQ: () => q,
      getUserQueue: () => userQueue,
      logErr: noopLog,
      exit,
    });

    await gracefulExit("end command", 0);

    expect(calls).toEqual(["interrupt", "close", "end", "exit"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second trigger during the first drain does NOT double-drain or double-exit", async () => {
    // SIGTERM arriving while the `end`-command drain is in flight (or vice-versa)
    // must be ignored. Falsify by dropping the `shuttingDown` latch and interrupt/
    // exit fire twice → RED.
    let resolveInterrupt!: () => void;
    const q: DrainableQuery = {
      interrupt: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveInterrupt = r;
          }),
      ),
      close: vi.fn(),
    };
    const userQueue: DrainableQueue = { end: vi.fn() };
    const exit = vi.fn((_code: number) => undefined as never);

    const gracefulExit = makeGracefulExit({
      getQ: () => q,
      getUserQueue: () => userQueue,
      logErr: noopLog,
      exit,
    });

    // First trigger parks awaiting interrupt; second trigger lands mid-drain.
    const first = gracefulExit("end command", 0);
    const second = gracefulExit("SIGTERM", 0); // must be an immediate no-op.
    await second; // resolves instantly (early return), drain still parked.

    expect(q.interrupt).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    resolveInterrupt(); // let the first drain complete.
    await first;

    expect(q.interrupt).toHaveBeenCalledTimes(1);
    expect(q.close).toHaveBeenCalledTimes(1);
    expect(userQueue.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("reads the LIVE q/userQueue via getters (a session that started after wiring is still drained)", async () => {
    // q/userQueue are null until `start` arrives; the handlers are wired at boot.
    // gracefulExit must read them at DRAIN time, not capture the boot-time null.
    let liveQ: DrainableQuery | null = null;
    let liveQueue: DrainableQueue | null = null;
    const exit = vi.fn((_code: number) => undefined as never);
    const gracefulExit = makeGracefulExit({
      getQ: () => liveQ,
      getUserQueue: () => liveQueue,
      logErr: noopLog,
      exit,
    });

    // Session starts AFTER gracefulExit is constructed.
    liveQ = { interrupt: vi.fn(async () => {}), close: vi.fn() };
    liveQueue = { end: vi.fn() };

    await gracefulExit("end command", 0);

    expect(liveQ.interrupt).toHaveBeenCalledTimes(1);
    expect(liveQ.close).toHaveBeenCalledTimes(1);
    expect(liveQueue.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
