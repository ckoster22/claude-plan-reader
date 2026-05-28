# Contract — Claude Code Plan Renderer

The source of truth for the DOM selector contract and the Tauri command/event surface. Two
sections:

1. DOM selector contract
2. Tauri command / event surface

---

## 1. DOM selector contract

These **stable ids** mark the containers the renderer renders into and the sidebar mutates:

| id | element | purpose |
|----|---------|-----------------|
| `#plan-list` | the `.plan-list` sidebar container | sidebar rows rendered/updated here |
| `#reading-pane` | the `.md` rich-content container | holds rendered **markdown HTML** (headings, lists, GFM tables, highlighted code, mermaid SVG, images, links) |
| `#reader-scroll` | the scrollable `.reader` element | scroll-preservation anchor — element/source-line anchored (survives async mermaid/image height changes) |
| `#doc-filename` | reader header filename slot | filename display |
| `#doc-src` | reader header cwd slot | cwd display (filled by the cwd resolver) |
| `#doc-saved` | reader header saved-time slot | saved / reload status |
| `#watch-path` | titlebar watched-path chrome | watched directory text |
| `#plan-count` | sidebar-head count chrome | file count |

> **Amendment 2026-05-25 — `#doc-saved` REMOVED.** The `#doc-saved` reader-header
> saved-time slot (the "auto-reloaded on file change" status indicator) was removed from
> the app on **2026-05-25** at the user's request, and is **no longer present in the DOM**
> (`index.html`, `src/main.ts`, `src/styles.css`). Its table row above is retained verbatim
> for the historical contract record; treat the selector as **retired** — do not build
> against it. No other selector in §1 is affected.

> **Amendment 2026-05-25 — `#watch-path` (live-watching chrome) REMOVED; `.titlebar-controls`
> slot + theme toggle ADDED.** The `#watch-path` titlebar text and its enclosing
> `.watch-path` container — together with the `.live-badge` / `.live-pulse` "Live watching …"
> indicator and the `@keyframes pulse` animation — were removed on **2026-05-25** at the user's
> request (redundant). The `#watch-path` table row above is retained verbatim for the historical
> record; treat it and the `.watch-path`/`.live-badge`/`.live-pulse` classes as **retired** — do
> not build against them. In their place, the titlebar hosts a frozen **`.titlebar-controls`**
> slot (right-aligned, `margin-left:auto`) carrying these controls:
>
> | selector | element | purpose |
> |----------|---------|-----------------|
> | `.titlebar-controls` | right-aligned flex slot inside `.titlebar` | holds the interactive titlebar controls as siblings |
> | `#theme-toggle` | icon-only `<button class="theme-toggle">` in the slot | dark/light theme toggle |
> | `#theme-icon` | `<span>` inside `#theme-toggle` | the sun (`&#9788;`, dark) / moon (`&#9789;`, light) glyph |
>
> The persisted-theme localStorage key **`plan-reader-theme`** (`"dark"` opts in; absent/`"light"`
> ⇒ light, the default appearance) is read before first paint by an inline anti-FOUC script in
> `index.html` and written on toggle by `initThemeToggle` (`src/titlebar.ts`, exporting
> `THEME_KEY`); the literal is duplicated between the two and pinned by `src/contract.test.ts`.
> The Prompt Feedback button + feedback overlay selectors mount as later siblings inside
> `.titlebar-controls` (documented in the Prompt Feedback section below).

### Per-row template

Each sidebar row, built by `buildFlatRow()`, is:

```html
<div class="plan [active] [unread]" data-path="<absolute path>">
  <div class="plan-row">
    <span class="plan-title">…stem…</span>
    <span class="unread-dot"></span>
  </div>
  <div class="plan-src">…dimmed cwd subtitle…</div>
  <div class="plan-meta"><span class="when">…relative mtime…</span></div>
</div>
```

- `data-path` carries the **absolute** plan path (the key for click → read and for
  matching `plan-changed` events).
- The sidebar owns toggling `.unread` and filling `.plan-src` (from the resolved cwd).
- The renderer never touches the sidebar.
- `.active` marks the currently-open plan (set on click; preserved across re-lists).
- The reading pane emits real markdown HTML into `#reading-pane`. (`.md.raw` —
  `white-space: pre-wrap`, monospace — survives only as the read-failure fallback.)

### Titlebar drag-region convention (additive — window-drag fix)

The `.titlebar` carries `data-tauri-drag-region` so the window can be moved by
dragging the bar (the OS traffic lights sit over its left inset via
`titleBarStyle:"Overlay"` + `trafficLightPosition`). **Tauri v2 starts a window
drag only when the mousedown event's `target` is the element bearing the
attribute — it does not walk ancestors.**

> **Amendment 2026-05-25 — real exclusion mechanism for interactive
> controls.** The original convention (passive children made `pointer-events:none`
> so mousedown falls through to `.titlebar`) is superseded now that the titlebar
> hosts genuinely **interactive** controls (the `#theme-toggle` in
> `.titlebar-controls`, and the Prompt Feedback button/overlay). Interactive children
> **keep `pointer-events:auto`** (they must receive clicks). Window-drag exclusion
> for them is enforced **in JS**: the explicit drag handler `isDragTarget`
> (`src/titlebar.ts`) **bails when the mousedown target is — or is inside — an
> interactive control** (`button, a, input, select, textarea, [data-no-drag]`)
> *before* the drag-region match. **Omitting `data-tauri-drag-region` on the child
> is insufficient on its own**, because `closest("[data-tauri-drag-region]")` still
> matches the ancestor `.titlebar`. This is the invariant any added titlebar control
> relies on: just put it in the slot as an ordinary interactive element
> (`button`/`a`/`input`/etc., or mark a wrapper `[data-no-drag]`) — no `pointer-events`
> hack and no per-control drag attribute needed. Native traffic lights are unaffected
> (OS-painted, not DOM). Guarded by `src/titlebar.test.ts` (a primary mousedown on
> `#theme-toggle`, with `.titlebar`'s drag attribute intact, must NOT call `startDragging`).

---

## 2. Tauri command / event surface

### `list_plans() -> Vec<PlanRecord>`

Reads `~/.claude/plans`, filters `*.md`, stats each, sorts **mtime descending**
(newest-first). Missing/empty dir → empty list (never errors). Per-entry I/O errors skip
that entry. Never panics on pre-epoch / clock-skew mtimes.

```rust
#[derive(Serialize)]
struct PlanRecord {
    absolute_path: String,
    filename_stem: String,
    mtime_ms: i64,        // millis since UNIX_EPOCH, JS-friendly (Date.now() comparable)
    cwd: Option<String>,  // resolved cwd (cwd resolver), else None
    unread: bool,         // read/unread state
    h1s: Vec<String>,     // plan's ATX H1 texts (fence-aware head scan) for sidebar filtering
}
```

The wire shape is **frozen at exactly these six snake_case keys** (`absolute_path`,
`filename_stem`, `mtime_ms`, `cwd`, `unread`, `h1s`) — guarded on the producing side by the Rust
test `planrecord_wire_contract_is_frozen` and on the consuming side by `src/contract.test.ts`'s
`EXPECTED_KEYS`. `cwd`/`unread`/`h1s` are documented in the cwd-resolver and sidebar-filter
sections below.

TypeScript mirror (`src/types.ts`): `cwd: string | null`, `unread: boolean`, `h1s: string[]`.

### `read_plan_contents(path: String) -> Result<String, String>`

Canonicalizes **both** the requested `path` **and** the plans-root and verifies
containment (`canon_path.starts_with(canon_root)`) — canonicalizing both sides defends
against a symlinked `$HOME` and path traversal. Rejects anything outside the plans dir or
not a regular file. Reads bytes and **lossy-decodes UTF-8** (invalid UTF-8 never panics).
Returns `Err(String)` on any failure.

> **Invocation note:** Tauri serializes the JS arg `{ path }` to the Rust `path` param.

### Event: `plan-changed`

Emitted by the `notify-debouncer-full` watcher (non-recursive, on the plans dir,
400 ms debounce) for any debounced **create / modify / remove** (plus the catch-all
`any`) touching a `*.md`. The `kind` field is exactly one of `"create" | "modify" |
"remove" | "any"` — there is **no** `"rename"` kind. The `notify` crate's `EventKind`
has no `Rename` variant, so atomic saves (temp-write + rename, e.g. vim / Claude's hook)
surface as `modify` / `remove` / `create` events — never a literal `"rename"`. The
debouncer's internal `RecommendedCache` file-ID tracking is what makes coalescing these
into reliable per-file change notifications work.

```rust
#[derive(Serialize)]
struct PlanChanged {
    path: String,   // absolute path of the changed .md
    kind: String,   // "create" | "modify" | "remove" | "any"  (no "rename")
}
```

Frontend behavior on a `plan-changed`: always re-run `list_plans` (re-sorts by recency); if
`payload.path === <open plan path>`, re-fetch contents, re-render, and restore the viewport
via an element/source-line anchor.

> **Scroll-restore mechanism.** The reload captures an **element/source-line anchor** (the
> first `[data-source-line]` block at the viewport top, plus its pixel offset) before
> re-render, then re-derives the nearest block by source line and restores that block's offset.
> The delta is applied twice — once after the synchronous text lands and again after `settle()`
> (mermaid render + image load) so async height changes don't drift the viewport.

---

## Rendering (markdown → HTML)

These supplement (never alter) §2's frozen command/event signatures.

### `read_image_as_data_url(path: String) -> Result<String, String>`

Consumed by the renderer (`src/render/assets.ts`) to inline **local** images. Returns a
`data:` URL for the file at `path`; `Err(String)` on failure. The frontend resolves a
markdown `![](src)` to this path by joining a relative `src` against the open plan's parent
directory (absolute `src` used as-is); `http(s):`/`data:` srcs bypass the command entirely.
The frontend tests mock it.

### DOM conventions emitted into `#reading-pane`

| attribute / class | element | meaning |
|-------------------|---------|---------|
| `data-source-line="<n>"` | every top-level block-open tag (and code/mermaid `<pre>`) | 0-based source line of the markdown block — the anchor key for scroll restore |
| `data-external="1"` | `<a>` | href is `http(s):`/`mailto:` → click opens **externally** (opener plugin), never navigates the WebView |
| `class="mermaid-src"` | `<pre>` | carries raw mermaid **source**; replaced in place by rendered SVG (or a raw-source error box) by `settle()` |
| `data-resolve="1"` + `data-local-src` | `<img>` | local-image placeholder; an async pass swaps in the resolved `data:` URL after insertion |
| `class="task-checkbox"` (+ `disabled`) on `<input type="checkbox">`, `class="task-list-item"` on `<li>`, `class="task-list"` on the list | task list | GFM `- [ ]`/`- [x]` items render as a **disabled** (read-only) checkbox input prepended to the item text; the list marker is suppressed on task items |

### Mermaid SVG sanitization (security)

Mermaid runs with `securityLevel:"loose"` (required for `<br/>` multi-line label fidelity).
**Loose mode does NOT auto-sanitize:** mermaid 11 only runs its internal DOMPurify pass in
the `!isLooseSecurityLevel` branch, so the SVG returned by `mermaid.render()` is **untrusted
markup** that could carry injected `<script>`/`on*` handlers from a prompt-injected plan.

We therefore sanitize the SVG **ourselves** with DOMPurify before any `innerHTML` injection
(`src/render/mermaid.ts` → `sanitizeSvg`), using profile
`{ svg, svgFilters, html }` + `ADD_TAGS:['foreignObject']` +
`HTML_INTEGRATION_POINTS:{ foreignobject:true }`. This strips `<script>` and event-handler
attributes while preserving `<foreignObject>`/`<br>` multi-line labels (the integration-point
flag is required, else DOMPurify's namespace check drops foreignObject's HTML children). We
also never call mermaid's returned `bindFunctions`, keeping any embedded click/script inert.

### `settle()` ordering (scroll-restore correctness)

`renderInto()` is purely synchronous (markdown → HTML only) so the first post-render
`applyDelta()` anchors against a stable text-only layout. `settle()` then runs the async
work **in order**: (1) `resolveLocalImages` (await — swaps real `data:` URLs onto local
`<img>` placeholders), (2) `renderDiagrams` (mermaid), (3) `awaitImages` (await load/error
with a per-image timeout). Resolving local images **before** awaiting them is required:
`awaitImages` skips any `<img>` still carrying `data-resolve`/empty `src` (such a placeholder
reports `complete===true` and would otherwise be falsely counted as loaded), so the second
`applyDelta()` after `settle()` correctly accounts for local-image height growth.

### Dependency versions (pinned, `src-tauri/Cargo.toml`)

| crate | version | note |
|-------|---------|------|
| `notify` | `=8.2.0` | cross-platform FS notifications |
| `notify-debouncer-full` | `=0.7.0` | ≥0.4; uses `RecommendedCache` file-ID cache internally. **Current stable constructor is the 3-arg `new_debouncer(timeout, tick_rate, handler)` form** — verified by compiling against 0.7.0. The 4-arg `RecommendedCache::new()` form is **not** in any released stable version. |
| `dirs` | `=6.0.0` | locate `~` |

---

## 3. cwd-resolution field set

The data model the cwd resolver builds against (the production resolver lives in
`src-tauri/src/lib.rs`).

### Real field set

A plan-path string appears across **multiple** record types under different field names;
`file_path` is a minority. The resolver must prefer the authoritative signal first:

| priority | record | discriminator | field carrying the plan path | also carries |
|----------|--------|---------------|------------------------------|--------------|
| 1 (authoritative) | `attachment` | `attachment.type == "plan_mode"` | `attachment.planFilePath` | `attachment.isSubAgent` (bool) |
| 2 (fallback) | `tool_use` | `message.content[].type == "tool_use"` & `name == "Write"` | `input.file_path` | — |
| 3 (last resort) | any line | line contains `/plans/<stem>.md` | (substring) | — |

For **whichever record matched**, read **that session's top-level `cwd`** field. (All
records in one transcript share the session cwd.)

> **`isSubAgent` caveat:** `isSubAgent` is only present on **priority-1** matches (the
> `plan_mode` `planFilePath` attachment). For **priority-2** `Write`-fallback matches it is
> absent — in that case subagent-ness is instead derived from the plan stem's
> `-agent-<hex>` suffix (see invariant (b) below), not from any `isSubAgent` field.

**NEVER reverse-decode the encoded project directory name** — it is lossy. Verified:
`-private-tmp-canary-work` decodes ambiguously vs. the real `/private/tmp/canary_work`
(underscore vs. hyphen collapse). The on-disk top-level `cwd` is authoritative; the
encoded dir name is not.

### Transcript locations (both MUST be scanned)

- Top-level sessions: `~/.claude/projects/<encoded-cwd>/<session>.jsonl`
- Subagent transcripts: `~/.claude/projects/<encoded-cwd>/<session>/subagents/agent-*.jsonl`

### Verified invariants

- **(a)** Real sample stems resolve to a `cwd` via the authoritative `plan_mode` attachment,
  or the `Write` `file_path` fallback.
- **(b) Subagent transcripts are self-sufficient.** A `*-agent-<hex>.md` plan resolves
  **inside its own `…/subagents/agent-<hex>.jsonl`**, which carries its own top-level `cwd`.
  The parent `<session>.jsonl` may not exist on disk. So **descending into `subagents/` is
  necessary, and the resolver MUST NOT depend on walking up to a parent session.** The agent
  file's `<hex>` matches the plan stem's `-agent-<hex>` suffix — a strong owner key.
- **(c)** `cwd: Option<String>` is the correct type — a resolved stem yields `Some(path)`;
  an unknown stem yields `None` (→ display "unknown").
- **(d) Falsifiability:** a stem with no transcript match resolves to `None`, so the matcher
  is not trivially matching everything.

---

## cwd resolver + persisted read/unread

These supplement §1/§2/§3 and the rendering additions; none of those are altered.

### Managed state

A second Tauri-managed `std::sync::Mutex<AppState>` (keyed by type, alongside the watcher
debouncer `Mutex`) is `app.manage(...)`'d **unconditionally** in `setup()` — independent of
watcher success — so the `State` extractor can never hit "state not managed". `AppState`
holds: `cwd_cache: HashMap<stem, cwd>`, `read_state: { baseline_ms: i64, viewed:
HashMap<abs_path, last_viewed_ms> }`, `open_path: Option<String>`, and the resolved
`data_dir: Option<PathBuf>`.

### Persisted state files

Two JSON files live under `app.path().app_data_dir()` (created with `create_dir_all` on
first launch). **All persistence degrades, never panics:**

| file | shape | notes |
|------|-------|-------|
| `cwd-cache.json` | `{ "<filename_stem>": "<resolved cwd>" }` | only **successful** resolutions persist (sticky; a stem's cwd is historically immutable). Unresolved stems are not persisted, so a transcript appearing later can resolve on a future launch. |
| `read-state.json` | `{ "baseline_ms": <i64>, "viewed": { "<absolute_path>": <last_viewed_ms> } }` | `baseline_ms` is the first-launch seed (baseline-as-read). |

- **app_data_dir / create_dir_all failure** ⇒ in-memory only (log + continue); persistence
  silently no-ops for the session.
- **Load absent** ⇒ empty; for read-state also seed `baseline_ms = now` (persisted once).
- **Load corrupt/unparseable** ⇒ log, treat as empty, **do not** destructively rewrite the
  corrupt file, **do not** re-seed a fresh baseline (read-state degrades to `baseline_ms = 0`
  so nothing is silently force-marked read).
- **Writes are atomic:** serialize to a temp file in the same dir, then `fs::rename` over the
  target. The small map is cloned **under** the `Mutex`, the lock is **released**, then the
  disk write happens — the `std::sync::Mutex` is never held across blocking file I/O or an
  `.await`.

### Read/unread rules

- `unread = mtime_ms > viewed.get(path).copied().unwrap_or(baseline_ms)`. An **absent**
  `viewed` entry falls back to `baseline_ms`: pre-baseline plans are read; new/changed-after-
  baseline plans are unread.
- **Open plan is read by fiat:** `list_plans` forces `unread = false` for `state.open_path`,
  regardless of mtime vs. view stamp (closes the re-bold race when a plan is edited while open).
- `mark_viewed` stamps `viewed[path] = max(now_ms, file_mtime_ms + 1)` (the `max` clamp
  prevents a concurrently-landing edit from out-stamping the recorded view).

### New commands (registered in `invoke_handler`)

```rust
// JS: invoke("set_open_plan", { path })   — path: string | null
#[tauri::command]
fn set_open_plan(path: Option<String>, state: State<'_, Mutex<AppState>>);

// JS: invoke("mark_viewed", { path })      — path: string
#[tauri::command]
fn mark_viewed(path: String, state: State<'_, Mutex<AppState>>);

// JS: invoke("resolve_cwds", { stems })    — stems: string[]
// Returns the FULL requested map (Some(cwd) | null per stem).
#[tauri::command]
async fn resolve_cwds(
    stems: Vec<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<HashMap<String, Option<String>>, String>;
```

- `resolve_cwds` is **async**: the blocking corpus scan runs via
  `tauri::async_runtime::spawn_blocking`, so the (potentially thousands of transcript files)
  pass never blocks the main thread or other commands. It resolves only the requested stems
  in **one pass**, updates the in-memory cache, atomically persists `cwd-cache.json` for the
  `Some` results, and returns the full requested map. The std `Mutex` is not held across the
  spawn_blocking await.

### Resolver

The resolver runs a single corpus pass that matches the whole set of requested stems, keyed by
a `HashMap<stem, Resolution>`. A per-stem acceptance gate is preserved so that: (a) a stem
already resolved **authoritatively**
(`plan_mode` attachment) is never downgraded by a later `Write`/substring match in another
transcript; (b) authoritative beats fallback **regardless of transcript visitation order**
(provenance is ordered `PlanModeAttachment > WriteFilePath > LineContains`; an `offer` only
records a candidate of strictly higher priority); (c) per matched record uses that
transcript's record `cwd`, else the transcript's `first_cwd`. Enumeration scans top-level
`*.jsonl` **and** `<session>/subagents/agent-*.jsonl`; the encoded project dir name is never
reverse-decoded. The transcript root is a parameter of the pure scan fn (tests inject a temp
corpus).

**Same-provenance tie-break (deterministic, newest-session-wins):** `read_dir` yields files
in OS-dependent order and `offer` keeps the **first-seen** match on a provenance tie, so the
pass would otherwise be non-deterministic when a stem has two equally-authoritative (or two
last-resort) matches in different transcripts. The resolver therefore sorts the transcripts
**newest-mtime-first** (then by path descending) **before** the pass — so a same-provenance
tie resolves to the **most-recent session's** cwd (a plan's "current" cwd is its most recent
session), stable across runs and independent of caller/iteration order.

### `list_plans` now populates `cwd` / `unread`

`list_plans` gained an **injected** `state: State<'_, Mutex<AppState>>` param — the JS
`invoke("list_plans")` call is **unchanged** (Tauri injects managed state). It now fills
`cwd` from the **in-memory cache only** (no transcript scan — `list_plans` must stay fast)
and computes `unread` per the rules above (including the open-path fiat). The `PlanRecord`
shape (§2) is otherwise unchanged.

### Frontend (`src/main.ts`, `src/cwd.ts`, `src/resolve.ts` — sidebar only)

After each `refreshList`, a module-level `Set<stem>` of already-attempted stems guards a
single `resolve_cwds` call for the still-unknown stems; results late-patch each row's
`.plan-src` and the reader `#doc-src` (with its `.folder` accent). Rows show an **empty**
`.plan-src` until resolution completes (no "unknown" flash); resolved ⇒ home-collapsed
`~/…` path (`collapseHome`, mirrored by the unit-tested Rust `collapse_home` reference);
resolved-but-`null` ⇒ `"unknown"`. The selection + attempted-stems guard + retry policy live
in `src/resolve.ts` (`resolveCwds`, unit-tested): stems are marked attempted before the call,
a **`null` result pins "unknown"** (kept attempted), but a **thrown (recoverable) error
un-attempts** the stems so the next `plan-changed` retries them (they would otherwise render
empty forever). `openPlan` calls `set_open_plan` then `mark_viewed` and locally clears
`.unread`; the `plan-changed` listener keeps `set_open_plan` current and, when the **open**
plan changed, `mark_viewed`s it **before** `refreshList`. `#reading-pane` and `src/render/`
are untouched.

---

## Sidebar rendering (flat list)

The sidebar is a flat, mtime-ordered list. `renderSidebar(listEl, records, ctx)` (`src/main.ts`,
exported for unit tests) walks the records top-to-bottom and renders each as a flat `.plan` row
(the §1 per-row template). A `split_frontmatter` strip in both `list_plans` (head scan for
`h1s`) and `read_plan_contents` (body strip) means any leading YAML frontmatter block is removed
from the reading pane; plans without frontmatter pass through **byte-for-byte unchanged**. The
active/unread/cwd-patch loops iterate `#plan-list [data-path]` (each row carries `data-path`).

---

## Table-of-contents sidebar view (additive, non-breaking)

The left sidebar is now a **tabbed panel** — a `[Plans] [Contents]` tab row above two
mutually-exclusive panes. **Plans** wraps the existing newest-first list (`.sidebar-head` +
`.search` + `#plan-list`) and is **default-active**. **Contents** holds the table of contents
(H1 + H2) of the currently-open plan. None of the §1/§2/§3 or prior additive surfaces are
altered; the reader column, its width, and every prior selector are unchanged.

### New DOM selectors

| selector | element | role |
|----------|---------|------|
| `.tab-row` | row above the panes | holds the two `.tab` buttons (`role="tablist"`) |
| `.tab[data-tab]` | a tab button | `data-tab` is `"plans"` or `"contents"`; click switches panes |
| `.tab.active` | the selected tab | exactly one at a time; terracotta underline via `--accent` |
| `#tab-plans` | `.tab-pane` wrapping the plans list | **default-active**; contains the frozen `#plan-count` + `#plan-list` |
| `#tab-contents` | `.tab-pane` holding the ToC | contains `.toc-head` + `#toc-list` |
| `.tab-pane[.active]` | a switchable pane | `display:none` unless `.active` (then `display:flex` column) |
| `.toc-head` | static "Contents" label in `#tab-contents` | no per-plan filename (the reader `#doc-filename` already shows it) |
| `#toc-list` | the ToC container | **sidebar mutates** — `.toc-item` rows / `.toc-empty` built here |
| `.toc-item[.toc-h1\|.toc-h2]` | one ToC row | `<a>` carrying `data-line` (the heading's `data-source-line`); `.toc-h2` is indented |
| `.toc-item.flash` | clicked ToC row | transient click affordance (`--accent-soft`), removed shortly after — **NOT** scroll-spy |
| `.toc-empty` | placeholder in `#toc-list` | "No headings" — shown for an **open** plan with zero headings only |

### `#plan-count` placement (unchanged, frozen)

`#plan-count` stays inside the plans-pane `sidebar-head` (now nested under `#tab-plans`). It is
**not relocated** — its §1 selector is frozen. The tab buttons are plain `"Plans"`/`"Contents"`
labels and carry no count.

### Empty-state distinction

- **Nothing open yet** ⇒ `#toc-list` is **blank** (no rows, no `.toc-empty`).
- **Open plan, zero headings** ⇒ `#toc-list` shows the `.toc-empty` "No headings" affordance.
- **Read failure** (`#reading-pane` got the `.raw` fallback) ⇒ `#toc-list` is **cleared**
  (no stale entries pointing at headings that did not render).

### Heading anchor reuse — no new `#reading-pane` attribute

The ToC **reuses the existing `#reading-pane` `data-source-line` heading anchor** (stamped by
`markdown.ts` — the same key `captureAnchor`/`applyDelta` use). It introduces **no new**
`#reading-pane` attribute and **mints no `id`**.

### Sanctioned read-only render → sidebar data flow

The sidebar↔reading-pane domains stay **disjoint**: the sidebar (`main.ts`) never queries or
mutates `#reading-pane` directly. The **only** crossing is through the render facade
(`src/render/index.ts`):

- `extractToc(paneEl) -> TocEntry[]` (`src/render/toc.ts`) — a **read-only** walk of the pane's
  `h1, h2` (document order), recording each heading's `data-source-line` and trimmed text
  (`"(untitled)"` placeholder when empty). H3–H6 excluded. Mutates nothing.
- `scrollToHeading(scrollEl, paneEl, line)` (`src/render/scroll.ts`) — resolves
  `h1\|h2[data-source-line="<line>"]` and smooth-scrolls `#reader-scroll` so it sits at top;
  no-op when no match. A DOM adapter (not unit-tested under jsdom).

`renderInto` remains purely markdown → HTML (its single responsibility); extraction is a
**separate** `extractToc` call. The ToC rebuild runs **only inside the render-generation
guarded region** (after the final `renderGuard.isCurrent(gen)` check) in **both** `openPlan`
and `reloadOpenPlan`, so a superseded render never clobbers a newer render's ToC. Building or
rebuilding the ToC **never** changes the active tab — opening or live-reloading a plan rebuilds
Contents silently while the user stays on whatever tab is active (no auto-switch).

---

## Sidebar filter (additive, non-breaking)

A live free-text filter over the **Plans tab only**. None of the §1/§2/§3 or prior additive
surfaces are altered; the `PlanRecord.h1s` field (documented in the §2 struct — the
wire-contract key count is **6**) backs heading matching, and the previously-static `.search`
placeholder becomes a real interactive control.

### Backend support

`list_plans` extracts each plan's ATX H1 headings into `PlanRecord.h1s` via the pure,
**fence-aware** `extract_h1s(body)` — running on the **body half** of the `split_frontmatter`
result (no second read pass; rides the existing bounded
8 KB head read, so it never goes stale and re-runs on every `plan-changed`). The scan toggles an
"inside fenced code" flag on ` ``` ` / `~~~` lines and skips `#` lines inside a fence, so a
`# comment` in a code block is never harvested as a heading. Only ATX H1 (`# ` + space) outside
fences counts; `## ` (H2+) and `#NoSpace` are excluded.

### New / changed DOM selectors

| selector | element | role |
|----------|---------|------|
| `.search` | the (frozen) filter container | now hosts the interactive control (no longer a static placeholder) |
| `#plan-filter` | the `<input>` inside `.search` | the filter query input (`input` event re-renders the Plans list) |
| `.search .clear` | the ✕ button | clears the query + refocuses the input; revealed by `.search.has-text` |
| `.filter-empty` | placeholder in `#plan-list` | "No matching plans" — shown when a non-empty query matches nothing |
| `<mark>` (inside `.plan-title` / `.plan-src`) | matched-substring wrapper | a single `<mark>` per element wraps the matched slice (built as DOM text nodes, never innerHTML) |

### Behavior

- **Match predicate** (`matchesQuery`) ORs the plan's **title** (`filename_stem`), **cwd**, and
  **`h1s`** case-insensitively; an empty/whitespace query matches everything. The filter reads
  `h1s` (and cwd) from the **in-memory records** — it **never queries `#reading-pane`** (honors
  the sidebar↔reading-pane disjointness).
- **Highlighting** runs only on the **visible** title (`.plan-title`) and cwd (`.plan-src`); a
  **heading-only** match still shows its row, **un-highlighted** (the heading text is not
  displayed in the row).
- **Flat filter** (`filterRecords`): keeps each record iff it matches the query, preserving the
  mtime order; an empty query keeps the full list.
- **`#plan-count` text form** (selector **unchanged**, still frozen): while filtering it reads
  `"N of M"` (N = files shown, M = total files); an empty query restores the plain `"M file(s)"`
  form. The count counts every plan **file**.
- Rendering routes through `applyFilterAndRender()` (called from `refreshList` instead of
  rendering directly) and is **re-applied after a late cwd patch**, so a cwd that resolves after
  the initial render is both matchable and highlighted. The Contents/ToC tab is **never**
  filtered — `buildToc` is not called from the filter path and `#toc-list` is left untouched.

---

## Mermaid pan/zoom (additive, non-breaking)

A rendered mermaid diagram in `#reading-pane` is now **pannable and zoomable**. None of the
§1/§2/§3 or prior additive surfaces are altered; the **sanitized-SVG pipeline is unchanged**
(`src/render/mermaid.ts` still calls the same `sanitizeSvg(svg)` with the same
`MERMAID_SANITIZE_CONFIG`, and never calls `bindFunctions`). The interaction layer wraps **outer
divs we create** — it never re-wires the sanitized SVG content.

### New DOM selectors (inside a successfully-rendered `.mermaid-box.mermaid-rendered`)

| selector | element | role |
|----------|---------|------|
| `.mermaid-viewport` | fixed-height (~340px) clipped frame inside `.mermaid-box` | the interactive region; `cursor: grab`, gains `.dragging` (`cursor: grabbing`) during a drag-pan; bordered/gridded so the bounded zone is obvious. Owns the `wheel` (`{passive:false}` + `preventDefault`) + `mousedown` + `dblclick` listeners |
| `.mermaid-stage` | transformed wrapper inside `.mermaid-viewport` | `transform-origin: 0 0`; carries the CSS `transform: translate(<tx>px, <ty>px) scale(<scale>)` (convention: screen = content·scale + translate). Holds the **SAME sanitized SVG** that previously sat bare in `.mermaid-box`. `.mermaid-stage svg { max-width: none }` so the SVG renders at natural size (pannable, not squashed by the `.mermaid-box svg { max-width: 100% }` rule) |
| `.mermaid-ctl` | control cluster (bottom-right of the viewport) | holds three `<button>`s: `+` (zoom in), `−` (zoom out), `⤢` (reset / centered fit) |
| `.mermaid-zoom-readout` | label (bottom-left of the viewport) | live zoom percentage (e.g. `"100%"`); updated on every state change; `pointer-events: none` |

### Behavior

- **Drag** inside `.mermaid-viewport` pans; **scroll/wheel** over it zooms **toward the cursor**
  (cursor-stationary), bounded to **30%–400%**; **double-click** re-fits (centered). The `+/−`
  buttons zoom about the viewport center.
- **Per-diagram state resets on every render.** `renderDiagrams` rebuilds a fresh `.mermaid-box`
  (and a fresh pan/zoom controller initialized to a centered fit) on every render, **live reload,
  and plan switch** — there is no carried-over pan/zoom. The previous render's controller is
  `destroy()`'d first so no listeners leak.
- **Listener discipline:** drag `mousemove`/`mouseup` listeners attach to `window` **only during
  an active drag** and are removed on mouseup (and on `destroy()`); the `wheel`/`mousedown`/
  `dblclick` listeners live on the viewport and are removed on `destroy()`.
- **Wheel-capture trade-off (intended):** because the viewport calls `preventDefault` on `wheel`,
  scrolling the page with the cursor over a diagram **zooms instead of scrolling**. Accepted — the
  viewport is a fixed-height clipped band with a clear `cursor: grab` + bordered affordance. This
  matches the approved prototype.
- **`settle()` ordering unchanged:** wrapping the SVG in `.mermaid-viewport > .mermaid-stage` adds
  no `<img>`, so `awaitImages` scroll-anchoring (§"`settle()` ordering") is unaffected.

### Pure pan/zoom module (`src/render/panzoom.ts`)

Side-effect-free, unit-tested functions plus one DOM adapter:
`clampScale(scale, min=0.3, max=4)`, `zoomAt(state, cursorX, cursorY, factor)` (cursor-stationary),
`fitState(viewportW, viewportH, contentW, contentH)` (centered fit, `min(vw/cw, vh/ch, 1)*0.92`,
guards zero/NaN content dims), `transformString(state)` → `translate(<tx>px, <ty>px) scale(<scale>)`,
and `attachPanZoom(viewportEl, stageEl, opts?)` → `{ zoomIn, zoomOut, reset, getState, destroy }`.

## Highlight + comment with quoted-text anchoring (additive, non-breaking)

The reading pane gains a select-text → comment affordance. A saved comment wraps the selection
in highlight span(s) and persists to a new `comments.json` store. Highlights survive
`renderInto`'s `innerHTML` wipe (live-reload / plan-switch) via **quoted-text anchoring**. The
**backend is the single source of truth for the comment count**; the frontend reads it via a
command, never the DOM. `PlanRecord` is **UNCHANGED (6 keys)** — comments do NOT ride on it.

### New DOM selectors

| Selector | Where | Role |
|----------|-------|------|
| `#sel-popover` (+`.hidden`) | child of `.window`, **OUTSIDE `#reading-pane`** | the selection popover; survives the pane's `innerHTML` wipe. The single applier `renderPopover(state)` in `src/render/comments.ts` is the **sole writer** of `.hidden`. NO `data-tauri-drag-region`. |
| `#sp-quote` | inside `#sel-popover` | the quoted-selection display (set only by `renderPopover`) |
| `#sp-text` | inside `#sel-popover` | `<textarea>` for the comment (cleared/populated only by `renderPopover`) |
| `#sp-cancel` | inside `#sel-popover` | cancel button (hide + discard) |
| `#sp-save` | inside `#sel-popover` | save (create mode) / clear-this-comment (view mode) |
| `.cmt-hl` + `data-c="{id}"` | inside `#reading-pane` | committed highlight span(s); a multi-element selection yields **several sibling spans sharing one `data-c`** (never crosses element boundaries — no `surroundContents`). `.cmt-hl.active` is the hover/active variant. |

### New CSS tokens

`--hl` / `--hl-active` are defined for BOTH the light `:root` and the dark `:root[data-theme="dark"]`
(values sourced from the prototype). They back `.cmt-hl` / `.cmt-hl.active` and `.md ::selection`.

### `CommentRecord` (mirrors the Rust struct; frozen 5-key wire shape)

```
{ quote: string,            // normalized (whitespace-collapsed, trimmed) selected text
  block_line: number | null,// data-source-line of nearest enclosing block; `null` ⇒ whole-pane scan
  occurrence: number,       // 0-based Nth match of `quote` within the chosen root
  comment: string,          // the user's comment
  id: number }              // collision-free id (= max existing id + 1); also the span's data-c
```

`block_line` is `Option<i64>` in Rust (serde emits `null`) / `number | null` in TS — mirroring the
existing `cwd: Option<String>` precedent. There is **NO `-1` sentinel**: "no enclosing block" is the
type. `block_line` + `occurrence` together are the minimal deterministic re-anchor disambiguator.
Keying-by-plan-path lives in the store map, not the record (mirrors `read-state.json`).

### New commands (registered in `invoke_handler`)

| Command | Returns | Notes |
|---------|---------|-------|
| `get_comments(path) -> Vec<CommentRecord>` | the plan's comments (empty when none) | |
| `get_comment_count(path) -> usize` | the plan's comment count | the **cold-read** count path — answers WITHOUT loading the array frontend-side (count must persist when the pane is empty or another plan is open). The 02→03 contract surface. |
| `set_comments(path, comments) -> Vec<CommentRecord>` | the **authoritative resulting array** | full-array replacement; an **empty array REMOVES the key**. The frontend adopts the return value as its cache (cache == last backend-confirmed value). |
| `clear_comments(path) -> Vec<CommentRecord>` | the empty array `[]` | wipes all comments for the plan |

All four follow the snapshot-then-persist-outside-lock discipline (the `std::sync::Mutex` is
**never** held across the blocking `atomic_write`), exactly like `mark_viewed`.

### `comments.json` store

`AppState.comments: HashMap<String, Vec<CommentRecord>>` (plan absolute_path → its comments),
persisted to `comments.json` under the app-data dir via `atomic_write` (temp-write + rename),
loaded in `init_app_state` alongside `cwd-cache.json` / `read-state.json`.
Same **graceful-degradation** rules: absent ⇒ empty; corrupt ⇒ log + empty **without rewriting**
the bad file; no data dir ⇒ in-memory only (persistence no-ops). Empty per-plan arrays are never
stored (an empty `set_comments` removes the key).

### Facade surface (`src/render/index.ts`)

Re-exports `applyComments(paneEl, records)`, `initComments(paneEl, getPlanPath, io)`,
`onCommentCountChanged(cb: () => void)` (a **zero-arg** notification fired after an in-pane save/
clear mutation; the facade does NOT compute the count), and `loadCommentsFor(paneEl, path)` (plus
the `CommentsIO` type). `renderInto` stays a **pure markdown→HTML transform** — no highlight logic.
The popover positioning is an un-unit-tested DOM adapter (jsdom has no layout).

## Prompt Feedback button + overlay (additive, non-breaking)

Added 2026-05-25. These supplement the comment additions; none of the §1/§2/§3 or prior
surfaces are altered. **`PlanRecord` is UNCHANGED (still 6 keys)** — the feedback feature
consumes the existing comment commands/count and adds no `PlanRecord` field.

The Prompt Feedback feature is the visible consumer of the comment count pipeline: a **"Prompt Feedback"**
button in the `.titlebar-controls` slot that appears only when ≥1 comment exists, opening an overlay
that shows a generated Claude Code prompt quoting each highlighted snippet alongside its comment,
with **Copy** and **clear-comments** actions. The **backend `comments.json` remains the single
source of truth for the count** (read via `get_comment_count` / `get_comments`, never the DOM).

### New DOM selectors

| Selector | Where | Role |
|----------|-------|------|
| `#feedback-btn` (+`.hidden`) | **FIRST child** of `.titlebar-controls` (left of `#theme-toggle`) | the Prompt Feedback button; starts `.hidden`, shown by `applyFeedbackButtonState` when count ≥ 1. NO `data-tauri-drag-region` — drag-immunity for this `<button>` is the `isDragTarget()` interactive-target bail in `src/titlebar.ts`. |
| `#feedback-count` | inside `#feedback-btn` | the count badge; text set to `String(count)` by `applyFeedbackButtonState` |
| `#feedback-overlay` (+`.hidden`) | child of `.window`, **OUTSIDE `#reading-pane`** (sibling of `#sel-popover`) | the feedback overlay; `position: fixed` (NOT `absolute` — `.window`/`.titlebar` are `position: static`, and `fixed` avoids adding `position: relative` to `.window`, which would shift `#sel-popover`'s JS coords). Toggled by `main.ts`. NO `data-tauri-drag-region`. |
| `#feedback-body` | inside `#feedback-overlay` | a `<pre>` holding the generated prompt (snapshot at open via `buildFeedbackPrompt`); whitespace/newlines render as-is. |
| `#feedback-copy` | inside `#feedback-overlay` | Copy button → `navigator.clipboard.writeText(prompt)` (best-effort) |
| `#feedback-clear` | inside `#feedback-overlay` | clear-all button → facade `clearAllComments` then hide the overlay |

### Pure prompt builder (`src/feedback.ts`)

`buildFeedbackPrompt(records: Pick<CommentRecord, "quote" | "comment">[]): string` — a lead line,
then ONE numbered entry per record (`N. Re: "<quote>"`, the comment on the next indented line). It
**emits one entry per record and never skips empty-comment records** (an empty comment yields a
quote-only entry), so the entry count always equals the badge count. Long quotes are clamped (~90
chars + ellipsis). Pure: lives in the `main.ts`/title-bar domain, NOT the render facade.

### Facade surface additions (`src/render/index.ts`)

Re-exports **`clearAllComments(paneEl, path)`** (alongside `applyComments`, `initComments`,
`onCommentCountChanged`, `loadCommentsFor`). It is exposed by a **second per-pane `WeakMap`
registry mirroring `loaderRegistry`**: `initComments` registers a per-pane closure that removes
every highlight by iterating the cached record ids via `clearHighlight` (BEFORE clearing the cache,
since `io.clearAll` returns `[]`), then calls `io.clearAll(path)`, adopts the returned `[]` into the
cache, and fires `onCommentCountChanged`. `main.ts` hands in the pane element exactly like
`initComments` / `loadCommentsFor` — it never reaches into `#reading-pane`.
