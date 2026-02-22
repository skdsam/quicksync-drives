use tauri::menu::{CheckMenuItemBuilder, Menu, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;

pub mod cloud_client;
pub mod config;
pub mod fs_commands;
mod ftp_client;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--flag1", "--flag2"]),
        ))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ftp_client::FtpState::default())
        .setup(|app| {
            // Read saved config to set initial menu state
            let app_config = match config::load_config(app.handle().clone()) {
                Ok(c) => c,
                Err(_) => config::AppConfig::default(),
            };
            let is_light = app_config.theme.as_deref() == Some("light");

            // Build CheckMenuItems
            let theme_light = CheckMenuItemBuilder::new("Light")
                .id("theme_light")
                .checked(is_light)
                .build(app)?;
            let theme_dark = CheckMenuItemBuilder::new("Dark")
                .id("theme_dark")
                .checked(!is_light)
                .build(app)?;

            let autostart_manager = app.autolaunch();
            let is_autostart = autostart_manager.is_enabled().unwrap_or(false);

            let autostart_item = CheckMenuItemBuilder::new("Start on Windows load")
                .id("autostart")
                .checked(is_autostart)
                .build(app)?;

            // Build Submenus
            let theme_submenu =
                Submenu::with_items(app, "Theme", true, &[&theme_light, &theme_dark])?;

            let view_submenu = Submenu::with_items(app, "View", true, &[&theme_submenu])?;

            let options_submenu = Submenu::with_items(app, "Options", true, &[&autostart_item])?;

            // Build Main Menu
            let menu = Menu::with_items(app, &[&view_submenu, &options_submenu])?;

            app.set_menu(menu)?;

            // Handle Menu Events
            app.on_menu_event(move |app_handle, event| {
                if event.id() == "theme_light" {
                    let _ = theme_light.set_checked(true);
                    let _ = theme_dark.set_checked(false);
                    let _ = app_handle.emit("theme-changed", "light");
                } else if event.id() == "theme_dark" {
                    let _ = theme_dark.set_checked(true);
                    let _ = theme_light.set_checked(false);
                    let _ = app_handle.emit("theme-changed", "dark");
                } else if event.id() == "autostart" {
                    let autostart_manager = app_handle.autolaunch();
                    if let Ok(enabled) = autostart_manager.is_enabled() {
                        if enabled {
                            let _ = autostart_manager.disable();
                            let _ = autostart_item.set_checked(false);
                        } else {
                            let _ = autostart_manager.enable();
                            let _ = autostart_item.set_checked(true);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            config::load_config,
            config::save_config,
            ftp_client::connect_ftp,
            ftp_client::disconnect_ftp,
            ftp_client::list_remote_directory,
            ftp_client::get_remote_pwd,
            ftp_client::download_remote_file,
            ftp_client::upload_file,
            ftp_client::delete_remote_file,
            ftp_client::delete_remote_dir,
            ftp_client::rename_remote_file,
            ftp_client::create_remote_dir,
            ftp_client::download_remote_folder,
            fs_commands::list_directory,
            fs_commands::get_home_dir,
            fs_commands::get_file_icon,
            cloud_client::list_cloud_directory,
            cloud_client::download_cloud_file,
            cloud_client::upload_cloud_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
