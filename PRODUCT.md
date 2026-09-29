# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The frontend is React in a Tauri shell on WebView2, Windows 10 and 11 only. It is a desktop app, but its
design language is the app's own, so it is recorded as `web`.

## Users

A solo developer on Windows who keeps ten to twenty or more repositories, types most of their git by
hand, and runs Claude Code in the terminal. The daily question is which of the projects needs
attention, not what one repository's graph looks like. Built first for its author, open to others
who work the same way.

## Product Purpose

A git client whose home screen is the whole fleet at once. The terminal is a primary pane, sessions
belong to a repository and survive a view change, and each project's run and build commands sit next
to the repository that needs them. Success is that the developer never has to open a repository to
learn that it wants attention, and never loses a running dev server by looking at another project.

## Positioning

The home screen is every repository at once, sorted by what needs attention, and every button types
the git command it runs into a real, persistent terminal. Other git GUIs treat one repository as the
unit of work and hide git behind buttons; GitView accelerates a habit of typing git rather than
replacing it.

## Operating Context

- Many repositories under a few watched folders; a scanner reads them in process and paints from
  SQLite before any repository is opened.
- PowerShell in ConPTY, with OSC 133 command blocks; `git.exe` for anything touching a remote, `gh`
  for GitHub. GitHub is read out of sight and written by typing.
- Claude Code runs in a tab, typed at a prompt. GitView adds no UI around it.
- The app is used alongside a terminal, an editor and a browser, for long sessions.

## Capabilities and Constraints

- Fleet scanner, persistent terminals, task discovery, branch graph, full commit history, diff and
  hunk staging, command blocks, GitHub inbox and pull request desk, paused-operation strip, stashes,
  amend, worktree awareness, settings dialog, self-update through `gh`.
- Windows only. No generated commit messages, no agent panel, no account, no telemetry.
- Every action names its command; shift-click types instead of running. Discarding work asks first.
- Terminology: "the fleet", "attention", "command block", "the wiki" (documentation lives outside
  the repository).
- Worktree lanes are designed but not built.

## Brand Commitments

Name is GitView. Voice is plain and exact: a path, a sha, a branch or a command is set in mono, a
title or a count is not. No label is uppercase. The app's OKLCH tokens are the incumbent visual
authority; `site/index.html` copies them.

## Evidence on Hand

- `README.md` for the feature list, `site/index.html` for the project page, and the wiki
  (Obsidian vault outside the repository) for decisions and measurements.
- Measurements exist for scan, history paging and diff rendering. No testimonials, customer counts or
  usage figures exist; do not invent them.

## Product Principles

1. The terminal is where work happens; the GUI shows state and types commands, and does not hide
   them.
2. Fleet first: the list of repositories answers "what needs me" before any single repository does.
3. Nothing acts out of sight unless it is a read or a fleet-wide operation that keeps a transcript.
4. Restraint over controls: no button for what the terminal does well.
5. A number is a measurement; a claim is checked in the running window.

## Accessibility & Inclusion

Keyboard-first, with chords defined in `lib/keys.ts`, and a terminal screen reader mode in settings.
No formal WCAG target has been set.
