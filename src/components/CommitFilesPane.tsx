import type { CommitDiff, CommitTarget, FileChange } from "../lib/types";

interface Props {
  target: CommitTarget;
  /** Null while the read is in flight. */
  commit: CommitDiff | null;
  /** The file whose hunks the main column is showing. */
  file: string | null;
  onPick: (file: string) => void;
  onClose: () => void;
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
export default function CommitFilesPane({ target, commit, file, onPick, onClose }: Props) {
  const files = commit?.files ?? [];
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
    </aside>
  );
}
