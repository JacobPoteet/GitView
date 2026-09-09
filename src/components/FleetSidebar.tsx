import { useMemo } from "react";
import { attentionScore, isClean, type RepoState } from "../lib/types";

interface Props {
  repos: RepoState[];
  selectedPath: string | null;
  liveSessions: Set<string>;
  query: string;
  scanning: boolean;
  onQuery: (value: string) => void;
  onSelect: (path: string) => void;
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

function Chips({ repo }: { repo: RepoState }) {
  const dirty = repo.staged + repo.modified;
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
    </span>
  );
}

function Row({
  repo,
  selected,
  live,
  onSelect,
}: {
  repo: RepoState;
  selected: boolean;
  live: boolean;
  onSelect: (path: string) => void;
}) {
  const state = repo.error
    ? "error"
    : live
      ? "live"
      : isClean(repo)
        ? "clean"
        : "attention";

  return (
    <button
      className={`repo-row${selected ? " selected" : ""}`}
      onClick={() => onSelect(repo.path)}
      title={repo.path}
    >
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
  );
}

export default function FleetSidebar({
  repos,
  selectedPath,
  liveSessions,
  query,
  scanning,
  onQuery,
  onSelect,
}: Props) {
  const { attention, clean } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? repos.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            (r.branch ?? "").toLowerCase().includes(needle),
        )
      : repos;

    const sorted = [...filtered].sort(
      (a, b) => attentionScore(b) - attentionScore(a) || a.name.localeCompare(b.name),
    );

    return {
      attention: sorted.filter((r) => !isClean(r)),
      clean: sorted.filter(isClean),
    };
  }, [repos, query]);

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
      </div>

      <div className="sidebar-search">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="4.5" stroke="var(--text-faint)" strokeWidth="1.4" />
          <path d="M10.5 10.5 14 14" stroke="var(--text-faint)" strokeWidth="1.4" strokeLinecap="round" />
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
            {scanning ? "Scanning…" : "No repositories found in the scan roots."}
          </p>
        )}

        {attention.length > 0 && (
          <>
            <div className="group-label">
              Needs attention <span className="count">{attention.length}</span>
            </div>
            {attention.map((repo) => (
              <Row
                key={repo.path}
                repo={repo}
                selected={repo.path === selectedPath}
                live={liveSessions.has(repo.path)}
                onSelect={onSelect}
              />
            ))}
          </>
        )}

        {clean.length > 0 && (
          <>
            <div className="group-label">
              Clean <span className="count">{clean.length}</span>
            </div>
            {clean.map((repo) => (
              <Row
                key={repo.path}
                repo={repo}
                selected={repo.path === selectedPath}
                live={liveSessions.has(repo.path)}
                onSelect={onSelect}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
