// Mock-mode Vite config — runs the REAL, UNMODIFIED app shell in a plain browser against a fake
// Tauri IPC layer (src/mock/*). `npm run mock` boots the sidebar + reading pane with fixture data
// and ZERO real Tauri/sidecar/agent calls.
//
// HOW THE SEAM WORKS: every `@tauri-apps/*` import the app makes is aliased (resolve.alias, OBJECT
// form, exact keys) to a mock shim under src/mock/. The app code is byte-unchanged; only its
// resolution targets differ at build time. This mirrors what the unit tests already prove with
// `vi.mock("@tauri-apps/api/core")` — done here at the Vite layer instead.
//
// PRODUCTION IS UNTOUCHED: vite.config.ts and index.html are not modified. This file imports the
// base config and merges onto it; vitest keeps reading the base config.

import { defineConfig, mergeConfig, type UserConfig, type Plugin } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import baseConfigFn from "./vite.config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockDir = path.resolve(__dirname, "src/mock");

// Absolute path to a mock shim file under src/mock.
function shim(file: string): string {
  return path.join(mockDir, file);
}

// Inline plugin: inject the control-deck module script right before </body>, so it loads AFTER
// main.ts (which is in <head> with defer). We serve the REAL index.html and inject — no separate
// mock.html.
function injectDeckPlugin(): Plugin {
  return {
    name: "mock-inject-deck",
    transformIndexHtml(html: string): string {
      const tag = '<script type="module" src="/src/mock/deck.ts"></script>';
      // Insert before the closing body tag; fall back to appending if it is somehow absent.
      return html.includes("</body>") ? html.replace("</body>", `  ${tag}\n  </body>`) : html + tag;
    },
  };
}

// The mock-only overrides merged onto the base config.
const mockOverrides: UserConfig = {
  resolve: {
    // OBJECT-form alias with EXACT keys for each distinct @tauri-apps specifier the app imports
    // (derived by grepping `from "@tauri-apps` across src/). Each points at its mock shim.
    alias: {
      "@tauri-apps/api/core": shim("core.ts"),
      "@tauri-apps/api/event": shim("event.ts"),
      "@tauri-apps/api/path": shim("path.ts"),
      "@tauri-apps/api/window": shim("window.ts"),
      "@tauri-apps/plugin-opener": shim("opener.ts"),
      "@tauri-apps/plugin-dialog": shim("dialog.ts"),
    },
  },
  // Exclude the real Tauri packages from dep pre-bundling so esbuild can't pre-bundle them and
  // bypass the alias.
  optimizeDeps: {
    exclude: ["@tauri-apps/api", "@tauri-apps/plugin-opener", "@tauri-apps/plugin-dialog"],
  },
  // A distinct port from the real dev server (1420) so the two never collide.
  server: {
    port: 1421,
    strictPort: true,
  },
  plugins: [injectDeckPlugin()],
};

// The base config is `defineConfig(async () => ({...}))` — a function returning a Promise. Resolve
// it, then merge our overrides on top.
export default defineConfig(async () => {
  const base = await baseConfigFn({ command: "serve", mode: "development" });
  return mergeConfig(base, mockOverrides);
});
