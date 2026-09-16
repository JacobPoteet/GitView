import { useEffect } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import { api } from "../lib/api";
import { openFileCommand, quote, type ShellKind } from "../lib/shell";
import type { CommitDiff, CommitFile, CommitTarget, FileChange } from "../lib/types";

interface Props {
  target: CommitTarget;
  /** Null while the read is in flight. */
  commit: CommitDiff | null;
  /** The file whose hunks the main column is showing. */
  file: string | null;
  /** No live shell means Open has nowhere to type. */
  disabled: boolean;
  shell: ShellKind;
  onPick: (file: string) => void;
  onCommand: (command: string, typeOnly: boolean) => void;
  onCopy: (text: string, what: string) => void;
  /** The status bar, for a write that failed. */
  onNote: (text: string) => void;
  onClose: () => void;
  /** Opens the history filtered to this path. */
  onFileHistory: (file: string) => void;
}

/** One letter per state, the same letters the working tree's rows use. */
const MARK: Record<FileChange["state"], string> = {
  new: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflicted: "U",
};

/**
 * The right-hand column while a commit is open: the files that commit touched,
 * in place of the working tree.
 *
 * The list sat inside the commit pane at first, over the hunks, and took a
 * third of the main column from the diff on any commit past a handful of
 * files. The column on the right already is a file list with a lit row for the
 * file the main column is showing, so the commit borrows it. The working tree
 * comes back when the pane closes.
 *
 * Rows here open and never stage: the same `.change-row` and mark as the
 * working tree, without the verb, plus the file's own counts.
 */
export default function CommitFilesPane({
  target,
  commit,
  file,
  disabled,
  shell,
  onPick,
  onCommand,
  onCopy,
  onNote,
  onClose,
  onFileHistory,
}: Props) {
  const files = commit?.files ?? [];
  const menu = useContextMenu<CommitFile>();

  useEffect(() => {
    menu.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  /**
   * The row's menu. Open is the commit's copy of the file, not the working
   * tree's: the blob goes out under GitView's data folder and `Invoke-Item`
   * on that path gets typed, so the line at the prompt says which version.
   * The path is not known until the file is written, so the tooltip names the
   * shape of the command rather than the line itself.
   */
  function rowMenu(entry: CommitFile): MenuEntry[] {
    const deleted = entry.status === "deleted";
    return [
      {
        label: "Open",
        title: deleted
          ? "Deleted in this commit, so there is nothing to open."
          : `Invoke-Item on this file as ${target.short} had it, written under GitView's data folder.`,
        disabled: disabled || deleted,
        run: (typeOnly) => {
          api
            .commitFileExport(target.repoPath, target.id, entry.path)
            .then((path) => onCommand(openFileCommand(path, shell), typeOnly))
            .catch((err) => onNote(String(err)));
        },
      },
      {
        label: "History of this file",
        title: `git log -- ${quote(entry.path, shell)}, as the history pane's path: filter`,
        run: () => onFileHistory(entry.path),
      },
      { label: "Copy path", run: () => onCopy(entry.path, "the path") },
    ];
  }
  return (
    <aside className="changes-pane commit-files-pane">
      <div className="pane-tab-bar">
        <span>commit</span>
        <span style={{ color: "var(--line-strong)" }}>·</span>
        <span>{target.short}</span>
        {files.length > 0 && (
          <>
            <span style={{ color: "var(--line-strong)" }}>·</span>
            <span>
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
          </>
        )}
        <button
          className="pane-close"
          onClick={onClose}
          title="Back to the working tree (Escape)"
          aria-label="Back to the working tree"
        >
          ✕
        </button>
      </div>

      <div className="change-list">
        {!commit && <p className="empty">Reading…</p>}
        {commit?.error && <p className="empty">{commit.error}</p>}
        {commit && !commit.error && files.length === 0 && (
          <p className="empty">This commit changed no files.</p>
        )}
        {files.map((entry) => {
          const slash = entry.path.lastIndexOf("/");
          const dir = slash === -1 ? "" : entry.path.slice(0, slash + 1);
          const name = slash === -1 ? entry.path : entry.path.slice(slash + 1);
          return (
            <div
              key={entry.path}
              className={`change-row${entry.path === file ? " open" : ""}`}
              onContextMenu={(event) => menu.open(event, entry)}
            >
              <button
                className="change-open"
                onClick={() => onPick(entry.path)}
                title={entry.oldPath ? `${entry.path}\nrenamed from ${entry.oldPath}` : entry.path}
              >
                <span className={`change-mark ${entry.status}`}>{MARK[entry.status]}</span>
                <span className="change-path">
                  {dir && (
                    <span className="dir">
                      <bdi>{dir}</bdi>
                    </span>
                  )}
                  <span className="file">{name}</span>
                </span>
              </button>
              {entry.binary ? (
                <span className="commit-file-binary">binary</span>
              ) : (
                <span className="diff-tally commit-file-tally">
                  <span className="add">+{entry.additions}</span>
                  <span className="del">−{entry.deletions}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.path} at ${target.short}`}
          entries={rowMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </aside>
  );
}
