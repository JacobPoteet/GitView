import { useMemo } from "react";
import { relativeTime, type GhStatus, type Inbox, type InboxItem } from "../lib/types";

interface Props {
  inbox: Inbox | null;
  gh: GhStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
  /** Selects the repository an item belongs to and closes the pane. */
  onSelect: (path: string) => void;
  /** Types a command into that repository's shell, the way every action does. */
  onCommand: (path: string, command: string) => void;
  onCopy: (text: string) => void;
}

/**
 * Groups, in the order they want something from you.
 *
 * The fleet list answers which repositories need attention. This answers what
 * needs a reply, which is a different question about the same eleven folders,
 * so it borrows the same group-label idiom rather than inventing one.
 */
interface Group {
  label: string;
  hint?: string;
  items: InboxItem[];
}

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

function Row({
  item,
  onSelect,
  onCommand,
  onCopy,
}: {
  item: InboxItem;
  onSelect: (path: string) => void;
  onCommand: (path: string, command: string) => void;
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
          <ReviewBadge item={item} />
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

export default function InboxPane({
  inbox,
  gh,
  refreshing,
  onRefresh,
  onClose,
  onSelect,
  onCommand,
  onCopy,
}: Props) {
  const groups = useMemo<Group[]>(() => {
    const items = inbox?.items ?? [];
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

    // Issues you opened yourself. Without this they fall in with other
    // people's, and on a fleet holding one public repository that is most of
    // the list, so "elsewhere" ended up describing your own backlog.
    const opened = issues.filter((issue) => !claimed.has(issue) && issue.mine);
    opened.forEach((issue) => claimed.add(issue));

    const others = [
      ...prs.filter((pr) => !taken.has(pr)),
      ...issues.filter((issue) => !claimed.has(issue)),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return [
      { label: "Needs your review", items: review },
      { label: "Yours, checks failing", items: failing },
      { label: "Your pull requests", items: mine },
      { label: "Assigned to you", items: assigned },
      { label: "Issues you opened", items: opened },
      { label: "From other people", items: others },
    ].filter((group) => group.items.length > 0);
  }, [inbox]);

  const missing = !gh?.version || !gh.loggedIn;

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
        <button className="btn tiny" disabled={refreshing || missing} onClick={onRefresh}>
          {refreshing ? "Reading…" : "Refresh"}
        </button>
        <button className="btn tiny" onClick={onClose} title="Back to the terminal">
          Close
        </button>
      </div>

      <div className="inbox-list">
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

        {groups.map((group) => (
          <div key={group.label}>
            <div className="group-label">
              {group.label} <span className="count">{group.items.length}</span>
            </div>
            {group.items.map((item) => (
              <Row
                key={`${item.ownerRepo}#${item.kind}${item.number}`}
                item={item}
                onSelect={onSelect}
                onCommand={onCommand}
                onCopy={onCopy}
              />
            ))}
          </div>
        ))}

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
