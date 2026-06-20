// Agent SDK driver (Sub-Plan 01) — additive, non-breaking.
//
// All driver logic lives HERE; the only edits to the lib.rs monolith are
// additive registration (plugin init, managed state, generate_handler!,
// teardown RunEvent → agent::shutdown_session). This module owns:
//   - the AgentDriver struct (CommandChild + bookkeeping) in Mutex<Option<…>>
//   - the 8 Tauri commands
//   - the sidecar spawn (shell plugin) + the read task (recv -> parse -> emit)
//   - token persistence (agent-auth.json, atomic temp-write+rename, mode 0600)
//   - the PURE helper `parse_stream_line` (unit-tested)
//
// The sidecar normalizes the SDK's message union into a small wire vocabulary;
// Rust never interprets the SDK shapes — it parses one JSON line per stdout
// event and RE-EMITS it onto the appropriate Tauri event, nothing more.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

/// Bounded interval the teardown drain waits for the sidecar (and, transitively,
/// its `claude` grandchild) to exit gracefully after the `end` line, before
/// falling back to SIGKILL. Kept short so app shutdown can never hang on a wedged
/// child, yet long enough for the SDK's `process.on("exit")` reaper to SIGTERM the
/// grandchild and for both to wind down.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// The sidecar's `externalBin` base name (tauri appends the target triple).
const SIDECAR_NAME: &str = "agent-driver";

/// Token store filename under the app-data dir. NEVER written into `~/.claude`.
const AUTH_FILE: &str = "agent-auth.json";

// ---------------------------------------------------------------------------
// Managed state.
// ---------------------------------------------------------------------------

/// Process-wide monotonic session id. Each `start_agent_session` stamps the
/// stored driver with the next value; the read task carries that same id so it
/// only releases the slot for the session it owns (never a successor's).
static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

/// Take the value out of `slot` IFF its stored id equals `my_id`; otherwise
/// leave the slot untouched and return `None`. Poison-safe (a poisoned lock is
/// treated as "nothing to take"). This is the natural-death release primitive:
/// the read task calls it on `Terminated` so a session that ended on its own
/// frees the singleton — but a newer session that already replaced it is left
/// alone (id mismatch).
fn take_if_current<T>(slot: &Mutex<Option<(u64, T)>>, my_id: u64) -> Option<T> {
    let mut guard = slot.lock().ok()?;
    match &*guard {
        Some((id, _)) if *id == my_id => guard.take().map(|(_, t)| t),
        _ => None,
    }
}

/// Store `driver` (stamped with `id`) into the singleton `slot`, then run `send` against the just-
/// stored driver. On send SUCCESS the driver stays in the slot and `Ok(())` is returned (the read
/// task is wired up by the caller afterward). On send FAILURE the driver is TAKEN BACK OUT of the
/// slot (`take_if_current`, id-matched so a racing successor is never clobbered) and returned to the
/// caller as `Err((driver, message))` so it can kill/drain the orphaned child — leaving the slot
/// `None` so the one-session-per-launch guard is NOT phantom-locked for the rest of the launch.
///
/// ROOT CAUSE this fixes: the old code stored the driver and only THEN sent the start line; a send
/// failure (`?`) returned early with the slot still `Some(dead-driver)`. With no read task ever
/// spawned, the natural-death `Terminated` handler that frees the slot could never fire, so every
/// subsequent `start_agent_session` was rejected with "already running" until an app restart.
///
/// Generic over the driver type + the send closure so the store→send→rollback ordering is unit-
/// testable with a fake driver and an injectable failing send (the real `AgentDriver::send_line`
/// needs a `CommandChild` that cannot be constructed in a test).
fn store_then_send<T, F>(
    slot: &Mutex<Option<(u64, T)>>,
    id: u64,
    driver: T,
    send: F,
) -> Result<(), (T, String)>
where
    F: FnOnce(&mut T) -> Result<(), String>,
{
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(_) => return Err((driver, "driver state poisoned".to_string())),
    };
    *guard = Some((id, driver));
    // Borrow the just-stored driver and attempt the send while STILL HOLDING the lock, so no
    // concurrent start can observe a half-initialized slot — and so the rollback below can pull the
    // driver back out without ever releasing the lock (race-free).
    let stored = guard.as_mut().map(|(_, d)| d).expect("just inserted");
    if let Err(e) = send(stored) {
        // Roll back under the same lock: free the slot and hand the driver to the caller for child
        // teardown, so the slot is left `None` (not phantom-locked).
        let recovered = guard.take().map(|(_, d)| d).expect("just inserted");
        return Err((recovered, e));
    }
    Ok(())
}

/// The live session's child handle plus bookkeeping. One per app launch.
pub struct AgentDriver {
    child: CommandChild,
    /// Fired (Ok) by the read task when it observes `CommandEvent::Terminated`,
    /// so the teardown drain can `block_on(timeout(.., terminated))` and SIGKILL
    /// only as the fallback. `Some` until the drain consumes it (it is `take`n
    /// during `drain_child`). A `None` here means the read task already saw the
    /// child exit and freed the slot — there is nothing left to drain.
    terminated: Option<oneshot::Receiver<()>>,
}

impl AgentDriver {
    /// Write one JSON-line command to the child's stdin. Each command is a
    /// single line terminated by `\n` (the sidecar reads line-by-line).
    fn send_line(&mut self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).map_err(|e| format!("serialize command: {e}"))?;
        line.push(b'\n');
        self.child
            .write(&line)
            .map_err(|e| format!("write to sidecar stdin: {e}"))
    }
}

// ---------------------------------------------------------------------------
// Graceful teardown drain (INV-4).
//
// ROOT CAUSE this fixes: teardown used to call `CommandChild::kill()` = SIGKILL,
// which is uncatchable — so the SDK's `process.on("exit")` reaper inside the
// sidecar never ran, and its `claude` grandchild orphaned (a token-burning CLI
// process surviving app quit). The fix is: send `{"type":"end"}` (NOT a signal —
// this stdin line is the PRIMARY teardown trigger), give the child a bounded
// interval to exit on its own — the sidecar's `end`/SIGTERM/SIGINT/stdin-close
// paths all route through one awaited drain that closes the SDK query, which
// makes the SDK's reaper SIGTERM the `claude` grandchild — and SIGKILL only if
// that interval elapses.
//
// `tauri-plugin-shell::CommandChild` exposes only `write`/`kill(self)`/`pid` —
// no `try_wait`/`wait`, and `kill(self)` CONSUMES the child — so child exit is
// observable ONLY via `CommandEvent::Terminated` on the plugin's `Receiver`,
// which the read task owns. The read task fires a `oneshot` on Terminated; the
// drain awaits it. `DrainTarget` abstracts "send the end line" + "consume-by-kill"
// so the ordering is unit-testable with a fake (the real CommandChild's
// kill-by-value can't be mocked otherwise).
// ---------------------------------------------------------------------------

/// The two teardown operations the drain performs on the session child, factored
/// behind a trait so the ORDER (`send_end` then, only on timeout, `kill`) is
/// testable with a recording fake. `kill` takes `self` to mirror
/// `CommandChild::kill(self)` (which consumes the child).
trait DrainTarget {
    /// Best-effort `{"type":"end"}` to the child's stdin (graceful end).
    fn send_end(&mut self) -> Result<(), String>;
    /// Force-kill (SIGKILL). Consumes the target — the fallback only.
    fn kill(self) -> Result<(), String>;
}

impl DrainTarget for AgentDriver {
    fn send_end(&mut self) -> Result<(), String> {
        self.send_line(&serde_json::json!({ "type": "end" }))
    }
    fn kill(self) -> Result<(), String> {
        self.child
            .kill()
            .map_err(|e| format!("kill sidecar: {e}"))
    }
}

/// Drain one session child gracefully: send `end`, await the read task's
/// `Terminated` signal for up to `timeout`, and SIGKILL ONLY if it does not
/// arrive (timeout) or the channel closed without an exit being observed.
/// Bounded by construction — a wedged child cannot hang shutdown past `timeout`.
///
/// Reused from BOTH teardown paths: the app-quit path (`shutdown_session`)
/// `block_on`s this so quit waits for the drain; the interactive path
/// (`end_agent_session`) `spawn`s it onto a background task so the UI never
/// blocks (see `offload_drain`). The drain is identical either way.
async fn drain_child<C: DrainTarget>(
    mut child: C,
    terminated: oneshot::Receiver<()>,
    timeout: Duration,
) {
    // Always attempt the graceful end FIRST (before any kill). A write failure
    // (child already gone) is non-fatal — we still wait/kill as needed.
    let _ = child.send_end();

    // Wait for the read task's Terminated signal, bounded. `Ok(Ok(()))` = the
    // child exited on its own → done, NO kill. A timeout (`Err(_)`) or a closed
    // channel (`Ok(Err(_))`, sender dropped without firing) → fall back to kill.
    match tokio::time::timeout(timeout, terminated).await {
        Ok(Ok(())) => {} // graceful exit observed — leave the (already-dead) child be.
        _ => {
            let _ = child.kill();
        }
    }
}

/// Offload a bounded `drain_child` onto a background task and return IMMEDIATELY
/// (non-blocking). The INTERACTIVE end path (`end_agent_session`, driven by the
/// UI's Stop/Cancel) uses this so a wedged child can NEVER freeze the UI for
/// `DRAIN_TIMEOUT` — the drain (and its SIGKILL fallback) runs detached on the
/// async runtime while the command returns at once. Distinct from the app-quit
/// path (`shutdown_session`), which deliberately `block_on`s the SAME drain so
/// the process does not exit before the agent tree winds down.
///
/// The caller has already `take`n the driver out of the singleton slot, so the
/// task owns it exclusively — there is no second drain and the slot is already
/// cleared. `C: Send + 'static` because the future is moved onto another thread.
fn offload_drain<C: DrainTarget + Send + 'static>(
    child: C,
    terminated: oneshot::Receiver<()>,
    timeout: Duration,
) {
    tauri::async_runtime::spawn(async move {
        drain_child(child, terminated, timeout).await;
    });
}

// ---------------------------------------------------------------------------
// Pure stream-line parser (unit-tested).
//
// The shell plugin's non-raw reader accumulates across pipe reads until a
// `\n`/`\r` and RETAINS the delimiter byte, so a `\r\n` line yields a trailing
// event whose payload is `"\n"` (NOT `""`). The guard is therefore "skip after
// trim," not "skip empty string."
//   - whitespace-only (incl. a lone "\n"/" ") AFTER trim  -> Ok(None)   (skip)
//   - valid JSON                                           -> Ok(Some(event))
//   - non-JSON                                             -> Err(diagnostic)
// ---------------------------------------------------------------------------

/// A parsed stdout frame routed to one of three Tauri events. The `kind`
/// distinguishes the committed agent-stream kinds from the permission seam.
#[derive(Debug, PartialEq)]
pub enum AgentEvent {
    /// `tool_permission_requested` -> the `tool-permission-requested` event.
    PermissionRequested(Value),
    /// `error` -> the `agent-error` event.
    Error(Value),
    /// Any committed agent-stream kind (system_init, assistant_text, tool_use,
    /// tool_result, mode_change, result, permission_denied) -> `agent-stream`.
    Stream(Value),
}

/// Parse one stdout line. See the module/section docs for the trim-then-skip
/// invariant. `Ok(None)` = whitespace-only (skip); `Err` = non-JSON (surface
/// as a contamination diagnostic, never a silent drop).
pub fn parse_stream_line(line: &str) -> Result<Option<AgentEvent>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("non-JSON line on sidecar stdout: {e}: {trimmed}"))?;

    let kind = value.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    let event = match kind {
        "tool_permission_requested" => AgentEvent::PermissionRequested(value),
        // Sidecar-originated errors arrive as `{kind:"error", error_kind, message,
        // fatal}` — `kind:"error"` is just the sidecar's INTERNAL routing token.
        // The public `agent-error` wire shape (CONTRACT.md) is `{kind, message,
        // fatal}` where `kind` is the discriminator (auth/sdk/spawn/…). Normalize
        // at this seam: lift `error_kind` into `kind` (default "sdk" if absent) and
        // drop the internal `error_kind` field, so Sub-Plan 02's `payload.kind ===
        // "auth"` onboarding check matches. Rust-originated errors (cwd/io/
        // contamination) never take this path — they emit a conforming `kind`
        // directly in the read task.
        "error" => AgentEvent::Error(normalize_error_payload(value)),
        // Everything else is a committed agent-stream kind (or a future one the
        // sidecar already passes through) — re-emit as `agent-stream`.
        _ => AgentEvent::Stream(value),
    };
    Ok(Some(event))
}

/// Rewrite a sidecar `{kind:"error", error_kind, message, fatal}` payload into
/// the public `agent-error` shape `{kind, message, fatal}`: `kind` becomes the
/// `error_kind` value (falling back to "sdk"), and the internal `error_kind`
/// field is dropped. Other fields (`message`, `fatal`, …) carry through verbatim.
fn normalize_error_payload(mut value: Value) -> Value {
    let public_kind = value
        .get("error_kind")
        .and_then(|k| k.as_str())
        .unwrap_or("sdk")
        .to_string();
    if let Value::Object(map) = &mut value {
        map.remove("error_kind");
        map.insert("kind".to_string(), Value::String(public_kind));
    }
    value
}

// ---------------------------------------------------------------------------
// Token persistence — agent-auth.json under app_data_dir, atomic + mode 0600.
// ---------------------------------------------------------------------------

#[derive(Serialize, serde::Deserialize, Default)]
struct AuthFile {
    token: Option<String>,
}

fn auth_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(AUTH_FILE))
}

fn load_token(app: &AppHandle) -> Option<String> {
    let path = auth_path(app)?;
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice::<AuthFile>(&bytes).ok()?.token
}

/// Atomic temp-write + rename, then chmod 0600. Mirrors the lib.rs cwd-cache
/// pattern; degrades (returns Err) on any I/O failure — never panics.
fn store_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let path = auth_path(app).ok_or("app_data_dir unavailable")?;
    let parent = path.parent().ok_or("auth path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("create app_data_dir: {e}"))?;

    let body = serde_json::to_vec(&AuthFile {
        token: Some(token.to_string()),
    })
    .map_err(|e| format!("serialize auth: {e}"))?;

    let tmp = parent.join(format!(".tmp-agent-auth-{}", std::process::id()));
    std::fs::write(&tmp, &body).map_err(|e| format!("write temp auth: {e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename auth into place: {e}")
    })?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Read task — recv -> parse -> emit ONLY. Never blocks on app state or awaits a
// permission resolution (the plugin's event channel is capacity-1, shared by
// stdout/stderr/terminate; blocking it would backpressure and hang the sidecar).
// Permission replies arrive over a SEPARATE path: resolve_tool_permission ->
// child stdin, not through this loop.
// ---------------------------------------------------------------------------

fn spawn_read_task(
    app: AppHandle,
    mut rx: Receiver<CommandEvent>,
    my_id: u64,
    // Fired once when the child terminates so the teardown drain can stop waiting
    // and skip the SIGKILL fallback. `Option` because it is consumed on the single
    // `Terminated` event (a oneshot Sender's `send` takes `self`).
    mut terminated_tx: Option<oneshot::Sender<()>>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    match parse_stream_line(&line) {
                        Ok(None) => {} // whitespace-only artifact (e.g. "\n") — skip.
                        Ok(Some(AgentEvent::PermissionRequested(v))) => {
                            let _ = app.emit("tool-permission-requested", v);
                        }
                        Ok(Some(AgentEvent::Error(v))) => {
                            let _ = app.emit("agent-error", v);
                        }
                        Ok(Some(AgentEvent::Stream(v))) => {
                            // DIAGNOSTIC (minecraft-clone halt investigation): log every agent-stream
                            // frame kind emitted to the frontend. For `result` frames also log the
                            // subtype / is_error / parent_tool_use_id so we can see whether the recon
                            // turn (which used the scope-recon subagent) emits a turn-ending top-level
                            // `result` at all — and what shape it carries. Log-only; no behavior change.
                            let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("?");
                            if kind == "result" {
                                eprintln!(
                                    "[agent:diag] emit agent-stream kind=result subtype={:?} is_error={:?} parent_tool_use_id={:?}",
                                    v.get("subtype"),
                                    v.get("is_error"),
                                    v.get("parent_tool_use_id"),
                                );
                            } else {
                                eprintln!("[agent:diag] emit agent-stream kind={kind}");
                            }
                            let _ = app.emit("agent-stream", v);
                        }
                        Err(diag) => {
                            // Contamination diagnostic — surface, never silently drop.
                            eprintln!("[agent] {diag}");
                            let _ = app.emit(
                                "agent-error",
                                serde_json::json!({
                                    "kind": "contamination",
                                    "message": diag,
                                    "fatal": false,
                                }),
                            );
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    // The sidecar's own diagnostics + the CLI child's stderr.
                    // Forward to logs; never onto an event channel.
                    eprint!("[agent:sidecar] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app.emit("agent-exit", serde_json::json!({ "code": payload.code }));
                    // Signal the teardown drain (INV-4) that the child has exited,
                    // so a concurrent `block_on(timeout(.., terminated_rx))` returns
                    // immediately and skips the SIGKILL fallback. Fire-and-forget:
                    // if the receiver was already dropped (no drain in flight, the
                    // common natural-death case) the send simply returns Err.
                    if let Some(tx) = terminated_tx.take() {
                        let _ = tx.send(());
                    }
                    // Natural death: release the singleton slot so the UI's
                    // "New plan" re-enable matches a backend that no longer
                    // holds a dead driver. Only frees THIS session's slot (id
                    // match) — a successor that already replaced it is left
                    // alone. Synchronous, no `.await` held across the lock.
                    if let Some(state) = app.try_state::<Mutex<Option<(u64, AgentDriver)>>>() {
                        let _ = take_if_current(&state, my_id);
                    }
                    break;
                }
                CommandEvent::Error(e) => {
                    let _ = app.emit(
                        "agent-error",
                        serde_json::json!({ "kind": "io", "message": e, "fatal": true }),
                    );
                }
                _ => {}
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

type DriverState<'a> = State<'a, Mutex<Option<(u64, AgentDriver)>>>;

/// Build the `start` command JSON line sent over the sidecar stdin. PURE — no
/// I/O, no state — so the resume/null wiring is unit-testable. `resume` carries
/// an SDK session id to resume; serde emits `null` for `None` (the sidecar
/// treats null/absent/empty as "no resume").
fn start_command_json(
    cwd: &str,
    permission_mode: &str,
    model: &Option<String>,
    effort: &Option<String>,
    resume: &Option<String>,
) -> Value {
    serde_json::json!({
        "type": "start",
        "cwd": cwd,
        "permissionMode": permission_mode,
        "model": model,
        "effort": effort,
        "resume": resume,
    })
}

/// Spawn the sidecar (if needed) and begin one streaming session rooted at
/// `cwd`, in `permission_mode`. Validates `cwd` is an existing directory (an
/// unvalidated cwd later becomes the `acceptEdits` scope — a security footgun).
/// One session per launch: a second start while a session is live is REJECTED.
#[tauri::command]
pub fn start_agent_session(
    app: AppHandle,
    state: DriverState<'_>,
    cwd: String,
    permission_mode: String,
    // Header-picker selection (Phase 1). Tauri maps JS camelCase `model`/`effort`.
    // None when no picker value is supplied; serde emits `null` and the sidecar
    // treats null/absent as "not set".
    model: Option<String>,
    effort: Option<String>,
    // Resume an in-progress SDK conversation (Phase 4). Tauri maps JS camelCase
    // `resumeSessionId`. None when starting fresh; serde emits `null`, forwarded
    // as `"resume"` in the start JSON. The one-session-per-launch guard is
    // UNCHANGED — resume only adds a flag to the start command.
    resume_session_id: Option<String>,
) -> Result<(), String> {
    // One-session-per-launch: reject if already live.
    {
        let guard = state.lock().map_err(|_| "driver state poisoned")?;
        if guard.is_some() {
            return Err("a session is already running (one session per launch)".into());
        }
    }

    // Validate cwd is an existing directory.
    if !Path::new(&cwd).is_dir() {
        let _ = app.emit(
            "agent-error",
            serde_json::json!({
                "kind": "cwd",
                "message": format!("cwd is not an existing directory: {cwd}"),
                "fatal": true,
            }),
        );
        return Err(format!("cwd is not an existing directory: {cwd}"));
    }

    // No stored token -> onboarding signal (02 shows `claude setup-token`).
    let token = match load_token(&app) {
        Some(t) => t,
        None => {
            let _ = app.emit("agent-auth-required", serde_json::json!({}));
            return Err("no OAuth token stored".into());
        }
    };

    // Spawn the sidecar, injecting CLAUDE_CODE_OAUTH_TOKEN into the child env
    // (the spawned CLI inherits it). We never set ANTHROPIC_API_KEY.
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("resolve sidecar: {e}"))?
        .env("CLAUDE_CODE_OAUTH_TOKEN", token);

    let (rx, child) = command.spawn().map_err(|e| format!("spawn sidecar: {e}"))?;

    // Stamp this session with a fresh id (the read task carries the SAME id so it
    // only releases the slot it owns). One fetch_add — never call it twice.
    let id = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);

    // Teardown-drain seam (INV-4): the read task fires `terminated_tx` when it
    // sees `CommandEvent::Terminated`; the driver keeps `terminated_rx` so the
    // graceful-drain in end_agent_session/shutdown_session can await the child's exit before any
    // SIGKILL fallback.
    let (terminated_tx, terminated_rx) = oneshot::channel::<()>();

    // Store the child, then send the `start` command — committing the driver to the slot ONLY if
    // the send succeeds. If the send fails, `store_then_send` pulls the driver back out (leaving the
    // slot `None`, so the one-session-per-launch guard is NOT phantom-locked) and hands it back so we
    // can kill the orphaned child here before propagating the error.
    let driver = AgentDriver {
        child,
        terminated: Some(terminated_rx),
    };
    let start_line =
        start_command_json(&cwd, &permission_mode, &model, &effort, &resume_session_id);
    if let Err((dead, e)) =
        store_then_send(&state, id, driver, |d| d.send_line(&start_line))
    {
        // Best-effort kill of the just-spawned child so it is not leaked. `terminated_tx` is dropped
        // here (the read task is never spawned), which is correct — there is no read task to wire it
        // to. `kill` consumes the driver (mirrors CommandChild::kill(self)).
        let _ = dead.kill();
        return Err(e);
    }

    // Start the read task AFTER the child is committed (it owns its own rx). Reached only on a
    // successful send, so the success path is identical to before: driver in the slot, read task
    // spawned with the matching id and the terminated sender.
    spawn_read_task(app, rx, id, Some(terminated_tx));
    Ok(())
}

/// One inline image attached to a user turn. Wire shape is **bare snake_case**
/// (`media_type` / `data`) — it matches the frontend `{media_type, data}` payload AND the
/// `ReviewRequest` precedent (lib.rs:177-198, also bare snake_case, no `serde(rename_all)`).
/// A `mediaType` drift would silently break deserialization, so the field name is pinned by the
/// `image_input_wire_rejects_camel_case` test below. `data` is base64 with NO `data:…;base64,`
/// prefix (the frontend strips it).
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
}

/// PURE, testable builder for the `user` stdin line sent to the sidecar.
///
/// - `images == None` → `{ "type":"user", "text":text }` with the `images` key **OMITTED**
///   (not null, not `[]`), so the text-only wire shape stays byte-identical to today.
/// - `images == Some(imgs)` → the same object plus `"images": [ {media_type,data}, … ]`.
pub fn build_user_line(text: &str, images: Option<&[ImageInput]>) -> serde_json::Value {
    let mut line = serde_json::json!({ "type": "user", "text": text });
    if let Some(imgs) = images {
        if let Value::Object(map) = &mut line {
            map.insert(
                "images".to_string(),
                serde_json::to_value(imgs).unwrap_or(Value::Null),
            );
        }
    }
    line
}

/// Push a user turn into the streaming-input queue.
///
/// `images` is OPTIONAL and additive: the frontend invokes
/// `invoke("send_agent_message", { text, images })` where `images` is `[{media_type, data}, …]`
/// or omitted. When omitted, the wire line carries no `images` key (see `build_user_line`).
#[tauri::command]
pub fn send_agent_message(
    state: DriverState<'_>,
    text: String,
    images: Option<Vec<ImageInput>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    // DIAGNOSTIC (minecraft-clone halt investigation): log every send_agent_message so a real run
    // reveals whether the sizer prompt (turn #2) is ever sent — i.e. whether RECON_DONE advanced the
    // orchestrator. The recon prompt is send #1; if no send #2 appears the run halted at recon.
    let preview: String = text.chars().take(60).collect();
    eprintln!(
        "[agent:diag] send_agent_message ({} chars, {} images) first60={preview:?}",
        text.len(),
        images.as_ref().map(|v| v.len()).unwrap_or(0)
    );
    driver.send_line(&build_user_line(&text, images.as_deref()))
}

/// Answer a pending `tool-permission-requested` (the canUseTool seam).
///
/// `updated_input` is optional and used by the interactive tools that return data on allow —
/// notably `AskUserQuestion`, where the host resolves with `{ questions, answers }`. When `None`
/// the field is OMITTED from the JSON line (the sidecar then echoes the stored tool input, the
/// existing ExitPlanMode behavior). Backward-compatible: callers that pass only `id`/`allow`/
/// `message` are unchanged.
#[tauri::command]
pub fn resolve_tool_permission(
    state: DriverState<'_>,
    id: String,
    allow: bool,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    let mut line = serde_json::json!({
        "type": "resolve-tool-permission",
        "id": id,
        "allow": allow,
        "message": message,
    });
    // Only attach updatedInput when provided — keep the wire shape backward-compatible (None → omit).
    if let Some(updated) = updated_input {
        if let Value::Object(map) = &mut line {
            map.insert("updatedInput".to_string(), updated);
        }
    }
    driver.send_line(&line)
}

/// Mid-session `q.setPermissionMode(mode)`.
#[tauri::command]
pub fn set_agent_permission_mode(state: DriverState<'_>, mode: String) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    driver.send_line(&serde_json::json!({ "type": "set-permission-mode", "mode": mode }))
}

/// Graceful `q.interrupt()` of the current turn.
#[tauri::command]
pub fn cancel_agent_run(state: DriverState<'_>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    driver.send_line(&serde_json::json!({ "type": "interrupt" }))
}

/// End the session for this launch, draining the agent tree gracefully (INV-4):
/// send `{"type":"end"}`, wait a bounded interval for the child to exit on its
/// own (the sidecar's `end`-command handler closes the SDK query, whose reaper
/// SIGTERMs the `claude` grandchild — never orphaning it), and SIGKILL only as
/// the timeout fallback.
///
/// This is the INTERACTIVE path (the UI's Stop/Cancel/end-session). It clears the
/// singleton slot synchronously, then OFFLOADS the bounded drain to a background
/// task and returns AT ONCE — so a wedged child can never freeze the UI for
/// `DRAIN_TIMEOUT`. (App-quit takes the opposite trade-off: `shutdown_session`
/// `block_on`s the same drain so the process does not exit before the agent tree
/// winds down.)
#[tauri::command]
pub fn end_agent_session(state: DriverState<'_>) -> Result<(), String> {
    // Take the driver out under the lock so the slot is cleared immediately and
    // the spawned drain owns the child exclusively (no second drain, no lock held
    // across the wait).
    let taken = {
        let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
        guard.take()
    };
    if let Some((_, mut driver)) = taken {
        // If the read task already saw Terminated it freed the receiver — the
        // child is gone; a closed channel makes the drain fall straight through
        // (send_end no-ops, kill is harmless).
        let terminated = driver.terminated.take().unwrap_or_else(|| {
            let (_tx, rx) = oneshot::channel::<()>(); // tx dropped → rx resolves Err.
            rx
        });
        // Non-blocking: the bounded drain (+ SIGKILL fallback) runs detached on
        // the async runtime; this command returns without waiting for it, so the
        // UI never stalls up to DRAIN_TIMEOUT on a wedged child.
        offload_drain(driver, terminated, DRAIN_TIMEOUT);
    }
    Ok(())
}

/// Report whether an OAuth token is stored (drives onboarding in 02).
#[tauri::command]
pub fn agent_auth_status(app: AppHandle) -> Result<Value, String> {
    Ok(serde_json::json!({ "hasToken": load_token(&app).is_some() }))
}

/// Persist the CLAUDE_CODE_OAUTH_TOKEN (injected into the sidecar env on next start).
#[tauri::command]
pub fn set_agent_oauth_token(app: AppHandle, token: String) -> Result<(), String> {
    store_token(&app, &token)
}

// ---------------------------------------------------------------------------
// Teardown — called from lib.rs on RunEvent::Exit/ExitRequested.
//
// GUARANTEED BEHAVIOR (INV-4): quitting the app sends the sidecar a graceful
// `{"type":"end"}` and waits a BOUNDED `DRAIN_TIMEOUT` for it (and its `claude`
// grandchild) to exit before SIGKILLing only as a fallback. The sidecar's
// `end`-command handler routes through one awaited drain that closes the SDK
// query, whose reaper SIGTERMs the grandchild — so a normal quit leaves NO
// orphaned `claude` or sidecar process. Only a sidecar that ignores `end` AND
// outlives the bounded wait is force-killed — and even then the SIGKILL is the
// last resort, not the default. (The previous code SIGKILLed immediately, which
// is uncatchable and orphaned the grandchild because the SDK's
// `process.on("exit")` reaper never ran.) The wait is bounded so a wedged child
// can never hang shutdown.
//
// Unlike the INTERACTIVE end path (`end_agent_session`, which OFFLOADS the drain
// to a background task so the UI never blocks), app-quit deliberately `block_on`s
// the bounded drain: the process must NOT exit before the agent tree has had its
// bounded chance to wind down, otherwise a spawned/detached drain would be torn
// down with the process and orphan the grandchild anyway.
// ---------------------------------------------------------------------------

pub fn shutdown_session(app: &AppHandle) {
    let taken = app
        .try_state::<Mutex<Option<(u64, AgentDriver)>>>()
        .and_then(|state| state.lock().ok().and_then(|mut guard| guard.take()));
    if let Some((_, mut driver)) = taken {
        let terminated = driver.terminated.take().unwrap_or_else(|| {
            let (_tx, rx) = oneshot::channel::<()>(); // already-gone child → resolves Err → kill fallback.
            rx
        });
        // This MUST stay a SYNC RunEvent callback (Tauri invokes it on the main
        // thread): `block_on` panics if moved onto a tokio worker thread. Outside
        // the async runtime here, so block_on is safe.
        tauri::async_runtime::block_on(drain_child(driver, terminated, DRAIN_TIMEOUT));
    }
}

// ---------------------------------------------------------------------------
// Unit tests (Verification 9) — falsifiable parse_stream_line tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_if_current_releases_only_on_matching_id() {
        // (a) matching id -> Some, slot drained to None.
        let slot: Mutex<Option<(u64, ())>> = Mutex::new(Some((5, ())));
        assert_eq!(take_if_current(&slot, 5), Some(()));
        assert!(slot.lock().unwrap().is_none(), "slot must be cleared on match");

        // (b) non-matching id -> None, slot untouched.
        let slot: Mutex<Option<(u64, ())>> = Mutex::new(Some((5, ())));
        assert_eq!(take_if_current(&slot, 4), None);
        assert_eq!(
            *slot.lock().unwrap(),
            Some((5, ())),
            "slot must be preserved on id mismatch"
        );

        // (c) empty slot -> None.
        let slot: Mutex<Option<(u64, ())>> = Mutex::new(None);
        assert_eq!(take_if_current(&slot, 5), None);
    }

    // -----------------------------------------------------------------------
    // FIX 2: a FAILED start-command write must NOT phantom-lock the session slot.
    //
    // `start_agent_session` used to store the driver into the singleton slot and
    // only THEN send the `start` line; a send failure returned early (`?`) with the
    // slot still `Some(dead-driver)`. With no read task spawned, the natural-death
    // `Terminated` handler that frees the slot never fired, so EVERY subsequent
    // start was rejected with "already running" until an app restart.
    //
    // The fix factors store→send→on-error-rollback into `store_then_send`, which
    // commits the driver to the slot ONLY on send success and on failure pulls it
    // back out (slot → None) and returns it for child teardown. We test that
    // invariant directly with a fake driver + injectable failing send (the real
    // `AgentDriver::send_line` needs a `CommandChild` that cannot be built in a
    // test).
    // -----------------------------------------------------------------------

    /// On send SUCCESS the driver stays committed in the slot (so the read task can
    /// be wired to it) and `Ok(())` is returned. Falsifiability complement to the
    /// failure test below: proves `store_then_send` does not spuriously evict a
    /// healthy driver.
    #[test]
    fn store_then_send_keeps_driver_on_success() {
        let slot: Mutex<Option<(u64, u32)>> = Mutex::new(None);
        // The "driver" is a plain u32 sentinel; the send closure succeeds.
        let res = store_then_send(&slot, 7, 99u32, |_d| Ok(()));
        assert!(res.is_ok(), "successful send must return Ok, got {res:?}");
        assert_eq!(
            *slot.lock().unwrap(),
            Some((7, 99)),
            "a successfully-started driver must remain committed in the slot"
        );
    }

    /// On send FAILURE the slot must be left `None` (NOT phantom-locked), and the
    /// driver must be handed back to the caller for teardown along with the error
    /// message. This is the core regression test for FIX 2.
    ///
    /// Falsifiable: revert `store_then_send` to the buggy shape (store the driver,
    /// run the send, and on failure leave the slot occupied — i.e. drop the
    /// `guard.take()` rollback) and the `is_none()` assertion below goes RED — a
    /// subsequent start would then be rejected as "already running". (Confirmed by
    /// temporarily removing the rollback: the slot stays `Some((9, …))`.)
    #[test]
    fn store_then_send_frees_slot_on_failure() {
        let slot: Mutex<Option<(u64, u32)>> = Mutex::new(None);
        // The send closure fails — mirroring a `send_line` write error.
        let res = store_then_send(&slot, 9, 42u32, |_d| Err("write to sidecar stdin: boom".into()));

        // (1) The error carries BOTH the recovered driver (for teardown) and the message.
        match res {
            Err((recovered, msg)) => {
                assert_eq!(recovered, 42, "the driver must be returned for child teardown");
                assert_eq!(msg, "write to sidecar stdin: boom");
            }
            Ok(()) => panic!("a failed send must return Err, not Ok"),
        }

        // (2) THE INVARIANT: the slot is empty, so the one-session-per-launch guard
        // (`if guard.is_some() { reject }`) will NOT reject the next start.
        assert!(
            slot.lock().unwrap().is_none(),
            "a failed start must leave the session slot empty, not phantom-locked"
        );

        // (3) Concretely simulate the very next start's guard check: it must pass.
        {
            let guard = slot.lock().unwrap();
            assert!(
                guard.is_none(),
                "the subsequent start's `guard.is_some()` reject must NOT fire"
            );
        }
    }

    #[test]
    fn start_command_json_carries_resume_when_some_and_null_when_none() {
        // Phase 4: the start line must carry the SDK resume id when the host
        // supplies one, and serde-`null` when it does not (the sidecar treats
        // null/absent/empty as "no resume"). Falsifiability: drop the `resume`
        // field from start_command_json and BOTH assertions below go RED.
        let with_resume = start_command_json(
            "/x",
            "plan",
            &None,
            &None,
            &Some("sess-1".to_string()),
        );
        assert_eq!(
            with_resume["resume"],
            Value::String("sess-1".to_string()),
            "resume id must be forwarded as the `resume` field"
        );
        assert_eq!(with_resume["type"], "start");
        assert_eq!(with_resume["cwd"], "/x");
        assert_eq!(with_resume["permissionMode"], "plan");

        let without_resume = start_command_json("/x", "plan", &None, &None, &None);
        assert_eq!(
            without_resume["resume"],
            Value::Null,
            "None must serialize to JSON null, not be omitted"
        );
    }

    #[test]
    fn valid_json_maps_to_the_right_event() {
        // A committed agent-stream kind -> Stream.
        let line = r#"{"seq":0,"kind":"assistant_text","text":"hi"}"#;
        match parse_stream_line(line) {
            Ok(Some(AgentEvent::Stream(v))) => {
                assert_eq!(v["kind"], "assistant_text");
                assert_eq!(v["text"], "hi");
            }
            other => panic!("expected Stream event, got {other:?}"),
        }

        // The permission seam -> PermissionRequested (a DIFFERENT variant), so
        // this test goes RED if routing collapses everything into Stream.
        let perm = r#"{"seq":1,"kind":"tool_permission_requested","id":"t1","tool":"Edit"}"#;
        match parse_stream_line(perm) {
            Ok(Some(AgentEvent::PermissionRequested(v))) => {
                assert_eq!(v["id"], "t1");
            }
            other => panic!("expected PermissionRequested event, got {other:?}"),
        }

        // An error frame -> Error variant, normalized to the public wire shape.
        let err = r#"{"kind":"error","error_kind":"auth","fatal":true}"#;
        match parse_stream_line(err) {
            Ok(Some(AgentEvent::Error(v))) => assert_eq!(v["kind"], "auth"),
            other => panic!("expected Error event, got {other:?}"),
        }
    }

    #[test]
    fn sidecar_error_kind_is_normalized_onto_public_kind() {
        // The sidecar emits `{kind:"error", error_kind:"auth", …}` — `kind:"error"`
        // is its INTERNAL routing token. The emitted `agent-error` payload MUST
        // conform to the contract's `{kind, message, fatal}` with `kind` = the
        // discriminator, or Sub-Plan 02's `payload.kind === "auth"` onboarding
        // never matches. Falsifiability: drop the normalize rewrite (re-emit the
        // payload verbatim) and `kind` stays "error" / "auth" leaks only on
        // `error_kind` -> this assertion goes RED.
        let line = r#"{"kind":"error","error_kind":"auth","message":"token expired","fatal":true}"#;
        match parse_stream_line(line) {
            Ok(Some(AgentEvent::Error(v))) => {
                assert_eq!(v["kind"], "auth", "public kind must be the discriminator");
                assert!(
                    v.get("error_kind").is_none(),
                    "internal error_kind must be dropped from the public payload"
                );
                assert_eq!(v["message"], "token expired");
                assert_eq!(v["fatal"], true);
            }
            other => panic!("expected normalized Error event, got {other:?}"),
        }

        // A sidecar error with NO error_kind falls back to "sdk" (never "error").
        let bare = r#"{"kind":"error","message":"boom","fatal":true}"#;
        match parse_stream_line(bare) {
            Ok(Some(AgentEvent::Error(v))) => assert_eq!(v["kind"], "sdk"),
            other => panic!("expected Error event, got {other:?}"),
        }
    }

    #[test]
    fn rust_originated_error_kinds_are_never_normalized() {
        // Rust-originated errors (cwd/io/contamination) are emitted with a
        // conforming public `kind` directly in the read task — they never carry
        // the sidecar's `kind:"error"` routing token, so they must NOT enter the
        // normalize path (which would downgrade them to "sdk"). Proof: a payload
        // already keyed `cwd`/`io`/`contamination` does not match the "error"
        // arm of parse_stream_line — it routes to Stream untouched, keeping its
        // kind verbatim. Falsifiability: route the "error" arm on ALL kinds and
        // this goes RED (the kind would flip to "sdk").
        for k in ["cwd", "io", "contamination"] {
            let line = format!(r#"{{"kind":"{k}","message":"x","fatal":false}}"#);
            match parse_stream_line(&line) {
                Ok(Some(AgentEvent::Stream(v))) => {
                    assert_eq!(v["kind"], k, "Rust error kind must survive verbatim");
                }
                other => panic!("expected Stream (untouched) for kind={k}, got {other:?}"),
            }
        }
    }

    #[test]
    fn newline_only_payload_is_none() {
        // The REAL `\r\n`-trailing artifact the reader emits is "\n" (NOT ""),
        // so we assert on "\n". If the skip guard were "skip empty string"
        // instead of "skip after trim," this would try to parse "\n" as JSON
        // and return Err -> the test goes RED. (Falsifiability: inverting the
        // trim/skip logic flips this from Ok(None) to Err.)
        assert_eq!(parse_stream_line("\n"), Ok(None));
    }

    #[test]
    fn whitespace_only_payload_is_none() {
        // A lone space is whitespace-only AFTER trim -> skip. Same falsifiable
        // property as the "\n" case.
        assert_eq!(parse_stream_line(" "), Ok(None));
    }

    #[test]
    fn non_json_line_surfaces_an_error() {
        // A non-JSON line must surface an error (a contamination diagnostic),
        // NOT a silent drop. If parse returned Ok(None) for this, the test
        // goes RED.
        match parse_stream_line("this is not json") {
            Err(_) => {}
            other => panic!("expected Err for non-JSON, got {other:?}"),
        }
    }

    #[test]
    fn payload_with_escaped_crlf_parses_as_one_event() {
        // A JSON line whose PAYLOAD contains an escaped `\r`/`\n` (e.g. captured
        // Bash output) must parse as ONE event — proving payload CR/LF do not
        // split frames (they stay escaped through JSON.stringify on the wire).
        let line = r#"{"kind":"tool_result","content":"line1\r\nline2\n"}"#;
        match parse_stream_line(line) {
            Ok(Some(AgentEvent::Stream(v))) => {
                assert_eq!(v["kind"], "tool_result");
                // The decoded content holds the real CR/LF — one whole event.
                assert_eq!(v["content"], "line1\r\nline2\n");
            }
            other => panic!("expected a single Stream event, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // INV-4: graceful agent-tree teardown drain ordering.
    //
    // The teardown drain (`drain_child`) MUST send `{"type":"end"}` BEFORE any
    // SIGKILL, and MUST only SIGKILL as the timeout fallback when the child has
    // not exited on its own. We test the pure ordering with a fake child that
    // records its calls — no real CommandChild (whose `kill(self)` consumes it
    // and whose exit is only observable over the plugin channel).
    // -----------------------------------------------------------------------

    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    #[derive(Debug, PartialEq, Clone)]
    enum DrainCall {
        SendEnd,
        Kill,
    }

    /// A fake child that records the drain's calls so a test can assert their
    /// ORDER (and that `kill` fires only on the timeout path).
    #[derive(Default)]
    struct FakeChild {
        calls: Arc<StdMutex<Vec<DrainCall>>>,
    }

    impl DrainTarget for FakeChild {
        fn send_end(&mut self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::SendEnd);
            Ok(())
        }
        fn kill(self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::Kill);
            Ok(())
        }
    }

    #[test]
    fn drain_kills_only_when_child_does_not_exit_in_time() {
        // The child NEVER signals Terminated (rx dropped) → the bounded wait
        // times out → drain falls back to kill, but ONLY after send_end. Order
        // must be exactly [SendEnd, Kill].
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let child = FakeChild { calls: calls.clone() };
        // A receiver whose sender is dropped resolves to Err immediately — but
        // we want to exercise the TIMEOUT branch, so use a never-resolving one:
        // keep the sender alive past the call so the rx only completes on timeout.
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async move {
            drain_child(child, rx, Duration::from_millis(50)).await;
        });
        drop(tx); // keep `tx` alive across the drain so rx never fired early.

        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd, DrainCall::Kill],
            "on timeout the end line MUST precede the kill, and kill is the fallback"
        );
    }

    #[test]
    fn drain_skips_kill_when_child_exits_before_timeout() {
        // The child signals Terminated (sender fired) BEFORE the timeout → the
        // graceful path completes and `kill` is NEVER called. Order is exactly
        // [SendEnd] — proving SIGKILL is the fallback, not the default.
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let child = FakeChild { calls: calls.clone() };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async move {
            // Fire the terminated signal first, then drain — the await resolves
            // immediately, well within the (generous) timeout.
            let _ = tx.send(());
            drain_child(child, rx, Duration::from_secs(2)).await;
        });

        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd],
            "a child that exits on its own MUST NOT be SIGKILLed"
        );
    }

    #[test]
    fn drain_sends_end_before_awaiting_then_kills_on_drop() {
        // Falsifiability complement: a receiver whose sender is already dropped
        // resolves to Err immediately (closed channel). The drain must still
        // have sent `end` first, and treats a closed/errored wait the same as a
        // timeout — falling back to kill. So the order is still [SendEnd, Kill].
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let child = FakeChild { calls: calls.clone() };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        drop(tx); // sender gone → rx.await == Err(RecvError) without ever signalling exit.

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async move {
            drain_child(child, rx, Duration::from_secs(2)).await;
        });

        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd, DrainCall::Kill],
            "a closed terminated-channel (no exit observed) must still kill, after end"
        );
    }

    // -----------------------------------------------------------------------
    // F2: the INTERACTIVE end path must NOT block the caller.
    //
    // `end_agent_session` (UI Stop/Cancel) OFFLOADS the bounded drain to a
    // background task via `offload_drain`, so a wedged child can never freeze
    // the UI for DRAIN_TIMEOUT. We exercise `offload_drain` directly (the same
    // primitive the command calls) with a child that NEVER signals Terminated,
    // forcing the drain down the full timeout→kill path, and prove:
    //   (1) `offload_drain` RETURNS before the drain completes (non-blocking),
    //   (2) the drain still eventually runs to completion with ordering
    //       [SendEnd, Kill] (the INV-4 invariant is preserved off-thread).
    // Falsifiability: revert `offload_drain` to a `block_on` and assertion (1)
    // goes RED — the call would not return until after the kill fired.
    // -----------------------------------------------------------------------

    /// A fake child that records calls AND fires a one-shot completion signal on
    /// `kill` (the terminal call of the timeout path), so a test can observe when
    /// the offloaded drain has run to completion on the background task.
    struct NotifyingFakeChild {
        calls: Arc<StdMutex<Vec<DrainCall>>>,
        // `Option` so the `Sender` can be moved out in `kill(self)`.
        done: Option<std::sync::mpsc::Sender<()>>,
    }

    impl DrainTarget for NotifyingFakeChild {
        fn send_end(&mut self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::SendEnd);
            Ok(())
        }
        fn kill(mut self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::Kill);
            if let Some(tx) = self.done.take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    #[test]
    fn offload_drain_returns_before_the_drain_completes() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let child = NotifyingFakeChild {
            calls: calls.clone(),
            done: Some(done_tx),
        };
        // Keep `tx` alive so the terminated receiver NEVER fires — the drain is
        // forced down the timeout→kill branch. A small but non-trivial timeout so
        // there is a real window in which a blocking call would still be waiting.
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let drain_timeout = Duration::from_millis(300);

        // Call the offload primitive on the tauri async runtime (lazily spun up by
        // `tauri::async_runtime::spawn`). It MUST return at once — well before the
        // drain's timeout elapses and the kill fires.
        let before = std::time::Instant::now();
        offload_drain(child, rx, drain_timeout);
        let elapsed = before.elapsed();

        // (1) Non-blocking: the call returned far faster than the drain timeout.
        // A blocking `block_on` would not return until ~drain_timeout (after the
        // kill), so this generous bound (half the timeout) cleanly separates the
        // two behaviors.
        assert!(
            elapsed < drain_timeout / 2,
            "offload_drain must return immediately (non-blocking); took {elapsed:?}"
        );

        // (1b) Corroboration: at the instant of return the drain has NOT yet
        // killed (the timeout has not elapsed), so no completion signal is present.
        assert!(
            done_rx.try_recv().is_err(),
            "the offloaded drain must still be in-flight right after the call returns"
        );

        // (2) The offloaded drain still runs to completion on the background task,
        // and the INV-4 ordering holds: SendEnd then (on timeout) Kill. Bound the
        // wait generously so a slow CI runtime does not flake.
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("offloaded drain must complete (kill fires on timeout)");
        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd, DrainCall::Kill],
            "offloaded drain must preserve the [SendEnd, Kill] ordering invariant"
        );

        drop(tx); // keep `tx` alive across the drain so the terminated rx never fired.
    }

    // -----------------------------------------------------------------------
    // Part D (Verification #8): the multimodal `user` wire line.
    //
    // `build_user_line` is the PURE builder for the `{type:"user", …}` stdin
    // line. Two load-bearing invariants:
    //   - text-only (images == None) → the `images` key is OMITTED (not null,
    //     not []), so the wire shape stays byte-identical to the pre-image flow;
    //   - images present → an ORDERED `images` array, each element `{media_type,
    //     data}`, preserved in attach order (the multi-image numbering the
    //     sidecar relies on for `[Image #1] … [Image #N]` derives from this order).
    // Plus a serde field-name guard pinning the snake_case wire contract.
    // -----------------------------------------------------------------------

    #[test]
    fn build_user_line_omits_images_key_when_none() {
        // INVARIANT: with no images the line is exactly the text-only shape and
        // carries NO `images` key. Falsifiability: make build_user_line always
        // insert an `images` entry (even for None) and `images.is_none()` flips
        // → this assertion goes RED.
        let v = build_user_line("hello", None);
        assert_eq!(v["type"], "user", "wire kind must be `user`");
        assert_eq!(v["text"], "hello", "text must be forwarded verbatim");
        assert!(
            v.get("images").is_none(),
            "text-only sends MUST omit the `images` key entirely (not null, not [])"
        );
    }

    #[test]
    fn build_user_line_carries_single_image() {
        // INVARIANT: one attached image → an `images` array of length 1 whose
        // element mirrors the input {media_type, data}. Falsifiability: drop the
        // images-insert branch and `images` is absent → the length assert goes RED.
        let imgs = vec![ImageInput {
            media_type: "image/png".to_string(),
            data: "AAAA".to_string(),
        }];
        let v = build_user_line("see this", Some(&imgs));
        assert_eq!(v["type"], "user");
        assert_eq!(v["text"], "see this");
        let arr = v["images"]
            .as_array()
            .expect("images must be a JSON array when present");
        assert_eq!(arr.len(), 1, "one attached image → one array element");
        assert_eq!(arr[0]["media_type"], "image/png");
        assert_eq!(arr[0]["data"], "AAAA");
    }

    #[test]
    fn build_user_line_preserves_three_images_in_order() {
        // MULTI-IMAGE INVARIANT: three attached images → an `images` array of
        // length 3 in ATTACH ORDER, each {media_type, data} intact. The sidecar's
        // `[Image #1] [Image #2] [Image #3]` numbering is positional, so order is
        // load-bearing. Falsifiability: reverse or reorder the emitted array and
        // the per-index media_type/data asserts go RED.
        let imgs = vec![
            ImageInput {
                media_type: "image/png".to_string(),
                data: "PNGDATA".to_string(),
            },
            ImageInput {
                media_type: "image/jpeg".to_string(),
                data: "JPEGDATA".to_string(),
            },
            ImageInput {
                media_type: "image/webp".to_string(),
                data: "WEBPDATA".to_string(),
            },
        ];
        let v = build_user_line("three pics", Some(&imgs));
        let arr = v["images"].as_array().expect("images array");
        assert_eq!(arr.len(), 3, "three attached images → three array elements");

        assert_eq!(arr[0]["media_type"], "image/png");
        assert_eq!(arr[0]["data"], "PNGDATA");
        assert_eq!(arr[1]["media_type"], "image/jpeg");
        assert_eq!(arr[1]["data"], "JPEGDATA");
        assert_eq!(arr[2]["media_type"], "image/webp");
        assert_eq!(arr[2]["data"], "WEBPDATA");
    }

    #[test]
    fn image_input_wire_rejects_camel_case() {
        // WIRE CONTRACT GUARD (DA #4): ImageInput deserializes the BARE snake_case
        // shape the frontend sends (`{media_type, data}`) and MUST reject a
        // camelCase `mediaType` drift — otherwise a silent rename would break
        // deserialization without a compile error. Falsifiability: add
        // `#[serde(rename_all = "camelCase")]` to ImageInput and the snake_case
        // `is_ok()` flips to Err (and camelCase to Ok) → both asserts go RED.
        let ok = serde_json::from_str::<ImageInput>(r#"{"media_type":"image/png","data":"AAAA"}"#);
        let parsed = ok.expect("snake_case wire shape MUST deserialize");
        assert_eq!(parsed.media_type, "image/png");
        assert_eq!(parsed.data, "AAAA");

        let err = serde_json::from_str::<ImageInput>(r#"{"mediaType":"image/png","data":"AAAA"}"#);
        assert!(
            err.is_err(),
            "camelCase `mediaType` MUST be rejected to protect the snake_case wire contract"
        );
    }
}
