// PURE quota-detection module. SDK-free + side-effect-free so it is unit-testable without
// importing index.ts (which embeds the `claude` binary via a `with { type: "file" }` import).
//
// PURPOSE: when a live session hits an Anthropic usage/quota wall, the sidecar must extract a
// rate-limit RESET TIME so the host can PAUSE + auto-resume instead of dying. There are two
// carriers, handled by the two exported parsers here:
//   1. The SDK top-level `rate_limit_event` message → `extractResetAt` reads its structured
//      `SDKRateLimitInfo` ({ status, resetsAt?, overageResetsAt?, ... }).
//   2. A thrown SDK error (the catch-block backstop) → `parseResetFromError` scrapes the
//      error text for an epoch / ISO / retry-after delta.
//
// EPOCH CONVENTION (load-bearing): every value returned by this module is epoch-MILLISECONDS.
// The SDK's sdk.d.ts does NOT document the unit of `resetsAt`/`overageResetsAt` (other epoch
// fields in the SDK — file mtime, session ctime — are explicitly documented as ms). To be safe
// against either unit, we normalize HEURISTICALLY: a value below SECONDS_MS_BOUNDARY (1e12,
// ≈ 2001-09-09 in ms / ≈ year 33658 in seconds) is interpreted as epoch-SECONDS and multiplied
// by 1000; a value at or above the boundary is already epoch-ms and passed through. Any plausible
// reset time (now-ish) is unambiguous under this rule: ~1.75e9 s vs ~1.75e12 ms.

// Below this, a positive epoch value is seconds; at/above, it is milliseconds.
const SECONDS_MS_BOUNDARY = 1e12;

/** Normalize a positive epoch number (seconds OR ms) to epoch-ms. Non-finite/<=0 → null. */
function toEpochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < SECONDS_MS_BOUNDARY ? Math.round(value * 1000) : Math.round(value);
}

// The fields we read off the SDK's `SDKRateLimitInfo`. Kept structural (not an SDK import) so
// this module stays SDK-free; index.ts passes the real `rate_limit_info` object through.
interface RateLimitInfoLike {
  status?: unknown;
  resetsAt?: unknown;
  overageResetsAt?: unknown;
}

/**
 * Extract a rate-limit reset time (epoch-MS) from the SDK's structured `SDKRateLimitInfo`.
 * Returns null unless `status === "rejected"` (an `allowed`/`allowed_warning` limit must NOT
 * pause the session). Prefers `resetsAt`; falls back to `overageResetsAt` only when `resetsAt`
 * is absent/unusable. No reset field present → null (honest fallback; the caller keeps today's
 * fatal/label-only path rather than guessing a delay).
 */
export function extractResetAt(info: unknown): number | null {
  if (info == null || typeof info !== "object") return null;
  const r = info as RateLimitInfoLike;
  if (r.status !== "rejected") return null;
  const primary = toEpochMs(r.resetsAt);
  if (primary !== null) return primary;
  return toEpochMs(r.overageResetsAt);
}

// Auth/credential errors must NEVER be treated as quota — an expired OAuth token would otherwise
// be paused-and-retried forever instead of surfacing as the fatal `auth` error it is.
//
// INTENTIONAL DIVERGENCE (NOT an exact mirror): this guard is BROADER than index.ts's catch-block
// `isAuth` (/auth|token|unauthor|401|oauth/i) — it also matches `forbidden|403|invalid[_-]?token`.
// The two are layered, not identical: index.ts's `isAuth` only decides auth-vs-maybe-quota; even
// when a `forbidden`/`403`/`invalid_token` error slips PAST it (isAuth false), it flows into
// parseResetFromError, where THIS broader guard catches it and returns null — so the error falls
// through to index.ts's fatal `sdk`/`auth` path instead of being paused-and-retried. The wider
// parser-side guard is the fail-safe; widening index.ts's isAuth to match is unnecessary for quota
// correctness (and would only change auth-vs-sdk LABELING of an already-fatal error).
const AUTH_RE = /auth|token|unauthor|401|oauth|invalid[_-]?token|forbidden|403/i;

// `retry-after: <seconds>` (or `retry_after` / `retry after`) — a RELATIVE delta in seconds.
const RETRY_AFTER_RE = /retry[\s_-]?after['"\s:=]+(\d+)/i;
// ISO-8601 timestamp (with a date + time, optional tz). Matched before bare-number parsing so an
// ISO string's embedded digits are not mistaken for an epoch.
const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
// A bare integer of >=10 digits — an epoch in seconds (~10 digits) or ms (~13 digits).
const EPOCH_RE = /\b(\d{10,16})\b/;

/**
 * Parse a rate-limit reset time (epoch-MS) from a thrown-error message string — the catch-block
 * backstop used when no structured `rate_limit_event` preceded the throw. Handles, in order:
 *   - `retry-after: <seconds>` deltas → `nowMs + seconds*1000`
 *   - ISO-8601 timestamps → `Date.parse`
 *   - bare epoch integers (seconds or ms, normalized to ms)
 * Returns null for auth/oauth-related text (so auth errors are never misclassified as quota) and
 * for any input with no parseable time. `nowMs` is injectable for deterministic delta tests.
 */
export function parseResetFromError(text: string, nowMs: number = Date.now()): number | null {
  if (typeof text !== "string" || text.length === 0) return null;
  // Auth guard FIRST: an auth error may also contain digits that look like an epoch.
  if (AUTH_RE.test(text)) return null;

  const retry = RETRY_AFTER_RE.exec(text);
  if (retry) {
    const secs = Number(retry[1]);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(nowMs + secs * 1000);
  }

  const iso = ISO_RE.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[0]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const epoch = EPOCH_RE.exec(text);
  if (epoch) {
    const ms = toEpochMs(Number(epoch[1]));
    if (ms !== null) return ms;
  }

  return null;
}

/**
 * normalize()'s decision for an SDK `rate_limit_event`. Returns whether to emit a non-fatal
 * `quota_exceeded` frame (carrying `resetAt` epoch-ms + `source`) vs. fall through to today's
 * label-only `status` behavior. Pure so the rate_limit_event branch is testable without
 * importing index.ts.
 */
export type RateLimitDecision =
  | { quota: true; resetAt: number; source: "rate_limit_event" }
  | { quota: false };

export function decideRateLimitFrame(info: unknown): RateLimitDecision {
  const resetAt = extractResetAt(info);
  if (resetAt === null) return { quota: false };
  return { quota: true, resetAt, source: "rate_limit_event" };
}

// ---------------------------------------------------------------------------
// PHASE 1 — result-carrier detection.
//
// A usage/session limit has NO dedicated result `subtype`: it arrives as a `result` with
// `is_error:true` whose ONLY payload is the human string
//   "You've hit your {session|weekly|Opus|…} limit · resets <h[:mm]><am|pm> (<IANA tz>)".
// `isUsageLimitText` is the anchored classifier the `result` branch uses to recognize that family.
// ---------------------------------------------------------------------------

// Anchored on the WHOLE "you've hit your … limit" phrase so it matches the family (session/weekly/
// Opus/usage/overage) WITHOUT matching ordinary errors that merely mention "limit" (e.g. "rate limit
// exceeded"). The apostrophe is optional (you'?ve) to tolerate curly/straight/absent renderings.
const USAGE_LIMIT_RE = /you'?ve hit your\b[^.\n]*\blimit\b/i;

/** True iff `text` is an Anthropic usage/session-limit human string (the result-carrier wall). */
export function isUsageLimitText(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return USAGE_LIMIT_RE.test(text);
}

// ---------------------------------------------------------------------------
// PHASE 2 — wall-clock-in-named-tz reset-time parser.
//
// The human string carries the reset time as "resets <h[:mm]><am|pm> (<IANA tz>)" where the tz is the
// machine's LOCAL tz. We MUST resolve that wall-clock-in-the-NAMED-tz to an absolute epoch-ms WITHOUT
// assuming the running process's tz equals the named tz (tests run under arbitrary TZ). We do this by
// INVERTING Intl.DateTimeFormat's offset: format a UTC guess back through the named-tz formatter,
// measure the delta from the wanted wall-clock, and correct — twice, so a DST boundary converges.
//
// ASYMMETRY RULE (load-bearing): ANY uncertainty (no match, unknown tz, Intl throws) returns null,
// which the caller degrades to the EXHAUSTED path. A wrong-EARLY time would resume back into the wall
// (a new loop), so null is always safer than a guess.
// ---------------------------------------------------------------------------

// "resets <hour>[:<min>] <am|pm> (<IANA tz>)" — am/pm and a parenthesized tz are BOTH required (their
// absence means we cannot resolve a real instant → null).
const RESET_CLOCK_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

// Read the wall-clock (as a UTC-encoded instant) that `ms` represents WHEN viewed in `tz`. Throws if
// the tz is unknown (Intl rejects it) — the caller treats a throw as "uncertain → null".
function wallClockOf(ms: number, tz: string): number {
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
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  // Some engines render midnight as "24" in hour12:false — normalize to 0.
  let hh = Number(parts.hour);
  if (hh === 24) hh = 0;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hh,
    Number(parts.minute),
    Number(parts.second),
  );
}

/**
 * Resolve "resets <h[:mm]><am|pm> (<IANA tz>)" → the next-future epoch-ms of that wall-clock in the
 * named tz. Machine-tz-independent (Intl offset inversion, two-pass DST-correct). Returns null on ANY
 * uncertainty (no match / unknown tz / Intl throw) — the fail-safe that degrades to exhausted.
 */
export function parseClockTimeInTz(text: unknown, nowMs: number = Date.now()): number | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const m = RESET_CLOCK_RE.exec(text);
  if (!m) return null;
  const rawHour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3].toLowerCase();
  const tz = m[4].trim();
  if (!Number.isFinite(rawHour) || rawHour < 1 || rawHour > 12) return null;
  if (minute < 0 || minute > 59) return null;
  // 12am → 0, 1–11am → as-is, 12pm → 12, 1–11pm → +12.
  let hour = rawHour % 12;
  if (ampm === "pm") hour += 12;

  try {
    // Today's Y-M-D AS SEEN IN the named tz (so "today" is the limit-holder's local today).
    const todayFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dp = Object.fromEntries(
      todayFmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
    );
    const y = Number(dp.year);
    const mo = Number(dp.month);
    const d = Number(dp.day);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;

    // The wall-clock instant we WANT (encoded as a UTC value for delta math).
    const want = Date.UTC(y, mo - 1, d, hour, minute, 0);
    // Invert the tz offset: a UTC guess, corrected by the wall-clock delta, twice (DST convergence).
    let guess = want;
    guess += want - wallClockOf(guess, tz);
    guess += want - wallClockOf(guess, tz);

    // Next-future occurrence: if already at/before now, roll forward 24h and re-resolve (re-inverting
    // so a DST transition between today and tomorrow stays correct). Bias LATER, never earlier.
    if (guess <= nowMs) {
      const wantNext = want + 24 * 60 * 60 * 1000;
      let g2 = wantNext;
      g2 += wantNext - wallClockOf(g2, tz);
      g2 += wantNext - wallClockOf(g2, tz);
      guess = g2;
    }
    if (!Number.isFinite(guess)) return null;
    return guess;
  } catch {
    // Unknown tz / Intl failure → uncertain → null (degrade to exhausted).
    return null;
  }
}

/** The result-carrier quota decision: an epoch-ms reset (or sentinel 0 when undeterminable). */
export interface ResultQuotaDecision {
  resetAt: number;
  source: "result_error";
}

/**
 * Resolve the reset time for a result-carrier usage limit, in PRIORITY ORDER:
 *   1. structured `extractResetAt(lastInfo)` — exact, no parsing (a recent rate_limit_event's resetsAt);
 *   2. the human string's clock time (`parseClockTimeInTz`);
 *   3. sentinel 0 — undeterminable → the host routes to EXHAUSTED (still stops the loop + notifies).
 */
export function decideResultQuota(
  text: unknown,
  lastInfo: unknown,
  nowMs: number = Date.now(),
): ResultQuotaDecision {
  const structured = extractResetAt(lastInfo);
  if (structured !== null) return { resetAt: structured, source: "result_error" };
  const parsed = parseClockTimeInTz(text, nowMs);
  if (parsed !== null) return { resetAt: parsed, source: "result_error" };
  return { resetAt: 0, source: "result_error" };
}
