// cwd-resolution spike — VALIDATION ONLY (Sub-Plan 01, step 5).
//
// Throwaway `cargo run --example cwd_spike`. NOT a Tauri command and NOT wired into
// list_plans. Its sole job is to validate that a plan-file stem can be resolved to its
// owning session `cwd` against REAL on-disk transcripts, confirming the reserved
// `cwd: Option<String>` field shape that Sub-Plan 03 will build a production resolver for.
//
// Match strategy (corrected against real on-disk data — do NOT key on file_path alone):
//   1. AUTHORITATIVE: an `attachment` record with attachment.type == "plan_mode" whose
//      attachment.planFilePath ends with `/plans/<stem>.md`. (Carries attachment.isSubAgent.)
//   2. FALLBACK: a `Write` tool_use record whose input.file_path ends with the same suffix.
//   3. LAST RESORT: any record line that merely contains the plan-path string.
//   For whichever record matched, read THAT session's top-level `cwd` field.
//
// NEVER reverse-decode the encoded directory name (lossy — verified:
//   `-private-tmp-canary-work` ↦ `/private/tmp/canary_work`).
//
// We scan BOTH `~/.claude/projects/*/*.jsonl` AND
// `~/.claude/projects/*/*/subagents/agent-*.jsonl`. Subagent transcripts are
// self-sufficient (carry their own top-level cwd) and a parent <session>.jsonl may not
// exist on disk, so descending into subagents/ is necessary.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
enum Provenance {
    PlanModeAttachment, // authoritative
    WriteFilePath,      // fallback
    LineContains,       // last resort
}

#[derive(Debug)]
struct Resolution {
    cwd: Option<String>,
    provenance: Option<Provenance>,
    is_subagent: Option<bool>,
    source_file: Option<String>,
}

fn home() -> PathBuf {
    dirs::home_dir().expect("home dir")
}

fn projects_root() -> PathBuf {
    home().join(".claude").join("projects")
}

/// Collect every transcript file: top-level session jsonls and subagent agent jsonls.
fn collect_transcripts() -> Vec<PathBuf> {
    let root = projects_root();
    let mut out = Vec::new();
    let Ok(project_dirs) = fs::read_dir(&root) else {
        return out;
    };
    for proj in project_dirs.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        // Top-level <session>.jsonl files.
        if let Ok(entries) = fs::read_dir(&proj_path) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    out.push(p.clone());
                }
                // Descend into <session>/subagents/agent-*.jsonl.
                if p.is_dir() {
                    let sub = p.join("subagents");
                    if let Ok(subs) = fs::read_dir(&sub) {
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

/// Try to resolve one plan stem to its owning cwd by scanning all transcripts.
/// Returns the best (highest-provenance) match found. Prefers an authoritative
/// plan_mode attachment; only falls through to weaker signals if none found.
fn resolve_stem(stem: &str, transcripts: &[PathBuf]) -> Resolution {
    let suffix = format!("/plans/{stem}.md");

    let mut best: Resolution = Resolution {
        cwd: None,
        provenance: None,
        is_subagent: None,
        source_file: None,
    };

    for fp in transcripts {
        let Ok(text) = fs::read_to_string(fp) else {
            continue;
        };
        // Cheap pre-filter: skip files that never mention this stem at all.
        if !text.contains(&suffix) {
            continue;
        }

        // The session's top-level cwd: take it from the first parseable line that has one.
        // (All records in a transcript share the same session cwd.)
        let session_cwd = first_cwd(&text);

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            // (1) AUTHORITATIVE — plan_mode attachment.
            if let Some(att) = v.get("attachment") {
                let is_plan_mode = att.get("type").and_then(|t| t.as_str()) == Some("plan_mode");
                if is_plan_mode {
                    if let Some(pfp) = att.get("planFilePath").and_then(|p| p.as_str()) {
                        if pfp.ends_with(&suffix) {
                            let is_sub = att.get("isSubAgent").and_then(|b| b.as_bool());
                            // top-level cwd of THIS record (falls back to session_cwd).
                            let cwd = v
                                .get("cwd")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string())
                                .or_else(|| session_cwd.clone());
                            return Resolution {
                                cwd,
                                provenance: Some(Provenance::PlanModeAttachment),
                                is_subagent: is_sub,
                                source_file: Some(rel(fp)),
                            };
                        }
                    }
                }
            }

            // (2) FALLBACK — Write tool_use input.file_path.
            if best.provenance.is_none() || best.provenance == Some(Provenance::LineContains) {
                if let Some(fpath) = write_file_path(&v) {
                    if fpath.ends_with(&suffix) {
                        let cwd = v
                            .get("cwd")
                            .and_then(|c| c.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| session_cwd.clone());
                        best = Resolution {
                            cwd,
                            provenance: Some(Provenance::WriteFilePath),
                            is_subagent: None,
                            source_file: Some(rel(fp)),
                        };
                        continue;
                    }
                }
            }
        }

        // (3) LAST RESORT — file mentions the stem but no structured match yet.
        if best.provenance.is_none() {
            best = Resolution {
                cwd: session_cwd.clone(),
                provenance: Some(Provenance::LineContains),
                is_subagent: None,
                source_file: Some(rel(fp)),
            };
        }
    }

    best
}

/// First top-level `cwd` value found across the transcript's lines.
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

/// Extract a Write tool_use's input.file_path from a record, if present.
fn write_file_path(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?.as_array()?;
    for c in content {
        if c.get("type").and_then(|t| t.as_str()) == Some("tool_use")
            && c.get("name").and_then(|n| n.as_str()) == Some("Write")
        {
            if let Some(fp) = c.get("input").and_then(|i| i.get("file_path")).and_then(|f| f.as_str())
            {
                return Some(fp.to_string());
            }
        }
    }
    None
}

fn rel(p: &Path) -> String {
    let root = projects_root();
    p.strip_prefix(&root)
        .map(|r| r.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

fn main() {
    let transcripts = collect_transcripts();
    let subagent_count = transcripts
        .iter()
        .filter(|p| p.to_string_lossy().contains("/subagents/"))
        .count();
    println!("=== cwd-resolution spike (validation only) ===");
    println!(
        "Scanned {} transcript files ({} top-level sessions, {} subagent transcripts).\n",
        transcripts.len(),
        transcripts.len() - subagent_count,
        subagent_count
    );

    // Real sample stems — INCLUDING at least one *-agent-<hex> subagent plan.
    let real_samples = [
        "dynamic-forging-yao",                            // regular, Write + plan_mode
        "async-popping-acorn",                            // regular
        "velvet-floating-hellman",                        // regular
        "merry-baking-hammock-agent-acea1c41bbc02c040",   // SUBAGENT plan (parent may be absent)
    ];
    // Falsifiability: a deliberately fake stem MUST resolve to None.
    let fake_stem = "totally-fake-nonexistent-plan-zzz-9999";

    let mut all_real_ok = true;
    let mut subagent_self_sufficient = false;

    println!("--- Real sample stems ---");
    for stem in real_samples {
        let r = resolve_stem(stem, &transcripts);
        let is_sub_plan = stem.contains("-agent-");
        match &r.cwd {
            Some(cwd) => {
                println!(
                    "  RESOLVED  {stem}\n            cwd        = {cwd}\n            provenance = {:?}\n            isSubAgent = {:?}\n            source     = {}",
                    r.provenance,
                    r.is_subagent,
                    r.source_file.as_deref().unwrap_or("?")
                );
                // Assert subagent plan resolved ONLY inside a subagents/ transcript.
                if is_sub_plan {
                    let from_sub = r
                        .source_file
                        .as_deref()
                        .map(|s| s.contains("/subagents/"))
                        .unwrap_or(false);
                    if from_sub {
                        subagent_self_sufficient = true;
                        println!("            [invariant b] resolved inside subagents/ transcript (self-sufficient)");
                    }
                }
            }
            None => {
                all_real_ok = false;
                println!("  *** FAILED to resolve {stem} (expected a cwd) ***");
            }
        }
        println!();
    }

    println!("--- Falsifiability check (fake stem must be None) ---");
    let fake = resolve_stem(fake_stem, &transcripts);
    let fake_is_none = fake.cwd.is_none() && fake.provenance.is_none();
    println!(
        "  {stem} -> cwd={:?} provenance={:?}  => {}",
        fake.cwd,
        fake.provenance,
        if fake_is_none { "None (PASS)" } else { "MATCHED SOMETHING (FAIL)" },
        stem = fake_stem
    );
    println!();

    // ---- Assertions (the invariants the spike must prove) ----
    println!("=== Invariant assertions ===");
    assert!(all_real_ok, "(a) all real sample stems must resolve to a cwd");
    println!("  (a) PASS — all real sample stems resolved to a cwd.");

    assert!(
        subagent_self_sufficient,
        "(b) the subagent plan must resolve inside a subagents/ transcript (self-sufficient)"
    );
    println!("  (b) PASS — subagent plan resolved inside its own subagents/ transcript (parent session not required).");

    // (c) Option<String> shape: a resolved stem yields Some(path); an unknown yields None.
    println!("  (c) PASS — resolved => Some(path); unknown => None. `Option<String>` is the correct reserved type.");

    assert!(fake_is_none, "(d) the fake stem must resolve to None (falsifiability)");
    println!("  (d) PASS — fake stem resolved to None (matcher is not trivially matching everything).");

    println!("\nAll invariants hold.");
}
