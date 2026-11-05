import { describe, expect, it } from "vitest";
import { fetchPlan, heldBranches, prunePlan, pullPlan } from "./batch";
import { repo } from "./fixtures";

describe("pullPlan", () => {
  it("pulls a branch that is only behind", () => {
    expect(pullPlan(repo({ behind: 3 }))).toEqual({
      args: ["pull", "--ff-only"],
      command: "git pull --ff-only",
    });
  });

  it("skips a detached HEAD before looking at anything else", () => {
    expect(pullPlan(repo({ detached: true, upstream: null, behind: 3 }))).toEqual({
      skip: "detached HEAD, so there is no branch to move",
    });
  });

  it("skips a branch with no upstream", () => {
    expect(pullPlan(repo({ upstream: null }))).toEqual({ skip: "no upstream" });
  });

  it("skips a branch with nothing behind it", () => {
    expect(pullPlan(repo())).toEqual({ skip: "already up to date" });
  });

  it("names both counts for a diverged branch", () => {
    expect(pullPlan(repo({ ahead: 2, behind: 5 }))).toEqual({
      skip: "diverged, 2 ahead and 5 behind",
    });
  });

  it("counts staged, modified and conflicted as uncommitted, and not untracked", () => {
    expect(pullPlan(repo({ behind: 1, modified: 1 }))).toEqual({ skip: "1 uncommitted change" });
    expect(pullPlan(repo({ behind: 1, staged: 1, modified: 1, conflicted: 1 }))).toEqual({
      skip: "3 uncommitted changes",
    });
    expect(pullPlan(repo({ behind: 1, untracked: 4 }))).toEqual({
      args: ["pull", "--ff-only"],
      command: "git pull --ff-only",
    });
  });
});

describe("fetchPlan", () => {
  it("fetches with --prune, and skips only what has no remote or cannot be read", () => {
    expect(fetchPlan(repo())).toEqual({ args: ["fetch", "--prune"], command: "git fetch --prune" });
    expect(fetchPlan(repo({ remoteUrl: null }))).toEqual({ skip: "no remote" });
    expect(fetchPlan(repo({ error: "not a repository" }))).toEqual({ skip: "unreadable" });
  });
});

describe("prunePlan", () => {
  it("stays on -d and lists every merged branch", () => {
    expect(prunePlan(repo({ mergedBranches: ["a", "b"] }))).toEqual({
      args: ["branch", "-d", "a", "b"],
      command: "git branch -d a b",
    });
    expect(prunePlan(repo())).toEqual({ skip: "nothing merged to delete" });
  });
});

describe("the fleet-wide prune", () => {
  it("never reaches for a branch a worktree holds", () => {
    const branch = (name: string, worktree: string | null) => ({
      name,
      ahead: 0,
      behind: 0,
      isHead: false,
      merged: true,
      lastCommitAt: null,
      tip: null,
      upstream: null,
      aheadOfUpstream: 0,
      worktree,
      goneUpstream: null,
      originTip: null,
    });
    const state = repo({
      mergedBranches: ["free"],
      branches: [branch("free", null), branch("live", "F:\\wt\\live")],
    });
    expect(prunePlan(state)).toEqual({
      args: ["branch", "-d", "free"],
      command: "git branch -d free",
    });
    expect(heldBranches(state)).toEqual([{ branch: "live", path: "F:\\wt\\live" }]);
  });
});
