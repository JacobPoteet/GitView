import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import type { BranchSummary, RepoState, Squashed } from "../lib/types";
import { relativeTime } from "../lib/types";
import { quote, type ShellKind } from "../lib/shell";

interface Props {
  repo: RepoState;
  shell: ShellKind;
  /** Branches the trunk swallowed through a squash, which it does not contain. */
  squashed: Squashed[];
  onCommand: (command: string, typeOnly: boolean) => void;
  /** Deleting asks first, and the app owns the dialog. */
  onDeleteBranch: (name: string) => void;
  onCopy: (text: string, what: string) => void;
}

/**
 * The branches you cannot otherwise see, behind the name of the one you are on.
 *
 * Standing on the default branch and in sync with it, the graph is a straight
 * line and the header says everything matches, which is true and also hides the
 * three branches sitting behind it. The scanner already measures every local
 * branch against the default one, so this is a list of what that pass found
 * rather than a second read.
 *
 * The trigger is the branch name in the title, the way every other client does
 * it, rather than a "Branches" button four commands to the right of the name it
 * was about. With no commits there is no branch to stand on and nothing to list,
 * so the name is plain text.
 */
export default function BranchMenu({
  repo,
  shell,
  squashed,
  onCommand,
  onDeleteBranch,
  onCopy,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useContextMenu<BranchSummary>();

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      // A right-click menu over a row renders outside the popup, and a click
      // on one of its items must not close the list it was opened from.
      if (target instanceof Element && target.closest(".row-menu")) return;
      if (!wrap.current?.contains(target)) setOpen(false);
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
  // A squash-merged branch is not contained by anything, so the scanner reads
  // it as outstanding work. It is not: the work is on the trunk under another
  // commit, and counting it here is what made this button shout about branches
  // that were finished weeks ago.
  const squashedBy = new Map(squashed.map((s) => [s.branch, s]));
  const outstanding = repo.branches.filter(
    (b) => !b.isHead && !b.merged && !squashedBy.has(b.name),
  ).length;

  if (!repo.branch) return <span className="branch-name">no commits</span>;

  // The row's click, the name, and the one thing the row has no button for.
  function rowMenu(branch: BranchSummary): MenuEntry[] {
    const switchTo = `git switch ${quote(branch.name, shell)}`;
    return [
      {
        label: "Switch to it",
        title: branch.isHead ? "You are here." : switchTo,
        disabled: branch.isHead,
        run: (typeOnly) => {
          onCommand(switchTo, typeOnly);
          if (!typeOnly) setOpen(false);
        },
      },
      { label: "Copy branch name", run: () => onCopy(branch.name, "the branch name") },
      "-",
      {
        label: "Delete branch",
        danger: true,
        disabled: branch.isHead,
        title: branch.isHead ? "You are on it. Switch away first." : "Asks first, and names the command.",
        run: () => {
          setOpen(false);
          onDeleteBranch(branch.name);
        },
      },
    ];
  }

  return (
    <div className="branch-menu" ref={wrap}>
      <button
        className={`branch-name${outstanding > 0 ? " has-other" : ""}${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${count} local ${count === 1 ? "branch" : "branches"}, measured against ${base}`}
      >
        {repo.branch}
        {count > 1 && <span className="branch-count">{count}</span>}
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
              squashed={squashedBy.get(branch.name) ?? null}
              shell={shell}
              onCommand={(command, typeOnly) => {
                onCommand(command, typeOnly);
                if (!typeOnly) setOpen(false);
              }}
              onMenu={menu.open}
            />
          ))}
        </div>
      )}

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.name}`}
          entries={rowMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </div>
  );
}

function BranchRow({
  branch,
  squashed,
  shell,
  onCommand,
  onMenu,
}: {
  branch: BranchSummary;
  squashed: Squashed | null;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
  onMenu: (event: ReactMouseEvent, branch: BranchSummary) => void;
}) {
  const command = `git switch ${quote(branch.name, shell)}`;
  return (
    <button
      className={`branch-pop-row${branch.isHead ? " current" : ""}`}
      disabled={branch.isHead}
      onClick={(event) => onCommand(command, event.shiftKey)}
      onContextMenu={(event) => onMenu(event, branch)}
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
        {/* On this disk and nowhere else. A branch with no upstream says so
            rather than counting, since every commit on it is unpushed. */}
        {branch.upstream && branch.aheadOfUpstream > 0 && (
          <span className="chip unpushed" title={`${branch.aheadOfUpstream} commits past ${branch.upstream}`}>
            ⇡{branch.aheadOfUpstream}
          </span>
        )}
        {!branch.upstream && !branch.merged && (
          <span className="chip unpushed" title="No upstream. Nothing on this branch has been pushed.">
            local
          </span>
        )}
        {branch.merged && (
          <span className="chip merged" title="Already contained in the default branch">
            merged
          </span>
        )}
        {!branch.merged && squashed && (
          <span
            className="chip squashed"
            title={`Squashed into ${squashed.intoShort} on ${squashed.base}
${squashed.intoSummary}

git has no link between the two. GitView matched the patch.`}
          >
            squashed
          </span>
        )}
      </span>
      <span className="branch-pop-when">{relativeTime(branch.lastCommitAt)}</span>
    </button>
  );
}
