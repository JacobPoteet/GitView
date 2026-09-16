/**
 * A repository the tests can start from: clean, on `main`, tracking origin,
 * nothing to do. Each test overrides the one field it is about.
 */

import type { RepoState } from "./types";

export function repo(over: Partial<RepoState> = {}): RepoState {
  return {
    path: "F:\\GitHub\\example",
    name: "example",
    branch: "main",
    detached: false,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    remoteUrl: "git@github.com:someone/example.git",
    ownerRepo: "someone/example",
    defaultBranch: "main",
    mergedBranches: [],
    localBranchCount: 1,
    branches: [],
    tags: [],
    defaultBase: "origin/main",
    aheadOfDefault: 0,
    behindDefault: 0,
    lastCommitAt: null,
    lastCommitSummary: null,
    isWorktree: false,
    operation: null,
    stashes: [],
    error: null,
    scannedAt: 0,
    ...over,
  };
}
