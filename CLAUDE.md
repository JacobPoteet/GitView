# Working in this repository

Follows the workflow standard in the user CLAUDE.md: squash merges, `/ship` to land a PR,
`/release` to cut one, bugs fixed when found. Deviations are listed at the end.

## The wiki

Documentation lives in the wiki, outside this repository, not in `docs/`. Its path is in the
gitignored `.claude/wiki-path.local`.

Before changing anything architectural, grep `GitView/Decision Log.md` for the area you are
touching. Most choices here have a reason recorded there, including the options already ruled out.
It is one long table and it grows every release, so search it rather than reading it end to end.

**Every pull request names the notes it affects under `## Wiki notes`, and updates `CLAUDE.md` when
a rule moved.** The `/release` pass writes those notes before the tag. A PR that changes the scanner
names `Architecture/Fleet Scanner.md`; a PR that adds a feature names a new note under `Features/`
and the index entry it needs. Edit the wiki between releases only to fix a note that would mislead.

### One note owns a change, the rest link to it

| Note | Gets |
| --- | --- |
| The one that owns the change | the real pass: delete what became false, write what shipped, record what was measured |
| Any other note that mentions it | one corrected sentence, or a `[[link]]`. No restructuring |
| `Decision Log` | a row for a choice someone would otherwise re-litigate, and a dead-end row for something tried and reversed. Not a row per commit |
| `Delivery Phases` and the index | one status entry per phase, not per PR |

Write a finding once, in the note that owns it, and link to it from the others. The ConPTY marker
findings landed in five notes in one PR, which is four copies to keep true from now on. A PR's
`## Wiki notes` section names the owning note first, so the release pass knows where it goes.

### Where the tokens go, and what to skip

| Skip | Instead |
| --- | --- |
| Reading a note end to end to change one section | grep for the heading, read that range, edit it |
| Rewriting prose that is still true | delete what is false and leave the rest |
| Per-file line counts in `Repo Map` | they go stale on every PR. Refresh them when the version bumps |
| A "Measured" table for something nobody measured | a number in the wiki is a measurement. No measurement, no table |
| A new note for a change that fits in an existing one | a note earns its file when it has a reader who would open it on its own |

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

Each Rust module opens with a `//!` comment naming what it owns, so `src-tauri/src` is its own map,
and the wiki's `Architecture/Repo Map.md` covers every file. What the files do not say:

| Path | Holds |
| --- | --- |
| `src/lib/api.ts` | The Rust command surface, mirrored. A new command lands in both |
| `src/hooks/` | State that left `App.tsx`. Each hook owns its state and returns what the render needs; a feature that grows a handful of state goes here rather than into `App` |
| `scripts/install-local.ps1` | `npm run install:local`: build the installer, run it over the installed GitView, start the new one. Never rename the script to `install`, npm runs that on every `npm install` and `npm ci` |
| `scripts/ftue.ps1` | `npm run dev:ftue`: a dev build with a fresh data folder, fresh `localStorage` and fixture repositories, for rehearsing the first run. The wiki's `Operations/Local Development.md` lists the scenarios |

## Rules that hold across changes

These hold everywhere. Area rules live in `.claude/rules/` and load when Claude touches the files
each one covers: `terminal.md`, `git-actions.md`, `history-and-diff.md`, `state.md` and
`interface.md`. A change that crosses into an area its files did not load reads that file first.

| Rule | Why |
| --- | --- |
| Repository reads go through `git2`, network operations go through `git.exe`, GitHub goes through `gh` | Credential helpers and SSH agents work for free through the CLI. Reimplementing auth is where other GUIs collect "cannot push" reports. The same argument covers the API: `gh api graphql` means GitView never sources, stores or redacts a token, and there is no HTTP client in the binary to add one with |
| Every action names the command it runs | The GUI accelerates a habit of typing git rather than hiding it. Shift-click types instead of running |
| No generated commit messages, no agent panel, no account, no telemetry | These are the features that made the tool being replaced feel bloated |
| Numbers in the wiki are measurements | If a note states a timing or a count, it was measured. Mark a target as a target |
| A pull request opens with one kind label at the least and an `area:` label for each part of the app it touches | A phase label dies with its phase; `area: graph` still says which wiki note owns the change three phases on. The kinds are the ones the issues use plus `release`, the areas follow the layout table above, and `gh label list` is the live vocabulary. Pass `--label` to `gh pr create` rather than labelling afterwards, and add a kind for every issue the PR closes. The wiki's `Operations/Wiki and PR Protocol.md` says what each label means |

## Cutting a release

Run `/release`. Version files: `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`; run `cargo check` after the bump so `Cargo.lock` follows. The tag push runs
`release.yml`, which fails on a version mismatch (the installer takes its filename and its
Add/Remove Programs entry from the config, so an unbumped tag would ship the old version's
installer), builds the NSIS installer and attaches it. It
also takes `workflow_dispatch` with a tag, for re-running a release whose build failed. Check that
the release carries `GitView_<version>_x64-setup.exe`.

## Building

Rust on Windows needs the MSVC linker, which a Rust install alone does not provide. On a machine
where `vswhere` does not report the C++ tools, rustc reports `link.exe not found` even with Build
Tools installed; sourcing `vcvars64.bat` before cargo fixes it. The exact invocation for this
machine is in the wiki's `Operations/Local Development.md`. CI on `windows-latest` needs none of it.

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
The wiki's `Operations/Local Development.md` lists them.

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

A dev build honours `GITVIEW_DATA_DIR`, so a test that needs a database of its own, or a broken
one, points the launcher at a scratch folder rather than opening the installed app's. The installed
app and a dev build sharing `%APPDATA%\GitView\gitview.db` is the one thing both corruptions had
in common. Release builds ignore the variable.

`.claude/rules/terminal.md` covers verifying a terminal change: the dev-only sessions handle, and
why a hot update is not enough.

## Deviations from the standard

None.
