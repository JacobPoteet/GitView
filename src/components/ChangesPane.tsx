import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import { isUntracked, type DiffTarget, type FileChange, type RepoState } from "../lib/types";
import { commitCommand, openFileCommand, quote, type ShellKind } from "../lib/shell";

interface Props {
  repo: RepoState | null;
  changes: FileChange[];
  /** No live shell means nothing here has anywhere to run. */
  disabled: boolean;
  shell: ShellKind;
  /** The file the diff pane is showing, so its row reads as selected. */
  open: DiffTarget | null;
  onCommand: (command: string, typeOnly: boolean) => void;
  onOpenDiff: (file: string, staged: boolean) => void;
  /**
   * Throwing work away, which the pane asks for rather than does.
   *
   * Everything else here types its command and lets the shell answer for it.
   * This one cannot be taken back by reading the scrollback, so it goes through
   * the app's confirmation first, and the app owns that.
   *
   * `all` says the rows are the whole unstaged working tree, which is what the
   * command it builds then names instead of listing them.
   */
  onDiscard: (rows: FileChange[], all: boolean) => void;
  /** Copies, and says so in the status bar. `what` finishes "Copied …". */
  onCopy: (text: string, what: string) => void;
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

/**
 * What a right-click on a row offers.
 *
 * `null` when nothing is up. Held by the pane rather than by the row so only
 * one can be open, and positioned in viewport coordinates because the list
 * scrolls under it.
 */
function splitPath(path: string): { dir: string; file: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { dir: "", file: path }
    : { dir: path.slice(0, cut + 1), file: path.slice(cut + 1) };
}

/**
 * The row is two controls, not one.
 *
 * Reading a file and staging it are separate acts and always were. Until the
 * diff pane existed there was nowhere to read one, so the whole row typed
 * `git add` and the verb at the end was a label. Now the name opens the diff
 * and the verb is the button that types the command, which is the arrangement
 * the rest of the app already uses: the part you click to look at something,
 * and the part that names what it runs.
 */
function Row({
  change,
  open,
  disabled,
  shell,
  onCommand,
  onOpenDiff,
  onMenu,
}: {
  change: FileChange;
  open: boolean;
  disabled: boolean;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
  onOpenDiff: (file: string, staged: boolean) => void;
  onMenu: (event: ReactMouseEvent, change: FileChange) => void;
}) {
  const arg = quote(change.path, shell);
  // Unstaging is `restore --staged`, not `reset HEAD`, because it says what it
  // does and leaves the working tree alone either way.
  const command = change.staged ? `git restore --staged -- ${arg}` : `git add -- ${arg}`;
  const { dir, file } = splitPath(change.path);

  return (
    <div
      className={`change-row ${change.state}${open ? " open" : ""}`}
      onContextMenu={(event) => onMenu(event, change)}
    >
      <button
        className="change-open"
        onClick={() => onOpenDiff(change.path, change.staged)}
        title={`${change.path}\n\nOpen the diff`}
      >
        <span className={`change-mark ${change.state}`}>{MARK[change.state]}</span>
        <span className="change-path">
          {/* The folders truncate from the left, so the end of the path survives
              in a narrow column. That takes `direction: rtl`, which then
              reorders the trailing slash to the front and renders `src/lib/` as
              `/src/lib`. `bdi` isolates the run as its own left-to-right
              paragraph, which keeps the order while the outer span still clips
              at the start. */}
          {dir && (
            <span className="dir">
              <bdi>{dir}</bdi>
            </span>
          )}
          <span className="file">{file}</span>
        </span>
      </button>
      {/* A conflicted file has no single command that resolves it, so it keeps
          the diff and loses the verb rather than offering a button that lies. */}
      <button
        className="change-verb"
        disabled={disabled || change.state === "conflicted"}
        onClick={(event) => onCommand(command, event.shiftKey)}
        title={
          change.state === "conflicted"
            ? "Resolve this one in the shell first."
            : `${command}\nShift-click to type it without running it.`
        }
      >
        {change.state === "conflicted" ? "" : change.staged ? "unstage" : "stage"}
      </button>
    </div>
  );
}

function Section({
  label,
  rows,
  bulk,
  bulkLabel,
  open,
  disabled,
  shell,
  onCommand,
  onOpenDiff,
  onMenu,
  onDiscardAll,
}: {
  label: string;
  rows: FileChange[];
  bulk: string;
  bulkLabel: string;
  open: DiffTarget | null;
  disabled: boolean;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
  onOpenDiff: (file: string, staged: boolean) => void;
  onMenu: (event: ReactMouseEvent, change: FileChange) => void;
  /** Set on the one section whose rows can be thrown away outright. */
  onDiscardAll?: () => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="change-section">
      <div className="change-section-head">
        <span>{label}</span>
        <span className="count">{rows.length}</span>
        {onDiscardAll && (
          <button
            className="change-discard-all"
            disabled={disabled}
            onClick={onDiscardAll}
            title={`Throw away all ${rows.length} unstaged ${rows.length === 1 ? "change" : "changes"}`}
          >
            <TrashIcon />
          </button>
        )}
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
          open={open?.file === change.path && open.staged === change.staged}
          disabled={disabled}
          shell={shell}
          onCommand={onCommand}
          onOpenDiff={onOpenDiff}
          onMenu={onMenu}
        />
      ))}
    </div>
  );
}

/** GitKraken's affordance, and the one people go looking for. */
function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M6.8 7v4M9.2 7v4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ChangesPane({
  repo,
  changes,
  disabled,
  shell,
  open,
  onCommand,
  onOpenDiff,
  onDiscard,
  onCopy,
}: Props) {
  const [message, setMessage] = useState("");
  const menu = useContextMenu<FileChange>();

  // A message belongs to the repository it was written for. Carrying a draft to
  // the next project offers to commit one repository's words into another.
  useEffect(() => {
    setMessage("");
    menu.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  /**
   * The row's menu. The verb the row already shows, the diff, the path, and
   * the one action that has no button because it asks first.
   */
  function rowMenu(change: FileChange): MenuEntry[] {
    const arg = quote(change.path, shell);
    const verb = change.staged ? `git restore --staged -- ${arg}` : `git add -- ${arg}`;
    const conflicted = change.state === "conflicted";
    // The desktop's own handler for the file type, typed like everything else.
    const opener = openFileCommand(change.path, shell);
    const deleted = change.state === "deleted";
    return [
      {
        label: change.staged ? "Unstage" : "Stage",
        title: conflicted ? "Resolve this one in the shell first." : verb,
        disabled: disabled || conflicted,
        run: (typeOnly) => onCommand(verb, typeOnly),
      },
      { label: "Open diff", run: () => onOpenDiff(change.path, change.staged) },
      {
        label: "Open",
        title: deleted ? "Nothing on disk to open." : opener,
        disabled: disabled || deleted,
        run: (typeOnly) => onCommand(opener, typeOnly),
      },
      { label: "Copy path", run: () => onCopy(change.path, "the path") },
      "-",
      {
        label: "Discard changes",
        danger: true,
        disabled: disabled || change.staged || conflicted,
        title: change.staged
          ? "Unstage it first. Discarding staged work would throw away two decisions at once."
          : conflicted
            ? "Resolve this one in the shell first."
            : isUntracked(change)
              ? "git clean -f on this file. It is not in git, so nothing brings it back."
              : "git restore on this file, back to what the index holds.",
        run: () => onDiscard([change], false),
      },
    ];
  }

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
        <div className="pane-tab-bar">
          <span>changes</span>
        </div>
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
          open={open}
          disabled={disabled}
          shell={shell}
          onCommand={onCommand}
          onOpenDiff={onOpenDiff}
          onMenu={menu.open}
        />
        <Section
          label="Changed"
          rows={unstaged}
          bulk="git add -A"
          bulkLabel="stage all"
          open={open}
          disabled={disabled}
          shell={shell}
          onCommand={onCommand}
          onOpenDiff={onOpenDiff}
          onMenu={menu.open}
          /* Only this section. Staged work can be unstaged back into it before
             it is thrown away, and a conflict has no single command that ends
             it, so neither gets a control that would have to guess. */
          onDiscardAll={() => onDiscard(unstaged, true)}
        />
      </div>

      {/* Staged sits outside the scrolling list, directly above the commit box.
          It is the list the message is about, so the two belong together, and
          ordering it last inside the scroller would only put it near the box
          while the changed list happened to be short. */}
      {staged.length > 0 && (
        <div className="change-staged">
          <Section
            label="Staged"
            rows={staged}
            bulk="git restore --staged ."
            bulkLabel="unstage all"
            open={open}
            disabled={disabled}
            shell={shell}
            onCommand={onCommand}
            onOpenDiff={onOpenDiff}
            onMenu={menu.open}
          />
        </div>
      )}

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

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.path}`}
          entries={rowMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </aside>
  );
}
