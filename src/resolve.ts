// Sub-Plan 03 — testable core of the post-list cwd resolution + retry policy.
//
// Extracted from `main.ts` so the "thrown error stays retryable, null result re-attempts a
// bounded number of times then pins unknown" policy is unit-testable without the DOM. The
// caller supplies the session collections (the resolved-cwd cache, the in-flight guard, and
// the per-stem attempt counter) and an `invoke` shim, so the pure decision + the
// rollback-on-throw + bounded-re-attempt behaviors can be exercised in isolation.

import { asStem, cwdState, setCwd, type PlanRecord, type Stem } from "./types";

/** Minimal shape this module needs from a plan record. */
export type ResolvableRecord = Pick<PlanRecord, "filename_stem" | "cwd">;

/**
 * Cap on how many times a stem that keeps resolving to `null` ("unknown") is re-attempted.
 * A plan whose originating transcript is written shortly AFTER the plan file would otherwise
 * be pinned "unknown" until app restart; a bounded re-attempt lets a late transcript get
 * picked up while a genuinely-unknown plan stops rescanning after the cap (no unbounded
 * full-corpus rescans on every event).
 */
export const MAX_RESOLVE_ATTEMPTS = 3;

/**
 * Which stems still need resolving. A stem is eligible when the backend didn't already
 * supply a `cwd` AND it is not currently in-flight (`attempted`) AND it is not terminal:
 *
 *  - never seen (absent from `cwdByStem`)            ⇒ eligible (first attempt),
 *  - resolved-but-`null` under the attempt cap       ⇒ eligible (bounded re-attempt),
 *  - resolved-but-`null` at/over the attempt cap     ⇒ TERMINAL ("unknown" pinned),
 *  - resolved to a non-null path                     ⇒ TERMINAL (success is immutable).
 *
 * De-duped. Pure.
 */
export function stemsNeedingResolution(
  records: ResolvableRecord[],
  cwdByStem: Map<Stem, string | null>,
  attempted: Set<Stem>,
  attemptCounts: Map<Stem, number>,
): Stem[] {
  const wanted = records
    .filter((r) => !r.cwd)
    .map((r) => r.filename_stem)
    .filter((stem) => !attempted.has(stem))
    .filter((stem) => {
      const s = cwdState(cwdByStem, stem);
      if (s.state === "unresolved") return true; // never resolved → first attempt
      // Recorded already: only a `null` (unknown) result under the cap is re-attemptable;
      // a resolved path, or a `null` at/over the cap, is terminal.
      if (s.state === "resolved") return false; // resolved to a path → terminal
      // s.state === "unknown" (null): re-attemptable only while under the cap.
      return (attemptCounts.get(stem) ?? 0) < MAX_RESOLVE_ATTEMPTS;
    });
  return Array.from(new Set(wanted));
}

/**
 * Resolve the still-unknown stems via `invoke`, recording results into `cwdByStem`.
 *
 * Retry policy:
 *  - stems are marked attempted (in-flight) BEFORE the call (so a stream of `plan-changed`
 *    events doesn't re-trigger a corpus rescan while one is in flight), and their attempt
 *    counter is incremented,
 *  - on a THROWN (recoverable) error the just-added stems are REMOVED from `attempted` AND
 *    their attempt-count increment is rolled back, so the next `plan-changed` retries them —
 *    they would otherwise render empty forever and a transient error must not burn an attempt,
 *  - a successful resolve to a path is terminal (stays out of future selection),
 *  - a `null` *result* is recorded as "resolved but unknown" but is RE-ATTEMPTED on later
 *    events until the per-stem attempt cap, after which it is pinned "unknown". The in-flight
 *    guard is released for re-attemptable `null` stems so a future event can pick them up;
 *    stems that resolved to a path (or hit the cap) stay in `attempted`.
 *
 * Returns `true` iff a resolve actually ran and recorded results (so the caller can patch the
 * DOM); `false` when there was nothing to resolve or the call threw.
 */
export async function resolveCwds(
  records: ResolvableRecord[],
  cwdByStem: Map<Stem, string | null>,
  attempted: Set<Stem>,
  invokeResolve: (stems: Stem[]) => Promise<Record<string, string | null>>,
  attemptCounts: Map<Stem, number>,
): Promise<boolean> {
  const stems = stemsNeedingResolution(records, cwdByStem, attempted, attemptCounts);
  if (stems.length === 0) return false;

  for (const s of stems) {
    attempted.add(s);
    attemptCounts.set(s, (attemptCounts.get(s) ?? 0) + 1);
  }

  let resolved: Record<string, string | null>;
  try {
    resolved = await invokeResolve(stems);
  } catch (e) {
    console.error("resolve_cwds failed", e);
    // Recoverable error: un-attempt these stems AND undo the attempt-count bump so the next
    // plan-changed retries them without a transient error consuming a bounded attempt.
    for (const s of stems) {
      attempted.delete(s);
      attemptCounts.set(s, (attemptCounts.get(s) ?? 1) - 1);
    }
    return false;
  }

  // Record results (incl. null = resolved-but-unknown) so re-renders show them immediately.
  for (const [stemStr, cwd] of Object.entries(resolved)) {
    const stem = asStem(stemStr);
    setCwd(cwdByStem, stem, cwd);
    // A `null` result that is still under the attempt cap must be re-attemptable on a later
    // event (a transcript may appear shortly), so release the in-flight guard for it. Once it
    // reaches the cap (or resolved to a path), it stays attempted and is terminal.
    if (cwd === null && (attemptCounts.get(stem) ?? 0) < MAX_RESOLVE_ATTEMPTS) {
      attempted.delete(stem);
    }
  }
  return true;
}
