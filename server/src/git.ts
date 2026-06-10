import path from "node:path";
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
const COMMON_TEXT_NAMES = new Set([
  "Dockerfile",
  "Makefile",
  ".env",
  ".gitignore",
  ".npmrc"
]);

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

function buildAuthenticatedRemoteUrl(
  remoteUrl: string,
  auth: {
    username?: string;
    password?: string;
  }
): string {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (auth.username) {
        url.username = auth.username;
      }
      if (auth.password) {
        url.password = auth.password;
      }
      return url.toString();
    }
  } catch {
    return remoteUrl;
  }
  return remoteUrl;
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
    return {
      ready: false,
      exists: false,
      repoPath,
      remoteUrl: config.repo.remoteUrl,
      branch: config.repo.branch,
      defaultFile: config.repo.defaultFile,
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

    return {
      ready: true,
      exists: true,
      repoPath,
      remoteUrl: config.repo.remoteUrl,
      branch: config.repo.branch,
      defaultFile: config.repo.defaultFile,
      currentBranch: currentBranch || null,
      head: head || null,
      lastError,
      lastSyncedAt: runtime.lastSyncedAt
    };
  } catch (error) {
    return {
      ready: false,
      exists: true,
      repoPath,
      remoteUrl: config.repo.remoteUrl,
      branch: config.repo.branch,
      defaultFile: config.repo.defaultFile,
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
  const remoteUrl = buildAuthenticatedRemoteUrl(config.repo.remoteUrl, config.repo.auth);
  await mkdir(path.dirname(repoPath), { recursive: true });

  if (!(await repoExists(repoPath))) {
    await runGit(
      [
        "clone",
        "--branch",
        config.repo.branch,
        "--single-branch",
        remoteUrl,
        repoPath
      ],
      { cwd: path.dirname(repoPath) }
    );
    return;
  }

  await runGit(["pull", "--rebase", remoteUrl, config.repo.branch], {
    cwd: repoPath
  });
}

function isAllowedFile(filePath: string, allowedExtensions: string[]): boolean {
  const extension = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath);
  return (
    allowedExtensions.includes(extension) ||
    COMMON_TEXT_NAMES.has(baseName) ||
    baseName.startsWith(".env")
  );
}

async function collectFilesystemStats(
  repoPath: string,
  repoRelativePath: string
): Promise<RepoFileSummary | null> {
  const filePath = path.resolve(repoPath, repoRelativePath);
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      return null;
    }
    return {
      path: repoRelativePath,
      size: fileStats.size,
      modifiedAt: fileStats.mtime.toISOString()
    };
  } catch {
    return null;
  }
}

export async function listRepoFiles(config: AppConfig): Promise<RepoFileSummary[]> {
  const repoPath = resolveRepoPath(config);
  const visibleRoots = normalizeVisibleRoots(config);
  const [trackedOutput, untrackedOutput] = await Promise.all([
    runGit(["ls-files"], { cwd: repoPath }),
    runGit(["ls-files", "--others", "--exclude-standard"], { cwd: repoPath })
  ]);

  const candidates = new Set(
    [...trackedOutput.split("\n"), ...untrackedOutput.split("\n")]
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => isInVisibleRoots(item, visibleRoots))
      .filter((item) => isAllowedFile(item, config.repo.allowedExtensions))
  );

  const files = await Promise.all(
    Array.from(candidates)
      .sort((left, right) => left.localeCompare(right))
      .map((filePath) => collectFilesystemStats(repoPath, filePath))
  );

  return files.filter((file): file is RepoFileSummary => Boolean(file));
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
  const [content, headContent, statusOutput, fileStats, lastCommit] =
    await Promise.all([
      readFile(absolutePath, "utf8"),
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
  runtime: RuntimeState,
  input: {
    path: string;
    message: string;
    username?: string;
    email?: string;
    password?: string;
  }
): Promise<{ head: string; path: string }> {
  const repoPath = resolveRepoPath(config);
  const repoRelativePath = normalizeAllowedFilePath(config, repoPath, input.path);
  const authorName = input.username?.trim() || runtime.git.username.trim();
  const authorEmail =
    input.email?.trim() ||
    runtime.git.email.trim() ||
    (authorName ? `${authorName}@local` : "");
  const commitMessage =
    input.message.trim() ||
    runtime.git.defaultCommitMessage ||
    `chore: update ${repoRelativePath}`;

  if (!authorName) {
    throw new Error("请先配置 Git 用户名");
  }

  const workingTreeStatus = await runGit(["status", "--porcelain", "--", repoRelativePath], {
    cwd: repoPath
  });
  if (!workingTreeStatus.trim()) {
    throw new Error("当前文件没有可提交的变更");
  }

  const pushRemoteUrl = buildAuthenticatedRemoteUrl(config.repo.remoteUrl, {
    username: config.repo.auth.username,
    password: input.password?.trim() || config.repo.auth.password
  });

  await runGit(["add", "--", repoRelativePath], { cwd: repoPath });
  await runGit(
    [
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${authorEmail}`,
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
    [
      "push",
      pushRemoteUrl,
      `HEAD:${config.repo.branch}`
    ],
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
