import { describe, expect, it } from "vitest";
import {
  byNeed,
  byRepo,
  checkTone,
  closedBy,
  groupSize,
  itemKey,
  mergeBlock,
  nestClosed,
  refKey,
  refLabel,
} from "./inbox";
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
    closes: [],
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

describe("closing references", () => {
  const ref = (number: number, ownerRepo = "someone/example") => ({
    ownerRepo,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${ownerRepo}/issues/${number}`,
  });

  it("keys a reference the way the issue's own row is keyed", () => {
    expect(refKey(ref(130))).toBe(itemKey(item({ kind: "issue", number: 130 })));
  });

  it("writes the repository only when it is another one", () => {
    expect(refLabel(ref(130), "someone/example")).toBe("#130");
    expect(refLabel(ref(9, "someone/other"), "someone/example")).toBe("someone/other#9");
  });

  it("finds every pull request that closes an issue, from the issue's side", () => {
    const a = item({ number: 131, closes: [ref(130), ref(9, "someone/other")] });
    const b = item({ number: 132, closes: [ref(130)] });
    const issue = item({ kind: "issue", number: 130, closes: [] });
    const map = closedBy([a, b, issue]);
    expect(map.get(refKey(ref(130)))?.map((pr) => pr.number)).toEqual([131, 132]);
    expect(map.get(refKey(ref(9, "someone/other")))).toEqual([a]);
    expect(map.has(itemKey(a))).toBe(false);
  });

  it("draws an issue under the pull request that closes it, once", () => {
    const pr = item({ number: 131, closes: [ref(130)] });
    const issue = item({ kind: "issue", number: 130, mine: true });
    const other = item({ kind: "issue", number: 12, mine: true });
    const groups = nestClosed(byNeed([pr, issue, other]));
    // The issue leaves "Issues you opened" and rides with the pull request.
    expect(groups.map((g) => g.items.map(itemKey))).toEqual([[itemKey(pr)], [itemKey(other)]]);
    expect(groups[0].nested?.get(itemKey(pr))).toEqual([issue]);
    expect(groups.map(groupSize)).toEqual([2, 1]);
  });

  it("drops a group the nesting empties, and leaves another repository's issue where it was", () => {
    const pr = item({ number: 131, closes: [ref(130), ref(9, "someone/other")] });
    const issue = item({ kind: "issue", number: 130, mine: true });
    const elsewhere = item({ kind: "issue", number: 9, ownerRepo: "someone/other", mine: false });
    const groups = nestClosed(byNeed([pr, issue, elsewhere]));
    expect(groups.map((g) => g.key)).toEqual(["need:mine", "need:others"]);
    expect(groups[1].items).toEqual([elsewhere]);
  });

  it("gives an issue two pull requests close to the one that moved last", () => {
    const older = item({ number: 131, updatedAt: "2026-09-20T00:00:00Z", closes: [ref(130)] });
    const newer = item({ number: 132, updatedAt: "2026-09-22T00:00:00Z", closes: [ref(130)] });
    const issue = item({ kind: "issue", number: 130 });
    const [group] = nestClosed(byRepo([older, newer, issue]));
    expect(group.nested?.get(itemKey(newer))).toEqual([issue]);
    expect(group.nested?.has(itemKey(older))).toBe(false);
  });
});
