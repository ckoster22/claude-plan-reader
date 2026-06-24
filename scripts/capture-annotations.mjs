// capture-annotations.mjs — Phase 4 of the mock-animate review-authoring layer.
//
// Given the NAME of a saved annotation doc (.mock-annotations/<name>.json), this script produces ONE
// settled screenshot per comment — the screen-at-T (reading pane / mermaid / overlays fully rendered)
// composited with that comment's isolated annotation overlay — plus an index.json. That directory is
// the canonical artifact an AI agent reads to review the feedback (the per-comment screenshot is the
// source of truth, per the plan's "Shared rendering environment": authoring + capture share one
// rendering env — deviceScaleFactor:1 + hidden scrollbars + a pinned viewport).
//
// LIFECYCLE (all children torn down in a finally):
//   1. read the doc from disk (comments + viewport) — no dependence on the server for the list.
//   2. spawn `MOCK_ANIMATE=1 vite --config vite.mock.config.ts --port <CAPTURE_PORT>` and poll until it serves.
//   3. spawn headless Chrome with remote debugging on its own port + a fresh temp user-data-dir.
//   4. drive raw CDP over the global WebSocket: open a tab, Page+Runtime enable, emulate the viewport,
//      navigate to ?annotations=<name>, await window.__mockAnim.
//   5. for each comment (doc order, isolated by id): seekSettled(tMs) → double-rAF → focusComment(id)
//      → one more rAF → Page.captureScreenshot → write NNNN_t<tMs>.png.
//   6. emit index.json = [{ commentId, tMs, text, png }].
//   7. focusComment(null); kill Chrome + vite; rm the temp user-data-dir.
//
// CDP is the proven raw-WebSocket pattern (no chrome-devtools MCP, per the plan's Risk #7); Node has a
// global WebSocket + global fetch, so this script needs zero npm deps.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const annotationsDir = path.join(repoRoot, ".mock-annotations");

// ---- small utilities -------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(msg) {
  console.error(`[capture-annotations] ERROR: ${msg}`);
  process.exit(1);
}

// Kill a detached child's whole process group (SIGTERM the negative pid = the group). Falls back to
// signaling just the child pid. No-op if the child already exited or was never spawned.
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

// Poll `fn` (returns truthy/throws) until it succeeds or the deadline passes.
async function waitFor(label, fn, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

// ---- CDP client over the global WebSocket ----------------------------------------------------

// A minimal request/response + event JSON-RPC client over a single page-target WebSocket.
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.method ?? "cdp"} failed: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  // Evaluate an expression in the page; awaits promises; returns the JSON value.
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `page eval threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result?.value;
  }
}

// Open (or reuse) a page target and return its webSocketDebuggerUrl. Some Chrome builds start with no
// page target until you PUT /json/new, so handle that path.
async function resolvePageTarget(devUrlBase) {
  const list = async () => {
    const res = await fetch(`${devUrlBase}/json/list`);
    return res.ok ? res.json() : [];
  };
  let targets = await list();
  let page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) {
    // Try to open a fresh tab. PUT is the documented verb; some builds accept GET. about:blank target.
    for (const method of ["PUT", "GET"]) {
      try {
        const res = await fetch(`${devUrlBase}/json/new?about:blank`, { method });
        if (res.ok) {
          const created = await res.json();
          if (created?.webSocketDebuggerUrl) return created.webSocketDebuggerUrl;
        }
      } catch {
        /* try next */
      }
    }
    targets = await list();
    page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  }
  if (!page) throw new Error("no page target with a webSocketDebuggerUrl");
  return page.webSocketDebuggerUrl;
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message ?? "open failed"}`)), {
      once: true,
    });
  });
}

// ---- Chrome binary resolution ----------------------------------------------------------------

function resolveChromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Last resort: rely on PATH lookup.
  return "google-chrome";
}

// ---- a double-rAF barrier evaluated in the page ----------------------------------------------

const DOUBLE_RAF = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;
const SINGLE_RAF = `new Promise((r) => requestAnimationFrame(() => r(true)))`;

// ---- main ------------------------------------------------------------------------------------

async function main() {
  const name = process.argv[2];
  if (!name) fail("usage: npm run capture-annotations -- <name>");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    fail(`invalid name "${name}" (must match ^[a-z0-9][a-z0-9_-]{0,63}$)`);
  }

  // (1) read the saved doc directly from disk.
  const docPath = path.join(annotationsDir, `${name}.json`);
  if (!fs.existsSync(docPath)) {
    fail(`no annotation doc at ${docPath} — author one first (npm run mock-annotate) or save via the middleware`);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
  } catch (err) {
    fail(`could not parse ${docPath}: ${err.message}`);
  }
  const comments = Array.isArray(doc.comments) ? doc.comments : [];
  if (comments.length === 0) fail(`doc "${name}" has no comments — nothing to capture`);
  const viewport = doc.viewport && doc.viewport.w && doc.viewport.h ? doc.viewport : { w: 1280, h: 800 };

  const port = Number(process.env.CAPTURE_PORT) || 1431;
  const dport = Number(process.env.CAPTURE_DEBUG_PORT) || 9333;
  const outDir = path.join(annotationsDir, name);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-anno-chrome-"));

  console.log(`[capture-annotations] doc "${name}": ${comments.length} comment(s), viewport ${viewport.w}x${viewport.h}`);

  let vite = null;
  let chrome = null;
  let ws = null;

  try {
    // (2) spawn the mock dev server on CAPTURE_PORT (NOT relying on strictPort 1421 being free).
    console.log(`[capture-annotations] starting mock dev server on :${port} ...`);
    vite = spawn(
      "npx",
      ["vite", "--config", "vite.mock.config.ts", "--port", String(port), "--strictPort"],
      {
        cwd: repoRoot,
        env: { ...process.env, MOCK_ANIMATE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group so teardown can SIGTERM the WHOLE tree (vite spawns esbuild grandchildren
        // that a bare child.kill() would orphan, leaving the port held).
        detached: true,
      },
    );
    vite.stdout?.on("data", () => {});
    vite.stderr?.on("data", (d) => process.stderr.write(`[vite] ${d}`));
    vite.on("exit", (code) => {
      if (code && code !== 0 && code !== null) console.error(`[vite] exited with code ${code}`);
    });

    // Vite binds to `localhost` (which resolves to ::1 on macOS), NOT 127.0.0.1 — so the page URL uses
    // `localhost`. Chrome's CDP endpoint (below) binds to 127.0.0.1, so those URLs stay 127.0.0.1.
    const baseUrl = `http://localhost:${port}`;
    await waitFor(`mock server at ${baseUrl}`, async () => {
      const res = await fetch(baseUrl, { method: "GET" });
      return res.ok || res.status === 200;
    });
    console.log(`[capture-annotations] mock server is up.`);

    // (3) spawn headless Chrome.
    const chromeBin = resolveChromeBinary();
    console.log(`[capture-annotations] launching Chrome: ${chromeBin}`);
    chrome = spawn(
      chromeBin,
      [
        "--headless=new",
        `--remote-debugging-port=${dport}`,
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${userDataDir}`,
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        `--window-size=${viewport.w},${viewport.h}`,
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    chrome.stderr?.on("data", () => {});
    chrome.on("exit", (code) => {
      if (code && code !== 0 && code !== null) console.error(`[chrome] exited with code ${code}`);
    });

    // (4) connect CDP.
    const devUrlBase = `http://127.0.0.1:${dport}`;
    const wsUrl = await waitFor(`Chrome devtools at ${devUrlBase}`, () => resolvePageTarget(devUrlBase));
    ws = await openWs(wsUrl);
    const cdp = new CdpClient(ws);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // Pin the rendering env to match authoring (Risk #4): exact viewport, DSR 1, no scrollbars.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.w,
      height: viewport.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Emulation.setScrollbarsHidden", { hidden: true });

    // Navigate to replay mode for this doc and wait for the load event.
    const targetUrl = `${baseUrl}/?annotations=${encodeURIComponent(name)}`;
    console.log(`[capture-annotations] navigating to ${targetUrl}`);
    await cdp.send("Page.navigate", { url: targetUrl });
    // Wait for the player control surface to exist (it mounts on DOMContentLoaded; the doc loads async).
    await waitFor("window.__mockAnim", async () => cdp.eval(`typeof window.__mockAnim === "object" && window.__mockAnim !== null`));
    // Wait for the doc to actually load into the player (boot hook fetches ?annotations=<name>).
    await waitFor("annotations loaded", async () =>
      cdp.eval(`(window.__mockAnim.getDuration() >= 0) && true`),
    );

    fs.mkdirSync(outDir, { recursive: true });

    // (5) per-comment isolated capture.
    const index = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const nnnn = String(i + 1).padStart(4, "0");
      const png = `${nnnn}_t${c.tMs}.png`;

      // Risk #2: AWAIT the reading-pane settle barrier so the screenshot isn't a half-rendered pane.
      await cdp.eval(`window.__mockAnim.seekSettled(${Number(c.tMs)})`);
      await cdp.eval(DOUBLE_RAF);
      // Isolate THIS comment only (so shared-tMs comments produce distinct clean frames).
      await cdp.eval(`window.__mockAnim.focusComment(${JSON.stringify(c.id)})`);
      await cdp.eval(SINGLE_RAF);

      const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const buf = Buffer.from(shot.data, "base64");
      fs.writeFileSync(path.join(outDir, png), buf);
      index.push({ commentId: c.id, tMs: c.tMs, text: c.text ?? "", png });
      console.log(`[capture-annotations]   ${png}  (comment ${c.id} @ ${c.tMs}ms, ${buf.length} bytes)`);
    }

    // Return the overlay to normal window behavior.
    await cdp.eval(`window.__mockAnim.focusComment(null)`).catch(() => {});

    // (6) index.json.
    fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");

    console.log(`\n[capture-annotations] DONE: ${index.length} PNG(s) + index.json at ${outDir}`);
  } finally {
    // (7) robust teardown — kill children + clean the temp dir even on error.
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    // Kill each child's whole PROCESS GROUP (they were spawned detached, so their pid is the group
    // leader; the negative-pid signal reaches grandchildren — vite's esbuild, Chrome's helpers — that
    // a bare child.kill() would orphan and leave holding the port). Fall back to the single pid.
    killTree(chrome);
    killTree(vite);
    // Give the children a beat to release the temp dir, then remove it.
    await sleep(300);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(`[capture-annotations] FATAL: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});
