mod sidecar;
mod tray;

use tauri::Manager;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[derive(serde::Serialize)]
pub struct ProxyInfo {
    pub running: bool,
    pub port: u16,
    pub config_path: String,
}

#[tauri::command]
fn get_proxy_info(app: tauri::AppHandle) -> ProxyInfo {
    ProxyInfo {
        running: sidecar::is_running(&app),
        port: sidecar::get_port(&app),
        config_path: sidecar::get_config_path(&app)
            .to_string_lossy()
            .to_string(),
    }
}

#[tauri::command]
fn restart_proxy(app: tauri::AppHandle) -> Result<(), String> {
    sidecar::restart(&app)
}

fn open_path_in_os(path: &std::path::Path, is_folder: bool) {
    let path_str = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        if is_folder {
            let _ = std::process::Command::new("explorer")
                .arg(&path_str)
                .spawn();
        } else {
            let _ = std::process::Command::new("cmd")
                .args(["/c", "start", "", &path_str])
                .spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&path_str).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn();
    }
}

#[tauri::command]
fn open_data_folder(app: tauri::AppHandle) {
    let folder = sidecar::data_folder(&app);
    let abs = std::fs::canonicalize(&folder).unwrap_or(folder);
    open_path_in_os(&abs, true);
}

#[tauri::command]
fn open_config_file(app: tauri::AppHandle) {
    let config_path = sidecar::get_config_path(&app);
    let abs = std::fs::canonicalize(&config_path).unwrap_or(config_path);
    open_path_in_os(&abs, false);
}

#[tauri::command]
fn open_log_file(app: tauri::AppHandle) {
    let log_path = sidecar::log_path(&app);
    if log_path.exists() {
        let abs = std::fs::canonicalize(&log_path).unwrap_or(log_path);
        open_path_in_os(&abs, false);
    }
}

#[tauri::command]
fn get_log_path(app: tauri::AppHandle) -> String {
    sidecar::log_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn install_ca_cert(app: tauri::AppHandle) -> Result<String, String> {
    crate::tray::install_ca_cert_internal(&app)
}

#[tauri::command]
fn get_ca_cert_path(app: tauri::AppHandle) -> Option<String> {
    let config_path = sidecar::get_config_path(&app);
    let config_dir = config_path.parent()?;
    let ca_cert_name = std::fs::read_to_string(&config_path)
        .ok()?
        .lines()
        .find_map(|line| {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("ca_cert:") {
                return Some(rest.trim().to_string());
            }
            None
        })
        .unwrap_or_else(|| "luwak-ca.crt".to_string());
    let ca_path = config_dir.join(&ca_cert_name);
    if ca_path.exists() {
        Some(ca_path.to_string_lossy().to_string())
    } else {
        None
    }
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

pub fn run() {
    let autostart = tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec!["net.awsystem.luwak"]),
    );

    let app = tauri::Builder::default()
        .plugin(autostart)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            get_proxy_info,
            restart_proxy,
            open_data_folder,
            open_config_file,
            open_log_file,
            get_log_path,
            install_ca_cert,
            get_ca_cert_path,
            is_autostart_enabled,
            set_autostart,
        ])
        .setup(|app| {
            tray::create(app)?;
            sidecar::start_and_connect(app.handle())?;
            tray::start_status_monitor(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building luwak desktop");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            sidecar::kill(app_handle);
        }
    });
}
