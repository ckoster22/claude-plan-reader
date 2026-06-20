# Claude Plan Renderer

macOS desktop app (Tauri v2) that browses and live-renders Claude Code plan markdown files from `~/.claude/plans/`. The sidebar lists plans newest-first with each plan's originating working directory and a bold title when it has unread edits; the reading pane renders full-fidelity markdown (mermaid, images, links, code) and auto-reloads in place when a plan changes on disk.

## Stack
- **Tauri v2** (~2.11): Rust backend (`src-tauri/`) + system WebView frontend.
- **Frontend**: vanilla TypeScript + Vite. Rendering via `markdown-it`, `highlight.js`, `mermaid` (lazy-loaded), `dompurify`.
- **Tests**: `vitest` (jsdom) for the frontend, `cargo test` for Rust.

## Commands
- `npm run tauri dev` — run in development (hot reload).
- `npm run tauri build` — build the distributable `.app`/`.dmg` (output under `src-tauri/target/release/bundle/`).
- `npm test` — frontend unit tests (vitest).
- `npx tsc --noEmit` — typecheck.
- `cd src-tauri && cargo test --lib` — backend unit tests.

## Architecture
- **Rust backend** (`src-tauri/src/lib.rs`): commands `list_plans` (mtime-sorted; fills cached `cwd` + `unread` per plan), `read_plan_contents`, `read_image_as_data_url`, `resolve_cwds`, `set_open_plan`, `mark_viewed`; a `notify` file watcher over `~/.claude/plans/` emitting the `plan-changed` event. State (cwd cache + read-state) is persisted under the Tauri app-data dir as `cwd-cache.json` / `read-state.json` via atomic temp-write+rename.
- **Frontend**: `src/main.ts` wires commands/events; `src/render/` owns the reading pane (markdown/mermaid/image/link rendering); `src/cwd.ts` + `src/resolve.ts` own the sidebar cwd/read-state; `src/titlebar.ts` owns window drag/zoom. The reading pane and the sidebar are separate domains — keep them disjoint.
- **`CONTRACT.md`** is the source of truth for the DOM selector contract and the Tauri command/event surface. Update it additively, never rewrite prior sections.

## Conventions & gotchas (learned the hard way)
- **Window drag** requires the `core:window:allow-start-dragging` capability in `src-tauri/capabilities/default.json` — it is NOT included in `core:default`. `data-tauri-drag-region` silently no-ops without it. Double-click-to-zoom needs `core:window:allow-toggle-maximize` (note: `allow-toggle-maximization` is NOT a valid permission name).
- **Local images** cannot be served via Tauri's asset protocol: its `FsScope` globs do not match path segments beginning with `.` (e.g. `~/.claude/...`), so they 403. Use the `read_image_as_data_url` Rust command instead; CSP stays `null`.
- **mermaid** is initialized with `securityLevel: "loose"` (needed for `<br/>`/HTML labels), which does NOT auto-sanitize — the rendered SVG is sanitized with DOMPurify before `innerHTML` (the config must preserve `foreignObject` / HTML integration points or multi-line labels collapse).
- **cwd resolution**: a plan's originating directory is found by scanning `~/.claude/projects/<encoded-cwd>/*.jsonl` AND `<session>/subagents/agent-*.jsonl` (~40% of plans are written by subagents) for the plan-write event, then reading that record's in-file `cwd`. Never reverse-decode the encoded directory name (it is lossy). `sessions-index.json` is a sparse, optional fast-path. Unresolved → render "unknown".
- **CLI plan-save duplicates**: the bundled Claude Code CLI saves ITS OWN frontmatter-less copy of every plan-mode plan (on ExitPlanMode) into `~/.claude/plans/`, slugged from the session's first user message + a random word pair (e.g. `we-are-running-the-vast-pebble.md`) — a byte-identical duplicate of the app's `write_agent_plan` copy that renders as a separate top-level standalone sidebar row. The sidecar redirects these via the `plansDirectory` flag-setting to `.plan-tree/cli-plans/` (`sidecar/cli-plans.ts`); the value MUST stay a relative path (the CLI requires it to resolve inside the project root).
- **Read/unread**: a plan is unread when its mtime is newer than its last-viewed time; the currently-open plan continuously updates its last-viewed time so live edits to the plan you are actively watching do not mark it unread.
- **Prototype permission seam**: the host-side `"prototype"` write policy (writes allowed only under `<cwd>/.plan-tree/prototype/`) maps to SDK permissionMode `"default"`, because SDK `"plan"` mode hard-blocks `Write` at the CLI tier regardless of `canUseTool`. But in `"default"` mode the user's `~/.claude/settings.json` `permissions.allow` rules evaluate BEFORE `canUseTool` (SDK precedence: PreToolUse hooks → deny rules → mode → allow rules → `canUseTool`) — so containment is enforced at the PreToolUse hook tier (`sidecar/permissions.ts` `prototypeHookDecision` / `createPrototypePreToolUseHook`). Never rely on `canUseTool` alone for `"default"`-mode sessions.
- The app reads two **read-only** trees under `~/.claude/`: `plans/` (rendered + watched) and `projects/` (used only for cwd resolution). It also writes to a self-owned control directory `~/.claude/plan-reader/**` (review IPC: requests/responses + an `app.alive` heartbeat, all atomic + containment-guarded) and performs a single idempotent additive merge into `~/.claude/settings.json` to install/remove the ExitPlanMode review hook. As the app becomes a standalone Claude Code replacement, it now also **writes its own agent-produced plans into `~/.claude/plans/`** via the `write_agent_plan` command (atomic temp+rename, containment-guarded to the plans dir, frontmatter-tagged with `tree_id`/`flavor`/`nn` for sidebar nesting) — `plans/` is now its canonical, single-rooted plan store, not a read-only tree. It still NEVER writes into `~/.claude/projects/`.

## Notes
- The app is unsigned; first launch needs right-click → Open (Gatekeeper). Signing/notarization is not configured.
- `.plan-tree/` holds the multiplan planning state (master plan + per-sub-plan plans and summaries) used to build this project.
