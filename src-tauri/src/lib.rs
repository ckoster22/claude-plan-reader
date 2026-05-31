// Sub-Plan 01 — Tauri shell, plan list & live file-watch.
//
// INVARIANT: this app never writes into `~/.claude/plans/`, so the plans watcher never fires
// on our own writes. CONTRACT.md, the cwd_spike example, and all build artifacts live in the
// repo, not the plans dir.
//
// Phase 4 adds exactly TWO write surfaces under `~/.claude/` (both OUTSIDE `plans/`):
//   (a) `~/.claude/plan-reader/**` — self-owned headless-review state (requests/, responses/,
//       app.alive heartbeat, hook.sh). Writes are atomic (temp-write + rename) and
//       containment-guarded (`guarded_path_in` canonicalizes the parent, rejecting any id that
//       would escape requests/ or responses/).
//   (b) `~/.claude/settings.json` — a SINGLE idempotent, additive merge (`merge_install_hook`
//       / `merge_uninstall_hook`) that touches only our `ExitPlanMode` PreToolUse entry and
//       preserves every other key/element untouched.
// The app still NEVER writes into `plans/`.

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

/// One row in the sidebar. The shape here is FROZEN as hand-off contract #2 (see CONTRACT.md);
/// Sub-Plan 01 (nested sidebar) EXTENDS it additively — see the §"Sub-Plan 01 (nested
/// master/sub hierarchy)" section in CONTRACT.md for the five appended fields.
/// `cwd` and `unread` are populated by Sub-Plan 03's resolver / read-state.
#[derive(Serialize, Clone)]
struct PlanRecord {
    absolute_path: String,
    filename_stem: String,
    mtime_ms: i64,        // millis since UNIX_EPOCH, JS-friendly
    cwd: Option<String>,  // resolved cwd (Sub-Plan 03), else None
    unread: bool,         // read/unread (Sub-Plan 03)
    // ---- Nested-hierarchy fields (Sub-Plan 01). snake_case JSON keys (no rename). ----
    /// Closed flavor set, never absent: "master" | "sub" | "standalone".
    flavor: Flavor,
    /// Join key linking a master to its subs; `null` for standalone.
    tree_id: Option<String>,
    /// Sub sequence number; `null` for master/standalone.
    nn: Option<u32>,
    /// Master only: OBSERVED count of present children (>= 0); `null` otherwise.
    child_count: Option<u32>,
    /// Master only (meaningful): persisted collapse state; `false` otherwise.
    collapsed: bool,
    /// The plan's ATX H1 heading texts (fence-aware, within the bounded head read), in
    /// document order. Used by the frontend sidebar filter to match on headings. `[]` when
    /// none. snake_case JSON key `h1s` (no rename).
    h1s: Vec<String>,
}

/// Closed set of plan flavors. `#[serde(rename_all = "lowercase")]` makes the JSON emit
/// `"master" | "sub" | "standalone"`, so an invalid flavor is unrepresentable on the wire.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Flavor {
    Master,
    Sub,
    Standalone,
}

/// The two flavors a *marker* can carry (a marker never says "standalone" — that is the
/// normalized result of an absent/invalid marker, computed in `arrange_plans`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawFlavor {
    Master,
    Sub,
}

/// A parsed frontmatter marker. `tree_id` is mandatory (a marker without it is rejected);
/// `nn` is only meaningful for `Sub`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RawMarker {
    tree_id: String,
    flavor: RawFlavor,
    nn: Option<u32>,
}

/// One per-file row fed into `arrange_plans`: the raw stat/cwd/unread facts plus the parsed
/// marker (if any). `arrange_plans` turns a `Vec<RawRow>` into the final ordered records.
#[derive(Debug, Clone)]
struct RawRow {
    stem: String,
    absolute_path: String,
    mtime_ms: i64,
    cwd: Option<String>,
    unread: bool,
    marker: Option<RawMarker>,
    /// ATX H1 heading texts (fence-aware) extracted from this file's body head. Threaded
    /// straight through to the final `PlanRecord.h1s`.
    h1s: Vec<String>,
}

/// Payload for the `plan-changed` event (frozen contract — see CONTRACT.md).
#[derive(Serialize, Clone)]
struct PlanChanged {
    path: String,
    kind: String,
}

/// One persisted comment for a plan (Sub-Plan 02). FROZEN wire shape — exactly 6 keys (see
/// CONTRACT.md §"Sub-Plan 02 additions" / §"Highlight + comment with quoted-text anchoring").
/// `block_line` is `Option<i64>` (serde emits `null`)
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

// ============================================================================
// Phase 3 — review-request / review-response wire types + plan-reader paths.
//
// These are the PURE cores for the headless plan-review handshake. A hook drops
// a `ReviewRequest` JSON file under `~/.claude/plan-reader/requests/`; the app
// emits a `ReviewRequested` event, the user accepts/rejects, and the app writes a
// `ReviewResponse` JSON file under `~/.claude/plan-reader/responses/`. No Tauri
// commands or watcher wiring live here yet (that is Phase 4) — only the data
// shapes, path helpers, id validation, and the safety-critical settings-merge.
//
// Serde casing: the crate's convention is snake_case field names with NO
// `rename_all` (see `PlanRecord` / `CommentRecord`). The wire keys required here
// (schema, review_id, session_id, transcript_path, plan_text, created_ms, …) are
// already snake_case, so the field names serialize verbatim — no rename needed.
// ============================================================================

/// Schema version stamped into every `ReviewRequest` / `ReviewResponse` on the wire.
const REVIEW_SCHEMA: u32 = 1;

/// A plan-review request, written by the ExitPlanMode hook into `requests/<review_id>.json`
/// and read by the app. FROZEN wire shape — exactly 8 snake_case keys (see the frozen-key
/// test `review_request_wire_contract_is_frozen`). Field names match the wire verbatim
/// (snake_case, no `serde(rename)` — mirrors `PlanRecord`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct ReviewRequest {
    /// Wire schema version (`REVIEW_SCHEMA` == 1).
    schema: u32,
    /// Filesystem-safe id minted by the hook; also the request/response file stem.
    review_id: String,
    /// Originating Claude Code session id.
    session_id: String,
    /// Working directory the plan was authored in.
    cwd: String,
    /// Absolute path to the session transcript (`.jsonl`).
    transcript_path: String,
    /// The full plan markdown awaiting review.
    plan_text: String,
    /// Absolute path to the plan markdown file Claude just wrote (e.g.
    /// `~/.claude/plans/foo.md`), sourced from the hook's `tool_input.planFilePath`.
    /// `#[serde(default)]` so request files written by the OLD hook (which lacked this key)
    /// deserialize to `""` instead of erroring — critical for launch recovery.
    #[serde(default)]
    pub plan_file_path: String,
    /// Creation wall-clock time, millis since the UNIX epoch.
    created_ms: u64,
}

/// A plan-review decision, written by the app into `responses/<review_id>.json` and read
/// by the waiting hook. FROZEN wire shape — exactly 4 snake_case keys (see
/// `review_response_wire_contract_is_frozen`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct ReviewResponse {
    /// Wire schema version (`REVIEW_SCHEMA` == 1).
    schema: u32,
    /// Echoes the request's `review_id` so the hook can correlate.
    review_id: String,
    /// The user's verdict: exactly `"allow"` / `"deny"` (validated by `is_valid_decision`).
    decision: String,
    /// Free-text rationale shown back to the model/hook.
    reason: String,
}

/// Event payload emitted to the frontend when a new review request arrives
/// (`plan-review-requested`). Carries only what the UI needs to render the prompt.
#[derive(Serialize, Clone, Debug, PartialEq)]
struct ReviewRequested {
    review_id: String,
    plan_text: String,
    plan_file_path: String,
}

/// Event payload emitted to the frontend when a pending review is cancelled
/// (`plan-review-cancelled`) — e.g. the request file was removed before a decision.
#[derive(Serialize, Clone, Debug, PartialEq)]
struct ReviewCancelled {
    review_id: String,
}

/// Absolute path to `~/.claude/plans`. Returns None only if the home dir cannot be located.
fn plans_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plans"))
}

/// Absolute path to `~/.claude/plan-reader` (the headless-review state root). Twin of
/// `plans_dir()` — same home-dir resolution, same `Option<PathBuf>` return.
fn plan_reader_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plan-reader"))
}

/// Absolute path to `~/.claude/plan-reader/requests` (hook-written review requests).
fn requests_dir() -> Option<PathBuf> {
    plan_reader_dir().map(|d| d.join("requests"))
}

/// Absolute path to `~/.claude/plan-reader/responses` (app-written review decisions).
fn responses_dir() -> Option<PathBuf> {
    plan_reader_dir().map(|d| d.join("responses"))
}

/// Absolute path to `~/.claude/plan-reader/app.alive` (heartbeat the hook checks before
/// blocking on a response — if the app isn't running it must not hang the model).
fn app_alive_path() -> Option<PathBuf> {
    plan_reader_dir().map(|d| d.join("app.alive"))
}

/// True iff `id` is a safe review-id usable as a single path segment / file stem.
/// Rules: non-empty; every char is ASCII `[A-Za-z0-9._-]`; not `.` or `..`; contains no
/// `/` or `\\`; does not start with `.` (so a request can never become a dotfile or escape
/// its directory). Hand-rolled — no regex dependency exists in Cargo.toml and the rule is a
/// fixed character class, so a full regex engine is unwarranted.
fn valid_review_id(id: &str) -> bool {
    if id.is_empty() || id == "." || id == ".." {
        return false;
    }
    if id.starts_with('.') {
        return false;
    }
    id.chars().all(|c| {
        // `/` and `\` are excluded by the allow-list below, but spelled out for intent.
        c != '/'
            && c != '\\'
            && (c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    })
}

/// Build the containment-guarded path `responses/<review_id>.json`. Returns `Err` if the id
/// is syntactically unsafe (`valid_review_id`). Because the response file does NOT exist yet,
/// we cannot `canonicalize` the target itself — instead we canonicalize the PARENT (the
/// responses dir, which exists) and assert the joined path's canonicalized parent IS that
/// dir. That rejects any id that — despite passing the syntactic check — would resolve outside
/// `responses/` (defense in depth; `valid_review_id` already forbids separators and dots).
fn response_path_for(review_id: &str) -> Result<PathBuf, String> {
    guarded_path_in(responses_dir(), review_id)
}

/// Twin of `response_path_for` for `requests/<review_id>.json`.
fn request_path_for(review_id: &str) -> Result<PathBuf, String> {
    guarded_path_in(requests_dir(), review_id)
}

/// Shared core of `response_path_for` / `request_path_for`: validate the id, join
/// `<dir>/<id>.json`, and assert the joined path's canonicalized parent equals the
/// canonicalized `dir`. Canonicalizes the PARENT (which exists), never the not-yet-created
/// target. Creates no file.
fn guarded_path_in(dir: Option<PathBuf>, review_id: &str) -> Result<PathBuf, String> {
    if !valid_review_id(review_id) {
        return Err("invalid review id".to_string());
    }
    let dir = dir.ok_or_else(|| "could not locate home directory".to_string())?;
    let joined = dir.join(format!("{review_id}.json"));
    let parent = joined
        .parent()
        .ok_or_else(|| "joined path has no parent".to_string())?;
    let canon_parent =
        std::fs::canonicalize(parent).map_err(|e| format!("dir unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("dir unavailable: {e}"))?;
    if canon_parent != canon_dir {
        return Err("path escapes the target directory".to_string());
    }
    Ok(joined)
}

/// The idempotency marker: any PreToolUse hook entry whose `command` string ENDS WITH this
/// suffix is treated as "our" plan-reader hook (install updates it in place; uninstall
/// removes it). Matching on the suffix — not an exact string — survives absolute-vs-`~`
/// path spellings of the same install.
const PLAN_READER_HOOK_SUFFIX: &str = "plan-reader/hook.sh";

/// The matcher key under which Claude Code fires hooks for the plan-approval gate.
const EXIT_PLAN_MODE_MATCHER: &str = "ExitPlanMode";

/// PURE settings merge: ensure the user's settings install our `ExitPlanMode` PreToolUse hook
/// pointing at `hook_command`. Takes and returns `serde_json::Value` so it is unit-testable
/// without touching disk. Behavior:
///   - coerce `settings` to an object (a non-object input becomes a fresh `{}`),
///   - ensure `hooks` is an object and `hooks.PreToolUse` is an array,
///   - find the array element whose `matcher == "ExitPlanMode"` (create + push one if absent),
///   - ensure that element's `hooks` array contains our command entry
///     `{ "type":"command", "command": hook_command, "timeout": 600 }`.
///     Idempotency key: an existing entry whose `command` ENDS WITH `plan-reader/hook.sh` is
///     "ours" — we update its `command` to `hook_command` and force `timeout` to 600 rather
///     than appending a duplicate.
/// EVERY other key and array element is preserved untouched (this is a SECURITY-critical
/// invariant — an unrelated Bash permission hook must never be clobbered).
fn merge_install_hook(settings: Value, hook_command: &str) -> Value {
    let mut root = match settings {
        Value::Object(map) => Value::Object(map),
        _ => Value::Object(serde_json::Map::new()),
    };
    let obj = root.as_object_mut().expect("root coerced to object");

    // hooks must be an object.
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(serde_json::Map::new());
    }
    let hooks = hooks.as_object_mut().expect("hooks coerced to object");

    // hooks.PreToolUse must be an array.
    let pretooluse = hooks
        .entry("PreToolUse")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !pretooluse.is_array() {
        *pretooluse = Value::Array(Vec::new());
    }
    let pretooluse = pretooluse.as_array_mut().expect("PreToolUse coerced to array");

    // Find (or create) the ExitPlanMode matcher element.
    let exit_idx = pretooluse.iter().position(|el| {
        el.get("matcher").and_then(|m| m.as_str()) == Some(EXIT_PLAN_MODE_MATCHER)
    });
    let exit_idx = match exit_idx {
        Some(i) => i,
        None => {
            let mut elem = serde_json::Map::new();
            elem.insert(
                "matcher".to_string(),
                Value::String(EXIT_PLAN_MODE_MATCHER.to_string()),
            );
            elem.insert("hooks".to_string(), Value::Array(Vec::new()));
            pretooluse.push(Value::Object(elem));
            pretooluse.len() - 1
        }
    };

    // Ensure that element's `hooks` is an array.
    let elem = pretooluse[exit_idx]
        .as_object_mut()
        .expect("ExitPlanMode element is an object");
    let elem_hooks = elem
        .entry("hooks")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !elem_hooks.is_array() {
        *elem_hooks = Value::Array(Vec::new());
    }
    let elem_hooks = elem_hooks.as_array_mut().expect("element hooks is array");

    // Look for an existing "ours" entry (command ends with the suffix).
    let ours = elem_hooks.iter_mut().find(|h| {
        h.get("command")
            .and_then(|c| c.as_str())
            .map(|c| c.ends_with(PLAN_READER_HOOK_SUFFIX))
            .unwrap_or(false)
    });
    match ours {
        Some(entry) => {
            // Update in place — no duplicate.
            if let Some(map) = entry.as_object_mut() {
                map.insert("command".to_string(), Value::String(hook_command.to_string()));
                map.insert("timeout".to_string(), Value::from(600));
            }
        }
        None => {
            let mut new_entry = serde_json::Map::new();
            new_entry.insert("type".to_string(), Value::String("command".to_string()));
            new_entry.insert("command".to_string(), Value::String(hook_command.to_string()));
            new_entry.insert("timeout".to_string(), Value::from(600));
            elem_hooks.push(Value::Object(new_entry));
        }
    }

    root
}

/// PURE inverse of `merge_install_hook`: remove our plan-reader hook (command ends with
/// `plan-reader/hook.sh`) from the `ExitPlanMode` PreToolUse element's `hooks` array. If that
/// element's `hooks` array becomes empty, the element is removed from `PreToolUse`. We do NOT
/// delete the `hooks` / `PreToolUse` keys even if `PreToolUse` becomes empty (minimal change).
/// Everything else is preserved. Idempotent — removing twice is a no-op.
fn merge_uninstall_hook(settings: Value) -> Value {
    let mut root = match settings {
        Value::Object(map) => Value::Object(map),
        other => return other, // nothing to uninstall from a non-object
    };
    let obj = root.as_object_mut().expect("root is object");

    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return root; // no hooks object — nothing to do
    };
    let Some(pretooluse) = hooks.get_mut("PreToolUse").and_then(|p| p.as_array_mut()) else {
        return root; // no PreToolUse array — nothing to do
    };

    if let Some(exit_idx) = pretooluse.iter().position(|el| {
        el.get("matcher").and_then(|m| m.as_str()) == Some(EXIT_PLAN_MODE_MATCHER)
    }) {
        if let Some(elem_hooks) = pretooluse[exit_idx]
            .get_mut("hooks")
            .and_then(|h| h.as_array_mut())
        {
            // Drop any entry whose command ends with our suffix.
            elem_hooks.retain(|h| {
                !h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.ends_with(PLAN_READER_HOOK_SUFFIX))
                    .unwrap_or(false)
            });
            // If the ExitPlanMode element's hooks went empty, remove the element entirely.
            if elem_hooks.is_empty() {
                pretooluse.remove(exit_idx);
            }
        }
    }

    root
}

/// PURE detection: is OUR plan-reader `ExitPlanMode` PreToolUse hook present in `settings`?
/// True iff `settings.hooks.PreToolUse` is an array containing an element whose
/// `matcher == "ExitPlanMode"` whose own `hooks` array contains an entry whose `command`
/// (a string) ENDS WITH `PLAN_READER_HOOK_SUFFIX` — the SAME idempotency key the merge
/// functions match on. Tolerant of odd shapes: any missing/wrong-typed level short-circuits
/// to `false` (never panics).
fn hook_is_installed(settings: &Value) -> bool {
    let Some(pretooluse) = settings
        .get("hooks")
        .and_then(|h| h.get("PreToolUse"))
        .and_then(|p| p.as_array())
    else {
        return false;
    };
    pretooluse.iter().any(|el| {
        if el.get("matcher").and_then(|m| m.as_str()) != Some(EXIT_PLAN_MODE_MATCHER) {
            return false;
        }
        el.get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| {
                hooks.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.ends_with(PLAN_READER_HOOK_SUFFIX))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    })
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
/// Sub-Plan 03: gains an injected `State<Mutex<AppState>>` (the JS `invoke("list_plans")`
/// call is unchanged — Tauri injects the managed state). It populates `cwd` from the
/// in-memory cache (NO transcript scan here — that lives in `resolve_cwds`, which must stay
/// fast) and `unread` per the baseline / viewed / open-path rules in `compute_unread`.
///
/// Sub-Plan 01 (nested sidebar): also reads a bounded head of each file, runs
/// `split_frontmatter` → `parse_marker`, builds raw rows, and delegates ordering +
/// flavor-normalization to the pure `arrange_plans` (replacing the old `sort_newest_first`).
/// Collapse-state entries whose `tree_id` no longer appears in any record are pruned.
#[tauri::command]
fn list_plans(state: tauri::State<'_, Mutex<AppState>>) -> Vec<PlanRecord> {
    // Snapshot what we need from the lock, then release it before doing any I/O.
    let (cwd_cache, baseline_ms, viewed, open_path, collapse_state, data_dir) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        (
            guard.cwd_cache.clone(),
            guard.read_state.baseline_ms,
            guard.read_state.viewed.clone(),
            guard.open_path.clone(),
            guard.collapse_state.clone(),
            guard.data_dir.clone(),
        )
    };

    let Some(dir) = plans_dir() else {
        return Vec::new();
    };

    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(), // dir missing / not yet created
    };

    let mut rows: Vec<RawRow> = Vec::new();

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

        // Bounded head-read: enough to capture the (line-1) frontmatter marker. A codepoint
        // split at the byte cap is harmless — the marker lives in the first ~5 lines, and the
        // lossy decode never panics on a split multibyte sequence.
        let head = read_head_string(&path, FRONTMATTER_HEAD_BYTES);
        // Split frontmatter once; the marker rides the yaml half and the H1 scan rides the
        // body half (which the old code discarded as `_body`). Near-zero added I/O — same
        // bounded head read that already runs on every entry / `plan-changed`.
        let (marker, h1s) = match head.as_deref() {
            Some(h) => {
                let (yaml, body) = split_frontmatter(h);
                (yaml.and_then(parse_marker), extract_h1s(body))
            }
            None => (None, Vec::new()),
        };

        rows.push(RawRow {
            stem,
            absolute_path: abs,
            mtime_ms,
            cwd,
            unread,
            marker,
            h1s,
        });
    }

    // Pure ordering + flavor-normalization (replaces the old `sort_newest_first`).
    let records = arrange_plans(rows, &collapse_state);

    // Prune collapse-state entries whose tree_id no longer appears in ANY record (keeps the
    // persisted file from accumulating dead trees). Cheap — the full record set is in hand.
    let live_tree_ids: std::collections::HashSet<&str> = records
        .iter()
        .filter_map(|r| r.tree_id.as_deref())
        .collect();
    let stale: Vec<String> = collapse_state
        .keys()
        .filter(|k| !live_tree_ids.contains(k.as_str()))
        .cloned()
        .collect();
    if !stale.is_empty() {
        let snapshot = {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            for k in &stale {
                guard.collapse_state.remove(k);
            }
            guard.collapse_state.clone()
        };
        persist_collapse_state(&data_dir, &snapshot);
    }

    records
}

/// Bytes of the head of each plan file read by `list_plans` for marker detection. The marker
/// (YAML frontmatter) sits in the first few lines; ~8 KB is a generous bound that still keeps
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
/// plans dir — behavior is identical to the inline sort it replaced.
#[allow(dead_code)]
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

/// Parse a frontmatter YAML block into a `RawMarker` with a minimal line-based `key: value`
/// scan — deliberately NO `serde_yaml` (the marker is a fixed, skill-generated 2-3 key
/// block, so a full YAML parser is unwarranted dependency surface). Recognizes only the
/// keys `tree_id`, `flavor`, `nn`. Returns `None` when `tree_id` is missing or `flavor` is
/// absent/unrecognized. `nn` parses to `Some(u32)` when present and numeric.
fn parse_marker(yaml_block: &str) -> Option<RawMarker> {
    let mut tree_id: Option<String> = None;
    let mut flavor: Option<RawFlavor> = None;
    let mut nn: Option<u32> = None;

    for line in yaml_block.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        // Strip an optional trailing comment and surrounding whitespace/quotes from the value.
        let value = value.trim();
        let value = value.trim_matches(|c| c == '"' || c == '\'');
        match key {
            "tree_id" => {
                if !value.is_empty() {
                    tree_id = Some(value.to_string());
                }
            }
            "flavor" => {
                flavor = match value {
                    "master" => Some(RawFlavor::Master),
                    "sub" => Some(RawFlavor::Sub),
                    _ => None,
                };
            }
            "nn" => {
                nn = value.parse::<u32>().ok();
            }
            _ => {}
        }
    }

    Some(RawMarker {
        tree_id: tree_id?,
        flavor: flavor?,
        nn,
    })
}

/// THE pure, testable core of the nested-hierarchy ordering. Given the raw per-file rows and
/// the persisted collapse map, produce the final `Vec<PlanRecord>` pre-ordered for direct
/// top-level rendering by the frontend (no re-aggregation). Pure ⇒ unit-testable without
/// Tauri state or real files (mirrors the `sort_newest_first` / `compute_unread` split).
///
/// Rules (closed flavor set with deterministic tie-breaks — see CONTRACT.md §"Sub-Plan 01"):
///   - No marker ⇒ standalone.
///   - `master` marker ⇒ master; `child_count` = count of PRESENT subs sharing its tree_id.
///   - duplicate masters on one tree_id ⇒ newest-mtime kept (tie: lexicographic stem);
///     the rest demoted to standalone (tree_id/nn nulled).
///   - `sub` marker WITH a surviving master of the same tree_id ⇒ sub.
///   - `sub` marker WITHOUT a master (orphan) ⇒ standalone (tree_id/nn nulled).
///   - Top level (masters + standalones) interleaved by recency DESC; a master's recency =
///     max mtime over {master file, all present children}.
///   - Each master is immediately followed by its children in `nn` ASCENDING order; a
///     `nn` collision breaks by `(nn, mtime_ms, stem)` for full determinism.
fn arrange_plans(rows: Vec<RawRow>, collapse_state: &HashMap<String, bool>) -> Vec<PlanRecord> {
    // ---- Phase 1: identify the surviving master per tree_id (duplicate demotion). ----
    // For each tree_id, collect candidate master rows; pick newest-mtime, tie lexicographic
    // stem. The surviving master's stem is recorded so the others can be demoted.
    let mut master_candidates: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(m) = &row.marker {
            if m.flavor == RawFlavor::Master {
                master_candidates
                    .entry(m.tree_id.clone())
                    .or_default()
                    .push(i);
            }
        }
    }

    // surviving_master[tree_id] = index of the winning master row.
    let mut surviving_master: HashMap<String, usize> = HashMap::new();
    for (tree_id, idxs) in &master_candidates {
        // newest-mtime first, tie → lexicographically-smallest stem.
        let winner = idxs
            .iter()
            .copied()
            .max_by(|&a, &b| {
                rows[a]
                    .mtime_ms
                    .cmp(&rows[b].mtime_ms)
                    // On an mtime tie we want the lexicographically SMALLEST stem to win, so
                    // invert the stem comparison inside the max.
                    .then_with(|| rows[b].stem.cmp(&rows[a].stem))
            })
            .expect("non-empty candidate list");
        surviving_master.insert(tree_id.clone(), winner);
    }

    // ---- Phase 2: classify each row into (Flavor, tree_id, nn). ----
    // children[tree_id] = Vec of child row indices (only subs whose master survives).
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();

    #[derive(Clone)]
    struct Classified {
        flavor: Flavor,
        tree_id: Option<String>,
        nn: Option<u32>,
    }
    let mut classified: Vec<Classified> = Vec::with_capacity(rows.len());

    for (i, row) in rows.iter().enumerate() {
        let c = match &row.marker {
            None => Classified {
                flavor: Flavor::Standalone,
                tree_id: None,
                nn: None,
            },
            Some(m) => match m.flavor {
                RawFlavor::Master => {
                    if surviving_master.get(&m.tree_id) == Some(&i) {
                        Classified {
                            flavor: Flavor::Master,
                            tree_id: Some(m.tree_id.clone()),
                            nn: None,
                        }
                    } else {
                        // A duplicate (non-surviving) master ⇒ demote to standalone.
                        Classified {
                            flavor: Flavor::Standalone,
                            tree_id: None,
                            nn: None,
                        }
                    }
                }
                RawFlavor::Sub => {
                    if surviving_master.contains_key(&m.tree_id) {
                        children.entry(m.tree_id.clone()).or_default().push(i);
                        Classified {
                            flavor: Flavor::Sub,
                            tree_id: Some(m.tree_id.clone()),
                            nn: m.nn,
                        }
                    } else {
                        // Orphan sub (no surviving master) ⇒ standalone, tree_id/nn nulled.
                        Classified {
                            flavor: Flavor::Standalone,
                            tree_id: None,
                            nn: None,
                        }
                    }
                }
            },
        };
        classified.push(c);
    }

    // ---- Phase 3: build PlanRecords + per-master observed child_count + recency. ----
    let build_record = |i: usize, c: &Classified, child_count: Option<u32>| -> PlanRecord {
        let collapsed = match (&c.flavor, &c.tree_id) {
            (Flavor::Master, Some(tid)) => collapse_state.get(tid).copied().unwrap_or(false),
            _ => false,
        };
        PlanRecord {
            absolute_path: rows[i].absolute_path.clone(),
            filename_stem: rows[i].stem.clone(),
            mtime_ms: rows[i].mtime_ms,
            cwd: rows[i].cwd.clone(),
            unread: rows[i].unread,
            flavor: c.flavor,
            tree_id: c.tree_id.clone(),
            nn: c.nn,
            child_count,
            collapsed,
            h1s: rows[i].h1s.clone(),
        }
    };

    // ---- Phase 4: order children per master (nn ascending; tie (nn, mtime, stem)). ----
    let order_children = |idxs: &[usize]| -> Vec<usize> {
        let mut v = idxs.to_vec();
        v.sort_by(|&a, &b| {
            let na = rows[a].marker.as_ref().and_then(|m| m.nn);
            let nb = rows[b].marker.as_ref().and_then(|m| m.nn);
            // Subs without an explicit nn sort last among children (None > Some via wrapping).
            let ka = na.unwrap_or(u32::MAX);
            let kb = nb.unwrap_or(u32::MAX);
            ka.cmp(&kb)
                .then_with(|| rows[a].mtime_ms.cmp(&rows[b].mtime_ms))
                .then_with(|| rows[a].stem.cmp(&rows[b].stem))
        });
        v
    };

    // ---- Phase 5: top-level entries (masters + standalones) with recency. ----
    // A top-level entry is either a master (with its ordered children) or a standalone.
    struct TopLevel {
        recency: i64,
        // Tie-break key for deterministic ordering when recencies are equal.
        stem: String,
        master_idx: usize,
        ordered_children: Vec<usize>,
        is_master: bool,
    }

    let mut top: Vec<TopLevel> = Vec::new();
    for (i, c) in classified.iter().enumerate() {
        match c.flavor {
            Flavor::Master => {
                let tid = c.tree_id.as_ref().expect("master has tree_id");
                let kids = children.get(tid).map(|v| order_children(v)).unwrap_or_default();
                // Recency = max(master mtime, all present children mtimes).
                let recency = kids
                    .iter()
                    .map(|&k| rows[k].mtime_ms)
                    .chain(std::iter::once(rows[i].mtime_ms))
                    .max()
                    .unwrap_or(rows[i].mtime_ms);
                top.push(TopLevel {
                    recency,
                    stem: rows[i].stem.clone(),
                    master_idx: i,
                    ordered_children: kids,
                    is_master: true,
                });
            }
            Flavor::Standalone => {
                top.push(TopLevel {
                    recency: rows[i].mtime_ms,
                    stem: rows[i].stem.clone(),
                    master_idx: i,
                    ordered_children: Vec::new(),
                    is_master: false,
                });
            }
            // Subs are emitted under their master, never at the top level.
            Flavor::Sub => {}
        }
    }

    // Top level: recency DESC, then stem ASC for a stable, deterministic tie-break.
    top.sort_by(|a, b| {
        b.recency
            .cmp(&a.recency)
            .then_with(|| a.stem.cmp(&b.stem))
    });

    // ---- Phase 6: flatten into the final display-ordered Vec. ----
    let mut out: Vec<PlanRecord> = Vec::with_capacity(rows.len());
    for entry in &top {
        if entry.is_master {
            let child_count = entry.ordered_children.len() as u32;
            out.push(build_record(
                entry.master_idx,
                &classified[entry.master_idx],
                Some(child_count),
            ));
            for &k in &entry.ordered_children {
                out.push(build_record(k, &classified[k], None));
            }
        } else {
            out.push(build_record(
                entry.master_idx,
                &classified[entry.master_idx],
                None,
            ));
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
    // Sub-Plan 01: strip a leading frontmatter marker so the reading pane never renders it.
    // Uses the SAME `split_frontmatter` as `list_plans` (single source of truth — the two
    // read paths can never disagree on the boundary). Legacy plans (no frontmatter) pass
    // through byte-for-byte unchanged.
    let (_marker, body) = split_frontmatter(&content);
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
// Sub-Plan 03 — managed AppState, persisted cwd cache + read/unread state,
// and the productionized (single-pass, priority-preserving) cwd resolver.
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
    /// tree_id → collapsed. ABSENT means expanded (the default). Persisted to
    /// `collapse-state.json`. Only master `tree_id`s are meaningful keys.
    collapse_state: HashMap<String, bool>,
    /// plan absolute_path → its comments. ABSENT means no comments. Persisted to
    /// `comments.json`. The backend is the single source of truth for the comment count.
    comments: HashMap<String, Vec<CommentRecord>>,
}

const CWD_CACHE_FILE: &str = "cwd-cache.json";
const READ_STATE_FILE: &str = "read-state.json";
const COLLAPSE_STATE_FILE: &str = "collapse-state.json";
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

/// Load the persisted collapse state. Absent ⇒ empty (everything expanded). Corrupt/
/// unparseable ⇒ log + empty WITHOUT rewriting the bad file (non-destructive). Never panics.
/// Exact shape-twin of `load_cwd_cache`.
fn load_collapse_state(dir: &Path) -> HashMap<String, bool> {
    let path = dir.join(COLLAPSE_STATE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(), // absent ⇒ empty (all expanded)
    };
    match serde_json::from_slice::<HashMap<String, bool>>(&bytes) {
        Ok(map) => map,
        Err(e) => {
            eprintln!(
                "[state] {COLLAPSE_STATE_FILE} is corrupt ({e}); ignoring (all expanded, in-memory only)"
            );
            HashMap::new()
        }
    }
}

/// Persist the collapse state atomically. No-op (logs) when there's no data dir or on write
/// error. Exact shape-twin of `persist_cwd_cache`.
fn persist_collapse_state(data_dir: &Option<PathBuf>, map: &HashMap<String, bool>) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(map) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize collapse state: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(COLLAPSE_STATE_FILE), &bytes) {
        eprintln!("[state] failed to persist {COLLAPSE_STATE_FILE}: {e}");
    }
}

/// Load the persisted comments map. Absent ⇒ empty. Corrupt/unparseable ⇒ log + empty WITHOUT
/// rewriting the bad file (non-destructive). Never panics. Exact shape-twin of
/// `load_collapse_state`.
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
/// error. Exact shape-twin of `persist_collapse_state`.
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

// ---- cwd resolver (ported + inverted from cwd_spike.rs) --------------------

/// Provenance of a stem→cwd match, in priority order. `PlanModeAttachment` is authoritative
/// and is NEVER downgraded by a later weaker match (the spike's acceptance gate, preserved
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
/// `<session>/subagents/agent-*.jsonl`. Mirrors the spike's `collect_transcripts`, but takes
/// the root as a parameter so tests can point it at a fabricated temp corpus.
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

// ---- Sub-Plan 03 commands --------------------------------------------------

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

/// Set (and persist) the collapsed state for a master's `tree_id`. Mirrors `mark_viewed`'s
/// snapshot-then-persist-outside-lock discipline: mutate the in-memory map under the lock,
/// clone a snapshot, release the lock, then write to disk (the `std::sync::Mutex` is never
/// held across the blocking file I/O).
#[tauri::command]
fn set_tree_collapsed(tree_id: String, collapsed: bool, state: tauri::State<'_, Mutex<AppState>>) {
    let (snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.collapse_state.insert(tree_id, collapsed);
        (guard.collapse_state.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_collapse_state(&data_dir, &snapshot);
}

// ---- Sub-Plan 02 comment commands (shape-twins of set_tree_collapsed) -------
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

// ============================================================================
// Phase 4 — headless plan-review commands + control-dir watcher + heartbeat.
//
// The hook (hook.sh) drops `requests/<id>.json`, the control-dir watcher emits
// `plan-review-requested`, the frontend renders the prompt, the user decides,
// and `respond_to_review` writes `responses/<id>.json` which the hook is polling.
// `app.alive` is a heartbeat the hook stat's to decide whether to block at all.
// ============================================================================

/// True iff a control-dir filename should be IGNORED by the watcher / listers: the in-flight
/// atomic-write temp (`.tmp-…`) and any other dotfile. Centralized so the watcher and
/// `list_pending_reviews` apply the identical skip rule.
fn is_ignored_control_filename(name: &str) -> bool {
    name.starts_with('.') || name.starts_with(".tmp-")
}

/// List the pending review requests (newest-first by `created_ms`). Reads `requests_dir()`,
/// parses each `*.json` (skipping dot/temp files and unparseable files), and returns the
/// `ReviewRequest`s. A missing dir is not an error — it yields an empty list.
#[tauri::command]
fn list_pending_reviews() -> Result<Vec<ReviewRequest>, String> {
    let Some(dir) = requests_dir() else {
        return Ok(Vec::new());
    };
    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(Vec::new()), // dir not yet created ⇒ empty
    };

    let mut out: Vec<ReviewRequest> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if is_ignored_control_filename(name) {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue, // unreadable ⇒ skip
        };
        match serde_json::from_slice::<ReviewRequest>(&bytes) {
            Ok(req) => out.push(req),
            Err(_) => continue, // unparseable (e.g. partial write) ⇒ skip
        }
    }

    // Newest-first by created_ms.
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    Ok(out)
}

/// Read the plan text for a single pending review. Containment is enforced by the guarded
/// `request_path_for` (rejects an id that escapes `requests/`); the file must exist and parse.
#[tauri::command]
fn read_review_plan(review_id: String) -> Result<String, String> {
    let path = request_path_for(&review_id)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("read failed: {e}"))?;
    let req: ReviewRequest =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse failed: {e}"))?;
    Ok(req.plan_text)
}

/// The decision vocabulary, per the wire protocol (hook + frontend + CONTRACT.md): a decision is
/// valid iff it is EXACTLY `"allow"` or `"deny"` (case-sensitive). Pure, so it is unit-testable
/// without the Tauri command surface.
fn is_valid_decision(d: &str) -> bool {
    d == "allow" || d == "deny"
}

/// Write the user's decision for a review. Rejects any decision other than `allow`/`deny`,
/// builds a `ReviewResponse`, and atomically writes it to the guarded
/// `responses/<review_id>.json` path (where the polling hook will find it).
#[tauri::command]
fn respond_to_review(review_id: String, decision: String, reason: String) -> Result<(), String> {
    if !is_valid_decision(&decision) {
        return Err(format!("invalid decision: {decision}"));
    }
    // Ensure the responses dir exists so the guarded path builder (which canonicalizes the
    // parent) and the atomic write both succeed.
    if let Some(dir) = responses_dir() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let path = response_path_for(&review_id)?;
    let resp = ReviewResponse {
        schema: REVIEW_SCHEMA,
        review_id,
        decision,
        reason,
    };
    let bytes = serde_json::to_vec_pretty(&resp).map_err(|e| format!("serialize failed: {e}"))?;
    atomic_write(&path, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

/// Best-effort: bring the main window to the foreground (show + unminimize + focus). Each
/// step's error is ignored — surfacing a review must never fail because, e.g., the window was
/// already visible. Returns Ok unless the window can't be found at all.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("main window not found".to_string());
    };
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    Ok(())
}

/// The hook script content, written verbatim to `~/.claude/plan-reader/hook.sh` by
/// `install_hook`. The `$(...)`/`set` usage is INTENTIONAL shell (this is file content, not a
/// command we run) and mirrors the existing `plan-tree-save-plan.sh`.
const HOOK_SCRIPT: &str = r#"#!/usr/bin/env bash
# Plan Reader: PreToolUse/ExitPlanMode hook. Writes a review request and blocks
# until the app responds, or falls through (exit 0, no decision) on timeout /
# app-not-running / missing jq. plan_text is passed as DATA via jq --arg.
set -uo pipefail

# Fail OPEN if jq is missing — never turn a missing tool into a stall.
command -v jq >/dev/null 2>&1 || exit 0

PLAN_READER_DIR="$HOME/.claude/plan-reader"
REQUESTS_DIR="$PLAN_READER_DIR/requests"
RESPONSES_DIR="$PLAN_READER_DIR/responses"
ALIVE="$PLAN_READER_DIR/app.alive"

INPUT=$(cat)

PLAN=$(printf '%s' "$INPUT" | jq -r '.tool_input.plan // empty')
[ -z "$PLAN" ] && exit 0

# Fast fallthrough: app not running (no heartbeat, or stale > 10s) → don't block.
[ -f "$ALIVE" ] || exit 0
NOW=$(date +%s)
MTIME=$(stat -f %m "$ALIVE" 2>/dev/null || echo 0)
[ $(( NOW - MTIME )) -gt 10 ] && exit 0

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
SID=$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9._-')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')
PLANFILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.planFilePath // empty')

mkdir -p "$REQUESTS_DIR" "$RESPONSES_DIR"

NANOS="${NOW}000000000"
RAND=$(jot -r 1 100000 999999 2>/dev/null || echo "$RANDOM")
REVIEW_ID="${SID}-${NANOS}-${RAND}"

REQ="$REQUESTS_DIR/${REVIEW_ID}.json"
RESP="$RESPONSES_DIR/${REVIEW_ID}.json"
TMP="$REQUESTS_DIR/.tmp-$$-${REVIEW_ID}.json"

jq -n \
  --arg review_id "$REVIEW_ID" \
  --arg session_id "$SID" \
  --arg cwd "$CWD" \
  --arg transcript_path "$TRANSCRIPT" \
  --arg plan_text "$PLAN" \
  --arg plan_file_path "$PLANFILE" \
  --argjson schema 1 \
  --argjson created_ms "${NOW}000" \
  '{schema:$schema, review_id:$review_id, session_id:$session_id, cwd:$cwd, transcript_path:$transcript_path, plan_text:$plan_text, plan_file_path:$plan_file_path, created_ms:$created_ms}' \
  > "$TMP"
mv -f "$TMP" "$REQ"

cleanup() { rm -f "$REQ" "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

DEADLINE=$(( NOW + 570 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$RESP" ]; then
    DECISION=$(jq -r '.decision // empty' "$RESP" 2>/dev/null || echo "")
    REASON=$(jq -r '.reason // empty' "$RESP" 2>/dev/null || echo "")
    rm -f "$RESP" 2>/dev/null || true
    if [ "$DECISION" = "allow" ] || [ "$DECISION" = "deny" ]; then
      jq -n --arg d "$DECISION" --arg r "$REASON" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
      exit 0
    fi
  fi
  # Re-check the heartbeat INSIDE the loop: if the app quit mid-review, app.alive stops
  # being touched (or is removed → stat fails → MTIME=0 → huge age), so fall through within
  # ~10s rather than blocking up to the full deadline.
  MTIME=$(stat -f %m "$ALIVE" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - MTIME )) -gt 10 ] && exit 0
  sleep 1
done
exit 0
"#;

/// Install the headless-review hook: write `hook.sh` (mode 0755) and merge the `ExitPlanMode`
/// PreToolUse entry into `~/.claude/settings.json` (idempotent additive merge — never clobbers
/// an unrelated hook). The hook's absolute path is what gets written into settings.
#[tauri::command]
fn install_hook(app: tauri::AppHandle) -> Result<(), String> {
    // We don't need `app` directly here, but the command takes it for symmetry / future use.
    let _ = app;

    // 1. Ensure the plan-reader dir tree exists.
    let base = plan_reader_dir().ok_or_else(|| "could not locate home directory".to_string())?;
    std::fs::create_dir_all(&base).map_err(|e| format!("mkdir failed: {e}"))?;
    if let Some(d) = requests_dir() {
        std::fs::create_dir_all(&d).map_err(|e| format!("mkdir requests failed: {e}"))?;
    }
    if let Some(d) = responses_dir() {
        std::fs::create_dir_all(&d).map_err(|e| format!("mkdir responses failed: {e}"))?;
    }

    // 2. Write hook.sh, then chmod 0755.
    let hook_path = base.join("hook.sh");
    std::fs::write(&hook_path, HOOK_SCRIPT).map_err(|e| format!("write hook.sh failed: {e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&hook_path, perms)
            .map_err(|e| format!("chmod hook.sh failed: {e}"))?;
    }

    // 3. Resolve the absolute hook path string we just wrote.
    let abs_hook = hook_path.to_string_lossy().to_string();

    // 4. Merge into ~/.claude/settings.json (default to {} when missing).
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "could not locate home directory".to_string())?
        .join(".claude")
        .join("settings.json");
    let current = read_settings_value(&settings_path)?;
    let merged = merge_install_hook(current, &abs_hook);
    let bytes =
        serde_json::to_vec_pretty(&merged).map_err(|e| format!("serialize settings failed: {e}"))?;
    // Back up the existing (parseable) settings before overwriting, for a recovery path.
    backup_settings(&settings_path);
    atomic_write(&settings_path, &bytes).map_err(|e| format!("write settings failed: {e}"))?;
    Ok(())
}

/// Uninstall the headless-review hook from `~/.claude/settings.json` (idempotent removal). The
/// `hook.sh` file is intentionally LEFT on disk — harmless and avoids racing a running hook.
#[tauri::command]
fn uninstall_hook() -> Result<(), String> {
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "could not locate home directory".to_string())?
        .join(".claude")
        .join("settings.json");
    let current = read_settings_value(&settings_path)?;
    let merged = merge_uninstall_hook(current);
    let bytes =
        serde_json::to_vec_pretty(&merged).map_err(|e| format!("serialize settings failed: {e}"))?;
    // Back up the existing (parseable) settings before overwriting, for a recovery path.
    backup_settings(&settings_path);
    atomic_write(&settings_path, &bytes).map_err(|e| format!("write settings failed: {e}"))?;
    Ok(())
}

/// Auto-detect whether OUR `ExitPlanMode` PreToolUse hook is currently installed in
/// `~/.claude/settings.json`. Drives the single-click Install XOR Remove button UX (no
/// two-click confirm). Failure policy: file ABSENT ⇒ `Ok(false)` (nothing installed); file
/// present but UNPARSEABLE ⇒ `Ok(false)` (we can't confirm our entry — `install_hook` still
/// guards a corrupt config separately and refuses to overwrite it); else
/// `Ok(hook_is_installed(&value))`. Never returns Err except for an unlocatable home dir.
#[tauri::command]
fn hook_status() -> Result<bool, String> {
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "could not locate home directory".to_string())?
        .join(".claude")
        .join("settings.json");
    let bytes = match std::fs::read(&settings_path) {
        Ok(b) => b,
        Err(_) => return Ok(false), // absent ⇒ not installed
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => Ok(hook_is_installed(&value)),
        Err(_) => Ok(false), // unparseable ⇒ can't confirm our entry
    }
}

/// Read `settings.json` into a `serde_json::Value`, distinguishing the two failure modes so a
/// momentarily-corrupt file can NEVER be clobbered:
///   - file ABSENT ⇒ `Ok({})` (a fresh, empty settings object — nothing to preserve);
///   - file present + reads but FAILS to parse ⇒ `Err(...)` so install/uninstall refuse to write
///     (mirrors the non-destructive degrade of `load_cwd_cache`/`load_read_state`, which never
///     rewrite a corrupt file);
///   - file parses ⇒ `Ok(value)`.
fn read_settings_value(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            "~/.claude/settings.json is not valid JSON — refusing to modify it to avoid \
             clobbering your config"
                .to_string()
        }),
        Err(_) => Ok(Value::Object(serde_json::Map::new())), // absent ⇒ fresh object
    }
}

/// Best-effort backup of an existing, parseable settings file to
/// `~/.claude/settings.json.plan-reader.bak` before we rewrite it. A backup-write failure is
/// logged and ignored — it must never abort the install/uninstall (the merge itself is the
/// safety-critical step). No-op when the source file does not exist.
fn backup_settings(settings_path: &Path) {
    if !settings_path.exists() {
        return;
    }
    let backup_path = settings_path.with_file_name("settings.json.plan-reader.bak");
    if let Err(e) = std::fs::copy(settings_path, &backup_path) {
        eprintln!("[settings] backup to {} failed: {e}", backup_path.display());
    }
}

/// Max age (seconds) before a control file (a `requests/`/`responses/` entry) is considered an
/// orphan and pruned. A live review never lives this long (the hook deadline is 570s and the
/// app responds far sooner), so anything older is from a SIGKILLed/timed-out hook.
const CONTROL_FILE_MAX_AGE_SECS: u64 = 600;

/// Best-effort prune of orphaned control files. Deletes any entry in `requests_dir()` /
/// `responses_dir()` whose mtime is older than `CONTROL_FILE_MAX_AGE_SECS`. This intentionally
/// includes `.tmp-…` and other dotfiles — stale temps are exactly the orphans we want to age
/// out. `app.alive` lives in `plan_reader_dir()` (not requests/responses), so it is never
/// touched. Every error is swallowed (panic-safe): a failed prune just leaves the file for the
/// next tick.
fn prune_stale_control_files() {
    let now = SystemTime::now();
    for dir in [requests_dir(), responses_dir()].into_iter().flatten() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue; // dir not yet created ⇒ nothing to prune
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            let age = now.duration_since(mtime).unwrap_or(Duration::ZERO);
            if age.as_secs() > CONTROL_FILE_MAX_AGE_SECS {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Spawn the heartbeat thread: touch `app.alive` every 5s so the hook knows the app is live.
/// Also opportunistically prunes orphaned control files (cheap — once per loop tick). Panic-safe
/// — directory creation and every write error are ignored (a missed heartbeat just makes the
/// hook fall through, which is the safe failure mode).
fn spawn_heartbeat() {
    std::thread::spawn(|| {
        if let Some(dir) = plan_reader_dir() {
            let _ = std::fs::create_dir_all(&dir);
        }
        loop {
            if let Some(path) = app_alive_path() {
                let _ = std::fs::write(&path, b"");
            }
            prune_stale_control_files();
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

/// Newtype wrapper so the control-dir debouncer can live in Tauri managed state alongside the
/// plans-dir debouncer. `app.manage` is keyed by TYPE; both debouncers share the same concrete
/// `Debouncer` type, so without distinct wrapper types the second `manage` would silently
/// collide with the first. This wrapper gives the control debouncer its own type key.
struct ControlWatcher<T>(#[allow(dead_code)] T);

/// Start the debounced watcher on the CONTROL dir (`requests/`, non-recursive). Emits
/// `plan-review-requested` on a created/modified `requests/<id>.json`, and
/// `plan-review-cancelled` on a removed one. SEPARATE from `start_watcher` — the plans-dir
/// watcher and its `plan-changed` path are untouched. Returns the live debouncer to keep alive.
fn start_control_watcher(app: tauri::AppHandle) -> Option<impl Sized> {
    let dir = requests_dir()?;

    let app_for_handler = app.clone();
    let mut debouncer = match new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(errs) => {
                    for e in errs {
                        eprintln!("[control-watcher] debounce error: {e:?}");
                    }
                    return;
                }
            };

            for ev in events {
                let kind = ev.kind;
                let is_remove = matches!(kind, EventKind::Remove(_));
                let is_upsert = matches!(
                    kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
                );
                if !is_remove && !is_upsert {
                    continue;
                }
                for p in ev.paths.iter() {
                    // *.json only.
                    let is_json = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("json"))
                        .unwrap_or(false);
                    if !is_json {
                        continue;
                    }
                    // Skip dotfiles / in-flight atomic-write temps.
                    let name = match p.file_name().and_then(|n| n.to_str()) {
                        Some(n) => n,
                        None => continue,
                    };
                    if is_ignored_control_filename(name) {
                        continue;
                    }
                    // review_id is the file stem; validate before trusting it.
                    let review_id = match p.file_stem().and_then(|s| s.to_str()) {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    if !valid_review_id(&review_id) {
                        continue;
                    }

                    if is_remove {
                        let payload = ReviewCancelled {
                            review_id: review_id.clone(),
                        };
                        if let Err(e) = app_for_handler.emit("plan-review-cancelled", payload) {
                            eprintln!("[control-watcher] emit cancelled failed: {e:?}");
                        }
                        continue;
                    }

                    // Upsert: read + parse the request. On parse failure, no-op — the atomic
                    // rename's settled event (a later modify/create) will arrive with full JSON.
                    let bytes = match std::fs::read(p) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let req: ReviewRequest = match serde_json::from_slice(&bytes) {
                        Ok(r) => r,
                        Err(_) => continue, // partial / unparseable ⇒ wait for the settled event
                    };
                    let payload = ReviewRequested {
                        review_id: review_id.clone(),
                        plan_text: req.plan_text,
                        plan_file_path: req.plan_file_path,
                    };
                    if let Err(e) = app_for_handler.emit("plan-review-requested", payload) {
                        eprintln!("[control-watcher] emit requested failed: {e:?}");
                    }
                }
            }
        },
    ) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[control-watcher] failed to create debouncer: {e:?}");
            return None;
        }
    };

    match debouncer.watch(&dir, RecursiveMode::NonRecursive) {
        Ok(()) => {
            println!("[control-watcher] watching {}", dir.display());
        }
        Err(e) => {
            eprintln!(
                "[control-watcher] could not watch {} (dir may not exist yet): {e:?}",
                dir.display()
            );
        }
    }

    Some(debouncer)
}

/// Build the initial `AppState`: locate + create the data dir, load both persisted files
/// (degrading on any failure), and seed the read-state baseline on first launch. Pure-ish:
/// takes the resolved data dir Option so `setup()` can wire it from `app.path()`.
fn init_app_state(data_dir: Option<PathBuf>) -> AppState {
    let (cwd_cache, read_state, seed_baseline, collapse_state, comments) = match &data_dir {
        Some(dir) => {
            let cwd_cache = load_cwd_cache(dir);
            let (read_state, seeded) = load_read_state(dir);
            let collapse_state = load_collapse_state(dir);
            let comments = load_comments(dir);
            (cwd_cache, read_state, seeded, collapse_state, comments)
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
                HashMap::new(),
            )
        }
    };

    let state = AppState {
        cwd_cache,
        read_state,
        open_path: None,
        data_dir: data_dir.clone(),
        collapse_state,
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
            // Sub-Plan 03: manage AppState UNCONDITIONALLY (independent of watcher success)
            // so the `State` extractor in list_plans / mark_viewed / etc. can never hit
            // "state not managed". Locate + create the data dir; all persistence degrades to
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

            // Phase 4: ensure the control dirs exist so the guarded path builders (which
            // canonicalize the parent) and the control-dir watcher can operate. Best-effort —
            // failures degrade (the commands re-create on demand; the watcher logs + no-ops).
            if let Some(d) = requests_dir() {
                let _ = std::fs::create_dir_all(&d);
            }
            if let Some(d) = responses_dir() {
                let _ = std::fs::create_dir_all(&d);
            }

            // Phase 4: prune orphaned control files left by SIGKILLed/timed-out hooks ONCE at
            // startup (before any launch recovery), then again on every heartbeat tick.
            prune_stale_control_files();

            // Phase 4: heartbeat thread — touches app.alive every 5s so the hook knows we are
            // live (a missed beat just makes the hook fall through, the safe failure mode).
            spawn_heartbeat();

            // Keep the debouncer alive for the lifetime of the app by stashing it in
            // managed state. Dropping it would stop the watch thread.
            if let Some(debouncer) = start_watcher(app.handle().clone()) {
                app.manage(Mutex::new(debouncer));
            }

            // Phase 4: SECOND debouncer on the control dir (requests/). Wrapped in the
            // `ControlWatcher` newtype so it gets a distinct type key in managed state (both
            // debouncers share the same concrete type — a bare `Mutex<Debouncer>` would
            // collide with the plans watcher above). Kept alive the same way: stashed in state.
            if let Some(debouncer) = start_control_watcher(app.handle().clone()) {
                app.manage(Mutex::new(ControlWatcher(debouncer)));
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
            set_tree_collapsed,
            get_comments,
            get_comment_count,
            set_comments,
            clear_comments,
            list_pending_reviews,
            read_review_plan,
            respond_to_review,
            focus_main_window,
            install_hook,
            uninstall_hook,
            hook_status
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
            flavor: Flavor::Standalone,
            tree_id: None,
            nn: None,
            child_count: None,
            collapsed: false,
            h1s: Vec::new(),
        }
    }

    /// Locks the `PlanRecord` wire shape to the frozen hand-off contract (CONTRACT.md).
    /// Any serde drift — a `rename`, an added/removed field, or a casing change — flips
    /// the top-level key set or the `flavor` string and turns this RED.
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
            "flavor",
            "tree_id",
            "nn",
            "child_count",
            "collapsed",
            "h1s",
        ]
        .into_iter()
        .collect();

        // One record per flavor, exercising the lowercase `flavor` strings and the
        // None-valued option fields that the contract requires to be present-as-null.
        let master = PlanRecord {
            absolute_path: "/tmp/master.md".to_string(),
            filename_stem: "master".to_string(),
            mtime_ms: 1,
            cwd: None,
            unread: false,
            flavor: Flavor::Master,
            tree_id: Some("tree-1".to_string()),
            nn: None,
            child_count: Some(2),
            collapsed: true,
            h1s: vec!["Plan: master title".to_string()],
        };
        let sub = PlanRecord {
            absolute_path: "/tmp/01-sub.md".to_string(),
            filename_stem: "01-sub".to_string(),
            mtime_ms: 2,
            cwd: None,
            unread: false,
            flavor: Flavor::Sub,
            tree_id: Some("tree-1".to_string()),
            nn: Some(1),
            child_count: None,
            collapsed: false,
            h1s: Vec::new(),
        };
        let standalone = record_with_mtime("standalone", 3); // Flavor::Standalone, all options None

        for (record, expected_flavor) in [
            (&master, "master"),
            (&sub, "sub"),
            (&standalone, "standalone"),
        ] {
            let value = serde_json::to_value(record).unwrap();
            let obj = value
                .as_object()
                .expect("PlanRecord must serialize to a JSON object");

            // Top-level key set must equal the frozen contract exactly — no more, no less.
            let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
            assert_eq!(
                actual_keys, expected_keys,
                "PlanRecord top-level JSON keys drifted from the frozen contract \
                 (flavor = {expected_flavor})"
            );

            // `flavor` must serialize to the lowercase contract string.
            assert_eq!(
                obj.get("flavor"),
                Some(&serde_json::Value::String(expected_flavor.to_string())),
                "flavor must serialize to the lowercase string {expected_flavor:?}"
            );

            // Value TYPES of the always-present scalar fields must match the contract,
            // so a value-type drift (e.g. mtime_ms number->String) that keeps key names
            // still turns this RED.
            assert!(obj["absolute_path"].is_string(), "absolute_path must be a JSON string");
            assert!(obj["filename_stem"].is_string(), "filename_stem must be a JSON string");
            assert!(obj["mtime_ms"].is_i64() || obj["mtime_ms"].is_u64(), "mtime_ms must be a JSON integer");
            assert!(obj["unread"].is_boolean(), "unread must be a JSON boolean");
            assert!(obj["flavor"].is_string(), "flavor must be a JSON string");
            assert!(obj["collapsed"].is_boolean(), "collapsed must be a JSON boolean");
            assert!(obj["h1s"].is_array(), "h1s must be a JSON array (always present)");
        }

        // Populated option fields must carry the contract value types: `tree_id` a
        // string, `nn`/`child_count` integers (master has tree_id+child_count, sub has nn).
        let master_value = serde_json::to_value(&master).unwrap();
        assert!(master_value["tree_id"].is_string(), "tree_id must be a JSON string when populated");
        assert!(master_value["child_count"].is_u64(), "child_count must be a JSON integer when populated");
        let sub_value = serde_json::to_value(&sub).unwrap();
        assert!(sub_value["nn"].is_u64(), "nn must be a JSON integer when populated");

        // Contract: tree_id / nn / child_count are always-present keys; when the Rust
        // value is `None` they must serialize as JSON `null`, never be omitted.
        let standalone_value = serde_json::to_value(&standalone).unwrap();
        for key in ["tree_id", "nn", "child_count"] {
            assert_eq!(
                standalone_value.get(key),
                Some(&serde_json::Value::Null),
                "{key} must be present as JSON null when None, not omitted"
            );
        }
    }

    /// Build a `RawRow` for `arrange_plans` tests. `marker` is supplied separately.
    fn raw_row(stem: &str, mtime_ms: i64, marker: Option<RawMarker>) -> RawRow {
        RawRow {
            stem: stem.to_string(),
            absolute_path: format!("/tmp/{stem}.md"),
            mtime_ms,
            cwd: None,
            unread: false,
            marker,
            h1s: Vec::new(),
        }
    }

    fn master_marker(tree_id: &str) -> RawMarker {
        RawMarker {
            tree_id: tree_id.to_string(),
            flavor: RawFlavor::Master,
            nn: None,
        }
    }

    fn sub_marker(tree_id: &str, nn: u32) -> RawMarker {
        RawMarker {
            tree_id: tree_id.to_string(),
            flavor: RawFlavor::Sub,
            nn: Some(nn),
        }
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
                flavor: Flavor::Standalone,
                tree_id: None,
                nn: None,
                child_count: None,
                collapsed: false,
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
    // Sub-Plan 03 — unread, open-plan fiat, resolver, persistence, helpers.
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
    // Sub-Plan 01 — nested master/sub hierarchy (frontmatter, markers,
    // arrange_plans ordering/normalization, collapse persistence, two-read-paths).
    // ====================================================================

    // ---- split_frontmatter (verification item 1) -----------------------

    #[test]
    fn split_frontmatter_extracts_leading_block_and_body() {
        let content = "---\ntree_id: t\nflavor: master\n---\n# Title\n\nbody\n";
        let (yaml, body) = split_frontmatter(content);
        assert_eq!(
            yaml,
            Some("tree_id: t\nflavor: master\n"),
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
        let content = "--- \r\ntree_id: t\r\nflavor: sub\r\nnn: 2\r\n---\t\r\n# Title\r\n";
        let (yaml, body) = split_frontmatter(content);
        assert!(yaml.is_some(), "a CRLF/whitespace-padded fence must still be recognized");
        let marker = parse_marker(yaml.unwrap()).expect("parses");
        assert_eq!(marker.flavor, RawFlavor::Sub);
        assert_eq!(marker.nn, Some(2));
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
        let content = "---\ntree_id: t\nflavor: master\n# never closed\nbody\n";
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

    // ---- parse_marker (verification item 2) ----------------------------

    #[test]
    fn parse_marker_reads_master_block() {
        let m = parse_marker("tree_id: nested-2026\nflavor: master\n").expect("master parses");
        assert_eq!(m.tree_id, "nested-2026");
        assert_eq!(m.flavor, RawFlavor::Master);
        assert_eq!(m.nn, None);
    }

    #[test]
    fn parse_marker_reads_sub_block_with_nn() {
        let m = parse_marker("tree_id: nested-2026\nflavor: sub\nnn: 3\n").expect("sub parses");
        assert_eq!(m.tree_id, "nested-2026");
        assert_eq!(m.flavor, RawFlavor::Sub);
        assert_eq!(m.nn, Some(3));
    }

    #[test]
    fn parse_marker_missing_tree_id_is_none() {
        // No tree_id ⇒ None (a marker without a join key is useless).
        assert_eq!(parse_marker("flavor: master\n"), None);
    }

    #[test]
    fn parse_marker_bad_flavor_is_none() {
        // INVERT-CHECK target: an unrecognized flavor must yield None.
        assert_eq!(parse_marker("tree_id: t\nflavor: wizard\n"), None);
        // Absent flavor entirely ⇒ also None.
        assert_eq!(parse_marker("tree_id: t\n"), None);
    }

    // ---- arrange_plans (verification item 3) ---------------------------

    fn by_stem(records: &[PlanRecord], stem: &str) -> PlanRecord {
        records
            .iter()
            .find(|r| r.filename_stem == stem)
            .unwrap_or_else(|| panic!("no record for stem {stem}"))
            .clone()
    }

    #[test]
    fn arrange_master_then_two_subs_in_nn_order() {
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            raw_row("sub02", 2_000, Some(sub_marker("t", 2))),
            raw_row("sub01", 3_000, Some(sub_marker("t", 1))),
        ];
        let mut collapse = HashMap::new();
        collapse.insert("t".to_string(), true);
        let out = arrange_plans(rows, &collapse);

        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "sub01", "sub02"],
            "master first, then children in nn-ascending order (NOT mtime)"
        );
        let m = &out[0];
        assert_eq!(m.flavor, Flavor::Master);
        assert_eq!(m.child_count, Some(2), "observed child_count = 2");
        assert!(m.collapsed, "collapsed reflects the collapse map entry (true)");
        assert_eq!(out[1].flavor, Flavor::Sub);
        assert_eq!(out[1].nn, Some(1));
        assert_eq!(out[2].nn, Some(2));
        // Subs carry the join key; their child_count is null.
        assert_eq!(out[1].tree_id.as_deref(), Some("t"));
        assert_eq!(out[1].child_count, None);
    }

    #[test]
    fn arrange_orphan_sub_becomes_standalone() {
        // A sub with no surviving master of its tree_id ⇒ standalone, tree_id/nn nulled.
        let rows = vec![raw_row("orphan", 1_000, Some(sub_marker("ghost", 1)))];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].flavor, Flavor::Standalone);
        assert_eq!(out[0].tree_id, None, "orphan sub's tree_id must be nulled");
        assert_eq!(out[0].nn, None, "orphan sub's nn must be nulled");
    }

    #[test]
    fn arrange_master_with_zero_subs_has_child_count_zero() {
        let rows = vec![raw_row("lonely-master", 1_000, Some(master_marker("t")))];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].flavor, Flavor::Master);
        assert_eq!(out[0].child_count, Some(0), "a childless master reports child_count = 0");
        assert!(!out[0].collapsed, "absent collapse entry ⇒ expanded (false)");
    }

    #[test]
    fn arrange_observed_child_count_counts_only_present_subs() {
        // A master whose body would describe 3 subs but only 1 sub FILE is present ⇒
        // child_count = 1 (the OBSERVED count, which the "N sub-plans" label depends on).
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            raw_row("sub01", 2_000, Some(sub_marker("t", 1))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let m = by_stem(&out, "master");
        assert_eq!(m.child_count, Some(1), "observed count = present sub files, not body claims");
    }

    #[test]
    fn arrange_unmarked_file_is_standalone() {
        let rows = vec![raw_row("legacy", 1_000, None)];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].flavor, Flavor::Standalone);
        assert_eq!(out[0].tree_id, None);
        assert_eq!(out[0].child_count, None);
    }

    #[test]
    fn arrange_duplicate_masters_keeps_newest_and_demotes_rest() {
        // Two masters share tree_id "t". The NEWER-mtime one survives; the older is demoted
        // to standalone. The sub attaches to the surviving (newer) master.
        let rows = vec![
            raw_row("master-old", 1_000, Some(master_marker("t"))),
            raw_row("master-new", 5_000, Some(master_marker("t"))),
            raw_row("sub01", 2_000, Some(sub_marker("t", 1))),
        ];
        let out = arrange_plans(rows, &HashMap::new());

        let new = by_stem(&out, "master-new");
        let old = by_stem(&out, "master-old");
        assert_eq!(new.flavor, Flavor::Master, "newest-mtime master survives");
        assert_eq!(new.child_count, Some(1), "the sub attaches to the survivor");
        assert_eq!(old.flavor, Flavor::Standalone, "the older duplicate master is demoted");
        assert_eq!(old.tree_id, None, "demoted master's tree_id is nulled");
        assert_eq!(old.child_count, None);

        // The survivor must be immediately followed by its child in the output.
        let survivor_pos = out.iter().position(|r| r.filename_stem == "master-new").unwrap();
        assert_eq!(
            out[survivor_pos + 1].filename_stem, "sub01",
            "the sub must follow its surviving master"
        );
    }

    #[test]
    fn arrange_duplicate_master_mtime_tie_breaks_lexicographically() {
        // Equal mtime ⇒ lexicographically-smallest stem survives ("alpha" < "beta").
        let rows = vec![
            raw_row("beta", 1_000, Some(master_marker("t"))),
            raw_row("alpha", 1_000, Some(master_marker("t"))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(by_stem(&out, "alpha").flavor, Flavor::Master, "lexicographic tie-break: alpha wins");
        assert_eq!(by_stem(&out, "beta").flavor, Flavor::Standalone);
    }

    #[test]
    fn arrange_nn_collision_is_deterministic() {
        // Two subs share nn=1. Tie-break is (nn, mtime, stem) — deterministic, no dropped/
        // duplicated rows. The earlier-mtime sub comes first.
        let rows = vec![
            raw_row("master", 5_000, Some(master_marker("t"))),
            raw_row("sub-b", 3_000, Some(sub_marker("t", 1))),
            raw_row("sub-a", 2_000, Some(sub_marker("t", 1))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "sub-a", "sub-b"],
            "nn collision breaks by mtime asc then stem; no rows dropped"
        );
        assert_eq!(out.len(), 3, "all rows present, none duplicated");
        assert_eq!(by_stem(&out, "master").child_count, Some(2));
    }

    #[test]
    fn arrange_recency_interleave_and_children_stay_nn_ascending() {
        // A master whose NEWEST CHILD mtime (9_000) exceeds a standalone's mtime (8_000)
        // must sort ABOVE that standalone — even though the master FILE's own mtime (1_000)
        // is older. And children must emit nn-ascending even when their mtimes are out of
        // order relative to nn.
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            // sub01 (nn=1) has an EARLIER mtime than sub02 (nn=2). So nn-ascending order
            // [sub01, sub02] is the OPPOSITE of mtime-descending [sub02, sub01] — this makes
            // the children-ordering invariant genuinely falsifiable (a mtime sort goes red).
            raw_row("sub01", 4_000, Some(sub_marker("t", 1))),
            raw_row("sub02", 9_000, Some(sub_marker("t", 2))),
            raw_row("standalone-x", 8_000, None),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        // INVERT-CHECK target: children must be nn-ascending [sub01, sub02], NOT mtime-desc.
        assert_eq!(
            order,
            vec!["master", "sub01", "sub02", "standalone-x"],
            "master (recency=9000 via child) above standalone (8000); children nn-ascending"
        );
    }

    // ---- collapse round-trip (verification item 4) ---------------------

    #[test]
    fn collapse_state_round_trips() {
        let dir = unique_dir("collapseA");
        let mut map = HashMap::new();
        map.insert("tree-a".to_string(), true);
        map.insert("tree-b".to_string(), false);

        persist_collapse_state(&Some(dir.clone()), &map);
        let loaded = load_collapse_state(&dir);
        assert_eq!(loaded, map, "collapse state must round-trip write→read");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_collapse_state_is_empty() {
        let dir = unique_dir("collapseB"); // exists but has no collapse-state.json
        let loaded = load_collapse_state(&dir);
        assert!(loaded.is_empty(), "absent collapse state ⇒ empty (all expanded)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_collapse_state_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("collapseC");
        let path = dir.join(COLLAPSE_STATE_FILE);
        let garbage = b"{ not : valid json @@@";
        std::fs::write(&path, garbage).expect("write garbage");

        let loaded = load_collapse_state(&dir); // must not panic
        assert!(loaded.is_empty(), "corrupt collapse state ⇒ empty");

        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt collapse state must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- two read paths agree (verification item 5) --------------------

    /// A reader-equivalent of `read_plan_contents`'s strip step: read bytes, lossy-decode,
    /// return the body with any leading frontmatter stripped (the production command does
    /// exactly this after the containment guards, which a temp dir cannot satisfy).
    fn reader_body(path: &Path) -> String {
        let bytes = std::fs::read(path).expect("read");
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let (_m, body) = split_frontmatter(&content);
        body.to_string()
    }

    /// The list-side classification of a single file via its head: split + parse marker, then
    /// map to the closed flavor set via `arrange_plans` on a one-row corpus (with a master in
    /// the corpus so a sub is not orphan-demoted).
    fn list_side_flavor_of(path: &Path) -> Flavor {
        let head = read_head_string(path, FRONTMATTER_HEAD_BYTES).expect("head");
        let (yaml, _body) = split_frontmatter(&head);
        let marker = yaml.and_then(parse_marker);
        // To classify a `sub` without orphan-demotion, include a master of the same tree_id.
        let mut rows = vec![raw_row("the-file", 1_000, marker.clone())];
        if let Some(m) = &marker {
            if m.flavor == RawFlavor::Sub {
                rows.push(raw_row("companion-master", 500, Some(master_marker(&m.tree_id))));
            }
        }
        let out = arrange_plans(rows, &HashMap::new());
        out.iter()
            .find(|r| r.filename_stem == "the-file")
            .expect("the-file present")
            .flavor
    }

    #[test]
    fn two_read_paths_agree_for_marked_plan() {
        let dir = unique_dir("tworead");
        // A marked sub plan, mirroring the fixture shape.
        let marked = dir.join("humble-exploring-walrus.md");
        std::fs::write(
            &marked,
            "---\ntree_id: nested-sidebar-2026\nflavor: sub\nnn: 1\n---\n\n# Sub-Plan 01 — title\n\nbody\n",
        )
        .expect("write marked");

        // (a) The reader strips the marker → body starts with `#` (no leading `---`/tree_id).
        let body = reader_body(&marked);
        assert!(
            body.trim_start().starts_with('#'),
            "stripped body must start with a heading, got: {:?}",
            &body[..body.len().min(40)]
        );
        assert!(
            !body.contains("tree_id"),
            "stripped body must not contain the marker text"
        );

        // (b) The list head-parse classifies the SAME file as non-standalone.
        let flavor = list_side_flavor_of(&marked);
        assert_ne!(
            flavor,
            Flavor::Standalone,
            "the list path must classify a marked plan as non-standalone (got {flavor:?})"
        );
        assert_eq!(flavor, Flavor::Sub);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_read_paths_legacy_file_is_byte_unchanged_and_standalone() {
        let dir = unique_dir("tworead_legacy");
        let legacy = dir.join("old-plan.md");
        let original = "# Legacy Plan\n\nNo frontmatter here.\n\n---\n\nA mid-doc rule.\n";
        std::fs::write(&legacy, original).expect("write legacy");

        // Reader leaves a no-frontmatter file byte-for-byte unchanged.
        let body = reader_body(&legacy);
        assert_eq!(body, original, "legacy body must be byte-unchanged by the strip");

        // List path classifies it standalone.
        assert_eq!(list_side_flavor_of(&legacy), Flavor::Standalone);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ====================================================================
    // Sub-Plan 02 — comments persistence + set_comments semantics + wire freeze.
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

    // ====================================================================
    // Phase 3 — review wire types, path helpers, id validation, settings merge.
    // ====================================================================

    fn sample_review_request() -> ReviewRequest {
        ReviewRequest {
            schema: REVIEW_SCHEMA,
            review_id: "05ff0135-1e19-4617-b843-4c24acb5dd64-1717100000000000000-ab12".to_string(),
            session_id: "session-abc".to_string(),
            cwd: "/Users/charliekoster/Documents/repos/claude-plan-reader".to_string(),
            transcript_path: "/Users/charliekoster/.claude/projects/x/session.jsonl".to_string(),
            plan_text: "# Plan\n\nDo the thing.".to_string(),
            plan_file_path: "/Users/charliekoster/.claude/plans/do-the-thing.md".to_string(),
            created_ms: 1_717_100_000_000,
        }
    }

    fn sample_review_response() -> ReviewResponse {
        ReviewResponse {
            schema: REVIEW_SCHEMA,
            review_id: "05ff0135-1e19-4617-b843-4c24acb5dd64-1717100000000000000-ab12".to_string(),
            decision: "allow".to_string(),
            reason: "Looks good; ship it.".to_string(),
        }
    }

    /// Serialize → deserialize → equal. Falsifiable: change a field after the round-trip and
    /// the `assert_eq!` goes red.
    #[test]
    fn review_request_round_trips() {
        let req = sample_review_request();
        let json = serde_json::to_string(&req).expect("serialize");
        let back: ReviewRequest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(req, back, "ReviewRequest must survive a serde round-trip unchanged");
    }

    /// A request JSON written by the OLD hook (no `plan_file_path` key) must still deserialize,
    /// defaulting the missing field to `""` — this is the launch-recovery path against
    /// pre-existing request files. Falsifiable: remove `#[serde(default)]` on `plan_file_path`
    /// and this `from_str` errors instead of yielding `""`.
    #[test]
    fn review_request_without_plan_file_path_defaults_to_empty() {
        let legacy = r##"{
            "schema": 1,
            "review_id": "rid-1",
            "session_id": "sid",
            "cwd": "/c",
            "transcript_path": "/t",
            "plan_text": "# Plan",
            "created_ms": 1717100000000
        }"##;
        let req: ReviewRequest =
            serde_json::from_str(legacy).expect("legacy request (no plan_file_path) must parse");
        assert_eq!(
            req.plan_file_path, "",
            "missing plan_file_path must default to empty string"
        );
    }

    /// `is_valid_decision` accepts EXACTLY `"allow"`/`"deny"` and rejects everything else
    /// (the stale `"accept"`/`"reject"` vocabulary, empty, wrong case, and arbitrary text).
    /// Falsifiable: if `is_valid_decision` also accepted `"accept"`, the `!` assertion on
    /// `"accept"` would go red.
    #[test]
    fn decision_validation_accepts_only_allow_deny() {
        assert!(is_valid_decision("allow"), "\"allow\" must be valid");
        assert!(is_valid_decision("deny"), "\"deny\" must be valid");
        assert!(!is_valid_decision("accept"), "\"accept\" must be rejected (stale vocab)");
        assert!(!is_valid_decision("reject"), "\"reject\" must be rejected (stale vocab)");
        assert!(!is_valid_decision(""), "empty must be rejected");
        assert!(!is_valid_decision("ALLOW"), "decision is case-sensitive");
        assert!(!is_valid_decision("yes"), "arbitrary text must be rejected");
    }

    #[test]
    fn review_response_round_trips() {
        let resp = sample_review_response();
        let json = serde_json::to_string(&resp).expect("serialize");
        let back: ReviewResponse = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(resp, back, "ReviewResponse must survive a serde round-trip unchanged");
    }

    /// Locks the `ReviewRequest` wire shape to exactly 8 snake_case keys against the ACTUAL
    /// serialized JSON. Twin of `planrecord_wire_contract_is_frozen`.
    #[test]
    fn review_request_wire_contract_is_frozen() {
        use std::collections::BTreeSet;
        let expected_keys: BTreeSet<&str> = [
            "schema",
            "review_id",
            "session_id",
            "cwd",
            "transcript_path",
            "plan_text",
            "plan_file_path",
            "created_ms",
        ]
        .into_iter()
        .collect();

        let value = serde_json::to_value(sample_review_request()).unwrap();
        let obj = value.as_object().expect("ReviewRequest serializes to an object");
        let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(
            actual_keys, expected_keys,
            "ReviewRequest top-level JSON keys drifted from the frozen 8-key contract"
        );
        // Value types of the always-present fields.
        assert!(obj["schema"].is_u64(), "schema must be a JSON integer");
        assert_eq!(obj["schema"], Value::from(1), "schema must serialize as 1");
        assert!(obj["review_id"].is_string());
        assert!(obj["session_id"].is_string());
        assert!(obj["cwd"].is_string());
        assert!(obj["transcript_path"].is_string());
        assert!(obj["plan_text"].is_string());
        assert!(obj["plan_file_path"].is_string());
        assert!(obj["created_ms"].is_u64(), "created_ms must be a JSON integer");
    }

    /// Locks the `ReviewResponse` wire shape to exactly 4 snake_case keys.
    #[test]
    fn review_response_wire_contract_is_frozen() {
        use std::collections::BTreeSet;
        let expected_keys: BTreeSet<&str> =
            ["schema", "review_id", "decision", "reason"].into_iter().collect();

        let value = serde_json::to_value(sample_review_response()).unwrap();
        let obj = value.as_object().expect("ReviewResponse serializes to an object");
        let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(
            actual_keys, expected_keys,
            "ReviewResponse top-level JSON keys drifted from the frozen 4-key contract"
        );
        assert!(obj["schema"].is_u64());
        assert_eq!(obj["schema"], Value::from(1), "schema must serialize as 1");
        assert!(obj["review_id"].is_string());
        assert!(obj["decision"].is_string());
        assert!(obj["reason"].is_string());
    }

    /// `valid_review_id` accepts a realistic id and REJECTS traversal / separator / dotfile /
    /// empty forms. Falsifiable: each rejected case asserts `!valid_review_id(...)`, so if the
    /// guard let one through the test goes red.
    #[test]
    fn valid_review_id_accepts_and_rejects() {
        // Realistic minted id.
        assert!(valid_review_id(
            "05ff0135-1e19-4617-b843-4c24acb5dd64-1717100000000000000-ab12"
        ));
        // Plain alphanumerics + allowed punctuation.
        assert!(valid_review_id("abc_DEF-123.json2"));

        // Rejections.
        assert!(!valid_review_id(".."), "`..` must be rejected");
        assert!(!valid_review_id("."), "`.` must be rejected");
        assert!(!valid_review_id("../escape"), "parent traversal must be rejected");
        assert!(!valid_review_id("a/b"), "forward slash must be rejected");
        assert!(!valid_review_id("a\\b"), "backslash must be rejected");
        assert!(!valid_review_id(""), "empty string must be rejected");
        assert!(!valid_review_id(".hidden"), "leading-dot (dotfile) must be rejected");
        // Out-of-class chars.
        assert!(!valid_review_id("a b"), "space must be rejected");
        assert!(!valid_review_id("a*b"), "glob char must be rejected");
    }

    /// `response_path_for`: Err on traversal / separator ids; Ok for a valid id with the
    /// path's parent equal to `responses_dir()`. Asserts NO file is created (pure builder).
    #[test]
    fn response_path_for_is_a_guarded_pure_builder() {
        // Rejections (these short-circuit at `valid_review_id`, before any canonicalize).
        assert!(response_path_for("../escape").is_err(), "traversal id must be Err");
        assert!(response_path_for("a/b").is_err(), "slash id must be Err");

        // Valid id. `responses_dir()` must canonicalize, so create it for the duration.
        let dir = responses_dir().expect("home dir resolvable");
        let preexisting = dir.exists();
        std::fs::create_dir_all(&dir).expect("create responses dir for test");

        let id = "valid-review-id-123";
        let path = response_path_for(id).expect("valid id yields Ok");

        // Parent is the responses dir.
        assert_eq!(
            path.parent().expect("has parent"),
            dir.as_path(),
            "built path's parent must be responses_dir()"
        );
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("valid-review-id-123.json"),
            "built path must be <id>.json"
        );
        // The pure builder must NOT create the target file.
        assert!(!path.exists(), "response_path_for must not create the file");

        // request_path_for twin: parent is requests_dir().
        let rdir = requests_dir().expect("home dir resolvable");
        std::fs::create_dir_all(&rdir).expect("create requests dir for test");
        let rpath = request_path_for(id).expect("valid id yields Ok");
        assert_eq!(rpath.parent().expect("has parent"), rdir.as_path());
        assert!(!rpath.exists(), "request_path_for must not create the file");

        // Cleanup: only remove dirs we created (leave a pre-existing real dir alone).
        if !preexisting {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The user's real settings shape — the merge fixture. Kept as a fn so each test gets a
    /// fresh, unmutated copy.
    fn settings_fixture() -> Value {
        serde_json::json!({
            "permissions": { "defaultMode": "auto" },
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [ { "type": "command", "command": "python3 /Users/charliekoster/.claude/hooks/claude_permission_hook.py", "timeout": 5000 } ] }
                ],
                "PostToolUse": [
                    { "matcher": "ExitPlanMode", "hooks": [ { "type": "command", "command": "~/.claude/scripts/plan-tree-save-plan.sh", "timeout": 5000 } ] }
                ]
            },
            "worktree": { "bgIsolation": "none" },
            "statusLine": { "type": "command", "command": "echo hi" },
            "effortLevel": "medium",
            "promptSuggestionEnabled": false,
            "voice": { "enabled": true, "mode": "hold" },
            "theme": "dark-daltonized",
            "skipAutoPermissionPrompt": true,
            "voiceEnabled": true
        })
    }

    const TEST_HOOK_CMD: &str = "/Users/charliekoster/.claude/plan-reader/hook.sh";

    /// Locate the ExitPlanMode element within hooks.PreToolUse, if present.
    fn find_exit_plan_mode(settings: &Value) -> Option<&Value> {
        settings["hooks"]["PreToolUse"]
            .as_array()?
            .iter()
            .find(|el| el.get("matcher").and_then(|m| m.as_str()) == Some("ExitPlanMode"))
    }

    /// merge_install_hook must (a) preserve the Bash security hook, (b) preserve the
    /// PostToolUse/ExitPlanMode entry, (c) leave every unrelated top-level key byte-equal, and
    /// (d) add a new ExitPlanMode PreToolUse entry with our command + timeout 600.
    #[test]
    fn merge_install_preserves_everything_and_adds_our_hook() {
        let input = settings_fixture();
        let merged = merge_install_hook(input.clone(), TEST_HOOK_CMD);

        // (a) The Bash PreToolUse entry is still present and UNCHANGED.
        let bash = merged["hooks"]["PreToolUse"]
            .as_array()
            .expect("PreToolUse array")
            .iter()
            .find(|el| el.get("matcher").and_then(|m| m.as_str()) == Some("Bash"))
            .expect("Bash matcher must survive the merge (security hook)");
        assert_eq!(
            bash, &input["hooks"]["PreToolUse"][0],
            "the Bash security hook must be byte-equal after merge"
        );

        // (b) PostToolUse/ExitPlanMode is unchanged.
        assert_eq!(
            merged["hooks"]["PostToolUse"], input["hooks"]["PostToolUse"],
            "PostToolUse must be untouched by a PreToolUse merge"
        );

        // (c) Every unrelated top-level key is byte-equal to the input.
        for key in [
            "worktree",
            "statusLine",
            "effortLevel",
            "promptSuggestionEnabled",
            "voice",
            "theme",
            "skipAutoPermissionPrompt",
            "voiceEnabled",
            "permissions",
        ] {
            assert_eq!(
                merged[key], input[key],
                "top-level key {key:?} must be preserved byte-equal"
            );
        }

        // (d) A new ExitPlanMode entry under PreToolUse with our command + timeout 600.
        let exit = find_exit_plan_mode(&merged).expect("ExitPlanMode now in PreToolUse");
        let our_entry = exit["hooks"]
            .as_array()
            .expect("ExitPlanMode hooks array")
            .iter()
            .find(|h| h.get("command").and_then(|c| c.as_str()) == Some(TEST_HOOK_CMD))
            .expect("our command must be present");
        assert_eq!(our_entry["type"], Value::from("command"));
        assert_eq!(our_entry["command"], Value::from(TEST_HOOK_CMD));
        assert_eq!(our_entry["timeout"], Value::from(600), "timeout must be 600");
    }

    /// Applying merge_install_hook twice equals applying it once — no duplicate entry.
    #[test]
    fn merge_install_is_idempotent() {
        let once = merge_install_hook(settings_fixture(), TEST_HOOK_CMD);
        let twice = merge_install_hook(once.clone(), TEST_HOOK_CMD);
        assert_eq!(once, twice, "install must be idempotent");

        // And there is exactly ONE ExitPlanMode entry with our command.
        let exit = find_exit_plan_mode(&twice).expect("ExitPlanMode present");
        let count = exit["hooks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|h| h.get("command").and_then(|c| c.as_str()) == Some(TEST_HOOK_CMD))
            .count();
        assert_eq!(count, 1, "no duplicate plan-reader hook entry");
    }

    /// When PreToolUse ALREADY has an ExitPlanMode matcher (with a different command), install
    /// APPENDS our entry to that matcher's hooks and preserves the existing command.
    #[test]
    fn merge_install_appends_to_existing_exit_plan_mode_matcher() {
        let mut fixture = settings_fixture();
        // Add an ExitPlanMode matcher to PreToolUse with some OTHER command.
        let other = serde_json::json!({
            "matcher": "ExitPlanMode",
            "hooks": [ { "type": "command", "command": "/some/other/exit-hook.sh", "timeout": 30 } ]
        });
        fixture["hooks"]["PreToolUse"]
            .as_array_mut()
            .unwrap()
            .push(other);

        let merged = merge_install_hook(fixture, TEST_HOOK_CMD);
        let exit = find_exit_plan_mode(&merged).expect("ExitPlanMode present");
        let cmds: Vec<&str> = exit["hooks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
            .collect();
        assert!(
            cmds.contains(&"/some/other/exit-hook.sh"),
            "the pre-existing ExitPlanMode command must be preserved"
        );
        assert!(
            cmds.contains(&TEST_HOOK_CMD),
            "our command must be appended to the existing matcher"
        );
        // There must be exactly ONE ExitPlanMode matcher element (appended, not duplicated).
        let exit_count = merged["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|el| el.get("matcher").and_then(|m| m.as_str()) == Some("ExitPlanMode"))
            .count();
        assert_eq!(exit_count, 1, "must append into the existing matcher, not add a second");
    }

    /// uninstall after install restores the hooks for our concern: our entry gone, Bash +
    /// PostToolUse intact. Since install ADDED a brand-new ExitPlanMode element whose only
    /// entry was ours, uninstall removes that element entirely — yielding the original hooks.
    #[test]
    fn uninstall_after_install_restores_original_hooks() {
        let original = settings_fixture();
        let installed = merge_install_hook(original.clone(), TEST_HOOK_CMD);
        let uninstalled = merge_uninstall_hook(installed);

        // Our entry is gone (no ExitPlanMode element under PreToolUse anymore).
        assert!(
            find_exit_plan_mode(&uninstalled).is_none(),
            "the installed ExitPlanMode PreToolUse element must be removed on uninstall"
        );

        // Bash + the whole hooks block match the original for our concern.
        assert_eq!(
            uninstalled["hooks"]["PreToolUse"], original["hooks"]["PreToolUse"],
            "PreToolUse must return to its original state (Bash intact, our element gone)"
        );
        assert_eq!(
            uninstalled["hooks"]["PostToolUse"], original["hooks"]["PostToolUse"],
            "PostToolUse must be untouched"
        );
        // Whole document equals the original.
        assert_eq!(uninstalled, original, "uninstall must fully restore the original settings");
    }

    /// Uninstall is idempotent — applying it a second time is a no-op.
    #[test]
    fn merge_uninstall_is_idempotent() {
        let installed = merge_install_hook(settings_fixture(), TEST_HOOK_CMD);
        let once = merge_uninstall_hook(installed);
        let twice = merge_uninstall_hook(once.clone());
        assert_eq!(once, twice, "uninstall must be idempotent (removing twice = no-op)");
    }

    /// `hook_is_installed` must be FALSE for the user's real settings (which has a Bash PreToolUse
    /// hook + a PostToolUse/ExitPlanMode hook, but NO plan-reader entry), and TRUE after
    /// `merge_install_hook` adds our entry. Falsifiability proven by inverting the assertion (see
    /// the commit report): the fixture passes only because no command ends with the suffix, and the
    /// merged value passes only because our command does — flipping either `assert!`/`assert!(!…)`
    /// turns the test red.
    #[test]
    fn hook_is_installed_detects_only_our_entry() {
        let fixture = settings_fixture();
        assert!(
            !hook_is_installed(&fixture),
            "the real-settings fixture (Bash PreToolUse + PostToolUse/ExitPlanMode, NO plan-reader \
             hook) must NOT be detected as installed"
        );

        let installed = merge_install_hook(fixture, TEST_HOOK_CMD);
        assert!(
            hook_is_installed(&installed),
            "after merge_install_hook adds our plan-reader/hook.sh command, it MUST be detected"
        );
    }

    /// `hook_is_installed` must not panic and must return `false` on odd / non-object shapes, and
    /// must reject an ExitPlanMode matcher whose only command does NOT end with our suffix.
    #[test]
    fn hook_is_installed_false_on_odd_shapes() {
        assert!(!hook_is_installed(&Value::Null));
        assert!(!hook_is_installed(&serde_json::json!([1, 2, 3])));
        assert!(!hook_is_installed(&serde_json::json!({ "hooks": "not-an-object" })));
        assert!(!hook_is_installed(&serde_json::json!({ "hooks": { "PreToolUse": {} } })));
        // ExitPlanMode matcher present, but the command is someone ELSE's hook → not ours.
        let foreign = serde_json::json!({
            "hooks": { "PreToolUse": [
                { "matcher": "ExitPlanMode", "hooks": [
                    { "type": "command", "command": "/some/other/exit-hook.sh", "timeout": 30 }
                ] }
            ] }
        });
        assert!(
            !hook_is_installed(&foreign),
            "an ExitPlanMode matcher whose command is not ours must NOT count as installed"
        );
        // Our suffix under a NON-ExitPlanMode matcher must also not count.
        let wrong_matcher = serde_json::json!({
            "hooks": { "PreToolUse": [
                { "matcher": "Bash", "hooks": [
                    { "type": "command", "command": "/x/plan-reader/hook.sh" }
                ] }
            ] }
        });
        assert!(
            !hook_is_installed(&wrong_matcher),
            "our suffix under a non-ExitPlanMode matcher must NOT count as installed"
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
