/**
 * Clean up: every branch but the one you are on, with what deleting it takes.
 *
 * The planning half, apart from the dialog because it is the part with a wrong
 * answer. It decides what each branch is, whether it starts ticked, and the
 * lines that get typed. Nothing here touches the repository, and nothing runs
 * out of sight: the commands land in the shell like every other single-repository
 * action, which is where `Deleted branch x (was abc1234)` belongs.
 *
 * A tick starts on only for a branch that is provably finished and a worktree
 * with nothing in it to lose. Anything else can still be ticked by hand, since
 * "delete everything but main" is a thing somebody is allowed to want. The one
 * exception is a folder something still has open: git would stop at a question
 * with the rest of the commands queued behind it, and answering no leaves the
 * worktree half gone.
 *
 * A row says all this in tags, using the branch menu's words. The whole sentence
 * is the tag's title, for the moment one is wanted.
 */

import { isSkip, pullPlan } from "./batch";
import { quote, type ShellKind } from "./shell";
import type { CleanupRead, RepoState, Squashed, WorktreeCheck, WorktreeSummary } from "./types";

/**
 * How sure the row is that the branch is done with.
 *
 * `gone` is not a finding of its own, since anybody can delete a remote branch.
 * It starts unticked until something proves the work landed. `fresh` is a
 * worktree whose branch sits exactly on the trunk: the same reading as a branch
 * long merged, and also what a Claude session that started a minute ago looks
 * like, so it never starts ticked.
 */
export type Verdict = "contained" | "squashed" | "gone" | "fresh" | "unfinished" | "detached";

/** A word on a row. `chip` is the `.chip` colour, the same ones the branch menu uses. */
export interface RowTag {
  label: string;
  chip: "merged" | "squashed" | "ahead" | "unpushed" | "dirty" | "conflict";
  /** The sentence the word stands for. */
  title: string;
  /** About origin's copy, so it goes away when deleting there is switched off. */
  origin?: boolean;
}

export interface CleanupRow {
  /** Stable across a re-read, so a tick survives the fetch finishing. */
  key: string;
  label: string;
  /** The local branch to delete, when there is one. */
  branch: string | null;
  /** Its name on origin, when origin has it. */
  remote: string | null;
  verdict: Verdict;
  /** Ready: it starts ticked. */
  ticked: boolean;
  /** A linked worktree to take away first. Never the main checkout. */
  worktree: WorktreeSummary | null;
  check: WorktreeCheck | null;
  /** Why it cannot be ticked at all. */
  blocked: string | null;
  tags: RowTag[];
  lastCommitAt: number | null;
}

/** What GitView's own shells in a folder are doing. Null is none open there. */
export type ShellState = "idle" | "busy" | null;

/** Past this a `git restore` line stops being readable, and a stash does the job as well. */
const MAX_RESTORED = 20;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function listed(names: string[], total: number): string {
  const extra = total - names.length;
  return extra > 0 ? `${names.join(", ")} and ${extra} more` : names.join(", ");
}

/** What a worktree adds to its row, and whether anything stops it going at all. */
function worktreeFacts(
  worktree: WorktreeSummary,
  check: WorktreeCheck | null,
  shells: ShellState,
): { tags: RowTag[]; heldOpen: boolean; atRisk: boolean } {
  const tags: RowTag[] = [];
  let atRisk = worktree.locked;
  if (worktree.locked) {
    tags.push({
      label: "locked",
      chip: "dirty",
      title: `Locked${worktree.lockReason ? `: ${worktree.lockReason}` : ""}. Deleting it unlocks it first.`,
    });
  }
  if (worktree.prunable) {
    tags.push({
      label: "folder gone",
      chip: "merged",
      title: `Its worktree folder is already gone from ${worktree.path}. git worktree prune clears the record.`,
    });
    return { tags, heldOpen: false, atRisk };
  }

  const about = [`Checked out in the worktree at ${worktree.path}.`];
  const endings = check?.lineEndings ?? [];
  if (endings.length > 0 && (check?.changedCount ?? 0) === 0 && endings.length <= MAX_RESTORED) {
    about.push(`Only line endings changed, restored first: ${endings.join(", ")}.`);
  }
  if (shells === "idle") about.push("GitView's shell there closes first.");
  tags.unshift({ label: "worktree", chip: "merged", title: about.join("\n") });

  if (shells === "busy") {
    atRisk = true;
    tags.push({
      label: "running",
      chip: "dirty",
      title: "A GitView shell there has something running. It closes first, and whatever is running stops.",
    });
  }
  // GitView's own shell is the one holder that goes away before the remove.
  const heldOpen = shells === null && check?.inUse === true;
  if (heldOpen) {
    tags.push({
      label: "in use",
      chip: "conflict",
      title: "A program has this folder open, a Claude Code session or a terminal usually, so Windows will not delete it. Close that and open Clean up again.",
    });
  }
  if (check?.error) {
    atRisk = true;
    tags.push({ label: "unreadable", chip: "dirty", title: `Could not read its status: ${check.error}` });
    return { tags, heldOpen, atRisk };
  }
  if ((check?.changedCount ?? 0) > 0 && check) {
    atRisk = true;
    tags.push({
      label: `${check.changedCount} changed`,
      chip: "dirty",
      title: `Kept in a stash first: ${listed(check.changed, check.changedCount)}.`,
    });
  }
  if ((check?.ignoredCount ?? 0) > 0 && check) {
    tags.push({
      label: `${check.ignoredCount} ignored`,
      chip: "dirty",
      title: `Ignored files that go with it and are not kept: ${listed(check.ignored, check.ignoredCount)}.`,
    });
  }
  return { tags, heldOpen, atRisk };
}

/**
 * Every row the dialog lists: local branches, then worktrees holding no branch,
 * then branches only origin has.
 *
 * Only `origin` is touched. A branch tracking another remote is usually tracking
 * somebody else's fork, and a tidy-up has no business pushing a delete there.
 */
export function cleanupRows(
  repo: RepoState,
  squashed: Squashed[],
  read: CleanupRead,
  shellState: (path: string) => ShellState = () => null,
): CleanupRow[] {
  const trunk = repo.defaultBase ?? repo.defaultBranch ?? "the default branch";
  const checks = new Map(read.worktrees.map((c) => [c.path, c]));
  const onOrigin = new Map(read.remoteBranches.map((r) => [r.name, r]));
  const localSquash = new Map(
    squashed.filter((s) => !s.remote && !s.protected).map((s) => [s.branch, s]),
  );
  const remoteSquash = new Map(squashed.filter((s) => s.remote).map((s) => [s.branch, s]));

  const rows: CleanupRow[] = [];

  for (const branch of repo.branches) {
    if (branch.isHead || branch.name === repo.defaultBranch) continue;

    const holder = branch.worktree
      ? (repo.worktrees.find((w) => w.path === branch.worktree) ?? null)
      : null;
    const linked = holder && !holder.main ? holder : null;
    const check = linked ? (checks.get(linked.path) ?? null) : null;
    const squash = localSquash.get(branch.name);
    const ahead = `${plural(branch.ahead, "commit")} not in ${trunk}`;

    let verdict: Verdict;
    const tags: RowTag[] = [];
    if (linked && !linked.prunable && branch.ahead === 0 && branch.behind === 0) {
      verdict = "fresh";
      tags.push({
        label: "new",
        chip: "merged",
        title: `No commits of its own and level with ${trunk}, so a session may have just started here.`,
      });
    } else if (branch.merged) {
      verdict = "contained";
      tags.push({ label: "merged", chip: "merged", title: `Already in ${trunk}.` });
    } else if (squash) {
      verdict = "squashed";
      tags.push({
        label: "squashed",
        chip: "squashed",
        title: `Squash-merged as ${squash.intoShort} on ${squash.base}: ${squash.intoSummary}`,
      });
    } else if (branch.goneUpstream) {
      verdict = "gone";
      tags.push({
        label: "gone",
        chip: "merged",
        title: `${branch.goneUpstream} is gone from the remote, and nothing matched its ${plural(branch.ahead, "commit")} on ${trunk}.`,
      });
    } else {
      verdict = "unfinished";
      tags.push({ label: `↑${branch.ahead}`, chip: "ahead", title: `${ahead}.` });
      if (!branch.upstream) {
        tags.push({ label: "local", chip: "unpushed", title: "Never pushed. These commits are on this disk alone." });
      } else if (branch.aheadOfUpstream > 0) {
        tags.push({
          label: `⇡${branch.aheadOfUpstream}`,
          chip: "unpushed",
          title: `${plural(branch.aheadOfUpstream, "commit")} past ${branch.upstream}, on this disk alone.`,
        });
      }
    }
    const finished = verdict === "contained" || verdict === "squashed";

    const facts = linked
      ? worktreeFacts(linked, check, shellState(linked.path))
      : { tags: [], heldOpen: false, atRisk: false };
    tags.push(...facts.tags);

    // Origin's copy can have moved on from this one, and a delete takes that too.
    const copy = onOrigin.get(branch.name);
    const copyAhead =
      branch.originTip !== null &&
      branch.originTip !== branch.tip &&
      !remoteSquash.has(`origin/${branch.name}`) &&
      (copy?.ahead ?? 1) !== 0;
    if (branch.originTip) {
      tags.push(
        copyAhead
          ? {
              label: "origin ahead",
              chip: "dirty",
              origin: true,
              title: `origin/${branch.name} has moved on from this branch, and those commits are not in ${trunk}. Deleting it takes them too.`,
            }
          : { label: "origin", chip: "merged", origin: true, title: `Also deletes origin/${branch.name}.` },
      );
    }

    let blocked: string | null = null;
    if (holder?.main) {
      blocked = `Checked out in the main checkout at ${holder.path}. Switch that checkout to another branch first.`;
      tags.push({ label: "main checkout", chip: "merged", title: blocked });
    } else if (facts.heldOpen) {
      blocked = "A program has this folder open. Close it and open Clean up again.";
    }

    rows.push({
      key: branch.name,
      label: branch.name,
      branch: branch.name,
      remote: branch.originTip ? branch.name : null,
      verdict,
      ticked: finished && blocked === null && !copyAhead && !facts.atRisk,
      worktree: linked,
      check,
      blocked,
      tags,
      lastCommitAt: branch.lastCommitAt,
    });
  }

  for (const worktree of repo.worktrees) {
    if (worktree.main || worktree.branch !== null) continue;
    const check = checks.get(worktree.path) ?? null;
    const facts = worktreeFacts(worktree, check, shellState(worktree.path));
    rows.push({
      key: worktree.path,
      label: worktree.path.split(/[\\/]/).pop() || worktree.path,
      branch: null,
      remote: null,
      verdict: "detached",
      ticked: worktree.prunable && !worktree.locked,
      worktree,
      check,
      blocked: facts.heldOpen ? "A program has this folder open. Close it and open Clean up again." : null,
      tags: [
        { label: "detached", chip: "merged", title: "A worktree on no branch. A commit made only there goes with it." },
        ...facts.tags,
      ],
      lastCommitAt: null,
    });
  }

  const locals = new Set(repo.branches.map((b) => b.name));
  for (const remote of read.remoteBranches) {
    if (locals.has(remote.name)) continue;
    const squash = remoteSquash.get(`origin/${remote.name}`);
    const contained = remote.ahead === 0;
    const tag: RowTag = contained
      ? { label: "merged", chip: "merged", title: `Only on origin, and already in ${trunk}.` }
      : squash
        ? {
            label: "squashed",
            chip: "squashed",
            title: `Only on origin. Squash-merged as ${squash.intoShort} on ${squash.base}: ${squash.intoSummary}`,
          }
        : remote.ahead === null
          ? { label: "unmeasured", chip: "merged", title: "Only on origin, with no default branch here to measure it against." }
          : {
              label: `↑${remote.ahead}`,
              chip: "ahead",
              title: `Only on origin, with ${plural(remote.ahead, "commit")} not in ${trunk}.`,
            };
    rows.push({
      key: `origin/${remote.name}`,
      label: `origin/${remote.name}`,
      branch: null,
      remote: remote.name,
      verdict: contained ? "contained" : squash ? "squashed" : "unfinished",
      ticked: contained || squash !== undefined,
      worktree: null,
      check: null,
      blocked: null,
      tags: [tag],
      lastCommitAt: remote.lastCommitAt,
    });
  }

  return rows;
}

/**
 * The lines to type, in the order they have to run.
 *
 * The pull comes first because `git branch -d` judges a branch against HEAD, and
 * a `main` one fetch behind would refuse work that is on origin/main. A worktree
 * has to go before its branch, and the record of a gone one before anything else
 * touches a branch it names.
 *
 * Line endings get `git restore` and a plain remove rather than `--force`, so a
 * file that changed since the dialog read it still makes git refuse. A stash
 * rather than `--force` for the same reason, and because a stash outlives the
 * worktree: `git stash list` from the main checkout still has it.
 */
export function cleanupCommands(
  rows: CleanupRow[],
  options: { kind: ShellKind; pull: boolean; withRemote: boolean },
): string[] {
  const { kind, pull, withRemote } = options;
  const q = (text: string) => quote(text, kind);
  const out: string[] = pull ? ["git pull --ff-only"] : [];

  const held = rows.filter((row) => row.worktree);
  for (const row of held) {
    if (row.worktree?.locked) out.push(`git worktree unlock ${q(row.worktree.path)}`);
  }
  if (held.some((row) => row.worktree?.prunable)) out.push("git worktree prune");

  for (const row of held) {
    const worktree = row.worktree;
    if (!worktree || worktree.prunable) continue;
    const path = q(worktree.path);
    const changed = row.check?.changedCount ?? 0;
    const endings = row.check?.lineEndings ?? [];
    if (changed > 0 || endings.length > MAX_RESTORED) {
      out.push(`git -C ${path} stash push -u -m ${q(`GitView: before removing ${row.label}`)}`);
    } else if (endings.length > 0) {
      out.push(`git -C ${path} restore -- ${endings.map(q).join(" ")}`);
    }
    // git will not remove a worktree holding submodules without it, whatever
    // else is true, and the stash above has already kept anything changed.
    out.push(`git worktree remove ${row.check?.submodules ? "--force " : ""}${path}`);
  }

  const contained = rows.filter((row) => row.branch && row.verdict === "contained");
  const forced = rows.filter((row) => row.branch && row.verdict !== "contained");
  const names = (list: CleanupRow[]) => list.map((row) => q(row.branch as string)).join(" ");
  if (contained.length > 0) out.push(`git branch -d ${names(contained)}`);
  if (forced.length > 0) out.push(`git branch -D ${names(forced)}`);

  if (withRemote) {
    const remotes = rows.flatMap((row) => (row.remote ? [row.remote] : []));
    if (remotes.length > 0) out.push(`git push origin --delete ${remotes.map(q).join(" ")}`);
  }
  return out;
}

/** Whether the shell is on the default branch and a pull would bring it level. */
export function pullFirst(repo: RepoState): boolean {
  return repo.branch === repo.defaultBranch && !isSkip(pullPlan(repo));
}

/** What the confirm button says it is about to do. */
export function confirmLabel(rows: CleanupRow[], withRemote: boolean): string {
  const branches = rows.filter((row) => row.branch || (withRemote && row.remote)).length;
  if (branches > 0) return `Delete ${plural(branches, "branch", "branches")}`;
  const worktrees = rows.filter((row) => row.worktree).length;
  return worktrees > 0 ? `Remove ${plural(worktrees, "worktree")}` : "Delete";
}

/**
 * The finished branches, for the count on the button.
 *
 * Read from what the sweep and the squash read already hold, since the button
 * is on screen long before the dialog's own reads run. A worktree level with the
 * trunk is left out for the same reason its row starts unticked.
 */
export function finishedCount(repo: RepoState, squashed: Squashed[]): number {
  const squash = new Set(squashed.filter((s) => !s.remote && !s.protected).map((s) => s.branch));
  const main = repo.worktrees.find((w) => w.main)?.path;
  return repo.branches.filter((b) => {
    if (b.isHead || b.name === repo.defaultBranch || (main && b.worktree === main)) return false;
    if (b.worktree && b.ahead === 0 && b.behind === 0) return false;
    return b.merged || squash.has(b.name);
  }).length;
}

/** Whether there is anything for the dialog to list. */
export function hasOtherBranches(repo: RepoState): boolean {
  return (
    repo.remoteOnlyBranches > 0 ||
    repo.worktrees.some((w) => !w.main) ||
    repo.branches.some((b) => !b.isHead && b.name !== repo.defaultBranch)
  );
}
