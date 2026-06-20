// Conversation domain (Sub-Plan 02) — SDK status pill + auth onboarding.
//
// Owns the #sdk-status pill state machine and the composer's auth-onboarding block. The pill
// reflects: ready (token present, idle) / building (a run is streaming) / auth required (no
// token, or an auth error) / error (a fatal non-auth error). On load it reads agent_auth_status;
// it reacts to agent-auth-required and agent-error{kind:"auth"} by showing the paste-token UI and
// persisting via set_agent_oauth_token.

import type { AgentAuthStatus } from "./types";

export type SdkStatus = "ready" | "building" | "auth" | "error";

// Human label per pill state.
const STATUS_LABEL: Record<SdkStatus, string> = {
  ready: "SDK ready",
  building: "building",
  auth: "auth required",
  error: "error",
};

// PURE next-state reducer. The inputs that move the pill:
//   - hasToken: whether a token is stored (false => auth required when idle)
//   - building: a run is currently streaming
//   - authError: an auth-kind error / agent-auth-required fired
//   - fatalError: a fatal non-auth error fired
// Precedence (most urgent first): auth > error > building > ready. EXPORTED for unit tests.
export function nextStatus(input: {
  hasToken: boolean;
  building: boolean;
  authError: boolean;
  fatalError: boolean;
}): SdkStatus {
  if (input.authError || !input.hasToken) return "auth";
  if (input.fatalError) return "error";
  if (input.building) return "building";
  return "ready";
}

// Map a status to its pill label. EXPORTED for tests.
export function statusLabel(status: SdkStatus): string {
  return STATUS_LABEL[status];
}

// The DOM handles the status controller drives.
export interface StatusElements {
  pill: HTMLElement | null;
  // The .hidden auth-onboarding block in the composer modal.
  authBlock: HTMLElement | null;
  // The paste-token input + its submit button.
  tokenInput: HTMLInputElement | null;
  tokenSubmit: HTMLButtonElement | null;
  // Inline error line in the composer modal (shared with the Start path). Optional so older
  // tests/callers compile; when present, "Save token" failures / empty-field feedback show here
  // instead of being a silent no-op or an unhandled rejection.
  error?: HTMLElement | null;
}

// Injection seam for the two commands this controller calls (tests stub them).
export interface StatusInvoker {
  authStatus(): Promise<AgentAuthStatus>;
  setToken(token: string): Promise<void>;
}

// The status controller. Holds the live inputs, recomputes the pill, and owns the onboarding UI.
export class StatusController {
  private hasToken = false;
  private building = false;
  private authError = false;
  private fatalError = false;

  constructor(
    private readonly els: StatusElements,
    private readonly invoker: StatusInvoker,
  ) {}

  // Show / clear the shared inline error (no-op if no error element is wired).
  private showError(message: string): void {
    if (!this.els.error) return;
    this.els.error.textContent = message;
    this.els.error.classList.remove("hidden");
  }
  private clearError(): void {
    if (!this.els.error) return;
    this.els.error.textContent = "";
    this.els.error.classList.add("hidden");
  }

  // Wire the paste-token submit and read the initial auth status. Call once on load.
  async init(): Promise<void> {
    if (this.els.tokenSubmit) {
      this.els.tokenSubmit.addEventListener("click", () => {
        void this.submitToken();
      });
    }
    // Editing the token clears a stale inline error.
    this.els.tokenInput?.addEventListener("input", () => this.clearError());
    await this.refresh();
  }

  // Re-read the live backend auth status and repaint. PUBLIC so the composer-open seam can refresh the
  // banner + Start token-guard against current backend state (not a one-shot startup read) — kills the
  // stale "No Claude subscription token found" banner after a token is added out-of-band.
  async refresh(): Promise<void> {
    try {
      const s = await this.invoker.authStatus();
      this.hasToken = s.hasToken;
    } catch {
      // Treat an unreadable status as no-token so onboarding shows (never silently "ready").
      this.hasToken = false;
    }
    this.render();
  }

  // A run started streaming.
  setBuilding(building: boolean): void {
    this.building = building;
    // A fresh build clears a prior non-fatal display so the pill reflects the live run.
    if (building) this.fatalError = false;
    this.render();
  }

  // Force the auth state to "token present" without an extra backend round-trip. Called after a
  // successful Start (onStarted), where the token PROVABLY exists (the backend used it to spawn the
  // sidecar). This keeps auth single-source — one boolean (`hasToken`) — and guarantees a later
  // composer reopen can never show a stale "no token" banner after a run has started.
  markTokenPresent(): void {
    this.hasToken = true;
    this.authError = false;
    this.render();
  }

  // agent-auth-required OR agent-error{kind:"auth"} fired.
  markAuthRequired(): void {
    this.authError = true;
    this.hasToken = false;
    this.building = false;
    this.render();
  }

  // A fatal non-auth error fired.
  markFatalError(): void {
    this.fatalError = true;
    this.building = false;
    this.render();
  }

  // "Save token" button handler: persist the typed token (NEVER a silent no-op). Empty field and
  // persist failures surface inline; on success the inline error is cleared.
  private async submitToken(): Promise<void> {
    this.clearError();
    const token = this.els.tokenInput?.value.trim() ?? "";
    if (!token) {
      this.showError("Paste your Claude subscription token before saving.");
      return;
    }
    try {
      await this.saveToken(token);
    } catch (e) {
      this.showError(`Could not save token: ${errMsg(e)}`);
    }
  }

  // Persist a token, then clear the auth-error state and re-render to `ready`. Callable from the
  // composer's Start path (honors a typed-but-unsaved token) AND from the "Save token" button.
  // On success the onboarding token input is cleared. On failure onboarding stays visible
  // (pill stays "auth") and the error is rethrown so callers can surface it.
  async saveToken(token: string): Promise<void> {
    try {
      await this.invoker.setToken(token);
      this.hasToken = true;
      this.authError = false;
      if (this.els.tokenInput) this.els.tokenInput.value = "";
      this.render();
    } catch (e) {
      // Keep onboarding visible; the pill stays "auth".
      this.hasToken = false;
      this.render();
      throw e;
    }
  }

  // Whether a token is currently considered persisted (composer reads this to decide whether a
  // missing typed token is fatal). Reflects init's auth_status plus any successful saveToken.
  tokenPresent(): boolean {
    return this.hasToken;
  }

  // Current pill state (pure reduction of the inputs).
  status(): SdkStatus {
    return nextStatus({
      hasToken: this.hasToken,
      building: this.building,
      authError: this.authError,
      fatalError: this.fatalError,
    });
  }

  // Paint the pill + toggle the onboarding block. The onboarding block shows iff status is auth.
  private render(): void {
    const status = this.status();
    if (this.els.pill) {
      this.els.pill.dataset.status = status;
      this.els.pill.textContent = statusLabel(status);
    }
    this.els.authBlock?.classList.toggle("hidden", status !== "auth");
  }
}

// Extract a human message from an unknown rejection value (Error, Tauri string, or anything).
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
