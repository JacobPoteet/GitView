# GitView

A git client for people who keep many repositories and type most of their git by hand.

**[jacobpoteet.github.io/GitView](https://jacobpoteet.github.io/GitView/)** shows it in motion.

The home screen is the whole fleet at once. The terminal is a primary pane rather than a tab. The
run and build commands for each project sit next to the repository that needs them.

> [!NOTE]
> Everything through Phase 4 works, and Phases 6 and 7 are landing: the fleet scanner, the
> persistent terminal, task discovery, the branch graph, command blocks, the GitHub inbox, the diff
> view, hunk staging, the commit history and its filter, the pull request desk, a strip for a paused
> rebase, the stash count, amend, and revert, cherry-pick and reset from a commit. Worktree lanes
> are designed but not built. See [Status](#status).

## Why

Every git GUI treats one repository as the unit of work: open it, look at the graph, commit, close.
That answers the wrong question when you keep twenty projects and the daily question is which of
them need attention. GitView puts that list first and leaves the commands to you.

Three rules shape the whole app:

| Rule | What it means |
| --- | --- |
| The terminal is where work happens | Sessions belong to a repository and survive switching away, so a dev server keeps running |
| Every button shows its command | Hover to read it, shift-click to type it at the prompt instead of running it |
| Nothing gets generated for you | No commit messages, no agent panel, no account, no telemetry |

## What works now

- **Fleet scanner.** Walks the scan roots one level deep, reads branch, ahead/behind, dirty counts,
  merged branches and the origin remote for each repository, and streams rows in as they are read.
- **Instant cold start.** The list paints from SQLite before any repository is opened.
- **Persistent terminals.** One shell per repository, PowerShell 7 when it is installed. Switching
  projects keeps the session, the scrollback and any running process.
- **Task discovery.** Reads `package.json` (with the package manager taken from the lockfile),
  `Cargo.toml`, `Makefile`, `justfile`, `pyproject.toml` and `uv.lock`, `.sln` and `.csproj`,
  `CMakeLists.txt`, Unity's `ProjectVersion.txt`, Docker Compose files, and a `gitview.toml` for the
  script that fits none of those, checked in so it travels with the repository.
- **Sync and prune.** Both type their command into the repository's own shell, so the output is
  where you already look. Prune lists the branches first and uses `git branch -d`, which refuses
  anything unmerged.
- **Branch graph.** Two rails, time running left to right: what your branch has that `origin/main`
  does not, and what it has that you do not. It collapses to a one-line summary, and clicking a
  commit opens it: its message, its files, and one file's hunks. Shift-click types `git show`.
- **A list you control.** Pin the repositories you are working on to the top, hide the ones you are
  not, and add or remove the folders GitView watches without leaving the app.
- **Tasks you actually run.** Discovery finds every script a project declares, which for one
  project here is 29. Move the CI-only ones to a collapsed Hidden section and they leave the
  palette too.
- **Command blocks.** PowerShell tells GitView where each command started, what it printed and what
  it exited with. The strip under the terminal shows the last one, and a two-pixel bar marks it in
  the scrollback: green, red, or violet while it runs.
- **Keeping a command you already ran.** One button turns the last command into a task for that
  repository. Nothing is written into the repository, and you never type the command twice.
- **Ports, without a config file.** A `localhost:5173` printed by a running command becomes a chip.
  Clicking it types `Start-Process`, like every other button here.
- **A failing build, in one copy.** The command, its directory, its exit code and its output go to
  the clipboard together, ready to paste into Claude in the next window.
- **Command palette.** `Ctrl+K` for repositories, tasks and actions.
- **The diff, without leaving the window.** Click a file name in the changes column and its diff
  opens over the terminal, unified, on whichever side of the index that row belongs to. A file
  staged and then edited again has both, and the pane says which one you are reading. The shell
  behind it keeps running.
- **A hunk at a time.** Each hunk has a button that stages it on its own. A hunk is the one argument
  nobody can type at a prompt, so GitView writes it out as a patch under its own data folder and
  types `git apply --cached` against that path, which is what `git add -p` does underneath. The
  command is in the scrollback and the patch is still on disk to read.
- **The whole history, scrolling.** Every commit on every branch, with the lanes drawn on a canvas
  under rows that only exist while they are on screen. 5,500 commits read in 140 ms a page and
  scroll at one frame a step. Clicking a commit opens it, and a field in the tab bar filters the
  list by message, `author:` or `path:`, at no more cost than a page without one. "History of this
  file" from any file row is that filter with the path filled in.
- **A commit's menu.** Right-click a commit in the strip or the history for revert, cherry-pick
  onto the branch, and reset to here with soft, mixed and hard each asking first. Cherry-pick is
  off, with the reason, for a commit the branch already has.
- **The state a prompt cannot show.** A paused rebase, merge, cherry-pick, revert, bisect or am
  gets a strip under the header: which branch, onto what, how far along, and Continue, Skip and
  Abort as buttons that type git's own next steps. The row wears it as a chip and sorts to the top.
- **Stashes, counted.** A chip on the row and in the header, with each entry's message; the
  header's copy types `git stash list` and its menu offers pop, apply and drop per entry.
- **Amend.** A word beside Commit that fills the box from the last commit and types
  `git commit --amend`, or `--amend --no-edit` when only the files changed. Off once the commit is
  on origin, since the next step would be a force push.
- **Unpushed work on every branch.** The attention sort counts commits that exist on this disk
  alone across every local branch, not only the one checked out, and the chip names them.
- **The pull request desk.** Push from the header, open a pull request from a form, watch each check
  by name, and merge with `gh pr merge` typed after a confirmation. See the wiki's GitHub Inbox.
- **Settings.** One dialog: watched folders, the terminal's type size and screen reader mode, and
  whether the app fetches and checks for a release on launch.
- **Updates that name their command.** GitView asks GitHub for its own latest release once per
  launch. When there is a newer one the status bar says so, and the dialog hands you the
  `gh release download` line to run at the prompt, like every other action here.

## Installing it

Windows installers are attached to each [release](https://github.com/JacobPoteet/GitView/releases).
Download `GitView_<version>_x64-setup.exe` and run it; it installs for the current user and asks for
no elevation.

The installer is not code signed, so SmartScreen will warn on first run. **More info** then **Run
anyway** is the way past it, and building from source below is the way around it.

After that, GitView tells you when a newer release is out and hands you the command that fetches it.
That check needs [`gh`](https://cli.github.com) installed and logged in, the same as the inbox.

## Requirements

| Requirement | Why |
| --- | --- |
| Windows 10 or 11 | The only target so far. ConPTY and WebView2 |
| `git` on PATH | Every network operation shells out to it, which is how credential helpers keep working |
| Node 20 or later | Frontend build |
| Rust stable | Backend build |
| Visual Studio Build Tools with the C++ workload | Rust on Windows needs the MSVC linker. A Rust install alone is not enough |

## Running it

```bash
npm install
npm run dev
```

`npm run build` produces an installer under `src-tauri/target/release/bundle/nsis`.
`npm run tauri build -- --no-bundle` produces just the executable, which is faster when you only
want to check that it compiles.

The scanner can be checked without opening a window:

```bash
cd src-tauri
cargo run --example scan -- F:\GitHub
```

That prints one line per repository with the timings, which is the fastest way to see whether a
large project is dragging the sweep.

## Releasing it

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the NSIS installer and
attaches it to the GitHub release. CI does not: it runs on pushes to `main`, which a tag push does
not match, and it builds `--no-bundle` so the gate stays fast.

**The version lives in four files, and the tag has to agree with all of them.**

| File | Why it matters |
| --- | --- |
| `src-tauri/tauri.conf.json` | the installer's filename and its Add/Remove Programs entry |
| `package.json` | the frontend package |
| `src-tauri/Cargo.toml` | the crate |
| `src-tauri/Cargo.lock` | follows `Cargo.toml`; `cargo` rewrites it, so commit it |

The release workflow re-reads the first three and refuses to build when any disagrees with the tag.
Without that check, tagging `v0.2.0` without bumping would publish a `v0.2.0` release containing a
file called `GitView_0.1.0_x64-setup.exe`.

Steps:

```bash
# 1. Bump the version in the three files above, then let cargo rewrite Cargo.lock.
# 2. Open a PR with that bump so CI gates it, and merge it.

# 3. Tag the commit that has the bumps, not the one before it.
git checkout main
git pull --ff-only
git tag v0.2.0
git push origin v0.2.0
```

The workflow then re-checks the versions, runs `cargo test`, builds the installer, creates the
release with generated notes if it does not exist yet, and uploads the asset with `--clobber` so a
re-run replaces it instead of failing.

### When the tag is already in the wrong place

This is the common mistake: tag first, bump second. The guard fails with
`Tag does not match the tree`, and `workflow_dispatch` will not rescue you, because it checks out
that same tag and hits the same guard. Move the tag onto the commit that has the bumps.

```bash
git tag -f v0.2.0            # on the commit that has the bumps
git push --force origin v0.2.0
```

Force-moving a tag is safe while nothing has been published under it. Once a release has an
installer attached, cut a new version instead, because anyone who downloaded the old one has a file
whose name no longer matches what the tag points at.

`workflow_dispatch` is for the other failure: the tag is right and the build broke. Run the
workflow by hand against the existing tag and it fills the release in without re-pushing anything.

## How it is built

| Layer | Choice |
| --- | --- |
| Shell | Tauri v2 |
| Frontend | React 18, TypeScript, Vite, hand-written CSS on OKLCH tokens |
| Terminal | `portable-pty` over ConPTY, `@xterm/xterm` with the WebGL renderer |
| Repository reads | libgit2 through `git2`, in process |
| Network git | `git.exe` as a subprocess |
| GitHub reads | `gh` as a subprocess, so no token is ever GitView's to hold |
| Cache | SQLite through `rusqlite` |

Reads and writes are split on purpose. Credential helpers, the Windows Credential Manager, SSH
agents and proxies are all solved by your existing git configuration, so fetch, push and pull spawn
`git` and inherit it. Reads have no such problem and stay in process, because spawning `git` six
times per repository per refresh is slow enough to feel.

## Status

| Phase | Contents | State |
| --- | --- | --- |
| 0 | Fleet view, terminal, task discovery, sync and prune, palette | Built |
| 0.5 | Pinning and hiding, watched folders, the branch graph, staging and commit | Built |
| 1 | Command blocks via OSC 133, saving a block as a task, ports, copying a failure | Built |
| 1 | Sync and prune across several repositories with a transcript, dragging to reorder pins | Built |
| 2 | GitHub inbox: pull requests, issues and CI status in one GraphQL query | Built |
| 3 | The diff pane, and staging one hunk of it through a typed `git apply` | Built |
| 3 | The commit history: canvas rails under virtualised rows, lanes packed in Rust | Built |
| 4 | The pull request desk: push, `gh pr create` from a form, checks by name, merge typed as `gh` | Built |
| 6 | The state a prompt cannot show: a paused rebase, stashes, unpushed work on every branch, amend | Built |
| 7 | Reading back: the history filter, file history, revert and cherry-pick and reset from a row, search in the scrollback | Built, blame pending |
| 8 | The window: splitters, scrollback across restarts, keyboard shortcuts, a second shell per repository | Planned |
| 5 | Worktree lanes | Designed |

Command blocks need PowerShell. GitView wraps whatever prompt you already have, so Starship and
oh-my-posh keep working, and it writes nothing to your profile or anywhere else outside its own
data folder. A `cmd.exe` session gets a working shell and no blocks.

## Documentation

The wiki is the source of truth and lives outside this repository. It covers the architecture, each
feature, the interface, and a decision log recording why each choice was made and what was ruled
out. This repository keeps only `README.md`, `CLAUDE.md`, the licence, the workflows and the project
page under `site/`.

## Licence

MIT. See [LICENSE](LICENSE).
