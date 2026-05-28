import { describe, it, expect, vi } from "vitest";

import {
  resolveCwds,
  stemsNeedingResolution,
  MAX_RESOLVE_ATTEMPTS,
  type ResolvableRecord,
} from "./resolve";
import { asStem, type Stem } from "./types";

function rec(stem: string, cwd: string | null = null): ResolvableRecord {
  return { filename_stem: asStem(stem), cwd };
}

describe("stemsNeedingResolution — pure selection", () => {
  it("selects stems with no backend cwd that are neither in-flight nor terminal", () => {
    // c is resolved-unknown AND at the attempt cap ⇒ terminal (excluded). a is fresh.
    const records = [rec("a"), rec("b", "/has/cwd"), rec("c"), rec("a")];
    const cwdByStem = new Map<Stem, string | null>([[asStem("c"), null]]);
    const attempted = new Set<Stem>();
    const counts = new Map<Stem, number>([[asStem("c"), MAX_RESOLVE_ATTEMPTS]]);
    expect(stemsNeedingResolution(records, cwdByStem, attempted, counts)).toEqual([asStem("a")]);
  });

  it("excludes stems currently in-flight (in `attempted`) this session", () => {
    const records = [rec("a"), rec("b")];
    const attempted = new Set<Stem>([asStem("a")]);
    expect(
      stemsNeedingResolution(records, new Map(), attempted, new Map()),
    ).toEqual([asStem("b")]);
  });

  it("RE-INCLUDES a null-resolved stem while it is under the attempt cap", () => {
    // BUG-2 core: a `null` (unknown) result that is below the cap must remain eligible so a
    // transcript appearing seconds later can be picked up. Falsifiable: if `null` were
    // permanently terminal (the old bug), this would be [] and the assertion fails.
    const records = [rec("late")];
    const cwdByStem = new Map<Stem, string | null>([[asStem("late"), null]]);
    const attempted = new Set<Stem>();
    const counts = new Map<Stem, number>([[asStem("late"), 1]]); // 1 < cap
    expect(stemsNeedingResolution(records, cwdByStem, attempted, counts)).toEqual([asStem("late")]);
  });

  it("EXCLUDES a null-resolved stem once it reaches the attempt cap (pinned unknown)", () => {
    const records = [rec("gone")];
    const cwdByStem = new Map<Stem, string | null>([[asStem("gone"), null]]);
    const attempted = new Set<Stem>();
    const counts = new Map<Stem, number>([[asStem("gone"), MAX_RESOLVE_ATTEMPTS]]);
    expect(stemsNeedingResolution(records, cwdByStem, attempted, counts)).toEqual([]);
  });

  it("EXCLUDES a stem already resolved to a path (success is terminal, never re-attempted)", () => {
    const records = [rec("ok")];
    const cwdByStem = new Map<Stem, string | null>([[asStem("ok"), "/resolved/cwd"]]);
    // Even with attempt count 0 (well under the cap) a non-null resolution is terminal.
    expect(
      stemsNeedingResolution(records, cwdByStem, new Set(), new Map()),
    ).toEqual([]);
  });
});

describe("resolveCwds — retry policy", () => {
  it("records resolved cwds; KEEPS a path-resolved stem attempted, RELEASES a null stem under the cap", async () => {
    const cwdByStem = new Map<Stem, string | null>();
    const attempted = new Set<Stem>();
    const counts = new Map<Stem, number>();
    const invokeResolve = vi.fn(async () => ({ a: "/cwd/a", b: null }));

    const ran = await resolveCwds([rec("a"), rec("b")], cwdByStem, attempted, invokeResolve, counts);

    expect(ran).toBe(true);
    expect(invokeResolve).toHaveBeenCalledTimes(1);
    expect(cwdByStem.get(asStem("a"))).toBe("/cwd/a");
    expect(cwdByStem.get(asStem("b"))).toBe(null);
    expect(cwdByStem.has(asStem("b"))).toBe(true);
    // a resolved to a path → stays attempted (terminal). b resolved null under the cap →
    // released so a later event can re-attempt it.
    expect(attempted.has(asStem("a"))).toBe(true);
    expect(attempted.has(asStem("b"))).toBe(false);
    expect(counts.get(asStem("a"))).toBe(1);
    expect(counts.get(asStem("b"))).toBe(1);
  });

  it("UN-attempts AND un-counts stems when the invoke THROWS, so they retry next time", async () => {
    const cwdByStem = new Map<Stem, string | null>();
    const attempted = new Set<Stem>();
    const counts = new Map<Stem, number>();
    const failing = vi.fn(async () => {
      throw new Error("backend unavailable");
    });

    const ran = await resolveCwds([rec("a"), rec("b")], cwdByStem, attempted, failing, counts);

    expect(ran).toBe(false);
    expect(cwdByStem.has(asStem("a"))).toBe(false);
    expect(cwdByStem.has(asStem("b"))).toBe(false);
    // Not left in `attempted`, and the attempt-count bump is rolled back (a transient error
    // must not burn one of the bounded attempts).
    expect(attempted.has(asStem("a"))).toBe(false);
    expect(attempted.has(asStem("b"))).toBe(false);
    expect(counts.get(asStem("a")) ?? 0).toBe(0);
    expect(counts.get(asStem("b")) ?? 0).toBe(0);

    // Simulate the retry succeeding on the next plan-changed.
    const ok = vi.fn(async () => ({ a: "/cwd/a", b: "/cwd/b" }));
    const ranAgain = await resolveCwds([rec("a"), rec("b")], cwdByStem, attempted, ok, counts);
    expect(ranAgain).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(cwdByStem.get(asStem("a"))).toBe("/cwd/a");
    expect(cwdByStem.get(asStem("b"))).toBe("/cwd/b");
  });

  it("does nothing (no invoke) when there is nothing to resolve", async () => {
    const invokeResolve = vi.fn(async () => ({}));
    const ran = await resolveCwds(
      [rec("a", "/has/cwd")],
      new Map(),
      new Set(),
      invokeResolve,
      new Map(),
    );
    expect(ran).toBe(false);
    expect(invokeResolve).not.toHaveBeenCalled();
  });

  it("BUG-2: a null result is RE-ATTEMPTED across events up to the cap, then pinned (no further invoke)", async () => {
    // The end-to-end retry loop a `plan-changed` burst drives. A stem that keeps coming back
    // `null` must be retried MAX_RESOLVE_ATTEMPTS times — picking up a transcript that lands
    // late — and then stop. Falsifiable: if `null` were permanently terminal (old bug), the
    // very first call would pin it and `invoke` would run exactly ONCE, failing the count
    // assertion below.
    const cwdByStem = new Map<Stem, string | null>();
    const attempted = new Set<Stem>();
    const counts = new Map<Stem, number>();
    const alwaysNull = vi.fn(async () => ({ late: null }));

    // Drive one resolution per simulated plan-changed event, more than the cap.
    for (let i = 0; i < MAX_RESOLVE_ATTEMPTS + 2; i++) {
      await resolveCwds([rec("late")], cwdByStem, attempted, alwaysNull, counts);
    }

    // The backend was hit exactly the capped number of times — re-attempted, then pinned.
    expect(alwaysNull).toHaveBeenCalledTimes(MAX_RESOLVE_ATTEMPTS);
    expect(counts.get(asStem("late"))).toBe(MAX_RESOLVE_ATTEMPTS);
    // At the cap the stem is terminal: still recorded null, kept attempted (pinned "unknown").
    expect(cwdByStem.get(asStem("late"))).toBe(null);
    expect(attempted.has(asStem("late"))).toBe(true);
    expect(stemsNeedingResolution([rec("late")], cwdByStem, attempted, counts)).toEqual([]);
  });

  it("BUG-2: a late transcript resolves a previously-null stem on a re-attempt before the cap", async () => {
    // Models the exact scenario in the bug: first event resolves null (transcript not written
    // yet), a later event resolves the real cwd. Must succeed, not be stuck on "unknown".
    const cwdByStem = new Map<Stem, string | null>();
    const attempted = new Set<Stem>();
    const counts = new Map<Stem, number>();

    const firstNull = vi.fn(async () => ({ late: null }));
    await resolveCwds([rec("late")], cwdByStem, attempted, firstNull, counts);
    expect(cwdByStem.get(asStem("late"))).toBe(null);
    // Released for re-attempt (under the cap).
    expect(attempted.has(asStem("late"))).toBe(false);

    const nowResolves = vi.fn(async () => ({ late: "/real/cwd" }));
    const ran = await resolveCwds([rec("late")], cwdByStem, attempted, nowResolves, counts);
    expect(ran).toBe(true);
    expect(nowResolves).toHaveBeenCalledTimes(1);
    expect(cwdByStem.get(asStem("late"))).toBe("/real/cwd");
    // Now terminal — no further attempts.
    expect(stemsNeedingResolution([rec("late")], cwdByStem, attempted, counts)).toEqual([]);
  });
});
