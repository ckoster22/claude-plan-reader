// Exponential backoff schedule for transient HTTP 529 "Overloaded" errors.
// Pure module (no SDK imports) so the timing/attempt math is unit-testable —
// index.ts is not vitest-importable.

export const BACKOFF_BASE_MS = 60_000; // 1 minute
export const BACKOFF_CAP_MS = 1_800_000; // 30 minutes
export const BACKOFF_MAX_RETRIES = 6; // give up after the 6th retry fails

// retry is 1-based: the Nth retry after the initial failure.
export function backoffDelayMs(retry: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (retry - 1), BACKOFF_CAP_MS);
}

export type BackoffDecision =
  | { kind: "retry"; retry: number; delayMs: number; nextAttemptAtMs: number }
  | { kind: "exhausted"; retries: number };

export function decideBackoff(retry: number, nowMs: number): BackoffDecision {
  if (retry > BACKOFF_MAX_RETRIES) return { kind: "exhausted", retries: BACKOFF_MAX_RETRIES };
  const delayMs = backoffDelayMs(retry);
  return { kind: "retry", retry, delayMs, nextAttemptAtMs: nowMs + delayMs };
}
