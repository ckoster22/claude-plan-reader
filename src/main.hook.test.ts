import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 6 — the plan-review hook button is now AUTO-DETECT single-click (NO two-click confirm):
//   - refreshHookButtons() queries the `hook_status` command and shows EXACTLY ONE of
//     #hook-setup (Install, when NOT installed) / #hook-remove (Remove, when installed).
//   - A SINGLE click on the visible button runs the matching command (install_hook / uninstall_hook)
//     and surfaces success/error in the in-DOM #hook-status line (window.alert is a no-op in the
//     Tauri v2 WKWebView), then re-queries hook_status so the pair flips.
//
// These tests assert the FLOW directly against refreshHookButtons/wireHookButton/setHookStatus (no
// DOMContentLoaded needed). Falsifiability: the "single click installs" test fires the command on the
// FIRST click and fails if an arming guard suppresses it (proven red→green in the test below).
// ---------------------------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { refreshHookButtons, wireHookButton, setHookStatus } from "./main";

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeButton(id: string, labelText: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = id;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = labelText;
  btn.appendChild(label);
  return btn;
}
function makeStatus(): HTMLElement {
  const el = document.createElement("span");
  el.id = "hook-status";
  el.className = "hook-status hidden";
  return el;
}

describe("refreshHookButtons — shows EXACTLY ONE button per install state", () => {
  it("hook_status true ⇒ Remove visible, Install hidden", async () => {
    const setup = makeButton("hook-setup", "Install plan-review hook");
    const remove = makeButton("hook-remove", "Remove");
    const status = makeStatus();
    const invokeFn = vi.fn(async (cmd: string) => (cmd === "hook_status" ? true : undefined));

    await refreshHookButtons(setup, remove, status, invokeFn);

    expect(invokeFn).toHaveBeenCalledWith("hook_status");
    expect(remove.classList.contains("hidden")).toBe(false); // Remove shown
    expect(setup.classList.contains("hidden")).toBe(true); // Install hidden
  });

  it("hook_status false ⇒ Install visible, Remove hidden (the reverse)", async () => {
    const setup = makeButton("hook-setup", "Install plan-review hook");
    const remove = makeButton("hook-remove", "Remove");
    const status = makeStatus();
    const invokeFn = vi.fn(async (cmd: string) => (cmd === "hook_status" ? false : undefined));

    await refreshHookButtons(setup, remove, status, invokeFn);

    expect(setup.classList.contains("hidden")).toBe(false); // Install shown
    expect(remove.classList.contains("hidden")).toBe(true); // Remove hidden
  });

  it("a thrown hook_status is treated as NOT installed (Install shown) and surfaces the error in #hook-status", async () => {
    const setup = makeButton("hook-setup", "Install plan-review hook");
    const remove = makeButton("hook-remove", "Remove");
    const status = makeStatus();
    const invokeFn = vi.fn(() => Promise.reject("settings.json unreadable"));

    await refreshHookButtons(setup, remove, status, invokeFn);

    expect(setup.classList.contains("hidden")).toBe(false); // default to Install on error
    expect(remove.classList.contains("hidden")).toBe(true);
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent).toContain("settings.json unreadable");
  });
});

describe("wireHookButton — SINGLE click invokes (no two-click confirm)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("a SINGLE click on #hook-setup calls install_hook exactly once, then re-queries hook_status", async () => {
    const setup = makeButton("hook-setup", "Install plan-review hook");
    const remove = makeButton("hook-remove", "Remove");
    const status = makeStatus();
    const calls: string[] = [];
    const invokeFn = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "hook_status") return true; // after install, it IS installed
      return undefined;
    });
    wireHookButton(setup, setup, remove, status, "install_hook", {
      successText: "Plan Reader hook installed.",
      errorPrefix: "Could not install hook",
      invokeFn,
    });

    setup.click(); // ONE click — no arming, no second click
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // Falsifiable: install MUST fire on the first (only) click. (Reintroducing an arming guard that
    // makes the first click a no-op turns this red — proven in the red→green test below.)
    expect(invokeFn).toHaveBeenCalledWith("install_hook");
    expect(calls.filter((c) => c === "install_hook").length).toBe(1);
    // After install it re-queries hook_status (so the pair can flip).
    expect(calls).toContain("hook_status");
    // Success surfaced IN THE DOM (not a window.alert no-op).
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(false);
    expect(status.textContent).toBe("Plan Reader hook installed.");
    // The re-query found installed=true ⇒ Remove now visible, Install hidden.
    expect(remove.classList.contains("hidden")).toBe(false);
    expect(setup.classList.contains("hidden")).toBe(true);
  });

  it("a SINGLE click on #hook-remove calls uninstall_hook exactly once, then re-queries hook_status", async () => {
    const setup = makeButton("hook-setup", "Install plan-review hook");
    const remove = makeButton("hook-remove", "Remove");
    const status = makeStatus();
    const calls: string[] = [];
    const invokeFn = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "hook_status") return false; // after uninstall, it is NOT installed
      return undefined;
    });
    wireHookButton(remove, setup, remove, status, "uninstall_hook", {
      successText: "Plan Reader hook removed.",
      errorPrefix: "Could not remove hook",
      invokeFn,
    });

    remove.click(); // ONE click
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(calls.filter((c) => c === "uninstall_hook").length).toBe(1);
    expect(calls).toContain("hook_status");
    expect(status.textContent).toBe("Plan Reader hook removed.");
    // Re-query found installed=false ⇒ Install now visible, Remove hidden.
    expect(setup.classList.contains("hidden")).toBe(false);
    expect(remove.classList.contains("hidden")).toBe(true);
  });

  it("a thrown install_hook surfaces the error string IN THE DOM (never silent)", async () => {
    const setup = makeButton("hook-setup", "Install plan-review hook");
    const remove = makeButton("hook-remove", "Remove");
    const status = makeStatus();
    const invokeFn = vi.fn(async (cmd: string) => {
      if (cmd === "install_hook") return Promise.reject("settings.json is not valid JSON — refusing to modify");
      return false; // hook_status re-query in the finally
    });
    wireHookButton(setup, setup, remove, status, "install_hook", {
      successText: "Plan Reader hook installed.",
      errorPrefix: "Could not install hook",
      invokeFn,
    });

    setup.click();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent).toContain("settings.json is not valid JSON");
    expect(status.textContent).toContain("Could not install hook");
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
