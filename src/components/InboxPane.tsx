import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import { Desk, CheckMark } from "./inbox/Desk";
import { IssueDesk } from "./inbox/IssueDesk";
import { NewIssue } from "./inbox/NewIssue";
import { NewPullRequest } from "./inbox/NewPullRequest";
import { byNeed, byRepo, itemKey, type Group, type Mode } from "../lib/inbox";
import { settings, updateSettings } from "../lib/settings";
import type { ShellKind } from "../lib/shell";
import {
  relativeTime,
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
  /** The sidebar's refresh button is reading GitHub. There is no button here. */
  refreshing: boolean;
  /**
   * A `gh` write the inbox typed and has not seen exit. The desk in that
   * repository holds its buttons until it does, and the row the write is
   * about to remove says so on its merge button.
   */
  waiting: { path: string; command: string; drops?: string } | null;
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
  /** Where a refused write of the issue body goes. The status bar. */
  onError: (message: string) => void;
  /** Copies, and says so in the status bar. `what` finishes "Copied …". */
  onCopy: (text: string, what: string) => void;
  /**
   * A row to open the desk under when the pane opens: the header's `PR #n`
   * button brings you here for that pull request, so it arrives expanded.
   */
  openKey: string | null;
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
  waiting,
  onToggle,
  onCommand,
  onMerge,
  onError,
  onMenu,
}: {
  item: InboxItem;
  /** Set in repo mode, where nothing above the row says why it is here. */
  showNeed: boolean;
  /** The desk is showing under this row. */
  open: boolean;
  shell: ShellKind;
  waiting: Props["waiting"];
  onToggle: () => void;
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  onMerge: (item: InboxItem, method: MergeMethod, command: string) => void;
  onError: (message: string) => void;
  onMenu: (event: ReactMouseEvent, item: InboxItem) => void;
}) {
  // Every action names the command it runs, so an inbox row types `gh` the way
  // a sidebar row types `git`. Nothing here writes to GitHub out of sight.
  const view = item.kind === "pr" ? `gh pr view ${item.number} --web` : `gh issue view ${item.number} --web`;
  const checkout = `gh pr checkout ${item.number}`;
  // A row opens its desk, the same as its chevron: the details are what you
  // clicked it for. An issue's row used to open the repository instead, which
  // closed the pane under you; the repository is still on the right-click.
  const pr = item.kind === "pr";
  const deskTitle = open
    ? pr
      ? "Hide the checks"
      : "Hide the thread"
    : pr
      ? "Checks, mergeability, and the merge button"
      : "The description and the thread";

  return (
    <div className={`inbox-row${open ? " open" : ""}`}>
      {/* The head is what the actions hang off. They used to float over the
          whole row, and a row with its desk open put them in the middle of
          the checks, where a click on the desk landed on Check out. */}
      <div className="inbox-head" onContextMenu={(event) => onMenu(event, item)}>
        <button
          className="inbox-expand"
          onClick={onToggle}
          title={deskTitle}
          aria-label={deskTitle}
          aria-expanded={open}
        >
          <span aria-hidden>{open ? "▾" : "▸"}</span>
        </button>
        <button className="inbox-main" onClick={onToggle} title={deskTitle}>
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

        {/* The actions show on hover and on focus-within, which Tab reaches
            but a reader does not hear coming. The group's name says they are
            there, and each one names the row it belongs to rather than
            sounding like the same Open on every row. */}
        <span className="inbox-actions" role="group" aria-label={`Actions for #${item.number}`}>
          {pr && (
            <button
              className="btn tiny"
              aria-label={`Check out #${item.number} in ${item.repoName}`}
              title={`${checkout}\n\nTyped into ${item.repoName}'s shell.`}
              onClick={() => onCommand(item.repoPath, checkout)}
            >
              Check out
            </button>
          )}
          <button
            className="btn tiny"
            aria-label={`Open #${item.number} on GitHub`}
            title={`${view}\n\nTyped into ${item.repoName}'s shell.`}
            onClick={() => onCommand(item.repoPath, view)}
          >
            Open
          </button>
        </span>
      </div>

      {open && pr && (
        <Desk item={item} shell={shell} waiting={waiting} onCommand={onCommand} onMerge={onMerge} />
      )}
      {open && !pr && <IssueDesk item={item} shell={shell} onCommand={onCommand} onError={onError} />}
    </div>
  );
}

export default function InboxPane({
  inbox,
  gh,
  repos,
  selectedPath,
  shell,
  refreshing,
  waiting,
  onClose,
  onSelect,
  onCommand,
  onMerge,
  onError,
  onCopy,
  openKey,
}: Props) {
  const menu = useContextMenu<InboxItem>();

  // The row's two hover buttons, the repository it belongs to, and the URL,
  // which is the one thing here worth pasting somewhere else.
  function rowMenu(item: InboxItem): MenuEntry[] {
    const view =
      item.kind === "pr" ? `gh pr view ${item.number} --web` : `gh issue view ${item.number} --web`;
    const checkout = `gh pr checkout ${item.number}`;
    const typed = (command: string) => `${command}

Typed into ${item.repoName}'s shell.`;
    return [
      { label: "Open on GitHub", title: typed(view), run: (t) => onCommand(item.repoPath, view, t) },
      ...(item.kind === "pr"
        ? [
            {
              label: "Check out",
              title: typed(checkout),
              run: (t: boolean) => onCommand(item.repoPath, checkout, t),
            },
          ]
        : []),
      { label: `Open ${item.repoName}`, title: item.repoPath, run: () => onSelect(item.repoPath) },
      "-",
      { label: "Copy URL", title: item.url, run: () => onCopy(item.url, "the URL") },
    ];
  }
  // By repo to start with. A fleet's inbox is mostly one repository's backlog
  // at a time, and reading it in project order is what somebody opening it asks
  // for; the need groups are one click away and the choice sticks.
  const [mode, setMode] = useState<Mode>(() => settings().inbox.mode);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(settings().inbox.collapsed),
  );
  const [composing, setComposing] = useState<"issue" | "pr" | null>(null);
  // Which desks are showing. Not persisted: a desk is opened to act on a row,
  // and the next time the pane opens the question is a new one.
  const [open, setOpen] = useState<Set<string>>(() => new Set(openKey ? [openKey] : []));

  useEffect(() => {
    if (openKey) setOpen((current) => (current.has(openKey) ? current : new Set(current).add(openKey)));
  }, [openKey]);

  useEffect(() => {
    updateSettings("inbox", { mode });
  }, [mode]);

  useEffect(() => {
    updateSettings("inbox", { collapsed: [...collapsed] });
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
        <button className="pane-close" onClick={onClose} title="Close (Escape)" aria-label="Close">
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
          <p className="empty">Nothing read yet. The refresh button in the sidebar asks GitHub.</p>
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
                <span className="chevron" aria-hidden>
                  {shut ? "▸" : "▾"}
                </span>
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
                      waiting={waiting}
                      onToggle={() =>
                        setOpen((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      onCommand={onCommand}
                      onMerge={onMerge}
                      onError={onError}
                      onMenu={menu.open}
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

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for #${menu.menu.payload.number}`}
          entries={rowMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </section>
  );
}
