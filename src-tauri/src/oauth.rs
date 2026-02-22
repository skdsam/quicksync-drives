use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri_plugin_opener::OpenerExt;
use tiny_http::{Response, Server};
use url::Url;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[tauri::command]
pub async fn start_oauth_flow(
    app: tauri::AppHandle,
    provider: String,
    client_id: String,
    client_secret: String,
) -> Result<OAuthTokens, String> {
    let port = 3456;
    let redirect_uri = format!("http://localhost:{}/oauth/callback", port);

    // 1. Construct Authorization URL based on provider
    let auth_url = match provider.as_str() {
        "google" => {
            let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
            url.query_pairs_mut()
                .append_pair("client_id", &client_id)
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", "https://www.googleapis.com/auth/drive.file")
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
            url.to_string()
        }
        "dropbox" => {
            let mut url = Url::parse("https://www.dropbox.com/oauth2/authorize").unwrap();
            url.query_pairs_mut()
                .append_pair("client_id", &client_id)
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("token_access_type", "offline");
            url.to_string()
        }
        _ => return Err(format!("Unsupported provider: {}", provider)),
    };

    // 2. Open browser
    if let Err(e) = app.opener().open_url(auth_url, None::<&str>) {
        return Err(format!("Failed to open browser: {}", e));
    }

    // 3. Start local server to capture redirect
    let server = Server::http(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to start local server: {}", e))?;

    let mut auth_code = String::new();

    // Block and wait for 1 request
    for request in server.incoming_requests() {
        let raw_url = format!("http://localhost:{}{}", port, request.url());
        if let Ok(url) = Url::parse(&raw_url) {
            if url.path() == "/oauth/callback" {
                let query_pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();

                if let Some(error) = query_pairs.get("error") {
                    let _ = request.respond(Response::from_string(
                        "Authentication Failed. You can close this window.",
                    ));
                    return Err(format!("OAuth error from provider: {}", error));
                }

                if let Some(code) = query_pairs.get("code") {
                    auth_code = code.to_string();
                    let response = Response::from_string(
                        "<html><body><h1>Authentication Successful!</h1><p>You can close this window and return to QuickSync Drives.</p></body></html>"
                    ).with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html"[..]).unwrap());

                    let _ = request.respond(response);
                    break;
                }
            }
        }

        // If not the callback, just return 404
        let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
    }

    if auth_code.is_empty() {
        return Err("Failed to capture authorization code".to_string());
    }

    // 4. Exchange code for tokens
    let token_endpoint = match provider.as_str() {
        "google" => "https://oauth2.googleapis.com/token",
        "dropbox" => "https://api.dropboxapi.com/oauth2/token",
        _ => unreachable!(),
    };

    let client = Client::new();
    let mut params = HashMap::<&str, &str>::new();
    params.insert("client_id", &client_id);
    params.insert("client_secret", &client_secret);
    params.insert("code", &auth_code);
    params.insert("grant_type", "authorization_code");
    params.insert("redirect_uri", &redirect_uri);

    let token_res = client
        .post(token_endpoint)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token request failed: {}", e))?;

    if !token_res.status().is_success() {
        let err_text = token_res.text().await.unwrap_or_default();
        return Err(format!("Failed to exchange token: {}", err_text));
    }

    let tokens: TokenResponse = token_res
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    Ok(OAuthTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
    })
}
