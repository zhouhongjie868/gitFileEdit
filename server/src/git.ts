import path from "node:path";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import {
  getEnvironmentOptions,
  normalizeVisibleRoots,
  resolveRepoPath
} from "./config";
import { validateConfigFileContent } from "./fileValidation";
import type {
  AppConfig,
  CommitSnapshot,
  FileConflictPayload,
  FileDetail,
  EnvironmentReviewCommit,
  EnvironmentReviewDiff,
  EnvironmentReviewFile,
  RepoFileSummary,
  RepoStatus,
  RuntimeState
} from "./types";
import type { AuthUser } from "./types";

const execFileAsync = promisify(execFile);

export class FileConflictError extends Error {
  statusCode = 409;

  constructor(public payload: FileConflictPayload) {
    super(payload.message);
  }
}

function logRepoDebug(scope: string, payload: Record<string, unknown>): void {
  console.log(`[repo-debug] ${scope}`, JSON.stringify(payload, null, 2));
}

function normalizeRepoRelativePath(repoPath: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolutePath = path.resolve(repoPath, normalized);
  if (!absolutePath.startsWith(repoPath + path.sep) && absolutePath !== repoPath) {
    throw new Error("文件路径不在仓库内");
  }
  return path.relative(repoPath, absolutePath).replace(/\\/g, "/");
}

function isInVisibleRoots(repoRelativePath: string, visibleRoots: string[]): boolean {
  const normalized = repoRelativePath.replace(/^\/+/, "");
  return visibleRoots.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`)
  );
}

function normalizeAllowedFilePath(config: AppConfig, repoPath: string, filePath: string): string {
  const repoRelativePath = normalizeRepoRelativePath(repoPath, filePath);
  const visibleRoots = normalizeVisibleRoots(config);
  if (!isInVisibleRoots(repoRelativePath, visibleRoots)) {
    throw new Error("仅允许访问 dev、sit、uat 目录下的文件");
  }
  return repoRelativePath;
}

function getEnvironmentLabelForFile(config: AppConfig, repoRelativePath: string): string | null {
  const normalizedPath = repoRelativePath.replace(/^\/+/, "");
  const matchedEnvironment = getEnvironmentOptions(config).find((environment) => {
    const root = environment.root.replace(/^\/+|\/+$/g, "");
    return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
  });

  return matchedEnvironment?.label ?? null;
}

function getEnvironmentRoot(config: AppConfig, repoPath: string, environmentId: string): string {
  const environment = getEnvironmentOptions(config).find((item) => item.id === environmentId);
  if (!environment) {
    throw new Error("未知环境");
  }
  return normalizeRepoRelativePath(repoPath, environment.root);
}

function isAllowedConfigFile(config: AppConfig, repoRelativePath: string): boolean {
  return config.repo.allowedExtensions.includes(path.extname(repoRelativePath).toLowerCase());
}

export function getEnvironmentIdForFile(config: AppConfig, filePath: string): string | null {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, filePath);
  const normalizedPath = repoRelativePath.replace(/^\/+/, "");
  const matchedEnvironment = getEnvironmentOptions(config).find((environment) => {
    const root = environment.root.replace(/^\/+|\/+$/g, "");
    return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
  });

  return matchedEnvironment?.id ?? null;
}

function getConfiguredRepoAuth(config: AppConfig): {
  username?: string;
  password?: string;
} {
  const username = config.repo.auth.username.trim();
  const password = config.repo.auth.password.trim();

  return {
    username: username || undefined,
    password: password || undefined
  };
}

function getGitCommitIdentityArgs(config: AppConfig, actor?: AuthUser): string[] {
  const name = actor?.id?.trim() || config.repo.auth.username.trim();
  if (!name) {
    return [];
  }

  return [
    "-c",
    `user.name=${name}`,
    "-c",
    "user.email=git-file-edit@local"
  ];
}

function getGitAuthArgs(config: AppConfig): string[] {
  const auth = getConfiguredRepoAuth(config);
  if (!auth.username || !auth.password) {
    return [];
  }

  const token = Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${token}`];
}

function getRemoteTrackingRef(config: AppConfig): string {
  return `refs/remotes/origin/${config.repo.branch}`;
}

function getRemoteUrlSummary(remoteUrl: string): {
  host: string | null;
  username: string | null;
} {
  try {
    const url = new URL(remoteUrl);
    return {
      host: url.host || null,
      username: url.username || null
    };
  } catch {
    return {
      host: null,
      username: null
    };
  }
}

function buildGitArgsWithManagedCredentials(
  config: AppConfig,
  args: string[]
): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    "credential.interactive=never",
    ...getGitAuthArgs(config),
    ...args
  ];
}

function formatGitError(error: unknown): Error {
  const candidate = error as {
    stdout?: string;
    stderr?: string;
    message?: string;
  };
  const text = [candidate.stderr, candidate.stdout, candidate.message]
    .filter(Boolean)
    .join("\n")
    .trim();
  return new Error(text || "Git 命令执行失败");
}

async function runGit(
  args: string[],
  options: {
    cwd: string;
  }
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0"
      },
      maxBuffer: 10 * 1024 * 1024
    });
    return result.stdout.trimEnd();
  } catch (error) {
    throw formatGitError(error);
  }
}

async function runGitRaw(
  args: string[],
  options: {
    cwd: string;
  }
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0"
      },
      maxBuffer: 10 * 1024 * 1024
    });
    return result.stdout;
  } catch (error) {
    throw formatGitError(error);
  }
}

export async function repoExists(repoPath: string): Promise<boolean> {
  try {
    await access(path.join(repoPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function inspectRepo(
  config: AppConfig,
  runtime: RuntimeState,
  lastError: string | null
): Promise<RepoStatus> {
  const repoPath = resolveRepoPath(config);
  const exists = await repoExists(repoPath);
  if (!exists) {
    logRepoDebug("inspectRepo.missing", {
      repoPath,
      branch: config.repo.branch,
      lastError,
      lastSyncedAt: runtime.lastSyncedAt
    });
    return {
      ready: false,
      exists: false,
      repoPath,
      remoteUrl: config.repo.remoteUrl,
      branch: config.repo.branch,
      currentBranch: null,
      head: null,
      lastError,
      lastSyncedAt: runtime.lastSyncedAt
    };
  }

  try {
    const [currentBranch, head] = await Promise.all([
      runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath }),
      runGit(["rev-parse", "HEAD"], { cwd: repoPath })
    ]);

    logRepoDebug("inspectRepo.ready", {
      repoPath,
      branch: config.repo.branch,
      currentBranch,
      head,
      lastError,
      lastSyncedAt: runtime.lastSyncedAt
    });

    return {
      ready: true,
      exists: true,
      repoPath,
      remoteUrl: config.repo.remoteUrl,
      branch: config.repo.branch,
      currentBranch: currentBranch || null,
      head: head || null,
      lastError,
      lastSyncedAt: runtime.lastSyncedAt
    };
  } catch (error) {
    logRepoDebug("inspectRepo.error", {
      repoPath,
      branch: config.repo.branch,
      error: (error as Error).message,
      lastSyncedAt: runtime.lastSyncedAt
    });
    return {
      ready: false,
      exists: true,
      repoPath,
      remoteUrl: config.repo.remoteUrl,
      branch: config.repo.branch,
      currentBranch: null,
      head: null,
      lastError: (error as Error).message,
      lastSyncedAt: runtime.lastSyncedAt
    };
  }
}

export async function syncRepo(
  config: AppConfig,
  _runtime: RuntimeState
): Promise<void> {
  const repoPath = resolveRepoPath(config);
  const remoteUrl = config.repo.remoteUrl;
  const remoteTrackingRef = getRemoteTrackingRef(config);
  const auth = getConfiguredRepoAuth(config);
  const remoteUrlSummary = getRemoteUrlSummary(remoteUrl);
  await mkdir(path.dirname(repoPath), { recursive: true });

  if (!(await repoExists(repoPath))) {
    logRepoDebug("syncRepo.clone.start", {
      repoPath,
      branch: config.repo.branch,
      remoteUrl: config.repo.remoteUrl,
      username: auth.username || null,
      resolvedRemoteHost: remoteUrlSummary.host,
      resolvedRemoteUsername: remoteUrlSummary.username
    });
    await runGit(
      buildGitArgsWithManagedCredentials(config, [
        "clone",
        "--branch",
        config.repo.branch,
        "--single-branch",
        remoteUrl,
        repoPath
      ]),
      { cwd: path.dirname(repoPath) }
    );
    logRepoDebug("syncRepo.clone.done", {
      repoPath,
      branch: config.repo.branch
    });
    return;
  }

  logRepoDebug("syncRepo.pull.start", {
    repoPath,
    branch: config.repo.branch,
    remoteUrl: config.repo.remoteUrl,
    username: auth.username || null,
    resolvedRemoteHost: remoteUrlSummary.host,
    resolvedRemoteUsername: remoteUrlSummary.username
  });
  await runGit(
    buildGitArgsWithManagedCredentials(config, [
      "fetch",
      "--prune",
      remoteUrl,
      `+refs/heads/${config.repo.branch}:${remoteTrackingRef}`
    ]),
    {
      cwd: repoPath
    }
  );
  await runGit(["checkout", config.repo.branch], {
    cwd: repoPath
  });
  await runGit(["merge", "--ff-only", remoteTrackingRef], {
    cwd: repoPath
  });
  logRepoDebug("syncRepo.pull.done", {
    repoPath,
    branch: config.repo.branch,
    remoteTrackingRef
  });
}

async function fetchRemoteBranch(config: AppConfig, repoPath: string): Promise<void> {
  await runGit(
    buildGitArgsWithManagedCredentials(config, [
      "fetch",
      "--prune",
      config.repo.remoteUrl,
      `+refs/heads/${config.repo.branch}:${getRemoteTrackingRef(config)}`
    ]),
    {
      cwd: repoPath
    }
  );
}

async function collectFilesystemStats(
  repoPath: string,
  repoRelativePath: string
): Promise<RepoFileSummary> {
  const filePath = path.resolve(repoPath, repoRelativePath);
  try {
    const fileStats = await stat(filePath);
    if (fileStats.isFile()) {
      return {
        path: repoRelativePath,
        size: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString()
      };
    }

    logRepoDebug("collectFilesystemStats.notFile", {
      repoRelativePath
    });
    return {
      path: repoRelativePath,
      size: 0,
      modifiedAt: new Date(0).toISOString()
    };
  } catch {
    logRepoDebug("collectFilesystemStats.statFailed", {
      repoRelativePath
    });
    return {
      path: repoRelativePath,
      size: 0,
      modifiedAt: new Date(0).toISOString()
    };
  }
}

export async function listRepoFiles(config: AppConfig): Promise<RepoFileSummary[]> {
  const repoPath = resolveRepoPath(config);
  const visibleRoots = normalizeVisibleRoots(config);
  const [trackedOutput, untrackedOutput] = await Promise.all([
    runGit(["ls-files"], { cwd: repoPath }),
    runGit(["ls-files", "--others", "--exclude-standard"], { cwd: repoPath })
  ]);
  const trackedFiles = trackedOutput
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const untrackedFiles = untrackedOutput
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const visibleCandidates = [...trackedFiles, ...untrackedFiles].filter((item) =>
    isInVisibleRoots(item, visibleRoots)
  );
  const extensionFilteredOut = visibleCandidates.filter(
    (item) => !config.repo.allowedExtensions.includes(path.extname(item).toLowerCase())
  );
  const candidates = new Set(
    visibleCandidates.filter((item) =>
      config.repo.allowedExtensions.includes(path.extname(item).toLowerCase())
    )
  );

  const files = await Promise.all(
    Array.from(candidates)
      .sort((left, right) => left.localeCompare(right))
      .map((filePath) => collectFilesystemStats(repoPath, filePath))
  );

  const result = files;
  const filesByRoot = Object.fromEntries(
    visibleRoots.map((root) => [
      root,
      result.filter((file) => file.path === root || file.path.startsWith(`${root}/`)).length
    ])
  );

  logRepoDebug("listRepoFiles.summary", {
    repoPath,
    visibleRoots,
    trackedCount: trackedFiles.length,
    untrackedCount: untrackedFiles.length,
    visibleCandidateCount: visibleCandidates.length,
    extensionFilteredOutCount: extensionFilteredOut.length,
    resultCount: result.length,
    filesByRoot,
    sampleVisibleCandidates: visibleCandidates.slice(0, 20),
    sampleExtensionFilteredOut: extensionFilteredOut.slice(0, 20),
    sampleResultFiles: result.slice(0, 20).map((file) => file.path)
  });

  return result;
}

async function readGitFile(
  repoPath: string,
  ref: string,
  repoRelativePath: string
): Promise<string> {
  try {
    return await runGitRaw([`show`, `${ref}:${repoRelativePath}`], { cwd: repoPath });
  } catch {
    return "";
  }
}

async function readRemoteTrackingFile(
  repoPath: string,
  branch: string,
  repoRelativePath: string
): Promise<string> {
  return readGitFile(repoPath, `origin/${branch}`, repoRelativePath);
}

async function readGitBlobId(
  repoPath: string,
  ref: string,
  repoRelativePath: string
): Promise<string | null> {
  const output = await runGit(["rev-parse", `${ref}:${repoRelativePath}`], {
    cwd: repoPath
  }).catch(() => "");
  return output.trim() || null;
}

async function readGitRef(repoPath: string, ref: string): Promise<string | null> {
  const output = await runGit(["rev-parse", ref], { cwd: repoPath }).catch(() => "");
  return output.trim() || null;
}

async function readFileHistorySnapshots(
  repoPath: string,
  repoRelativePath: string,
  limit = 20
): Promise<CommitSnapshot[]> {
  const rawMeta = await runGit(
    [
      "log",
      `-${limit}`,
      "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%B%x1e",
      "--date=iso-strict",
      "--",
      repoRelativePath
    ],
    { cwd: repoPath }
  ).catch(() => "");

  if (!rawMeta) {
    return [];
  }

  const records = rawMeta
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean);

  return Promise.all(
    records.map(async (record) => {
      const [hash, authorName, authorEmail, committedAt, ...messageParts] =
        record.split("\x1f");
      const message = messageParts.join("\x1f").trim();
      const [beforeContent, afterContent] = await Promise.all([
        readGitFile(repoPath, `${hash}^`, repoRelativePath),
        readGitFile(repoPath, hash, repoRelativePath)
      ]);

      return {
        hash,
        authorName,
        authorEmail,
        committedAt,
        message,
        beforeContent,
        afterContent
      };
    })
  );
}

function parseReviewFileLine(
  config: AppConfig,
  environmentRoot: string,
  line: string
): EnvironmentReviewFile | null {
  const [status, ...paths] = line.split("\t");
  const filePath = paths[paths.length - 1]?.trim();
  if (!status || !filePath) {
    return null;
  }
  if (!isInVisibleRoots(filePath, [environmentRoot]) || !isAllowedConfigFile(config, filePath)) {
    return null;
  }
  return {
    path: filePath,
    status
  };
}

export async function readEnvironmentReviewCommits(
  config: AppConfig,
  input: {
    environmentId: string;
    since: string;
    until: string;
  }
): Promise<EnvironmentReviewCommit[]> {
  const repoPath = resolveRepoPath(config);
  const environmentRoot = getEnvironmentRoot(config, repoPath, input.environmentId);
  const rawLog = await runGit(
    [
      "log",
      "--max-count=200",
      `--since=${input.since}`,
      `--until=${input.until} 23:59:59`,
      "--date=iso-strict",
      "--format=%x1e%H%x1f%an%x1f%ae%x1f%ad%x1f%s",
      "--name-status",
      "--",
      environmentRoot
    ],
    { cwd: repoPath }
  ).catch(() => "");

  return rawLog
    .split("\x1e")
    .map((record): EnvironmentReviewCommit | null => {
      const lines = record
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const [meta, ...fileLines] = lines;
      if (!meta) {
        return null;
      }

      const [hash, authorName, authorEmail, committedAt, message] = meta.split("\x1f");
      const files = fileLines
        .map((line) => parseReviewFileLine(config, environmentRoot, line))
        .filter((file): file is EnvironmentReviewFile => Boolean(file));
      if (!hash || files.length === 0) {
        return null;
      }

      return {
        hash,
        authorName,
        authorEmail,
        committedAt,
        message: message ?? "",
        files
      };
    })
    .filter((commit): commit is EnvironmentReviewCommit => Boolean(commit));
}

export async function readEnvironmentReviewDiff(
  config: AppConfig,
  input: {
    environmentId: string;
    hash: string;
    path: string;
  }
): Promise<EnvironmentReviewDiff> {
  const repoPath = resolveRepoPath(config);
  const environmentRoot = getEnvironmentRoot(config, repoPath, input.environmentId);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, input.path);
  if (!isInVisibleRoots(repoRelativePath, [environmentRoot]) || !isAllowedConfigFile(config, repoRelativePath)) {
    throw new Error("文件不在当前环境内");
  }

  const [beforeContent, afterContent] = await Promise.all([
    readGitFile(repoPath, `${input.hash}^`, repoRelativePath),
    readGitFile(repoPath, input.hash, repoRelativePath)
  ]);

  return {
    hash: input.hash,
    path: repoRelativePath,
    beforeContent,
    afterContent
  };
}

export async function readFileDetail(
  config: AppConfig,
  filePath: string
): Promise<FileDetail> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, filePath);
  const absolutePath = path.resolve(repoPath, repoRelativePath);
  const [
    content,
    remoteContent,
    headContent,
    statusOutput,
    fileStats,
    history,
    baseHead,
    baseBlob,
    remoteHead,
    remoteBlob
  ] =
    await Promise.all([
      readFile(absolutePath, "utf8"),
      readRemoteTrackingFile(repoPath, config.repo.branch, repoRelativePath),
      readGitFile(repoPath, "HEAD", repoRelativePath),
      runGit(["status", "--porcelain", "--", repoRelativePath], { cwd: repoPath }).catch(
        () => ""
      ),
      stat(absolutePath),
      readFileHistorySnapshots(repoPath, repoRelativePath),
      readGitRef(repoPath, "HEAD"),
      readGitBlobId(repoPath, "HEAD", repoRelativePath),
      readGitRef(repoPath, `origin/${config.repo.branch}`),
      readGitBlobId(repoPath, `origin/${config.repo.branch}`, repoRelativePath)
    ]);

  return {
    path: repoRelativePath,
    content,
    remoteContent,
    headContent,
    baseHead: baseHead ?? "",
    baseBlob,
    remoteHead,
    remoteBlob,
    isDirty: Boolean(statusOutput.trim()),
    modifiedAt: fileStats.mtime.toISOString(),
    lastCommit: history[0] ?? null,
    history
  };
}

export async function discardRepoFileChanges(
  config: AppConfig,
  filePath: string
): Promise<FileDetail> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, filePath);
  await runGit(["restore", "--worktree", "--", repoRelativePath], {
    cwd: repoPath
  });
  return readFileDetail(config, repoRelativePath);
}

export async function commitAndPushFile(
  config: AppConfig,
  _runtime: RuntimeState,
  input: {
    path: string;
    content: string;
    message: string;
    baseHead: string;
    baseBlob: string | null;
    actor?: AuthUser;
  }
): Promise<{ head: string; path: string }> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, input.path);
  const baseHead = input.baseHead.trim();
  if (!baseHead) {
    throw new Error("缺少打开文件时的版本信息，请刷新文件后重试");
  }

  await fetchRemoteBranch(config, repoPath);

  const remoteRef = `origin/${config.repo.branch}`;
  const [currentHead, remoteHead, remoteBlob] = await Promise.all([
    readGitRef(repoPath, "HEAD"),
    readGitRef(repoPath, remoteRef),
    readGitBlobId(repoPath, remoteRef, repoRelativePath)
  ]);

  if (remoteBlob !== input.baseBlob) {
    const [baseContent, remoteContent] = await Promise.all([
      readGitFile(repoPath, baseHead, repoRelativePath),
      readGitFile(repoPath, remoteRef, repoRelativePath)
    ]);
    throw new FileConflictError({
      type: "conflict",
      message: "该文件已被其他人更新，请先处理冲突后再提交",
      path: repoRelativePath,
      baseHead,
      remoteHead,
      remoteBlob,
      baseContent,
      localContent: input.content,
      remoteContent
    });
  }

  if (remoteHead && currentHead !== remoteHead) {
    await runGit(["restore", "--staged", "--worktree", "--", repoRelativePath], {
      cwd: repoPath
    }).catch(() => "");
    await runGit(["merge", "--ff-only", remoteRef], {
      cwd: repoPath
    });
  }

  const detailMessage = input.message.trim();
  const prefix = config.repo.commitMessagePrefix || "";
  const environmentLabel = getEnvironmentLabelForFile(config, repoRelativePath);
  const metadataLines = [
    input.actor ? `提交用户：${input.actor.id}` : null,
    environmentLabel ? `修改环境：${environmentLabel}` : null
  ].filter((item): item is string => Boolean(item));
  const commitMessage = [
    `${prefix}${detailMessage || "更新配置"}`.trim(),
    ...metadataLines
  ].join("\n\n");

  const absolutePath = path.resolve(repoPath, repoRelativePath);
  validateConfigFileContent(repoRelativePath, input.content);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.content, "utf8");

  const workingTreeStatus = await runGit(["status", "--porcelain", "--", repoRelativePath], {
    cwd: repoPath
  });
  if (!workingTreeStatus.trim()) {
    throw new Error("当前文件没有可提交的变更");
  }

  const auth = getConfiguredRepoAuth(config);
  const pushRemoteUrl = config.repo.remoteUrl;
  const remoteUrlSummary = getRemoteUrlSummary(pushRemoteUrl);

  logRepoDebug("commitAndPushFile.push.start", {
    repoPath,
    branch: config.repo.branch,
    path: repoRelativePath,
    username: auth.username || null,
    resolvedRemoteHost: remoteUrlSummary.host,
    resolvedRemoteUsername: remoteUrlSummary.username,
    authMode: "http.extraHeader"
  });

  await runGit(["add", "--", repoRelativePath], { cwd: repoPath });
  await runGit(
    [
      ...getGitCommitIdentityArgs(config, input.actor),
      "commit",
      "--no-gpg-sign",
      "-m",
      commitMessage,
      "--",
      repoRelativePath
    ],
    { cwd: repoPath }
  );
  await runGit(
    buildGitArgsWithManagedCredentials(config, [
      "push",
      pushRemoteUrl,
      `HEAD:${config.repo.branch}`
    ]),
    { cwd: repoPath }
  );

  const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  return {
    head,
    path: repoRelativePath
  };
}

export async function restoreFileToHistoryCommit(
  config: AppConfig,
  _runtime: RuntimeState,
  input: {
    path: string;
    hash: string;
    baseHead: string;
    baseBlob: string | null;
    actor?: AuthUser;
  }
): Promise<{ head: string; path: string }> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, input.path);
  const baseHead = input.baseHead.trim();
  const targetHash = input.hash.trim();

  if (!baseHead) {
    throw new Error("缺少打开文件时的版本信息，请刷新文件后重试");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(targetHash)) {
    throw new Error("历史版本标识无效");
  }

  const targetBlob = await readGitBlobId(repoPath, targetHash, repoRelativePath);
  if (!targetBlob) {
    throw new Error("所选历史版本中不存在该文件");
  }

  await fetchRemoteBranch(config, repoPath);

  const remoteRef = `origin/${config.repo.branch}`;
  const [currentHead, remoteHead, remoteBlob] = await Promise.all([
    readGitRef(repoPath, "HEAD"),
    readGitRef(repoPath, remoteRef),
    readGitBlobId(repoPath, remoteRef, repoRelativePath)
  ]);

  if (remoteBlob !== input.baseBlob) {
    const [baseContent, remoteContent] = await Promise.all([
      readGitFile(repoPath, baseHead, repoRelativePath),
      readGitFile(repoPath, remoteRef, repoRelativePath)
    ]);
    throw new FileConflictError({
      type: "conflict",
      message: "该文件已被其他人更新，请先处理冲突后再回滚",
      path: repoRelativePath,
      baseHead,
      remoteHead,
      remoteBlob,
      baseContent,
      localContent: await readGitFile(repoPath, targetHash, repoRelativePath),
      remoteContent
    });
  }

  if (remoteHead && currentHead !== remoteHead) {
    await runGit(["restore", "--staged", "--worktree", "--", repoRelativePath], {
      cwd: repoPath
    }).catch(() => "");
    await runGit(["merge", "--ff-only", remoteRef], {
      cwd: repoPath
    });
  }

  const targetContent = await readGitFile(repoPath, targetHash, repoRelativePath);
  validateConfigFileContent(repoRelativePath, targetContent);

  const absolutePath = path.resolve(repoPath, repoRelativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, targetContent, "utf8");

  const workingTreeStatus = await runGit(["status", "--porcelain", "--", repoRelativePath], {
    cwd: repoPath
  });
  if (!workingTreeStatus.trim()) {
    throw new Error("当前文件已是所选历史版本");
  }

  const auth = getConfiguredRepoAuth(config);
  const pushRemoteUrl = config.repo.remoteUrl;
  const remoteUrlSummary = getRemoteUrlSummary(pushRemoteUrl);

  logRepoDebug("restoreFileToHistoryCommit.push.start", {
    repoPath,
    branch: config.repo.branch,
    path: repoRelativePath,
    targetHash,
    username: auth.username || null,
    resolvedRemoteHost: remoteUrlSummary.host,
    resolvedRemoteUsername: remoteUrlSummary.username,
    authMode: "http.extraHeader"
  });

  const prefix = config.repo.commitMessagePrefix || "";
  const environmentLabel = getEnvironmentLabelForFile(config, repoRelativePath);
  const metadataLines = [
    input.actor ? `提交用户：${input.actor.id}` : null,
    environmentLabel ? `修改环境：${environmentLabel}` : null,
    `回滚来源：${targetHash}`
  ].filter((item): item is string => Boolean(item));
  const commitMessage = [
    `${prefix}回滚配置到 ${targetHash.slice(0, 8)}`.trim(),
    ...metadataLines
  ].join("\n\n");

  await runGit(["add", "--", repoRelativePath], { cwd: repoPath });
  await runGit(
    [
      ...getGitCommitIdentityArgs(config, input.actor),
      "commit",
      "--no-gpg-sign",
      "-m",
      commitMessage,
      "--",
      repoRelativePath
    ],
    { cwd: repoPath }
  );
  await runGit(
    buildGitArgsWithManagedCredentials(config, [
      "push",
      pushRemoteUrl,
      `HEAD:${config.repo.branch}`
    ]),
    { cwd: repoPath }
  );

  const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  return {
    head,
    path: repoRelativePath
  };
}

export async function hasAnyRepoContent(repoPath: string): Promise<boolean> {
  try {
    const entries = await readdir(repoPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}
