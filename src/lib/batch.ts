/**
 * What a fleet-wide sync or prune is going to do, decided before it does it.
 *
 * Every other action in GitView types its command into a shell, where the user
 * reads the output. Twelve repositories cannot: one shell would serialise them
 * behind whatever is already at that prompt, and twelve shells would interleave
 * twenty-four commands with no way to tell which line came from which project.
 * So a batch runs through `git_run` and keeps a transcript instead, and the
 * transcript owes the user everything a shell would have shown: the command as
 * typed, the exit code, and every line git wrote.
 *
 * The planning half lives here, apart from the running half, because it is the
 * part with a wrong answer. A repository that is skipped has to say why in words
 * that name the state it is in.
 */

import { api } from "./api";
import type { GitOutcome, RepoState, Squashed } from "./types";

export type BatchKind = "fetch" | "sync" | "prune";

/** A command to run, or the reason there is nothing to run. */
export type Plan = { args: string[]; command: string } | { skip: string };

function run(args: string[]): Plan {
  return { args, command: `git ${args.join(" ")}` };
}

export function isSkip(plan: Plan): plan is { skip: string } {
  return "skip" in plan;
}

/**
 * Fetching is read-only against the local repository, so the only reasons to
 * skip it are that there is nothing to fetch from or nothing to fetch into.
 */
export function fetchPlan(repo: RepoState): Plan {
  if (repo.error) return { skip: "unreadable" };
  if (!repo.remoteUrl) return { skip: "no remote" };
  return run(["fetch", "--prune"]);
}

/**
 * Whether this repository can be fast-forwarded, read from state that is fresh
 * out of the fetch rather than out of the last sweep.
 *
 * `--ff-only` would refuse a diverged branch on its own, which is the whole
 * safety argument for the Sync button. Deciding here as well is not for safety,
 * it is so the transcript says `diverged, 2 ahead and 5 behind` rather than
 * eleven lines of git telling the user to specify how to reconcile.
 *
 * Untracked files are not counted as uncommitted work: a fast-forward that
 * would land a file on top of one is refused by git, and every other untracked
 * file is irrelevant to the pull. Counting them would skip the average
 * repository with a stray log in it.
 */
export function pullPlan(repo: RepoState): Plan {
  if (repo.detached) return { skip: "detached HEAD, so there is no branch to move" };
  if (!repo.upstream) return { skip: "no upstream" };
  if (repo.behind === 0) return { skip: "already up to date" };
  if (repo.ahead > 0) {
    return { skip: `diverged, ${repo.ahead} ahead and ${repo.behind} behind` };
  }
  const dirty = repo.staged + repo.modified + repo.conflicted;
  if (dirty > 0) {
    return { skip: `${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}` };
  }
  return run(["pull", "--ff-only"]);
}

/**
 * The branches a single-repository prune would delete, and how.
 *
 * Two lists, because they take different flags. A branch the trunk already
 * contains goes through `git branch -d`, which refuses anything unmerged and is
 * the whole safety story in [[Batch Operations]]. A squash-merged branch is not
 * contained by anything, so `-d` refuses it too and it needs `-D`. That swaps
 * git's judgement for GitView's, which is why the two are never mixed into one
 * command: the dialog has to be able to say which branches are on which flag.
 */
export interface PruneSplit {
  merged: string[];
  squashed: string[];
}

export function pruneSplit(repo: RepoState, squashed: Squashed[]): PruneSplit {
  const contained = new Set(repo.mergedBranches);
  return {
    merged: repo.mergedBranches,
    squashed: squashed
      // A remote-tracking ref is drawn in the history and is not a branch
      // `git branch -D` can touch; `git push origin --delete` is a different
      // action against somebody else's copy and is not one to fold in here.
      .filter((s) => !s.protected && !s.remote && !contained.has(s.branch))
      .map((s) => s.branch),
  };
}

/** The commands that prune leaves in the shell, in the order they run. */
export function pruneCommands(split: PruneSplit): string[] {
  const out: string[] = [];
  if (split.merged.length > 0) out.push(`git branch -d ${split.merged.join(" ")}`);
  if (split.squashed.length > 0) out.push(`git branch -D ${split.squashed.join(" ")}`);
  return out;
}

/**
 * The fleet-wide prune stays on `-d` and on ancestry alone.
 *
 * A batch runs out of sight across twelve repositories, and its safety comes
 * from `git branch -d` refusing anything it is not certain about. Detecting a
 * squash costs a patch id per branch against recent history, which is a read
 * the sweep deliberately does not do, and `-D` across twelve repositories with
 * nobody watching is not a trade worth making for it. Squash-merged branches
 * are offered one repository at a time, where the dialog can name them.
 */
export function prunePlan(repo: RepoState): Plan {
  if (repo.error) return { skip: "unreadable" };
  if (repo.mergedBranches.length === 0) return { skip: "nothing merged to delete" };
  return run(["branch", "-d", ...repo.mergedBranches]);
}

/** One command a batch ran, or decided not to. */
export interface BatchStep {
  label: "fetch" | "pull" | "prune";
  /** The command as typed, whether or not it ran. */
  command: string | null;
  /** Null while it has not finished, and when it was skipped. */
  outcome: GitOutcome | null;
  /** Why it did not run. Null when it did. */
  skipped: string | null;
}

export interface BatchRow {
  path: string;
  name: string;
  state: "waiting" | "running" | "done";
  steps: BatchStep[];
  /** What happened, in the fewest words that are still true. */
  headline: string;
  failed: boolean;
}

export interface BatchRun {
  kind: BatchKind;
  rows: BatchRow[];
  /** Rows finished, so the dialog can count without scanning them. */
  done: number;
  running: boolean;
  /** Stopped between repositories. Whatever had run stays in the transcript. */
  cancelled: boolean;
}

export function newRun(kind: BatchKind, repos: RepoState[]): BatchRun {
  return {
    kind,
    rows: repos.map((repo) => ({
      path: repo.path,
      name: repo.name,
      state: "waiting",
      steps: [],
      headline: "",
      failed: false,
    })),
    done: 0,
    running: true,
    cancelled: false,
  };
}

/** The row a transcript should show for a repository, before anything ran. */
export function previewOf(kind: BatchKind, repo: RepoState): string {
  if (kind === "prune") {
    const plan = prunePlan(repo);
    return isSkip(plan)
      ? plan.skip
      : `${repo.mergedBranches.length} merged ${
          repo.mergedBranches.length === 1 ? "branch" : "branches"
        }`;
  }

  const fetch = fetchPlan(repo);
  if (isSkip(fetch)) return fetch.skip;
  if (kind === "fetch") return "fetch";

  // The counts are from the last sweep, so anything said about the pull here is
  // a guess. The exceptions are worth naming; the ordinary row is not, and on a
  // fleet whose remote refs are a day old it is almost every row. It says what
  // will certainly happen and leaves the rest to the transcript.
  if (repo.detached) return "fetch only, detached HEAD";
  if (!repo.upstream) return "fetch only, no upstream";
  if (repo.behind > 0 && repo.ahead > 0) {
    return `fetch only, diverged by ${repo.ahead} and ${repo.behind}`;
  }
  if (repo.behind > 0) return `${repo.behind} to pull, as of the last scan`;
  return "fetch";
}

/**
 * The transcript as text, because the recovery record for a prune is in it.
 *
 * `git branch -d` prints `Deleted branch X (was abc1234)` for each branch, and
 * those hashes are the only way back. In a shell they would sit in the
 * scrollback; here they sit in a dialog that closes, so they have to be
 * copyable.
 */
export function transcriptText(run: BatchRun): string {
  const lines: string[] = [];
  for (const row of run.rows) {
    lines.push(`${row.name}  ${row.headline || row.state}`);
    lines.push(`  ${row.path}`);
    for (const step of row.steps) {
      if (step.skipped) {
        lines.push(`  ${step.label}: skipped, ${step.skipped}`);
        continue;
      }
      lines.push(`  ${step.command}`);
      if (step.outcome) {
        lines.push(`  exit ${step.outcome.code}`);
        const output = stepOutput(step);
        for (const line of output.split("\n")) {
          if (line.trim()) lines.push(`    ${line}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * What git wrote, from whichever stream it used.
 *
 * `git fetch` and `git pull` write their progress to stderr on success, so
 * reading stdout alone shows an empty transcript for a run that worked.
 */
export function stepOutput(step: BatchStep): string {
  if (!step.outcome) return "";
  const stdout = step.outcome.stdout.trim();
  const stderr = step.outcome.stderr.trim();
  if (stdout && stderr) return `${stdout}\n${stderr}`;
  return stdout || stderr;
}

/**
 * Runs one command, or records that it was skipped.
 *
 * `git_run` resolves with an exit code rather than throwing, so `code` is what
 * says whether this worked. The catch is for the narrower case of the command
 * itself failing to start, and it lands in the same shape so the transcript has
 * one thing to render.
 */
async function exec(path: string, label: BatchStep["label"], plan: Plan): Promise<BatchStep> {
  if (isSkip(plan)) {
    return { label, command: null, outcome: null, skipped: plan.skip };
  }
  const outcome = await api.gitRun(path, plan.args).catch(
    (err): GitOutcome => ({
      code: -1,
      stdout: "",
      stderr: String(err),
      command: plan.command,
    }),
  );
  return { label, command: plan.command, outcome, skipped: null };
}

async function reread(
  path: string,
  onState: (state: RepoState) => void,
): Promise<RepoState | null> {
  try {
    const state = await api.repoRefresh(path);
    onState(state);
    return state;
  } catch {
    // A row that fails to re-read is a stale row, not a failed operation.
    return null;
  }
}

export interface RepoResult {
  steps: BatchStep[];
  headline: string;
  failed: boolean;
}

/**
 * One repository's share of a batch, start to finish.
 *
 * The sidebar row is updated through `onState` as each command lands rather than
 * after the whole sweep, so a fleet-wide sync visibly works its way down the
 * list instead of changing everything at the end.
 */
export async function runRepo(
  kind: BatchKind,
  repo: RepoState,
  onState: (state: RepoState) => void,
): Promise<RepoResult> {
  if (kind === "prune") {
    const step = await exec(repo.path, "prune", prunePlan(repo));
    if (step.skipped) return { steps: [step], headline: step.skipped, failed: false };
    const code = step.outcome?.code ?? -1;
    await reread(repo.path, onState);
    const count = repo.mergedBranches.length;
    return {
      steps: [step],
      headline:
        code === 0
          ? `deleted ${count} ${count === 1 ? "branch" : "branches"}`
          : `git branch -d exited ${code}`,
      failed: code !== 0,
    };
  }

  const fetch = await exec(repo.path, "fetch", fetchPlan(repo));
  if (fetch.skipped) return { steps: [fetch], headline: fetch.skipped, failed: false };
  const fetchCode = fetch.outcome?.code ?? -1;
  if (fetchCode !== 0) {
    return { steps: [fetch], headline: `fetch exited ${fetchCode}`, failed: true };
  }

  // Read after the fetch, not before it. The counts the pull turns on are the
  // ones a fetch has just changed, so deciding from the last sweep would skip a
  // repository that became fast-forwardable a second ago.
  const fresh = (await reread(repo.path, onState)) ?? repo;

  if (kind === "fetch") {
    return {
      steps: [fetch],
      headline: fresh.behind > 0 ? `${fresh.behind} to pull` : "up to date",
      failed: false,
    };
  }

  const pull = await exec(repo.path, "pull", pullPlan(fresh));
  if (pull.skipped) {
    return { steps: [fetch, pull], headline: `fetched, ${pull.skipped}`, failed: false };
  }
  const pullCode = pull.outcome?.code ?? -1;
  await reread(repo.path, onState);
  return {
    steps: [fetch, pull],
    headline:
      pullCode === 0
        ? `pulled ${fresh.behind} ${fresh.behind === 1 ? "commit" : "commits"}`
        : `pull exited ${pullCode}`,
    failed: pullCode !== 0,
  };
}

/** The word for what a batch is about to do, for a button and a heading. */
export const verbFor: Record<BatchKind, string> = {
  fetch: "Fetch",
  sync: "Sync",
  prune: "Prune",
};
