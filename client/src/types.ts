export interface RepoFileSummary {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface GitSettingsSummary {
  commitMessagePrefix: string;
}

export interface AuthUser {
  id: string;
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
}

export interface BootstrapResponse {
  user: AuthUser | null;
  config: {
    remoteUrl: string;
    branch: string;
    environments: RepoEnvironmentOption[];
    visibleRoots: string[];
    port: number;
  };
  gitSettings: GitSettingsSummary;
  repoStatus: RepoStatus;
  files: RepoFileSummary[];
  selectedFile: string | null;
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
