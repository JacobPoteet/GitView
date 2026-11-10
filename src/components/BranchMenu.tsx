import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import type { BranchScope, BranchSummary, RepoState, Squashed } from "../lib/types";
import { relativeTime } from "../lib/types";
import { quote, reviewCommand, type ShellKind } from "../lib/shell";

interface Props {
  repo: RepoState;
  shell: ShellKind;
  /** Branches the trunk swallowed through a squash, which it does not contain. */
  squashed: Squashed[];
  onCommand: (command: string, typeOnly: boolean) => void;
  /** Deleting asks first, and the app owns the dialog. */
  onDeleteBranch: (name: string, scope: BranchScope) => void;
  onCopy: (text: string, what: string) => void;
  /** Opens everything `head` changed since it left `base`, in the commit's column. */
  onReview: (base: string, head: string) => void;
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
  onReview,
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
    const held = branch.worktree;
    const remote = (branch.upstream ?? branch.goneUpstream)?.split("/")[0] || "origin";
    // A branch with an upstream has a copy there. Without one, only a ref under
    // origin says so, and typing a delete for nothing fails with exit 1.
    const hasRemote =
      repo.remoteUrl !== null && (branch.upstream !== null || branch.originTip !== null);
    const noRemote = branch.goneUpstream
      ? `${branch.goneUpstream} is already gone from the remote.`
      : repo.remoteUrl === null
        ? "No remote to delete from."
        : `Nothing on ${remote} to delete: this branch was never pushed.`;
    // The base the counts were measured against, so the review and the arrows
    // on the row answer the same question.
    const reviewBase = repo.defaultBase ?? repo.defaultBranch;
    const isBase =
      reviewBase !== null &&
      (branch.name === reviewBase || branch.name === repo.defaultBranch);
    const review = reviewBase ? reviewCommand(reviewBase, branch.name, shell) : null;
    return [
      {
        label: reviewBase ? `Review against ${reviewBase}` : "Review",
        title: !reviewBase
          ? "No default branch to measure against."
          : isBase
            ? `This is ${reviewBase}.`
            : `Every file ${branch.name} changed since it left ${reviewBase}, read here.

Shift-click types ${review}.`,
        disabled: !reviewBase || isBase,
        run: (typeOnly) => {
          if (!reviewBase || !review) return;
          setOpen(false);
          if (typeOnly) onCommand(review, true);
          else onReview(reviewBase, branch.name);
        },
      },
      "-",
      {
        label: "Check out",
        title: branch.isHead
          ? "You are here."
          : held
            ? `Checked out in the worktree at ${held}, and git will not put two checkouts on one branch.`
            : switchTo,
        disabled: branch.isHead || held !== null,
        run: (typeOnly) => {
          onCommand(switchTo, typeOnly);
          if (!typeOnly) setOpen(false);
        },
      },
      { label: "Copy branch name", run: () => onCopy(branch.name, "the branch name") },
      ...(held ? [{ label: "Copy worktree path", run: () => onCopy(held, "the worktree path") }] : []),
      "-",
      {
        label: "Delete local branch",
        danger: true,
        disabled: branch.isHead,
        title: branch.isHead
          ? "You are on it. Check out another branch first."
          : held
            ? `Checked out in the worktree at ${held}. Asks first, and names both commands: the worktree goes, then the branch.`
            : "Here only. Asks first, and names the command.",
        run: () => {
          setOpen(false);
          onDeleteBranch(branch.name, "local");
        },
      },
      {
        label: `Delete ${remote}/${branch.name}`,
        danger: true,
        disabled: !hasRemote,
        title: hasRemote
          ? `On ${remote} only; the local branch stays. Asks first, and names the command.`
          : noRemote,
        run: () => {
          setOpen(false);
          onDeleteBranch(branch.name, "remote");
        },
      },
      {
        label: "Delete local and remote",
        danger: true,
        disabled: branch.isHead || !hasRemote,
        title: branch.isHead
          ? "You are on it. Check out another branch first."
          : hasRemote
            ? "Both copies, one confirmation, both commands named."
            : noRemote,
        run: () => {
          setOpen(false);
          onDeleteBranch(branch.name, "both");
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
  // git refuses to switch to a branch another checkout has, so the click does
  // nothing and the title says where it is. The right-click menu still opens.
  const held = branch.worktree;
  // The row you are on switches nowhere, but it is not `disabled`: a disabled
  // button gets no contextmenu event, so its menu (copy, review) never opened.
  return (
    <button
      className={`branch-pop-row${branch.isHead ? " current" : ""}`}
      aria-disabled={branch.isHead}
      onClick={(event) => {
        if (!held && !branch.isHead) onCommand(command, event.shiftKey);
      }}
      onContextMenu={(event) => onMenu(event, branch)}
      title={
        branch.isHead
          ? "You are here. Right-click for its menu."
          : held
            ? `Checked out in the worktree at ${held}.\n\nRight-click to remove that worktree and delete the branch.`
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
        {!branch.upstream && !branch.goneUpstream && !branch.merged && (
          <span className="chip unpushed" title="No upstream. Nothing on this branch has been pushed.">
            local
          </span>
        )}
        {branch.goneUpstream && !branch.merged && !squashed && (
          <span
            className="chip merged"
            title={`It tracked ${branch.goneUpstream}, which is gone from the remote. A merged pull request usually leaves this, but nothing here has confirmed that it merged.`}
          >
            gone
          </span>
        )}
        {held && (
          <span className="chip merged" title={held}>
            worktree
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
