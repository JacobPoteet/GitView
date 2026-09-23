import { useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import {
  attentionScore,
  isClean,
  operationTitle,
  stashTitle,
  unpushed,
  unpushedBranches,
  type RepoPref,
  type RepoState,
} from "../lib/types";

/** What the inbox knows about one repository, merged in the way prefs are. */
export interface RepoGithub {
  open: number;
  failing: boolean;
}

interface Props {
  repos: RepoState[];
  prefs: Map<string, RepoPref>;
  /** Empty until the inbox has been read. */
  github: Map<string, RepoGithub>;
  /** Pull requests and issues wanting something from this person. */
  inboxWaiting: number;
  /** Null when gh is absent, which is when there is no inbox to open. */
  onOpenInbox: (() => void) | null;
  selectedPath: string | null;
  liveSessions: Set<string>;
  query: string;
  scanning: boolean;
  /** A refresh is in flight: the sweep, the inbox read, or both. */
  refreshing: boolean;
  /** Rescans the fleet, re-reads the refs, and reads the inbox. */
  onRefresh: () => void;
  onQuery: (value: string) => void;
  onSelect: (path: string) => void;
  onPin: (path: string, pinned: boolean) => void;
  /** The pinned group in its new order, whole rather than as a move. */
  onReorderPins: (paths: string[]) => void;
  onHide: (path: string, hidden: boolean) => void;
  /** Only offered on a row that has one. The fleet view exists so a repository
   *  can be acted on without opening it, and that has to include ending its
   *  shell. */
  onCloseShell: (path: string) => void;
  /** Copies, and says so in the status bar. `what` finishes "Copied …". */
  onCopy: (text: string, what: string) => void;
  onManageRoots: () => void;
  onOpenSettings: () => void;
  /** Whether any folder is watched, which decides what an empty list says. */
  watching: boolean;
}

function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 3.5v9M4 3.5a1.5 1.5 0 1 0 0-.001M4 12.5a1.5 1.5 0 1 0 0 .001M12 5.5a1.5 1.5 0 1 0 0-.001M12 7v.5A3.5 3.5 0 0 1 8.5 11H4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.6 1.9 14.1 6.4M10.4 2.7 8.6 6l-3.9 1.3a.9.9 0 0 0-.4 1.5l3 3 3 3a.9.9 0 0 0 1.5-.4L13 10.5l3.3-1.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(-1.2 0.6) rotate(-8 8 8)"
      />
      <path d="M5.6 10.4 2 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function HideIcon({ hidden }: { hidden: boolean }) {
  return hidden ? (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 5.4C1.9 6.2 1.5 8 1.5 8S4 12.5 8 12.5c1 0 1.9-.3 2.7-.7M6.2 4c.6-.3 1.2-.5 1.8-.5 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function Chips({ repo, github }: { repo: RepoState; github?: RepoGithub }) {
  const dirty = repo.staged + repo.modified;
  const local = unpushed(repo);
  const base = repo.defaultBase ?? repo.defaultBranch ?? "the default branch";
  return (
    <span className="chips">
      {repo.operation && (
        <span className="chip conflict" title={operationTitle(repo.operation)}>
          {repo.operation.kind}
        </span>
      )}
      {repo.conflicted > 0 && (
        <span className="chip conflict" title="conflicted files">
          !{repo.conflicted}
        </span>
      )}
      {repo.behind > 0 && (
        <span className="chip behind" title="commits behind upstream">
          ↓{repo.behind}
        </span>
      )}
      {repo.ahead > 0 && (
        <span className="chip ahead" title="commits ahead of upstream">
          ↑{repo.ahead}
        </span>
      )}
      {/* Commits on this disk and nowhere else, on any local branch: a branch
          with no upstream by its lead over the default, one with an upstream
          by its lead over that. `ahead` only ever sees HEAD's. */}
      {local > 0 && (
        <span
          className="chip unpushed"
          title={`${local} ${local === 1 ? "commit" : "commits"} not on any remote\n${
            unpushedBranches(repo).join("\n") || `ahead of ${base} with no upstream`
          }`}
        >
          ⇡{local}
        </span>
      )}
      {dirty > 0 && (
        <span className="chip dirty" title="staged and modified files">
          ●{dirty}
        </span>
      )}
      {repo.mergedBranches.length > 0 && (
        <span className="chip merged" title="branches merged into the default branch">
          ⌫{repo.mergedBranches.length}
        </span>
      )}
      {repo.localBranchCount > 1 && (
        <span className="chip branches" title={`${repo.localBranchCount} local branches`}>
          ⑂{repo.localBranchCount}
        </span>
      )}
      {/* Bare like the branch count: a stash is work set aside on purpose,
          and a row should not shout about it. The title lists them. */}
      {repo.stashes.length > 0 && (
        <span className="chip branches" title={stashTitle(repo.stashes)}>
          ⧉{repo.stashes.length}
        </span>
      )}
      {/* GitHub state, which the scan cannot see. Absent until the inbox has
          been read once, so a row never claims zero open pull requests. */}
      {github && github.open > 0 && (
        <span
          className={`chip pr${github.failing ? " failing" : ""}`}
          title={
            github.failing
              ? `${github.open} open pull requests, checks failing on one`
              : `${github.open} open pull requests`
          }
        >
          ⇅{github.open}
          {github.failing && "!"}
        </span>
      )}
    </span>
  );
}

function GripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="6" cy="4" r="1.15" />
      <circle cx="10" cy="4" r="1.15" />
      <circle cx="6" cy="8" r="1.15" />
      <circle cx="10" cy="8" r="1.15" />
      <circle cx="6" cy="12" r="1.15" />
      <circle cx="10" cy="12" r="1.15" />
    </svg>
  );
}

/**
 * The pinned group with one row moved to where it was dropped.
 *
 * `target` is that row's index in the order as drawn, so dragging downwards
 * lands the row after the one under the cursor and dragging upwards lands it
 * before, which is where the insertion line was.
 */
function moveTo(order: string[], path: string, target: number): string[] {
  const from = order.indexOf(path);
  if (from === -1 || from === target) return order;
  const next = order.filter((p) => p !== path);
  next.splice(target, 0, path);
  return next;
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** How a row is taking part in a drag, which is what draws the insertion line. */
type DragRole = "none" | "source" | "before" | "after";

/** What a heading says for a group: the visible count is a bare number. */
function groupName(label: string, count: number): string {
  return `${label}, ${count} ${count === 1 ? "repository" : "repositories"}`;
}

function Row({
  repo,
  selected,
  live,
  pinned,
  hidden,
  github,
  orderable,
  slot,
  drag,
  onSelect,
  onPin,
  onHide,
  onCloseShell,
  onMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMove,
}: {
  repo: RepoState;
  selected: boolean;
  live: boolean;
  pinned: boolean;
  hidden: boolean;
  github?: RepoGithub;
  /** False on every row outside the pinned group, which has no order to set. */
  orderable: boolean;
  /** Position in the list, labels included, for the cascade on launch. */
  slot: number;
  drag: DragRole;
  onSelect: (path: string) => void;
  onPin: (path: string, pinned: boolean) => void;
  onHide: (path: string, hidden: boolean) => void;
  onCloseShell: (path: string) => void;
  onMenu: (event: ReactMouseEvent, repo: RepoState) => void;
  onDragStart: (path: string) => void;
  onDragOver: (path: string) => void;
  onDrop: (path: string) => void;
  onDragEnd: () => void;
  onMove: (path: string, delta: number) => void;
}) {
  const state = repo.error ? "error" : live ? "live" : isClean(repo) ? "clean" : "attention";
  // A repository on its default branch drops the second line. Ten rows that
  // each said `main` hid the one that did not, so a branch under a name now
  // means that repository is somewhere other than home.
  const home = !repo.error && !repo.isWorktree && repo.branch != null && repo.branch === repo.defaultBranch;
  const wrap = useRef<HTMLLIElement>(null);

  // The row and its two controls are siblings rather than nested buttons, which
  // the browser refuses to nest and the keyboard cannot reach.
  return (
    <li
      ref={wrap}
      style={{ "--slot": slot } as CSSProperties}
      className={
        `repo-row-wrap${selected ? " selected" : ""}${hidden ? " muted" : ""}` +
        (drag === "source" ? " dragging" : "") +
        (drag === "before" ? " drop-before" : "") +
        (drag === "after" ? " drop-after" : "")
      }
      onContextMenu={(event) => onMenu(event, repo)}
      onDragOver={
        orderable
          ? (e) => {
              // Without this the drop is refused and the row springs back.
              e.preventDefault();
              onDragOver(repo.path);
            }
          : undefined
      }
      onDrop={
        orderable
          ? (e) => {
              e.preventDefault();
              onDrop(repo.path);
            }
          : undefined
      }
    >
      <button
        className={`repo-row${home ? " home" : ""}`}
        onClick={() => onSelect(repo.path)}
        title={home ? `${repo.path}
on ${repo.branch}` : repo.path}
        onKeyDown={
          orderable
            ? (e) => {
                // Dragging is a mouse gesture and this list is reachable by
                // keyboard, so the order has to be too.
                if (!e.altKey) return;
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  onMove(repo.path, -1);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  onMove(repo.path, 1);
                }
              }
            : undefined
        }
      >
        <span className="repo-row-top">
          <span className={`dot ${state}`} />
          <span className="repo-name">{repo.name}</span>
          <Chips repo={repo} github={github} />
        </span>
        {!home && (
          <span className="repo-row-bottom">
            <span className="branch">
              <BranchIcon />
              <span>{repo.error ? "unreadable" : (repo.branch ?? "no commits")}</span>
            </span>
            {repo.isWorktree && <span className="chip merged">worktree</span>}
          </span>
        )}
      </button>

      <span className="row-actions">
        {orderable && (
          // The handle is what carries `draggable`, not the row: Chromium will
          // not start a parent's drag from inside a button, so a draggable
          // wrapper is only draggable by its padding.
          <span
            className="row-action grip"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              // Firefox and WebView2 both want the drag to carry something.
              e.dataTransfer.setData("text/plain", repo.path);
              if (wrap.current) e.dataTransfer.setDragImage(wrap.current, 12, 18);
              onDragStart(repo.path);
            }}
            onDragEnd={onDragEnd}
            title="Drag to reorder, or Alt+Up and Alt+Down on the row"
          >
            <GripIcon />
          </span>
        )}
        {live && (
          <button
            className="row-action live"
            onClick={() => onCloseShell(repo.path)}
            title="Close this repository's shell"
            aria-label={`Close ${repo.name}'s shell`}
          >
            <CloseIcon />
          </button>
        )}
        <button
          className={`row-action${pinned ? " on" : ""}`}
          onClick={() => onPin(repo.path, !pinned)}
          title={pinned ? "Unpin" : "Pin to the top of the list"}
          aria-label={pinned ? `Unpin ${repo.name}` : `Pin ${repo.name}`}
          aria-pressed={pinned}
        >
          <PinIcon />
        </button>
        <button
          className="row-action"
          onClick={() => onHide(repo.path, !hidden)}
          title={hidden ? "Show in the list again" : "Hide, and drop it from the palette"}
          aria-label={hidden ? `Show ${repo.name}` : `Hide ${repo.name}`}
        >
          <HideIcon hidden={hidden} />
        </button>
      </span>
    </li>
  );
}

/**
 * The sidebar's groups, in the order it draws them. Exported so `App` can
 * number the first nine for Ctrl+1 to Ctrl+9 from the same list the eye
 * counts down, and never from a list the sidebar would draw differently.
 */
export function groupRepos(repos: RepoState[], prefs: Map<string, RepoPref>, query: string) {
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? repos.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.branch ?? "").toLowerCase().includes(needle),
      )
    : repos;

  const hidden = filtered.filter((r) => prefs.get(r.path)?.hidden);
  const visible = filtered.filter((r) => !prefs.get(r.path)?.hidden);

  // Pin order is whatever the user arranged it to be, and the order they were
  // pinned in until they arrange it. A pinned repository holds its place
  // whether or not it is the loudest one today, which is the point.
  const pinned = visible
    .filter((r) => prefs.get(r.path)?.pinnedAt != null)
    .sort((a, b) => {
      const left = prefs.get(a.path);
      const right = prefs.get(b.path);
      return (
        (left?.pinnedPos ?? Number.MAX_SAFE_INTEGER) -
          (right?.pinnedPos ?? Number.MAX_SAFE_INTEGER) ||
        (left?.pinnedAt ?? 0) - (right?.pinnedAt ?? 0) ||
        a.name.localeCompare(b.name)
      );
    });

  const rest = visible
    .filter((r) => prefs.get(r.path)?.pinnedAt == null)
    .sort((a, b) => attentionScore(b) - attentionScore(a) || a.name.localeCompare(b.name));

  return {
    pinned,
    attention: rest.filter((r) => !isClean(r)),
    clean: rest.filter(isClean),
    hidden: hidden.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The visible rows top to bottom, which is what Ctrl+1 to Ctrl+9 count. */
export function drawnOrder(groups: ReturnType<typeof groupRepos>): RepoState[] {
  return [...groups.pinned, ...groups.attention, ...groups.clean];
}

export default function FleetSidebar({
  repos,
  prefs,
  selectedPath,
  liveSessions,
  query,
  scanning,
  refreshing,
  onRefresh,
  onQuery,
  github,
  inboxWaiting,
  onOpenInbox,
  onSelect,
  onPin,
  onReorderPins,
  onHide,
  onCloseShell,
  onCopy,
  onManageRoots,
  onOpenSettings,
  watching,
}: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const menu = useContextMenu<RepoState>();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const groups = useMemo(() => groupRepos(repos, prefs, query), [repos, prefs, query]);

  const pinOrder = groups.pinned.map((repo) => repo.path);

  // A filter draws a subset of the pinned group, and an order written from a
  // subset would leave the rows it could not see holding stale positions. So
  // the group is only orderable when all of it is on screen.
  const orderable = query.trim() === "" && pinOrder.length > 1;

  const commitDrop = (target: string) => {
    const next = dragging ? moveTo(pinOrder, dragging, pinOrder.indexOf(target)) : pinOrder;
    setDragging(null);
    setOver(null);
    if (next !== pinOrder) onReorderPins(next);
  };

  const move = (path: string, delta: number) => {
    const from = pinOrder.indexOf(path);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= pinOrder.length) return;
    const next = [...pinOrder];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onReorderPins(next);
  };

  function roleFor(path: string): DragRole {
    if (!dragging || !orderable) return "none";
    if (dragging === path) return "source";
    if (over !== path) return "none";
    return pinOrder.indexOf(dragging) < pinOrder.indexOf(path) ? "after" : "before";
  }

  // Counted in render order, which is top to bottom: the launch cascade pops
  // each label and row in by its place, whichever group it is in.
  let slots = 0;
  const slot = () => ({ "--slot": slots++ }) as CSSProperties;
  const renderRow = (repo: RepoState, inPinnedGroup: boolean) => (
    <Row
      key={repo.path}
      slot={slots++}
      repo={repo}
      selected={repo.path === selectedPath}
      live={liveSessions.has(repo.path)}
      pinned={prefs.get(repo.path)?.pinnedAt != null}
      hidden={prefs.get(repo.path)?.hidden === true}
      github={github.get(repo.path)}
      orderable={inPinnedGroup && orderable}
      drag={inPinnedGroup ? roleFor(repo.path) : "none"}
      onSelect={onSelect}
      onPin={onPin}
      onHide={onHide}
      onCloseShell={onCloseShell}
      onMenu={menu.open}
      onDragStart={setDragging}
      onDragOver={setOver}
      onDrop={commitDrop}
      onDragEnd={() => {
        setDragging(null);
        setOver(null);
      }}
      onMove={move}
    />
  );

  // A one-argument form, because `.map(render)` would otherwise hand the index
  // in as the second parameter and make every row after the first orderable.
  const render = (repo: RepoState) => renderRow(repo, false);

  // The row's two hover controls and the one it shows when a shell is up, plus
  // the path, which is otherwise only readable from the tooltip.
  function rowMenu(repo: RepoState): MenuEntry[] {
    const pinned = prefs.get(repo.path)?.pinnedAt != null;
    const hidden = prefs.get(repo.path)?.hidden === true;
    const live = liveSessions.has(repo.path);
    return [
      {
        label: pinned ? "Unpin" : "Pin to the top",
        run: () => onPin(repo.path, !pinned),
      },
      {
        label: hidden ? "Show in the list" : "Hide",
        title: hidden ? undefined : "Drops it from the list and the palette",
        run: () => onHide(repo.path, !hidden),
      },
      { label: "Copy path", title: repo.path, run: () => onCopy(repo.path, "the path") },
      ...(live
        ? [
            "-" as const,
            {
              label: "Close shell",
              danger: true,
              title: "Ends the session, and whatever is running in it",
              run: () => onCloseShell(repo.path),
            },
          ]
        : []),
    ];
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">
          <svg className="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M8 5.5v13M8 12h5.5A2.5 2.5 0 0 0 16 9.5V9"
              stroke="var(--accent)"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <circle cx="8" cy="4.6" r="2" stroke="var(--accent)" strokeWidth="1.6" />
            <circle cx="8" cy="19.4" r="2" stroke="var(--accent)" strokeWidth="1.6" />
            <circle cx="16" cy="7.4" r="2" stroke="var(--accent)" strokeWidth="1.6" />
          </svg>
          GitView
        </span>
        {/* The inbox belongs here rather than in the repository header: it is a
            question about the whole fleet, and the header only exists once one
            repository is open, which is the moment you least need it. */}
        {onOpenInbox && (
          <button
            className={`icon-btn${inboxWaiting > 0 ? " badged" : ""}`}
            data-tour="inbox"
            onClick={onOpenInbox}
            title={
              inboxWaiting > 0
                ? `GitHub inbox: ${inboxWaiting} waiting on you`
                : "GitHub inbox: pull requests and issues across the fleet"
            }
            // The badge's count is the button's text, and text beats a title
            // for the accessible name, so without this the button reads "3".
            aria-label={inboxWaiting > 0 ? `GitHub inbox, ${inboxWaiting} waiting on you` : "GitHub inbox"}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M1.8 8.5h3l1 1.7h4.4l1-1.7h3M1.8 8.5 3.4 3.2A1 1 0 0 1 4.4 2.5h7.2a1 1 0 0 1 1 .7l1.6 5.3v3.3a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V8.5Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {inboxWaiting > 0 && <span className="badge-count">{inboxWaiting}</span>}
          </button>
        )}
        {/* Settings sit beside the inbox: both are about the app rather than
            about the repository that happens to be open. */}
        <button
          className="icon-btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            {/* A gear: eight teeth on a ring, with the hole in the middle.
                The rays-round-a-circle it replaced read as a sun (#112). */}
            <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M12.6 6.4L14.4 6.5L14.4 9.5L12.6 9.6L12.4 10.2L13.6 11.4L11.4 13.6L10.2 12.4L9.6 12.6L9.5 14.4L6.5 14.4L6.4 12.6L5.8 12.4L4.6 13.6L2.4 11.4L3.6 10.2L3.4 9.6L1.6 9.5L1.6 6.5L3.4 6.4L3.6 5.8L2.4 4.6L4.6 2.4L5.8 3.6L6.4 3.4L6.5 1.6L9.5 1.6L9.6 3.4L10.2 3.6L11.4 2.4L13.6 4.6L12.4 5.8Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {/* The one refresh. It lives beside the folders button because that is
            the one row on screen whether or not a repository is open. */}
        <button
          className={`icon-btn${refreshing ? " busy" : ""}`}
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh"
          aria-busy={refreshing}
          title={
            refreshing
              ? "Refreshing"
              : "Refresh: rescan the fleet, re-read the refs, and read the inbox"
          }
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.4h-2.4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="icon-btn"
          onClick={onManageRoots}
          title="Folders GitView watches"
          aria-label="Watched folders"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="sidebar-search">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="4.5" stroke="var(--text-faint)" strokeWidth="1.4" />
          <path
            d="M10.5 10.5 14 14"
            stroke="var(--text-faint)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter repositories"
          spellCheck={false}
        />
      </div>

      <div className="repo-list" data-tour="fleet">
        {repos.length === 0 && (
          <p className="empty">
            {scanning
              ? "Scanning…"
              : watching
                ? "No repositories in the watched folders."
                : "Nothing watched yet."}
          </p>
        )}

        {/* Each group is a region under its own heading, and the rows are a
            list, so a screen reader hears "Pinned, 3 repositories" and then a
            list of three rather than one long run of buttons. The count is
            read from the heading's label: the bare number in the visible
            text says nothing on its own. */}
        {groups.pinned.length > 0 && (
          <section className="repo-group" aria-labelledby="group-pinned">
            <h2
              id="group-pinned"
              className="group-label"
              style={slot()}
              aria-label={groupName("Pinned", groups.pinned.length)}
            >
              Pinned <span className="count">{groups.pinned.length}</span>
              {orderable && <span className="group-hint">drag to reorder</span>}
            </h2>
            <ul className="repo-rows">{groups.pinned.map((repo) => renderRow(repo, true))}</ul>
          </section>
        )}

        {groups.attention.length > 0 && (
          <section className="repo-group" aria-labelledby="group-attention">
            <h2
              id="group-attention"
              className="group-label"
              style={slot()}
              aria-label={groupName("Needs attention", groups.attention.length)}
            >
              Needs attention <span className="count">{groups.attention.length}</span>
            </h2>
            <ul className="repo-rows">{groups.attention.map(render)}</ul>
          </section>
        )}

        {groups.clean.length > 0 && (
          <section className="repo-group" aria-labelledby="group-clean">
            <h2
              id="group-clean"
              className="group-label"
              style={slot()}
              aria-label={groupName("Clean", groups.clean.length)}
            >
              Clean <span className="count">{groups.clean.length}</span>
            </h2>
            <ul className="repo-rows">{groups.clean.map(render)}</ul>
          </section>
        )}

        {groups.hidden.length > 0 && (
          <section className="repo-group" aria-labelledby="group-hidden">
            <h2 className="group-head">
              <button
                id="group-hidden"
                className="group-label toggle"
                style={slot()}
                onClick={() => setShowHidden((v) => !v)}
                aria-expanded={showHidden}
                aria-label={groupName("Hidden", groups.hidden.length)}
              >
                <span className="chevron" aria-hidden>
                  {showHidden ? "▾" : "▸"}
                </span>
                Hidden <span className="count">{groups.hidden.length}</span>
              </button>
            </h2>
            {showHidden && <ul className="repo-rows">{groups.hidden.map(render)}</ul>}
          </section>
        )}
      </div>

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.name}`}
          entries={rowMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </aside>
  );
}
