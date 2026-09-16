import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { issueCreateCommand, type ShellKind } from "../../lib/shell";
import type { RepoState } from "../../lib/types";

/**
 * The form that opens an issue.
 *
 * The inbox reads GitHub out of sight because a fleet-wide read has nowhere to
 * type. Opening an issue is aimed at one repository, so it has a prompt and it
 * uses it: this builds a `gh issue create` and hands it to that repository's
 * shell. The only part that does not fit on a line is the body, because a
 * newline at a prompt submits the command, so a body with paragraphs in it goes
 * out to a file under GitView's data folder and the line carries `--body-file`.
 */
export function NewIssue({
  repos,
  selectedPath,
  shell,
  onCommand,
  onCancel,
  onError,
}: {
  repos: RepoState[];
  selectedPath: string | null;
  shell: ShellKind;
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const targets = useMemo(
    () =>
      repos
        .filter((repo) => repo.ownerRepo)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [repos],
  );

  const [path, setPath] = useState(
    () => targets.find((repo) => repo.path === selectedPath)?.path ?? targets[0]?.path ?? "",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const target = targets.find((repo) => repo.path === path) ?? null;
  const ownerRepo = target?.ownerRepo ?? "";
  const ready = Boolean(target) && title.trim().length > 0 && !busy;

  // What the line will look like, minus the body file, which does not exist
  // until the button is pressed. Close enough to read before pressing it.
  const preview = target
    ? issueCreateCommand(
        ownerRepo,
        title.trim() || "…",
        body,
        body.includes("\n") ? "…\\body.md" : null,
        shell,
      )
    : "";

  /**
   * `typeOnly` is the app's shift-click convention, and it matters more here
   * than anywhere else it appears: this is the one control in GitView that
   * writes something other people will read. Holding shift leaves the line at
   * the prompt so the title and the body file can be looked at before Enter.
   */
  async function create(typeOnly: boolean) {
    if (!ready || !target?.ownerRepo) return;
    setBusy(true);
    try {
      const file = body.includes("\n")
        ? await api.githubIssueBody(target.ownerRepo, title.trim(), body)
        : null;
      onCommand(
        target.path,
        issueCreateCommand(target.ownerRepo, title.trim(), body, file, shell),
        typeOnly,
      );
      // The line is at the prompt, and what GitHub answers lands in the
      // scrollback. The form has nothing left to say, so it goes.
      onCancel();
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  }

  if (targets.length === 0) {
    return (
      <div className="inbox-notice">
        <p>
          None of the watched repositories has a GitHub remote this can resolve, so there is
          nowhere to open an issue.
        </p>
        <div className="inbox-compose-actions">
          <span className="inbox-when" />
          <button type="button" className="btn" onClick={onCancel}>
            Back to the list
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="inbox-compose"
      onSubmit={(event) => {
        // Enter in the title field. The controls that can carry a modifier
        // call `create` themselves with it.
        event.preventDefault();
        create(false);
      }}
    >
      <label className="inbox-field">
        <span>Repository</span>
        <select value={path} onChange={(event) => setPath(event.target.value)}>
          {targets.map((repo) => (
            <option key={repo.path} value={repo.path}>
              {repo.ownerRepo}
            </option>
          ))}
        </select>
      </label>

      <label className="inbox-field">
        <span>Title</span>
        <input
          className="text-input"
          autoFocus
          value={title}
          placeholder="What is wrong, in one line"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="inbox-field">
        <span>Body</span>
        <textarea
          value={body}
          spellCheck
          placeholder="Markdown, the same as the box on GitHub. Optional."
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl+Enter submits. Enter alone stays a newline: a body is worth
            // writing, and the commit box already works this way.
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              create(event.shiftKey);
            }
          }}
        />
      </label>

      <pre className="inbox-command" title={preview}>
        {preview}
      </pre>

      <div className="inbox-compose-actions">
        <span className="inbox-when">
          It gets typed at {target?.name ?? "the repository"}&apos;s prompt, so what GitHub answers
          lands in the scrollback. Hold shift to type it without running it.
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn accent"
          disabled={!ready}
          title={
            preview
              ? `${preview}\n\nShift-click to type it without running it.`
              : "Pick a repository and write a title."
          }
          onClick={(event) => create(event.shiftKey)}
        >
          {busy ? "Writing the body…" : "Create issue"}
        </button>
      </div>
    </form>
  );
}
