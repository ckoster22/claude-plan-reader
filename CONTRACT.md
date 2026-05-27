# Hand-off Contract — Claude Code Plan Renderer

Frozen by **Sub-Plan 01**. Sub-Plans 02 (rendering) and 03 (cwd resolver + read/unread)
build against this surface and MUST NOT renegotiate it. Three sections:

1. DOM selector contract
2. Tauri command / event surface
3. cwd-spike findings (real field set + subagent invariant)

---

## 1. DOM selector contract

The originating prototype was class-only. Sub-Plan 01 mints these
**stable ids** on the containers 02 renders into and 03 mutates:

| id | element | owner / purpose |
|----|---------|-----------------|
| `#plan-list` | the `.plan-list` sidebar container | **03 mutates** — sidebar rows rendered/updated here |
| `#reading-pane` | the `.md` rich-content container | **02 renders into** — now holds rendered **markdown HTML** (headings, lists, GFM tables, highlighted code, mermaid SVG, images, links), no longer raw text |
| `#reader-scroll` | the scrollable `.reader` element | scroll-preservation anchor — **02: element/source-line anchored** (supersedes the raw-`scrollTop` limit below; survives async mermaid/image height changes) |
| `#doc-filename` | reader header filename slot | filename display |
| `#doc-src` | reader header cwd slot | cwd display (filled by 03) |
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
> slot + theme toggle ADDED (Sub-Plan 01).** The `#watch-path` titlebar text and its enclosing
> `.watch-path` container — together with the `.live-badge` / `.live-pulse` "Live watching …"
> indicator and the `@keyframes pulse` animation — were removed on **2026-05-25** at the user's
> request (redundant). The `#watch-path` table row above is retained verbatim for the historical
> record; treat it and the `.watch-path`/`.live-badge`/`.live-pulse` classes as **retired** — do
> not build against them. In their place, the titlebar now hosts a frozen **`.titlebar-controls`**
> slot (right-aligned, `margin-left:auto`) carrying the new controls:
>
> | selector | element | owner / purpose |
> |----------|---------|-----------------|
> | `.titlebar-controls` | right-aligned flex slot inside `.titlebar` | **01 owns**; later sub-plans append controls as **later siblings** here (never editing 01's markup) |
> | `#theme-toggle` | icon-only `<button class="theme-toggle">` in the slot | **01 owns** — dark/light theme toggle |
> | `#theme-icon` | `<span>` inside `#theme-toggle` | the sun (`&#9788;`, dark) / moon (`&#9789;`, light) glyph |
>
> The persisted-theme localStorage key **`plan-reader-theme`** (`"dark"` opts in; absent/`"light"`
> ⇒ light, the default appearance) is **01-owned**. It is read before first paint by an inline
> anti-FOUC script in `index.html` and written on toggle by `initThemeToggle` (`src/titlebar.ts`,
> exporting `THEME_KEY`); the literal is duplicated between the two and pinned by
> `src/contract.test.ts`. The **Prompt Feedback button + feedback overlay selectors are reserved
> for Sub-Plan 03**, mounting as **later siblings inside `.titlebar-controls`**.

### Per-row template (so 03 mutates a known shape)

Each sidebar row, built by 01's `buildRow()`, is:

```html
<div class="plan [active] [unread]" data-path="<absolute path>">
  <div class="plan-row">
    <span class="plan-title">…stem…</span>
    <span class="unread-dot"></span>
  </div>
  <div class="plan-src">…dimmed cwd subtitle (EMPTY in 01)…</div>
  <div class="plan-meta"><span class="when">…relative mtime…</span></div>
</div>
```

- `data-path` carries the **absolute** plan path (the key for click → read and for
  matching `plan-changed` events).
- **03 owns:** toggling `.unread` and filling `.plan-src` (from the resolved cwd).
- **02 never touches the sidebar.**
- `.active` marks the currently-open plan (set on click; preserved across re-lists).
- The reading pane in 01 used `.md.raw` (`white-space: pre-wrap`, monospace) for **raw
  text**. **02 removes `.raw` on successful render** and emits real markdown HTML into the
  same `#reading-pane`. (`.md.raw` survives only as the read-failure fallback.)

### Titlebar drag-region convention (additive — window-drag fix)

The `.titlebar` carries `data-tauri-drag-region` so the window can be moved by
dragging the bar (the OS traffic lights sit over its left inset via
`titleBarStyle:"Overlay"` + `trafficLightPosition`). **Tauri v2 starts a window
drag only when the mousedown event's `target` is the element bearing the
attribute — it does not walk ancestors.**

> **Amendment 2026-05-25 (Sub-Plan 01) — real exclusion mechanism for interactive
> controls.** The original convention (passive children made `pointer-events:none`
> so mousedown falls through to `.titlebar`) is superseded now that the titlebar
> hosts genuinely **interactive** controls (the `#theme-toggle` in
> `.titlebar-controls`, and Sub-Plan 03's button/overlay). Interactive children
> **keep `pointer-events:auto`** (they must receive clicks). Window-drag exclusion
> for them is enforced **in JS**: the explicit drag handler `isDragTarget`
> (`src/titlebar.ts`) **bails when the mousedown target is — or is inside — an
> interactive control** (`button, a, input, select, textarea, [data-no-drag]`)
> *before* the drag-region match. **Omitting `data-tauri-drag-region` on the child
> is insufficient on its own**, because `closest("[data-tauri-drag-region]")` still
> matches the ancestor `.titlebar`. This is the invariant Sub-Plan 03 relies on when
> appending more controls to `.titlebar-controls`: just put them in the slot as
> ordinary interactive elements (`button`/`a`/`input`/etc., or mark a wrapper
> `[data-no-drag]`) — no `pointer-events` hack and no per-control drag attribute
> needed. Native traffic lights are unaffected (OS-painted, not DOM). Guarded by
> `src/titlebar.test.ts` (a primary mousedown on `#theme-toggle`, with `.titlebar`'s
> drag attribute intact, must NOT call `startDragging`).

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
    cwd: Option<String>,  // RESERVED for Sub-Plan 03 — always None in 01
    unread: bool,         // RESERVED for Sub-Plan 03 — always false in 01
}
```

> **Extended additively in §"Nested master/sub hierarchy (Sub-Plan 01)"** below: `PlanRecord`
> gains five appended fields (`flavor`, `tree_id`, `nn`, `child_count`, `collapsed`) and
> `list_plans` now returns records **pre-ordered** for direct nested rendering. This block is
> unchanged; the new fields are documented there.

TypeScript mirror (`src/main.ts`): `cwd: string | null`, `unread: boolean`.

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

Frontend behavior (01): always re-run `list_plans` (re-sorts by recency); if
`payload.path === <open plan path>`, capture `#reader-scroll`.scrollTop, re-fetch
contents, replace text, restore scrollTop.

> **Scroll-restore limit (documented, not a bug):** exact for **append-at-bottom** edits.
> An **insert/delete above** the viewport shifts content, so the restored offset points at
> different text (drift). Acceptable for raw-text v1; **superseded by Sub-Plan 02's
> element-anchored restore** once async-rendered mermaid/images also change height.
>
> **SUPERSEDED by Sub-Plan 02.** 02's reload no longer captures/restores raw `scrollTop`.
> It captures an **element/source-line anchor** (the first `[data-source-line]` block at the
> viewport top, plus its pixel offset) before re-render, then re-derives the nearest block by
> source line and restores that block's offset. The delta is applied twice — once after the
> synchronous text lands and again after `settle()` (mermaid render + image load) so async
> height changes don't drift the viewport.

---

## Sub-Plan 02 additions (rendering — additive, non-breaking)

These supplement (never alter) §2's frozen command/event signatures.

### `read_image_as_data_url(path: String) -> Result<String, String>`

Consumed by the renderer (`src/render/assets.ts`) to inline **local** images. Returns a
`data:` URL for the file at `path`; `Err(String)` on failure. The frontend resolves a
markdown `![](src)` to this path by joining a relative `src` against the open plan's parent
directory (absolute `src` used as-is); `http(s):`/`data:` srcs bypass the command entirely.
**Owned by the backend track** — 02 mocks it in tests.

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

## 3. cwd-spike findings (validation-only — `src-tauri/examples/cwd_spike.rs`)

Run: `cd src-tauri && cargo run --example cwd_spike`. Output is recorded here, **not**
wired into `list_plans` (production resolver is Sub-Plan 03).

### Real field set discovered

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

### Verified invariants (the spike asserts all four)

- **(a)** All real sample stems resolve to a `cwd` (incl. `dynamic-forging-yao`,
  `async-popping-acorn`, `velvet-floating-hellman` via authoritative `plan_mode`
  attachment, and the subagent plan via the `Write` `file_path` fallback).
- **(b) Subagent transcripts are self-sufficient.** The `*-agent-<hex>.md` sample
  (`merry-baking-hammock-agent-acea1c41bbc02c040`) resolves **inside its own
  `…/subagents/agent-<hex>.jsonl`**, which carries its own top-level `cwd`. The parent
  `<session>.jsonl` may not exist on disk. So **descending into `subagents/` is
  necessary, and 03 MUST NOT depend on walking up to a parent session.** The agent file's
  `<hex>` matches the plan stem's `-agent-<hex>` suffix — a strong owner key.
- **(c)** `cwd: Option<String>` is the correct reserved type — a resolved stem yields
  `Some(path)`; an unknown stem yields `None` (→ display "unknown" in 03).
- **(d) Falsifiability:** a deliberately fake stem
  (`totally-fake-nonexistent-plan-zzz-9999`) resolves to `None`, proving the matcher is
  not trivially matching everything.

### Sample run output (recorded)

```
Scanned 2870 transcript files (231 top-level sessions, 2639 subagent transcripts).

  RESOLVED  dynamic-forging-yao
            cwd        = /Users/charliekoster/Documents/repos/scratch/nuke
            provenance = Some(PlanModeAttachment)   isSubAgent = Some(false)
  RESOLVED  async-popping-acorn
            cwd        = /Users/charliekoster/Documents/repos/scratch
            provenance = Some(PlanModeAttachment)   isSubAgent = Some(false)
  RESOLVED  velvet-floating-hellman
            cwd        = /Users/charliekoster/Documents/repos/plan-tree-scratch/helicopter
            provenance = Some(PlanModeAttachment)   isSubAgent = Some(false)
  RESOLVED  merry-baking-hammock-agent-acea1c41bbc02c040
            cwd        = /Users/charliekoster/.hermes
            provenance = Some(WriteFilePath)   source = …/subagents/agent-acea1c41bbc02c040.jsonl
            [invariant b] resolved inside subagents/ transcript (self-sufficient)

  totally-fake-nonexistent-plan-zzz-9999 -> None (PASS)

(a)(b)(c)(d) all PASS.
```

---

## Sub-Plan 03 additions (cwd resolver + persisted read/unread — additive, non-breaking)

These supplement §1/§2/§3 and the Sub-Plan 02 additions; none of those are altered.

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

### Resolver (ported + inverted from `cwd_spike.rs`)

The spike's one-scan-per-stem loop is **inverted** into a single corpus pass that matches the
whole set of requested stems, keyed by a `HashMap<stem, Resolution>`. The spike's acceptance
gate is preserved **per stem** so that: (a) a stem already resolved **authoritatively**
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

## Nested master/sub hierarchy (Sub-Plan 01 — additive, non-breaking)

This supplements §1/§2/§3 and the Sub-Plan 02/03 additions; none of those are altered. It is
the **data-source layer** for the nested, collapsible sidebar. The master→sub relationship
does not exist in the data the app reads except via a **marker embedded in the plan body**
(`/multiplan` writes it; both the `.plan-tree/` hook copy and the built-in `~/.claude/plans/`
copy preserve it verbatim). Display markup/CSS/toggle wiring is owned by **Sub-Plan 02**.

### Marker grammar — YAML frontmatter at the top of the plan body

A **leading** (line-1) frontmatter block fenced by `---` lines. Only a line-1 block counts (a
mid-document `---` thematic break is never a marker). Fence lines tolerate trailing whitespace;
both `\n` and `\r\n` endings are accepted. Parsed by a minimal line-based `key: value` scan
(no `serde_yaml`).

```
---
tree_id: <stable token, shared by a master and all its children>
flavor: master            # master | sub   (a marker never says "standalone")
nn: 2                     # present only when flavor: sub (integer sequence)
---

# <plan title …>
```

- `tree_id` is **mandatory**; a marker missing `tree_id` or carrying an unrecognized `flavor`
  is rejected (the file is treated as having no marker ⇒ `standalone`).
- The marker is **stripped from the body** by `read_plan_contents` (same `split_frontmatter`
  parser used by `list_plans` — a single source of truth, so the two read paths can never
  disagree on the boundary), so the reading pane never renders it. Legacy plans (no
  frontmatter) pass through **byte-for-byte unchanged**.

### `PlanRecord` — five appended fields (snake_case JSON, no rename)

Appended to the §2 struct (`{absolute_path, filename_stem, mtime_ms, cwd, unread}`):

| field | type (JSON) | meaning |
|-------|-------------|---------|
| `flavor` | `"master" \| "sub" \| "standalone"` | closed set; **never absent** |
| `tree_id` | `string \| null` | join key linking a master to its subs; `null` for standalone |
| `nn` | `number \| null` | sub sequence; `null` for master/standalone |
| `child_count` | `number \| null` | master only: **observed** present children (≥ 0); `null` otherwise |
| `collapsed` | `boolean` | master only (meaningful); persisted collapse state, `false` otherwise |
| `h1s` | `string[]` | plan's ATX H1 texts (from the first 8 KB head, **fence-aware**) for sidebar-filter matching; `[]` when none. Only H1s within the bounded head read are indexed — the `# Title` (line 1 of the body) is always covered; a rare second/third H1 beyond 8 KB in a long plan is not indexed (accepted trade-off; title + cwd still match). |

### Pre-ordering guarantee

`list_plans` returns a flat `Vec<PlanRecord>` **already in display order** — the frontend walks
it top-to-bottom and renders directly, with **no re-aggregation**:

- Top level (masters + standalones) is interleaved by **recency descending**. A master's
  recency = **max mtime over {master file, all present children}**. Equal recency breaks by
  `filename_stem` ascending (deterministic).
- Each master is **immediately followed** by its children in **`nn` ascending** order (not
  mtime). `flavor` drives indentation, `tree_id` links a sub back to its master for collapse,
  and `child_count` feeds the "N sub-plans" label.
- Example shape: `[masterA, A·sub01, A·sub02, standaloneX, masterB, …]`.

### Closed flavor set + deterministic tie-break rules

So Sub-Plan 02 needs **no fallback logic** at render time:

- No marker ⇒ `standalone` (the common case; legacy plans are unaffected).
- Valid `master` marker ⇒ `master`; `child_count` = count of **present** subs sharing its
  `tree_id`. A master whose body lists N subs but whose sub *files* aren't all present reports
  the **observed** count — `0` is valid and is the normal incremental state.
- Valid `sub` marker **with** a present (surviving) master of the same `tree_id` ⇒ `sub`.
- Valid `sub` marker **without** a surviving master (orphan/partial tree) ⇒ normalized to
  `standalone` with `tree_id`/`nn` set to `null`.
- **Duplicate masters sharing one `tree_id`** (a re-draft leaves the old plans-dir file
  behind): keep the **newest-mtime** file as `master` (tie → lexicographically-smallest
  `filename_stem`); demote the rest to `standalone` (their `tree_id`/`nn` nulled). Subs attach
  to the surviving master.
- **`nn` collision** among a tree's subs: stable order by `(nn, mtime_ms, filename_stem)` —
  deterministic, no dropped/duplicated rows.

### `set_tree_collapsed` command + collapse persistence

```rust
// JS: invoke("set_tree_collapsed", { treeId, collapsed })  — treeId: string, collapsed: bool
#[tauri::command]
fn set_tree_collapsed(tree_id: String, collapsed: bool, state: State<'_, Mutex<AppState>>);
```

- Updates `AppState.collapse_state: HashMap<tree_id, bool>` and persists it
  (snapshot-then-persist-outside-lock, mirroring `mark_viewed`).
- Persisted to **`collapse-state.json`** under `app.path().app_data_dir()` (shape:
  `{ "<tree_id>": <bool> }`), via the same atomic temp-write+rename and graceful-degradation
  rules as `cwd-cache.json` / `read-state.json` (**absent ⇒ empty/all-expanded; corrupt ⇒
  empty without panic or destructive rewrite; no data dir ⇒ in-memory only**).
- **Collapse default: absent ⇒ expanded.** A `tree_id` with no entry in `collapse-state.json`
  renders **expanded** (`collapsed: false`). The initial collapsed state rides on each master
  `PlanRecord` from `list_plans` (no separate getter — consistent with how `unread` rides on
  the record). `list_plans` also **prunes** collapse-state entries whose `tree_id` no longer
  appears in any record, keeping the file from accumulating dead trees.

---

## Sub-Plan 02 — nested sidebar rendering (additive, non-breaking)

The **display layer** for the nested hierarchy. It consumes the frozen pre-ordered
`PlanRecord` stream and the `set_tree_collapsed` command (both above) and adds **no** backend
fields or commands. `renderSidebar(listEl, records, ctx)` (`src/main.ts`, exported for unit
tests) walks the pre-ordered records top-to-bottom with **no re-aggregation**, tracking the
current master's `.children` container. The three flavors are distinguished by **structure
alone — no text tags**.

### New DOM selectors

| selector | element | role |
|----------|---------|------|
| `.master` | wrapper around a master-row + its children | expandable master group; carries `data-tree-id`; gets `.collapsed` when collapsed |
| `.master-row` | the `.plan` row inside a `.master` | the master's own clickable row (carries `data-path`) |
| `.twirl` | leading `<span>` in the master-row's `.plan-row` | disclosure affordance; rotates -90° under `.master.collapsed` |
| `.child-count` | trailing `<span>` in the master-row's `.plan-row` | "N sub-plans" label (singular at 1) |
| `.children` | container after the master-row inside `.master` | holds the nested sub rows; indent + left rule via `--border`; hidden under `.master.collapsed` |
| `.sub` | a `.plan` row inside `.children` | a nested child row (carries `data-path`) |
| `.seq` | leading `<span>` in a sub's `.plan-row` | 2-digit zero-padded `nn` sequence (mono) |

### Per-row templates (nested)

**Standalone** (and a 0-child master — see edge rules) — unchanged from §1's flat template:
```html
<div class="plan [active] [unread]" data-path="…">
  <div class="plan-row"><span class="plan-title">…</span><span class="unread-dot"></span></div>
  <div class="plan-src">…cwd…</div>
  <div class="plan-meta"><span class="when">…</span></div>
</div>
```

**Master** (`child_count >= 1`):
```html
<div class="master [collapsed]" data-tree-id="…">
  <div class="plan master-row [active] [unread]" data-path="…">
    <div class="plan-row">
      <span class="twirl">▾</span>
      <span class="plan-title">…</span>
      <span class="unread-dot"></span>
      <span class="child-count">N sub-plans</span>
    </div>
    <div class="plan-src">…cwd…</div>
    <div class="plan-meta"><span class="when">…</span></div>
  </div>
  <div class="children"> …sub rows… </div>
</div>
```

**Sub** (compact — NN + title + dot ONLY; **no** `.plan-src` / `.plan-meta`):
```html
<div class="plan sub [active] [unread]" data-path="…">
  <div class="plan-row"><span class="seq">NN</span><span class="plan-title">…</span><span class="unread-dot"></span></div>
</div>
```

### `data-path` placement → row iteration is now `#plan-list [data-path]`

`data-path` sits on the **`.master-row`**, **every `.sub`**, and **every standalone `.plan`** —
the `.master` wrapper itself carries **no** `data-path` (only `data-tree-id`). Because subs now
live inside `.master > .children` (no longer all direct children of `#plan-list`), the
active/unread/cwd-patch loops iterate `#plan-list [data-path]` instead of
`#plan-list`'s direct children. (Updated in `openPlan`'s active/unread loop and `patchAllCwds`.)

### Twirl collapse — optimistic toggle, no race

A click on `.twirl` calls `e.stopPropagation()` (so it never also opens the master plan) then
the `onToggleCollapse(treeId, next)` handler: it records the intent in a session
`collapseOverride: Map<tree_id, bool>`, toggles `.collapsed` on the matching `.master` wrapper
**instantly**, and fire-and-forgets `invoke("set_tree_collapsed", { treeId, collapsed: next })`
(errors logged, non-fatal — **no re-list**). `renderSidebar` resolves effective collapse as
`collapseOverride.get(tree_id) ?? rec.collapsed`, so an in-flight `list_plans` that returns a
not-yet-persisted (stale) `collapsed` value **cannot revert** the user's toggle — the **session
override wins** until the backend converges; the empty map on restart cedes to the persisted
record value. Clicking the master `.plan-title` / `.child-count` opens the plan (`onOpen`), never
toggles collapse.

### Resolved edge rules

- **`child_count: 0` master ⇒ flat row.** A master appears in `~/.claude/plans` the moment it
  is approved, before any sub file exists, so `child_count: 0` is a common transient state.
  When `child_count === 0` the master renders as a plain flat row (no `.twirl`, no `.child-count`,
  no `.children`); it keeps `data-path` and opens normally, and becomes an expandable master the
  instant its first sub appears. The disclosure affordance appears only at `child_count >= 1` —
  this is a display threshold, not flavor re-aggregation.
- **Master unread cue = the dot, not bold.** `.master-row .plan-title` is **always** bold (visual
  hierarchy), which would mask the bold-on-unread cue, so for masters the **unread dot** carries
  unread. The dot element always renders on the master row and `.plan.unread .unread-dot` paints
  it accent when the master is unread.
- **File-count unchanged.** `#plan-count` keeps counting every plan **file** (masters + subs +
  standalones), not the number of visible top-level rows.

### Loud-not-silent orphan guard

`renderSidebar` trusts the contract (a `sub` always follows its master). The one guard — made
**loud not silent** — is: a `sub` arriving with no open `.children` container (a backend
contract violation) is `console.error`'d and appended **flat** to `#plan-list` so the sidebar
still renders (a visible diagnostic, never a quiet re-classification).

---

## Table-of-contents sidebar view (additive, non-breaking)

The left sidebar is now a **tabbed panel** — a `[Plans] [Contents]` tab row above two
mutually-exclusive panes. **Plans** wraps the existing newest-first list (`.sidebar-head` +
`.search` + `#plan-list`) and is **default-active**. **Contents** holds the table of contents
(H1 + H2) of the currently-open plan. None of the §1/§2/§3 or Sub-Plan 02/03 surfaces are
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
surfaces are altered; the **`PlanRecord` gains one appended field `h1s`** (documented in the
field table above — the wire-contract key count is now **11**) and the previously-static
`.search` placeholder becomes a real interactive control.

### Backend support

`list_plans` extracts each plan's ATX H1 headings into `PlanRecord.h1s` via the new pure,
**fence-aware** `extract_h1s(body)` — running on the **body half** of the `split_frontmatter`
result that the marker scan already produces (no second read pass; rides the existing bounded
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
- **Nesting preserved** (`filterRecords`): a matched **sub** keeps its **master** in the result
  (never an orphan); when the master matches, its whole block (master + subs) is kept intact.
- **`#plan-count` text form** (selector **unchanged**, still frozen): while filtering it reads
  `"N of M"` (N = files shown, M = total files); an empty query restores the plain `"M file(s)"`
  form. The count still counts every plan **file** (masters + subs + standalones).
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

## Highlight + comment with quoted-text anchoring (Sub-Plan 02 additions — additive, non-breaking)

The reading pane gains a select-text → comment affordance. A saved comment wraps the selection
in highlight span(s) and persists to a new `comments.json` store. Highlights survive
`renderInto`'s `innerHTML` wipe (live-reload / plan-switch) via **quoted-text anchoring**. The
**backend is the single source of truth for the comment count**; the frontend reads it via a
command, never the DOM. `PlanRecord` is **UNCHANGED (11 keys)** — comments do NOT ride on it.

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
**never** held across the blocking `atomic_write`), exactly like `set_tree_collapsed`.

### `comments.json` store

`AppState.comments: HashMap<String, Vec<CommentRecord>>` (plan absolute_path → its comments),
persisted to `comments.json` under the app-data dir via `atomic_write` (temp-write + rename),
loaded in `init_app_state` alongside `cwd-cache.json` / `read-state.json` / `collapse-state.json`.
Same **graceful-degradation** rules: absent ⇒ empty; corrupt ⇒ log + empty **without rewriting**
the bad file; no data dir ⇒ in-memory only (persistence no-ops). Empty per-plan arrays are never
stored (an empty `set_comments` removes the key).

### Facade surface (`src/render/index.ts`)

Re-exports `applyComments(paneEl, records)`, `initComments(paneEl, getPlanPath, io)`,
`onCommentCountChanged(cb: () => void)` (a **zero-arg** notification fired after an in-pane save/
clear mutation; the facade does NOT compute the count), and `loadCommentsFor(paneEl, path)` (plus
the `CommentsIO` type). `renderInto` stays a **pure markdown→HTML transform** — no highlight logic.
The popover positioning is an un-unit-tested DOM adapter (jsdom has no layout).

## Sub-Plan 03 additions (Prompt Feedback button + overlay — additive, non-breaking)

Added 2026-05-25. These supplement the Sub-Plan 02 additions; none of the §1/§2/§3 or Sub-Plan
01/02 surfaces are altered. **`PlanRecord` is UNCHANGED (still 11 keys)** — the feedback feature
consumes the existing comment commands/count and adds no `PlanRecord` field.

Sub-Plan 03 attaches the visible consumer of the Sub-Plan 02 count pipeline: a **"Prompt Feedback"**
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
