pub mod config;
pub mod fs_commands;
pub mod ftp_client;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ftp_client::FtpState::default())
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
            fs_commands::list_directory,
            fs_commands::get_home_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
