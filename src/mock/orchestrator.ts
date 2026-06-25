// Mock-mode FAKE orchestrator — the narrowest faithful seam for the PROTOTYPE / ACCEPTANCE
// review-bar modes.
//
// main.ts derives those two bar modes STRICTLY from the orchestrator snapshot it holds in
// `orchSnapshot` (populated by the orchestrator's onSnapshot / onPrototypeReview / onAcceptanceReview
// observers) AND `isOrchestrationActive()`. Neither `orchSnapshot`, `refreshReviewBar`,
// `applyPrototypeBar`, nor `applyAcceptanceBar` is exported, so the ONLY way to paint those bars
// through the real production code (no production edits) is to drive main.ts's OWN subscribed observer
// with a real snapshot.
//
// We do that by installing a fake OrchestratorHandle as the orchestrator singleton BEFORE main.ts's
// DOMContentLoaded wiring calls getOrchestrator().subscribe(...) (the singleton is lazy — created on
// first getOrchestrator() call — and this module evaluates at mock-boot time, before that handler
// runs). main.ts then subscribes its real observer to THIS fake handle; emitGate() fans a real
// PlanTreeSnapshot2 (carrying a prototype/acceptance gate) to that observer exactly as the real
// orchestrator would, so the real prototypeGateActive/acceptanceGateActive + applyPrototypeBar/
// applyAcceptanceBar render the bar. We fabricate ONLY the gate data the real orchestrator would
// itself produce.
//
// isOrchestrationActive() must ALSO be true for the derivation to fire, so emitGate() registers this
// handle as the module-level active orchestrator (__setActiveOrchestratorForTest) and clearGate()
// deregisters it. Crucially the handle starts INACTIVE so it never makes the in-process review path
// (handleToolPermissionRequested, which early-returns while isOrchestrationActive()) silently dead.

import {
  __setOrchestratorForTest,
  __setActiveOrchestratorForTest,
  type OrchestratorHandle,
  type OrchestratorObserver,
  type PlanTreeSnapshot2,
} from "../conversation/orchestrator";
import { gateSnapshot, approvalGateSnapshot, placeholderSnapshot } from "./fixtures/reviews";
import type { ProtoPreviewOverride } from "./fixtures/reviews";

// The observers main.ts (and anyone else) subscribes. emitGate() fans to all of them.
const observers = new Set<OrchestratorObserver>();
// The latest snapshot, so a freshly-subscribed observer (subscribe order vs. emit order is not
// guaranteed under HMR) can be brought current — and snapshot() can return something non-throwing.
let lastSnapshot: PlanTreeSnapshot2 | null = null;
// Whether this fake is currently the registered active orchestrator. Starts false (see header).
let active = false;

// A no-op async thunk for the many handle methods the mock never drives. They must exist (the
// interface is exhaustive) but are unreachable in mock mode — the gate bars are driven via emitGate.
const noopAsync = async (): Promise<void> => {};

// The fake handle. Only `subscribe`, `snapshot`, and `orchestrationActive` carry real behavior; the
// rest satisfy the exhaustive OrchestratorHandle interface as inert no-ops.
const handle: OrchestratorHandle = {
  start: async () => false,
  resume: async () => false,
  snapshot: () => {
    if (lastSnapshot === null) throw new Error("[mock] fake orchestrator: snapshot() before any gate");
    return lastSnapshot;
  },
  approve: noopAsync,
  requestChanges: noopAsync,
  answerClarify: noopAsync,
  approvePrototype: noopAsync,
  refinePrototype: noopAsync,
  approveAcceptance: noopAsync,
  divergeAcceptance: noopAsync,
  refineAcceptance: noopAsync,
  ingestStream: noopAsync,
  ingestPermission: noopAsync,
  cancel: noopAsync,
  subscribe: (obs) => {
    observers.add(obs);
    return () => {
      observers.delete(obs);
    };
  },
  teardown: async () => {
    observers.clear();
  },
  orchestrationActive: () => active,
  resuming: () => false,
  quotaPaused: () => false,
  markQuotaPausePending: () => {},
  notifyAgentExit: () => {},
  dispatch: noopAsync,
};

// Install this fake as the orchestrator singleton. Idempotent. MUST be called before main.ts's
// getOrchestrator().subscribe(...) runs (this module evaluates at mock boot, before DOMContentLoaded).
export function installMockOrchestrator(): void {
  // Clear any observers left over from a prior test/boot — each DOMContentLoaded subscribes index.ts's
  // observer afresh, and without this they accumulate on the module-level singleton (so a fanned quota
  // callback would fire N times across N boots). A clean set keeps per-test fan-out deterministic.
  observers.clear();
  lastSnapshot = null;
  active = false;
  __setOrchestratorForTest(handle);
}

// Drive the bar into PROTOTYPE or ACCEPTANCE mode: register as active (so isOrchestrationActive()
// returns true), then fan a real snapshot — onSnapshot (sets orchSnapshot + refreshReviewBar) PLUS the
// specific review hook (onPrototypeReview / onAcceptanceReview — flips to the Plan tab, renders the
// detached prototype preview, refreshes the bar), mirroring the real orchestrator's emission pair.
// `round` (1..3, clamped in gateSnapshot) drives the real prototypeBarLabel — the Review-bar
// "prototype round" knob passes it.
export function emitGate(
  which: "prototype" | "acceptance",
  round = 1,
  protoPreview?: ProtoPreviewOverride,
): void {
  active = true;
  __setActiveOrchestratorForTest(handle);
  const snap = gateSnapshot(which, round, protoPreview);
  lastSnapshot = snap;
  for (const o of observers) o.onSnapshot?.(snap);
  if (which === "prototype" && snap.pendingPrototype) {
    for (const o of observers) o.onPrototypeReview?.(snap.pendingPrototype);
  } else if (which === "acceptance" && snap.pendingAcceptance) {
    for (const o of observers) o.onAcceptanceReview?.(snap.pendingAcceptance);
  }
}

// Drive the bar into the IN-PROCESS APPROVAL "Request changes" VIEWING mode (review2 c5): register as
// active, then fan a real snapshot carrying a held pendingApproval gate whose `planPath` EQUALS the
// already-open plan. We fan ONLY onSnapshot (sets orchSnapshot + refreshReviewBar) — NOT
// onAwaitingApproval, whose production hook calls openPlan(gate.planPath) and re-renders the reading
// pane, WIPING the freshly-applied comment highlights. Because the plan is already open, main.ts's
// viewingGate() matches WITHOUT a re-open, so currentReviewSource() reports "in-process" → the Submit
// button relabels to "Request changes" and #review-bar shows in VIEWING mode. Leaves the fake as the
// active orchestrator until clearGate()/clearApprovalGate() runs.
export function emitApprovalGate(planPath: string): void {
  active = true;
  __setActiveOrchestratorForTest(handle);
  const snap = approvalGateSnapshot(planPath);
  lastSnapshot = snap;
  for (const o of observers) o.onSnapshot?.(snap);
}

// Clear the in-process approval gate (mirrors clearGate but documented for the c5 path). Deregisters
// as active and fans a terminal so main.ts drops orchSnapshot and refreshReviewBar hides the bar.
export function clearApprovalGate(): void {
  clearGate();
}

// Drive ONLY the sidebar live-run placeholder (no review-bar mode): register as active + fan a
// gate-less ACTIVE snapshot. main.ts's onSnapshot mints `.plan.placeholder.active` when
// isOrchestrationActive() && snap.treeId && !snap.done. The Sidebar "placeholder on/off" knob uses
// this. Like emitGate it leaves the fake as the active orchestrator until clearGate() runs.
export function emitPlaceholderSnapshot(): void {
  active = true;
  __setActiveOrchestratorForTest(handle);
  const snap = placeholderSnapshot();
  lastSnapshot = snap;
  for (const o of observers) o.onSnapshot?.(snap);
}

// Quota-banner drivers (Phase 5): fan the quota observer callbacks to every subscriber (index.ts's
// real quota wiring is one of them in mock mode, since it subscribes via getOrchestrator()). These let
// the floating deck exercise the WAITING / EXHAUSTED / RESUMED banner states without real tokens.
// `resetAt` defaults to ~1h out so the countdown reads a realistic HH:MM:SS.
export function emitQuotaPaused(remaining = 1, resetMsFromNow = 3_600_000): void {
  const resetAt = Date.now() + resetMsFromNow;
  for (const o of observers) o.onQuotaPaused?.({ resetAt, remaining, source: "retry-after" });
}
export function emitQuotaExhausted(resetMsFromNow = 3 * 3_600_000): void {
  const resetAt = Date.now() + resetMsFromNow;
  for (const o of observers) o.onQuotaExhausted?.({ resetAt, source: "retry-after" });
}
export function emitQuotaResumed(): void {
  for (const o of observers) o.onQuotaResumed?.();
}

// TEST-ONLY: the live observer set, so a cross-boundary test can fan an EXACT quota callback (e.g. the
// degraded resetAt:0 sentinel) that the offset-from-now emit* helpers above cannot express.
export function __getMockObserversForTest(): OrchestratorObserver[] {
  return Array.from(observers);
}

// Clear the gate: deregister as active and fan a terminal so the bar reverts to its non-gate modes.
// Mirrors the orchestrator's onDone (orchSnapshot = null + refreshReviewBar). Leaves the singleton in
// place (a later emitGate re-arms it).
export function clearGate(): void {
  active = false;
  __setActiveOrchestratorForTest(null);
  lastSnapshot = null;
  for (const o of observers) o.onDone?.(gateSnapshot("prototype"));
}
