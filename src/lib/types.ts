export interface RepoState {
  path: string;
  name: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  remoteUrl: string | null;
  ownerRepo: string | null;
  defaultBranch: string | null;
  mergedBranches: string[];
  localBranchCount: number;
  lastCommitAt: number | null;
  lastCommitSummary: string | null;
  isWorktree: boolean;
  error: string | null;
  scannedAt: number;
}

export interface Task {
  id: string;
  name: string;
  command: string;
  source: string;
  saved: boolean;
}

export interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

export interface AppInfo {
  gitVersion: string | null;
  shell: string;
  dataDir: string;
  roots: string[];
}

/** What the sidebar sorts on. Higher wants attention sooner. */
export function attentionScore(repo: RepoState): number {
  if (repo.error) return 1000;
  return (
    repo.conflicted * 500 +
    repo.behind * 12 +
    repo.ahead * 8 +
    (repo.staged + repo.modified) * 4 +
    repo.mergedBranches.length * 3 +
    Math.min(repo.untracked, 20)
  );
}

export function isClean(repo: RepoState): boolean {
  return attentionScore(repo) === 0;
}

export function relativeTime(seconds: number | null): string {
  if (!seconds) return "never";
  const delta = Math.floor(Date.now() / 1000) - seconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 2592000) return `${Math.floor(delta / 86400)}d ago`;
  if (delta < 31536000) return `${Math.floor(delta / 2592000)}mo ago`;
  return `${Math.floor(delta / 31536000)}y ago`;
}
