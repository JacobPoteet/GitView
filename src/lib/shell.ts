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
 * becomes one `-m` per paragraph, which is how git assembles a body anyway. A
 * message that is only a subject stays a single `-m`.
 */
export function commitCommand(message: string, kind: ShellKind, amend = false): string {
  const paragraphs = message
    .split(/\n\s*\n/)
    .map((part) => part.trim().replace(/\s*\n\s*/g, " "))
    .filter(Boolean);

  const parts = ["git", "commit"];
  if (amend) parts.push("--amend");
  for (const paragraph of paragraphs) {
    parts.push("-m", quote(paragraph, kind));
  }
  return parts.join(" ");
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
