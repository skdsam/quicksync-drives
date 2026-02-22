use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use suppaftp::tokio::{AsyncFtpStream, AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::types::Mode;
use tauri::{Emitter, State, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

#[derive(Debug)]
struct DummyVerifier(Arc<dyn ServerCertVerifier>);

impl DummyVerifier {
    fn new(roots: Arc<rustls::RootCertStore>) -> Self {
        let provider = rustls::crypto::ring::default_provider();
        let default_verifier =
            rustls::client::WebPkiServerVerifier::builder_with_provider(roots, provider.into())
                .build()
                .unwrap();
        Self(default_verifier)
    }
}

impl ServerCertVerifier for DummyVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

// Type aliases for state management in suppaftp 8.0.2
// AsyncFtpStream = ImplAsyncFtpStream<AsyncNoTlsStream>  (plain)
// AsyncRustlsFtpStream = ImplAsyncFtpStream<AsyncRustlsStream>  (TLS)
type PlainStream = AsyncFtpStream;
type SecureStream = AsyncRustlsFtpStream;

pub struct FtpState {
    pub client: Mutex<Option<PlainStream>>,
    pub secure_client: Mutex<Option<SecureStream>>,
}

impl Default for FtpState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            secure_client: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct FtpConfigPayload {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub secure: bool,
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub filename: String,
    pub progress: u64,
    pub total: u64,
    pub status: String,
}

#[tauri::command]
pub async fn connect_ftp(
    state: State<'_, FtpState>,
    config: FtpConfigPayload,
) -> Result<String, String> {
    let host_port = format!("{}:{}", config.host, config.port);

    if config.secure {
        // For FTPS: Use AsyncRustlsFtpStream::connect() which creates a stream
        // typed as ImplAsyncFtpStream<AsyncRustlsStream>, so into_secure
        // can properly resolve AsyncTlsConnector<Stream = AsyncRustlsStream>.
        let ftp_stream = AsyncRustlsFtpStream::connect(&host_port)
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        // Prepare Rustls config (rustls 0.23 API)
        let _ = rustls::crypto::ring::default_provider().install_default();

        let mut root_store = rustls::RootCertStore::empty();
        let cert_result = rustls_native_certs::load_native_certs();
        for cert in cert_result.certs {
            let _ = root_store.add(cert);
        }

        let root_store_arc = Arc::new(root_store);
        let mut tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store_arc.clone())
            .with_no_client_auth();

        tls_config
            .dangerous()
            .set_certificate_verifier(Arc::new(DummyVerifier::new(root_store_arc)));

        let tls_connector = suppaftp::tokio_rustls::TlsConnector::from(Arc::new(tls_config));
        let connector = AsyncRustlsConnector::from(tls_connector);

        // Upgrade to TLS
        let mut secure_stream = ftp_stream
            .into_secure(connector, &config.host)
            .await
            .map_err(|e| format!("TLS upgrade failed: {}", e))?;

        secure_stream
            .login(
                config.username.as_str(),
                config.password.as_deref().unwrap_or(""),
            )
            .await
            .map_err(|e| format!("Secure Login failed: {}", e))?;

        // Enable passive mode so data connections work through firewalls/NAT
        secure_stream.set_mode(Mode::Passive);

        let mut lock = state.secure_client.lock().await;
        *lock = Some(secure_stream);
        Ok(format!("Securely connected to {}", config.host))
    } else {
        // Plain FTP: connect and login directly
        let mut ftp_stream = AsyncFtpStream::connect(&host_port)
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        ftp_stream
            .login(
                config.username.as_str(),
                config.password.as_deref().unwrap_or(""),
            )
            .await
            .map_err(|e| format!("Login failed: {}", e))?;

        // Enable passive mode so data connections work through firewalls/NAT
        ftp_stream.set_mode(Mode::Passive);

        let mut lock = state.client.lock().await;
        *lock = Some(ftp_stream);
        Ok(format!("Connected to {}", config.host))
    }
}

#[tauri::command]
pub async fn disconnect_ftp(state: State<'_, FtpState>) -> Result<String, String> {
    // Try to disconnect secure client first
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            let _ = client.quit().await;
            *lock = None;
            return Ok("Disconnected secure session".into());
        }
    }

    // Then plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            let _ = client.quit().await;
            *lock = None;
            return Ok("Disconnected plain session".into());
        }
    }

    Err("No active connection".into())
}

#[derive(Serialize)]
pub struct RemoteFileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: String,
    pub modified: String,
}

fn parse_list_line(line: &str) -> Option<RemoteFileEntry> {
    // Parse Unix-style LIST output:
    // drwxr-xr-x   2 user group  4096 Jan  1 12:00 dirname
    // -rw-r--r--   1 user group 12345 Jan  1 12:00 filename.txt
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }

    let perms = parts[0];
    let is_dir = perms.starts_with('d');
    let size = parts[4].parse::<u64>().unwrap_or(0);
    let modified = format!("{} {} {}", parts[5], parts[6], parts[7]);
    // Name can contain spaces, so join everything from index 8 onwards
    let name = parts[8..].join(" ");

    // Skip . and ..
    if name == "." || name == ".." {
        return None;
    }

    Some(RemoteFileEntry {
        name,
        is_dir,
        size,
        permissions: perms.to_string(),
        modified,
    })
}

#[tauri::command]
pub async fn list_remote_directory(
    state: State<'_, FtpState>,
    path: Option<String>,
) -> Result<Vec<RemoteFileEntry>, String> {
    let dir_path = path.as_deref();

    // Try secure client first
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            if let Some(p) = dir_path {
                client
                    .cwd(p)
                    .await
                    .map_err(|e| format!("CWD failed: {}", e))?;
            }
            let lines = client
                .list(None)
                .await
                .map_err(|e| format!("LIST failed: {}", e))?;
            let mut entries: Vec<RemoteFileEntry> =
                lines.iter().filter_map(|l| parse_list_line(l)).collect();
            entries.sort_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            return Ok(entries);
        }
    }

    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            if let Some(p) = dir_path {
                client
                    .cwd(p)
                    .await
                    .map_err(|e| format!("CWD failed: {}", e))?;
            }
            let lines = client
                .list(None)
                .await
                .map_err(|e| format!("LIST failed: {}", e))?;
            let mut entries: Vec<RemoteFileEntry> =
                lines.iter().filter_map(|l| parse_list_line(l)).collect();
            entries.sort_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            return Ok(entries);
        }
    }

    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn get_remote_pwd(state: State<'_, FtpState>) -> Result<String, String> {
    // Try secure client first
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            return client.pwd().await.map_err(|e| format!("PWD failed: {}", e));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            return client.pwd().await.map_err(|e| format!("PWD failed: {}", e));
        }
    }
    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn download_remote_file(
    window: Window,
    state: State<'_, FtpState>,
    remote_name: String,
    local_path: String,
) -> Result<String, String> {
    // Generate a unique ID for this transfer
    let transfer_id = format!("dl-{}", uuid::Uuid::new_v4());

    // Get file size for progress bar
    let size = {
        // We try to get size from LIST or just use 0 if unknown
        // For simplicity, we'll try MDTM or just use a default
        0 // Placeholder if we can't get it easily without a separate call
    };

    // Try secure client first
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            // Try to get size
            let total_size = client.size(&remote_name).await.unwrap_or(0) as u64;

            let mut stream = client
                .retr_as_stream(&remote_name)
                .await
                .map_err(|e| format!("Download failed: {}", e))?;

            let mut file = tokio::fs::File::create(&local_path)
                .await
                .map_err(|e| format!("Capture failed: {}", e))?;

            let mut buffer = [0u8; 16384];
            let mut downloaded = 0u64;

            loop {
                let n = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                file.write_all(&buffer[..n])
                    .await
                    .map_err(|e| e.to_string())?;
                downloaded += n as u64;

                // Emit progress
                if total_size > 0 {
                    let _ = window.emit(
                        "transfer-progress",
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            filename: remote_name.clone(),
                            progress: downloaded,
                            total: total_size,
                            status: "downloading".into(),
                        },
                    );
                }
            }

            client
                .finalize_retr_stream(stream)
                .await
                .map_err(|e| format!("Finalize failed: {}", e))?;

            // Final emit
            let _ = window.emit(
                "transfer-progress",
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    filename: remote_name.clone(),
                    progress: downloaded,
                    total: total_size,
                    status: "complete".into(),
                },
            );

            return Ok(format!("Downloaded {}", remote_name));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            let total_size = client.size(&remote_name).await.unwrap_or(0) as u64;

            let mut stream = client
                .retr_as_stream(&remote_name)
                .await
                .map_err(|e| format!("Download failed: {}", e))?;

            let mut file = tokio::fs::File::create(&local_path)
                .await
                .map_err(|e| format!("Capture failed: {}", e))?;

            let mut buffer = [0u8; 16384];
            let mut downloaded = 0u64;

            loop {
                let n = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                file.write_all(&buffer[..n])
                    .await
                    .map_err(|e| e.to_string())?;
                downloaded += n as u64;

                if total_size > 0 {
                    let _ = window.emit(
                        "transfer-progress",
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            filename: remote_name.clone(),
                            progress: downloaded,
                            total: total_size,
                            status: "downloading".into(),
                        },
                    );
                }
            }

            client
                .finalize_retr_stream(stream)
                .await
                .map_err(|e| format!("Finalize failed: {}", e))?;

            let _ = window.emit(
                "transfer-progress",
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    filename: remote_name.clone(),
                    progress: downloaded,
                    total: total_size,
                    status: "complete".into(),
                },
            );

            return Ok(format!("Downloaded {}", remote_name));
        }
    }
    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn upload_file(
    window: Window,
    state: State<'_, FtpState>,
    local_path: String,
    remote_name: String,
) -> Result<String, String> {
    let transfer_id = format!("ul-{}", uuid::Uuid::new_v4());

    let mut file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("Read failed: {}", e))?;
    let metadata = file.metadata().await.map_err(|e| e.to_string())?;
    let total_size = metadata.len();

    // Try secure client first
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            let data = std::fs::read(&local_path).map_err(|e| e.to_string())?;
            let mut cursor = std::io::Cursor::new(data);

            client
                .put_file(&remote_name, &mut cursor)
                .await
                .map_err(|e| format!("Upload failed: {}", e))?;

            let _ = window.emit(
                "transfer-progress",
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    filename: remote_name.clone(),
                    progress: total_size,
                    total: total_size,
                    status: "complete".into(),
                },
            );

            return Ok(format!("Uploaded {}", remote_name));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            let data = std::fs::read(&local_path).map_err(|e| e.to_string())?;
            let mut cursor = std::io::Cursor::new(data);

            client
                .put_file(&remote_name, &mut cursor)
                .await
                .map_err(|e| format!("Upload failed: {}", e))?;

            let _ = window.emit(
                "transfer-progress",
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    filename: remote_name.clone(),
                    progress: total_size,
                    total: total_size,
                    status: "complete".into(),
                },
            );

            return Ok(format!("Uploaded {}", remote_name));
        }
    }
    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn delete_remote_file(
    state: State<'_, FtpState>,
    path: String,
) -> Result<String, String> {
    // Try secure client
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .rm(&path)
                .await
                .map_err(|e| format!("Delete failed: {}", e))?;
            return Ok(format!("Deleted file: {}", path));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .rm(&path)
                .await
                .map_err(|e| format!("Delete failed: {}", e))?;
            return Ok(format!("Deleted file: {}", path));
        }
    }
    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn delete_remote_dir(state: State<'_, FtpState>, path: String) -> Result<String, String> {
    // Note: rmdir usually only works if the directory is empty.
    // For recursive deletion, a more complex approach is needed
    // (listing contents and deleting recursively) but this is a starting point.
    // Try secure client
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .rmdir(&path)
                .await
                .map_err(|e| format!("Delete generic failed (directory must be empty): {}", e))?;
            return Ok(format!("Deleted directory: {}", path));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .rmdir(&path)
                .await
                .map_err(|e| format!("Delete genric failed (directory must be empty): {}", e))?;
            return Ok(format!("Deleted directory: {}", path));
        }
    }
    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn rename_remote_file(
    state: State<'_, FtpState>,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    // Try secure client
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .rename(&old_path, &new_path)
                .await
                .map_err(|e| format!("Rename failed: {}", e))?;
            return Ok(format!("Renamed {} to {}", old_path, new_path));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .rename(&old_path, &new_path)
                .await
                .map_err(|e| format!("Rename failed: {}", e))?;
            return Ok(format!("Renamed {} to {}", old_path, new_path));
        }
    }
    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn create_remote_dir(state: State<'_, FtpState>, path: String) -> Result<String, String> {
    // Try secure client
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .mkdir(&path)
                .await
                .map_err(|e| format!("Mkdir failed: {}", e))?;
            return Ok(format!("Created directory: {}", path));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            client
                .mkdir(&path)
                .await
                .map_err(|e| format!("Mkdir failed: {}", e))?;
            return Ok(format!("Created directory: {}", path));
        }
    }
    Err("No active FTP connection".into())
}

#[async_recursion::async_recursion]
async fn recursive_download_secure(
    client: &mut SecureStream,
    remote_dir: &str,
    local_dir: &std::path::Path,
) -> Result<u64, String> {
    use tokio::io::AsyncReadExt;

    if !local_dir.exists() {
        std::fs::create_dir_all(local_dir)
            .map_err(|e| format!("Failed to create local dir: {}", e))?;
    }

    client
        .cwd(remote_dir)
        .await
        .map_err(|e| format!("CWD failed to {}: {}", remote_dir, e))?;
    let lines = client
        .list(None)
        .await
        .map_err(|e| format!("LIST failed in {}: {}", remote_dir, e))?;

    let mut total_bytes = 0;

    let mut entries = Vec::new();
    for l in lines {
        if let Some(entry) = parse_list_line(&l) {
            entries.push(entry);
        }
    }

    for entry in entries {
        let entry_remote_path = format!("{}/{}", remote_dir, entry.name);
        let entry_local_path = local_dir.join(&entry.name);

        if entry.is_dir {
            total_bytes +=
                recursive_download_secure(client, &entry_remote_path, &entry_local_path).await?;
            client
                .cwd(remote_dir)
                .await
                .map_err(|e| format!("CWD failed returning to {}: {}", remote_dir, e))?;
        } else {
            let mut stream = client
                .retr_as_stream(&entry.name)
                .await
                .map_err(|e| format!("Download failed for {}: {}", entry.name, e))?;
            let mut buf = Vec::new();
            stream
                .read_to_end(&mut buf)
                .await
                .map_err(|e| format!("Read stream failed for {}: {}", entry.name, e))?;
            client
                .finalize_retr_stream(stream)
                .await
                .map_err(|e| format!("Finalize failed for {}: {}", entry.name, e))?;

            std::fs::write(&entry_local_path, &buf)
                .map_err(|e| format!("Save failed for {}: {}", entry.name, e))?;
            total_bytes += buf.len() as u64;
        }
    }

    Ok(total_bytes)
}

#[async_recursion::async_recursion]
async fn recursive_download_plain(
    client: &mut PlainStream,
    remote_dir: &str,
    local_dir: &std::path::Path,
) -> Result<u64, String> {
    use tokio::io::AsyncReadExt;

    if !local_dir.exists() {
        std::fs::create_dir_all(local_dir)
            .map_err(|e| format!("Failed to create local dir: {}", e))?;
    }

    client
        .cwd(remote_dir)
        .await
        .map_err(|e| format!("CWD failed to {}: {}", remote_dir, e))?;
    let lines = client
        .list(None)
        .await
        .map_err(|e| format!("LIST failed in {}: {}", remote_dir, e))?;

    let mut total_bytes = 0;

    let mut entries = Vec::new();
    for l in lines {
        if let Some(entry) = parse_list_line(&l) {
            entries.push(entry);
        }
    }

    for entry in entries {
        let entry_remote_path = format!("{}/{}", remote_dir, entry.name);
        let entry_local_path = local_dir.join(&entry.name);

        if entry.is_dir {
            total_bytes +=
                recursive_download_plain(client, &entry_remote_path, &entry_local_path).await?;
            client
                .cwd(remote_dir)
                .await
                .map_err(|e| format!("CWD failed returning to {}: {}", remote_dir, e))?;
        } else {
            let mut stream = client
                .retr_as_stream(&entry.name)
                .await
                .map_err(|e| format!("Download failed for {}: {}", entry.name, e))?;
            let mut buf = Vec::new();
            stream
                .read_to_end(&mut buf)
                .await
                .map_err(|e| format!("Read stream failed for {}: {}", entry.name, e))?;
            client
                .finalize_retr_stream(stream)
                .await
                .map_err(|e| format!("Finalize failed for {}: {}", entry.name, e))?;

            std::fs::write(&entry_local_path, &buf)
                .map_err(|e| format!("Save failed for {}: {}", entry.name, e))?;
            total_bytes += buf.len() as u64;
        }
    }

    Ok(total_bytes)
}

#[tauri::command]
pub async fn download_remote_folder(
    state: State<'_, FtpState>,
    remote_dir: String,
    local_dir: String,
) -> Result<String, String> {
    let local_path = std::path::Path::new(&local_dir);

    // Try secure client
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            let orig_cwd = client.pwd().await.unwrap_or_else(|_| "/".to_string());

            let absolute_remote = if remote_dir.starts_with('/') {
                remote_dir.clone()
            } else {
                let sep = if orig_cwd.ends_with('/') { "" } else { "/" };
                format!("{}{}{}", orig_cwd, sep, remote_dir)
            };

            let result = recursive_download_secure(client, &absolute_remote, local_path).await;

            let _ = client.cwd(&orig_cwd).await;

            let bytes = result?;
            return Ok(format!(
                "Downloaded folder '{}' ({} bytes)",
                remote_dir, bytes
            ));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            let orig_cwd = client.pwd().await.unwrap_or_else(|_| "/".to_string());

            let absolute_remote = if remote_dir.starts_with('/') {
                remote_dir.clone()
            } else {
                let sep = if orig_cwd.ends_with('/') { "" } else { "/" };
                format!("{}{}{}", orig_cwd, sep, remote_dir)
            };

            let result = recursive_download_plain(client, &absolute_remote, local_path).await;

            let _ = client.cwd(&orig_cwd).await;

            let bytes = result?;
            return Ok(format!(
                "Downloaded folder '{}' ({} bytes)",
                remote_dir, bytes
            ));
        }
    }
    Err("No active FTP connection".into())
}
