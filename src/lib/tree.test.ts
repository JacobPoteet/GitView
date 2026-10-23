import { describe, expect, it } from "vitest";
import { closeUnder, flatten, marks, parentOf, sideFor, type TreeEntry } from "./tree";
import type { FileChange } from "./types";

const dir = (path: string): TreeEntry => ({ name: path.split("/").pop()!, path, dir: true, ignored: false });
const file = (path: string): TreeEntry => ({ name: path.split("/").pop()!, path, dir: false, ignored: false });

describe("flatten", () => {
  const listings = new Map([
    ["", [dir("src"), dir("docs"), file("README.md")]],
    ["src", [dir("src/lib"), file("src/main.ts")]],
    ["src/lib", [file("src/lib/a.ts")]],
  ]);

  it("draws an open folder's listing under it, one level deeper", () => {
    const rows = flatten(listings, new Set(["src"]));
    expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([
      ["src", 0],
      ["src/lib", 1],
      ["src/main.ts", 1],
      ["docs", 0],
      ["README.md", 0],
    ]);
  });

  it("keeps an inner folder open behind a closed parent", () => {
    // Closing src and opening it again brings src/lib back open, the way it was.
    const rows = flatten(listings, new Set(["src/lib"]));
    expect(rows.map((r) => r.entry.path)).toEqual(["src", "docs", "README.md"]);
  });

  it("draws an open folder with no listing yet as open and empty", () => {
    const rows = flatten(listings, new Set(["docs"]));
    expect(rows.find((r) => r.entry.path === "docs")?.open).toBe(true);
    expect(rows).toHaveLength(3);
  });
});

describe("closeUnder", () => {
  it("closes the folder and everything under it, and nothing beside it", () => {
    const next = closeUnder(new Set(["src", "src/lib", "src/lib/x", "srcfoo", "docs"]), "src");
    expect([...next].sort()).toEqual(["docs", "srcfoo"]);
  });
});

describe("parentOf", () => {
  it("puts a top-level entry in the root", () => {
    expect(parentOf("README.md")).toBe("");
    expect(parentOf("src/lib/a.ts")).toBe("src/lib");
  });
});

describe("marks", () => {
  const change = (path: string, state: FileChange["state"], staged = false): FileChange => ({
    path,
    state,
    staged,
  });

  it("rolls the loudest change up to every folder above it", () => {
    const { dirs } = marks([
      change("src/lib/new.ts", "new"),
      change("src/lib/old.ts", "deleted"),
      change("src/app.ts", "conflicted"),
      change("docs/a.md", "new"),
    ]);
    expect(dirs.get("src")).toBe("conflicted");
    expect(dirs.get("src/lib")).toBe("modified");
    expect(dirs.get("docs")).toBe("new");
    expect(dirs.has("")).toBe(false);
  });

  it("shows the working-tree side of a file staged and edited again", () => {
    const { files } = marks([change("a.ts", "new", true), change("a.ts", "modified")]);
    expect(files.get("a.ts")).toBe("modified");
  });
});

describe("sideFor", () => {
  it("opens the working tree, the staged copy when that is all, and nothing for a clean file", () => {
    const changes: FileChange[] = [
      { path: "a.ts", state: "modified", staged: true },
      { path: "a.ts", state: "modified", staged: false },
      { path: "b.ts", state: "new", staged: true },
    ];
    expect(sideFor(changes, "a.ts")).toBe(false);
    expect(sideFor(changes, "b.ts")).toBe(true);
    expect(sideFor(changes, "c.ts")).toBe(null);
  });
});
