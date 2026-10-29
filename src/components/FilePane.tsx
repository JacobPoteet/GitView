import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Blame, BlameHunk, FileDiff, FileTarget } from "../lib/types";
import { openFileCommand, quote, type ShellKind } from "../lib/shell";
import DiffHunks from "./DiffHunks";
import PaneNote from "./PaneNote";
import CloseButton from "./CloseButton";

interface Props {
  target: FileTarget;
  /**
   * The side of the index the changes column would open this file's diff on,
   * or null when it has nothing uncommitted. The Diff button follows it.
   */
  diffSide: boolean | null;
  /** No live shell means Open has nowhere to type. */
  disabled: boolean;
  shell: ShellKind;
  /** Replaced whenever the working tree is re-read, which is when the file can have changed. */
  reloadKey: unknown;
  onOpenDiff: (staged: boolean) => void;
  onFileHistory: () => void;
  /** A sha in the blame gutter was clicked: open that commit on this file. */
  onOpenCommit: (commit: { id: string; short: string; file?: string }) => void;
  onClose: () => void;
  onCommand: (command: string, typeOnly: boolean) => void;
}

/**
 * One file as it is on disk, read-only, over the main column. What a click on
 * a file in the tree opens.
 *
 * GitView is still not an editor: nothing here types into the file, and Open
 * hands it to whatever the machine opens that kind of file in. The rows are
 * `DiffHunks` reading one hunk that holds the whole file, so the line numbers,
 * the 6000-line cap, images and the blame gutter are the diff pane's own. A
 * line not committed yet has a green bar in the gutter, and the history and
 * the diff are a button each.
 */
export default function FilePane({
  target,
  diffSide,
  disabled,
  shell,
  reloadKey,
  onOpenDiff,
  onFileHistory,
  onOpenCommit,
  onClose,
  onCommand,
}: Props) {
  const [file, setFile] = useState<FileDiff | null>(null);
  const [reading, setReading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReading(true);
    api
      .repoFile(target.repoPath, target.file)
      .then((next) => {
        if (cancelled) return;
        setFile(next);
        setFailure(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setFile(null);
        setFailure(String(err));
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.repoPath, target.file, reloadKey, attempt]);

  // A file read for one path must not draw under another's header while the
  // next read is in flight.
  const shown = file && file.path === target.file ? file : null;

  /**
   * The blame gutter, off until asked, like the commit pane's. The choice
   * outlives the file so walking the tree keeps it, and it is read again with
   * the file, since an edit moves the lines it numbers.
   */
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<Blame | null>(null);
  useEffect(() => {
    setBlame(null);
    if (!blameOn) return;
    let cancelled = false;
    api
      .repoBlameWorktree(target.repoPath, target.file)
      .then((next) => {
        if (!cancelled) setBlame(next);
      })
      .catch((err) => {
        if (!cancelled) setBlame({ hunks: [], truncated: false, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [blameOn, target.repoPath, target.file, reloadKey]);
  const blameLines = useMemo(() => {
    if (!blame || blame.error) return undefined;
    const map = new Map<number, BlameHunk>();
    for (const hunk of blame.hunks) {
      for (let n = 0; n < hunk.lines; n += 1) map.set(hunk.start + n, hunk);
    }
    return map;
  }, [blame]);

  const open = openFileCommand(target.file, shell);
  const changed = shown !== null && shown.status !== "unchanged";
  const text = shown !== null && !shown.binary && !shown.error;
  const lines = shown?.hunks[0]?.lines.length ?? 0;

  return (
    <section className="diff-pane file-pane">
      <div className="pane-tab-bar">
        <span>File</span>
        <span className="tab-path" title={target.file}>
          <bdi>{target.file}</bdi>
        </span>

        {changed && text && shown.additions + shown.deletions > 0 && (
          <span className="diff-tally" title="Not committed yet, staged or not, against HEAD">
            <span className="add">+{shown.additions}</span>
            <span className="del">−{shown.deletions}</span>
          </span>
        )}

        {diffSide !== null && (
          <button
            className="btn tiny"
            onClick={() => onOpenDiff(diffSide)}
            title={`The ${diffSide ? "staged" : "unstaged"} diff, as the changes column opens it`}
          >
            diff
          </button>
        )}
        {text && (
          <button
            className="btn tiny"
            onClick={() => setBlameOn((on) => !on)}
            title={
              blameOn
                ? "Hide who last touched each line."
                : `Who last touched each line, as the file is on disk. git blame -- ${target.file}, read in process.`
            }
            aria-pressed={blameOn}
          >
            blame
          </button>
        )}
        <button
          className="btn tiny"
          onClick={onFileHistory}
          title={`git log -- ${target.file}, as the history pane's path: filter`}
        >
          History
        </button>
        <button
          className="btn tiny accent"
          disabled={disabled}
          onClick={(event) => onCommand(open, event.shiftKey)}
          title={
            disabled
              ? "No shell open for this repository."
              : `${open}\n\nShift-click to type it without running it.`
          }
        >
          Open
        </button>
        <CloseButton onClick={onClose} />
      </div>

      <div className="diff-body">
        {reading && !shown && !failure && <PaneNote kind="loading">Reading…</PaneNote>}
        {failure && (
          <PaneNote kind="error" onRetry={() => setAttempt((n) => n + 1)}>
            {failure}
          </PaneNote>
        )}
        {blameOn && blame?.error && <p className="diff-note">Blame failed: {blame.error}</p>}
        {blameOn && blame?.truncated && (
          <p className="diff-note">
            The gutter stops at line 6000. <code>git blame -- {target.file}</code> in the shell
            has the rest.
          </p>
        )}
        {shown && text && lines === 0 && !shown.image && <p className="empty">Empty file.</p>}
        {shown && (
          <DiffHunks
            diff={shown}
            whole
            imageSource={{ repoPath: target.repoPath, staged: false, sha: null }}
            restCommand={`${shell === "powershell" ? "Get-Content" : "cat"} ${quote(target.file, shell)}`}
            emptyNote="This file is not on disk."
            blame={blameOn ? blameLines : undefined}
            onBlameCommit={(commit) => onOpenCommit({ ...commit, file: target.file })}
          />
        )}
      </div>
    </section>
  );
}
