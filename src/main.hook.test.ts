import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 6 fix — the "Install plan-review hook" button did NOTHING because the old handler gated
// on window.confirm(...) (returns false in Tauri v2 WKWebView ⇒ invoke never fired) and reported
// via window.alert(...) (a no-op ⇒ errors invisible). The fix is a dependency-free in-DOM flow:
//   - a two-click "click again to confirm" arm before the mutation, and
//   - an in-DOM #hook-status line for success/error (never window.alert).
//
// These tests assert the FLOW directly against wireHookButton/setHookStatus (no DOMContentLoaded
// needed). Falsifiability: the "two clicks invoke" test fails if invoke fires on the FIRST click
// (the old window.confirm bug equivalent), and the error test fails if a thrown invoke is silent.
// ---------------------------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { wireHookButton, setHookStatus } from "./main";

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = "hook-setup";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Install plan-review hook";
  btn.appendChild(label);
  return btn;
}
function makeStatus(): HTMLElement {
  const el = document.createElement("span");
  el.id = "hook-status";
  el.className = "hook-status hidden";
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("wireHookButton — two-click confirm gates the invoke", () => {
  it("first click does NOT invoke; it arms the button (label + .confirming)", async () => {
    const btn = makeButton();
    const status = makeStatus();
    const invokeFn = vi.fn(() => Promise.resolve());
    wireHookButton(btn, status, "install_hook", {
      confirmLabel: "Click again to confirm",
      successText: "Plan Reader hook installed.",
      errorPrefix: "Could not install hook",
      invokeFn,
    });

    btn.click();
    await flush();

    // The bug being guarded: a first click must NOT fire the command (the old window.confirm
    // returned false, so invoke never ran — here we require the OPPOSITE gating: deliberate
    // two-click confirm, so one click only arms).
    expect(invokeFn).not.toHaveBeenCalled();
    expect(btn.classList.contains("confirming")).toBe(true);
    expect(btn.querySelector(".label")?.textContent).toBe("Click again to confirm");
  });

  it("second click invokes the command exactly once and shows an in-DOM success status", async () => {
    const btn = makeButton();
    const status = makeStatus();
    const invokeFn = vi.fn(() => Promise.resolve());
    wireHookButton(btn, status, "install_hook", {
      confirmLabel: "Click again to confirm",
      successText: "Plan Reader hook installed.",
      errorPrefix: "Could not install hook",
      invokeFn,
    });

    btn.click(); // arm
    btn.click(); // confirm
    await flush();

    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(invokeFn).toHaveBeenCalledWith("install_hook");
    // Success surfaced IN THE DOM (not a window.alert no-op).
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(false);
    expect(status.textContent).toBe("Plan Reader hook installed.");
    // Button reverted to its original label after confirming.
    expect(btn.classList.contains("confirming")).toBe(false);
    expect(btn.querySelector(".label")?.textContent).toBe("Install plan-review hook");
  });

  it("a thrown invoke surfaces the error string IN THE DOM (never silent)", async () => {
    const btn = makeButton();
    const status = makeStatus();
    const invokeFn = vi.fn(() =>
      Promise.reject("settings.json is not valid JSON — refusing to modify"),
    );
    wireHookButton(btn, status, "install_hook", {
      confirmLabel: "Click again to confirm",
      successText: "Plan Reader hook installed.",
      errorPrefix: "Could not install hook",
      invokeFn,
    });

    btn.click(); // arm
    btn.click(); // confirm
    await flush();

    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);
    // The command's actual error string is shown (not swallowed).
    expect(status.textContent).toContain("settings.json is not valid JSON");
    expect(status.textContent).toContain("Could not install hook");
  });

  it("arming auto-reverts after the confirm window, so the NEXT click re-arms (does not invoke)", async () => {
    const btn = makeButton();
    const status = makeStatus();
    const invokeFn = vi.fn(() => Promise.resolve());
    wireHookButton(btn, status, "install_hook", {
      confirmLabel: "Click again to confirm",
      successText: "ok",
      errorPrefix: "err",
      invokeFn,
    });

    btn.click(); // arm
    expect(btn.classList.contains("confirming")).toBe(true);
    vi.advanceTimersByTime(5000); // past HOOK_CONFIRM_MS (4000) → auto-disarm
    expect(btn.classList.contains("confirming")).toBe(false);

    // A click after the timeout re-arms rather than confirming → still no invoke.
    btn.click();
    await flush();
    expect(invokeFn).not.toHaveBeenCalled();
    expect(btn.classList.contains("confirming")).toBe(true);
  });
});

describe("setHookStatus", () => {
  it("empty text hides and clears", () => {
    const status = makeStatus();
    setHookStatus(status, "hi", "success");
    expect(status.classList.contains("hidden")).toBe(false);
    setHookStatus(status, "");
    expect(status.classList.contains("hidden")).toBe(true);
    expect(status.textContent).toBe("");
    expect(status.classList.contains("error")).toBe(false);
  });
});
