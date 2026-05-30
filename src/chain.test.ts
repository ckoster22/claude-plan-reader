import { describe, it, expect, vi, beforeEach } from "vitest";

// chainHandler lives in main.ts, which pulls in the Tauri APIs and the render facade at load.
// Mock them so importing the module is a no-op (it only registers a DOMContentLoaded listener,
// which never fires under vitest). We exercise the real chainHandler, not a copy of the pattern.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./render", () => ({ renderInto: vi.fn(), settle: vi.fn(), clearAllComments: vi.fn() }));
vi.mock("./render/scroll", () => ({ captureAnchor: vi.fn(), applyDelta: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { chainHandler } from "./main";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("chainHandler — self-healing serialized chain", () => {
  it("runs the next body even after a previous body REJECTS (chain not wedged)", async () => {
    // BUG-1 follow-on: without the .catch backstop, a rejected body leaves the chain
    // permanently rejected and every subsequent event is silently dropped. Falsifiable: drop
    // the .catch in chainHandler and `ran` stays false (the second body never runs).
    let pending: Promise<void> = Promise.resolve();

    const failing = vi.fn(async () => {
      throw new Error("handler blew up");
    });
    pending = chainHandler(pending, failing);

    let ran = false;
    const next = vi.fn(async () => {
      ran = true;
    });
    pending = chainHandler(pending, next);

    await pending;

    expect(failing).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ran).toBe(true);
  });

  it("the returned promise RESOLVES (never rejects) when a body rejects", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const tail = chainHandler(Promise.resolve(), failing);
    // If the .catch were absent, awaiting `tail` would throw and this expect would fail.
    await expect(tail).resolves.toBeUndefined();
  });

  it("preserves serial ordering: bodies run in append order, one at a time", async () => {
    const order: number[] = [];
    let release1!: () => void;
    const gate1 = new Promise<void>((r) => {
      release1 = r;
    });

    let pending: Promise<void> = Promise.resolve();
    const first = vi.fn(async () => {
      await gate1; // block until released
      order.push(1);
    });
    const second = vi.fn(async () => {
      order.push(2);
    });
    pending = chainHandler(pending, first);
    pending = chainHandler(pending, second);

    // second must NOT have run while first is blocked.
    await Promise.resolve();
    expect(order).toEqual([]);

    release1();
    await pending;
    expect(order).toEqual([1, 2]); // first finishes before second starts
  });
});
