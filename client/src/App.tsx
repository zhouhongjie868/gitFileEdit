import { diffLines } from "diff";
import { startTransition, useEffect, useState } from "react";
import type {
  BootstrapResponse,
  FileDetail,
  GitSettingsSummary,
  RepoEnvironmentOption,
  RepoFileSummary
} from "./types";

interface DiffRow {
  id: string;
  type: "added" | "removed" | "same";
  marker: "+" | "-" | " ";
  text: string;
}

interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  children: FileTreeNode[];
  file?: RepoFileSummary;
}

interface NamespaceOption {
  id: string;
  label: string;
}

const ROOT_NAMESPACE_ID = "__root__";
const DEFAULT_NAMESPACE_IDS_BY_ENVIRONMENT: Record<string, string[]> = {
  dev: ["finagent-tob-dev", "finagentservice-tob-dev"],
  sit: ["finagent-tob", "finagentservice-tob"],
  uat: ["finagent-tob-uat", "finagentservice-tob-uat"],
  prod: ["finagent-tob", "finagentservice-tob"]
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });

  if (!response.ok) {
    const fallbackText = await response.text();
    try {
      const payload = JSON.parse(fallbackText) as { error?: string };
      throw new Error(payload.error || "请求失败");
    } catch {
      throw new Error(fallbackText || "请求失败");
    }
  }

  return (await response.json()) as T;
}

function formatTime(isoTime: string | null): string {
  if (!isoTime) {
    return "未同步";
  }
  return new Date(isoTime).toLocaleString("zh-CN", {
    hour12: false
  });
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function splitPathSegments(value: string): string[] {
  return normalizePath(value).split("/").filter(Boolean);
}

function getPathWithinRoot(filePath: string, root: string): string | null {
  const fileSegments = splitPathSegments(filePath);
  const rootSegments = splitPathSegments(root);
  if (!fileSegments.length || !rootSegments.length || fileSegments.length < rootSegments.length) {
    return null;
  }

  for (let start = 0; start <= fileSegments.length - rootSegments.length; start += 1) {
    const matches = rootSegments.every(
      (segment, index) => fileSegments[start + index] === segment
    );
    if (matches) {
      return fileSegments.slice(start + rootSegments.length).join("/");
    }
  }

  return null;
}

function getNamespaceIdForFile(filePath: string, environmentRoot: string): string | null {
  const relativePath = getPathWithinRoot(filePath, environmentRoot);
  if (relativePath === null) {
    return null;
  }

  const segments = splitPathSegments(relativePath);
  if (segments.length <= 1) {
    return ROOT_NAMESPACE_ID;
  }

  return segments[0];
}

function getDefaultNamespaceOptions(environmentId: string): NamespaceOption[] {
  return (DEFAULT_NAMESPACE_IDS_BY_ENVIRONMENT[environmentId] ?? []).map((item) => ({
    id: item,
    label: item
  }));
}

function scanNamespaceOptions(
  files: RepoFileSummary[],
  environmentRoot: string
): NamespaceOption[] {
  const namespaces = new Map<string, NamespaceOption>();

  for (const file of files) {
    const namespaceId = getNamespaceIdForFile(file.path, environmentRoot);
    if (!namespaceId) {
      continue;
    }

    if (!namespaces.has(namespaceId)) {
      namespaces.set(namespaceId, {
        id: namespaceId,
        label: namespaceId === ROOT_NAMESPACE_ID ? "根目录" : namespaceId
      });
    }
  }

  return Array.from(namespaces.values()).sort((left, right) => {
    if (left.id === ROOT_NAMESPACE_ID) {
      return -1;
    }
    if (right.id === ROOT_NAMESPACE_ID) {
      return 1;
    }
    return left.label.localeCompare(right.label, "zh-CN");
  });
}

function getNamespaceOptions(
  environmentId: string,
  files: RepoFileSummary[],
  environmentRoot: string
): NamespaceOption[] {
  const merged = new Map<string, NamespaceOption>();

  for (const item of getDefaultNamespaceOptions(environmentId)) {
    merged.set(item.id, item);
  }

  for (const item of scanNamespaceOptions(files, environmentRoot)) {
    if (!merged.has(item.id)) {
      merged.set(item.id, item);
    }
  }

  return Array.from(merged.values());
}

function getPathWithinNamespace(
  filePath: string,
  environmentRoot: string,
  namespaceId: string
): string | null {
  const relativePath = getPathWithinRoot(filePath, environmentRoot);
  if (relativePath === null) {
    return null;
  }

  const segments = splitPathSegments(relativePath);
  if (namespaceId === ROOT_NAMESPACE_ID) {
    return segments.length <= 1 ? relativePath : null;
  }

  if (segments.length <= 1 || segments[0] !== namespaceId) {
    return null;
  }

  return segments.slice(1).join("/");
}

function replaceEnvironmentRoot(
  filePath: string,
  environments: RepoEnvironmentOption[],
  nextEnvironmentId: string
): string | null {
  const currentEnvironment = environments.find(
    (item) => getPathWithinRoot(filePath, item.root) !== null
  );
  const nextEnvironment = environments.find((item) => item.id === nextEnvironmentId);
  if (!currentEnvironment || !nextEnvironment) {
    return null;
  }

  const suffix = getPathWithinRoot(filePath, currentEnvironment.root);
  if (suffix === null) {
    return null;
  }

  return suffix ? `${nextEnvironment.root}/${suffix}` : nextEnvironment.root;
}

function buildFileTree(
  files: RepoFileSummary[],
  resolveRelativePath: (file: RepoFileSummary) => string | null,
  treeId: string
): FileTreeNode[] {
  const rootNode: FileTreeNode = {
    id: treeId,
    name: treeId.split("/").pop() || treeId,
    path: treeId,
    kind: "directory",
    children: []
  };

  for (const file of files) {
    const relativePath = resolveRelativePath(file);
    if (!relativePath) {
      continue;
    }

    const segments = relativePath.split("/").filter(Boolean);
    let currentNode = rootNode;

    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      const nextPath = `${currentNode.path}/${segment}`;
      let child = currentNode.children.find(
        (item) => item.name === segment && item.kind === (isFile ? "file" : "directory")
      );

      if (!child) {
        child = {
          id: isFile ? file.path : nextPath,
          name: segment,
          path: isFile ? file.path : nextPath,
          kind: isFile ? "file" : "directory",
          children: [],
          file: isFile ? file : undefined
        };
        currentNode.children.push(child);
        currentNode.children.sort((left, right) => {
          if (left.kind !== right.kind) {
            return left.kind === "directory" ? -1 : 1;
          }
          return left.name.localeCompare(right.name, "zh-CN");
        });
      }

      currentNode = child;
    });
  }

  return rootNode.children;
}

function FileTree(props: {
  nodes: FileTreeNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
  level?: number;
}): JSX.Element {
  const level = props.level ?? 0;

  return (
    <div className={`file-tree file-tree--level-${level}`}>
      {props.nodes.map((node) =>
        node.kind === "directory" ? (
          <details key={node.id} className="file-tree-folder" open>
            <summary
              className="file-tree-folder__summary"
              style={{ paddingLeft: `${12 + level * 18}px` }}
            >
              <span className="file-tree-folder__icon">▾</span>
              <span className="file-tree-folder__name">{node.name}</span>
            </summary>
            <div className="file-tree-folder__children">
              <FileTree
                nodes={node.children}
                selectedPath={props.selectedPath}
                onSelect={props.onSelect}
                level={level + 1}
              />
            </div>
          </details>
        ) : (
          <button
            key={node.id}
            className={`file-tree-file ${props.selectedPath === node.path ? "file-tree-file--active" : ""}`}
            onClick={() => props.onSelect(node.path)}
            style={{ paddingLeft: `${16 + level * 18}px` }}
          >
            <span className="file-tree-file__name">{node.name}</span>
            <span className="file-tree-file__meta">
              {node.file ? `${formatSize(node.file.size)} · ${formatTime(node.file.modifiedAt)}` : ""}
            </span>
          </button>
        )
      )}
    </div>
  );
}

function DiffView(props: {
  before: string;
  after: string;
  emptyText: string;
}): JSX.Element {
  const segments = diffLines(props.before, props.after);
  const rows: DiffRow[] = segments.flatMap((segment, index) => {
    const rawLines = segment.value.split("\n");
    if (segment.value.endsWith("\n")) {
      rawLines.pop();
      rawLines.push("");
    }

    return rawLines.map((line, lineIndex): DiffRow => ({
      id: `${index}-${lineIndex}`,
      type: segment.added ? "added" : segment.removed ? "removed" : "same",
      marker: segment.added ? "+" : segment.removed ? "-" : " ",
      text: line
    }));
  });

  const hasChange = rows.some((row) => row.type !== "same");
  if (!hasChange) {
    return <div className="empty-block">{props.emptyText}</div>;
  }

  return (
    <div className="diff-view">
      {rows.map((row) => (
        <div key={row.id} className={`diff-row diff-row--${row.type}`}>
          <span className="diff-marker">{row.marker}</span>
          <span className="diff-text">{row.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function ContentBlock(props: { content: string; emptyText: string }): JSX.Element {
  if (!props.content) {
    return <div className="empty-block">{props.emptyText}</div>;
  }

  return <pre className="content-block">{props.content}</pre>;
}

export default function App(): JSX.Element {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>("");
  const [selectedNamespace, setSelectedNamespace] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [gitForm, setGitForm] = useState({
    commitMessagePrefix: "",
    commitMessage: ""
  });
  const [settingsSeeded, setSettingsSeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  async function refreshBootstrap(preferredPath?: string, preserveForm = true): Promise<void> {
    const data = await requestJson<BootstrapResponse>("/api/bootstrap");
    const nextPath =
      preferredPath && data.files.some((file) => file.path === preferredPath)
        ? preferredPath
        : (data.selectedFile ?? "");
    const environmentOptions = data.config.environments;
    const derivedEnvironment =
      environmentOptions.find((item) => nextPath && getPathWithinRoot(nextPath, item.root) !== null)
        ?.id ||
      environmentOptions[0]?.id ||
      "";
    const derivedEnvironmentRoot =
      environmentOptions.find((item) => item.id === derivedEnvironment)?.root ?? "";
    const derivedNamespace =
      (nextPath && derivedEnvironmentRoot
        ? getNamespaceIdForFile(nextPath, derivedEnvironmentRoot)
        : null) ??
      ROOT_NAMESPACE_ID;
    const namespaceOptions = derivedEnvironmentRoot
      ? getNamespaceOptions(
          derivedEnvironment,
          data.files.filter((file) => getPathWithinRoot(file.path, derivedEnvironmentRoot) !== null),
          derivedEnvironmentRoot
        )
      : [];

    startTransition(() => {
      setBootstrap(data);
      setSelectedEnvironment((current) =>
        current && environmentOptions.some((item) => item.id === current)
          ? current
          : derivedEnvironment
      );
      setSelectedNamespace((current) =>
        current && namespaceOptions.some((item) => item.id === current)
          ? current
          : (namespaceOptions.find((item) => item.id === derivedNamespace)?.id ??
            namespaceOptions[0]?.id ??
            "")
      );
      setSelectedPath(nextPath);
      if (!settingsSeeded || !preserveForm) {
        setGitForm({
          commitMessagePrefix: data.gitSettings.commitMessagePrefix,
          commitMessage: ""
        });
        setSettingsSeeded(true);
      }
    });
  }

  async function refreshFile(pathValue: string, preserveDraft: boolean): Promise<void> {
    if (!pathValue) {
      startTransition(() => {
        setFileDetail(null);
        setEditorContent("");
        setEditorDirty(false);
      });
      return;
    }

    const detail = await requestJson<FileDetail>(
      `/api/file?path=${encodeURIComponent(pathValue)}`
    );

    startTransition(() => {
      setFileDetail(detail);
      if (!preserveDraft || !editorDirty) {
        setEditorContent(detail.content);
        setEditorDirty(false);
      }
    });
  }

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        await refreshBootstrap(undefined, false);
      } catch (fetchError) {
        setError((fetchError as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    void refreshFile(selectedPath, false).catch((fetchError) => {
      setError((fetchError as Error).message);
    });
  }, [selectedPath]);

  useEffect(() => {
    const stream = new EventSource("/api/stream");

    stream.addEventListener("repo-changed", () => {
      void (async () => {
        try {
          await refreshBootstrap(selectedPath);
          if (selectedPath) {
            await refreshFile(selectedPath, true);
          }
          setLiveNotice(editorDirty ? "仓库已更新，预览已刷新" : "仓库内容已同步刷新");
        } catch (fetchError) {
          setError((fetchError as Error).message);
        }
      })();
    });

    stream.onerror = () => {
      setLiveNotice("实时连接已中断，正在等待重连");
    };

    return () => {
      stream.close();
    };
  }, [selectedPath, editorDirty, settingsSeeded]);

  async function saveGitSettings(): Promise<void> {
    const response = await requestJson<{ gitSettings: GitSettingsSummary }>("/api/settings/git", {
      method: "POST",
      body: JSON.stringify({
        commitMessagePrefix: gitForm.commitMessagePrefix
      })
    });

    startTransition(() => {
      setBootstrap((current) =>
        current
          ? {
              ...current,
              gitSettings: response.gitSettings
            }
          : current
      );
      setGitForm((current) => ({
        ...current,
        commitMessagePrefix: response.gitSettings.commitMessagePrefix
      }));
    });
  }

  async function saveCurrentFile(): Promise<void> {
    if (!selectedPath) {
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const detail = await requestJson<FileDetail>("/api/file", {
        method: "PUT",
        body: JSON.stringify({
          path: selectedPath,
          content: editorContent
        })
      });

      startTransition(() => {
        setFileDetail(detail);
        setEditorContent(detail.content);
        setEditorDirty(false);
      });
      setMessage("文件已保存到工作区");
      await refreshBootstrap(selectedPath);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function commitAndPush(): Promise<void> {
    if (!selectedPath) {
      return;
    }

    setCommitting(true);
    setError(null);
    setMessage(null);

    try {
      await saveGitSettings();
      if (editorDirty) {
        await requestJson<FileDetail>("/api/file", {
          method: "PUT",
          body: JSON.stringify({
            path: selectedPath,
            content: editorContent
          })
        });
        setEditorDirty(false);
      }

      await requestJson<{ head: string; path: string }>("/api/commit", {
        method: "POST",
        body: JSON.stringify({
          path: selectedPath,
          message: gitForm.commitMessage
        })
      });

      await refreshBootstrap(selectedPath);
      await refreshFile(selectedPath, false);
      setGitForm((current) => ({
        ...current,
        commitMessage: ""
      }));
      setMessage("修改已提交并推送到远程仓库");
    } catch (commitError) {
      setError((commitError as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  async function syncRepository(): Promise<void> {
    setSyncing(true);
    setError(null);
    setMessage(null);

    try {
      await requestJson<BootstrapResponse>("/api/repo/sync", {
        method: "POST"
      });
      await refreshBootstrap(selectedPath || undefined);
      if (selectedPath) {
        await refreshFile(selectedPath, true);
      }
      setMessage("仓库已同步");
    } catch (syncError) {
      setError((syncError as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const files: RepoFileSummary[] = bootstrap?.files ?? [];
  const environmentOptions = bootstrap?.config.environments ?? [];
  const activeEnvironment =
    environmentOptions.find((item) => item.id === selectedEnvironment) ?? environmentOptions[0];
  const environmentFiles = activeEnvironment
    ? files.filter((file) => getPathWithinRoot(file.path, activeEnvironment.root) !== null)
    : files;
  const namespaceOptions = activeEnvironment
    ? getNamespaceOptions(activeEnvironment.id, environmentFiles, activeEnvironment.root)
    : [];
  const activeNamespace =
    namespaceOptions.find((item) => item.id === selectedNamespace) ?? namespaceOptions[0] ?? null;
  const visibleFiles =
    activeEnvironment && activeNamespace
      ? environmentFiles.filter(
          (file) => getPathWithinNamespace(file.path, activeEnvironment.root, activeNamespace.id) !== null
        )
      : environmentFiles;
  const fileTree =
    activeEnvironment && activeNamespace
      ? buildFileTree(
          visibleFiles,
          (file) => getPathWithinNamespace(file.path, activeEnvironment.root, activeNamespace.id),
          `${activeEnvironment.root}/${activeNamespace.id}`
        )
      : activeEnvironment
        ? buildFileTree(
            environmentFiles,
            (file) => getPathWithinRoot(file.path, activeEnvironment.root),
            activeEnvironment.root
          )
        : [];
  const repoReady = bootstrap?.repoStatus.ready ?? false;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Git File Console</p>
          <h1>配置文件在线展示与提交</h1>
          <p className="hero-text">
            按环境切换查看配置文件，支持实时刷新、在线修改、提交并推送。
          </p>
        </div>
        <div className="hero-card">
          <span className={`status-dot ${repoReady ? "status-dot--ok" : "status-dot--warn"}`} />
          <div>
            <strong>{repoReady ? "仓库可用" : "仓库未就绪"}</strong>
            <div className="muted-text">
              上次同步 {formatTime(bootstrap?.repoStatus.lastSyncedAt ?? null)}
            </div>
          </div>
        </div>
      </header>

      <div className="page-grid">
        <aside className="panel sidebar">
          <div className="panel-title-row">
            <h2>文件列表</h2>
            <button className="secondary-button" onClick={() => void syncRepository()} disabled={syncing}>
              {syncing ? "同步中..." : "同步仓库"}
            </button>
          </div>

          <label className="form-row">
            <span>当前环境</span>
            <select
              value={activeEnvironment?.id ?? ""}
              onChange={(event) => {
                const nextEnvironmentId = event.target.value;
                setSelectedEnvironment(nextEnvironmentId);
                const nextEnvironment = environmentOptions.find(
                  (item) => item.id === nextEnvironmentId
                );
                const nextEnvironmentFiles = nextEnvironment
                  ? files.filter((file) => getPathWithinRoot(file.path, nextEnvironment.root) !== null)
                  : [];
                const nextNamespaceOptions = nextEnvironment
                  ? getNamespaceOptions(
                      nextEnvironment.id,
                      nextEnvironmentFiles,
                      nextEnvironment.root
                    )
                  : [];
                const replacedPath = selectedPath
                  ? replaceEnvironmentRoot(selectedPath, environmentOptions, nextEnvironmentId)
                  : null;
                const replacedNamespace =
                  replacedPath && nextEnvironment
                    ? getNamespaceIdForFile(replacedPath, nextEnvironment.root)
                    : null;
                const nextNamespaceId =
                  (replacedNamespace &&
                  nextNamespaceOptions.some((item) => item.id === replacedNamespace)
                    ? replacedNamespace
                    : null) ??
                  nextNamespaceOptions[0]?.id ??
                  "";
                setSelectedNamespace(nextNamespaceId);
                const nextPath = selectedPath
                  ? replacedPath
                  : null;
                if (nextPath && files.some((file) => file.path === nextPath)) {
                  setSelectedPath(nextPath);
                  return;
                }

                const fallbackPath =
                  nextEnvironment
                    ? files.find(
                        (file) =>
                          getPathWithinRoot(file.path, nextEnvironment.root) !== null &&
                          (!nextNamespaceId ||
                            getPathWithinNamespace(file.path, nextEnvironment.root, nextNamespaceId) !==
                              null)
                      )?.path ?? ""
                    : "";
                setSelectedPath(fallbackPath);
              }}
            >
              {environmentOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          {activeEnvironment ? (
            <label className="form-row">
              <span>名称</span>
              <select
                value={activeNamespace?.id ?? ""}
                onChange={(event) => {
                  const nextNamespaceId = event.target.value;
                  setSelectedNamespace(nextNamespaceId);
                  const nextPath =
                    selectedPath &&
                    activeEnvironment &&
                    getPathWithinNamespace(selectedPath, activeEnvironment.root, nextNamespaceId) !==
                      null
                      ? selectedPath
                      : "";
                  if (nextPath) {
                    setSelectedPath(nextPath);
                    return;
                  }

                  const fallbackPath =
                    activeEnvironment
                      ? files.find(
                          (file) =>
                            getPathWithinNamespace(
                              file.path,
                              activeEnvironment.root,
                              nextNamespaceId
                            ) !== null
                        )?.path ?? ""
                      : "";
                  setSelectedPath(fallbackPath);
                }}
              >
                {namespaceOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="repo-meta">
            <div>
              <span className="meta-label">远程仓库</span>
              <span className="meta-value">{bootstrap?.config.remoteUrl || "-"}</span>
            </div>
            <div>
              <span className="meta-label">分支</span>
              <span className="meta-value">{bootstrap?.config.branch || "-"}</span>
            </div>
            <div>
              <span className="meta-label">展示目录</span>
              <span className="meta-value">
                {activeEnvironment
                  ? activeNamespace && activeNamespace.id !== ROOT_NAMESPACE_ID
                    ? `${activeEnvironment.root}/${activeNamespace.id}`
                    : activeEnvironment.root
                  : bootstrap?.config.visibleRoots?.join(" / ") || "-"}
              </span>
            </div>
            <div>
              <span className="meta-label">当前 HEAD</span>
              <span className="meta-value mono">{bootstrap?.repoStatus.head || "-"}</span>
            </div>
          </div>

          {bootstrap?.repoStatus.lastError ? (
            <div className="notice notice--error">{bootstrap.repoStatus.lastError}</div>
          ) : null}

          <div className="file-list">
            {visibleFiles.length === 0 ? (
              <div className="empty-block">仓库中还没有可展示的文本文件</div>
            ) : (
              <FileTree nodes={fileTree} selectedPath={selectedPath} onSelect={setSelectedPath} />
            )}
          </div>
        </aside>

        <main className="main-column">
          <section className="panel">
            <div className="panel-title-row">
              <h2>{selectedPath || "当前文件"}</h2>
              <div className="action-row">
                <button className="secondary-button" onClick={() => void saveCurrentFile()} disabled={!selectedPath || saving}>
                  {saving ? "保存中..." : "保存"}
                </button>
                <button className="primary-button" onClick={() => void commitAndPush()} disabled={!selectedPath || committing}>
                  {committing ? "提交中..." : "提交并推送"}
                </button>
              </div>
            </div>

            {message ? <div className="notice notice--ok">{message}</div> : null}
            {liveNotice ? <div className="notice notice--live">{liveNotice}</div> : null}
            {error ? <div className="notice notice--error">{error}</div> : null}

            <div className="editor-grid">
              <div className="surface">
                <div className="surface-title">最新预览</div>
                <ContentBlock
                  content={fileDetail?.content ?? ""}
                  emptyText={loading ? "正在加载..." : "请选择文件"}
                />
              </div>

              <div className="surface">
                <div className="surface-title">在线编辑</div>
                <textarea
                  className="editor"
                  value={editorContent}
                  onChange={(event) => {
                    setEditorContent(event.target.value);
                    setEditorDirty(true);
                  }}
                  placeholder="请选择要编辑的文件"
                  disabled={!selectedPath}
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title-row">
              <h2>当前工作区与 HEAD 对比</h2>
              <span className="tag">{fileDetail?.isDirty ? "有未提交修改" : "已和 HEAD 一致"}</span>
            </div>
            <DiffView
              before={fileDetail?.headContent ?? ""}
              after={editorDirty ? editorContent : fileDetail?.content ?? ""}
              emptyText="当前文件没有未提交差异"
            />
          </section>

          <section className="panel">
            <div className="panel-title-row">
              <h2>最近一次提交前后对比</h2>
              <span className="tag">
                {fileDetail?.lastCommit ? fileDetail.lastCommit.message : "暂无提交记录"}
              </span>
            </div>

            {fileDetail?.lastCommit ? (
              <>
                <div className="commit-meta">
                  <span>{fileDetail.lastCommit.authorName}</span>
                  <span>{fileDetail.lastCommit.authorEmail}</span>
                  <span>{formatTime(fileDetail.lastCommit.committedAt)}</span>
                  <span className="mono">{fileDetail.lastCommit.hash}</span>
                </div>
                <DiffView
                  before={fileDetail.lastCommit.beforeContent}
                  after={fileDetail.lastCommit.afterContent}
                  emptyText="最近一次提交没有内容变化"
                />
              </>
            ) : (
              <div className="empty-block">当前文件还没有最近提交对比可展示</div>
            )}
          </section>
        </main>

        <aside className="panel settings-column">
          <h2>提交设置</h2>
          <label className="form-row">
            <span>Commit Message 前缀</span>
            <input
              value={gitForm.commitMessagePrefix}
              onChange={(event) =>
                setGitForm((current) => ({
                  ...current,
                  commitMessagePrefix: event.target.value
                }))
              }
            />
          </label>

          <label className="form-row">
            <span>本次提交说明</span>
            <textarea
              rows={6}
              value={gitForm.commitMessage}
              placeholder={"建议包含：\n提交人：张三\n修改环境：开发环境\n修改内容：调整 xxx 配置为 yyy"}
              onChange={(event) =>
                setGitForm((current) => ({
                  ...current,
                  commitMessage: event.target.value
                }))
              }
            />
          </label>

          <button className="secondary-button full-width" onClick={() => void saveGitSettings()}>
            保存前缀
          </button>

          <div className="settings-note">
            提交说明建议包含提交人、修改环境、修改内容。这里仅做提醒，不会阻止提交；最终 commit message 前缀始终读取服务端配置。
          </div>
        </aside>
      </div>
    </div>
  );
}
