// Conversation domain (Sub-Plan 02) — status pill + onboarding tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextStatus, statusLabel, StatusController } from "./status";

describe("nextStatus — pure pill reducer", () => {
  it("no token => auth (even when idle)", () => {
    expect(nextStatus({ hasToken: false, building: false, authError: false, fatalError: false })).toBe("auth");
  });
  it("auth error wins over everything", () => {
    expect(nextStatus({ hasToken: true, building: true, authError: true, fatalError: true })).toBe("auth");
  });
  it("fatal error => error (token present, not auth)", () => {
    expect(nextStatus({ hasToken: true, building: false, authError: false, fatalError: true })).toBe("error");
  });
  it("building => building (token present, no errors)", () => {
    expect(nextStatus({ hasToken: true, building: true, authError: false, fatalError: false })).toBe("building");
  });
  it("token present + idle + no errors => ready", () => {
    expect(nextStatus({ hasToken: true, building: false, authError: false, fatalError: false })).toBe("ready");
  });
  it("labels are distinct human strings", () => {
    expect(statusLabel("ready")).toMatch(/ready/i);
    expect(statusLabel("building")).toMatch(/building/i);
    expect(statusLabel("auth")).toMatch(/auth/i);
    expect(statusLabel("error")).toBe("error");
  });
});

function makeEls() {
  const pill = document.createElement("span");
  const authBlock = document.createElement("div");
  authBlock.className = "hidden";
  const tokenInput = document.createElement("input");
  const tokenSubmit = document.createElement("button");
  const error = document.createElement("div");
  error.className = "hidden";
  return { pill, authBlock, tokenInput, tokenSubmit, error };
}

describe("StatusController — onboarding behavior", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("on init with a stored token => pill ready, onboarding hidden", async () => {
    const els = makeEls();
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: true })),
      setToken: vi.fn(async () => {}),
    });
    await ctl.init();
    expect(ctl.status()).toBe("ready");
    expect(els.pill.dataset.status).toBe("ready");
    expect(els.authBlock.classList.contains("hidden")).toBe(true);
  });

  it("on init with NO token => pill auth, onboarding shown", async () => {
    const els = makeEls();
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: false })),
      setToken: vi.fn(async () => {}),
    });
    await ctl.init();
    expect(ctl.status()).toBe("auth");
    expect(els.authBlock.classList.contains("hidden")).toBe(false);
  });

  // Fix 3 (falsifiable): refresh() re-reads the live backend auth status. Starting with NO token
  // (banner shown), a later refresh that sees a token must HIDE the banner + flip to ready — killing
  // the stale "No Claude subscription token found" banner. FALSIFY: make refresh() not re-read (return
  // early) and the post-refresh "ready / banner hidden" assertions go RED.
  it("refresh() re-reads auth and HIDES the banner once a token is present", async () => {
    const els = makeEls();
    let stored = false;
    const authStatus = vi.fn(async () => ({ hasToken: stored }));
    const ctl = new StatusController(els, { authStatus, setToken: vi.fn(async () => {}) });
    await ctl.init();
    // Initial read: no token → auth, banner visible.
    expect(ctl.status()).toBe("auth");
    expect(els.authBlock.classList.contains("hidden")).toBe(false);

    // A token is added out-of-band; refresh must observe it and hide the banner.
    stored = true;
    await ctl.refresh();
    expect(authStatus).toHaveBeenCalledTimes(2); // init + refresh both read
    expect(ctl.status()).toBe("ready");
    expect(ctl.tokenPresent()).toBe(true);
    expect(els.authBlock.classList.contains("hidden")).toBe(true);
  });

  it("Save token persists the ACTUAL typed value via set_agent_oauth_token and flips to ready", async () => {
    const els = makeEls();
    const setToken = vi.fn(async () => {});
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: false })),
      setToken,
    });
    await ctl.init();
    expect(ctl.status()).toBe("auth");
    els.tokenInput.value = "  sk-oauth-xyz  "; // typed value, with surrounding whitespace
    els.tokenSubmit.click();
    // Let the click's async handler settle.
    await Promise.resolve();
    await Promise.resolve();
    // The real (trimmed) typed value reaches the backend — NOT empty, NOT a wrong arg.
    expect(setToken).toHaveBeenCalledTimes(1);
    expect(setToken).toHaveBeenCalledWith("sk-oauth-xyz");
    expect(ctl.status()).toBe("ready");
    expect(ctl.tokenPresent()).toBe(true);
    expect(els.authBlock.classList.contains("hidden")).toBe(true);
    expect(els.tokenInput.value).toBe(""); // cleared on success
    expect(els.error.classList.contains("hidden")).toBe(true);
  });

  it("Save token with an EMPTY field surfaces an inline error and does NOT call set_agent_oauth_token", async () => {
    const els = makeEls();
    const setToken = vi.fn(async () => {});
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: false })),
      setToken,
    });
    await ctl.init();
    els.tokenInput.value = "   "; // whitespace only
    els.tokenSubmit.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(setToken).not.toHaveBeenCalled();
    expect(els.error.classList.contains("hidden")).toBe(false);
    expect(els.error.textContent).not.toBe("");
    expect(ctl.status()).toBe("auth"); // still unauthenticated
  });

  it("Save token failure surfaces inline (no silent swallow); pill stays auth", async () => {
    const els = makeEls();
    const setToken = vi.fn(async () => {
      throw new Error("disk full");
    });
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: false })),
      setToken,
    });
    await ctl.init();
    els.tokenInput.value = "sk-oauth-xyz";
    els.tokenSubmit.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(setToken).toHaveBeenCalledWith("sk-oauth-xyz");
    expect(els.error.classList.contains("hidden")).toBe(false);
    expect(els.error.textContent).toMatch(/disk full/);
    expect(ctl.status()).toBe("auth");
    expect(ctl.tokenPresent()).toBe(false);
  });

  it("saveToken (the shared path used by composer Start) invokes setToken with the value and flips ready", async () => {
    const els = makeEls();
    const setToken = vi.fn(async () => {});
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: false })),
      setToken,
    });
    await ctl.init();
    await ctl.saveToken("sk-from-start");
    expect(setToken).toHaveBeenCalledWith("sk-from-start");
    expect(ctl.tokenPresent()).toBe(true);
    expect(ctl.status()).toBe("ready");
  });

  it("saveToken rethrows on failure so the composer can surface it", async () => {
    const els = makeEls();
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: false })),
      setToken: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    await ctl.init();
    await expect(ctl.saveToken("sk-x")).rejects.toThrow(/nope/);
    expect(ctl.tokenPresent()).toBe(false);
  });

  it("markAuthRequired re-shows onboarding even after ready (agent-error{auth})", async () => {
    const els = makeEls();
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: true })),
      setToken: vi.fn(async () => {}),
    });
    await ctl.init();
    expect(ctl.status()).toBe("ready");
    ctl.markAuthRequired();
    expect(ctl.status()).toBe("auth");
    expect(els.authBlock.classList.contains("hidden")).toBe(false);
  });

  it("setBuilding(true) shows building; a fatal error shows error", async () => {
    const els = makeEls();
    const ctl = new StatusController(els, {
      authStatus: vi.fn(async () => ({ hasToken: true })),
      setToken: vi.fn(async () => {}),
    });
    await ctl.init();
    ctl.setBuilding(true);
    expect(ctl.status()).toBe("building");
    ctl.markFatalError();
    expect(ctl.status()).toBe("error");
  });
});
