import { describe, expect, it } from "vitest";
import { repo } from "./fixtures";
import { attentionScore, branchTips, isClean, unpushed } from "./types";

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
    ...over,
  });

  it("counts a branch switched away from with work on it", () => {
    expect(unpushed(repo({ branches: [branch({ ahead: 2 })] }))).toBe(2);
    expect(unpushed(repo({ branches: [branch({ upstream: "origin/topic", aheadOfUpstream: 3 })] }))).toBe(3);
  });

  it("leaves HEAD's tracked branch to `ahead`, and skips a merged branch", () => {
    expect(unpushed(repo({ ahead: 4, branches: [branch({ name: "main", isHead: true, ahead: 4 })] }))).toBe(0);
    expect(unpushed(repo({ branches: [branch({ ahead: 2, merged: true })] }))).toBe(0);
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
