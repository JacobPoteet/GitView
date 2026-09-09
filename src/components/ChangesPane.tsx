import { useEffect, useMemo, useState } from "react";
import type { FileChange, RepoState } from "../lib/types";
import { commitCommand, quote, type ShellKind } from "../lib/shell";

interface Props {
  repo: RepoState | null;
  changes: FileChange[];
  /** No live shell means nothing here has anywhere to run. */
  disabled: boolean;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
}

/**
 * Staged and unstaged work, and the commit that ends it.
 *
 * Every control types its command at the prompt rather than running it behind
 * the pane, the same as every other action in the app. Staging by clicking
 * therefore leaves a readable trail of `git add` in the shell, which is the
 * point: the pane accelerates the habit rather than replacing it.
 */

/** One letter per state, in git's own vocabulary. */
const MARK: Record<FileChange["state"], string> = {
  new: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflicted: "U",
};

function splitPath(path: string): { dir: string; file: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { dir: "", file: path }
    : { dir: path.slice(0, cut + 1), file: path.slice(cut + 1) };
}

function Row({
  change,
  disabled,
  shell,
  onCommand,
}: {
  change: FileChange;
  disabled: boolean;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
}) {
  const arg = quote(change.path, shell);
  // Unstaging is `restore --staged`, not `reset HEAD`, because it says what it
  // does and leaves the working tree alone either way.
  const command = change.staged ? `git restore --staged -- ${arg}` : `git add -- ${arg}`;
  const { dir, file } = splitPath(change.path);

  return (
    <button
      className={`change-row ${change.state}`}
      disabled={disabled || change.state === "conflicted"}
      onClick={(event) => onCommand(command, event.shiftKey)}
      title={
        change.state === "conflicted"
          ? `${change.path}\n\nResolve this one in the shell first.`
          : `${change.path}\n\n${command}\nShift-click to type it without running it.`
      }
    >
      <span className={`change-mark ${change.state}`}>{MARK[change.state]}</span>
      <span className="change-path">
        {/* The folders truncate from the left, so the end of the path survives
            in a narrow column. That takes `direction: rtl`, which then reorders
            the trailing slash to the front and renders `src/lib/` as `/src/lib`.
            `bdi` isolates the run as its own left-to-right paragraph, which
            keeps the order while the outer span still clips at the start. */}
        {dir && (
          <span className="dir">
            <bdi>{dir}</bdi>
          </span>
        )}
        <span className="file">{file}</span>
      </span>
      <span className="change-verb">{change.staged ? "unstage" : "stage"}</span>
    </button>
  );
}

function Section({
  label,
  rows,
  bulk,
  bulkLabel,
  disabled,
  shell,
  onCommand,
}: {
  label: string;
  rows: FileChange[];
  bulk: string;
  bulkLabel: string;
  disabled: boolean;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="change-section">
      <div className="change-section-head">
        <span>{label}</span>
        <span className="count">{rows.length}</span>
        <button
          className="change-bulk"
          disabled={disabled}
          onClick={(event) => onCommand(bulk, event.shiftKey)}
          title={`${bulk}\n\nShift-click to type it without running it.`}
        >
          {bulkLabel}
        </button>
      </div>
      {rows.map((change) => (
        <Row
          key={`${change.staged ? "s" : "w"}:${change.path}`}
          change={change}
          disabled={disabled}
          shell={shell}
          onCommand={onCommand}
        />
      ))}
    </div>
  );
}

export default function ChangesPane({ repo, changes, disabled, shell, onCommand }: Props) {
  const [message, setMessage] = useState("");

  // A message belongs to the repository it was written for. Carrying a draft to
  // the next project offers to commit one repository's words into another.
  useEffect(() => {
    setMessage("");
  }, [repo?.path]);

  const { staged, unstaged, conflicted } = useMemo(() => {
    return {
      staged: changes.filter((c) => c.staged),
      unstaged: changes.filter((c) => !c.staged && c.state !== "conflicted"),
      conflicted: changes.filter((c) => c.state === "conflicted"),
    };
  }, [changes]);

  if (!repo) {
    return (
      <aside className="changes-pane">
        <div className="pane-tab-bar">changes</div>
        <p className="empty">Pick a repository to see its working tree.</p>
      </aside>
    );
  }

  const command = message.trim() ? commitCommand(message, shell) : "";
  // git refuses an empty commit anyway, and a message with nothing staged is the
  // mistake worth catching before it reaches the prompt.
  const ready = staged.length > 0 && message.trim().length > 0 && !disabled;

  function commit() {
    if (!ready) return;
    onCommand(command, false);
    setMessage("");
  }

  return (
    <aside className="changes-pane">
      <div className="pane-tab-bar">
        <span>changes</span>
        {changes.length > 0 && (
          <span style={{ color: "var(--line-strong)" }}>·</span>
        )}
        {changes.length > 0 && <span>{changes.length}</span>}
      </div>

      <div className="change-list">
        {changes.length === 0 && <p className="empty">Nothing to commit.</p>}

        <Section
          label="Conflicted"
          rows={conflicted}
          bulk="git status"
          bulkLabel="status"
          disabled={disabled}
          shell={shell}
          onCommand={onCommand}
        />
        <Section
          label="Staged"
          rows={staged}
          bulk="git restore --staged ."
          bulkLabel="unstage all"
          disabled={disabled}
          shell={shell}
          onCommand={onCommand}
        />
        <Section
          label="Changed"
          rows={unstaged}
          bulk="git add -A"
          bulkLabel="stage all"
          disabled={disabled}
          shell={shell}
          onCommand={onCommand}
        />
      </div>

      <div className="commit-box">
        <textarea
          value={message}
          spellCheck
          placeholder={
            staged.length > 0 ? "Commit message" : "Stage something first"
          }
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(event) => {
            // Ctrl+Enter commits. Enter alone stays a newline, because a body is
            // worth writing and a stray return should not commit.
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <div className="commit-actions">
          <span className="commit-hint" title={command}>
            <bdi>{command || "git commit"}</bdi>
          </span>
          <button
            className="btn accent"
            disabled={!ready}
            onClick={commit}
            title={
              ready
                ? `${command}\n\nCtrl+Enter does the same.`
                : disabled
                  ? "No shell open for this repository."
                  : staged.length === 0
                    ? "Nothing staged."
                    : "Write a message."
            }
          >
            Commit {staged.length > 0 && `(${staged.length})`}
          </button>
        </div>
      </div>
    </aside>
  );
}
