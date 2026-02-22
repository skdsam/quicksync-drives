import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useConfigStore, FtpConnection, CloudConnection } from "./store/config";
import logo from "./assets/logo.png";
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
  size: number | null;
  last_modified: string | null;
  id?: string;
}

interface TreeNode extends FileEntry {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

interface TransferProgress {
  transfer_id: string;
  filename: string;
  progress: number;
  total: number;
  status: string;
}

/* ───────── Helpers ───────── */
function formatSize(size: number | null): string {
  if (size === null || size === 0) return "-";
  const i = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, i)).toFixed(2)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}

function ProgressItem({ transfer }: { transfer: TransferProgress }) {
  const percent = transfer.total > 0 ? (transfer.progress / transfer.total) * 100 : 0;

  return (
    <div className="progress-item">
      <div className="progress-info">
        <span className="progress-filename" title={transfer.filename}>{transfer.filename}</span>
        <span className="progress-status">
          {transfer.status === 'complete' ? 'Complete' : `${formatSize(transfer.progress)} / ${formatSize(transfer.total)}`}
        </span>
      </div>
      <div className="progress-bar-container">
        <div
          className={`progress-bar-fill ${transfer.status}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function persist(key: string, value: number) {
  localStorage.setItem(`qs-${key}`, String(value));
}
function restore(key: string, fallback: number): number {
  const v = localStorage.getItem(`qs-${key}`);
  return v ? Number(v) : fallback;
}

// Import common icons
const dirIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style={{ opacity: 0.8, color: "var(--warning-color)" }}>
    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
  </svg>
);
const defaultFileIcon = '📄';

const googleIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <path fill="#4285F4" d="M15.418 5L22.5 17.5l-3.55 6.188L11.85 11.188z" />
    <path fill="#34A853" d="M1.5 17.5L8.582 5h7.082l-7.082 12.5z" />
    <path fill="#FBBC05" d="M8.582 17.5L1.5 17.5L5.05 11.188h14.15z" />
  </svg>
);

const dropboxIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="#0061FF">
    <path d="M6 2L1 5.4L6 8.8L11 5.4L6 2Z" />
    <path d="M18 2L13 5.4L18 8.8L23 5.4L18 2Z" />
    <path d="M6 15.6L1 12.2L6 8.8L11 12.2L6 15.6Z" />
    <path d="M18 15.6L13 12.2L18 8.8L23 12.2L18 15.6Z" />
    <path d="M6 16.6L11 20L16 16.6L11 13.2L6 16.6Z" />
  </svg>
);

/* ───────── FileTree component ───────── */
function FileTree({ rootPath, onTransferMsg, onDragOverPanel, refreshKey }: {
  rootPath: string,
  onTransferMsg: (msg: string) => void,
  onDragOverPanel?: () => void,
  refreshKey?: number
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, entry: FileEntry | null } | null>(null);

  const onContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const handleDelete = async (entry: FileEntry) => {
    if (!window.confirm(`Are you sure you want to delete local ${entry.is_dir ? 'folder' : 'file'} "${entry.name}"?`)) return;
    try {
      onTransferMsg(`Deleting ${entry.name}…`);
      const result = await invoke<string>("delete_local_file", { path: entry.path });
      onTransferMsg(result);
      loadDir(currentPath).then(setTree);
    } catch (err: any) {
      onTransferMsg(`Delete error: ${err}`);
    }
  };

  // Icon cache structure mapping extension to base64
  const [iconCache, setIconCache] = useState<Record<string, string>>({});

  const getFileIcon = async (filename: string): Promise<string | null> => {
    const extMatch = filename.match(/\.([^.]+)$/);
    if (!extMatch) return null;
    const ext = extMatch[1].toLowerCase();

    // Check cache
    if (iconCache[ext] !== undefined) return iconCache[ext];

    try {
      const base64Icon = await invoke<string>("get_file_icon", { ext });
      setIconCache(prev => ({ ...prev, [ext]: base64Icon }));
      return base64Icon;
    } catch {
      // Cache null if failed so we don't spam errors
      setIconCache(prev => ({ ...prev, [ext]: "" }));
      return null;
    }
  };

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
  }, [currentPath, loadDir, refreshKey]);

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

  const filteredTree = tree.filter(node =>
    node.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
            onContextMenu={(e) => onContextMenu(e, node)}
          >
            <div className="tree-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {node.is_dir ? (node.expanded ? "📂" : dirIcon) : (
                <FileIconRenderer filename={node.name} iconCache={iconCache} getFileIcon={getFileIcon} />
              )}
            </div>
            <span className="tree-name">{node.name}</span>
            {!node.is_dir && <span className="tree-size">{formatSize(node.size)}</span>}
            {node.loading && <span className="tree-loading">…</span>}
          </div>
          {node.expanded && node.children && renderNodes(node.children, path, depth + 1)}
        </div>
      );
    });
  };

  const visibleNodes = searchQuery ? filteredTree : tree;

  // Navigate up
  const goUp = () => {
    const parent = currentPath.replace(/[\\/][^\\/]*$/, "");
    if (parent && parent !== currentPath) setCurrentPath(parent);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onTransferMsg("DEBUG: Local handleDrop event detected");
    setDragging(false);
    const files = e.dataTransfer.files;
    onTransferMsg(`DEBUG: Local files count: ${files.length}`);
    if (!files.length) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = (file as any).path;
      if (!filePath) {
        onTransferMsg(`Cannot copy ${file.name} — no path available`);
        continue;
      }

      try {
        onTransferMsg(`Copying ${file.name} to local folder…`);
        const result = await invoke<string>("copy_to_local", {
          sourcePath: filePath,
          destDir: currentPath,
        });
        onTransferMsg(result);
      } catch (err: any) {
        onTransferMsg(`Local Copy error: ${err}`);
      }
    }
    // Refresh
    loadDir(currentPath).then(setTree);
  };

  return (
    <div
      className={`file-tree ${dragging ? 'file-tree-dragover' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); onDragOverPanel?.(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); onDragOverPanel?.(); }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); }}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      <div className="tree-toolbar">
        <button className="btn-icon" onClick={goUp} title="Go up">⬆</button>
        <div className="search-container">
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button className="btn-clear-search" onClick={() => setSearchQuery("")}>✕</button>
          )}
        </div>
        <button className="btn-icon" onClick={() => loadDir(currentPath).then(setTree)} title="Refresh">↻</button>
      </div>
      <div className="tree-list">
        {error && <div className="tree-error">{error}</div>}
        {!error && visibleNodes.length === 0 && (
          <div className="tree-empty">{searchQuery ? "No matches found" : "Empty directory"}</div>
        )}
        {dragging && <div className="drop-indicator">Drop to Copy to Local</div>}
        {renderNodes(visibleNodes)}

        {contextMenu && contextMenu.entry && (
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="context-menu-header">{contextMenu.entry.name}</div>
            <div className="context-menu-item" onClick={() => { setContextMenu(null); navigator.clipboard.writeText(contextMenu.entry!.path); onTransferMsg("Path copied"); }}>Copy Path</div>
            <div className="context-menu-divider" />
            <div className="context-menu-item text-danger" onClick={() => { setContextMenu(null); handleDelete(contextMenu.entry!); }}>Delete</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────── RemoteFileTree component ───────── */
function RemoteFileTree({ onTransferMsg, downloadDir, cloudConfig, onDragOverPanel, onPathChange, refreshKey }: {
  onTransferMsg: (msg: string) => void,
  downloadDir: string,
  cloudConfig?: CloudConnection,
  onDragOverPanel?: () => void,
  onPathChange?: (path: string) => void,
  refreshKey?: number
}) {
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [remotePath, setRemotePath] = useState("/");
  const [pathStack, setPathStack] = useState<{ id: string, name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Icon cache
  const [iconCache, setIconCache] = useState<Record<string, string>>({});

  const getFileIcon = async (filename: string): Promise<string | null> => {
    const extMatch = filename.match(/\.([^.]+)$/);
    if (!extMatch) return null;
    const ext = extMatch[1].toLowerCase();

    // Check cache
    if (iconCache[ext] !== undefined) return iconCache[ext];

    try {
      const base64Icon = await invoke<string>("get_file_icon", { ext });
      setIconCache(prev => ({ ...prev, [ext]: base64Icon }));
      return base64Icon;
    } catch {
      // Cache null if failed so we don't spam errors
      setIconCache(prev => ({ ...prev, [ext]: "" }));
      return null;
    }
  };

  // Context Menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: RemoteEntry | null;
  } | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const loadRemoteDir = useCallback(async (path?: string, dirName?: string) => {
    setLoading(true);
    setError(null);
    try {
      let files: RemoteEntry[];
      let pwd = "";

      if (cloudConfig) {
        // Cloud Provider
        const isUp = path === "..";
        const folderId = isUp
          ? (pathStack.length > 1 ? pathStack[pathStack.length - 2].id : null)
          : (path ?? null);

        files = await invoke<RemoteEntry[]>("list_cloud_directory", {
          provider: cloudConfig.provider,
          token: cloudConfig.access_token,
          folderId: folderId
        });

        let nextStack = pathStack;
        if (isUp) {
          nextStack = pathStack.slice(0, -1);
          setPathStack(nextStack);
        } else if (path && dirName) {
          nextStack = [...pathStack, { id: path, name: dirName }];
          setPathStack(nextStack);
        } else if (!path) {
          nextStack = [];
          setPathStack([]);
        }

        pwd = nextStack.length === 0 ? "/ (Cloud Root)" : "Root / " + nextStack.map(s => s.name).join(" / ");
      } else {
        // Standard FTP
        files = await invoke<RemoteEntry[]>("list_remote_directory", { path: path ?? null });
        pwd = await invoke<string>("get_remote_pwd");
      }

      setEntries(files);
      setRemotePath(pwd);
      onPathChange?.(pwd);
    } catch (err: any) {
      setError(String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [cloudConfig, pathStack]);

  useEffect(() => {
    // Only auto-load on first mount or config change
    loadRemoteDir();
  }, [cloudConfig, refreshKey]); // Trigger only on config change to avoid infinite loops with pathStack dependency

  const navigateTo = (entry: RemoteEntry) => {
    if (cloudConfig) {
      if (entry.id) {
        loadRemoteDir(entry.id, entry.name);
      }
    } else {
      loadRemoteDir(entry.name);
    }
  };
  const goUp = () => loadRemoteDir("..");

  const handleDownload = async (entry: RemoteEntry) => {
    try {
      onTransferMsg(`Downloading ${entry.name}…`);
      const localPath = `${downloadDir}\\${entry.name}`;

      let result = "";
      if (cloudConfig) {
        if (!entry.id) throw new Error("Cloud entry missing ID.");
        result = await invoke<string>("download_cloud_file", {
          provider: cloudConfig.provider,
          token: cloudConfig.access_token,
          fileId: entry.id,
          localPath,
        });
      } else {
        result = await invoke<string>("download_remote_file", {
          remoteName: entry.name,
          localPath,
        });
      }
      onTransferMsg(result);
    } catch (err: any) {
      onTransferMsg(`Download error: ${err}`);
    }
  };

  const handleDownloadFolder = async (folderName: string, localBaseDir?: string) => {
    try {
      onTransferMsg(`Downloading folder ${folderName}…`);
      const baseDir = localBaseDir || downloadDir;
      const localFolder = `${baseDir}\\${folderName}`;

      const result = await invoke<string>("download_remote_folder", {
        remoteDir: folderName,
        localDir: localFolder,
      });

      onTransferMsg(result);
    } catch (err: any) {
      onTransferMsg(`Download Folder error: ${err}`);
    }
  };

  const handleDelete = async (entry: RemoteEntry) => {
    if (!window.confirm(`Are you sure you want to delete ${entry.name}?`)) return;
    try {
      onTransferMsg(`Deleting ${entry.name}…`);
      let result = "";
      if (cloudConfig) {
        if (!entry.id) {
          onTransferMsg("Cannot delete: cloud entry ID is missing.");
          return;
        }
        result = await invoke<string>("delete_cloud_file", {
          provider: cloudConfig.provider,
          token: cloudConfig.access_token,
          fileId: entry.id,
        });
      } else {
        if (entry.is_dir) {
          result = await invoke<string>("delete_remote_dir", { path: entry.name });
        } else {
          result = await invoke<string>("delete_remote_file", { path: entry.name });
        }
      }
      onTransferMsg(result);
      loadRemoteDir();
    } catch (err: any) {
      onTransferMsg(`Delete error: ${err}`);
    }
  };

  const handleRename = async (entry: RemoteEntry) => {
    const newName = window.prompt(`Rename ${entry.name} to:`, entry.name);
    if (!newName || newName === entry.name) return;
    try {
      onTransferMsg(`Renaming ${entry.name} to ${newName}…`);
      let result = "";
      if (cloudConfig) {
        onTransferMsg("Cloud rename not yet implemented.");
        return;
      } else {
        result = await invoke<string>("rename_remote_file", {
          oldPath: entry.name,
          newPath: newName
        });
      }
      onTransferMsg(result);
      loadRemoteDir();
    } catch (err: any) {
      onTransferMsg(`Rename error: ${err}`);
    }
  };

  const handleCopyPath = async (entry: RemoteEntry) => {
    const fullPath = remotePath.endsWith("/")
      ? `${remotePath}${entry.name}`
      : `${remotePath}/${entry.name}`;

    try {
      await navigator.clipboard.writeText(fullPath);
      onTransferMsg(`Copied path: ${fullPath}`);
    } catch (err) {
      onTransferMsg("Failed to copy path.");
    }
  };

  const handleCopyFile = async (entry: RemoteEntry) => {
    if (cloudConfig) {
      onTransferMsg("Cloud copying is not yet implemented.");
      return;
    }

    if (entry.is_dir) {
      onTransferMsg("Copying directories is not yet supported.");
      return;
    }
    const newName = window.prompt(`Copy ${entry.name} as:`, `Copy_of_${entry.name}`);
    if (!newName) return;

    try {
      onTransferMsg(`Copying ${entry.name} to ${newName} (this may take a while)…`);
      // 1. Download to temp
      const tempPath = `${downloadDir}\\.quicksync_temp_${entry.name}`;
      await invoke<string>("download_remote_file", {
        remoteName: entry.name,
        localPath: tempPath,
      });
      // 2. Upload with new name
      const result = await invoke<string>("upload_file", {
        localPath: tempPath,
        remoteName: newName,
      });
      onTransferMsg(`Copy complete: ${result}`);
      loadRemoteDir();
    } catch (err: any) {
      onTransferMsg(`Copy error: ${err}`);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onTransferMsg("DEBUG: Remote handleDrop event detected");
    setDragging(false);
    const files = e.dataTransfer.files;
    onTransferMsg(`DEBUG: Remote files count: ${files.length}`);
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
        let result = "";

        if (cloudConfig) {
          // Note: remotePath actually tracks the current folder ID or "root" in cloud mode
          const parentId = remotePath === "/ (Cloud Root)" || remotePath === "" ? null : remotePath;
          result = await invoke<string>("upload_cloud_file", {
            provider: cloudConfig.provider,
            token: cloudConfig.access_token,
            localPath: filePath,
            remoteParentId: parentId,
          });
        } else {
          result = await invoke<string>("upload_file", {
            localPath: filePath,
            remoteName: file.name,
          });
        }
        onTransferMsg(result);
      } catch (err: any) {
        onTransferMsg(`Upload error: ${err}`);
      }
    }
    loadRemoteDir();
  };

  const filteredEntries = entries.filter(entry =>
    entry.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div
      className={`file-tree ${dragging ? 'file-tree-dragover' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); onDragOverPanel?.(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); onDragOverPanel?.(); }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); }}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      <div className="tree-toolbar">
        <button className="btn-icon" onClick={goUp} title="Go up">⬆</button>
        <div className="search-container">
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button className="btn-clear-search" onClick={() => setSearchQuery("")}>✕</button>
          )}
        </div>
        <button className="btn-icon" onClick={() => loadRemoteDir()} title="Refresh">↻</button>
      </div>
      <div className="tree-list">
        {loading && <div className="tree-loading-msg">Loading…</div>}
        {error && <div className="tree-error">{error}</div>}
        {!loading && !error && filteredEntries.length === 0 && (
          <div className="tree-empty">{searchQuery ? "No matches found" : "Empty directory"}</div>
        )}
        {dragging && <div className="drop-indicator">Drop files here to upload</div>}
        {filteredEntries.map((entry) => (
          <div
            key={entry.name}
            className="tree-row"
            onClick={() => entry.is_dir && navigateTo(entry)}
            onDoubleClick={() => !entry.is_dir && handleDownload(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.pageX, y: e.pageY, entry });
            }}
            style={{ cursor: entry.is_dir ? 'pointer' : 'default' }}
            title={entry.is_dir ? 'Click to open' : 'Double-click to download. Right-click for options.'}
          >
            <div className="tree-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {entry.is_dir ? dirIcon : (
                <FileIconRenderer filename={entry.name} iconCache={iconCache} getFileIcon={getFileIcon} />
              )}
            </div>
            <span className="tree-name">{entry.name}</span>
            {!entry.is_dir && <span className="tree-size">{formatSize(entry.size)}</span>}
            {!entry.is_dir && (
              <button
                className="btn-icon btn-download"
                onClick={(e) => { e.stopPropagation(); handleDownload(entry); }}
                title="Download"
              >⬇</button>
            )}
          </div>
        ))}

        {contextMenu && contextMenu.entry && (
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="context-menu-header">{contextMenu.entry.name}</div>

            {contextMenu.entry.is_dir ? (
              <div className="context-menu-item" onClick={() => { setContextMenu(null); handleDownloadFolder(contextMenu.entry!.name); }}>Download Folder</div>
            ) : (
              <div className="context-menu-item" onClick={() => { setContextMenu(null); handleDownload(contextMenu.entry!); }}>Download File</div>
            )}

            <div className="context-menu-item" onClick={() => { setContextMenu(null); handleRename(contextMenu.entry!); }}>Rename</div>
            <div className="context-menu-item" onClick={() => { setContextMenu(null); handleCopyPath(contextMenu.entry!); }}>Copy Path</div>

            {!contextMenu.entry.is_dir && (
              <div className="context-menu-item" onClick={() => { setContextMenu(null); handleCopyFile(contextMenu.entry!); }}>Copy File</div>
            )}

            <div className="context-menu-divider" />
            <div className="context-menu-item text-danger" onClick={() => { setContextMenu(null); handleDelete(contextMenu.entry!); }}>Delete</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Separate component to handle individual file icon rendering asynchronously without blocking UI
function FileIconRenderer({
  filename,
  iconCache,
  getFileIcon
}: {
  filename: string,
  iconCache: Record<string, string>,
  getFileIcon: (filename: string) => Promise<string | null>
}) {
  const extMatch = filename.match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : null;
  const cachedIcon = ext ? iconCache[ext] : undefined;

  useEffect(() => {
    if (ext && cachedIcon === undefined) {
      getFileIcon(filename).catch(() => { });
    }
  }, [ext, cachedIcon, filename, getFileIcon]);

  if (cachedIcon) {
    return <img src={cachedIcon} alt="icon" style={{ width: 16, height: 16 }} />;
  }

  return <span>{defaultFileIcon}</span>;
}

/* ───────── Resizer component ───────── */
function Resizer({ direction, onResize }: { direction: "col" | "row"; onResize: (delta: number) => void }) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    let startPos = direction === "col" ? e.clientX : e.clientY;
    const onMove = (ev: MouseEvent) => {
      const currentPos = direction === "col" ? ev.clientX : ev.clientY;
      const delta = currentPos - startPos;
      startPos = currentPos;
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
function ConnectionModal({ onClose, onSaveFtp, onSaveCloud, editingFtp, editingCloud }: {
  onClose: () => void;
  onSaveFtp: (conn: FtpConnection) => void;
  onSaveCloud: (conn: CloudConnection) => void;
  editingFtp?: FtpConnection | null;
  editingCloud?: CloudConnection | null;
}) {
  const isEditingCloud = !!editingCloud;
  const [type, setType] = useState<"ftp" | "cloud">(isEditingCloud ? "cloud" : "ftp");

  // FTP State
  const [name, setName] = useState(editingFtp?.name || "");
  const [host, setHost] = useState(editingFtp?.host || "");
  const [port, setPort] = useState(editingFtp?.port || 21);
  const [username, setUsername] = useState(editingFtp?.username || "");
  const [password, setPassword] = useState(editingFtp?.password || "");
  const [secure, setSecure] = useState(editingFtp?.secure || false);

  // Cloud State
  const [provider, setProvider] = useState(editingCloud?.provider || "google");
  const [accountName, setAccountName] = useState(editingCloud?.account_name || "");
  const [accessToken, setAccessToken] = useState(editingCloud?.access_token || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (type === "ftp") {
      onSaveFtp({
        id: editingFtp?.id || Date.now().toString(),
        name: name || `${host}:${port}`,
        host,
        port,
        username,
        password: password || undefined,
        secure,
      });
      onClose();
    } else if (type === "cloud") {
      onSaveCloud({
        id: editingCloud?.id || Date.now().toString(),
        provider,
        account_name: accountName || `${provider} Account`,
        access_token: accessToken,
      });
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-header">
          <h2>
            {editingFtp ? "Edit FTP Connection" : editingCloud ? "Edit Cloud Connection" : "New Connection"}
          </h2>
          <button type="button" className="btn-close" onClick={onClose}>✕</button>
        </div>

        {!editingFtp && !editingCloud && (
          <div className="form-toggle-group">
            <button
              type="button"
              className={`btn-toggle ${type === "ftp" ? "active" : ""}`}
              onClick={() => setType("ftp")}
            >
              FTP Server
            </button>
            <button
              type="button"
              className={`btn-toggle ${type === "cloud" ? "active" : ""}`}
              onClick={() => setType("cloud")}
            >
              Cloud Storage
            </button>
          </div>
        )}

        <div className="form-grid" style={{ marginTop: 16 }}>
          {type === "ftp" ? (
            <>
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
            </>
          ) : (
            <>
              <label>Provider *</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="google">Google Drive</option>
                <option value="dropbox">Dropbox</option>
              </select>

              <label>Account Name</label>
              <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Personal Drive" />

              <label>Access Token *</label>
              <input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="Paste your OAuth Access Token here" required />

              {provider === "google" && (
                <div style={{ gridColumn: "1 / -1", fontSize: "0.85em", marginTop: "4px", backgroundColor: "rgba(255,255,255,0.05)", padding: "8px", borderRadius: "4px" }}>
                  <strong>How to get a token:</strong><br />
                  1. Visit <a href="https://developers.google.com/oauthplayground/?scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive&step=1" target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)" }}>Google OAuth Playground</a>.<br />
                  2. Click <strong>Authorize APIs</strong> and log in with your Google Account.<br />
                  3. Click <strong>Exchange authorization code for tokens</strong>.<br />
                  4. Copy the resulting <strong>Access token</strong> and paste it above!
                </div>
              )}

              {provider === "dropbox" && (
                <div style={{ gridColumn: "1 / -1", fontSize: "0.85em", marginTop: "4px", backgroundColor: "rgba(255,255,255,0.05)", padding: "8px", borderRadius: "4px" }}>
                  <strong>How to get a token:</strong><br />
                  1. Visit <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)" }}>Dropbox App Console</a> and create an App.<br />
                  2. Choose <strong>Scoped Access</strong>, <strong>Full Dropbox</strong>, and name it.<br />
                  3. In the <strong>Permissions</strong> tab, check <code>files.metadata.read</code>, <code>files.content.read</code>, and <code>files.content.write</code>, then hit Submit.<br />
                  4. Back in the <strong>Settings</strong> tab, scroll down to OAuth 2 and click <strong>Generate</strong>.<br />
                  5. Copy your new Access Token and paste it above!
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-actions" style={{ flexDirection: "column", gap: "10px" }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', width: '100%', marginTop: '8px' }}>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary">
              {editingFtp || editingCloud ? "Save" : "Add Connection"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/* ───────── Main App ───────── */
function App() {
  const [connectionStatus, setConnectionStatus] = useState("Not Connected");
  const [showModal, setShowModal] = useState(false);
  const [editingFtp, setEditingFtp] = useState<FtpConnection | null>(null);
  const [editingCloud, setEditingCloud] = useState<CloudConnection | null>(null);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [homePath, setHomePath] = useState("");
  const [transferMsgs, setTransferMsgs] = useState<string[]>([]);
  const [downloadDir, setDownloadDir] = useState(() => localStorage.getItem("qs-download-dir") || "");
  const [currentRemotePath, setCurrentRemotePath] = useState("/");
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTransfers, setActiveTransfers] = useState<Record<string, TransferProgress>>({});

  const handleClearQueue = () => {
    setTransferMsgs([]);
    setActiveTransfers({});
  };

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
    invoke<string>("get_home_dir").then((home) => {
      if (!localStorage.getItem("qs-download-dir")) {
        const defaultDrop = `${home}\\Downloads`;
        setDownloadDir(defaultDrop);
        localStorage.setItem("qs-download-dir", defaultDrop);
      }
      setHomePath(home);
    }).catch(() => setHomePath("C:\\"));
  }, []);

  // Theme listener and application
  useEffect(() => {
    // Apply theme from config when loaded
    if (config.theme) {
      document.body.setAttribute('data-theme', config.theme);
    }
  }, [config.theme]);

  // Global UI polish
  useEffect(() => {
    // Disable native context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener("contextmenu", handleContextMenu);

    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);


  useEffect(() => {
    const unlisten = listen<string>("theme-changed", (event) => {
      const newTheme = event.payload;
      document.documentElement.setAttribute('data-theme', newTheme);
      saveConfig({ ...config, theme: newTheme });
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [config, saveConfig]);

  // Handle Transfer Progress Events
  useEffect(() => {
    const unlisten = listen<TransferProgress>("transfer-progress", (event) => {
      const p = event.payload;
      setActiveTransfers((prev) => {
        // If complete, we might want to keep it for a few seconds then remove
        if (p.status === 'complete') {
          // Trigger a refresh after upload completes
          setRefreshKey(k => k + 1);

          const next = { ...prev, [p.transfer_id]: p };
          setTimeout(() => {
            setActiveTransfers(curr => {
              const cleaned = { ...curr };
              delete cleaned[p.transfer_id];
              return cleaned;
            });
          }, 5000);
          return next;
        }
        return { ...prev, [p.transfer_id]: p };
      });
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /* ── Connection CRUD ── */
  const handleSaveFtp = (conn: FtpConnection) => {
    const existing = config.ftp_connections.findIndex((c) => c.id === conn.id);
    const updated = [...config.ftp_connections];
    if (existing >= 0) updated[existing] = conn;
    else updated.push(conn);
    saveConfig({ ...config, ftp_connections: updated });
  };

  const handleSaveCloud = (conn: CloudConnection) => {
    const existing = config.cloud_connections.findIndex((c) => c.id === conn.id);
    const updated = [...config.cloud_connections];
    if (existing >= 0) updated[existing] = conn;
    else updated.push(conn);
    saveConfig({ ...config, cloud_connections: updated });
  };

  const handleDeleteConn = (id: string, type: "ftp" | "cloud") => {
    if (selectedConnId === id) {
      setSelectedConnId(null);
    }

    if (type === "ftp") {
      saveConfig({ ...config, ftp_connections: config.ftp_connections.filter((c) => c.id !== id) });
    } else {
      saveConfig({ ...config, cloud_connections: config.cloud_connections.filter((c) => c.id !== id) });
    }
  };

  const selectedFtpConn = config.ftp_connections.find((c) => c.id === selectedConnId) || null;
  const selectedCloudConn = config.cloud_connections.find((c) => c.id === selectedConnId) || null;
  const activeConnName = selectedFtpConn ? selectedFtpConn.name : (selectedCloudConn ? selectedCloudConn.account_name : null);

  const handleConnect = async () => {
    if (selectedFtpConn) {
      setConnectionStatus("Connecting…");
      try {
        const result = await invoke<string>("connect_ftp", {
          config: {
            host: selectedFtpConn.host,
            port: selectedFtpConn.port,
            username: selectedFtpConn.username,
            password: selectedFtpConn.password || "",
            secure: selectedFtpConn.secure || false,
          },
        });
        setConnectionStatus(result);
      } catch (err: any) {
        setConnectionStatus(`Error: ${err}`);
      }
    } else if (selectedCloudConn) {
      setConnectionStatus("Connected to Cloud Storage");
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

  const handleBrowseDownloadDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: downloadDir,
        title: "Select Download Folder"
      });
      if (selected && typeof selected === "string") {
        setDownloadDir(selected);
        localStorage.setItem("qs-download-dir", selected);
      }
    } catch (err) {
      console.error("Failed to open folder picker", err);
    }
  };

  // Native DND (Tauri v2) — auto-detect target panel
  // Browser onDragOver events DON'T fire for external file drags in Tauri,
  // so we can't rely on lastDragTarget. Instead we check connection state:
  //   • If a remote connection is active → upload to remote
  //   • Otherwise → copy to local home directory
  useEffect(() => {
    const unlisten = listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      const paths = event.payload.paths;
      if (paths.length === 0) return;

      const isRemoteConnected =
        (connectionStatus.includes("connected") || connectionStatus.includes("Connected")) &&
        (selectedFtpConn || selectedCloudConn);

      for (const filePath of paths) {
        const fileName = filePath.split(/[\\/]/).pop() || "unknown";
        try {
          if (isRemoteConnected) {
            setTransferMsgs(prev => [...prev, `Uploading ${fileName} to remote…`]);
            let result = "";
            if (selectedCloudConn) {
              const parentId = (currentRemotePath === "/ (Cloud Root)" || currentRemotePath === "") ? null : currentRemotePath;
              result = await invoke<string>("upload_cloud_file", {
                provider: selectedCloudConn.provider,
                token: selectedCloudConn.access_token,
                localPath: filePath,
                remoteParentId: parentId,
              });
            } else {
              result = await invoke<string>("upload_file", {
                localPath: filePath,
                remoteName: fileName,
              });
            }
            setTransferMsgs(prev => [...prev, result]);
          } else {
            // No remote connection active → copy to local
            setTransferMsgs(prev => [...prev, `Copying ${fileName} to local…`]);
            const res = await invoke<string>("copy_to_local", {
              sourcePath: filePath,
              destDir: homePath,
            });
            setTransferMsgs(prev => [...prev, res]);
          }
        } catch (err) {
          setTransferMsgs(prev => [...prev, `Drop Error: ${err}`]);
        }
      }
      // Refresh panels after all drops processed
      setRefreshKey(k => k + 1);
    });
    return () => {
      unlisten.then(f => f());
    };
  }, [homePath, connectionStatus, selectedFtpConn, selectedCloudConn, currentRemotePath]);

  return (
    <div className="app-container">
      {/* Modal */}
      {showModal && (
        <ConnectionModal
          onClose={() => { setShowModal(false); setEditingFtp(null); setEditingCloud(null); }}
          onSaveFtp={handleSaveFtp}
          onSaveCloud={handleSaveCloud}
          editingFtp={editingFtp}
          editingCloud={editingCloud}
        />
      )}

      {/* Sidebar */}
      <aside className="sidebar" style={{ width: sidebarW, minWidth: sidebarW }}>
        <div className="sidebar-header">
          <h2>Connections</h2>
          <button className="btn-icon btn-add" onClick={() => { setEditingFtp(null); setEditingCloud(null); setShowModal(true); }} title="Add Connection">+</button>
        </div>

        <div
          className={`sidebar-item ${!selectedConnId ? 'active' : ''}`}
          onClick={() => { setSelectedConnId(null) }}
        >
          <div className="sidebar-icon">💻</div>
          <span>Local System</span>
        </div>

        {config.ftp_connections.map((c) => (
          <div
            key={c.id}
            className={`sidebar-item ${selectedConnId === c.id ? 'active' : ''}`}
            onClick={() => { setSelectedConnId(c.id) }}
            title={`${c.host}:${c.port}${c.secure ? ' (FTPS)' : ''}`}
          >
            <div className="sidebar-icon">
              {c.secure ? '🔒' : '🌐'}
            </div>
            <span style={{ flex: 1 }}>
              {c.name}
            </span>
            <button
              className="btn-icon btn-edit"
              onClick={(e) => { e.stopPropagation(); setEditingFtp(c); setShowModal(true); }}
              title="Edit connection"
            >✎</button>
            <button
              className="btn-icon btn-delete"
              onClick={(e) => { e.stopPropagation(); handleDeleteConn(c.id, "ftp"); }}
              title="Remove connection"
            >✕</button>
          </div>
        ))}

        {config.cloud_connections.map((c) => {
          const isEmail = c.account_name.includes('@');
          const displayName = isEmail ? (c.provider === 'google' ? 'Google Drive' : 'Dropbox') : c.account_name;

          return (
            <div
              key={c.id}
              className={`sidebar-item ${selectedConnId === c.id ? 'active' : ''}`}
              onClick={() => { setSelectedConnId(c.id) }}
              title={`${c.provider === 'google' ? 'Google Drive' : 'Dropbox'} - ${c.account_name}`}
            >
              <span className="sidebar-icon">
                {c.provider === 'google' ? googleIcon : dropboxIcon}
              </span>
              <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {displayName}
              </span>
              <button
                className="btn-icon btn-edit"
                onClick={(e) => { e.stopPropagation(); setEditingCloud(c); setShowModal(true); }}
                title="Edit connection"
              >✎</button>
              <button
                className="btn-icon btn-delete"
                onClick={(e) => { e.stopPropagation(); handleDeleteConn(c.id, "cloud"); }}
                title="Remove connection"
              >✕</button>
            </div>
          );
        })}
      </aside>

      <Resizer direction="col" onResize={onSidebarResize} />

      {/* Main Content */}
      <main className="main-content">
        <header className="header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <img src={logo} alt="Logo" style={{ width: '32px', height: '32px', objectFit: 'contain' }} />
            <h1>QuickSync Drives</h1>
          </div>
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
            {homePath && (
              <FileTree
                rootPath={homePath}
                onTransferMsg={(msg) => setTransferMsgs((prev) => [...prev, msg])}

                refreshKey={refreshKey}
              />
            )}
          </div>

          <Resizer direction="col" onResize={onPaneResize} />

          <div className="pane" style={{ flex: 1 }}>
            <div className="pane-header">
              <span>{activeConnName ? `Remote: ${activeConnName}` : 'Remote Files'}</span>
              {activeConnName && (
                <div style={{ display: 'flex', gap: '6px' }}>
                  {connectionStatus.includes('connected') || connectionStatus.includes('Connected') ? (
                    <button className="btn-small btn-danger" onClick={handleDisconnect}>Disconnect</button>
                  ) : (
                    <button className="btn-small btn-connect" onClick={handleConnect}>Connect</button>
                  )}
                </div>
              )}
            </div>
            {activeConnName ? (
              (connectionStatus.includes('connected') || connectionStatus.includes('Connected')) && selectedFtpConn ? (
                <RemoteFileTree
                  key={selectedConnId || 'ftp'}
                  onTransferMsg={(msg) => setTransferMsgs((prev) => [...prev, msg])}
                  downloadDir={downloadDir}

                  onPathChange={setCurrentRemotePath}
                  refreshKey={refreshKey}
                />
              ) : (connectionStatus.includes('connected') || connectionStatus.includes('Connected')) && selectedCloudConn ? (
                <RemoteFileTree
                  key={selectedConnId || 'cloud'}
                  cloudConfig={selectedCloudConn}
                  onTransferMsg={(msg) => setTransferMsgs((prev) => [...prev, msg])}
                  downloadDir={downloadDir}

                  onPathChange={setCurrentRemotePath}
                  refreshKey={refreshKey}
                />
              ) : (
                <div className="connection-info">
                  {selectedFtpConn && (
                    <>
                      <div className="conn-detail"><span>Host</span><span>{selectedFtpConn.host}:{selectedFtpConn.port}</span></div>
                      <div className="conn-detail"><span>User</span><span>{selectedFtpConn.username}</span></div>
                      <div className="conn-detail"><span>Security</span><span>{selectedFtpConn.secure ? '🔒 FTPS' : '🔓 Plain FTP'}</span></div>
                    </>
                  )}
                  {selectedCloudConn && (
                    <>
                      <div className="conn-detail"><span>Provider</span><span style={{ textTransform: 'capitalize' }}>{selectedCloudConn.provider}</span></div>
                      <div className="conn-detail"><span>Account</span><span>{selectedCloudConn.account_name}</span></div>
                      <div className="conn-detail"><span>Status</span><span>{selectedCloudConn.access_token ? "Token Active" : "No Token"}</span></div>
                    </>
                  )}
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
          <div className="queue-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span>Transfer Queue</span>
              {(transferMsgs.length > 0 || Object.keys(activeTransfers).length > 0) && (
                <button
                  className="btn-small btn-danger"
                  style={{ padding: '2px 8px', fontSize: '10px', textTransform: 'none', letterSpacing: 'normal' }}
                  onClick={handleClearQueue}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="download-dir-picker" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Download To:</span>
              <input
                type="text"
                readOnly
                value={downloadDir}
                style={{ fontSize: '11px', padding: '2px 8px', width: '200px', cursor: 'pointer' }}
                onClick={handleBrowseDownloadDir}
              />
              <button className="btn-secondary" style={{ padding: '2px 8px', fontSize: '11px' }} onClick={handleBrowseDownloadDir}>Browse</button>
            </div>
          </div>
          {transferMsgs.length === 0 && Object.keys(activeTransfers).length === 0 ? (
            <div className="queue-empty">No active transfers.</div>
          ) : (
            <div className="queue-list">
              {Object.values(activeTransfers).map((t) => (
                <ProgressItem key={t.transfer_id} transfer={t} />
              ))}
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
