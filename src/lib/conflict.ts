import { quote, type ShellKind } from "./shell";
import type { Operation } from "./types";

/**
 * Reading a file git left conflict markers in.
 *
 * git writes each conflict as `<<<<<<< ours`, the ours lines, an optional
 * `||||||| base` with the base lines (diff3 and zdiff3), `=======`, the theirs
 * lines, then `>>>>>>> theirs`. The roles here follow the file line by line so
 * the pane can tint each side and label it where it starts.
 */
export type ConflictRole =
  | "ours-start"
  | "ours"
  | "base-start"
  | "base"
  | "split"
  | "theirs"
  | "theirs-end";

/** git's marker, seven characters, then a space and a label or nothing. */
function marker(text: string, char: string): boolean {
  const line = text.replace(/\r$/, "");
  const seven = char.repeat(7);
  return line === seven || line.startsWith(`${seven} `);
}

/**
 * One role per line, or null outside a conflict. A marker git would not have
 * written there (a `=======` in ordinary text, a `>>>>>>>` with no opening) is
 * left as text, since an AsciiDoc rule or a quoted email is not a conflict.
 */
export function conflictRoles(lines: string[]): (ConflictRole | null)[] {
  const roles: (ConflictRole | null)[] = [];
  let state: "out" | "ours" | "base" | "theirs" = "out";
  for (const text of lines) {
    if (state === "out") {
      if (marker(text, "<")) {
        state = "ours";
        roles.push("ours-start");
      } else roles.push(null);
    } else if (state === "ours" || state === "base") {
      if (state === "ours" && marker(text, "|")) {
        state = "base";
        roles.push("base-start");
      } else if (marker(text, "=")) {
        state = "theirs";
        roles.push("split");
      } else roles.push(state);
    } else if (marker(text, ">")) {
      state = "out";
      roles.push("theirs-end");
    } else roles.push("theirs");
  }
  return roles;
}

/** How many conflicts are still in the file: every opening marker git wrote. */
export function countConflicts(lines: string[]): number {
  return conflictRoles(lines).filter((role) => role === "ours-start").length;
}

/** One side of a conflict: what it is called and what it is in this operation. */
export interface ConflictSide {
  /** A branch name or a short sha, what the side's button keeps. */
  name: string;
  /** What that side is, for the title: "the branch you are rebasing onto". */
  role: string;
}

/**
 * Which side is which, for the operation git is paused in.
 *
 * In a merge, ours is the branch you are on and theirs is the one coming in.
 * A rebase swaps them: git replays your commits onto the new base, so ours is
 * the base being built on and theirs is your own commit. Labelling the buttons
 * "ours" and "theirs" in a rebase is how people keep the wrong half, so the
 * labels are the names.
 */
export function conflictSides(
  op: Operation | null,
  head: string | null,
): { ours: ConflictSide; theirs: ConflictSide } {
  const here = head ?? "HEAD";
  switch (op?.kind) {
    case "rebase":
      return {
        ours: { name: op.onto ?? "the new base", role: "the base you are rebasing onto" },
        theirs: {
          name: op.branch ?? "your commit",
          role: `your commit being replayed${op.branch ? ` from ${op.branch}` : ""}`,
        },
      };
    case "merge":
      return {
        ours: { name: here, role: "the branch you are on" },
        theirs: { name: op.onto ?? "incoming", role: "the branch being merged in" },
      };
    case "cherry-pick":
      return {
        ours: { name: here, role: "the branch you are on" },
        theirs: { name: op.onto ?? "the commit", role: "the commit being picked" },
      };
    case "revert":
      return {
        ours: { name: here, role: "the branch you are on" },
        theirs: {
          name: `revert of ${op.onto ?? "the commit"}`,
          role: "the commit's change, undone",
        },
      };
    default:
      return {
        ours: { name: here, role: "HEAD" },
        theirs: { name: "incoming", role: "the other side" },
      };
  }
}

/**
 * Keep one whole side of a conflicted file, then mark it resolved.
 *
 * `git add` on a file that still has markers marks the markers resolved, so
 * the add runs only if the checkout succeeded: `&&` in POSIX, `if ($?)` in
 * Windows PowerShell 5.1, which has no `&&`.
 */
export function keepSideCommand(side: "ours" | "theirs", file: string, shell: ShellKind): string {
  const arg = quote(file, shell);
  const checkout = `git checkout --${side} -- ${arg}`;
  const add = `git add -- ${arg}`;
  return shell === "powershell" ? `${checkout}; if ($?) { ${add} }` : `${checkout} && ${add}`;
}
