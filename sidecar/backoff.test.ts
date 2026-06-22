// Falsifiable unit tests for the sidecar's PURE exponential-backoff module (backoff.ts).
//
// THE BEHAVIOR UNDER TEST: when a live session hits a transient HTTP 529 "Overloaded" error,
// the sidecar must retry on an exponential schedule (1m, 2m, 4m, 8m, 16m, then a 30m cap) and
// GIVE UP after the 6th retry fails — so a brief upstream overload self-heals but a sustained
// outage degrades to exhausted instead of looping forever. The delay/attempt math lives here
// (pure, no SDK imports) because index.ts is not vitest-importable.

import { describe, it, expect } from "vitest";
import {
  backoffDelayMs,
  decideBackoff,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_MAX_RETRIES,
} from "./backoff";

// A fixed "now" well past the seconds/ms ambiguity boundary (1e12 ≈ 2001-09-09).
const NOW_MS = 1_750_000_000_000; // ~2025-06-15

describe("backoffDelayMs — 1-based retry → exponential delay capped at 30m", () => {
  it("retry 1 → 60_000ms (1 minute, the base)", () => {
    // FALSIFY: change BACKOFF_BASE_MS or the exponent base → first delay != 60000 → RED.
    expect(backoffDelayMs(1)).toBe(60_000);
  });

  it("retry 2 → 120_000ms (2 minutes, base×2)", () => {
    // FALSIFY: drop the 2 ** (retry-1) doubling → 60000 not 120000 → RED.
    expect(backoffDelayMs(2)).toBe(120_000);
  });

  it("retry 3 → 240_000ms (4 minutes)", () => {
    expect(backoffDelayMs(3)).toBe(240_000);
  });

  it("retry 4 → 480_000ms (8 minutes)", () => {
    expect(backoffDelayMs(4)).toBe(480_000);
  });

  it("retry 5 → 960_000ms (16 minutes, last uncapped step)", () => {
    expect(backoffDelayMs(5)).toBe(960_000);
  });

  it("retry 6 → 1_800_000ms (30m CAP, NOT the uncapped 1_920_000)", () => {
    // FALSIFY: drop the Math.min(..., BACKOFF_CAP_MS) cap → 1_920_000 not 1_800_000 → RED.
    expect(backoffDelayMs(6)).toBe(1_800_000);
    expect(backoffDelayMs(6)).not.toBe(1_920_000);
  });

  it("the full 1..6 schedule is exactly [60000,120000,240000,480000,960000,1800000]", () => {
    // FALSIFY: any off-by-one in the exponent or a missing cap shifts one entry → RED.
    expect([1, 2, 3, 4, 5, 6].map(backoffDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000,
    ]);
  });

  it("the cumulative wait across all 6 retries === 3_660_000ms (≈ 61 minutes)", () => {
    // FALSIFY: drop the 30m cap on retry 6 → sum becomes 3_780_000 (with 1_920_000) → RED.
    const total = [1, 2, 3, 4, 5, 6].reduce((acc, r) => acc + backoffDelayMs(r), 0);
    expect(total).toBe(3_660_000);
  });
});

describe("decideBackoff — schedule a retry or declare exhausted", () => {
  it("retry 3 → full retry frame with nextAttemptAtMs = nowMs + delayMs", () => {
    // FALSIFY: forget to add delayMs to nowMs (e.g. nextAttemptAtMs: nowMs) → RED.
    expect(decideBackoff(3, NOW_MS)).toEqual({
      kind: "retry",
      retry: 3,
      delayMs: 240_000,
      nextAttemptAtMs: NOW_MS + 240_000,
    });
  });

  it("retry 6 (the capped boundary) → retry frame with the 30m delay + correct nextAttemptAtMs", () => {
    // FALSIFY: treat retry 6 as exhausted (off-by-one boundary) → kind:"exhausted" not "retry" → RED.
    expect(decideBackoff(6, NOW_MS)).toEqual({
      kind: "retry",
      retry: 6,
      delayMs: 1_800_000,
      nextAttemptAtMs: NOW_MS + 1_800_000,
    });
  });

  it("retry 1 → retry frame (the first retry is never exhausted)", () => {
    // FALSIFY: invert the boundary so retry 1 returns exhausted → RED.
    expect(decideBackoff(1, NOW_MS)).toEqual({
      kind: "retry",
      retry: 1,
      delayMs: 60_000,
      nextAttemptAtMs: NOW_MS + 60_000,
    });
  });

  it("retry 7 → exhausted (give up after the 6th retry fails), retries === 6", () => {
    // FALSIFY: loosen `retry > BACKOFF_MAX_RETRIES` to `retry > 7` → retry 7 still schedules → RED.
    expect(decideBackoff(7, NOW_MS)).toEqual({ kind: "exhausted", retries: 6 });
  });

  it("the nextAttemptAtMs is purely nowMs-relative (different now → shifts by the same delta)", () => {
    // FALSIFY: hardcode an absolute next-attempt time independent of nowMs → the two diverge → RED.
    const a = decideBackoff(2, NOW_MS);
    const b = decideBackoff(2, NOW_MS + 5_000);
    expect(a.kind).toBe("retry");
    expect(b.kind).toBe("retry");
    if (a.kind === "retry" && b.kind === "retry") {
      expect(b.nextAttemptAtMs - a.nextAttemptAtMs).toBe(5_000);
    }
  });
});

describe("exported constants — the schedule's load-bearing numbers", () => {
  it("BACKOFF_BASE_MS = 60_000, BACKOFF_CAP_MS = 1_800_000, BACKOFF_MAX_RETRIES = 6", () => {
    // FALSIFY: change any constant → the schedule shifts and the above tests would too → RED.
    expect(BACKOFF_BASE_MS).toBe(60_000);
    expect(BACKOFF_CAP_MS).toBe(1_800_000);
    expect(BACKOFF_MAX_RETRIES).toBe(6);
  });
});
