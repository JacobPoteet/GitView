import { describe, expect, it } from "vitest";
import { conflictRoles, conflictSides, countConflicts, keepSideCommand } from "./conflict";
import type { Operation } from "./types";

const op = (kind: Operation["kind"], extra: Partial<Operation> = {}): Operation => ({
  kind,
  branch: null,
  onto: null,
  step: null,
  total: null,
  ...extra,
});

describe("conflictRoles", () => {
  it("follows a merge-style conflict line by line", () => {
    const lines = ["a", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "z"];
    expect(conflictRoles(lines)).toEqual([
      null,
      "ours-start",
      "ours",
      "split",
      "theirs",
      "theirs-end",
      null,
    ]);
  });

  it("reads diff3's base section and CRLF line ends", () => {
    const lines = ["<<<<<<< HEAD\r", "o\r", "||||||| base\r", "b\r", "=======\r", "t\r", ">>>>>>> x\r"];
    expect(conflictRoles(lines)).toEqual([
      "ours-start",
      "ours",
      "base-start",
      "base",
      "split",
      "theirs",
      "theirs-end",
    ]);
  });

  it("leaves a rule of equals signs outside a conflict as text", () => {
    expect(conflictRoles(["Title", "=======", ">>>>>>> nothing opened"])).toEqual([
      null,
      null,
      null,
    ]);
    // Eight is not git's marker.
    expect(conflictRoles(["<<<<<<<< no"])).toEqual([null]);
  });

  it("counts every conflict left", () => {
    const one = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x"];
    expect(countConflicts([...one, "mid", ...one])).toBe(2);
    expect(countConflicts(["clean"])).toBe(0);
  });
});

describe("conflictSides", () => {
  it("swaps the names in a rebase", () => {
    const sides = conflictSides(op("rebase", { branch: "feature", onto: "main" }), null);
    expect(sides.ours.name).toBe("main");
    expect(sides.theirs.name).toBe("feature");
    expect(sides.theirs.role).toContain("your commit");
  });

  it("keeps them in a merge", () => {
    const sides = conflictSides(op("merge", { onto: "feature" }), "main");
    expect(sides.ours.name).toBe("main");
    expect(sides.theirs.name).toBe("feature");
  });
});

describe("keepSideCommand", () => {
  it("adds only after the checkout succeeds", () => {
    expect(keepSideCommand("ours", "a.txt", "powershell")).toBe(
      "git checkout --ours -- 'a.txt'; if ($?) { git add -- 'a.txt' }",
    );
    expect(keepSideCommand("theirs", "a b.txt", "posix")).toBe(
      "git checkout --theirs -- 'a b.txt' && git add -- 'a b.txt'",
    );
  });
});
