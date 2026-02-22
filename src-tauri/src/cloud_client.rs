use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Window};
use tokio::io::AsyncWriteExt;

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub filename: String,
    pub progress: u64,
    pub total: u64,
    pub status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CloudEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub last_modified: Option<String>,
    pub id: Option<String>,
}

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
struct GoogleDriveFile {
    id: String,
    name: String,
    mimeType: String,
    size: Option<String>,
    modifiedTime: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GoogleDriveResponse {
    files: Vec<GoogleDriveFile>,
}

#[derive(Deserialize, Debug)]
struct DropboxFile {
    #[serde(rename = ".tag")]
    tag: String,
    name: String,
    id: String,
    size: Option<u64>,
    server_modified: Option<String>,
}

#[derive(Deserialize, Debug)]
struct DropboxListResponse {
    entries: Vec<DropboxFile>,
}

#[tauri::command]
pub async fn list_cloud_directory(
    provider: String,
    token: String,
    folder_id: Option<String>,
) -> Result<Vec<CloudEntry>, String> {
    if provider == "google" {
        let client = Client::new();
        let parent_id = folder_id.unwrap_or_else(|| "root".to_string());

        let query = format!("'{}' in parents and trashed = false", parent_id);
        let url = format!(
            "https://www.googleapis.com/drive/v3/files?q={}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=folder,name",
            urlencoding::encode(&query)
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .send()
            .await
            .map_err(|e| format!("Network request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Google Drive API Error: {}", err_text));
        }

        let drive_res: GoogleDriveResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse Google Drive response: {}", e))?;

        let mut entries = Vec::new();
        for file in drive_res.files {
            let is_dir = file.mimeType == "application/vnd.google-apps.folder";
            let size = file.size.and_then(|s| s.parse::<u64>().ok());

            entries.push(CloudEntry {
                name: file.name,
                is_dir,
                size,
                last_modified: file.modifiedTime,
                id: Some(file.id),
            });
        }
        return Ok(entries);
    } else if provider == "dropbox" {
        let client = Client::new();

        let path = if let Some(id) = folder_id {
            if id.is_empty() {
                String::new()
            } else {
                id
            }
        } else {
            String::new()
        };

        let res = client
            .post("https://api.dropboxapi.com/2/files/list_folder")
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "path": path
            }))
            .send()
            .await
            .map_err(|e| format!("Dropbox Network request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Dropbox API Error: {}", err_text));
        }

        let box_res: DropboxListResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse Dropbox response: {}", e))?;

        let mut entries = Vec::new();
        for file in box_res.entries {
            let is_dir = file.tag == "folder";
            entries.push(CloudEntry {
                name: file.name,
                is_dir,
                size: file.size,
                last_modified: file.server_modified,
                id: Some(file.id),
            });
        }
        return Ok(entries);
    }

    Err(format!("Provider {} not recognized.", provider))
}

#[tauri::command]
pub async fn download_cloud_file(
    window: Window,
    provider: String,
    token: String,
    file_id: String,
    local_path: String,
) -> Result<String, String> {
    let transfer_id = format!("dl-{}", uuid::Uuid::new_v4());
    let client = Client::new();

    if provider == "google" {
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?alt=media",
            file_id
        );
        let mut res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .send()
            .await
            .map_err(|e| format!("Google Drive Download request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Google Drive Download Error: {}", err_text));
        }

        let total_size = res.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(&local_path)
            .await
            .map_err(|e| format!("Failed to create local file: {}", e))?;

        let mut downloaded = 0u64;
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| format!("Error reading stream: {}", e))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write to local file: {}", e))?;
            downloaded += chunk.len() as u64;

            if total_size > 0 {
                let _ = window.emit(
                    "transfer-progress",
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        filename: file_id.clone(),
                        progress: downloaded,
                        total: total_size,
                        status: "downloading".into(),
                    },
                );
            }
        }

        let _ = window.emit(
            "transfer-progress",
            TransferProgress {
                transfer_id: transfer_id.clone(),
                filename: file_id.clone(),
                progress: downloaded,
                total: total_size,
                status: "complete".into(),
            },
        );

        return Ok(format!("Successfully downloaded file to {}", local_path));
    } else if provider == "dropbox" {
        let path_arg = serde_json::json!({
            "path": if file_id.starts_with("id:") { &file_id } else { &file_id } // Check if id: is already there
        });

        let mut res = client
            .post("https://content.dropboxapi.com/2/files/download")
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("Dropbox-API-Arg", path_arg.to_string())
            .send()
            .await
            .map_err(|e| format!("Dropbox Download request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Dropbox Download Error: {}", err_text));
        }

        let total_size = res.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(&local_path)
            .await
            .map_err(|e| format!("Failed to create local file: {}", e))?;

        let mut downloaded = 0u64;
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| format!("Error reading stream: {}", e))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write to local file: {}", e))?;
            downloaded += chunk.len() as u64;

            if total_size > 0 {
                let _ = window.emit(
                    "transfer-progress",
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        filename: file_id.clone(),
                        progress: downloaded,
                        total: total_size,
                        status: "downloading".into(),
                    },
                );
            }
        }

        let _ = window.emit(
            "transfer-progress",
            TransferProgress {
                transfer_id: transfer_id,
                filename: file_id,
                progress: downloaded,
                total: total_size,
                status: "complete".into(),
            },
        );

        return Ok(format!("Successfully downloaded file to {}", local_path));
    }

    Err(format!("Provider {} not recognized.", provider))
}

#[tauri::command]
pub async fn upload_cloud_file(
    _window: Window,
    provider: String,
    token: String,
    local_path: String,
    remote_parent_id: Option<String>,
) -> Result<String, String> {
    let _transfer_id = format!("ul-{}", uuid::Uuid::new_v4());
    let _file_name = std::path::Path::new(&local_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown_file");

    if provider == "google" {
        // Read the local file
        let file = std::fs::File::open(&local_path)
            .map_err(|e| format!("Failed to open local file: {}", e))?;

        // Suppress unused metadata warning since we might use it later
        let _metadata = file
            .metadata()
            .map_err(|e| format!("Failed to read file metadata: {}", e))?;

        let file_name = std::path::Path::new(&local_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown_file");

        let client = Client::new();
        let url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

        let parent_id = remote_parent_id.unwrap_or_else(|| "root".to_string());
        let metadata_json = serde_json::json!({
            "name": file_name,
            "parents": [parent_id]
        });

        let metadata_part = reqwest::multipart::Part::text(metadata_json.to_string())
            .mime_str("application/json")
            .unwrap();

        let file_bytes = std::fs::read(&local_path)
            .map_err(|e| format!("Failed to read file into memory: {}", e))?;

        let media_part =
            reqwest::multipart::Part::bytes(file_bytes).file_name(file_name.to_string());

        let form = reqwest::multipart::Form::new()
            .part("metadata", metadata_part)
            .part("file", media_part);

        let res = client
            .post(url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Upload request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Upload API Error: {}", err_text));
        }

        return Ok(format!("Successfully uploaded {}", file_name));
    } else if provider == "dropbox" {
        let file_name = std::path::Path::new(&local_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown_file");

        let client = Client::new();

        // Dropbox paths must start with a slash or be completely empty for root
        let mut parent_path = remote_parent_id.unwrap_or_default();
        if parent_path.starts_with("id:") {
            // Dropbox supports uploading into a folder by ID, so we just append the filename
            parent_path = if parent_path.ends_with('/') {
                parent_path
            } else {
                format!("{}/", parent_path)
            };
        } else {
            // It's a string path
            if !parent_path.starts_with('/') && !parent_path.is_empty() {
                parent_path = format!("/{}", parent_path);
            }
            if parent_path != "/" && !parent_path.ends_with('/') {
                parent_path = format!("{}/", parent_path);
            }
            if parent_path == "/" {
                parent_path = "/".to_string(); // Keep base slash
            }
        }

        let upload_path = format!("{}{}", parent_path, file_name);

        let path_arg = serde_json::json!({
            "path": upload_path,
            "mode": "add",
            "autorename": true,
            "mute": false
        });

        let file_bytes = std::fs::read(&local_path)
            .map_err(|e| format!("Failed to read file into memory: {}", e))?;

        let res = client
            .post("https://content.dropboxapi.com/2/files/upload")
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("Dropbox-API-Arg", path_arg.to_string())
            .header("Content-Type", "application/octet-stream")
            .body(file_bytes)
            .send()
            .await
            .map_err(|e| format!("Dropbox Upload request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Dropbox Upload API Error: {}", err_text));
        }

        return Ok(format!("Successfully uploaded {}", file_name));
    }

    Err(format!("Provider {} not recognized.", provider))
}

#[tauri::command]
pub async fn delete_cloud_file(
    provider: String,
    token: String,
    file_id: String,
) -> Result<String, String> {
    let client = Client::new();
    if provider == "google" {
        let url = format!("https://www.googleapis.com/drive/v3/files/{}", file_id);
        let res = client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .send()
            .await
            .map_err(|e| format!("Google Drive Delete request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Google Drive Delete Error: {}", err_text));
        }
        return Ok(format!("Successfully deleted file ID: {}", file_id));
    } else if provider == "dropbox" {
        let res = client
            .post("https://api.dropboxapi.com/2/files/delete_v2")
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "path": file_id
            }))
            .send()
            .await
            .map_err(|e| format!("Dropbox Delete request failed: {}", e))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Dropbox Delete Error: {}", err_text));
        }
        return Ok(format!("Successfully deleted: {}", file_id));
    }

    Err(format!("Provider {} not recognized.", provider))
}
