import { describe, expect, it } from "vitest";
import { fetchPlan, prunePlan, pruneSplit, pruneCommands, pullPlan } from "./batch";
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

describe("pruneSplit", () => {
  const squashed = (branch: string, over: { protected?: boolean; remote?: boolean } = {}) => ({
    branch,
    into: "0".repeat(40),
    intoShort: "0000000",
    intoSummary: "Squash",
    base: "origin/main",
    commits: 1,
    protected: false,
    remote: false,
    ...over,
  });

  it("keeps -d and -D apart, and never offers a protected or remote ref for -D", () => {
    const split = pruneSplit(repo({ mergedBranches: ["merged"] }), [
      squashed("squashed"),
      squashed("merged"),
      squashed("main", { protected: true }),
      squashed("origin/old", { remote: true }),
    ]);
    expect(split).toEqual({ merged: ["merged"], squashed: ["squashed"] });
    expect(pruneCommands(split)).toEqual(["git branch -d merged", "git branch -D squashed"]);
  });
});
