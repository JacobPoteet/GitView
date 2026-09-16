import { describe, expect, it } from "vitest";
import { byNeed, byRepo, checkTone, itemKey, mergeBlock } from "./inbox";
import type { InboxItem } from "./types";

function item(over: Partial<InboxItem>): InboxItem {
  return {
    kind: "pr",
    repoPath: "F:\\GitHub\\example",
    repoName: "example",
    ownerRepo: "someone/example",
    number: 1,
    title: "A change",
    url: "https://github.com/someone/example/pull/1",
    updatedAt: "2026-09-16T10:00:00Z",
    author: "someone",
    draft: false,
    headRef: "topic",
    reviewDecision: null,
    checks: "SUCCESS",
    checkRuns: [],
    baseRef: "main",
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    mergeMethods: ["squash", "merge"],
    deleteBranchOnMerge: false,
    mine: true,
    reviewRequested: false,
    assigned: false,
    ...over,
  };
}

describe("itemKey", () => {
  it("is stable across refreshes and tells a PR from an issue with the same number", () => {
    expect(itemKey(item({ number: 7 }))).toBe("someone/example#pr7");
    expect(itemKey(item({ number: 7, kind: "issue" }))).toBe("someone/example#issue7");
  });
});

describe("byNeed", () => {
  it("puts each row in the first group that wants it, and drops empty groups", () => {
    const review = item({ number: 1, mine: false, reviewRequested: true });
    const failing = item({ number: 2, checks: "FAILURE" });
    const mine = item({ number: 3 });
    const assigned = item({ number: 4, kind: "issue", assigned: true, mine: false });
    const opened = item({ number: 5, kind: "issue" });
    const stranger = item({ number: 6, kind: "issue", mine: false });
    const groups = byNeed([stranger, opened, assigned, mine, failing, review]);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.number)])).toEqual([
      ["need:review", [1]],
      ["need:failing", [2]],
      ["need:mine", [3]],
      ["need:assigned", [4]],
      ["need:opened", [5]],
      ["need:others", [6]],
    ]);
  });

  it("does not list a failing PR of yours twice when a review is also asked", () => {
    const both = item({ number: 1, checks: "FAILURE", reviewRequested: true });
    const groups = byNeed([both]);
    expect(groups.map((g) => g.key)).toEqual(["need:review"]);
  });
});

describe("byRepo", () => {
  it("orders repositories by their freshest row and PRs before issues inside one", () => {
    const oldRepo = item({ ownerRepo: "a/old", repoName: "old", updatedAt: "2026-09-01T00:00:00Z" });
    const newIssue = item({ ownerRepo: "b/new", repoName: "new", kind: "issue", number: 2, updatedAt: "2026-09-16T00:00:00Z" });
    const newPr = item({ ownerRepo: "b/new", repoName: "new", number: 3, updatedAt: "2026-09-10T00:00:00Z" });
    const groups = byRepo([oldRepo, newIssue, newPr]);
    expect(groups.map((g) => g.label)).toEqual(["new", "old"]);
    expect(groups[0].items.map((i) => i.number)).toEqual([3, 2]);
  });
});

describe("checkTone and mergeBlock", () => {
  it("reads a rollup into a tone", () => {
    expect(checkTone("SUCCESS")).toBe("ok");
    expect(checkTone("FAILURE")).toBe("bad");
    expect(checkTone("PENDING")).toBe("pending");
    // A null rollup is Actions not having registered a check yet, so it waits.
    expect(checkTone(null)).toBe("pending");
    expect(checkTone("SKIPPED")).toBe("off");
  });

  it("says why the merge button is off, in GitHub's words, and nothing when it is on", () => {
    expect(mergeBlock(item({}))).toBeNull();
    expect(mergeBlock(item({ draft: true }))).toMatch(/draft/i);
    expect(mergeBlock(item({ mergeable: "CONFLICTING" }))).toMatch(/Conflicts with main/);
    expect(mergeBlock(item({ mergeState: "BLOCKED" }))).toMatch(/branch protection/);
    expect(mergeBlock(item({ mergeMethods: [] }))).toMatch(/no merge method/);
    // GitHub still computing leaves the button on and lets the scrollback say.
    expect(mergeBlock(item({ mergeable: "UNKNOWN" }))).toBeNull();
  });
});
