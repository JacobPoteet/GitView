import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { CommitDiff, CommitTarget, FileDiff } from "../lib/types";
import { quote, type ShellKind } from "../lib/shell";
import DiffHunks from "./DiffHunks";

interface Props {
  target: CommitTarget;
  /** Null while the read is in flight. App owns it, because the column on the right draws its files. */
  commit: CommitDiff | null;
  /** The file whose hunks to show, picked in that column. */
  file: string | null;
  /** No live shell means the `show` button has nowhere to type. */
  disabled: boolean;
  shell: ShellKind;
  onClose: () => void;
  onCommand: (command: string, typeOnly: boolean) => void;
}

/**
 * One commit, over the main column: its message, then the hunks of the file
 * picked in the right-hand column, which lists the commit's files while this
 * pane is up.
 *
 * Until this pane existed a click on a commit typed `git show --stat` at the
 * prompt, which printed a file list and left the diff another command away.
 * Reading is a lookup and a lookup should leave nothing in the scrollback, so
 * the click opens this and types nothing. The command is still one Shift-click
 * away on the row, and the `show` button here names it for the file on screen.
 *
 * The rows are `DiffHunks`, the same component the working-tree pane draws,
 * without the stage button: a hunk in a commit is already in one.
 */
export default function CommitPane({
  target,
  commit,
  file,
  disabled,
  shell,
  onClose,
  onCommand,
}: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setFailure(null);
    if (!file) return;
    let cancelled = false;
    api
      .repoCommitFile(target.repoPath, target.id, file)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((err) => {
        if (!cancelled) setFailure(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [target.repoPath, target.id, file]);

  const show = file
    ? `git --no-pager show ${target.short} -- ${quote(file, shell)}`
    : `git --no-pager show --stat ${target.short}`;

  return (
    <section className="diff-pane commit-pane">
      <div className="pane-tab-bar">
        <span>commit</span>
        <span className="commit-short">{target.short}</span>
        <span className="tab-path" title={file ?? ""}>
          <bdi>{file ?? ""}</bdi>
        </span>

        {diff && !diff.empty && !diff.binary && !diff.error && (
          <span className="diff-tally" title="This file">
            <span className="add">+{diff.additions}</span>
            <span className="del">−{diff.deletions}</span>
          </span>
        )}

        <button
          className="diff-stage"
          disabled={disabled}
          onClick={(event) => onCommand(show, event.shiftKey)}
          title={
            disabled
              ? "No shell open for this repository."
              : `${show}\n\nShift-click to type it without running it.`
          }
        >
          show
        </button>
        <button className="pane-close" onClick={onClose} title="Close (Escape)" aria-label="Close">
          ✕
        </button>
      </div>

      {commit?.error && <p className="empty">{commit.error}</p>}

      {commit && !commit.error && (
        <div className="commit-head">
          <div className="commit-summary">{commit.summary || "(no message)"}</div>
          {commit.body && <pre className="commit-body">{commit.body}</pre>}
          <div className="commit-meta">
            <span>{commit.author}</span>
            <span>{new Date(commit.time * 1000).toLocaleString()}</span>
            <span className="diff-tally" title="Over the whole commit">
              <span className="add">+{commit.additions}</span>
              <span className="del">−{commit.deletions}</span>
            </span>
            {commit.parents.length === 0 && <span>root commit</span>}
            {commit.parents.map((parent, index) => (
              <span
                key={parent}
                title={
                  index === 0
                    ? "The diff is against this parent."
                    : "Not diffed against. git show -m would."
                }
              >
                {commit.parents.length > 1 ? `parent ${index + 1}` : "parent"} {parent}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="diff-body">
        {!commit && <p className="empty">Reading…</p>}
        {commit && !commit.error && !file && commit.files.length === 0 && (
          <p className="empty">This commit changed no files.</p>
        )}
        {file && !diff && !failure && <p className="empty">Reading…</p>}
        {failure && <p className="empty">{failure}</p>}
        {diff && (
          <DiffHunks diff={diff} restCommand={show} emptyNote="This file is not in the commit." />
        )}
      </div>
    </section>
  );
}
