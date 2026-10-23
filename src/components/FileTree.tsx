import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import PaneNote from "./PaneNote";
import { MARK } from "./ChangesPane";
import type { FileTree as Tree } from "../hooks/useFileTree";
import { parentOf, sideFor, type TreeEntry } from "../lib/tree";
import { openFileCommand, quote, type ShellKind } from "../lib/shell";
import type { FileChange, RepoState } from "../lib/types";

interface Props {
  repo: RepoState;
  tree: Tree;
  changes: FileChange[];
  /** The file the diff pane is showing, lit the way its changes row is. */
  openFile: string | null;
  /** The shell is not at a prompt yet, so nothing that types can run. */
  disabled: boolean;
  shell: ShellKind;
  onBack: () => void;
  onOpenDiff: (file: string, staged: boolean) => void;
  onFileHistory: (path: string) => void;
  onCommand: (command: string, typeOnly: boolean) => void;
  onCopy: (text: string, what: string) => void;
}

/**
 * The rail's project mode: one repository's folders, where the fleet was.
 *
 * GitView is not an editor, so a file here is something to ask git about. A
 * changed file opens its diff, the way its row in the changes column does, and
 * any other file or folder opens the history filtered to its path. Opening the
 * file itself is on the right-click menu, typed as `Invoke-Item` like the
 * changes column's Open.
 *
 * There is no `cd` here on purpose. Every command GitView types names its
 * paths from the repository's root, so a prompt standing anywhere else would
 * make the next `git add` from the changes column miss.
 */
export default function FileTree({
  repo,
  tree,
  changes,
  openFile,
  disabled,
  shell,
  onBack,
  onOpenDiff,
  onFileHistory,
  onCommand,
  onCopy,
}: Props) {
  const menu = useContextMenu<TreeEntry>();

  function activate(entry: TreeEntry, deep: boolean) {
    if (entry.dir) {
      tree.toggle(entry.path, deep);
      return;
    }
    const staged = sideFor(changes, entry.path);
    if (staged === null) onFileHistory(entry.path);
    else onOpenDiff(entry.path, staged);
  }

  function entryMenu(entry: TreeEntry): MenuEntry[] {
    const arg = quote(entry.path, shell);
    const opener = openFileCommand(entry.path, shell);
    const copy: MenuEntry = { label: "Copy path", run: () => onCopy(entry.path, "the path") };
    if (entry.dir) {
      const open = tree.rows.some((r) => r.entry.path === entry.path && r.open);
      return [
        {
          label: open ? "Close every folder inside" : "Open every folder inside",
          title: "Ctrl+click on the folder does the same. Ignored folders stay closed.",
          run: () => tree.toggle(entry.path, true),
        },
        {
          label: "History of this folder",
          title: `git log -- ${arg}, as the history pane's path: filter`,
          run: () => onFileHistory(entry.path),
        },
        {
          label: "Open folder",
          title: opener,
          disabled,
          run: (typeOnly) => onCommand(opener, typeOnly),
        },
        copy,
      ];
    }
    const staged = sideFor(changes, entry.path);
    return [
      ...(staged !== null
        ? [{ label: "Open diff", run: () => onOpenDiff(entry.path, staged) }]
        : []),
      {
        label: "History of this file",
        title: `git log -- ${arg}, as the history pane's path: filter`,
        run: () => onFileHistory(entry.path),
      },
      {
        label: "Open",
        title: opener,
        disabled,
        run: (typeOnly) => onCommand(opener, typeOnly),
      },
      copy,
    ];
  }

  /**
   * The arrow keys, the way a tree takes them: up and down walk the rows,
   * right opens a folder, left closes it or steps out to its parent. `*`
   * opens everything under a folder, which is what it does in Explorer.
   */
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const path = target.dataset.path;
    if (path === undefined) return;
    const row = tree.rows.find((r) => r.entry.path === path);
    if (!row) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-path]")];
    const at = items.indexOf(target);
    const focus = (el: HTMLElement | undefined) => {
      if (!el) return;
      event.preventDefault();
      el.focus();
    };
    if (event.key === "ArrowDown") focus(items[at + 1]);
    else if (event.key === "ArrowUp") focus(items[at - 1]);
    else if (event.key === "ArrowRight" && row.entry.dir) {
      event.preventDefault();
      if (!row.open) tree.toggle(path, false);
      else focus(items[at + 1]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.open) tree.toggle(path, false);
      else focus(items.find((el) => el.dataset.path === parentOf(path)));
    } else if (event.key === "*" && row.entry.dir && !row.open) {
      event.preventDefault();
      tree.toggle(path, true);
    }
  }

  return (
    <aside className="sidebar files">
      <div className="sidebar-head">
        <button
          className="icon-btn"
          onClick={onBack}
          title="Back to every repository (Ctrl+Shift+E, or Escape)"
          aria-label="Back to every repository"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M10 3.5 5.5 8l4.5 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="brand files-name" title={repo.path}>
          {repo.name}
        </span>
        <button
          className="icon-btn"
          onClick={tree.collapseAll}
          title="Close every folder"
          aria-label="Close every folder"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M4.5 6.5 8 3l3.5 3.5M4.5 13 8 9.5l3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div
        className="tree-list"
        role="tree"
        // The rows are buttons and take the focus themselves; this lets a
        // click on the list's empty space land somewhere the arrows work.
        tabIndex={-1}
        aria-label={`Files in ${repo.name}`}
        onKeyDown={onKeyDown}
      >
        {tree.error ? (
          <PaneNote kind="error" onRetry={tree.retry}>
            Could not read the folder: {tree.error}
          </PaneNote>
        ) : !tree.ready ? (
          <PaneNote kind="loading">Reading the folder</PaneNote>
        ) : tree.rows.length === 0 ? (
          <PaneNote>Nothing in this folder yet.</PaneNote>
        ) : (
          tree.rows.map(({ entry, depth, open }) => {
            const mark = entry.dir ? tree.marks.dirs.get(entry.path) : tree.marks.files.get(entry.path);
            return (
              <button
                key={entry.path}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={entry.dir ? open : undefined}
                aria-selected={!entry.dir && entry.path === openFile}
                data-path={entry.path}
                className={
                  `tree-row${entry.dir ? " dir" : ""}${entry.ignored ? " ignored" : ""}` +
                  (!entry.dir && entry.path === openFile ? " open" : "")
                }
                style={{ "--depth": depth } as CSSProperties}
                onClick={(event) => activate(entry, event.ctrlKey || event.metaKey)}
                onContextMenu={(event) => menu.open(event, entry)}
                title={rowTitle(entry, mark !== undefined)}
              >
                <span className="tree-twisty" aria-hidden>
                  {entry.dir && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path
                        d="M3.5 2 6.5 5 3.5 8"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span className="tree-name">{entry.name}</span>
                {mark && (
                  <span className={`change-mark ${mark}`}>{entry.dir ? "•" : MARK[mark]}</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.name}`}
          entries={entryMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </aside>
  );
}

function rowTitle(entry: TreeEntry, changed: boolean): string {
  const ignored = entry.ignored ? "\nIgnored by .gitignore" : "";
  if (entry.dir) {
    return `${entry.path}${ignored}\n\nCtrl+click opens or closes every folder inside`;
  }
  const does = changed ? "Open the diff" : `History of this file: git log -- ${entry.path}`;
  return `${entry.path}${ignored}\n\n${does}`;
}
