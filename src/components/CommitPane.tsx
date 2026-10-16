import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Blame, BlameHunk, CommitTarget, FileDiff } from "../lib/types";
import { quote, type ShellKind } from "../lib/shell";
import DiffHunks from "./DiffHunks";
import PaneNote from "./PaneNote";
import CloseButton from "./CloseButton";

interface Props {
  target: CommitTarget;
  /** The file whose hunks to show, picked in the column on the right. */
  file: string;
  /** No live shell means the `show` button has nowhere to type. */
  disabled: boolean;
  shell: ShellKind;
  /** Closes the diff and leaves the commit up in the column on the right. */
  onClose: () => void;
  onCommand: (command: string, typeOnly: boolean) => void;
  /** A sha in the blame gutter was clicked: open that commit in this pane, on the same file. */
  onOpenCommit: (commit: { id: string; short: string; file?: string }) => void;
}

/**
 * One file of a commit, over the main column: its hunks, and nothing else.
 *
 * The message, the author and the file list are in the right-hand column
 * (`CommitFilesPane`), where a click on another commit replaces them without
 * this pane being up. This pane exists only while a file is picked there, so a
 * commit on its own never covers the graph or the shell.
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
  file,
  disabled,
  shell,
  onClose,
  onCommand,
  onOpenCommit,
}: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /**
   * The blame gutter: off until asked, and asked once per file. The choice
   * outlives the file so a reader walking a commit's files keeps it. No blame
   * on the working-tree diff, which has no pane for it: an uncommitted line
   * has no author yet, and the question blame answers is about lines that do.
   */
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<Blame | null>(null);
  useEffect(() => {
    setBlame(null);
    if (!blameOn) return;
    let cancelled = false;
    api
      .repoBlame(target.repoPath, target.id, file)
      .then((next) => {
        if (!cancelled) setBlame(next);
      })
      .catch((err) => {
        if (!cancelled) setBlame({ hunks: [], truncated: false, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [blameOn, target.repoPath, target.id, file]);
  // One entry per line, from the hunks. Spread once here rather than searched
  // per row while drawing six thousand of them.
  const blameLines = useMemo(() => {
    if (!blame || blame.error) return undefined;
    const map = new Map<number, BlameHunk>();
    for (const hunk of blame.hunks) {
      for (let n = 0; n < hunk.lines; n += 1) map.set(hunk.start + n, hunk);
    }
    return map;
  }, [blame]);

  useEffect(() => {
    setDiff(null);
    setFailure(null);
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
  }, [target.repoPath, target.id, file, attempt]);

  const show = `git --no-pager show ${target.short} -- ${quote(file, shell)}`;

  return (
    <section className="diff-pane commit-pane">
      <div className="pane-tab-bar">
        <span>Commit</span>
        <span className="commit-short">{target.short}</span>
        <span className="tab-path" title={file}>
          <bdi>{file}</bdi>
        </span>

        {diff &&
          !diff.empty &&
          !diff.binary &&
          !diff.error &&
          (!diff.image || diff.additions + diff.deletions > 0) && (
          <span className="diff-tally" title="This file">
            <span className="add">+{diff.additions}</span>
            <span className="del">−{diff.deletions}</span>
          </span>
        )}

        <button
          className="btn tiny"
          onClick={() => setBlameOn((on) => !on)}
          title={
            blameOn
              ? "Hide who last touched each line."
              : `Who last touched each line, as of ${target.short}. git blame ${target.short} -- ${file}, read in process.`
          }
          aria-pressed={blameOn}
        >
          blame
        </button>
        <button
          className="btn tiny accent"
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
        <CloseButton onClick={onClose} />
      </div>

      <div className="diff-body">
        {!diff && !failure && <PaneNote kind="loading">Reading…</PaneNote>}
        {failure && (
          <PaneNote kind="error" onRetry={() => setAttempt((n) => n + 1)}>
            {failure}
          </PaneNote>
        )}
        {blame?.error && <p className="diff-note">Blame failed: {blame.error}</p>}
        {blame?.truncated && (
          <p className="diff-note">
            The gutter stops at line 6000. <code>git blame {target.short} -- {file}</code> in
            the shell has the rest.
          </p>
        )}
        {diff && (
          <DiffHunks
            diff={diff}
            imageSource={{ repoPath: target.repoPath, staged: false, sha: target.id }}
            restCommand={show}
            emptyNote="This file is not in the commit."
            blame={blameOn ? blameLines : undefined}
            onBlameCommit={(commit) => onOpenCommit({ ...commit, file })}
          />
        )}
      </div>
    </section>
  );
}
