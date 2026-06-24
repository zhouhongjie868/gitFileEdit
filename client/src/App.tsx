import type { EditorView } from "@codemirror/view";
import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { AuthScreen } from "./components/AuthScreen";
import { CommitConfirmDialog } from "./components/CommitConfirmDialog";
import { ConfigEditor } from "./components/ConfigEditor";
import { DiffView } from "./components/DiffView";
import { FileTree } from "./components/FileTree";
import { ToastStack } from "./components/ToastStack";
import {
  buildFileTree,
  getPathWithinRoot,
  replaceEnvironmentRoot
} from "./lib/filePaths";
import { formatTime, getCommitBody, getCommitSubject } from "./lib/format";
import {
  cn,
  editorSurfaceHeightClass,
  emptyBlockClass,
  formLabelClass,
  formRowClass,
  inputClass,
  panelClass,
  panelTitleRowClass,
  primaryButtonClass,
  secondaryButtonClass
} from "./lib/ui";
import type {
  AuthUser,
  BootstrapResponse,
  CommitSnapshot,
  EnvironmentReviewCommit,
  EnvironmentReviewDiff,
  FileConflictPayload,
  FileDetail,
  RepoEnvironmentOption,
  RepoFileSummary
} from "./types";

interface AuthResponse {
  user: AuthUser;
}

interface EnvironmentSettingsResponse {
  environments: RepoEnvironmentOption[];
}

interface FileValidationPayload {
  type: "file_validation";
  fileType: string;
  message: string;
}

const fileListMinWidth = 260;
const fileListDefaultWidth = 320;
const fileListMaxWidth = 560;
const mainContentMinWidth = 520;
const diffPreviewDebounceMs = 280;
const largeDiffPreviewThreshold = 200 * 1024;
const diffLineAlignmentOffset = -3;

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

function isProtectedEnvironmentId(environmentId: string | undefined): boolean {
  return environmentId === "uat";
}

function createEnvironmentId(label: string, index: number): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `env-${index + 1}`;
}

function createBlankEnvironment(index: number, fallback?: RepoEnvironmentOption): RepoEnvironmentOption {
  return {
    id: `env-${Date.now()}-${index + 1}`,
    label: "",
    root: fallback?.root ?? "",
    requiresAdminToEdit: false
  };
}

function isFileConflictPayload(value: unknown): value is FileConflictPayload {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "conflict" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

function isFileValidationPayload(value: unknown): value is FileValidationPayload {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "file_validation" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function countLines(value: string): number {
  if (!value) {
    return 1;
  }

  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 1);
}

export default function App(): JSX.Element {
  const pendingDiffRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const diffPreviewTimerRef = useRef<number | null>(null);
  const isLargeDiffPreviewRef = useRef(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const reviewRequestIdRef = useRef(0);
  const reviewDiffRequestIdRef = useRef(0);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>("");
  const [fileQuery, setFileQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [diffPreviewContent, setDiffPreviewContent] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [isLargeDiffPreview, setIsLargeDiffPreview] = useState(false);
  const [isDiffPreviewStale, setIsDiffPreviewStale] = useState(false);
  const [fileConflict, setFileConflict] = useState<FileConflictPayload | null>(null);
  const [fileValidationError, setFileValidationError] = useState<string | null>(null);
  const [gitForm, setGitForm] = useState({
    extraMessage: ""
  });
  const [settingsSeeded, setSettingsSeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [confirmingCommit, setConfirmingCommit] = useState(false);
  const [selectedHistoryHash, setSelectedHistoryHash] = useState<string>("");
  const [restoringHash, setRestoringHash] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [showRepoDetails, setShowRepoDetails] = useState(false);
  const [fileListWidth, setFileListWidth] = useState(fileListDefaultWidth);
  const [resizingFileList, setResizingFileList] = useState(false);
  const [currentEditorLine, setCurrentEditorLine] = useState(1);
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [activationDialogOpen, setActivationDialogOpen] = useState(false);
  const [activationCode, setActivationCode] = useState("");
  const [activatingAdmin, setActivatingAdmin] = useState(false);
  const [showEnvironmentSettings, setShowEnvironmentSettings] = useState(false);
  const [environmentDraft, setEnvironmentDraft] = useState<RepoEnvironmentOption[]>([]);
  const [savingEnvironmentSettings, setSavingEnvironmentSettings] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewSince, setReviewSince] = useState(() =>
    toDateInputValue(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))
  );
  const [reviewUntil, setReviewUntil] = useState(() => toDateInputValue(new Date()));
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewCommits, setReviewCommits] = useState<EnvironmentReviewCommit[]>([]);
  const [selectedReviewHash, setSelectedReviewHash] = useState("");
  const [selectedReviewPath, setSelectedReviewPath] = useState("");
  const [reviewDiff, setReviewDiff] = useState<EnvironmentReviewDiff | null>(null);
  const [reviewDiffLoading, setReviewDiffLoading] = useState(false);

  function resetAuthenticatedState(): void {
    setAuthUser(null);
    setBootstrap(null);
    setSelectedPath("");
    setFileDetail(null);
    setEditorContent("");
    setDiffPreviewContent("");
    setEditorDirty(false);
    setIsDiffPreviewStale(false);
    clearDiffPreviewTimer();
    setLargeDiffPreviewMode(false);
    setCurrentEditorLine(1);
    setFileConflict(null);
    setFileValidationError(null);
    setReviewOpen(false);
    setReviewCommits([]);
    setSelectedReviewHash("");
    setSelectedReviewPath("");
    setReviewDiff(null);
    setLiveNotice(null);
    setAccountMenuOpen(false);
    setActivationDialogOpen(false);
    setActivationCode("");
    setShowEnvironmentSettings(false);
    setEnvironmentDraft([]);
  }

  function handleAuthRequired(errorValue: unknown): boolean {
    if (errorValue instanceof ApiRequestError && errorValue.status === 401) {
      resetAuthenticatedState();
      setAuthChecked(true);
      setError(null);
      setMessage(null);
      return true;
    }

    return false;
  }

  function clearDiffPreviewTimer(): void {
    if (diffPreviewTimerRef.current !== null) {
      window.clearTimeout(diffPreviewTimerRef.current);
      diffPreviewTimerRef.current = null;
    }
  }

  function getLatestEditorContent(): string {
    return editorViewRef.current?.state.doc.toString() ?? editorContent;
  }

  function setLargeDiffPreviewMode(nextValue: boolean): void {
    if (isLargeDiffPreviewRef.current === nextValue) {
      return;
    }

    isLargeDiffPreviewRef.current = nextValue;
    setIsLargeDiffPreview(nextValue);
  }

  function updateLargeDiffPreviewMode(contentLength: number): boolean {
    const nextValue = pendingBaseContent.length + contentLength > largeDiffPreviewThreshold;
    setLargeDiffPreviewMode(nextValue);
    return nextValue;
  }

  function scheduleDiffPreviewUpdate(view: EditorView): void {
    const nextIsLarge = updateLargeDiffPreviewMode(view.state.doc.length);
    clearDiffPreviewTimer();
    if (nextIsLarge) {
      return;
    }

    diffPreviewTimerRef.current = window.setTimeout(() => {
      diffPreviewTimerRef.current = null;
      const nextContent = view.state.doc.toString();
      startTransition(() => {
        setDiffPreviewContent(nextContent);
        setIsDiffPreviewStale(false);
      });
    }, diffPreviewDebounceMs);
  }

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

  function getDiffViewportTop(viewportTop: number): number {
    const diffElement = pendingDiffRef.current;
    const editorElement = editorViewRef.current?.scrollDOM;
    if (!diffElement || !editorElement) {
      return viewportTop;
    }

    const diffTop = diffElement.getBoundingClientRect().top;
    const editorTop = editorElement.getBoundingClientRect().top;
    return Math.max(0, viewportTop + editorTop - diffTop + diffLineAlignmentOffset);
  }

  function scrollPendingDiffToEditorLine(
    lineNumber: number,
    options: { viewportTop?: number; lineProgress?: number } = {}
  ): boolean {
    const diffElement = pendingDiffRef.current;
    if (!diffElement) {
      return false;
    }

    const target = diffElement.querySelector<HTMLElement>(`[data-after-line="${lineNumber}"]`);
    if (!target) {
      return false;
    }

    const maxScrollTop = diffElement.scrollHeight - diffElement.clientHeight;
    const viewportTop = getDiffViewportTop(options.viewportTop ?? 8);
    const lineProgress = clampRatio(options.lineProgress ?? 0);
    const diffRect = diffElement.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = targetRect.top - diffRect.top + diffElement.scrollTop;
    diffElement.scrollTop = Math.max(
      0,
      Math.min(maxScrollTop, targetTop + targetRect.height * lineProgress - viewportTop)
    );
    return true;
  }

  function scrollPendingDiffForEditorLine(
    lineNumber: number,
    options: { viewportTop?: number; lineProgress?: number } = {}
  ): void {
    const lineIndex = Math.max(0, lineNumber - 1);
    setCurrentEditorLine(lineNumber);

    if (isLargeDiffPreview || !scrollPendingDiffToEditorLine(lineNumber, options)) {
      const totalLines = editorViewRef.current?.state.doc.lines ?? countLines(editorContent);
      const ratio = totalLines <= 1 ? 0 : lineIndex / (totalLines - 1);
      scrollPendingDiffToRatio(ratio);
    }
  }

  function syncPendingDiffToEditorCursor(
    lineNumber: number,
    viewportTop: number,
    lineProgress: number
  ): void {
    window.requestAnimationFrame(() => {
      scrollPendingDiffForEditorLine(lineNumber, { viewportTop, lineProgress });
    });
  }

  function syncPendingDiffToEditorScroll(
    lineNumber: number,
    viewportTop: number,
    lineProgress: number
  ): void {
    scrollPendingDiffForEditorLine(lineNumber, { viewportTop, lineProgress });
  }

  function startFileListResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (window.matchMedia("(max-width: 960px)").matches) {
      return;
    }

    event.preventDefault();
    setResizingFileList(true);
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
        setDiffPreviewContent("");
        setEditorDirty(false);
        setIsDiffPreviewStale(false);
        clearDiffPreviewTimer();
        setLargeDiffPreviewMode(false);
        setCurrentEditorLine(1);
        setFileConflict(null);
        setFileValidationError(null);
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
        setDiffPreviewContent(detail.content);
        setEditorDirty(false);
        setIsDiffPreviewStale(false);
        clearDiffPreviewTimer();
        setLargeDiffPreviewMode(
          detail.headContent.length + detail.content.length > largeDiffPreviewThreshold
        );
        setCurrentEditorLine(1);
        setFileConflict(null);
        setFileValidationError(null);
      }
    });
  }

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        const authResponse = await fetch("/api/auth/me");
        if (!authResponse.ok) {
          resetAuthenticatedState();
          setError(null);
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
    void refreshFile(selectedPath, false).catch((fetchError) => {
      if (handleAuthRequired(fetchError)) {
        return;
      }
      setError((fetchError as Error).message);
    });
  }, [selectedPath]);

  useEffect(() => {
    const history = fileDetail?.history ?? [];
    if (!history.length) {
      setSelectedHistoryHash("");
      return;
    }

    setSelectedHistoryHash((current) =>
      current && history.some((item) => item.hash === current)
        ? current
        : history[0].hash
    );
  }, [fileDetail?.path, fileDetail?.history]);

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
          if (handleAuthRequired(fetchError)) {
            return;
          }
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

  useEffect(() => {
    if (!authUser || !message) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessage(null);
    }, 3200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [authUser, message]);

  useEffect(() => {
    if (!authUser || !liveNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLiveNotice(null);
    }, 3200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [authUser, liveNotice]);

  useEffect(() => {
    if (!authUser || !error) {
      return;
    }

    const timer = window.setTimeout(() => {
      setError(null);
    }, 5200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [authUser, error]);

  useEffect(() => {
    if (!resizingFileList) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(event: PointerEvent): void {
      const layoutElement = layoutRef.current;
      if (!layoutElement) {
        return;
      }

      const rect = layoutElement.getBoundingClientRect();
      const maxWidth = Math.max(
        fileListMinWidth,
        Math.min(fileListMaxWidth, rect.width - mainContentMinWidth - 22)
      );
      setFileListWidth(
        clampNumber(event.clientX - rect.left, fileListMinWidth, maxWidth)
      );
    }

    function stopResizing(): void {
      setResizingFileList(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [resizingFileList]);

  async function discardCurrentFile(): Promise<void> {
    if (!selectedPath) {
      return;
    }
    if (isProtectedFileReadOnly) {
      setError("普通用户在当前环境仅可查看文件与历史记录");
      return;
    }

    if (!editorDirty && !fileDetail?.isDirty) {
      setMessage("当前文件没有可丢弃的修改");
      setError(null);
      return;
    }

    if (!window.confirm("确认丢弃当前文件的未提交修改？编辑区内容会恢复到当前 HEAD。")) {
      return;
    }

    setDiscarding(true);
    setError(null);
    setMessage(null);
    setFileConflict(null);
    setFileValidationError(null);

    try {
      const detail = await requestJson<FileDetail>("/api/file/discard", {
        method: "POST",
        body: JSON.stringify({
          path: selectedPath
        })
      });

      startTransition(() => {
        setFileDetail(detail);
        setEditorContent(detail.content);
        setDiffPreviewContent(detail.content);
        setEditorDirty(false);
        clearDiffPreviewTimer();
        setLargeDiffPreviewMode(
          detail.headContent.length + detail.content.length > largeDiffPreviewThreshold
        );
        setCurrentEditorLine(1);
      });
      setSelectedHistoryHash(detail.history[0]?.hash ?? "");
      setMessage("已丢弃当前文件的未提交修改");
      await refreshBootstrap(selectedPath);
    } catch (discardError) {
      if (handleAuthRequired(discardError)) {
        return;
      }
      setError((discardError as Error).message);
    } finally {
      setDiscarding(false);
    }
  }

  async function commitAndPush(): Promise<void> {
    if (!selectedPath) {
      return;
    }
    if (isProtectedFileReadOnly) {
      setConfirmingCommit(false);
      setError("普通用户在当前环境仅可查看文件与历史记录");
      return;
    }

    setConfirmingCommit(false);
    setCommitting(true);
    setError(null);
    setMessage(null);
    setFileValidationError(null);

    try {
      if (!fileDetail) {
        throw new Error("请先选择要提交的文件");
      }

      const latestContent = getLatestEditorContent();
      await requestJson<{ head: string; path: string }>("/api/commit", {
        method: "POST",
        body: JSON.stringify({
          path: selectedPath,
          content: latestContent,
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
      } else if (handleAuthRequired(commitError)) {
        return;
      } else if (
        commitError instanceof ApiRequestError &&
        commitError.status === 400 &&
        isFileValidationPayload(commitError.payload)
      ) {
        setFileValidationError(commitError.payload.message);
      }
      setError((commitError as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  async function restoreHistoryCommit(commit: CommitSnapshot): Promise<void> {
    if (!selectedPath || !fileDetail) {
      return;
    }
    if (isProtectedFileReadOnly) {
      setError("普通用户在当前环境仅可查看文件与历史记录");
      return;
    }

    if (
      editorDirty &&
      !window.confirm("编辑区有未提交的内容，回滚会用历史版本覆盖当前文件。确认继续？")
    ) {
      return;
    }

    setRestoringHash(commit.hash);
    setError(null);
    setMessage(null);
    setFileValidationError(null);

    try {
      await requestJson<{ head: string; path: string }>("/api/file/restore", {
        method: "POST",
        body: JSON.stringify({
          path: selectedPath,
          hash: commit.hash,
          baseHead: fileDetail.baseHead,
          baseBlob: fileDetail.baseBlob
        })
      });

      setFileConflict(null);
      await refreshBootstrap(selectedPath);
      await refreshFile(selectedPath, false);
      setMessage("已回滚到所选历史版本并推送到远程仓库");
    } catch (restoreError) {
      if (
        restoreError instanceof ApiRequestError &&
        restoreError.status === 409 &&
        isFileConflictPayload(restoreError.payload)
      ) {
        const conflictPayload = restoreError.payload;
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
      } else if (handleAuthRequired(restoreError)) {
        return;
      } else if (
        restoreError instanceof ApiRequestError &&
        restoreError.status === 400 &&
        isFileValidationPayload(restoreError.payload)
      ) {
        setFileValidationError(restoreError.payload.message);
      }
      setError((restoreError as Error).message);
    } finally {
      setRestoringHash(null);
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
      if (handleAuthRequired(syncError)) {
        return;
      }
      setError((syncError as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function loadReviewChanges(environmentId = activeEnvironment?.id): Promise<void> {
    if (!environmentId) {
      setError("请先选择环境");
      return;
    }

    const requestId = reviewRequestIdRef.current + 1;
    reviewRequestIdRef.current = requestId;
    setReviewOpen(true);
    setReviewLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        environmentId,
        since: reviewSince,
        until: reviewUntil
      });
      const payload = await requestJson<{ commits: EnvironmentReviewCommit[] }>(
        `/api/review/changes?${params.toString()}`
      );
      if (requestId !== reviewRequestIdRef.current) {
        return;
      }
      setReviewCommits(payload.commits);
      const firstCommit = payload.commits[0] ?? null;
      selectReviewCommit(firstCommit, environmentId);
    } catch (reviewError) {
      if (requestId !== reviewRequestIdRef.current) {
        return;
      }
      if (handleAuthRequired(reviewError)) {
        return;
      }
      setError((reviewError as Error).message);
    } finally {
      if (requestId === reviewRequestIdRef.current) {
        setReviewLoading(false);
      }
    }
  }

  function selectReviewCommit(
    commit: EnvironmentReviewCommit | null,
    environmentId = activeEnvironment?.id
  ): void {
    setSelectedReviewHash(commit?.hash ?? "");
    if (commit?.files.length === 1) {
      void loadReviewDiff(commit, commit.files[0].path, environmentId);
      return;
    }
    reviewDiffRequestIdRef.current += 1;
    setSelectedReviewPath("");
    setReviewDiff(null);
  }

  async function loadReviewDiff(
    commit: EnvironmentReviewCommit,
    filePath: string,
    environmentId = activeEnvironment?.id
  ): Promise<void> {
    if (!environmentId) {
      return;
    }

    setSelectedReviewHash(commit.hash);
    setSelectedReviewPath(filePath);
    const diffRequestId = reviewDiffRequestIdRef.current + 1;
    reviewDiffRequestIdRef.current = diffRequestId;
    setReviewDiffLoading(true);
    setReviewDiff(null);
    setError(null);

    try {
      const params = new URLSearchParams({
        environmentId,
        hash: commit.hash,
        path: filePath
      });
      const diff = await requestJson<EnvironmentReviewDiff>(`/api/review/diff?${params.toString()}`);
      if (diffRequestId !== reviewDiffRequestIdRef.current) {
        return;
      }
      setReviewDiff(diff);
    } catch (reviewError) {
      if (diffRequestId !== reviewDiffRequestIdRef.current) {
        return;
      }
      if (handleAuthRequired(reviewError)) {
        return;
      }
      setError((reviewError as Error).message);
    } finally {
      if (diffRequestId === reviewDiffRequestIdRef.current) {
        setReviewDiffLoading(false);
      }
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
      if (handleAuthRequired(loginError)) {
        return;
      }
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
    resetAuthenticatedState();
    setError(null);
    setMessage(null);
  }

  async function submitActivationCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setActivatingAdmin(true);
    setError(null);
    setMessage(null);

    try {
      const payload = await requestJson<AuthResponse>("/api/auth/activate-admin", {
        method: "POST",
        body: JSON.stringify({
          code: activationCode
        })
      });
      setAuthUser(payload.user);
      setActivationCode("");
      setActivationDialogOpen(false);
      setAccountMenuOpen(false);
      setMessage("已升级为管理员");
    } catch (activationError) {
      if (handleAuthRequired(activationError)) {
        return;
      }
      setError((activationError as Error).message);
    } finally {
      setActivatingAdmin(false);
    }
  }

  async function openEnvironmentSettings(): Promise<void> {
    if (authUser?.role !== "admin") {
      setError("仅管理员可配置环境");
      return;
    }

    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<EnvironmentSettingsResponse>("/api/settings/environments");
      setEnvironmentDraft(payload.environments);
      setShowEnvironmentSettings(true);
    } catch (settingsError) {
      if (handleAuthRequired(settingsError)) {
        return;
      }
      setError((settingsError as Error).message);
    }
  }

  function updateEnvironmentDraft(
    index: number,
    patch: Partial<RepoEnvironmentOption>
  ): void {
    setEnvironmentDraft((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
    );
  }

  function addEnvironmentDraft(): void {
    setEnvironmentDraft((current) => [
      ...current,
      createBlankEnvironment(current.length, current[current.length - 1])
    ]);
  }

  function removeEnvironmentDraft(index: number): void {
    setEnvironmentDraft((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  async function saveEnvironmentSettings(): Promise<void> {
    const normalized = environmentDraft.map((item, index) => ({
      ...item,
      id: item.id.trim() || createEnvironmentId(item.label, index),
      label: item.label.trim(),
      root: item.root.trim().replace(/^\/+|\/+$/g, "")
    }));
    if (!normalized.length) {
      setError("至少需要保留一个环境配置");
      return;
    }
    if (normalized.some((item) => !item.label || !item.root)) {
      setError("环境名称和展示目录不能为空");
      return;
    }

    setSavingEnvironmentSettings(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<EnvironmentSettingsResponse>("/api/settings/environments", {
        method: "PUT",
        body: JSON.stringify({
          environments: normalized
        })
      });
      setEnvironmentDraft(payload.environments);
      await refreshBootstrap(selectedPath || undefined);
      setShowEnvironmentSettings(false);
      setMessage("环境配置已保存");
    } catch (settingsError) {
      if (handleAuthRequired(settingsError)) {
        return;
      }
      setError((settingsError as Error).message);
    } finally {
      setSavingEnvironmentSettings(false);
    }
  }

  const files: RepoFileSummary[] = bootstrap?.files ?? [];
  const environmentOptions = bootstrap?.config.environments ?? [];
  const activeEnvironment =
    environmentOptions.find((item) => item.id === selectedEnvironment) ?? environmentOptions[0];
  const selectedFileEnvironment =
    environmentOptions.find(
      (item) => selectedPath && getPathWithinRoot(selectedPath, item.root) !== null
    ) ?? activeEnvironment;
  const displayRoot =
    activeEnvironment
      ? activeEnvironment.root
      : bootstrap?.config.visibleRoots?.join(" / ") || "-";
  const repoHead = bootstrap?.repoStatus.head ?? null;
  const remoteUrl = bootstrap?.config.remoteUrl || "-";
  const currentRoleLabel = authUser?.role === "admin" ? "管理员" : "普通用户";
  const isProtectedFileReadOnly =
    authUser?.role !== "admin" &&
    (selectedFileEnvironment?.requiresAdminToEdit ??
      isProtectedEnvironmentId(selectedFileEnvironment?.id));
  const environmentFiles = useMemo(
    () =>
      activeEnvironment
        ? files.filter((file) => getPathWithinRoot(file.path, activeEnvironment.root) !== null)
        : files,
    [activeEnvironment, files]
  );
  const visibleFiles = environmentFiles;
  const normalizedFileQuery = fileQuery.trim().toLocaleLowerCase();
  const filteredVisibleFiles = useMemo(
    () =>
      normalizedFileQuery
        ? visibleFiles.filter((file) => {
          const relativePath =
            activeEnvironment ? getPathWithinRoot(file.path, activeEnvironment.root) : file.path;
          const searchTarget = `${file.path}\n${relativePath ?? ""}\n${file.path.split("/").pop() ?? ""}`.toLocaleLowerCase();
          return searchTarget.includes(normalizedFileQuery);
        })
        : visibleFiles,
    [activeEnvironment, normalizedFileQuery, visibleFiles]
  );
  const fileTree = useMemo(
    () =>
      activeEnvironment
        ? buildFileTree(
          filteredVisibleFiles,
          (file) => getPathWithinRoot(file.path, activeEnvironment.root),
          activeEnvironment.root
        )
        : [],
    [activeEnvironment, filteredVisibleFiles]
  );
  const repoReady = bootstrap?.repoStatus.ready ?? false;
  const pendingBaseContent = fileDetail?.headContent ?? "";
  const diffPreviewStatusText = isDiffPreviewStale
    ? isLargeDiffPreview
      ? "大文件模式已关闭实时差异预览"
      : "差异预览稍后刷新"
    : null;
  const hasPendingChanges =
    Boolean(selectedPath) &&
    (editorDirty || pendingBaseContent !== (fileDetail?.content ?? ""));
  const canDiscardCurrentFile =
    Boolean(selectedPath) &&
    !isProtectedFileReadOnly &&
    !committing &&
    (editorDirty || Boolean(fileDetail?.isDirty));
  const fileHistory = fileDetail?.history ?? [];
  const selectedHistory =
    fileHistory.find((commit) => commit.hash === selectedHistoryHash) ?? fileHistory[0] ?? null;
  const selectedReviewCommit =
    reviewCommits.find((commit) => commit.hash === selectedReviewHash) ?? reviewCommits[0] ?? null;
  const workspaceLayoutStyle = {
    "--file-list-grid": `${fileListWidth}px minmax(0, 1fr)`
  } as CSSProperties;

  useEffect(() => clearDiffPreviewTimer, []);

  if (!authChecked || loading) {
    return <div className="p-7 text-[#43555d]">正在加载...</div>;
  }

  if (!authUser) {
    return (
      <AuthScreen
        authMode={authMode}
        error={error}
        loggingIn={loggingIn}
        loginForm={loginForm}
        onSubmit={(event) => void submitLogin(event)}
        onFormChange={setLoginForm}
        onModeToggle={() => {
          setAuthMode((current) => (current === "login" ? "register" : "login"));
          setError(null);
          setLoginForm({
            username: "",
            password: "",
            confirmPassword: ""
          });
        }}
      />
    );
  }

  return (
    <div className="p-4 sm:p-7">
      <ToastStack message={message} liveNotice={liveNotice} error={error} />
      {confirmingCommit && !isProtectedFileReadOnly ? (
        <CommitConfirmDialog
          selectedPath={selectedPath}
          commitMessage={gitForm.extraMessage}
          committing={committing}
          onCancel={() => setConfirmingCommit(false)}
          onConfirm={() => void commitAndPush()}
        />
      ) : null}
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
          <div className="relative">
            <button
              className="flex w-full items-center justify-between gap-3 rounded-[22px] border border-slate-900/10 bg-white/70 px-5 py-4 text-left shadow-[0_24px_60px_rgba(54,77,80,0.1)] transition duration-200 hover:-translate-y-px"
              onClick={() => setAccountMenuOpen((current) => !current)}
              type="button"
            >
              <div className="min-w-0">
                <strong className="block truncate">{authUser.id}</strong>
                <div className="mt-1.5 text-sm text-[#728188]">当前账号</div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-semibold",
                  authUser.role === "admin"
                    ? "bg-[#0e6b72]/10 text-[#0e6b72]"
                    : "bg-[#143138]/[0.08] text-[#53676e]"
                )}
              >
                {currentRoleLabel}
              </span>
            </button>
            {accountMenuOpen ? (
              <div className="absolute right-0 z-30 mt-2 grid w-48 gap-1 rounded-[18px] border border-slate-900/10 bg-white p-2 shadow-[0_20px_50px_rgba(33,51,63,0.16)]">
                {authUser.role === "admin" ? (
                  <button
                    className="rounded-2xl border-0 bg-transparent px-3 py-2.5 text-left text-[#183039] hover:bg-[#143138]/[0.08]"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      void openEnvironmentSettings();
                    }}
                    type="button"
                  >
                    环境配置
                  </button>
                ) : null}
                <button
                  className="rounded-2xl border-0 bg-transparent px-3 py-2.5 text-left text-[#183039] hover:bg-[#143138]/[0.08]"
                  onClick={() => {
                    setActivationDialogOpen(true);
                    setAccountMenuOpen(false);
                  }}
                  type="button"
                >
                  输入激活码
                </button>
                <button
                  className="rounded-2xl border-0 bg-transparent px-3 py-2.5 text-left text-[#183039] hover:bg-[#143138]/[0.08]"
                  onClick={() => void logoutCurrentUser()}
                  type="button"
                >
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {activationDialogOpen ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[#10262b]/35 px-4">
          <form
            className="w-full max-w-md rounded-[24px] border border-slate-900/10 bg-white p-5 shadow-[0_28px_80px_rgba(16,38,43,0.24)]"
            onSubmit={(event) => void submitActivationCode(event)}
          >
            <div className="mb-4">
              <h2 className="m-0 text-xl">输入激活码</h2>
              <p className="mt-2 text-sm text-[#728188]">
                激活码和当前账号绑定，校验成功后该账号会升级为管理员。
              </p>
            </div>
            <label className={formRowClass}>
              <span className={formLabelClass}>激活码</span>
              <input
                className={inputClass}
                onChange={(event) => setActivationCode(event.target.value)}
                placeholder="ADM1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                value={activationCode}
              />
            </label>
            <div className="mt-5 flex justify-end gap-3">
              <button
                className={secondaryButtonClass}
                onClick={() => {
                  setActivationDialogOpen(false);
                  setActivationCode("");
                }}
                type="button"
              >
                取消
              </button>
              <button
                className={primaryButtonClass}
                disabled={!activationCode.trim() || activatingAdmin}
                type="submit"
              >
                {activatingAdmin ? "激活中..." : "激活"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {showEnvironmentSettings ? (
        <main className={panelClass}>
          <div className={panelTitleRowClass}>
            <div>
              <h2 className="m-0 text-lg">环境配置</h2>
              <div className="mt-1.5 text-sm text-[#728188]">
                配置环境名称、展示目录和编辑权限。
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                className={secondaryButtonClass}
                onClick={() => {
                  setShowEnvironmentSettings(false);
                  setEnvironmentDraft([]);
                }}
                type="button"
              >
                返回
              </button>
              <button
                className={primaryButtonClass}
                disabled={savingEnvironmentSettings}
                onClick={() => void saveEnvironmentSettings()}
                type="button"
              >
                {savingEnvironmentSettings ? "保存中..." : "保存环境配置"}
              </button>
            </div>
          </div>

          <div className="grid gap-3">
            {environmentDraft.map((environment, index) => (
              <div
                className="grid gap-3 rounded-[22px] border border-[#183039]/10 bg-[#f6f9f7]/85 p-4"
                key={environment.id || index}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <strong className="text-[#183039]">环境 {index + 1}</strong>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-sm font-semibold text-[#40545b]">
                      <input
                        checked={environment.requiresAdminToEdit}
                        onChange={(event) =>
                          updateEnvironmentDraft(index, {
                            requiresAdminToEdit: event.target.checked
                          })
                        }
                        type="checkbox"
                      />
                      需要管理员权限编辑
                    </label>
                    <button
                      className="rounded-2xl border-0 bg-[#c94a35]/10 px-4 py-2.5 text-[#9f2f20] transition duration-200 hover:-translate-y-px hover:bg-[#c94a35]/15 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0"
                      disabled={environmentDraft.length <= 1}
                      onClick={() => removeEnvironmentDraft(index)}
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                </div>
                <div className="grid gap-3 xl:grid-cols-[minmax(180px,0.8fr)_minmax(320px,1.4fr)]">
                  <label className={formRowClass}>
                    <span className={formLabelClass}>环境名称</span>
                    <input
                      className={inputClass}
                      onChange={(event) =>
                        updateEnvironmentDraft(index, {
                          label: event.target.value,
                          id: createEnvironmentId(event.target.value, index)
                        })
                      }
                      value={environment.label}
                    />
                  </label>
                  <label className={formRowClass}>
                    <span className={formLabelClass}>展示目录</span>
                    <input
                      className={inputClass}
                      onChange={(event) =>
                        updateEnvironmentDraft(index, {
                          root: event.target.value
                        })
                      }
                      placeholder="nacos-config/config/dev"
                      value={environment.root}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>

          <button
            className={cn(secondaryButtonClass, "mt-3")}
            onClick={addEnvironmentDraft}
            type="button"
          >
            新增环境
          </button>
        </main>
      ) : (
      <div
        ref={layoutRef}
        className="grid gap-[22px] min-[961px]:grid-cols-[var(--file-list-grid)]"
        style={workspaceLayoutStyle}
      >
        <aside className={cn(panelClass, "relative min-w-0 overflow-x-hidden min-[961px]:sticky min-[961px]:top-5 min-[961px]:max-h-[calc(100vh-40px)] min-[961px]:overflow-y-auto")}>
          <div className={panelTitleRowClass}>
            <h2 className="m-0 text-lg">文件列表</h2>
            <button className={secondaryButtonClass} onClick={() => void syncRepository()} disabled={syncing}>
              {syncing ? "同步中..." : "同步仓库"}
            </button>
          </div>

          <div className={formRowClass}>
            <span className={formLabelClass}>当前环境</span>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <select
                className={inputClass}
                value={activeEnvironment?.id ?? ""}
                onChange={(event) => {
                  const nextEnvironmentId = event.target.value;
                  setSelectedEnvironment(nextEnvironmentId);
                  reviewDiffRequestIdRef.current += 1;
                  setReviewCommits([]);
                  setSelectedReviewHash("");
                  setReviewDiff(null);
                  setSelectedReviewPath("");
                  if (reviewOpen) {
                    void loadReviewChanges(nextEnvironmentId);
                  }
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
              <button
                className={cn(secondaryButtonClass, "w-[104px] justify-center whitespace-nowrap px-0")}
                type="button"
                onClick={() => void loadReviewChanges()}
                disabled={reviewLoading}
              >
                版本比对
              </button>
            </div>
          </div>

          <div className="mb-3 min-w-0 rounded-2xl bg-[#e8f1f0]/70 px-3 py-2">
            <div className="flex min-h-[34px] min-w-0 items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate text-sm text-[#183039]"
                title={remoteUrl}
              >
                {remoteUrl}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-full bg-white/70 px-3 py-1.5 text-xs text-[#315159] transition hover:bg-white"
                onClick={() => setShowRepoDetails((current) => !current)}
              >
                {showRepoDetails ? "收起" : "详情"}
              </button>
            </div>

            {showRepoDetails ? (
              <div className="mt-2 grid min-w-0 gap-2 border-t border-[#183039]/10 pt-2 text-sm">
                <div className="min-w-0">
                  <span className="mb-0.5 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">远程仓库</span>
                  <span className="block min-w-0 break-all text-[#183039]">{remoteUrl}</span>
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2">
                  <div className="min-w-0">
                    <span className="mb-0.5 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">分支</span>
                    <span className="block min-w-0 truncate text-[#183039]" title={bootstrap?.config.branch || "-"}>
                      {bootstrap?.config.branch || "-"}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <span className="mb-0.5 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">当前 HEAD</span>
                    <span className="block min-w-0 truncate font-mono text-xs text-[#183039]" title={repoHead || "-"}>
                      {repoHead || "-"}
                    </span>
                  </div>
                </div>
                <div className="min-w-0">
                  <span className="mb-0.5 block text-xs uppercase tracking-[0.08em] text-[#6c7d83]">展示目录</span>
                  <span className="block min-w-0 break-all text-[#183039]">{displayRoot}</span>
                </div>
              </div>
            ) : null}
          </div>

          <label className="mb-4 flex min-h-[42px] items-center gap-2 rounded-xl border border-[#dfe4e6] bg-white px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
            <svg
              className="h-[18px] w-[18px] shrink-0 text-[#8b9499]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <input
              className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-[#24292f] outline-none placeholder:text-[#8b8f93]"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="搜索文件名..."
            />
          </label>

          <div className="-mx-2 min-w-0 overflow-x-hidden rounded-xl bg-[#f1f5f4] px-2 py-2">
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
          <button
            type="button"
            aria-label="拖动调整文件列表宽度"
            className={cn(
              "absolute inset-y-4 right-0 hidden w-3 cursor-col-resize touch-none rounded-full transition min-[961px]:block",
              resizingFileList ? "bg-[#0e6b72]/15" : "hover:bg-[#0e6b72]/10"
            )}
            onPointerDown={startFileListResize}
          >
            <span
              className={cn(
                "absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full transition",
                resizingFileList ? "bg-[#0e6b72]/70" : "bg-[#183039]/15"
              )}
            />
          </button>
        </aside>

        <main className="grid gap-[22px]">
          {reviewOpen ? (
            <section className={panelClass}>
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="m-0 text-lg">版本比对</h2>
                  <div className="mt-2 text-sm text-[#5d7077]">
                    {activeEnvironment?.label ?? "当前环境"} 自指定日期至今的配置改动
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="text-sm text-[#4d6269]">
                    <div className="flex items-center gap-2">
                      <input
                        className={cn(inputClass, "review-date-input h-[34px] w-[160px] py-1.5")}
                        type="date"
                        value={reviewSince}
                        onChange={(event) => setReviewSince(event.target.value)}
                      />
                      <span className="text-[#8a999f]">-</span>
                      <input
                        className={cn(inputClass, "review-date-input h-[34px] w-[160px] py-1.5")}
                        type="date"
                        value={reviewUntil}
                        onChange={(event) => setReviewUntil(event.target.value)}
                      />
                    </div>
                  </div>
                  <button
                    className={cn(secondaryButtonClass, "w-[72px] justify-center px-0")}
                    type="button"
                    onClick={() => void loadReviewChanges()}
                    disabled={reviewLoading}
                  >
                    {reviewLoading ? "查询中..." : "查询"}
                  </button>
                  <button
                    className={secondaryButtonClass}
                    type="button"
                    onClick={() => setReviewOpen(false)}
                  >
                    关闭
                  </button>
                </div>
              </div>

              {reviewLoading && reviewCommits.length === 0 ? (
                <div className={emptyBlockClass}>正在查询版本改动...</div>
              ) : reviewCommits.length === 0 ? (
                <div className={emptyBlockClass}>当前环境在该日期之后没有配置改动</div>
              ) : (
                <div className="grid gap-4 min-[1080px]:grid-cols-[340px_minmax(0,1fr)]">
                  <div className="min-h-0 overflow-hidden rounded-[22px] border border-[#183039]/10 bg-[#f6f9f7]/85">
                    <div className="border-b border-[#183039]/10 px-4 py-3 text-sm font-semibold text-[#20404a]">
                      {reviewCommits.length >= 200 ? "最近 200 次相关提交" : `${reviewCommits.length} 次相关提交`}
                    </div>
                    <div className="max-h-[520px] overflow-auto p-2">
                      {reviewCommits.map((commit) => {
                        const isSelected = commit.hash === selectedReviewCommit?.hash;
                        return (
                          <button
                            key={commit.hash}
                            className={cn(
                              "mb-2 w-full rounded-[18px] border px-3.5 py-3 text-left transition duration-200",
                              isSelected
                                ? "border-[#0e6b72]/25 bg-white shadow-[0_14px_32px_rgba(28,64,54,0.12)]"
                                : "border-transparent bg-transparent hover:bg-white/75"
                            )}
                            type="button"
                            onClick={() => selectReviewCommit(commit)}
                          >
                            <span className="block break-words text-sm font-semibold text-[#183039]">
                              {commit.message || "更新配置"}
                            </span>
                            <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#61747b]">
                              <span>{commit.authorName}</span>
                              <span>{formatTime(commit.committedAt)}</span>
                              <span>{commit.files.length} 个文件</span>
                            </span>
                            <span className="mt-2 block break-all font-mono text-[12px] text-[#6b7d84]">
                              {commit.hash}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="min-w-0">
                    {selectedReviewCommit ? (
                      <>
                        <div className="mb-3.5 flex flex-wrap items-center gap-2">
                          <span className="break-all font-mono text-xs text-[#5d7077]">
                            {selectedReviewCommit.hash}
                          </span>
                          <span className="rounded-full bg-[#134e5e]/10 px-3 py-1.5 text-xs text-[#214954]">
                            {selectedReviewCommit.files.length} 个文件
                          </span>
                        </div>
                        <div className="mb-3 grid max-h-[220px] gap-2 overflow-auto rounded-[18px] border border-[#183039]/10 bg-[#f6f9f7]/85 p-2">
                          {selectedReviewCommit.files.map((file) => (
                            <button
                              key={`${selectedReviewCommit.hash}-${file.path}`}
                              className={cn(
                                "grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition",
                                selectedReviewPath === file.path
                                  ? "bg-white text-[#183039] shadow-[0_8px_20px_rgba(28,64,54,0.08)]"
                                  : "text-[#40545b] hover:bg-white/75"
                              )}
                              type="button"
                              onClick={() => void loadReviewDiff(selectedReviewCommit, file.path)}
                            >
                              <span className="font-mono text-xs text-[#7b8d94]">{file.status}</span>
                              <span className="min-w-0 break-all">{file.path}</span>
                            </button>
                          ))}
                        </div>
                        {reviewDiffLoading ? (
                          <div className={emptyBlockClass}>正在加载文件差异...</div>
                        ) : reviewDiff ? (
                          <DiffView
                            before={reviewDiff.beforeContent}
                            after={reviewDiff.afterContent}
                            emptyText="该文件在此提交中没有内容变化"
                            className="max-h-[520px] overflow-auto"
                          />
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </section>
          ) : null}

          <section className={panelClass}>
            <div className="mb-4 grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(460px,auto)]">
              <div className="min-w-0">
                <h2 className="m-0 break-words text-lg">{selectedPath || "当前文件"}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#5d7077]">
                  <span className="inline-flex items-center rounded-full bg-[#134e5e]/10 px-3 py-1.5 text-[#214954]">
                    {activeEnvironment?.label ?? "未选择环境"}
                  </span>
                  {isProtectedFileReadOnly ? (
                    <span className="inline-flex items-center rounded-full bg-[#d8a21b]/15 px-3 py-1.5 text-[#785918]">
                      普通用户只读
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-[minmax(220px,1fr)_auto_auto]">
                <textarea
                  className={cn(inputClass, "min-h-[46px] resize-y py-2.5 text-sm")}
                  disabled={isProtectedFileReadOnly}
                  rows={1}
                  value={gitForm.extraMessage}
                  placeholder={isProtectedFileReadOnly ? "当前环境仅管理员可提交" : "commit 信息"}
                  onChange={(event) =>
                    setGitForm((current) => ({
                      ...current,
                      extraMessage: event.target.value
                    }))
                  }
                />
                <button
                  className={secondaryButtonClass}
                  onClick={() => void discardCurrentFile()}
                  disabled={!canDiscardCurrentFile || discarding}
                >
                  {discarding ? "丢弃中..." : "丢弃修改"}
                </button>
                <button
                  className={primaryButtonClass}
                  onClick={() => {
                    if (isProtectedFileReadOnly) {
                      setError("普通用户在当前环境仅可查看文件与历史记录");
                      return;
                    }
                    setConfirmingCommit(true);
                  }}
                  disabled={!selectedPath || isProtectedFileReadOnly || committing || discarding}
                >
                  {committing ? "提交中..." : "提交并推送该文件"}
                </button>
              </div>
            </div>

            {fileConflict ? (
              <div className="mb-3.5 grid gap-3 rounded-2xl border border-[#c94a35]/20 bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#79301f]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <strong>检测到远程冲突</strong>
                    <div className="mt-1 text-[#8d3322]">
                      远程文件已更新，你的编辑内容已保留。
                    </div>
                  </div>
                  <button
                    className={secondaryButtonClass}
                    type="button"
                    onClick={() => {
                      setEditorContent(fileConflict.remoteContent);
                      setDiffPreviewContent(fileConflict.remoteContent);
                      setEditorDirty(false);
                      setIsDiffPreviewStale(false);
                      clearDiffPreviewTimer();
                      setLargeDiffPreviewMode(
                        fileConflict.remoteContent.length * 2 > largeDiffPreviewThreshold
                      );
                      setCurrentEditorLine(1);
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
                  {diffPreviewStatusText ? (
                    <span className="inline-flex items-center rounded-full bg-[#d8a21b]/15 px-3 py-1.5 text-xs text-[#785918]">
                      {diffPreviewStatusText}
                    </span>
                  ) : null}
                </div>
                {isLargeDiffPreview ? (
                  <div
                    ref={pendingDiffRef}
                    className={cn(emptyBlockClass, editorSurfaceHeightClass, "grid content-center")}
                  >
                    大文件模式下已暂停左侧实时差异渲染，避免加载和滚动卡死。提交、冲突检测仍使用右侧最新编辑内容。
                  </div>
                ) : (
                  <DiffView
                    before={pendingBaseContent}
                    after={diffPreviewContent}
                    emptyText={loading ? "正在加载..." : "当前文件没有未提交差异"}
                    className={editorSurfaceHeightClass}
                    scrollRef={pendingDiffRef}
                    showContentWhenUnchanged
                    highlightAfterLine={isDiffPreviewStale ? null : currentEditorLine}
                  />
                )}
              </div>

              <div className="grid content-start gap-3">
                <div className="flex min-h-[32px] items-center gap-2 font-bold text-[#20404a]">
                  在线编辑
                  {isProtectedFileReadOnly ? (
                    <span className="rounded-full bg-[#143138]/[0.08] px-2.5 py-1 text-xs font-semibold text-[#53676e]">
                      只读
                    </span>
                  ) : null}
                </div>
                <div className={cn("overflow-hidden rounded-[22px] border border-[#183039]/10 bg-[#fafcfb]/95", editorSurfaceHeightClass)}>
                  <ConfigEditor
                    value={editorContent}
                    disabled={!selectedPath || isProtectedFileReadOnly}
                    placeholderText="请选择要编辑的文件"
                    onViewReady={(view) => {
                      editorViewRef.current = view;
                    }}
                    onChange={(view) => {
                      setEditorDirty(true);
                      setIsDiffPreviewStale(true);
                      setFileValidationError(null);
                      scheduleDiffPreviewUpdate(view);
                    }}
                    onCursorLineChange={syncPendingDiffToEditorCursor}
                    onViewportLineChange={syncPendingDiffToEditorScroll}
                  />
                </div>
                {fileValidationError ? (
                  <div className="rounded-2xl border border-[#c94a35]/20 bg-[#c94a35]/10 px-3.5 py-3 text-sm text-[#79301f]">
                    <strong>格式校验未通过</strong>
                    <div className="mt-1 break-words text-[#8d3322]">{fileValidationError}</div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className={panelClass}>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 className="m-0 text-lg">文件历史记录</h2>
              <span className="inline-flex items-center rounded-full bg-[#134e5e]/10 px-3 py-1.5 text-xs text-[#214954]">
                {fileHistory.length ? `最近 ${fileHistory.length} 次提交` : "暂无提交记录"}
              </span>
            </div>

            {selectedHistory ? (
              <div className="grid gap-4 min-[1080px]:grid-cols-[340px_minmax(0,1fr)]">
                <div className="min-h-0 overflow-hidden rounded-[22px] border border-[#183039]/10 bg-[#f6f9f7]/85">
                  <div className="border-b border-[#183039]/10 px-4 py-3 text-sm font-semibold text-[#20404a]">
                    历史提交
                  </div>
                  <div className="max-h-[520px] overflow-auto p-2">
                    {fileHistory.map((commit) => {
                      const isSelected = commit.hash === selectedHistory.hash;
                      const commitSubject = getCommitSubject(commit.message);
                      return (
                        <button
                          key={commit.hash}
                          className={cn(
                            "mb-2 w-full rounded-[18px] border px-3.5 py-3 text-left transition duration-200",
                            isSelected
                              ? "border-[#0e6b72]/25 bg-white shadow-[0_14px_32px_rgba(28,64,54,0.12)]"
                              : "border-transparent bg-transparent hover:bg-white/75"
                          )}
                          type="button"
                          onClick={() => setSelectedHistoryHash(commit.hash)}
                        >
                          <span className="block break-words text-sm font-semibold text-[#183039]">
                            {commitSubject}
                          </span>
                          <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#61747b]">
                            <span>{commit.authorName}</span>
                            <span>{formatTime(commit.committedAt)}</span>
                          </span>
                          <span className="mt-2 block break-all font-mono text-[12px] text-[#6b7d84]">
                            {commit.hash}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="break-words text-base font-bold text-[#183039]">
                        {getCommitSubject(selectedHistory.message)}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[13px] text-[#55686f]">
                        <span className="inline-flex min-h-7 items-center rounded-full bg-[#143138]/[0.06] px-3">
                          {selectedHistory.authorName}
                        </span>
                        <span className="inline-flex min-h-7 items-center rounded-full bg-[#143138]/[0.06] px-3">
                          {formatTime(selectedHistory.committedAt)}
                        </span>
                        <span className="inline-flex min-h-7 max-w-full items-center break-all rounded-full bg-[#143138]/[0.06] px-3 font-mono text-[13px]">
                          {selectedHistory.hash}
                        </span>
                      </div>
                      {getCommitBody(selectedHistory.message) ? (
                        <div className="mt-3 whitespace-pre-wrap break-words rounded-2xl border border-[#183039]/10 bg-[#f6f9f7]/85 px-3.5 py-3 text-sm leading-6 text-[#40545b]">
                          {getCommitBody(selectedHistory.message)}
                        </div>
                      ) : null}
                    </div>
                    <button
                      className={primaryButtonClass}
                      type="button"
                      onClick={() => void restoreHistoryCommit(selectedHistory)}
                      disabled={!selectedPath || isProtectedFileReadOnly || restoringHash !== null}
                    >
                      {restoringHash === selectedHistory.hash ? "回滚中..." : "回滚到此版本"}
                    </button>
                  </div>
                  <DiffView
                    before={selectedHistory.beforeContent}
                    after={selectedHistory.afterContent}
                    emptyText="该提交没有内容变化"
                    className="max-h-[520px] overflow-auto"
                  />
                </div>
              </div>
            ) : (
              <div className={emptyBlockClass}>当前文件还没有历史记录可展示</div>
            )}
          </section>
        </main>

      </div>
      )}
    </div>
  );
}
