import type { ReactNode } from "react";

/**
 * The one sentence a pane says when it has no rows to show, in three voices.
 *
 * `empty` is a fact: nothing is there. `loading` is a promise: a read is in
 * flight. `error` is neither, and it used to wear the empty voice, so a diff
 * that failed to read looked like a diff with nothing in it. In a tool whose
 * whole job is to say what needs attention, a failure is the loudest thing a
 * pane can hold, so it gets its own colour, a live-region role, and a way to
 * ask again.
 */
interface Props {
  kind?: "empty" | "loading" | "error";
  /** Error only: draws Try again, which re-runs the read that failed. */
  onRetry?: () => void;
  children: ReactNode;
}

export default function PaneNote({ kind = "empty", onRetry, children }: Props) {
  if (kind === "error") {
    return (
      <div className="pane-note error" role="alert">
        <p className="pane-note-title">Could not read this.</p>
        <p className="pane-note-detail">{children}</p>
        {onRetry && (
          <button className="btn tiny" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (kind === "loading") {
    return (
      <p className="empty loading" role="status" aria-busy="true">
        {children}
      </p>
    );
  }
  return <p className="empty">{children}</p>;
}
