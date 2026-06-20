// Mock shim for "@tauri-apps/api/path".
//
// The app imports ONLY `homeDir` from this module (src/main.ts). Returns the canned mock home so
// the sidebar's "~/…" collapse works. Keep the async signature identical to the real API.

import { MOCK_HOME } from "./state";

export async function homeDir(): Promise<string> {
  return MOCK_HOME;
}
