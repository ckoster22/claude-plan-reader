// Live-debug seam (instrumentation only — NEVER affects behavior).
//
// The frontend `console.log` lands in the WebView devtools, not the dev terminal, so reading it
// requires the user to open devtools mid-run. `diag(msg)` forwards the line to the Rust `diag_log`
// command, which `eprintln!("[fe:diag] ...")`s it into the dev-terminal stderr — making one live
// run fully diagnosable from the dev-terminal log file ALONE.
//
// FULLY GUARDED: fire-and-forget, swallowing every error. The `invoke` call is wrapped so that a
// mocked Tauri seam (which returns undefined), an absent Tauri runtime (tests that don't mock core
// — the call throws synchronously), or a rejected promise can NEVER throw out of diag() or stall a
// caller. It is a strict no-op in tests.

import { invoke } from "@tauri-apps/api/core";

export function diag(msg: string): void {
  try {
    const r = invoke("diag_log", { msg }) as unknown;
    // `invoke` normally returns a Promise; swallow a rejection so a missing/failed seam is silent.
    if (r && typeof (r as { catch?: unknown }).catch === "function") {
      (r as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Synchronous throw (e.g. no Tauri runtime in a unit test) — instrumentation must stay inert.
  }
}
