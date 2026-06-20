/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vitest unit-test config. The render math/classifiers are pure; the DOM-touching
  // bits use jsdom. mermaid is loaded via a lazy dynamic import (src/render/mermaid.ts)
  // so it never participates in the unit-test or initial bundle graph.
  test: {
    environment: "jsdom",
    // src/** = the frontend domains; sidecar/** = the Agent SDK sidecar's pure permission/status
    // helpers (permissions.ts is side-effect-free; index.ts is NOT imported by tests — it has
    // top-level side effects from the embedded-CLI import + stdin reader).
    include: ["src/**/*.test.ts", "sidecar/**/*.test.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
