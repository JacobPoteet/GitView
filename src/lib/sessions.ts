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
 */

const SUFFIX = /#(\d+)$/;

/** The repository a session belongs to. */
export function sessionRepo(id: string): string {
  return id.replace(SUFFIX, "");
}

/** Which shell in its repository this is, counting from 1. */
export function sessionNumber(id: string): number {
  const match = SUFFIX.exec(id);
  return match ? Number(match[1]) : 1;
}

/** The id of the nth shell in a repository. The first is the path itself. */
export function sessionId(repoPath: string, n: number): string {
  return n <= 1 ? repoPath : `${repoPath}#${n}`;
}

/** "shell", "shell 2": what the tab says. */
export function sessionLabel(id: string): string {
  const n = sessionNumber(id);
  return n === 1 ? "shell" : `shell ${n}`;
}

/** The ids that belong to a repository, out of every id there is, first to last. */
export function sessionsOf(repoPath: string, ids: Iterable<string>): string[] {
  return [...ids]
    .filter((id) => sessionRepo(id) === repoPath)
    .sort((a, b) => sessionNumber(a) - sessionNumber(b));
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
