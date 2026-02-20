import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useConfigStore, FtpConnection } from "./store/config";
import "./index.css";

/* ───────── Types ───────── */
interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

interface RemoteEntry {
  name: string;
  is_dir: boolean;
  size: number;
  permissions: string;
  modified: string;
}

interface TreeNode extends FileEntry {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

/* ───────── Helpers ───────── */
function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function persist(key: string, value: number) {
  localStorage.setItem(`qs-${key}`, String(value));
}
function restore(key: string, fallback: number): number {
  const v = localStorage.getItem(`qs-${key}`);
  return v ? Number(v) : fallback;
}

/* ───────── FileTree component ───────── */
function FileTree({ rootPath }: { rootPath: string }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (path: string) => {
    try {
      setError(null);
      const entries = await invoke<FileEntry[]>("list_directory", { path });
      return entries.map((e) => ({ ...e, children: undefined, expanded: false, loading: false }));
    } catch (err: any) {
      setError(String(err));
      return [];
    }
  }, []);

  useEffect(() => {
    loadDir(currentPath).then(setTree);
  }, [currentPath, loadDir]);

  const toggleFolder = async (node: TreeNode, idx: number[]) => {
    const update = (nodes: TreeNode[], path: number[]): TreeNode[] => {
      return nodes.map((n, i) => {
        if (path.length === 1 && i === path[0]) {
          return { ...n, expanded: !n.expanded, loading: !n.expanded && !n.children };
        }
        if (path.length > 1 && i === path[0] && n.children) {
          return { ...n, children: update(n.children, path.slice(1)) };
        }
        return n;
      });
    };
    setTree((prev) => update(prev, idx));

    if (!node.expanded && !node.children) {
      const children = await loadDir(node.path);
      const setChildren = (nodes: TreeNode[], path: number[]): TreeNode[] => {
        return nodes.map((n, i) => {
          if (path.length === 1 && i === path[0]) {
            return { ...n, children, loading: false };
          }
          if (path.length > 1 && i === path[0] && n.children) {
            return { ...n, children: setChildren(n.children, path.slice(1)) };
          }
          return n;
        });
      };
      setTree((prev) => setChildren(prev, idx));
    }
  };

  const renderNodes = (nodes: TreeNode[], indexPath: number[] = [], depth = 0): React.ReactNode[] => {
    return nodes.map((node, i) => {
      const path = [...indexPath, i];
      return (
        <div key={node.path}>
          <div
            className="tree-row"
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => node.is_dir && toggleFolder(node, path)}
            onDoubleClick={() => { if (node.is_dir) setCurrentPath(node.path); }}
          >
            <span className="tree-icon">
              {node.is_dir ? (node.expanded ? "📂" : "📁") : "📄"}
            </span>
            <span className="tree-name">{node.name}</span>
            {!node.is_dir && <span className="tree-size">{formatSize(node.size)}</span>}
            {node.loading && <span className="tree-loading">…</span>}
          </div>
          {node.expanded && node.children && renderNodes(node.children, path, depth + 1)}
        </div>
      );
    });
  };

  // Navigate up
  const goUp = () => {
    const parent = currentPath.replace(/[\\/][^\\/]*$/, "");
    if (parent && parent !== currentPath) setCurrentPath(parent);
  };

  return (
    <div className="file-tree">
      <div className="tree-toolbar">
        <button className="btn-icon" onClick={goUp} title="Go up">⬆</button>
        <span className="tree-path" title={currentPath}>{currentPath}</span>
        <button className="btn-icon" onClick={() => loadDir(currentPath).then(setTree)} title="Refresh">↻</button>
      </div>
      <div className="tree-list">
        {error && <div className="tree-error">{error}</div>}
        {!error && tree.length === 0 && <div className="tree-empty">Empty directory</div>}
        {renderNodes(tree)}
      </div>
    </div>
  );
}

/* ───────── RemoteFileTree component ───────── */
function RemoteFileTree({ onTransferMsg }: { onTransferMsg: (msg: string) => void }) {
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [remotePath, setRemotePath] = useState("/");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const loadRemoteDir = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const files = await invoke<RemoteEntry[]>("list_remote_directory", { path: path ?? null });
      const pwd = await invoke<string>("get_remote_pwd");
      setEntries(files);
      setRemotePath(pwd);
    } catch (err: any) {
      setError(String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRemoteDir();
  }, [loadRemoteDir]);

  const navigateTo = (dirName: string) => loadRemoteDir(dirName);
  const goUp = () => loadRemoteDir("..");

  const handleDownload = async (fileName: string) => {
    try {
      onTransferMsg(`Downloading ${fileName}…`);
      const home = await invoke<string>("get_home_dir");
      const localPath = `${home}\\Downloads\\${fileName}`;
      const result = await invoke<string>("download_remote_file", {
        remoteName: fileName,
        localPath,
      });
      onTransferMsg(result);
    } catch (err: any) {
      onTransferMsg(`Download error: ${err}`);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer.files;
    if (!files.length) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = (file as any).path;
      if (!filePath) {
        onTransferMsg(`Cannot upload ${file.name} — no path available`);
        continue;
      }
      try {
        onTransferMsg(`Uploading ${file.name}…`);
        const result = await invoke<string>("upload_file", {
          localPath: filePath,
          remoteName: file.name,
        });
        onTransferMsg(result);
      } catch (err: any) {
        onTransferMsg(`Upload error: ${err}`);
      }
    }
    loadRemoteDir();
  };

  return (
    <div
      className={`file-tree ${dragging ? 'file-tree-dragover' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="tree-toolbar">
        <button className="btn-icon" onClick={goUp} title="Go up">⬆</button>
        <span className="tree-path" title={remotePath}>{remotePath}</span>
        <button className="btn-icon" onClick={() => loadRemoteDir()} title="Refresh">↻</button>
      </div>
      <div className="tree-list">
        {loading && <div className="tree-loading-msg">Loading…</div>}
        {error && <div className="tree-error">{error}</div>}
        {!loading && !error && entries.length === 0 && <div className="tree-empty">Empty directory</div>}
        {dragging && <div className="drop-indicator">Drop files here to upload</div>}
        {entries.map((entry) => (
          <div
            key={entry.name}
            className="tree-row"
            onClick={() => entry.is_dir && navigateTo(entry.name)}
            onDoubleClick={() => !entry.is_dir && handleDownload(entry.name)}
            style={{ cursor: entry.is_dir ? 'pointer' : 'default' }}
            title={entry.is_dir ? 'Click to open' : 'Double-click to download'}
          >
            <span className="tree-icon">{entry.is_dir ? '📁' : '📄'}</span>
            <span className="tree-name">{entry.name}</span>
            {!entry.is_dir && <span className="tree-size">{formatSize(entry.size)}</span>}
            {!entry.is_dir && (
              <button
                className="btn-icon btn-download"
                onClick={(e) => { e.stopPropagation(); handleDownload(entry.name); }}
                title="Download"
              >⬇</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── Resizer component ───────── */
function Resizer({ direction, onResize }: { direction: "col" | "row"; onResize: (delta: number) => void }) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startPos = direction === "col" ? e.clientX : e.clientY;
    const onMove = (ev: MouseEvent) => {
      const delta = (direction === "col" ? ev.clientX : ev.clientY) - startPos;
      onResize(delta);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = direction === "col" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`resizer resizer-${direction}`}
      onMouseDown={handleMouseDown}
    />
  );
}

/* ───────── Connection Form Modal ───────── */
function ConnectionModal({ onClose, onSave, editing }: {
  onClose: () => void;
  onSave: (conn: FtpConnection) => void;
  editing?: FtpConnection | null;
}) {
  const [name, setName] = useState(editing?.name || "");
  const [host, setHost] = useState(editing?.host || "");
  const [port, setPort] = useState(editing?.port || 21);
  const [username, setUsername] = useState(editing?.username || "");
  const [password, setPassword] = useState(editing?.password || "");
  const [secure, setSecure] = useState(editing?.secure || false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      id: editing?.id || Date.now().toString(),
      name: name || `${host}:${port}`,
      host,
      port,
      username,
      password: password || undefined,
      secure,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-header">
          <h2>{editing ? "Edit Connection" : "New Connection"}</h2>
          <button type="button" className="btn-close" onClick={onClose}>✕</button>
        </div>

        <div className="form-grid">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My FTP Server" />

          <label>Host *</label>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ftp.example.com" required />

          <label>Port</label>
          <input type="number" value={port} onChange={(e) => setPort(+e.target.value)} min={1} max={65535} />

          <label>Username *</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required />

          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />

          <label>FTPS (Secure)</label>
          <label className="toggle-container">
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary">{editing ? "Save" : "Add Connection"}</button>
        </div>
      </form>
    </div>
  );
}

/* ───────── Main App ───────── */
function App() {
  const [connectionStatus, setConnectionStatus] = useState("Not Connected");
  const [showModal, setShowModal] = useState(false);
  const [editingConn, setEditingConn] = useState<FtpConnection | null>(null);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [homePath, setHomePath] = useState("");
  const [transferMsgs, setTransferMsgs] = useState<string[]>([]);

  // Resizable panel sizes
  const [sidebarW, setSidebarW] = useState(() => restore("sidebar-w", 240));
  const [leftRatio, setLeftRatio] = useState(() => restore("left-ratio", 50));
  const [queueH, setQueueH] = useState(() => restore("queue-h", 180));

  const sidebarRef = useRef(sidebarW);
  const leftRef = useRef(leftRatio);
  const queueRef = useRef(queueH);
  const panesRef = useRef<HTMLElement>(null);

  const { config, loadConfig, saveConfig } = useConfigStore();

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => {
    invoke<string>("get_home_dir").then(setHomePath).catch(() => setHomePath("C:\\"));
  }, []);

  /* ── Connection CRUD ── */
  const handleSaveConn = (conn: FtpConnection) => {
    const existing = config.ftp_connections.findIndex((c) => c.id === conn.id);
    const updated = [...config.ftp_connections];
    if (existing >= 0) updated[existing] = conn;
    else updated.push(conn);
    saveConfig({ ...config, ftp_connections: updated });
  };

  const handleDeleteConn = (id: string) => {
    if (selectedConnId === id) setSelectedConnId(null);
    saveConfig({ ...config, ftp_connections: config.ftp_connections.filter((c) => c.id !== id) });
  };

  const selectedConn = config.ftp_connections.find((c) => c.id === selectedConnId) || null;

  const handleConnect = async () => {
    if (!selectedConn) return;
    setConnectionStatus("Connecting…");
    try {
      const result = await invoke<string>("connect_ftp", {
        config: {
          host: selectedConn.host,
          port: selectedConn.port,
          username: selectedConn.username,
          password: selectedConn.password || "",
          secure: selectedConn.secure || false,
        },
      });
      setConnectionStatus(result);
    } catch (err: any) {
      setConnectionStatus(`Error: ${err}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      const result = await invoke<string>("disconnect_ftp");
      setConnectionStatus(result);
    } catch (err: any) {
      setConnectionStatus(`Error: ${err}`);
    }
  };

  /* ── Resize handlers ── */
  const onSidebarResize = useCallback((delta: number) => {
    const next = Math.max(160, Math.min(500, sidebarRef.current + delta));
    setSidebarW(next);
    sidebarRef.current = next;
    persist("sidebar-w", next);
  }, []);

  const onPaneResize = useCallback((delta: number) => {
    if (!panesRef.current) return;
    const containerW = panesRef.current.offsetWidth;
    const pxToPercent = (delta / containerW) * 100;
    const next = Math.max(20, Math.min(80, leftRef.current + pxToPercent));
    setLeftRatio(next);
    leftRef.current = next;
    persist("left-ratio", next);
  }, []);

  const onQueueResize = useCallback((delta: number) => {
    const next = Math.max(80, Math.min(500, queueRef.current - delta));
    setQueueH(next);
    queueRef.current = next;
    persist("queue-h", next);
  }, []);

  return (
    <div className="app-container">
      {/* Modal */}
      {showModal && (
        <ConnectionModal
          onClose={() => { setShowModal(false); setEditingConn(null); }}
          onSave={handleSaveConn}
          editing={editingConn}
        />
      )}

      {/* Sidebar */}
      <aside className="sidebar" style={{ width: sidebarW, minWidth: sidebarW }}>
        <div className="sidebar-header">
          <h2>Connections</h2>
          <button className="btn-icon btn-add" onClick={() => { setEditingConn(null); setShowModal(true); }} title="Add Connection">+</button>
        </div>

        <div
          className={`sidebar-item ${!selectedConnId ? 'active' : ''}`}
          onClick={() => setSelectedConnId(null)}
        >
          <span>💻 Local System</span>
        </div>

        {config.ftp_connections.map((c) => (
          <div
            key={c.id}
            className={`sidebar-item ${selectedConnId === c.id ? 'active' : ''}`}
            onClick={() => setSelectedConnId(c.id)}
            title={`${c.host}:${c.port}${c.secure ? ' (FTPS)' : ''}`}
          >
            <span style={{ flex: 1 }}>
              {c.secure ? '🔒' : '🌐'} {c.name}
            </span>
            <button
              className="btn-icon btn-edit"
              onClick={(e) => { e.stopPropagation(); setEditingConn(c); setShowModal(true); }}
              title="Edit connection"
            >✎</button>
            <button
              className="btn-icon btn-delete"
              onClick={(e) => { e.stopPropagation(); handleDeleteConn(c.id); }}
              title="Remove connection"
            >✕</button>
          </div>
        ))}
      </aside>

      <Resizer direction="col" onResize={onSidebarResize} />

      {/* Main Content */}
      <main className="main-content">
        <header className="header">
          <h1>QuickSync Drives</h1>
          <div className="header-status">
            <span className={`status-badge ${connectionStatus.includes("Connected") ? "status-ok" : ""}`}>
              {connectionStatus}
            </span>
          </div>
        </header>

        {/* Split Panes */}
        <section className="panes-container" ref={panesRef}>
          <div className="pane" style={{ flex: `0 0 ${leftRatio}%` }}>
            <div className="pane-header">
              <span>Local Files</span>
            </div>
            {homePath && <FileTree rootPath={homePath} />}
          </div>

          <Resizer direction="col" onResize={onPaneResize} />

          <div className="pane" style={{ flex: 1 }}>
            <div className="pane-header">
              <span>{selectedConn ? `Remote: ${selectedConn.name}` : 'Remote Files'}</span>
              {selectedConn && (
                <div style={{ display: 'flex', gap: '6px' }}>
                  {connectionStatus.includes('connected') || connectionStatus.includes('Connected') ? (
                    <button className="btn-small btn-danger" onClick={handleDisconnect}>Disconnect</button>
                  ) : (
                    <button className="btn-small btn-connect" onClick={handleConnect}>Connect</button>
                  )}
                </div>
              )}
            </div>
            {selectedConn ? (
              connectionStatus.includes('connected') || connectionStatus.includes('Connected') ? (
                <RemoteFileTree onTransferMsg={(msg) => setTransferMsgs((prev) => [...prev, msg])} />
              ) : (
                <div className="connection-info">
                  <div className="conn-detail"><span>Host</span><span>{selectedConn.host}:{selectedConn.port}</span></div>
                  <div className="conn-detail"><span>User</span><span>{selectedConn.username}</span></div>
                  <div className="conn-detail"><span>Security</span><span>{selectedConn.secure ? '🔒 FTPS' : '🔓 Plain FTP'}</span></div>
                  <div className="conn-status">{connectionStatus}</div>
                </div>
              )
            ) : (
              <div className="pane-empty">
                <p>Select a connection from the sidebar to browse remote files.</p>
              </div>
            )}
          </div>
        </section>

        {/* Queue */}
        <Resizer direction="row" onResize={onQueueResize} />
        <footer className="queue-panel" style={{ height: queueH, minHeight: queueH }}>
          <div className="queue-header">Transfer Queue</div>
          {transferMsgs.length === 0 ? (
            <div className="queue-empty">No active transfers.</div>
          ) : (
            <div className="queue-list">
              {transferMsgs.map((msg, i) => (
                <div key={i} className="queue-item">{msg}</div>
              ))}
            </div>
          )}
        </footer>
      </main>
    </div>
  );
}

export default App;
