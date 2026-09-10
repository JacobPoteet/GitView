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

`README.md`, `CLAUDE.md`, `LICENSE`, and the two workflows. Everything else belongs in the wiki. Do
not add a `docs/` folder.

`ci.yml` is the gate and builds `--no-bundle`, so it never produces an artifact. `release.yml` runs
on a `v*` tag, builds the NSIS installer and attaches it to the release. A tag push does not match
`branches: [main]`, which is why CI cannot do both jobs.

## Layout

| Path | Holds |
| --- | --- |
| `src/` | React frontend. Components, plus `lib/api.ts` mirroring the Rust command surface and `lib/shell.ts` quoting the commands that get typed at a prompt |
| `src-tauri/src/fleet.rs` | The scanner. Repository reads, in process |
| `src-tauri/src/graph.rs` | The branch graph. Two bounded revwalks against a chosen base |
| `src-tauri/src/gitops.rs` | `git.exe` subprocess. Everything that touches a remote |
| `src-tauri/src/github.rs` | `gh` subprocess. One aliased GraphQL query for the whole fleet |
| `src-tauri/src/update.rs` | The launch check against the latest GitHub release, through the same `gh` invocation |
| `src-tauri/src/pty.rs` | Terminal sessions, and the base64 that hands the shell its prompt hook |
| `src-tauri/src/shell_integration.ps1` | The OSC 133 hook. Source, not an asset: `include_str!` puts it in the binary |
| `src-tauri/src/tasks.rs` | Task discovery across manifests |
| `src-tauri/src/cache.rs` | SQLite. Cached scans, saved tasks, settings, and the pin and hide preferences |
| `src-tauri/examples/scan.rs` | Headless scanner check, no window |

## Rules that hold across changes

| Rule | Why |
| --- | --- |
| Repository reads go through `git2`, network operations go through `git.exe`, GitHub goes through `gh` | Credential helpers and SSH agents work for free through the CLI. Reimplementing auth is where other GUIs collect "cannot push" reports. The same argument covers the API: `gh api graphql` means GitView never sources, stores or redacts a token, and there is no HTTP client in the binary to add one with |
| A terminal session is never closed on a view change | Closing it would kill a dev server every time the user looked at another project |
| Every action names the command it runs | The GUI accelerates a habit of typing git rather than hiding it. Shift-click types instead of running |
| No generated commit messages, no agent panel, no account, no telemetry | These are the features that made the tool being replaced feel bloated |
| GitHub is read out of sight, but written by typing | A fleet-wide read has nowhere to type, the same as fetch-all. A merge does: `gh pr merge` gets typed into that repository's shell like every other action |
| A command aimed at a repository waits for its session, never for a timer | `sendCommand` writes to the PTY directly, so a command sent while the shell is still starting is lost with an unhandled rejection. Select the repository, then send when `live` reports it |
| Numbers in the wiki are measurements | If a note states a timing or a count, it was measured. Mark a target as a target |
| A preference is never stored in `RepoState` | That struct is scanner output, cached as a blob and rewritten every sweep. Pins and hides live in `repo_pref` and `task_pref`, and the frontend merges them |
| A schema change reaches an installed database by `ALTER TABLE` | The one on this machine holds pins and saved tasks somebody set. `add_column_if_missing` checks `PRAGMA table_info` rather than catching an error whose message would also cover a real failure, and a new column that replaces an old sort key is backfilled from it so the upgrade changes nothing on screen |
| Hiding something removes it from the palette | Demoting it still leaves it in the way, and the palette is where a project's thirty npm scripts do the most damage |
| A release tag must match `tauri.conf.json`, `package.json` and `Cargo.toml` | The installer takes its filename and its Add/Remove Programs entry from the config, so tagging `v0.2.0` without bumping ships a `v0.2.0` release containing `GitView_0.1.0_x64-setup.exe`. `release.yml` fails on the mismatch rather than shipping it |
| A preference is keyed on the path, and follows a rename by `owner/repo` | Keying on the identity outright strands every repository with no remote. `repo_identity` records what was at a path so a move can be recognised afterwards, guarded so two clones of one project cannot fight over a set of pins |
| Staging and committing type their commands too | A single-repository action always has a shell to type into, and the output belongs where the user already looks. Only a fleet-wide action may run out of sight, because one shell would serialise twelve repositories behind whatever is at that prompt |
| A fleet-wide operation keeps a transcript, and the transcript holds what a scrollback would | Fetch-all got away with a count because it has no output worth reading. Sync and prune do, so `lib/batch.ts` records the command as typed, the exit code and both streams per repository, and `git branch -d`'s `(was abc1234)` lines can be copied out. A batch with no transcript is an action that happened where nobody can see it |
| An operation that runs out of sight reports what failed | `git_run` resolves with an exit code rather than throwing, so catching the promise sees almost nothing. Read `code` |
| A batch reads the repository again between its commands | `ahead` and `behind` come from the last sweep, and a fetch is what changes them. Planning the pull from cached counts skips the repository that became fast-forwardable one command ago |
| The prompt hook wraps the user's prompt and touches nothing on disk | Overwriting `prompt` discards Starship and oh-my-posh. The script is handed over as `-EncodedCommand` after the profile has loaded, so it captures whatever is there. Never write to a profile without asking |
| A terminal line number is checked against the command text before it is used | ConPTY repaints on resize and can duplicate a line, and `cls` rewrites lines in place, so a marker stops describing what it was taken from. `anchor` in `TerminalPane.tsx` is the only way to turn a block into a line |
| GitView's own update goes through `gh`, and installs by typing | `tauri-plugin-updater` is what every Tauri project reaches for, and it wants an HTTP client, a TLS stack in a binary built with `lto = true`, and a minisign private key living in an Actions secret. That is the trade the inbox already refused. `gh release view` reads the release out of sight, because the question belongs to the app rather than to a repository; `gh release download` and `Start-Process` get typed at a prompt, so the one action that replaces the binary still names what it ran |
| A version is compared as numbers, and a tag has to look like a version | `0.10.0` sorts below `0.9.0` as a string, and `v2026-09-09` splits into major 2026 with a prerelease of `09-09` and beats everything. `is_newer` parses each dotted component and requires a major and a minor, so `v3` and `nightly` win nothing |
| The output channel belongs to the session, not to a React effect | An effect-owned callback drops everything a shell prints while its pane is off screen, which is most of what a dev server prints. Sessions outlive views, and so does their output |

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
cd src-tauri && cargo test             # unit tests
cd src-tauri && cargo fmt --all        # CI checks this
cd src-tauri && cargo run --example scan -- F:\GitHub
```

`src-tauri/target` reaches several gigabytes within a day and cargo never prunes it. Deleting
`target/debug` reclaims most of it and costs one cold rebuild. The wiki's
`Operations/Local Development.md` has the measurement.

The example is the fastest way to check the scanner against real repositories. It prints per-repo
timings, which is where a slow project shows up.

## Verifying a change

There is no UI test harness. The loop is: `cargo test` for the pure functions, the scan example for
the scanner, then `npm run dev` and look at the window. Record what you measured in the wiki note
rather than in a comment here.

Opening the app is not optional. Every bug found in this project so far survived clippy, `cargo
test`, a full CI build and a read-through, and fell out within minutes of looking at the window.
Two were in the keyboard path, one only appeared after removing a watched folder, and three more
were visual: a path rendered `/src/lib` because of a bidi reorder, two graph rails whose captions
overlapped, and a commit message that followed the selection into the next repository. Command
blocks added four, including one that had been dropping terminal output since Phase 0 whenever a
build finished in a project nobody was looking at.

Some cases the eleven repositories here do not have. An unrelated history, a branch far ahead with
no upstream, and a remote that does not resolve each need a throwaway repository; the wiki's
`Operations/Local Development.md` records how to build them and the two traps in doing so.

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
