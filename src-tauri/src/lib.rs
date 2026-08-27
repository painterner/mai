//! Mai's Tauri desktop host. It keeps the local agent daemon and HTTP API
//! sidecars alive, owns the tray/autostart lifecycle, and relays daemon JSON
//! events to the React webview. Agent logic remains in `mai-cli-node`.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, Mutex};

struct DaemonHandle {
    child: CommandChild,
}

struct AppState {
    daemon: Mutex<Option<DaemonHandle>>,
    api: Mutex<Option<CommandChild>>,
    handoff_waiter: Mutex<Option<oneshot::Sender<Result<(), String>>>>,
    ready_info: Mutex<Option<Value>>,
    api_status: Mutex<Value>,
    workspace: Mutex<Option<PathBuf>>,
    exiting: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            daemon: Mutex::new(None),
            api: Mutex::new(None),
            handoff_waiter: Mutex::new(None),
            ready_info: Mutex::new(None),
            api_status: Mutex::new(json!({ "state": "starting" })),
            workspace: Mutex::new(None),
            exiting: AtomicBool::new(false),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            send_message,
            approve,
            clear_conversation,
            interrupt_turn,
            switch_to_cli,
            get_ready_info,
            list_providers,
            list_models,
            set_model,
            autostart_status,
            set_autostart,
            get_api_status,
        ])
        .setup(|app| {
            setup_tray(app)?;
            let workspace = resolve_workspace(app.handle()).map_err(std::io::Error::other)?;
            *tauri::async_runtime::block_on(app.state::<AppState>().workspace.lock()) =
                Some(workspace.clone());

            if std::env::args().any(|arg| arg == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            let daemon_app = app.handle().clone();
            let daemon_workspace = workspace.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(message) = run_daemon(daemon_app.clone(), daemon_workspace).await {
                    if !is_exiting(&daemon_app) {
                        let _ = daemon_app.emit("daemon-fatal", message);
                    }
                }
            });

            let api_app = app.handle().clone();
            tauri::async_runtime::spawn(run_api_supervisor(api_app, workspace));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state: State<AppState> = window.state();
                if !state.exiting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// --- tray and process lifecycle -----------------------------------------

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Mai", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Mai", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("mai-tray")
        .tooltip("Mai")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => request_exit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_exit(app: AppHandle) {
    let state: State<AppState> = app.state();
    if state.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        shutdown_children(&app).await;
        app.exit(0);
    });
}

async fn shutdown_children(app: &AppHandle) {
    let state: State<AppState> = app.state();
    let daemon = state.daemon.lock().await.take();
    if let Some(handle) = daemon {
        let _ = handle.child.kill();
    }
    let api = state.api.lock().await.take();
    if let Some(child) = api {
        let _ = child.kill();
    }
}

fn is_exiting(app: &AppHandle) -> bool {
    app.state::<AppState>().exiting.load(Ordering::SeqCst)
}

// --- daemon lifecycle ----------------------------------------------------

async fn run_daemon(app: AppHandle, workspace: PathBuf) -> Result<(), String> {
    let command = configure_agent_command(daemon_command(&app)?, &workspace);
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("Failed to start agent daemon: {error}"))?;

    {
        let state: State<AppState> = app.state();
        *state.daemon.lock().await = Some(DaemonHandle { child });
    }

    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                handle_daemon_line(&app, &String::from_utf8_lossy(&bytes)).await
            }
            CommandEvent::Stderr(bytes) => {
                let _ = app.emit("daemon-stderr", String::from_utf8_lossy(&bytes).to_string());
            }
            CommandEvent::Error(message) => {
                clear_daemon(&app).await;
                return Err(format!("Agent daemon process error: {message}"));
            }
            CommandEvent::Terminated(payload) => {
                clear_daemon(&app).await;
                if is_exiting(&app) {
                    return Ok(());
                }
                return Err(format!(
                    "Agent daemon exited unexpectedly (code {:?})",
                    payload.code
                ));
            }
            _ => {}
        }
    }

    clear_daemon(&app).await;
    if is_exiting(&app) {
        Ok(())
    } else {
        Err("Agent daemon exited unexpectedly".to_string())
    }
}

async fn handle_daemon_line(app: &AppHandle, line: &str) {
    let line = line.trim();
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };

    if let Some(event_type) = value.get("type").and_then(Value::as_str) {
        if event_type == "ready" {
            let state: State<AppState> = app.state();
            *state.ready_info.lock().await = Some(value.clone());
        }

        if event_type == "handoffWritten" || event_type == "handoffFailed" {
            let state: State<AppState> = app.state();
            let sender = state.handoff_waiter.lock().await.take();
            if let Some(sender) = sender {
                let result = if event_type == "handoffWritten" {
                    Ok(())
                } else {
                    Err(value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Handoff failed")
                        .to_string())
                };
                let _ = sender.send(result);
            }
        }
    }

    let _ = app.emit("daemon-event", value);
}

async fn clear_daemon(app: &AppHandle) {
    app.state::<AppState>().daemon.lock().await.take();
}

async fn write_command(state: &State<'_, AppState>, payload: Value) -> Result<(), String> {
    let mut guard = state.daemon.lock().await;
    let handle = guard.as_mut().ok_or("Agent daemon is not running yet")?;
    let mut line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    line.push('\n');
    handle
        .child
        .write(line.as_bytes())
        .map_err(|error| error.to_string())
}

// --- HTTP API sidecar supervisor ----------------------------------------

async fn run_api_supervisor(app: AppHandle, workspace: PathBuf) {
    loop {
        if is_exiting(&app) {
            return;
        }
        set_api_status(&app, json!({ "state": "starting", "url": api_url() })).await;
        let outcome = run_api_once(&app, &workspace).await;
        if is_exiting(&app) {
            return;
        }
        set_api_status(
            &app,
            json!({
                "state": "restarting",
                "url": api_url(),
                "message": outcome.err().unwrap_or_else(|| "API exited".to_string())
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn run_api_once(app: &AppHandle, workspace: &Path) -> Result<(), String> {
    let command = configure_agent_command(api_command(app)?, workspace)
        .env("MAI_API_ALLOW_WRITE", "true")
        .env("MAI_API_ALLOW_SHELL", "true")
        .env("MAI_ALLOW_SHELL", "true");
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("Failed to start HTTP API sidecar: {error}"))?;
    {
        let state: State<AppState> = app.state();
        *state.api.lock().await = Some(child);
    }

    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if line.contains("Mai API listening") {
                    set_api_status(app, json!({ "state": "running", "url": api_url() })).await;
                }
                let _ = app.emit("api-log", line);
            }
            CommandEvent::Stderr(bytes) => {
                let _ = app.emit(
                    "api-log",
                    String::from_utf8_lossy(&bytes).trim().to_string(),
                );
            }
            CommandEvent::Error(message) => {
                clear_api(app).await;
                return Err(message);
            }
            CommandEvent::Terminated(payload) => {
                clear_api(app).await;
                return Err(format!("HTTP API exited with code {:?}", payload.code));
            }
            _ => {}
        }
    }
    clear_api(app).await;
    Err("HTTP API event stream closed".to_string())
}

async fn set_api_status(app: &AppHandle, value: Value) {
    let state: State<AppState> = app.state();
    *state.api_status.lock().await = value.clone();
    let _ = app.emit("api-status", value);
}

async fn clear_api(app: &AppHandle) {
    app.state::<AppState>().api.lock().await.take();
}

fn api_url() -> String {
    let host = std::env::var("MAI_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let display_host = if host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        &host
    };
    let port = std::env::var("MAI_API_PORT").unwrap_or_else(|_| "3141".to_string());
    format!("http://{display_host}:{port}")
}

// --- frontend commands --------------------------------------------------

#[tauri::command]
async fn send_message(state: State<'_, AppState>, text: String) -> Result<(), String> {
    write_command(&state, json!({ "type": "send", "text": text })).await
}

#[tauri::command]
async fn approve(state: State<'_, AppState>, approved: bool) -> Result<(), String> {
    write_command(&state, json!({ "type": "approve", "approved": approved })).await
}

#[tauri::command]
async fn clear_conversation(state: State<'_, AppState>) -> Result<(), String> {
    write_command(&state, json!({ "type": "clear" })).await
}

#[tauri::command]
async fn interrupt_turn(state: State<'_, AppState>) -> Result<(), String> {
    write_command(&state, json!({ "type": "interrupt" })).await
}

#[tauri::command]
async fn list_providers(state: State<'_, AppState>) -> Result<(), String> {
    write_command(&state, json!({ "type": "listProviders" })).await
}

#[tauri::command]
async fn list_models(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    write_command(
        &state,
        json!({ "type": "listModels", "provider": provider }),
    )
    .await
}

#[tauri::command]
async fn set_model(
    state: State<'_, AppState>,
    provider: String,
    model: String,
) -> Result<(), String> {
    write_command(
        &state,
        json!({ "type": "setModel", "provider": provider, "model": model }),
    )
    .await
}

#[tauri::command]
async fn get_ready_info(state: State<'_, AppState>) -> Result<Option<Value>, String> {
    Ok(state.ready_info.lock().await.clone())
}

#[tauri::command]
async fn get_api_status(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.api_status.lock().await.clone())
}

#[tauri::command]
fn autostart_status(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())?;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn switch_to_cli(
    app: AppHandle,
    state: State<'_, AppState>,
    ui_messages: Vec<Value>,
) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    *state.handoff_waiter.lock().await = Some(tx);
    write_command(
        &state,
        json!({ "type": "handoff", "uiMessages": ui_messages }),
    )
    .await?;

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(message))) => return Err(message),
        Ok(Err(_)) => return Err("Agent daemon closed unexpectedly while handing off".to_string()),
        Err(_) => return Err("Timed out waiting to hand off the conversation".to_string()),
    }

    let workspace = state
        .workspace
        .lock()
        .await
        .clone()
        .ok_or("Workspace is not initialized")?;
    launch_cli_terminal(&workspace)?;
    request_exit(app);
    Ok(())
}

// --- command and workspace resolution ----------------------------------

fn daemon_command(app: &AppHandle) -> Result<Command, String> {
    if let Ok(path) = std::env::var("MAI_DAEMON_BIN") {
        return Ok(app.shell().command(path));
    }
    if cfg!(debug_assertions) {
        if let Some(path) = resolve_sibling_js("dist/daemon.js", "MAI_DAEMON_JS") {
            return Ok(app.shell().command(node_binary()).arg(path));
        }
    }
    app.shell()
        .sidecar("binaries/mai-daemon")
        .map_err(|error| error.to_string())
}

fn api_command(app: &AppHandle) -> Result<Command, String> {
    if let Ok(path) = std::env::var("MAI_API_BIN") {
        return Ok(app.shell().command(path));
    }
    if cfg!(debug_assertions) {
        if let Some(path) = resolve_sibling_js("dist/api-main.js", "MAI_API_JS") {
            return Ok(app.shell().command(node_binary()).arg(path));
        }
    }
    app.shell()
        .sidecar("binaries/mai-api")
        .map_err(|error| error.to_string())
}

fn configure_agent_command(command: Command, workspace: &Path) -> Command {
    let mut command = command.current_dir(workspace).env("PATH", child_path());
    if let Some(sandbox) = installed_sidecar("mai-sandbox") {
        command = command.env("MAI_SANDBOX_BIN", sandbox);
    }
    command
}

fn resolve_workspace(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(workspace) = std::env::var_os("MAI_WORKSPACE").map(PathBuf::from) {
        return validate_workspace(workspace);
    }

    let config_file = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("workspace");
    if let Ok(saved) = fs::read_to_string(&config_file) {
        if let Ok(workspace) = validate_workspace(PathBuf::from(saved.trim())) {
            return Ok(workspace);
        }
    }

    let workspace =
        validate_workspace(std::env::current_dir().map_err(|error| error.to_string())?)?;
    if let Some(parent) = config_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(config_file, workspace.to_string_lossy().as_bytes());
    Ok(workspace)
}

fn validate_workspace(path: PathBuf) -> Result<PathBuf, String> {
    let path = fs::canonicalize(&path)
        .map_err(|error| format!("Could not resolve workspace {}: {error}", path.display()))?;
    if !path.is_dir() {
        return Err(format!("Workspace is not a directory: {}", path.display()));
    }
    Ok(path)
}

fn installed_sidecar(name: &str) -> Option<PathBuf> {
    let directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
    #[cfg(target_os = "windows")]
    let filename = format!("{name}.exe");
    #[cfg(not(target_os = "windows"))]
    let filename = name.to_string();
    let candidate = directory.join(filename);
    candidate.is_file().then_some(candidate)
}

fn child_path() -> OsString {
    let mut entries = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            entries.push(parent.to_path_buf());
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn workspace_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let mut directory = executable.parent()?.to_path_buf();
    for _ in 0..4 {
        directory = directory.parent()?.to_path_buf();
    }
    Some(directory)
}

fn resolve_sibling_js(relative: &str, env_override: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var(env_override) {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    let candidate = workspace_root()?.join("mai-cli-node").join(relative);
    candidate.exists().then_some(candidate)
}

fn node_binary() -> String {
    std::env::var("MAI_NODE_BIN").unwrap_or_else(|_| "node".to_string())
}

// --- Open the CLI in a native terminal ----------------------------------

fn cli_invocation() -> Result<(String, Vec<String>), String> {
    if let Ok(path) = std::env::var("MAI_CLI_BIN") {
        return Ok((path, Vec::new()));
    }
    if !cfg!(debug_assertions) {
        if let Some(path) = installed_sidecar("mai-cli") {
            return Ok((path.to_string_lossy().to_string(), Vec::new()));
        }
    }
    let entry = resolve_sibling_js("dist/index.js", "MAI_CLI_JS").ok_or_else(|| {
        "Could not find the packaged mai-cli sidecar or mai-cli-node/dist/index.js".to_string()
    })?;
    Ok((node_binary(), vec![entry.to_string_lossy().to_string()]))
}

fn launch_cli_terminal(workspace: &Path) -> Result<(), String> {
    let (program, args) = cli_invocation()?;

    #[cfg(target_os = "linux")]
    {
        let candidates: &[(&str, &[&str])] = &[
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("xfce4-terminal", &["-x"]),
            ("alacritty", &["-e"]),
            ("kitty", &[]),
            ("x-terminal-emulator", &["-e"]),
            ("xterm", &["-e"]),
        ];
        for (binary, prefix_args) in candidates {
            if !which(binary) {
                continue;
            }
            let mut command = std::process::Command::new(binary);
            command
                .args(*prefix_args)
                .arg(&program)
                .args(&args)
                .current_dir(workspace);
            if command.spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("No supported terminal emulator was found".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let invocation = std::iter::once(program.as_str())
            .chain(args.iter().map(String::as_str))
            .map(osascript_quote)
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "tell application \"Terminal\" to do script \"cd {} && {}\"",
            osascript_quote(&workspace.to_string_lossy()),
            invocation,
        );
        return std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open Terminal.app: {error}"));
    }

    #[cfg(target_os = "windows")]
    {
        let mut terminal_args = vec![
            "-d".to_string(),
            workspace.to_string_lossy().to_string(),
            program.clone(),
        ];
        terminal_args.extend(args.clone());
        if std::process::Command::new("wt")
            .args(&terminal_args)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        let command_line = std::iter::once(program)
            .chain(args)
            .collect::<Vec<_>>()
            .join(" ");
        return std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &command_line])
            .current_dir(workspace)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open a terminal: {error}"));
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("Opening a terminal is not supported on this platform".to_string())
}

#[cfg(target_os = "linux")]
fn which(binary: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|directory| directory.join(binary).is_file())
        })
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn osascript_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
