import { useMemo, useRef, useState, type CSSProperties } from "react";
import { attentionScore, isClean, unpushed, type RepoPref, type RepoState } from "../lib/types";

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
  onManageRoots: () => void;
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
      {/* No upstream, so `ahead` reads zero however far this has run. These
          commits are on this disk and nowhere else. */}
      {local > 0 && (
        <span
          className="chip unpushed"
          title={`${local} commits ahead of ${base}, on a branch with no upstream`}
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
  onDragStart: (path: string) => void;
  onDragOver: (path: string) => void;
  onDrop: (path: string) => void;
  onDragEnd: () => void;
  onMove: (path: string, delta: number) => void;
}) {
  const state = repo.error ? "error" : live ? "live" : isClean(repo) ? "clean" : "attention";
  const wrap = useRef<HTMLDivElement>(null);

  // The row and its two controls are siblings rather than nested buttons, which
  // the browser refuses to nest and the keyboard cannot reach.
  return (
    <div
      ref={wrap}
      style={{ "--slot": slot } as CSSProperties}
      className={
        `repo-row-wrap${selected ? " selected" : ""}${hidden ? " muted" : ""}` +
        (drag === "source" ? " dragging" : "") +
        (drag === "before" ? " drop-before" : "") +
        (drag === "after" ? " drop-after" : "")
      }
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
        className="repo-row"
        onClick={() => onSelect(repo.path)}
        title={repo.path}
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
        <span className="repo-row-bottom">
          <span className="branch">
            <BranchIcon />
            <span>{repo.error ? "unreadable" : (repo.branch ?? "no commits")}</span>
          </span>
          {repo.isWorktree && <span className="chip merged">worktree</span>}
        </span>
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
          >
            <CloseIcon />
          </button>
        )}
        <button
          className={`row-action${pinned ? " on" : ""}`}
          onClick={() => onPin(repo.path, !pinned)}
          title={pinned ? "Unpin" : "Pin to the top of the list"}
        >
          <PinIcon />
        </button>
        <button
          className="row-action"
          onClick={() => onHide(repo.path, !hidden)}
          title={hidden ? "Show in the list again" : "Hide, and drop it from the palette"}
        >
          <HideIcon hidden={hidden} />
        </button>
      </span>
    </div>
  );
}

export default function FleetSidebar({
  repos,
  prefs,
  selectedPath,
  liveSessions,
  query,
  scanning,
  onQuery,
  github,
  inboxWaiting,
  onOpenInbox,
  onSelect,
  onPin,
  onReorderPins,
  onHide,
  onCloseShell,
  onManageRoots,
}: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const groups = useMemo(() => {
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
  }, [repos, prefs, query]);

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
            onClick={onOpenInbox}
            title={
              inboxWaiting > 0
                ? `GitHub inbox: ${inboxWaiting} waiting on you`
                : "GitHub inbox: pull requests and issues across the fleet"
            }
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
        <button className="icon-btn" onClick={onManageRoots} title="Folders GitView watches">
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

      <div className="repo-list">
        {repos.length === 0 && (
          <p className="empty">
            {scanning ? "Scanning…" : "No repositories in the watched folders."}
          </p>
        )}

        {groups.pinned.length > 0 && (
          <>
            <div className="group-label" style={slot()}>
              Pinned <span className="count">{groups.pinned.length}</span>
              {orderable && <span className="group-hint">drag to reorder</span>}
            </div>
            {groups.pinned.map((repo) => renderRow(repo, true))}
          </>
        )}

        {groups.attention.length > 0 && (
          <>
            <div className="group-label" style={slot()}>
              Needs attention <span className="count">{groups.attention.length}</span>
            </div>
            {groups.attention.map(render)}
          </>
        )}

        {groups.clean.length > 0 && (
          <>
            <div className="group-label" style={slot()}>
              Clean <span className="count">{groups.clean.length}</span>
            </div>
            {groups.clean.map(render)}
          </>
        )}

        {groups.hidden.length > 0 && (
          <>
            <button
              className="group-label toggle"
              style={slot()}
              onClick={() => setShowHidden((v) => !v)}
            >
              <span className="chevron">{showHidden ? "▾" : "▸"}</span>
              Hidden <span className="count">{groups.hidden.length}</span>
            </button>
            {showHidden && groups.hidden.map(render)}
          </>
        )}
      </div>
    </aside>
  );
}
