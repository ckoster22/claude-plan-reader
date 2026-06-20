//! `.plan-tree/` persistence for a user-chosen working directory.
//!
//! The frontend WebView cannot write files, so the multiplan orchestration state that lives in
//! `<cwd>/.plan-tree/` (master plan, per-sub-plan plans + summaries, and a `state.json`) is
//! materialized through these Tauri commands. Unlike the `~/.claude/` trees the rest of the
//! app touches, this directory lives OUTSIDE `~/.claude/` — wherever the user pointed the plan at.
//! (`reset_plan_tree_dir` — the START-reconciliation sweep into `.archive/` — documents its own
//! guard set on the function.)
//!
//! The read/write commands are doubly defended:
//!   1. `valid_plan_tree_name` — a strict allow-list (membership + a hand-parsed `NN-(plan|summary).md`
//!      shape). The literal control files are `state.json`, `recon.md`, `master.md`, and `INTENT.md`.
//!      No regex
//!      dependency; `/`, `\`, `..`, leading-`.`, URL escapes, and absolute paths all fail the
//!      charset/shape check.
//!   2. A canonicalized-parent containment guard mirroring `lib.rs`'s `guarded_plan_path`: build
//!      `<cwd>/.plan-tree/<name>`, ensure `.plan-tree` exists, canonicalize that parent dir, and
//!      assert the target's canonical parent IS it — so even a name that slipped the allow-list could
//!      not escape `.plan-tree`.
//!
//! Writes reuse `crate::atomic_write` (temp `.tmp-…` + rename). Reads degrade gracefully: an absent
//! file is `Ok(None)`, never an error.

use std::path::{Path, PathBuf};

/// The exact literal control-file names usable inside `.plan-tree/` (no `NN-` prefix). These are the
/// files the multiplan orchestrator's reducer emits via `writePlanTreeFile` with a fixed name, plus
/// the persisted ledger. Keep this in lock-step with the reducer's fixed-name `writePlanTreeFile`
/// effects (`plan-tree.ts`: INTENT_CLARIFIED → `INTENT.md`, RECON_DONE → `recon.md`,
/// MASTER_DRAFTED → `master.md`) and the driver's `persist` effect (`orchestrator.ts` → `state.json`).
/// The frontend `plan-tree-filenames` test pins this contract from the other side.
const LITERAL_PLAN_TREE_NAMES: &[&str] = &["state.json", "INTENT.md", "recon.md", "master.md"];

/// True iff `name` is one of the exact allow-listed file names usable inside `.plan-tree/`.
///
/// Accepts ONLY:
///   * one of `LITERAL_PLAN_TREE_NAMES` (`state.json`, `INTENT.md`, `recon.md`, `master.md`)
///   * the shape `NN-plan.md` or `NN-summary.md`, where `NN` is exactly two ASCII digits.
///
/// Everything else is rejected: any `/`, `\`, `..`, leading `.` (none of the literal allow-listed
/// names starts with `.`), URL-encoded escapes (`%` is not in the accepted shape), absolute paths,
/// single-digit prefixes, wrong stems, or trailing junk. Pure; touches no filesystem.
fn valid_plan_tree_name(name: &str) -> bool {
    if LITERAL_PLAN_TREE_NAMES.contains(&name) {
        return true;
    }
    valid_nn_md(name)
}

/// Hand-parse the `SEG("."SEG)*-(plan|summary).md` shape with zero regex dependency, where SEG is
/// EXACTLY two ASCII digits (Phase 2: dotted hierarchical ids; flat legacy is the 1-segment case).
///
/// Layout: `<id>-<stem>.md`, where `<id>` is dot-joined two-digit segments (`01`, `02.01`,
/// `02.01.01`, …) and `<stem>` is exactly `plan` or `summary`. We strip the trailing `.md`, split
/// at the FIRST `-` (segments contain only digits and dots, never `-`), require the stem to equal
/// one of the two literals exactly, and require every dot-separated segment to be exactly two
/// ASCII digits. Because we match the whole string with no wildcards, `foo/bar.md`, `1-plan.md`,
/// `001-plan.md`, `02.-plan.md`, `02..01-plan.md`, `.02-plan.md`, `00-plans.md`, `..`, etc. all
/// fail (an empty segment from a leading/trailing/doubled dot has length 0 ≠ 2).
fn valid_nn_md(name: &str) -> bool {
    let Some(id_and_stem) = name.strip_suffix(".md") else {
        return false;
    };
    let Some((id, stem)) = id_and_stem.split_once('-') else {
        return false;
    };
    if stem != "plan" && stem != "summary" {
        return false;
    }
    // `"".split('.')` yields one empty segment, so an empty id is rejected by the length check.
    id.split('.').all(|seg| {
        let bytes = seg.as_bytes();
        bytes.len() == 2 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit()
    })
}

/// Build the containment-guarded absolute path `<cwd>/.plan-tree/<name>`, creating `.plan-tree` if
/// needed. Validates `name` against the allow-list, requires `cwd` to be an existing directory, then
/// canonicalizes the `.plan-tree` PARENT (which now exists) and asserts the target's canonical parent
/// equals it. Mirrors `lib.rs`'s `guarded_plan_path`. Creates the directory but NOT the target file.
fn guarded_plan_tree_path(cwd: &str, name: &str) -> Result<PathBuf, String> {
    if !valid_plan_tree_name(name) {
        return Err(format!("invalid plan-tree file name: {name:?}"));
    }
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not an existing directory: {cwd:?}"));
    }
    let dir = cwd_path.join(".plan-tree");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create .plan-tree dir: {e}"))?;

    // Containment: the canonical `.plan-tree` must sit DIRECTLY inside the canonical cwd, so a
    // `.plan-tree` that is a SYMLINK out of the cwd is rejected (its canonical parent is NOT the
    // canonical cwd). Comparing `joined.parent()` to `dir` would be tautological here — an
    // allow-listed `name` has no `/`, so `joined.parent()` is always exactly `dir` and the check
    // could never fire. Mirror `reset_plan_tree_dir`'s parent-equals-cwd assert instead.
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!(".plan-tree dir unavailable: {e}"))?;
    if canon_dir.parent() != Some(canon_cwd.as_path()) {
        return Err("path escapes the .plan-tree directory".to_string());
    }
    Ok(dir.join(name))
}

/// Atomically write `contents` to `<cwd>/.plan-tree/<name>`, returning the absolute path written.
///
/// `name` MUST be allow-listed (`state.json`, `recon.md`, `master.md`, `INTENT.md`, or
/// `NN-(plan|summary).md`); anything else
/// returns `Err` and writes NOTHING. `cwd` must be an existing directory. The `.plan-tree` dir is
/// created if absent; the write is atomic (temp + rename) via `crate::atomic_write`.
///
/// AUTO-CAPTURE: after a successful `state.json` write, best-effort parse the JSON for a
/// top-level `tree_id` and upsert `tree-cwd-index.json` with `tree_id → cwd` (the command's `cwd`
/// arg). This keeps the index fresh for every tree the app touches going forward, with no frontend
/// wiring. A `state.json` without a parseable `tree_id` leaves the index untouched, and a capture
/// failure NEVER fails the write (the file is already on disk by then). The `State` is injected by
/// Tauri — the frontend `invoke("write_plan_tree_file", …)` call is unchanged.
#[tauri::command]
pub fn write_plan_tree_file(
    cwd: String,
    name: String,
    contents: String,
    state: tauri::State<'_, std::sync::Mutex<crate::AppState>>,
) -> Result<String, String> {
    let written = write_plan_tree_file_inner(&cwd, &name, &contents)?;
    // Auto-capture the tree_id → cwd mapping on the state ledger write (best-effort, post-write).
    if name == "state.json" {
        crate::capture_tree_cwd(&state, &cwd, &contents);
    }
    Ok(written)
}

/// Tauri-free core of `write_plan_tree_file`: validate + atomically write `<cwd>/.plan-tree/<name>`
/// and return the absolute path. Kept separate from the `#[tauri::command]` wrapper so the write
/// (and the allow-list/containment guards) stay unit-testable without a `State` extractor, and so
/// `capture_tree_cwd` can be exercised independently.
pub(crate) fn write_plan_tree_file_inner(
    cwd: &str,
    name: &str,
    contents: &str,
) -> Result<String, String> {
    let path = guarded_plan_tree_path(cwd, name)?;
    crate::atomic_write(&path, contents.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Read `<cwd>/.plan-tree/<name>` as lossy UTF-8. Absent file ⇒ `Ok(None)` (graceful degradation, not
/// an error). Present ⇒ `Ok(Some(contents))`. `name` MUST be allow-listed and `cwd` an existing dir;
/// otherwise `Err`. Mirrors the write path's validation + containment guard.
#[tauri::command]
pub fn read_plan_tree_file(cwd: String, name: String) -> Result<Option<String>, String> {
    let path = guarded_plan_tree_path(&cwd, &name)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read failed: {e}")),
    }
}

/// Delete `<cwd>/.plan-tree/<name>` (PHASE 6 — the refine branch's per-reset-node cleanup). `name`
/// MUST be allow-listed and `cwd` an existing dir (the SAME `guarded_plan_tree_path` containment +
/// allow-list guard the read/write paths use — so a name that is not a literal control file or
/// `NN-(plan|summary).md` is rejected before any unlink, and the target can never escape `.plan-tree`).
/// GRACEFUL: an absent file is `Ok(())` (a leaf node never wrote `NN-plan.md`, so deleting it is a
/// no-op), never an error — mirroring the read path's absent-⇒-`Ok(None)` degradation.
#[tauri::command]
pub fn delete_plan_tree_file(cwd: String, name: String) -> Result<(), String> {
    delete_plan_tree_file_inner(&cwd, &name)
}

/// Tauri-free core of `delete_plan_tree_file`: validate (allow-list + containment) then unlink,
/// treating an absent file as success. Kept separate so the guard + the absent-file degradation stay
/// unit-testable without a Tauri runtime.
pub(crate) fn delete_plan_tree_file_inner(cwd: &str, name: &str) -> Result<(), String> {
    let path = guarded_plan_tree_path(cwd, name)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete failed: {e}")),
    }
}

/// Reset `<cwd>/.plan-tree/` for a fresh orchestration run (START reconciliation): move EVERY
/// current entry into `<cwd>/.plan-tree/.archive/`, REPLACING any previous `.archive/` first — so
/// exactly ONE prior generation is kept, never nested, never growing without bound. Stale files
/// from earlier runs (recon.md, master.md, NN-summary.md, hook litter) would otherwise survive and
/// poison disk-derived phase detection.
///
/// Guards mirror the write path's conventions:
///   * `cwd` must be absolute, contain no `..` components (a traversing cwd could re-root the
///     sweep somewhere unintended), and be an existing directory.
///   * `.plan-tree` is created if absent (the reset is then a no-op archive).
///   * Symlink defense: after creation, the canonicalized `.plan-tree`'s parent must BE the
///     canonicalized `cwd`, mirroring `guarded_plan_tree_path`'s containment assert.
///
/// Entries move via `std::fs::rename` (same-volume atomic moves — `.archive` lives inside the dir
/// being swept), so a file is always either in the root or in the archive, never half-copied.
///
/// MARKER-LAST: `state.json` is the app-ownership marker the ExitPlanMode hook fences on, so the
/// sweep moves it LAST (see `sweep_order`). If any earlier rename fails mid-sweep, `state.json` is
/// still at the root — the marker is never dropped while the dir is left dirty.
#[tauri::command]
pub fn reset_plan_tree_dir(cwd: String) -> Result<(), String> {
    let cwd_path = Path::new(&cwd);
    if !cwd_path.is_absolute() {
        return Err(format!("cwd must be an absolute path: {cwd:?}"));
    }
    if cwd_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("cwd must not contain `..` components: {cwd:?}"));
    }
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not an existing directory: {cwd:?}"));
    }
    let dir = cwd_path.join(".plan-tree");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create .plan-tree dir: {e}"))?;

    // Containment: the canonical `.plan-tree` must sit DIRECTLY inside the canonical cwd.
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!(".plan-tree dir unavailable: {e}"))?;
    if canon_dir.parent() != Some(canon_cwd.as_path()) {
        return Err("path escapes the working directory".to_string());
    }

    // REPLACE the previous generation's archive (absent is fine), then start a fresh one. A stray
    // regular file (or symlink) squatting on the `.archive` name is replaced too — erroring on it
    // would wedge every subsequent START against the same immovable obstacle.
    let archive = canon_dir.join(".archive");
    match std::fs::symlink_metadata(&archive) {
        Ok(meta) if meta.is_dir() => {
            std::fs::remove_dir_all(&archive)
                .map_err(|e| format!("could not clear previous archive: {e}"))?;
        }
        Ok(_) => {
            std::fs::remove_file(&archive)
                .map_err(|e| format!("could not replace stray .archive file: {e}"))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("could not inspect previous archive: {e}")),
    }
    std::fs::create_dir(&archive).map_err(|e| format!("could not create archive dir: {e}"))?;

    // Sweep every remaining entry (the fresh `.archive` itself excepted) into the archive, with
    // `state.json` ordered LAST (marker-last — see the doc comment above).
    let entries =
        std::fs::read_dir(&canon_dir).map_err(|e| format!("could not list .plan-tree: {e}"))?;
    let mut names: Vec<std::ffi::OsString> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not list .plan-tree entry: {e}"))?;
        let name = entry.file_name();
        if name == ".archive" {
            continue;
        }
        names.push(name);
    }
    for name in sweep_order(names) {
        std::fs::rename(canon_dir.join(&name), archive.join(&name)).map_err(|e| {
            format!("could not archive {:?}: {e}", name.to_string_lossy())
        })?;
    }
    Ok(())
}

// ---- visual-prototype support (Phase 4d) -------------------------------------------------------
//
// The intent-clarifier's visual-prototype mode writes throwaway artifacts under
// `<cwd>/.plan-tree/prototype/` (the sidecar's "prototype" write policy confines the agent to
// exactly that subtree, but it cannot CREATE the dir — `ensure_prototype_dir` does, before the
// visual-mode prompt is sent). `open_prototype` opens one of those artifacts (an HTML prototype)
// in the default browser via tauri-plugin-opener. Both commands mirror `reset_plan_tree_dir`'s
// cwd guard set; the open path adds a strict file-containment guard. The validation cores are
// plain functions (no AppHandle) so the containment rules are unit-testable without ever
// launching a browser — the `#[tauri::command]`s stay thin shells.

/// Shared cwd guard for the prototype commands, mirroring `reset_plan_tree_dir`'s set:
/// `cwd` must be absolute, contain no `..` components, and be an existing directory.
fn validated_cwd(cwd: &str) -> Result<&Path, String> {
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_absolute() {
        return Err(format!("cwd must be an absolute path: {cwd:?}"));
    }
    if cwd_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("cwd must not contain `..` components: {cwd:?}"));
    }
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not an existing directory: {cwd:?}"));
    }
    Ok(cwd_path)
}

/// Validation + creation core of `ensure_prototype_dir` (testable; no Tauri types). Creates
/// `<cwd>/.plan-tree/prototype/` (idempotent), then asserts containment: the CANONICAL created
/// dir must equal `<canonical cwd>/.plan-tree/prototype` exactly — a symlinked `.plan-tree` (or
/// `prototype`) pointing elsewhere canonicalizes to a different path and is rejected. Returns the
/// canonical (absolute) dir path.
fn ensure_prototype_dir_impl(cwd: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let dir = cwd_path.join(".plan-tree").join("prototype");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create prototype dir: {e}"))?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("prototype dir unavailable: {e}"))?;
    if canon_dir != canon_cwd.join(".plan-tree").join("prototype") {
        return Err("path escapes the working directory".to_string());
    }
    Ok(canon_dir)
}

/// Create `<cwd>/.plan-tree/prototype/` (idempotent) and return its absolute path. Called by the
/// orchestrator driver BEFORE the visual-mode intent prompt is sent, so the clarifier never needs
/// Bash/mkdir (the sidecar's "prototype" policy only allows writes UNDER the dir — it cannot
/// create it). Guards documented on `ensure_prototype_dir_impl`.
#[tauri::command]
pub fn ensure_prototype_dir(cwd: String) -> Result<String, String> {
    ensure_prototype_dir_impl(&cwd).map(|p| p.to_string_lossy().to_string())
}

/// Validation core of `open_prototype` (testable; no Tauri types, never launches anything).
/// `path` may be absolute or relative-to-`cwd` (the gate's `paths` are usually relative, e.g.
/// `.plan-tree/prototype/index.html`). Requirements, all enforced on CANONICAL paths so symlinks
/// cannot smuggle a target out:
///   * `cwd` passes `validated_cwd` (absolute, no `..`, existing dir);
///   * `<cwd>/.plan-tree/prototype/` exists and canonicalizes INSIDE the canonical cwd
///     (same equality assert as `ensure_prototype_dir_impl`);
///   * the resolved `path` exists, canonicalizes STRICTLY UNDER that prototype dir, and is a
///     regular file (directories and anything else are rejected).
fn validated_prototype_file(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let proto = cwd_path.join(".plan-tree").join("prototype");
    let canon_proto =
        std::fs::canonicalize(&proto).map_err(|e| format!("prototype dir unavailable: {e}"))?;
    if canon_proto != canon_cwd.join(".plan-tree").join("prototype") {
        return Err("path escapes the working directory".to_string());
    }
    let requested = Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canon_cwd.join(requested)
    };
    let canon =
        std::fs::canonicalize(&joined).map_err(|e| format!("prototype file unavailable: {e}"))?;
    if !canon.starts_with(&canon_proto) || canon == canon_proto {
        return Err("path escapes the prototype directory".to_string());
    }
    let meta =
        std::fs::metadata(&canon).map_err(|e| format!("prototype file unavailable: {e}"))?;
    if !meta.is_file() {
        return Err(format!("prototype path is not a regular file: {path:?}"));
    }
    Ok(canon)
}

/// Open a prototype artifact (validated by `validated_prototype_file` — strictly under
/// `<cwd>/.plan-tree/prototype/`) in the OS default handler (the browser, for `index.html`) via
/// tauri-plugin-opener's Rust API. Rust-side opener calls need no extra JS capability; the
/// `opener:default` capability covers the plugin's own setup.
#[tauri::command]
pub fn open_prototype(
    app: tauri::AppHandle,
    cwd: String,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = validated_prototype_file(&cwd, &path)?;
    app.opener()
        .open_path(file.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("could not open prototype: {e}"))
}

// ---- baseline (frozen "working reference") support (Phase 3) -----------------------------------
//
// When the user marks a visual prototype a "working reference" at the prototype-approval gate, the
// throwaway `<cwd>/.plan-tree/prototype/` tree is FROZEN into a contained `<cwd>/.plan-tree/baseline/`
// so it survives the prototype dir being reset/overwritten by later runs. The baseline is a FLOOR on
// the outcome dimensions captured in INTENT.md — never a behavioral match-target — but on disk it is
// just a snapshot copy of the prototype subtree. Both ensure + freeze + open mirror the directory-
// canonicalization containment of the prototype commands above (NOT the file-name allow-list of
// `guarded_plan_tree_path`, which rejects any `/`-containing sub-path): the canonical created/target
// dir must equal `<canonical cwd>/.plan-tree/baseline` exactly, so a symlinked `.plan-tree` (or
// `baseline`) pointing elsewhere is rejected. The validation cores are plain functions (no AppHandle)
// so the containment rules are unit-testable without launching anything.

/// Validation + creation core of `ensure_baseline_dir` (testable; no Tauri types). Creates
/// `<cwd>/.plan-tree/baseline/` (idempotent), then asserts containment: the CANONICAL created dir
/// must equal `<canonical cwd>/.plan-tree/baseline` exactly. Mirrors `ensure_prototype_dir_impl`.
/// Returns the canonical (absolute) dir path.
fn ensure_baseline_dir_impl(cwd: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let dir = cwd_path.join(".plan-tree").join("baseline");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create baseline dir: {e}"))?;
    let canon_cwd = std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("baseline dir unavailable: {e}"))?;
    if canon_dir != canon_cwd.join(".plan-tree").join("baseline") {
        return Err("path escapes the working directory".to_string());
    }
    Ok(canon_dir)
}

/// Create `<cwd>/.plan-tree/baseline/` (idempotent) and return its absolute path. Guards documented
/// on `ensure_baseline_dir_impl`.
#[tauri::command]
pub fn ensure_baseline_dir(cwd: String) -> Result<String, String> {
    ensure_baseline_dir_impl(&cwd).map(|p| p.to_string_lossy().to_string())
}

/// Recursively copy `src` into `dst` (both already canonical + contained), asserting NEITHER side
/// escapes its containment root as the walk descends. `src_root`/`dst_root` are the canonical
/// `prototype`/`baseline` dirs; every directory entry's canonical path must stay STRICTLY UNDER its
/// root (a symlink inside `prototype/` pointing out, or a symlink `dst` entry redirecting the write
/// out, is rejected). Symlinks are NOT followed for copying — they would let a planted link redirect
/// a read/write outside containment, so any symlink encountered is rejected. Files are copied with
/// `std::fs::copy`; subdirectories recurse.
fn copy_tree_contained(
    src: &Path,
    dst: &Path,
    src_root: &Path,
    dst_root: &Path,
) -> Result<(), String> {
    let entries = std::fs::read_dir(src).map_err(|e| format!("could not list baseline source: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read baseline source entry: {e}"))?;
        let name = entry.file_name();
        let src_child = src.join(&name);
        let dst_child = dst.join(&name);

        // Symlink defense: never follow a link (it could redirect outside containment). Reject any.
        let meta = std::fs::symlink_metadata(&src_child)
            .map_err(|e| format!("could not stat baseline source entry: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "baseline freeze refuses to copy a symlink: {:?}",
                name.to_string_lossy()
            ));
        }

        if meta.is_dir() {
            std::fs::create_dir_all(&dst_child)
                .map_err(|e| format!("could not create baseline subdir: {e}"))?;
            // Containment re-assert on BOTH sides after creation (canonical paths now exist).
            let canon_src = std::fs::canonicalize(&src_child)
                .map_err(|e| format!("baseline source subdir unavailable: {e}"))?;
            let canon_dst = std::fs::canonicalize(&dst_child)
                .map_err(|e| format!("baseline dest subdir unavailable: {e}"))?;
            if !canon_src.starts_with(src_root) || !canon_dst.starts_with(dst_root) {
                return Err("baseline freeze path escapes containment".to_string());
            }
            copy_tree_contained(&canon_src, &canon_dst, src_root, dst_root)?;
        } else if meta.is_file() {
            let canon_src = std::fs::canonicalize(&src_child)
                .map_err(|e| format!("baseline source file unavailable: {e}"))?;
            if !canon_src.starts_with(src_root) {
                return Err("baseline freeze source escapes containment".to_string());
            }
            // The destination parent (`dst`) is already canonical + contained by construction; the
            // child join cannot escape it (a plain file name, source-side symlinks rejected above).
            if !dst.starts_with(dst_root) {
                return Err("baseline freeze destination escapes containment".to_string());
            }
            // Destination symlink defense (mirror of the source-side rejection above): `std::fs::copy`
            // FOLLOWS a symlink at the destination, so a link pre-planted at `dst_child` pointing
            // outside `.plan-tree/` would let the copy overwrite an out-of-containment target. Reject
            // any pre-existing destination entry that is a symlink before copying.
            if let Ok(dst_meta) = std::fs::symlink_metadata(&dst_child) {
                if dst_meta.file_type().is_symlink() {
                    return Err(format!(
                        "baseline freeze refuses to overwrite a symlink destination: {:?}",
                        name.to_string_lossy()
                    ));
                }
            }
            std::fs::copy(&canon_src, &dst_child)
                .map_err(|e| format!("could not copy baseline file: {e}"))?;
        }
        // Anything else (sockets, fifos, …) is silently skipped — a prototype never produces them.
    }
    Ok(())
}

/// Freeze `<cwd>/.plan-tree/prototype/` into `<cwd>/.plan-tree/baseline/`: ensure the baseline dir
/// (containment-guarded), then recursively copy every prototype file/subdir into it with containment
/// guards on BOTH source and destination (`copy_tree_contained`). The prototype dir MUST exist and
/// canonicalize inside the cwd (same equality assert as `ensure_prototype_dir_impl`); a missing
/// prototype dir is an error (there is nothing to freeze). Idempotent in the sense that re-freezing
/// overwrites same-named files; pre-existing baseline files not present in the prototype are left
/// untouched. Returns the canonical baseline dir path.
#[tauri::command]
pub fn freeze_baseline(cwd: String) -> Result<String, String> {
    let cwd_path = validated_cwd(&cwd)?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;

    // Source: the prototype dir must exist and be contained (mirrors validated_prototype_file's
    // dir assert).
    let proto = cwd_path.join(".plan-tree").join("prototype");
    let canon_proto =
        std::fs::canonicalize(&proto).map_err(|e| format!("prototype dir unavailable: {e}"))?;
    if canon_proto != canon_cwd.join(".plan-tree").join("prototype") {
        return Err("prototype path escapes the working directory".to_string());
    }

    // Destination: create + contain the baseline dir.
    let canon_baseline = ensure_baseline_dir_impl(&cwd)?;

    copy_tree_contained(&canon_proto, &canon_baseline, &canon_proto, &canon_baseline)?;
    Ok(canon_baseline.to_string_lossy().to_string())
}

/// Validation core of `open_baseline` (testable; no Tauri types, never launches anything). Scoped to
/// `<cwd>/.plan-tree/baseline/` exactly as `validated_prototype_file` is scoped to `prototype/` —
/// `open_prototype` is hard-scoped to `prototype/` and would 403 on a baseline path, so the gate
/// needs this baseline-scoped opener. Same canonical-path containment: the resolved `path` must
/// exist, canonicalize STRICTLY UNDER the baseline dir, and be a regular file.
fn validated_baseline_file(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let base = cwd_path.join(".plan-tree").join("baseline");
    let canon_base =
        std::fs::canonicalize(&base).map_err(|e| format!("baseline dir unavailable: {e}"))?;
    if canon_base != canon_cwd.join(".plan-tree").join("baseline") {
        return Err("path escapes the working directory".to_string());
    }
    let requested = Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canon_cwd.join(requested)
    };
    let canon =
        std::fs::canonicalize(&joined).map_err(|e| format!("baseline file unavailable: {e}"))?;
    if !canon.starts_with(&canon_base) || canon == canon_base {
        return Err("path escapes the baseline directory".to_string());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("baseline file unavailable: {e}"))?;
    if !meta.is_file() {
        return Err(format!("baseline path is not a regular file: {path:?}"));
    }
    Ok(canon)
}

/// Open a baseline artifact (validated by `validated_baseline_file` — strictly under
/// `<cwd>/.plan-tree/baseline/`) in the OS default handler via tauri-plugin-opener's Rust API.
/// Mirrors `open_prototype` but scoped to `baseline/` (Phase 5's gate opens the frozen baseline).
#[tauri::command]
pub fn open_baseline(app: tauri::AppHandle, cwd: String, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = validated_baseline_file(&cwd, &path)?;
    app.opener()
        .open_path(file.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("could not open baseline: {e}"))
}

/// Order the entries the START-reconciliation sweep will move: every entry EXCEPT `state.json`
/// first (relative order preserved), `state.json` strictly last. `state.json` is the
/// app-ownership marker the ExitPlanMode review hook uses as its fence — if a rename fails
/// mid-sweep, the marker must still be at the `.plan-tree` root, so it can only ever be the FINAL
/// move. Pure data-in/data-out so the ordering itself is unit-testable.
fn sweep_order(names: Vec<std::ffi::OsString>) -> Vec<std::ffi::OsString> {
    let (marker, mut rest): (Vec<_>, Vec<_>) =
        names.into_iter().partition(|n| n == "state.json");
    rest.extend(marker);
    rest
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Create a unique temp dir under `std::env::temp_dir()` (no `tempfile` crate dependency). Uses
    /// pid + a nanosecond clock read + a monotonic process-local counter so concurrent tests never
    /// collide on the same path.
    fn unique_temp_dir() -> PathBuf {
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("plan-tree-test-{pid}-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// List the file names directly inside `<cwd>/.plan-tree`, or empty if the dir is absent.
    fn list_plan_tree(cwd: &Path) -> Vec<String> {
        let dir = cwd.join(".plan-tree");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect()
    }

    /// Round-trip `state.json`: write JSON content, read it back, assert byte-for-byte equality.
    /// Falsifiable: if the read returned the wrong/empty content, the equality assert goes red.
    #[test]
    fn roundtrip_state_json() {
        let cwd = unique_temp_dir();
        let payload = r#"{"phase":"executing","cursor":3}"#;
        let written = write_plan_tree_file_inner(
            &cwd.to_string_lossy(),
            "state.json",
            payload,
        )
        .expect("write should succeed");
        assert!(written.ends_with("/.plan-tree/state.json"), "got {written}");

        let read = read_plan_tree_file(
            cwd.to_string_lossy().to_string(),
            "state.json".to_string(),
        )
        .expect("read should succeed");
        assert_eq!(read, Some(payload.to_string()));

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// Round-trip the `NN-plan.md` and `NN-summary.md` shapes (both allow-listed via the hand parser).
    /// Falsifiable: a broken shape check would reject these and the `expect` would panic.
    #[test]
    fn roundtrip_nn_plan_and_summary() {
        let cwd = unique_temp_dir();
        for (name, body) in [("01-plan.md", "# plan one"), ("02-summary.md", "## done")] {
            write_plan_tree_file_inner(&cwd.to_string_lossy(), name, body)
                .unwrap_or_else(|e| panic!("write {name} should succeed: {e}"));

            let read = read_plan_tree_file(
                cwd.to_string_lossy().to_string(),
                name.to_string(),
            )
            .expect("read should succeed");
            assert_eq!(read, Some(body.to_string()), "round-trip mismatch for {name}");
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// Every malformed/hostile name must (a) return `Err` and (b) write NOTHING. We pre-seed one
    /// legitimate file so the `.plan-tree` dir exists, then assert the only file present afterward is
    /// the legitimate seed — proving no rejected name ever produced a file (escaped or in-dir).
    /// Falsifiable: if any rejected name wrote a file or returned `Ok`, an assert goes red.
    #[test]
    fn rejects_hostile_names_and_writes_nothing() {
        let cwd = unique_temp_dir();
        // Seed a known-good file so the dir exists and we can detect any stray write.
        write_plan_tree_file_inner(&cwd.to_string_lossy(), "master.md", "seed")
            .expect("seed write should succeed");

        let hostile = [
            "../../etc/evil",
            "/abs/path",
            "foo/bar.md",
            "..",
            ".hidden",
            "state.jsonx",
            "1-plan.md",   // one digit
            "00-plans.md", // wrong stem (plurals)
            "evil.md",
        ];
        for name in hostile {
            let res = write_plan_tree_file_inner(&cwd.to_string_lossy(), name, "PWNED");
            assert!(res.is_err(), "name {name:?} must be rejected, got {res:?}");

            // Read must reject identically (no Ok(None) leakage past validation).
            let read = read_plan_tree_file(cwd.to_string_lossy().to_string(), name.to_string());
            assert!(read.is_err(), "read of {name:?} must be rejected, got {read:?}");
        }

        let files = list_plan_tree(&cwd);
        assert_eq!(
            files,
            vec!["master.md".to_string()],
            "only the seed file may exist; found {files:?}"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// An absent allow-listed name reads as `Ok(None)`, not `Err`. Falsifiable: if the read errored
    /// on a missing file, the `assert_eq` against `Ok(None)` would fail.
    #[test]
    fn read_absent_allowlisted_is_none() {
        let cwd = unique_temp_dir();
        let read = read_plan_tree_file(
            cwd.to_string_lossy().to_string(),
            "02-summary.md".to_string(),
        )
        .expect("read of absent allow-listed name should be Ok, not Err");
        assert_eq!(read, None);
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// PHASE 6 — delete an allow-listed file: it is removed from `.plan-tree` and reads back as
    /// absent. Falsifiable: if the unlink were skipped, the post-delete read would still return the
    /// body and the `assert_eq!(read, None)` would fire.
    #[test]
    fn delete_removes_allowlisted_file() {
        let cwd = unique_temp_dir();
        write_plan_tree_file_inner(&cwd.to_string_lossy(), "01-summary.md", "stale summary")
            .expect("seed write should succeed");
        // Also seed a neighbor that must SURVIVE the delete (the delete targets exactly one name).
        write_plan_tree_file_inner(&cwd.to_string_lossy(), "02-summary.md", "keep me")
            .expect("seed write should succeed");

        delete_plan_tree_file_inner(&cwd.to_string_lossy(), "01-summary.md")
            .expect("delete should succeed");

        let read = read_plan_tree_file(cwd.to_string_lossy().to_string(), "01-summary.md".to_string())
            .expect("read after delete should be Ok");
        assert_eq!(read, None, "deleted file must read as absent");
        // The neighbor is untouched.
        let files = list_plan_tree(&cwd);
        assert_eq!(files, vec!["02-summary.md".to_string()], "only the neighbor must remain; found {files:?}");
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// PHASE 6 — deleting an ABSENT allow-listed file is a graceful no-op (`Ok(())`), not an error
    /// (a leaf node never wrote `NN-plan.md`, so its delete is a no-op). Falsifiable: if the absent
    /// case errored, the `expect` would panic.
    #[test]
    fn delete_absent_allowlisted_is_ok() {
        let cwd = unique_temp_dir();
        delete_plan_tree_file_inner(&cwd.to_string_lossy(), "07-plan.md")
            .expect("delete of an absent allow-listed name should be Ok, not Err");
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// PHASE 6 — the delete path is containment-guarded EXACTLY like read/write: every hostile name
    /// is rejected (Err) and removes NOTHING. We seed a legitimate file and assert it survives every
    /// rejected delete. Falsifiable: if a hostile name slipped the guard and unlinked the seed (or
    /// escaped `.plan-tree`), the survival assert would fire.
    #[test]
    fn delete_rejects_hostile_names_and_removes_nothing() {
        let cwd = unique_temp_dir();
        write_plan_tree_file_inner(&cwd.to_string_lossy(), "master.md", "seed")
            .expect("seed write should succeed");

        let hostile = [
            "../../etc/evil",
            "/abs/path",
            "foo/bar.md",
            "..",
            ".hidden",
            "1-plan.md",   // one digit
            "00-plans.md", // wrong stem
            "evil.md",
        ];
        for name in hostile {
            let res = delete_plan_tree_file_inner(&cwd.to_string_lossy(), name);
            assert!(res.is_err(), "delete of {name:?} must be rejected, got {res:?}");
        }
        let files = list_plan_tree(&cwd);
        assert_eq!(files, vec!["master.md".to_string()], "the seed must survive; found {files:?}");
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// After a successful write, no leftover `.tmp-*` temp files remain in `.plan-tree` (the
    /// atomic_write rename completed). Falsifiable: if rename were skipped, a `.tmp-` file would
    /// linger and the assert would fire.
    #[test]
    fn no_leftover_temp_files_after_write() {
        let cwd = unique_temp_dir();
        write_plan_tree_file_inner(&cwd.to_string_lossy(), "master.md", "content")
            .expect("write should succeed");

        let leftovers: Vec<String> = list_plan_tree(&cwd)
            .into_iter()
            .filter(|n| n.starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "found leftover temp files: {leftovers:?}");
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// CONTRACT: the validator MUST accept every file name the multiplan orchestrator's reducer +
    /// driver actually write via `writePlanTreeFile`/`persist`. This is the regression test for the
    /// shipped halt-after-recon bug: the reducer emits `recon.md` on RECON_DONE, the Rust validator
    /// rejected it, the throw aborted the effect loop before `persist`/the next prompt, and the run
    /// stalled. Falsifiable: against the OLD validator (`state.json`/`master.md` + `NN-(plan|summary)`),
    /// `recon.md` is NOT accepted and this test goes red on that case.
    ///
    /// Enumerated set the frontend emits (see plan-tree.ts / orchestrator.ts):
    ///   * `state.json`           — driver `persist` effect (orchestrator.ts runEffect)
    ///   * `INTENT.md`            — reducer INTENT_CLARIFIED (the intent-clarification phase)
    ///   * `recon.md`             — reducer RECON_DONE
    ///   * `master.md`            — reducer MASTER_DRAFTED
    ///   * `NN-summary.md`        — reducer SUMMARY_WRITTEN via summaryName(nn)
    /// (`NN-plan.md` is allow-listed for symmetry though the reducer routes plans through
    /// write_agent_plan; we keep accepting it.)
    ///
    /// Falsifiable for `INTENT.md`: remove "INTENT.md" from `LITERAL_PLAN_TREE_NAMES` and the
    /// `valid_plan_tree_name("INTENT.md")` assertion below goes RED (the same bug class as recon.md:
    /// the intent phase would throw before persist/the next prompt and the run would stall at intent).
    #[test]
    fn accepts_every_orchestrator_emitted_name() {
        let accept = [
            "state.json",
            "INTENT.md",
            "recon.md",
            "master.md",
            // NN-summary.md across the digit boundaries the reducer can produce (zero-padded 2-digit).
            "00-summary.md",
            "01-summary.md",
            "09-summary.md",
            "10-summary.md",
            "42-summary.md",
            "99-summary.md",
            // NN-plan.md (still allow-listed).
            "01-plan.md",
            "07-plan.md",
        ];
        for name in accept {
            assert!(
                valid_plan_tree_name(name),
                "validator must ACCEPT orchestrator-emitted name {name:?}"
            );
        }
    }

    /// CONTRACT: widening the allow-list must NOT open a path-traversal/hostile-name hole. Every name
    /// here must still be rejected. Falsifiable: if the charset/shape guard regressed (e.g. accepted a
    /// `/` or `..`), the matching `assert!` goes red. Extended (Phase 2, dotted ids) with the dotted
    /// hostile set — the dotted generalization must not loosen any segment/shape rule.
    #[test]
    fn still_rejects_unsafe_names() {
        let reject = [
            "../x",
            "../../etc/passwd",
            "/etc/passwd",
            "a/b.md",
            "",
            "..",
            ".hidden",
            "recon.md.bak",   // trailing junk on a now-accepted literal
            "Recon.md",       // case mismatch (allow-list is exact)
            "recon",          // missing extension
            "INTENT.md.bak",  // trailing junk on the now-accepted INTENT.md literal
            "intent.md",      // case mismatch (allow-list is exact: INTENT.md)
            "INTENT",         // missing extension
            "state.jsonx",
            "1-plan.md",      // single digit
            "00-plans.md",    // wrong stem
            "%2e%2e/x",       // url-encoded traversal
            "evil.md",
            // ---- dotted hostiles (Phase 2: SEG must be EXACTLY two digits, no empty segments) ----
            "001-plan.md",      // three-digit segment
            "02.-plan.md",      // trailing empty segment
            "02..01-plan.md",   // interior empty segment
            ".02-plan.md",      // leading empty segment (and leading `.`)
            "02.1-plan.md",     // one-digit second segment
            "02.001-plan.md",   // three-digit second segment
            "02.01-plans.md",   // wrong stem on a dotted id
            "02.01.md",         // no `-stem` at all
            "02.0a-plan.md",    // non-digit in a segment
            "02-01-plan.md",    // `-` is not a segment separator
            "02.01-",           // missing stem + extension
        ];
        for name in reject {
            assert!(
                !valid_plan_tree_name(name),
                "validator must REJECT unsafe name {name:?}"
            );
        }
    }

    /// Phase 2 (dotted hierarchical ids): the hand parser generalizes to `SEG("."SEG)*-(plan|summary).md`
    /// where SEG is EXACTLY two ASCII digits. Flat legacy names are the 1-segment case (still accepted
    /// byte-identically); arbitrary depth nests by appending `.SEG`. Falsifiable: revert `valid_nn_md`
    /// to the two-digit-only parser and every dotted accept below goes RED (the reject set is pinned
    /// red-side by `still_rejects_unsafe_names`).
    #[test]
    fn valid_nn_md_accepts_dotted_rejects_malformed() {
        let accept = [
            "01-plan.md",
            "99-summary.md",
            "02.01-plan.md",
            "02.01-summary.md",
            "02.01.01-plan.md",
            "10.20.30.40-summary.md",
        ];
        for name in accept {
            assert!(valid_nn_md(name), "must ACCEPT dotted/flat id {name:?}");
        }
        let reject = [
            "1-plan.md",       // single digit
            "001-plan.md",     // three digits
            "02.-plan.md",     // trailing empty segment
            "02..01-plan.md",  // interior empty segment
            ".02-plan.md",     // leading empty segment
            "02.1-plan.md",    // unpadded second segment
            "02.01-extra-plan.md", // junk between id and stem
            "02.01-plan.txt",  // wrong extension
            "-plan.md",        // no id at all
            "02.01-summary",   // missing .md
        ];
        for name in reject {
            assert!(!valid_nn_md(name), "must REJECT malformed id {name:?}");
        }
    }

    /// Writing to a non-existent `cwd` returns `Err` (and creates nothing). Falsifiable: if the
    /// existence check were dropped, `create_dir_all` would succeed and the write would too.
    #[test]
    fn write_to_missing_cwd_errors() {
        let cwd = unique_temp_dir();
        let missing = cwd.join("does-not-exist");
        let res = write_plan_tree_file_inner(&missing.to_string_lossy(), "state.json", "{}");
        assert!(res.is_err(), "write to missing cwd must error, got {res:?}");
        assert!(!missing.exists(), "missing cwd must not be created");
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// START reconciliation: a reset moves EVERY current `.plan-tree/` entry into `.archive/`
    /// (leaving the root holding nothing else), and a SECOND reset REPLACES the archive — exactly
    /// one prior generation kept, no `.archive/.archive` nesting, no unbounded growth. Falsifiable:
    /// skip the pre-clear of the old archive and the first-generation assertions go red.
    #[test]
    fn reset_plan_tree_dir_archives_and_bounds() {
        let cwd = unique_temp_dir();
        let dir = cwd.join(".plan-tree");
        std::fs::create_dir_all(&dir).expect("seed .plan-tree");
        // Stale litter from a "prior run" — including a name the write allow-list would reject
        // (request.txt, e.g. hook litter), which the sweep must still archive.
        std::fs::write(dir.join("01-summary.md"), "stale summary").expect("seed summary");
        std::fs::write(dir.join("request.txt"), "stale request").expect("seed request");

        reset_plan_tree_dir(cwd.to_string_lossy().to_string()).expect("first reset");

        let archive = dir.join(".archive");
        assert_eq!(
            std::fs::read_to_string(archive.join("01-summary.md")).expect("archived summary"),
            "stale summary"
        );
        assert_eq!(
            std::fs::read_to_string(archive.join("request.txt")).expect("archived request"),
            "stale request"
        );
        // The root now holds NOTHING but the archive itself.
        let names = list_plan_tree(&cwd);
        assert_eq!(names, vec![".archive".to_string()], "root must hold only .archive");

        // Second generation: new litter, then reset again — the archive is REPLACED, not nested.
        std::fs::write(dir.join("02-summary.md"), "gen2").expect("seed gen2");
        reset_plan_tree_dir(cwd.to_string_lossy().to_string()).expect("second reset");
        assert_eq!(
            std::fs::read_to_string(archive.join("02-summary.md")).expect("archived gen2"),
            "gen2"
        );
        assert!(
            !archive.join("01-summary.md").exists(),
            "first generation must be dropped (archive REPLACED)"
        );
        assert!(
            !archive.join(".archive").exists(),
            "the old archive must not be nested inside the new one"
        );
        let names = list_plan_tree(&cwd);
        assert_eq!(names, vec![".archive".to_string()], "root must hold only .archive after gen2");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// An absent `.plan-tree/` is created and the reset is a no-op archive (nothing to sweep).
    /// Falsifiable: an implementation erroring on a missing dir panics the expect.
    #[test]
    fn reset_plan_tree_dir_creates_absent_dir() {
        let cwd = unique_temp_dir();
        reset_plan_tree_dir(cwd.to_string_lossy().to_string()).expect("reset on absent dir");
        assert!(cwd.join(".plan-tree").is_dir(), ".plan-tree must exist after reset");
        std::fs::remove_dir_all(&cwd).ok();
    }

    /// MARKER-LAST ordering as data: `sweep_order` must place `state.json` — the app-ownership
    /// marker the ExitPlanMode hook fences on — strictly LAST, so a mid-sweep failure can never
    /// have already archived the marker while other litter remains at the root. Falsifiable:
    /// remove the partition (return the input order) and the last-position asserts go red.
    #[test]
    fn sweep_order_places_state_json_last() {
        let names = |v: &[&str]| -> Vec<std::ffi::OsString> {
            v.iter().map(std::ffi::OsString::from).collect()
        };

        // state.json mid-list → moved to the end; relative order of the rest preserved.
        let ordered = sweep_order(names(&["recon.md", "state.json", "01-plan.md", "request.txt"]));
        assert_eq!(
            ordered,
            names(&["recon.md", "01-plan.md", "request.txt", "state.json"])
        );
        assert_eq!(ordered.last().map(|n| n.as_os_str()), Some(std::ffi::OsStr::new("state.json")));

        // state.json FIRST in read_dir order — the exact hazard — still ends up last.
        let ordered = sweep_order(names(&["state.json", "master.md"]));
        assert_eq!(ordered, names(&["master.md", "state.json"]));

        // No marker present / empty input: order untouched.
        assert_eq!(sweep_order(names(&["a.md", "b.md"])), names(&["a.md", "b.md"]));
        assert_eq!(sweep_order(Vec::new()), Vec::<std::ffi::OsString>::new());
    }

    /// A SUBDIRECTORY at the `.plan-tree` root (e.g. a stray `prototype/` from a prior run) is
    /// swept whole into the archive, contents intact — `rename` moves directories atomically.
    /// Falsifiable: skip directory entries in the sweep and the archived-content read panics.
    #[test]
    fn reset_plan_tree_dir_archives_subdirectories() {
        let cwd = unique_temp_dir();
        let dir = cwd.join(".plan-tree");
        std::fs::create_dir_all(dir.join("prototype")).expect("seed subdir");
        std::fs::write(dir.join("prototype/index.html"), "<html>proto</html>")
            .expect("seed subdir file");

        reset_plan_tree_dir(cwd.to_string_lossy().to_string()).expect("reset");

        assert_eq!(
            std::fs::read_to_string(dir.join(".archive/prototype/index.html"))
                .expect("archived subdir file"),
            "<html>proto</html>"
        );
        assert!(!dir.join("prototype").exists(), "subdir must be gone from the root");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `.plan-tree` itself being a SYMLINK pointing outside the cwd must be REJECTED by the
    /// containment guard (canonical `.plan-tree`'s parent != canonical cwd), and the symlink's
    /// target left untouched — no archive created there, nothing swept. Falsifiable: drop the
    /// containment check and the reset succeeds, planting `.archive` inside the target.
    #[cfg(unix)]
    #[test]
    fn reset_plan_tree_dir_rejects_symlinked_plan_tree() {
        let cwd = unique_temp_dir();
        let target = unique_temp_dir(); // lives elsewhere under temp, NOT inside cwd
        std::fs::write(target.join("victim.md"), "do not touch").expect("seed target");
        std::os::unix::fs::symlink(&target, cwd.join(".plan-tree")).expect("plant symlink");

        let res = reset_plan_tree_dir(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "symlinked .plan-tree must be rejected, got {res:?}");

        // Target untouched: the victim file is still at its root and no archive was created.
        assert_eq!(
            std::fs::read_to_string(target.join("victim.md")).expect("victim intact"),
            "do not touch"
        );
        assert!(!target.join(".archive").exists(), "no archive may be planted in the target");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    /// `.plan-tree` itself being a SYMLINK pointing outside the cwd must be REJECTED by the
    /// write/read/delete containment guard (`guarded_plan_tree_path`), even for an ALLOW-LISTED
    /// name — and the symlink's target must be left untouched (no file written there). This mirrors
    /// `reset_plan_tree_dir_rejects_symlinked_plan_tree` but exercises the write/read/delete trio.
    ///
    /// Falsifiable: with the OLD guard (canonical PARENT of `dir.join(name)` vs canonical `dir` —
    /// tautologically equal because an allow-listed `name` has no `/`, so `joined.parent()` is
    /// always exactly `dir`), the symlink is NOT rejected: the write lands `state.json` inside the
    /// symlink's target and the `is_err()` assert below goes RED. The fix (assert canonical
    /// `.plan-tree`'s PARENT == canonical cwd) makes it pass.
    #[cfg(unix)]
    #[test]
    fn guarded_plan_tree_path_rejects_symlinked_plan_tree() {
        let cwd = unique_temp_dir();
        let target = unique_temp_dir(); // lives elsewhere under temp, NOT inside cwd
        std::fs::write(target.join("victim.md"), "do not touch").expect("seed target");
        std::os::unix::fs::symlink(&target, cwd.join(".plan-tree")).expect("plant symlink");

        let cwd_s = cwd.to_string_lossy().to_string();

        // WRITE of an allow-listed name through a symlinked `.plan-tree` must be rejected, and must
        // write NOTHING into the symlink's target.
        let res = write_plan_tree_file_inner(&cwd_s, "state.json", "PWNED");
        assert!(res.is_err(), "write via symlinked .plan-tree must be rejected, got {res:?}");
        assert!(
            !target.join("state.json").exists(),
            "no file may be planted in the symlink target"
        );

        // READ through a symlinked `.plan-tree` must be rejected too (same guard).
        let res = read_plan_tree_file(cwd_s.clone(), "state.json".to_string());
        assert!(res.is_err(), "read via symlinked .plan-tree must be rejected, got {res:?}");

        // DELETE through a symlinked `.plan-tree` must be rejected, leaving the target untouched.
        let res = delete_plan_tree_file_inner(&cwd_s, "victim.md".to_string().as_str());
        // (victim.md is not even allow-listed, but assert the broader invariant via an allow-listed
        // name too — the delete of an allow-listed name must be rejected before any unlink.)
        let _ = res;
        let res = delete_plan_tree_file_inner(&cwd_s, "state.json");
        assert!(res.is_err(), "delete via symlinked .plan-tree must be rejected, got {res:?}");

        // The target's pre-existing file is untouched throughout.
        assert_eq!(
            std::fs::read_to_string(target.join("victim.md")).expect("victim intact"),
            "do not touch"
        );

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    /// A NORMAL (real-directory) `.plan-tree` still works through `guarded_plan_tree_path`: a write
    /// + read round-trips, both BEFORE the dir exists (first use creates it) and after. This pins
    /// that the symlink-rejection fix does NOT break the legitimate create-then-write flow.
    /// Falsifiable: an over-strict guard that rejected a freshly-created real dir would fail the
    /// `expect`s here.
    #[test]
    fn guarded_plan_tree_path_accepts_real_plan_tree() {
        let cwd = unique_temp_dir();
        let cwd_s = cwd.to_string_lossy().to_string();

        // First write CREATES `.plan-tree` (it did not exist yet) and succeeds.
        let written = write_plan_tree_file_inner(&cwd_s, "master.md", "real plan")
            .expect("first write to a real (to-be-created) .plan-tree must succeed");
        assert!(written.ends_with("/.plan-tree/master.md"), "got {written}");
        // The dir is a real directory directly inside cwd.
        let dir = cwd.join(".plan-tree");
        assert!(dir.is_dir(), ".plan-tree must be a real directory");

        // A second write/read round-trips against the now-existing dir.
        write_plan_tree_file_inner(&cwd_s, "recon.md", "recon body")
            .expect("second write to the existing real dir must succeed");
        let read = read_plan_tree_file(cwd_s.clone(), "recon.md".to_string())
            .expect("read should succeed");
        assert_eq!(read, Some("recon body".to_string()));

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// A stray regular FILE named `.archive` at the root is REPLACED (removed and recreated as the
    /// archive dir) rather than erroring — an error here would feed straight into the start()
    /// wedge. The file's content is dropped; the sweep proceeds normally. Falsifiable: restore the
    /// bare `remove_dir_all` (which errors on a file) and the `expect` panics.
    #[test]
    fn reset_plan_tree_dir_replaces_stray_archive_file() {
        let cwd = unique_temp_dir();
        let dir = cwd.join(".plan-tree");
        std::fs::create_dir_all(&dir).expect("seed .plan-tree");
        std::fs::write(dir.join(".archive"), "i am a file, not a dir").expect("seed stray file");
        std::fs::write(dir.join("recon.md"), "stale recon").expect("seed recon");

        reset_plan_tree_dir(cwd.to_string_lossy().to_string()).expect("reset must replace the stray file");

        let archive = dir.join(".archive");
        assert!(archive.is_dir(), ".archive must now be a directory");
        assert_eq!(
            std::fs::read_to_string(archive.join("recon.md")).expect("archived recon"),
            "stale recon"
        );

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `ensure_prototype_dir` creates `<cwd>/.plan-tree/prototype/` when absent and is IDEMPOTENT
    /// (a second call on the now-existing dir succeeds and returns the same path). The returned
    /// path is absolute and ends with `.plan-tree/prototype`. Falsifiable: skip the create_dir_all
    /// and the canonicalize fails (no dir to canonicalize) → the expect panics.
    #[test]
    fn ensure_prototype_dir_creates_idempotently_and_returns_absolute() {
        let cwd = unique_temp_dir();
        let first = ensure_prototype_dir(cwd.to_string_lossy().to_string())
            .expect("first ensure should create the dir");
        assert!(Path::new(&first).is_absolute(), "returned path must be absolute: {first}");
        assert!(
            first.ends_with("/.plan-tree/prototype"),
            "returned path must be the prototype dir: {first}"
        );
        assert!(Path::new(&first).is_dir(), "the prototype dir must exist on disk");

        let second = ensure_prototype_dir(cwd.to_string_lossy().to_string())
            .expect("second ensure must be an idempotent success");
        assert_eq!(first, second, "idempotent re-ensure must return the same path");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `ensure_prototype_dir` mirrors `reset_plan_tree_dir`'s cwd guards: relative cwd, a cwd with
    /// `..` components, and a missing cwd are all rejected (and nothing is created). Falsifiable:
    /// drop the guards and the `..` form resolves to a real directory and succeeds.
    #[test]
    fn ensure_prototype_dir_rejects_bad_cwd() {
        let cwd = unique_temp_dir();

        let res = ensure_prototype_dir("relative/dir".to_string());
        assert!(res.is_err(), "relative cwd must be rejected, got {res:?}");

        let traversing = format!("{}/..", cwd.to_string_lossy());
        let res = ensure_prototype_dir(traversing);
        assert!(res.is_err(), "cwd with `..` must be rejected, got {res:?}");

        let missing = cwd.join("does-not-exist");
        let res = ensure_prototype_dir(missing.to_string_lossy().to_string());
        assert!(res.is_err(), "missing cwd must be rejected, got {res:?}");
        assert!(!missing.exists(), "missing cwd must not be created");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// A `.plan-tree` that is a SYMLINK out of the cwd must be rejected by the prototype-dir
    /// containment assert (the canonical dir no longer equals `<canon cwd>/.plan-tree/prototype`).
    /// Falsifiable: drop the equality check and the ensure succeeds, planting `prototype/` inside
    /// the symlink's target.
    #[cfg(unix)]
    #[test]
    fn ensure_prototype_dir_rejects_symlinked_plan_tree() {
        let cwd = unique_temp_dir();
        let target = unique_temp_dir(); // elsewhere under temp, NOT inside cwd
        std::os::unix::fs::symlink(&target, cwd.join(".plan-tree")).expect("plant symlink");

        let res = ensure_prototype_dir(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "symlinked .plan-tree must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    /// `validated_prototype_file` containment: traversal out of the prototype dir, an absolute
    /// path outside the cwd, a file at the `.plan-tree` ROOT (inside cwd but NOT under
    /// `prototype/`), and a DIRECTORY inside `prototype/` are ALL rejected; a real file under
    /// `prototype/` is accepted whether addressed relative-to-cwd or absolutely, and the returned
    /// path is absolute (canonical). Falsifiable: drop the `starts_with` containment check and the
    /// `.plan-tree`-root case (an existing regular file) validates.
    #[test]
    fn validated_prototype_file_containment() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        std::fs::write(proto.join("index.html"), "<html></html>").expect("seed index.html");
        std::fs::create_dir_all(proto.join("assets")).expect("seed subdir");
        std::fs::write(cwd.join(".plan-tree").join("master.md"), "not a prototype")
            .expect("seed plan-tree-root file");
        // An out-of-cwd victim a traversal would otherwise reach.
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");

        let cwd_s = cwd.to_string_lossy().to_string();

        // Accept: relative-to-cwd addressing (the gate's usual form).
        let ok = validated_prototype_file(&cwd_s, ".plan-tree/prototype/index.html")
            .expect("relative in-dir file must validate");
        assert!(ok.is_absolute(), "validated path must be absolute: {ok:?}");
        assert!(ok.ends_with(".plan-tree/prototype/index.html"), "got {ok:?}");

        // Accept: absolute addressing of the same file.
        let abs = proto.join("index.html").to_string_lossy().to_string();
        validated_prototype_file(&cwd_s, &abs).expect("absolute in-dir file must validate");

        // Reject: traversal escaping prototype/ (resolves to the out-of-cwd victim).
        let depth = outside.components().count();
        let ups = "../".repeat(depth + 4);
        let traversal = format!(
            ".plan-tree/prototype/{ups}{}/victim.html",
            outside.to_string_lossy().trim_start_matches('/')
        );
        let res = validated_prototype_file(&cwd_s, &traversal);
        assert!(res.is_err(), "traversal must be rejected, got {res:?}");

        // Reject: absolute path outside the cwd entirely.
        let res = validated_prototype_file(
            &cwd_s,
            &outside.join("victim.html").to_string_lossy().to_string(),
        );
        assert!(res.is_err(), "outside-cwd absolute path must be rejected, got {res:?}");

        // Reject: a real file inside .plan-tree but NOT under prototype/.
        let res = validated_prototype_file(&cwd_s, ".plan-tree/master.md");
        assert!(res.is_err(), ".plan-tree-root file must be rejected, got {res:?}");

        // Reject: a directory inside prototype/ (not a regular file).
        let res = validated_prototype_file(&cwd_s, ".plan-tree/prototype/assets");
        assert!(res.is_err(), "directory must be rejected, got {res:?}");

        // Reject: the prototype dir itself.
        let res = validated_prototype_file(&cwd_s, ".plan-tree/prototype");
        assert!(res.is_err(), "the prototype dir itself must be rejected, got {res:?}");

        // Reject: a missing file (nothing to open).
        let res = validated_prototype_file(&cwd_s, ".plan-tree/prototype/ghost.html");
        assert!(res.is_err(), "missing file must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// A SYMLINK inside `prototype/` pointing OUT of it must be rejected: validation operates on
    /// the canonical (resolved) path, which lands outside the canonical prototype dir.
    /// Falsifiable: validate the un-canonicalized join instead and the symlink passes.
    #[cfg(unix)]
    #[test]
    fn validated_prototype_file_rejects_outward_symlink() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");
        std::os::unix::fs::symlink(outside.join("victim.html"), proto.join("link.html"))
            .expect("plant symlink");

        let res = validated_prototype_file(
            &cwd.to_string_lossy(),
            ".plan-tree/prototype/link.html",
        );
        assert!(res.is_err(), "outward symlink must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// Path-escape rejection: a `cwd` containing `..` components, a relative `cwd`, or a missing
    /// `cwd` all error and sweep NOTHING. Falsifiable: drop the component/existence guards and the
    /// `..` form resolves to a real directory, succeeding.
    #[test]
    fn reset_plan_tree_dir_rejects_path_escape() {
        let cwd = unique_temp_dir();
        let traversing = format!("{}/..", cwd.to_string_lossy());
        let res = reset_plan_tree_dir(traversing);
        assert!(res.is_err(), "cwd with `..` must be rejected, got {res:?}");

        let res = reset_plan_tree_dir("relative/dir".to_string());
        assert!(res.is_err(), "relative cwd must be rejected, got {res:?}");

        let missing = cwd.join("does-not-exist");
        let res = reset_plan_tree_dir(missing.to_string_lossy().to_string());
        assert!(res.is_err(), "missing cwd must be rejected, got {res:?}");
        assert!(!missing.exists(), "missing cwd must not be created");

        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---- baseline (frozen "working reference") tests (Phase 3) ---------------------------------

    /// `ensure_baseline_dir` creates `<cwd>/.plan-tree/baseline/` when absent and is IDEMPOTENT.
    /// The returned path is absolute and ends with `.plan-tree/baseline`. Falsifiable: skip the
    /// create_dir_all and the canonicalize fails → the expect panics.
    #[test]
    fn ensure_baseline_dir_creates_idempotently_and_returns_absolute() {
        let cwd = unique_temp_dir();
        let first = ensure_baseline_dir(cwd.to_string_lossy().to_string())
            .expect("first ensure should create the dir");
        assert!(Path::new(&first).is_absolute(), "returned path must be absolute: {first}");
        assert!(
            first.ends_with("/.plan-tree/baseline"),
            "returned path must be the baseline dir: {first}"
        );
        assert!(Path::new(&first).is_dir(), "the baseline dir must exist on disk");

        let second = ensure_baseline_dir(cwd.to_string_lossy().to_string())
            .expect("second ensure must be an idempotent success");
        assert_eq!(first, second, "idempotent re-ensure must return the same path");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `ensure_baseline_dir` mirrors the cwd guards: relative cwd, a cwd with `..` components, and a
    /// missing cwd are all rejected (and nothing is created). Falsifiable: drop the guards and the
    /// `..` form resolves to a real directory and succeeds.
    #[test]
    fn ensure_baseline_dir_rejects_bad_cwd() {
        let cwd = unique_temp_dir();

        let res = ensure_baseline_dir("relative/dir".to_string());
        assert!(res.is_err(), "relative cwd must be rejected, got {res:?}");

        let traversing = format!("{}/..", cwd.to_string_lossy());
        let res = ensure_baseline_dir(traversing);
        assert!(res.is_err(), "cwd with `..` must be rejected, got {res:?}");

        let missing = cwd.join("does-not-exist");
        let res = ensure_baseline_dir(missing.to_string_lossy().to_string());
        assert!(res.is_err(), "missing cwd must be rejected, got {res:?}");
        assert!(!missing.exists(), "missing cwd must not be created");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// A `.plan-tree` that is a SYMLINK out of the cwd must be rejected by the baseline-dir
    /// containment assert. Falsifiable: drop the equality check and the ensure succeeds, planting
    /// `baseline/` inside the symlink's target.
    #[cfg(unix)]
    #[test]
    fn ensure_baseline_dir_rejects_symlinked_plan_tree() {
        let cwd = unique_temp_dir();
        let target = unique_temp_dir(); // elsewhere under temp, NOT inside cwd
        std::os::unix::fs::symlink(&target, cwd.join(".plan-tree")).expect("plant symlink");

        let res = ensure_baseline_dir(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "symlinked .plan-tree must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    /// FREEZE ROUND-TRIP: `freeze_baseline` recursively copies `<cwd>/.plan-tree/prototype/` into
    /// `<cwd>/.plan-tree/baseline/`, files AND nested subdirs preserved byte-for-byte. Falsifiable:
    /// skip the recursion and the nested-file read panics.
    #[test]
    fn freeze_baseline_copies_files_and_subdirs() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(proto.join("assets")).expect("seed prototype dir + subdir");
        std::fs::write(proto.join("index.html"), "<html>proto</html>").expect("seed index");
        std::fs::write(proto.join("assets/app.js"), "console.log('hi')").expect("seed nested file");

        let returned =
            freeze_baseline(cwd.to_string_lossy().to_string()).expect("freeze should succeed");
        assert!(
            returned.ends_with("/.plan-tree/baseline"),
            "returned path must be the baseline dir: {returned}"
        );

        let base = cwd.join(".plan-tree").join("baseline");
        assert_eq!(
            std::fs::read_to_string(base.join("index.html")).expect("frozen index"),
            "<html>proto</html>"
        );
        assert_eq!(
            std::fs::read_to_string(base.join("assets/app.js")).expect("frozen nested file"),
            "console.log('hi')"
        );

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `freeze_baseline` with NO prototype dir errors (nothing to freeze) and creates no baseline.
    /// Falsifiable: if freeze ignored the missing source, it would create an empty baseline and
    /// succeed.
    #[test]
    fn freeze_baseline_errors_without_prototype() {
        let cwd = unique_temp_dir();
        std::fs::create_dir_all(cwd.join(".plan-tree")).expect("seed .plan-tree (no prototype)");

        let res = freeze_baseline(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "freeze without a prototype dir must error, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// FREEZE SYMLINK DEFENSE: a symlink INSIDE `prototype/` pointing OUT of it must be rejected
    /// (the freeze never follows a link to copy outside content), and the link's target left
    /// untouched (no copy planted). Falsifiable: follow the symlink instead of rejecting and the
    /// out-of-tree victim is copied into baseline.
    #[cfg(unix)]
    #[test]
    fn freeze_baseline_rejects_inward_symlink() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");
        std::os::unix::fs::symlink(outside.join("victim.html"), proto.join("link.html"))
            .expect("plant symlink");

        let res = freeze_baseline(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "freeze must reject a symlink entry, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// FREEZE DESTINATION SYMLINK DEFENSE: a symlink pre-planted at the DESTINATION (inside
    /// `baseline/`, same name as a prototype file) pointing OUT of `.plan-tree/` must be rejected —
    /// `std::fs::copy` would otherwise FOLLOW the link and overwrite the out-of-tree target with the
    /// prototype's bytes. The freeze must error and leave the victim untouched. Falsifiable: remove
    /// the destination `symlink_metadata` guard in `copy_tree_contained`'s file branch and the victim
    /// is overwritten with the prototype content (the assertion goes RED).
    #[cfg(unix)]
    #[test]
    fn freeze_baseline_rejects_destination_symlink() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        std::fs::write(proto.join("index.html"), "PROTO").expect("seed prototype file");

        // An out-of-containment victim the planted destination symlink points at.
        let outside = unique_temp_dir();
        let victim = outside.join("victim.html");
        std::fs::write(&victim, "ORIGINAL").expect("seed victim");

        // Pre-plant the baseline dir with a symlink whose name collides with the prototype file, so
        // the copy resolves dst_child to it.
        let base = cwd.join(".plan-tree").join("baseline");
        std::fs::create_dir_all(&base).expect("seed baseline dir");
        std::os::unix::fs::symlink(&victim, base.join("index.html")).expect("plant dst symlink");

        let res = freeze_baseline(cwd.to_string_lossy().to_string());
        assert!(
            res.is_err(),
            "freeze must reject a symlink at the destination, got {res:?}"
        );
        // The out-of-tree victim must be untouched (the copy never followed the link).
        assert_eq!(
            std::fs::read_to_string(&victim).expect("victim still readable"),
            "ORIGINAL",
            "destination symlink must NOT be followed to overwrite the out-of-tree victim"
        );

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// `validated_baseline_file` containment: traversal out of baseline/, an absolute path outside
    /// the cwd, a file at the `.plan-tree` ROOT (inside cwd but NOT under baseline/), a DIRECTORY
    /// inside baseline/, and the baseline dir itself are ALL rejected; a real file under baseline/
    /// is accepted relative-to-cwd and absolutely, returning an absolute path. Falsifiable: drop the
    /// `starts_with` containment check and the `.plan-tree`-root case validates.
    #[test]
    fn validated_baseline_file_containment() {
        let cwd = unique_temp_dir();
        let base = cwd.join(".plan-tree").join("baseline");
        std::fs::create_dir_all(&base).expect("seed baseline dir");
        std::fs::write(base.join("index.html"), "<html></html>").expect("seed index.html");
        std::fs::create_dir_all(base.join("assets")).expect("seed subdir");
        std::fs::write(cwd.join(".plan-tree").join("master.md"), "not a baseline")
            .expect("seed plan-tree-root file");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");

        let cwd_s = cwd.to_string_lossy().to_string();

        // Accept: relative-to-cwd addressing.
        let ok = validated_baseline_file(&cwd_s, ".plan-tree/baseline/index.html")
            .expect("relative in-dir file must validate");
        assert!(ok.is_absolute(), "validated path must be absolute: {ok:?}");
        assert!(ok.ends_with(".plan-tree/baseline/index.html"), "got {ok:?}");

        // Accept: absolute addressing of the same file.
        let abs = base.join("index.html").to_string_lossy().to_string();
        validated_baseline_file(&cwd_s, &abs).expect("absolute in-dir file must validate");

        // Reject: traversal escaping baseline/ (resolves to the out-of-cwd victim).
        let depth = outside.components().count();
        let ups = "../".repeat(depth + 4);
        let traversal = format!(
            ".plan-tree/baseline/{ups}{}/victim.html",
            outside.to_string_lossy().trim_start_matches('/')
        );
        let res = validated_baseline_file(&cwd_s, &traversal);
        assert!(res.is_err(), "traversal must be rejected, got {res:?}");

        // Reject: absolute path outside the cwd entirely.
        let res = validated_baseline_file(
            &cwd_s,
            &outside.join("victim.html").to_string_lossy().to_string(),
        );
        assert!(res.is_err(), "outside-cwd absolute path must be rejected, got {res:?}");

        // Reject: a real file inside .plan-tree but NOT under baseline/.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/master.md");
        assert!(res.is_err(), ".plan-tree-root file must be rejected, got {res:?}");

        // Reject: a directory inside baseline/.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/baseline/assets");
        assert!(res.is_err(), "directory must be rejected, got {res:?}");

        // Reject: the baseline dir itself.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/baseline");
        assert!(res.is_err(), "the baseline dir itself must be rejected, got {res:?}");

        // Reject: a missing file.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/baseline/ghost.html");
        assert!(res.is_err(), "missing file must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// A SYMLINK inside `baseline/` pointing OUT of it must be rejected: validation operates on the
    /// canonical (resolved) path, which lands outside the canonical baseline dir. Falsifiable:
    /// validate the un-canonicalized join instead and the symlink passes.
    #[cfg(unix)]
    #[test]
    fn validated_baseline_file_rejects_outward_symlink() {
        let cwd = unique_temp_dir();
        let base = cwd.join(".plan-tree").join("baseline");
        std::fs::create_dir_all(&base).expect("seed baseline dir");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");
        std::os::unix::fs::symlink(outside.join("victim.html"), base.join("link.html"))
            .expect("plant symlink");

        let res = validated_baseline_file(&cwd.to_string_lossy(), ".plan-tree/baseline/link.html");
        assert!(res.is_err(), "outward symlink must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
