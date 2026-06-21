// Conversation domain (Phase 5) — quota auto-resume banner tests (jsdom, falsifiable).
//
// Covers the SINGLE quota-banner node end to end:
//   - render: a WAITING node draws a .conv-qb-countdown + the "armed · N left" pill + NO Resume button;
//     an EXHAUSTED node draws the Cancel button + next-reset + NO auto-resume note.
//   - countdown: the displayed value is driven by WALL-CLOCK (resetAt - Date.now()), not a frozen
//     decrement; after resetAt it clamps at 00:00:00.
//   - interval leak: re-rendering never leaves more than ONE live interval (cleared on rebuild/teardown).
//   - singleton: a second pause UPDATES the same banner (waiting -> exhausted) rather than appending a
//     duplicate; a resume CLEARS it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// links.ts (reached transitively via render → markdown → links) imports openUrl at module load.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { ConversationModel } from "./stream";
import { renderTree, teardownQuotaCountdown, formatCountdown } from "./render";

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  // Always stop the lone countdown interval so a test's banner can't tick into the next test.
  teardownQuotaCountdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(m: ConversationModel): void {
  renderTree(host, m.derive(), { onCancelSession: () => {} });
}

describe("quota banner — WAITING render", () => {
  it("renders a live countdown + the armed-N-left pill + NO Resume button", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({
      state: "waiting",
      resetAt: Date.now() + 3_600_000,
      remaining: 1,
      source: "retry-after",
    });
    render(m);

    const banner = host.querySelector(".conv-quota-banner")!;
    expect(banner).toBeTruthy();
    expect((banner as HTMLElement).dataset.state).toBe("waiting");
    // The countdown element exists.
    expect(banner.querySelector(".conv-qb-countdown")).toBeTruthy();
    // The "armed · N left" pill is present and reflects the remaining count.
    const pill = banner.querySelector(".conv-qb-pill")!;
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain("armed");
    expect(pill.textContent).toContain("1 attempt");
    // The auto-resume note is present in the waiting state.
    expect(banner.querySelector(".conv-qb-auto-note")).toBeTruthy();
    // FALSIFICATION TARGET: there is NO Resume button anywhere in the waiting banner.
    const buttons = Array.from(banner.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").toLowerCase(),
    );
    expect(buttons.some((t) => t.includes("resume"))).toBe(false);
  });

  it("pluralizes the pill ('attempts') for remaining !== 1", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({
      state: "waiting",
      resetAt: Date.now() + 3_600_000,
      remaining: 2,
      source: "retry-after",
    });
    render(m);
    expect(host.querySelector(".conv-qb-pill")!.textContent).toContain("2 attempts");
  });
});

describe("quota banner — EXHAUSTED render", () => {
  it("renders a Cancel button + next-reset and NO auto-resume note (no countdown)", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({
      state: "exhausted",
      resetAt: Date.now() + 3_600_000,
      remaining: 0,
      source: "retry-after",
    });
    render(m);

    const banner = host.querySelector(".conv-quota-banner")!;
    expect((banner as HTMLElement).dataset.state).toBe("exhausted");
    // The next-reset clock line is present.
    const refresh = banner.querySelector(".conv-qb-refresh-at")!;
    expect(refresh).toBeTruthy();
    expect(refresh.textContent).toContain("Next reset");
    // A Cancel-session button exists.
    const cancel = banner.querySelector(".conv-qb-cancel")!;
    expect(cancel).toBeTruthy();
    expect(cancel.textContent).toBe("Cancel session");
    // NO auto-resume note + NO countdown in the exhausted state.
    expect(banner.querySelector(".conv-qb-auto-note")).toBeNull();
    expect(banner.querySelector(".conv-qb-countdown")).toBeNull();
  });

  it("invokes onCancelSession when the Cancel button is clicked", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({
      state: "exhausted",
      resetAt: Date.now() + 1000,
      remaining: 0,
      source: "retry-after",
    });
    const onCancel = vi.fn();
    renderTree(host, m.derive(), { onCancelSession: onCancel });
    host.querySelector<HTMLButtonElement>(".conv-qb-cancel")!.click();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("quota banner — wall-clock countdown", () => {
  it("formatCountdown is wall-clock and clamps at 00:00:00", () => {
    expect(formatCountdown(3_661_000)).toBe("01:01:01");
    expect(formatCountdown(0)).toBe("00:00:00");
    // Past reset → clamped, never negative.
    expect(formatCountdown(-5000)).toBe("00:00:00");
  });

  it("the displayed countdown reflects TRUE remaining as Date.now() advances (not a frozen decrement)", () => {
    vi.useFakeTimers();
    const start = 1_000_000_000_000;
    vi.setSystemTime(start);
    const resetAt = start + 3_600_000; // 01:00:00 out

    const m = new ConversationModel();
    m.appendQuotaBanner({ state: "waiting", resetAt, remaining: 1, source: "retry-after" });
    render(m);

    const countdown = host.querySelector(".conv-qb-countdown")!;
    expect(countdown.textContent).toBe("01:00:00");

    // Jump the WALL CLOCK forward ~30 minutes, then fire ONE 1s tick (which lands at exactly
    // start + 30min). A frozen-decrement implementation would show ~59:59 (one second elapsed since
    // render); a wall-clock one reads resetAt - now and shows 30:00.
    vi.setSystemTime(start + 30 * 60_000 - 1000);
    vi.advanceTimersByTime(1000); // fires the tick at start + 30min
    expect(countdown.textContent).toBe("00:30:00");

    // Past the reset → clamps at zero.
    vi.setSystemTime(resetAt + 10_000 - 1000);
    vi.advanceTimersByTime(1000);
    expect(countdown.textContent).toBe("00:00:00");
  });

  it("recomputes immediately on visibilitychange (un-occlusion), not only on the next tick", () => {
    vi.useFakeTimers();
    const start = 2_000_000_000_000;
    vi.setSystemTime(start);
    const resetAt = start + 3_600_000;

    const m = new ConversationModel();
    m.appendQuotaBanner({ state: "waiting", resetAt, remaining: 1, source: "retry-after" });
    render(m);
    const countdown = host.querySelector(".conv-qb-countdown")!;
    expect(countdown.textContent).toBe("01:00:00");

    // Advance wall clock WITHOUT firing a timer tick (simulating a throttled/suspended interval),
    // then dispatch visibilitychange while visible → the handler recomputes immediately.
    vi.setSystemTime(start + 15 * 60_000);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(countdown.textContent).toBe("00:45:00");
  });
});

describe("quota banner — single interval, no leak", () => {
  it("re-rendering does not accumulate intervals (one created per rebuild, prior cleared)", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const m = new ConversationModel();
    m.appendQuotaBanner({
      state: "waiting",
      resetAt: Date.now() + 3_600_000,
      remaining: 1,
      source: "retry-after",
    });

    render(m); // rebuild #1 — arms 1 interval
    render(m); // rebuild #2 — must clear #1's interval, arm 1 new one
    render(m); // rebuild #3 — same

    // 3 intervals created, but at least 2 cleared (one before each re-arm) — so at most 1 is live.
    expect(setSpy).toHaveBeenCalledTimes(3);
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Teardown clears the lone remaining interval.
    teardownQuotaCountdown();
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("rendering a tree with NO waiting banner clears a previously-armed interval", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const m = new ConversationModel();
    m.appendQuotaBanner({
      state: "waiting",
      resetAt: Date.now() + 3_600_000,
      remaining: 1,
      source: "retry-after",
    });
    render(m); // arms an interval

    // Resume clears the banner → next render has no waiting banner → interval must be torn down.
    m.clearQuotaBanner();
    render(m);
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(host.querySelector(".conv-quota-banner")).toBeNull();
  });
});

describe("quota banner — singleton model semantics", () => {
  it("a second pause UPDATES the same node (waiting -> exhausted), never a duplicate", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({ state: "waiting", resetAt: Date.now() + 1000, remaining: 1, source: "s" });
    m.updateQuotaBanner({ state: "exhausted", resetAt: Date.now() + 2000, remaining: 0, source: "s" });

    const tree = m.derive();
    const banners = tree.nodes.filter((n) => n.type === "quota-banner");
    expect(banners).toHaveLength(1);
    expect((banners[0] as { state: string }).state).toBe("exhausted");
  });

  it("clearQuotaBanner removes the node from the derived tree (resume)", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({ state: "waiting", resetAt: Date.now() + 1000, remaining: 1, source: "s" });
    m.clearQuotaBanner();
    const tree = m.derive();
    expect(tree.nodes.filter((n) => n.type === "quota-banner")).toHaveLength(0);
  });

  it("the banner NEVER flips complete/session state (pure render row)", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({ state: "waiting", resetAt: Date.now() + 1000, remaining: 1, source: "s" });
    const tree = m.derive();
    expect(tree.complete).toBe(false);
    // No working indicator is implied by the banner alone (no active turn).
    expect(tree.working).toBeNull();
  });
});
