# GitView

A git client for people who keep many repositories and type most of their git by hand.

The home screen is the whole fleet at once. The terminal is a primary pane rather than a tab. The
run and build commands for each project sit next to the repository that needs them.

> [!NOTE]
> The fleet scanner, the persistent terminal, task discovery, the branch graph and command blocks
> work. The diff view, the full commit history and the GitHub inbox are designed but not built. See
> [Status](#status).

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
  `CMakeLists.txt`, Unity's `ProjectVersion.txt`, and Docker Compose files.
- **Sync and prune.** Both type their command into the repository's own shell, so the output is
  where you already look. Prune lists the branches first and uses `git branch -d`, which refuses
  anything unmerged.
- **Branch graph.** Two rails, time running left to right: what your branch has that `origin/main`
  does not, and what it has that you do not. It collapses to a one-line summary, and clicking a
  commit types `git show` into that repository's shell.
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

Pushing a `v*` tag builds the same installer on CI and attaches it to the GitHub release. The
workflow refuses to run if the tag disagrees with the version in `tauri.conf.json`, `package.json`
or `Cargo.toml`, because the installer is named from the first of those.

The scanner can be checked without opening a window:

```bash
cd src-tauri
cargo run --example scan -- F:\GitHub
```

That prints one line per repository with the timings, which is the fastest way to see whether a
large project is dragging the sweep.

## How it is built

| Layer | Choice |
| --- | --- |
| Shell | Tauri v2 |
| Frontend | React 18, TypeScript, Vite, hand-written CSS on OKLCH tokens |
| Terminal | `portable-pty` over ConPTY, `@xterm/xterm` with the WebGL renderer |
| Repository reads | libgit2 through `git2`, in process |
| Network git | `git.exe` as a subprocess |
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
| 1 | Sync and prune across several repositories with a transcript, dragging to reorder pins | Designed |
| 2 | GitHub inbox: pull requests, issues and CI status in one GraphQL query | Designed |
| 3 | Diff, hunk staging, commit graph | Designed |
| 4 | Worktree lanes and a local API for agents | Designed |

Command blocks need PowerShell. GitView wraps whatever prompt you already have, so Starship and
oh-my-posh keep working, and it writes nothing to your profile or anywhere else outside its own
data folder. A `cmd.exe` session gets a working shell and no blocks.

## Documentation

The wiki is the source of truth and lives outside this repository. It covers the architecture, each
feature, the interface, and a decision log recording why each choice was made and what was ruled
out. This repository keeps only `README.md`, `CLAUDE.md`, the licence and the CI workflow.

## Licence

MIT. See [LICENSE](LICENSE).
