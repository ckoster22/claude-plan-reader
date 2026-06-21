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
| `data-source-end-line="<n>"` | same elements as `data-source-line` | markdown-it `token.map[1]` — the 0-based **exclusive** end of the block's `[start, end)` source range. Stamped alongside `data-source-line` (renderToken override + fence templates). Read by the comment-capture path to record a block's full line range; fenced/mermaid blocks carry it for symmetry but it is never read off them (they are comment-excluded). |
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

- **(a)** All real sample stems resolve to a `cwd` (incl. `quiet-rolling-cedar`,
  `calm-spinning-birch`, `amber-drifting-pine` via authoritative `plan_mode`
  attachment, and the subagent plan via the `Write` `file_path` fallback).
- **(b) Subagent transcripts are self-sufficient.** The `*-agent-<hex>.md` sample
  (`gentle-waving-maple-agent-0000000000000002`) resolves **inside its own
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

  RESOLVED  quiet-rolling-cedar
            cwd        = /Users/u/repos/scratch/alpha
            provenance = Some(PlanModeAttachment)   isSubAgent = Some(false)
  RESOLVED  calm-spinning-birch
            cwd        = /Users/u/repos/scratch
            provenance = Some(PlanModeAttachment)   isSubAgent = Some(false)
  RESOLVED  amber-drifting-pine
            cwd        = /Users/u/repos/plan-tree-scratch/beta
            provenance = Some(PlanModeAttachment)   isSubAgent = Some(false)
  RESOLVED  gentle-waving-maple-agent-0000000000000002
            cwd        = /Users/u/.example-project
            provenance = Some(WriteFilePath)   source = …/subagents/agent-0000000000000002.jsonl
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

### `CommentRecord` (mirrors the Rust struct; frozen 6-key wire shape)

```
{ quote: string,             // normalized (whitespace-collapsed, trimmed) selected text
  block_line: number | null, // data-source-line of nearest enclosing block; `null` ⇒ whole-pane scan
  block_end_line: number | null, // data-source-end-line of that SAME block (markdown-it [start,end) exclusive end); `null` ⇒ unknown / whole-pane
  occurrence: number,        // 0-based Nth match of `quote` within the chosen root
  comment: string,           // the user's comment
  id: number }               // collision-free id (= max existing id + 1); also the span's data-c
```

> **Wire change (additive, backward-compatible):** the record grew from 5 to **6 keys** with the
> addition of `block_end_line`. The Rust field is `#[serde(default)]` so **old saved comment files
> lacking the key still deserialize** (the field becomes `None`/`null`). It always **serializes**
> (present as JSON `null` when unknown — never omitted, no `-1` sentinel), so the frozen-key freezes
> (`comment_record_wire_contract_is_frozen` in Rust; the type-derived key set in `contract.test.ts`)
> assert exactly 6 keys.

`block_line` and `block_end_line` are each `Option<i64>` in Rust (serde emits `null`) / `number | null`
in TS — mirroring the existing `cwd: Option<String>` precedent. There is **NO `-1` sentinel**: "no
enclosing block" is the type. `block_line` remains the sole anchor key; `block_end_line` is recorded
only to render the comment's source-line range in the feedback prompt (it does **not** participate in
re-anchoring). `block_line` + `occurrence` together are the minimal deterministic re-anchor
disambiguator. Keying-by-plan-path lives in the store map, not the record (mirrors `read-state.json`).

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

> **Amendment 2026-06-08 — REMOVED: the Prompt Feedback button + feedback overlay are gone.**
> The entire feedback-button/overlay surface above is **removed from `index.html`** and supersedes
> every row in this table plus the `2026-05-30` review-aware amendment that follows it. **No longer
> exist:** `#feedback-btn`, `#feedback-count`, `#feedback-overlay`, `#feedback-body`,
> `#feedback-copy`, `#feedback-clear` (and the never-shipped `#feedback-approve`). The titlebar
> `.titlebar-controls` slot no longer carries a Prompt Feedback button as its FIRST child; commenting
> on a plan now flows through the **conversation composer** + the **`#review-bar`** (see §"Plan Review
> (ExitPlanMode hook)" and its later amendments — the `#review-bar` is the live commenting/review
> surface). The selector rows above are retained verbatim as history; do **not** build against them.
> `src/feedback.ts` `buildFeedbackPrompt(...)` remains the pure prompt builder reused by the review
> path; only the overlay DOM was removed, not the builder.

> **Amendment 2026-05-30 — feedback overlay is now review-aware; see §"Plan Review
> (ExitPlanMode hook)" below.** When a plan in `#reading-pane` has a **pending hook review**
> (see the new section), the overlay grows an additional **`#feedback-approve`** button (hidden
> unless a review is pending for the open plan) and `#feedback-copy`'s label/behavior become
> review-aware: in review mode the **deny** path forwards `buildFeedbackPrompt(comments)` to
> Claude as the review `reason` (delivered as an ExitPlanMode tool error so Claude revises in
> place), rather than only copying the prompt to the clipboard. The selector rows above are
> retained verbatim; this note records the additive behavior change. No other row in this
> section is affected, and `#feedback-clear` / `buildFeedbackPrompt` are unchanged (the deny
> reason **reuses `buildFeedbackPrompt` unchanged** — see the DESIGN NOTE in the new section).

### Pure prompt builder (`src/feedback.ts`)

`buildFeedbackPrompt(records: Pick<CommentRecord, "quote" | "comment" | "block_line" | "block_end_line">[]): string`
— a lead line, then ONE numbered entry per record (`N. Re: "<quote>"`, the comment on the next
indented line). It **emits one entry per record and never skips empty-comment records** (an empty
comment yields a quote-only entry), so the entry count always equals the badge count. Long quotes
are clamped (~90 chars + ellipsis). Pure: lives in the `main.ts`/title-bar domain, NOT the render
facade.

Each `Re: "<quote>"` line carries a **source-line suffix** derived from the block's range. Since
markdown-it `token.map = [start, end)` is 0-based and end-exclusive, the 1-based **inclusive** range
is `start = block_line + 1`, `end = block_end_line` (converting the 0-based exclusive end to 1-based
inclusive is a no-op). The suffix is:
- `block_line === null` → **no suffix** (whole-pane comment);
- `block_end_line === null` OR computed `end <= start` → ` (line {start})` (single line / unknown end);
- otherwise → ` (lines {start}-{end})`.

### Facade surface additions (`src/render/index.ts`)

Re-exports **`clearAllComments(paneEl, path)`** (alongside `applyComments`, `initComments`,
`onCommentCountChanged`, `loadCommentsFor`). It is exposed by a **second per-pane `WeakMap`
registry mirroring `loaderRegistry`**: `initComments` registers a per-pane closure that removes
every highlight by iterating the cached record ids via `clearHighlight` (BEFORE clearing the cache,
since `io.clearAll` returns `[]`), then calls `io.clearAll(path)`, adopts the returned `[]` into the
cache, and fires `onCommentCountChanged`. `main.ts` hands in the pane element exactly like
`initComments` / `loadCommentsFor` — it never reaches into `#reading-pane`.

## Reading-pane text-size control (additive, non-breaking)

Added 2026-05-29. Two `A−` / `A+` stepper buttons in the `.titlebar-controls` slot scale the
**entire reading pane** (headings, body, code, tables) as one system. None of the §1/§2/§3 or prior
surfaces are altered; `PlanRecord` is **UNCHANGED (still 6 keys)**.

### Single-variable scaling

Every reading-pane (`.md …`) `font-size` in `src/styles.css` is `em`-relative to a single CSS custom
property **`--reading-font-size`** (declared once on the light `:root`, theme-independent — NOT
duplicated in the dark block). `.md` itself is `font-size: var(--reading-font-size)`; headings/table/
code/pre/raw are `em` multiples preserving the original 15px-base ratios (h1 `1.8em`, h2 `1.333em`,
h3 `1.067em`, `.md table` `0.9em`, inline `.md code` `0.833em`, `.md pre` `0.833em` with `.md pre code`
`1em` to avoid compounding, `.md.raw` `0.833em`). Stepping the one variable rescales the whole pane.

### New DOM selectors

| selector | element | role |
|----------|---------|------|
| `#text-dec` | `<button class="theme-toggle">` in `.titlebar-controls`, **immediately before `#theme-toggle`** | decrease reading-pane text size (label `A−`, U+2212). Drag-immunity via the `isDragTarget()` interactive-target bail (it is a `<button>`), NOT `data-tauri-drag-region`. Disabled at the ladder floor. |
| `#text-inc` | `<button class="theme-toggle">` in `.titlebar-controls`, between `#text-dec` and `#theme-toggle` | increase reading-pane text size (label `A+`). Same drag-immunity. Disabled at the ladder ceiling. |

### Persistence + ladder

The fixed ladder is **`[13, 14, 15, 17, 19, 21]`** (px); the default is **15**. The persisted choice
lives under the localStorage key **`plan-reader-text-size`** (a ladder integer). It is **read before
first paint** by the inline anti-FOUC script in `index.html` (which sets
`--reading-font-size` on `document.documentElement`, validating against the ladder and defaulting to
15 on a missing/invalid value) and **written on click** by `initTextSize` (`src/titlebar.ts`, exporting
`TEXT_SIZE_KEY`, `DEFAULT_TEXT_SIZE`, `TEXT_SIZE_LADDER`, and the pure `nextTextSize(currentPx, dir)`
stepper). The key + ladder literal are duplicated between the inline script and the module — mirroring
the `plan-reader-theme` precedent. `nextTextSize` snaps off-ladder input to the nearest rung, steps one
rung, and clamps at both ends (always returns a ladder value); it is pinned by `src/titlebar.test.ts`
(`test_nextTextSize_steps_and_clamps`).

The inline-script duplicates (the `plan-reader-text-size` key and the `[13, 14, 15, 17, 19, 21]` ladder
literal) are themselves pinned against the `index.html` source by `src/contract.test.ts` (suite
*"text-size anti-FOUC literals pinned in index.html"*): the key and ladder are asserted equal to
titlebar.ts's exported `TEXT_SIZE_KEY` / `TEXT_SIZE_LADDER`, and the `#text-dec` / `#text-inc` ids and
the `--reading-font-size` variable are asserted present — so if the inline script drifts from the module
source of truth, those assertions go red (mirroring how `plan-reader-theme` is pinned).

## Plan Review (ExitPlanMode hook) (additive, non-breaking)

Added 2026-05-30. A new surface lets a `PreToolUse`/`ExitPlanMode` hook hand a plan to the
running app for **in-app review** (approve, or deny-with-feedback so Claude revises in place),
turning the highlight-and-comment overlay into a live plan-revision loop. None of the §1/§2/§3
or prior additive surfaces are altered; `PlanRecord` is **UNCHANGED**. The feedback overlay
becomes review-aware (see the dated amendment in §"Sub-Plan 03 additions (Prompt Feedback
button + overlay)").

### File-write invariant preserved — new control directory

The app's write surface is still tightly bounded. It writes **ONLY** under a new control
directory **`~/.claude/plan-reader/`** plus a **single idempotent merge** into
`~/.claude/settings.json` (the hook registration). **It never writes into `~/.claude/plans/`**
— the plans tree stays read-only (rendered + watched), exactly as before. The control directory
holds:

| path | role |
|------|------|
| `~/.claude/plan-reader/requests/` | hook → app IPC inbox; one `<review_id>.json` per pending review |
| `~/.claude/plan-reader/responses/` | app → hook IPC outbox; one `<review_id>.json` per decision |
| `~/.claude/plan-reader/app.alive` | heartbeat file; mtime is refreshed by the running app so the hook can detect whether the app is live (and fall back to allow if not) |

### IPC file shapes

**Request** (hook writes `requests/<review_id>.json`):

```jsonc
{ "schema": 1,
  "review_id": "<opaque token>",   // see below — NEVER split
  "session_id": "<claude session id>",
  "cwd": "<originating working directory>",
  "transcript_path": "<path to the session transcript>",
  "plan_text": "<full plan markdown>",
  "created_ms": <i64> }
```

**Response** (app writes `responses/<review_id>.json`):

```jsonc
{ "schema": 1,
  "review_id": "<opaque token>",
  "decision": "allow" | "deny",
  "reason": "<text>" }            // on deny, = buildFeedbackPrompt(comments) — see DESIGN NOTE
```

- **`review_id` is an OPAQUE token** — format `<session_id>-<unix_nanos>-<rand>`, but it is
  **never split or parsed back into parts**; treat it as one atom. It is validated against
  `^[A-Za-z0-9._-]+$` (rejecting `..`, `/`, and a leading dot) **at every path-building
  boundary** before it is joined into a `requests/`/`responses/` filename — the guard against
  path traversal out of the control directory.
- `schema` is pinned at `1` on both files for forward-compat.

### New Tauri commands (registered in `invoke_handler`)

| command | signature | role |
|---------|-----------|------|
| `list_pending_reviews` | `() -> Vec<ReviewRequest>` | the pending-review inbox (parsed `requests/*.json`) |
| `read_review_plan` | `(review_id: String) -> Result<String, String>` | returns the request's `plan_text` |
| `respond_to_review` | `(review_id: String, decision: String, reason: String) -> Result<(), String>` | writes `responses/<review_id>.json` (`decision` ∈ `"allow"\|"deny"`) |
| `pending_review_for_path` | `(path: String) -> Option<String>` | maps an open plan path → its pending `review_id` (drives the review-aware overlay) |
| `install_hook` | `() -> Result<(), String>` | the single idempotent merge into `~/.claude/settings.json` registering the `PreToolUse`/`ExitPlanMode` hook |
| `uninstall_hook` | `() -> Result<(), String>` | removes that hook registration from `~/.claude/settings.json` |
| `focus_main_window` | `()` | best-effort `show` + `unminimize` + `set_focus` of the `main` window (so a review request can foreground the app) |

`review_id` arriving over `read_review_plan` / `respond_to_review` is re-validated against the
same `^[A-Za-z0-9._-]+$` allow-list before any path is built.

### New Tauri events (emitted by the backend watcher over `~/.claude/plan-reader/requests/`)

| event | payload | meaning |
|-------|---------|---------|
| `plan-review-requested` | `{ review_id: string, plan_text: string }` | a new `requests/<review_id>.json` appeared — a plan awaits review |
| `plan-review-cancelled` | `{ review_id: string }` | a pending request file was removed before the app responded (the hook gave up / timed out) |

### New capabilities (`src-tauri/capabilities/default.json`)

`focus_main_window` requires three window permissions **not** in `core:default`, added to the
`permissions` array: **`core:window:allow-set-focus`**, **`core:window:allow-show`**,
**`core:window:allow-unminimize`**. (Mirrors the `core:window:allow-start-dragging` /
`core:window:allow-toggle-maximize` precedent — these are individually opt-in.)

### New DOM selectors

| selector | where | role |
|----------|-------|------|
| `#feedback-approve` | inside `#feedback-overlay` (sibling of `#feedback-copy`/`#feedback-clear`) | **hidden unless a review is pending** for the open plan; approving sends `respond_to_review(review_id, "allow", "")`. NO `data-tauri-drag-region`. |
| `#hook-setup` | titlebar control in `.titlebar-controls` | installs the ExitPlanMode hook (`install_hook`); includes a remove/uninstall affordance (`uninstall_hook`). Drag-immunity via the `isDragTarget()` interactive-target bail (it is an interactive control), NOT `data-tauri-drag-region`. |

### Empirical notes (verified Phase 0, against a live Claude Code session)

- **Plan text source.** At `PreToolUse`/`ExitPlanMode` the hook payload carries
  `tool_input.plan` (full markdown), `session_id`, `cwd`, `transcript_path`, `hook_event_name`,
  `tool_name`, `tool_use_id`, and `tool_input.planFilePath`. There is **NO `tool_response`**
  (the tool has not run yet), so the plan text **MUST** be taken from **`tool_input.plan`** —
  never from a tool result.
- **Decision protocol (stdout JSON).** The hook returns its decision on **stdout** as:
  ```jsonc
  { "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny" | "allow",
      "permissionDecisionReason": "<text>" } }
  ```
  A **`deny`** causes ExitPlanMode to **fail**: the reason text is delivered back to Claude as a
  **tool error**, Claude **remains in plan mode** and revises the plan. An **`allow`** lets the
  plan be presented/approved normally.
- **DESIGN NOTE — deny reason must read as the user's feedback, not meta-instructions.** Because
  the deny `reason` is surfaced to Claude as a tool error, and Claude scrutinizes instruction-like
  content for **prompt-injection**, the reason must read as the **user's plan-revision feedback**
  (e.g. *"Please revise the plan based on this feedback: …"*), **never** as meta-instructions
  directed at the model. In production the reason is exactly `buildFeedbackPrompt(comments)`
  output — **reused unchanged** — which already phrases the comments as user feedback, satisfying
  this constraint.

### Amendment 2026-05-30 (Phase 4) — `pending_review_for_path` NOT implemented

The previously-planned `pending_review_for_path` command was **dropped** and is **not**
implemented. It has no consumer: the frontend (Phase 6) tracks the active review by its
`review_id` in memory, so a path→review lookup is unnecessary. The Phase 4 review command
surface is therefore: `list_pending_reviews`, `read_review_plan`, `respond_to_review`,
`focus_main_window`, `install_hook`, `uninstall_hook`, plus the events
`plan-review-requested` ({review_id, plan_text}) and `plan-review-cancelled` ({review_id}).

### Amendment 2026-05-30 — hook install/remove UX is in-DOM (no `window.confirm`/`alert`)

The `#hook-setup` / `#hook-remove` click handlers no longer use `window.confirm` / `window.alert`:
in Tauri v2 (Wry + WKWebView on macOS) `window.confirm()` returns `false` (so `invoke` never
fired — the button appeared to do nothing) and `window.alert()` is a no-op (so any error was
invisible). They now use a dependency-free in-DOM flow (no `@tauri-apps/plugin-dialog`):

| selector | where | role |
|----------|-------|------|
| `#hook-status` | titlebar control in `.titlebar-controls` (a `<span role="status" aria-live="polite">`, sibling of `#hook-remove`) | transient in-DOM status readout for install/remove. `main.ts` sets `textContent`, toggles `.hidden`, and adds `.error` (red) for failures; auto-clears after a few seconds. Carries no `data-tauri-drag-region` (a non-interactive `<span>` — not clickable, drag-immunity irrelevant). |

Each hook button uses a two-click **"click again to confirm"** arm before mutating
`~/.claude/settings.json`: the first click adds `.confirming` to the button and relabels it
(auto-reverting after a few seconds); the second click runs the command. Success and error are
surfaced via `#hook-status` (and always `console.log`/`console.error`'d); a thrown command error
shows its returned string (e.g. *"settings.json is not valid JSON — refusing to modify"*) in-DOM.

### Amendment 2026-05-30 — review Submit/Approve live on a persistent `#review-bar` (not solely the overlay)

The plan-review feedback overlay (`#feedback-overlay`) is `position: fixed` and floats over the
reading pane, and it closes on outside-click. That made commenting and acting on a review mutually
exclusive: to add an inline comment the user had to click into the pane (closing the overlay), and
once closed there was no reliable affordance to Submit/Approve (those controls lived only inside the
overlay; the `#feedback-btn` toggle is hidden at 0 comments).

A **persistent, non-occluding review action bar** now owns the review actions:

| selector | where | role |
|----------|-------|------|
| `#review-bar` | inside `.reader-inner`, in normal flow between `.doc-header` and `#reading-pane` (NOT floating over the pane) | shown (`.hidden` removed) iff a review is active; hidden otherwise. `main.ts` `refreshReviewBar()` is the sole writer of its `.hidden`. |
| `#review-bar-label` | inside `#review-bar` | reads `Reviewing plan — N comments` (N from the authoritative review comment count). |
| `#review-submit` | inside `#review-bar` | **Submit feedback** → `respond_to_review(reviewId, "deny", buildFeedbackPrompt(reviewComments))` then teardown. Disabled while there are 0 review comments; enabled on the FIRST comment (authoritative-count plumbing from `onCommentCountChanged`). |
| `#review-approve` | inside `#review-bar` | **Approve plan** → `respond_to_review(reviewId, "allow", "Plan approved in Plan Reader.")` then teardown. Always enabled while a review is active. |
| `#review-preview` | inside `#review-bar` | opens the existing `#feedback-overlay` read-only to PREVIEW the assembled feedback prompt. |

> **Amendment 2026-06-08 — `#review-preview` is REMOVED (and its target overlay no longer exists).**
> The `#review-preview` row above is dead: it described opening `#feedback-overlay`, which was itself
> removed (see the `2026-06-08` REMOVED amendment in §"Prompt Feedback"). `#review-preview` was already
> listed among "Removed symbols" by the `2026-05-30` feedback-only amendment below (`activeReview`,
> `ActiveReview`, `surfaceNextPendingReview`, `#feedback-approve`, `#review-approve`, `#review-preview`);
> this note reconciles the dangling row here. There is **no preview button in `#review-bar`** today —
> the live review controls are `#review-submit` / `#review-dismiss` / `#review-resume` (see the
> two-mode `#review-bar` amendment below). The row is retained verbatim as history.

Because the bar is in normal flow at the top of the reading column, the reading pane stays fully
interactive for inline commenting while a review is active. The `#review-bar` Submit/Approve buttons
and the overlay's `#feedback-copy` (submit-mode) / `#feedback-approve` buttons call the **same**
shared `respond_to_review` handlers in `main.ts` (no duplicated invoke logic). A review request and
launch-recovery NO LONGER auto-open the occluding overlay — they render the plan via `openReview`,
show `#review-bar`, and leave the overlay as preview-only. Non-review behavior (the `#feedback-btn`
clipboard / overlay flow when no review is active) is unchanged.

### Amendment 2026-05-30 — feedback-only review UX: Approve removed, Dismiss releases the hook, pending reviews are resumable and decoupled from the display

This supersedes the relevant parts of the two amendments above. Two product decisions drive it:

**(1) Feedback-only — Approve-as-auto-execute is GONE.** A PreToolUse hook cannot auto-approve a
plan (decision `"allow"` only lets `ExitPlanMode` proceed to Claude Code's *normal terminal*
plan-approval prompt; true auto-approve needs a `PermissionRequest` hook, currently broken upstream).
So the in-app "Approve plan" concept is removed. It is replaced by **Dismiss**, which sends decision
`"allow"` to **release the blocking hook** so Claude Code shows its normal terminal prompt where the
user approves. **Submit feedback** is unchanged in spirit: decision `"deny"` + the assembled
`buildFeedbackPrompt(...)` comments, so Claude revises. The `#feedback-approve` button (formerly an
`#feedback-overlay` child) is **removed**; the overlay's `#feedback-copy` is now ALWAYS a plain
clipboard copy (no submit-mode), and the overlay is no longer review-aware.

**(2) Browse freely; a pending review never traps navigation.** "A review is pending" (a live
blocking hook) is now DECOUPLED from "what is rendered in the reading pane." Opening a real plan
while a review is pending shows that plan, leaves the review in the pending set, and does NOT resolve
it. The old `surfaceNextPendingReview()` re-poll on teardown — which re-opened the *same* still-
pending review on every sidebar click — is **deleted**.

State model (`main.ts`): `pendingReviews: Map<reviewId, {reviewId, planText, createdMs}>` (all known
pending reviews, each with a blocking hook); `reviewComments: Map<reviewId, CommentRecord[]>`
(per-review in-memory comments, isolated by id, NEVER persisted to comments.json); `viewedReviewId:
string | null` (which review is rendered, or null for a real plan / nothing). The `REVIEW_PATH`
comment-store sentinel now maps to `reviewComments.get(viewedReviewId)`.

The `#review-bar` now has **two modes** (pure derivation in `src/review.ts` `applyReviewBarState`):

| selector | where | role |
|----------|-------|------|
| `#review-bar` | inside `.reader-inner`, normal flow between `.doc-header` and `#reading-pane` | visible iff one or more reviews are pending; hidden when none. `refreshReviewBar()` is the sole writer of its `.hidden`. |
| `#review-bar-label` | inside `#review-bar` | **viewing** mode: `Reviewing plan — N comment(s)`. **summary** mode: `N plan(s) awaiting review`. |
| `#review-submit` | inside `#review-bar` | shown only in **viewing** mode → `respond_to_review(viewedReviewId, "deny", buildFeedbackPrompt(thatReview's comments))`. Disabled at 0 comments; enabled on the FIRST (authoritative-count plumbing). |
| `#review-dismiss` | inside `#review-bar` | shown only in **viewing** mode → `respond_to_review(viewedReviewId, "allow", "Dismissed in Plan Reader — approve in the terminal.")`. Releases the hook to the terminal. |
| `#review-resume` | inside `#review-bar` | shown only in **summary** mode → re-opens the NEWEST pending review (max `createdMs`) via `openReview`, switching the bar back to viewing mode. |

**viewing** mode = `viewedReviewId !== null` (a review is rendered): Submit + Dismiss shown, Resume
hidden. **summary** mode = reviews pending but a real plan (or nothing) is shown: count label +
Resume only. **hidden** = `pendingReviews.size === 0`.

Wiring: `openPlan` sets `viewedReviewId = null` (re-keys comments to the real path) and refreshes the
bar — it never resolves or re-opens a review (the navigation-unstick fix). On `plan-review-requested`:
the review is added to `pendingReviews`; if nothing is being viewed it is auto-shown (focus +
`openReview`), otherwise the bar count just rises (no yank). On `plan-review-cancelled`: the review is
removed from both maps and unviewed if it was the viewed one. Launch recovery populates all non-stale
pending reviews and auto-shows the newest (`console.warn` if more than one). On any resolve, the
review is removed from both maps; the bar drops to summary mode if others remain, or hides. Removed
symbols: `activeReview`, `ActiveReview`, `surfaceNextPendingReview`, `#feedback-approve`,
`#review-approve`, `#review-preview`.

### Amendment 2026-05-30 — Option A: a review OPENS + SELECTS the real plan file (no detached IPC render)

This supersedes the parts of the amendment above that describe a detached `openReview(reviewId, planText)`
render with an in-memory per-review comment store. **The reviewed plan is a real file under
`~/.claude/plans/`** (Claude writes it before `ExitPlanMode`), so a review now opens that file through
the **normal plan-open flow**, fixing an invariant violation (reading-pane content with no selected
sidebar row).

**Wire additions (backend + frontend, additive):** `ReviewRequest` and the `plan-review-requested`
event payload now both carry **`plan_file_path: string`** — the absolute path of the reviewed plan
file under `~/.claude/plans/`. The request JSON gains `"plan_file_path": "<abs path>"` (sourced from
the hook's `tool_input.planFilePath`). The event payload is now `{ review_id, plan_text, plan_file_path }`.
`src/types.ts` `ReviewRequest` / `ReviewRequested` mirror this.

**State model (`main.ts`):** `pendingReviews: Map<reviewId, {reviewId, planFilePath, planText, createdMs}>`.
The in-memory review-comment subsystem is **DELETED** (`REVIEW_PATH`, `reviewPathFor`, `reviewIdFromPath`,
`reviewComments`, `viewedReviewComments`, `viewedReviewId`, the `CommentsIO` review branch, `openReview`).
Review comments are now just the opened plan's **normal persisted comments** (keyed on its real path —
no special store). "Viewing a review" is **derived**: `currentReviewId(): string | null` returns the
reviewId whose `planFilePath === openPath`, else null. `CommentsIO` is the plain backend
get/set/clear; the comment-path reader is simply `() => openPath`.

**Bar derivation (`applyReviewBarState`, unchanged signature):** wiring computes
`viewing = currentReviewId() !== null` and `viewedCommentCount` = the open plan's comment count.
Submit → `respond_to_review(currentReviewId(), "deny", buildFeedbackPrompt(open plan's comments))`,
removes the review from `pendingReviews` (plan stays open + selected, comments stay saved). Dismiss →
`respond_to_review(currentReviewId(), "allow", "Dismissed in Plan Reader — approve in the terminal.")`,
removes from pending. Resume → opens the newest pending review's `planFilePath` via the normal flow
(re-selecting its row).

**Behavior:** on `plan-review-requested`, the review is added to `pendingReviews`; if no review is
currently being viewed, the app `focus_main_window`s, **refreshes the sidebar list** (so the just-
written plan's `[data-path]` row exists), then `openPlan(planFilePath, <stem>)` — which selects the
row. Live-reload works normally on a reviewed plan (a real file). `openPlan` no longer has any review
teardown — navigation is free and never touches `pendingReviews`; the bar flips viewing↔summary purely
by `openPath`. **Fallback (degraded):** if `plan_file_path` is empty OR the open fails (file missing /
outside plans dir), the handler `console.warn`s and renders the IPC-supplied `planText` detached (no
sidebar selection) so the review stays actionable.

### Amendment 2026-05-30 — Submit clears the submitted plan's comments; new `#review-clear` manual clear

Two additive changes to the `#review-bar` review flow (no prior section is rewritten):

**Submit consumes (clears) comments.** When `#review-submit` succeeds, the submitted plan's comments
have been consumed into the deny feedback, so they are now CLEARED. Strict order: (1) read the open
plan's comments and build the reason via `buildFeedbackPrompt`, (2) `respond_to_review(reviewId,
"deny", reason)`, (3) **only on success** clear the comments via the same path `#feedback-clear` uses —
`clearAllComments(readingPaneEl, openPath)` (facade) → backend `clear_comments(openPath)` + in-pane
highlight removal + `onCommentCountChanged` (count/button/bar refresh to 0). The reason still carries
the comments (built before the clear). **Dismiss does NOT clear** (no feedback was sent).

| Selector | Location | Contract |
|----------|----------|----------|
| `#review-clear` | inside `#review-bar` (`.review-bar-actions`, between `#review-submit` and `#review-dismiss`) | shown only in **viewing** mode AND when the open plan has **≥1 comment** (`ReviewBarState.clearVisible`). Discoverable MANUAL clear during review. Uses the dependency-free **two-click "Click again to confirm"** pattern (`window.confirm` is inert in Tauri v2 WKWebView): 1st click arms (`.confirming`, relabel, auto-revert after `HOOK_CONFIRM_MS`); 2nd click runs the `#feedback-clear` path `clearAllComments(readingPaneEl, openPath)`. `refreshReviewBar` disarms it when it hides. |

`applyReviewBarState` gains an additive `clearVisible: boolean` field (`true` only in viewing mode with
`viewedCommentCount > 0`; `false` in summary/hidden and at 0 comments). `refreshReviewBar` is the sole
writer of `#review-clear`'s `.hidden`.

---

## Agent SDK driver (Sub-Plan 01 — additive, non-breaking)

The app gains an **agentic runtime**: it drives Claude itself via the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) using the user's **subscription** token
(`CLAUDE_CODE_OAUTH_TOKEN`, never an `ANTHROPIC_API_KEY`). The SDK is embedded in a
**single-binary sidecar** (`sidecar/index.ts` → `bun build --compile` → the `externalBin`
`binaries/agent-driver-<triple>`), spawned via the Tauri shell plugin. Rust ⇄ sidecar speak
**newline-delimited JSON** over stdin/stdout; the sidecar **normalizes** the SDK's large
`SDKMessage` union into a small, stable wire vocabulary (below) so the SDK's version
volatility is encapsulated in the sidecar and never leaks into Rust or the frontend. None of
the §1/§2/§3 or prior additive surfaces are altered; `PlanRecord` is **UNCHANGED**. All driver
logic lives in `src-tauri/src/agent.rs`; the edits to the `lib.rs` monolith are additive
registration only (plugin init, managed `Mutex<Option<AgentDriver>>`, the eight commands
appended to `generate_handler!`, and a `RunEvent::Exit`/`ExitRequested` teardown that kills the
child so quitting leaves no orphan). **One session per app launch** (resume is a v1 non-goal).

### File-write invariant preserved — new self-owned auth file

The write surface stays bounded. The driver adds **one** new write target: the OAuth token is
persisted under the Tauri **`app_data_dir()`** as **`agent-auth.json`** (`{ "token": "<…>" }`,
atomic temp-write + rename, mode **0600**), mirroring the `cwd-cache.json` discipline. It is
**never** written into the read-only `~/.claude` trees. The token is injected into the sidecar
child's env on `start_agent_session` (the spawned CLI inherits it); `ANTHROPIC_API_KEY` is never
set or forwarded.

### New Tauri commands (registered in `invoke_handler`)

| command | args | purpose |
|---------|------|---------|
| `start_agent_session` | `{ cwd: String, permissionMode: String }` | spawn the sidecar (if needed) and begin **one** streaming session rooted at `cwd`, starting in the given mode (`"plan"` for the planning flow). **Validates `cwd` is an existing directory** (rejects + emits `agent-error{kind:"cwd"}` otherwise — an unvalidated cwd later becomes the `acceptEdits` scope). **One-session-per-launch:** a start while a session is live is **rejected** (first-call-wins; resume/replace is a non-goal). With **no stored token** it emits `agent-auth-required` and returns `Err`. |
| `send_agent_message` | `{ text: String }` | push a user turn into the streaming-input queue |
| `resolve_tool_permission` | `{ id: String, allow: bool, message: Option<String> }` | answer a pending `tool-permission-requested` (the `canUseTool` seam). `id` is the SDK's `toolUseID`, so resolve round-trips line up. |
| `set_agent_permission_mode` | `{ mode: String }` | mid-session `q.setPermissionMode(mode)` (Sub-Plan 03 uses it to flip plan → acceptEdits on approve) |
| `cancel_agent_run` | `{}` | graceful `q.interrupt()` of the current turn |
| `end_agent_session` | `{}` | end + kill the sidecar child for this session |
| `agent_auth_status` | `{}` → `{ hasToken: bool }` | report whether an OAuth token is stored (drives onboarding in 02) |
| `set_agent_oauth_token` | `{ token: String }` | persist the `CLAUDE_CODE_OAUTH_TOKEN` to `agent-auth.json` (injected into the sidecar env on next start) |

> **Invocation note:** Tauri serializes the JS args to the Rust params (snake_case Rust params
> map from the camelCase JS keys above). The `permissionMode` JS key maps to the Rust
> `permission_mode` param.

> **Amendment 2026-06-13 — `start_agent_session` gains an optional `resumeSessionId` arg;
> single-session resume-from-disk is now SUPPORTED.** The row above (and the line "resume is a v1
> non-goal" / "resume/replace is a non-goal") is retained verbatim for the historical record, but is
> **corrected here**: the **"resume an in-progress plan"** feature now lets a single session resume an
> SDK conversation from disk. `start_agent_session` accepts an **optional** `resumeSessionId?: string`
> JS arg (camelCase) → mapped to the Rust `resume_session_id: Option<String>` param → forwarded into
> the sidecar **start** command JSON as the `"resume"` field → spread by the sidecar into the SDK
> `resume` query option (pure `resumeOption`, key-omission preserved). **Omitted/`undefined` ⇒ a fresh
> session** (the start JSON omits `resume` entirely — never `resume: undefined`); a non-empty id ⇒ the
> sidecar pre-flights `getSessionInfo(id)` and resumes the transcript when it exists, else falls back
> to a fresh run and emits a `resume_fallback` frame (below). The **one-session-per-launch** guard is
> **UNCHANGED** — resume only adds a flag to the **first** start; a start while a session is live is
> still rejected. What is no longer a non-goal is **single-session resume-from-disk**; parallel /
> multi-session remains out of scope.

### New Tauri events (emitted to the frontend)

| event | payload | purpose |
|-------|---------|---------|
| `agent-stream` | `{ seq, kind, … }` normalized message | the full committed stream vocabulary (see below) — Sub-Plan 02 renders it |
| `tool-permission-requested` | `{ seq, kind:"tool_permission_requested", id, tool, input, agent_id }` | the `canUseTool` seam. `id` = the SDK `toolUseID`; `agent_id` = the SDK `agentID` (**non-null when the request originated inside a subagent** — handed to Sub-Plan 03 for subagent-written-plan reasoning) or `null`. Sub-Plan 03 maps approve→allow / request-changes→deny+feedback via `resolve_tool_permission`. |
| `agent-error` | `{ kind, message, fatal }` | sidecar/SDK errors. `kind` ∈ `"auth"` (token expiry/invalidity — fatal), `"cwd"`, `"spawn"`, `"sdk"`, `"io"`, `"contamination"` (a non-JSON line on the stdout channel — non-fatal diagnostic, never a silent drop). |
| `agent-exit` | `{ code }` | sidecar process terminated (crash, cancel, or normal end) |
| `agent-auth-required` | `{}` | emitted when a `start_agent_session` is attempted with no stored token (02 shows the `claude setup-token` onboarding) |

### Committed `agent-stream` vocabulary (`kind`)

The stable schema the sidecar maps `SDKMessage` onto. Because this file is **append-only**, Sub-
Plan 01 commits **only the kinds it actually observes on the wire** during its own verification.
Every `agent-stream` frame carries a monotonic `seq` and a `kind`; the kind-specific fields are:

| kind | fields (beyond `seq`/`kind`) | source |
|------|------------------------------|--------|
| `system_init` | `model, cwd, tools, skills, slash_commands, permission_mode, session_id` | SDK `system`/`init` |
| `assistant_text` | `text, parent_tool_use_id` | an assistant message `text` block |
| `tool_use` | `id, tool, input, parent_tool_use_id` | an assistant message `tool_use` block |
| `tool_result` | `tool_use_id, content, is_error, parent_tool_use_id` | a user message `tool_result` block |
| `mode_change` | `mode` | SDK `system`/`status` carrying a new `permissionMode` (a `setPermissionMode` round-trip) |
| `result` | `subtype, is_error, result, num_turns, duration_ms, total_cost_usd, session_id` | SDK `result` |
| `permission_denied` | `tool, tool_use_id, agent_id, decision_reason_type, message` | SDK `system`/`permission_denied` — the **bypass-detection signal**: `SDKPermissionDeniedMessage` short-circuits `canUseTool` (auto/`dontAsk` modes, deny rules, **PreToolUse hooks**), so this kind lets Sub-Plan 03 detect "a tool was decided without passing through our seam." |

**Execution-phase, subagent, and skill-invocation kinds are NOT committed by Sub-Plan 01** —
their SDK shapes are not yet observed (there is no `skill_use` subtype; subagent sub-stream
framing is unconfirmed). The sidecar's normalizer still **passes through** structured subagent
tool activity under the committed `tool_use`/`tool_result` kinds where it fits (carrying
`parent_tool_use_id`), and **drops** truly unrecognized subtypes (logged to the sidecar's own
stderr) so coverage degrades gracefully. Sub-Plans 02/03 append new kinds **once observed**.

### Stdout framing (Rust read task)

The driver relies on the shell plugin's **default line-buffering** — `tauri::utils::io::read_line`
accumulates across pipe reads until a `\n`/`\r` (no capacity cap, **retains** the delimiter
byte), so one `CommandEvent::Stdout` event == one whole JSON line; `set_raw_out(true)` is **not**
called. The pure `parse_stream_line(line)` **trims then skips** whitespace-only payloads — a
`\r\n` line yields a trailing event whose payload is `"\n"` (NOT `""`), so the guard is "skip
after trim," not "skip empty string." A non-JSON line surfaces as a `contamination` diagnostic
(`agent-error`, non-fatal), never a silent drop. The read task does **nothing but recv → parse
→ emit** and **never** blocks on app state or awaits a permission resolution (the plugin's event
channel is capacity-1, shared by stdout/stderr/terminate; blocking it would backpressure and
hang the sidecar). Permission replies travel a **separate** path (`resolve_tool_permission` →
child stdin), not through the read loop.

### Serialization invariant (sidecar)

Every stdout frame is `JSON.stringify(...) + "\n"` and nothing bypasses `JSON.stringify`, so the
only raw `\n`/`\r` on fd 1 is the single terminating `\n`. Raw CR/LF captured **inside** a
payload (e.g. Bash output) stays escaped and cannot split a frame. The SDK CLI child's
diagnostics are wired to the sidecar's `stderr` callback (kept off fd 1), so they never corrupt
the JSON-lines channel.

---

## Conversation domain (Sub-Plan 02 — additive, non-breaking)

The **front-of-house** for the agentic runtime: a **Conversation tab** in the reading pane plus a
new, self-contained frontend **conversation domain** (`src/conversation/`) that drives the
Sub-Plan 01 sidecar surface and renders its live event stream. None of the §1/§2/§3, prior
additive, or Agent-SDK-driver surfaces are altered — this section adds **DOM selectors**, one
**dialog capability**, and the **frontend domain's public shape**. The domain is **disjoint** from
`src/render/*` and the sidebar (`src/cwd.ts`/`src/resolve.ts`/`src/filter.ts`), converging with the
app only at `src/main.ts`. It consumes the frozen command/event vocabulary **verbatim** (snake_case
wire fields) and **does not** resolve permissions (`resolve_tool_permission` is Sub-Plan 03's
policy) — it *renders* `tool-permission-requested` as an "awaiting review" marker only.

### New DOM selectors

**Reading-pane tab row** (a SECOND `.tab-row`, distinguished by `.reader-tab-row`; `main.ts`
scopes its `initTabs` to that class so the sidebar's `data-tab="plans"`/`#tab-plans` tokens are
unaffected). The center "Table of Contents" tab from the prototype is intentionally dropped —
CONTENTS already lives in the sidebar.

| selector | element | role |
|----------|---------|------|
| `.reader-tab-row` | reading-pane `.tab-row` | the `[Plan | Conversation]` toggle (driven by the existing generic `initTabs`) |
| `.reader-tab-row .tab[data-tab]` | a tab button | `data-tab` is `"plan"` or `"conversation"` |
| `#tab-plan` | `.tab-pane` (ships `class="tab-pane active"`) | **default-active**; wraps the EXISTING `.doc-header` / `.review-bar` / `#reading-pane` (ids+classes intact; `#reading-pane` stays an **empty self-closed div**) |
| `#tab-conversation` | `.tab-pane` | holds the live stream + cancel control |
| `#conversation-stream` | `.conv-stream` container | **02 renders into** — the live agent-run stream (assistant text, tool rows, subagent groups, mode chips, markers, result/error/exit rows) |
| `#conversation-cancel` | `.conv-cancel` button | UI-side cancel → `cancel_agent_run` (graceful interrupt of the current turn) |

> **Placement invariant preserved:** `#sel-popover` and `#feedback-overlay` remain siblings under
> `.window`, **after** `#reading-pane` (they are NOT moved into `#tab-plan`), so the
> `contract.test.ts` string-index assertions still hold.

**Titlebar additions** (later siblings in the frozen `.titlebar-controls` slot; placed **before**
`#feedback-btn` so the frozen ordering `#feedback-btn … #theme-toggle` is preserved; window-drag
exclusion is the existing `isDragTarget()` interactive-target bail — no `data-tauri-drag-region`):

| selector | element | role |
|----------|---------|------|
| `#new-plan-btn` | `.conv-new-plan` button | opens the New-plan composer modal |
| `#sdk-status` | `.conv-status` pill | reflects `ready` / `building` / `auth required` / `error` via `data-status` (the dot color resolves through tokens) |

> **Amendment 2026-06-08 — `#sdk-status` RELOCATED out of the titlebar into the sidebar.** The pill is
> **no longer a child of `.titlebar-controls`**; it now lives in the LEFT sidebar under "Recent Plans",
> inside a new **`.sidebar-status`** wrapper in the Plans pane (`#tab-plans`, after `.sidebar-head` and
> before the `.search` filter). The id (`id="sdk-status"`), its `.conv-status` class, `data-status`
> values, and `role="status"` / `aria-live="polite"` semantics are **unchanged**, so `StatusController`
> and the `main.ts` `pill:` querySelector keep working untouched — only the DOM location moved. Rationale:
> the app is single-session, so the pill represents the one current run and reads more naturally beside
> the plan list than in the header. The row above is retained verbatim except for this placement note.
>
> | selector | where | role |
> |----------|-------|------|
> | `.sidebar-status` | wrapper in `#tab-plans`, between `.sidebar-head` and `.search` | new container hosting the relocated `#sdk-status` pill |

**New-plan composer modal** (`.conv-modal`, `.hidden` by default; sibling under `.window` so it
inherits no titlebar drag region and survives the reading-pane wipe):

| selector | element | role |
|----------|---------|------|
| `#composer-modal` | `.conv-modal` overlay | the New-plan modal (toggled `.hidden`) |
| `#composer-request` | `.conv-request` textarea | the plan request text |
| `#composer-dir` | read-only `.conv-dir-field` input | the chosen working directory (display only) |
| `#composer-choose-dir` | `.conv-btn` button | opens the native folder dialog (`@tauri-apps/plugin-dialog` `open({directory:true})`) |
| `#composer-mode` | `.conv-mode-toggle` group | Plan/Build segmented toggle; its two buttons carry `data-mode="plan"` / `data-mode="acceptEdits"` |
| `#composer-start` | `.conv-btn-primary` button | Start → `start_agent_session({cwd, permissionMode})` **then** `send_agent_message({text})` |
| `#composer-cancel` | `.conv-btn` button | closes the modal |
| `#composer-auth` | `.conv-auth` block (`.hidden` unless no token) | OAuth onboarding (run `claude setup-token`, paste a token) |
| `#composer-token` | `.conv-auth-input` input | the pasted `CLAUDE_CODE_OAUTH_TOKEN` |
| `#composer-token-submit` | `.conv-btn` button | persists it → `set_agent_oauth_token` |
| `#composer-error` | `.conv-error` line (`.hidden` by default) | shared inline failure line: Start surfaces empty-field validation + `start_agent_session`/`send_agent_message` rejections here (modal stays open, never a silent no-op); "Save token" surfaces empty-field + `set_agent_oauth_token` failures here. Cleared on field edit / successful start |

**Render selectors emitted into `#conversation-stream`** (all namespaced `.conv-*`): `.conv-text`
(SANITIZED assistant-markdown bubble), `.conv-tool` + `.conv-tool-head`/`-badge`/`-name`/
`-summary`/`-status`/`-chevron`/`-body`/`-input`/`-result` (collapsible tool row;
`data-status="running|done|error"`; `.expanded` reveals the body), `.conv-subagent`
(`data-agent-id`, accent left border, **no name label** — none is frozen), `.conv-chip-skill`
(best-effort Skill chip, inferred from the observed tool name only — **not** a committed wire
shape), `.conv-mode` / `.conv-mode-build` (mode chip / green Build-mode banner on
`mode_change`→`acceptEdits`), `.conv-perm-request` ("awaiting review — wired in Sub-Plan 03"
marker on `tool-permission-requested`), `.conv-perm-denied` (a visible `permission_denied` row),
`.conv-result` / `.conv-result-error` (the `result` row), `.conv-error` / `.conv-error-fatal`
(an `agent-error` row), `.conv-exit` (an `agent-exit` row).

### Sanitization invariant (assistant text)

Assistant-text bubbles are model-influenceable. `render.ts` renders markdown via the public
`renderMarkdown` (`src/render/markdown.ts`, built `html:false` — it does **NOT** sanitize) and
then passes the HTML through a **NEW HTML-profile `DOMPurify.sanitize`** (`USE_PROFILES:{html:true}`)
**before** any `innerHTML`. This is distinct from `mermaid.ts`'s SVG-profile sanitizer. Tool
`input`/`result`/Bash output are code/text — rendered via `textContent` only, **never** raw
`innerHTML`.

### Dark-mode invariant (tokens-only)

Every `.conv-*` rule and the composer modal use **only `var(--*)` tokens** — zero hardcoded
hex/rgb/hsl. Any new color is a `--conv-*` variable declared in **BOTH** `:root` **and**
`:root[data-theme="dark"]`: `--conv-bubble-bg`, `--conv-build-bg`, `--conv-build-text`,
`--conv-danger`, `--conv-danger-soft`, `--conv-overlay`, `--conv-on-accent`, `--conv-shadow`. So
the Conversation tab, composer, status pill, and all stream rows re-theme correctly in dark mode.

### Added dialog capability

`src-tauri/capabilities/default.json` gains **`dialog:allow-open`** (the `allow-open` permission
set of `tauri-plugin-dialog` v2.7.1, verified against the crate's
`permissions/autogenerated/commands/open.toml`) — scoping the native folder dialog used by
`#composer-choose-dir`. The plugin is registered additively in `lib.rs`
(`.plugin(tauri_plugin_dialog::init())`); `agent.rs` is untouched.

### Frontend domain public shape (`src/conversation/`)

`initConversation(els, onActivity) -> Promise<ConversationHandle>` is the single entry point
`main.ts` calls. It subscribes to the **five** Tauri events (`agent-stream`,
`tool-permission-requested`, `agent-error`, `agent-exit`, `agent-auth-required`), drives a **pure**
`ConversationModel` (`stream.ts`: orders by `seq`; correlates `tool_use.id`↔`tool_result.tool_use_id`
running→done/error; groups subagent sub-streams keyed by the frozen `parent_tool_use_id`; tracks
`permission_mode`; marks complete on `result`) → the DOM `renderTree` (`render.ts`), and owns the
UI side of cancel (`cancel_agent_run`) + teardown (`end_agent_session`). The `ConversationHandle`
exposes `openComposer()` and `teardown()`. **Skill and subagent display-NAME shapes remain
UNFROZEN** (Sub-Plan 01 committed neither) — they are rendered best-effort from observed wire data
and their exact shape is **deferred to the live-smoke step**, to be appended here once observed.

---

## In-process plan review (Sub-Plan 03 — additive, non-breaking)

Closes the agentic loop: when the **app's own Agent-SDK session** emits a plan via `ExitPlanMode`,
the in-process `canUseTool` seam (`tool-permission-requested`, Sub-Plan 01) **holds** it; the app
materializes the plan as a **real file** under `~/.claude/plans/`, opens it through the normal
plan-open flow in the **Plan tab**, and the user resolves it on the existing **review bar** —
**Approve** (→ allow + flip to `acceptEdits` + stream execution in the same session) or **Request
changes** (≥1 inline comment → deny + assembled `buildFeedbackPrompt` feedback → the agent re-plans,
re-entering review). None of the §1/§2/§3 or prior additive surfaces are altered; `PlanRecord` is
**UNCHANGED**. This section adds **one Tauri command** and **one DOM selector**; everything else is
**reused unchanged**.

### Why a real file (no synthetic store)

The existing review surface (`src/review.ts`, `src/feedback.ts`, the comment store, the review bar,
sidebar nesting) is keyed by an **absolute plan path** — a reviewed plan IS a real file under
`~/.claude/plans/` (Option A, per the "review OPENS + SELECTS the real plan file" amendment above).
The SDK hands only raw markdown (`tool-permission-requested` `input.plan`, **no path**), so the app
**writes that markdown to a real file** to reuse the whole surface verbatim — selecting the sidebar
row, persisting comments with the plan, live-reloading, and nesting re-plan versions.

### New Tauri command (registered in `invoke_handler`)

| command | signature | role |
|---------|-----------|------|
| `write_agent_plan` | `(plan: String, tree_id: Option<String>, nn: Option<u32>) -> Result<String, String>` | writes an agent-produced plan markdown into `~/.claude/plans/` as a **real file** and returns its **absolute path**. |

- **What it writes.** A file `agent-plan-<tree_id>-<nn>-<hex>.md` (sanitized slug) under
  `plans_dir()`, with **YAML frontmatter prepended** (the same marker grammar `list_plans` /
  `arrange_plans` parse — see §"Nested master/sub hierarchy"): `tree_id` / `flavor` / `nn`.
- **Frontmatter / nesting semantics.** The **first emission** of a session → `flavor: master` with
  a **freshly generated `tree_id`** (the seed). **Re-plans** (subsequent emissions in the same
  review loop) → `flavor: sub` + an **incrementing `nn`**, reusing the seed master's `tree_id`, so
  `arrange_plans` **nests each re-plan version under the seed master** in the sidebar.
- **Containment guarantee.** The written path is computed under `plans_dir()` and **containment-
  guarded** so a traversal-y slug can only ever land **inside `plans_dir()`** (defense against
  `../`). The write is **atomic** (temp-write + rename), mirroring the `cwd-cache.json` /
  `read-state.json` / `comments.json` writer discipline.
- **Return value.** The **absolute path** of the written file, which the frontend feeds straight
  into the normal `openPlan(path, stem)` flow.

> **File-write posture (relaxed, intentional).** This is the first command that writes into
> `~/.claude/plans/`, intentionally **relaxing** the viewer-era "never write into `plans/`"
> invariant: as a **standalone Claude Code replacement**, the app is now a plan *producer* and
> `plans/` is its canonical, single-rooted, interoperable plan store. The app **still NEVER writes
> into `~/.claude/projects/`** (read-only, cwd resolution only).

### New DOM selector

| selector | where | role |
|----------|-------|------|
| `#review-approve` | inside `#review-bar` (a button in the review-bar actions) | **hidden by default**; shown **only** while viewing an **in-process (Agent-SDK) plan review**. A **single click** → allow + flip the session to `acceptEdits` + execute (`resolveReview(currentReviewId(), "allow", "")`); no confirm step. `refreshReviewBar` is the sole writer of its `.hidden` (toggled from `ReviewBarState.approveVisible`). |

> This is a **new** selector distinct from the `#review-approve` that an earlier amendment listed as
> "Removed" (that was the external-hook auto-execute concept). Sub-Plan 03's `#review-approve` is the
> in-process Agent-SDK approve affordance — it round-trips `resolve_tool_permission`, not
> `respond_to_review`.

### Reused, unchanged

Sub-Plan 03 adds **no** execution-rendering code and renegotiates **nothing**. It reuses, byte-for-
byte:

- **Commands:** `resolve_tool_permission` and `set_agent_permission_mode` (Sub-Plan 01).
- **Events:** `tool-permission-requested` (the seam) and `agent-stream` kind `permission_denied`
  (the bypass alarm — Sub-Plan 01).
- **Review / comment / sidebar surface:** `#review-bar`, `#review-bar-label`, `#review-submit`,
  `#review-dismiss`, `#review-clear`, `#review-resume`; the persisted comment store
  (`get_comments` / `get_comment_count` / `set_comments` / `clear_comments`, `comments.json`);
  `applyReviewBarState` (`src/review.ts`) and `buildFeedbackPrompt` (`src/feedback.ts`); the normal
  `openPlan(path, stem)` flow; and `arrange_plans` sidebar nesting (Sub-Plan 01 / 02).

### In-process review POLICY (load-bearing)

- **Every `tool-permission-requested` with `tool === "ExitPlanMode"` is HELD until the user
  resolves it on the review bar.** The handler writes a real plan file (`write_agent_plan`),
  registers an in-process pending review (`reviewId = the request's `id` = the SDK `toolUseID`),
  and opens it in the Plan tab. **Nothing auto-allows** — the sole path to
  `resolve_tool_permission(allow:true)` is a click on `#review-approve`.
- **`agent_id` does NOT affect the hold.** A subagent-originated request (`agent_id != null`) blocks
  **identically** and round-trips via its stored `toolUseID`. There is no early-return / auto-allow
  branch on `agent_id`.
- **Resolution round-trips the SAME id.** Approve → `resolve_tool_permission({ id: toolUseId,
  allow: true, message: null })` then `set_agent_permission_mode({ mode: "acceptEdits" })`.
  Request-changes → `resolve_tool_permission({ id: toolUseId, allow: false, message:
  buildFeedbackPrompt(<the plan file's persisted comments>) })`. The `id` passed back is always the
  exact `id` from the held request.
- **Liveness — non-ExitPlanMode seam requests are auto-DENIED** (`resolve_tool_permission({ id,
  allow: false, … })`), never held — a defensive guard so a seam request can never hang the SDK
  (read-only tools in plan mode are auto-allowed by the SDK and should not reach the seam).
- **Held in-process reviews are PURGED on agent exit / fatal error / user cancel** (`agent-exit`,
  fatal `agent-error`, cancel), so a dead seam never leaves a phantom pending review — an Approve
  after the session is gone is impossible.

### Tab-ownership rule

On an `ExitPlanMode` permission request, **`main.ts` owns the reading-pane tab** and switches to the
**Plan tab** (so the plan is reviewed where the review bar lives). The **conversation facade
(`src/conversation/index.ts`) SKIPS its `onActivity()` tab-switch when `payload.tool ===
"ExitPlanMode"`** so it does not race `main.ts` to the Conversation tab — the facade still appends
its stream marker, but does not steal the tab for the review case. (For all other tool-permission
requests the facade's existing behavior is unchanged.)

**Enforcement note (convention/ordering, not type-level).** The `tool-permission-requested` event
has **two** listeners — the conversation facade (`src/conversation/index.ts`, ~line 242) and
`main.ts` (~line 1739). The "exactly one component owns the reading-pane tab on an `ExitPlanMode`
request → the Plan tab" invariant is held today by two cooperating mechanisms, neither of which is
enforced by the type system:

- The facade's `if (e.payload.tool !== "ExitPlanMode")` guard (`src/conversation/index.ts`,
  ~line 242) **skips its conversation-tab flip** for the `ExitPlanMode` case, so it never races to
  the Conversation tab.
- `main.ts`'s `chainHandler` async ordering (`src/main.ts`, ~line 1730 / 1741) makes its
  `switchToPlanTab()` run **last and win** for the review case.

This is a falsifiable, guarded contract: `src/main.inproc-review.test.ts` (the test around
lines 302–320) goes **RED** if the facade's `ExitPlanMode` skip is removed. Because the invariant is
a convention/ordering contract rather than a type-level one, **any refactor touching either listener
(or the chain ordering) must preserve both mechanisms**, or the tab-ownership invariant will break
silently.

### Source-aware review bar (additive to `applyReviewBarState`)

`applyReviewBarState` gains an optional **`source?: "external" | "in-process"`** input (default
`"external"`; every existing field stays byte-identical when omitted/`"external"`). `ReviewBarState`
gains two fields:

| field | meaning |
|-------|---------|
| `approveVisible: boolean` | `true` **only** when `viewing && source === "in-process"`; drives `#review-approve`'s visibility. |
| `submitLabel: string` | `"Request changes"` for in-process / `"Submit"` for external — the label on `#review-submit`. |

`submitDisabled = (viewedCommentCount === 0)` for **both** sources (≥1 comment still required to
deny — to reject wholesale, add one comment). `dismissVisible` stays **false** for in-process (no
terminal-release concept).

### Hook short-circuit constraint (load-bearing — mechanism pending live verification)

The **external `ExitPlanMode` `PreToolUse` hook** (installed in `~/.claude/settings.json` for
external terminal Claude Code sessions — §"Plan Review (ExitPlanMode hook)") **short-circuits the
in-process `canUseTool` seam**: when a PreToolUse hook decides a tool, the SDK emits
`permission_denied` ("decided outside the seam") and the in-process `tool-permission-requested`
**never fires**. The app's own SDK session loads settings (`settingSources: ["user","project",
"local"]`), so the external review hook would fire FIRST for the app's own `ExitPlanMode` and route
the plan through the old external file-IPC path — the in-process seam (the entire point of this
sub-plan) would never trigger.

- **Therefore the external hook MUST be neutralized for the app's OWN SDK session.** It **stays
  installed and functional for external terminal Claude Code sessions** (neutralization ≠
  uninstalling).
- **The exact neutralization mechanism is PENDING live verification** (candidates: exclude `user`
  hooks from the SDK session / disable that hook per-session / a settings override). The confirmed
  mechanism is implemented as the closing change of this sub-plan.
- **Live signal of a short-circuit:** if an `ExitPlanMode` plan surfaces as **`permission_denied`**
  (`agent-stream`) **instead of** `tool-permission-requested`, the external hook short-circuited the
  seam — that `permission_denied` row (Sub-Plan 02's visible bypass alarm) is the diagnostic that
  neutralization is required for the session.

## Tool-permission policy + composer scope (corrective note, append-only)

This section corrects/extends earlier in-process intercept notes additively. Prior sections are
left intact.

### Non-ExitPlanMode tools are AUTO-ALLOWED (not denied)

The in-process `canUseTool` seam (`main.ts` `handleToolPermissionRequested`) now resolves every
**non-`ExitPlanMode`** `tool-permission-requested` with `resolve_tool_permission({ id, allow: true,
message: null })`. (Earlier notes described an auto-DENY here; that wording is superseded.) Auto-deny
flooded plan mode with "request blocked" errors. Auto-allow does NOT defeat plan mode: the installed
Agent SDK enforces read-only at the CLI level during plan mode regardless of `canUseTool`, and the
ONLY path that switches to `acceptEdits` remains the post-review `#review-approve` handler
(`set_agent_permission_mode("acceptEdits")`). The `ExitPlanMode` HOLD path (write + open in the Plan
tab + hold for `#review-approve`) is unchanged: it still never resolves at the seam.

Rendering: the conversation stream marker for a non-`ExitPlanMode` `permission_request` now renders a
muted neutral note `"<tool> permitted"` (class `conv-perm-request conv-perm-muted`) instead of the
misleading "<tool> request blocked" wording. The `ExitPlanMode` note ("Plan ready — reviewing in the
Plan tab") and the genuine `permission_denied` row are unchanged.

### Composer is plan-only (Build removed)

The New-plan composer no longer offers a Plan/Build toggle. The `#composer-mode` control is removed
from `index.html`; the composer ALWAYS starts sessions with `permissionMode: "plan"` (a fixed
constant). `ComposerElements.modeToggle` is retained on the interface (always `null` in production)
for caller/test compatibility but is unused. The only path to `acceptEdits` remains `#review-approve`.

### Composer-open auth refresh + session-liveness guard

- Opening the New-plan composer re-reads `agent_auth_status` (`StatusController.refresh()`) BEFORE
  showing the modal, so the auth banner + Start token-guard reflect live backend token state (kills
  the stale "No Claude subscription token found" banner).
- The conversation controller tracks a minimal session-liveness flag (`"none" | "running"`): set on
  session start / `system_init`, cleared on `agent-exit`, fatal `agent-error`, and cancel. While a
  session is live, `#new-plan-btn` is disabled and `openComposer()` is a no-op (the New-plan modal
  cannot be open mid-run). The Cancel button (`#conversation-cancel`) is disabled / no-op unless a
  session is live (it no longer invokes `cancel_agent_run` with no session).

### Single-source `SessionState` + Cancel = interrupt **and** end (supersedes the prior bullet's mechanics)

The previous design kept TWO desyncable representations of liveness — the controller's `"none" | "running"`
flag and `StatusController.building` (the pill) — and Cancel only interrupted the turn. That let
{ pill: "building", New-plan: enabled, modal: openable } occur after Start → Cancel while the sidecar
stayed alive. The invariant **"the New-plan composer cannot be open while an agent session is live"**
is now made unrepresentable via ONE source of truth:

- `SessionState = "none" | "running"`, owned by `initConversation` (`src/conversation/index.ts`), is THE
  source of truth. It is mutated in exactly ONE place: `applySessionState(next)`, which is called on every
  transition and re-derives ALL liveness-dependent UI so no two can disagree:
  - `#new-plan-btn` disabled ⇔ `running`
  - `#conversation-cancel` enabled ⇔ `running`
  - the status pill: `applySessionState` calls `StatusController.setBuilding(running)`, so a `none`
    session forces `building=false` (the pill can never show "building" while idle). `building` remains
    an internal sub-state of the pill for the streaming/auth/error/complete faces, but is now DERIVED
    from session state, never set independently for liveness.
  - the composer modal: if a transition to `running` happens while the modal is open, `applySessionState`
    calls `composer.close()` — so "modal open while running" is unrepresentable from BOTH directions
    (opening while running is a no-op; going running while open closes it).
- Transition to `running`: composer `onStarted` (successful Start), `system_init` / any `agent-stream`,
  and `tool-permission-requested` (belt-and-suspenders). Transition to `none`: `agent-exit`, fatal
  `agent-error`, and explicit Cancel. Transitions are idempotent (a late `agent-exit` after Cancel is a
  no-op).
- **Cancel semantics** (`#conversation-cancel`, only when `running`): invoke `cancel_agent_run` (interrupt
  the turn) THEN `end_agent_session` (kill the one-session-per-launch sidecar, releasing the slot so a new
  plan can start), and locally `applySessionState("none")` immediately — it does NOT wait for an
  `agent-exit` event (the killed child may not emit one). This is the fix for the reported bug.
- **Auth single-source**: `StatusController` holds auth as one boolean (`hasToken`). `openComposer`
  refreshes it before showing (unchanged); additionally, on successful Start the token provably exists,
  so `onStarted` calls `StatusController.markTokenPresent()` (set `hasToken=true`, clear `authError`)
  so a later composer reopen can never show a stale "no token" banner after a run has started.

---

## Agent-run reliability + controls pass (additive, non-breaking)

Three coherent fixes to the agentic runtime. None alter prior surfaces; all are additive.

### A. `canUseTool` auto-allows everything except `ExitPlanMode` (the permission-failure fix)

The SDK's **runtime** Zod validator REQUIRES `updatedInput` on an `allow` `PermissionResult` even
though the published `.d.ts` marks it optional — a bare `{ behavior: "allow" }` fails with a
`ZodError` (`path: ["updatedInput"]`), which the SDK turns into an `is_error` tool result. The
sidecar therefore:

- **Auto-allows every non-`ExitPlanMode` tool SYNCHRONOUSLY in `canUseTool`** —
  `return { behavior: "allow", updatedInput: input }` immediately. It does **NOT** emit a
  `tool-permission-requested` event and does **NOT** register a pending entry for these tools. This
  eliminates BOTH the `ZodError` (the result now carries `updatedInput`) AND the
  `Tool permission request failed: Error: Stream closed` races (no frontend round-trip for the common
  case, so a slow UI hop can't outlive the permission window).
- **Only `ExitPlanMode`** registers a pending permission, emits `tool-permission-requested`, and waits
  for the frontend `resolve_tool_permission` (the review). The pending registry now stores
  `{ resolve, input }`; on `resolve_tool_permission({ allow: true })` the sidecar echoes the stored
  `input` back as `updatedInput`. The abort/interrupt race (deny `"interrupted"`) is unchanged.
- **Frontend follow-through:** since only `ExitPlanMode` events arrive, `main.ts`
  `handleToolPermissionRequested`'s non-`ExitPlanMode` branch is now a defensive **no-op** (it does
  NOT call `resolve_tool_permission` — there is no pending entry to resolve). The conversation
  renderer's non-`ExitPlanMode` "permitted" row is no longer produced (retained only as an
  older-sidecar fallback). `permission_denied` (a separate SDK signal) still renders.

### B. New `agent-stream` kind: `status` (immediate "working" feedback)

| kind | fields (beyond `seq`/`kind`) | source |
|------|------------------------------|--------|
| `status` | `label` (a SHORT string) | sidecar maps low-level SDK progress signals — `thinking_tokens` → `"thinking…"`, `task_started`/`task_progress`/`task_notification` → `"running subagent"`, `rate_limit_event` → `"waiting (rate limit)"` — to a **label-only** frame (never the underlying text; privacy + noise). **Throttled at the source**: emitted only when the label CHANGES from the last emitted one; the throttle resets on each `result` (turn boundary). Truly-unknown subtypes are still dropped + logged. |

The conversation model derives a single `working: { label } | null` from this: shown while a turn is
active (events arrived, no `result`/`exit`/fatal-error yet), seeded `"Working…"` before the first
`status` frame so it appears IMMEDIATELY on run start. The renderer paints ONE in-place
`.conv-working` (with `.conv-working-dot` + `.conv-working-label`, `role="status"`) at the bottom of
`#conversation-stream`; the controller additionally gates it off whenever the session is not
`"active"` (so Pause/Stop hide it at once).

### C. Stop / Pause / Resume — `SessionState` extended to `"none" | "active" | "idle"`

Supersedes the prior `"none" | "running"` model (§"Single-source `SessionState`"). Same single-source
discipline — mutated only in `applySessionState`, which re-derives ALL controls so they cannot
disagree:

- `"none"` = no backend session. `"active"` = a turn is generating. `"idle"` = session alive, no
  active turn (after `result`, or after Pause).
- **Derived controls:** `#conversation-cancel` (**Stop**) enabled ⇔ `active ∨ idle`;
  `#conversation-pause` (**Pause**) enabled ⇔ `active`; `#conversation-resume` (**Resume**) enabled ⇔
  `idle`; `#new-plan-btn` disabled ⇔ a session exists (`active ∨ idle`); pill `"building"` ⇔ `active`.
- **Actions:** Stop = `cancel_agent_run` then `end_agent_session` → `none` (today's full-stop). Pause =
  `cancel_agent_run` ONLY (do NOT end) → `idle`. Resume = `send_agent_message("Continue.")` → `active`.
  All gated + idempotent.
- **Transitions:** composer `onStarted` / `system_init` / any non-`result` `agent-stream` frame /
  `tool-permission-requested` → `active`; `result` → `idle`; `agent-exit` / fatal `agent-error` /
  Stop → `none`; Pause → `idle`; Resume → `active`.

### New DOM selectors

| selector | role |
|----------|------|
| `#conversation-pause` | Pause button (interrupt the turn only; session stays alive) |
| `#conversation-resume` | Resume button (push a "Continue." user turn) |
| `.conv-working` (+ `.conv-working-dot`, `.conv-working-label`) | the single in-place "working…" indicator in `#conversation-stream` |

`#conversation-cancel` is unchanged as a selector but is now the **Stop** button (full-stop:
interrupt + end), wired into the controller as both `cancelBtn` (legacy alias) and `stopBtn`.

## Agent-SDK pivot UI cleanup (additive, non-breaking)

### Titlebar no longer exposes hook install/remove

The titlebar `#hook-setup` ("Install plan-review hook") and `#hook-remove` ("Remove") `<button>`s —
vestiges of the pre-pivot **external** terminal-Claude-Code integration (§"Plan Review (ExitPlanMode
hook)") — have been **removed from `index.html`**, along with their `main.ts` wiring
(`refreshHookButtons` / `wireHookButton` and the DOMContentLoaded calls) and the dead `.theme-toggle.hook-btn`
CSS. The app now drives Claude **in-process**, so those buttons only confused users.

- **Backend unchanged:** the `install_hook` / `uninstall_hook` / `hook_status` Tauri commands remain
  defined and registered (backend-only now). The external substrate is intentionally retained.
- **`#hook-status` is RETAINED** (selector unchanged): `setHookStatus()` still surfaces
  review-response (`resolveReview`) and save-for-review error messages on it. `setHookStatus`,
  `HOOK_STATUS_MS`, and `HOOK_CONFIRM_MS` (the `#review-clear` two-click confirm) all remain.

### Task / Agent tool row renders legibly

`renderToolRow` in `src/conversation/render.ts` now renders a `Task` (or `Agent`) tool_use's
**`description`** (suffixed with `(subagent_type)` when present) as the collapsed-row summary instead
of the raw JSON input blob. Any other tool — and a `Task` with no usable `description` — falls back
to the existing generic `summarize()`. Rendered via `textContent` (never innerHTML), as before.

### Immediate "working" indicator on session start

The conversation controller now seeds the single `.conv-working` indicator the instant a session
goes **`active`** (composer `onStarted` calls `rerender()`), so it appears RIGHT AWAY — before the
first `agent-stream` event — with the generic `WORKING_SEED_LABEL` ("Working…"). Real `status` frames
replace the label as they arrive; `result` / idle / `exit` hide it (the existing gate). No new
selectors. This closes the dead gap immediately after Start.

## Human-in-the-loop input (additive, non-breaking)

Two additions to the Agent SDK driver + conversation domain: the AskUserQuestion interactive seam
and a free-text message composer. Both are additive; no prior shape changed.

### Generalized interactive-tools seam (ExitPlanMode + AskUserQuestion)

The sidecar's `canUseTool` no longer holds **only** `ExitPlanMode`. It now holds the set of
**interactive tools** = `{ ExitPlanMode, AskUserQuestion }` (`sidecar/permissions.ts` →
`INTERACTIVE_TOOLS`; `isReviewTool` is its membership test). For an interactive tool the sidecar
registers a pending entry and emits `tool_permission_requested` (carrying `tool` + `input`), then
awaits the host's resolve — exactly as it always did for `ExitPlanMode`. Every **non**-interactive
tool is still auto-allowed synchronously in-process (no round-trip, no pending entry).

- `AskUserQuestion` `input` shape (the SDK's built-in question tool):
  `{ questions: [ { question, header, options: [{ label, description? }], multiSelect } ] }`
  (1–4 questions, 2–4 options each).
- `AskUserQuestion` does **not** fire inside subagents, and the SDK errors the tool after ~60s if
  unanswered. The host surfaces nothing special on timeout — it simply errors; the free-text
  composer (below) covers the subagent / no-question case.

### `resolve_tool_permission` — new optional `updated_input` param

The `resolve_tool_permission` Tauri command gains an OPTIONAL `updated_input: Option<Value>`
(JS arg name `updatedInput`). On allow:

- when `updatedInput` is provided (an object), the sidecar resolves the SDK permission with
  `{ behavior: "allow", updatedInput: <provided> }`;
- when omitted (`None`), the field is dropped from the JSON line and the sidecar falls back to
  echoing the stored tool input — the existing `ExitPlanMode` behavior.

Backward-compatible: callers passing only `id` / `allow` / `message` (e.g. the ExitPlanMode review
path in `main.ts`) are unchanged. The selection rule lives in `sidecar/permissions.ts`
(`resolveAllowInput`).

The sidecar `resolve-tool-permission` stdin command shape is now
`{ type, id, allow, message?, updatedInput? }` (`updatedInput` optional).

### AskUserQuestion answers payload shape

When the host answers a question card it calls
`resolve_tool_permission({ id, allow: true, message: null, updatedInput: { questions, answers } })`
where `questions` is the original questions array (echoed back) and `answers` is keyed by each
question's `question` string, with the value being the chosen option **`label`** (a string) for a
single-select question, or an **array of labels** (`string[]`) for a `multiSelect` question.

### New DOM — question card

Rendered by the conversation domain into `#conversation-stream` when a `tool-permission-requested`
event arrives with `tool === "AskUserQuestion"` (NOT routed to the plan-review path). Selectors:

| selector | role |
|----------|------|
| `.conv-question` (`[data-request-id]`) | the question card; gains `.conv-question-answered` once submitted |
| `.conv-question-section` (`[data-question]`, `[data-multi-select]`) | one question's block |
| `.conv-question-header` / `.conv-question-text` | the question's header / prompt text |
| `.conv-question-option` (+ `.conv-question-option-label`, `.conv-question-option-desc`) | one selectable option (label wraps the input) |
| `.conv-question-input` | the option's `<input type="radio">` (single) or `type="checkbox"` (multiSelect) |
| `.conv-question-submit` | the Submit button — disabled until EVERY question has a selection |
| `.conv-question-answer` | the chosen answer(s), shown read-only after submit |

Single-select questions render radios; `multiSelect` questions render checkboxes. On submit the card
re-renders read-only (no inputs / no Submit) so the stream keeps a permanent record of the answers.

### New DOM — free-text message composer

A persistent input row at the bottom of `#tab-conversation`, separate from the New-plan composer
modal and from the question card.

| selector | role |
|----------|------|
| `#conversation-input` | the composer row container |
| `#conversation-input-field` | the message `<textarea>` |
| `#conversation-send` | the Send button |

- **Action:** Send → `send_agent_message({ text })` with the trimmed field value, then clears the
  field. Enter sends; Shift+Enter inserts a newline. A no-op when the trimmed text is empty.
- **Enable/disable:** derived in `applySessionState` from the single `SessionState` source of truth —
  enabled ⇔ a session is live (`active ∨ idle`), disabled when `none`. This gives general
  human-in-the-loop input even when the agent never used AskUserQuestion (and covers the subagent
  case where AskUserQuestion cannot fire).

## Subagent visibility — `subagent_started` kind + labeled group header (additive, non-breaking)


Subagent activity is now surfaced with identity + task. When the agent spawns a subagent (Task/Agent
tool), the SDK emits a `system`/`task_started` message carrying `tool_use_id`, `subagent_type`,
`description`, and `prompt`. The sidecar previously dropped this into a coarse `status:"running
subagent"` frame, leaving the subagent group anonymous. It now emits a dedicated committed
`agent-stream` kind.

### New `agent-stream` kind: `subagent_started`

| kind | fields (beyond `seq`/`kind`) | source |
|------|------------------------------|--------|
| `subagent_started` | `tool_use_id` (string), `subagent_type` (string \| null), `description` (string \| null), `prompt` (string \| null) | sidecar maps SDK `system`/`task_started`. **`tool_use_id` is the load-bearing key:** it equals BOTH the parent Task `tool_use`'s `id` AND the `parent_tool_use_id` carried by every child message of the subagent — so the frontend keys the subagent group off it. Any field may be `null` when the SDK omitted it. |

- `task_progress` / `task_notification` still map to the throttled `status:"running subagent"` label
  (unchanged). Only `task_started` becomes `subagent_started`.
- This frame adds **no** standalone timeline node; the model folds it onto the subagent group keyed by
  `tool_use_id`. It may arrive **before** the first child (seeds an empty, labeled group so the user
  sees "Subagent · {type} — {description}" the instant the subagent starts) **or after** the children
  (annotates the already-formed group) — both resolve, wire order is irrelevant.

### Subagent group header (DOM)

The `.conv-subagent` group renders a header when metadata is present:

| selector | role |
|----------|------|
| `.conv-subagent-header` | header container (only present when `subagent_started` metadata arrived) |
| `.conv-subagent-title` | `Subagent · {subagent_type}` (or `Subagent` when type is null) — `textContent` |
| `.conv-subagent-desc` | the `description` — `textContent` (omitted when null) |
| `.conv-subagent-prompt` | the `prompt` sub-line — `textContent` (omitted when null) |

- All header text is `textContent` only (subagent fields are model-influenceable — never `innerHTML`).
- **Fallback:** absent any metadata (older sidecar), the group renders as the prior anonymous box (no
  header).
- **Redundant Task row suppressed:** when a subagent group exists for a Task/Agent `tool_use`'s id,
  that standalone top-level Task `tool_use` row is suppressed (the group header is now the primary
  display of the subagent's identity + task). A Task row with no corresponding group still renders
  normally (e.g. its final `tool_result` on the Task row).

<!-- end subagent visibility addition -->

---

## Amendment 2026-06-07 — un-openable review is REFUSED + the producer is RELEASED (replaces the detached-render fallback)

This supersedes the **degraded detached-render fallback** described in the 2026-05-30 "Option A" amendment
(§ around line 1226: *"if `plan_file_path` is empty OR the open fails … the handler `console.warn`s and
renders the IPC-supplied `planText` detached … so the review stays actionable"*). That fallback was
removed in a prior change (the `renderReviewTextDetached` helper was deleted): a detached render never
set `openPath`, so `currentReviewId()` stayed `null` → the bar fell to SUMMARY mode (Submit/Dismiss
hidden, their handlers bail on the null guards) while the dead review was STILL counted — an
unactionable phantom that trapped navigation but could never be acted on.

**New behavior — `refuseUnopenableReview(review)` (`src/main.ts`).** A pending review whose REAL plan
file cannot be opened (empty `planFilePath`, or `openPlan` threw — file missing / outside the plans dir)
is **REFUSED**: an un-openable plan can never be reviewed, so the held producer is **RELEASED with a
DENY** before the review is dropped (leaving it held would hang the agent). The release is
**SOURCE-AWARE** — it delegates to `resolveReview(reviewId, "deny", reason)`, which dispatches per
`PendingReview.source`:

- **in-process** (Agent-SDK `canUseTool` seam): denied via `resolve_tool_permission({ id, allow:false,
  message })`, freeing the held `canUseTool` promise so the agent re-plans instead of hanging forever
  (no SDK timeout). This mirrors the existing `write_agent_plan`-failure auto-deny in
  `handleToolPermissionRequested`.
- **external** (settings.json `ExitPlanMode` hook, file-IPC): denied via `respond_to_review(reviewId,
  "deny", reason)`, freeing the terminal hook so Claude stays in plan mode and can retry — instead of
  leaving it blocked until its ~570s hook timeout.

After releasing, the review is dropped from `pendingReviews` (belt-and-suspenders alongside
`resolveReview`'s own delete), the bar is refreshed (`refreshReviewBar`), and a **source-appropriate**
message is surfaced on `#hook-status` (`error`). The prior message "approve/deny in the terminal" is
**replaced** — it was wrong for in-process reviews (there is no terminal). `refuseUnopenableReview` is
now `async` and both call sites in `openReviewPlanFile` (the empty-path branch and the `openPlan`-threw
`catch`) `await` it.

---

## Multiplan orchestration (.plan-tree state-of-record)

Introduced by **Sub-Plan 01** (the orchestrator engine + lifecycle state machine). This supplements
every prior section and alters none of them. The durable orchestration ledger lives in
`<cwd>/.plan-tree/` — in the **user-chosen working directory, OUTSIDE `~/.claude/`** — materialized
through two new Rust commands because the WebView cannot write files. It is a **new deliberate write
surface**, guarded with the same atomic-write + canonicalized-containment discipline as the
`~/.claude/` writers. Plans are **also dual-written** into `~/.claude/plans/` via the existing
`write_agent_plan` (frontmatter `tree_id`/`flavor`/`nn`) so `arrange_plans`/the sidebar nests the tree.

### New Tauri commands (registered in `src-tauri/src/lib.rs`, implemented in `src-tauri/src/plan_tree.rs`)

```rust
// JS: invoke("write_plan_tree_file", { cwd, name, contents })
//   cwd: string  name: string  contents: string
pub fn write_plan_tree_file(cwd: String, name: String, contents: String) -> Result<String, String>;

// JS: invoke("read_plan_tree_file", { cwd, name })
//   cwd: string  name: string
pub fn read_plan_tree_file(cwd: String, name: String) -> Result<Option<String>, String>;
```

- The JS `invoke` arg names are **exactly** `cwd`, `name`, `contents` (write) / `cwd`, `name` (read) —
  Tauri serializes them to the like-named Rust params.
- **`write_plan_tree_file`** atomically writes `contents` to `<cwd>/.plan-tree/<name>` (temp + rename via
  the now-`pub(crate)` `crate::atomic_write`), creating `.plan-tree/` if absent, and returns the
  **absolute path** written.
- **`read_plan_tree_file`** reads `<cwd>/.plan-tree/<name>` as lossy UTF-8; an **absent file ⇒ `Ok(None)`**
  (graceful degradation, never an error), present ⇒ `Ok(Some(contents))`.
- **`name` is a strict allow-list** (membership + a hand-parsed shape, no regex): exactly `state.json`,
  exactly `master.md`, or the shape `NN-plan.md` / `NN-summary.md` where `NN` is **two ASCII digits**.
  Anything else is rejected — path separators (`/`, `\`), `..`, leading `.`, URL-escapes (`%`),
  absolute paths, single-digit prefixes, wrong stems, trailing junk. A rejected name returns `Err`
  and **writes nothing** (both commands validate identically before touching the filesystem).
- **Doubly defended:** even a name that slipped the allow-list cannot escape, because a second
  containment guard canonicalizes the `.plan-tree` parent and asserts the target's canonical parent
  equals it (mirrors `lib.rs`'s `guarded_plan_path`). `cwd` must be an existing directory.

> **Note 2026-06-08 — the prose allow-list above is non-exhaustive; the Rust constant is authoritative.**
> The `name` allow-list has since grown to also accept `recon.md` and `INTENT.md` as literal control
> files (the `master.md` re-plan loop and recon/intent phases write them). The authoritative set is the
> `LITERAL_PLAN_TREE_NAMES` constant + `valid_plan_tree_name` in `src-tauri/src/plan_tree.rs`
> (`state.json`, `recon.md`, `master.md`, `INTENT.md`, plus the `NN-(plan|summary).md` shape). The
> earlier two-item prose listing above is retained as history.
>
> **`.plan-tree/INTENT.md` divergence (known + accepted).** This app's `.plan-tree/INTENT.md` is the
> orchestrator's free-text confirmed-intent record (a plain-prose note of the user-approved intent for
> the run). It is **NOT interchangeable** with the CLI `/multiplan` skill's structured `INTENT.md`
> schema — same filename, different contract. The divergence is intentional and accepted; do not assume
> the structured schema when reading or writing this app's `INTENT.md`.

> **Note 2026-06-10 — START reconciliation adds a third command, `reset_plan_tree_dir`.**
>
> ```rust
> // JS: invoke("reset_plan_tree_dir", { cwd })
> //   cwd: string
> pub fn reset_plan_tree_dir(cwd: String) -> Result<(), String>;
> ```
>
> Emitted by the orchestrator's START reducer (`Effect {kind:"resetPlanTreeDir"}`, run BEFORE the
> genesis `persist`): moves **every** current entry of `<cwd>/.plan-tree/` into
> `<cwd>/.plan-tree/.archive/`, **replacing** any previous `.archive/` first — exactly one prior
> generation is kept (no nesting, no unbounded growth), so stale files from earlier runs (recon.md,
> master.md, NN-summary.md, hook litter) can never poison disk-derived phase detection. `.plan-tree/`
> is created if absent (the reset is then a no-op archive). Guards: `cwd` must be absolute, contain no
> `..` components, and be an existing directory; after creation the canonicalized `.plan-tree`'s
> parent must equal the canonicalized `cwd` (symlink defense). Entries move via same-volume
> `std::fs::rename` (atomic moves).

### `.plan-tree/state.json` schema (`schema: 1`)

Discriminated on `master.phase`; the per-sub-plan lifecycle is a closed enum. `updated_ms` is stamped on
every atomic write.

```jsonc
{
  "schema": 1,
  "tree_id": "2480B8A2-...",        // MUST equal master.md frontmatter tree_id
  "created_ms": 0, "updated_ms": 0, // updated_ms re-stamped on every write
  "master": {
    "phase": "decomposing",         // recon|sizing|decomposing|awaiting-approval|approved|running|done
    "sizer": { "decision": "split", "confidence": 0.82, "num_plans": 3 } // null until past "sizing"
  },
  "subplans": [
    { "nn": 1, "title": "...", "lifecycle": "summarized",
      "plan_path": ".plan-tree/01-plan.md",       // cwd-relative; null until drafted
      "summary_path": ".plan-tree/01-summary.md", // null until summarized
      "plans_dir_path": "/…/.claude/plans/agent-plan-….md", // dual-write render copy
      "redraft_count": 0, "last_feedback": null }
  ],
  "pointer": 0                       // index into subplans; -1 while master in control
}
```

Field meanings: `schema` is the format version; `tree_id` is the stable token joining this ledger to
`master.md` and all child plans; `created_ms`/`updated_ms` are epoch-ms creation/last-write stamps;
`master.phase` is the master state (closed enum below); `master.sizer` is the sizer outcome
(`decision`/`confidence`/`num_plans`), `null` until past `sizing`. Each `subplans[]` entry carries `nn`
(sequence), `title`, `lifecycle` (closed enum below), `plan_path`/`summary_path` (cwd-relative;
`null` until drafted/summarized), `plans_dir_path` (the dual-written `~/.claude/plans/` render copy),
`redraft_count` (back-edge counter), and `last_feedback` (most recent request-changes feedback, or
`null`). `pointer` indexes into `subplans` (`-1` while the master is in control).

- **Closed `master.phase` enum:** `recon | sizing | decomposing | awaiting-approval | approved | running | done`.
- **Closed sub `lifecycle` enum:** `pending | recon | drafting | awaiting-approval | executing | summarized`.
- **Coherence invariant** (reducer-enforced, test-pinned): every `subplans[i < pointer]` is `summarized`;
  `subplans[pointer]` is non-`pending`; every `subplans[i > pointer]` is `pending`.
- **Master↔pointer invariant:** `pointer === -1` iff `master.phase ∈ {recon, sizing, decomposing,
  awaiting-approval}`; `pointer >= 0` iff `master.phase ∈ {running, done}`; `master.phase: "approved"`
  is the single tick where `pointer` moves `-1 → 0`.
- **Recon / devils-advocate transcripts are NOT persisted** — only the sizer outcome plus the boolean
  fact that recon ran. Persisting transcripts would defeat context hygiene and bloat the ledger.

> **Amendment 2026-06-08 — `clarifying-intent` is the new GENESIS `master.phase` (recon is no longer
> genesis).** The closed `master.phase` enum documented above (`recon | sizing | decomposing |
> awaiting-approval | approved | running | done`, plus the terminal `escalated` the code also carries)
> now ALSO includes a new initial phase **`clarifying-intent`**. `START` lands the tree in
> `clarifying-intent`, NOT `recon`: `plan-tree.ts`'s `initial()` constructs
> `master: { phase: "clarifying-intent", … }`, and the `INTENT_CLARIFIED` event advances
> `clarifying-intent → recon`. So recon is no longer the genesis phase — it is the SECOND phase,
> reached only after intent clarification. The full sequence is now
> `clarifying-intent → recon → sizing → …`. The enum row above is retained verbatim as history; add
> `clarifying-intent` (initial) to it.
>
> **Master↔pointer invariant — `clarifying-intent` is a pointer === -1 pre-exec phase.** The invariant
> above states `pointer === -1` iff `master.phase ∈ {recon, sizing, decomposing, awaiting-approval}`
> (the pre-execution set). `clarifying-intent` is ALSO a pre-execution phase: the genesis tree rests at
> the sentinel `pointer === -1` while intent is being clarified, and no sub-plan exists yet. It belongs
> in that pre-exec set (it is in `plan-tree.ts`'s `PRE_EXEC_PHASES` alongside `recon`/`sizing`/
> `decomposing`/`awaiting-approval`/`escalated`). The invariant text above is retained as history; read
> the pre-exec set as additionally containing `clarifying-intent`.

### No new events, no new DOM selectors

Sub-Plan 01 introduces **no new Tauri events** — the orchestrator consumes the existing **five frozen
agent events**. It introduces **no new DOM selectors**; the gate UI (approval/clarify) is **Sub-Plan 02**.

### Permission-flip spike findings

**STATUS: VERIFIED (ran live, PASS).** The engine's load-bearing assumption is that **repeated bidirectional
`plan` ↔ `acceptEdits` permission-mode flips within one SDK session** are honored through the full app
seam (the Rust `set_agent_permission_mode` command → sidecar `set-permission-mode` → `q.setPermissionMode`,
with an observable `mode_change` frame per flip). The existing flow flips exactly once (plan → acceptEdits
on approve) and never reverses, so this is **unverified**. A falsifiable spike (`sidecar/spike-flip.ts`)
must be run to confirm — odd turns must hold `ExitPlanMode`, even turns must auto-allow, and every flip
must emit an observable mode frame — **before the live engine is trusted**. (The spike file is authored
separately; this section only records the finding.)

RESULT: PASS — repeated bidirectional plan↔acceptEdits flips work within one SDK `query` session; flipping
back to `plan` re-arms ExitPlanMode interception; proven repeatable across 3 draft cycles; plan-mode flips
emit observable `mode_change` frames.

KEY NOTE: the SDK AUTO-reverts plan→acceptEdits after each ExitPlanMode approval, so the orchestrator must
explicitly `setMode("plan")` BEFORE each next draft; it does NOT need to flip to acceptEdits after approve
(that is automatic).

## Multiplan default-entry, live bridge & gates (Sub-Plan 03 — additive, non-breaking)

Sub-Plan 03 connects the frozen reducer (`plan-tree.ts`) and the impure driver shell
(`orchestrator.ts`) to the running app: the composer becomes the **default (and only) planning
entry**, live agent frames are bridged into the driver's sequencer, and the master-decomposition
gate is surfaced. This supplements every prior section and alters none of them. **No new Tauri
commands, events, or DOM selectors** — the entire feature reuses the existing surface (see the
final subsection).

### Composer is the default planning entry → `getOrchestrator().start()`

- The composer Start no longer opens a bare plan-mode agent. `index.ts` binds the composer's
  `ComposerInvoker` so Start `await`s `getOrchestrator().start({ cwd, request })` (mode is always
  `"plan"`); the invoker's `sendMessage` is a **no-op** (the orchestrator owns the first/recon prompt).
- **`start()` returns a `boolean`.** `true` = a run was really started; `false` = the idempotent
  no-op (a `start()` while an orchestration is already active — single-session seam). The composer
  MUST run its `onStarted()` liveness UX (`applySessionState("active")` / `markTokenPresent()` /
  `onActivity()` / `rerender()`) **and `close()` the modal ONLY on `true`**; on `false` it surfaces
  an error and leaves the modal open. A dead start must never close the modal.

### Live bridge: frames → driver (`index.ts` listeners → driver ingest)

- The existing `agent-stream` and `tool-permission-requested` listeners in `index.ts` keep their
  current `model.appendStream` / `appendPermissionRequest` rendering (the Conversation tab still
  shows activity), then — **after** rendering — forward to the driver **only while orchestration is
  active**: `if (isOrchestrationActive()) void getOrchestrator().ingestStream(e.payload)` and
  `… ingestPermission(e.payload)`. Listeners stay in `index.ts` (where they are testable today); the
  driver stays `listen`/DOM-free and unit-testable.
- `ingestStream(frame: AgentStream)` and `ingestPermission(req: ToolPermissionRequested)` are the
  driver's two live entry points. `ingestStream` is the **turn-completion sequencer**; `ingestPermission`
  is the **interactive-tool path** (ExitPlanMode / AskUserQuestion).

### The `pendingStep` arming + approval-resume `result` swallow rule

- The driver owns a `pendingStep` flag naming the step it is **waiting on a `result` frame for**
  (`recon | sizer | sub-recon | summary | exec | null`). `ingestStream`'s `result` branch acts
  **ONLY when `pendingStep` is armed**, then disarms it. Every prompt the driver sends arms the next
  `pendingStep` — **or arms nothing** when the next signal is an ExitPlanMode hold (a
  `tool-permission-requested`), not a `result`.
- **Swallow rule:** the `result` that fires after an ExitPlanMode `allow` resumes the SAME turn lands
  while `pendingStep` is `null` and is **swallowed** — never mistaken for a fresh `*_DONE`. This is
  what prevents a post-approval resume from double-advancing the sequencer.
- `assistant_text` frames accumulate into a per-step buffer (cleared at each `*_DONE` boundary). For
  the SIZER scan the driver takes the **last** `SIZER:`-matching line (subagent text carries a
  non-null `parent_tool_use_id`; the last match avoids a stray top-level echo).

### Master-decomposition gate (keyed on phase, NOT nn)

- The split path surfaces an explicit master gate. The reducer DROPS `MASTER_DRAFTED.toolUseId`, so
  the driver tracks the held id as `masterToolUseId` and surfaces the gate via `onAwaitingApproval`
  with a **sentinel `ApprovalGate.nn === -1`** (`MASTER_GATE_NN`). The UI distinguishes the master
  gate by **`snapshot().master.phase === "awaiting-approval"`**, NOT by the `nn` value (a real sub
  `nn` is always `>= 1`; the sentinel never collides).
- Handle methods: **`approveMaster()`** → `resolvePermission({ id: masterToolUseId, allow: true })`
  then `dispatch(MASTER_APPROVED)` (→ running / pointer 0; sends the first sub-recon prompt, arms
  `"sub-recon"`). **`requestMasterChanges(feedback)`** → `resolvePermission({ id, allow: false,
  message: feedback })` then re-sends the master-draft prompt (stays `decomposing`). **Neither path
  dispatches `APPROVE`** (which requires a pointer and would throw at `-1`).
- The master `ExitPlanMode` is recognized in `ingestPermission` when `master.phase` is `decomposing`
  (first draft) OR `awaiting-approval` (a re-draft after `requestMasterChanges` — the reducer has no
  edge back to `decomposing`), never when a real sub is pointed.

### Single-authoritative-write rule (`wrotePlanForNn`)

- `write_agent_plan` mints a non-deterministic filename, so a "pre-write to learn the path, then
  re-write" approach would double-write. The driver does the **single physical write** in
  `ingestPermission`: for a drafting sub it calls `deps.writeAgentPlan(plan, treeId, nn)` to learn the
  real `~/.claude/plans/` path, sets `wrotePlanForNn = nn`, then dispatches `SUB_DRAFTED` carrying that
  real path (the reducer stamps it into the sub + gate). The reducer's `writeAgentPlan` **effect then
  no-ops** in `runEffect` when `wrotePlanForNn === eff.nn` (clearing the guard). Exactly one physical
  write per sub plan; the master plan is likewise written once (flavor master, `nn = null`).

### `CLARIFY_ANSWERED → updatedInput: { questions, answers }` reshape

- The reducer nulls `pendingClarify` **before** the `resolvePermission` effect runs, so the questions
  are not readable from state at effect time. The driver retains them in a `clarifyQuestions` map
  (keyed by toolUseId, populated at `CLARIFY_REQUESTED`). In `runEffect`'s `resolvePermission` case,
  when `eff.id` is a known clarify id, the driver parses `answers` from the reducer's JSON message,
  looks up the retained `questions`, and calls `resolvePermission({ id, allow, updatedInput: {
  questions, answers } })` — **dropping the raw message** — then deletes the map entry. This yields the
  `{ questions, answers }` shape the SDK/sidecar require (see the AskUserQuestion section), never an
  empty `questions: []`.

### Lifecycle reconciliation: Stop → `cancel()`, Pause/Resume disabled

- While `isOrchestrationActive()`, the run controls route through the orchestrator instead of the
  legacy direct `cancel_agent_run` / `send_agent_message` / `end_agent_session` path (which would
  strand `activeOrchestrator`, leaving `isOrchestrationActive()` stuck `true` and blocking the next
  composer open, and leave `heldPermissionId` un-purged):
  - **Stop → `getOrchestrator().cancel()`** (does cancelRun + endSession + purge held permission +
    deregister from the active-guard; the on-disk ledger is left intact).
  - **Pause/Resume are disabled** during orchestration — the orchestrator drives its own turns via
    `sendMessage`; an out-of-band "Continue." would inject a turn the sequencer does not expect.
- The **external** file-IPC review path (the ExitPlanMode hook from other Claude Code sessions) is
  unchanged: `pendingReviews`/`resolveReview` still serve `source: "external"`, and
  `handleToolPermissionRequested` early-returns on `isOrchestrationActive()`. Only the in-process
  single-shot composer review is subsumed (the composer no longer mints one), so two in-process
  review entry points never coexist.

### Per-step prompt / subagent protocol

- The driver sends a fixed set of module-constant prompts over the single SDK session, faithful to the
  `/multiplan` skill (subagents resolve via `settingSources: ["user", "project", "local"]`):
  - **recon** → "Use the **scope-recon** subagent … return its report verbatim"; arms `"recon"`.
  - **sizer** → "Use the **plan-sizer** subagent … emit exactly one top-level line `SIZER: <single|split|escalate> / <num_plans> / <confidence>`"; arms `"sizer"`. `escalate` is treated as `split`.
  - **master / sub draft** → "Draft … run a silent **devils-advocate-reviewer** pass … then call **ExitPlanMode** with the plan"; arms nothing (the ExitPlanMode hold is the next signal).
  - **sub-recon / sub-draft** prompts embed the sub's mandate **plus all prior `summaries`** (forward threading); the summary prompt asks for `## Changes` / `## Findings` / `## Next-step inputs`.

> **Amendment 2026-06-08 — a new INTENT step is sent FIRST (genesis), before recon, and a new
> `INTENT_CLARIFIED` event.** The per-step prompt list above does not include the genesis intent step;
> it now exists and is the FIRST prompt the driver sends (`orchestrator.ts`'s `intentPrompt(request)`,
> armed as `awaiting = { tag: "intent" }` in `start()` — BEFORE the recon prompt). The intent step's
> contract:
> - It is sent immediately after the SDK session opens, while `master.phase === "clarifying-intent"`.
>   The MAIN (orchestrated) agent invokes the **intent-clarifier** subagent ONLY to ASSESS the request
>   and return either a confirmed concise intent OR 1–3 clarifying questions. The subagent is given hard
>   constraints in its spawn prompt: it MUST NOT call AskUserQuestion or any interactive tool, MUST NOT
>   build/render visual or HTML prototypes or take screenshots, and MUST NOT write files. If questions
>   come back, the **MAIN agent** (never the subagent) asks them via **AskUserQuestion** (which surfaces
>   through the app's CLARIFY gate — a subagent's AskUserQuestion does not). The main agent's final
>   message is the confirmed INTENT.
> - On the intent turn's completion `result`, the driver dispatches the new **`INTENT_CLARIFIED`** event
>   (`PlanTreeEvent` `{ type: "INTENT_CLARIFIED"; intent: string }`). Its reducer effect **writes
>   `.plan-tree/INTENT.md`** (`writePlanTreeFile`, contents = the raw confirmed-intent buffer) and
>   `persist`s, advancing `master.phase` `clarifying-intent → recon`. The driver retains the trimmed
>   intent (null when whitespace-only) and threads it as a labeled "Confirmed intent" block ABOVE the
>   recon and master-draft prompts; an empty intent leaves those prompts byte-identical to their
>   pre-feature form. Only after `INTENT_CLARIFIED` does the driver send the recon prompt (arming
>   `"recon"`). The prompt-step list above is retained verbatim as history; the intent step precedes
>   the `recon` row.

> **Amendment 2026-06-10 — branded domain primitives + structured mandates (additive; prior rows
> retained verbatim as history).**
> - **`SUMMARY_WRITTEN` reshaped; the summary write moved to the DRIVER.** The event is now
>   `{ nn: Nn, summaryText: string, summaryPath: PlanTreeFilePath }`. The driver physically writes
>   `NN-summary.md` (via the existing `write_plan_tree_file` command, mirroring the sub-plan
>   single-authoritative-write seam) and dispatches the write's RETURNED path; the reducer only
>   records it (no `writePlanTreeFile` effect from `SUMMARY_WRITTEN` anymore).
>   `onSummaryWritten(nn, summaryPath)` and `SubPlanStep.summaryPath` now carry
>   **`PlanTreeFilePath`** — a branded string mintable ONLY by the driver's wrapper around the write
>   command's return (no exported cast helper), so summary TEXT can no longer pose as the path.
> - **`Nn` (branded 1–99 integer) with a single `parseNn` boundary.** `SubPlanStep.nn`, the per-sub
>   events, and `summaryName(nn)` are `Nn`-typed. `parseSubPlanHeaders` still matches `\d{1,3}` but
>   a header outside 1–99 (e.g. `### Sub-Plan 100:`) now THROWS a master-plan validation error,
>   surfaced as a terminal FATAL through the ingest queue — never a silent drop/truncation.
> - **`Mandate` struct.** `parseSubPlanHeaders` returns `{ preamble, subplans: [{nn, title, body}] }`;
>   the sub-recon/sub-draft prompt builders take `Mandate { title, sectionBody, masterPreamble }`
>   (a bare string no longer compiles), so those prompts embed the sub's master SECTION BODY and the
>   master preamble, not just its title.
> - **Sizer decomposition bias.** `sizerPrompt()` (now exported) carries the /multiplan skill's
>   `---DECOMPOSITION-BIAS---` block (greenfield multi-subsystem requests default to `split`).
> - **`updated_ms` stamping.** The reducer no longer touches `updated_ms` (its old self-max was a
>   no-op); the driver stamps a fresh injected `now()` at its single persist path, so every
>   `state.json` write carries the write's own timestamp.

### No new Tauri commands, events, or DOM selectors

Sub-Plan 03 adds **none**. The master + sub gates reuse the existing `#review-bar` /
`#review-approve` / `#review-submit` controls (Sub-Plan 02) and the existing AskUserQuestion card;
all SDK round-trips reuse existing commands — notably `resolve_tool_permission`, which **already
accepts `updatedInput`** (used for both the master/sub allow/deny and the AskUserQuestion
`{ questions, answers }` reshape). The only frontend wiring changes are the composer entry redirect,
the two `index.ts` ingest forwards, and the master-gate branch added before the per-sub branch in the
`#review-approve` / `#review-submit` handlers.

## Escalate-handoff notice row (additive)

The conversation stream gains one new render selector:

| Selector | Source | Purpose |
|----------|--------|---------|
| `.conv-notice` | a `notice` render node (model `appendNotice(text, seq)`) | a **plain, non-error** message row emitted into `#conversation-stream`. `textContent` is the BARE message — **no** `Error (...)` prefix and **no** `conv-error`/`conv-error-fatal` class. Used by the orchestrator's escalate handoff (`ConversationHandle.surfaceMessage` → `appendNotice`) so a routine "the planner needs more input" handoff is not mislabeled as a system error. It carries no error semantics: the derive places it without flipping session state, and it survives re-derive like any accumulated event. Styled neutral/informational via `var(--*)` tokens (no danger color). |

## `.plan-tree/` ownership contract (additive)

**Marker**: the presence of `.plan-tree/state.json` under a project directory means the tree is
**app-owned** — the claude-plan-reader app is the SOLE writer of `state.json`; the CLI `/multiplan`
skill never creates one. Absence of `state.json` means the tree is CLI-owned (legacy `/multiplan`
flow).

**Hook obligation**: the globally installed `PostToolUse:ExitPlanMode` hook
(`~/.claude/scripts/plan-tree-save-plan.sh`) fires on EVERY ExitPlanMode in every project. In an
app-owned tree it MUST exit 0 **without writing anything** — no `master.md`, no `NN-plan.md`, no
`.pending-*` caches, no `.last-input.json`, not even `.hook.log`. The guard
(`[ -f "$DIR/state.json" ] && exit 0`) sits immediately after the `.plan-tree/` existence check,
before any write path. In a CLI-owned tree (no `state.json`) the hook's behavior is unchanged,
byte-for-byte.

**App side**: the app NEVER relies on hook writes. All `.plan-tree/` state in app-owned trees
(state.json, plans, summaries, INTENT.md, recon.md) is produced by the app's own orchestrator /
`writePlanTreeFile` path. Any file the hook would have written there is litter, not input.

**Verification**: `bash scripts/hook-ownership.test.sh` — fixture-based shell test asserting
(a) app-owned tree stays byte-identical across a hook invocation, (b) CLI master-plan write still
happens, (c) CLI ambiguous `.pending-*` cache still happens.

## Amendment 2026-06-10 — `.plan-tree/state.json` persisted ledger shape (as actually written by `toLedger`)

**SUPERSEDES** the field shapes in the earlier section **"`.plan-tree/state.json` schema (`schema: 1`)"**
(under "Multiplan orchestration (.plan-tree state-of-record)"): that section's all-snake_case sub-plan
keys (`plan_path`, `summary_path`, `plans_dir_path`, `redraft_count`, `last_feedback`) and its
"cwd-relative `plan_path`" claim describe a shape that was never what the TypeScript driver persists.
Per the additive convention, the earlier section is retained verbatim as history — read THIS section as
the authoritative on-disk shape. (This supersession is scoped to the `state.json` ledger only: the
separate snake_case `PlanRecord` JSON surface — Rust-side serde — is intentional and still correct.)

What lands on disk is `JSON.stringify(toLedger(state))`, written by the driver's single `persist`
effect path (`orchestrator.ts` → `write_plan_tree_file(cwd, "state.json", …)`, atomic temp+rename).
`toLedger` (`src/conversation/plan-tree.ts`) projects exactly the `PlanTreeLedger` subset — the
transient `pendingApproval` / `pendingClarify` gates are NEVER serialized.

### Exact persisted shape (MIXED case — snake_case top level, camelCase sub-plan fields)

```jsonc
{
  "schema": 1,                       // literal 1 (format version)
  "tree_id": "tree-…",               // string — snake_case
  "created_ms": 1765432100000,       // number, epoch ms — snake_case
  "updated_ms": 1765432109999,       // number, epoch ms — snake_case (see stamping note below)
  "master": {
    "phase": "running",              // MasterPhase: clarifying-intent | recon | sizing | decomposing |
                                     //   awaiting-approval | approved (never rests) | running | done | escalated
    "sizer": {                       // SizerOutcome | null (null until past sizing)
      "decision": "split",           // "single" | "split" | "escalate"
      "confidence": 0.82,            // number
      "num_plans": 3,                // number (snake_case INSIDE sizer — SizerOutcome keeps its own shape)
      "handoff": null                // string | null — populated ONLY when decision === "escalate"
    }
  },
  "subplans": [
    {                                // SubPlanStep — camelCase fields
      "nn": 1,                       // Nn (number, 1–99; see Nn semantics below)
      "title": "…",                  // string
      "lifecycle": "summarized",     // pending | recon | drafting | awaiting-approval | executing | summarized
      "planPath": "/Users/…/.claude/plans/agent-plan-….md",     // string | null (camelCase, ABSOLUTE)
      "summaryPath": "/…/<cwd>/.plan-tree/01-summary.md",       // PlanTreeFilePath | null (camelCase, ABSOLUTE)
      "plansDirPath": "/Users/…/.claude/plans/agent-plan-….md", // string | null (camelCase, ABSOLUTE)
      "redraftCount": 0,             // number (camelCase)
      "lastFeedback": null           // string | null (camelCase) — most recent request-changes feedback
    }
  ],
  "pointer": 0                       // number — index into subplans; -1 = pre-execution sentinel
}
```

Field-for-field from `toLedger`: `schema`, `tree_id`, `created_ms`, `updated_ms`,
`master.phase`, `master.sizer`, `subplans[]` (each `nn`, `title`, `lifecycle`, `planPath`,
`summaryPath`, `plansDirPath`, `redraftCount`, `lastFeedback`), `pointer`. Nothing else is
persisted.

### Path semantics (all absolute; one field is brand-guarded)

- **`planPath` / `plansDirPath`** — both stamped (with the SAME returned value) from the driver's
  single authoritative `write_agent_plan` call at `SUB_DRAFTED` time: the **absolute path into
  `~/.claude/plans/`** of the agent-produced plan file. Plain `string | null` — not branded.
- **`summaryPath`** — the **absolute path of `<cwd>/.plan-tree/NN-summary.md`**, returned by
  `write_plan_tree_file`. It is typed **`PlanTreeFilePath`** (`string & { __brand: "PlanTreeFilePath" }`,
  `plan-tree.ts`): a path PROVEN to come from a real plan-tree write. There is NO exported cast
  helper; the brand is minted at exactly ONE site — `writePlanTreeFileMinted` in
  `src/conversation/orchestrator.ts` (the wrapper around `deps.writePlanTreeFile`'s returned path).
  This makes the old "summary TEXT posing as the path" bug uncompilable.
- (Note: the earlier-section claim that `summary_path` is cwd-relative is superseded — the write
  command returns and the ledger stores the absolute path.)

### `nn` semantics (`Nn` domain type)

`nn` is the branded **`Nn`** type: an integer PROVEN to be in **1–99** (the two-digit `NN-(plan|summary).md`
on-disk shape). **`parseNn` (`plan-tree.ts`) is the SOLE boundary** — every raw number entering the
domain (parsed master-plan headers, UI gate clicks) passes through it and it THROWS on anything outside
1–99. A master-plan header beyond the range (e.g. `### Sub-Plan 100:`) still matches the `\d{1,3}`
parser on purpose, then fails `parseNn` as a master-plan **validation error that DENIES the held master
ExitPlanMode with the message** (same mechanism as `requestMasterChanges`) so the master decomposition
is **redrafted** — never a silent drop/truncation, never a FATAL for this recoverable case.

### `updated_ms` stamping

`updated_ms` is a **last-modified stamp, NOT an ordering sequence**. The reducer never touches it;
the driver stamps a fresh **injected `now()`** (the `OrchestratorDeps.now` clock seam, default
`Date.now`) at its single persist path, immediately before each `state.json` write — so every write
carries the write's own real time, but two persists within the same millisecond may carry equal
stamps.

### Ownership marker + `.archive/` single-generation convention

- **`state.json` presence == app-owned tree.** This is the ownership marker the globally installed
  `PostToolUse:ExitPlanMode` hook fences on — see the earlier section
  **"`.plan-tree/` ownership contract (additive)"** for the full obligation (hook exits 0 without
  writing anything in an app-owned tree).
- **`.plan-tree/.archive/` keeps exactly ONE prior generation.** `START` emits `resetPlanTreeDir`
  (BEFORE the genesis persist): `reset_plan_tree_dir` replaces any previous `.archive/`, then sweeps
  every current `.plan-tree/` entry into the fresh archive via same-volume atomic renames —
  **marker-last**: `state.json` is moved LAST, so if any earlier rename fails mid-sweep the
  ownership marker is still at the root and the hook fence never drops while the dir is dirty.

## Amendment 2026-06-10 — `write_agent_plan` flavor is keyed on `nn`, NOT on first-vs-subsequent emission

This **supersedes** the "Frontmatter / nesting semantics" bullet in §"New Tauri command (registered
in `invoke_handler`)" above, which described flavor as keyed on the **first vs. subsequent emission**
per `tree_id`. That description is stale; the implemented rule (`write_agent_plan_in`,
`src-tauri/src/lib.rs`) keys flavor **purely on the `nn` argument**:

- **`nn: None` ⇒ `flavor: master`, no `nn` in frontmatter.** The supplied `tree_id` is **reused** if
  present, else a fresh one is seeded.
- **`nn: Some(n)` ⇒ `flavor: sub`, `nn: n`.** The supplied `tree_id` is likewise **reused** if
  present, else a fresh one is seeded.

Whether a `tree_id` was supplied has **no bearing on flavor** — this is load-bearing for the
multiplan orchestrator, which generates the `tree_id` itself (so it is ALWAYS `Some`) and signals
master-vs-sub purely through `nn`. The legacy viewer-era behavior is a strict subset: `(tree_id
None, nn None)` still yields a fresh-tree master, and `(tree_id Some, nn Some)` still yields a sub
of that tree. The previously mis-handled case `(tree_id Some, nn None)` — the orchestrator's master
write — now correctly stamps `flavor: master` instead of `flavor: sub, nn: 2`.

**Regression test**: `write_agent_plan_supplied_tree_id_no_nn_is_master_and_nests_subs`
(`src-tauri/src/lib.rs`, `cargo test --lib`).

## Note 2026-06-10 — the hook ownership guard is a HOST-ONLY manual prerequisite (not shipped by this repo)

The guarded hook script `~/.claude/scripts/plan-tree-save-plan.sh` (see §"`.plan-tree/` ownership
contract (additive)") lives in the **user's global `~/.claude/`**, OUTSIDE this repository. Nothing
in this repo installs, ships, or updates it — it is a **manual host prerequisite** that must already
carry the `state.json` ownership guard. Accordingly, `scripts/hook-ownership.test.sh` **SKIPs
(exit 0) with a clear message when the hook file is absent** on the machine running it, rather than
failing; on hosts where the hook is installed it asserts the full guard contract as before.

## Amendment 2026-06-10 — Stop → New plan ALWAYS yields a FRESH session (no context bleed)

Additive clarification + hardening of the one-session-per-launch lifecycle. The frozen surfaces are
unchanged (`start_agent_session` while a session is LIVE is **still rejected** — "a session is
already running (one session per launch)"); what is new is the guarantee that **starting a new plan
after a stop can never run inside the prior session's conversation context**. Three rules:

1. **Every terminal path ends the SDK session.** `cancel()` (Stop) and the escalate handoff already
   ran `cancel_agent_run` + `end_agent_session`; the **FATAL terminal now does too**
   (`notifyFatal` in `src/conversation/orchestrator.ts`, `wasActive`-guarded so a repeated FATAL
   never re-ends). A terminal orchestrator (`isOrchestrationActive() === false`) can therefore never
   strand a live sidecar session — the desync that previously left the old session (and possibly a
   widened mode) alive for a later start to collide with. Exception, by design: **`notifyDone`
   keeps the session alive** for follow-up free-text chat; `#new-plan-btn` stays disabled until the
   user Stops (which ends it).
2. **The fresh-session primitive is a NEW `start_agent_session`.** Each `start_agent_session`
   spawns a brand-new sidecar process (a brand-new SDK `query()` — empty conversation context),
   starting in the requested `permissionMode` (`"plan"` for every orchestrated run). A new plan is
   NEVER delivered via `send_agent_message` into a surviving session.
3. **A second `start` reaching an already-started sidecar is a FATAL protocol error, never a
   silent join.** Previously the sidecar logged "start ignored — session already running" and kept
   the old `Query` + module-level `hostPolicy`, so subsequent `user` messages (the new plan) were
   absorbed into the OLD session — the context-bleed seam. Now (`sidecar/session-start.ts`,
   `decideStart`, pure + unit-tested): a second `start` emits
   `{kind:"error", error_kind:"protocol", message, fatal:true}` (normalized by the host onto the
   public `agent-error` shape with `kind:"protocol"`) and the process **exits(1)**; the host's
   `Terminated` handling releases the session slot so a retry starts clean. A FRESH start
   **re-asserts the `hostPolicy` backstop from the start command's own `permissionMode`**
   (fail-closed `"plan"`), so a stale `"acceptEdits"` from a stopped mid-execution run can never
   leak into a new session's planning phase.

**Regression tests**: `orchestrator — every terminal path ends the SDK session`
(`src/conversation/orchestrator.test.ts`) and `sidecar decideStart — …`
(`sidecar/session-start.test.ts`), both falsifiable (inverting the fix turns them red).

## Amendment 2026-06-10 — TWO-OUTCOME sizer: `escalate` removed (unrepresentable); unknown decisions coerce to split

Additive amendment. **Supersedes every prior `escalate`/handoff mention** — notably the per-step
prompt row "`SIZER: <single|split|escalate> …`" (Per-step prompt / subagent protocol), the
"Escalate-handoff notice row (additive)" section's *rationale* (the `.conv-notice` selector itself
survives, see below), the `state.json` sketch's `"escalate"` / `"handoff"` annotations, the
`escalated` MasterPhase mentions, and rule 1 of "Amendment 2026-06-10 — Stop → New plan …" where it
cites "the escalate handoff" as a terminal path. Those sections are retained verbatim as history;
read them through this amendment.

The sizer now has **exactly two outputs**: `split`, or a *confident* `single`. Escalate is
**unrepresentable at the type level**. Rationale: the master decomposition gate is already the
human checkpoint, so an uncertain sizer must decompose — never terminate the run with a handoff.

- **Types** (`src/conversation/plan-tree.ts`): `SizerOutcome.decision` is `"single" | "split"`;
  the `handoff` field is REMOVED from `SizerOutcome` (it existed only for escalate; no
  reading-tolerance is needed — there is no resume-from-disk, so the ledger simply stops carrying
  it). The `ESCALATE` event variant, the terminal `escalated` `MasterPhase`, and the
  `notifyHandoff` effect are all removed; `SIZER_DONE`'s misrouted-escalate guard throw is gone
  (the case no longer compiles).
- **Prompt** (`orchestrator.ts` `sizerPrompt()`): the model is offered ONLY
  `SIZER: <single|split> / <num_plans> / <confidence>` and is told to choose `split` when
  uncertain. The `---HANDOFF---` fenced-block instructions and `parseHandoff` are removed. The
  `---DECOMPOSITION-BIAS---` block is unchanged.
- **Driver coercion** (`orchestrator.ts`, sizer branch): `"split"` → split; `"single"` → the
  existing confident/low-confidence handling (a `single` below 0.6 confidence is still treated as
  a split); **ANYTHING ELSE** — a literal `escalate` from a stale model response, an unknown
  decision word, or NO parseable SIZER line at all — is **coerced to `split`**
  (`{decision:"split", confidence:0, num_plans:0}`) with a LOUD `diag()` line in the dev terminal.
  This replaces both the old `ESCALATE` dispatch and the old
  FATAL("plan-sizer emitted no SIZER decision line"): an unparseable sizer turn is no longer fatal.
- **Observer surface**: `OrchestratorObserver.onHandoff` is removed (main.ts no longer subscribes
  a handoff handler). `ConversationHandle.surfaceMessage` and the `.conv-notice` selector REMAIN
  as the general non-error notice channel — only their escalate-specific rationale is superseded.
- **Rust surface**: unchanged. `PlanRecord`/`plan_tree.rs` never carried the sizer or handoff.

**Regression tests** (`src/conversation/`): `plan-tree.test.ts` — "a SizerOutcome with decision
`escalate` does not compile" (an `@ts-expect-error` pin: re-adding `escalate` to the union fails
`tsc` with TS2578) and "returns null for a SIZER line with an unknown decision word";
`orchestrator.test.ts` — "a literal `escalate` sizer decision coerces to split (loudly)" and "an
unparseable sizer turn (no SIZER line at all) coerces to split, never FATAL" (falsified by
temporarily restoring the FATAL mapping → red; restored → green).

## Amendment 2026-06-10 — Recursive representation cutover (schema-2 ledger, unified `ApprovalGate2`, path-keyed handle)

Additive amendment for Phase 1 of the recursive-multiplan redesign: the orchestrator core
(`src/conversation/plan-tree.ts` + `orchestrator.ts`) was cut over from the flat
master+`subplans[]`+`pointer` machine (generation 1) to the recursive `TreeNode`/`NodePath`
representation (generation 2). **Depth-1 observable wire behavior is byte-identical** — pinned by
the golden oracle `src/conversation/golden-depth1.test.ts` (every `sendMessage` prompt text,
`writeAgentPlan` arg, `setMode`, `resolvePermission`, `interrupt`, plan-tree file name/contents and
ordered observer event kind is unchanged; the ONE intended delta is the `state.json` ledger bytes,
below). Prior sections describing the gen-1 surfaces are retained verbatim as history; read them
through this amendment.

### `.plan-tree/state.json` is now **schema 2** (supersedes the schema-1 shape sections)

**Supersedes** both "`.plan-tree/state.json` schema (`schema: 1`)" and "Amendment 2026-06-10 —
`.plan-tree/state.json` persisted ledger shape (as actually written by `toLedger`)". What lands on
disk is `JSON.stringify(toLedger2(state))` (same single persist path, same atomic
`write_plan_tree_file` write, same driver-stamped `updated_ms` via the injected `now()` seam —
those semantics carry over unchanged). The recursive shape:

```jsonc
{
  "schema": 2,                  // literal 2 (format version; no schema-1 migration — no resume-from-disk exists)
  "tree_id": "tree-…",          // string — snake_case (unchanged)
  "created_ms": 1765432100000,  // number, epoch ms (unchanged)
  "updated_ms": 1765432109999,  // number, epoch ms (unchanged stamping semantics)
  "root": {                     // TreeNode — the ONE recursive node type (root included; camelCase fields)
    "nn": 1,                    // Nn (the ROOT's nn is conventional and never read — paths derive from child segments)
    "title": "…",               // string (the root's title records the request)
    "redraftCount": 0,          // number — survives stage transitions / redrafts
    "lastFeedback": null,       // string | null
    "state": {                  // the DISCRIMINATED per-node state — exactly one of three stages:
      // { "stage": "open",  "phase": "clarifying-intent" | "pending" | "recon" | "sizing" |
      //                              "decomposing" | "awaiting-decomposition-approval" }   // NO children, NO paths
      // { "stage": "leaf",  "phase": "drafting" | "awaiting-approval" | "executing" | "summarized",
      //   "planPath": string|null, "summaryPath": string|null, "plansDirPath": string|null }
      // { "stage": "split", "phase": "running-children" | "reviewing" | "summarized",
      //   "children": [TreeNode, …]  /* non-empty by construction */,
      //   "planPath": string|null, "summaryPath": string|null, "plansDirPath": string|null }
    }
  }
}
```

Deltas from schema 1 (all intentional):

- **`pointer` is GONE** — the active node is DERIVED (`activePathOf`: depth-first first
  non-pending/non-summarized node; coherence guarantees ≤ 1).
- **`master`/`subplans` are GONE** — the root is just the depth-0 invocation of the one node type.
- **The sizer outcome is NOT stored** — the verdict is fully encoded in the arc taken
  (single-collapse vs `decomposing`).
- **Run completion is DERIVED, never stored** — the tree is done iff the ROOT is `summarized`
  (`treeIsDone`); there is no `done` phase value and no completed flag.
- Path semantics (absolute `planPath`/`plansDirPath` from the single authoritative
  `write_agent_plan`; brand-guarded absolute `summaryPath` from `write_plan_tree_file`), `nn`/`Nn`
  semantics incl. the deny-for-redraft on out-of-range headers, the `state.json`-as-ownership-marker
  rule, and the `.archive/` single-generation convention all carry over UNCHANGED from the
  superseded sections.
- Transients are still never serialized: `pendingApproval`, `pendingClarify`, and the new
  `parsedChildren` stash (children parsed from a held decomposition draft materialize into the tree
  only at `DECOMPOSITION_APPROVED`).

### Unified `ApprovalGate2` in `pendingApproval` (supersedes the master-gate keying)

**Supersedes** "Master-decomposition gate (keyed on phase, NOT nn)". EVERY held ExitPlanMode gate —
the root decomposition gate included — is now carried in the snapshot's `pendingApproval` as ONE
shape:

```ts
interface ApprovalGate2 {
  path: NodePath;                    // [] = the root
  kind: "decomposition" | "leaf";    // the routing discriminant
  toolUseId: string;
  planPath: string;                  // absolute plans-dir path (what the UI opens)
  plansDirPath: string;
  redraftCount: number;
}
```

The `nn: -1` master sentinel is GONE; `master.phase === "awaiting-approval"` keying is GONE; the
driver-side `masterGatePlanPath` capture in `main.ts` is GONE. The UI derives ONE
`viewingGate(): ApprovalGate2 | null` (open plan matches `pendingApproval.planPath`) and routes
both bar buttons through it; the decomposition-vs-leaf behavior split lives INSIDE the
orchestrator's exhaustive `switch (gate.kind)`.

### Handle surface (supersedes `approveMaster`/`requestMasterChanges`)

`OrchestratorHandle.approveMaster()` and `requestMasterChanges(feedback)` are **superseded by the
unified path-keyed methods** (the per-sub `approve(nn: number)`/`requestChanges(nn, …)` signatures
are likewise superseded):

- `approve(pathKeyStr: string)` — `parsePathKey` is the loud UI boundary (`""` = the root,
  `"01"` = depth-1 child 01); the held gate is looked up and routed by `kind`:
  - **decomposition**: arm the `resuming` hold BEFORE the first await, dispatch
    `DECOMPOSITION_APPROVED` (the reducer resolves the held permission allow), then
    `deps.interrupt()` — the interrupt call is lexically scoped INSIDE this case. Invariant test:
    `root_decomposition_gate_routes_decomposition_branch`
    (`src/conversation/orchestrator-gate-invariants.test.ts`).
  - **leaf**: dispatch `APPROVE` (resolve allow; derived policy flips to acceptEdits), arm `exec`.
    **NEVER interrupts** — invariant test: `leaf_approval_never_interrupts` (same file; both
    falsified by inverting the branch → red → restored).
- `requestChanges(pathKeyStr, feedback)` — deny with feedback; decomposition →
  `DECOMPOSITION_CHANGES_REQUESTED` (a first-class reducer event now: the node returns to
  `open/decomposing` for the same-turn redraft — gen-1 rested at awaiting-approval with no event),
  leaf → `REQUEST_CHANGES` (redraft in place). Neither sends anything inline (the deny resumes the
  held turn).

Observer deltas: `onAwaitingApproval(gate: ApprovalGate2)` (fired for decomposition AND leaf gates
through the reducer's `notifyAwaitingApproval` effect — no more driver-side master surface);
`onSummaryWritten(path: NodePath, summaryPath)` (was `(nn, summaryPath)`); `onSnapshot`/`onDone`
carry `PlanTreeSnapshot2` (`{ treeId, root, activePath, writePolicy, done, pendingApproval,
pendingClarify }`). The events the internal `dispatch` funnel accepts are the gen-2
`PlanTreeEvent2` union (`NODE_RECON_DONE`/`SIZER_DONE`/`DECOMPOSITION_DRAFTED`/`CHILDREN_PARSED`/
`DECOMPOSITION_APPROVED`/`DECOMPOSITION_CHANGES_REQUESTED`/`NODE_DRAFTED`/`APPROVE`/…, all
path-addressed). The gen-2 reducer emits NO `writeAgentPlan` effect — the DRIVER is the single
authoritative plan writer (in `ingestPermission`), and it also writes `recon.md`/`master.md`
itself before dispatching the matching events (the driver-write boundary; the `wrotePlanForNn`
one-shot guard is gone with nothing left to no-op).

### Unchanged surfaces

No new Tauri commands, no new events, no DOM selector changes (`#review-approve`/`#review-submit`
behavior is identical — one button each, routing moved inside the orchestrator). The
`write_agent_plan` wire still takes `nn: number | null` this phase (Phase 2 widens it to dotted
strings). **Sidecar: unchanged. Rust: unchanged.**

**Regression pins**: `src/conversation/golden-depth1.test.ts` (byte-exact depth-1 wire traces; the
`state.json` contents are the one audited schema-2 delta), `plan-tree2.test.ts` +
`plan-tree2-reducer.test.ts` (gen-2 core), `orchestrator-gate-invariants.test.ts` (the two routing
invariants above, falsified both ways).

## Amendment 2026-06-11 — Dotted hierarchical ids (Phase 2: Rust accepts/writes dotted `nn`; flat legacy byte-identical)

Phase 2 of the recursive-multiplan plan generalizes the Rust/wire id scheme from flat two-digit
`nn` to **dotted hierarchical ids**. Flat legacy trees render byte-identically; this section is
additive and supersedes the "`write_agent_plan` wire still takes `nn: number | null` this phase"
note in the previous amendment's *Unchanged surfaces* (that deferral has now landed).

### Dotted `nn` grammar (frontmatter + `.plan-tree/` filenames)

- **Grammar**: `SEG("."SEG)*` where SEG is exactly two ASCII digits with value 01–99
  (canonical zero-padded form: `"01"`, `"02.01"`, `"02.01.01"`, …; unbounded depth).
- **`.plan-tree/` filenames** (`plan_tree.rs::valid_nn_md`, hand-parsed, no regex):
  `SEG("."SEG)*-(plan|summary).md`. Accepts `01-plan.md`, `02.01-summary.md`, `02.01.01-plan.md`.
  Rejects `1-plan.md`, `001-plan.md`, `02.-plan.md`, `02..01-plan.md`, `.02-plan.md`,
  `02.1-plan.md`, plus the entire pre-existing hostile set (traversal, separators, wrong stems).
- **Frontmatter `nn`** (`lib.rs::parse_nn_segments`): parses to the per-segment integer vector
  (`RawMarker.nn: Option<Vec<u32>>`). READ-side leniency: 1–2 digit segments, value 1–99 — the
  legacy unpadded `nn: 2` u32 frontmatter still parses as the single-segment `[2]` (pinned).
  Malformed/out-of-range values parse to `nn: None` (the marker survives; only the id drops).

### `PlanRecord` — additive `nn_path` field

`PlanRecord.nn` is UNCHANGED: still `Option<u32>` = the **first segment** only (legacy sidebar
behavior byte-identical, serde-pinned byte-for-byte in `planrecord_flat_wire_shape_byte_pin`).
NEW always-present key `nn_path: Option<String>` (present-as-null like `tree_id`/`nn`): the full
canonical zero-padded dotted id (`"02.01"`; flat legacy ⇒ `"02"`; master/standalone ⇒ `null`).
The frontend builds visual nesting depth from `nn_path` prefixes (Phase 3).

### `write_agent_plan` wire change (number → string)

`nn` is now **`Option<String>`** (Rust) — the canonical zero-padded dotted id. A bare JSON
integer (`nn: 2`, the previous wire shape) is **rejected by serde** at the invoke boundary
(pinned by `write_agent_plan_nn_wire_rejects_bare_integer`). The WRITE side validates strictly
(`valid_dotted_nn`): only canonical zero-padded segments 01–99 are accepted — `"2"`, `"02."`,
`"00"`, `"100"` etc. fail loudly with `Err` and write nothing. The slug nn part is the dotted
string verbatim (`agent-plan-<tree_id>-02.01-<hex>`; `valid_plan_slug` already allows `.`),
and the frontmatter emits `nn: 02.01`. Master/no-nn behavior is unchanged (`flavor: master`,
no `nn` key, slug part `00`). TS dep: `writeAgentPlan(plan, treeId, nnPath: string | null)` —
call sites send `pathKey(path)` (`"01"` at depth 1) or `null` for the root decomposition.

### Per-segment ordering rule (`arrange_plans`)

Children of a master order by **per-segment integer-vector comparison** on the dotted nn
(`Vec<u32>` lexicographic: `1 < 1.1 < 1.2 < 2` — a prefix sorts before its extensions; depth-first
dotted order). The order is **mtime-INDEPENDENT for distinct ids** (re-drafting a sub never
reshuffles the tree); `(mtime, stem)` tie-breaks apply to IDENTICAL ids only. Subs without an nn
sort last. The TWO-LEVEL grouping is kept: every sub of a tree_id (dotted included) is emitted
under its master — visual depth is the frontend's job (Phase 3).

### Orphan-rendering note

A dotted sub whose parent prefix row is absent (e.g. `02.01` present, `02` missing) is NOT
demoted/dropped at this layer: it still orders by its segments among its siblings. Rendering
that gap loudly (visual orphan handling) is the Phase-3 frontend's responsibility, driven by
`nn_path` prefixes.

**Regression pins**: `valid_nn_md_accepts_dotted_rejects_malformed` + extended
`still_rejects_unsafe_names` (validator), `parse_marker_reads_dotted_nn` +
`parse_marker_reads_sub_block_with_nn` (legacy u32 pin), `planrecord_flat_wire_shape_byte_pin`
(byte-exact flat shape), `arrange_orders_dotted_per_segment` (fragility pin: newest-mtime `02`
does not reorder; falsified by re-adding mtime to the distinct-id comparator → red),
`arrange_orphan_dotted_child_orders_by_segments_without_parent_row`,
`arrange_duplicate_dotted_id_collision_is_deterministic`,
`write_agent_plan_supplied_tree_id_no_nn_is_master_and_nests_subs` (extended with a dotted child),
`write_agent_plan_dotted_nn_writes_dotted_frontmatter_and_slug`,
`write_agent_plan_rejects_malformed_dotted_nn`, `write_agent_plan_nn_wire_rejects_bare_integer`
(serde rejects a bare integer). Golden oracle: only the three `writeAgentPlan` `nn` trace values
changed shape (`1`/`2` → `"01"`/`"02"`; documented in the golden header as Cutover Amendment 2).
**Sidecar: unchanged.**

## Phase 3 — Recursive sidebar nesting from `nn_path` prefixes (additive amendment)

The sidebar now builds ARBITRARY-DEPTH visual nesting from `PlanRecord.nn_path` dotted prefixes
(`src/main.ts::renderSidebar`). `arrange_plans` still emits the flat two-level grouping (every
sub immediately after its master, depth-first dotted order — see "Per-segment ordering rule"
above); depth is reconstructed frontend-side with a prefix-keyed stack: a sub whose `nn_path`
extends a preceding sub's `nn_path` by exactly one segment nests inside that sub's `.children`.

- **Dotted `.seq`**: a sub row's `.seq` shows the FULL canonical dotted id (`02.01`), derived
  EXCLUSIVELY from `nn_path` — never from the legacy first-segment `nn` (which would render a
  `02.01` child as a colliding duplicate "02"). A null `nn_path` keeps the legacy `00`
  placeholder. Monospace alignment is unchanged (`.sub .seq`).
- **Internal sub nodes**: a sub with nested children renders as a `.sub-node` wrapper
  (`data-nn-path`) holding its `.plan.sub` row — augmented with a leading `.twirl` and a
  trailing `.child-count` of its DIRECT children — plus a nested `.children` container.
  Leaf subs keep the EXACT pre-Phase-3 row markup (affordances appear only when children
  exist), so legacy flat (depth-1) trees render byte-identical DOM (golden-pinned).
- **Internal-node collapse is SESSION-ONLY**: tracked in an in-memory map keyed
  `tree_id` + U+0000 + `nn_path` (`SidebarCtx.subCollapse`), toggled by the node's twirl with
  instant class feedback. It is NEVER persisted and NEVER routed through `set_tree_collapsed` —
  the persisted tree_id collapse store remains master-only and unchanged.
- **Generalized loud orphan rule**: a sub whose `nn_path` parent prefix has no preceding row in
  the same tree (e.g. `02.01` with no `02`) renders FLAT at the master's depth-1 level with a
  `console.error` contract-violation diagnostic (mirrors the existing no-master orphan-sub
  convention; never a quiet re-parent). Extensions of an orphan are themselves orphans (each
  violating row is individually loud). Duplicate dotted ids are deterministic: all duplicates
  render at their prefix level in arrival order; children attach to the MOST RECENT duplicate.

**Regression pins** (`src/main.test.ts`): "recursive nesting from nn_path prefixes" cluster
(depth-2 nesting + dotted `.seq` DA pin + per-node direct child counts + session-only collapse),
"generalized loud orphan guard (dotted)", "duplicate dotted ids are deterministic", and the
legacy golden "flat tree DOM is byte-identical" pin. `PlanRecord`'s TS mirror + the
`list_plans.sample.json` contract fixture now carry `nn_path` (twelve locked keys).

## Phase 4 — Unlimited depth: per-node sizer, recursive gates, roll-up summaries (additive amendment)

The orchestrator now runs ONE node algorithm at every depth (the Phase-1 `requireDepth1` reducer
guard is deleted): recon → sizer → (single ⇒ the node ITSELF becomes the leaf) | (split ⇒ its own
decomposition draft + gate → recurse into children) — then, on completion, a per-level ascent.
Depth-1 observable behavior is preserved per the golden oracle's documented Amendment 3
(`src/conversation/golden-depth1.test.ts`): Scenario A is byte-identical; Scenario B gains exactly
the per-child sizer turn.

- **Per-node sizer (recursive descent)**: every NON-ROOT active node answers `NODE_RECON_DONE`
  with `open/sizing` and runs the SAME sizer turn/parser/coerce-to-split as the root
  (`SIZER_DONE{path}`): confident `single` (≥ 0.6) ⇒ the node is replaced by `leaf/drafting`
  (NO collapse child — the collapse exists only at the root, where a gate must still follow);
  `split` or low-confidence single ⇒ `open/decomposing`. ROOT-COLLAPSE EXCEPTION: the sole child
  of a planPath-less root split (`isRootCollapseChild`) inherited the root sizer's verdict and
  skips the per-node sizer (recon → `leaf/drafting` directly) — pinned by the unchanged golden
  Scenario A.
- **Nested decomposition gates**: `DECOMPOSITION_DRAFTED` / `CHILDREN_PARSED` /
  `DECOMPOSITION_APPROVED` / `DECOMPOSITION_CHANGES_REQUESTED` are legal at ANY depth. A non-root
  split's ExitPlanMode draft is written to BOTH stores: the plans dir via
  `write_agent_plan(plan, tree_id, nn = <dotted PathKey>)` (flavor `sub`, nests in the sidebar)
  AND `.plan-tree/<dotted>-plan.md` (`planName2(path)`; the root keeps `master.md`). Child
  headers are PER-LEVEL `### Sub-Plan NN:` numbers (parseSubPlanHeaders reused verbatim); child
  paths mint as `[...parentPath, parseNn(NN)]`; an NN outside 1–99 in a NESTED draft is
  denied-for-redraft with the same validation message as the root. A (re-)draft replaces ONLY the
  drafting node's descendant mandates — other levels' mandates survive.
- **Interrupt boundary, generalized**: EVERY decomposition approval — root and nested alike —
  arms the `resuming` hold (deferred first-child recon) and fires `interrupt()`; leaf approvals
  never do. Decomposition approvals are the ONLY `resuming`-arming sites: all completion-ascent
  hops (child-summary → next-sibling recon; last-child-summary → roll-up send; roll-up-summary →
  ascent send) send INLINE off the just-consumed summary result (nothing is in flight there).
  Pinned per-hop, falsified, in `src/conversation/orchestrator-depth2.test.ts`; the watchdog
  FATAL text is path-aware (dotted id).
- **Roll-up summaries + completion ascent**: when a NON-ROOT split's last child summarizes, the
  parent rests in its ROLL-UP WINDOW — `split/running-children` with ALL children summarized (a
  new, derived, non-root-only `assertCoherent2` allowance; `activePathOf` returns the parent
  itself there; `inRollupWindow` is the predicate). The driver then sends a roll-up summary turn
  fed the parent's DIRECT children's summaries, writes `.plan-tree/<dotted>-summary.md`
  (`summaryName2`), and dispatches `SUMMARY_WRITTEN{parentPath}` — which completes the parent
  (`split/summarized` + recorded `summaryPath`) and continues the ascent one hop (next pending
  sibling → recon | grandparent roll-up window | root summarized + `notifyDone`). The ROOT still
  writes NO roll-up (`treeIsDone` stays derived; `summaryName2([])` still throws). The ascent
  recursion lives in the EVENT STREAM (one hop per `SUMMARY_WRITTEN`), never inside one reduce.
- **Per-level summary threading**: the driver's `summaries` map stays keyed by full `PathKey`;
  prompt threading collects ONLY the target level's DIRECT siblings (parent-prefix filter). A
  nested child sees its own completed siblings' summaries — never another level's; a later
  root-level sibling sees a completed split sibling's single ROLL-UP summary, never the
  grandchildren's. Write policy is unchanged: `acceptEdits` iff some leaf executes (the roll-up
  window/turn stays `plan`).
- **Sidebar filter ancestor retention** (`src/filter.ts`): when a sub matches the filter query,
  the result retains — besides the master — every sub whose `nn_path` is a PROPER PREFIX of the
  match's (its ancestor chain), in original stream order, so a filtered dotted tree never trips
  the loud-orphan rule. Depth-1 behavior is unchanged (a depth-1 sub has no sub ancestors).
- **Duplicate-sub ordering direction (pinned)**: `arrange_plans` orders identical sub ids
  oldest-mtime-first / newest-LAST (Rust test
  `arrange_duplicate_sub_ids_order_oldest_first_newest_last`), which is what makes the sidebar's
  documented "children attach to the MOST RECENT duplicate" rule mean the NEWEST draft wins.

Sidecar: unchanged. Phase-5 seams (parent review: the `reviewing` phase, its coherence rules, and
the `parent-review` awaiting-variant slot) are untouched.

## Phase 5 — The parent review turn between siblings (additive amendment)

After each NON-FINAL child's `SUMMARY_WRITTEN` (right-siblings remain — at ANY depth, root
included), the PARENT now runs an active review turn before the next sibling starts. The LAST
child of a level skips it entirely (review happens only BETWEEN siblings; the roll-up window and
root completion are unchanged) — pinned by the byte-identical golden Scenario A.

- **Reducer arcs** (`src/conversation/plan-tree.ts`): the non-final-child summary moves the parent
  `running-children → reviewing` and the next sibling STAYS `open/pending`. The new event
  `PARENT_REVIEW_DONE { path: parentPath, note: string | null }` is the ONLY exit from
  `reviewing`: back to `running-children` + the next pending child → `open/recon`. Any other
  event during `reviewing` throws (the reviewing parent is the active node; `requireActive2`
  rejects events addressed elsewhere). The `note` rides the event for traceability only — the
  reducer never stores it (never persisted). Coherence rules (each pinned falsifiably):
  `reviewing` is legal only with ≥1 summarized child behind, ≥1 pending child ahead, and NO
  active child; no leaf may be `executing` under a `reviewing` ancestor (the rule now has a
  reachable arc: a nested parent reviews while the root runs children).
- **Review turn protocol** (`parentReviewPrompt`, exported): a NO-TOOLS turn carrying the reviewed
  child's summary VERBATIM + the remaining siblings' mandates (titles + section bodies —
  **mandates are FROZEN**: the review may only pass one adjustment note, never re-decompose) +
  the strict output protocol: the turn must END with exactly one line `ADJUST: <note>` or `NONE`.
  `parseParentReview(text)` (exported, pure) scans all lines, LAST matching line wins; an
  unparseable turn (no protocol line, or a bare `ADJUST:`) coerces to NONE with a loud diag —
  never fatal.
- **Single-note lifecycle (driver)**: the driver holds at most ONE pending note —
  `adjustNote: { parentKey, note } | null` (deliberately not a Map; never persisted). Set (or
  nulled, on NONE/unparseable) at every `PARENT_REVIEW_DONE`; scoped by `parentKey` so only the
  issuing parent's children ever see it; injected as a labeled block ("Adjustment from the
  parent's review of the previous sibling:") into the next child's recon AND draft prompts
  (`subReconPrompt`/`subDraftPrompt`/nested decomposition draft — all exported or threaded);
  CLEARED when that child's DRAFTED event (`NODE_DRAFTED` or nested `DECOMPOSITION_DRAFTED`)
  dispatches — i.e. after both prompt injections. A null/empty note yields BYTE-IDENTICAL prompts
  (pinned), so a NONE review leaves the wire surface unchanged (golden Scenario B's review turn
  is insert-only).
- **Awaiting variant**: `{ tag: "parent-review"; parentPath; reviewedChild; buffer }`. The review
  result is consumed inline: `PARENT_REVIEW_DONE` dispatch + the next child's recon sent
  INLINE — decomposition approvals remain the ONLY `resuming`-arming sites.
- **Turn watchdog generalized (DA P4 follow-up)**: the `summary` AND `parent-review` awaiting
  variants are now watchdog-bounded by ONE constant `TURN_RESULT_TIMEOUT_MS` (120s — these are
  real generation turns, wider than the 30s interrupt-bounded `RESUME_RESULT_TIMEOUT_MS`, which
  is unchanged). No result within the window ⇒ the established loud terminal FATAL (serialized
  via the ingest queue). One shared timer slot; cleared on every exit path: consumed result,
  re-arm, Stop/cancel, FATAL, done (all via `markTerminal`).
- **Rogue ExitPlanMode deny (DA P4 follow-up)**: an ExitPlanMode arriving while the active node
  matches NO legal drafting branch — a summary turn (leaf or roll-up), the roll-up window, or the
  reviewing window — is now resolved as a DENY with
  `this turn must not call ExitPlanMode — finish the <summary|review> text` (plus a loud diag)
  instead of being silently dropped with the sidecar's held resolver stranded. The run continues
  (the deny is fed back as the tool error). Legal drafting branches are unchanged:
  `open/decomposing | awaiting-decomposition-approval` (decomposition flow) and `leaf/drafting`
  (leaf flow).

Golden oracle: Scenario A byte-identical (zero changes — pins both the last-child skip and the
single-child case); Scenario B gains exactly the one review turn between sub-01 and sub-02,
documented as CUTOVER AMENDMENT 4 in `golden-depth1.test.ts` (insert-only audit: the reviewing
persist + the review sendMessage + the PARENT_REVIEW_DONE persist, whose contents equal the
pre-Phase-5 post-summary persist byte-for-byte; sub-02's recon/draft prompts unchanged — the
harness answers NONE). Sidecar: unchanged.

## Note 2026-06-11 — `#sdk-status` pill relocated to the sidebar head (additive)

The SDK status pill keeps its frozen id `#sdk-status` and all StatusController behavior, but its
DOM parent moved from `.titlebar-controls` to a new `.sidebar-status` container in the sidebar
head (`index.html`). Selector-based consumers are unaffected (the id is unchanged — verified by
`contract.test.ts`); only the visual placement moved. This supersedes the placement implied by
the original titlebar section without rewriting it.

## Note 2026-06-11 — result-row rendering is three-way (additive)

The `result` row in `#conversation-stream` now renders three ways, keyed EXCLUSIVELY on a
host-side `deliberateInterrupt` tag (never on the SDK `subtype` — `error_during_execution` also
covers genuine mid-run failures): a deliberately-interrupted turn (the orchestrator armed
`resuming` and fired the gate-boundary interrupt; index.ts tags the STORED frame at ingest)
renders a muted, non-error `.conv-result-interrupted` row reading "Turn interrupted — continuing";
a genuine error renders `.conv-result-error` with `Run failed: <message>` or, when the SDK
provided no result text, `Run failed (no details)` (a null payload is never interpolated as the
string "null"); success renders "Run complete" unchanged. `.conv-result-interrupted` joins the
`.conv-*` selector list (tokens-only styling).

## Amendment 2026-06-12 — Model & effort picker (additive, non-breaking)

Added 2026-06-12. A model/effort preset picker now lives in the `.titlebar-controls` slot as its
**first child** (left of `#text-dec`), letting the user choose which SDK model+effort the **next**
plan they start runs under. None of the §1/§2/§3 or prior additive surfaces are altered; `PlanRecord`
is **UNCHANGED**. As with every control added to `.titlebar-controls`, these are **owner-appended
later siblings** (never editing 01's markup) and rely on the JS drag-exclusion invariant
(`isDragTarget()` bails on interactive children, per the 2026-05-25 Sub-Plan 01 amendment) — **no
per-control `data-tauri-drag-region`** and no `pointer-events` hack.

### New DOM selectors

| selector | element | role |
|----------|---------|------|
| `.titlebar-model-picker` | wrapper `<div>` in `.titlebar-controls`, **first child** (left of `#text-dec`) | model & effort preset group; `title`/`aria-label` = "Model & effort — applies to the next plan you start". Drag-immune via the `isDragTarget()` interactive-control bail (it holds plain `<button>`s), NOT `data-tauri-drag-region`. |
| `.model-preset` | three `<button class="model-preset" data-preset="…">` inside `.titlebar-model-picker` | a preset choice. `data-preset` ∈ `opus-4-8` \| `fable-5` \| `sonnet-4-6` (labels "Opus 4.8" / "Fable 5" / "Sonnet 4.6"); the selected one carries `.active`. Clicking persists the choice. Same drag-immunity. |

### Persistence

The selected preset id lives under the localStorage key **`plan-reader-model-preset`** (one of
`opus-4-8` \| `fable-5` \| `sonnet-4-6`), sitting alongside the existing `plan-reader-theme` /
`plan-reader-text-size` keys. The default (absent/invalid value) is **`opus-4-8`**. It is **written
on click** by the picker and **read at agent-session start** to choose the SDK `model` + `effort`
for that run — so changing the preset affects the **next** plan started, not any in-flight session.

## Amendment 2026-06-12 — `.plan.placeholder` live-run sidebar row (additive)

A running orchestration has **no sidebar row** until the agent writes its plan file (and
`list_plans` can lag the write), so the sidebar selection would otherwise land on nothing/the
wrong row while the reading pane shows the conversation. The sidebar now renders a **live-run
placeholder row** in that window. None of the prior `.plan` row shapes, `PlanRecord`, or any
Tauri command/event change.

| selector | element | role |
|----------|---------|------|
| `.plan.placeholder` | a `.plan`-shaped `<div>` in `#plan-list` | stands in for a live run with no real row yet. Carries `data-tree-id` (the run's tree id) and **NO `data-path`** (there is no file to open — `openPlan`'s `[data-path]` selection loop structurally cannot touch it). Holds the usual `.plan-row > .plan-title` (label "New plan — drafting…") plus a leading `.placeholder-dot` (small pulsing dot; `.conv-working-dot` token values, tokens-only styling). |

Behavior:

- **Presence**: rendered iff the sidebar render ctx carries a placeholder **AND no rendered
  record has `tree_id === placeholder.treeId`**. Once the run's real (frontmatter-tagged) row
  appears, the placeholder is omitted — the real row takes over.
- **Position**: always the **FIRST** `#plan-list` entry when present.
- **Filtering**: always visible regardless of the filter query (it represents live work, not a
  record the filter can match) — shown even above the `.filter-empty` affordance.
- **Selection**: carries `.active` when selected — selected on run start, on a placeholder click,
  and (derived) whenever a held gate's plan is the open plan but its row is missing (the
  placeholder stands in as the active row). Opening any real plan deselects it.
- **Click**: switches the reading pane to the Conversation tab (and selects the placeholder).
- **Lifecycle**: minted on the first orchestrator snapshot of each run (keyed by `treeId`);
  cleared on the run's terminal `onDone`/`onFatal`, and on `agent-exit` **only when no active
  orchestration claims its `treeId`** (a late exit from a previous session can never clear a
  freshly started next run's placeholder).
- `SidebarCtx` gains **optional** fields `placeholder: { treeId; label; selected } | null` and
  `onPlaceholderOpen: () => void` (additive; absent ⇒ no placeholder).

## Amendment 2026-06-12 — Visual-prototype review gate (PROTOTYPE bar mode, `ensure_prototype_dir` / `open_prototype`, the `"prototype"` permission-mode wire value)

The intent-clarification phase can now produce a throwaway **visual prototype** (HTML / mermaid /
ascii / table) under `<cwd>/.plan-tree/prototype/`; the orchestrator surfaces it through a
**prototype-review gate** (`onPrototypeReview(gate: PrototypeGate)`, snapshot field
`pendingPrototype`) resolved by `approvePrototype()` / `refinePrototype(feedback)`. Everything here
is **additive** — no prior selector, command, or event changes shape.

### New DOM selectors (inside `#review-bar` → `.review-bar-actions`; both ship `.hidden`)

| selector | element | role |
|----------|---------|------|
| `#prototype-feedback` | `<textarea class="proto-feedback">` | PROTOTYPE-mode refine feedback. The relabeled `#review-submit` ("Request changes") is **disabled while this is empty** (whitespace-trimmed); on a successful `refinePrototype(text)` dispatch the textarea clears. Typing re-derives the bar (`input` → `refreshReviewBar`). |
| `#prototype-open` | `<button class="rb-btn">` ("Open in browser") | shown **only** in PROTOTYPE mode **and** only for `gate.kind === "html"`. Click → `open_prototype({ cwd: gate.cwd, path })` where `path` is the gate's `index.html` path when present, else `paths[0]` (pure `prototypeOpenTarget`, `src/prototype.ts`; paths may be cwd-relative — the Rust command resolves + containment-guards them). |

`applyPrototypeBar` (called from `refreshReviewBar`) is the sole writer of both elements' `.hidden`.

### `#review-bar` — the PROTOTYPE mode (additive third mode + precedence)

Mode **precedence** in `refreshReviewBar` (first match wins):

1. **pendingApproval gate** — a held `ApprovalGate2` (decomposition or leaf): the existing
   viewing/summary derivation, unchanged.
2. **prototype gate** — `orchSnapshot.pendingPrototype` non-null (and orchestration active): the
   PROTOTYPE mode below. Derived **from the snapshot, never module state** (pure
   `prototypeGateActive`, `src/prototype.ts`), so the mode **self-clears**: the reducer nulls
   `pendingPrototype` on `PROTOTYPE_APPROVED`/`PROTOTYPE_REFINED` and the next `onSnapshot` →
   `refreshReviewBar()` reverts the bar with no extra bookkeeping.
3. **pendingReviews** — the existing tracked-review derivation, unchanged.

PROTOTYPE mode affordances:

- `#review-bar-label` reads **`Visual prototype — round N of 3`** (`prototypeBarLabel`; rounds are
  1-based, driver-minted, display-clamped to 3).
- `#review-approve` is **always enabled**, relabeled **`Approve visual`** (**`Proceed as-is`** from
  round ≥ 3 — the loop-escape affordance; `prototypeApproveLabel`) → `getOrchestrator().approvePrototype()`
  + flip to the Conversation tab. Its default label ("Approve & Build") is captured at wire-time and
  restored on mode exit (same pattern as the Submit label).
- `#review-submit` is relabeled **`Request changes`**, enabled iff `#prototype-feedback` is
  non-empty → `getOrchestrator().refinePrototype(text)`, then the textarea clears.
- `#review-clear` / `#review-dismiss` / `#review-resume` hide (prototype feedback is the textarea,
  not inline comments).

#### Amendment — combined apply-and-approve (adaptive `#review-approve`)

`refinePrototype` gains an optional second argument: `refinePrototype(feedback, opts?: { autoApprove?: boolean })`.
The driver-owned `autoApproveNext` latch (set LAST in `refinePrototype`, only after the
`PROTOTYPE_REFINED` dispatch resolves, so a dispatch throw can't strand it; reset everywhere
`prototypeRound` resets — `start()`, `resume()`, and `markTerminal()`) makes the **next** prototype
turn auto-resolve forward WITHOUT surfacing another review round: when the revised block arrives, the
intent-ingestion branch dispatches **`PROTOTYPE_READY`** (clarifying-intent → prototype-review) THEN
the shared `resolveApprove(gate)` arc (**`PROTOTYPE_APPROVED`** → recon, composing INTENT.md from
**this** turn's `parsed.intentText`). Skipping the `PROTOTYPE_READY` step would throw
`PROTOTYPE_APPROVED illegal` (the reducer requires prototype-review). If the revised turn emits **no**
block, the branch clears the latch and falls through to the normal `INTENT_CLARIFIED` → recon path
(never `PROTOTYPE_APPROVED`). The latch is **driver-owned** — never model/agent-controlled.

The intermediate `PROTOTYPE_READY` on the auto-approve arc is **silent**: it dispatches with
`{ suppressNotifyPrototypeReview: true }`, so the reducer's `notifyPrototypeReview` view effect is
dropped for that one transition (the state mutation + `persist` still run). The observer
`onPrototypeReview` does **not** fire, so there is **no** `switchToPlanTab` / preview render /
review-bar flip — the combined action never surfaces the round it is designed to skip. The
**ordinary** Request-changes round and the **empty-textarea** approve are unchanged: their
`PROTOTYPE_READY` dispatches opt-free and surface the review normally.

`#review-approve`'s label is **adaptive** (`applyPrototypeBar` reads the current
`#prototype-feedback` value; recomputed live via the textarea's `input` → `refreshReviewBar`):
- **empty** textarea → the existing `Approve visual` / `Proceed as-is` (`prototypeApproveLabel`)
  → `approvePrototype()` (no echo, straight to recon).
- **non-empty** textarea → **`Apply changes & approve`** → `refinePrototype(text, { autoApprove: true })`,
  then (success-only, mirroring Request-changes ordering) `echoUserMessage(text)` + clear the
  textarea. Either branch flips to the Conversation tab on success.

The gate also renders a **detached preview** into `#reading-pane` (observer `onPrototypeReview`):
`composePreviewMarkdown(gate)` (pure, `src/prototype.ts`) through the normal `renderInto`/`settle`
pipeline with `#doc-filename` = **`prototype-preview`** — `openPath` is **never** touched, so the
next `openPlan` naturally replaces the preview. Markdown shape: mermaid kind → a ```` ```mermaid ````
fence of `inlinePreview`; ascii/table → a plain fence; html → a short notice ("HTML prototype written
to `.plan-tree/prototype/` — use **Open in browser** below") listing `paths`; each `variants[]` entry
under a `### <label>` heading with its fenced `inlinePreview`. `suppressConversationFlip` is
**unchanged** (still keyed strictly on `pendingApproval` — the prototype gate resolves by turn
completion, so no stream frames race the Plan tab).

### New Tauri commands (Rust: `src-tauri/src/plan_tree.rs`)

| command | args | returns | behavior |
|---------|------|---------|----------|
| `ensure_prototype_dir` | `{ cwd: String }` | `String` (the absolute prototype dir path) | Creates `<cwd>/.plan-tree/prototype/` (idempotent — `create_dir_all`). Guards mirror `reset_plan_tree_dir`: `cwd` must be absolute, contain no `..` components, and be an existing directory; after creation the **canonical** dir must equal `<canonical cwd>/.plan-tree/prototype` exactly (a symlinked `.plan-tree` is rejected). Called by the orchestrator driver (`OrchestratorDeps.ensurePrototypeDir`) **before** the visual-mode intent prompt, so the clarifier never needs `mkdir` (the sidecar's `"prototype"` policy can only write **under** the dir, not create it). |
| `open_prototype` | `{ cwd: String, path: String }` | `()` | Opens a prototype artifact in the OS default handler (the browser for `index.html`) via **tauri-plugin-opener**'s Rust API (`app.opener().open_path(...)` — Rust-side, so no additional JS capability beyond the existing `opener:default`). `cwd` passes the same guard set; `path` may be absolute or cwd-relative and must canonicalize to a **regular file strictly under** `<cwd>/.plan-tree/prototype/` (traversal, out-of-cwd paths, `.plan-tree`-root files, directories, and outward symlinks are all rejected — validation core `validated_prototype_file`, opener-free and unit-tested). |

### The `"prototype"` permission-mode wire value

`start_agent_session({ permissionMode })` and `set_agent_permission_mode({ mode })` now **pass
through** a third host-level value **`"prototype"`** alongside `"plan"`/`"acceptEdits"` (Rust
forwards the string opaquely). It is **host-only**: the sidecar records it as the active
`HostPolicy` (`sidecar/permissions.ts`) — mutating tools are allowed **only** for paths strictly
under `<cwd>/.plan-tree/prototype/`, everything else behaves like `"plan"` — and maps it to SDK
**`"default"`** before `q.setPermissionMode`/session options (the SDK's own `plan` mode would
hard-block `Write` regardless of `canUseTool`; the SDK never sees the literal `"prototype"`). The
orchestrator's `WritePolicy` derives `"prototype"` while the root is in its intent window
(`clarifying-intent` / `prototype-review`).

> **Note 2026-06-12 — `open_prototype` runs agent-authored JS at file:// origin (ACCEPTED risk).**
> `open_prototype` opens an agent-authored HTML file in the user's default browser at `file://`
> origin, where its JS runs with file-origin reach. This is an **accepted** risk, for parity with
> the external `/multiplan` skill — the artifact is authored by the same agent the user already
> trusts to plan the codebase. It is bounded by the containment guard (only regular files strictly
> under `<cwd>/.plan-tree/prototype/` can be opened) and by requiring an explicit user click
> (`#prototype-open`).

### Prototype-policy Bash is FAIL-CLOSED (INV-1 — additive, 2026-06-17)

The `"prototype"` HostPolicy's Bash containment is now a **fail-closed allowlist**, not a
blocklist. One shared decision — `bashDecisionFor(policy, command)` in `sidecar/permissions.ts`
— backs BOTH enforcement tiers (the `PreToolUse` hook `prototypeHookDecision` AND the in-process
`canUseTool` gate), so they cannot drift:

- **`prototype`** → a Bash call runs ONLY when **every** segment (split on the command separators
  `;` `&&` `||` `|` **and** bare `&` (background) **and** newlines `\n`/`\r`) is a **provably
  read-only** command; anything unrecognized is **denied**. The bare-`&` split is precise — it does
  NOT split the `&` inside an fd-redirect (`2>&1`, `&>f`), so fd-dups stay classifiable while a true
  background chain (`ls & rm build`, trailing `ls &`) is split out and denied (the chained write
  segment is non-read-only; a trailing `&` leaves an empty segment → fail closed). Command- and
  **process-substitution** (`$(…)` / backticks / `<(…)` / `>(…)`) and an env-assignment prefix
  (`FOO=bar …`) are never provably read-only → denied (the substitution's inner command is
  unconstrained; `cat <(touch x)` denies). The read-only verb set is `ls cat head tail grep rg pwd wc which file stat echo`
  (`echo` only with **no** output redirect). `git` is read-only only for `status|log|diff|show`
  and `branch --list`, and only with **no** global flag (`-C` / `-c` / `--git-dir`). `find` is
  read-only only with **no** `-exec|-execdir|-delete|-ok|-fprint` action token. Any
  **file-writing** output redirect denies the segment: `>`/`>>`/`>|`, whitespace-insensitive,
  incl. the no-space form `x>f` AND the numbered/merged-fd-to-FILE forms (`1>f`, `2>f`, `2>>f`,
  `&>f`, `&>>f`, and `>&word` where `word` is a file). The ONLY redirects treated as non-writes
  are fd-**DUP**/close — `2>&1`, `>&2`, `2>&-` (a `>` whose target is `&<digit>` or `&-`, an
  existing fd, not a file) — so those stay allowed under the read-only verb. This closes the
  S1+S2 escapes plus the DA-found fd-to-file write (`echo x 1>/tmp/evil`, `cat foo 1>out`,
  `echo x &>file`): `echo x>/f`, `cat a>>b`, `>|f`, `python3 -c …`, `node -e …`, `tar -xf …`,
  `install`, `git stash`, `find … -delete`, `find … -exec …`, env-prefixed shells. Denials reuse
  the existing `PLAN_POLICY_WRITE_DENY` message constant. The `intent-clarifier` (the only
  prototype-window Bash agent) is unaffected: it writes artifacts through the **contained**
  `Write` tool, and the prototype dir is pre-created host-side by
  `OrchestratorDeps.ensurePrototypeDir` (`ensure_prototype_dir`) before the visual-mode prompt,
  so it never needs `mkdir`.
- **`plan`** → still a **blocklist** (so the documented test-run capability `cargo test` /
  `npm test` / `npx vitest` is **preserved** — incl. `… 2>&1`, an fd-dup, not a write), but the
  `BASH_WRITE_DENY_PATTERNS` set is extended to close the same named holes. It SHARES the one
  `OUTPUT_REDIRECT` pattern with the prototype tier (whitespace-insensitive, `>|`, no-space, and
  the fd-to-FILE forms above, while exempting fd-dup `2>&1`/`>&2`/`2>&-`); plus inline-code
  interpreters (`python -c`, `node -e`, `perl -e`, `ruby -e`, `sh -c`, `bash -c`, `osascript -e`),
  here-string/heredoc feeds (`<<<`, `<< EOF`), and file-write tools (`tee dd install cp mv tar -x
  unzip patch truncate ln xargs`, `git stash/commit/add/rm/mv`, `find … -delete/-exec`) are denied.
- **`acceptEdits`** → unrestricted (unchanged).

This is honest **fail-closed gate containment**, not complete shell classification — the durable
boundary remains the named OS `sandbox-exec` follow-on.

---

## Resume an in-progress plan (additive, non-breaking)

The **resume-from-disk** feature for the single session: a `.plan-tree/state.json` left in a
non-terminal phase can be re-entered without re-running the whole plan. None of the §1/§2/§3 or
prior additive surfaces are altered. The `start_agent_session` `resumeSessionId` arg is documented
inline at its command row (see the **Amendment 2026-06-13** above §"New Tauri events"); this section
adds the new `agent-stream` kind, the DOM affordances, and a new frontend consumer of an existing
Rust command.

### New `agent-stream` kind: `resume_fallback`

| kind | fields (beyond `seq`/`kind`) | source |
|------|------------------------------|--------|
| `resume_fallback` | `reason` (a SHORT string) | the sidecar emits this **once** when a requested SDK `resume` transcript is **missing/expired** and it therefore falls back to a **fresh** session. Pre-flighted via `getSessionInfo(id)` before the session opens (`sidecar/session-resume.ts` `decideResume`; the `reason` literal is `RESUME_FALLBACK_REASON`). Non-fatal — the run proceeds fresh; it is purely an advisory notice. NOT emitted on an ordinary fresh start (no resume requested) or on a successful resume. |

The frontend renders the `reason` into the transient `#toast` (below); it does **not** abort the run.

### New DOM selectors

**Reading-pane resume affordance** (the `#resume-banner`, shown when the OPEN plan belongs to a
non-terminal `.plan-tree/` tree; `main.ts`'s `detectResumable` reads `state.json` and renders the
banner):

| selector | element | role |
|----------|---------|------|
| `#resume-banner` | `.resume-banner` region (`role="region"`, `.hidden` by default) | the reading-pane resume affordance; shown for an open plan whose tree is in a resumable (non-terminal) phase |
| `#resume-banner-msg` | `.resume-banner-msg` `<span>` inside the banner | the banner's status/blocked message text |
| `#resume-plan-btn` | `.rb-btn.rb-approve` `<button>` inside the banner (`.hidden` until resumable) | the resumable-state control — labeled **`Resume — <phaseLabel>`**; click drives `getOrchestrator().resume()` (mirroring the composer's started flow) |

**Transient toast** (sibling under `.window`, `.hidden` by default):

| selector | element | role |
|----------|---------|------|
| `#toast` | `.toast` notice (`role="status"`, `aria-live="polite"`, `.hidden` by default) | lightweight non-blocking bottom-docked notice, auto-dismissed after `TOAST_MS`; `showToast` is its sole writer. Currently used only to surface the `resume_fallback` frame's message. |

### `read_plan_tree_file` — new frontend consumer

The Rust command **`read_plan_tree_file(cwd, name)`** (documented under §"New Tauri commands …
`plan_tree.rs`" — JS args `{ cwd, name }`, absent file ⇒ `Ok(None)`) gains a **new frontend
consumer**: `main.ts`'s resume detection now `invoke`s it to read `state.json` (the ledger) and the
held gate's plan artifact (`NN-plan.md`) when deciding whether — and at what phase — to offer the
`#resume-banner`. The command, its arg names, and its allow-list are **unchanged**; only the set of
callers grew (the orchestrator's `OrchestratorDeps.readPlanTreeFile` was already a consumer).

### Amendment — PHASE-5 forced-acceptance-window resume (additive)

Previously a baseline-bearing root **parked in its forced-acceptance window** (root `running-children`,
all children summarized, `baseline_` frozen, `acceptance_` absent) when the session ended was a
permanent dead-end on resume: `resumeScopeForRoot` returned **blocked** for it and there was no arc to
re-arm the transient gate. This amendment wires that resume arc. **No prior resume surface changes
shape**; the additions are:

- **`ResumePlan` gains a third variant `{ kind: "acceptance" }`** (alongside `gate` / `resend`). It
  carries no path/artifact fields — the gate is re-derived from the tree shape + `baseline_`, never
  from disk.
- **`resumeScopeForRoot(root, ledger?)`** takes an **optional** second arg
  `Pick<RecursiveLedger, "baseline_" | "acceptance_">`. When the active node is the **root acceptance
  window** (`activePath === []` AND `inAcceptanceWindow(root)`) and the ledger facts confirm a
  legitimately-parked root (`baseline_` frozen AND `acceptance_` absent), it returns
  `{ resumable: true, plan: { kind: "acceptance" }, phaseLabel: "Awaiting baseline acceptance" }`.
  Omitted ledger / absent `baseline_` / a verdict already recorded ⇒ **blocked**
  (`"awaiting baseline acceptance — start a new plan"`). All other scope verdicts are **unchanged**;
  `main.ts`'s `detectResumable` and the driver's `resume()` pass the ledger so the window classifies as
  resumable (and `detectResumable` skips plan-artifact verification for this kind — there is no plan to
  re-present).
- **Driver `resume()` acceptance arc:** when the resolved scope is `{ kind: "acceptance" }`, the driver
  **re-mints `pendingAcceptance`** exactly as the live `notifyAcceptanceReview` path does — gate
  `{ cwd, openTarget: "index.html", runCommand: null, round: 1 }`, set `active`/`activeOrchestrator`,
  fire `onAcceptanceReview`, best-effort `openBaseline`, emit a snapshot — **and sends NO model turn**
  (the tree waits on a human verdict, not an agent). `approveAcceptance()`/`divergeAcceptance(reason)`
  then drive the deferred finalize to `done` exactly as in the live path.

### Amendment — PHASE-2 resume-banner action labels for the new resumable kinds (additive)

`detectResumable` previously **downgraded** the PHASE-2 `ResumePlan` kinds (`restart` / `prototype-gate`
/ `rewind`) to a **blocked** verdict (`"… (resume coming soon)"`). It now surfaces them as **resumable
forward actions** on `#resume-plan-btn`. **No prior label changes**; the `.hidden`/`.blocked` toggles,
the `pendingResume` stash, and the click → `getOrchestrator().resume({cwd, ledger})` wiring are all
**unchanged** (the orchestrator decides the concrete action from the ledger — the banner only triggers
resume). The additions:

- **`#resume-plan-btn` label is now derived per `ResumePlan.kind`** (was always `Resume — <phaseLabel>`):

  | `plan.kind` | button label |
  |-------------|--------------|
  | `restart` (`from:"clarify"`) | **`Restart from your original request`** |
  | `prototype-gate` | **`Resume — Prototype review`** |
  | `rewind` (`toGate:"decomposition"`) | **`Rewind to decomposition plan`** |
  | `rewind` (`toGate:"leaf"` / `"leaf-approval"`) | **`Rewind to approved plan`** |
  | `gate` / `resend` / `acceptance` (unchanged) | **`Resume — <phaseLabel>`** |

- **Artifact verification in `detectResumable`:** `restart`, `prototype-gate`, and a **null-`planPath`**
  `rewind` (torn leaf gate / degenerate no-active-node) need **no** artifact read — resumable as-is. A
  `rewind` with a **non-null `planPath`** (a decomposition plan filename under `.plan-tree/`, via
  `planName2`) is verified through `read_plan_tree_file(cwd, planPath)` exactly like a decomposition
  gate; a **missing** artifact degrades to **blocked** (`"plan artifact missing"`).
- All PHASE-2 labels are **non-hazardous one-click** actions. The hazardous confirmation-gated variant
  (`leaf`/`executing`) is **PHASE 3** and still maps to a **blocked** verdict today; the button-label
  switch is structured to admit a hazardous secondary later without reshaping the existing labels.

### Amendment — PHASE-3c hazardous resume (`leaf`/`executing`) is now a confirm-gated action (additive)

`leaf`/`executing` is **no longer blocked**. P3a made `resumeScopeForRoot` return a **resumable**
`rewind` verdict for it whose `plan` carries `requiresConfirm: true` and `hazard: "edits may be
partially applied"` (the in-flight executing turn may have already partially applied edits — invariant
I3). The banner offers it, but **gates `resume()` behind an explicit confirmation step**. Everything in
the PHASE-2 amendment is **unchanged** for the non-hazardous kinds; the additions:

- **New DOM inside `#resume-banner`** — the inline confirm row, written solely by `main.ts`
  (`renderResumeBanner` / `showResumeConfirmRow` / `hideResumeConfirmRow`):

  | selector | element | role |
  |----------|---------|------|
  | `#resume-confirm` | `.resume-confirm` `<span>` (`role="group"`, `.hidden` by default) | the confirm step; revealed only for a hazardous (`requiresConfirm`) verdict after the primary click |
  | `#resume-hazard` | `.resume-hazard` `<span>` inside `#resume-confirm` | the hazard text (`Are you sure? <hazard>`) |
  | `#resume-confirm-btn` | `.rb-btn.rb-approve` `<button>` inside `#resume-confirm` | **Confirm** — the ONLY control that fires `getOrchestrator().resume()` for a hazardous verdict |
  | `#resume-cancel-btn` | `.rb-btn` `<button>` inside `#resume-confirm` | **Cancel** — collapses back to the one-click `#resume-plan-btn`, no resume |

- **`#resume-plan-btn` label for the hazardous `rewind` (`requiresConfirm`)** is **`Continue
  implementation`** (a forward "continue", not a "Rewind to …"); the risk is surfaced in `#resume-hazard`,
  not the button label. The PHASE-2 `rewind` labels (`Rewind to decomposition plan` / `Rewind to approved
  plan`) still apply to **non-`requiresConfirm`** rewinds.
- **Confirm gating (`resumeFromBanner`):** for a `requiresConfirm` verdict the first `#resume-plan-btn`
  click reveals `#resume-confirm` and **does NOT** call `resume()`; `resume()` fires only from
  `#resume-confirm-btn`. `#resume-cancel-btn` aborts (no resume, banner stays). **Non-hazardous verdicts
  never reveal `#resume-confirm`** and fire `resume()` on the first click exactly as before.
- The `pendingResume` stash now carries `{ cwd, ledger, requiresConfirm, hazard }` (the latter two ride
  through from `verdict.plan`; only `rewind` plans set them — every other kind is one-click).

## tree-cwd index (cwd resolution for app-generated plan-tree plans — additive, non-breaking)

App-generated plan-tree plans (filenames `agent-plan-<tree_id>-<nn>-…md`, written by
`write_agent_plan`, frontmatter-tagged with `tree_id`) never emit a plan-write event into a
`~/.claude/projects/` session transcript, so the transcript-scan resolver (§"Resolver") returns
`None` ("unknown") for them. A persisted `tree_id → cwd` index resolves these plans directly,
consulted **before** the scan.

### New app-data file

| file | shape | notes |
|------|-------|-------|
| `tree-cwd-index.json` | `{ "<tree_id>": "<absolute cwd>" }` | atomic temp-write+rename; **best-effort** — a missing/corrupt file loads as empty without rewriting it. Exact shape-twin of `cwd-cache.json`. Lives in the same Tauri app-data dir, loaded once at startup into `AppState.tree_cwd_index`. |

### Auto-capture on `write_plan_tree_file`

`plan_tree::write_plan_tree_file(cwd, name, contents)` (JS args unchanged — `{ cwd, name, contents }`;
a `State<Mutex<AppState>>` is injected by Tauri) now, **after** a successful `state.json` write,
best-effort parses the JSON for a top-level `tree_id` and upserts `index[tree_id] = cwd`, then
persists the index. A `state.json` without a parseable `tree_id` (or unparseable JSON) leaves the
index **unchanged**, and a capture failure **never** fails the write (the file is already on disk).
This keeps the index fresh for every tree the app touches going forward, with no frontend wiring.

### Index fast-path in `list_plans` / `resolve_cwds`

When resolving a plan's cwd, if the plan's frontmatter `tree_id` is present **AND** the index has an
entry for it **AND** that path still exists as a directory, the indexed cwd is used **first**
(authoritative for these plans). Otherwise resolution falls back to the **unchanged**
transcript-scan, so no currently-resolving plan regresses, and a stale entry (since-deleted/moved
dir) silently falls through rather than resolving to a dead path. An index hit also populates the
existing `cwd-cache.json` (the same field successful scan resolutions land in), so the cwd survives
a relaunch and the rest of the pipeline is unaffected. `resolve_cwds` reads each requested stem's
frontmatter from `~/.claude/plans/<stem>.md` to recover its `tree_id` before deciding the fast-path;
only stems the index does not resolve go to the (off-thread) scan.

### Startup backfill

On app startup a **background thread** (never blocks startup) seeds the index once from existing
trees: it walks the repo root for `<dir>/.plan-tree/state.json` ledgers and maps each `tree_id → <dir>`
(the cwd — the parent of `.plan-tree`). Root default `${HOME}/Documents/repos`, overridable via the
`PLAN_READER_BACKFILL_ROOT` env var. The hand-rolled `std::fs` walk caps depth (~8) and **prunes**
`.git`, `node_modules`, `target`, `dist`, and any `.archive` subtree (so archived/superseded trees
are never indexed — only the live tree at the repo root wins). The merge is idempotent and additive
(existing entries overwritten with the freshly scanned live dir; untouched tree_ids preserved),
persisted once at the end. Best-effort: unreadable dirs / unreadable-or-unparseable `state.json` /
ledgers without a `tree_id` are skipped silently.

This does **not** change the plan-file format (frontmatter keys, slug shape, or the
`write_agent_plan` / `write_plan_tree_file` wire signatures as seen from JS are all unchanged).

## User-attributed message bubble (additive)

The conversation stream now renders a **user-attributed bubble** so a user's submitted feedback is
echoed verbatim into the conversation (previously the user's words were wrapped into a system prompt
and never shown). This is additive — no prior render selector or model method changes shape.

- **Model**: a new `UserMessageNode` (`{ type: "user"; seq: number; text: string }`) in the
  `RenderNode` union (`src/conversation/stream.ts`), produced by a new
  `ConversationModel.appendUserMessage(text)`. The model stamps the bubble at `lastWireSeq + 0.5` — a
  fractional tiebreaker over the highest WIRE seq it has observed (tracked in `appendStream` /
  `appendPermissionRequest`; NOT the controller's 1e9-based `synthSeq`). This places the bubble AFTER
  every frame seen so far but strictly BEFORE the agent's reply (the next wire frame at
  `lastWireSeq + 1`) — so on the free-text path the user message renders ABOVE the response it
  prompted, not below it. The placement is frozen into the event at append time, so it is stable
  across re-derives. On derive it yields a standalone top-level node; it never touches session state.
- **Render selector**: `.conv-text.conv-text-user` — emitted into `#conversation-stream`. It reuses
  the SAME sanitized-markdown path as `.conv-text` (`renderTextBubble(text, "user")`; user text is no
  more trusted than assistant text and passes through the same DOMPurify HTML profile), adding only
  `.conv-text-user` for distinct alignment/background (`var(--accent-soft)` fill, right-aligned).
- **Facade**: `ConversationHandle.echoUserMessage(text)` (`src/conversation/index.ts`) routes through
  `appendUserMessage`. **Ordering invariant**: every echo site calls it ONLY AFTER its dispatch
  resolves successfully — a failed send adds NO bubble and does not clear the input. Three sites:
  the free-text composer (`send_agent_message`, echoes internally + clears the field on success), the
  prototype "Request changes" gate (`refinePrototype` → echo trimmed feedback, then clear), and the
  plan-review comment submit (`requestChanges` → echo a STRUCTURED `Re: "<quote>" — <comment>`
  per-comment view, NOT the wrapped `buildFeedbackPrompt` system text).

## Amendment 2026-06-14 — App-owned planning sub-agents (passed via SDK `agents`, additive, non-breaking)

The four planning sub-agents the multiplan flow invokes BY NAME are now **owned by the app** and
passed programmatically to the SDK, instead of being discovered ambiently from the host's global
`~/.claude/agents/`. This is additive: it changes WHERE the four definitions come from, not the wire
vocabulary, the orchestrator prompts, or any DOM selector.

- **Source of definitions**: `sidecar/agents/planningAgents.ts` exports
  `planningAgents: Record<string, AgentDefinition>` (the SDK's `AgentDefinition` type). The map keys
  are the EXACT names the orchestrator prompts (`src/conversation/orchestrator.ts`) invoke via the
  Agent tool — renaming a key silently breaks its planning phase:
  - `intent-clarifier`
  - `plan-sizer`
  - `scope-recon`
  - `devils-advocate-reviewer`
- **Wiring**: `buildOptions` (`sidecar/index.ts`) adds `agents: planningAgents` to the options it
  hands `query()`. `settingSources` stays `["user","project","local"]` UNCHANGED — explicitly-passed
  `agents` definitions take precedence over settings-discovered ones of the same name (per the SDK
  type contract), so these four keys SHADOW any ambient copies while OTHER ambient agents on the host
  remain discoverable. Net effect: the four planning agents now resolve regardless of the target cwd
  and regardless of whether the host has the global definitions installed.
- **Faithful prompt ports (prompts only)**: each `prompt` is a byte-faithful copy of the
  corresponding global `.md` system-prompt body (not paraphrased). `plan-sizer` additionally
  **inlines the rubric** that the global `plan-sizer.md` `Read`s at runtime
  (`plan-sizer-prompts/rubric.md`) — an `AgentDefinition.prompt` is a single string and cannot
  reference external files, so the load-bearing rubric (criteria, JSON schema, recursion cap,
  few-shot examples) lives directly in the prompt. The orchestrator's `sizerPrompt()`
  decomposition-bias block is a SEPARATE user-turn input and is unchanged. **The faithfulness
  guarantee covers the PROMPT bodies only — other fields are not all verbatim**: in particular the
  `devils-advocate-reviewer`'s `description` is condensed and its `tools` are a deliberately reduced
  read/research subset (`Bash`/`Glob`/`Grep`/`Read`/`WebFetch`/`WebSearch`/`BashOutput`, no
  `Write`/`Edit`) sufficient for the silent plan-draft review pass.
- **Per-agent model choices** (only `model` is per-agent; reasoning *effort* IS exposed per-agent by
  `AgentDefinition` (`effort`, sdk.d.ts:86-88) but is deliberately set session-globally instead —
  baked into the SDK `query()` at construction in `resolveModelEffort` — so we intentionally omit the
  per-agent `effort` field here):
  - `intent-clarifier` → `opus` (matches its frontmatter; steel-manning + visual-prototype work).
  - `plan-sizer` → `opus` (matches its frontmatter; high-stakes decomposition judgment).
  - `scope-recon` → `sonnet` (no model in its frontmatter → inherited the session model, default
    `opus`; deliberately pinned DOWN to `sonnet` as a labeled cost optimization — cheaper than the
    inherited default, and capable enough for shallow recon. NOT behavior-preserving).
  - `devils-advocate-reviewer` → `opus` (matches its `opus` frontmatter; KEPT on the capable model —
    the adversarial-review gate must not be downgraded).
- **Tests**: `sidecar/agents/planningAgents.test.ts` pins the four role keys, non-empty prompts +
  descriptions, the inlined plan-sizer rubric markers, and each per-agent model alias (reverting
  `scope-recon` off `sonnet` or `devils-advocate-reviewer` off `opus` fails its assertion).
  `buildOptions` itself is not
  unit-tested in isolation (it has embedded-CLI-extraction side effects); per the established pattern
  (cf. `session-resume.test.ts` testing `resumeOption`), the test covers the `planningAgents` export
  that `buildOptions` spreads as `agents: planningAgents`.

## Amendment 2026-06-14 — First-class "baseline" (frozen working reference, additive, non-breaking)

At the prototype-approval gate the user may now classify the prototype as a **working reference** (a
FLOOR on the outcome dimensions captured in `INTENT.md` — the minimum bar the build must clear, NOT a
behavioral match-target) instead of the default **"just a sketch"**. On a working-reference approval
the driver freezes `<cwd>/.plan-tree/prototype/` into a contained `<cwd>/.plan-tree/baseline/` and
records it on the persisted ledger. **Default = sketch = nothing changes** (everything below is
opt-in; the sketch path is byte-identical to the prior behavior).

### New `.plan-tree/` directory

- `<cwd>/.plan-tree/baseline/` — a frozen snapshot copy of `.plan-tree/prototype/` at the moment of a
  working-reference approval. App-owned, written ONLY by `freeze_baseline`. The baseline survives the
  prototype dir being reset/overwritten by later runs, so it remains the durable floor reference.

### New Tauri commands (Rust: `src-tauri/src/plan_tree.rs`)

All three mirror the **directory-canonicalization containment** of the prototype commands (the
canonical created/target/opened dir must equal `<canonical cwd>/.plan-tree/baseline` exactly), NOT
the file-name allow-list of `guarded_plan_tree_path`.

| Command | Args | Returns | Behavior |
|---|---|---|---|
| `ensure_baseline_dir` | `{ cwd: String }` | `String` (absolute baseline dir path) | Creates `<cwd>/.plan-tree/baseline/` (idempotent — `create_dir_all`). Guards mirror `ensure_prototype_dir`: `cwd` absolute, no `..`, existing dir; the **canonical** dir must equal `<canonical cwd>/.plan-tree/baseline` exactly (a symlinked `.plan-tree`/`baseline` is rejected). |
| `freeze_baseline` | `{ cwd: String }` | `String` (absolute baseline dir path) | Ensures the baseline dir, then **recursively copies** every file/subdir of `<cwd>/.plan-tree/prototype/` into it with containment guards on **both** source and destination (each entry must canonicalize strictly under its root). The prototype dir MUST exist and canonicalize inside the cwd (a missing prototype is an error — nothing to freeze). **Symlinks are never followed and are rejected** (a planted link cannot redirect a read/write outside containment). Validation/copy core `copy_tree_contained`, unit-tested. |
| `open_baseline` | `{ cwd: String, path: String }` | `()` | Opens a baseline artifact in the OS default handler via **tauri-plugin-opener**'s Rust API. Scoped to `baseline/` exactly as `open_prototype` is scoped to `prototype/` (Phase 5's gate opens the frozen baseline; `open_prototype` is hard-scoped to `prototype/` and would 403 on a baseline path). `path` may be absolute or cwd-relative and must canonicalize to a **regular file strictly under** `<cwd>/.plan-tree/baseline/` (traversal, out-of-cwd paths, `.plan-tree`-root files, directories, and outward symlinks all rejected — validation core `validated_baseline_file`, opener-free and unit-tested). |

Registered in `lib.rs`'s `invoke_handler` alongside the prototype commands.

### Ledger field — `RecursiveLedger.baseline_` (schema stays 2)

- `baseline_?: { frozen: true; frozen_ms: number }` — **OPTIONAL + additive** (an old/sketch
  `state.json` without it deserializes fine; absent ⇒ `undefined` ⇒ no working reference). PRESENT
  iff the user approved as a working reference. Carried through `toLedger2` / `clone2` /
  `initial2` (undefined) / `rehydrateState2` (deep-copied). On-disk artifacts live under
  `.plan-tree/baseline/`, so no path list is stored (it would only duplicate the dir's contents).

### `PROTOTYPE_APPROVED` event — new fields

- `PROTOTYPE_APPROVED` now carries `asWorkingReference: boolean` (default **false** at the call site)
  and `frozenMs: number` (rides the event — the pure reducer never reads a clock, mirroring START's
  `nowMs`). When `asWorkingReference` is true the reducer sets `baseline_ = { frozen: true, frozen_ms:
  frozenMs }`; false leaves the ledger untouched beyond the recon hop.

### Driver / gate UI

- `OrchestratorDeps` gains optional `ensureBaselineDir(cwd)` / `freezeBaseline(cwd)` (wired in
  `defaultDeps` to the new commands). `OrchestratorHandle.approvePrototype(opts?: {
  asWorkingReference?: boolean })` threads the classification into the shared `resolveApprove(gate,
  asWorkingReference)`, which — on `true` — calls `ensureBaselineDir` + `freezeBaseline` **before**
  dispatching `PROTOTYPE_APPROVED` (best-effort: a freeze failure is logged and does NOT block the
  recon hop). The combined apply-and-approve path (feedback typed) stays sketch (it is still
  refining).
- **New DOM selector** `#prototype-working-ref` (a checkbox inside `.review-bar-actions`, with label
  `#prototype-working-ref-label`): PROTOTYPE-mode only (shown by `applyPrototypeBar`, hidden by
  `refreshReviewBar`'s non-prototype path). UNCHECKED (default) = "just a sketch"; CHECKED = "working
  reference (hold the build to it)". Read only on the **plain**-approve branch (`#review-approve` with
  an empty `#prototype-feedback`) → `approvePrototype({ asWorkingReference })`; reset to unchecked
  after a plain approve.

### Prompt framing constant

- `BASELINE_FRAMING` (exported from `orchestrator.ts`) establishes the reusable wording: the baseline
  is a FLOOR on the outcome dimensions in `INTENT.md`, never a behavioral match-target; intentional
  improvements above the floor are good. (Full use lands in Phase 4 — here the constant only fixes the
  wording.)

## Amendment 2026-06-14 — Phase 5: the forced ACCEPTANCE gate (a baseline floor cannot be reported done without a recorded verdict)

A tree that froze a working-reference baseline (`RecursiveLedger.baseline_` present) **cannot finalize
without a recorded acceptance verdict.** This is a **TRANSIENT gate**, NOT a new stored `NodeState`
phase — the project's "done is derived, never stored" invariant is preserved. A tree with **no**
baseline is byte/effect-identical to before (immediate finalize + `notifyDone`).

### The resting shape (no new phase)

When the **ROOT's last child summarizes** AND `state.baseline_` is set AND no verdict is yet recorded
(`acceptance_` undefined), the reducer does **not** finalize. Instead the root **rests in its
`running-children` ACCEPTANCE WINDOW** — every child summarized, root phase `running-children` (NOT
`summarized`). This is the SAME structural shape as the existing non-root roll-up window, now also
legal at the root:
- `treeIsDone(root)` stays **false** (phase is `running-children`).
- `assertCoherent2` accepts it: the all-summarized `running-children` allowance (previously
  `path.length > 0` only) now covers the root too. A root `running-children` with a **non-summarized**
  (pending/active) child and none active is **still** a loud incoherence (the window requires EVERY
  child summarized).
- `activePathOf(root)` returns `[]` (the acceptance verdict is the root's "turn").
- `writePolicyFor2` derives `"plan"` (no leaf is executing).

### Transient gate — `PlanTreeState2.pendingAcceptance` (`AcceptanceGate | null`)

- `AcceptanceGate = { cwd: string; openTarget: string | null; runCommand: string | null; round: number }`
  (modeled on `PrototypeGate`). **NEVER serialized** (like `pendingPrototype`): `toLedger2` excludes
  it, `clone2`/`initial2`/`rehydrateState2` null it (a resumed run re-mints it from the tree shape +
  `baseline_`). Surfaced on `PlanTreeSnapshot2.pendingAcceptance`. The reducer mints it with the
  driver-unknown display fields blank (`cwd:""`, `openTarget:null`, `runCommand:null`, `round:1`); the
  **driver augments** `cwd`/`openTarget` in `runEffect` (see below).

### Events (root-only, no path)

- **`ACCEPTANCE_APPROVED { decidedMs }`** — the build clears the baseline floor. Performs the deferred
  finalize (root → `summarized` + `notifyDone`), clears `pendingAcceptance`, records
  `acceptance_ = { verdict: "approved", decided_ms }`.
- **`ACCEPTANCE_DIVERGED { reason, decidedMs }`** — the user accepts a result **below** the floor and
  records WHY. Same finalize; records `acceptance_ = { verdict: "diverged", reason, decided_ms }`.
- Both are legal **ONLY** while the gate is open (the root in its acceptance window AND
  `pendingAcceptance` held) — anywhere else throws `… illegal: no acceptance gate is open` /
  `… not in the acceptance window`. `decidedMs` rides the event (the pure reducer never reads a clock —
  START's `nowMs` precedent).

### Ledger field — `RecursiveLedger.acceptance_` (schema stays 2)

- `acceptance_?: { verdict: "approved"; decided_ms: number } | { verdict: "diverged"; reason: string;
  decided_ms: number }` — **OPTIONAL + additive** (a no-baseline tree never reaches the gate, so this
  is absent and `state.json` is byte-identical to today there). The divergence **`reason` is a
  serializable field round-tripped** through `toLedger2` ↔ `rehydrateState2`. Carried (deep-copied)
  through `toLedger2`/`clone2`; `initial2`/`rehydrateState2` set it from disk (absent ⇒ undefined).

### Effect — `notifyAcceptanceReview { gate }`

- Emitted by the completion ascent **instead of** `notifyDone` when the gate arms; `notifyDone` is
  **withheld** until `ACCEPTANCE_APPROVED`/`ACCEPTANCE_DIVERGED`. The driver's `runEffect`:
  (a) augments the gate with the run `cwd` + `openTarget` (default `"index.html"`) and patches it back
  into `state.pendingAcceptance` so the snapshot carries it; (b) fans the augmented gate to
  `OrchestratorObserver.onAcceptanceReview(gate)`; (c) best-effort **opens the baseline** via the
  `open_baseline` Tauri command (`OrchestratorDeps.openBaseline(cwd, path)`). Like the prototype gate,
  there is **no `heldPermissionId`** — the gate resolves by an explicit user action, not a held tool.

### Driver surface

- `OrchestratorHandle.approveAcceptance()` / `divergeAcceptance(reason)` dispatch the two events
  (clock via `nowFn()`); both throw `no pending acceptance gate` when none is held.
- `OrchestratorObserver.onAcceptanceReview(gate: AcceptanceGate)` — the new hook.
- `OrchestratorDeps.openBaseline?(cwd, path)` — optional; wired in `defaultDeps` to
  `invoke("open_baseline", { cwd, path })`.
- **Summary-consume short-circuit (CRITICAL):** in the driver's `summary` consume branch, a parked
  root acceptance window (`activePath() === []` AND `pendingAcceptance` held) is detected **before**
  the roll-up-window branch and sends **no** turn (the root acceptance window is structurally identical
  to a roll-up window, so without this guard the driver would erroneously send a root roll-up prompt).

### `#review-bar` — the ACCEPTANCE mode (additive fourth mode + precedence)

Precedence (first match wins): **pendingApproval gate > prototype gate > ACCEPTANCE gate >
pendingReviews**. Derived **from the snapshot, never module state** (pure `acceptanceGateActive`,
`src/prototype.ts`), so it self-clears when `approveAcceptance`/`divergeAcceptance` null
`pendingAcceptance`. Reuses the `.proto` bar layout + controls:
- `#review-bar-label` reads **`Acceptance — does the build meet the baseline floor?`**
  (`acceptanceBarLabel`).
- `#review-approve` — **always enabled**, label **`Accept (meets baseline)`** (`acceptanceApproveLabel`)
  → `getOrchestrator().approveAcceptance()`.
- `#review-submit` — relabeled **`Accept divergence…`** (`acceptanceDivergeLabel`), **disabled while
  `#prototype-feedback` (reused as the divergence-reason textarea) is empty** → `divergeAcceptance(reason)`.
- `#prototype-open` — relabeled **`Open baseline`** → `open_baseline({ cwd, path: gate.openTarget ?? "index.html" })`.
- The working-reference checkbox and the comment-driven controls (clear/dismiss/resume) hide.
- The idle-waiting hint stays up while `pendingAcceptance` is held (turn-completion signaled, like the
  prototype gate).

## Amendment 2026-06-14 — Phase 6: the forced-acceptance REFINE (re-plan) branch (additive, non-breaking)

A **THIRD** acceptance-gate action beside Approve and Accept-divergence: **re-plan a chosen sub-plan**
as a first-class operation. There is deliberately **NO "stale summary" flag** — refine RESETS the
target node and its right-siblings to a fresh re-execution shape (a tree shape the existing per-level
partition already permits), so those sub-plans re-execute and OVERWRITE their summaries; when the tree
re-completes with the baseline still present and no verdict recorded, the Phase-5 acceptance gate
**re-arms automatically** (it falls out of the existing `advanceAfterSummary` root-completion logic).

### Event — `ACCEPTANCE_REFINED { target: NodePath }` (`PlanTreeEvent2`)

- **Guard:** legal ONLY while the acceptance gate is open — `pendingAcceptance` held AND the root in
  its acceptance window (`inAcceptanceWindow`, running-children + all children summarized). Any other
  shape throws LOUDLY (`no acceptance gate is open` / `not in the acceptance window`).
- **Target:** a **direct root child** (`target.length === 1`) — the top-level sub-plans the gate
  surfaces. The root (`[]`) is rejected (the root writes no plan/summary; re-planning the whole tree is
  "start a new plan"); a deeper path is rejected (it would have to un-summarize every ancestor back to
  the root, which the per-level reset does not do).
- **Reset semantics (the whole story — no stale flag):** at the target's level, the **target → fresh
  `open/recon`** (active, re-execution resumes there) and **every RIGHT-sibling → fresh `open/pending`**
  (`makeNode2` shape: `redraftCount` 0, no `lastFeedback`, no artifacts). **Left-siblings stay
  `summarized`** (untouched). The result is a coherent **`summarized* active pending*`** partition with
  the parent (root) still `running-children` with exactly one active child — a shape `assertCoherent2`
  already accepts (mirrors `DECOMPOSITION_APPROVED`'s "first child → recon, rest pending" shaping).
- Clears `pendingAcceptance` (back to executing). Records **NO** `acceptance_` (no verdict).
- Emits one **`deletePlanTreeFile`** effect for each reset node's `NN-plan.md` AND `NN-summary.md` (in
  per-sibling order, target first), and **nothing for left-siblings**. The reducer stays PURE
  (clock/IO via effects/events).

### Effect — `deletePlanTreeFile { name }` (`Effect2`)

Delete `<cwd>/.plan-tree/<name>`. The driver's `runEffect` calls the optional `deletePlanTreeFile` dep
**best-effort** (a failure or an absent dep is logged, never throws — the re-run overwrites the file
anyway). Containment-guarded + allow-list-validated identically to `writePlanTreeFile` (see the new
Rust command below): only the literal control files or an `NN-(plan|summary).md` shape pass; the target
can never escape `.plan-tree/`.

### New Tauri command (Rust: `src-tauri/src/plan_tree.rs`)

| Command | JS args | Returns | Notes |
|---|---|---|---|
| `delete_plan_tree_file` | `{ cwd, name }` | `()` | Deletes `<cwd>/.plan-tree/<name>` via the SAME `guarded_plan_tree_path` allow-list + containment guard as read/write. **Graceful:** an absent file is `Ok(())` (a leaf node never wrote `NN-plan.md`), never an error. |

### Driver surface

- `OrchestratorHandle.refineAcceptance(target: NodePath)` — guarded (throws `no pending acceptance
  gate` when none is held), dispatches `ACCEPTANCE_REFINED`, drops the reset nodes' stale summaries from
  the per-level threading map, then **drives the target's fresh recon turn** (`subReconPrompt`) — the
  session is idle at the gate (a post-completion hold), so no interrupt. `notifyDone` stays withheld;
  the gate re-arms on the tree's re-completion.
- New optional dep `OrchestratorDeps.deletePlanTreeFile(cwd, name)` (→ `delete_plan_tree_file`).

### `#review-bar` — the ACCEPTANCE mode gains the REFINE action (additive)

Two new `.review-bar-actions` children, **shown ONLY in ACCEPTANCE mode** (and only when the root is a
split with ≥1 refinable sub-plan), both ship `.hidden`:
- `#review-refine-target` (`<select class="rb-select">`) — the sub-plan picker, populated from the
  snapshot by `applyAcceptanceBar` (pure `acceptanceRefineTargets(root)` → the root's direct children as
  `{ pathKey, title }`).
- `#review-refine` (`<button class="rb-btn">`, label **`Refine sub-plan`** via `acceptanceRefineLabel`)
  — click → `refineAcceptance(parsePathKey(#review-refine-target.value))`, then flip to the Conversation
  tab (the re-run streams in place). `applyAcceptanceBar` / `refreshReviewBar` / `applyPrototypeBar` are
  the sole writers of their `.hidden` (hidden in every non-ACCEPTANCE mode).

## Amendment 2026-06-14 — Opus-only effort selector (`.titlebar-effort`, additive, non-breaking)

A frontend-only addition to the titlebar that lets the user pick Opus's reasoning effort. No Tauri
command/event surface changes; the effort value rides the existing frontend→Rust→sidecar→SDK path
(`resolveModelOptions` → `start_agent_session` options, already opaque at Rust, validated at the
sidecar's `isEffortLevel`).

### New DOM group — `.titlebar-effort` (sibling of `.titlebar-model-picker`)

- `.titlebar-effort` is a **sibling** of `.titlebar-model-picker` inside `.titlebar-controls` — **NOT a
  child** (the model picker has `overflow:hidden` + a fixed 28px height that would clip extra buttons and
  their focus outlines). It carries `role="group"` + `aria-label="Opus effort level"`.
- It contains exactly **five** `<button class="effort-level" data-effort=…>` buttons, in order:
  `data-effort ∈ low | medium | high | xhigh | max` (mirrors `EFFORT_LEVELS` in `src/model-picker.ts`).
  Each starts `aria-pressed="false"`; `initModelPicker`'s `highlightEffort` keeps exactly one button
  `.active` + `aria-pressed="true"` in lockstep.
- **Opus-only visibility:** the group is revealed (its `hidden` attribute removed) **only when `opus-4-8`
  is the active preset**; for `fable-5` / `sonnet-4-6` it is `hidden` (with the explicit
  `.titlebar-effort[hidden] { display: none; }` rule, it is fully removed from layout — no greyed
  placeholder). `initModelPicker`'s `syncEffortVisibility(preset)` is the sole writer of this attribute
  (called on init from the stored preset and after every preset click).
- **Drag-immune:** plain interactive `<button>`s, excluded from the window drag region by
  `isDragTarget()` in `src/titlebar.ts` (no `data-tauri-drag-region`), exactly like the model presets.
- **Disjoint handlers/selectors:** the effort click handler is bound to `.titlebar-effort` and guarded by
  `closest(".effort-level")`; the preset handler stays bound to `.titlebar-model-picker` and guarded by
  `closest(".model-preset")`. The `highlight()` (`.model-preset`) query is NOT broadened. An effort click
  never changes the active preset and a preset click never changes the active effort.

### New localStorage key — `plan-reader-opus-effort`

- Holds one of the five levels (`low | medium | high | xhigh | max`); **default `high`** when
  absent/invalid/unreadable (the hardened `readStoredEffort` never throws — it mirrors
  `readStoredPreset`).
- It is a **single global** setting (independent of `plan-reader-model-preset`), applied whenever Opus is
  the selected preset. **Written on effort-button click** only; **never cleared on model switch** (the
  chosen level is retained across model switches). **Read at session start** by the orchestrator via
  `resolveModelOptions` — for `opus-4-8` the resolved options carry `effort = readStoredEffort(storage)`;
  for every other preset the resolved options carry that preset's own static effort (the global Opus
  effort never leaks onto a non-Opus preset, and `buildOptions`'s key-omission invariant is preserved).

### Supersedes the prior Opus static `effort: "medium"`

`PRESET_OPTIONS["opus-4-8"]` no longer carries a static `effort` (it is now `{ model: "claude-opus-4-8" }`,
`"effort" in PRESET_OPTIONS["opus-4-8"] === false`). The Opus effort is now sourced exclusively from the
global `plan-reader-opus-effort` key (default `high`), superseding the former hard-coded
`effort: "medium"`. The Opus `.model-preset` button's `title`/`aria-label` drop the stale "medium effort"
phrase accordingly. `fable-5` / `sonnet-4-6` static efforts are unchanged.

---

## Amendment — Dense Chat tool-row density (`#conversation-stream` only)

The conversation pane's tool rows now diverge by their already-emitted `data-status` so a long
session reads tighter. This is an **additive** amendment: the frozen render-selector list
(`.conv-tool` + `-head`/`-badge`/`-name`/`-summary`/`-status`/`-chevron`/`-body`/`-input`/`-result`),
the `data-status="running|done|error"` attribute, the `.expanded` toggle, the Sanitization
invariant, the Dark-mode tokens-only invariant, and the `.conv-subagent` table are all
**unchanged**. The renderer keeps emitting the identical structure and toggle for every status;
the divergence lives entirely in `src/styles.css` behind `.conv-tool[data-status="…"]`.

### Per-`data-status` density (CSS-only, keyed on the existing attribute)

| `data-status` | Treatment |
|---------------|-----------|
| `done` | Ultra-slim, borderless, dimmed one-liner: small **done-dot** (the `.conv-tool-status::before`, `background: var(--live)`) replaces the now-hidden `.conv-tool-status-text`; mono badge collapses to a tiny glyph; `.conv-tool-summary` keeps `nowrap`/`ellipsis`; `.conv-tool-chevron` is hidden and **revealed on `:hover` and while `.expanded`**; detail (`.conv-tool-body`) hidden until expanded. |
| `running` | Prominent accent card (`background: var(--conv-tool-run-bg)`, `1px solid var(--accent-soft)`); bold mono `.conv-tool-name`; uppercase accent `.conv-tool-status` containing the live `.conv-tool-pulse` dot; chevron always visible. |
| `error` | Danger treatment at the new density (`border: var(--conv-danger)`, `background: var(--conv-danger-soft)`); **never collapses** to the slim done treatment; `.conv-tool-result-error` color is **unchanged**. |

Shared: `.conv-tool-body { display: none }` / `.conv-tool.expanded .conv-tool-body { display: block }`
(unchanged toggle); the done body is indented to align under the row content. The `.conv-stream`
inter-row `gap` is reduced (10px → 6px) for the tighter cadence.

### New DOM (additive — nothing renamed)

- **`.conv-tool-pulse`** — a decorative pulsing dot emitted by `render.ts` **only** when
  `node.status === "running"` (inside `.conv-tool-status`). It is `aria-hidden="true"` (purely
  visual). Done/error rows do **not** emit it.
- **`.conv-tool-status-text`** — a label-wrapper span inside `.conv-tool-status` that now carries
  the `statusLabel(...)` text (`textContent`). It exists so the running pulse child can coexist
  with the label (assigning `.conv-tool-status.textContent` directly would clobber the pulse). The
  done state hides this span (`display: none`) in favor of the done-dot. Future assertions about
  the status label should target `.conv-tool-status-text`, **not** `.conv-tool-status`'s
  `textContent` (it is now a parent of child spans).

### New token

- **`--conv-tool-run-bg`** — the running-card accent wash. Declared in **BOTH** `:root` and
  `:root[data-theme="dark"]` (per the Dark-mode tokens-only invariant). It is the only new color;
  no literal color is inlined into any `.conv-*` rule body.

### Reduced-motion guard

All Dense Chat motion is state-change only and gated by the existing
`@media (prefers-reduced-motion: reduce) { animation: none }` idiom: the `.conv-tool-pulse` reuses
`@keyframes conv-working-pulse` and is stilled to a resting `opacity` under `reduce`; the
running-card `@keyframes conv-tool-settle` (fade-in) and the expanded-body
`@keyframes conv-tool-reveal` (slide-in) are also disabled under `reduce`. Keyframe step bodies
are color-free.

### Subagent inheritance

Nested `.conv-tool` rows inside a `.conv-subagent` group pick up the per-`data-status` density
automatically — the rules are not top-level-scoped, so a subagent's completed tools collapse to
the slim done treatment for free.

---

## Conversation history (plan-select replay)

Selecting a plan in the sidebar can reconstruct that plan's **past** conversation from its
originating session transcript on disk and replay it into the CONVERSATION tab. The Tauri command
below is the locate-and-read seam; it returns only raw transcript lines — no conversation
vocabulary crosses the Rust↔TS boundary.

### Command: `read_plan_transcript(stem)`

```
read_plan_transcript(stem: string) -> {
  found: boolean,
  path: string | null,        // canonical path of the matched transcript
  cwd: string | null,         // the matched transcript's session cwd
  session_id: string | null,  // first sessionId/session_id found in the file (best-effort)
  lines: string[]             // server-filtered raw jsonl lines, in file order
}
```

(JSON keys are snake_case — `session_id` — matching the `PlanRecord` convention; no serde
rename.)

- **Resolution** uses the SAME provenance ranking as cwd resolution (`resolve_stem_path` shares
  `resolve_stems`' helpers `offer`/`first_cwd`/`write_file_path` and its `Provenance` levels): a
  `plan_mode` attachment whose `planFilePath` ends with `/plans/<stem>.md` (authoritative) beats a
  `Write` tool_use whose `input.file_path` matches (fallback), which beats a bare substring mention
  (last resort). Highest provenance wins; ties break to the **newest-mtime** transcript, identical
  to `resolve_stems`.
- **Unmatched** stems return `{ found: false, path: null, cwd: null, session_id: null, lines: [] }`
  — the frontend paints an explicit empty state, never a silently blank pane.
- **Server-side filter** (bounds the payload — the corpus has multi-MB transcripts): `lines`
  contains ONLY records whose top-level `type` is `"user"` or `"assistant"` AND that are not
  flagged true on any of `isMeta` / `isVisibleInTranscriptOnly` / `isSidechain` /
  `isCompactSummary`. Every other record type (attachment / summary / last-prompt / ai-title /
  permission-mode / queue-operation / mode / agent-name / system) and any line that fails to parse
  as a JSON object is dropped. Original file order is preserved.
- **Containment**: the matched transcript path is canonicalized and verified to live inside the
  canonical `~/.claude/projects` root (mirrors `read_plan_contents`) before any read; the scan runs
  off-thread via `spawn_blocking` (mirrors `resolve_cwds`).

### Selector: `.conv-empty` (history empty state)

When a selected plan has no reconstructable conversation, the controller paints a SINGLE explicit
empty-state element into `#conversation-stream` (via `replaceChildren`) instead of a silently blank
pane:

| Selector | Emitted when | `textContent` |
|---|---|---|
| `div.conv-empty` | `read_plan_transcript` returns `found:false` (no resolvable transcript) | `No conversation history found for this plan.` |
| `div.conv-empty` | transcript found but the replay yields zero renderable nodes | `No conversation content to display for this plan.` |

`.conv-empty` is **distinct from `.conv-notice`** (a real model `NoticeNode`): it is set via
`textContent` (never `innerHTML`), carries no model event, and does not survive a re-derive — it is
purely the pane's idle empty state. A live/orchestration takeover replaces it with the live model.

The controller method that drives this is `ConversationHandle.loadHistoryForPlan(stem)`, fired
un-awaited from `openPlan` (silent populate — the user stays on the PLAN tab). It is a hard NO-OP
while a session is live OR an orchestration is active, and guards against a stale resolve (a fast
A→B plan switch) and a live run starting mid-await via an internal generation counter.

### Boundary: the transform lives in TS, not Rust

The CLI-record → `AgentStream` transform lives entirely in **TypeScript**
(`src/conversation/history.ts`), NOT in Rust. Only the raw filtered lines (plus `cwd` /
`session_id`) cross the boundary; TS parses each line and builds the typed `AgentStream` frames it
replays through the existing conversation renderer.

### Scope

This covers **scan-resolvable** plans (CLI-authored / plan-mode plans that emit a plan-write
provenance event into a transcript). App-authored `tree_id` plans (`agent-plan-tree-*`, which emit
no plan-write event and resolve via the `tree_cwd_index` fast-path) are resolved by the **`tree_id`
resolution fallback** documented below.

### Amendment 2026-06-14 — `tree_id` resolution fallback (app-authored plans)

`read_plan_transcript` now resolves app-authored `agent-plan-tree-*` plans too. The provenance scan
(`resolve_stem_path`) remains the **PRIMARY** path, so CLI-authored / plan-mode plans are entirely
unaffected (the fallback is reached ONLY when the scan returns `None`). The fallback chain:

1. **Scan miss** → read the plan file head (`~/.claude/plans/<stem>.md`) and `parse_marker` its
   frontmatter. No `tree_id` ⇒ keep `found:false` (a genuinely transcript-less plan).
2. **`tree_id` → cwd** via `AppState.tree_cwd_index`, gated by `indexed_cwd_if_live` (the cwd dir
   must still exist). No live cwd ⇒ `found:false`. The `Mutex<AppState>` is locked ONLY to clone the
   index out and is **never held across `spawn_blocking`/`.await`** (mirrors `resolve_cwds`).
3. **`<cwd>/.plan-tree/state.json`** is read + JSON-parsed (absent/malformed tolerated). If its
   `tree_id` matches and it carries an `sdk_session_id`, that is the session id.
4. **Locate the transcript** (`resolve_tree_session`):
   - **PRIMARY (filename match):** among `collect_transcripts(projects_root())`, the file whose
     **stem equals `sdk_session_id`** — because the session transcript is
     `projects/<encoded-cwd>/<session_id>.jsonl` (no reverse-decoding of the lossy encoded-cwd dir
     name). The stem-matched file is accepted ONLY if its in-file `first_cwd` equals the resolved
     cwd (the same invariant the FALLBACK enforces); a stale/mismatched `sdk_session_id` could name
     a transcript from a DIFFERENT directory, which must not be returned under the resolved cwd — on
     mismatch resolution falls through to the newest-by-cwd FALLBACK.
   - **FALLBACK (newest-by-cwd):** when there is no usable `sdk_session_id` (or PRIMARY's cwd check
     fails), the **newest**
     (mtime-descending) top-level `<session>.jsonl` whose in-file `first_cwd` equals the resolved
     cwd; its `first_session_id` is the session id. Subagent files (`subagents/agent-*.jsonl`) are
     excluded — only a top-level session can be the originating session.

If neither yields a file ⇒ `found:false`. The matched path is canonicalized + containment-guarded
against the canonical projects root before reading (same guard as the scan path). The returned
`cwd` is the index-resolved cwd. `resolve_tree_session(tree_id, cwd, transcripts, state_json:
Option<&Value>) -> Option<(PathBuf, session_id)>` is a unit-testable seam (no `plans_dir()` /
`State` access); the command wires the state lock + plan-file + `state.json` reads around it.

**Scan-before-fallback ordering is invariant.** A provenance-scan hit ALWAYS short-circuits — the
`tree_id` fallback is consulted ONLY on a scan miss, so CLI-authored / plan-mode plans are entirely
unaffected by this fallback. The pure ordering is `pick_transcript_source(scan, fallback)`
(returns the scan hit verbatim without invoking `fallback`; runs `fallback` only on `None`).

## Amendment 2026-06-14 — Conversation minimap gutter (`#tab-conversation`, additive)

A render-only **minimap gutter** sits to the RIGHT of the scroll container inside the conversation
pane. The scroll container (`#conversation-stream`) and the minimap are now wrapped together in a
flex-row wrapper; the toolbar (`.conv-toolbar`) and composer (`#conversation-input`) rows are
**unchanged siblings** of that wrapper under `#tab-conversation`.

| selector | element | role |
|----------|---------|------|
| `.conv-stream-wrap` | flex-row wrapper | new direct child of `#tab-conversation`, in the position the stream previously held. Takes the vertical space the stream used to occupy (`flex:1; min-height:0`); lays the stream + minimap out side by side |
| `#conversation-stream` (`.conv-stream`) | scroll container | UNCHANGED id/class/contents; only its parent moved (now inside `.conv-stream-wrap`). **NEW REQUIREMENT:** it is `position: relative` so a block child's `offsetTop` resolves against the scroll container — the minimap reads this for block layout and click-to-scroll |
| `#conversation-minimap` (`.conv-minimap`) | gutter, `aria-hidden="true"` | fixed-width (`flex:0 0 24px`) right sibling of the stream; `position: relative; overflow: hidden`; click/drag target (`cursor: pointer; user-select: none`) for scroll-to-position. Reads as a gutter via a left border + faint `--conv-bubble-bg` fill |
| `.conv-minimap.is-empty` | minimap, no blocks | `display: none` — fully hidden when the stream has no rendered blocks |
| `.conv-minimap-block[data-tier="user\|assistant\|meta"]` | one positioned proportional bar per stream block | `position: absolute; left:3px; right:3px`. **`top`/`height` set INLINE by JS** (proportional to the block's offset/height in the stream). Tier colors: `user` = `var(--accent)` (matches the `.conv-text-user` accent family), `assistant` = `var(--text-dim)` (neutral mid), `meta` = `var(--text-dim)` at `opacity:0.35` (dimmed/muted) — so user vs assistant vs meta are visually distinct at a glance |
| `.conv-minimap-viewport` | the visible-window indicator | `position: absolute; left:0; right:0`; translucent accent fill (`color-mix(... var(--accent) 18% ...)`) + `1px solid var(--border)`; `pointer-events: none`. **`top`/`height` set INLINE by JS** to mirror the stream's current scroll viewport |

> **JS contract:** CSS sets only static geometry (left/right insets, colors, border-radius). The
> per-block `top`/`height` and the viewport `top`/`height` are owned by JS (inline styles), computed
> from `#conversation-stream` child `offsetTop`/`offsetHeight` against the (now `position: relative`)
> scroll container. The `position: relative` on `.conv-stream` is load-bearing for this and MUST NOT
> be removed.

## Amendment 2026-06-15 — Mock-mode harness mirrors the command/event surface (additive, dev-only)

The token-free **mock harness** (`src/mock/**`, run via `npm run mock` — see `README.md` → "Mock mode"
and the developer guide in `src/mock/README.md`) re-implements this contract's **Tauri command/event
surface** in-memory so the real, unmodified frontend runs in a plain browser. It aliases every
`@tauri-apps/*` import to a shim (`vite.mock.config.ts`); production source, `vite.config.ts`, and
`index.html` are untouched.

This surface is **frozen against the contract by a test**, so it cannot silently drift from the real
app:

- **`src/mock/registry-canary.test.ts`** statically scans every production `.ts` under `src/` (excluding
  `src/mock/**` and `*.test.ts`) for `invoke("…")` literals and asserts the mock's handled-command set
  (`HANDLED_COMMANDS` in `src/mock/core.ts`) is a **superset** of them. **Any NEW Tauri command the
  frontend invokes MUST get a mock handler** (a `dispatch` case + a `HANDLED_COMMANDS` entry) or the
  canary goes RED, naming the missing command. (`tsc` cannot catch this — the app's `invoke(cmd, args)`
  call sites are untyped strings.)
- **`src/mock/scenes.test.ts`** holds an `AgentStream`-union exhaustiveness guard: every committed
  `agent-stream` `kind` (this contract's frozen vocabulary, typed in `src/conversation/types.ts`) is
  either driven by a mock scene/handler or listed in an explicit allowlist with a reason. Adding an
  11th union member fails `tsc` (the coverage map is keyed by the union) until it is consciously
  classified.

Dev-only: ships in no distributable. `npm run build` (production Vite, base config) emits **no** mock
markers — the harness, the deck, and `window.__mock` exist only under the mock config.

## Amendment 2026-06-17 — Synthetic "resume" sidebar rows for plan-file-less trees (additive)

`list_plans` now returns, in addition to the real `~/.claude/plans/*.md` rows, **synthetic
`PlanRecord` rows** for plan-trees that are mid-decompose but have **no plan `.md` file yet** — so a
tree whose only on-disk state is `<cwd>/.plan-tree/state.json` is still visible in the sidebar and its
resume banner is reachable (previously such a tree had zero rows and was invisible).

**Source.** For every `tree_id → cwd` entry in the persisted `tree-cwd-index.json`
(`AppState.tree_cwd_index`), the backend synthesizes ONE row iff ALL of:
1. the `tree_id` has **zero real rows** in this `list_plans` pass (see the dedup rule below), AND
2. `<cwd>/.plan-tree/state.json` exists, reads, and parses as JSON, AND
3. the tree is **NOT done** — `tree_is_done(state)` is `false`, where `tree_is_done` is the Rust port
   of the frontend `treeIsDone` (`src/conversation/plan-tree.ts`): done iff
   `root.state.stage != "open" && root.state.phase == "summarized"`. The Phase-5 forced-acceptance
   window (root resting `split` / `running-children`, NOT summarized) reads **not done**, so an
   acceptance-pending tree is still surfaced. A malformed/incomplete ledger reads **not done** (kept
   visible, never silently hidden).

**Zero-real-rows dedup rule.** A real plan file for a `tree_id` — master **or** sub — ALWAYS suppresses
its synthetic row. Synthesis is skipped whenever the `tree_id` appears on ANY real record. We do NOT
adopt orphan subs into a synthesized master; if there is already something real in the sidebar for that
tree, the synthetic row is not minted.

**Synthetic `PlanRecord` shape** (same frozen wire shape as a real row — see §"Sub-Plan 01"):
- `absolute_path`: the **sentinel** `plan-tree-resume://<tree_id>` (the `RESUME_SENTINEL_SCHEME`
  prefix). This can never collide with a real `~/.claude/plans/*.md` path. `read_plan_contents`
  rejects it safely (its `canonicalize` fails on the scheme string, so the containment guard never
  runs and no file is ever read for a sentinel path).
- `filename_stem`: the `tree_id` (stable, collision-free among synthetic rows; display-incidental —
  the frontend renders the title).
- `flavor`: `"master"`; `tree_id`: `Some(<tree_id>)`; `nn`/`nn_path`: `null`; `child_count`: `0`;
  `collapsed`: `false`.
- `cwd`: `Some(<index cwd>)` — so the frontend resolves cwd WITHOUT a transcript scan.
- `mtime_ms` (the sidebar recency **sort key**): the ledger top-level **`created_ms`** (epoch ms), NOT
  the `state.json` file mtime. `created_ms` is stable across the frequent `persist` rewrites, so the
  row does not churn to the top of the recency-sorted sidebar on every poll. Falls back to the
  `state.json` file mtime only when `created_ms` is absent (old/sketch ledger).
- `unread`: the SAME baseline/viewed/open-by-fiat rule as a real row, keyed by the sentinel path.
- `h1s`: `[root.title]` (the title rides `h1s`; the sidebar reads it as it would a real master's H1).
  Falls back to the `tree_id` when `root.title` is absent.

Synthetic rows are merged into the arranged real rows by **recency** (their `created_ms`), interleaved
alongside real top-level entries while each real master keeps its children contiguous beneath it
(`merge_synthetic_rows`). `arrange_plans` itself is unchanged and never sees synthetic rows (they are a
childless standalone master, so it could not mangle them either way).

**Frontend obligation (separate task).** The frontend MUST detect the `plan-tree-resume://` prefix on
`absolute_path` and treat such a row specially: opening it surfaces the resume/continue banner for that
`tree_id` (using the row's `cwd`), and it MUST NOT call `read_plan_contents` for a sentinel path (there
is no plan file behind it — the call would error).

**Frontend behavior (implemented — `src/main.ts`).** A single predicate `isResumeSentinel(path)` keys
off the `plan-tree-resume://` prefix. All sentinel handling is gated on it:
- **No plans-channel IPC for the sentinel path.** `openPlan` skips `set_open_plan`, `read_plan_contents`,
  and `mark_viewed` for a sentinel (all reject Rust-side). `reloadOpenPlan` bails immediately for a
  sentinel `openPath`; `handlePlanChanged` skips `set_open_plan(openPath)` / `mark_viewed(openPath)`
  when the open plan is a sentinel. (A sentinel is never a real watched `changedPath`, so it never
  drives a reload.)
- **Reading-pane placeholder.** Inside the same render-generation guard as a normal open, `openPlan`
  renders a graceful placeholder: it prefers the tree's `INTENT.md` via
  `read_plan_tree_file(cwd, "INTENT.md")` (the row's `cwd`, run through `resolvedCwdFor`), and falls
  back to a static "_This plan is in progress. Use **Resume** above to continue it._" note when
  `INTENT.md` is absent/unreadable. Never throws; respects the `renderGuard.isCurrent(gen)` re-checks.
- **Resume banner.** `refreshResumeBanner(path)` runs unchanged for a sentinel — `detectResumable`
  reads the freshest record by `absolute_path`, derives cwd from `rec.cwd` (set on the synthetic row),
  and reads `.plan-tree/state.json`; it does NOT depend on the path being a real file, so the banner
  surfaces the correct forward action (Resume/Continue/Restart/Rewind) per the tree's phase.
- **Sidebar + header title.** The synthetic row renders flat (`flavor:master`, `child_count:0`). Its
  `.plan-title` and the reader `#doc-filename` show the tree title from `h1s[0]` (the `filename_stem`
  is the tree_id — display-incidental), falling back to the stem when `h1s` is empty. The reader
  `#doc-src` cwd comes from the record's `cwd` (the sentinel stem is never in the resolve cache).

### Amendment 2026-06-17 — synthetic-row correctness clarifications (additive)

Three correctness refinements to the synthesis above (no wire-shape or selector changes):

- **Refresh cadence — cold-start / restart affordance, NOT a live indicator.** A synthetic resume row
  is a **cold-start / restart** affordance: it appears (and updates) only on the **next `list_plans`**,
  which fires at app startup and on a `~/.claude/plans/` `.md` change (the `notify` file watcher covers
  `plans/` ONLY — it does **not** watch any `<cwd>/.plan-tree/` directory). A `.plan-tree/`-only
  `state.json` write therefore does **not** instantly add, remove, or re-title a synthetic row. This is
  by design: a **live, in-app** plan run is surfaced by the orchestrator's `runPlaceholder` (the
  in-session conversation/reading-pane state), not by the synthetic sidebar row. The synthetic row
  exists to make a tree resumable **across restarts** (or when discovered cold from the index), so its
  eventual-consistency refresh on the next `list_plans` is sufficient.

- **Dedup suppression set is built from RAW frontmatter markers, not arranged records.** The
  zero-real-rows dedup set (`real_tree_ids`) is collected from the **raw** parsed frontmatter markers
  (`RawRow.marker.tree_id`) BEFORE `arrange_plans` runs — NOT from the arranged `records[].tree_id`.
  `arrange_plans` NULLS an orphan sub's `tree_id` (a sub `.md` present with its master `.md` absent is
  reclassified Standalone with `tree_id = None`), so a set keyed off arranged records would miss that
  tree and wrongly synthesize a master ALONGSIDE the orphan-sub row (a double row for one tree). Keying
  off the raw marker means **any** real plan file of **any** flavor for a `tree_id` suppresses its
  synthetic row, regardless of arrange-time reclassification.

- **Ledger-`tree_id` guard against reused-cwd ghosts.** Synthesis skips an index entry unless the parsed
  `state.json`'s top-level `tree_id` equals the index **key**. A re-genesised cwd (the orchestrator
  archives the old tree and starts a new `tree_id` in the SAME cwd) can leave a stale `tree-old → /cwd`
  index entry; without this guard, synthesis would emit a **ghost** sentinel for `tree-old` while reading
  `tree-new`'s `state.json`. The guard ensures only the index key that matches the ledger's own
  `tree_id` synthesizes.

## Multimodal image input for the prompt composer (additive, non-breaking)

Both prompt surfaces accept image attachments (paste / drag-drop / file-pick); multiple per message;
each shows as a removable chip; after send each renders as a thumbnail in the conversation-history
user bubble. The string-only send path is widened **additively** with an OPTIONAL `images` field —
OMITTED entirely when no images are attached, so every text-only / agent-generated send is
byte-identical to before.

### New DOM ids (both surfaces)

| Selector | Purpose |
|----------|---------|
| `#composer-attachments` | composer: removable image-chip strip (`.conv-attach-chip` per chip) |
| `#composer-attach` | composer: "attach image" button (proxies a click to the hidden file input) |
| `#composer-file-input` | composer: hidden `<input type="file" multiple>` (image picker) |
| `#composer-error` | composer: attach-time rejections REUSE the existing inline error line |
| `#conversation-attachments` | in-conversation: removable image-chip strip |
| `#conversation-attach` | in-conversation: "attach image" button |
| `#conversation-file-input` | in-conversation: hidden `<input type="file" multiple>` |
| `#conversation-attach-error` | in-conversation: inline attach-time rejection line |

### `send_agent_message` — additive optional `images`

The command args gain an OPTIONAL `images` field (snake_case `media_type` to match Rust
`ImageInput` / the SDK `Base64ImageSource`); the key is OMITTED when empty:

```ts
send_agent_message({
  text: string,
  images?: [{ media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: string }],
  // `data` is base64 with NO `data:<mime>;base64,` prefix.
})
```

### Sidecar `string → content-array` migration + `[Image #N]` tokens

When `images` is present and non-empty, the sidecar lifts the user message `content` from a bare
`string` to an **array**: one inline base64 image block per element (attach order) followed by a
single text block whose text is prefixed with positional `[Image #1] [Image #2] … [Image #N]`
tokens (1-based, one per image, incrementing). With no images the `content` stays the bare string
(byte-identical to before). Token-injection authority lives ONLY in the sidecar — the visible
textarea never holds the token. Malformed image elements (missing `media_type`/`data`) fail soft to
the bare string rather than throwing in the stdin loop.

### Conversation-history thumbnail render (one shared user-bubble path)

`UserMessageNode` gains an OPTIONAL `images?: string[]` holding DISPLAY data URLs of the form
`data:<media_type>;base64,<data>` (the wire shape's stripped prefix re-assembled at the call sites).
The user-bubble renderer draws a thumbnail row ABOVE the text when present: a `.conv-user-images`
container holding one `<img class="conv-user-image">` per data URL; the text follows in a
`.conv-user-text` child. No images → no row (byte-identical to the prior text-only bubble). This
single render path serves BOTH surfaces.

The in-conversation surface passes its display URLs to `appendUserMessage(text, images?)` on the
live AND post-end-resume success branches. The composer first turn — which sends
`intentPrompt(request)` and never echoed the raw request before — now echoes the **raw `request`**
(NOT the wrapper) + the display URLs as a user bubble, **GATED on images-present**: a text-only
composer start echoes NO first-turn bubble (unchanged behavior). Both echoes fire only on a
successful send (no orphan bubble on failure).

## Addendum 2026-06-20 — doc-audit reconciliation (additive; nothing above is changed or removed)

This addendum records a full re-audit of the documented surface against the code on the
`agent-sdk` branch. **No prior section was rewritten, reordered, or deleted.** Every command and
event documented above still exists and is still registered. Two items existed in the code but were
never documented in a prior section; they are added here.

### Command present in code but previously undocumented: `diag_log`

```
diag_log(msg: String)
```

Registered in `tauri::generate_handler![…]` (`src-tauri/src/lib.rs`). A fire-and-forget diagnostic
sink: it takes a single `msg` string and writes `[fe:diag] <msg>` to the backend's stderr
(`eprintln!`). No return value, no state, no event. The frontend calls it via
`invoke("diag_log", { msg })` to surface front-end diagnostics in the dev terminal (used by
`src/conversation/diag.ts`). It reads/writes no files and touches no managed state.

### DOM selector present in code but previously undocumented: `#conversation-attach-row`

The multimodal-image addendum above documents `#conversation-attach`, `#conversation-attachments`,
`#conversation-file-input`, and `#conversation-attach-error`, but not their wrapper:

| Selector | Role |
|----------|------|
| `#conversation-attach-row` | `<div class="conv-attach-row">` in `index.html` — the row container that groups the in-conversation attach button + chip strip beneath the message composer. Purely structural (layout container for the already-documented attach controls). |

### Verified-still-current inventory (no change required)

For the record, the following were confirmed present and correctly documented:

- **Commands** (40, all registered in `invoke_handler`): `list_plans`, `read_plan_contents`,
  `read_image_as_data_url`, `diag_log` (see above), `set_open_plan`, `mark_viewed`, `resolve_cwds`,
  `read_plan_transcript`, `set_tree_collapsed`, `get_comments`, `get_comment_count`, `set_comments`,
  `clear_comments`, `list_pending_reviews`, `read_review_plan`, `respond_to_review`,
  `write_agent_plan`, `plan_tree::write_plan_tree_file`, `plan_tree::read_plan_tree_file`,
  `plan_tree::delete_plan_tree_file`, `plan_tree::reset_plan_tree_dir`,
  `plan_tree::ensure_prototype_dir`, `plan_tree::open_prototype`, `plan_tree::ensure_baseline_dir`,
  `plan_tree::freeze_baseline`, `plan_tree::open_baseline`, `focus_main_window`, `install_hook`,
  `uninstall_hook`, `hook_status`, and the eight Agent-SDK driver commands
  (`agent::start_agent_session`, `agent::send_agent_message`, `agent::resolve_tool_permission`,
  `agent::set_agent_permission_mode`, `agent::cancel_agent_run`, `agent::end_agent_session`,
  `agent::agent_auth_status`, `agent::set_agent_oauth_token`).
- **Events** (8): `plan-changed` (plans-dir watcher), `plan-review-requested` /
  `plan-review-cancelled` (control-dir watcher over `~/.claude/plan-reader/requests/`),
  `agent-stream`, `agent-error`, `agent-exit`, `tool-permission-requested`, `agent-auth-required`
  (Agent-SDK driver, `src-tauri/src/agent.rs`).

---

## Quota-exceeded auto-resume (additive, non-breaking)

The app detects when Claude's usage/rate-limit quota is hit and (in later phases) parks the run
behind a countdown banner, then auto-resumes once the quota window resets. None of the §1/§2/§3 or
prior additive surfaces are altered. This section adds **one new `agent-stream` kind**; the banner,
the ledger budget, and the orchestrator timer/auto-resume are added by **later phases** and
documented separately as they land.

### New `agent-stream` kind: `quota_exceeded`

| kind | fields (beyond `seq`/`kind`) | source |
|------|------------------------------|--------|
| `quota_exceeded` | `resetAt` (epoch-**milliseconds**), `source` (`"rate_limit_event" \| "thrown_error"`) | the sidecar emits this when the SDK reports the quota was hit, by **either** carrier: a rate-limit progress event (`source: "rate_limit_event"`) **or** a thrown quota error (`source: "thrown_error"`). `resetAt` is the moment the quota window resets, already normalized to epoch-**ms** by the sidecar (the frontend must NOT re-scale it). The `source` enum distinguishes the two detection carriers. |

**Non-fatal — travels via `agent-stream`, NOT `agent-error`.** This is load-bearing: routing it on
`agent-stream` means the Rust read task's catch-all `_ =>` Stream arm relays it unchanged (**no Rust
change required**), and — unlike a fatal `agent-error` — it does **not** tear the session down. The
session stays alive so a later phase can auto-resume it in place once `resetAt` passes.

The pure conversation reducer (`src/conversation/stream.ts`) treats `quota_exceeded` as **inert**: it
adds **no** timeline node, does **not** flip `complete`, and does **not** change the working/active
indicator state. The countdown **banner** and the **auto-resume** timer are owned by the
**orchestrator** observer (a later phase), NOT by the reducer.

### Phase 5 — the countdown banner (additive DOM contract)

The banner is a **single** pure render node (`QuotaBannerNode`, `type:"quota-banner"`) appended to the
live `ConversationModel` by the **orchestrator quota observer** wired in `src/conversation/index.ts`
(it subscribes `onQuotaPaused` / `onQuotaExhausted` / `onQuotaResumed` via `getOrchestrator()`). It is a
**singleton**: a re-pause UPDATES the same node in place (waiting → exhausted), never appending a
duplicate; `onQuotaResumed` clears it and appends a `.conv-notice` row reading **"Resumed after a quota
threshold was reached"**. The node never flips session/`complete` state.

Model methods on `ConversationModel`: `appendQuotaBanner({state,resetAt,remaining,source})` (create or
update the singleton), `updateQuotaBanner(...)` (alias), `clearQuotaBanner()` (tombstone → no node).

Rendered into `#conversation-stream` by `src/conversation/render.ts` (`renderQuotaBanner`). DOM selectors
(all `.conv-*`, token-styled in `styles.css`):

| selector | role |
|----------|------|
| `.conv-quota-banner` | banner root. `data-state` is `"waiting"` or `"exhausted"`. |
| `.conv-quota-banner-waiting` / `.conv-quota-banner-exhausted` | state modifier classes. |
| `.conv-qb-head` + `.conv-qb-dot` + `.conv-qb-head-text` | header row; amber **pulsing** dot (waiting), static accent dot (exhausted). |
| `.conv-qb-sub` | explanatory sub-text. |
| `.conv-qb-countdown` | **waiting only** — live `HH:MM:SS` countdown. |
| `.conv-qb-refresh-at` | reset clock-time ("Resets at …" / "Next reset at …"). |
| `.conv-qb-auto-note` + `.conv-qb-spin` | **waiting only** — "will auto-resume" reassurance + spinner. |
| `.conv-qb-pill` | **waiting only** — "⟳ Auto-resume armed · N attempt(s) left this session". |
| `.conv-qb-actions` + `.conv-qb-cancel` | **exhausted only** — the **Cancel session** button (the ONLY affordance; there is **never** a Resume button). |

**Countdown is wall-clock-driven.** A **single** module-level `setInterval` in `render.ts` recomputes
`resetAt - Date.now()` each 1s tick (clamped at `00:00:00`) — NOT a stored decrementing counter — so an
occluded/suspended WebView shows the correct value the instant it wakes; a `visibilitychange` listener
recomputes immediately on un-occlusion. The interval + listener are torn down at the top of every
`renderTree()` (before re-arming) and via the exported `teardownQuotaCountdown()` (called from the
controller's `teardown()`), guaranteeing **at most one** live interval — no leak across rebuilds.

The exhausted **Cancel session** button is wired to the `onCancelSession` render handler, which the
controller maps to the SAME full-stop path as the Stop button (orchestrator `cancel()` when an
orchestration owns the seam, else `cancel_agent_run` + `end_agent_session`).

### Same-tick agent-exit / quota-pause race (additive)

`OrchestratorHandle.quotaPaused(): boolean` is the **synchronously-correct** pause probe BOTH
`agent-exit` listeners consult (the conversation facade in `src/conversation/index.ts` and main.ts's
review-purge listener): when it is true on an `agent-exit`, the run is a **quota pause**, not an
end-of-run — index.ts lands SessionState `"paused"` (not `"none"`) and main.ts SKIPS its destructive
`purgeInprocReviews()` + live-run placeholder clear (a held in-process ExitPlanMode review must
survive the pause). Because the orchestrator's `QUOTA_PAUSED` dispatch runs in a **later microtask**
(via `enqueueIngest`) than the `agent-stream(quota_exceeded)` frame, the established pause is not yet
installed on a same-tick `quota_exceeded` + `agent-exit` delivery. `OrchestratorHandle.markQuotaPausePending(): void`
closes that race: the conversation facade's `agent-stream` listener calls it **synchronously** the
instant a `quota_exceeded` frame is seen (before the fire-and-forget `ingestStream`), so
`quotaPaused()` reads true from that tick onward (it ORs the pending flag with the established pause).
The pending flag is cleared wherever the pause resolves — `QUOTA_RESUMED` (auto-resume),
`cancel()`/`teardown()`, and every terminal (`markTerminal`) — so it never lingers to mis-classify a
later genuine exit as paused.
