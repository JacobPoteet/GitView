/** One local branch, measured against the default branch. */
export interface BranchSummary {
  name: string;
  ahead: number;
  behind: number;
  isHead: boolean;
  merged: boolean;
  lastCommitAt: number | null;
}

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
  branches: BranchSummary[];
  /** The ref the drift numbers were measured against, `origin/main` usually. */
  defaultBase: string | null;
  aheadOfDefault: number;
  behindDefault: number;
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
  /** Sent to the collapsed section at the foot of the pane, and out of the palette. */
  hidden: boolean;
}

/** A display choice about one repository, kept apart from the scanned state. */
export interface RepoPref {
  path: string;
  hidden: boolean;
  /** When it was pinned. Kept for an upgrade, which orders the group by it. */
  pinnedAt: number | null;
  /** Where it sits in the pinned group. Null until something has ordered it. */
  pinnedPos: number | null;
}

export interface GraphCommit {
  id: string;
  short: string;
  summary: string;
  author: string;
  time: number;
  refs: string[];
  isMerge: boolean;
}

export interface BranchGraph {
  path: string;
  head: string | null;
  detached: boolean;
  base: string | null;
  baseKind: "remote-default" | "default" | "upstream" | "none";
  trunk: GraphCommit[];
  theirs: GraphCommit[];
  ours: GraphCommit[];
  truncated: boolean;
  /** No merge base at all, so there is no fork and no shared rail to draw. */
  unrelated: boolean;
  error: string | null;
}

/** One row in the changes pane. */
export interface FileChange {
  path: string;
  state: "new" | "modified" | "deleted" | "renamed" | "typechange" | "conflicted";
  staged: boolean;
}

/** What one sweep did, including any preferences that followed a renamed folder. */
export interface ScanReport {
  scanned: number;
  adopted: { ownerRepo: string; from: string; to: string }[];
}

export interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

/** Whether `gh` is on PATH and logged in, which is all the inbox needs. */
export interface GhStatus {
  version: string | null;
  loggedIn: boolean;
}

/** One pull request or issue, flattened out of the fleet-wide GraphQL query. */
export interface InboxItem {
  kind: "pr" | "issue";
  repoPath: string;
  repoName: string;
  ownerRepo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  author: string;
  draft: boolean;
  /** PRs only, so the header can match it against HEAD. */
  headRef: string | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  /** The check rollup on the head commit. */
  checks: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null;
  mine: boolean;
  reviewRequested: boolean;
  assigned: boolean;
}

export interface Inbox {
  viewer: string | null;
  items: InboxItem[];
  fetchedAt: number;
  /** Repositories the query could not resolve. They drop out of the sweep. */
  unresolved: string[];
  error: string | null;
}

/** The latest GitHub release, as `gh release view` reported it. */
export interface Release {
  /** `owner/repo`, so the typed command names where this was read from. */
  repo: string;
  /** `v0.2.0`, the tag `gh release download` wants. */
  tag: string;
  /** `0.2.0`, the tag as a version. */
  version: string;
  name: string;
  url: string;
  publishedAt: string;
  /** The release body, capped by the backend. */
  notes: string;
  /** The installer on that release, absent while the release build is running. */
  assetName: string | null;
  assetSize: number | null;
}

/**
 * What the launch check found.
 *
 * `error` never reaches a dialog. A machine off the network is not an event, so
 * the status bar stays quiet and the palette row is the way to ask again.
 */
export interface UpdateCheck {
  current: string;
  latest: Release | null;
  available: boolean;
  checkedAt: number;
  error: string | null;
}

export interface AppInfo {
  gitVersion: string | null;
  gh: GhStatus;
  shell: string;
  /** Whether this shell emits OSC 133 marks, so blocks are possible at all. */
  shellIntegration: boolean;
  dataDir: string;
  roots: string[];
}

/**
 * One command typed at the prompt, as the shell integration reported it.
 *
 * The output is not held here. It is read back out of the terminal buffer on
 * demand, so a build that printed forty thousand lines costs nothing until
 * somebody asks for it, and what comes back has already had its escape codes
 * applied. See `blockOutput` in TerminalPane.
 */
export interface CommandBlock {
  id: number;
  repoPath: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  /** Null while it is still running. */
  exitCode: number | null;
}

export function blockDuration(block: CommandBlock): string {
  const ms = (block.endedAt ?? Date.now()) - block.startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * Ports a running command announced, in the order they appeared.
 *
 * Only a running block is worth scanning: a dev server holds its block open for
 * as long as it is up, so a port found in one is live, and one found in a build
 * that has already finished is a line of documentation.
 */
export function portsIn(output: string): number[] {
  const found: number[] = [];
  const pattern = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/gi;
  for (const match of output.matchAll(pattern)) {
    const port = Number.parseInt(match[1], 10);
    if (port > 0 && port < 65536 && !found.includes(port)) found.push(port);
  }
  return found;
}

/**
 * Commits that exist in exactly one place.
 *
 * `ahead` only counts against an upstream, so a branch that has never been
 * pushed reported zero however far it had run. That is precisely the case where
 * the work exists on one disk and nowhere else, which is what the ahead weight
 * was there to catch. Measured against the default branch instead, and only
 * when there is no upstream, so a pushed branch is not counted twice.
 */
export function unpushed(repo: RepoState): number {
  return repo.upstream ? 0 : repo.aheadOfDefault;
}

/** What the sidebar sorts on. Higher wants attention sooner. */
export function attentionScore(repo: RepoState): number {
  if (repo.error) return 1000;
  return (
    repo.conflicted * 500 +
    repo.behind * 12 +
    repo.ahead * 8 +
    // Below `ahead`: work that is only local is a smaller problem than work that
    // has diverged from a branch someone else is also pushing to.
    unpushed(repo) * 5 +
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
