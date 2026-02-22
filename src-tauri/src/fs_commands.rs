use serde::Serialize;
use std::fs;

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = if path.is_empty() {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("C:\\"))
    } else {
        std::path::PathBuf::from(&path)
    };

    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", dir_path.display()));
    }
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", dir_path.display()));
    }

    let mut entries: Vec<FileEntry> = Vec::new();

    match fs::read_dir(&dir_path) {
        Ok(read_dir) => {
            for entry in read_dir.flatten() {
                let metadata = entry.metadata();
                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

                entries.push(FileEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                    is_dir,
                    size,
                });
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    // Sort: directories first, then files, both alphabetically
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[tauri::command]
pub fn get_file_icon(ext: String) -> Result<String, String> {
    use base64::{engine::general_purpose, Engine as _};
    use systemicons::get_icon;

    // get_icon takes an extension like ".txt" and a size (16, 32, 64, 256)
    let ext_with_dot = if ext.starts_with('.') {
        ext.clone()
    } else if ext.is_empty() {
        return Err("Empty extension".into());
    } else {
        format!(".{}", ext)
    };

    // Try to get 16x16 icon (Standard small icon)
    match get_icon(&ext_with_dot, 16) {
        Ok(icon_bytes) => {
            let base64_str = general_purpose::STANDARD.encode(icon_bytes);
            Ok(format!("data:image/png;base64,{}", base64_str))
        }
        Err(e) => Err(format!("Failed to get icon for {}: {:?}", ext_with_dot, e)),
    }
}

#[tauri::command]
pub fn delete_local_file(path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if p.is_dir() {
        std::fs::remove_dir_all(&p)
            .map_err(|e| format!("Failed to delete directory {}: {}", path, e))?;
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Failed to delete file {}: {}", path, e))?;
    }
    Ok(format!("Successfully deleted {}", path))
}

#[tauri::command]
pub fn copy_to_local(source_path: String, dest_dir: String) -> Result<String, String> {
    let source = std::path::PathBuf::from(&source_path);
    let dest_dir_path = std::path::PathBuf::from(&dest_dir);

    if !source.exists() {
        return Err(format!("Source file does not exist: {}", source_path));
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| "Invalid source file name".to_string())?;
    let dest_path = dest_dir_path.join(file_name);

    match std::fs::copy(&source, &dest_path) {
        Ok(_) => Ok(format!(
            "Successfully copied {} to {}",
            source_path,
            dest_path.display()
        )),
        Err(e) => Err(format!("Failed to copy file: {}", e)),
    }
}
