use serde::{Deserialize, Serialize};
use std::sync::Arc;
use suppaftp::tokio::{AsyncFtpStream, AsyncRustlsConnector, AsyncRustlsFtpStream};
use tauri::State;
use tokio::sync::Mutex;

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

        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();

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
    state: State<'_, FtpState>,
    remote_name: String,
    local_path: String,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;

    // Try secure client first
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            let mut stream = client
                .retr_as_stream(&remote_name)
                .await
                .map_err(|e| format!("Download failed: {}", e))?;
            let mut buf = Vec::new();
            stream
                .read_to_end(&mut buf)
                .await
                .map_err(|e| format!("Read stream failed: {}", e))?;
            client
                .finalize_retr_stream(stream)
                .await
                .map_err(|e| format!("Finalize failed: {}", e))?;
            std::fs::write(&local_path, &buf).map_err(|e| format!("Save failed: {}", e))?;
            return Ok(format!("Downloaded {} ({} bytes)", remote_name, buf.len()));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            let mut stream = client
                .retr_as_stream(&remote_name)
                .await
                .map_err(|e| format!("Download failed: {}", e))?;
            let mut buf = Vec::new();
            stream
                .read_to_end(&mut buf)
                .await
                .map_err(|e| format!("Read stream failed: {}", e))?;
            client
                .finalize_retr_stream(stream)
                .await
                .map_err(|e| format!("Finalize failed: {}", e))?;
            std::fs::write(&local_path, &buf).map_err(|e| format!("Save failed: {}", e))?;
            return Ok(format!("Downloaded {} ({} bytes)", remote_name, buf.len()));
        }
    }
    Err("No active FTP connection".into())
}

#[tauri::command]
pub async fn upload_file(
    state: State<'_, FtpState>,
    local_path: String,
    remote_name: String,
) -> Result<String, String> {
    let data = std::fs::read(&local_path).map_err(|e| format!("Read failed: {}", e))?;
    let size = data.len();

    // Try secure client first
    {
        let mut lock = state.secure_client.lock().await;
        if let Some(ref mut client) = *lock {
            let mut cursor = std::io::Cursor::new(data);
            client
                .put_file(&remote_name, &mut cursor)
                .await
                .map_err(|e| format!("Upload failed: {}", e))?;
            return Ok(format!("Uploaded {} ({} bytes)", remote_name, size));
        }
    }
    // Try plain client
    {
        let mut lock = state.client.lock().await;
        if let Some(ref mut client) = *lock {
            let mut cursor = std::io::Cursor::new(data);
            client
                .put_file(&remote_name, &mut cursor)
                .await
                .map_err(|e| format!("Upload failed: {}", e))?;
            return Ok(format!("Uploaded {} ({} bytes)", remote_name, size));
        }
    }
    Err("No active FTP connection".into())
}
