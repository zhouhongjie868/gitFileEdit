import { diffLines } from "diff";
import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject
} from "react";
import type {
  AuthUser,
  BootstrapResponse,
  FileConflictPayload,
  FileDetail,
  RepoEnvironmentOption,
  RepoFileSummary
} from "./types";

interface DiffLine {
  text: string;
  hasNewline: boolean;
}

interface DiffBlock {
  id: string;
  type: "added" | "removed" | "same";
  marker: "+" | "-" | " ";
  lines: DiffLine[];
}

interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  children: FileTreeNode[];
  file?: RepoFileSummary;
}

interface AuthResponse {
  user: AuthUser;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

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
const editorSurfaceHeightClass = "h-[62vh] min-h-[360px] max-h-[640px] overflow-auto";

class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: unknown
  ) {
    super(message);
  }
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
    let payload: unknown = null;
    try {
      payload = fallbackText ? JSON.parse(fallbackText) : null;
    } catch {
      payload = null;
    }

    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : fallbackText || "请求失败";
    throw new ApiRequestError(message, response.status, payload);
  }

  return (await response.json()) as T;
}

function isFileConflictPayload(value: unknown): value is FileConflictPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "conflict" &&
      typeof (value as { path?: unknown }).path === "string"
  );
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
  forceOpen?: boolean;
  level?: number;
}): JSX.Element {
  const level = props.level ?? 0;

  return (
    <div className="grid gap-0.5">
      {props.nodes.map((node) => (
        <FileTreeRow
          key={node.id}
          node={node}
          selectedPath={props.selectedPath}
          onSelect={props.onSelect}
          level={level}
          forceOpen={props.forceOpen ?? false}
        />
      ))}
    </div>
  );
}

function FileTreeRow(props: {
  node: FileTreeNode;
  selectedPath: string;
  onSelect: (path: string) => void;
  level: number;
  forceOpen: boolean;
}): JSX.Element {
  const containsSelected = nodeContainsPath(props.node, props.selectedPath);
  const [open, setOpen] = useState(true);
  const isOpen = props.forceOpen || containsSelected || open;
  const indent = 6 + props.level * 10;

  if (props.node.kind === "directory") {
    return (
      <div>
        <button
          type="button"
          className={cn(
            "flex min-h-[34px] w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[15px] font-semibold text-[#24292f] transition hover:text-[#0f5e58]",
            containsSelected && "text-[#111827]"
          )}
          onClick={() => setOpen((current) => !current)}
          style={{ paddingLeft: `${indent}px` }}
        >
          <span
            className={cn(
              "w-6 shrink-0 text-center text-3xl font-light leading-none text-[#8a8f94] transition-transform",
              isOpen && "rotate-90 text-[#24292f]"
            )}
          >
            ›
          </span>
          <span className="min-w-0 flex-1 truncate">{props.node.name}</span>
        </button>
        {isOpen ? (
          <FileTree
            nodes={props.node.children}
            selectedPath={props.selectedPath}
            onSelect={props.onSelect}
            level={props.level + 1}
            forceOpen={props.forceOpen}
          />
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "group grid min-h-[34px] w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md px-1.5 text-left text-[15px] text-[#24292f] transition hover:text-[#0f5e58]",
        props.selectedPath === props.node.path &&
          "font-semibold text-[#111827]"
      )}
      onClick={() => props.onSelect(props.node.path)}
      style={{ paddingLeft: `${indent + 18}px` }}
      title={props.node.path}
    >
      <FileTypeIcon fileName={props.node.name} />
      <span className="min-w-0 truncate">{props.node.name}</span>
      <span className="hidden text-xs font-normal text-[#7a8b91] group-hover:inline">
        {props.node.file ? formatSize(props.node.file.size) : ""}
      </span>
    </button>
  );
}

function nodeContainsPath(node: FileTreeNode, pathValue: string): boolean {
  if (node.kind === "file") {
    return node.path === pathValue;
  }
  return node.children.some((child) => nodeContainsPath(child, pathValue));
}

function FileTypeIcon(props: { fileName: string }): JSX.Element {
  const name = props.fileName.toLocaleLowerCase();

  if (name.endsWith(".md")) {
    return <span className="text-center text-sm font-black text-[#20a455]">M↓</span>;
  }
  if (name === "dockerfile" || name.includes("compose") || name.endsWith(".yml") || name.endsWith(".yaml")) {
    return <span className="text-center text-lg leading-none text-[#238bd7]">◆</span>;
  }
  if (name.endsWith(".html")) {
    return <span className="rounded-md bg-[#f4dfcb] text-center text-sm font-bold text-[#d9792b]">#</span>;
  }
  if (name.endsWith(".json")) {
    return <span className="text-center text-lg leading-none text-[#e47a22]">{"{}"}</span>;
  }
  if (name.endsWith(".cjs") || name.endsWith(".js")) {
    return <span className="text-center text-lg leading-none text-[#df3b4a]">◎</span>;
  }
  if (name.endsWith(".ts") || name.endsWith(".tsx")) {
    return <span className="text-center text-lg leading-none text-[#a83ac6]">ϟ</span>;
  }
  if (name.endsWith(".css") || name.endsWith(".scss")) {
    return <span className="text-center text-lg leading-none text-[#20a9c8]">~</span>;
  }
  if (name.endsWith(".properties") || name.endsWith(".conf") || name.endsWith(".ini") || name.endsWith(".env")) {
    return <span className="rounded-md bg-[#edf1f3] text-center text-sm font-bold text-[#65727a]">.</span>;
  }

  return <span className="text-center text-lg leading-none text-[#9aa3aa]">•</span>;
}

function DiffView(props: {
  before: string;
  after: string;
  emptyText: string;
  className?: string;
  showContentWhenUnchanged?: boolean;
  scrollRef?: RefObject<HTMLDivElement>;
}): JSX.Element {
  const segments = diffLines(props.before, props.after);
  const diffBlocks: DiffBlock[] = segments.flatMap((segment, index) => {
    const type = segment.added ? "added" : segment.removed ? "removed" : "same";
    const marker = segment.added ? "+" : segment.removed ? "-" : " ";
    const lines = splitDiffLines(segment.value);

    if (type !== "same") {
      return [
        {
          id: `${index}`,
          type,
          marker,
          lines
        }
      ];
    }

    return lines.map((line, lineIndex): DiffBlock => ({
      id: `${index}-${lineIndex}`,
      type,
      marker,
      lines: [line]
    }));
  });

  const hasChange = diffBlocks.some((block) => block.type !== "same");
  const blocks = hasChange || props.showContentWhenUnchanged
    ? diffBlocks
    : [];
  if (blocks.length === 0) {
    return <div ref={props.scrollRef} className={cn(emptyBlockClass, props.className)}>{props.emptyText}</div>;
  }

  return (
    <div ref={props.scrollRef} className={cn("grid auto-rows-min content-start gap-0.5 rounded-[22px] border border-[#183039]/10 bg-[#fafcfb]/95 p-4", props.className)}>
      {blocks.map((block) => (
        <div
          key={block.id}
          className={cn(
            "grid grid-cols-[18px_minmax(0,1fr)] gap-2 rounded-[10px] px-1.5 py-1",
            block.type === "added" && "bg-[#1d8c68]/10",
            block.type === "removed" && "bg-[#c94a35]/10"
          )}
        >
          <span className="font-mono text-[#4a5b61]">{block.marker}</span>
          <span className="grid gap-0 whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.65]">
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                <VisibleWhitespace text={line.text} hasNewline={line.hasNewline} />
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function splitDiffLines(value: string): DiffLine[] {
  if (!value) {
    return [];
  }

  const lines = value.split("\n").map((text, index, allLines) => ({
    text,
    hasNewline: index < allLines.length - 1
  }));

  if (value.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function VisibleWhitespace(props: { text: string; hasNewline: boolean }): JSX.Element {
  const characters = Array.from(props.text);

  return (
    <>
      {characters.length === 0 && !props.hasNewline ? " " : null}
      {characters.map((character, index) => {
        if (character === " ") {
          return (
            <span key={index} className="text-[#84969c]">
              ·
            </span>
          );
        }

        if (character === "\t") {
          return (
            <span key={index} className="text-[#84969c]">
              ⇥
            </span>
          );
        }

        return <span key={index}>{character}</span>;
      })}
      {props.hasNewline ? <span className="ml-1 text-[#84969c]">↵</span> : null}
    </>
  );
}

export default function App(): JSX.Element {
  const pendingDiffRef = useRef<HTMLDivElement>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>("");
  const [fileQuery, setFileQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [fileConflict, setFileConflict] = useState<FileConflictPayload | null>(null);
  const [gitForm, setGitForm] = useState({
    extraMessage: ""
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
    password: "",
    confirmPassword: ""
  });
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loggingIn, setLoggingIn] = useState(false);

  function scrollPendingDiffToRatio(ratio: number): void {
    const diffElement = pendingDiffRef.current;
    if (!diffElement) {
      return;
    }

    const maxScrollTop = diffElement.scrollHeight - diffElement.clientHeight;
    if (maxScrollTop <= 0) {
      return;
    }

    diffElement.scrollTop = Math.max(0, Math.min(maxScrollTop, maxScrollTop * ratio));
  }

  function syncPendingDiffToEditorCursor(textarea: HTMLTextAreaElement): void {
    window.requestAnimationFrame(() => {
      const textBeforeCursor = textarea.value.slice(0, textarea.selectionStart);
      const cursorLineIndex = textBeforeCursor.split("\n").length - 1;
      const totalLines = Math.max(textarea.value.split("\n").length, 1);
      const ratio = totalLines <= 1 ? 0 : cursorLineIndex / (totalLines - 1);
      scrollPendingDiffToRatio(ratio);
    });
  }

  function syncPendingDiffToEditorScroll(textarea: HTMLTextAreaElement): void {
    const maxScrollTop = textarea.scrollHeight - textarea.clientHeight;
    if (maxScrollTop <= 0) {
      scrollPendingDiffToRatio(0);
      return;
    }

    scrollPendingDiffToRatio(textarea.scrollTop / maxScrollTop);
  }

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
          extraMessage: ""
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
        setFileConflict(null);
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
        setFileConflict(null);
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

  async function saveCurrentFile(): Promise<void> {
    if (!selectedPath) {
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      setFileConflict(null);
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
      setMessage("文件已暂存到工作区");
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
      if (!fileDetail) {
        throw new Error("请先选择要提交的文件");
      }

      await requestJson<{ head: string; path: string }>("/api/commit", {
        method: "POST",
        body: JSON.stringify({
          path: selectedPath,
          content: editorContent,
          baseHead: fileDetail.baseHead,
          baseBlob: fileDetail.baseBlob,
          message: gitForm.extraMessage
        })
      });

      setFileConflict(null);
      await refreshBootstrap(selectedPath);
      await refreshFile(selectedPath, false);
      setGitForm((current) => ({
        ...current,
        extraMessage: ""
      }));
      setMessage("修改已提交并推送到远程仓库");
    } catch (commitError) {
      if (
        commitError instanceof ApiRequestError &&
        commitError.status === 409 &&
        isFileConflictPayload(commitError.payload)
      ) {
        const conflictPayload = commitError.payload;
        setFileConflict(conflictPayload);
        setFileDetail((current) =>
          current
            ? {
                ...current,
                baseHead: conflictPayload.remoteHead ?? current.baseHead,
                baseBlob: conflictPayload.remoteBlob,
                remoteHead: conflictPayload.remoteHead,
                remoteBlob: conflictPayload.remoteBlob,
                remoteContent: conflictPayload.remoteContent,
                headContent: conflictPayload.remoteContent
              }
            : current
        );
        setEditorDirty(true);
      }
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
      if (authMode === "register" && loginForm.password !== loginForm.confirmPassword) {
        throw new Error("两次输入的密码不一致");
      }

      const payload = await requestJson<AuthResponse>(
        authMode === "register" ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({
            username: loginForm.username,
            password: loginForm.password
          })
        }
      );
      setAuthUser(payload.user);
      setLoginForm({
        username: "",
        password: "",
        confirmPassword: ""
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
  const visibleFiles = environmentFiles;
  const normalizedFileQuery = fileQuery.trim().toLocaleLowerCase();
  const filteredVisibleFiles = normalizedFileQuery
    ? visibleFiles.filter((file) => {
        const relativePath =
          activeEnvironment ? getPathWithinRoot(file.path, activeEnvironment.root) : file.path;
        const searchTarget = `${file.path}\n${relativePath ?? ""}\n${file.path.split("/").pop() ?? ""}`.toLocaleLowerCase();
        return searchTarget.includes(normalizedFileQuery);
      })
    : visibleFiles;
  const fileTree =
    activeEnvironment
      ? buildFileTree(
          filteredVisibleFiles,
          (file) => getPathWithinRoot(file.path, activeEnvironment.root),
          activeEnvironment.root
        )
      : [];
  const repoReady = bootstrap?.repoStatus.ready ?? false;
  const pendingBaseContent = fileDetail?.headContent ?? "";
  const pendingContent = editorDirty ? editorContent : fileDetail?.content ?? "";
  const hasPendingChanges = Boolean(selectedPath) && pendingBaseContent !== pendingContent;

  if (!authChecked || loading) {
    return <div className="p-7 text-[#43555d]">正在加载...</div>;
  }

  if (!authUser) {
    const isRegistering = authMode === "register";
    return (
      <div className="grid min-h-screen place-items-center p-4">
        <form
          className={cn(panelClass, "w-full max-w-[420px]")}
          onSubmit={(event) => void submitLogin(event)}
        >
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-[#5a7a72]">
            Git File Console
          </p>
          <h1 className="m-0 text-3xl leading-tight">
            {isRegistering ? "注册账号" : "登录后修改配置"}
          </h1>
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
                autoComplete={isRegistering ? "new-password" : "current-password"}
                value={loginForm.password}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    password: event.target.value
                  }))
                }
              />
            </label>
            {isRegistering ? (
              <label className={formRowClass}>
                <span className={formLabelClass}>确认密码</span>
                <input
                  className={inputClass}
                  type="password"
                  autoComplete="new-password"
                  value={loginForm.confirmPassword}
                  onChange={(event) =>
                    setLoginForm((current) => ({
                      ...current,
                      confirmPassword: event.target.value
                    }))
                  }
                />
              </label>
            ) : null}
            {error ? (
              <div className="rounded-2xl bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#8d3322]">
                {error}
              </div>
            ) : null}
            <button
              className={primaryButtonClass}
              disabled={
                !loginForm.username ||
                !loginForm.password ||
                (isRegistering && !loginForm.confirmPassword) ||
                loggingIn
              }
            >
              {loggingIn
                ? isRegistering
                  ? "注册中..."
                  : "登录中..."
                : isRegistering
                  ? "注册并登录"
                  : "登录"}
            </button>
            <button
              className={secondaryButtonClass}
              type="button"
              onClick={() => {
                setAuthMode((current) => (current === "login" ? "register" : "login"));
                setError(null);
                setLoginForm({
                  username: "",
                  password: "",
                  confirmPassword: ""
                });
              }}
            >
              {isRegistering ? "已有账号，去登录" : "没有账号，去注册"}
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

      <div className="grid gap-[22px] min-[961px]:grid-cols-[320px_minmax(0,1fr)]">
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
                const replacedPath = selectedPath
                  ? replaceEnvironmentRoot(selectedPath, environmentOptions, nextEnvironmentId)
                  : null;
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
                          getPathWithinRoot(file.path, nextEnvironment.root) !== null
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
                  ? activeEnvironment.root
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

          <label className="mb-4 flex min-h-[42px] items-center gap-2 rounded-xl border border-[#dfe4e6] bg-white px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
            <span className="text-2xl font-light leading-none text-[#8b9499]">⌕</span>
            <input
              className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-[#24292f] outline-none placeholder:text-[#8b8f93]"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="Filter files..."
            />
          </label>

          <div className="-mx-2 rounded-xl bg-[#f1f5f4] px-2 py-2">
            {visibleFiles.length === 0 ? (
              <div className={emptyBlockClass}>仓库中还没有可展示的文本文件</div>
            ) : filteredVisibleFiles.length === 0 ? (
              <div className={emptyBlockClass}>没有匹配当前检索条件的文件</div>
            ) : (
              <FileTree
                nodes={fileTree}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                forceOpen={Boolean(normalizedFileQuery)}
              />
            )}
          </div>
        </aside>

        <main className="grid gap-[22px]">
          <section className={panelClass}>
            <div className="mb-4 grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(460px,auto)]">
              <div className="min-w-0">
                <h2 className="m-0 break-words text-lg">{selectedPath || "当前文件"}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#5d7077]">
                  <span className="inline-flex items-center rounded-full bg-[#134e5e]/10 px-3 py-1.5 text-[#214954]">
                    {activeEnvironment?.label ?? "未选择环境"}
                  </span>
                </div>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-[minmax(220px,1fr)_auto_auto]">
                <textarea
                  className={cn(inputClass, "min-h-[46px] resize-y py-2.5 text-sm")}
                  rows={1}
                  value={gitForm.extraMessage}
                  placeholder="commit 信息"
                  onChange={(event) =>
                    setGitForm((current) => ({
                      ...current,
                      extraMessage: event.target.value
                    }))
                  }
                />
                <button className={secondaryButtonClass} onClick={() => void saveCurrentFile()} disabled={!selectedPath || saving}>
                  {saving ? "暂存中..." : "暂存"}
                </button>
                <button className={primaryButtonClass} onClick={() => void commitAndPush()} disabled={!selectedPath || committing}>
                  {committing ? "提交中..." : "提交并推送"}
                </button>
              </div>
            </div>

            {message ? <div className="mb-3.5 rounded-2xl bg-[#1d8c68]/10 px-3.5 py-3 text-sm text-[#12684d]">{message}</div> : null}
            {liveNotice ? <div className="mb-3.5 rounded-2xl bg-[#2475b2]/10 px-3.5 py-3 text-sm text-[#18527e]">{liveNotice}</div> : null}
            {error ? <div className="mb-3.5 rounded-2xl bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#8d3322]">{error}</div> : null}
            {fileConflict ? (
              <div className="mb-3.5 grid gap-3 rounded-2xl border border-[#c94a35]/20 bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#79301f]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <strong>检测到远程冲突</strong>
                    <div className="mt-1 text-[#8d3322]">
                      远程文件已更新，你的编辑内容已保留在右侧编辑器中。
                    </div>
                  </div>
                  <button
                    className={secondaryButtonClass}
                    type="button"
                    onClick={() => {
                      setEditorContent(fileConflict.remoteContent);
                      setEditorDirty(false);
                      setFileDetail((current) =>
                        current
                          ? {
                              ...current,
                              content: fileConflict.remoteContent,
                              remoteContent: fileConflict.remoteContent,
                              headContent: fileConflict.remoteContent,
                              baseHead: fileConflict.remoteHead ?? current.baseHead,
                              baseBlob: fileConflict.remoteBlob,
                              remoteHead: fileConflict.remoteHead,
                              remoteBlob: fileConflict.remoteBlob,
                              isDirty: false
                            }
                          : current
                      );
                      setFileConflict(null);
                    }}
                  >
                    使用远程版本
                  </button>
                </div>
                <DiffView
                  before={fileConflict.remoteContent}
                  after={fileConflict.localContent}
                  emptyText="远程版本与我的修改没有内容差异"
                />
              </div>
            ) : null}

            <div className="grid gap-[18px] min-[961px]:grid-cols-2">
              <div className="grid content-start gap-3">
                <div className="flex min-h-[32px] flex-wrap items-center gap-2">
                  <div className="font-bold text-[#20404a]">原始文件</div>
                  {selectedPath && !hasPendingChanges ? (
                    <span className="inline-flex items-center rounded-full bg-[#134e5e]/10 px-3 py-1.5 text-xs text-[#214954]">
                      当前文件没有未提交差异
                    </span>
                  ) : null}
                </div>
                <DiffView
                  before={pendingBaseContent}
                  after={pendingContent}
                  emptyText={loading ? "正在加载..." : "当前文件没有未提交差异"}
                  className={editorSurfaceHeightClass}
                  scrollRef={pendingDiffRef}
                  showContentWhenUnchanged
                />
              </div>

              <div className="grid content-start gap-3">
                <div className="flex min-h-[32px] items-center font-bold text-[#20404a]">在线编辑</div>
                <textarea
                  className={cn(codeSurfaceClass, editorSurfaceHeightClass, "w-full resize-none outline-none")}
                  value={editorContent}
                  onChange={(event) => {
                    setEditorContent(event.target.value);
                    setEditorDirty(true);
                    syncPendingDiffToEditorCursor(event.currentTarget);
                  }}
                  onClick={(event) => syncPendingDiffToEditorCursor(event.currentTarget)}
                  onKeyUp={(event) => syncPendingDiffToEditorCursor(event.currentTarget)}
                  onSelect={(event) => syncPendingDiffToEditorCursor(event.currentTarget)}
                  onScroll={(event) => syncPendingDiffToEditorScroll(event.currentTarget)}
                  placeholder="请选择要编辑的文件"
                  disabled={!selectedPath}
                />
              </div>
            </div>
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

      </div>
    </div>
  );
}
