// Desktop notifications (Phase 8) — a thin, ALWAYS-SILENT-ON-FAILURE wrapper around
// `@tauri-apps/plugin-notification`.
//
// Notifications fire in EXACTLY two scenarios, both driven from the quota observer block in
// src/conversation/index.ts:
//   1. Quota limit reached (session paused) — and its exhausted variant.
//   2. Conversation auto-resumed after the quota reset.
// Nothing else (no normal-completion / error notifications).
//
// DESIGN: notifications are a pure enhancement, never a gate. Every public function is
// fire-and-forget and CANNOT throw into the caller: permission is requested once and cached, and any
// failure (permission denied, plugin/API unavailable, send rejection) degrades to a silent no-op.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// Cached permission decision. `null` = not yet resolved; `true`/`false` = the final granted state.
// Resolving it requires at most ONE permission round-trip per app run (isPermissionGranted, then
// requestPermission only if not already granted) — subsequent calls reuse the cached boolean.
let permissionGranted: boolean | null = null;
// The in-flight permission resolution, so concurrent first-use calls share ONE round-trip instead of
// each firing their own requestPermission().
let permissionInFlight: Promise<boolean> | null = null;

// Resolve (and cache) whether we may post notifications. Never throws — any failure caches `false`
// so we stop retrying for the rest of the run.
async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted;
  if (permissionInFlight) return permissionInFlight;
  permissionInFlight = (async (): Promise<boolean> => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      permissionGranted = granted;
      return granted;
    } catch {
      // Plugin/API unavailable (e.g. running outside Tauri) — treat as denied, silently.
      permissionGranted = false;
      return false;
    } finally {
      permissionInFlight = null;
    }
  })();
  return permissionInFlight;
}

// Post a notification IFF permission is granted. Swallows every failure (denied permission, send
// rejection, missing plugin) so the quota/auto-resume flow is never disturbed.
async function notify(title: string, body: string): Promise<void> {
  try {
    if (!(await ensurePermission())) return;
    sendNotification({ title, body });
  } catch {
    // Silent degradation: notifications are an enhancement, not a gate.
  }
}

// Format an epoch-ms reset time as a human clock time (e.g. "6:00 PM"). Locale-aware, hour:minute
// only. Mirrors render.ts's formatResetClock (kept local to avoid a cross-domain import — notify.ts
// is disjoint from the conversation render pane). Returns "" on a bad value — INCLUDING the degraded
// sentinel resetAt <= 0 (an undeterminable reset), so callers never print a bogus "new Date(0)" clock
// (epoch 1970). Callers branch on "" to drop the clock phrase entirely.
function formatResetClock(resetAt: number): string {
  if (!(Number.isFinite(resetAt) && resetAt > 0)) return "";
  try {
    return new Date(resetAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// Scenario 1 (paused): the usage limit was hit and the session is auto-resume-armed — it will wait
// until `resetAt` (epoch-ms) and pick back up automatically.
export function notifyQuotaPaused(resetAt: number): void {
  const clock = formatResetClock(resetAt);
  // A degraded/unknown reset (clock === "") still notifies — without a bogus epoch-1970 time.
  const body = clock ? `Waiting until ${clock} to auto-resume.` : "Waiting to auto-resume.";
  void notify("Usage limit reached", body);
}

// Scenario 1 (exhausted variant): the usage limit was hit but the auto-resume budget is spent, so the
// run is parked waiting for manual action. `resetAt` (epoch-ms) is the next quota reset.
export function notifyQuotaExhausted(resetAt: number): void {
  const clock = formatResetClock(resetAt);
  // A degraded/unknown reset (clock === "") drops the "Quota resets at <epoch 1970>" clause entirely.
  const body = clock
    ? `Auto-resume budget spent — waiting for manual action. Quota resets at ${clock}.`
    : "Auto-resume budget spent — waiting for manual action.";
  void notify("Usage limit reached", body);
}

// Scenario 2 (resumed): the quota refreshed and the conversation auto-resumed.
export function notifyQuotaResumed(): void {
  void notify("Quota refreshed", "Conversation resumed.");
}

// TEST-ONLY: reset the cached permission state so each test starts from a clean slate.
export function __resetNotifyPermissionCacheForTests(): void {
  permissionGranted = null;
  permissionInFlight = null;
}
