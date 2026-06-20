// Agent SDK sidecar — pure `resume` decision.
//
// Extracted from index.ts (like session-start.ts) so the resume-vs-fall-back rule is
// UNIT-TESTABLE without importing index.ts's top-level side effects. NO module-level
// state — the decision is a pure function of (sessionInfoExists, resumeRequested).
//
// Phase 4 wiring: the host may ask to resume an SDK conversation by session id. Before
// passing `resume` to the SDK we pre-flight `getSessionInfo(id)`: if the transcript is
// missing/expired (getSessionInfo throws or returns undefined → sessionInfoExists=false)
// we DROP the resume and run the current step fresh, emitting a non-fatal `resume_fallback`
// frame. The decision below encodes exactly that, with a single-fallback guard upstream.

// The non-fatal reason surfaced on a `resume_fallback` frame when the requested
// transcript could not be found. Stable wording so the host toast is predictable.
export const RESUME_FALLBACK_REASON = "transcript missing/expired";

export type ResumeDecision =
  // resume — the transcript exists; pass `resume` to the SDK.
  | { kind: "resume" }
  // fresh — either no resume was requested, or the transcript is gone. When
  // `fallback` is true the host must emit a non-fatal `resume_fallback` frame
  // (a resume WAS requested but the transcript was missing); when false this is
  // an ordinary fresh start (no resume requested), no frame.
  | { kind: "fresh"; fallback: boolean };

// Decide whether to resume the SDK transcript or fall back to a fresh run.
//   resumeRequested=false             → fresh, no fallback frame (ordinary start)
//   resumeRequested=true, exists=true → resume
//   resumeRequested=true, exists=false→ fresh + fallback (emit resume_fallback)
export function decideResume(
  sessionInfoExists: boolean,
  resumeRequested: boolean,
): ResumeDecision {
  if (!resumeRequested) return { kind: "fresh", fallback: false };
  if (sessionInfoExists) return { kind: "resume" };
  return { kind: "fresh", fallback: true };
}

// PURE: produce the SDK `resume` option for spreading into query options.
// KEY-OMISSION is the load-bearing property: when no resume id is set the result
// is `{}` (the `resume` key never appears — never `{ resume: undefined }`), so a
// fresh start carries no resume; when set, the result is `{ resume }`. Extracted
// from index.ts's buildOptions so it is unit-testable without the side-effectful
// embedded-CLI extraction / module singletons.
export function resumeOption(resume: string | undefined): { resume?: string } {
  return resume ? { resume } : {};
}
