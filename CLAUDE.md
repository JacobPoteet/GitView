# Working in this repository

## The wiki

Documentation lives in an Obsidian vault outside this repository, not in `docs/`. The path is in
`.claude/wiki-path.local`, which is gitignored. Never write the vault path into tracked files, a
comment, or a commit message. Call it "the wiki".

Before changing anything architectural, grep `GitView/Decision Log.md` for the area you are
touching. Most choices here have a reason recorded there, including the options already ruled out.
It is one long table and it grows every PR, so search it rather than reading it end to end.

**Every pull request updates the note that owns what changed, and `CLAUDE.md` when a rule moved.**
Wiki edits sit outside the repository, so they happen before the PR opens or they do not happen at
all. A PR that changes the scanner updates `Architecture/Fleet Scanner.md`; a PR that adds a feature
adds a note under `Features/` and links it from the index.

### One note owns a change, the rest link to it

| Note | Gets |
| --- | --- |
| The one that owns the change | the real pass: delete what became false, write what shipped, record what was measured |
| Any other note that mentions it | one corrected sentence, or a `[[link]]`. No restructuring |
| `Decision Log` | a row for a choice someone would otherwise re-litigate, and a dead-end row for something tried and reversed. Not a row per commit |
| `Delivery Phases` and the index | one status entry per phase, not per PR |

Write a finding once, in the note that owns it, and link to it from the others. The ConPTY marker
findings landed in five notes in one PR, which is four copies to keep true from now on.

### Where the tokens go, and what to skip

| Skip | Instead |
| --- | --- |
| Reading a note end to end to change one section | grep for the heading, read that range, edit it |
| Rewriting prose that is still true | delete what is false and leave the rest |
| Per-file line counts in `Repo Map` | they go stale on every PR. Refresh them when the version bumps |
| A "Measured" table for something nobody measured | a number in the wiki is a measurement. No measurement, no table |
| A new note for a change that fits in an existing one | a note earns its file when it has a reader who would open it on its own |

The wiki has its own house style, recorded in its `Wiki Conventions.md`. Follow it. It calls for the
`stop-slop` skill, which governs the prose in a note you write or rewrite; load it once in a session
rather than per note, and skip it for a one-line factual correction.

## Documents this repository keeps

`README.md`, `CLAUDE.md`, `LICENSE`, the three workflows, and the project page under `site/`.
Everything else belongs in the wiki. Do not add a `docs/` folder: GitHub Pages would serve it, but
it is also where a reader expects documentation, and the documentation is in the wiki.

`ci.yml` is the gate and builds `--no-bundle`, so it never produces an artifact. `release.yml` runs
on a `v*` tag, builds the NSIS installer and attaches it to the release. A tag push does not match
`branches: [main]`, which is why CI cannot do both jobs. `pages.yml` deploys `site/` to
jacobpoteet.github.io/GitView on a push to `main` that touches it; CI cannot carry that either,
because CI runs on pull requests and a pull request must never deploy the page.

`site/index.html` is the whole page: one file, no build step, no framework, the app's OKLCH tokens
copied in. Its prose gets the same `stop-slop` pass a wiki note does. The wiki's
`Operations/Project Site.md` records what the page shows and how it was checked.

## Layout

| Path | Holds |
| --- | --- |
| `src/` | React frontend. Components, plus `lib/api.ts` mirroring the Rust command surface, `lib/shell.ts` quoting the commands that get typed at a prompt, and `lib/settings.ts` holding the app's own settings in `localStorage` |
| `src/hooks/` | State that left `App.tsx`: `useInbox`, `useBatch`, `useUpdate`. Each owns its state and returns what the render needs; a feature that grows a handful of state goes here rather than into `App` |
| `src-tauri/src/fleet.rs` | The scanner. Repository reads, in process |
| `src-tauri/src/graph.rs` | The branch graph. Two bounded revwalks against a chosen base |
| `src-tauri/src/diff.rs` | One file's hunks, read per file and per side of the index, and one commit against its first parent |
| `src-tauri/src/blame.rs` | Who last wrote each line of a file, as of a commit. Hunks, not lines, capped at 6000 like the diff |
| `src-tauri/src/history.rs` | The whole DAG, a page at a time, with its lanes already packed |
| `src-tauri/src/signing.rs` | Whether a commit carries a signature and of which scheme. Presence only, never verification |
| `src-tauri/src/gitops.rs` | `git.exe` subprocess. Everything that touches a remote |
| `src-tauri/src/github.rs` | `gh` subprocess. One aliased GraphQL query for the whole fleet |
| `src-tauri/src/update.rs` | The launch check against the latest GitHub release, through the same `gh` invocation |
| `src-tauri/src/pty.rs` | Terminal sessions, and the base64 that hands the shell its prompt hook |
| `src-tauri/src/scrollback.rs` | A shell's buffer and its blocks on disk, written as the shell settles and on close, read back above the next launch's first prompt |
| `src-tauri/src/scratch.rs` | The files a typed command names because its argument cannot be typed: the folder under the data dir, the one sweep, the slug, and the commit message writer |
| `src-tauri/src/shell_integration.ps1` | The OSC 133 hook. Source, not an asset: `include_str!` puts it in the binary |
| `src-tauri/src/tasks.rs` | Task discovery across manifests |
| `src-tauri/src/cache.rs` | SQLite. Cached scans, saved tasks, settings, and the pin and hide preferences |
| `src-tauri/examples/scan.rs` | Headless scanner check, no window |
| `site/index.html` | The project page. Static, served by `pages.yml` |
| `scripts/install-local.ps1` | `npm run install:local`: build the installer, run it over the installed GitView, start the new one. Never rename the script to `install`, npm runs that on every `npm install` and `npm ci` |

## Rules that hold across changes

| Rule | Why |
| --- | --- |
| Repository reads go through `git2`, network operations go through `git.exe`, GitHub goes through `gh` | Credential helpers and SSH agents work for free through the CLI. Reimplementing auth is where other GUIs collect "cannot push" reports. The same argument covers the API: `gh api graphql` means GitView never sources, stores or redacts a token, and there is no HTTP client in the binary to add one with |
| A terminal session is never closed on a view change | Closing it would kill a dev server every time the user looked at another project |
| The window's close is a request Rust holds | `on_window_event` prevents the close and emits `closing`; the frontend writes every shell's scrollback and calls `app_quit`. Closing outright would end the buffers before the write began. The hold is bounded at three seconds in `saveAllSessions`, so a save that hangs cannot keep the app open |
| Every action names the command it runs | The GUI accelerates a habit of typing git rather than hiding it. Shift-click types instead of running |
| No generated commit messages, no agent panel, no account, no telemetry | These are the features that made the tool being replaced feel bloated |
| GitHub is read out of sight, but written by typing | A fleet-wide read has nowhere to type, the same as fetch-all. A write does: `gh issue create` and `gh pr merge` get typed into that repository's shell like every other action. An issue body has paragraphs and a newline at a prompt submits the line, so a multi-line body goes out to a file under GitView's data folder and `--body-file` carries the path, the same answer hunk staging gives |
| A command aimed at a repository waits for its session, never for a timer | `sendCommand` writes to the PTY directly, so a command sent while the shell is still starting is lost with an unhandled rejection. Select the repository, then send when `live` reports it |
| Numbers in the wiki are measurements | If a note states a timing or a count, it was measured. Mark a target as a target |
| A setting about the app lives in `lib/settings.ts`, and a setting about a repository lives in SQLite | The terminal's type size and the launch checks are choices about this window and this install, read synchronously before the first terminal opens, so they sit in one `localStorage` object merged over its defaults. Pins, hides and the watched folders are read from Rust or belong to a repository, so they stay in the database. The settings dialog is the one home for the first kind: a switch added anywhere else is a switch nobody finds |
| A paused rebase, merge, cherry-pick, revert, bisect or am is read from `Repository::state()`, and the strip that shows it is never hidden by a pane | With nothing conflicted a paused rebase is a detached HEAD and nothing more, which is the state a prompt is worst at. `read_operation` in `fleet.rs` fills `operation`, `OperationBar.tsx` keeps git's own `hint:` steps on screen under the header, and the state outranks whatever a pane is showing. Continue and Skip type straight away; only Abort asks, since it discards resolution work nothing keeps |
| A preference is never stored in `RepoState` | That struct is scanner output, cached as a blob and rewritten every sweep. Pins and hides live in `repo_pref` and `task_pref`, and the frontend merges them |
| A schema change reaches an installed database by `ALTER TABLE` | The one on this machine holds pins and saved tasks somebody set. `add_column_if_missing` checks `PRAGMA table_info` rather than catching an error whose message would also cover a real failure, and a new column that replaces an old sort key is backfilled from it so the upgrade changes nothing on screen |
| Hiding something removes it from the palette | Demoting it still leaves it in the way, and the palette is where a project's thirty npm scripts do the most damage |
| A release tag must match `tauri.conf.json`, `package.json` and `Cargo.toml` | The installer takes its filename and its Add/Remove Programs entry from the config, so tagging `v0.2.0` without bumping ships a `v0.2.0` release containing `GitView_0.1.0_x64-setup.exe`. `release.yml` fails on the mismatch rather than shipping it |
| A preference is keyed on the path, and follows a rename by `owner/repo` | Keying on the identity outright strands every repository with no remote. `repo_identity` records what was at a path so a move can be recognised afterwards, guarded so two clones of one project cannot fight over a set of pins |
| Staging and committing type their commands too | A single-repository action always has a shell to type into, and the output belongs where the user already looks. Only a fleet-wide action may run out of sight, because one shell would serialise twelve repositories behind whatever is at that prompt |
| A fleet-wide operation keeps a transcript, and the transcript holds what a scrollback would | Fetch-all got away with a count because it has no output worth reading. Sync and prune do, so `lib/batch.ts` records the command as typed, the exit code and both streams per repository, and `git branch -d`'s `(was abc1234)` lines can be copied out. A batch with no transcript is an action that happened where nobody can see it |
| An operation that runs out of sight reports what failed | `git_run` resolves with an exit code rather than throwing, so catching the promise sees almost nothing. Read `code` |
| An argument nobody can type goes out as a file under GitView's data folder, through `scratch.rs` | A hunk, an issue body and a commit message with a description are the three so far. Each writer used to carry its own sweep; `scratch::dir` is the one that remains, and a new one calls it rather than copying the loop. A subject-only commit stays `-m`, because that reads at the prompt and `-F` for one line would not |
| A batch reads the repository again between its commands | `ahead` and `behind` come from the last sweep, and a fetch is what changes them. Planning the pull from cached counts skips the repository that became fast-forwardable one command ago |
| The prompt hook wraps the user's prompt and touches nothing on disk | Overwriting `prompt` discards Starship and oh-my-posh. The script is handed over as `-EncodedCommand` after the profile has loaded, so it captures whatever is there. Never write to a profile without asking |
| A terminal line number is checked against the command text before it is used | ConPTY repaints on resize and can duplicate a line, and `cls` rewrites lines in place, so a marker stops describing what it was taken from. `anchor` in `TerminalPane.tsx` is the only way to turn a block into a line |
| GitView's own update goes through `gh`, and installs by typing | `tauri-plugin-updater` is what every Tauri project reaches for, and it wants an HTTP client, a TLS stack in a binary built with `lto = true`, and a minisign private key living in an Actions secret. That is the trade the inbox already refused. `gh release view` reads the release out of sight, because the question belongs to the app rather than to a repository; `gh release download` and `Start-Process` get typed at a prompt, so the one action that replaces the binary still names what it ran. The prompt is the selected repository's when there is one, and otherwise a shell GitView opens for itself in its data folder: the command has no interest in a repository, so it never asks you to pick one |
| A version is compared as numbers, and a tag has to look like a version | `0.10.0` sorts below `0.9.0` as a string, and `v2026-09-09` splits into major 2026 with a prerelease of `09-09` and beats everything. `is_newer` parses each dotted component and requires a major and a minor, so `v3` and `nightly` win nothing |
| A pane that wants a fourth column shares the main one, and never covers the terminal | The grid is full at sidebar + 1fr + changes, 296 and 300 by default and dragged from there. `.main.split` hides `.graph` with `display: none` and clamps `.terminal-pane` to a third, so a pane gets its room from the branch strip rather than from the shell. Never unmount the strip and never let the terminal flex: the first hands its `ResizeObserver` a 0x0 container on the way back, and the second is the 0x0 the old overlay existed to avoid. Whatever a pane types has to be readable while the pane is still open |
| Discarding work asks first, and names both commands when there are two | It is the one action in the changes pane a scrollback cannot undo: nothing there is committed, so `git restore` has no reflog behind it and `git clean` restores nothing at all, it removes a file git never had. Unstaged only, and the dialog says which of the two it is about to do rather than promising a restore for both |
| Staging a hunk types `git apply --cached` against a patch file | It is the one action whose argument nobody can type, since the argument is the hunk. Writing it out under GitView's data folder, never into the repository, makes the argument a path, so the command stays readable and re-runnable and the scrollback still says what happened. `git add -p` does the same underneath. Build the patch from libgit2's bytes rather than from the trimmed display rows, and give a lone hunk a new-side start of its own |
| A diff is read without a pathspec, and capped at 6000 rows | Rename detection pairs a delete with an add, and a pathspec drops one half of the pair before `find_similar` sees it, so a renamed file arrives as a whole-file delete. The cap stands in for virtualisation: 6000 rows of plain DOM paint in 695 ms, and past it the pane names the `git diff` that has the rest |
| The commit history packs its lanes in Rust and walks from the top for every page | A lane depends on every commit newer than it, so a page starting in the middle has nothing to work from. Walking oids is cheap and reading a commit's text is not, so the walk runs whole and only the rows asked for are read: 140 ms a page over 5,500 commits, and the same 140 ms whichever page |
| A lane colour is never `--red` or `--amber` | Those already mean a failed command and a repository wanting attention. A trunk that lands in either reads as a warning it is not, so the history has `--lane-1` to `--lane-6` of its own |
| A read that depends on the refs keys on `refSignature`, never on HEAD alone and never on `scannedAt` | HEAD's branch and counts miss a prune, and `scannedAt` redraws for nothing. The string holds every local tip, so a branch deleted, created or reset reaches the graph, the squash detection and the history, and a refresh that changed nothing leaves all three alone. The Refresh button bumps an epoch inside it, which is how tags and remote refs get re-read at all |
| A sticky element is dimmed by colour, never by `opacity` | Opacity applies to the element's own background, so a translucent line-number gutter lets a long line scroll straight through it |
| The output channel belongs to the session, not to a React effect | An effect-owned callback drops everything a shell prints while its pane is off screen, which is most of what a dev server prints. Sessions outlive views, and so does their output |
| Everything closes with the X in its top right | One gesture for every pane and every dialog, plus `Escape`. A footer button survives only where it is a different act: Cancel abandons a choice, which is not what closing a finished report does |
| A right-click opens the surface's own menu, never the webview's | WebView2 offers Back, Reload, Print and Share, and `App.tsx` swallows the event at the document. A surface with something to offer uses `ContextMenu.tsx` and builds its items from actions it already has; there is no "Type without running" item because shift-click on any item already does that. Text fields keep the native menu for cut, copy and paste |
| A chord is added to `lib/keys.ts` and nowhere else | Three places have to agree on it: the terminal releases it rather than handing it to the shell, `App` acts on it, and the settings dialog lists it. `isClaimed` and `SHORTCUTS` both read the one table, and `chordOf` is the only reading of a key event, so a handler that tests `event.key` itself is a chord the terminal will swallow |
| The clipboard is read in Rust, and written from the webview | `navigator.clipboard.readText()` makes WebView2 raise an Edge permission dialog over the window; `clipboard_text` through `arboard` asks nothing. `writeText` never prompts, so `copyText` stays where it is |

## Building

Rust on Windows needs the MSVC linker, which a Rust install alone does not provide. On a machine
where `vswhere` does not report the C++ tools, rustc reports `link.exe not found` even with Build
Tools installed; sourcing `vcvars64.bat` before cargo fixes it. The exact invocation for this
machine is in the wiki's `Operations/Local Development.md`. CI on `windows-latest` needs none of it.

Run cargo from PowerShell, never Git Bash: `/usr/bin/link` shadows MSVC's `link.exe` and the error
names neither Rust nor Visual Studio.

```bash
npm install
npm run dev                            # Tauri dev, opens a window
npm run build:vite                     # typecheck and bundle the frontend
cd src-tauri && cargo test             # Rust unit tests
npm test                               # TypeScript unit tests, vitest over src/lib/*.test.ts
cd src-tauri && cargo fmt --all        # CI checks this
cd src-tauri && cargo run --example scan -- F:\GitHub
```

`src-tauri/target` reaches several gigabytes within a day and cargo never prunes it. Deleting
`target/debug` reclaims most of it and costs one cold rebuild. The wiki's
`Operations/Local Development.md` has the measurement.

The example is the fastest way to check the scanner against real repositories. It prints per-repo
timings, which is where a slow project shows up.

## Verifying a change

There is no UI test harness. The loop is: `cargo test` and `npm test` for the pure functions, the
scan example for the scanner, then `npm run dev` and look at the window. Record what you measured in the wiki note
rather than in a comment here.

Opening the app is not optional. Every bug found in this project so far survived clippy, `cargo
test`, a full CI build and a read-through, and fell out within minutes of looking at the window.
Two were in the keyboard path, one only appeared after removing a watched folder, and three more
were visual: a path rendered `/src/lib` because of a bidi reorder, two graph rails whose captions
overlapped, and a commit message that followed the selection into the next repository. Command
blocks added four, including one that had been dropping terminal output since Phase 0 whenever a
build finished in a project nobody was looking at. The diff pane added two, both in gutters that
only misbehave once a line is wider than the pane, and the commit history added two more that
needed a throwaway repository with six branches to show at all.

Some cases the eleven repositories here do not have. An unrelated history, a branch far ahead with
no upstream, a remote that does not resolve, and anything past a couple of hundred commits each need
a throwaway repository; the wiki's `Operations/Local Development.md` records how to build them, and
`git fast-import` is how to get thousands of commits in seconds rather than minutes.

To click things from a script, start the app with WebView2 debugging on and drive the page over
CDP:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run dev
```

Connect with `playwright-core`'s `chromium.connectOverCDP("http://localhost:9222")`, and pick the
page whose URL starts `http://localhost:5183` rather than `pages()[0]`, since a permission dialog
opens as a page of its own and would take that slot. Keep the driver outside this repository so it
never lands in `npm ci`. Synthetic desktop input does not reach the window on the development
machine; the wiki records why.

A dev build exposes `window.__gitview.sessions`, which is the only way to read a session's blocks,
its markers and its buffer. The WebGL renderer draws to a canvas, so there is no terminal text in
the DOM to scrape. Vite drops the handle from a production bundle.

Restart the app rather than trusting Vite's hot update when the change touches the terminal.
`TerminalPane` holds its sessions in module state, so a hot update leaves the existing `Terminal`
object in place without any new handler attached.
