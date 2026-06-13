import { diffLines } from "diff";
import { startTransition, useEffect, useState, type FormEvent } from "react";
import type {
  AuthUser,
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

interface AuthResponse {
  user: AuthUser;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const ROOT_NAMESPACE_ID = "__root__";
const DEFAULT_NAMESPACE_IDS_BY_ENVIRONMENT: Record<string, string[]> = {
  dev: ["finagent-tob-dev", "finagentservice-tob-dev"],
  sit: ["finagent-tob", "finagentservice-tob"],
  uat: ["finagent-tob-uat", "finagentservice-tob-uat"],
  prod: ["finagent-tob", "finagentservice-tob"]
};

const panelClass =
  "rounded-[28px] border border-slate-900/10 bg-white/75 p-5 shadow-[0_20px_50px_rgba(33,51,63,0.08)] backdrop-blur";
const panelTitleRowClass = "mb-4 flex items-center justify-between gap-3";
const secondaryButtonClass =
  "rounded-2xl border-0 bg-[#143138]/[0.08] px-4 py-2.5 text-[#183039] transition duration-200 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0";
const primaryButtonClass =
  "rounded-2xl border-0 bg-gradient-to-br from-[#0e6b72] to-[#1e8f6b] px-4 py-2.5 text-white shadow-[0_12px_28px_rgba(18,118,112,0.22)] transition duration-200 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0";
const formRowClass = "mb-3.5 grid gap-2";
const formLabelClass = "text-sm font-semibold text-[#223841]";
const inputClass =
  "rounded-2xl border border-[#183039]/10 bg-[#fcfdfc]/95 px-3.5 py-3 outline-none";
const emptyBlockClass =
  "rounded-[22px] border border-dashed border-[#183039]/15 bg-[#f6f9f7]/85 p-6 text-center text-[#73848a]";
const codeSurfaceClass =
  "m-0 rounded-[22px] border border-[#183039]/10 bg-[#fafcfb]/95 p-4 font-mono text-[13px] leading-[1.65] whitespace-pre-wrap break-words";

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
    } catch (error) {
      if (error instanceof Error && payloadHasErrorMessage(fallbackText)) {
        throw error;
      }
      throw new Error(fallbackText || "请求失败");
    }
  }

  return (await response.json()) as T;
}

function payloadHasErrorMessage(value: string): boolean {
  try {
    const payload = JSON.parse(value) as { error?: unknown };
    return typeof payload.error === "string";
  } catch {
    return false;
  }
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
    <div className="grid gap-1.5">
      {props.nodes.map((node) =>
        node.kind === "directory" ? (
          <details key={node.id} className="grid gap-1.5 open:grid" open>
            <summary
              className="flex cursor-pointer items-center gap-2 rounded-2xl bg-[#e8f1f0]/60 px-3 py-2.5 font-semibold text-[#1b2a33]"
              style={{ paddingLeft: `${12 + level * 18}px` }}
            >
              <span className="text-xs text-[#4d6966]">▾</span>
              <span className="break-words">{node.name}</span>
            </summary>
            <div className="mt-1.5">
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
            className={cn(
              "grid gap-1 rounded-2xl border border-[#183039]/10 bg-white/70 px-3 py-2.5 text-left",
              props.selectedPath === node.path &&
                "border-[#188f75]/35 bg-gradient-to-br from-[#127670]/10 to-[#1d8c68]/10"
            )}
            onClick={() => props.onSelect(node.path)}
            style={{ paddingLeft: `${16 + level * 18}px` }}
          >
            <span className="break-words font-semibold text-[#1b2a33]">{node.name}</span>
            <span className="text-xs text-[#617278]">
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
    return <div className={emptyBlockClass}>{props.emptyText}</div>;
  }

  return (
    <div className="grid gap-0.5 rounded-[22px] border border-[#183039]/10 bg-[#fafcfb]/95 p-4">
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            "grid grid-cols-[18px_minmax(0,1fr)] gap-2 rounded-[10px] px-1.5 py-1",
            row.type === "added" && "bg-[#1d8c68]/10",
            row.type === "removed" && "bg-[#c94a35]/10"
          )}
        >
          <span className="font-mono text-[#4a5b61]">{row.marker}</span>
          <span className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.65]">
            {row.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function ContentBlock(props: { content: string; emptyText: string }): JSX.Element {
  if (!props.content) {
    return <div className={emptyBlockClass}>{props.emptyText}</div>;
  }

  return <pre className={cn(codeSurfaceClass, "min-h-[480px]")}>{props.content}</pre>;
}

export default function App(): JSX.Element {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>("");
  const [selectedNamespace, setSelectedNamespace] = useState<string>("");
  const [fileQuery, setFileQuery] = useState("");
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
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginForm, setLoginForm] = useState({
    username: "",
    password: ""
  });
  const [loggingIn, setLoggingIn] = useState(false);

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
        const authResponse = await fetch("/api/auth/me");
        if (!authResponse.ok) {
          setAuthUser(null);
          return;
        }
        const authPayload = (await authResponse.json()) as AuthResponse;
        setAuthUser(authPayload.user);
        await refreshBootstrap(undefined, false);
      } catch (fetchError) {
        setError((fetchError as Error).message);
      } finally {
        setAuthChecked(true);
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
    if (!authUser) {
      return;
    }

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
  }, [authUser, selectedPath, editorDirty, settingsSeeded]);

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

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoggingIn(true);
    setError(null);
    setMessage(null);

    try {
      const payload = await requestJson<AuthResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(loginForm)
      });
      setAuthUser(payload.user);
      setLoginForm({
        username: "",
        password: ""
      });
      await refreshBootstrap(undefined, false);
    } catch (loginError) {
      setError((loginError as Error).message);
    } finally {
      setLoggingIn(false);
      setAuthChecked(true);
    }
  }

  async function logoutCurrentUser(): Promise<void> {
    await requestJson<{ ok: boolean }>("/api/auth/logout", {
      method: "POST"
    }).catch(() => ({ ok: true }));
    setAuthUser(null);
    setBootstrap(null);
    setSelectedPath("");
    setFileDetail(null);
    setEditorContent("");
    setEditorDirty(false);
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
  const normalizedFileQuery = fileQuery.trim().toLocaleLowerCase();
  const filteredVisibleFiles = normalizedFileQuery
    ? visibleFiles.filter((file) => {
        const relativePath =
          activeEnvironment && activeNamespace
            ? getPathWithinNamespace(file.path, activeEnvironment.root, activeNamespace.id)
            : activeEnvironment
              ? getPathWithinRoot(file.path, activeEnvironment.root)
              : file.path;
        const searchTarget = `${file.path}\n${relativePath ?? ""}\n${file.path.split("/").pop() ?? ""}`.toLocaleLowerCase();
        return searchTarget.includes(normalizedFileQuery);
      })
    : visibleFiles;
  const fileTree =
    activeEnvironment && activeNamespace
      ? buildFileTree(
          filteredVisibleFiles,
          (file) => getPathWithinNamespace(file.path, activeEnvironment.root, activeNamespace.id),
          `${activeEnvironment.root}/${activeNamespace.id}`
        )
      : activeEnvironment
        ? buildFileTree(
            filteredVisibleFiles,
            (file) => getPathWithinRoot(file.path, activeEnvironment.root),
            activeEnvironment.root
          )
        : [];
  const repoReady = bootstrap?.repoStatus.ready ?? false;

  if (!authChecked || loading) {
    return <div className="p-7 text-[#43555d]">正在加载...</div>;
  }

  if (!authUser) {
    return (
      <div className="grid min-h-screen place-items-center p-4">
        <form
          className={cn(panelClass, "w-full max-w-[420px]")}
          onSubmit={(event) => void submitLogin(event)}
        >
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-[#5a7a72]">
            Git File Console
          </p>
          <h1 className="m-0 text-3xl leading-tight">登录后修改配置</h1>
          <div className="mt-6 grid gap-4">
            <label className={formRowClass}>
              <span className={formLabelClass}>账号</span>
              <input
                className={inputClass}
                autoComplete="username"
                value={loginForm.username}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    username: event.target.value
                  }))
                }
              />
            </label>
            <label className={formRowClass}>
              <span className={formLabelClass}>密码</span>
              <input
                className={inputClass}
                type="password"
                autoComplete="current-password"
                value={loginForm.password}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    password: event.target.value
                  }))
                }
              />
            </label>
            {error ? (
              <div className="rounded-2xl bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#8d3322]">
                {error}
              </div>
            ) : null}
            <button
              className={primaryButtonClass}
              disabled={!loginForm.username || !loginForm.password || loggingIn}
            >
              {loggingIn ? "登录中..." : "登录"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-7">
      <header className="mb-6 flex flex-col items-start justify-between gap-6 xl:flex-row">
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-[#5a7a72]">
            Git File Console
          </p>
          <h1 className="m-0 text-[clamp(32px,5vw,48px)] leading-[1.05]">
            配置文件在线展示与提交
          </h1>
          <p className="mt-3.5 max-w-[760px] leading-relaxed text-[#43555d]">
            按环境切换查看配置文件，支持实时刷新、在线修改、提交并推送。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(260px,1fr)_auto]">
          <div className="flex min-w-[260px] items-center gap-3.5 rounded-[22px] border border-slate-900/10 bg-white/70 px-5 py-4 shadow-[0_24px_60px_rgba(54,77,80,0.1)]">
            <span
              className={cn(
                "inline-block h-3 w-3 rounded-full",
                repoReady
                  ? "bg-[#1d8c68] shadow-[0_0_0_6px_rgba(29,140,104,0.14)]"
                  : "bg-[#d1842f] shadow-[0_0_0_6px_rgba(209,132,47,0.14)]"
              )}
            />
            <div>
              <strong>{repoReady ? "仓库可用" : "仓库未就绪"}</strong>
              <div className="mt-1.5 text-[#728188]">
                上次同步 {formatTime(bootstrap?.repoStatus.lastSyncedAt ?? null)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[22px] border border-slate-900/10 bg-white/70 px-5 py-4 shadow-[0_24px_60px_rgba(54,77,80,0.1)]">
            <div>
              <strong>{authUser.id}</strong>
              <div className="mt-1.5 text-sm text-[#728188]">当前账号</div>
            </div>
            <button className={secondaryButtonClass} onClick={() => void logoutCurrentUser()}>
              退出
            </button>
          </div>
        </div>
      </header>

      <div className="grid gap-[22px] min-[1321px]:grid-cols-[320px_minmax(0,1fr)_320px] min-[961px]:max-[1320px]:grid-cols-[280px_minmax(0,1fr)]">
        <aside className={cn(panelClass, "min-[961px]:sticky min-[961px]:top-5 min-[961px]:max-h-[calc(100vh-40px)] min-[961px]:overflow-auto")}>
          <div className={panelTitleRowClass}>
            <h2 className="m-0 text-lg">文件列表</h2>
            <button className={secondaryButtonClass} onClick={() => void syncRepository()} disabled={syncing}>
              {syncing ? "同步中..." : "同步仓库"}
            </button>
          </div>

          <label className={formRowClass}>
            <span className={formLabelClass}>当前环境</span>
            <select
              className={inputClass}
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
            <label className={formRowClass}>
              <span className={formLabelClass}>名称</span>
              <select
                className={inputClass}
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

          <div className="mb-4 grid gap-3 rounded-[20px] bg-[#e8f1f0]/70 px-4 py-3.5">
            <div>
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">远程仓库</span>
              <span className="block break-words text-sm text-[#183039]">{bootstrap?.config.remoteUrl || "-"}</span>
            </div>
            <div>
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">分支</span>
              <span className="block break-words text-sm text-[#183039]">{bootstrap?.config.branch || "-"}</span>
            </div>
            <div>
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">展示目录</span>
              <span className="block break-words text-sm text-[#183039]">
                {activeEnvironment
                  ? activeNamespace && activeNamespace.id !== ROOT_NAMESPACE_ID
                    ? `${activeEnvironment.root}/${activeNamespace.id}`
                    : activeEnvironment.root
                  : bootstrap?.config.visibleRoots?.join(" / ") || "-"}
              </span>
            </div>
            <div>
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">当前 HEAD</span>
              <span className="block break-words font-mono text-xs text-[#183039]">{bootstrap?.repoStatus.head || "-"}</span>
            </div>
          </div>

          {bootstrap?.repoStatus.lastError ? (
            <div className="mb-3.5 rounded-2xl bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#8d3322]">{bootstrap.repoStatus.lastError}</div>
          ) : null}

          <label className={formRowClass}>
            <span className={formLabelClass}>文件检索</span>
            <input
              className={inputClass}
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="按文件名或路径检索"
            />
          </label>

          <div className="grid gap-2.5">
            {visibleFiles.length === 0 ? (
              <div className={emptyBlockClass}>仓库中还没有可展示的文本文件</div>
            ) : filteredVisibleFiles.length === 0 ? (
              <div className={emptyBlockClass}>没有匹配当前检索条件的文件</div>
            ) : (
              <FileTree nodes={fileTree} selectedPath={selectedPath} onSelect={setSelectedPath} />
            )}
          </div>
        </aside>

        <main className="grid gap-[22px]">
          <section className={panelClass}>
            <div className={panelTitleRowClass}>
              <h2 className="m-0 text-lg">{selectedPath || "当前文件"}</h2>
              <div className="flex gap-2.5">
                <button className={secondaryButtonClass} onClick={() => void saveCurrentFile()} disabled={!selectedPath || saving}>
                  {saving ? "保存中..." : "保存"}
                </button>
                <button className={primaryButtonClass} onClick={() => void commitAndPush()} disabled={!selectedPath || committing}>
                  {committing ? "提交中..." : "提交并推送"}
                </button>
              </div>
            </div>

            {message ? <div className="mb-3.5 rounded-2xl bg-[#1d8c68]/10 px-3.5 py-3 text-sm text-[#12684d]">{message}</div> : null}
            {liveNotice ? <div className="mb-3.5 rounded-2xl bg-[#2475b2]/10 px-3.5 py-3 text-sm text-[#18527e]">{liveNotice}</div> : null}
            {error ? <div className="mb-3.5 rounded-2xl bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#8d3322]">{error}</div> : null}

            <div className="grid gap-[18px] min-[961px]:grid-cols-2">
              <div className="grid gap-3">
                <div className="font-bold text-[#20404a]">最新预览</div>
                <ContentBlock
                  content={fileDetail?.remoteContent ?? ""}
                  emptyText={loading ? "正在加载..." : "请选择文件"}
                />
              </div>

              <div className="grid gap-3">
                <div className="font-bold text-[#20404a]">在线编辑</div>
                <textarea
                  className={cn(codeSurfaceClass, "min-h-[480px] w-full resize-y outline-none")}
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

          <section className={panelClass}>
            <div className={panelTitleRowClass}>
              <h2 className="m-0 text-lg">当前工作区与 HEAD 对比</h2>
              <span className="inline-flex items-center rounded-full bg-[#134e5e]/10 px-3 py-1.5 text-xs text-[#214954]">{fileDetail?.isDirty ? "有未提交修改" : "已和 HEAD 一致"}</span>
            </div>
            <DiffView
              before={fileDetail?.headContent ?? ""}
              after={editorDirty ? editorContent : fileDetail?.content ?? ""}
              emptyText="当前文件没有未提交差异"
            />
          </section>

          <section className={panelClass}>
            <div className={panelTitleRowClass}>
              <h2 className="m-0 text-lg">最近一次提交前后对比</h2>
              <span className="inline-flex items-center rounded-full bg-[#134e5e]/10 px-3 py-1.5 text-xs text-[#214954]">
                {fileDetail?.lastCommit ? fileDetail.lastCommit.message : "暂无提交记录"}
              </span>
            </div>

            {fileDetail?.lastCommit ? (
              <>
                <div className="mb-3.5 flex flex-wrap gap-x-3.5 gap-y-2.5 text-[13px] text-[#55686f]">
                  <span>{fileDetail.lastCommit.authorName}</span>
                  <span>{fileDetail.lastCommit.authorEmail}</span>
                  <span>{formatTime(fileDetail.lastCommit.committedAt)}</span>
                  <span className="font-mono text-xs">{fileDetail.lastCommit.hash}</span>
                </div>
                <DiffView
                  before={fileDetail.lastCommit.beforeContent}
                  after={fileDetail.lastCommit.afterContent}
                  emptyText="最近一次提交没有内容变化"
                />
              </>
            ) : (
              <div className={emptyBlockClass}>当前文件还没有最近提交对比可展示</div>
            )}
          </section>
        </main>

        <aside className={cn(panelClass, "min-[1321px]:sticky min-[1321px]:top-5 min-[1321px]:max-h-[calc(100vh-40px)] min-[1321px]:overflow-auto min-[961px]:max-[1320px]:col-span-full")}>
          <h2 className="m-0 mb-4 text-lg">提交设置</h2>
          <label className={formRowClass}>
            <span className={formLabelClass}>Commit Message 前缀</span>
            <input
              className={inputClass}
              value={gitForm.commitMessagePrefix}
              onChange={(event) =>
                setGitForm((current) => ({
                  ...current,
                  commitMessagePrefix: event.target.value
                }))
              }
            />
          </label>

          <label className={formRowClass}>
            <span className={formLabelClass}>本次提交说明</span>
            <textarea
              className={inputClass}
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

          <button className={cn(secondaryButtonClass, "w-full")} onClick={() => void saveGitSettings()}>
            保存前缀
          </button>

          <div className="mt-4 rounded-[18px] bg-[#ebf2f8]/70 px-4 py-3.5 leading-relaxed text-[#4a5f68]">
            提交说明建议包含提交人、修改环境、修改内容。这里仅做提醒，不会阻止提交；最终 commit message 前缀始终读取服务端配置。
          </div>
        </aside>
      </div>
    </div>
  );
}
