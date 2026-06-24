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
import fs from "node:fs";
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

// Inline plugin: inject the ANIMATE player module script right before </body> (mirrors
// injectDeckPlugin). Used INSTEAD of the deck in `npm run mock-animate` (MOCK_ANIMATE=1), so the
// scrubbable Trailhead beat boots and the deck does NOT (the two are mutually exclusive).
function injectAnimatePlugin(): Plugin {
  return {
    name: "mock-inject-animate",
    transformIndexHtml(html: string): string {
      const tag = '<script type="module" src="/src/mock/animate/index.ts"></script>';
      // Author mode (`npm run mock-annotate`, MOCK_ANNOTATE=1): set window.__MOCK_ANNOTATE BEFORE the
      // player module evaluates, so index.ts boots paused + mounts the author UI. A plain inline
      // (non-module) <script> runs synchronously at parse time, before the deferred module below.
      const flag = process.env.MOCK_ANNOTATE
        ? "<script>window.__MOCK_ANNOTATE=true</script>\n  "
        : "";
      const inject = `${flag}${tag}`;
      // Insert before the closing body tag; fall back to appending if it is somehow absent.
      return html.includes("</body>") ? html.replace("</body>", `  ${inject}\n  </body>`) : html + inject;
    },
  };
}

// Inline plugin: a DEV-ONLY persistence middleware for the annotation-authoring layer (Phase 2).
// The browser can't write files, so saving/loading an AnnotationDoc round-trips through this
// connect middleware on the mock dev server. Routes live under /__mock_annotations; everything
// else (or any non-matching method) falls through to Vite via next().
//
// SAFETY — TWO INDEPENDENT name guards (defense in depth): (a) a strict regex, and (b) a
// resolved-path containment assertion. Either failing → 400. Writes are ATOMIC (temp + rename).
// This plugin is inert unless its routes are hit, so it is always included regardless of mode.
function annotationsApiPlugin(): Plugin {
  const dir = path.resolve(__dirname, ".mock-annotations");

  // Both guards must pass. Returns the absolute file path for `name`, or null if either guard fails.
  const safeFile = (name: unknown): string | null => {
    if (typeof name !== "string") return null;
    // Guard (a): strict charset/shape.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) return null;
    // Guard (b): resolved-path containment — the resolved file MUST equal the naive join AND sit
    // strictly under the annotations dir. This catches anything the regex might miss (defense in depth).
    const file = path.resolve(dir, name + ".json");
    if (file !== path.join(dir, name + ".json")) return null;
    if (!file.startsWith(dir + path.sep)) return null;
    return file;
  };

  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  return {
    name: "mock-annotations-api",
    configureServer(server): void {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__mock_annotations")) return next();

        void (async (): Promise<void> => {
          try {
            const parsed = new URL(url, "http://localhost");
            const pathname = parsed.pathname;

            // ---- POST /__mock_annotations/save ----
            if (pathname === "/__mock_annotations/save" && req.method === "POST") {
              const raw = await readBody(req);
              let payload: { name?: unknown; doc?: unknown };
              try {
                payload = JSON.parse(raw) as { name?: unknown; doc?: unknown };
              } catch {
                res.statusCode = 400;
                res.end("invalid JSON body");
                return;
              }
              const file = safeFile(payload.name);
              if (file === null) {
                res.statusCode = 400;
                res.end("invalid name");
                return;
              }
              fs.mkdirSync(dir, { recursive: true });
              const tmp = file + ".tmp";
              fs.writeFileSync(tmp, JSON.stringify(payload.doc));
              fs.renameSync(tmp, file);
              res.statusCode = 200;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ path: file }));
              return;
            }

            // ---- GET /__mock_annotations/load?name=<name> ----
            if (pathname === "/__mock_annotations/load" && req.method === "GET") {
              const file = safeFile(parsed.searchParams.get("name"));
              if (file === null) {
                res.statusCode = 400;
                res.end("invalid name");
                return;
              }
              if (!fs.existsSync(file)) {
                res.statusCode = 404;
                res.end("not found");
                return;
              }
              const contents = fs.readFileSync(file, "utf8");
              res.statusCode = 200;
              res.setHeader("content-type", "application/json");
              res.end(contents);
              return;
            }

            // Any other sub-path/method under /__mock_annotations → let Vite handle it.
            return next();
          } catch (err) {
            res.statusCode = 500;
            res.end("annotations middleware error: " + (err instanceof Error ? err.message : String(err)));
          }
        })();
      });
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
      "@tauri-apps/plugin-notification": shim("notification.ts"),
    },
  },
  // Exclude the real Tauri packages from dep pre-bundling so esbuild can't pre-bundle them and
  // bypass the alias.
  optimizeDeps: {
    exclude: [
      "@tauri-apps/api",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-notification",
    ],
  },
  // A distinct port from the real dev server (1420) so the two never collide.
  server: {
    port: 1421,
    strictPort: true,
    // Keep the persisted annotation artifact OUT of Vite's file watcher: a save writes into
    // .mock-annotations/ and would otherwise trip chokidar → HMR/full reload, dropping the
    // in-memory AnnotationDoc mid-author (Risk #1). .gitignore does NOT exclude the watcher.
    watch: { ignored: ["**/.mock-annotations/**"] },
  },
  // Mutually exclusive: `npm run mock-animate` (MOCK_ANIMATE=1) boots the scrubbable Trailhead
  // player INSTEAD of the control deck, so only one overlay mounts at a time. The annotations API
  // middleware is included unconditionally — it is inert unless its /__mock_annotations routes are hit.
  plugins: [
    process.env.MOCK_ANIMATE ? injectAnimatePlugin() : injectDeckPlugin(),
    annotationsApiPlugin(),
  ],
};

// The base config is `defineConfig(async () => ({...}))` — a function returning a Promise. Resolve
// it, then merge our overrides on top.
export default defineConfig(async () => {
  const base = await baseConfigFn({ command: "serve", mode: "development" });
  return mergeConfig(base, mockOverrides);
});
