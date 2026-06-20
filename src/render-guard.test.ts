import { describe, it, expect } from "vitest";

import { RenderGuard, isLatestGeneration } from "./render-guard";

describe("isLatestGeneration — pure bail-out decision", () => {
  it("is true only when the captured generation equals the current one", () => {
    expect(isLatestGeneration(1, 1)).toBe(true);
  });

  it("is false once a newer generation has begun (captured is stale)", () => {
    // BUG-1 core: a render that captured gen 1 must bail after its awaits if gen 2 began.
    // Falsifiable: if the guard returned true unconditionally (renders unconditional, the
    // bug), this would be true and the assertion fails.
    expect(isLatestGeneration(1, 2)).toBe(false);
  });
});

describe("RenderGuard", () => {
  it("hands out strictly increasing tokens", () => {
    const g = new RenderGuard();
    const a = g.begin();
    const b = g.begin();
    const c = g.begin();
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("only the most-recent token is current; earlier tokens are superseded", () => {
    const g = new RenderGuard();
    const first = g.begin();
    expect(g.isCurrent(first)).toBe(true);
    const second = g.begin();
    expect(g.isCurrent(first)).toBe(false); // superseded
    expect(g.isCurrent(second)).toBe(true);
  });
});

// ---- Real overlap simulation ----------------------------------------------------------
//
// Reproduces the open/reload race WITHOUT main.ts's top-level wiring by running two render
// bodies that mirror reloadOpenPlan's structure: begin() → await read → (guard) mutate pane
// → await settle → (guard) mutate pane. We start render A, let it begin and block on its
// read, then start render B (newer). Whichever resolves last must NOT clobber the pane: only
// B's content may land. This is the exact stale-render-lands-late failure of BUG-1.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A guarded render body shaped like reloadOpenPlan/openPlan: it only writes `content` into
// `pane` if its generation is still current after EACH await. Returns the value it wrote (or
// null if it bailed) for assertion clarity.
async function guardedRender(
  guard: RenderGuard,
  pane: { content: string | null },
  content: string,
  readDone: Promise<void>,
  settleDone: Promise<void>,
): Promise<string | null> {
  const gen = guard.begin();
  await readDone;
  if (!guard.isCurrent(gen)) return null; // superseded while reading → bail
  pane.content = content; // first mutation (renderInto + applyDelta)
  await settleDone;
  if (!guard.isCurrent(gen)) return null; // superseded during settle → bail
  pane.content = content; // second mutation (post-settle applyDelta)
  return content;
}

describe("RenderGuard — overlapping render race", () => {
  it("a slower OLDER render does not clobber a newer one (newest content wins)", async () => {
    const guard = new RenderGuard();
    const pane = { content: null as string | null };

    const aRead = defer<void>();
    const aSettle = defer<void>();
    const bRead = defer<void>();
    const bSettle = defer<void>();

    // Render A starts first and begins (gen 1), then blocks on its read.
    const aPromise = guardedRender(guard, pane, "A", aRead.promise, aSettle.promise);
    await Promise.resolve(); // let A's begin() run

    // Render B starts and begins (gen 2) — supersedes A.
    const bPromise = guardedRender(guard, pane, "B", bRead.promise, bSettle.promise);
    await Promise.resolve();

    // B completes fully first: its content lands.
    bRead.resolve();
    bSettle.resolve();
    expect(await bPromise).toBe("B");
    expect(pane.content).toBe("B");

    // Now the OLDER render A's awaits finally resolve LATE. It must bail at the first guard
    // check and never overwrite the pane.
    aRead.resolve();
    aSettle.resolve();
    expect(await aPromise).toBe(null); // A bailed
    expect(pane.content).toBe("B"); // newest content survives
  });

  it("a render superseded DURING settle does not run its second pane mutation", async () => {
    const guard = new RenderGuard();
    const pane = { content: null as string | null };

    const aRead = defer<void>();
    const aSettle = defer<void>();

    // A begins (gen 1), reads, writes its first mutation, then blocks in settle.
    const aPromise = guardedRender(guard, pane, "A", aRead.promise, aSettle.promise);
    await Promise.resolve();
    aRead.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pane.content).toBe("A"); // first mutation landed (it was current then)

    // A newer render B begins (gen 2) while A is still in settle, completes immediately.
    const bRead = defer<void>();
    const bSettle = defer<void>();
    const bPromise = guardedRender(guard, pane, "B", bRead.promise, bSettle.promise);
    await Promise.resolve();
    bRead.resolve();
    bSettle.resolve();
    expect(await bPromise).toBe("B");
    expect(pane.content).toBe("B");

    // A's settle now resolves late: its SECOND mutation must be skipped (guard not current).
    aSettle.resolve();
    expect(await aPromise).toBe(null);
    expect(pane.content).toBe("B");
  });
});
