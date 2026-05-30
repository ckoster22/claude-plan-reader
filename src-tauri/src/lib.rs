// Tauri shell, plan list & live file-watch.
//
// INVARIANT: this app only ever READS `~/.claude/plans/`. It never writes into that
// directory, so the watcher never fires on our own writes. CONTRACT.md and all build
// artifacts live in the repo, not the plans dir.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::{EventKind, RecursiveMode};
use notify_debouncer_full::DebounceEventResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

/// Hard ceiling on the size of an image we will inline as a `data:` URL. Files larger than
/// this are rejected BEFORE we read their bytes, so a huge file can never blow up memory.
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024; // 25 MiB

/// One row in the sidebar. The shape here is FROZEN as a hand-off contract (see CONTRACT.md).
/// `cwd` and `unread` are populated by the cwd resolver / read-state.
#[derive(Serialize, Clone)]
struct PlanRecord {
    absolute_path: String,
    filename_stem: String,
    mtime_ms: i64,        // millis since UNIX_EPOCH, JS-friendly
    cwd: Option<String>,  // resolved cwd, else None
    unread: bool,         // read/unread
    /// The plan's ATX H1 heading texts (fence-aware, within the bounded head read), in
    /// document order. Used by the frontend sidebar filter to match on headings. `[]` when
    /// none. snake_case JSON key `h1s` (no rename).
    h1s: Vec<String>,
}

/// Payload for the `plan-changed` event (frozen contract — see CONTRACT.md).
#[derive(Serialize, Clone)]
struct PlanChanged {
    path: String,
    kind: String,
}

/// One persisted comment for a plan. FROZEN wire shape — exactly 6 keys (see
/// CONTRACT.md §"Highlight + comment with quoted-text anchoring"). `block_line` is
/// `Option<i64>` (serde emits `null`)
/// — it mirrors the existing `cwd: Option<String>` precedent; there is NO `-1` sentinel.
/// `null` means the captured selection had no enclosing source block (re-find scans the whole
/// pane by `occurrence`). `block_end_line` is the matching `data-source-end-line` of that same
/// block (markdown-it's `[start, end)` exclusive end); it is `#[serde(default)]` so older saved
/// files lacking the key deserialize to `None`. Keyed-by-plan-path lives in the store map, not
/// the record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct CommentRecord {
    /// Normalized (whitespace-collapsed, trimmed) selected text — the re-anchor key.
    quote: String,
    /// `data-source-line` of the nearest enclosing block, or `null` for a whole-pane anchor.
    block_line: Option<i64>,
    /// `data-source-end-line` (markdown-it `[start, end)` exclusive end) of that same block, or
    /// `null` (unknown / whole-pane). `#[serde(default)]` rescues old files lacking the key.
    #[serde(default)]
    block_end_line: Option<i64>,
    /// 0-based Nth match of `quote` within the chosen root (block element, or whole pane).
    occurrence: i64,
    /// The user's comment text.
    comment: String,
    /// Collision-free id (also the highlight span's `data-c`), minted frontend-side.
    id: i64,
}

/// Absolute path to `~/.claude/plans`. Returns None only if the home dir cannot be located.
fn plans_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plans"))
}

/// True iff `candidate` lives inside `root`. Both are expected to already be canonicalized
/// by the caller (so symlinks/`..` are resolved before this check). Extracted from
/// `read_plan_contents` purely so the containment rule is unit-testable with an arbitrary
/// root — it does not change the command's behavior.
fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Convert a filesystem mtime into millis since the UNIX epoch.
/// Never panics: pre-epoch / clock-skew timestamps map to a negative value instead of
/// unwrapping `duration_since(UNIX_EPOCH)`.
fn system_time_to_ms(t: std::time::SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        // File mtime is before the epoch (or clock skew). Represent as negative millis.
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Read the plans dir, filter `*.md`, stat each, sort newest-first by mtime.
/// Missing or empty dir => empty list (UI shows empty-state, never errors).
/// Per-entry I/O errors skip that entry rather than failing the whole call.
///
/// Gains an injected `State<Mutex<AppState>>` (the JS `invoke("list_plans")` call is unchanged
/// — Tauri injects the managed state). It populates `cwd` from the in-memory cache (NO
/// transcript scan here — that lives in `resolve_cwds`, which must stay fast) and `unread` per
/// the baseline / viewed / open-path rules in `compute_unread`. It also reads a bounded head of
/// each file and runs `split_frontmatter` → `extract_h1s` to harvest the sidebar-filter
/// headings, then orders the records newest-first via `sort_newest_first`.
#[tauri::command]
fn list_plans(state: tauri::State<'_, Mutex<AppState>>) -> Vec<PlanRecord> {
    // Snapshot what we need from the lock, then release it before doing any I/O.
    let (cwd_cache, baseline_ms, viewed, open_path) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        (
            guard.cwd_cache.clone(),
            guard.read_state.baseline_ms,
            guard.read_state.viewed.clone(),
            guard.open_path.clone(),
        )
    };

    let Some(dir) = plans_dir() else {
        return Vec::new();
    };

    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(), // dir missing / not yet created
    };

    let mut records: Vec<PlanRecord> = Vec::new();

    for entry in read_dir.flatten() {
        let path = entry.path();
        // *.md files only.
        let is_md = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // can't stat — skip
        };
        if !metadata.is_file() {
            continue;
        }
        let mtime = match metadata.modified() {
            Ok(t) => t,
            Err(_) => continue, // platform without mtime — skip
        };

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let abs = path.to_string_lossy().to_string();
        let mtime_ms = system_time_to_ms(mtime);

        let cwd = cwd_cache.get(&stem).cloned();
        let unread = unread_for_row(
            &abs,
            mtime_ms,
            viewed.get(&abs).copied(),
            baseline_ms,
            open_path.as_deref(),
        );

        // Bounded head-read: enough to capture any leading frontmatter block. A codepoint
        // split at the byte cap is harmless — the lossy decode never panics on a split
        // multibyte sequence.
        let head = read_head_string(&path, FRONTMATTER_HEAD_BYTES);
        // Split frontmatter once and scan the body half for ATX H1 headings (the yaml half
        // is discarded). Near-zero added I/O — same bounded head read that already runs on
        // every entry / `plan-changed`.
        let h1s = match head.as_deref() {
            Some(h) => {
                let (_yaml, body) = split_frontmatter(h);
                extract_h1s(body)
            }
            None => Vec::new(),
        };

        records.push(PlanRecord {
            absolute_path: abs,
            filename_stem: stem,
            mtime_ms,
            cwd,
            unread,
            h1s,
        });
    }

    // Order newest-first by mtime.
    sort_newest_first(&mut records);

    records
}

/// Bytes of the head of each plan file read by `list_plans`. Any leading YAML frontmatter
/// block sits in the first few lines; ~8 KB is a generous bound that still keeps
/// `list_plans` cheap for the ~73 small files in a typical corpus.
const FRONTMATTER_HEAD_BYTES: usize = 8 * 1024;

/// Read up to `cap` bytes from the head of `path` and lossy-decode (mirrors
/// `read_plan_contents`' decode). Returns `None` on any I/O error (the file is simply
/// treated as having no marker). A codepoint split at the cap is harmless.
fn read_head_string(path: &Path, cap: usize) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; cap];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Sort plan records newest-first (largest `mtime_ms` at index 0). Extracted from
/// `list_plans` so the ordering invariant is unit-testable without touching the real
/// plans dir.
fn sort_newest_first(records: &mut [PlanRecord]) {
    records.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
}

/// THE single source of truth for the frontmatter boundary — used by BOTH `list_plans`
/// (head-parse for the marker) and `read_plan_contents` (strip the marker from the body).
/// They MUST never disagree, so there is exactly one parser.
///
/// If `content` begins (at line 1) with a `---` fence line and a later `---` fence line
/// closes it, returns `(Some(yaml_block_between_fences), body_after_closing_fence)`. Else
/// `(None, content)`. Only a LEADING block counts — a mid-document `---` thematic break is
/// never treated as an opening fence (and so is never stripped). Tolerates trailing
/// whitespace on a fence line and both `\n` / `\r\n` line endings, so the two read paths
/// can never disagree on where the body begins.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    // A fence line is exactly `---` after trimming trailing whitespace (CR included).
    fn is_fence(line: &str) -> bool {
        line.trim_end() == "---"
    }

    // The first line must be an opening fence. Find its byte span (incl. the newline).
    let first_line_end = content.find('\n').map(|i| i + 1).unwrap_or(content.len());
    let first_line = &content[..first_line_end];
    if !is_fence(first_line) {
        return (None, content);
    }

    // Scan subsequent lines for the CLOSING fence.
    let mut cursor = first_line_end;
    let yaml_start = first_line_end;
    while cursor < content.len() {
        let rest = &content[cursor..];
        let line_end_rel = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
        let line = &rest[..line_end_rel];
        if is_fence(line) {
            // yaml block is everything between the two fences (excludes both fence lines).
            let yaml = &content[yaml_start..cursor];
            let body = &content[cursor + line_end_rel..];
            return (Some(yaml), body);
        }
        cursor += line_end_rel;
    }

    // Opening fence but no closing fence ⇒ NOT frontmatter; pass through unchanged.
    (None, content)
}

/// Extract the ATX H1 heading texts from a plan body, in document order. FENCE-AWARE: a
/// line whose trimmed-start opens or closes a ``` / ~~~ fenced code block toggles an
/// "inside fence" flag, and ALL lines inside a fence are skipped — so a `# Comment` line in
/// a code block is NOT harvested as a heading (a fence-blind scan would wrongly collect it;
/// at least one real corpus plan has ~25 such `#` lines inside a `python` fence).
///
/// Outside fences we collect ONLY ATX H1: a line whose content (after stripping a leading
/// `> ` is NOT considered — only a leading `# ` exactly) starts with `# ` (one hash then a
/// space) and whose heading text is the trimmed remainder. `## ` (H2+) and `#NoSpace` (no
/// following space) are excluded. The empty-string heading (`# ` with nothing after) yields
/// an empty string entry — but in practice the title line always carries text.
fn extract_h1s(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed_start = line.trim_start();
        // A fence open/close is a line whose trimmed-start begins with ``` or ~~~.
        if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // ATX H1: exactly one leading `#` followed by a space. `## ` (the char after the
        // first `#` is another `#`) and `#NoSpace` are excluded.
        if let Some(rest) = trimmed_start.strip_prefix("# ") {
            // `strip_prefix("# ")` already requires `#` + space, so `## x` (starts with
            // `##`) and `#x` (no space) do not match. Trim the heading text.
            out.push(rest.trim().to_string());
        }
    }
    out
}

/// Read a plan's raw text. Defends against path traversal by canonicalizing BOTH the
/// requested path and the plans-root and verifying containment. Canonicalizing both sides
/// also defends against a symlinked $HOME. Never panics on bad UTF-8 — lossy-decodes.
#[tauri::command]
fn read_plan_contents(path: String) -> Result<String, String> {
    let root = plans_dir().ok_or_else(|| "could not locate home directory".to_string())?;

    // Canonicalize the plans root. If it doesn't exist, there's nothing to read.
    let canon_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("plans dir unavailable: {e}"))?;

    let requested = Path::new(&path);
    let canon_path = std::fs::canonicalize(requested)
        .map_err(|e| format!("cannot resolve path: {e}"))?;

    // Containment check: the resolved path must live inside the resolved plans root.
    if !is_within(&canon_root, &canon_path) {
        return Err("path is outside the plans directory".to_string());
    }

    // Only serve regular files.
    let meta = std::fs::metadata(&canon_path).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }

    // Read bytes and lossy-decode so invalid UTF-8 never panics.
    let bytes = std::fs::read(&canon_path).map_err(|e| format!("read failed: {e}"))?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    // Strip a leading frontmatter block so the reading pane never renders it. Uses the SAME
    // `split_frontmatter` as `list_plans` (single source of truth — the two read paths can
    // never disagree on the boundary). Plans without frontmatter pass through byte-for-byte
    // unchanged.
    let (_yaml, body) = split_frontmatter(&content);
    Ok(body.to_string())
}

/// Map a (lower-cased) file extension to the MIME type we will embed in the `data:` URL.
/// Returns `None` for anything not in the image allow-list. Pure — the single source of
/// truth for both "is this a supported image?" and "what MIME tag does it get?".
fn mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// True iff `ext` is a supported image extension (case-insensitive). Derived from
/// `mime_for_ext` so the allow-list can never drift between the two. Part of the documented
/// helper surface and exercised by the allow-list tests; the core fn uses `mime_for_ext`
/// directly (it needs the MIME string), hence `allow(dead_code)` for the non-test build.
#[allow(dead_code)]
fn is_supported_image_ext(ext: &str) -> bool {
    mime_for_ext(ext).is_some()
}

/// True iff a file of `len` bytes is within the inline-image size cap. Pure boundary check,
/// extracted so the 25 MiB limit is unit-testable at the exact boundary without writing a
/// 25 MiB file. The cap is INCLUSIVE: exactly `MAX_IMAGE_BYTES` is allowed, one byte more is not.
fn within_size_cap(len: u64) -> bool {
    len <= MAX_IMAGE_BYTES
}

/// Core, Tauri-free implementation: take an already-resolved `&Path`, run the image guards,
/// and produce a `data:<mime>;base64,<encoded>` URL. Kept separate from the
/// `#[tauri::command]` wrapper so every guard is unit-testable with a plain path.
///
/// Guards, in order:
///   1. must be a regular file,
///   2. extension (case-insensitive) must be in the image allow-list,
///   3. on-disk size must be within `MAX_IMAGE_BYTES` (checked BEFORE reading bytes),
///   4. read + base64-encode.
///
/// NOTE: unlike `read_plan_contents`, this intentionally does NOT contain the path to the
/// plans dir — images legitimately live in project dirs, /tmp, etc. The extension + size +
/// is_file guards are the intended bound.
fn read_image_as_data_url_core(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let mime = mime_for_ext(ext).ok_or_else(|| "unsupported image type".to_string())?;

    // Size cap BEFORE reading bytes — never load a huge file into memory just to reject it.
    if !within_size_cap(meta.len()) {
        return Err("image too large".to_string());
    }

    let bytes = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    let encoded = BASE64.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Load a LOCAL image file and return it as a `data:` URL the WebView can render directly
/// (the WebView cannot fetch `file://`). Mirrors `read_plan_contents`' error-string idiom.
/// Canonicalizes the path first so symlinks / `..` are resolved before the guards run.
#[tauri::command]
fn read_image_as_data_url(path: String) -> Result<String, String> {
    let requested = Path::new(&path);
    let canon_path = std::fs::canonicalize(requested)
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    read_image_as_data_url_core(&canon_path)
}

// ============================================================================
// Managed AppState, persisted cwd cache + read/unread state, and the
// single-pass, priority-preserving cwd resolver.
// ============================================================================

/// Persisted read/unread state. `baseline_ms` is the first-launch seed: every plan whose
/// mtime predates the baseline counts as already read (we never write 72 per-plan entries).
/// `viewed[absolute_path] = last_viewed_ms` overrides the baseline per plan once opened.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct ReadState {
    baseline_ms: i64,
    viewed: HashMap<String, i64>,
}

/// Tauri-managed state (keyed by type, alongside the debouncer `Mutex`). Held behind a
/// `std::sync::Mutex<AppState>`. The lock is NEVER held across blocking file I/O or an
/// `.await` — callers clone the small maps under the lock, release, then persist.
#[derive(Default)]
struct AppState {
    /// filename_stem -> resolved cwd. Only SUCCESSFUL resolutions are kept (sticky).
    cwd_cache: HashMap<String, String>,
    read_state: ReadState,
    /// Absolute path of the currently-open plan (read by fiat).
    open_path: Option<String>,
    /// Directory under which `cwd-cache.json` / `read-state.json` live. `None` ⇒ in-memory
    /// only (app_data_dir / create_dir_all failed); all persistence then silently no-ops.
    data_dir: Option<PathBuf>,
    /// plan absolute_path → its comments. ABSENT means no comments. Persisted to
    /// `comments.json`. The backend is the single source of truth for the comment count.
    comments: HashMap<String, Vec<CommentRecord>>,
}

const CWD_CACHE_FILE: &str = "cwd-cache.json";
const READ_STATE_FILE: &str = "read-state.json";
const COMMENTS_FILE: &str = "comments.json";

/// Current wall-clock time in millis since the epoch. Never panics (clock skew before the
/// epoch maps to a negative value, consistent with `system_time_to_ms`).
fn now_ms() -> i64 {
    system_time_to_ms(SystemTime::now())
}

/// Pure unread rule: a plan is unread iff its mtime is strictly newer than the effective
/// "last viewed" time. The effective time is the per-plan `viewed` stamp when present,
/// else the first-launch `baseline_ms`. So a pre-baseline plan with no view stamp is read;
/// a post-baseline (new / changed-after-seed) plan is unread.
fn compute_unread(mtime_ms: i64, viewed_ms: Option<i64>, baseline_ms: i64) -> bool {
    let effective = viewed_ms.unwrap_or(baseline_ms);
    mtime_ms > effective
}

/// Per-row unread decision for `list_plans`: the open plan is read by fiat (a plan being
/// live-edited while open must never re-bold), otherwise apply the baseline/viewed rule.
/// Pure so the fiat invariant is unit-testable without Tauri state injection.
fn unread_for_row(
    abs_path: &str,
    mtime_ms: i64,
    viewed_ms: Option<i64>,
    baseline_ms: i64,
    open_path: Option<&str>,
) -> bool {
    if open_path == Some(abs_path) {
        return false;
    }
    compute_unread(mtime_ms, viewed_ms, baseline_ms)
}

/// Collapse a leading `$HOME` into `~` for display. Pure; if `home` is empty or `path`
/// doesn't start with it, returns `path` unchanged. The boundary check (next char is `/`
/// or end-of-string) prevents `/Users/bob-other` collapsing under home `/Users/bob`.
///
/// The PRODUCTION home-collapse runs in the frontend (`src/main.ts` `collapseHome`) because
/// the resolved cwd is patched into the DOM there. This Rust mirror exists as a documented,
/// unit-tested reference of the exact rule (hence `allow(dead_code)` for the non-test build).
#[allow(dead_code)]
fn collapse_home(path: &str, home: &str) -> String {
    if home.is_empty() || !path.starts_with(home) {
        return path.to_string();
    }
    let rest = &path[home.len()..];
    if rest.is_empty() {
        "~".to_string()
    } else if let Some(stripped) = rest.strip_prefix('/') {
        format!("~/{stripped}")
    } else {
        // home is a prefix but not at a path boundary (e.g. /Users/bob vs /Users/bobby).
        path.to_string()
    }
}

/// Atomically write `bytes` to `target`: write a temp file in the SAME directory, then
/// `rename` over the target (atomic on one filesystem; no truncate-mid-write corruption).
/// Returns Err on any I/O failure — callers log and degrade, never panic.
fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "target has no parent dir")
    })?;
    // Unique-ish temp name in the same dir so rename stays on one filesystem.
    let pid = std::process::id();
    let stamp = now_ms();
    let tmp = parent.join(format!(".tmp-{pid}-{stamp}-{}", nanos_suffix()));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp); // best-effort cleanup
            Err(e)
        }
    }
}

/// Sub-nanosecond entropy for the temp-file name (avoids collisions within the same ms).
fn nanos_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Load the persisted cwd cache. Absent ⇒ empty. Corrupt/unparseable ⇒ log + empty WITHOUT
/// rewriting the bad file (non-destructive). Never panics.
fn load_cwd_cache(dir: &Path) -> HashMap<String, String> {
    let path = dir.join(CWD_CACHE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(), // absent ⇒ empty
    };
    match serde_json::from_slice::<HashMap<String, String>>(&bytes) {
        Ok(map) => map,
        Err(e) => {
            eprintln!("[state] {CWD_CACHE_FILE} is corrupt ({e}); ignoring (in-memory only)");
            HashMap::new()
        }
    }
}

/// Load the persisted read-state. Absent ⇒ empty + `baseline_ms = now` (seed). Corrupt ⇒
/// log + empty WITHOUT re-seeding a fresh baseline that would silently mark a changed corpus
/// all-read, and WITHOUT rewriting the bad file. The `seeded` flag tells the caller whether
/// it should persist the freshly-seeded baseline (only on a clean absent load).
fn load_read_state(dir: &Path) -> (ReadState, bool) {
    let path = dir.join(READ_STATE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            // Absent ⇒ seed baseline-as-read at first launch.
            return (
                ReadState {
                    baseline_ms: now_ms(),
                    viewed: HashMap::new(),
                },
                true,
            );
        }
    };
    match serde_json::from_slice::<ReadState>(&bytes) {
        Ok(rs) => (rs, false),
        Err(e) => {
            eprintln!(
                "[state] {READ_STATE_FILE} is corrupt ({e}); ignoring without re-seeding \
                 baseline (in-memory only, baseline=0 so nothing is force-marked read)"
            );
            // Degrade to empty. baseline_ms=0 means absent-entry plans are treated as
            // unread (mtime > 0) rather than silently all-read — the safe failure mode.
            (ReadState::default(), false)
        }
    }
}

/// Persist the cwd cache atomically. No-op (logs) when there's no data dir or on write error.
fn persist_cwd_cache(data_dir: &Option<PathBuf>, cache: &HashMap<String, String>) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(cache) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize cwd cache: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(CWD_CACHE_FILE), &bytes) {
        eprintln!("[state] failed to persist {CWD_CACHE_FILE}: {e}");
    }
}

/// Persist the read-state atomically. No-op (logs) when there's no data dir or on write error.
fn persist_read_state(data_dir: &Option<PathBuf>, rs: &ReadState) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(rs) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize read-state: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(READ_STATE_FILE), &bytes) {
        eprintln!("[state] failed to persist {READ_STATE_FILE}: {e}");
    }
}

/// Load the persisted comments map. Absent ⇒ empty. Corrupt/unparseable ⇒ log + empty WITHOUT
/// rewriting the bad file (non-destructive). Never panics. Exact shape-twin of
/// `load_cwd_cache`.
fn load_comments(dir: &Path) -> HashMap<String, Vec<CommentRecord>> {
    let path = dir.join(COMMENTS_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(), // absent ⇒ empty (no comments)
    };
    match serde_json::from_slice::<HashMap<String, Vec<CommentRecord>>>(&bytes) {
        Ok(map) => map,
        Err(e) => {
            eprintln!(
                "[state] {COMMENTS_FILE} is corrupt ({e}); ignoring (no comments, in-memory only)"
            );
            HashMap::new()
        }
    }
}

/// Persist the comments map atomically. No-op (logs) when there's no data dir or on write
/// error. Exact shape-twin of `persist_cwd_cache`.
fn persist_comments(data_dir: &Option<PathBuf>, map: &HashMap<String, Vec<CommentRecord>>) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(map) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize comments: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(COMMENTS_FILE), &bytes) {
        eprintln!("[state] failed to persist {COMMENTS_FILE}: {e}");
    }
}

// ---- cwd resolver ----------------------------------------------------------

/// Provenance of a stem→cwd match, in priority order. `PlanModeAttachment` is authoritative
/// and is NEVER downgraded by a later weaker match (the acceptance gate, preserved
/// per-stem across the single corpus pass).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Provenance {
    LineContains = 1,     // last resort
    WriteFilePath = 2,    // fallback
    PlanModeAttachment = 3, // authoritative
}

/// A resolved (or partially-resolved) stem entry built up across the corpus pass.
#[derive(Debug, Clone)]
struct Resolution {
    cwd: Option<String>,
    provenance: Provenance,
}

/// The projects transcript root (`~/.claude/projects`). Returns None if home is unlocatable.
fn projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Enumerate every transcript file under `root`: top-level `<session>.jsonl` files AND
/// `<session>/subagents/agent-*.jsonl`. Takes the root as a parameter so tests can point it
/// at a fabricated temp corpus.
fn collect_transcripts(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(project_dirs) = std::fs::read_dir(root) else {
        return out;
    };
    for proj in project_dirs.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&proj_path) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    out.push(p.clone());
                }
                if p.is_dir() {
                    let sub = p.join("subagents");
                    if let Ok(subs) = std::fs::read_dir(&sub) {
                        for se in subs.flatten() {
                            let sp = se.path();
                            let is_agent_jsonl = sp
                                .file_name()
                                .and_then(|n| n.to_str())
                                .map(|n| n.starts_with("agent-") && n.ends_with(".jsonl"))
                                .unwrap_or(false);
                            if is_agent_jsonl {
                                out.push(sp);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// First top-level `cwd` value found across the transcript's lines. (All records in one
/// transcript share the session cwd.)
fn first_cwd(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                return Some(c.to_string());
            }
        }
    }
    None
}

/// Extract a `Write` tool_use's `input.file_path` from a record, if present.
fn write_file_path(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?.as_array()?;
    for c in content {
        if c.get("type").and_then(|t| t.as_str()) == Some("tool_use")
            && c.get("name").and_then(|n| n.as_str()) == Some("Write")
        {
            if let Some(fp) = c
                .get("input")
                .and_then(|i| i.get("file_path"))
                .and_then(|f| f.as_str())
            {
                return Some(fp.to_string());
            }
        }
    }
    None
}

/// Order transcripts so the resolution pass is DETERMINISTIC and same-provenance ties resolve
/// to the most-recent session. `collect_transcripts` yields files in raw `read_dir` order
/// (unsorted, OS-dependent), and `offer` keeps the first-seen match on a provenance tie — so
/// without this sort a stem with two equally-authoritative (or two last-resort) matches in
/// different transcripts would resolve to whichever file `read_dir` happened to yield first,
/// which can differ across runs. We sort **newest-mtime-first** (a plan's "current" cwd is its
/// most recent session), breaking remaining ties by path descending for full determinism.
fn sort_transcripts_newest_first(transcripts: &mut [PathBuf]) {
    transcripts.sort_by(|a, b| {
        let ma = std::fs::metadata(a)
            .and_then(|m| m.modified())
            .map(system_time_to_ms)
            .unwrap_or(i64::MIN);
        let mb = std::fs::metadata(b)
            .and_then(|m| m.modified())
            .map(system_time_to_ms)
            .unwrap_or(i64::MIN);
        // mtime descending, then path descending (stable, fully deterministic tie-break).
        mb.cmp(&ma).then_with(|| b.cmp(a))
    });
}

/// Consider one matched-stem candidate against the running best for that stem. Records the
/// candidate only if it has strictly higher provenance than what's already there — so an
/// authoritative `plan_mode` match is never downgraded by a later `Write`/`LineContains`
/// match in another transcript, REGARDLESS of transcript visitation order. On a provenance
/// TIE the first-seen wins, which — because the pass visits transcripts newest-mtime-first
/// (see `sort_transcripts_newest_first`) — means the most-recent session's cwd wins.
fn offer(best: &mut HashMap<String, Resolution>, stem: &str, cand: Resolution) {
    match best.get(stem) {
        Some(existing) if existing.provenance >= cand.provenance => {
            // Keep the existing higher-or-equal-priority resolution (first-wins on ties).
        }
        _ => {
            best.insert(stem.to_string(), cand);
        }
    }
}

/// Single corpus pass: resolve the WHOLE set of requested `stems` against `transcripts`,
/// preserving per-stem provenance priority. Pure (takes the transcript list); reads each
/// file at most once. Returns the full requested map with `None` for unresolved stems.
fn resolve_stems(stems: &[String], transcripts: &[PathBuf]) -> HashMap<String, Option<String>> {
    // Pre-compute the `/plans/<stem>.md` suffix for every requested stem once.
    let suffixes: Vec<(String, String)> = stems
        .iter()
        .map(|s| (s.clone(), format!("/plans/{s}.md")))
        .collect();

    // Deterministic, newest-session-wins tie-break: sort an owned copy newest-mtime-first so
    // the pass order does NOT depend on how the caller (or `read_dir`) ordered the slice.
    let mut ordered: Vec<PathBuf> = transcripts.to_vec();
    sort_transcripts_newest_first(&mut ordered);

    let mut best: HashMap<String, Resolution> = HashMap::new();

    for fp in &ordered {
        let Ok(text) = std::fs::read_to_string(fp) else {
            continue;
        };

        // Which requested stems does this file even mention? Cheap pre-filter.
        let mentioned: Vec<&(String, String)> = suffixes
            .iter()
            .filter(|(_, suffix)| text.contains(suffix.as_str()))
            .collect();
        if mentioned.is_empty() {
            continue;
        }

        let session_cwd = first_cwd(&text);

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            // Record-level cwd (falls back to the session cwd).
            let record_cwd = || {
                v.get("cwd")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| session_cwd.clone())
            };

            // (1) AUTHORITATIVE — plan_mode attachment.
            if let Some(att) = v.get("attachment") {
                if att.get("type").and_then(|t| t.as_str()) == Some("plan_mode") {
                    if let Some(pfp) = att.get("planFilePath").and_then(|p| p.as_str()) {
                        for (stem, suffix) in &mentioned {
                            if pfp.ends_with(suffix.as_str()) {
                                offer(
                                    &mut best,
                                    stem,
                                    Resolution {
                                        cwd: record_cwd(),
                                        provenance: Provenance::PlanModeAttachment,
                                    },
                                );
                            }
                        }
                    }
                }
            }

            // (2) FALLBACK — Write tool_use input.file_path.
            if let Some(fpath) = write_file_path(&v) {
                for (stem, suffix) in &mentioned {
                    if fpath.ends_with(suffix.as_str()) {
                        offer(
                            &mut best,
                            stem,
                            Resolution {
                                cwd: record_cwd(),
                                provenance: Provenance::WriteFilePath,
                            },
                        );
                    }
                }
            }
        }

        // (3) LAST RESORT — the file mentions a stem but no structured match was recorded
        // for it. Use the session cwd at the weakest priority (never downgrades a stronger
        // match thanks to `offer`).
        for (stem, _suffix) in &mentioned {
            offer(
                &mut best,
                stem,
                Resolution {
                    cwd: session_cwd.clone(),
                    provenance: Provenance::LineContains,
                },
            );
        }
    }

    // Materialize the FULL requested map (None for unresolved / cwd-less stems).
    let mut out: HashMap<String, Option<String>> = HashMap::new();
    for s in stems {
        let resolved = best.get(s).and_then(|r| r.cwd.clone());
        out.insert(s.clone(), resolved);
    }
    out
}

// ---- open-plan + read-state commands ---------------------------------------

/// Record the currently-open plan (or `null` when nothing is selected). The open plan is
/// read by fiat in `list_plans`, so this is what keeps a live-edited open plan from re-bolding.
#[tauri::command]
fn set_open_plan(path: Option<String>, state: tauri::State<'_, Mutex<AppState>>) {
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.open_path = path;
}

/// Mark a plan viewed: `viewed[path] = max(now_ms, file_mtime_ms + 1)`. The `max` clamp
/// prevents an edit landing at the same instant from out-stamping the recorded view. If the
/// file can't be stat'd, fall back to `now_ms`. Persists atomically (outside the lock).
#[tauri::command]
fn mark_viewed(path: String, state: tauri::State<'_, Mutex<AppState>>) {
    let now = now_ms();
    let stamp = match file_mtime_ms(&path) {
        Some(mtime) => now.max(mtime + 1),
        None => now,
    };

    let (snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.read_state.viewed.insert(path, stamp);
        (guard.read_state.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_read_state(&data_dir, &snapshot);
}

// ---- comment commands ------------------------------------------------------
//
// The backend is the SINGLE SOURCE OF TRUTH for the comment count. `set_comments`/
// `clear_comments` return the authoritative resulting array so the frontend can adopt it as
// its per-path cache (cache == last backend-confirmed value); `get_comment_count` is the
// cold-read path that answers the count for a plan WITHOUT loading its array frontend-side.
// All four follow the snapshot-then-persist-outside-lock discipline (the std Mutex is never
// held across the blocking `atomic_write`).

/// Read all comments for a plan (empty when none).
#[tauri::command]
fn get_comments(path: String, state: tauri::State<'_, Mutex<AppState>>) -> Vec<CommentRecord> {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.comments.get(&path).cloned().unwrap_or_default()
}

/// Cold-read the comment count for a plan WITHOUT loading its array into the frontend cache
/// (the count must persist when the pane is empty or a different plan is open). This is the
/// 02→03 contract surface — NOT redundant with `array.length`, which only answers for the
/// currently-open, loaded plan.
#[tauri::command]
fn get_comment_count(path: String, state: tauri::State<'_, Mutex<AppState>>) -> usize {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.comments.get(&path).map(|v| v.len()).unwrap_or(0)
}

/// THE pure map transition for `set_comments` (extracted so the return-after-mutation contract
/// is unit-testable WITHOUT Tauri state). Full-array replacement: a non-empty array inserts/
/// replaces the key; an EMPTY array REMOVES the key (so the persisted map never accumulates
/// empty entries). Returns the AUTHORITATIVE resulting array (what the frontend adopts as its
/// cache) — on success this equals the post-mutation stored value for the key.
fn apply_set_comments(
    map: &mut HashMap<String, Vec<CommentRecord>>,
    path: String,
    comments: Vec<CommentRecord>,
) -> Vec<CommentRecord> {
    if comments.is_empty() {
        map.remove(&path);
    } else {
        map.insert(path.clone(), comments);
    }
    map.get(&path).cloned().unwrap_or_default()
}

/// THE pure map transition for `clear_comments` (extracted alongside `apply_set_comments`).
/// Wipes all comments for a plan; returns the resulting (empty) array.
fn apply_clear_comments(
    map: &mut HashMap<String, Vec<CommentRecord>>,
    path: &str,
) -> Vec<CommentRecord> {
    map.remove(path);
    map.get(path).cloned().unwrap_or_default()
}

/// Full-array replacement of a plan's comments. An EMPTY array removes the key entirely (so
/// the persisted map never accumulates empty entries). Returns the AUTHORITATIVE resulting
/// array so the frontend adopts it as its cache (one round-trip, no separate count query).
#[tauri::command]
fn set_comments(
    path: String,
    comments: Vec<CommentRecord>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Vec<CommentRecord> {
    let (result, snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let result = apply_set_comments(&mut guard.comments, path, comments);
        (result, guard.comments.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_comments(&data_dir, &snapshot);
    result
}

/// Wipe all comments for a plan. Returns the resulting (empty) array.
#[tauri::command]
fn clear_comments(path: String, state: tauri::State<'_, Mutex<AppState>>) -> Vec<CommentRecord> {
    let (result, snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let result = apply_clear_comments(&mut guard.comments, &path);
        (result, guard.comments.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_comments(&data_dir, &snapshot);
    result
}

/// Stat a file and return its mtime in millis, or None on any failure.
fn file_mtime_ms(path: &str) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    Some(system_time_to_ms(mtime))
}

/// Resolve the cwd for the requested still-unknown `stems` in ONE corpus pass. Async: the
/// blocking scan runs on `spawn_blocking` so the (potentially thousands of files) pass never
/// blocks the main thread or other commands. Updates the in-memory cache + atomically
/// persists `cwd-cache.json` for the `Some` results, and returns the full requested map
/// (incl. `None` for unresolved stems).
#[tauri::command]
async fn resolve_cwds(
    stems: Vec<String>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<HashMap<String, Option<String>>, String> {
    if stems.is_empty() {
        return Ok(HashMap::new());
    }

    // Run the blocking corpus scan off the main thread. We do NOT hold the std Mutex across
    // this await (we don't touch it inside the closure at all).
    let scan_stems = stems.clone();
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = projects_root() else {
            // No projects root ⇒ everything unresolved.
            return scan_stems.iter().map(|s| (s.clone(), None)).collect();
        };
        let transcripts = collect_transcripts(&root);
        resolve_stems(&scan_stems, &transcripts)
    })
    .await
    .map_err(|e| format!("resolve scan failed: {e}"))?;

    // Update the in-memory cache for the Some results, snapshot it, release the lock.
    let (cache_snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        for (stem, cwd) in &resolved {
            if let Some(c) = cwd {
                guard.cwd_cache.insert(stem.clone(), c.clone());
            }
        }
        (guard.cwd_cache.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_cwd_cache(&data_dir, &cache_snapshot);

    Ok(resolved)
}

/// Build the initial `AppState`: locate + create the data dir, load both persisted files
/// (degrading on any failure), and seed the read-state baseline on first launch. Pure-ish:
/// takes the resolved data dir Option so `setup()` can wire it from `app.path()`.
fn init_app_state(data_dir: Option<PathBuf>) -> AppState {
    let (cwd_cache, read_state, seed_baseline, comments) = match &data_dir {
        Some(dir) => {
            let cwd_cache = load_cwd_cache(dir);
            let (read_state, seeded) = load_read_state(dir);
            let comments = load_comments(dir);
            (cwd_cache, read_state, seeded, comments)
        }
        None => {
            // In-memory only. baseline_ms = now so a session without persistence still
            // treats the existing corpus as read (matches first-launch semantics).
            (
                HashMap::new(),
                ReadState {
                    baseline_ms: now_ms(),
                    viewed: HashMap::new(),
                },
                false,
                HashMap::new(),
            )
        }
    };

    let state = AppState {
        cwd_cache,
        read_state,
        open_path: None,
        data_dir: data_dir.clone(),
        comments,
    };

    // Persist the freshly-seeded baseline so a relaunch keeps the same baseline (only on a
    // clean absent load — never overwrite a corrupt file).
    if seed_baseline {
        persist_read_state(&state.data_dir, &state.read_state);
    }

    state
}

fn event_kind_label(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Access(_) => "access",
        EventKind::Any => "any",
        EventKind::Other => "other",
    }
}

/// Start the debounced watcher on the plans dir (non-recursive). Emits `plan-changed`
/// for any debounced event touching a `*.md` path. Tolerates a not-yet-existing dir.
/// Returns the live debouncer so the caller can keep it alive for the app's lifetime.
fn start_watcher(app: tauri::AppHandle) -> Option<impl Sized> {
    let dir = plans_dir()?;

    let app_for_handler = app.clone();
    let mut debouncer = match new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(errs) => {
                    for e in errs {
                        eprintln!("[watcher] debounce error: {e:?}");
                    }
                    return;
                }
            };

            for ev in events {
                // Handle create / modify / remove (plus the catch-all Any). The notify
                // crate's EventKind has NO Rename variant: atomic saves (temp-write +
                // rename) surface as Modify(Name)/Remove/Create, which we label
                // modify/remove/create — never a literal "rename". The RecommendedCache
                // file-ID tracking inside the debouncer is what makes this reliable.
                let kind = ev.kind;
                let interesting = matches!(
                    kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
                );
                if !interesting {
                    continue;
                }
                for p in ev.paths.iter() {
                    let is_md = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("md"))
                        .unwrap_or(false);
                    if !is_md {
                        continue;
                    }
                    let payload = PlanChanged {
                        path: p.to_string_lossy().to_string(),
                        kind: event_kind_label(&kind).to_string(),
                    };
                    let label = payload.kind.clone();
                    let p_disp = payload.path.clone();
                    if let Err(e) = app_for_handler.emit("plan-changed", payload) {
                        eprintln!("[watcher] emit failed: {e:?}");
                    } else {
                        println!("[watcher] emitted plan-changed ({label}): {p_disp}");
                    }
                }
            }
        },
    ) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[watcher] failed to create debouncer: {e:?}");
            return None;
        }
    };

    // The dir may not exist yet; watching a missing path errors. Tolerate it by logging
    // and returning the debouncer anyway (it just won't fire until 03 or the user creates
    // the dir; re-watch-on-create is a later concern).
    match debouncer.watch(&dir, RecursiveMode::NonRecursive) {
        Ok(()) => {
            println!("[watcher] watching {}", dir.display());
        }
        Err(e) => {
            eprintln!(
                "[watcher] could not watch {} (dir may not exist yet): {e:?}",
                dir.display()
            );
        }
    }

    Some(debouncer)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Manage AppState UNCONDITIONALLY (independent of watcher success) so the `State`
            // extractor in list_plans / mark_viewed / etc. can never hit "state not managed".
            // Locate + create the data dir; all persistence degrades to
            // in-memory on any failure (never panics).
            let data_dir = match app.path().app_data_dir() {
                Ok(dir) => match std::fs::create_dir_all(&dir) {
                    Ok(()) => Some(dir),
                    Err(e) => {
                        eprintln!(
                            "[state] could not create app_data_dir {} ({e}); running in-memory only",
                            dir.display()
                        );
                        None
                    }
                },
                Err(e) => {
                    eprintln!("[state] app_data_dir unavailable ({e}); running in-memory only");
                    None
                }
            };
            app.manage(Mutex::new(init_app_state(data_dir)));

            // Keep the debouncer alive for the lifetime of the app by stashing it in
            // managed state. Dropping it would stop the watch thread.
            if let Some(debouncer) = start_watcher(app.handle().clone()) {
                app.manage(Mutex::new(debouncer));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_plans,
            read_plan_contents,
            read_image_as_data_url,
            set_open_plan,
            mark_viewed,
            resolve_cwds,
            get_comments,
            get_comment_count,
            set_comments,
            clear_comments
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn record_with_mtime(stem: &str, mtime_ms: i64) -> PlanRecord {
        PlanRecord {
            absolute_path: format!("/tmp/{stem}.md"),
            filename_stem: stem.to_string(),
            mtime_ms,
            cwd: None,
            unread: false,
            h1s: Vec::new(),
        }
    }

    /// Locks the `PlanRecord` wire shape to the frozen hand-off contract (CONTRACT.md).
    /// Any serde drift — a `rename`, an added/removed field, or a casing change — flips
    /// the top-level key set and turns this RED.
    #[test]
    fn planrecord_wire_contract_is_frozen() {
        use std::collections::BTreeSet;

        // The exact, frozen set of top-level JSON keys (snake_case).
        let expected_keys: BTreeSet<&str> = [
            "absolute_path",
            "filename_stem",
            "mtime_ms",
            "cwd",
            "unread",
            "h1s",
        ]
        .into_iter()
        .collect();

        // A record exercising the always-present scalar fields, a populated cwd, and a
        // non-empty h1s list.
        let record = PlanRecord {
            absolute_path: "/tmp/plan.md".to_string(),
            filename_stem: "plan".to_string(),
            mtime_ms: 1,
            cwd: Some("/Users/u/work".to_string()),
            unread: true,
            h1s: vec!["Plan: title".to_string()],
        };

        let value = serde_json::to_value(&record).unwrap();
        let obj = value
            .as_object()
            .expect("PlanRecord must serialize to a JSON object");

        // Top-level key set must equal the frozen contract exactly — no more, no less.
        let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(
            actual_keys, expected_keys,
            "PlanRecord top-level JSON keys drifted from the frozen contract"
        );

        // Value TYPES of the always-present scalar fields must match the contract, so a
        // value-type drift (e.g. mtime_ms number->String) that keeps key names still turns
        // this RED.
        assert!(obj["absolute_path"].is_string(), "absolute_path must be a JSON string");
        assert!(obj["filename_stem"].is_string(), "filename_stem must be a JSON string");
        assert!(obj["mtime_ms"].is_i64() || obj["mtime_ms"].is_u64(), "mtime_ms must be a JSON integer");
        assert!(obj["unread"].is_boolean(), "unread must be a JSON boolean");
        assert!(obj["cwd"].is_string(), "cwd must be a JSON string when populated");
        assert!(obj["h1s"].is_array(), "h1s must be a JSON array (always present)");

        // Contract: `cwd` is an always-present key; when the Rust value is `None` it must
        // serialize as JSON `null`, never be omitted.
        let none_cwd = record_with_mtime("none-cwd", 2); // cwd: None
        let none_value = serde_json::to_value(&none_cwd).unwrap();
        assert_eq!(
            none_value.get("cwd"),
            Some(&serde_json::Value::Null),
            "cwd must be present as JSON null when None, not omitted"
        );
    }

    // ---- system_time_to_ms ------------------------------------------------

    #[test]
    fn mtime_epoch_is_zero() {
        assert_eq!(system_time_to_ms(UNIX_EPOCH), 0);
    }

    #[test]
    fn mtime_known_post_epoch_is_correct_ms() {
        // 1_700_000_000_000 ms after the epoch (a real-ish 2023 timestamp).
        let known_ms: u64 = 1_700_000_000_000;
        let t = UNIX_EPOCH + Duration::from_millis(known_ms);
        assert_eq!(system_time_to_ms(t), known_ms as i64);
    }

    #[test]
    fn mtime_pre_epoch_does_not_panic_and_is_nonpositive() {
        // 5 seconds before the epoch — duration_since(UNIX_EPOCH) returns Err.
        let t = UNIX_EPOCH - Duration::from_secs(5);
        let ms = system_time_to_ms(t); // must not panic
        assert!(ms <= 0, "pre-epoch time should map to <= 0, got {ms}");
        assert_eq!(ms, -5_000);
    }

    // ---- sort_newest_first ------------------------------------------------

    #[test]
    fn sort_puts_largest_mtime_first() {
        let mut records = vec![
            record_with_mtime("oldest", 100),
            record_with_mtime("newest", 300),
            record_with_mtime("middle", 200),
        ];
        sort_newest_first(&mut records);
        let order: Vec<&str> = records.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(order, vec!["newest", "middle", "oldest"]);
        // Explicit: index 0 carries the strictly-largest mtime.
        assert_eq!(records[0].mtime_ms, 300);
        assert!(records[0].mtime_ms > records[1].mtime_ms);
        assert!(records[1].mtime_ms > records[2].mtime_ms);
    }

    #[test]
    fn sort_newest_first_from_real_temp_file_mtimes() {
        // Fabricate real temp files with distinct, explicitly-set mtimes and confirm the
        // helper orders them newest-first.
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_sort_test_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");

        let mut records = Vec::new();
        for (stem, ms) in [("a", 1_000i64), ("b", 3_000), ("c", 2_000)] {
            let p = dir.join(format!("{stem}.md"));
            std::fs::write(&p, b"x").expect("write temp file");
            records.push(PlanRecord {
                absolute_path: p.to_string_lossy().to_string(),
                filename_stem: stem.to_string(),
                mtime_ms: ms,
                cwd: None,
                unread: false,
                h1s: Vec::new(),
            });
        }

        sort_newest_first(&mut records);
        let order: Vec<&str> = records.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(order, vec!["b", "c", "a"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- is_within (path containment) ------------------------------------

    #[test]
    fn path_inside_root_is_accepted() {
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_within_ok_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        let inside = dir.join("plan.md");
        std::fs::write(&inside, b"x").expect("write");

        let canon_root = std::fs::canonicalize(&dir).expect("canon root");
        let canon_inside = std::fs::canonicalize(&inside).expect("canon inside");
        assert!(is_within(&canon_root, &canon_inside));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parent_traversal_escape_is_rejected() {
        let base = std::env::temp_dir().join(format!(
            "plan_reader_within_escape_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let root = base.join("plans");
        std::fs::create_dir_all(&root).expect("mkdir root");
        // A sibling file OUTSIDE the plans root, reached via `../secret.md`.
        let secret = base.join("secret.md");
        std::fs::write(&secret, b"secret").expect("write secret");

        let canon_root = std::fs::canonicalize(&root).expect("canon root");
        // Canonicalizing `<root>/../secret.md` resolves the `..` to the real escaped path.
        let traversal = root.join("..").join("secret.md");
        let canon_traversal = std::fs::canonicalize(&traversal).expect("canon traversal");

        assert!(
            !is_within(&canon_root, &canon_traversal),
            "a `../` escape resolving outside the root must be rejected"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn symlink_target_outside_root_is_rejected() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "plan_reader_within_symlink_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let root = base.join("plans");
        std::fs::create_dir_all(&root).expect("mkdir root");
        let outside_target = base.join("outside.md");
        std::fs::write(&outside_target, b"out").expect("write outside");

        // A symlink INSIDE the root pointing OUTSIDE it. After canonicalization (which the
        // command performs) the resolved path is the outside target, which must be rejected.
        let link = root.join("link.md");
        symlink(&outside_target, &link).expect("symlink");

        let canon_root = std::fs::canonicalize(&root).expect("canon root");
        let canon_link = std::fs::canonicalize(&link).expect("canon link");
        assert!(
            !is_within(&canon_root, &canon_link),
            "a symlink resolving outside the root must be rejected"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- mime_for_ext / is_supported_image_ext (allow-list) --------------

    #[test]
    fn allow_list_accepts_supported_extensions() {
        // Lowercase, mixed-case, and the multi-mapped jpeg/svg cases.
        assert_eq!(mime_for_ext("png"), Some("image/png"));
        assert_eq!(mime_for_ext("PNG"), Some("image/png")); // case-insensitive
        assert_eq!(mime_for_ext("jpeg"), Some("image/jpeg"));
        assert_eq!(mime_for_ext("jpg"), Some("image/jpeg"));
        assert_eq!(mime_for_ext("svg"), Some("image/svg+xml"));
        assert_eq!(mime_for_ext("gif"), Some("image/gif"));
        assert_eq!(mime_for_ext("webp"), Some("image/webp"));
        assert_eq!(mime_for_ext("bmp"), Some("image/bmp"));
        assert_eq!(mime_for_ext("avif"), Some("image/avif"));

        assert!(is_supported_image_ext("png"));
        assert!(is_supported_image_ext("PNG"));
        assert!(is_supported_image_ext("jpeg"));
        assert!(is_supported_image_ext("svg"));
    }

    #[test]
    fn allow_list_rejects_unsupported_extensions() {
        assert_eq!(mime_for_ext("txt"), None);
        assert_eq!(mime_for_ext("exe"), None);
        assert_eq!(mime_for_ext(""), None); // missing extension
        assert!(!is_supported_image_ext("txt"));
        assert!(!is_supported_image_ext("exe"));
        assert!(!is_supported_image_ext(""));
    }

    // ---- within_size_cap (25 MiB boundary) -------------------------------

    #[test]
    fn size_cap_boundary_is_inclusive() {
        // Exactly at the cap is allowed; one byte over is not. Tested via the pure fn so
        // we never materialize a 25 MiB file.
        assert_eq!(MAX_IMAGE_BYTES, 25 * 1024 * 1024);
        assert!(within_size_cap(0));
        assert!(within_size_cap(MAX_IMAGE_BYTES - 1));
        assert!(within_size_cap(MAX_IMAGE_BYTES)); // exactly 25 MiB: allowed
        assert!(!within_size_cap(MAX_IMAGE_BYTES + 1)); // 25 MiB + 1: rejected
    }

    // ---- read_image_as_data_url_core: is_file rejection ------------------

    #[test]
    fn directory_path_is_rejected() {
        // A directory is not a regular file → Err, even though it "exists".
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_img_dir_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");

        let result = read_image_as_data_url_core(&dir);
        assert!(
            matches!(result, Err(ref m) if m == "not a regular file"),
            "a directory must be rejected as not a regular file, got {result:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_extension_file_is_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_img_badext_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"hello").expect("write txt");

        let result = read_image_as_data_url_core(&txt);
        assert!(
            matches!(result, Err(ref m) if m == "unsupported image type"),
            "a .txt file must be rejected as unsupported, got {result:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- read_image_as_data_url_core: real PNG round-trip ----------------

    /// A minimal, valid 1x1 transparent PNG (67 bytes): signature + IHDR + IDAT + IEND.
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, // bit depth/color/.. + CRC
        0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, // IDAT length + type
        0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, // zlib data ..
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, // .. + CRC
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, // IEND length + type + CRC..
        0x42, 0x60, 0x82,
    ];

    #[test]
    fn tiny_png_round_trips_to_data_url() {
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_img_png_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        let png = dir.join("pixel.png");
        std::fs::write(&png, TINY_PNG).expect("write png");

        let url = read_image_as_data_url_core(&png).expect("core should succeed for a real png");

        // Correct MIME prefix.
        assert!(
            url.starts_with("data:image/png;base64,"),
            "expected a png data-url prefix, got: {}",
            &url[..url.len().min(40)]
        );

        // The base64 payload decodes back to the EXACT original bytes (true round-trip).
        let b64 = url
            .strip_prefix("data:image/png;base64,")
            .expect("prefix present");
        let decoded = BASE64.decode(b64).expect("payload must be valid base64");
        assert_eq!(
            decoded, TINY_PNG,
            "decoded bytes must equal the original image bytes"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ====================================================================
    // Unread, open-plan fiat, resolver, persistence, helpers.
    // ====================================================================

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_{tag}_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        dir
    }

    // ---- compute_unread vs baseline_ms ---------------------------------

    #[test]
    fn unread_when_mtime_newer_than_viewed() {
        // mtime strictly after the viewed stamp ⇒ unread.
        assert!(compute_unread(2_000, Some(1_000), 0));
    }

    #[test]
    fn read_when_mtime_equal_or_older_than_viewed() {
        // Equal ⇒ read (not strictly greater); older ⇒ read.
        assert!(!compute_unread(1_000, Some(1_000), 0));
        assert!(!compute_unread(500, Some(1_000), 0));
    }

    #[test]
    fn absent_entry_falls_back_to_baseline() {
        let baseline = 1_000;
        // No viewed entry, mtime BEFORE baseline ⇒ read (pre-existing plan).
        assert!(!compute_unread(500, None, baseline));
        // No viewed entry, mtime AFTER baseline ⇒ unread (new/changed after seed).
        assert!(compute_unread(1_500, None, baseline));
        // Exactly at baseline ⇒ read (not strictly greater).
        assert!(!compute_unread(1_000, None, baseline));
    }

    // ---- open-plan fiat ------------------------------------------------

    #[test]
    fn open_plan_is_read_by_fiat_even_when_mtime_newer() {
        let p = "/tmp/live.md";
        // mtime (3000) is strictly newer than the viewed stamp (1000) — normally unread.
        // But because p is the open plan, the fiat forces it read.
        assert!(
            !unread_for_row(p, 3_000, Some(1_000), 0, Some(p)),
            "the open plan must be read by fiat regardless of mtime > viewed"
        );
        // Sanity: clearing the open plan (None) ⇒ the SAME inputs now yield unread, proving
        // the fiat — not the clock — is what held it read.
        assert!(
            unread_for_row(p, 3_000, Some(1_000), 0, None),
            "with no open plan, mtime > viewed must be unread"
        );
        // And a DIFFERENT open plan does not protect p.
        assert!(unread_for_row(p, 3_000, Some(1_000), 0, Some("/tmp/other.md")));
    }

    // ---- collapse_home -------------------------------------------------

    #[test]
    fn collapse_home_replaces_leading_home_with_tilde() {
        assert_eq!(
            collapse_home("/Users/bob/repos/x", "/Users/bob"),
            "~/repos/x"
        );
        // Exact home ⇒ bare tilde.
        assert_eq!(collapse_home("/Users/bob", "/Users/bob"), "~");
        // Not under home ⇒ unchanged.
        assert_eq!(collapse_home("/var/log", "/Users/bob"), "/var/log");
        // Prefix-but-not-boundary must NOT collapse (bobby is not under bob).
        assert_eq!(
            collapse_home("/Users/bobby/x", "/Users/bob"),
            "/Users/bobby/x"
        );
        // Empty home ⇒ unchanged.
        assert_eq!(collapse_home("/Users/bob/x", ""), "/Users/bob/x");
    }

    // ---- resolver: cross-transcript priority (fabricated fixtures) -----

    /// Write a top-level session transcript `<root>/<proj>/<session>.jsonl`.
    fn write_session(root: &Path, proj: &str, session: &str, lines: &[String]) -> PathBuf {
        let dir = root.join(proj);
        std::fs::create_dir_all(&dir).expect("mkdir proj");
        let p = dir.join(format!("{session}.jsonl"));
        std::fs::write(&p, lines.join("\n")).expect("write session");
        p
    }

    /// Write a subagent transcript `<root>/<proj>/<session>/subagents/agent-<hex>.jsonl`.
    fn write_subagent(
        root: &Path,
        proj: &str,
        session: &str,
        hex: &str,
        lines: &[String],
    ) -> PathBuf {
        let dir = root.join(proj).join(session).join("subagents");
        std::fs::create_dir_all(&dir).expect("mkdir subagents");
        let p = dir.join(format!("agent-{hex}.jsonl"));
        std::fs::write(&p, lines.join("\n")).expect("write subagent");
        p
    }

    fn plan_mode_line(cwd: &str, stem: &str) -> String {
        serde_json::json!({
            "cwd": cwd,
            "attachment": {
                "type": "plan_mode",
                "planFilePath": format!("/whatever/plans/{stem}.md"),
                "isSubAgent": false
            }
        })
        .to_string()
    }

    fn write_tool_line(cwd: &str, stem: &str) -> String {
        serde_json::json!({
            "cwd": cwd,
            "message": {
                "content": [
                    { "type": "tool_use", "name": "Write",
                      "input": { "file_path": format!("/whatever/plans/{stem}.md") } }
                ]
            }
        })
        .to_string()
    }

    /// A bare line that merely contains the plan path (last-resort substring match).
    fn line_contains_only(cwd: &str, stem: &str) -> String {
        serde_json::json!({
            "cwd": cwd,
            "text": format!("see /whatever/plans/{stem}.md for details")
        })
        .to_string()
    }

    /// Set a file's mtime to an explicit `YYYYMMDDhhmm` timestamp via `touch -t` (no extra
    /// crate dependency). Used to give fixtures distinct, deterministic mtimes so the
    /// newest-session tie-break can be asserted without relying on write-order timing.
    fn set_mtime(path: &Path, touch_stamp: &str) {
        let status = std::process::Command::new("touch")
            .arg("-t")
            .arg(touch_stamp)
            .arg(path)
            .status()
            .expect("run touch");
        assert!(status.success(), "touch -t {touch_stamp} {path:?} failed");
    }

    #[test]
    fn same_provenance_tie_resolves_to_newest_mtime_deterministically() {
        let stem = "tie-break-stem";
        // Two transcripts with the SAME (authoritative) provenance for `stem` but different
        // cwds and different mtimes. The NEWER-mtime transcript's cwd must win — and must do
        // so regardless of the order the slice is passed in (proves it's mtime, not order).
        for forward in [true, false] {
            let root = unique_dir(if forward { "tie_fwd" } else { "tie_rev" });
            let old = write_session(&root, "projOld", "sOld", &[plan_mode_line("/OLD", stem)]);
            let new = write_session(&root, "projNew", "sNew", &[plan_mode_line("/NEW", stem)]);
            // /OLD = Jan 2020, /NEW = Jan 2024 (strictly newer).
            set_mtime(&old, "202001010000");
            set_mtime(&new, "202401010000");

            let transcripts = if forward {
                vec![old.clone(), new.clone()]
            } else {
                vec![new.clone(), old.clone()]
            };
            let out = resolve_stems(&[stem.to_string()], &transcripts);
            assert_eq!(
                out.get(stem).cloned().flatten(),
                Some("/NEW".to_string()),
                "on a same-provenance tie the newest-mtime session's cwd must win, forward={forward}"
            );

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn authoritative_beats_fallback_regardless_of_file_order() {
        let stem = "cross-priority-stem";
        // Transcript A: Write-fallback match, cwd = /A.
        // Transcript B: authoritative plan_mode match, cwd = /B.
        // The resolved cwd MUST be /B under BOTH file orderings.
        for forward in [true, false] {
            let root = unique_dir(if forward { "resA_fwd" } else { "resA_rev" });
            let a = write_session(&root, "projA", "sessA", &[write_tool_line("/A", stem)]);
            let b = write_session(&root, "projB", "sessB", &[plan_mode_line("/B", stem)]);

            let transcripts = if forward {
                vec![a.clone(), b.clone()]
            } else {
                vec![b.clone(), a.clone()]
            };
            let out = resolve_stems(&[stem.to_string()], &transcripts);
            assert_eq!(
                out.get(stem).cloned().flatten(),
                Some("/B".to_string()),
                "authoritative plan_mode (/B) must win over Write-fallback (/A), forward={forward}"
            );

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn authoritative_not_downgraded_by_later_write_or_substring() {
        let stem = "no-downgrade-stem";
        let root = unique_dir("resB");
        // First file (authoritative). Later files only carry weaker signals.
        let auth = write_session(&root, "p0", "s0", &[plan_mode_line("/AUTH", stem)]);
        let weak_write = write_session(&root, "p1", "s1", &[write_tool_line("/WRITE", stem)]);
        let weak_sub = write_session(&root, "p2", "s2", &[line_contains_only("/SUBSTR", stem)]);

        let out = resolve_stems(
            &[stem.to_string()],
            &[auth.clone(), weak_write.clone(), weak_sub.clone()],
        );
        assert_eq!(
            out.get(stem).cloned().flatten(),
            Some("/AUTH".to_string()),
            "an already-authoritative stem must NOT be downgraded by a later Write/substring"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn subagent_transcript_resolves_from_its_own_file() {
        let hex = "acea1c41bbc02c040";
        let stem = format!("merry-baking-hammock-agent-{hex}");
        let root = unique_dir("resC");
        // No top-level <session>.jsonl exists for this stem — only the subagent file does.
        // The subagent file carries its OWN cwd and a Write match for the stem.
        write_subagent(
            &root,
            "someproj",
            "parent-session",
            hex,
            &[write_tool_line("/Users/me/.hermes", &stem)],
        );

        let root2 = projects_for(&root);
        let transcripts = collect_transcripts(&root2);
        let out = resolve_stems(&[stem.clone()], &transcripts);
        assert_eq!(
            out.get(&stem).cloned().flatten(),
            Some("/Users/me/.hermes".to_string()),
            "a subagent plan must resolve from its own subagents/agent-<hex>.jsonl"
        );

        // collect_transcripts must actually have picked up the subagent file.
        assert!(
            transcripts.iter().any(|p| p.to_string_lossy().contains("/subagents/")),
            "collect_transcripts must descend into subagents/"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The fabricated fixtures are written directly under `root` as the projects-root, so
    /// `collect_transcripts(root)` is the entry point. This helper just returns `root` (it
    /// documents intent: `root` IS the `~/.claude/projects` analogue in tests).
    fn projects_for(root: &Path) -> PathBuf {
        root.to_path_buf()
    }

    #[test]
    fn fake_stem_resolves_to_none() {
        let root = unique_dir("resD");
        // A real transcript that mentions some OTHER plan, never the fake stem.
        write_session(
            &root,
            "proj",
            "sess",
            &[plan_mode_line("/X", "some-real-other-plan")],
        );
        let transcripts = collect_transcripts(&root);
        let fake = "totally-fake-nonexistent-plan-zzz-9999".to_string();
        let out = resolve_stems(&[fake.clone()], &transcripts);
        assert_eq!(
            out.get(&fake).cloned(),
            Some(None),
            "a fake stem must be present in the map with a None resolution"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- persistence: round-trip, missing, corrupt --------------------

    #[test]
    fn cwd_cache_round_trips() {
        let dir = unique_dir("persA");
        let mut cache = HashMap::new();
        cache.insert("stem-a".to_string(), "/cwd/a".to_string());
        cache.insert("stem-b".to_string(), "/cwd/b".to_string());

        persist_cwd_cache(&Some(dir.clone()), &cache);
        let loaded = load_cwd_cache(&dir);
        assert_eq!(loaded, cache, "cwd cache must round-trip write→read");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_state_round_trips() {
        let dir = unique_dir("persB");
        let mut rs = ReadState {
            baseline_ms: 12_345,
            viewed: HashMap::new(),
        };
        rs.viewed.insert("/tmp/p.md".to_string(), 99_999);

        persist_read_state(&Some(dir.clone()), &rs);
        let (loaded, seeded) = load_read_state(&dir);
        assert!(!seeded, "loading an existing file must not be flagged as a fresh seed");
        assert_eq!(loaded.baseline_ms, 12_345);
        assert_eq!(loaded.viewed.get("/tmp/p.md").copied(), Some(99_999));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_read_state_is_empty_with_baseline_now() {
        let dir = unique_dir("persC"); // exists but has no read-state.json
        let before = now_ms();
        let (rs, seeded) = load_read_state(&dir);
        let after = now_ms();
        assert!(seeded, "an absent read-state must be flagged for baseline seeding");
        assert!(rs.viewed.is_empty(), "absent ⇒ empty viewed map");
        assert!(
            rs.baseline_ms >= before && rs.baseline_ms <= after,
            "absent ⇒ baseline seeded to ~now (got {}, window {before}..={after})",
            rs.baseline_ms
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_cwd_cache_is_empty() {
        let dir = unique_dir("persD"); // exists but has no cwd-cache.json
        let loaded = load_cwd_cache(&dir);
        assert!(loaded.is_empty(), "absent cwd cache ⇒ empty map");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_read_state_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("persE");
        let path = dir.join(READ_STATE_FILE);
        let garbage = b"{ this is : not valid json @@@ ";
        std::fs::write(&path, garbage).expect("write garbage");

        // Must NOT panic, must degrade to empty, must NOT re-seed a fresh baseline.
        let (rs, seeded) = load_read_state(&dir);
        assert!(!seeded, "corrupt file must NOT be flagged as a fresh seed");
        assert_eq!(rs.baseline_ms, 0, "corrupt ⇒ baseline 0 (nothing force-marked read)");
        assert!(rs.viewed.is_empty());

        // The corrupt file must be left UNTOUCHED (non-destructive).
        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt file must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_cwd_cache_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("persF");
        let path = dir.join(CWD_CACHE_FILE);
        let garbage = b"<<<not json>>>";
        std::fs::write(&path, garbage).expect("write garbage");

        let loaded = load_cwd_cache(&dir); // must not panic
        assert!(loaded.is_empty(), "corrupt cwd cache ⇒ empty");

        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt cwd cache must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- atomic_write sanity -------------------------------------------

    #[test]
    fn atomic_write_overwrites_existing_target() {
        let dir = unique_dir("atomic");
        let target = dir.join("data.json");
        std::fs::write(&target, b"old contents").expect("seed");
        atomic_write(&target, b"new contents").expect("atomic write");
        let got = std::fs::read(&target).expect("read back");
        assert_eq!(got, b"new contents");
        // No leftover temp files in the dir.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with(".tmp-"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(leftovers.is_empty(), "atomic_write must not leave temp files behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ====================================================================
    // Frontmatter split + fence-aware H1 extraction (the two read paths).
    // ====================================================================

    // ---- split_frontmatter ---------------------------------------------

    #[test]
    fn split_frontmatter_extracts_leading_block_and_body() {
        let content = "---\nkey: t\nother: value\n---\n# Title\n\nbody\n";
        let (yaml, body) = split_frontmatter(content);
        assert_eq!(
            yaml,
            Some("key: t\nother: value\n"),
            "the yaml block between the fences must be returned verbatim"
        );
        assert!(
            body.starts_with("# Title"),
            "body must begin AFTER the closing fence, got {body:?}"
        );
    }

    #[test]
    fn split_frontmatter_tolerates_crlf_and_trailing_fence_whitespace() {
        // CRLF line endings AND trailing whitespace on both fences — both read paths must
        // still agree on the boundary.
        let content = "--- \r\nkey: value\r\nother: 2\r\n---\t\r\n# Title\r\n";
        let (yaml, body) = split_frontmatter(content);
        assert!(yaml.is_some(), "a CRLF/whitespace-padded fence must still be recognized");
        assert!(
            yaml.unwrap().contains("key: value"),
            "the yaml block between the fences must be returned"
        );
        assert!(body.starts_with("# Title"), "body begins after closing fence, got {body:?}");
    }

    #[test]
    fn split_frontmatter_no_frontmatter_passes_through() {
        let content = "# Just a heading\n\nsome body\n";
        let (yaml, body) = split_frontmatter(content);
        // INVERT-CHECK target: this MUST be None. (Asserting Some(...) here would go red.)
        assert_eq!(yaml, None, "a no-frontmatter document must yield None");
        assert_eq!(body, content, "body must be the unchanged content");
    }

    #[test]
    fn split_frontmatter_unterminated_fence_is_not_stripped() {
        // Opening fence but NO closing fence ⇒ not frontmatter; nothing stripped.
        let content = "---\nkey: t\nother: value\n# never closed\nbody\n";
        let (yaml, body) = split_frontmatter(content);
        assert_eq!(yaml, None, "an unterminated --- must NOT be treated as frontmatter");
        assert_eq!(body, content, "unterminated fence ⇒ body unchanged");
    }

    #[test]
    fn split_frontmatter_mid_document_rule_is_not_stripped() {
        // A `---` thematic break NOT at line 1 must never open a frontmatter block.
        let content = "# Title\n\nsome text\n\n---\n\nmore text\n";
        let (yaml, body) = split_frontmatter(content);
        assert_eq!(yaml, None, "a mid-document --- thematic break must not be frontmatter");
        assert_eq!(body, content, "mid-document --- ⇒ body unchanged");
    }

    // ---- extract_h1s (fence-aware H1 scan for the sidebar filter) ------

    #[test]
    fn extract_h1s_collects_atx_h1_only() {
        // `# Title` is collected (trimmed); `## H2` and `#NoSpace` are excluded.
        let body = "# Title\n\nsome text\n## H2 section\n\n#NoSpace\n\n#   Padded H1   \n";
        let h1s = extract_h1s(body);
        assert_eq!(
            h1s,
            vec!["Title".to_string(), "Padded H1".to_string()],
            "only ATX H1 (`# ` + space) collected, trimmed; H2 and #NoSpace excluded"
        );
    }

    #[test]
    fn extract_h1s_empty_body_is_empty() {
        assert_eq!(extract_h1s(""), Vec::<String>::new());
        assert_eq!(extract_h1s("just paragraph text\nno headings\n"), Vec::<String>::new());
    }

    #[test]
    fn extract_h1s_is_fence_aware_skips_hash_lines_in_code_fences() {
        // A `# Comment` line INSIDE a ```python fence must NOT be harvested. This is the real
        // corpus failure mode: a fence-blind scan would return ["Comment"]. Inverting the
        // fence-awareness (treating fenced `# ` lines as headings) makes this assertion RED.
        let body = "# Real Title\n\n```python\n# Comment inside a code fence\nx = 1  # not a heading\n```\n\n# Second Real Title\n";
        let h1s = extract_h1s(body);
        assert_eq!(
            h1s,
            vec!["Real Title".to_string(), "Second Real Title".to_string()],
            "the `# Comment` line inside the python fence must be skipped (fence-aware)"
        );
        assert!(
            !h1s.iter().any(|h| h.contains("Comment")),
            "no fenced code comment may leak into the H1 list"
        );
    }

    #[test]
    fn extract_h1s_tilde_fence_is_also_aware() {
        // `~~~` fences are handled exactly like ``` fences.
        let body = "# Title\n~~~\n# fenced comment\n~~~\n# After\n";
        assert_eq!(
            extract_h1s(body),
            vec!["Title".to_string(), "After".to_string()]
        );
    }

    // ---- frontmatter strip: the read path leaves the body intact -------

    /// A reader-equivalent of `read_plan_contents`'s strip step: read bytes, lossy-decode,
    /// return the body with any leading frontmatter stripped (the production command does
    /// exactly this after the containment guards, which a temp dir cannot satisfy).
    fn reader_body(path: &Path) -> String {
        let bytes = std::fs::read(path).expect("read");
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let (_yaml, body) = split_frontmatter(&content);
        body.to_string()
    }

    #[test]
    fn read_path_strips_leading_frontmatter_block() {
        let dir = unique_dir("frontmatter_strip");
        let marked = dir.join("humble-exploring-walrus.md");
        std::fs::write(
            &marked,
            "---\nkey: value\nother: 1\n---\n\n# A plan title\n\nbody\n",
        )
        .expect("write marked");

        // The reader strips the frontmatter → body starts with `#` (no leading `---`/yaml).
        let body = reader_body(&marked);
        assert!(
            body.trim_start().starts_with('#'),
            "stripped body must start with a heading, got: {:?}",
            &body[..body.len().min(40)]
        );
        assert!(
            !body.contains("key: value"),
            "stripped body must not contain the frontmatter text"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_path_legacy_file_is_byte_unchanged() {
        let dir = unique_dir("frontmatter_legacy");
        let legacy = dir.join("old-plan.md");
        let original = "# Legacy Plan\n\nNo frontmatter here.\n\n---\n\nA mid-doc rule.\n";
        std::fs::write(&legacy, original).expect("write legacy");

        // Reader leaves a no-frontmatter file byte-for-byte unchanged.
        let body = reader_body(&legacy);
        assert_eq!(body, original, "a no-frontmatter body must be byte-unchanged by the strip");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ====================================================================
    // Comments persistence + set_comments semantics + wire freeze.
    // ====================================================================

    fn comment_rec(quote: &str, block_line: Option<i64>, occurrence: i64, id: i64) -> CommentRecord {
        CommentRecord {
            quote: quote.to_string(),
            block_line,
            // Derive a plausible end line from the start (start + 2) so round-trip exercises a
            // populated value; None when there is no block (whole-pane anchor).
            block_end_line: block_line.map(|s| s + 2),
            occurrence,
            comment: format!("note for {quote}"),
            id,
        }
    }

    #[test]
    fn comments_round_trip() {
        let dir = unique_dir("commentsA");
        let mut map: HashMap<String, Vec<CommentRecord>> = HashMap::new();
        map.insert(
            "/plans/p1.md".to_string(),
            vec![
                comment_rec("hello world", Some(5), 1, 0),
                // A block_line: None record MUST round-trip as JSON null (no -1 sentinel).
                comment_rec("whole pane quote", None, 0, 1),
            ],
        );
        map.insert(
            "/plans/p2.md".to_string(),
            vec![comment_rec("another", Some(0), 0, 0)],
        );

        persist_comments(&Some(dir.clone()), &map);

        // The block_line: None record must serialize to literal JSON `null`, never omitted/-1.
        let raw = std::fs::read_to_string(dir.join(COMMENTS_FILE)).expect("read comments file");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        let none_rec = &v["/plans/p1.md"][1];
        assert_eq!(
            none_rec.get("block_line"),
            Some(&serde_json::Value::Null),
            "a None block_line must serialize as JSON null, not omitted or -1"
        );

        let loaded = load_comments(&dir);
        assert_eq!(loaded, map, "comments must round-trip write→read");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_comments_is_empty() {
        let dir = unique_dir("commentsB"); // exists but has no comments.json
        let loaded = load_comments(&dir);
        assert!(loaded.is_empty(), "absent comments ⇒ empty map");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_comments_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("commentsC");
        let path = dir.join(COMMENTS_FILE);
        let garbage = b"{ not : valid json @@@";
        std::fs::write(&path, garbage).expect("write garbage");

        let loaded = load_comments(&dir); // must not panic
        assert!(loaded.is_empty(), "corrupt comments ⇒ empty");

        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt comments must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `set_comments` semantics, exercised against the REAL command path's pure core
    /// (`apply_set_comments` — the same free function the `#[tauri::command]` calls, NOT a local
    /// copy). This makes the return-after-mutation contract falsifiable: the frontend adopts the
    /// RETURNED array as its cache, so the function MUST return the POST-mutation value. A
    /// non-empty array inserts/replaces and returns it; an EMPTY array REMOVES the key and
    /// returns the resulting (empty) array.
    #[test]
    fn set_comments_empty_removes_key_and_returns_array() {
        let mut map: HashMap<String, Vec<CommentRecord>> = HashMap::new();
        let key = "/plans/p.md".to_string();

        // Non-empty replacement inserts and RETURNS the post-mutation array (== what was set).
        let recs = vec![comment_rec("x", Some(1), 0, 0), comment_rec("y", None, 2, 1)];
        let returned = apply_set_comments(&mut map, key.clone(), recs.clone());
        assert_eq!(
            returned, recs,
            "set_comments must RETURN the post-mutation array (the frontend adopts it as cache)"
        );
        assert!(map.contains_key(&key), "non-empty set keeps the key present");

        // A SECOND non-empty set fully replaces (not appends) and returns the new array.
        let replacement = vec![comment_rec("z", Some(3), 0, 5)];
        let returned2 = apply_set_comments(&mut map, key.clone(), replacement.clone());
        assert_eq!(returned2, replacement, "set is full-array replacement, not append");

        // Empty array removes the key; the returned array is empty (and the key is gone).
        let returned3 = apply_set_comments(&mut map, key.clone(), Vec::new());
        assert!(returned3.is_empty(), "an empty set returns an empty array");
        assert!(
            !map.contains_key(&key),
            "an empty set must REMOVE the key (no accumulation of empty entries)"
        );
    }

    /// `clear_comments` semantics via its real pure core `apply_clear_comments`: wipes the key
    /// and RETURNS the resulting (empty) array. Falsifiable for the same reason as above —
    /// returning a stale pre-clear array would break the frontend cache adoption.
    #[test]
    fn clear_comments_removes_key_and_returns_empty_array() {
        let mut map: HashMap<String, Vec<CommentRecord>> = HashMap::new();
        let key = "/plans/p.md".to_string();
        map.insert(key.clone(), vec![comment_rec("x", Some(1), 0, 0)]);

        let returned = apply_clear_comments(&mut map, &key);
        assert!(returned.is_empty(), "clear must RETURN the resulting empty array");
        assert!(!map.contains_key(&key), "clear must remove the key");

        // Clearing an absent key is a benign no-op returning empty.
        let again = apply_clear_comments(&mut map, &key);
        assert!(again.is_empty());
    }

    /// Locks the `CommentRecord` wire shape to the frozen contract: exactly 6 snake_case keys,
    /// with `block_line` / `block_end_line` present as JSON `null` when `None` (mirrors the
    /// `cwd: Option<String>` precedent — never omitted, never a -1 sentinel). Twin of
    /// `planrecord_wire_contract_is_frozen`.
    #[test]
    fn comment_record_wire_contract_is_frozen() {
        use std::collections::BTreeSet;

        let expected_keys: BTreeSet<&str> =
            ["quote", "block_line", "block_end_line", "occurrence", "comment", "id"]
                .into_iter()
                .collect();

        // One record with a real block_line, one with None — both must carry all 6 keys.
        let with_block = comment_rec("anchored quote", Some(7), 2, 0);
        let whole_pane = comment_rec("floating quote", None, 0, 1);

        for rec in [&with_block, &whole_pane] {
            let value = serde_json::to_value(rec).unwrap();
            let obj = value
                .as_object()
                .expect("CommentRecord must serialize to a JSON object");
            let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
            assert_eq!(
                actual_keys, expected_keys,
                "CommentRecord top-level JSON keys drifted from the frozen 6-key contract"
            );

            // Value types of the always-present scalar fields.
            assert!(obj["quote"].is_string(), "quote must be a JSON string");
            assert!(obj["comment"].is_string(), "comment must be a JSON string");
            assert!(obj["occurrence"].is_i64() || obj["occurrence"].is_u64(), "occurrence must be an integer");
            assert!(obj["id"].is_i64() || obj["id"].is_u64(), "id must be an integer");
        }

        // `block_line` must be a JSON integer when Some, and JSON null (present) when None.
        let with_block_value = serde_json::to_value(&with_block).unwrap();
        assert!(
            with_block_value["block_line"].is_i64() || with_block_value["block_line"].is_u64(),
            "block_line must be a JSON integer when populated"
        );
        let whole_pane_value = serde_json::to_value(&whole_pane).unwrap();
        assert_eq!(
            whole_pane_value.get("block_line"),
            Some(&serde_json::Value::Null),
            "block_line must be present as JSON null when None (no -1 sentinel, never omitted)"
        );

        // `block_end_line` follows the same rule: integer when Some, present JSON null when None.
        assert!(
            with_block_value["block_end_line"].is_i64() || with_block_value["block_end_line"].is_u64(),
            "block_end_line must be a JSON integer when populated"
        );
        assert_eq!(
            whole_pane_value.get("block_end_line"),
            Some(&serde_json::Value::Null),
            "block_end_line must be present as JSON null when None (never omitted)"
        );
    }

    /// `#[serde(default)]` must rescue OLD saved files that predate `block_end_line`: a comments
    /// JSON object whose records lack the key deserializes to `None` (not an error). Pins the
    /// backward-compat guarantee the task requires.
    #[test]
    fn old_comment_files_without_block_end_line_deserialize() {
        let dir = unique_dir("commentsOld");
        // Hand-written legacy 5-key record (no `block_end_line`).
        let legacy = r#"{"/plans/old.md":[{"quote":"legacy quote","block_line":3,"occurrence":0,"comment":"old note","id":0}]}"#;
        std::fs::write(dir.join(COMMENTS_FILE), legacy).expect("write legacy comments");

        let loaded = load_comments(&dir);
        let recs = loaded.get("/plans/old.md").expect("legacy key present");
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].block_line, Some(3));
        assert_eq!(
            recs[0].block_end_line, None,
            "a record missing block_end_line must deserialize to None via serde(default)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
