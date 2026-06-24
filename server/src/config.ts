import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AppConfig, GitSettingsSummary, RepoEnvironmentOption, RuntimeState } from "./types";

export const PROJECT_ROOT = path.resolve(__dirname, "../..");
const APP_CONFIG_PATH = path.resolve(PROJECT_ROOT, "data/app.config.json");
const RUNTIME_STATE_PATH = path.resolve(PROJECT_ROOT, "data/runtime.json");
const DEFAULT_CONFIG_ROOT = "nacos-config/config";
const DEFAULT_REMOTE_URL = "http://12.103.118.207:10880/AI/aifp-config-tob.git";
const DEFAULT_BRANCH = "main";
const DEFAULT_ENVIRONMENTS: RepoEnvironmentOption[] = [
  {
    id: "dev",
    label: "开发环境",
    root: `${DEFAULT_CONFIG_ROOT}/dev`,
    requiresAdminToEdit: false
  },
  {
    id: "sit",
    label: "SIT环境",
    root: `${DEFAULT_CONFIG_ROOT}/sit`,
    requiresAdminToEdit: false
  },
  {
    id: "uat",
    label: "UAT环境",
    root: `${DEFAULT_CONFIG_ROOT}/uat`,
    requiresAdminToEdit: true
  }
];

const DEFAULT_APP_CONFIG: AppConfig = {
  server: {
    port: 8090
  },
  repo: {
    localPath: "./data/repo",
    remoteUrl: DEFAULT_REMOTE_URL,
    branch: DEFAULT_BRANCH,
    configRoot: DEFAULT_CONFIG_ROOT,
    allowedExtensions: [
      "",
      ".json",
      ".yaml",
      ".yml",
      ".toml",
      ".ini",
      ".conf",
      ".properties",
      ".env",
      ".xml",
      ".txt",
      ".md"
    ],
    auth: {
      username: "rhb",
      password: "nbcb,111"
    },
    commitMessagePrefix: "config: ",
    cloneOnStart: true
  }
};

const DEFAULT_RUNTIME_STATE: RuntimeState = {
  lastSyncedAt: null
};

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    await ensureParent(filePath);
    await writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }
}

function normalizeRoot(root: string): string {
  return root.trim().replace(/^\/+|\/+$/g, "");
}

function getDefaultEnvironmentRoots(configRoot: string): RepoEnvironmentOption[] {
  const normalizedConfigRoot = normalizeRoot(configRoot || DEFAULT_CONFIG_ROOT);
  return DEFAULT_ENVIRONMENTS.map((item) => ({
    ...item,
    root: normalizedConfigRoot ? `${normalizedConfigRoot}/${item.id}` : item.root
  }));
}

function normalizeEnvironmentOptions(
  rawEnvironments: RepoEnvironmentOption[] | undefined,
  configRoot: string
): RepoEnvironmentOption[] {
  const source = rawEnvironments?.length
    ? rawEnvironments
    : getDefaultEnvironmentRoots(configRoot);
  const seenIds = new Set<string>();

  return source
    .map((item, index) => {
      const fallback = DEFAULT_ENVIRONMENTS[index] ?? DEFAULT_ENVIRONMENTS[0];
      const id = String(item.id || fallback.id || `env-${index + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const uniqueId = id && !seenIds.has(id) ? id : `env-${index + 1}`;
      seenIds.add(uniqueId);
      return {
        id: uniqueId,
        label: String(item.label || fallback.label || uniqueId).trim(),
        root: normalizeRoot(String(item.root || fallback.root || "")),
        requiresAdminToEdit: Boolean(item.requiresAdminToEdit)
      };
    })
    .filter((item) => item.label && item.root);
}

function normalizeAppConfig(rawConfig: AppConfig): AppConfig {
  const remoteUrl = rawConfig.repo?.remoteUrl || DEFAULT_APP_CONFIG.repo.remoteUrl;
  const branch = rawConfig.repo?.branch || DEFAULT_APP_CONFIG.repo.branch;
  const configRoot = rawConfig.repo?.configRoot || DEFAULT_APP_CONFIG.repo.configRoot || DEFAULT_CONFIG_ROOT;
  return {
    server: {
      port: rawConfig.server?.port || DEFAULT_APP_CONFIG.server.port
    },
    repo: {
      localPath: rawConfig.repo?.localPath || DEFAULT_APP_CONFIG.repo.localPath,
      remoteUrl,
      branch,
      configRoot,
      visibleRoots: rawConfig.repo?.visibleRoots,
      allowedExtensions:
        rawConfig.repo?.allowedExtensions?.length
          ? rawConfig.repo.allowedExtensions
          : DEFAULT_APP_CONFIG.repo.allowedExtensions,
      auth: {
        username: rawConfig.repo?.auth?.username || DEFAULT_APP_CONFIG.repo.auth.username,
        password: rawConfig.repo?.auth?.password || DEFAULT_APP_CONFIG.repo.auth.password
      },
      environments: normalizeEnvironmentOptions(
        rawConfig.repo?.environments,
        configRoot
      ),
      commitMessagePrefix:
        rawConfig.repo?.commitMessagePrefix ?? DEFAULT_APP_CONFIG.repo.commitMessagePrefix,
      cloneOnStart: rawConfig.repo?.cloneOnStart ?? DEFAULT_APP_CONFIG.repo.cloneOnStart
    }
  };
}

export async function loadAppConfig(): Promise<AppConfig> {
  const config = await readJsonFile(APP_CONFIG_PATH, DEFAULT_APP_CONFIG);
  return normalizeAppConfig(config);
}

export async function loadRuntimeState(): Promise<RuntimeState> {
  return readJsonFile(RUNTIME_STATE_PATH, DEFAULT_RUNTIME_STATE);
}

export async function saveRuntimeState(state: RuntimeState): Promise<RuntimeState> {
  await ensureParent(RUNTIME_STATE_PATH);
  await writeFile(RUNTIME_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  return state;
}

export async function saveAppConfig(config: AppConfig): Promise<AppConfig> {
  const normalizedConfig = normalizeAppConfig(config);
  await ensureParent(APP_CONFIG_PATH);
  await writeFile(APP_CONFIG_PATH, JSON.stringify(normalizedConfig, null, 2), "utf8");
  return normalizedConfig;
}

export async function updateCommitMessagePrefix(prefix: string): Promise<AppConfig> {
  const current = await loadAppConfig();
  const next: AppConfig = {
    ...current,
    repo: {
      ...current.repo,
      commitMessagePrefix: prefix
    }
  };
  return saveAppConfig(next);
}

export async function updateEnvironmentOptions(
  environments: RepoEnvironmentOption[]
): Promise<AppConfig> {
  const current = await loadAppConfig();
  const normalizedEnvironments = normalizeEnvironmentOptions(
    environments,
    current.repo.configRoot || DEFAULT_CONFIG_ROOT
  );
  if (!normalizedEnvironments.length) {
    throw new Error("至少需要保留一个环境配置");
  }

  return saveAppConfig({
    ...current,
    repo: {
      ...current.repo,
      environments: normalizedEnvironments,
      visibleRoots: normalizedEnvironments.map((item) => item.root)
    }
  });
}

export async function markLastSyncedAt(timestamp: string): Promise<RuntimeState> {
  const current = await loadRuntimeState();
  current.lastSyncedAt = timestamp;
  return saveRuntimeState(current);
}

export function resolveRepoPath(config: AppConfig): string {
  return path.resolve(PROJECT_ROOT, config.repo.localPath);
}

export function normalizeVisibleRoots(config: AppConfig): string[] {
  const rawRoots = config.repo.visibleRoots?.length
    ? config.repo.visibleRoots
    : getEnvironmentOptions(config).map((item) => item.root);

  return rawRoots
    .map((item) => item.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

export function getEnvironmentOptions(config: AppConfig): RepoEnvironmentOption[] {
  return normalizeEnvironmentOptions(
    config.repo.environments,
    config.repo.configRoot || DEFAULT_CONFIG_ROOT
  );
}

export function toGitSettingsSummary(config: AppConfig): GitSettingsSummary {
  return {
    commitMessagePrefix: config.repo.commitMessagePrefix || ""
  };
}
