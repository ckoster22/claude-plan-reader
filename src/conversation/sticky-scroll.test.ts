// Conversation domain — sticky scroll-to-bottom (Fix 1).
//
// Two layers:
//   1. The PURE isAtBottom() threshold helper (no DOM, fully falsifiable in isolation).
//   2. The integration path through initConversation's rerender(): a streamed frame re-pins the
//      view to the bottom WHEN the user was already at the bottom, and leaves it alone when the user
//      has scrolled up to read history.
//
// jsdom does not compute layout, so scrollHeight/clientHeight/scrollTop are stubbed via
// Object.defineProperty to model the two positions. scrollTop is a backed accessor that records the
// raw assigned value (no clamp) so we can directly observe whether production re-pinned it to the
// bottom (scrollTop := scrollHeight) or left it untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversationElements } from "./index";

const H = vi.hoisted(() => ({
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    (H.listeners[name] ??= []).push(handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import { initConversation, isAtBottom, STICK_THRESHOLD_PX } from "./index";
import { __resetOrchestratorForTest } from "./orchestrator";

function el<T extends HTMLElement>(tag: string): T {
  return document.createElement(tag) as T;
}

// Build a minimal ConversationElements with a stream whose scroll geometry we control. `scrollTop`
// is a backed accessor that records the RAW assigned value (no clamp), so a re-pin (scrollTop :=
// scrollHeight) is directly observable as getScrollTop() === scrollHeight.
function makeEls(geom: { scrollHeight: number; clientHeight: number; scrollTop: number }): {
  els: ConversationElements;
  stream: HTMLElement;
  getScrollTop: () => number;
} {
  const stream = el<HTMLElement>("div");
  document.body.appendChild(stream);
  let scrollTop = geom.scrollTop;
  const scrollHeight = geom.scrollHeight;
  const clientHeight = geom.clientHeight;
  Object.defineProperty(stream, "scrollHeight", { get: () => scrollHeight, configurable: true });
  Object.defineProperty(stream, "clientHeight", { get: () => clientHeight, configurable: true });
  Object.defineProperty(stream, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  const composer = {
    modal: el<HTMLElement>("div"),
    request: el<HTMLTextAreaElement>("textarea"),
    dirField: el<HTMLInputElement>("input"),
    chooseDirBtn: el<HTMLButtonElement>("button"),
    modeToggle: null,
    startBtn: el<HTMLButtonElement>("button"),
    cancelBtn: el<HTMLButtonElement>("button"),
    tokenInput: el<HTMLInputElement>("input"),
    error: el<HTMLElement>("div"),
  };
  const status = {
    pill: el<HTMLElement>("span"),
    authBlock: el<HTMLElement>("div"),
    tokenInput: composer.tokenInput,
    tokenSubmit: el<HTMLButtonElement>("button"),
    error: composer.error,
  };
  const els: ConversationElements = {
    stream,
    cancelBtn: el<HTMLButtonElement>("button"),
    pauseBtn: el<HTMLButtonElement>("button"),
    resumeBtn: el<HTMLButtonElement>("button"),
    newPlanBtn: el<HTMLButtonElement>("button"),
    messageInput: el<HTMLTextAreaElement>("textarea"),
    sendBtn: el<HTMLButtonElement>("button"),
    composer,
    status,
  };
  return {
    els,
    stream,
    getScrollTop: () => scrollTop,
  };
}

function fire(name: string, payload: unknown): void {
  for (const h of H.listeners[name] ?? []) h({ payload });
}
async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  H.listeners = {};
  document.body.innerHTML = "";
  __resetOrchestratorForTest();
});

describe("isAtBottom — threshold helper (pure)", () => {
  it("is true exactly at the bottom (remaining distance 0)", () => {
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
  });

  it("is true within the slack threshold", () => {
    // remaining = 1000 - (800 - THRESHOLD) - 200 = THRESHOLD → still at bottom.
    expect(
      isAtBottom({ scrollHeight: 1000, scrollTop: 800 - STICK_THRESHOLD_PX, clientHeight: 200 }),
    ).toBe(true);
  });

  it("is false once past the slack threshold (scrolled up)", () => {
    // remaining = THRESHOLD + 1 → no longer at bottom.
    expect(
      isAtBottom({ scrollHeight: 1000, scrollTop: 800 - STICK_THRESHOLD_PX - 1, clientHeight: 200 }),
    ).toBe(false);
  });
});

describe("rerender sticky-scroll — follows when at bottom, leaves alone when scrolled up", () => {
  it("a streamed frame re-pins scrollTop to the bottom when the user was already at the bottom", async () => {
    // Start pinned: scrollTop=800, scrollHeight=1000, clientHeight=200 → remaining 0 (at bottom).
    const h = makeEls({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    await initConversation(h.els, () => {});
    await flush();

    fire("agent-stream", { seq: 1, kind: "assistant_text", text: "hello" });
    await flush();

    // Re-pinned: production assigns scrollTop = scrollHeight (1000), keeping the view at the bottom.
    expect(h.getScrollTop()).toBe(1000);
  });

  it("a streamed frame does NOT yank the view when the user has scrolled up", async () => {
    // Scrolled up: remaining = 1000 - 100 - 200 = 700 ≫ threshold → not at bottom.
    const h = makeEls({ scrollHeight: 1000, clientHeight: 200, scrollTop: 100 });
    await initConversation(h.els, () => {});
    await flush();

    fire("agent-stream", { seq: 1, kind: "assistant_text", text: "hello" });
    await flush();

    // Position is left exactly where the user put it — no jump to the bottom.
    expect(h.getScrollTop()).toBe(100);
  });
});
