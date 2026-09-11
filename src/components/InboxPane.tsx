import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  issueCreateCommand,
  mergeCommand,
  openUrlCommand,
  prCreateCommand,
  rerunCommand,
  type ShellKind,
} from "../lib/shell";
import {
  relativeTime,
  type CheckRun,
  type GhStatus,
  type Inbox,
  type InboxItem,
  type MergeMethod,
  type RepoState,
} from "../lib/types";

interface Props {
  inbox: Inbox | null;
  gh: GhStatus | null;
  /** The fleet, for the repository picker on the new-issue form. */
  repos: RepoState[];
  /** What the picker starts on, when that repository has a GitHub remote. */
  selectedPath: string | null;
  shell: ShellKind;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
  /** Selects the repository an item belongs to and closes the pane. */
  onSelect: (path: string) => void;
  /** Types a command into that repository's shell, the way every action does. */
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  /**
   * Merging asks first, the way discarding does: it is remote, and it deletes
   * a branch. The pane hands the dialog its title, what it is about to do and
   * the command, and the app owns the dialog.
   */
  onMerge: (item: InboxItem, method: MergeMethod, command: string) => void;
  onCopy: (text: string) => void;
  /** Where a refused write of the issue body goes. The status bar. */
  onError: (message: string) => void;
  /**
   * A row to open the desk under when the pane opens: the header's `PR #n`
   * button brings you here for that pull request, so it arrives expanded.
   */
  openKey: string | null;
}

/**
 * Groups, in the order they want something from you.
 *
 * The fleet list answers which repositories need attention. This answers what
 * needs a reply, which is a different question about the same eleven folders,
 * so it borrows the same group-label idiom rather than inventing one.
 */
interface Group {
  key: string;
  label: string;
  hint?: string;
  items: InboxItem[];
}

/** Which question the groups are answering. */
type Mode = "need" | "repo";

const MODE_KEY = "gitview.inbox.mode";
const COLLAPSED_KEY = "gitview.inbox.collapsed";

/** The three colours a check can be. Skipped and cancelled read as neither passed nor failed. */
function checkTone(state: InboxItem["checks"] | CheckRun["state"]): "ok" | "bad" | "pending" | "off" {
  if (state === "SUCCESS") return "ok";
  if (state === "FAILURE" || state === "ERROR") return "bad";
  if (state === "SKIPPED" || state === "CANCELLED") return "off";
  return "pending";
}

const CHECK_GLYPH = { ok: "✓", bad: "✕", pending: "•", off: "–" } as const;

function CheckMark({ state }: { state: InboxItem["checks"] }) {
  if (!state) return null;
  const tone = checkTone(state);
  return (
    <span className={`inbox-checks ${tone}`} title={`checks: ${state.toLowerCase()}`}>
      {CHECK_GLYPH[tone]}
    </span>
  );
}

const METHOD_KEY = "gitview.inbox.mergeMethod";

/** The merge method last picked for this repository, if the repository still allows it. */
function storedMethod(item: InboxItem): MergeMethod {
  let picked: string | null = null;
  try {
    picked = localStorage.getItem(`${METHOD_KEY}:${item.ownerRepo}`);
  } catch {
    picked = null;
  }
  if (picked && item.mergeMethods.includes(picked as MergeMethod)) return picked as MergeMethod;
  return item.mergeMethods[0] ?? "squash";
}

/**
 * Why the Merge button is off, in the words the dialog on GitHub would use.
 * Null when it is on. `UNSTABLE` is a failing check that is not required, and
 * `UNKNOWN` is GitHub still computing the merge: both leave the button on and
 * let the scrollback say what GitHub decided.
 */
function mergeBlock(item: InboxItem): string | null {
  if (item.draft) return "A draft. Mark it ready first.";
  if (item.mergeable === "CONFLICTING" || item.mergeState === "DIRTY")
    return `Conflicts with ${item.baseRef ?? "the base branch"}. Resolve them on the branch and push.`;
  if (item.mergeState === "BLOCKED")
    return "Blocked by branch protection: a required review or check is missing.";
  if (item.mergeState === "BEHIND")
    return `Behind ${item.baseRef ?? "the base branch"}, and the branch protection wants it brought up to date first.`;
  if (item.mergeMethods.length === 0) return "The repository allows no merge method the token can use.";
  return null;
}

/**
 * The desk under a pull request row: its checks by name, whether GitHub would
 * let it merge, and the button that merges it. Everything here is the page on
 * GitHub with the browser left closed, and everything it does gets typed.
 */
function Desk({
  item,
  shell,
  onCommand,
  onMerge,
}: {
  item: InboxItem;
  shell: ShellKind;
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  onMerge: (item: InboxItem, method: MergeMethod, command: string) => void;
}) {
  const [method, setMethod] = useState<MergeMethod>(() => storedMethod(item));

  const pick = (next: MergeMethod) => {
    setMethod(next);
    try {
      localStorage.setItem(`${METHOD_KEY}:${item.ownerRepo}`, next);
    } catch {
      // A private window. The choice lasts the session.
    }
  };

  const block = mergeBlock(item);
  const command = mergeCommand(item.number, method, !item.deleteBranchOnMerge);
  const passed = item.checkRuns.filter((run) => run.state === "SUCCESS").length;
  const counted = item.checkRuns.filter((run) => checkTone(run.state) !== "off").length;

  // One button per run, not per job: `--failed` re-runs every failed job in
  // the run, so a matrix with three red cells is one command.
  const failedRuns = [
    ...new Set(
      item.checkRuns
        .filter((run) => run.state === "FAILURE" && run.runId !== null)
        .map((run) => run.runId as number),
    ),
  ];

  const typed = (command: string) => `${command}

Typed into ${item.repoName}'s shell.`;

  return (
    <div className="inbox-desk">
      <div className="inbox-desk-line">
        <span className="inbox-desk-refs">
          <bdi>{item.headRef}</bdi> → <bdi>{item.baseRef ?? "?"}</bdi>
        </span>
        <span className="inbox-desk-size">
          <span className="add">+{item.additions}</span> <span className="del">−{item.deletions}</span>
          {" in "}
          {item.changedFiles} {item.changedFiles === 1 ? "file" : "files"}
        </span>
        {item.mergeState === "CLEAN" && <span className="inbox-badge approved">mergeable</span>}
        {item.mergeState === "UNSTABLE" && (
          <span className="inbox-badge changes">mergeable, checks failing</span>
        )}
      </div>

      {item.checkRuns.length > 0 ? (
        <ul className="inbox-checklist">
          {item.checkRuns.map((run, index) => {
            const tone = checkTone(run.state);
            return (
              <li key={`${run.name}${index}`} className={`inbox-check ${tone}`}>
                <span className={`inbox-checks ${tone}`}>{CHECK_GLYPH[tone]}</span>
                {run.url ? (
                  <button
                    className="inbox-check-name link"
                    title={typed(openUrlCommand(run.url, shell))}
                    onClick={() => onCommand(item.repoPath, openUrlCommand(run.url as string, shell))}
                  >
                    {run.name}
                  </button>
                ) : (
                  <span className="inbox-check-name">{run.name}</span>
                )}
                <span className="inbox-when">{run.state.toLowerCase()}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="inbox-when">No checks on the head commit.</p>
      )}

      <div className="inbox-desk-actions">
        <span className="inbox-when">
          {item.checkRuns.length > 0 && `${passed} of ${counted} passed`}
          {block && (
            <>
              {item.checkRuns.length > 0 && " · "}
              {block}
            </>
          )}
        </span>

        {failedRuns.map((runId) => (
          <button
            key={runId}
            className="btn tiny"
            title={typed(rerunCommand(runId))}
            onClick={(event) => onCommand(item.repoPath, rerunCommand(runId), event.shiftKey)}
          >
            Re-run failed
          </button>
        ))}

        {item.draft && (
          <button
            className="btn tiny"
            title={typed(`gh pr ready ${item.number}`)}
            onClick={(event) => onCommand(item.repoPath, `gh pr ready ${item.number}`, event.shiftKey)}
          >
            Mark ready
          </button>
        )}

        {item.mergeState === "BEHIND" && (
          <button
            className="btn tiny"
            title={typed(`gh pr update-branch ${item.number}`)}
            onClick={(event) =>
              onCommand(item.repoPath, `gh pr update-branch ${item.number}`, event.shiftKey)
            }
          >
            Update branch
          </button>
        )}

        {item.mergeMethods.length > 1 && (
          <select
            className="inbox-method"
            value={method}
            title="How the branch lands on the base. Squash is one commit per pull request, which is how this history reads."
            onChange={(event) => pick(event.target.value as MergeMethod)}
          >
            {item.mergeMethods.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}

        <button
          className="btn tiny accent"
          disabled={block !== null}
          title={block ?? `${command}

Asks first, then types it into ${item.repoName}'s shell.`}
          onClick={() => onMerge(item, method, command)}
        >
          {item.deleteBranchOnMerge ? "Merge" : "Merge & delete branch"}
        </button>
      </div>
    </div>
  );
}

function ReviewBadge({ item }: { item: InboxItem }) {
  if (item.kind !== "pr") return null;
  if (item.draft) return <span className="inbox-badge draft">draft</span>;
  if (item.reviewDecision === "APPROVED")
    return <span className="inbox-badge approved">approved</span>;
  if (item.reviewDecision === "CHANGES_REQUESTED")
    return <span className="inbox-badge changes">changes requested</span>;
  if (item.reviewRequested) return <span className="inbox-badge review">your review</span>;
  return null;
}

/**
 * The one-line reason a row is in the list, when the list is not already
 * grouped by it.
 *
 * Grouping by repository answers "what is going on in this project" and loses
 * "what wants me", which is what the inbox is for. The badge puts it back on
 * the row rather than making the two questions exclusive.
 */
function NeedBadge({ item }: { item: InboxItem }) {
  if (item.kind === "pr" && item.reviewRequested)
    return <span className="inbox-badge review">your review</span>;
  if (item.kind === "pr" && item.mine && (item.checks === "FAILURE" || item.checks === "ERROR"))
    return <span className="inbox-badge changes">checks failing</span>;
  if (item.kind === "issue" && item.assigned)
    return <span className="inbox-badge review">assigned</span>;
  return null;
}

function Row({
  item,
  showNeed,
  open,
  shell,
  onToggle,
  onSelect,
  onCommand,
  onMerge,
  onCopy,
}: {
  item: InboxItem;
  /** Set in repo mode, where nothing above the row says why it is here. */
  showNeed: boolean;
  /** The desk is showing under this row. PRs only. */
  open: boolean;
  shell: ShellKind;
  onToggle: () => void;
  onSelect: (path: string) => void;
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  onMerge: (item: InboxItem, method: MergeMethod, command: string) => void;
  onCopy: (text: string) => void;
}) {
  // Every action names the command it runs, so an inbox row types `gh` the way
  // a sidebar row types `git`. Nothing here writes to GitHub out of sight.
  const view = item.kind === "pr" ? `gh pr view ${item.number} --web` : `gh issue view ${item.number} --web`;
  const checkout = `gh pr checkout ${item.number}`;

  return (
    <div className={`inbox-row${open ? " open" : ""}`}>
      {item.kind === "pr" ? (
        <button
          className="inbox-expand"
          onClick={onToggle}
          title={open ? "Hide the checks" : "Checks, mergeability, and the merge button"}
        >
          {open ? "▾" : "▸"}
        </button>
      ) : (
        <span className="inbox-expand" />
      )}
      <button
        className="inbox-main"
        onClick={() => onSelect(item.repoPath)}
        title={`${item.repoPath}\n\nOpens ${item.repoName}`}
      >
        <span className="inbox-line">
          <span className={`inbox-kind ${item.kind}`}>
            {item.kind === "pr" ? "PR" : "issue"}
          </span>
          <span className="inbox-number">#{item.number}</span>
          <span className="inbox-title">{item.title}</span>
        </span>
        <span className="inbox-meta">
          <span className="inbox-repo">{item.repoName}</span>
          {showNeed ? <NeedBadge item={item} /> : <ReviewBadge item={item} />}
          <CheckMark state={item.checks} />
          <span className="inbox-when">
            {item.author && `${item.author} · `}
            {relativeTime(Math.floor(new Date(item.updatedAt).getTime() / 1000))}
          </span>
        </span>
      </button>

      <span className="inbox-actions">
        {item.kind === "pr" && (
          <button
            className="btn tiny"
            title={`${checkout}\n\nTyped into ${item.repoName}'s shell.`}
            onClick={() => onCommand(item.repoPath, checkout)}
          >
            Check out
          </button>
        )}
        <button
          className="btn tiny"
          title={`${view}\n\nTyped into ${item.repoName}'s shell.`}
          onClick={() => onCommand(item.repoPath, view)}
        >
          Open
        </button>
        <button className="btn tiny" title="The URL, for pasting" onClick={() => onCopy(item.url)}>
          Copy link
        </button>
      </span>

      {open && item.kind === "pr" && (
        <Desk item={item} shell={shell} onCommand={onCommand} onMerge={onMerge} />
      )}
    </div>
  );
}

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
function NewIssue({
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

/**
 * The form that opens a pull request.
 *
 * The same shape as the issue form, with the branch the shell is standing on
 * as the head and the repository's default branch as the base. The line has
 * no `--head`: gh reads it from the shell's branch, which is also what lets it
 * offer to push a branch that is not on origin yet, at the prompt, where that
 * question belongs.
 */
function NewPullRequest({
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

/**
 * A branch holding one commit is a pull request with that commit's subject
 * for a title, which is what `gh pr create --fill` would pick. More than one
 * and nothing is guessed.
 */
function suggestedTitle(repo: RepoState | null): string {
  if (!repo || repo.aheadOfDefault !== 1) return "";
  return repo.lastCommitSummary ?? "";
}

export default function InboxPane({
  inbox,
  gh,
  repos,
  selectedPath,
  shell,
  refreshing,
  onRefresh,
  onClose,
  onSelect,
  onCommand,
  onMerge,
  onCopy,
  onError,
  openKey,
}: Props) {
  // By repo to start with. A fleet's inbox is mostly one repository's backlog
  // at a time, and reading it in project order is what somebody opening it asks
  // for; the need groups are one click away and the choice sticks.
  const [mode, setMode] = useState<Mode>(
    () => (localStorage.getItem(MODE_KEY) === "need" ? "need" : "repo"),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [composing, setComposing] = useState<"issue" | "pr" | null>(null);
  // Which desks are showing. Not persisted: a desk is opened to act on a pull
  // request, and the next time the pane opens the question is a new one.
  const [open, setOpen] = useState<Set<string>>(() => new Set(openKey ? [openKey] : []));

  useEffect(() => {
    if (openKey) setOpen((current) => (current.has(openKey) ? current : new Set(current).add(openKey)));
  }, [openKey]);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  const groups = useMemo<Group[]>(() => {
    const items = inbox?.items ?? [];
    if (mode === "repo") return byRepo(items);
    return byNeed(items);
  }, [inbox, mode]);

  const missing = !gh?.version || !gh.loggedIn;

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="inbox-pane">
      <div className="pane-tab-bar">
        <span>inbox</span>
        {inbox && !inbox.error && (
          <span className="inbox-when">
            read {relativeTime(inbox.fetchedAt)}
            {inbox.viewer && ` as ${inbox.viewer}`}
          </span>
        )}
        <span className="spacer" />

        {/* Two questions about the same list. "What wants me" is what an inbox
            is for; "what is going on in this project" is what you want once
            more than one of them does. Neither is a subset of the other, so the
            pane answers whichever was asked last. */}
        <span className="inbox-modes">
          <button
            className={mode === "need" ? "on" : ""}
            onClick={() => setMode("need")}
            title="Grouped by what each row wants from you"
          >
            by need
          </button>
          <button
            className={mode === "repo" ? "on" : ""}
            onClick={() => setMode("repo")}
            title="Grouped by repository, newest activity first"
          >
            by repo
          </button>
        </span>

        <button
          className="btn tiny"
          disabled={missing || composing !== null}
          onClick={() => setComposing("pr")}
          title="gh pr create, typed into that repository's shell"
        >
          New pull request
        </button>
        <button
          className="btn tiny"
          disabled={missing || composing !== null}
          onClick={() => setComposing("issue")}
          title="gh issue create, typed into that repository's shell"
        >
          New issue
        </button>
        <button className="btn tiny" disabled={refreshing || missing} onClick={onRefresh}>
          {refreshing ? "Reading…" : "Refresh"}
        </button>
        <button className="pane-close" onClick={onClose} title="Close (Escape)">
          ✕
        </button>
      </div>

      <div className="inbox-list">
        {composing === "issue" && (
          <NewIssue
            repos={repos}
            selectedPath={selectedPath}
            shell={shell}
            onCommand={onCommand}
            onCancel={() => setComposing(null)}
            onError={onError}
          />
        )}
        {composing === "pr" && (
          <NewPullRequest
            repos={repos}
            selectedPath={selectedPath}
            shell={shell}
            onCommand={onCommand}
            onCancel={() => setComposing(null)}
            onError={onError}
          />
        )}

        {missing && (
          <div className="inbox-notice">
            <p>
              The inbox reads GitHub through the <code>gh</code> CLI, so GitView never handles a
              token of its own.
            </p>
            {!gh?.version ? (
              <>
                <p>It is not on PATH here.</p>
                <pre>winget install GitHub.cli</pre>
              </>
            ) : (
              <>
                <p>
                  {gh.version} is installed, but nobody is logged in, so every repository would come
                  back unresolved.
                </p>
                <pre>gh auth login</pre>
              </>
            )}
          </div>
        )}

        {!missing && inbox?.error && (
          <div className="inbox-notice">
            <p>gh could not answer, and the list below is the last one that came back.</p>
            <pre>{inbox.error}</pre>
          </div>
        )}

        {!missing && !inbox && !refreshing && (
          <p className="empty">Nothing read yet. Refresh to ask GitHub.</p>
        )}

        {!missing && inbox && groups.length === 0 && !inbox.error && (
          <p className="empty">
            No open pull requests or issues across {inbox.items.length === 0 ? "the fleet" : "it"}.
          </p>
        )}

        {groups.map((group) => {
          const shut = collapsed.has(group.key);
          return (
            <div key={group.key}>
              <button
                className="group-label toggle"
                onClick={() => toggle(group.key)}
                title={shut ? "Show these" : "Hide these"}
              >
                <span className="chevron">{shut ? "▸" : "▾"}</span>
                {group.label} <span className="count">{group.items.length}</span>
                {group.hint && <span className="group-hint">{group.hint}</span>}
              </button>
              {!shut &&
                group.items.map((item) => {
                  const key = itemKey(item);
                  return (
                    <Row
                      key={key}
                      item={item}
                      showNeed={mode === "repo"}
                      open={open.has(key)}
                      shell={shell}
                      onToggle={() =>
                        setOpen((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      onSelect={onSelect}
                      onCommand={onCommand}
                      onMerge={onMerge}
                      onCopy={onCopy}
                    />
                  );
                })}
            </div>
          );
        })}

        {inbox && inbox.unresolved.length > 0 && (
          <p className="inbox-unresolved">
            {inbox.unresolved.length} repositor{inbox.unresolved.length === 1 ? "y" : "ies"} did not
            resolve and dropped out: {inbox.unresolved.join(", ")}. Renamed, private, or gone.
          </p>
        )}
      </div>
    </section>
  );
}

/** One key per row, stable across refreshes, so an open desk stays open. */
export function itemKey(item: Pick<InboxItem, "ownerRepo" | "kind" | "number">): string {
  return `${item.ownerRepo}#${item.kind}${item.number}`;
}

/** What each row wants from you, which is the question an inbox exists for. */
function byNeed(items: InboxItem[]): Group[] {
  const prs = items.filter((item) => item.kind === "pr");
  const issues = items.filter((item) => item.kind === "issue");

  const review = prs.filter((pr) => pr.reviewRequested);
  const taken = new Set(review);

  const failing = prs.filter(
    (pr) => !taken.has(pr) && pr.mine && (pr.checks === "FAILURE" || pr.checks === "ERROR"),
  );
  failing.forEach((pr) => taken.add(pr));

  const mine = prs.filter((pr) => !taken.has(pr) && pr.mine);
  mine.forEach((pr) => taken.add(pr));

  const assigned = issues.filter((issue) => issue.assigned);
  const claimed = new Set(assigned);

  // Issues you opened yourself. Without this they fall in with other people's,
  // and on a fleet holding one public repository that is most of the list, so
  // "elsewhere" ended up describing your own backlog.
  const opened = issues.filter((issue) => !claimed.has(issue) && issue.mine);
  opened.forEach((issue) => claimed.add(issue));

  const others = [
    ...prs.filter((pr) => !taken.has(pr)),
    ...issues.filter((issue) => !claimed.has(issue)),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return [
    { key: "need:review", label: "Needs your review", items: review },
    { key: "need:failing", label: "Yours, checks failing", items: failing },
    { key: "need:mine", label: "Your pull requests", items: mine },
    { key: "need:assigned", label: "Assigned to you", items: assigned },
    { key: "need:opened", label: "Issues you opened", items: opened },
    { key: "need:others", label: "From other people", items: others },
  ].filter((group) => group.items.length > 0);
}

/**
 * One group per repository, newest activity first.
 *
 * Ordered by the freshest row each repository holds rather than by name, so the
 * project that moved this morning is still the one at the top. Inside a group
 * the pull requests come before the issues: a PR is a thing that is going to
 * land, and an issue is a thing somebody wrote down.
 */
function byRepo(items: InboxItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const existing = groups.get(item.ownerRepo);
    if (existing) existing.items.push(item);
    else
      groups.set(item.ownerRepo, {
        key: `repo:${item.ownerRepo}`,
        label: item.repoName,
        hint: item.ownerRepo,
        items: [item],
      });
  }

  const rank = (item: InboxItem) => (item.kind === "pr" ? 0 : 1);
  const freshest = (group: Group) =>
    group.items.reduce((newest, item) => (item.updatedAt > newest ? item.updatedAt : newest), "");

  for (const group of groups.values()) {
    group.items.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }
  return [...groups.values()].sort((a, b) => freshest(b).localeCompare(freshest(a)));
}
