import { useEffect, useRef, useState } from "react";
import type { BranchSummary, RepoState } from "../lib/types";
import { relativeTime } from "../lib/types";
import { quote, type ShellKind } from "../lib/shell";

interface Props {
  repo: RepoState;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
}

/**
 * The branches you cannot otherwise see.
 *
 * Standing on the default branch and in sync with it, the graph is a straight
 * line and the header says everything matches, which is true and also hides the
 * three branches sitting behind it. The scanner already measures every local
 * branch against the default one, so this is a list of what that pass found
 * rather than a second read.
 */
export default function BranchMenu({ repo, shell, onCommand }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = repo.branches.length || repo.localBranchCount;
  const base = repo.defaultBase ?? repo.defaultBranch ?? "the default branch";
  // Branches that are neither the one you are on nor already contained in the
  // default branch. That is the number worth putting on the button, because it
  // is the work you would forget about.
  const outstanding = repo.branches.filter((b) => !b.isHead && !b.merged).length;

  return (
    <div className="branch-menu" ref={wrap}>
      <button
        className={`btn${outstanding > 0 ? " has-other" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={`${count} local ${count === 1 ? "branch" : "branches"}, measured against ${base}`}
      >
        Branches
        <code>{count}</code>
      </button>

      {open && (
        <div className="branch-pop">
          <div className="branch-pop-head">
            Measured against <code>{base}</code>
          </div>

          {repo.branches.length === 0 && <p className="empty">No local branches.</p>}

          {repo.branches.map((branch) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              shell={shell}
              onCommand={(command, typeOnly) => {
                onCommand(command, typeOnly);
                if (!typeOnly) setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchRow({
  branch,
  shell,
  onCommand,
}: {
  branch: BranchSummary;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
}) {
  const command = `git switch ${quote(branch.name, shell)}`;
  return (
    <button
      className={`branch-pop-row${branch.isHead ? " current" : ""}`}
      disabled={branch.isHead}
      onClick={(event) => onCommand(command, event.shiftKey)}
      title={
        branch.isHead
          ? "You are here."
          : `${command}\n\nShift-click to type it without running it.`
      }
    >
      <span className="branch-pop-name">{branch.name}</span>
      <span className="branch-pop-counts">
        {branch.ahead > 0 && <span className="chip ahead">↑{branch.ahead}</span>}
        {branch.behind > 0 && <span className="chip behind">↓{branch.behind}</span>}
        {branch.merged && (
          <span className="chip merged" title="Already contained in the default branch">
            merged
          </span>
        )}
      </span>
      <span className="branch-pop-when">{relativeTime(branch.lastCommitAt)}</span>
    </button>
  );
}
