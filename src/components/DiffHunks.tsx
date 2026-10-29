import type { ReactNode } from "react";
import PaneNote from "./PaneNote";
import ImageDiff, { type ImageSource } from "./ImageDiff";
import { ageBucket, relativeTime, type BlameHunk, type FileDiff } from "../lib/types";

/**
 * The rows of one file's diff: the gutters, the sign, the text, and the `@@`
 * band over each hunk. Shared by the working-tree pane, the commit pane and the file view,
 * which read different diffs and draw the same rows.
 *
 * The hunk band takes an optional action. The working-tree pane passes the
 * stage button; the commit pane passes nothing, because a hunk in a commit is
 * already in one.
 */
interface Props {
  diff: FileDiff;
  /** What to draw at the right of each `@@` band. Absent when there is nothing to do to a hunk. */
  hunkAction?: (index: number, header: string) => ReactNode;
  /** The command that has the rest, named when the read stopped at the cap. */
  restCommand: string;
  /** What to say when the file is on neither side. */
  emptyNote: string;
  /**
   * Who last wrote each line, keyed on the new-side line number. Present only
   * on a committed file with the gutter turned on: a `-` line has no new-side
   * number and gets no entry, since the line it was is not in the file.
   */
  blame?: Map<number, BlameHunk>;
  /** A sha in the gutter was clicked. */
  onBlameCommit?: (commit: { id: string; short: string }) => void;
  /** Where to read an image's bytes from. Only read when the file is one. */
  imageSource?: ImageSource;
  /**
   * The file view's reading of the rows: one hunk holding the whole file, so
   * no `@@` band, one line number, and no sign column. A `+` row is a line not
   * committed yet and gets a bar in the gutter rather than a green row; a `-`
   * row is not in the file, so it is not drawn, and the line after it carries
   * a rule where it was.
   */
  whole?: boolean;
}

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

export default function DiffHunks({
  diff,
  hunkAction,
  restCommand,
  emptyNote,
  blame,
  onBlameCommit,
  imageSource,
  whole = false,
}: Props) {
  // The gutter says the sha and the age once per run of lines from one
  // commit, on the first line of the run, and holds its tint for the rest:
  // a hunk of forty lines from one commit reads as one block, not forty
  // repeats of the same sha.
  let lastBlame: BlameHunk | undefined;
  return (
    <>
      {diff.error && <PaneNote kind="error">{diff.error}</PaneNote>}

      {!diff.error && diff.image && imageSource && (
        <ImageDiff diff={diff} source={imageSource} />
      )}

      {!diff.error && diff.binary && !(diff.image && imageSource) && (
        <p className="empty">Binary. git has no text to show for this one.</p>
      )}

      {!diff.error && !diff.binary && diff.empty && <p className="empty">{emptyNote}</p>}

      {/* Modified with no hunks: the line endings or the mode changed and
          not a line. `git diff` prints nothing for it either, and a blank
          pane looked like a read that never finished. */}
      {!diff.error && !diff.binary && !diff.empty && diff.hunks.length === 0 && !diff.image && (
        <p className="empty">
          No line differs. Line endings or the file mode changed, which
          <code> git diff</code> shows nothing for either.
        </p>
      )}

      {diff.oldPath && (
        <p className="diff-rename">
          renamed from <bdi>{diff.oldPath}</bdi>
        </p>
      )}

      {/* One wrapper around every hunk, and it is what sets the scroll width.
          Per-hunk `min-width` gave each hunk its own, so scrolling right to
          read a 600-character line carried the short hunks off the left edge
          and out of the pane. */}
      <div className={`diff-hunks${blame ? " blamed" : ""}${whole ? " whole" : ""}`}>
        {diff.hunks.map((hunk, index) => {
          lastBlame = undefined;
          const { range, context } = splitHeader(hunk.header);
          // In the whole file, the `-` rows before a drawn line become a rule
          // on that line, and a run at the very end goes on the last one.
          let gone = false;
          let lastDrawn = -1;
          for (let i = hunk.lines.length - 1; whole && i >= 0; i -= 1) {
            if (hunk.lines[i].origin === " " || hunk.lines[i].origin === "+") {
              lastDrawn = i;
              break;
            }
          }
          const goneAtEnd = whole && hunk.lines[hunk.lines.length - 1]?.origin === "-";
          return (
            <div className="diff-hunk" key={`${hunk.oldStart}:${hunk.newStart}:${index}`}>
              {!whole && (
                <div className="diff-hunk-head">
                  {/* The band is as wide as the widest line in the file. This
                      span is what stays on screen when one is scrolled. */}
                  <span className="stick">
                    <span className="range">{range}</span>
                    {context && <span className="context">{context}</span>}
                  </span>
                  {hunkAction?.(index, hunk.header)}
                </div>
              )}
              {hunk.lines.map((line, row) => {
                if (whole && line.origin !== " " && line.origin !== "+") {
                  if (line.origin === "-") gone = true;
                  return null;
                }
                const who = blame && line.new != null ? blame.get(line.new) : undefined;
                const first = who !== undefined && who !== lastBlame;
                if (who) lastBlame = who;
                const marks = whole
                  ? `${line.origin === "+" ? " fresh" : ""}${gone ? " gone-above" : ""}` +
                    (goneAtEnd && row === lastDrawn ? " gone-below" : "")
                  : "";
                gone = false;
                const tone = whole ? "context" : (TONE[line.origin] ?? "context");
                return (
                  <div className={`diff-line ${tone}${marks}`} key={row}>
                    {blame && (
                      <span
                        className={`blame${who ? ` age-${ageBucket(who.time)}` : ""}`}
                        title={
                          who && !who.id
                            ? "Not committed yet."
                            : who
                              ? `${who.short}  ${who.summary}\n${who.author}, ${relativeTime(who.time)}\n\nClick to open the commit.`
                              : undefined
                        }
                      >
                        {who && first && !who.id && <span className="blame-age">uncommitted</span>}
                        {who && first && who.id && (
                          <button
                            className="blame-sha"
                            onClick={() => onBlameCommit?.({ id: who.id, short: who.short })}
                          >
                            {who.short}
                          </button>
                        )}
                        {who && first && who.id && (
                          <span className="blame-age">{relativeTime(who.time)}</span>
                        )}
                      </span>
                    )}
                    {!whole && <span className="ln">{line.old ?? ""}</span>}
                    <span className="ln">{line.new ?? ""}</span>
                    {whole ? (
                      <span
                        className="mark"
                        title={line.origin === "+" ? "Not committed yet" : undefined}
                      />
                    ) : (
                      <span className="sign">{line.origin === "\\" ? "\\" : line.origin}</span>
                    )}
                    <span className="text">
                      {line.text}
                      {line.clipped && <span className="clipped"> … line clipped</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {diff.truncated && (
        <p className="diff-note">
          Stopped after 6000 lines. <code>{restCommand}</code> in the shell has the rest.
        </p>
      )}
    </>
  );
}
