// Conversation domain (Sub-Plan 02) — New-plan composer modal.
//
// Collects: a request (<textarea>) and a working directory (native folder picker). The starting
// mode is fixed to "plan" (Build removed). On Start it drives the frozen Sub-Plan 01 surface:
//   start_agent_session({ cwd, permissionMode: "plan" }) THEN send_agent_message({ text }).
// Remembers the last chosen directory in localStorage so the next New-plan run pre-fills it.

import { chooseDirectory } from "./wd-picker";
import type { StartingMode } from "./types";
import { createImageAttachments, type ImageAttachments } from "./attachments";
import type { AttachedImage } from "./images";

const LAST_DIR_KEY = "plan-reader-last-agent-dir";

// Minimal storage seam (matches src/titlebar.ts's pattern): a get/set pair. The default is
// real localStorage (best-effort, swallows storage errors); tests inject a fake because jsdom's
// global localStorage is non-functional in this vitest setup.
export interface DirStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStorage: DirStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

// The composer's DOM handles.
export interface ComposerElements {
  modal: HTMLElement | null;
  request: HTMLTextAreaElement | null;
  dirField: HTMLInputElement | null; // read-only path display
  chooseDirBtn: HTMLButtonElement | null;
  // DEPRECATED: the Plan/Build segmented toggle was removed (composer is plan-only). Kept on the
  // interface (always null in production) so existing callers/tests keep compiling; unused by Composer.
  modeToggle: HTMLElement | null;
  startBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  // The paste-token input (owned by the status onboarding block, but Start reads it so a
  // typed-but-unsaved token is honored). Optional so older tests/callers compile.
  tokenInput?: HTMLInputElement | null;
  // Inline error line — hidden by default; Start surfaces failures here instead of silently failing.
  error?: HTMLElement | null;
  // Multimodal image input (optional so older tests/callers compile). When all three are present the
  // composer wires an image-attachment controller in init(): attachStrip holds the removable chips,
  // attachBtn proxies a click to the hidden fileInput, and paste/drop bind on the request textarea.
  // Attach-time rejections surface in the existing `error` line.
  attachStrip?: HTMLElement | null;
  attachBtn?: HTMLElement | null;
  fileInput?: HTMLInputElement | null;
}

// Injection seam for the Start action (tests stub it).
//
// Sub-Plan 03: the composer no longer fires start_agent_session + send_agent_message itself — it
// delegates to a SINGLE `start({cwd, request})` thunk that the orchestrator owns (index.ts binds it
// to getOrchestrator().start(...)). The thunk returns TRUE when a run was really started and FALSE
// on the idempotent no-op (a run is already active). The composer runs onStarted()/close() ONLY on
// TRUE, so a dead start never masquerades as success.
export interface ComposerInvoker {
  start(args: { cwd: string; request: string; images?: AttachedImage[] }): Promise<boolean>;
}

// Seam for persisting a typed-but-unsaved token + asking whether a token is already stored. Backed
// by the StatusController in production (its saveToken/tokenPresent); tests inject a fake.
export interface TokenSaver {
  // Persist a token via the same path "Save token" uses (set_agent_oauth_token). Rejects on failure.
  saveToken(token: string): Promise<void>;
  // Whether a token is currently persisted (so Start can tell "typed nothing + none stored" apart).
  tokenPresent(): boolean;
}

// Factory seam for the image-attachment controller. Defaults to the real createImageAttachments;
// tests inject a fake so getImages()/clear() are observable without a real FileReader/DOM round-trip.
export type AttachmentsFactory = (els: ComposerElements) => ImageAttachments | null;

const defaultAttachmentsFactory: AttachmentsFactory = (els) => {
  if (!els.request || !els.attachStrip) return null;
  return createImageAttachments({
    inputEl: els.request,
    chipStrip: els.attachStrip,
    attachBtn: els.attachBtn ?? undefined,
    fileInput: els.fileInput ?? undefined,
    errorEl: els.error ?? undefined,
  });
};

export class Composer {
  private cwd = "";
  // The image-attachment controller (null when the surface has no attach elements / no factory).
  private attachments: ImageAttachments | null = null;
  // Build mode removed (user decision: plan-only for now). The composer ALWAYS starts sessions in
  // "plan" mode; the only path to acceptEdits is the post-review #review-approve handler in main.ts
  // (set_agent_permission_mode). This is a fixed constant, not user-selectable.
  private readonly mode: StartingMode = "plan";

  constructor(
    private readonly els: ComposerElements,
    private readonly invoker: ComposerInvoker,
    // Called after a successful Start so the controller can flip to the Conversation tab +
    // mark the pill building.
    private readonly onStarted: () => void,
    // Storage seam (last-dir memory). Defaults to localStorage; tests inject a fake.
    private readonly storage: DirStorage = defaultStorage,
    // Token seam — lets Start honor a typed-but-unsaved token and check whether one is stored.
    // Optional so existing two/three-arg constructions keep compiling (Start then skips token logic).
    private readonly tokens?: TokenSaver,
    // Image-attachment factory seam. Defaults to the real controller; tests inject a fake. Optional so
    // existing constructions keep compiling (the composer then has no image input).
    private readonly attachmentsFactory: AttachmentsFactory = defaultAttachmentsFactory,
  ) {}

  // Read / write the remembered last directory through the injected storage.
  private loadLastDir(): string {
    return this.storage.getItem(LAST_DIR_KEY) ?? "";
  }
  private saveLastDir(dir: string): void {
    this.storage.setItem(LAST_DIR_KEY, dir);
  }

  // Wire the modal controls. Call once on load.
  init(): void {
    this.els.chooseDirBtn?.addEventListener("click", () => {
      void this.pickDir();
    });
    this.els.startBtn?.addEventListener("click", () => {
      void this.start();
    });
    this.els.cancelBtn?.addEventListener("click", () => this.close());

    // Editing any field clears a stale inline error so the user is never staring at an old message.
    this.els.request?.addEventListener("input", () => this.clearError());
    this.els.tokenInput?.addEventListener("input", () => this.clearError());

    // Build mode removed — there is no Plan/Build toggle to wire (mode is the fixed "plan" constant).

    // Multimodal: build the image-attachment controller (paste/drop/file-pick → chips). Null when the
    // surface has no attach elements (older callers) — Start then forwards no images.
    this.attachments = this.attachmentsFactory(this.els);
  }

  // Open the modal, pre-filling the remembered last directory. Mode is always "plan" (Build removed).
  open(): void {
    this.cwd = this.loadLastDir();
    if (this.els.dirField) this.els.dirField.value = this.cwd;
    if (this.els.request) this.els.request.value = "";
    // Drop any images left attached from a prior (cancelled) open so each composer session starts clean.
    this.attachments?.clear();
    this.clearError();
    this.els.modal?.classList.remove("hidden");
    this.els.request?.focus();
  }

  // Hide the modal.
  close(): void {
    this.els.modal?.classList.add("hidden");
  }

  // Show an inline error inside the modal (keeps the modal open). EXPORTED behavior is unit-tested.
  private showError(message: string): void {
    if (!this.els.error) return;
    this.els.error.textContent = message;
    this.els.error.classList.remove("hidden");
  }

  // Clear + hide the inline error.
  private clearError(): void {
    if (!this.els.error) return;
    this.els.error.textContent = "";
    this.els.error.classList.add("hidden");
  }

  // Current inline-error text (test reader).
  errorText(): string {
    return this.els.error?.textContent ?? "";
  }

  // Starting mode (test reader). Always "plan" now (Build removed).
  startingMode(): StartingMode {
    return this.mode;
  }

  // Currently-selected directory (test reader).
  directory(): string {
    return this.cwd;
  }

  private async pickDir(): Promise<void> {
    const chosen = await chooseDirectory(this.cwd || undefined);
    if (chosen === null) return; // cancelled — keep the prior value
    this.cwd = chosen;
    if (this.els.dirField) this.els.dirField.value = chosen;
    this.saveLastDir(chosen);
  }

  // Start the run: validate inputs, ensure a token is available, fire start_agent_session then
  // send_agent_message, remember the dir, close the modal, and notify the controller. ALL failures
  // surface as a VISIBLE inline error (the modal stays open) — never a silent no-op. EXPORTED
  // behavior is unit-tested via the injected invoker + token seam (no real Tauri).
  async start(): Promise<void> {
    this.clearError();
    const text = this.els.request?.value.trim() ?? "";
    // Validate inputs with visible feedback (was a silent early-return).
    if (!text) {
      this.showError("Enter a request before starting.");
      return;
    }
    if (!this.cwd) {
      this.showError("Choose a working directory before starting.");
      return;
    }

    // Fix B — honor a typed-but-unsaved token: persist it via the SAME path "Save token" uses
    // before attempting the session. If none typed AND none stored, fail visibly (the backend
    // would otherwise reject with "no OAuth token stored").
    if (this.tokens) {
      const typed = this.els.tokenInput?.value.trim() ?? "";
      if (typed) {
        try {
          await this.tokens.saveToken(typed);
        } catch (e) {
          this.showError(`Could not save token: ${errMsg(e)}`);
          return;
        }
      } else if (!this.tokens.tokenPresent()) {
        this.showError("No Claude subscription token found — paste your token and try again.");
        return;
      }
    }

    // Multimodal: collect any attached images. OMIT-WHEN-EMPTY — pass NO `images` key when there are
    // none so a text-only start is byte-identical to today (preserves exact-match assertions + the
    // cached wire shape). The empty-text guard above still stands: the composer requires text even
    // with images (a planning session needs a textual request; images-only is in-conversation only).
    const images = this.attachments?.getImages() ?? [];

    // Sub-Plan 03: delegate to the orchestrator's start() thunk (mode is always "plan"). It returns
    // TRUE on a real start, FALSE on the idempotent no-op (a planning run is already active).
    let started: boolean;
    try {
      started = await this.invoker.start(
        images.length > 0
          ? { cwd: this.cwd, request: text, images }
          : { cwd: this.cwd, request: text },
      );
    } catch (e) {
      // Keep the modal open and show the rejection so the user knows what happened.
      this.showError(errMsg(e));
      return;
    }
    if (!started) {
      // Idempotent no-op: a run is already active. A dead start must NOT close the modal or run the
      // onStarted liveness chain — surface a visible error and keep the modal open.
      this.showError("A planning run is already active.");
      return;
    }
    this.saveLastDir(this.cwd);
    this.clearError();
    this.close();
    this.onStarted();
  }
}

// Extract a human message from an unknown rejection value (Error, Tauri string, or anything).
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
