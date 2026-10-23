/**
 * The file tree the rail shows for one repository, as pure functions.
 *
 * Rust hands over folders one listing at a time (see tree.rs). What is drawn
 * is those listings flattened under whichever folders are open, with the
 * changes column's states laid over the top so a file shows the same letter it
 * has there and a folder says something under it changed.
 */

import type { FileChange } from "./types";

export interface TreeEntry {
  name: string;
  /** From the repository's root, forward slashes. */
  path: string;
  dir: boolean;
  ignored: boolean;
}

export interface TreeListing {
  /** The root is the empty string. */
  dir: string;
  entries: TreeEntry[];
  error: string | null;
}

export interface Tree {
  listings: TreeListing[];
  truncated: boolean;
}

/** One drawn row: an entry and how deep it sits. */
export interface TreeRow {
  entry: TreeEntry;
  depth: number;
  open: boolean;
}

/**
 * The rows top to bottom: each listing's entries, and under each open folder
 * that has a listing, its own. A folder that is open but not read yet draws as
 * open and empty for the moment it takes to arrive.
 */
export function flatten(listings: Map<string, TreeEntry[]>, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of listings.get(dir) ?? []) {
      const open = entry.dir && expanded.has(entry.path);
      rows.push({ entry, depth, open });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/** Whether `path` is `dir` or somewhere under it. The root holds everything. */
export function within(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/** The open set without `dir` and every folder under it, for Ctrl+click on an open folder. */
export function closeUnder(expanded: Set<string>, dir: string): Set<string> {
  return new Set([...expanded].filter((path) => !within(path, dir)));
}

/** The folder a path sits in. The root's children sit in "". */
export function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

export type Mark = FileChange["state"];

/**
 * The state each changed file shows, and the one each folder above it rolls
 * up to. A file staged and then edited again shows its working-tree side,
 * since that is the one a click opens. A folder shows the loudest thing under
 * it: a conflict, then any change to a file git has, then a new file.
 */
export function marks(changes: FileChange[]): { files: Map<string, Mark>; dirs: Map<string, Mark> } {
  const files = new Map<string, Mark>();
  for (const change of changes) {
    if (!change.staged || !files.has(change.path)) files.set(change.path, change.state);
  }
  const rank = (mark: Mark) => (mark === "conflicted" ? 2 : mark === "new" ? 0 : 1);
  const dirs = new Map<string, Mark>();
  for (const [path, mark] of files) {
    const rolled: Mark = rank(mark) === 1 ? "modified" : mark;
    for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) {
      const was = dirs.get(dir);
      if (was && rank(was) >= rank(rolled)) continue;
      dirs.set(dir, rolled);
    }
  }
  return { files, dirs };
}

/**
 * Which side of the index a click on a changed file opens: the working tree
 * when it has one, the staged copy when that is all there is, and null when
 * the file has no change, which sends the click to the file's history instead.
 */
export function sideFor(changes: FileChange[], path: string): boolean | null {
  const rows = changes.filter((c) => c.path === path);
  if (rows.length === 0) return null;
  return rows.every((c) => c.staged);
}
