# QuickSync Drives 🚀

QuickSync Drives is a professional-grade, native multi-cloud and FTP file manager built with **Rust (Tauri)** and **React**. It provides a unified interface for managing files across local storage, FTP servers, and cloud providers like Google Drive and Dropbox.

![QuickSync Drives Header](src/assets/logo.png)

## Key Features

### 🌐 Unified File Management
- **Local Explorer**: Browse your local system with high-performance native I/O.
- **FTP/FTPS Client**: Support for both plain FTP and secure FTPS (FTP over TLS) connections.
- **Cloud Integration**: Full CRUD support for **Google Drive** and **Dropbox**.

### ⚡ Performance & Stability
- **Robust Networking**: Integrated timeouts for all remote operations to prevent UI hangs during network stalls.
- **Chunked Transfers**: Efficient streaming for large file downloads and uploads.
- **Passive Mode**: Built-in support for FTP Passive mode to ensure compatibility with firewalls and NAT.

### 🎨 Premium User Experience
- **Transfer Queue**: Real-time progress bars with shimmer animations for all active transfers.
- **Modern UI**: Adaptive dark mode with a sleek glassmorphism aesthetic.
- **Split-Pane Layout**: Resizable side-by-side view for effortless drag-and-drop between local and remote systems.
- **Fast Search**: Instant client-side filtering for both local and remote file lists.

### 🛡️ Secure & Native
- **Native OS Integration**: Native window decorations, taskbar icons, and system menus.
- **OAuth Support**: Securely connect your cloud accounts using industry-standard OAuth 2.0.
- **Auto-Autostart**: Option to launch at system startup for seamless background synchronization.

## Tech Stack
- **Backend**: Rust, Tauri, Tokio, SuppaFTP
- **Frontend**: React, TypeScript, Vite, Vanilla CSS

## Getting Started

1. **Clone the repo**
2. **Install dependencies**: `npm install`
3. **Run in development**: `npm run tauri dev`
4. **Build production**: `npm run tauri build`

---

*Built with ❤️ for power users who need a faster, more stable way to manage their data.*
