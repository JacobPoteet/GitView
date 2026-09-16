/**
 * Quoting for commands typed at a prompt.
 *
 * Every action in GitView types its command into the repository's shell rather
 * than running it behind the UI, which means a file path with a space in it and
 * a commit message with an apostrophe both have to survive the trip through
 * whatever shell is open. That shell is PowerShell on this machine and could be
 * a POSIX one elsewhere, so the quoting is chosen from what `app_info` reports.
 *
 * The Decision Log records the other half of this problem: a PowerShell
 * here-string handed to `git commit -m` as an argument got word-split by PS 5.1.
 * Nothing here builds an argument list for a subprocess. It builds a line of
 * text a person can read before it runs.
 */

import type { MergeMethod, Operation } from "./types";

export type ShellKind = "powershell" | "posix";

export function shellKind(shellPath: string | undefined): ShellKind {
  if (!shellPath) return "powershell";
  const name = shellPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return name.startsWith("pwsh") || name.startsWith("powershell") ? "powershell" : "posix";
}

/** One argument, quoted so the shell hands git exactly the text given. */
export function quote(value: string, kind: ShellKind): string {
  if (kind === "powershell") {
    // A single-quoted PowerShell string expands nothing at all. The only
    // character with meaning inside one is the quote itself, which doubles.
    return `'${value.replace(/'/g, "''")}'`;
  }
  // POSIX has no escape inside single quotes: close, emit a literal, reopen.
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * `git commit` with a message, as one line.
 *
 * A newline typed at a prompt submits the command, so a message with a body
 * cannot be typed as it was written. A subject alone is `-m` and reads at the
 * prompt. A subject with a body goes out to a file under GitView's data folder
 * and `-F` carries the path, the same answer an issue body gets, so a list in
 * the body keeps its line breaks: one `-m` per paragraph, the shape this took
 * until 16 Sep 2026, joined the lines inside a paragraph with spaces.
 */
export function commitCommand(
  subject: string,
  messageFile: string | null,
  kind: ShellKind,
  amend = false,
): string {
  const parts = ["git", "commit"];
  if (amend) parts.push("--amend");
  if (messageFile) parts.push("-F", quote(messageFile, kind));
  else parts.push("-m", quote(subject.trim(), kind));
  return parts.join(" ");
}

/**
 * The commands that move a paused operation along, in the order the strip
 * shows them: the one that goes on, the one that steps over, and the one that
 * gives up. Bisect is the odd one: its steps are answers, so it gets Good and
 * Bad and its way out is `reset`. Every entry is the exact line git prints
 * under "hint:" for that state, so the strip reads the same as the scrollback.
 */
export function operationCommands(
  kind: Operation["kind"],
): { label: string; command: string; abort?: boolean }[] {
  switch (kind) {
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "am":
      return [
        { label: "Continue", command: `git ${kind} --continue` },
        { label: "Skip", command: `git ${kind} --skip` },
        { label: "Abort", command: `git ${kind} --abort`, abort: true },
      ];
    case "merge":
      return [
        { label: "Continue", command: "git merge --continue" },
        { label: "Abort", command: "git merge --abort", abort: true },
      ];
    case "bisect":
      return [
        { label: "Good", command: "git bisect good" },
        { label: "Bad", command: "git bisect bad" },
        { label: "Reset", command: "git bisect reset", abort: true },
      ];
  }
}

/**
 * Throwing away work that was never committed.
 *
 * Two commands, because git has two: a tracked file goes back to what the index
 * holds through `git restore`, and an untracked one is not in the index to go
 * back to, so it is `git clean` or nothing. Returning both rather than joining
 * them with a separator keeps each line something the confirmation can print
 * and the shell can echo on its own.
 *
 * `all` says `paths` is the whole unstaged working tree, so the commands say
 * `.` rather than listing it: that is what a person types, and it stays true if
 * something changed between the dialog opening and the line running. `git clean`
 * then takes `-d` too, since a directory holding only new files is itself new.
 */
export function discardCommands(
  paths: { path: string; untracked: boolean }[],
  kind: ShellKind,
  all = false,
): string[] {
  const commands: string[] = [];
  if (all) {
    if (paths.some((p) => !p.untracked)) commands.push("git restore -- .");
    if (paths.some((p) => p.untracked)) commands.push("git clean -fd");
    return commands;
  }
  const tracked = paths.filter((p) => !p.untracked).map((p) => quote(p.path, kind));
  const untracked = paths.filter((p) => p.untracked).map((p) => quote(p.path, kind));
  if (tracked.length > 0) commands.push(`git restore -- ${tracked.join(" ")}`);
  if (untracked.length > 0) commands.push(`git clean -f -- ${untracked.join(" ")}`);
  return commands;
}

/**
 * Pushing the branch, and publishing it the first time.
 *
 * `git push` alone is the line when the branch already tracks something. With
 * no upstream git refuses and suggests `--set-upstream`, so the first push
 * names the remote and the branch and sets the tracking as it goes, which is
 * what every push after it relies on.
 */
export function pushCommand(branch: string, hasUpstream: boolean, kind: ShellKind): string {
  if (hasUpstream) return "git push";
  return `git push -u origin ${quote(branch, kind)}`;
}

/**
 * `git tag`, as one line.
 *
 * A message makes it annotated, which is the kind `git describe` and GitHub's
 * release page read, and the kind that carries a tagger and a date. Without
 * one it is a lightweight tag, a name on a commit and nothing else. The message
 * goes the way a commit's does, one `-m` per paragraph. The sha is always
 * named, even when it is HEAD, so the line says what it tagged.
 */
export function tagCommand(name: string, message: string, sha: string, kind: ShellKind): string {
  const parts = ["git", "tag"];
  const paragraphs = message
    .split(/\n\s*\n/)
    .map((part) => part.trim().replace(/\s*\n\s*/g, " "))
    .filter(Boolean);
  if (paragraphs.length > 0) {
    parts.push("-a");
    for (const paragraph of paragraphs) parts.push("-m", quote(paragraph, kind));
  }
  parts.push(quote(name, kind), sha);
  return parts.join(" ");
}

/**
 * Whether git would take the name, by `git check-ref-format`'s rules.
 *
 * The dialog checks before typing so the shell never prints "not a valid tag
 * name" for a space or a colon. Not every rule is here: the ones that are
 * cover what somebody types by hand, and git has the last word.
 */
export function validRefName(name: string): boolean {
  if (!name || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (/[\s~^:?*[\\]/.test(name)) return false;
  // Control characters, which the lint rule keeps out of a regex literal.
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
}

/**
 * `gh pr create`, as one line.
 *
 * No `--repo` and no `--head`: the line is typed into that repository's shell,
 * and gh takes the head from the branch the shell is standing on. That is
 * also what lets gh offer to push a branch that has not been pushed, which
 * `--head` would turn into a refusal. The body goes the way an issue's does.
 */
export function prCreateCommand(
  base: string,
  title: string,
  body: string,
  bodyFile: string | null,
  kind: ShellKind,
): string {
  const parts = ["gh", "pr", "create", "--base", quote(base, kind), "--title", quote(title, kind)];
  if (bodyFile) {
    parts.push("--body-file", quote(bodyFile, kind));
  } else {
    parts.push("--body", quote(body, kind));
  }
  return parts.join(" ");
}

/**
 * `gh issue create`, as one line.
 *
 * The inbox reads GitHub out of sight because a fleet-wide read has nowhere to
 * type. Opening an issue is aimed at one repository, so it has a prompt, and it
 * uses it. `--repo` is on the line even though the shell is already in that
 * folder: the line is meant to be readable on its own afterwards.
 *
 * `bodyFile` is set when the body has a newline in it, since a newline typed at
 * a prompt submits the command. A one-line body is quoted inline instead, which
 * keeps the common case to one readable argument.
 */
export function issueCreateCommand(
  ownerRepo: string,
  title: string,
  body: string,
  bodyFile: string | null,
  kind: ShellKind,
): string {
  const parts = ["gh", "issue", "create", "--repo", quote(ownerRepo, kind), "--title", quote(title, kind)];
  if (bodyFile) {
    parts.push("--body-file", quote(bodyFile, kind));
  } else {
    // `--body ''` rather than no flag at all: without it gh opens an editor and
    // the shell sits there holding a prompt nobody asked it to hold.
    parts.push("--body", quote(body, kind));
  }
  return parts.join(" ");
}

/**
 * Merging a pull request, and deleting the branch it came from.
 *
 * `--delete-branch` removes the head branch on origin and, when the shell is
 * standing on it, switches to the base branch and removes the local copy too,
 * which is the whole cleanup the merge button on GitHub leaves for later. A
 * repository set to delete the branch itself gets the plain merge, since the
 * flag would only repeat what GitHub is about to do.
 */
export function mergeCommand(number: number, method: MergeMethod, deleteBranch: boolean): string {
  const parts = ["gh", "pr", "merge", String(number), `--${method}`];
  if (deleteBranch) parts.push("--delete-branch");
  return parts.join(" ");
}

/**
 * `gh issue comment`, as one line.
 *
 * The body goes the way a new issue's does: inline when it fits on a line, and
 * out to a file under GitView's data folder when it has paragraphs.
 */
export function issueCommentCommand(
  number: number,
  body: string,
  bodyFile: string | null,
  kind: ShellKind,
): string {
  const parts = ["gh", "issue", "comment", String(number)];
  if (bodyFile) parts.push("--body-file", quote(bodyFile, kind));
  else parts.push("--body", quote(body, kind));
  return parts.join(" ");
}

/** Re-running the jobs that failed in one Actions run, and only those. */
export function rerunCommand(runId: number): string {
  return `gh run rerun ${runId} --failed`;
}

/**
 * Opening a URL the shell just announced.
 *
 * A dev server prints its address and GitView notices; the browser still gets
 * opened by a command typed at the prompt, because a button that reaches the
 * desktop without saying how would be the only one in the app that does.
 */
export function openUrlCommand(url: string, kind: ShellKind): string {
  return kind === "powershell" ? `Start-Process ${quote(url, kind)}` : `open ${quote(url, kind)}`;
}

/**
 * Opening a file in whatever the desktop has registered for its type.
 *
 * `Invoke-Item` is the ShellExecute verb PowerShell gives a path, so a `.ts`
 * lands in the editor the machine already opens `.ts` in, and GitView never
 * has to hold an editor setting of its own. The path is relative to the
 * repository, the same as every `git add` typed from the changes pane, and
 * the same forward slashes: PowerShell takes them.
 */
export function openFileCommand(path: string, kind: ShellKind): string {
  return kind === "powershell" ? `Invoke-Item ${quote(path, kind)}` : `open ${quote(path, kind)}`;
}

/**
 * Fetching a release's installer and running it, as one line.
 *
 * The alternative was `tauri-plugin-updater`, which downloads and swaps the
 * binary out of sight. That would be the one action in GitView that changes
 * something on disk without naming what it ran, and it would put an HTTP client
 * and a signing key into a project that has spent every other decision avoiding
 * both. `gh` is already on the machine and already authenticated, so the update
 * is the same shape as every other action here: a command at the prompt, with
 * the tag it is pulling visible in it.
 *
 * `$env:TEMP` is the one thing on the line that must not be quoted, because the
 * download needs the folder expanded rather than the literal text. `Join-Path`
 * then hands the same folder to `Start-Process` without needing a second
 * quoting style for a filename that came from GitHub.
 */
export function installUpdateCommand(
  repo: string,
  tag: string,
  asset: string,
  kind: ShellKind,
): string {
  const name = quote(asset, kind);
  const download = `gh release download ${quote(tag, kind)} --repo ${quote(repo, kind)} --pattern ${name}`;
  if (kind === "powershell") {
    return `${download} --dir $env:TEMP --clobber; Start-Process (Join-Path $env:TEMP ${name})`;
  }
  // A release carries a Windows installer and nothing else, so the POSIX line
  // stops at the download rather than pretending it can run what it fetched.
  return `${download} --dir "\${TMPDIR:-/tmp}" --clobber`;
}
