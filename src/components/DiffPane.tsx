import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DiffTarget, FileDiff } from "../lib/types";
import { quote, type ShellKind } from "../lib/shell";

interface Props {
  target: DiffTarget;
  /** Which sides of this file the working tree has, so only real tabs are drawn. */
  sides: { staged: boolean; unstaged: boolean };
  /** No live shell means the stage button has nowhere to type. */
  disabled: boolean;
  shell: ShellKind;
  /**
   * Changes identity, which the app replaces every time it re-reads the working
   * tree. The diff is re-read on the same signal, so a `git add` typed at the
   * prompt updates the pane without it polling for one.
   */
  reloadKey: unknown;
  onSide: (staged: boolean) => void;
  onClose: () => void;
  onCommand: (command: string, typeOnly: boolean) => void;
  /** Where a refused patch goes. The status bar, like every other refusal. */
  onError: (message: string) => void;
}

/**
 * One file, unified, over the main column.
 *
 * An overlay rather than a fourth grid region, for the reason the inbox is one:
 * the grid is full at 296 + 1fr + 300, and an overlay leaves the terminal at
 * its own size so the shell behind it keeps running at the width it had.
 *
 * Unified rather than side by side. 300 px of chrome either side of a 1fr
 * column does not leave two columns of code wide enough to read, and a unified
 * hunk is what `git diff` prints, which is the format this app is trying to
 * stay legible against rather than replace.
 */

/**
 * `@@ -1,7 +1,9 @@ fn read_file(...)`. The range is machine text and the tail
 * is the enclosing function git found, which is the half worth reading, so the
 * two are drawn in different tones rather than as one grey line.
 */
function splitHeader(header: string): { range: string; context: string } {
  const close = header.indexOf("@@", 2);
  if (close === -1) return { range: header, context: "" };
  return {
    range: header.slice(0, close + 2),
    context: header.slice(close + 2).trim(),
  };
}

const TONE: Record<string, string> = {
  " ": "context",
  "+": "add",
  "-": "del",
  "\\": "note",
};

export default function DiffPane({
  target,
  sides,
  disabled,
  shell,
  reloadKey,
  onSide,
  onClose,
  onCommand,
  onError,
}: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [reading, setReading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReading(true);
    api
      .repoDiff(target.repoPath, target.file, target.staged)
      .then((next) => {
        if (cancelled) return;
        setDiff(next);
        setFailure(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setDiff(null);
        setFailure(String(err));
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.repoPath, target.file, target.staged, reloadKey]);

  const arg = quote(target.file, shell);
  const command = target.staged
    ? `git restore --staged -- ${arg}`
    : `git add -- ${arg}`;
  const verb = target.staged ? "unstage" : "stage";

  /**
   * One hunk, staged or unstaged.
   *
   * The only action in this app whose argument cannot be typed, because the
   * argument is the hunk. So the hunk becomes a file: the backend writes it out
   * as a patch under GitView's own data folder, and what gets typed at the
   * prompt is `git apply --cached` against that path. The command is readable,
   * re-runnable, and the file it names is still there afterwards.
   */
  async function applyHunk(index: number, header: string, typeOnly: boolean) {
    try {
      const patch = await api.diffHunkPatch(
        target.repoPath,
        target.file,
        target.staged,
        index,
        header,
      );
      const reverse = target.staged ? "--reverse " : "";
      onCommand(`git apply --cached ${reverse}${quote(patch, shell)}`, typeOnly);
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <section className="diff-pane">
      <div className="pane-tab-bar">
        <span>diff</span>
        <span className="tab-path" title={target.file}>
          <bdi>{target.file}</bdi>
        </span>

        {/* Both sides only when the file actually has both, which is the case
            git status reports as two rows: staged, then edited again. */}
        {sides.staged && sides.unstaged && (
          <span className="diff-sides">
            <button
              className={target.staged ? "" : "on"}
              onClick={() => onSide(false)}
              title="What is not staged yet: the index against the working tree"
            >
              unstaged
            </button>
            <button
              className={target.staged ? "on" : ""}
              onClick={() => onSide(true)}
              title="What this commit would contain: HEAD against the index"
            >
              staged
            </button>
          </span>
        )}

        {diff && !diff.empty && !diff.binary && (
          <span className="diff-tally">
            <span className="add">+{diff.additions}</span>
            <span className="del">−{diff.deletions}</span>
          </span>
        )}

        <button
          className="diff-stage"
          disabled={disabled}
          onClick={(event) => onCommand(command, event.shiftKey)}
          title={
            disabled
              ? "No shell open for this repository."
              : `${command}\n\nShift-click to type it without running it.`
          }
        >
          {verb}
        </button>
        <button className="pane-close" onClick={onClose} title="Close (Escape)">
          ✕
        </button>
      </div>

      <div className="diff-body">
        {reading && !diff && <p className="empty">Reading…</p>}
        {failure && <p className="empty">{failure}</p>}
        {diff?.error && <p className="empty">{diff.error}</p>}

        {diff && !diff.error && diff.binary && (
          <p className="empty">
            Binary. git has no text to show for this one.
          </p>
        )}

        {diff && !diff.error && !diff.binary && diff.empty && (
          <p className="empty">
            Nothing on the {target.staged ? "staged" : "unstaged"} side of this
            file.
          </p>
        )}

        {diff?.oldPath && (
          <p className="diff-rename">
            renamed from <bdi>{diff.oldPath}</bdi>
          </p>
        )}

        {/* One wrapper around every hunk, and it is what sets the scroll width.
            Per-hunk `min-width` gave each hunk its own, so scrolling right to
            read a 600-character line carried the short hunks off the left edge
            and out of the pane. */}
        <div className="diff-hunks">
          {diff?.hunks.map((hunk, index) => {
            const { range, context } = splitHeader(hunk.header);
            return (
              <div
                className="diff-hunk"
                key={`${hunk.oldStart}:${hunk.newStart}:${index}`}
              >
                <div className="diff-hunk-head">
                  {/* The band is as wide as the widest line in the file. This
                    span is what stays on screen when one is scrolled. */}
                  <span className="stick">
                    <span className="range">{range}</span>
                    {context && <span className="context">{context}</span>}
                  </span>
                  {/* Sticky to the other edge, so it is where the eye expects a
                    button however far the file has been scrolled sideways. */}
                  <button
                    className="hunk-apply"
                    disabled={disabled}
                    onClick={(event) =>
                      applyHunk(index, hunk.header, event.shiftKey)
                    }
                    title={
                      disabled
                        ? "No shell open for this repository."
                        : `git apply --cached ${target.staged ? "--reverse " : ""}<patch>

GitView writes this hunk out as a patch under its own data folder, never into
the repository, and types the command that applies it. The prompt shows the
path it wrote.
Shift-click to type it without running it.`
                    }
                  >
                    {verb} hunk
                  </button>
                </div>
                {hunk.lines.map((line, row) => (
                  <div
                    className={`diff-line ${TONE[line.origin] ?? "context"}`}
                    key={row}
                  >
                    <span className="ln">{line.old ?? ""}</span>
                    <span className="ln">{line.new ?? ""}</span>
                    <span className="sign">
                      {line.origin === "\\" ? "\\" : line.origin}
                    </span>
                    <span className="text">
                      {line.text}
                      {line.clipped && (
                        <span className="clipped"> … line clipped</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {diff?.truncated && (
          <p className="diff-note">
            Stopped after 6000 lines. <code>git diff -- {target.file}</code> in
            the shell has the rest.
          </p>
        )}
      </div>
    </section>
  );
}
