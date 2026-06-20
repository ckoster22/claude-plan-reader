// Conversation domain (Sub-Plan 02/03) — composer tests.
//
// We stub @tauri-apps/plugin-dialog so wd-picker's chooseDirectory is controllable, and inject the
// single `start({cwd, request})` invoker so Start is testable without real Tauri. Sub-Plan 03: the
// composer delegates to the orchestrator's start() thunk (returns true on a real start, false on the
// idempotent no-op) instead of firing start_agent_session + send_agent_message itself.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the dialog plugin BEFORE importing composer (which imports wd-picker -> the plugin).
const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openMock(...a) }));

import {
  Composer,
  type ComposerElements,
  type ComposerInvoker,
  type DirStorage,
  type TokenSaver,
  type AttachmentsFactory,
} from "./composer";
import type { AttachedImage } from "./images";
import type { ImageAttachments } from "./attachments";

// A fake image-attachments controller whose getImages() returns the injected set. clearCount tracks
// clear() calls so open()-clears + send-clears are observable without a real FileReader/DOM round-trip.
function makeFakeAttachments(initial: AttachedImage[] = []): ImageAttachments & {
  clearCount: number;
  setImages(next: AttachedImage[]): void;
} {
  let imgs = initial.slice();
  const fake = {
    clearCount: 0,
    getImages: () => imgs.slice(),
    isEmpty: () => imgs.length === 0,
    clear: () => {
      imgs = [];
      fake.clearCount++;
    },
    // Test helper: simulate the user attaching images (paste/drop/pick) AFTER open() has cleared.
    setImages: (next: AttachedImage[]) => {
      imgs = next.slice();
    },
  };
  return fake;
}

function mkFactory(att: ImageAttachments | null): AttachmentsFactory {
  return () => att;
}

const PNG: AttachedImage = { media_type: "image/png", data: "AAAA" };
const JPG: AttachedImage = { media_type: "image/jpeg", data: "BBBB" };

// A start-invoker that resolves true (a real start) by default. `result` controls the boolean Start
// observes; `impl` overrides for ordering/throwing tests.
function mkStart(
  result = true,
  impl?: (args: { cwd: string; request: string }) => Promise<boolean>,
): ComposerInvoker & { start: ReturnType<typeof vi.fn> } {
  return { start: vi.fn(impl ?? (async () => result)) };
}

// A fake storage seam (jsdom's global localStorage is non-functional in this vitest setup, so
// the codebase injects fakes — mirrors src/titlebar.test.ts).
function makeStorage(): DirStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
  };
}

function makeEls(): ComposerElements {
  const modal = document.createElement("div");
  modal.className = "hidden";
  const request = document.createElement("textarea");
  const dirField = document.createElement("input");
  const chooseDirBtn = document.createElement("button");
  // Build removed — the composer is plan-only; there is no Plan/Build toggle (modeToggle is null).
  const startBtn = document.createElement("button");
  const cancelBtn = document.createElement("button");
  // Token paste field + inline error line — present on the real modal; Start reads/writes them.
  const tokenInput = document.createElement("input");
  const error = document.createElement("div");
  error.className = "hidden";
  return { modal, request, dirField, chooseDirBtn, modeToggle: null, startBtn, cancelBtn, tokenInput, error };
}

// A fake token seam. `present` controls tokenPresent(); saveToken records its arg + flips present.
function makeTokens(opts: { present?: boolean; saveRejects?: unknown } = {}): TokenSaver & {
  saved: string[];
} {
  let present = opts.present ?? false;
  const saved: string[] = [];
  return {
    saved,
    saveToken: vi.fn(async (token: string) => {
      if (opts.saveRejects !== undefined) throw opts.saveRejects;
      saved.push(token);
      present = true;
    }),
    tokenPresent: () => present,
  };
}

// Drive the picker to a directory on the given composer's els (the picker is the only way `cwd` is set).
async function chooseDir(els: ComposerElements, dir: string): Promise<void> {
  openMock.mockResolvedValue(dir);
  els.chooseDirBtn!.click();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = "";
  openMock.mockReset();
});

describe("Composer — open/close (plan-only; Build removed)", () => {
  it("open shows the modal in Plan mode; close hides it", () => {
    const els = makeEls();
    const c = new Composer(els, mkStart(), vi.fn());
    c.init();
    c.open();
    expect(els.modal!.classList.contains("hidden")).toBe(false);
    expect(c.startingMode()).toBe("plan");
    c.close();
    expect(els.modal!.classList.contains("hidden")).toBe(true);
  });

  // Test #3 (falsifiable): the composer is plan-only. Mode stays "plan" — the orchestrator's start()
  // (which the invoker delegates to) opens the session in plan mode. FALSIFY: change the composer's
  // fixed mode constant and startingMode() goes RED.
  it("Start delegates to the orchestrator start() thunk; mode stays 'plan'", async () => {
    const els = makeEls();
    const inv = mkStart();
    const c = new Composer(els, inv, vi.fn());
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    await c.start();
    expect(inv.start).toHaveBeenCalledWith({ cwd: "/work", request: "do it" });
    expect(c.startingMode()).toBe("plan");
  });
});

describe("Composer — folder picker", () => {
  it("choosing a directory fills the read-only field and remembers it", async () => {
    const els = makeEls();
    const storage = makeStorage(); // SHARED across both composer instances
    openMock.mockResolvedValue("/Users/u/work/proj");
    const c = new Composer(els, mkStart(), vi.fn(), storage);
    c.init();
    c.open();
    els.chooseDirBtn!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(els.dirField!.value).toBe("/Users/u/work/proj");
    expect(c.directory()).toBe("/Users/u/work/proj");
    // Persisted: a fresh composer (same storage) opens pre-filled with the remembered dir.
    const c2 = new Composer(makeEls(), mkStart(), vi.fn(), storage);
    c2.init();
    c2.open();
    expect(c2.directory()).toBe("/Users/u/work/proj");
  });

  it("cancelling the picker (null) keeps the prior directory", async () => {
    const els = makeEls();
    openMock.mockResolvedValue(null);
    const c = new Composer(els, mkStart(), vi.fn());
    c.init();
    c.open();
    els.chooseDirBtn!.click();
    await Promise.resolve();
    expect(c.directory()).toBe("");
  });
});

describe("Composer — Start delegates to the orchestrator start() thunk", () => {
  it("Start (with request + dir) calls start({cwd,request}); on TRUE it notifies + closes", async () => {
    const els = makeEls();
    const inv = mkStart(true);
    const onStarted = vi.fn();
    const c = new Composer(els, inv, onStarted);
    c.init();
    c.open();
    // Provide a dir + request (plan-only — no Build toggle).
    openMock.mockResolvedValue("/work");
    els.chooseDirBtn!.click();
    await Promise.resolve();
    await Promise.resolve();
    els.request!.value = "Build the OAuth route";

    await c.start();

    expect(inv.start).toHaveBeenCalledWith({ cwd: "/work", request: "Build the OAuth route" });
    expect(onStarted).toHaveBeenCalled();
    expect(els.modal!.classList.contains("hidden")).toBe(true);
  });

  // Sub-Plan 03 (falsifiable): start() returning FALSE is the idempotent no-op (a run is already
  // active). A dead start must NOT close the modal or run onStarted — it shows a visible error.
  // FALSIFY: run onStarted()/close() unconditionally (ignore the boolean) → these go RED.
  it("on a FALSE start (idempotent no-op) it shows an error and stays open; no onStarted", async () => {
    const els = makeEls();
    const inv = mkStart(false);
    const onStarted = vi.fn();
    const c = new Composer(els, inv, onStarted);
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    await c.start();
    expect(inv.start).toHaveBeenCalledWith({ cwd: "/work", request: "do it" });
    expect(onStarted).not.toHaveBeenCalled();
    expect(els.modal!.classList.contains("hidden")).toBe(false); // modal stays open
    expect(c.errorText()).toMatch(/already active/i);
    expect(els.error!.classList.contains("hidden")).toBe(false);
  });

  it("success path shows NO inline error", async () => {
    const els = makeEls();
    const c = new Composer(els, mkStart(true), vi.fn());
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    await c.start();
    expect(c.errorText()).toBe("");
    expect(els.error!.classList.contains("hidden")).toBe(true);
  });
});

describe("Composer — Fix A: failures surface as a VISIBLE inline error (never silent)", () => {
  it("empty request => inline error shown, NO session started, modal stays open", async () => {
    const els = makeEls();
    const inv = mkStart();
    const c = new Composer(els, inv, vi.fn());
    c.init();
    c.open();
    await chooseDir(els, "/work"); // dir present, but request is blank
    els.request!.value = "   ";
    await c.start();
    expect(inv.start).not.toHaveBeenCalled();
    expect(c.errorText()).not.toBe("");
    expect(els.error!.classList.contains("hidden")).toBe(false);
    expect(els.modal!.classList.contains("hidden")).toBe(false); // modal stays open
  });

  it("missing working directory => inline error shown, NO session started", async () => {
    const els = makeEls();
    const inv = mkStart();
    const c = new Composer(els, inv, vi.fn());
    c.init();
    c.open();
    els.request!.value = "hi"; // request present, no dir chosen
    await c.start();
    expect(inv.start).not.toHaveBeenCalled();
    expect(c.errorText()).toMatch(/director/i);
    expect(els.error!.classList.contains("hidden")).toBe(false);
  });

  it("start() rejects => inline error displays the rejection message AND modal stays open (not silently closed)", async () => {
    const els = makeEls();
    const inv = mkStart(true, async () => {
      throw new Error("no OAuth token stored");
    });
    const onStarted = vi.fn();
    // token present so we reach start(); its rejection is what we are asserting.
    const c = new Composer(els, inv, onStarted, makeStorage(), makeTokens({ present: true }));
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    await c.start();
    expect(c.errorText()).toBe("no OAuth token stored");
    expect(els.error!.classList.contains("hidden")).toBe(false);
    expect(els.modal!.classList.contains("hidden")).toBe(false); // NOT silently closed
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("editing the request clears a stale inline error", async () => {
    const els = makeEls();
    const c = new Composer(els, mkStart(), vi.fn());
    c.init();
    c.open();
    await c.start(); // empty -> error shows
    expect(els.error!.classList.contains("hidden")).toBe(false);
    els.request!.value = "x";
    els.request!.dispatchEvent(new Event("input"));
    expect(els.error!.classList.contains("hidden")).toBe(true);
    expect(c.errorText()).toBe("");
  });
});

describe("Composer — Fix B: Start honors a typed-but-unsaved token", () => {
  it("typed-but-unsaved token is persisted (set_agent_oauth_token path) THEN the session starts", async () => {
    const els = makeEls();
    const calls: string[] = [];
    const inv = mkStart(true, async () => {
      calls.push("start");
      return true;
    });
    const tokens = makeTokens({ present: false }); // none stored yet
    const c = new Composer(els, inv, vi.fn(), makeStorage(), tokens);
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    els.tokenInput!.value = "  sk-typed-token  "; // typed, never "Save token"-clicked

    // Make saveToken record ordering relative to start.
    (tokens.saveToken as ReturnType<typeof vi.fn>).mockImplementation(async (t: string) => {
      tokens.saved.push(t);
      calls.push("save");
    });

    await c.start();

    expect(tokens.saveToken).toHaveBeenCalledWith("sk-typed-token"); // trimmed
    expect(tokens.saved).toEqual(["sk-typed-token"]);
    expect(inv.start).toHaveBeenCalled();
    expect(calls).toEqual(["save", "start"]); // persist BEFORE starting
    expect(c.errorText()).toBe("");
  });

  it("no typed token AND none stored => inline error, NO session started", async () => {
    const els = makeEls();
    const inv = mkStart();
    const tokens = makeTokens({ present: false });
    const c = new Composer(els, inv, vi.fn(), makeStorage(), tokens);
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    els.tokenInput!.value = ""; // nothing typed
    await c.start();
    expect(tokens.saveToken).not.toHaveBeenCalled();
    expect(inv.start).not.toHaveBeenCalled();
    expect(c.errorText()).toMatch(/token/i);
    expect(els.error!.classList.contains("hidden")).toBe(false);
  });

  it("no typed token but one IS stored => starts without saving", async () => {
    const els = makeEls();
    const inv = mkStart(true);
    const tokens = makeTokens({ present: true });
    const c = new Composer(els, inv, vi.fn(), makeStorage(), tokens);
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    await c.start();
    expect(tokens.saveToken).not.toHaveBeenCalled();
    expect(inv.start).toHaveBeenCalled();
    expect(c.errorText()).toBe("");
  });

  it("saveToken rejection surfaces an inline error and does NOT start the session", async () => {
    const els = makeEls();
    const inv = mkStart();
    const tokens = makeTokens({ present: false, saveRejects: new Error("keychain locked") });
    const c = new Composer(els, inv, vi.fn(), makeStorage(), tokens);
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    els.tokenInput!.value = "sk-typed";
    await c.start();
    expect(inv.start).not.toHaveBeenCalled();
    expect(c.errorText()).toMatch(/keychain locked/);
    expect(els.error!.classList.contains("hidden")).toBe(false);
  });
});

describe("Composer — multimodal image attachments", () => {
  // text+images: inv.start receives the EXACT { cwd, request, images } shape.
  it("text + images forwards the expected images array", async () => {
    const els = makeEls();
    const inv = mkStart();
    const att = makeFakeAttachments();
    const c = new Composer(els, inv, vi.fn(), makeStorage(), undefined, mkFactory(att));
    c.init();
    c.open();
    att.setImages([PNG, JPG]); // user attaches AFTER open() (which clears)
    await chooseDir(els, "/work");
    els.request!.value = "design this";
    await c.start();
    expect(inv.start).toHaveBeenCalledWith({
      cwd: "/work",
      request: "design this",
      images: [PNG, JPG],
    });
  });

  // FALSIFIABLE omit-when-empty: text-only forwards NO `images` key (exact arg shape). Breaking the
  // composer's omit guard (always sending images) makes this assertion go RED.
  it("text-only forwards NO images key (exact arg shape)", async () => {
    const els = makeEls();
    const inv = mkStart();
    const att = makeFakeAttachments([]); // no images attached
    const c = new Composer(els, inv, vi.fn(), makeStorage(), undefined, mkFactory(att));
    c.init();
    c.open();
    await chooseDir(els, "/work");
    els.request!.value = "do it";
    await c.start();
    expect(inv.start).toHaveBeenCalledWith({ cwd: "/work", request: "do it" });
    const arg = (inv.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect("images" in arg).toBe(false);
  });

  // Composer requires TEXT even with images (images-only is in-conversation only).
  it("empty text + images is still rejected (no start)", async () => {
    const els = makeEls();
    const inv = mkStart();
    const att = makeFakeAttachments();
    const c = new Composer(els, inv, vi.fn(), makeStorage(), undefined, mkFactory(att));
    c.init();
    c.open();
    att.setImages([PNG]); // user attaches AFTER open()
    await chooseDir(els, "/work");
    els.request!.value = "   "; // blank text, but an image is attached
    await c.start();
    expect(inv.start).not.toHaveBeenCalled();
    expect(c.errorText()).not.toBe("");
  });

  // open() clears any images left from a prior (cancelled) open.
  it("open() clears attachments", () => {
    const els = makeEls();
    const att = makeFakeAttachments([PNG]);
    const c = new Composer(els, mkStart(), vi.fn(), makeStorage(), undefined, mkFactory(att));
    c.init();
    c.open();
    expect(att.clearCount).toBeGreaterThanOrEqual(1);
  });
});
