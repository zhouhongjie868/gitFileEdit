import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  getEnvironmentOptions,
  loadAppConfig,
  loadRuntimeState,
  markLastSyncedAt,
  normalizeVisibleRoots,
  resolveRepoPath,
  toGitSettingsSummary,
  updateRuntimeGitSettings
} from "./config";
import {
  commitAndPushFile,
  inspectRepo,
  listRepoFiles,
  readFileDetail,
  repoExists,
  syncRepo,
  writeRepoFile
} from "./git";
import { RepoEventHub, RepoWatcher } from "./repoWatcher";

const app = express();
const notifier = new RepoEventHub();
const watcher = new RepoWatcher((payload) => {
  notifier.broadcast("repo-changed", payload);
});
const clientDistPath = path.resolve(__dirname, "../client");

let lastRepoError: string | null = null;

app.use(express.json({ limit: "5mb" }));

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

async function buildBootstrapPayload() {
  const [config, runtime] = await Promise.all([loadAppConfig(), loadRuntimeState()]);
  const repoStatus = await inspectRepo(config, runtime, lastRepoError);
  const files = repoStatus.ready ? await listRepoFiles(config) : [];
  const selectedFile = files.some((file) => file.path === config.repo.defaultFile)
    ? config.repo.defaultFile
    : (files[0]?.path ?? null);

  return {
    config: {
      remoteUrl: config.repo.remoteUrl,
      branch: config.repo.branch,
      defaultFile: config.repo.defaultFile,
      environments: getEnvironmentOptions(config),
      visibleRoots: normalizeVisibleRoots(config),
      port: config.server.port
    },
    gitSettings: toGitSettingsSummary(runtime),
    repoStatus,
    files,
    selectedFile
  };
}

async function ensureWatcher(): Promise<void> {
  const config = await loadAppConfig();
  const repoPath = resolveRepoPath(config);
  if (await repoExists(repoPath)) {
    await watcher.watchRepo(repoPath);
  }
}

async function initializeRepoOnStartup(): Promise<void> {
  const [config, runtime] = await Promise.all([loadAppConfig(), loadRuntimeState()]);
  try {
    if (config.repo.cloneOnStart) {
      await syncRepo(config, runtime);
      await markLastSyncedAt(new Date().toISOString());
    }
    await ensureWatcher();
    lastRepoError = null;
  } catch (error) {
    lastRepoError = toErrorMessage(error);
  }
}

app.get("/api/bootstrap", async (_request, response, next) => {
  try {
    response.json(await buildBootstrapPayload());
  } catch (error) {
    next(error);
  }
});

app.get("/api/file", async (request, response, next) => {
  try {
    const filePath = String(request.query.path ?? "").trim();
    if (!filePath) {
      response.status(400).json({ error: "缺少文件路径" });
      return;
    }

    const config = await loadAppConfig();
    response.json(await readFileDetail(config, filePath));
  } catch (error) {
    next(error);
  }
});

app.put("/api/file", async (request, response, next) => {
  try {
    const filePath = String(request.body.path ?? "").trim();
    const content = String(request.body.content ?? "");
    if (!filePath) {
      response.status(400).json({ error: "缺少文件路径" });
      return;
    }

    const config = await loadAppConfig();
    const detail = await writeRepoFile(config, filePath, content);
    await ensureWatcher();
    notifier.broadcast("repo-changed", {
      relativePath: filePath,
      eventType: "save"
    });
    response.json(detail);
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/git", async (request, response, next) => {
  try {
    const runtime = await updateRuntimeGitSettings({
      username: typeof request.body.username === "string" ? request.body.username.trim() : undefined,
      email: typeof request.body.email === "string" ? request.body.email.trim() : undefined,
      defaultCommitMessage:
        typeof request.body.defaultCommitMessage === "string"
          ? request.body.defaultCommitMessage.trim()
          : undefined
    });
    response.json({
      gitSettings: toGitSettingsSummary(runtime)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/repo/sync", async (_request, response, next) => {
  try {
    const [config, runtime] = await Promise.all([loadAppConfig(), loadRuntimeState()]);
    await syncRepo(config, runtime);
    await markLastSyncedAt(new Date().toISOString());
    await ensureWatcher();
    lastRepoError = null;
    notifier.broadcast("repo-changed", {
      relativePath: null,
      eventType: "sync"
    });
    response.json(await buildBootstrapPayload());
  } catch (error) {
    lastRepoError = toErrorMessage(error);
    next(error);
  }
});

app.post("/api/commit", async (request, response, next) => {
  try {
    const filePath = String(request.body.path ?? "").trim();
    const message = String(request.body.message ?? "").trim();
    if (!filePath) {
      response.status(400).json({ error: "缺少文件路径" });
      return;
    }

    const username =
      typeof request.body.username === "string" ? request.body.username.trim() : undefined;
    const email =
      typeof request.body.email === "string" ? request.body.email.trim() : undefined;
    const password =
      typeof request.body.password === "string" && request.body.password.trim()
        ? request.body.password
        : undefined;

    const [config, runtime] = await Promise.all([loadAppConfig(), loadRuntimeState()]);
    const result = await commitAndPushFile(config, runtime, {
      path: filePath,
      message,
      username,
      email,
      password
    });

    await updateRuntimeGitSettings({
      username,
      email,
      defaultCommitMessage: message || undefined
    });
    await markLastSyncedAt(new Date().toISOString());
    await ensureWatcher();
    lastRepoError = null;
    notifier.broadcast("repo-changed", {
      relativePath: result.path,
      eventType: "commit"
    });
    response.json(result);
  } catch (error) {
    lastRepoError = toErrorMessage(error);
    next(error);
  }
});

app.get("/api/stream", (_request, response) => {
  notifier.addClient(response);
});

app.use(express.static(clientDistPath));

app.get("*", (_request, response) => {
  response.sendFile(path.resolve(clientDistPath, "index.html"));
});

app.use(
  (error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const message = toErrorMessage(error);
    if (request.path.startsWith("/api/")) {
      response.status(500).json({ error: message });
      return;
    }
    response.status(500).send(message);
  }
);

void initializeRepoOnStartup();

void (async () => {
  const config = await loadAppConfig();
  const port = Number(process.env.PORT || config.server.port || 8090);
  app.listen(port, "0.0.0.0", () => {
    console.log(`Git File Console listening on http://0.0.0.0:${port}`);
  });
})();
