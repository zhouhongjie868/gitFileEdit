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

function replaceEnvironmentRoot(
  filePath: string,
  environments: RepoEnvironmentOption[],
  nextEnvironmentId: string
): string | null {
  const currentEnvironment = environments.find(
    (item) => filePath === item.root || filePath.startsWith(`${item.root}/`)
  );
  const nextEnvironment = environments.find((item) => item.id === nextEnvironmentId);
  if (!currentEnvironment || !nextEnvironment) {
    return null;
  }

  const suffix = filePath.slice(currentEnvironment.root.length);
  return `${nextEnvironment.root}${suffix}`;
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
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [gitForm, setGitForm] = useState({
    username: "",
    email: "",
    password: "",
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
      environmentOptions.find(
        (item) => nextPath && (nextPath === item.root || nextPath.startsWith(`${item.root}/`))
      )?.id ||
      environmentOptions[0]?.id ||
      "";

    startTransition(() => {
      setBootstrap(data);
      setSelectedEnvironment((current) =>
        current && environmentOptions.some((item) => item.id === current)
          ? current
          : derivedEnvironment
      );
      setSelectedPath(nextPath);
      if (!settingsSeeded || !preserveForm) {
        setGitForm({
          username: data.gitSettings.username,
          email: data.gitSettings.email,
          password: "",
          commitMessage: data.gitSettings.defaultCommitMessage
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
        username: gitForm.username,
        email: gitForm.email,
        defaultCommitMessage: gitForm.commitMessage
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
        password: ""
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
          message: gitForm.commitMessage,
          username: gitForm.username,
          email: gitForm.email,
          password: gitForm.password
        })
      });

      await refreshBootstrap(selectedPath);
      await refreshFile(selectedPath, false);
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
  const visibleFiles = activeEnvironment
    ? files.filter(
        (file) => file.path === activeEnvironment.root || file.path.startsWith(`${activeEnvironment.root}/`)
      )
    : files;
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
                const nextPath = selectedPath
                  ? replaceEnvironmentRoot(selectedPath, environmentOptions, nextEnvironmentId)
                  : null;
                if (nextPath && files.some((file) => file.path === nextPath)) {
                  setSelectedPath(nextPath);
                  return;
                }

                const nextEnvironment = environmentOptions.find(
                  (item) => item.id === nextEnvironmentId
                );
                const fallbackPath =
                  nextEnvironment
                    ? files.find(
                        (file) =>
                          file.path === nextEnvironment.root ||
                          file.path.startsWith(`${nextEnvironment.root}/`)
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
                {activeEnvironment?.root || bootstrap?.config.visibleRoots?.join(" / ") || "-"}
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
              visibleFiles.map((file) => (
                <button
                  key={file.path}
                  className={`file-item ${selectedPath === file.path ? "file-item--active" : ""}`}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className="file-path">{file.path}</span>
                  <span className="file-meta">
                    {formatSize(file.size)} · {formatTime(file.modifiedAt)}
                  </span>
                </button>
              ))
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
            <span>Git 用户名</span>
            <input
              value={gitForm.username}
              onChange={(event) =>
                setGitForm((current) => ({
                  ...current,
                  username: event.target.value
                }))
              }
            />
          </label>

          <label className="form-row">
            <span>Git 邮箱</span>
            <input
              value={gitForm.email}
              onChange={(event) =>
                setGitForm((current) => ({
                  ...current,
                  email: event.target.value
                }))
              }
            />
          </label>

          <label className="form-row">
            <span>Git 密码或 Token</span>
            <input
              type="password"
              placeholder="留空则使用配置文件中的默认仓库密码"
              value={gitForm.password}
              onChange={(event) =>
                setGitForm((current) => ({
                  ...current,
                  password: event.target.value
                }))
              }
            />
          </label>

          <label className="form-row">
            <span>Commit Message</span>
            <textarea
              rows={4}
              value={gitForm.commitMessage}
              onChange={(event) =>
                setGitForm((current) => ({
                  ...current,
                  commitMessage: event.target.value
                }))
              }
            />
          </label>

          <button className="secondary-button full-width" onClick={() => void saveGitSettings()}>
            保存 Git 设置
          </button>

          <div className="settings-note">
            查看和同步仓库使用配置文件中的默认账号密码；这里输入的密码仅在本次提交推送时优先生效。
          </div>
        </aside>
      </div>
    </div>
  );
}
