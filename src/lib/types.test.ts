import { describe, expect, it } from "vitest";
import { repo } from "./fixtures";
import {
  attentionScore,
  branchTips,
  fleetSummary,
  foldWorktrees,
  isClean,
  parentRow,
  unpushed,
  worktreeRemoved,
} from "./types";

describe("attentionScore", () => {
  it("orders a conflict above a paused operation above behind above dirty", () => {
    const conflicted = attentionScore(repo({ conflicted: 1 }));
    const paused = attentionScore(
      repo({ operation: { kind: "rebase", branch: "topic", onto: "main", step: 1, total: 3 } }),
    );
    const behind = attentionScore(repo({ behind: 1 }));
    const dirty = attentionScore(repo({ modified: 1 }));
    expect(conflicted).toBeGreaterThan(paused);
    expect(paused).toBeGreaterThan(behind);
    expect(behind).toBeGreaterThan(dirty);
    expect(dirty).toBeGreaterThan(0);
  });

  it("puts an unreadable repository above everything", () => {
    expect(attentionScore(repo({ error: "boom" }))).toBeGreaterThan(
      attentionScore(repo({ conflicted: 1, behind: 10 })),
    );
  });

  it("caps what a pile of untracked files can add", () => {
    expect(attentionScore(repo({ untracked: 500 }))).toBe(attentionScore(repo({ untracked: 20 })));
  });

  it("is zero for a repository with nothing to do", () => {
    expect(isClean(repo())).toBe(true);
  });
});

describe("unpushed", () => {
  const branch = (over: Partial<ReturnType<typeof repo>["branches"][number]>) => ({
    name: "topic",
    ahead: 0,
    behind: 0,
    isHead: false,
    merged: false,
    lastCommitAt: null,
    tip: null,
    upstream: null,
    aheadOfUpstream: 0,
    worktree: null,
    goneUpstream: null,
    originTip: null,
    ...over,
  });

  it("counts the checked-out branch with no upstream", () => {
    const on = branch({ isHead: true, ahead: 3 });
    expect(unpushed(repo({ upstream: null, aheadOfDefault: 3, branches: [on] }))).toBe(3);
  });

  it("leaves a tracked branch to `ahead`", () => {
    const on = branch({ name: "main", isHead: true, upstream: "origin/main", aheadOfUpstream: 4 });
    expect(unpushed(repo({ ahead: 4, branches: [on] }))).toBe(0);
  });

  it("says nothing about a branch that is not checked out", () => {
    const main = branch({ name: "main", isHead: true, upstream: "origin/main" });
    const others = [
      branch({ name: "local", ahead: 2 }),
      branch({ name: "pushed", upstream: "origin/pushed", aheadOfUpstream: 3 }),
      branch({ name: "merged-pr", ahead: 2, behind: 2, goneUpstream: "origin/merged-pr" }),
    ];
    const state = repo({ branches: [main, ...others] });
    expect(unpushed(state)).toBe(0);
    expect(isClean(state)).toBe(true);
  });

  it("has nothing to push on a branch whose upstream went away", () => {
    const on = branch({ isHead: true, ahead: 2, goneUpstream: "origin/topic" });
    expect(unpushed(repo({ upstream: null, aheadOfDefault: 2, branches: [on] }))).toBe(0);
  });
});

describe("attentionScore and other branches", () => {
  it("leaves a merged side branch out of the sort and the summary", () => {
    const state = repo({ mergedBranches: ["done"] });
    expect(attentionScore(state)).toBe(0);
    expect(fleetSummary([state])).toEqual([]);
  });
});

describe("foldWorktrees", () => {
  const main = repo({ path: "F:\\GitHub\\app", name: "app" });
  const linked = (name: string, mainPath: string | null) =>
    repo({ path: `F:\\GitHub\\${name}`, name, isWorktree: true, mainPath });

  it("folds a worktree under its main checkout, whatever the slashes and case", () => {
    const child = linked("app-wt", "f:/github/APP");
    expect(parentRow(child, [main, child])).toBe(main);
    expect(foldWorktrees([main, child], [main, child]).get(main.path)).toEqual([child]);
  });

  it("leaves one in place when its main checkout is not on screen", () => {
    const child = linked("app-wt", "F:\\elsewhere\\app");
    expect(foldWorktrees([main, child], [main, child]).size).toBe(0);
  });

  it("never folds a row that is not a worktree", () => {
    expect(foldWorktrees([main], [main]).size).toBe(0);
  });

  it("drops a worktree once its main checkout stops listing it, and no other row", () => {
    const child = linked("app-wt", main.path);
    const summary = {
      path: "f:/github/APP-WT",
      branch: "topic",
      main: false,
      prunable: false,
      locked: false,
      lockReason: null,
    };
    expect(worktreeRemoved(child, { ...main, worktrees: [summary] })).toBe(false);
    expect(worktreeRemoved(child, main)).toBe(true);
    expect(worktreeRemoved(linked("other-wt", "F:\\GitHub\\other"), main)).toBe(false);
    expect(worktreeRemoved(main, main)).toBe(false);
  });
});

describe("branchTips", () => {
  it("offers a remote chip as the local branch it would check out", () => {
    expect(branchTips([{ name: "origin/feature/x", kind: "remote" }], "main")).toEqual([
      { name: "feature/x", isHead: false, remote: "origin/feature/x" },
    ]);
  });

  it("drops a remote whose local namesake sits on the same commit", () => {
    const tips = branchTips(
      [
        { name: "origin/main", kind: "remote" },
        { name: "main", kind: "head" },
      ],
      "main",
    );
    expect(tips).toEqual([{ name: "main", isHead: true }]);
  });

  it("marks a remote as current when its local namesake is checked out elsewhere", () => {
    expect(branchTips([{ name: "origin/main", kind: "remote" }], "main")[0].isHead).toBe(true);
  });

  it("skips tags, a detached HEAD and a remote's own HEAD", () => {
    const tips = branchTips(
      [
        { name: "v1.0.0", kind: "tag" },
        { name: "HEAD", kind: "head" },
        { name: "origin/HEAD", kind: "remote" },
      ],
      null,
    );
    expect(tips).toEqual([]);
  });
});
