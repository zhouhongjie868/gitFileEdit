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
  normalizeVisibleRoots,
  resolveRepoPath
} from "./config";
import type {
  AppConfig,
  CommitSnapshot,
  FileDetail,
  RepoFileSummary,
  RepoStatus,
  RuntimeState
} from "./types";

const execFileAsync = promisify(execFile);
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
    throw new Error("仅允许访问 dev、sit、uat、prod 目录下的文件");
  }
  return repoRelativePath;
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

function getGitCommitIdentityArgs(config: AppConfig): string[] {
  const username = config.repo.auth.username.trim();
  if (!username) {
    return [];
  }

  return [
    "-c",
    `user.name=${username}`,
    "-c",
    `user.email=${username}@local`
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
      config.repo.branch
    ]),
    {
      cwd: repoPath
    }
  );
  await runGit(
    ["checkout", config.repo.branch],
    {
      cwd: repoPath
    }
  ).catch(() => "");
  await runGit(
    ["merge", "--ff-only", `FETCH_HEAD`],
    {
      cwd: repoPath
    }
  ).catch((error) => {
    logRepoDebug("syncRepo.merge.skip", {
      repoPath,
      branch: config.repo.branch,
      error: (error as Error).message
    });
    return "";
  });
  logRepoDebug("syncRepo.pull.done", {
    repoPath,
    branch: config.repo.branch
  });
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
  const candidates = new Set(visibleCandidates);

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
    return await runGit([`show`, `${ref}:${repoRelativePath}`], { cwd: repoPath });
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

async function readLastCommitSnapshot(
  repoPath: string,
  repoRelativePath: string
): Promise<CommitSnapshot | null> {
  const rawMeta = await runGit(
    ["log", "-1", "--format=%H%n%an%n%ae%n%ad%n%s", "--date=iso-strict", "--", repoRelativePath],
    { cwd: repoPath }
  ).catch(() => "");

  if (!rawMeta) {
    return null;
  }

  const [hash, authorName, authorEmail, committedAt, ...messageParts] =
    rawMeta.split("\n");
  const message = messageParts.join("\n").trim();
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
}

export async function readFileDetail(
  config: AppConfig,
  filePath: string
): Promise<FileDetail> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, filePath);
  const absolutePath = path.resolve(repoPath, repoRelativePath);
  const [content, remoteContent, headContent, statusOutput, fileStats, lastCommit] =
    await Promise.all([
      readFile(absolutePath, "utf8"),
      readRemoteTrackingFile(repoPath, config.repo.branch, repoRelativePath),
      readGitFile(repoPath, "HEAD", repoRelativePath),
      runGit(["status", "--porcelain", "--", repoRelativePath], { cwd: repoPath }).catch(
        () => ""
      ),
      stat(absolutePath),
      readLastCommitSnapshot(repoPath, repoRelativePath)
    ]);

  return {
    path: repoRelativePath,
    content,
    remoteContent,
    headContent,
    isDirty: Boolean(statusOutput.trim()),
    modifiedAt: fileStats.mtime.toISOString(),
    lastCommit
  };
}

export async function writeRepoFile(
  config: AppConfig,
  filePath: string,
  content: string
): Promise<FileDetail> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, filePath);
  const absolutePath = path.resolve(repoPath, repoRelativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return readFileDetail(config, repoRelativePath);
}

export async function commitAndPushFile(
  config: AppConfig,
  _runtime: RuntimeState,
  input: {
    path: string;
    message: string;
  }
): Promise<{ head: string; path: string }> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, input.path);
  const detailMessage = input.message.trim();
  const prefix = config.repo.commitMessagePrefix || "";
  const commitMessage = `${prefix}${detailMessage}`.trim();

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
      ...getGitCommitIdentityArgs(config),
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
