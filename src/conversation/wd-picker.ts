// Conversation domain (Sub-Plan 02) — native working-directory picker.
//
// A brand-new input that flows 02 -> 01 (start_agent_session.cwd). It is DISJOINT from cwd
// resolution (src/cwd.ts / src/resolve.ts) — those reverse-engineer a plan's ORIGIN cwd; this
// simply asks the user to CHOOSE a directory for a new agent run via the native folder dialog.

import { open } from "@tauri-apps/plugin-dialog";

// Open the native folder dialog and return the chosen absolute directory, or null if the user
// cancelled. `directory:true` restricts the dialog to folders. `defaultPath` seeds it at the
// remembered last directory (composer.ts passes the persisted value).
export async function chooseDirectory(defaultPath?: string): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a working directory for the agent",
    ...(defaultPath ? { defaultPath } : {}),
  });
  // With multiple:false the plugin returns a single path string (or null on cancel). Guard the
  // array form defensively in case a platform returns one.
  if (selected == null) return null;
  if (Array.isArray(selected)) return selected[0] ?? null;
  return selected;
}
