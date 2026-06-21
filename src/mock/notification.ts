// Mock shim for "@tauri-apps/plugin-notification".
//
// src/notify.ts (Phase 8) posts desktop notifications via this plugin in EXACTLY two cases (quota
// reached / auto-resumed). In the browser mock there is no OS notification center and the real
// plugin pulls `addPluginListener` from @tauri-apps/api/core (which is itself aliased to the mock
// core.ts that does NOT export it) — so without this shim the whole mock module graph fails to load
// and window.__mock never installs.
//
// Permission is GRANTED here (so the real notify.ts path actually reaches sendNotification) and every
// send is RECORDED into an inspectable in-memory buffer. This lets the mock cross-boundary test prove
// the notification fires end-to-end through the real index.ts quota observer + real notify.ts — the
// same wiring previously missing in the (mocked-out) unit tests that hid a real bug. sendNotification
// still cannot throw into notify.ts (which swallows failures regardless), so the quota flow is safe.

export interface MockNotification {
  title: string;
  body: string;
}

// The recorded sends. Inspect via getMockNotifications(); clear via clearMockNotifications() in a
// beforeEach so each test starts from a clean slate.
const sent: MockNotification[] = [];

export function getMockNotifications(): MockNotification[] {
  return sent.slice();
}

export function clearMockNotifications(): void {
  sent.length = 0;
}

export async function isPermissionGranted(): Promise<boolean> {
  // GRANTED so notify.ts reaches sendNotification (the cross-boundary test asserts the recorded send).
  return true;
}

export async function requestPermission(): Promise<"granted" | "denied" | "default"> {
  return "granted";
}

export function sendNotification(options: { title: string; body?: string } | string): void {
  const title = typeof options === "string" ? options : options.title;
  const body = typeof options === "string" ? "" : (options.body ?? "");
  sent.push({ title, body });
  console.log("[mock] sendNotification (recorded):", title, "—", body);
}
