import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { prCreateCommand, type ShellKind } from "../../lib/shell";
import { suggestedTitle } from "../../lib/inbox";
import type { RepoState } from "../../lib/types";

/**
 * The form that opens a pull request.
 *
 * The same shape as the issue form, with the branch the shell is standing on
 * as the head and the repository's default branch as the base. The line has
 * no `--head`: gh reads it from the shell's branch, which is also what lets it
 * offer to push a branch that is not on origin yet, at the prompt, where that
 * question belongs.
 */
export function NewPullRequest({
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
        .filter((repo) => repo.ownerRepo && repo.branch)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [repos],
  );

  const [path, setPath] = useState(
    () => targets.find((repo) => repo.path === selectedPath)?.path ?? targets[0]?.path ?? "",
  );
  const target = targets.find((repo) => repo.path === path) ?? null;

  // The base and the title follow the repository, since both come from it:
  // the default branch, and the one commit the branch holds when it holds one.
  const [base, setBase] = useState(() => target?.defaultBranch ?? "main");
  const [title, setTitle] = useState(() => suggestedTitle(target));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const choose = (next: string) => {
    setPath(next);
    const repo = targets.find((candidate) => candidate.path === next) ?? null;
    setBase(repo?.defaultBranch ?? "main");
    setTitle(suggestedTitle(repo));
  };

  const onBase = target !== null && target.branch === base.trim();
  const ready = Boolean(target) && !onBase && title.trim().length > 0 && base.trim().length > 0 && !busy;

  const preview = target
    ? prCreateCommand(
        base.trim() || "…",
        title.trim() || "…",
        body,
        body.includes("\n") ? "…\\body.md" : null,
        shell,
      )
    : "";

  async function create(typeOnly: boolean) {
    if (!ready || !target?.ownerRepo) return;
    setBusy(true);
    try {
      const file = body.includes("\n")
        ? await api.githubIssueBody(target.ownerRepo, title.trim(), body)
        : null;
      onCommand(
        target.path,
        prCreateCommand(base.trim(), title.trim(), body, file, shell),
        typeOnly,
      );
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
          None of the watched repositories has a GitHub remote and a branch, so there is nowhere
          to open a pull request from.
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
        event.preventDefault();
        create(false);
      }}
    >
      <label className="inbox-field">
        <span>Repository</span>
        <select value={path} onChange={(event) => choose(event.target.value)}>
          {targets.map((repo) => (
            <option key={repo.path} value={repo.path}>
              {repo.ownerRepo}
            </option>
          ))}
        </select>
      </label>

      <div className="inbox-field-row">
        <label className="inbox-field">
          <span>From</span>
          <input className="text-input" readOnly value={target?.branch ?? ""} />
        </label>
        <label className="inbox-field">
          <span>Into</span>
          <input
            className="text-input"
            value={base}
            onChange={(event) => setBase(event.target.value)}
          />
        </label>
      </div>

      {target && onBase && (
        <p className="inbox-field-note warn">
          The shell is standing on {target.branch}, which is the base. Check out the branch with the
          work on it first.
        </p>
      )}
      {target && !onBase && target.upstream === null && (
        <p className="inbox-field-note">
          {target.branch} has not been pushed. gh asks where to push it, at the prompt, before it
          opens anything.
        </p>
      )}
      {target && !onBase && target.upstream !== null && target.ahead > 0 && (
        <p className="inbox-field-note warn">
          {target.ahead} {target.ahead === 1 ? "commit" : "commits"} on {target.branch} not pushed
          yet. The pull request opens without {target.ahead === 1 ? "it" : "them"} until you push.
        </p>
      )}

      <label className="inbox-field">
        <span>Title</span>
        <input
          className="text-input"
          autoFocus
          value={title}
          placeholder="What it does, in one line"
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
          {busy ? "Writing the body…" : "Open pull request"}
        </button>
      </div>
    </form>
  );
}
