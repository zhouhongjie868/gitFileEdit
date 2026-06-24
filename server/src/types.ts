export interface AppConfig {
  server: {
    port: number;
  };
  repo: {
    localPath: string;
    remoteUrl: string;
    branch: string;
    configRoot?: string;
    visibleRoots?: string[];
    allowedExtensions: string[];
    auth: {
      username: string;
      password: string;
    };
    environments?: RepoEnvironmentOption[];
    commitMessagePrefix: string;
    cloneOnStart: boolean;
  };
}

export interface RuntimeState {
  lastSyncedAt: string | null;
}

export interface AuthUser {
  id: string;
  role: "user" | "admin";
}

export interface RepoFileSummary {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface RepoStatus {
  ready: boolean;
  exists: boolean;
  repoPath: string;
  remoteUrl: string;
  branch: string;
  currentBranch: string | null;
  head: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
}

export interface RepoEnvironmentOption {
  id: string;
  label: string;
  root: string;
  requiresAdminToEdit: boolean;
}

export interface CommitSnapshot {
  hash: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  message: string;
  beforeContent: string;
  afterContent: string;
}

export interface EnvironmentReviewFile {
  path: string;
  status: string;
}

export interface EnvironmentReviewCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  message: string;
  files: EnvironmentReviewFile[];
}

export interface EnvironmentReviewDiff {
  hash: string;
  path: string;
  beforeContent: string;
  afterContent: string;
}

export interface FileDetail {
  path: string;
  content: string;
  remoteContent: string;
  headContent: string;
  baseHead: string;
  baseBlob: string | null;
  remoteHead: string | null;
  remoteBlob: string | null;
  isDirty: boolean;
  modifiedAt: string;
  lastCommit: CommitSnapshot | null;
  history: CommitSnapshot[];
}

export interface FileConflictPayload {
  type: "conflict";
  message: string;
  path: string;
  baseHead: string;
  remoteHead: string | null;
  remoteBlob: string | null;
  baseContent: string;
  localContent: string;
  remoteContent: string;
}

export interface GitSettingsSummary {
  commitMessagePrefix: string;
}
