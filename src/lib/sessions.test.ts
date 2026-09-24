import { describe, expect, it } from "vitest";
import {
  claudeId,
  isClaude,
  nextSessionId,
  pickShell,
  sessionId,
  sessionLabel,
  sessionNumber,
  sessionRepo,
  sessionsOf,
} from "./sessions";

const repo = "F:\\GitHub\\example";

describe("session ids", () => {
  it("names the first shell after the path and the rest with a number", () => {
    expect(sessionId(repo, 1)).toBe(repo);
    expect(sessionId(repo, 2)).toBe(`${repo}#2`);
    expect(sessionNumber(repo)).toBe(1);
    expect(sessionNumber(`${repo}#3`)).toBe(3);
    expect(sessionRepo(`${repo}#3`)).toBe(repo);
    expect(sessionRepo(repo)).toBe(repo);
  });

  it("labels the tabs", () => {
    expect(sessionLabel(repo)).toBe("shell");
    expect(sessionLabel(`${repo}#2`)).toBe("shell 2");
  });

  it("lists one repository's shells in order and leaves the others out", () => {
    const ids = [`${repo}#3`, "F:\\GitHub\\other", repo, `${repo}#2`, "F:\\GitHub\\other#2"];
    expect(sessionsOf(repo, ids)).toEqual([repo, `${repo}#2`, `${repo}#3`]);
  });

  it("numbers a new shell past the highest, never into a gap", () => {
    expect(nextSessionId(repo, [])).toBe(`${repo}#2`);
    expect(nextSessionId(repo, [repo])).toBe(`${repo}#2`);
    expect(nextSessionId(repo, [repo, `${repo}#3`])).toBe(`${repo}#4`);
  });

  it("puts the Claude tab after the first shell and never numbers it", () => {
    const claude = claudeId(repo);
    expect(claude).toBe(`${repo}#claude`);
    expect(isClaude(claude)).toBe(true);
    expect(isClaude(repo)).toBe(false);
    expect(sessionRepo(claude)).toBe(repo);
    expect(sessionNumber(claude)).toBe(0);
    expect(sessionLabel(claude)).toBe("Claude");
    expect(sessionsOf(repo, [`${repo}#2`, claude, repo])).toEqual([repo, claude, `${repo}#2`]);
    expect(nextSessionId(repo, [repo, claude])).toBe(`${repo}#2`);
  });

});

describe("the shell a command lands in", () => {
  const two = `${repo}#2`;
  const three = `${repo}#3`;
  const claude = claudeId(repo);
  const idle = () => false;
  const holding = (...ids: string[]) => (id: string) => ids.includes(id);

  it("stays on the tab on screen while it is at its prompt", () => {
    expect(pickShell(repo, two, [repo, two], idle)).toBe(two);
  });

  it("skips a shell running claude, or anything else, for the first free one", () => {
    expect(pickShell(repo, repo, [repo, two, three], holding(repo))).toBe(two);
    expect(pickShell(repo, three, [repo, two, three], holding(three))).toBe(repo);
  });

  it("never picks the Claude tab, running or not", () => {
    expect(pickShell(repo, claude, [repo, claude], idle)).toBe(repo);
    expect(pickShell(repo, claude, [claude], idle)).toBe(repo);
  });

  it("opens a new shell when every one is busy", () => {
    expect(pickShell(repo, repo, [repo, claude, two], holding(repo, two))).toBe(three);
  });

  it("reopens the first shell before numbering a new one", () => {
    expect(pickShell(repo, two, [two], holding(two))).toBe(repo);
  });

  it("ignores another repository's shell on screen", () => {
    expect(pickShell(repo, "F:\\GitHub\\other", [repo], idle)).toBe(repo);
  });
});
