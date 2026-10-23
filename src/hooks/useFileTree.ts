import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { closeUnder, flatten, marks, type Mark, type TreeEntry, type TreeRow } from "../lib/tree";
import type { FileChange } from "../lib/types";

export interface FileTree {
  rows: TreeRow[];
  /** The changes column's states, by file and rolled up by folder. */
  marks: { files: Map<string, Mark>; dirs: Map<string, Mark> };
  /** The root has been read at least once for this repository. */
  ready: boolean;
  /** The root could not be read. */
  error: string | null;
  retry: () => void;
  /** Opens or closes a folder. `deep` takes every folder under it along. */
  toggle: (dir: string, deep: boolean) => void;
  collapseAll: () => void;
}

/**
 * The rail's file tree for the selected repository.
 *
 * Which folders are open is remembered per repository for as long as the app
 * runs, so going back to the fleet and coming back in, or walking from one
 * project to the next, finds each tree the way it was left. The listings are
 * kept the same way, so a project you come back to draws at once and the
 * fresh read replaces it a moment later.
 *
 * Nothing is read while the rail shows the fleet. While it shows the tree, the
 * root and every open folder are read again whenever the changes column is,
 * which is whenever a shell in that repository settles: a build that writes
 * `dist/` shows up without a refresh button.
 */
export function useFileTree(
  repoPath: string | null,
  active: boolean,
  changes: FileChange[],
  onNote: (note: string) => void,
): FileTree {
  const expandedBy = useRef(new Map<string, Set<string>>());
  const listingsBy = useRef(new Map<string, Map<string, TreeEntry[]>>());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [error, setError] = useState<{ path: string; text: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  const expandedOf = useCallback((path: string) => {
    let set = expandedBy.current.get(path);
    if (!set) expandedBy.current.set(path, (set = new Set()));
    return set;
  }, []);
  const listingsOf = useCallback((path: string) => {
    let map = listingsBy.current.get(path);
    if (!map) listingsBy.current.set(path, (map = new Map()));
    return map;
  }, []);

  const read = useCallback(
    (path: string, dirs: string[], deep: boolean) => {
      api
        .repoTree(path, dirs, deep)
        .then((tree) => {
          const listings = listingsOf(path);
          const expanded = expandedOf(path);
          let changed = false;
          for (const listing of tree.listings) {
            if (listing.error !== null) {
              if (listing.dir === "") {
                setError({ path, text: listing.error });
                continue;
              }
              // A folder deleted since it was opened. Forget it rather than
              // keep it open for a folder of the same name made next month.
              changed = listings.delete(listing.dir) || changed;
              expanded.delete(listing.dir);
              continue;
            }
            if (listing.dir === "") setError((was) => (was?.path === path ? null : was));
            if (!sameEntries(listings.get(listing.dir), listing.entries)) {
              listings.set(listing.dir, listing.entries);
              changed = true;
            }
            if (deep && listing.dir !== "" && !expanded.has(listing.dir)) {
              expanded.add(listing.dir);
              changed = true;
            }
          }
          if (tree.truncated) {
            onNote(
              `Opened the first 5000 rows under ${dirs[0] || "the root"}. The folders past that stay closed.`,
            );
          }
          if (changed) bump();
        })
        .catch((err) => setError({ path, text: String(err) }));
    },
    [bump, expandedOf, listingsOf, onNote],
  );

  // `changes` is a new array every time the changes column is read, which is
  // the signal this rides on.
  useEffect(() => {
    if (!active || !repoPath) return;
    read(repoPath, ["", ...expandedOf(repoPath)], false);
  }, [active, repoPath, changes, attempt, read, expandedOf]);

  const toggle = useCallback(
    (dir: string, deep: boolean) => {
      if (!repoPath) return;
      const expanded = expandedOf(repoPath);
      if (expanded.has(dir)) {
        // A plain close leaves the folders inside it open, so opening it
        // again puts back what was there. Ctrl+click closes those too.
        if (deep) expandedBy.current.set(repoPath, closeUnder(expanded, dir));
        else expanded.delete(dir);
        bump();
        return;
      }
      expanded.add(dir);
      bump();
      read(repoPath, [dir], deep);
    },
    [repoPath, expandedOf, bump, read],
  );

  const collapseAll = useCallback(() => {
    if (!repoPath) return;
    expandedBy.current.set(repoPath, new Set());
    bump();
  }, [repoPath, bump]);

  const rows = useMemo(
    () => (repoPath ? flatten(listingsOf(repoPath), expandedOf(repoPath)) : []),
    // `version` is how a change to the maps in the refs reaches this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoPath, version, listingsOf, expandedOf],
  );
  const overlay = useMemo(() => marks(changes), [changes]);

  return {
    rows,
    marks: overlay,
    ready: repoPath ? listingsOf(repoPath).has("") : false,
    error: error && error.path === repoPath ? error.text : null,
    retry: () => setAttempt((n) => n + 1),
    toggle,
    collapseAll,
  };
}

function sameEntries(was: TreeEntry[] | undefined, next: TreeEntry[]): boolean {
  if (!was || was.length !== next.length) return false;
  return was.every(
    (entry, i) =>
      entry.path === next[i].path && entry.dir === next[i].dir && entry.ignored === next[i].ignored,
  );
}
