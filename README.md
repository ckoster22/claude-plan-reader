# Claude Plan Reader (multiplan branch)

A macOS desktop app that browses and live-renders [Claude Code](https://claude.com/claude-code) plan markdown files from `~/.claude/plans/`, with native rendering of nested master ▸ sub-plan trees.

> **Branch note.** This is the **`multiplan`** branch — it includes the nested plan-tree sidebar (see [Plan trees](#plan-trees) below). The **[`main`](https://github.com/ckoster22/claude-plan-reader/tree/main)** branch has that feature removed for a simpler shareable build. Pick whichever you need.

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
git checkout multiplan
npm install
npm run tauri dev
```

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

The DOM selector contract and the Tauri command/event surface (including the nested-hierarchy `PlanRecord` fields and the `set_tree_collapsed` command) are documented in [`CONTRACT.md`](CONTRACT.md).
