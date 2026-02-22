use reqwest::Client;
use serde::{Deserialize, Serialize};

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

#[tauri::command]
pub async fn list_cloud_directory(
    provider: String,
    token: String,
    folder_id: Option<String>,
) -> Result<Vec<CloudEntry>, String> {
    if provider != "google" {
        return Err("Only Google Drive is implemented at this time.".to_string());
    }

    let client = Client::new();
    let parent_id = folder_id.unwrap_or_else(|| "root".to_string());

    // Construct the query to get files in the specific parent directory.
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

    // If we're not at the root, append a ".." entry pointing to a parent if possible,
    // though Google Drive doesn't easily return the parent's parent ID without extra requests.
    // For now, we let the frontend manage the "up" directory stack.

    for file in drive_res.files {
        let is_dir = file.mimeType == "application/vnd.google-apps.folder";

        // Parse size if available
        let size = file.size.and_then(|s| s.parse::<u64>().ok());

        entries.push(CloudEntry {
            name: file.name,
            is_dir,
            size,
            last_modified: file.modifiedTime,
            id: Some(file.id),
        });
    }

    Ok(entries)
}

#[tauri::command]
pub async fn download_cloud_file(
    provider: String,
    token: String,
    file_id: String,
    local_path: String,
) -> Result<String, String> {
    if provider != "google" {
        return Err("Only Google Drive is implemented at this time.".to_string());
    }

    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?alt=media",
        file_id
    );
    let client = Client::new();

    let mut res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token.trim()))
        .send()
        .await
        .map_err(|e| format!("Failed to initiate download: {}", e))?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Download API Error: {}", err_text));
    }

    let mut file = std::fs::File::create(&local_path)
        .map_err(|e| format!("Failed to create local file: {}", e))?;

    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("Error reading stream: {}", e))?
    {
        use std::io::Write;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write to local file: {}", e))?;
    }

    Ok(format!("Successfully downloaded file to {}", local_path))
}

#[tauri::command]
pub async fn upload_cloud_file(
    provider: String,
    token: String,
    local_path: String,
    remote_parent_id: Option<String>,
) -> Result<String, String> {
    if provider != "google" {
        return Err("Only Google Drive is implemented at this time.".to_string());
    }

    // Read the local file
    let file = std::fs::File::open(&local_path)
        .map_err(|e| format!("Failed to open local file: {}", e))?;

    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

    let file_name = std::path::Path::new(&local_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown_file");

    // We will do a simple multipart upload
    // https://developers.google.com/drive/api/guides/manage-uploads#multipart

    let client = Client::new();
    let url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

    // Construct metadata
    let parent_id = remote_parent_id.unwrap_or_else(|| "root".to_string());
    let metadata_json = serde_json::json!({
        "name": file_name,
        "parents": [parent_id]
    });

    let metadata_part = reqwest::multipart::Part::text(metadata_json.to_string())
        .mime_str("application/json")
        .unwrap();

    // In a real robust implementation, we'd stream the file using tokio::fs::File
    // and reqwest::Body::wrap_stream. For simplicity, we'll read it into memory.
    let file_bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read file into memory: {}", e))?;

    let media_part = reqwest::multipart::Part::bytes(file_bytes).file_name(file_name.to_string());

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

    Ok(format!("Successfully uploaded {}", file_name))
}
