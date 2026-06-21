// Mock-mode PHASE 5 test — the quota auto-resume banner through the REAL index.ts observer wiring.
//
// Boots the REAL main.ts via DOMContentLoaded against the mock Tauri shims + the mock fake orchestrator
// (installed FIRST so getOrchestrator() returns it and index.ts subscribes its REAL quota observer to
// our handle). __mock.showQuota(...) stages a scene + fans the matching observer callback; the banner
// is rendered into the production #conversation-stream by index.ts's appendQuotaBanner/clearQuotaBanner
// + rerender — the LIVE wiring, not a copy.
//
// Falsifiable: a banner appearing in #conversation-stream proves the index.ts subscription is wired
// (remove the onQuotaPaused branch and these go RED). The exhausted/resumed cases prove the single
// banner is UPDATED/CLEARED in place, not duplicated.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => await import("./core"));
vi.mock("@tauri-apps/api/event", async () => await import("./event"));
vi.mock("@tauri-apps/api/path", async () => await import("./path"));
vi.mock("@tauri-apps/api/window", async () => await import("./window"));
vi.mock("@tauri-apps/plugin-opener", async () => await import("./opener"));
vi.mock("@tauri-apps/plugin-dialog", async () => await import("./dialog"));
// The recording notification shim: grants permission + records every send, so we can prove the REAL
// index.ts quota observer → REAL notify.ts → sendNotification path fires end-to-end (the cross-boundary
// behavior the mocked-out unit tests could not cover).
vi.mock("@tauri-apps/plugin-notification", async () => await import("./notification"));
vi.mock("../titlebar", () => ({
  initTitlebar: vi.fn(),
  initThemeToggle: vi.fn(),
  initTextSize: vi.fn(),
}));

import { clearMockBuffer } from "./event";
import { resetState } from "./state";
import { installMockApi } from "./api";
import { installMockOrchestrator } from "./orchestrator";
import { getMockNotifications, clearMockNotifications } from "./notification";
import { __resetNotifyPermissionCacheForTests } from "../notify";

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button class="conv-new-plan" id="new-plan-btn"></button>
    </div></div>
    <div class="tab-pane active" id="tab-plans"><div class="plan-list" id="plan-list"></div>
      <span id="plan-count"></span>
      <div class="sidebar-status"><span class="conv-status" id="sdk-status"></span></div></div>
    <main id="reader-scroll"><div class="reader-inner">
      <div class="tab-row reader-tab-row">
        <span class="tab active" data-tab="plan">Plan</span>
        <span class="tab" data-tab="conversation">Conversation</span>
      </div>
      <div class="tab-pane active" id="tab-plan"><div class="md" id="reading-pane"></div></div>
      <div class="tab-pane" id="tab-conversation">
        <button class="conv-cancel" id="conversation-cancel"></button>
        <button id="conversation-pause"></button>
        <button id="conversation-resume"></button>
        <div class="conv-stream" id="conversation-stream"></div>
        <textarea id="conversation-input"></textarea>
        <button id="conversation-send"></button>
      </div>
    </div></main>
    <div class="conv-modal hidden" id="composer-modal">
      <textarea id="composer-request"></textarea><input id="composer-dir" />
      <button id="composer-choose-dir"></button>
      <div id="composer-mode"><button class="conv-mode-btn active" data-mode="plan"></button></div>
      <button id="composer-start"></button><button id="composer-cancel"></button>
      <div class="conv-auth hidden" id="composer-auth"><input id="composer-token" /><button id="composer-token-submit"></button></div>
    </div>
    <div id="composer-status"></div>
    <div class="toast hidden" id="toast"></div>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

describe("quota banner — REAL index.ts wiring via the mock observer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearMockBuffer();
    resetState();
    window.__mockNoReload = true;
    clearMockNotifications();
    __resetNotifyPermissionCacheForTests();
    installMockOrchestrator();
    installMockApi();
  });

  it("showQuota('waiting') renders the WAITING banner in #conversation-stream (countdown + pill, no Resume)", async () => {
    bootDom();
    await flush();

    window.__mock!.showQuota("waiting");
    await flush();

    const stream = document.querySelector("#conversation-stream")!;
    const banner = stream.querySelector(".conv-quota-banner")!;
    expect(banner).toBeTruthy();
    expect((banner as HTMLElement).dataset.state).toBe("waiting");
    expect(banner.querySelector(".conv-qb-countdown")).toBeTruthy();
    expect(banner.querySelector(".conv-qb-pill")!.textContent).toContain("armed");
    const resume = Array.from(banner.querySelectorAll("button")).some((b) =>
      (b.textContent ?? "").toLowerCase().includes("resume"),
    );
    expect(resume).toBe(false);
  });

  it("showQuota('exhausted') renders the EXHAUSTED banner (Cancel-session only, no countdown)", async () => {
    bootDom();
    await flush();
    window.__mock!.showQuota("exhausted");
    await flush();

    const banner = document.querySelector("#conversation-stream .conv-quota-banner")!;
    expect((banner as HTMLElement).dataset.state).toBe("exhausted");
    expect(banner.querySelector(".conv-qb-cancel")!.textContent).toBe("Cancel session");
    expect(banner.querySelector(".conv-qb-countdown")).toBeNull();
  });

  it("waiting → exhausted updates the SAME single banner in place (no duplicate)", async () => {
    bootDom();
    await flush();
    window.__mock!.showQuota("waiting");
    await flush();
    // Re-drive exhausted WITHOUT a reset (showQuota resets first; emit directly to test the singleton).
    const { emitQuotaExhausted } = await import("./orchestrator");
    emitQuotaExhausted();
    await flush();

    const banners = document.querySelectorAll("#conversation-stream .conv-quota-banner");
    expect(banners).toHaveLength(1);
    expect((banners[0] as HTMLElement).dataset.state).toBe("exhausted");
  });

  // ---- CROSS-BOUNDARY: banner + desktop notification together, through the REAL wiring ----------
  //
  // These drive the REAL index.ts quota observer (subscribed to the fake orchestrator handle) which
  // BOTH renders the banner into #conversation-stream AND calls the REAL notify.ts → the recording
  // notification shim. They prove the two effects fire together for a future reset (waiting + countdown
  // + "Waiting until …" notification) and for a degraded/exhausted reset (exhausted banner, no
  // countdown, "Auto-resume budget spent" notification). The mocked-out unit tests asserted these in
  // isolation; this is the only place the banner and the notification are exercised through one frame.
  //
  // Drain enough microtasks for notify.ts's fire-and-forget ensurePermission→sendNotification chain.
  async function flushNotify(n = 60): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  it("FUTURE reset (waiting): renders the countdown banner AND fires the 'Waiting until …' notification", async () => {
    bootDom();
    await flush();

    const { emitQuotaPaused } = await import("./orchestrator");
    emitQuotaPaused(1, 3_600_000); // remaining 1, reset ~1h out (future)
    await flushNotify();

    // Banner: waiting + a live countdown element.
    const banner = document.querySelector("#conversation-stream .conv-quota-banner")!;
    expect((banner as HTMLElement).dataset.state).toBe("waiting");
    expect(banner.querySelector(".conv-qb-countdown")).toBeTruthy();

    // Notification fired through the REAL notify.ts with a real clock time (future reset → non-empty).
    const notes = getMockNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Usage limit reached");
    expect(notes[0].body).toMatch(/^Waiting until .+ to auto-resume\.$/);
  });

  it("DEGRADED reset 0 (exhausted): renders the exhausted banner (no countdown) AND fires the exhausted notification with NO bogus 1970 clock", async () => {
    bootDom();
    await flush();

    // Drive onQuotaExhausted with resetAt EXACTLY 0 (the degraded sentinel). emitQuotaExhausted offsets
    // from Date.now(), so call the observer directly with resetAt 0 to exercise the degraded copy.
    const { __getMockObserversForTest } = await import("./orchestrator");
    for (const o of __getMockObserversForTest()) {
      o.onQuotaExhausted?.({ resetAt: 0, source: "result_error" });
    }
    await flushNotify();

    const banner = document.querySelector("#conversation-stream .conv-quota-banner")!;
    expect((banner as HTMLElement).dataset.state).toBe("exhausted");
    // No countdown on the exhausted banner (no resume timer/wait).
    expect(banner.querySelector(".conv-qb-countdown")).toBeNull();

    const notes = getMockNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Usage limit reached");
    // Degraded copy: NO "Quota resets at <1970 clock>" clause. FALSIFY: format new Date(0) → a 1970
    // clock string appears → this goes RED.
    expect(notes[0].body).toBe("Auto-resume budget spent — waiting for manual action.");
    expect(notes[0].body).not.toMatch(/resets at/);
  });

  it("onQuotaResumed clears the banner and appends the resumed notice", async () => {
    bootDom();
    await flush();
    window.__mock!.showQuota("waiting");
    await flush();
    expect(document.querySelector("#conversation-stream .conv-quota-banner")).toBeTruthy();

    const { emitQuotaResumed } = await import("./orchestrator");
    emitQuotaResumed();
    await flush();

    expect(document.querySelector("#conversation-stream .conv-quota-banner")).toBeNull();
    const notices = Array.from(document.querySelectorAll("#conversation-stream .conv-notice")).map(
      (n) => n.textContent ?? "",
    );
    expect(notices.some((t) => t.includes("Resumed after a quota threshold"))).toBe(true);
  });
});
