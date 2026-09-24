/**
 * How a terminal session is named.
 *
 * The first shell in a repository has the repository's path as its id, which
 * is what every session was called until 16 Sep 2026 and what the Rust side,
 * the block records and the live set still see. A second shell in the same
 * folder is `path#2`, a third `path#3`: the same path with a number on it, so
 * the repository a session belongs to can be read back off its id without a
 * table. Rust already takes the id and the working directory as two arguments,
 * so it needs nothing new.
 *
 * The Claude tab is `path#claude`: a shell like the others, which types
 * `claude` once it is live. It is not a numbered shell, so a command aimed at
 * the repository never lands in it. See the Terminal note in the wiki.
 */

const SUFFIX = /#(\d+|claude)$/;
const CLAUDE = "#claude";

/** The repository a session belongs to. */
export function sessionRepo(id: string): string {
  return id.replace(SUFFIX, "");
}

/** The Claude tab's id in a repository. */
export function claudeId(repoPath: string): string {
  return repoPath + CLAUDE;
}

/** Whether this session is a repository's Claude tab. */
export function isClaude(id: string): boolean {
  return id.endsWith(CLAUDE);
}

/** Which shell in its repository this is, counting from 1. The Claude tab is 0. */
export function sessionNumber(id: string): number {
  if (isClaude(id)) return 0;
  const match = SUFFIX.exec(id);
  return match ? Number(match[1]) : 1;
}

/** Where a tab sits: the first shell, then Claude, then the numbered rest. */
function position(id: string): number {
  return isClaude(id) ? 1.5 : sessionNumber(id);
}

/** The id of the nth shell in a repository. The first is the path itself. */
export function sessionId(repoPath: string, n: number): string {
  return n <= 1 ? repoPath : `${repoPath}#${n}`;
}

/** "shell", "shell 2", "Claude": what the tab says. */
export function sessionLabel(id: string): string {
  if (isClaude(id)) return "Claude";
  const n = sessionNumber(id);
  return n === 1 ? "shell" : `shell ${n}`;
}

/** The ids that belong to a repository, out of every id there is, first to last. */
export function sessionsOf(repoPath: string, ids: Iterable<string>): string[] {
  return [...ids]
    .filter((id) => sessionRepo(id) === repoPath)
    .sort((a, b) => position(a) - position(b));
}

/**
 * The id for one more shell in a repository: one past the highest still
 * open, so the tabs read in the order they were opened. A closed shell's
 * number comes back once nothing above it is open.
 */
export function nextSessionId(repoPath: string, ids: Iterable<string>): string {
  const highest = sessionsOf(repoPath, ids).reduce((max, id) => Math.max(max, sessionNumber(id)), 0);
  return sessionId(repoPath, Math.max(2, highest + 1));
}

/**
 * The shell a command aimed at a repository is typed into.
 *
 * Only a shell at its prompt will do. `busy` says a typed command still holds
 * one: `claude`, any other CLI that reads its own input, a dev server. Text
 * sent there becomes that program's input, so `git fetch` would land in a
 * conversation. The Claude tab never qualifies, even between runs.
 *
 * The tab on screen wins when it is free, so a command stays where you are
 * looking. Otherwise it is the first free shell in the folder, which is the
 * first shell when nothing has opened it yet, and past those a new one.
 */
export function pickShell(
  repoPath: string,
  onScreen: string,
  ids: Iterable<string>,
  busy: (id: string) => boolean,
): string {
  const free = (id: string) => !isClaude(id) && !busy(id);
  if (sessionRepo(onScreen) === repoPath && free(onScreen)) return onScreen;
  const all = [...ids];
  return sessionsOf(repoPath, new Set([repoPath, ...all])).find(free) ?? nextSessionId(repoPath, all);
}
