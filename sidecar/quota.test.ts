// Falsifiable unit tests for the sidecar's PURE quota-detection module (quota.ts).
//
// THE BEHAVIOR UNDER TEST: when a live session hits an Anthropic usage/quota wall, the
// sidecar must extract a rate-limit RESET TIME (epoch-ms) so the host can pause + auto-resume
// instead of dying. Two carriers: the SDK `rate_limit_event` (structured `SDKRateLimitInfo`)
// and a thrown SDK error string (the catch-block backstop). Auth errors must NEVER be
// misclassified as quota (so an expired token still hits the fatal `auth` path).

import { describe, it, expect } from "vitest";
import {
  extractResetAt,
  parseResetFromError,
  decideRateLimitFrame,
  isUsageLimitText,
  parseClockTimeInTz,
  decideResultQuota,
} from "./quota";

// A fixed "now" well past the seconds/ms ambiguity boundary (1e12 ≈ 2001-09-09).
const NOW_MS = 1_750_000_000_000; // ~2025-06-15
const NOW_S = Math.floor(NOW_MS / 1000); // 1_750_000_000

describe("extractResetAt — structured SDKRateLimitInfo → epoch-ms reset or null", () => {
  it('status:"rejected" + resetsAt(seconds) → epoch-ms (×1000)', () => {
    // FALSIFY: drop the seconds→ms normalization → returns raw seconds (1.75e9), not 1.75e12 → RED.
    expect(extractResetAt({ status: "rejected", resetsAt: NOW_S })).toBe(NOW_S * 1000);
  });

  it('status:"rejected" + resetsAt(already ms) → unchanged epoch-ms', () => {
    // Values >= 1e12 are already ms and must NOT be multiplied again.
    expect(extractResetAt({ status: "rejected", resetsAt: NOW_MS })).toBe(NOW_MS);
  });

  it('status:"allowed" → null (no pause for a non-rejected limit)', () => {
    // FALSIFY: remove the status guard → returns a reset time → RED.
    expect(extractResetAt({ status: "allowed", resetsAt: NOW_S })).toBeNull();
  });

  it('status:"allowed_warning" → null', () => {
    expect(extractResetAt({ status: "allowed_warning", resetsAt: NOW_S })).toBeNull();
  });

  it("missing resetsAt but present overageResetsAt → overage (epoch-ms)", () => {
    // FALSIFY: remove the overage fallback → returns null → RED.
    expect(extractResetAt({ status: "rejected", overageResetsAt: NOW_S })).toBe(NOW_S * 1000);
  });

  it("prefers resetsAt over overageResetsAt when both present", () => {
    // FALSIFY: read overageResetsAt first → returns the overage value → RED.
    const r = extractResetAt({
      status: "rejected",
      resetsAt: NOW_S,
      overageResetsAt: NOW_S + 9999,
    });
    expect(r).toBe(NOW_S * 1000);
  });

  it("rejected with neither field → null (honest fallback, no guess)", () => {
    expect(extractResetAt({ status: "rejected" })).toBeNull();
  });

  it("null / non-object input → null (defensive)", () => {
    expect(extractResetAt(null)).toBeNull();
    expect(extractResetAt(undefined)).toBeNull();
    expect(extractResetAt("nope" as unknown)).toBeNull();
  });
});

describe("parseResetFromError — thrown-error text → epoch-ms reset or null", () => {
  it("epoch-seconds in message → epoch-ms", () => {
    const r = parseResetFromError(`rate limit exceeded, resets at ${NOW_S}`, NOW_MS);
    expect(r).toBe(NOW_S * 1000);
  });

  it("epoch-ms in message → unchanged epoch-ms", () => {
    const r = parseResetFromError(`429 too many requests; reset ${NOW_MS}`, NOW_MS);
    expect(r).toBe(NOW_MS);
  });

  it("ISO-8601 timestamp in message → epoch-ms", () => {
    const iso = new Date(NOW_MS).toISOString();
    const r = parseResetFromError(`usage limit; try again after ${iso}`, NOW_MS);
    expect(r).toBe(NOW_MS);
  });

  it("retry-after: <seconds> delta → now + seconds (injected now)", () => {
    // FALSIFY: treat retry-after as an absolute epoch → returns ~3600 (ms), not NOW_MS+3.6e6 → RED.
    const r = parseResetFromError("rate limited. retry-after: 3600", NOW_MS);
    expect(r).toBe(NOW_MS + 3600 * 1000);
  });

  it("auth/oauth text → null (never misclassify an auth error as quota)", () => {
    // FALSIFY: remove the auth guard → the embedded 401/epoch parses → non-null → RED.
    expect(parseResetFromError("401 unauthorized: oauth token expired", NOW_MS)).toBeNull();
    expect(parseResetFromError(`auth failed at ${NOW_S}`, NOW_MS)).toBeNull();
    expect(parseResetFromError(`invalid_token resets ${NOW_S}`, NOW_MS)).toBeNull();
  });

  it("gibberish / no parseable time → null", () => {
    expect(parseResetFromError("something went wrong", NOW_MS)).toBeNull();
    expect(parseResetFromError("", NOW_MS)).toBeNull();
  });
});

describe("decideRateLimitFrame — normalize()'s rate_limit_event decision", () => {
  it('rejected + resetsAt → quota_exceeded extra (resetAt + source)', () => {
    // FALSIFY: always return {quota:false} → no quota frame → RED.
    const d = decideRateLimitFrame({ status: "rejected", resetsAt: NOW_S });
    expect(d).toEqual({ quota: true, resetAt: NOW_S * 1000, source: "rate_limit_event" });
  });

  it('allowed_warning → label fallback (NOT a quota frame)', () => {
    // FALSIFY: return quota:true for non-rejected → RED (would change today's status behavior).
    expect(decideRateLimitFrame({ status: "allowed_warning" })).toEqual({ quota: false });
  });

  it('rejected with no reset time → label fallback (honest, no guess)', () => {
    expect(decideRateLimitFrame({ status: "rejected" })).toEqual({ quota: false });
  });
});

// ---------------------------------------------------------------------------
// PHASE 1 — isUsageLimitText: classify the result-carrier human limit string.
// The usage limit arrives as a `result` with is_error:true whose ONLY payload is the human text
// "You've hit your {session|weekly|Opus} limit · resets <h[:mm]><am|pm> (<IANA tz>)". There is no
// dedicated subtype, so this anchored classifier is the detection seam.
// ---------------------------------------------------------------------------
describe("isUsageLimitText — classify the result-carrier human limit string", () => {
  it("matches the session-limit string (binary-confirmed format)", () => {
    // FALSIFY: drop the regex / return false → RED.
    expect(
      isUsageLimitText("You've hit your session limit · resets 2:10pm (America/Chicago)"),
    ).toBe(true);
  });

  it("matches the weekly-limit variant", () => {
    expect(
      isUsageLimitText("You've hit your weekly limit · resets 11pm (America/Chicago)"),
    ).toBe(true);
  });

  it("matches the Opus-limit variant", () => {
    expect(
      isUsageLimitText("You've hit your Opus limit · resets 9am (America/New_York)"),
    ).toBe(true);
  });

  it("matches a straight-apostrophe 'Youve hit your ... limit' spelling", () => {
    // The regex tolerates a missing/curly apostrophe (you'?ve) so a CLI rendering variant still hits.
    expect(isUsageLimitText("Youve hit your usage limit, please wait")).toBe(true);
  });

  it("does NOT match an ordinary error", () => {
    // FALSIFY: loosen the anchor to /limit/i alone → "rate limit exceeded" matches → RED.
    expect(isUsageLimitText("Error: tool execution failed (exit 1)")).toBe(false);
    expect(isUsageLimitText("rate limit exceeded, try again")).toBe(false);
  });

  it("does NOT match a normal success result or non-string input", () => {
    expect(isUsageLimitText("Done. All tests pass.")).toBe(false);
    expect(isUsageLimitText("")).toBe(false);
    expect(isUsageLimitText(null)).toBe(false);
    expect(isUsageLimitText(undefined)).toBe(false);
    expect(isUsageLimitText(42 as unknown)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PHASE 2 — parseClockTimeInTz: wall-clock-in-named-tz → epoch-ms, machine-tz-INDEPENDENT.
// These tests deliberately do NOT mutate process.env.TZ at runtime (vitest's date stack is already
// loaded); instead each case anchors `nowMs` and a NAMED tz and asserts the resolved epoch-ms is the
// correct UTC instant REGARDLESS of where the machine is. The proof of machine-tz-independence is that
// the SAME named tz resolves to the SAME absolute instant whatever the host zone — verified by
// computing the expected instant from first principles (the named tz's offset), not from the host.
// ---------------------------------------------------------------------------
describe("parseClockTimeInTz — wall-clock-in-named-tz → epoch-ms (machine-tz-independent)", () => {
  // Helper: the epoch-ms of a given wall-clock in a named tz, computed independently of the parser
  // (so the test is not reverse-engineered from the implementation). Uses the same Intl inversion but
  // written out longhand here as the oracle.
  function expectedEpoch(
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
    tz: string,
  ): number {
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const read = (ms: number): number => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      let hh = Number(p.hour);
      if (hh === 24) hh = 0;
      return Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        hh,
        Number(p.minute),
        Number(p.second),
      );
    };
    const want = Date.UTC(y, mo - 1, d, h, mi, 0);
    let g = guess;
    g += want - read(g);
    g += want - read(g);
    return g;
  }

  it("resets 2:10pm (America/Chicago) WITH minutes → correct epoch-ms (CDT, future today)", () => {
    // nowMs = 2025-06-15 07:00:00 UTC = 02:00 CDT → 2:10pm CDT is later today.
    const nowMs = Date.UTC(2025, 5, 15, 7, 0, 0);
    const got = parseClockTimeInTz("resets 2:10pm (America/Chicago)", nowMs);
    // 14:10 CDT (UTC-5 in June) → expected via the independent oracle.
    expect(got).toBe(expectedEpoch(2025, 6, 15, 14, 10, "America/Chicago"));
    // Sanity: it is in the future and on the same day. FALSIFY: ignore minutes → 14:00 not 14:10 → RED.
    expect(got!).toBeGreaterThan(nowMs);
  });

  it("resets 11pm (America/Chicago) minute OMITTED → :00", () => {
    const nowMs = Date.UTC(2025, 5, 15, 7, 0, 0);
    const got = parseClockTimeInTz("resets 11pm (America/Chicago)", nowMs);
    // FALSIFY: default minute to anything but 0 → mismatch → RED.
    expect(got).toBe(expectedEpoch(2025, 6, 15, 23, 0, "America/Chicago"));
  });

  it("12am → midnight (hour 0), 12pm → noon (hour 12)", () => {
    // Use UTC tz so the wall-clock maps 1:1 to the instant — isolates the 12am/12pm normalization.
    // nowMs is just after midnight UTC so 12am today is in the past → rolls to NEXT day midnight.
    const now = Date.UTC(2025, 5, 15, 1, 0, 0);
    const am = parseClockTimeInTz("resets 12am (UTC)", now);
    // 12am today (00:00 the 15th) already passed → next-future = 00:00 the 16th.
    expect(am).toBe(Date.UTC(2025, 5, 16, 0, 0, 0));
    const pm = parseClockTimeInTz("resets 12pm (UTC)", now);
    // FALSIFY: 12pm→0 (forget the +=12) → noon would be midnight → RED.
    expect(pm).toBe(Date.UTC(2025, 5, 15, 12, 0, 0));
  });

  it("a reset time already PASSED today rolls to the next-future occurrence (>nowMs)", () => {
    // nowMs = 18:00 UTC; "resets 9am (UTC)" already passed today → next day 09:00.
    const now = Date.UTC(2025, 5, 15, 18, 0, 0);
    const got = parseClockTimeInTz("resets 9am (UTC)", now);
    // FALSIFY: drop the next-future roll → returns today 09:00 (< now) → RED (would resume into the wall).
    expect(got).toBe(Date.UTC(2025, 5, 16, 9, 0, 0));
    expect(got!).toBeGreaterThan(now);
  });

  it("DST spring-forward boundary: no off-by-one-hour (America/Chicago, 2025-03-09)", () => {
    // On 2025-03-09 the US springs forward at 02:00 local. A 3pm CDT (UTC-5) reset must resolve to
    // 20:00 UTC, NOT 21:00 (which a naive fixed-offset parser would yield). nowMs = early that day UTC.
    const now = Date.UTC(2025, 2, 9, 9, 0, 0); // 03:00 CDT (already after the spring-forward)
    const got = parseClockTimeInTz("resets 3pm (America/Chicago)", now);
    expect(got).toBe(expectedEpoch(2025, 3, 9, 15, 0, "America/Chicago"));
    // CDT is UTC-5 → 15:00 local = 20:00 UTC. FALSIFY: a single-pass / fixed-offset resolve → off by 1h → RED.
    expect(got).toBe(Date.UTC(2025, 2, 9, 20, 0, 0));
  });

  it("two-pass DST convergence: pass 2 corrects pass 1 (independent brute-force oracle, foreign machine TZ)", () => {
    // REGRESSION GUARD for the second convergence pass. The other DST cases above derive their
    // expected value from the SAME guess-and-invert algorithm as the implementation, so dropping
    // pass 2 leaves them green. This case uses a GENUINELY DIFFERENT oracle: a minute-resolution
    // brute-force scan that picks the instant whose Intl-in-tz formatting equals the wanted
    // wall-clock — it never inverts an offset, so it cannot share the impl's convergence bug.
    //
    // The case is 3:00am on America/Chicago's 2025-03-09 spring-forward day (clocks jump 02:00→03:00).
    // The impl's first guess `want` corrects, after ONE pass, to 09:00 UTC (CST side of the gap);
    // only pass 2 pulls it to the true 08:00 UTC (CDT side). So:
    //   zero-pass → 2025-03-10T03:00Z (want<now → rolls a day; wrong instant) — RED
    //   single-pass → 2025-03-09T09:00Z (off by exactly one hour) — RED
    //   two-pass → 2025-03-09T08:00Z (== brute oracle) — GREEN
    //
    // process.env.TZ is forced to a DIFFERENT zone to prove the result is machine-tz-independent:
    // a single-pass-only impl fails this REGARDLESS of where the host machine is.
    const savedTZ = process.env.TZ;
    process.env.TZ = "Asia/Kolkata"; // deliberately NOT America/Chicago and NOT UTC
    try {
      // Independent oracle: scan ±36h at minute resolution around the target day and return the
      // unique instant whose America/Chicago wall-clock equals 2025-03-09 03:00. No offset inversion.
      const bruteForceEpoch = (
        y: number,
        mo: number,
        d: number,
        h: number,
        mi: number,
        tz: string,
      ): number => {
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const center = Date.UTC(y, mo - 1, d, h, mi, 0);
        const found: number[] = [];
        for (let off = -36 * 60; off <= 36 * 60; off++) {
          const ms = center + off * 60_000;
          const p = Object.fromEntries(
            fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
          );
          let hh = Number(p.hour);
          if (hh === 24) hh = 0;
          if (
            Number(p.year) === y &&
            Number(p.month) === mo &&
            Number(p.day) === d &&
            hh === h &&
            Number(p.minute) === mi
          ) {
            found.push(ms);
          }
        }
        // The 3:00am instant exists exactly once on a spring-forward day (2:xx never occurs).
        expect(found.length).toBe(1);
        return found[0];
      };

      // nowMs = 2025-03-09 01:30 CST (07:30 UTC), before the spring-forward gap, so "today in
      // America/Chicago" is the 9th AND the 3am target is in the future (no 24h roll).
      const now = Date.UTC(2025, 2, 9, 7, 30, 0);
      const got = parseClockTimeInTz("resets 3am (America/Chicago)", now);

      const oracle = bruteForceEpoch(2025, 3, 9, 3, 0, "America/Chicago");
      expect(oracle).toBe(Date.UTC(2025, 2, 9, 8, 0, 0)); // 03:00 CDT == 08:00 UTC
      // The actual regression assertion: the two-pass parser must equal the independent oracle.
      expect(got).toBe(oracle);
    } finally {
      if (savedTZ === undefined) delete process.env.TZ;
      else process.env.TZ = savedTZ;
    }
  });

  it("garbage / unknown tz → null (ASYMMETRY: any uncertainty degrades to exhausted)", () => {
    const now = Date.UTC(2025, 5, 15, 7, 0, 0);
    // FALSIFY: swallow the Intl throw and return a host-tz guess → non-null → RED.
    expect(parseClockTimeInTz("resets 2:10pm (Not/AZone)", now)).toBeNull();
    expect(parseClockTimeInTz("resets 2:10pm (Mars/Olympus)", now)).toBeNull();
  });

  it("no regex match (missing am/pm or tz) → null", () => {
    const now = Date.UTC(2025, 5, 15, 7, 0, 0);
    expect(parseClockTimeInTz("resets soon", now)).toBeNull();
    expect(parseClockTimeInTz("resets 14:10 (America/Chicago)", now)).toBeNull(); // 24h, no am/pm
    expect(parseClockTimeInTz("resets 2:10pm", now)).toBeNull(); // no tz
  });
});

// ---------------------------------------------------------------------------
// PHASE 2 — decideResultQuota: resolve resetAt in PRIORITY ORDER (structured > string > sentinel 0).
// ---------------------------------------------------------------------------
describe("decideResultQuota — priority: structured resetsAt > string parse > sentinel 0", () => {
  const TEXT = "You've hit your session limit · resets 2:10pm (America/Chicago)";
  const nowMs = Date.UTC(2025, 5, 15, 7, 0, 0);

  it("structured lastInfo.resetsAt (rejected) WINS over the parseable string", () => {
    // The structured value is exact; it must be used even though the string is also parseable.
    // FALSIFY: parse the string first → returns the string-derived time, not NOW_S*1000 → RED.
    const out = decideResultQuota(TEXT, { status: "rejected", resetsAt: NOW_S }, nowMs);
    expect(out).toEqual({ resetAt: NOW_S * 1000, source: "result_error" });
  });

  it("no usable structured info → falls back to the parsed string time", () => {
    const out = decideResultQuota(TEXT, null, nowMs);
    expect(out.source).toBe("result_error");
    // The 2:10pm CDT instant (same as the parser test).
    expect(out.resetAt).toBe(parseClockTimeInTz(TEXT, nowMs));
    expect(out.resetAt).toBeGreaterThan(0);
  });

  it("non-rejected structured info is ignored (extractResetAt → null), string used instead", () => {
    const out = decideResultQuota(TEXT, { status: "allowed", resetsAt: NOW_S }, nowMs);
    expect(out.resetAt).toBe(parseClockTimeInTz(TEXT, nowMs));
  });

  it("no structured + UNPARSEABLE string → sentinel 0 (degraded → host routes to EXHAUSTED)", () => {
    // FALSIFY: return a non-zero guess on the degraded path → the host would arm a resume timer → RED.
    const out = decideResultQuota("You've hit your session limit, please wait", null, nowMs);
    expect(out).toEqual({ resetAt: 0, source: "result_error" });
  });
});
