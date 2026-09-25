import { describe, expect, it } from "vitest";
import {
  cloneCommand,
  cloneName,
  clonePath,
  commitCommand,
  discardCommands,
  isClaudeWorktree,
  quote,
  releaseCommand,
  shellKind,
  tagCommand,
  validRefName,
} from "./shell";
import type { WorktreeSummary } from "./types";

describe("quote", () => {
  it("doubles an apostrophe for PowerShell and closes around it for POSIX", () => {
    expect(quote("don't", "powershell")).toBe("'don''t'");
    expect(quote("don't", "posix")).toBe("'don'\\''t'");
  });

  it("keeps a space inside one argument", () => {
    expect(quote("My Folder/file.ts", "powershell")).toBe("'My Folder/file.ts'");
    expect(quote("My Folder/file.ts", "posix")).toBe("'My Folder/file.ts'");
  });

  it("gives an empty string two quotes rather than nothing", () => {
    expect(quote("", "powershell")).toBe("''");
    expect(quote("", "posix")).toBe("''");
  });

  it("expands nothing: a dollar and a backtick come through as typed", () => {
    expect(quote("$env:TEMP `x", "powershell")).toBe("'$env:TEMP `x'");
    expect(quote("$HOME", "posix")).toBe("'$HOME'");
  });
});

describe("shellKind", () => {
  it("reads the shell from the last path component", () => {
    expect(shellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
    expect(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
    expect(shellKind("/bin/bash")).toBe("posix");
    expect(shellKind(undefined)).toBe("powershell");
  });
});

describe("commitCommand", () => {
  it("types a subject alone with -m", () => {
    expect(commitCommand("Fix the thing", null, "powershell")).toBe("git commit -m 'Fix the thing'");
  });

  it("carries a described commit by file, so a list in the body keeps its lines", () => {
    // The subject is not on the line: the file holds the whole message.
    expect(commitCommand("Fix the thing", "C:\\data\\scratch\\msg.txt", "powershell")).toBe(
      "git commit -F 'C:\\data\\scratch\\msg.txt'",
    );
  });

  it("trims the subject and puts --amend before the message", () => {
    expect(commitCommand("  Reword  ", null, "posix", true)).toBe("git commit --amend -m 'Reword'");
  });
});

describe("discardCommands", () => {
  const tracked = { path: "src/a.ts", untracked: false };
  const untracked = { path: "notes.md", untracked: true };

  it("restores a tracked file", () => {
    expect(discardCommands([tracked], "powershell")).toEqual(["git restore -- 'src/a.ts'"]);
  });

  it("cleans an untracked file, which restore has nothing to restore", () => {
    expect(discardCommands([untracked], "powershell")).toEqual(["git clean -f -- 'notes.md'"]);
  });

  it("names both commands when both kinds are selected", () => {
    expect(discardCommands([tracked, untracked], "powershell")).toEqual([
      "git restore -- 'src/a.ts'",
      "git clean -f -- 'notes.md'",
    ]);
  });

  it("says . for the whole tree, and -d for the directories that are new", () => {
    expect(discardCommands([tracked, untracked], "powershell", true)).toEqual([
      "git restore -- .",
      "git clean -fd",
    ]);
    expect(discardCommands([tracked], "powershell", true)).toEqual(["git restore -- ."]);
  });
});

describe("tagCommand", () => {
  it("is lightweight without a message and annotated with one", () => {
    expect(tagCommand("v1.0.0", "", "abc1234", "powershell")).toBe("git tag 'v1.0.0' abc1234");
    expect(tagCommand("v1.0.0", "First release", "abc1234", "powershell")).toBe(
      "git tag -a -m 'First release' 'v1.0.0' abc1234",
    );
  });

  it("gives each paragraph its own -m", () => {
    expect(tagCommand("v1.0.0", "First\nrelease\n\nWith notes", "abc1234", "posix")).toBe(
      "git tag -a -m 'First release' -m 'With notes' 'v1.0.0' abc1234",
    );
  });
});

describe("validRefName", () => {
  // The examples under `git check-ref-format`'s rules, one per rule.
  it.each([
    ["v1.0.0", true],
    ["feature/thing", true],
    ["release-2026.09", true],
    ["", false],
    ["@", false],
    ["-flag", false],
    ["/leading", false],
    ["trailing/", false],
    ["ends.", false],
    ["ends.lock", false],
    ["a..b", false],
    ["a@{b", false],
    ["a//b", false],
    ["has space", false],
    ["tilde~", false],
    ["caret^", false],
    ["colon:", false],
    ["question?", false],
    ["star*", false],
    ["bracket[", false],
    ["back\\slash", false],
    ["control\x07", false],
    ["del\x7f", false],
    [".hidden", false],
    ["a/.hidden", false],
    ["a/b.lock/c", false],
  ])("%j is %s", (name, ok) => {
    expect(validRefName(name)).toBe(ok);
  });
});

describe("clone", () => {
  it("names the folder the way git does", () => {
    expect(cloneName("https://github.com/JacobPoteet/GitView.git")).toBe("GitView");
    expect(cloneName("https://github.com/JacobPoteet/GitView/")).toBe("GitView");
    expect(cloneName("git@github.com:JacobPoteet/GitView.git")).toBe("GitView");
    expect(cloneName("git@host:solo")).toBe("solo");
    expect(cloneName("C:\\origins\\atlas.git")).toBe("atlas");
  });

  it("refuses a URL with no usable name", () => {
    expect(cloneName("")).toBeNull();
    expect(cloneName("https://")).toBeNull();
    expect(cloneName("not a url")).toBeNull();
  });

  it("joins with the parent's own separator", () => {
    expect(clonePath("F:\\GitHub", "x")).toBe("F:\\GitHub\\x");
    expect(clonePath("F:\\GitHub\\", "x")).toBe("F:\\GitHub\\x");
    expect(clonePath("/home/me/src", "x")).toBe("/home/me/src/x");
  });

  it("quotes both arguments", () => {
    expect(cloneCommand(" https://h/o/r.git ", "C:\\My Code\\r", "powershell")).toBe(
      "git clone 'https://h/o/r.git' 'C:\\My Code\\r'",
    );
  });
});

describe("releaseCommand", () => {
  const worktree = (over: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
    path: "F:\\GitHub\\app\\.claude\\worktrees\\issue 9",
    branch: "issue-9",
    main: false,
    prunable: false,
    locked: false,
    ...over,
  });

  it("removes a live worktree, quoting its path", () => {
    expect(releaseCommand(worktree(), "powershell")).toBe(
      "git worktree remove 'F:\\GitHub\\app\\.claude\\worktrees\\issue 9'",
    );
  });

  it("prunes a record whose folder is gone, and offers nothing for main or a lock", () => {
    expect(releaseCommand(worktree({ prunable: true }), "powershell")).toBe("git worktree prune");
    expect(releaseCommand(worktree({ main: true }), "powershell")).toBeNull();
    expect(releaseCommand(worktree({ locked: true }), "powershell")).toBeNull();
    expect(releaseCommand(worktree({ locked: true, prunable: true }), "powershell")).toBeNull();
  });

  it("knows a Claude Code worktree by its folder", () => {
    expect(isClaudeWorktree(worktree().path)).toBe(true);
    expect(isClaudeWorktree("F:/GitHub/app/.claude/worktrees/x")).toBe(true);
    expect(isClaudeWorktree("F:\\GitHub\\app.worktrees\\x")).toBe(false);
  });
});
