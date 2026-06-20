use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::sidecar;

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
