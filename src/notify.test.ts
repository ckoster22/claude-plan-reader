import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri notification plugin. The three spies are referenced through wrapper fns so the
// per-test reassignments below take effect (vi.mock is hoisted; we mutate the spies in beforeEach).
const isPermissionGrantedMock = vi.fn();
const requestPermissionMock = vi.fn();
const sendNotificationMock = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: (...a: unknown[]) => isPermissionGrantedMock(...a),
  requestPermission: (...a: unknown[]) => requestPermissionMock(...a),
  sendNotification: (...a: unknown[]) => sendNotificationMock(...a),
}));

import {
  notifyQuotaPaused,
  notifyQuotaExhausted,
  notifyQuotaResumed,
  __resetNotifyPermissionCacheForTests,
} from "./notify";

// Let the internal fire-and-forget promise chain (ensurePermission → sendNotification) drain.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A fixed epoch-ms reset time. The exact formatted clock string is locale/timezone dependent, so the
// assertions check the stable prefixes/structure of the body rather than the literal time.
const RESET_AT = 1_700_000_000_000;

beforeEach(() => {
  isPermissionGrantedMock.mockReset();
  requestPermissionMock.mockReset();
  sendNotificationMock.mockReset();
  __resetNotifyPermissionCacheForTests();
});

describe("notify — permission granted", () => {
  beforeEach(() => {
    isPermissionGrantedMock.mockResolvedValue(true);
  });

  it("sends the paused notification with the right title/body", async () => {
    notifyQuotaPaused(RESET_AT);
    await flush();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const arg = sendNotificationMock.mock.calls[0][0];
    expect(arg.title).toBe("Usage limit reached");
    expect(arg.body).toMatch(/^Waiting until .+ to auto-resume\.$/);
  });

  it("sends the exhausted notification with the right title/body", async () => {
    notifyQuotaExhausted(RESET_AT);
    await flush();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const arg = sendNotificationMock.mock.calls[0][0];
    expect(arg.title).toBe("Usage limit reached");
    expect(arg.body).toMatch(
      /^Auto-resume budget spent — waiting for manual action\. Quota resets at .+\.$/,
    );
  });

  it("sends the resumed notification with the right title/body", async () => {
    notifyQuotaResumed();
    await flush();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const arg = sendNotificationMock.mock.calls[0][0];
    expect(arg.title).toBe("Quota refreshed");
    expect(arg.body).toBe("Conversation resumed.");
  });
});

describe("notify — degraded/unknown reset (resetAt <= 0) drops the bogus epoch-1970 clock", () => {
  beforeEach(() => {
    isPermissionGrantedMock.mockResolvedValue(true);
  });

  it("paused with resetAt 0 → body has NO clock time, no 'Dec 31 1969 / 1970'", async () => {
    notifyQuotaPaused(0);
    await flush();
    const arg = sendNotificationMock.mock.calls[0][0];
    // FALSIFY: format new Date(0) anyway → body contains a 1970-ish clock string → these go RED.
    expect(arg.body).toBe("Waiting to auto-resume.");
    expect(arg.body).not.toMatch(/until/);
  });

  it("exhausted with resetAt 0 → drops the 'Quota resets at ...' clause", async () => {
    notifyQuotaExhausted(0);
    await flush();
    const arg = sendNotificationMock.mock.calls[0][0];
    expect(arg.body).toBe("Auto-resume budget spent — waiting for manual action.");
    expect(arg.body).not.toMatch(/resets at/);
  });
});

describe("notify — permission denied", () => {
  beforeEach(() => {
    isPermissionGrantedMock.mockResolvedValue(false);
    requestPermissionMock.mockResolvedValue("denied");
  });

  it("does NOT send and does NOT throw when permission is denied", async () => {
    // Must not throw synchronously (fire-and-forget).
    expect(() => notifyQuotaPaused(RESET_AT)).not.toThrow();
    await flush();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("does NOT send when the plugin API itself rejects (unavailable)", async () => {
    isPermissionGrantedMock.mockRejectedValue(new Error("plugin unavailable"));
    expect(() => notifyQuotaResumed()).not.toThrow();
    await flush();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});

describe("notify — permission requested only once (cached)", () => {
  it("requests permission at most once across multiple calls", async () => {
    isPermissionGrantedMock.mockResolvedValue(false);
    requestPermissionMock.mockResolvedValue("granted");

    notifyQuotaPaused(RESET_AT);
    await flush();
    notifyQuotaExhausted(RESET_AT);
    await flush();
    notifyQuotaResumed();
    await flush();

    // isPermissionGranted + requestPermission ran exactly once total (cached after first resolve).
    expect(isPermissionGrantedMock).toHaveBeenCalledTimes(1);
    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    // All three subsequent notifications still fired (permission was granted on the first request).
    expect(sendNotificationMock).toHaveBeenCalledTimes(3);
  });

  it("does not re-query after a cached granted decision", async () => {
    isPermissionGrantedMock.mockResolvedValue(true);
    notifyQuotaPaused(RESET_AT);
    await flush();
    notifyQuotaPaused(RESET_AT);
    await flush();
    expect(isPermissionGrantedMock).toHaveBeenCalledTimes(1);
    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
  });
});
