import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { issueCreateCommand, type ShellKind } from "../lib/shell";
import {
  relativeTime,
  type GhStatus,
  type Inbox,
  type InboxItem,
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
  onCopy: (text: string) => void;
  /** Where a refused write of the issue body goes. The status bar. */
  onError: (message: string) => void;
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

function CheckMark({ state }: { state: InboxItem["checks"] }) {
  if (!state) return null;
  const tone =
    state === "SUCCESS"
      ? "ok"
      : state === "FAILURE" || state === "ERROR"
        ? "bad"
        : "pending";
  const glyph = tone === "ok" ? "✓" : tone === "bad" ? "✕" : "•";
  return (
    <span className={`inbox-checks ${tone}`} title={`checks: ${state.toLowerCase()}`}>
      {glyph}
    </span>
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
  onSelect,
  onCommand,
  onCopy,
}: {
  item: InboxItem;
  /** Set in repo mode, where nothing above the row says why it is here. */
  showNeed: boolean;
  onSelect: (path: string) => void;
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  onCopy: (text: string) => void;
}) {
  // Every action names the command it runs, so an inbox row types `gh` the way
  // a sidebar row types `git`. Nothing here writes to GitHub out of sight.
  const view = item.kind === "pr" ? `gh pr view ${item.number} --web` : `gh issue view ${item.number} --web`;
  const checkout = `gh pr checkout ${item.number}`;

  return (
    <div className="inbox-row">
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
  onCopy,
  onError,
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
  const [composing, setComposing] = useState(false);

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
          disabled={missing || composing}
          onClick={() => setComposing(true)}
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
        {composing && (
          <NewIssue
            repos={repos}
            selectedPath={selectedPath}
            shell={shell}
            onCommand={onCommand}
            onCancel={() => setComposing(false)}
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
                group.items.map((item) => (
                  <Row
                    key={`${item.ownerRepo}#${item.kind}${item.number}`}
                    item={item}
                    showNeed={mode === "repo"}
                    onSelect={onSelect}
                    onCommand={onCommand}
                    onCopy={onCopy}
                  />
                ))}
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
