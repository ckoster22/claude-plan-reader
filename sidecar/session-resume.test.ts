// Falsifiable unit tests for the sidecar's PURE resume decision + options helper
// (session-resume.ts). Phase 4: the host may ask to resume an SDK conversation by
// session id; the sidecar pre-flights the transcript and either resumes or falls
// back to a fresh run with a non-fatal `resume_fallback` notice.
//
// index.ts's buildOptions is NOT imported here (it has side effects: embedded-CLI
// extraction + module singletons, and the vitest config excludes index.ts). The
// load-bearing resume behavior of buildOptions IS `resumeOption(start.resume)` —
// buildOptions spreads exactly this object — so testing resumeOption proves the
// "options contain resume when set / no resume key otherwise" property directly.

import { describe, it, expect } from "vitest";
import { decideResume, resumeOption, RESUME_FALLBACK_REASON } from "./session-resume";

describe("sidecar resumeOption — buildOptions' resume spread (key-omission)", () => {
  it('resume set → the object carries resume:"sess-1"', () => {
    // This is the exact object buildOptions spreads. FALSIFY: make resumeOption
    // always return {} → the resume key vanishes → RED.
    const opt = resumeOption("sess-1");
    expect(opt.resume).toBe("sess-1");
    expect(Object.prototype.hasOwnProperty.call(opt, "resume")).toBe(true);
  });

  it("resume absent → NO resume key at all (omission, never resume:undefined)", () => {
    // KEY-OMISSION is load-bearing: the SDK must not see resume:undefined. FALSIFY:
    // return { resume } unconditionally → the key appears with undefined → RED.
    const opt = resumeOption(undefined);
    expect(Object.prototype.hasOwnProperty.call(opt, "resume")).toBe(false);
    expect(opt).toEqual({});
  });

  it('empty-string resume is treated as fresh (no resume key)', () => {
    // Empty/falsey id must not resume — the start handler already maps "" → undefined,
    // but resumeOption is defensive too.
    const opt = resumeOption("");
    expect(Object.prototype.hasOwnProperty.call(opt, "resume")).toBe(false);
  });
});

describe("sidecar decideResume — resume-vs-fallback (pre-flight transcript probe)", () => {
  it("transcript missing + resume requested → fresh + fallback (emit resume_fallback)", () => {
    // The headline behavior: a stale/expired transcript must NOT abort the run; it
    // degrades to a fresh re-run WITH a non-fatal notice. FALSIFY: have the missing
    // branch return { kind:"resume" } (resume a dead transcript) → RED.
    const d = decideResume(false, true);
    expect(d).toEqual({ kind: "fresh", fallback: true });
  });

  it("transcript exists + resume requested → resume", () => {
    // FALSIFY: collapse to always-fresh → RED.
    expect(decideResume(true, true)).toEqual({ kind: "resume" });
  });

  it("no resume requested → fresh, NO fallback frame (regardless of existence)", () => {
    // An ordinary fresh start must never emit a resume_fallback. FALSIFY: set
    // fallback:true here → a spurious toast on every fresh start → RED.
    expect(decideResume(false, false)).toEqual({ kind: "fresh", fallback: false });
    expect(decideResume(true, false)).toEqual({ kind: "fresh", fallback: false });
  });

  it("the fallback reason is the stable non-fatal wording", () => {
    expect(RESUME_FALLBACK_REASON).toBe("transcript missing/expired");
  });
});
