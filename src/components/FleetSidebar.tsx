import { useMemo, useState } from "react";
import { attentionScore, isClean, unpushed, type RepoPref, type RepoState } from "../lib/types";

interface Props {
  repos: RepoState[];
  prefs: Map<string, RepoPref>;
  selectedPath: string | null;
  liveSessions: Set<string>;
  query: string;
  scanning: boolean;
  onQuery: (value: string) => void;
  onSelect: (path: string) => void;
  onPin: (path: string, pinned: boolean) => void;
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

function Chips({ repo }: { repo: RepoState }) {
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
    </span>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Row({
  repo,
  selected,
  live,
  pinned,
  hidden,
  onSelect,
  onPin,
  onHide,
  onCloseShell,
}: {
  repo: RepoState;
  selected: boolean;
  live: boolean;
  pinned: boolean;
  hidden: boolean;
  onSelect: (path: string) => void;
  onPin: (path: string, pinned: boolean) => void;
  onHide: (path: string, hidden: boolean) => void;
  onCloseShell: (path: string) => void;
}) {
  const state = repo.error ? "error" : live ? "live" : isClean(repo) ? "clean" : "attention";

  // The row and its two controls are siblings rather than nested buttons, which
  // the browser refuses to nest and the keyboard cannot reach.
  return (
    <div className={`repo-row-wrap${selected ? " selected" : ""}${hidden ? " muted" : ""}`}>
      <button className="repo-row" onClick={() => onSelect(repo.path)} title={repo.path}>
        <span className="repo-row-top">
          <span className={`dot ${state}`} />
          <span className="repo-name">{repo.name}</span>
          <Chips repo={repo} />
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
  onSelect,
  onPin,
  onHide,
  onCloseShell,
  onManageRoots,
}: Props) {
  const [showHidden, setShowHidden] = useState(false);

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

    // Pin order is the order they were pinned. A pinned repository holds its
    // place whether or not it is the loudest one today, which is the point.
    const pinned = visible
      .filter((r) => prefs.get(r.path)?.pinnedAt != null)
      .sort(
        (a, b) => (prefs.get(a.path)?.pinnedAt ?? 0) - (prefs.get(b.path)?.pinnedAt ?? 0),
      );

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

  const render = (repo: RepoState) => (
    <Row
      key={repo.path}
      repo={repo}
      selected={repo.path === selectedPath}
      live={liveSessions.has(repo.path)}
      pinned={prefs.get(repo.path)?.pinnedAt != null}
      hidden={prefs.get(repo.path)?.hidden === true}
      onSelect={onSelect}
      onPin={onPin}
      onHide={onHide}
      onCloseShell={onCloseShell}
    />
  );

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
            <div className="group-label">
              Pinned <span className="count">{groups.pinned.length}</span>
            </div>
            {groups.pinned.map(render)}
          </>
        )}

        {groups.attention.length > 0 && (
          <>
            <div className="group-label">
              Needs attention <span className="count">{groups.attention.length}</span>
            </div>
            {groups.attention.map(render)}
          </>
        )}

        {groups.clean.length > 0 && (
          <>
            <div className="group-label">
              Clean <span className="count">{groups.clean.length}</span>
            </div>
            {groups.clean.map(render)}
          </>
        )}

        {groups.hidden.length > 0 && (
          <>
            <button className="group-label toggle" onClick={() => setShowHidden((v) => !v)}>
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
