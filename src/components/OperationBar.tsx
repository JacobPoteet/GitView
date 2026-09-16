import { operationCommands } from "../lib/shell";
import { operationTitle, type Operation } from "../lib/types";

interface Props {
  operation: Operation;
  /** Conflicted files in the working tree, which is usually why it paused. */
  conflicted: number;
  /** No live shell means nothing here has anywhere to run. */
  disabled: boolean;
  onCommand: (command: string, typeOnly: boolean) => void;
  /**
   * The one that gives up asks first, and the app owns the dialog. Everything
   * else here is a step git can be walked back from; an abort throws away
   * whatever conflict resolution is sitting in the working tree.
   */
  onAbort: (command: string) => void;
}

/**
 * The strip that says git is paused, and what in.
 *
 * A rebase stopped on a conflict is the state a person most needs a client
 * for: with the conflict resolved and `git add` typed, the prompt shows a
 * detached HEAD and nothing else, and the next command is the one git printed
 * under `hint:` forty lines up. This strip keeps that hint on screen for as
 * long as the state lasts. Under the header rather than in it, and never
 * hidden by a pane, since the state outranks whatever the pane is showing.
 *
 * Each button names its command and shift-click types it without running it,
 * the same as everywhere else. There is no conflict resolver: the diff pane
 * opens a conflicted file and the shell is where it gets resolved.
 */
export default function OperationBar({
  operation,
  conflicted,
  disabled,
  onCommand,
  onAbort,
}: Props) {
  const title = operationTitle(operation);
  const detail =
    conflicted > 0
      ? `${conflicted} ${conflicted === 1 ? "file is" : "files are"} conflicted. Resolve and stage them, then Continue.`
      : operation.kind === "bisect"
        ? "Test this commit, then say which it is."
        : "Nothing is conflicted. Continue picks up where it stopped.";

  return (
    <div className="operation-bar" role="status">
      <span className="operation-mark" aria-hidden>
        ⟳
      </span>
      <span className="operation-text">
        <strong>{title}.</strong> {detail}
      </span>
      <span className="operation-actions">
        {operationCommands(operation.kind).map((entry) => (
          <button
            key={entry.command}
            className={`btn${entry.abort ? " danger" : ""}`}
            disabled={disabled}
            title={
              disabled
                ? "Waiting for the shell"
                : entry.abort
                  ? `${entry.command}\n\nAsks first: it throws away anything resolved so far.`
                  : `${entry.command}\n\nShift-click to type it without running it.`
            }
            onClick={(event) =>
              entry.abort && !event.shiftKey
                ? onAbort(entry.command)
                : onCommand(entry.command, event.shiftKey)
            }
          >
            {entry.label}
          </button>
        ))}
      </span>
    </div>
  );
}
