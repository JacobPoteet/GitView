import { describe, expect, it } from "vitest";
import { rank, score } from "./palette";

const issue = (label: string) => ({ label, hint: "issue", inbox: true });
const labels = (query: string, items: { label: string; hint?: string; inbox?: boolean }[]) =>
  rank(query, items).map((item) => item.label);

describe("score", () => {
  it("orders exact, prefix, word start, mid-word, hint, then scattered", () => {
    const needle = "sync";
    const bands = [
      score(needle, { label: "Sync" }),
      score(needle, { label: "Sync all" }),
      score(needle, { label: "Fleet sync" }),
      score(needle, { label: "Resync" }),
      score(needle, { label: "Fetch", hint: "then sync" }),
      score(needle, { label: "Show your conflicts" }),
    ] as number[];
    expect(bands.every((band) => band !== null)).toBe(true);
    expect([...bands].sort((a, b) => b - a)).toEqual(bands);
    expect(new Set(bands).size).toBe(bands.length);
  });

  it("keeps a word start above a mid-word hit however long the label", () => {
    const far = `${"x".repeat(200)} sync`;
    expect(score("sync", { label: far })!).toBeGreaterThan(score("sync", { label: "Resync" })!);
  });

  it("still finds an initialism", () => {
    expect(score("lsdev", { label: "LunchSpecial · dev" })).not.toBeNull();
  });

  it("ranks a tight scattered run above a sprawling one", () => {
    const tight = score("prn", { label: "Prune" })!;
    const loose = score("prn", { label: "Pull request needed" })!;
    expect(tight).toBeGreaterThan(loose);
  });

  it("does not let a hint donate scattered letters", () => {
    expect(score("prune", { label: "Dev", hint: "npm run dev" })).toBeNull();
  });
});

describe("an inbox row", () => {
  it("never matches on scattered letters", () => {
    expect(score("theme", issue("GitView #12 The heat map measures everything"))).toBeNull();
    expect(score("stash", issue("GitView #40 Status text after a shell closes"))).toBeNull();
  });

  it("never matches mid-word", () => {
    expect(score("merge", issue("GitView #7 Emerge from the splash sooner"))).toBeNull();
  });

  it("matches on a word start, the number and its hint", () => {
    expect(score("theme", issue("GitView #12 Add a theme"))).not.toBeNull();
    expect(score("12", issue("GitView #12 Add a theme"))).not.toBeNull();
    expect(score("issue", issue("GitView #12 Add a theme"))).not.toBeNull();
  });

  it("ranks below every command that matches, and above scattered letters", () => {
    const items = [
      issue("Open #1 Open a file from the tree"),
      { label: "Other pending note" }, // o-p-e-n, scattered
      { label: "Fleet", hint: "open the fleet" },
      { label: "Reopen the last tab" },
      { label: "Open diff" },
    ];
    expect(labels("open", items)).toEqual([
      "Open diff",
      "Reopen the last tab",
      "Fleet",
      "Open #1 Open a file from the tree",
      "Other pending note",
    ]);
  });
});

describe("rank", () => {
  it("returns everything in order for an empty query", () => {
    const items = [{ label: "b" }, { label: "a" }];
    expect(labels("  ", items)).toEqual(["b", "a"]);
  });

  it("keeps ties in the order it was given", () => {
    const items = [{ label: "Sync one" }, { label: "Sync two" }];
    expect(labels("sync", items)).toEqual(["Sync one", "Sync two"]);
  });

  it("drops what does not match", () => {
    expect(labels("zzz", [{ label: "Sync" }])).toEqual([]);
  });
});
