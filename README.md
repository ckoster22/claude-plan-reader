# Claude Plan Reader (agent-sdk branch)

A macOS desktop app that browses and live-renders [Claude Code](https://claude.com/claude-code) plan markdown files from `~/.claude/plans/`, with native rendering of nested master ▸ sub-plan trees.

> **Branch note.** This is the **`agent-sdk`** branch — beyond the plan reader/sidebar it also *drives* Claude Code itself: a New-plan composer starts a live agent session (via a bundled `agent-driver` sidecar built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) that runs the recursive multiplan orchestrator — recon → sizer → decomposition/plan gates → execute → roll-up — with an in-app review surface and an ExitPlanMode review hook (see [Driving agent sessions](#driving-agent-sessions) below). The **[`multiplan`](https://github.com/ckoster22/claude-plan-reader/tree/multiplan)** branch is the read-only reader with the nested plan-tree sidebar but no agent driver; the **[`main`](https://github.com/ckoster22/claude-plan-reader/tree/main)** branch drops the tree feature for a simpler shareable build. Pick whichever you need.

When Claude Code writes a plan to disk (via `ExitPlanMode`), it lands as a markdown file in `~/.claude/plans/`. Plans can contain code blocks, mermaid diagrams, images, and links — and they're *living documents* the model edits between sessions. This app gives them a real reading surface.

## What it does

- **Sidebar** — every plan, newest first, with its originating working directory and an unread indicator when a plan you've already opened has been edited on disk. Nested master ▸ sub-plan trees collapse behind a disclosure twirl and show an "N sub-plans" count.
- **Reading pane** — full-fidelity markdown: syntax-highlighted code, rendered mermaid diagrams, inline images, working links. Auto-reloads in place when the file changes on disk, preserving scroll position.
- **Comments** — highlight any passage and attach a comment; comments persist per-plan in local app data.
- **Feedback prompt** — collect your highlights into one prompt ready to paste back to Claude Code as feedback on the plan.
- **Filter, table of contents, pan/zoom mermaid, dark/light theme.**

The app reads (read-only) from two directories under `~/.claude/`:
- `plans/` — the plan files, watched live for changes.
- `projects/` — used only to resolve each plan's originating working directory.

## Plan trees

The nested sidebar activates when plan files contain YAML frontmatter:

```yaml
---
tree_id: <stable-id-shared-by-master-and-children>
flavor: master   # or: sub
nn: 01           # only when flavor: sub
---
```

A master row with `child_count > 0` gets a disclosure twirl, an "N sub-plans" label, and indented children that share its `tree_id`. Collapse state is persisted in app data as `collapse-state.json` and survives restarts. Plans without the marker render as flat standalone rows. The frontmatter grammar above is what the `/multiplan` skill in Claude Code writes — but the app cares only about the marker shape, so any plan files matching it render as a tree.

## Driving agent sessions

This branch is also a Claude Code *driver*, not just a reader. Clicking **New plan** opens a composer (pick a working directory + type a request), which starts a live agent session through a bundled `agent-driver` sidecar process (Node, built on the Claude Agent SDK). The session runs the **recursive multiplan orchestrator**: every plan node — the root included — runs the same algorithm (recon → sizer → split-into-children or stay-a-leaf), holds each decomposition/plan at a **gate** for your approval, executes approved leaves, runs a no-tools **parent review** between siblings, and writes roll-up summaries. Per-node planning state lives in `<cwd>/.plan-tree/`; the agent's own plans are written into `~/.claude/plans/` (frontmatter-tagged for the tree sidebar). A persistent review bar handles ExitPlanMode plan review, visual-prototype review, and forced-acceptance review; an installable ExitPlanMode hook routes CLI plans through the same surface.

`docs/flow-visualizer.html` is a standalone, animated diagram of this recursive node algorithm and the session lifecycle — open it in any browser.

## Requirements

- **macOS** (Apple Silicon or Intel). Packaged for macOS only.
- **Node.js 18+** — for the frontend toolchain (Vite + vitest).
- **Rust toolchain** — for the Tauri backend. [rustup](https://rustup.rs/) is recommended, but a Homebrew Rust (`brew install rust`) works too; the build only needs a working `cargo`/`rustc` (1.88 verified).
- **Xcode Command Line Tools** — provides the `clang`/`cc` linker that cargo needs to link the Rust binary. Install with `xcode-select --install` (a full Xcode install also satisfies this). Without it the Rust build fails at the link step.

Tauri's other system prerequisites come in via the `@tauri-apps/cli` npm dep; you generally don't need extra setup.

## Run it

```sh
git clone https://github.com/ckoster22/claude-plan-reader.git
cd claude-plan-reader
git checkout agent-sdk
npm install
npm run tauri dev
```

`npm run tauri dev` / `tauri build` automatically run `npm run build:sidecar` first (`beforeDevCommand` / `beforeBuildCommand`), which bundles the `agent-driver` sidecar into `src-tauri/binaries/` so live agent sessions work; you don't need to build it by hand.

The first cold launch downloads and builds Rust dependencies — budget several minutes. Subsequent launches are fast.

## Build a distributable

```sh
npm run tauri build
```

Output lands under `src-tauri/target/release/bundle/macos/`. The build is **unsigned** — first launch needs **right-click → Open** to bypass Gatekeeper. Signing and notarization are not configured.

To build and install into `/Applications` in one step (replacing any existing copy), run:

```sh
bash scripts/install.sh
```

## Develop

| Command                              | Does                                           |
| ------------------------------------ | ---------------------------------------------- |
| `npm test`                           | Frontend unit tests (vitest, jsdom).           |
| `npx tsc --noEmit`                   | Typecheck the frontend.                        |
| `cd src-tauri && cargo test --lib`   | Rust backend unit tests.                       |
| `npm run tauri dev`                  | Run the app with hot reload.                   |
| `npm run tauri build`                | Build a distributable `.app` / `.dmg`.         |
| `npm run build:sidecar`              | Build the `agent-driver` sidecar binary (run automatically by `tauri dev`/`build`). |
| `npm run mock`                       | Token-free visual harness in a browser (`http://localhost:1421`). |

The DOM selector contract and the Tauri command/event surface (including the nested-hierarchy `PlanRecord` fields and the `set_tree_collapsed` command) are documented in [`CONTRACT.md`](CONTRACT.md).

## Mock mode (token-free visual QA)

`npm run mock` runs the **real, unmodified frontend** in a plain browser against a fake Tauri layer — **no Rust backend, no sidecar, no agent, and zero LLM tokens**. Every `@tauri-apps/*` import is aliased to an in-memory shim under [`src/mock/`](src/mock/), so the app code is byte-identical to production; only its IPC targets change. It exists for fast visual QA of every distinct UI state without spinning up a real session.

```sh
npm run mock        # → http://localhost:1421
```

A floating **control deck** (bottom-right) drives the app:

- **Presets** — one click jumps to any visual state: every conversation scene (assistant text, tool running/done/error, subagent group, result success/error/interrupted, fatal error, question card, ExitPlanMode review, …) and every non-conversation surface (the review bar's 4 modes, the resume banner, reading-pane variants, history replay, empty states, the composer, auth onboarding).
- **Knobs** — live toggles/selects/number/text inputs (sidebar count/unread/tree/filter, theme, text size, conversation streaming delay, question-card shape, review comment count, …) that re-drive only the affected surface through the real production seams.

The same states are scriptable via the **`window.__mock` API** (used by the deck, by a human/automation in the browser console, and by the mock test suite). Key methods:

- `playScene(name, delayMs?)` / `listScenes()` — replay a canned conversation scene.
- `showReview(mode)` / `clearReview()` — paint the review bar (`viewing` | `summary` | `prototype` | `acceptance`).
- `showResume(kind)` / `hideResume()` — the resume banner.
- `openDoc(variant)` — a reading-pane doc (`mermaid` | `table` | `code` | `image` | `error`).
- `showHistory()` / `showEmptyConversation()` / `clearConversation()` — history-replay + empty states.
- `openComposer()` / `showAuthOnboarding()` — the New-plan composer (the latter first flips auth off).
- `reset()` — return to a clean baseline (every jumper calls this first, so jumps are order-independent).

**Fidelity caveat:** the data is hand-authored fixtures, not a live agent — frames mirror the real `AgentStream` union and the orchestrator's gate shapes, but they are canned. Because the live conversation model is single-session (a private closure with no in-place reset), a **conversation jump reloads the page** (carrying the target in the URL) to obtain a genuinely fresh model — the same way the real app gets one.

A developer guide to the harness (architecture, how to add a scene/knob/command handler, and the load-bearing fidelity assumptions) lives in [`src/mock/README.md`](src/mock/README.md).
