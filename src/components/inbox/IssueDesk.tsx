import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../lib/api";
import { issueCommentCommand, type ShellKind } from "../../lib/shell";
import { relativeTime, type InboxItem, type IssueDetail } from "../../lib/types";

/**
 * The desk under an issue row: the body, the labels, and the tail of the
 * thread, read when the row opens rather than in the sweep. The one thing it
 * writes is a comment, and that gets typed the way a new issue does.
 */
export function IssueDesk({
  item,
  shell,
  onCommand,
  onError,
}: {
  item: InboxItem;
  shell: ShellKind;
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  onError: (message: string) => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  // Read again when the sweep says the issue moved, which is how a comment
  // typed a moment ago shows up in the thread once the shell's block settles.
  useEffect(() => {
    let stale = false;
    setError(null);
    api
      .githubIssue(item.ownerRepo, item.number)
      .then((next) => {
        if (!stale) setDetail(next);
      })
      .catch((err) => {
        if (!stale) setError(String(err));
      });
    return () => {
      stale = true;
    };
  }, [item.ownerRepo, item.number, item.updatedAt]);

  const ready = comment.trim().length > 0 && !busy;
  const preview = issueCommentCommand(
    item.number,
    comment.trim() || "…",
    comment.includes("\n") ? "…\\comment.md" : null,
    shell,
  );

  async function post(typeOnly: boolean) {
    if (!ready) return;
    setBusy(true);
    try {
      const file = comment.includes("\n")
        ? await api.githubIssueBody(item.ownerRepo, `comment-${item.number}`, comment)
        : null;
      onCommand(item.repoPath, issueCommentCommand(item.number, comment.trim(), file, shell), typeOnly);
      setComment("");
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const when = (iso: string) => relativeTime(Math.floor(Date.parse(iso) / 1000));
  const left = detail ? detail.commentCount - detail.comments.length : 0;

  return (
    <div className="inbox-desk">
      {error && <p className="inbox-when">Could not read the issue: {error}</p>}
      {!error && !detail && <p className="inbox-when">Reading…</p>}

      {detail && (
        <>
          <div className="inbox-desk-line">
            <span className="inbox-when">
              {detail.author || "someone"} opened this {when(detail.createdAt)}
            </span>
            {detail.assignees.length > 0 && (
              <span className="inbox-when">assigned to {detail.assignees.join(", ")}</span>
            )}
            {detail.labels.map((label) => (
              <span
                key={label.name}
                className="inbox-label"
                style={{ "--label": `#${label.color}` } as CSSProperties}
              >
                {label.name}
              </span>
            ))}
          </div>

          {detail.body.trim() ? (
            <div className="inbox-body">{detail.body}</div>
          ) : (
            <p className="inbox-when">No description.</p>
          )}

          {detail.comments.length > 0 && (
            <ul className="inbox-thread">
              {left > 0 && (
                <li className="inbox-when">
                  {left} earlier {left === 1 ? "comment is" : "comments are"} on GitHub.
                </li>
              )}
              {detail.comments.map((entry) => (
                <li key={entry.url} className="inbox-comment">
                  <div className="inbox-comment-head">
                    <span className="inbox-comment-author">{entry.author || "someone"}</span>
                    <span className="inbox-when">{when(entry.createdAt)}</span>
                  </div>
                  <div className="inbox-body">{entry.body}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <textarea
        className="inbox-reply"
        value={comment}
        spellCheck
        placeholder="Comment. Markdown, the same as the box on GitHub."
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            post(event.shiftKey);
          }
        }}
      />
      <div className="inbox-desk-actions">
        <span className="inbox-when">
          Ctrl+Enter comments. Hold shift to type it without running it.
        </span>
        <button
          className="btn tiny"
          title={`gh issue close ${item.number}\n\nTyped into ${item.repoName}'s shell.`}
          onClick={(event) => onCommand(item.repoPath, `gh issue close ${item.number}`, event.shiftKey)}
        >
          Close issue
        </button>
        <button
          className="btn tiny accent"
          disabled={!ready}
          title={`${preview}\n\nTyped into ${item.repoName}'s shell. Shift-click to type it without running it.`}
          onClick={(event) => post(event.shiftKey)}
        >
          {busy ? "Writing…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
