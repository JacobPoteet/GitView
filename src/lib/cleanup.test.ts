import { describe, expect, it } from "vitest";
import {
  cleanupCommands,
  cleanupRows,
  confirmLabel,
  finishedCount,
  hasOtherBranches,
  pullFirst,
  type CleanupRow,
} from "./cleanup";
import { repo } from "./fixtures";
import type {
  BranchSummary,
  CleanupRead,
  RemoteBranch,
  Squashed,
  WorktreeCheck,
  WorktreeSummary,
} from "./types";

const branch = (name: string, over: Partial<BranchSummary> = {}): BranchSummary => ({
  name,
  ahead: 2,
  behind: 3,
  isHead: false,
  merged: false,
  lastCommitAt: null,
  tip: "aaa",
  upstream: null,
  aheadOfUpstream: 0,
  worktree: null,
  goneUpstream: null,
  originTip: null,
  ...over,
});

const main = branch("main", { isHead: true, ahead: 0, behind: 0, upstream: "origin/main" });

const contained = (name: string, over: Partial<BranchSummary> = {}) =>
  branch(name, { merged: true, ahead: 0, ...over });

const worktree = (path: string, over: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  path,
  branch: null,
  main: false,
  prunable: false,
  locked: false,
  lockReason: null,
  ...over,
});

const check = (path: string, over: Partial<WorktreeCheck> = {}): WorktreeCheck => ({
  path,
  changed: [],
  changedCount: 0,
  lineEndings: [],
  ignored: [],
  ignoredCount: 0,
  submodules: false,
  inUse: false,
  error: null,
  ...over,
});

const remote = (name: string, over: Partial<RemoteBranch> = {}): RemoteBranch => ({
  name,
  tip: "bbb",
  ahead: 0,
  lastCommitAt: null,
  ...over,
});

const squash = (name: string, over: Partial<Squashed> = {}): Squashed => ({
  branch: name,
  into: "0".repeat(40),
  intoShort: "0000000",
  intoSummary: "Squash",
  base: "origin/main",
  commits: 1,
  protected: false,
  remote: false,
  ...over,
});

const empty: CleanupRead = { worktrees: [], remoteBranches: [] };
const options = { kind: "powershell" as const, pull: false, withRemote: true };

function rowsOf(branches: BranchSummary[], extra: { squashed?: Squashed[]; read?: CleanupRead; worktrees?: WorktreeSummary[] } = {}) {
  return cleanupRows(
    repo({ branches: [main, ...branches], worktrees: extra.worktrees ?? [] }),
    extra.squashed ?? [],
    extra.read ?? empty,
  );
}

/** The sentence behind a row's tags, and the tags themselves. */
const words = (row: CleanupRow) => row.tags.map((tag) => tag.label);
const sentences = (row: CleanupRow) => row.tags.map((tag) => tag.title).join(" ");

function only(rows: CleanupRow[], key: string): CleanupRow {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe("cleanupRows", () => {
  it("never lists the branch you are on or the default branch", () => {
    const rows = cleanupRows(
      repo({ branch: "topic", branches: [branch("topic", { isHead: true }), branch("main")] }),
      [],
      empty,
    );
    expect(rows).toEqual([]);
  });

  it("ticks what is proven finished and nothing else", () => {
    const rows = rowsOf(
      [
        contained("merged"),
        branch("squashed"),
        branch("gone", { goneUpstream: "origin/gone" }),
        branch("wip"),
      ],
      { squashed: [squash("squashed")] },
    );
    expect(only(rows, "merged").ticked).toBe(true);
    expect(only(rows, "squashed").ticked).toBe(true);
    expect(only(rows, "gone").verdict).toBe("gone");
    expect(only(rows, "gone").ticked).toBe(false);
    expect(only(rows, "wip").verdict).toBe("unfinished");
    expect(only(rows, "wip").ticked).toBe(false);
  });

  it("says how a branch that is not finished stands against its remote", () => {
    const rows = rowsOf([
      branch("pushed", { upstream: "origin/pushed", originTip: "aaa" }),
      branch("ahead", { upstream: "origin/ahead", aheadOfUpstream: 1, originTip: "ccc" }),
      branch("never"),
    ]);
    expect(words(only(rows, "pushed"))).toEqual(["↑2", "origin"]);
    expect(words(only(rows, "ahead"))).toEqual(["↑2", "⇡1", "origin ahead"]);
    expect(words(only(rows, "never"))).toEqual(["↑2", "local"]);
  });

  it("never reads a worktree level with the trunk as finished", () => {
    const held = contained("new", { behind: 0, worktree: "F:\\wt\\new" });
    const rows = rowsOf([held], { worktrees: [worktree("F:\\wt\\new", { branch: "new" })] });
    expect(only(rows, "new").verdict).toBe("fresh");
    expect(only(rows, "new").ticked).toBe(false);
  });

  it("leaves a row with work in its worktree unticked and says what happens to it", () => {
    const path = "F:\\wt\\dirty";
    const rows = rowsOf([contained("dirty", { worktree: path })], {
      worktrees: [worktree(path, { branch: "dirty" })],
      read: { ...empty, worktrees: [check(path, { changed: ["a.txt"], changedCount: 1 })] },
    });
    const row = only(rows, "dirty");
    expect(row.verdict).toBe("contained");
    expect(row.ticked).toBe(false);
    expect(words(row)).toContain("1 changed");
    expect(sentences(row)).toContain("Kept in a stash first: a.txt");
  });

  it("ticks a worktree that only has line endings to lose", () => {
    const path = "F:\\wt\\eol";
    const rows = rowsOf([contained("eol", { worktree: path })], {
      worktrees: [worktree(path, { branch: "eol" })],
      read: { ...empty, worktrees: [check(path, { lineEndings: ["Cargo.toml"] })] },
    });
    expect(only(rows, "eol").ticked).toBe(true);
    expect(words(only(rows, "eol"))).toEqual(["merged", "worktree"]);
    expect(sentences(only(rows, "eol"))).toContain("Only line endings changed");
  });

  it("names ignored files nothing will keep", () => {
    const path = "F:\\wt\\ign";
    const rows = rowsOf([contained("ign", { worktree: path })], {
      worktrees: [worktree(path, { branch: "ign" })],
      read: {
        ...empty,
        worktrees: [check(path, { ignored: [".env.local"], ignoredCount: 3 })],
      },
    });
    expect(words(only(rows, "ign"))).toContain("3 ignored");
    expect(sentences(only(rows, "ign"))).toContain(".env.local and 2 more");
  });

  it("leaves a locked worktree unticked, with the reason it was given", () => {
    const path = "F:\\wt\\lock";
    const rows = rowsOf([contained("lock", { worktree: path })], {
      worktrees: [worktree(path, { branch: "lock", locked: true, lockReason: "agent 7" })],
    });
    expect(only(rows, "lock").ticked).toBe(false);
    expect(only(rows, "lock").blocked).toBeNull();
    expect(sentences(only(rows, "lock"))).toContain("Locked: agent 7");
  });

  it("blocks a branch the main checkout has, since nothing here can free it", () => {
    const path = "F:\\app";
    const rows = rowsOf([contained("there", { worktree: path })], {
      worktrees: [worktree(path, { branch: "there", main: true })],
    });
    expect(only(rows, "there").blocked).toContain("main checkout");
    expect(only(rows, "there").ticked).toBe(false);
    expect(only(rows, "there").worktree).toBeNull();
  });

  it("will not tick a branch whose copy on origin has moved on", () => {
    const rows = rowsOf(
      [
        contained("moved", { originTip: "new" }),
        contained("same", { tip: "x", originTip: "x" }),
        contained("alsoin", { originTip: "old" }),
        contained("sq", { originTip: "sqtip" }),
      ],
      {
        squashed: [squash("origin/sq", { remote: true })],
        read: {
          ...empty,
          remoteBranches: [
            remote("moved", { ahead: 1 }),
            remote("same"),
            remote("alsoin", { ahead: 0 }),
            remote("sq", { ahead: 2 }),
          ],
        },
      },
    );
    expect(only(rows, "moved").ticked).toBe(false);
    expect(words(only(rows, "moved"))).toContain("origin ahead");
    expect(only(rows, "same").ticked).toBe(true);
    expect(only(rows, "alsoin").ticked).toBe(true);
    expect(only(rows, "sq").ticked).toBe(true);
  });

  it("only offers a remote delete when origin has the branch", () => {
    const rows = rowsOf([
      contained("gone", { goneUpstream: "origin/gone" }),
      contained("there", { originTip: "aaa" }),
      contained("never"),
    ]);
    expect(only(rows, "gone").remote).toBeNull();
    expect(only(rows, "there").remote).toBe("there");
    expect(only(rows, "never").remote).toBeNull();
    expect(words(only(rows, "never"))).toEqual(["merged"]);
  });

  it("does not touch a remote the branch tracks other than origin", () => {
    const rows = rowsOf([contained("fork", { upstream: "upstream/fork" })]);
    expect(only(rows, "fork").remote).toBeNull();
  });

  it("lists a branch only origin has, finished or not", () => {
    const rows = rowsOf([contained("both", { originTip: "bbb" })], {
      squashed: [squash("origin/sq", { remote: true })],
      read: {
        ...empty,
        remoteBranches: [
          remote("both"),
          remote("old"),
          remote("sq", { ahead: 2 }),
          remote("open", { ahead: 1 }),
          remote("unmeasured", { ahead: null }),
        ],
      },
    });
    expect(rows.map((r) => r.key)).toEqual([
      "both",
      "origin/old",
      "origin/sq",
      "origin/open",
      "origin/unmeasured",
    ]);
    expect(only(rows, "origin/old").ticked).toBe(true);
    expect(only(rows, "origin/sq").ticked).toBe(true);
    expect(only(rows, "origin/open").ticked).toBe(false);
    expect(only(rows, "origin/unmeasured").ticked).toBe(false);
    expect(only(rows, "origin/old").branch).toBeNull();
    expect(only(rows, "origin/old").remote).toBe("old");
  });

  it("lists a worktree on no branch, ticked only when its folder is gone", () => {
    const state = repo({
      branches: [main],
      worktrees: [
        worktree("F:\\wt\\live"),
        worktree("F:\\wt\\stale", { prunable: true }),
        worktree("F:\\app", { main: true }),
      ],
    });
    const rows = cleanupRows(state, [], empty);
    expect(rows.map((r) => r.label)).toEqual(["live", "stale"]);
    expect(only(rows, "F:\\wt\\live").ticked).toBe(false);
    expect(only(rows, "F:\\wt\\stale").ticked).toBe(true);
  });
});

describe("a folder something has open", () => {
  const path = "F:\\wt\\open";
  const open = (state: "idle" | "busy" | null = null) =>
    only(
      cleanupRows(
        repo({
          branches: [main, contained("open", { worktree: path })],
          worktrees: [worktree(path, { branch: "open" })],
        }),
        [],
        { ...empty, worktrees: [check(path, { inUse: true })] },
        () => state,
      ),
      "open",
    );

  it("cannot be ticked, so git never reaches its retry question", () => {
    const row = open();
    expect(row.ticked).toBe(false);
    expect(row.blocked).toContain("has this folder open");
    expect(words(row)).toContain("in use");
  });

  it("is ready when the only thing holding it is GitView's own idle shell", () => {
    const row = open("idle");
    expect(row.blocked).toBeNull();
    expect(row.ticked).toBe(true);
    expect(words(row)).not.toContain("in use");
    expect(sentences(row)).toContain("GitView's shell there closes first");
  });

  it("asks for a tick by hand when GitView's shell there is running something", () => {
    const row = open("busy");
    expect(row.blocked).toBeNull();
    expect(row.ticked).toBe(false);
    expect(words(row)).toContain("running");
  });

  it("blocks a worktree on no branch the same way", () => {
    const rows = cleanupRows(
      repo({ branches: [main], worktrees: [worktree(path)] }),
      [],
      { ...empty, worktrees: [check(path, { inUse: true })] },
    );
    expect(rows[0].blocked).toContain("has this folder open");
  });
});

describe("cleanupCommands", () => {
  const held = (name: string, over: Partial<WorktreeSummary> = {}, c: Partial<WorktreeCheck> = {}) => {
    const path = `F:\\wt\\${name}`;
    return only(
      rowsOf([contained(name, { worktree: path })], {
        worktrees: [worktree(path, { branch: name, ...over })],
        read: { ...empty, worktrees: over.prunable ? [] : [check(path, c)] },
      }),
      name,
    );
  };

  it("types a plain remove for a clean worktree, then the branch", () => {
    expect(cleanupCommands([held("a")], options)).toEqual([
      "git worktree remove 'F:\\wt\\a'",
      "git branch -d 'a'",
    ]);
  });

  it("restores line endings by name rather than reaching for --force", () => {
    const row = held("a", {}, { lineEndings: ["src-tauri/Cargo.toml", "it's.txt"] });
    expect(cleanupCommands([row], options)).toEqual([
      "git -C 'F:\\wt\\a' restore -- 'src-tauri/Cargo.toml' 'it''s.txt'",
      "git worktree remove 'F:\\wt\\a'",
      "git branch -d 'a'",
    ]);
  });

  it("stashes real changes, so the remove has nothing to refuse and nothing is lost", () => {
    const row = held("a", {}, { changed: ["x"], changedCount: 1, lineEndings: ["y"] });
    expect(cleanupCommands([row], options)).toEqual([
      "git -C 'F:\\wt\\a' stash push -u -m 'GitView: before removing a'",
      "git worktree remove 'F:\\wt\\a'",
      "git branch -d 'a'",
    ]);
  });

  it("falls back to a stash when too many files changed line endings to name", () => {
    const lineEndings = Array.from({ length: 21 }, (_, i) => `f${i}`);
    const commands = cleanupCommands([held("a", {}, { lineEndings })], options);
    expect(commands[0]).toContain("stash push -u");
    expect(commands.join(" ")).not.toContain("restore");
  });

  it("unlocks a locked worktree first", () => {
    expect(cleanupCommands([held("a", { locked: true })], options)).toEqual([
      "git worktree unlock 'F:\\wt\\a'",
      "git worktree remove 'F:\\wt\\a'",
      "git branch -d 'a'",
    ]);
  });

  it("prunes one record however many folders are gone, ahead of any delete", () => {
    const rows = [held("a", { prunable: true }), held("b", { prunable: true })];
    expect(cleanupCommands(rows, options)).toEqual(["git worktree prune", "git branch -d 'a' 'b'"]);
  });

  it("unlocks a gone worktree before the prune that would otherwise skip it", () => {
    expect(cleanupCommands([held("a", { prunable: true, locked: true })], options)).toEqual([
      "git worktree unlock 'F:\\wt\\a'",
      "git worktree prune",
      "git branch -d 'a'",
    ]);
  });

  it("forces only the remove of a worktree holding submodules", () => {
    const commands = cleanupCommands([held("a", {}, { submodules: true })], options);
    expect(commands[0]).toBe("git worktree remove --force 'F:\\wt\\a'");
  });

  it("keeps -d and -D apart, and pushes one delete for everything on origin", () => {
    const rows = rowsOf(
      [
        contained("merged", { originTip: "aaa", tip: "aaa" }),
        branch("sq", { originTip: "aaa", tip: "aaa" }),
        branch("wip"),
      ],
      {
        squashed: [squash("sq")],
        read: { ...empty, remoteBranches: [remote("merged"), remote("sq"), remote("only")] },
      },
    );
    expect(cleanupCommands(rows, options)).toEqual([
      "git branch -d 'merged'",
      "git branch -D 'sq' 'wip'",
      "git push origin --delete 'merged' 'sq' 'only'",
    ]);
  });

  it("leaves origin alone when that is switched off", () => {
    const rows = rowsOf([contained("merged", { originTip: "aaa", tip: "aaa" })], {
      read: { ...empty, remoteBranches: [remote("merged"), remote("only")] },
    });
    expect(cleanupCommands(rows, { ...options, withRemote: false })).toEqual([
      "git branch -d 'merged'",
    ]);
  });

  it("pulls first, so -d is judged against a HEAD that has the merge", () => {
    expect(cleanupCommands(rowsOf([contained("a")]), { ...options, pull: true })).toEqual([
      "git pull --ff-only",
      "git branch -d 'a'",
    ]);
  });

  it("quotes every name, since a branch can be called x;calc", () => {
    const rows = rowsOf([contained("a;calc"), contained("it's")]);
    expect(cleanupCommands(rows, options)).toEqual(["git branch -d 'a;calc' 'it''s'"]);
    expect(cleanupCommands(rows, { ...options, kind: "posix" })[0]).toBe(
      "git branch -d 'a;calc' 'it'\\''s'",
    );
  });
});

describe("pullFirst", () => {
  it("pulls only the default branch, and only when that can fast-forward", () => {
    expect(pullFirst(repo({ behind: 2 }))).toBe(true);
    expect(pullFirst(repo())).toBe(false);
    expect(pullFirst(repo({ behind: 2, ahead: 1 }))).toBe(false);
    expect(pullFirst(repo({ behind: 2, modified: 1 }))).toBe(false);
    expect(pullFirst(repo({ behind: 2, branch: "topic" }))).toBe(false);
  });
});

describe("confirmLabel", () => {
  it("counts branches, and a worktree when there is nothing else", () => {
    const rows = rowsOf([contained("a"), contained("b")]);
    expect(confirmLabel(rows, true)).toBe("Delete 2 branches");
    expect(confirmLabel(rows.slice(0, 1), true)).toBe("Delete 1 branch");
    const detached = cleanupRows(
      repo({ branches: [main], worktrees: [worktree("F:\\wt\\x")] }),
      [],
      empty,
    );
    expect(confirmLabel(detached, true)).toBe("Remove 1 worktree");
  });

  it("does not count a branch only origin has once origin is off", () => {
    const rows = rowsOf([], { read: { ...empty, remoteBranches: [remote("only")] } });
    expect(confirmLabel(rows, true)).toBe("Delete 1 branch");
    expect(confirmLabel(rows, false)).toBe("Delete");
  });
});

describe("finishedCount", () => {
  it("counts what is finished, held or not, and skips what cannot go", () => {
    const state = repo({
      branches: [
        main,
        contained("merged"),
        contained("held", { worktree: "F:\\wt\\held" }),
        branch("sq"),
        contained("level", { behind: 0, worktree: "F:\\wt\\level" }),
        contained("mainheld", { worktree: "F:\\app" }),
        branch("wip"),
      ],
      worktrees: [worktree("F:\\app", { main: true })],
    });
    expect(finishedCount(state, [squash("sq"), squash("main", { protected: true })])).toBe(3);
  });
});

describe("hasOtherBranches", () => {
  it("is true for anything the dialog would list", () => {
    expect(hasOtherBranches(repo({ branches: [main] }))).toBe(false);
    expect(hasOtherBranches(repo({ branches: [main, branch("x")] }))).toBe(true);
    expect(hasOtherBranches(repo({ branches: [main], remoteOnlyBranches: 1 }))).toBe(true);
    expect(hasOtherBranches(repo({ branches: [main], worktrees: [worktree("F:\\wt\\x")] }))).toBe(true);
    expect(
      hasOtherBranches(repo({ branches: [main], worktrees: [worktree("F:\\app", { main: true })] })),
    ).toBe(false);
  });
});
