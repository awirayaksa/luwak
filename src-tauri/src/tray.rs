use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::sidecar;

pub fn install_ca_cert_internal(app: &AppHandle) -> Result<String, String> {
    let config_path = sidecar::get_config_path(app);
    let config_dir = config_path.parent().unwrap_or(std::path::Path::new("."));

    let ca_cert_name = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|content| {
            content.lines().find_map(|line| {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("ca_cert:") {
                    return Some(rest.trim().to_string());
                }
                None
            })
        })
        .unwrap_or_else(|| "luwak-ca.crt".to_string());

    let ca_path = config_dir.join(&ca_cert_name);
    if !ca_path.exists() {
        return Err(format!(
            "CA certificate not found at {}. Enable transparent mode in the config and restart the proxy first.",
            ca_path.display()
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let ca_str = ca_path.to_string_lossy().to_string();
        let result = std::process::Command::new("certutil")
            .args(["-addstore", "-user", "Root", &ca_str])
            .output()
            .map_err(|e| format!("Failed to run certutil: {}", e))?;
        if result.status.success() {
            Ok("CA certificate installed to Windows trust store.".to_string())
        } else {
            Err(format!("certutil failed: {}", String::from_utf8_lossy(&result.stderr)))
        }
    }
    #[cfg(target_os = "macos")]
    {
        let ca_str = ca_path.to_string_lossy().to_string();
        let result = std::process::Command::new("security")
            .args(["add-trusted-cert", "-d", "-r", "trustRoot", "-k", "login.keychain", &ca_str])
            .output()
            .map_err(|e| format!("Failed to run security: {}", e))?;
        if result.status.success() {
            Ok("CA certificate installed to macOS login keychain.".to_string())
        } else {
            Err(format!("security command failed: {}", String::from_utf8_lossy(&result.stderr)))
        }
    }
    #[cfg(target_os = "linux")]
    {
        let ca_str = ca_path.to_string_lossy().to_string();
        let result = std::process::Command::new("sh")
            .args(["-c", &format!("cp '{}' /usr/local/share/ca-certificates/luwak-ca.crt && sudo update-ca-certificates", ca_str)])
            .output()
            .map_err(|e| format!("Failed to install CA: {}", e))?;
        if result.status.success() {
            Ok("CA certificate installed to system trust store.".to_string())
        } else {
            Err(format!("Installation failed: {}", String::from_utf8_lossy(&result.stderr)))
        }
    }
}

fn open_in_file_manager(path: &std::path::Path) {
    let path_str = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .arg(path_str)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(&path_str)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn();
    }
}

fn open_file(path: &std::path::Path) {
    let path_str = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", &path_str])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&path_str).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path_str).spawn();
    }
}

fn update_status_text(app: &AppHandle) {
    let running = sidecar::is_running(app);
    let text = if running { "Proxy: Running" } else { "Proxy: Stopped" };
    if let Some(item) = app.menu().and_then(|m| m.get("status")) {
        if let Some(menu_item) = item.as_menuitem() {
            let _ = menu_item.set_text(text);
        }
    }
}

pub fn create(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show Luwak", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Proxy: Starting…", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Proxy", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start on Login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let open_config = MenuItem::with_id(
        app,
        "open_config",
        "Open Config File",
        true,
        None::<&str>,
    )?;
    let open_data = MenuItem::with_id(
        app,
        "open_data",
        "Open Data Folder",
        true,
        None::<&str>,
    )?;
    let install_ca = MenuItem::with_id(
        app,
        "install_ca",
        "Install CA Certificate",
        true,
        None::<&str>,
    )?;
    let view_logs = MenuItem::with_id(
        app,
        "view_logs",
        "View Logs",
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Luwak", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &status,
            &restart,
            &sep1,
            &autostart,
            &open_config,
            &open_data,
            &install_ca,
            &view_logs,
            &sep2,
            &quit,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .ok_or("no default window icon found")?
        .clone();

    TrayIconBuilder::with_id("main-tray")
        .tooltip("Luwak")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "restart" => {
                    if let Err(e) = sidecar::restart(app) {
                        eprintln!("luwak: failed to restart sidecar: {}", e);
                    }
                }
                "autostart" => {
                    let autostart_manager = app.autolaunch();
                    if let Ok(enabled) = autostart_manager.is_enabled() {
                        if enabled {
                            let _ = autostart_manager.disable();
                        } else {
                            let _ = autostart_manager.enable();
                        }
                    }
                }
                "open_config" => {
                    let config_path = sidecar::get_config_path(app);
                    open_file(&config_path);
                }
                "open_data" => {
                    let folder = sidecar::data_folder(app);
                    let abs = std::fs::canonicalize(&folder).unwrap_or(folder);
                    open_in_file_manager(&abs);
                }
                "install_ca" => {
                    let app_handle = app.clone();
                    std::thread::spawn(move || {
                        match install_ca_cert_internal(&app_handle) {
                            Ok(msg) => println!("luwak: {}", msg),
                            Err(e) => eprintln!("luwak: CA install failed: {}", e),
                        }
                    });
                }
                "view_logs" => {
                    let log_path = sidecar::log_path(app);
                    if log_path.exists() {
                        open_file(&log_path);
                    } else {
                        let dir = log_path.parent().unwrap_or(std::path::Path::new("."));
                        open_in_file_manager(dir);
                    }
                }
                "quit" => {
                    sidecar::kill(app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

pub fn start_status_monitor(app: &AppHandle) {
    struct StatusState;
    app.manage(Mutex::new(StatusState));

    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        update_status_text(&app_handle);
    });
}
