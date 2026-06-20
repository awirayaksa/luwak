use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub struct SidecarState {
    child: Option<CommandChild>,
    port: u16,
    config_path: PathBuf,
    monitor_stop: Option<Arc<AtomicBool>>,
}

const DEFAULT_CONFIG: &str = r#"# Luwak configuration
# Full docs: https://github.com/awsystem/luwak/blob/main/luwak.yaml.example

# Bind to loopback only: the proxy forwards live API keys upstream.
listen: 127.0.0.1:8080

# Capture database location (relative to this file).
db: ./luwak.db

# Raw retention (days). 0 = keep forever.
retention_days: 30

# Providers: point your client at http://127.0.0.1:8080/<prefix>
# and luwak forwards to `upstream`, capturing the exchange.
providers:
  - id: anthropic
    prefix: /anthropic
    upstream: https://api.anthropic.com
    adapter: anthropic

  - id: openai
    prefix: /openai
    upstream: https://api.openai.com
    adapter: openai

  # OpenAI-compatible providers reuse the openai adapter:
  # - id: groq
  #   prefix: /groq
  #   upstream: https://api.groq.com/openai
  #   adapter: openai

# Transparent MITM proxy (optional).
# When enabled, set HTTPS_PROXY=http://127.0.0.1:8081 in your client's
# environment instead of changing base URLs. Requires OpenSSL for CA
# certificate generation. Install luwak-ca.crt in your trust store, then
# use the "Install CA Certificate" option in the tray menu.
# transparent:
#   enabled: true
#   listen: 127.0.0.1:8081
#   ca_cert: ./luwak-ca.crt
#   ca_key: ./luwak-ca.key
"#;

/// Resolve the config file path, creating a default if none exists.
///
/// Search order:
/// 1. LUWAK_CONFIG env var (if the file exists)
/// 2. Next to the main exe (portable mode)
/// 3. App data directory (installed mode)
/// 4. Create a default config next to the exe (portable) or in app_data_dir
fn resolve_config_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("LUWAK_CONFIG") {
        let p = PathBuf::from(&path);
        if p.exists() {
            return p;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let config = dir.join("luwak.yaml");
            if config.exists() {
                return config;
            }
        }
    }

    if let Ok(data_dir) = app.path().app_data_dir() {
        let config = data_dir.join("luwak.yaml");
        if config.exists() {
            return config;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let config = dir.join("luwak.yaml");
            if std::fs::write(&config, DEFAULT_CONFIG).is_ok() {
                eprintln!("luwak: created default config at {}", config.display());
                return config;
            }
        }
    }

    if let Ok(data_dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&data_dir);
        let config = data_dir.join("luwak.yaml");
        let _ = std::fs::write(&config, DEFAULT_CONFIG);
        eprintln!("luwak: created default config at {}", config.display());
        return config;
    }

    PathBuf::from("luwak.yaml")
}

fn read_port_from_config(config_path: &PathBuf) -> u16 {
    if let Ok(content) = std::fs::read_to_string(config_path) {
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("listen:") {
                let addr = rest.trim();
                if let Some(port_str) = addr.rsplit(':').next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        return port;
                    }
                }
            }
        }
    }
    8080
}

fn read_db_path_from_config(config_path: &PathBuf) -> String {
    if let Ok(content) = std::fs::read_to_string(config_path) {
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("db:") {
                return rest.trim().to_string();
            }
        }
    }
    "./luwak.db".to_string()
}

pub fn is_healthy(port: u16) -> bool {
    std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok()
}

fn wait_for_health(port: u16, timeout_secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    while Instant::now() < deadline {
        if is_healthy(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

fn navigate_to_viewer(app: &AppHandle, port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/app", port);
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    window
        .eval(&format!("window.location.replace('{}')", url))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn show_error(app: &AppHandle, msg: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let json_msg = serde_json::to_string(msg).unwrap_or_else(|_| "\"Error\"".to_string());
        let _ = window.eval(&format!("window.__luwakShowError({})", json_msg));
    }
}

/// Build the sidecar command with the correct env var and working directory.
fn build_sidecar_command(app: &AppHandle, config_path: &PathBuf) -> Result<tauri_plugin_shell::process::Command, String> {
    let cwd = config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let cmd = app
        .shell()
        .sidecar("luwak")
        .map_err(|e| format!("Failed to find sidecar binary: {}", e))?;

    // On Windows, GUI apps may have a truncated PATH. Merge the system PATH
    // from the registry so the sidecar can find tools like openssl.
    #[cfg(target_os = "windows")]
    {
        let system_path = get_full_windows_path();
        Ok(cmd
            .env("LUWAK_CONFIG", config_path.to_string_lossy().to_string())
            .env("PATH", system_path)
            .current_dir(&cwd))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(cmd
            .env("LUWAK_CONFIG", config_path.to_string_lossy().to_string())
            .current_dir(&cwd))
    }
}

/// Get the full PATH from the Windows registry (Machine + User), merging with
/// the current process PATH. This ensures the sidecar can find openssl etc.
#[cfg(target_os = "windows")]
fn get_full_windows_path() -> String {
    use std::process::Command;

    let mut paths: Vec<String> = Vec::new();

    // Current process PATH
    if let Ok(p) = std::env::var("PATH") {
        for part in p.split(';') {
            if !part.is_empty() {
                paths.push(part.to_string());
            }
        }
    }

    // System (Machine) PATH from registry
    if let Ok(output) = Command::new("reg")
        .args(["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", "PATH"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if let Some(idx) = line.find("PATH") {
                    if let Some(rest) = line[idx..].strip_prefix("PATH") {
                        let rest = rest.trim_start_matches([' ', '\t']);
                        if let Some(rest) = rest.strip_prefix("REG_SZ") {
                            for part in rest.trim().split(';') {
                                if !part.is_empty() && !paths.contains(&part.to_string()) {
                                    paths.push(part.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // User PATH from registry
    if let Ok(output) = Command::new("reg")
        .args(["query", "HKCU\\Environment", "/v", "PATH"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if let Some(idx) = line.find("PATH") {
                    if let Some(rest) = line[idx..].strip_prefix("PATH") {
                        let rest = rest.trim_start_matches([' ', '\t']);
                        if let Some(rest) = rest.strip_prefix("REG_SZ") {
                            for part in rest.trim().split(';') {
                                if !part.is_empty() && !paths.contains(&part.to_string()) {
                                    paths.push(part.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    paths.join(";")
}

/// Monitor the sidecar: capture stderr, detect crashes, check health.
/// All stdout/stderr is written to luwak.log next to the config file.
fn spawn_monitor(
    app: AppHandle,
    rx: tauri::async_runtime::Receiver<CommandEvent>,
    port: u16,
    config_path: PathBuf,
    stop_flag: Arc<AtomicBool>,
) {
    // Truncate the log at startup so it doesn't grow forever.
    let log_file = log_path(&app);
    let _ = std::fs::write(&log_file, "");
    log_line(&app, &format!("--- luwak desktop starting ---"));
    log_line(&app, &format!("config: {}", config_path.display()));
    log_line(&app, &format!("log file: {}", log_file.display()));

    std::thread::spawn(move || {
        let mut rx = rx;
        let mut last_error = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut healthy = false;

        while Instant::now() < deadline {
            if stop_flag.load(Ordering::SeqCst) {
                return;
            }

            match rx.try_recv() {
                Ok(CommandEvent::Stderr(line)) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    let text = text.trim();
                    if !text.is_empty() {
                        log_line(&app, &format!("stderr: {}", text));
                        last_error = text.to_string();
                    }
                }
                Ok(CommandEvent::Stdout(line)) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    let text = text.trim();
                    if !text.is_empty() {
                        log_line(&app, &format!("stdout: {}", text));
                    }
                }
                Ok(CommandEvent::Terminated(payload)) => {
                    let msg = if last_error.is_empty() {
                        format!("Proxy exited (code: {:?}).", payload.code)
                    } else {
                        last_error
                    };
                    log_line(&app, &format!("TERMINATED: {}", msg));
                    show_error(&app, &msg);
                    return;
                }
                Ok(CommandEvent::Error(err)) => {
                    last_error = err.clone();
                    log_line(&app, &format!("error: {}", err));
                }
                Ok(_) => {}
                Err(_) => {
                    if is_healthy(port) {
                        healthy = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(300));
                }
            }
        }

        if !healthy {
            let msg = if last_error.is_empty() {
                format!(
                    "Proxy did not start within 30s on port {}.\nConfig: {}",
                    port,
                    config_path.display()
                )
            } else {
                last_error
            };
            log_line(&app, &format!("HEALTH CHECK FAILED: {}", msg));
            show_error(&app, &msg);
            return;
        }

        log_line(&app, &format!("proxy healthy on port {}", port));

        if let Err(e) = navigate_to_viewer(&app, port) {
            log_line(&app, &format!("failed to navigate to viewer: {}", e));
            show_error(&app, &format!("Failed to load viewer: {}", e));
            return;
        }

        log_line(&app, "viewer loaded, entering health monitor loop");

        loop {
            std::thread::sleep(Duration::from_secs(5));
            if stop_flag.load(Ordering::SeqCst) {
                log_line(&app, "monitor stop requested, exiting");
                return;
            }
            match rx.try_recv() {
                Ok(CommandEvent::Stderr(line)) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    let text = text.trim();
                    if !text.is_empty() {
                        log_line(&app, &format!("stderr: {}", text));
                    }
                }
                Ok(CommandEvent::Stdout(line)) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    let text = text.trim();
                    if !text.is_empty() {
                        log_line(&app, &format!("stdout: {}", text));
                    }
                }
                Ok(CommandEvent::Terminated(_)) => {
                    log_line(&app, "proxy terminated unexpectedly");
                    show_error(&app, "The proxy process has stopped unexpectedly.");
                    return;
                }
                Ok(_) => {}
                Err(_) => {
                    if !is_healthy(port) {
                        log_line(&app, "proxy health check failed (port not responding)");
                        show_error(&app, "The proxy process has stopped unexpectedly.");
                        return;
                    }
                }
            }
        }
    });
}

pub fn get_port(app: &AppHandle) -> u16 {
    if let Some(state) = app.try_state::<Mutex<SidecarState>>() {
        if let Ok(state) = state.lock() {
            return state.port;
        }
    }
    8080
}

pub fn get_config_path(app: &AppHandle) -> PathBuf {
    if let Some(state) = app.try_state::<Mutex<SidecarState>>() {
        if let Ok(state) = state.lock() {
            return state.config_path.clone();
        }
    }
    resolve_config_path(app)
}

pub fn is_running(app: &AppHandle) -> bool {
    let port = get_port(app);
    is_healthy(port)
}

pub fn data_folder(app: &AppHandle) -> PathBuf {
    let config_path = get_config_path(app);
    let db_path = read_db_path_from_config(&config_path);
    let p = PathBuf::from(&db_path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            return parent.to_path_buf();
        }
    }
    config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Log file lives next to the config file (same directory as the exe in
/// portable mode, or in app_data_dir for installed mode).
pub fn log_path(app: &AppHandle) -> PathBuf {
    let config_path = get_config_path(app);
    config_path
        .parent()
        .map(|d| d.join("luwak.log"))
        .unwrap_or_else(|| PathBuf::from("luwak.log"))
}

/// Append a line to the log file with a timestamp.
fn log_line(app: &AppHandle, line: &str) {
    let path = log_path(app);
    let timestamp = {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        format!("{}", now)
    };
    let entry = format!("[{}] {}\n", timestamp, line);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, entry.as_bytes()));
}

pub fn start_and_connect(app: &AppHandle) -> Result<(), String> {
    let config_path = resolve_config_path(app);
    let port = read_port_from_config(&config_path);

    if cfg!(debug_assertions) {
        app.manage(Mutex::new(SidecarState {
            child: None,
            port,
            config_path: config_path.clone(),
            monitor_stop: None,
        }));

        let app_handle = app.clone();
        std::thread::spawn(move || {
            if wait_for_health(port, 60) {
                if let Err(e) = navigate_to_viewer(&app_handle, port) {
                    eprintln!("luwak: failed to navigate to viewer: {}", e);
                }
            } else {
                show_error(
                    &app_handle,
                    &format!(
                        "Could not connect to proxy on port {}.\nStart it with: bun run dev",
                        port
                    ),
                );
            }
        });
        Ok(())
    } else {
        let sidecar_cmd = build_sidecar_command(app, &config_path)?;
        let (rx, child) = sidecar_cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        let stop_flag = Arc::new(AtomicBool::new(false));

        app.manage(Mutex::new(SidecarState {
            child: Some(child),
            port,
            config_path: config_path.clone(),
            monitor_stop: Some(stop_flag.clone()),
        }));

        spawn_monitor(
            app.clone(),
            rx,
            port,
            config_path,
            stop_flag,
        );
        Ok(())
    }
}

pub fn restart(app: &AppHandle) -> Result<(), String> {
    let state_guard = app.state::<Mutex<SidecarState>>();
    let mut state = state_guard.lock().map_err(|e| e.to_string())?;
    let port = state.port;
    let config_path = state.config_path.clone();

    if let Some(stop) = state.monitor_stop.take() {
        stop.store(true, Ordering::SeqCst);
    }
    if let Some(child) = state.child.take() {
        let _ = child.kill();
    }
    drop(state);

    std::thread::sleep(Duration::from_secs(1));

    if !cfg!(debug_assertions) {
        let sidecar_cmd = build_sidecar_command(app, &config_path)?;
        let (rx, child) = sidecar_cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        let stop_flag = Arc::new(AtomicBool::new(false));

        let state_guard = app.state::<Mutex<SidecarState>>();
        let mut state = state_guard.lock().map_err(|e| e.to_string())?;
        state.child = Some(child);
        state.monitor_stop = Some(stop_flag.clone());
        drop(state);

        spawn_monitor(app.clone(), rx, port, config_path, stop_flag);
    } else {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            if wait_for_health(port, 30) {
                if let Err(e) = navigate_to_viewer(&app_handle, port) {
                    eprintln!("luwak: failed to navigate after restart: {}", e);
                }
            } else {
                show_error(
                    &app_handle,
                    "The proxy did not become healthy after restart.",
                );
            }
        });
    }

    Ok(())
}

pub fn kill(app: &AppHandle) {
    if let Some(state_guard) = app.try_state::<Mutex<SidecarState>>() {
        if let Ok(mut state) = state_guard.lock() {
            if let Some(stop) = state.monitor_stop.take() {
                stop.store(true, Ordering::SeqCst);
            }
            if let Some(child) = state.child.take() {
                let _ = child.kill();
            }
        }
    }
}
