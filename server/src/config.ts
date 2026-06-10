import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  AppConfig,
  GitSettingsSummary,
  RepoEnvironmentOption,
  RuntimeState
} from "./types";

export const PROJECT_ROOT = path.resolve(__dirname, "../..");
const APP_CONFIG_PATH = path.resolve(PROJECT_ROOT, "data/app.config.json");
const RUNTIME_STATE_PATH = path.resolve(PROJECT_ROOT, "data/runtime.json");
const DEFAULT_CONFIG_ROOT = "nacos-config/config";
const DEFAULT_ENVIRONMENTS: RepoEnvironmentOption[] = [
  {
    id: "dev",
    label: "开发环境",
    root: `${DEFAULT_CONFIG_ROOT}/dev`
  },
  {
    id: "sit",
    label: "测试环境",
    root: `${DEFAULT_CONFIG_ROOT}/sit`
  },
  {
    id: "uat",
    label: "UAT环境",
    root: `${DEFAULT_CONFIG_ROOT}/uat`
  },
  {
    id: "prod",
    label: "生产环境",
    root: `${DEFAULT_CONFIG_ROOT}/prod`
  }
];

const DEFAULT_APP_CONFIG: AppConfig = {
  server: {
    port: 8090
  },
  repo: {
    localPath: "./data/repo",
    remoteUrl: "http://12.99.223.130:30005/enterprise/LMA/aifp-config-tob.git",
    branch: "main",
    defaultFile: "dev/app.yaml",
    configRoot: DEFAULT_CONFIG_ROOT,
    allowedExtensions: [
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
      username: "224270",
      password: "nbcb,123"
    },
    cloneOnStart: true
  }
};

const DEFAULT_RUNTIME_STATE: RuntimeState = {
  git: {
    defaultCommitMessage: "config: "
  },
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

export async function loadAppConfig(): Promise<AppConfig> {
  return readJsonFile(APP_CONFIG_PATH, DEFAULT_APP_CONFIG);
}

export async function loadRuntimeState(): Promise<RuntimeState> {
  return readJsonFile(RUNTIME_STATE_PATH, DEFAULT_RUNTIME_STATE);
}

export async function saveRuntimeState(state: RuntimeState): Promise<RuntimeState> {
  await ensureParent(RUNTIME_STATE_PATH);
  await writeFile(RUNTIME_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  return state;
}

export async function updateRuntimeGitSettings(input: {
  defaultCommitMessage?: string;
}): Promise<RuntimeState> {
  const current = await loadRuntimeState();
  const next: RuntimeState = {
    ...current,
    git: {
      ...current.git,
      defaultCommitMessage:
        input.defaultCommitMessage ?? current.git.defaultCommitMessage
    }
  };
  return saveRuntimeState(next);
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
  const configRoot = (config.repo.configRoot || DEFAULT_CONFIG_ROOT)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!configRoot) {
    return DEFAULT_ENVIRONMENTS;
  }

  return DEFAULT_ENVIRONMENTS.map((item) => ({
    ...item,
    root: `${configRoot}/${item.id}`
  }));
}

export function toGitSettingsSummary(state: RuntimeState): GitSettingsSummary {
  return {
    defaultCommitMessage: state.git.defaultCommitMessage
  };
}
