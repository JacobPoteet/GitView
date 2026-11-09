---
paths:
  - "src-tauri/src/fleet.rs"
  - "src-tauri/src/gitops.rs"
  - "src-tauri/src/cleanup.rs"
  - "src-tauri/src/squash.rs"
  - "src-tauri/src/scratch.rs"
  - "src-tauri/src/github.rs"
  - "src-tauri/src/update.rs"
  - "src-tauri/src/signing.rs"
  - "src/lib/batch.ts"
  - "src/lib/cleanup.ts"
  - "src/lib/inbox.ts"
  - "src/hooks/useBatch.ts"
  - "src/hooks/useInbox.ts"
  - "src/hooks/useUpdate.ts"
  - "src/components/CleanupDialog.tsx"
  - "src/components/BatchDialog.tsx"
  - "src/components/ChangesPane.tsx"
  - "src/components/CommitPane.tsx"
  - "src/components/OperationBar.tsx"
  - "src/components/FleetSidebar.tsx"
  - "src/components/BranchMenu.tsx"
  - "src/components/UpdateDialog.tsx"
  - "src/components/DiffHunks.tsx"
  - "src/components/inbox/**"
---

# Git and GitHub actions

Loaded when Claude touches what GitView runs against a repository: staging, committing, batches, Clean up, GitHub, the update check.

| Rule | Why |
| --- | --- |
| GitHub is read out of sight, but written by typing | A fleet-wide read has nowhere to type, the same as fetch-all. A write does: `gh issue create` and `gh pr merge` get typed into that repository's shell like every other action. An issue body has paragraphs and a newline at a prompt submits the line, so a multi-line body goes out to a file under GitView's data folder and `--body-file` carries the path, the same answer hunk staging gives |
| A paused rebase, merge, cherry-pick, revert, bisect or am is read from `Repository::state()`, and the strip that shows it is never hidden by a pane | With nothing conflicted a paused rebase is a detached HEAD and nothing more, which is the state a prompt is worst at. `read_operation` in `fleet.rs` fills `operation`, `OperationBar.tsx` keeps git's own `hint:` steps on screen under the header, and the state outranks whatever a pane is showing. Continue and Skip type straight away; only Abort asks, since it discards resolution work nothing keeps |
| Staging and committing type their commands too | A single-repository action always has a shell to type into, and the output belongs where the user already looks. Only a fleet-wide action may run out of sight, because one shell would serialise twelve repositories behind whatever is at that prompt. The fetch Clean up opens with is the one exception, since the dialog's answers depend on it, and its button names it while it runs |
| A fleet-wide operation keeps a transcript, and the transcript holds what a scrollback would | Fetch-all got away with a count because it has no output worth reading. Sync and prune do, so `lib/batch.ts` records the command as typed, the exit code and both streams per repository, and `git branch -d`'s `(was abc1234)` lines can be copied out. A batch with no transcript is an action that happened where nobody can see it |
| An operation that runs out of sight reports what failed | `git_run` resolves with an exit code rather than throwing, so catching the promise sees almost nothing. Read `code` |
| An argument nobody can type goes out as a file under GitView's data folder, through `scratch.rs` | A hunk, an issue body and a commit message with a description are the three so far. Each writer used to carry its own sweep; `scratch::dir` is the one that remains, and a new one calls it rather than copying the loop. A subject-only commit stays `-m`, because that reads at the prompt and `-F` for one line would not |
| A batch reads the repository again between its commands | `ahead` and `behind` come from the last sweep, and a fetch is what changes them. Planning the pull from cached counts skips the repository that became fast-forwardable one command ago |
| GitView's own update goes through `gh`, and installs by typing | `tauri-plugin-updater` is what every Tauri project reaches for, and it wants an HTTP client, a TLS stack in a binary built with `lto = true`, and a minisign private key living in an Actions secret. That is the trade the inbox already refused. `gh release view` reads the release out of sight, because the question belongs to the app rather than to a repository; `gh release download` and `Start-Process` get typed at a prompt, so the one action that replaces the binary still names what it ran. The prompt is the selected repository's when there is one, and otherwise a shell GitView opens for itself in its data folder: the command has no interest in a repository, so it never asks you to pick one |
| A version is compared as numbers, and a tag has to look like a version | `0.10.0` sorts below `0.9.0` as a string, and `v2026-09-09` splits into major 2026 with a prerelease of `09-09` and beats everything. `is_newer` parses each dotted component and requires a major and a minor, so `v3` and `nightly` win nothing |
| Discarding work asks first, and names both commands when there are two | It is the one action in the changes pane a scrollback cannot undo: nothing there is committed, so `git restore` has no reflog behind it and `git clean` restores nothing at all, it removes a file git never had. Unstaged only, and the dialog says which of the two it is about to do rather than promising a restore for both |
| A branch another worktree has checked out is never typed into a delete on its own | git refuses it, and in a prune one refusal fails the whole repository. `read_worktrees` in `fleet.rs` fills `BranchSummary.worktree` and keeps such a branch out of `merged_branches`; Clean up (`CleanupDialog.tsx`, planned in `lib/cleanup.ts`) types what frees it ahead of the delete, after closing GitView's own shells there, since Windows will not delete a folder a shell is standing in. Claude Code's worktrees sit under `.claude/worktrees/`, below where discovery looks, so this list is the only place GitView sees them |
| A worktree is removed by a plain `git worktree remove`, after the dialog has dealt with what it would refuse over | `--force` deletes whatever changed after the dialog read the status, and a plain remove still refuses then. Line endings alone get `git restore` by name, real changes a `git stash push -u` that outlives the worktree, a lock `git worktree unlock`. What git will refuse is asked of `git status` through `git.exe`, the one repository read that spawns git, because libgit2 calls a line-ending rewrite clean and git refuses over it. `tauri dev` in a worktree leaves `Cargo.toml` in that state |
| A tick in Clean up starts on only for work that provably landed | A branch contained in the trunk or matched to a squash. A gone upstream is a hint, since anybody can delete a remote branch, and a worktree level with the trunk is what a session started a minute ago looks like. Anything else can be ticked by hand, with what it costs on the row, apart from a branch the main checkout has and a folder something has open. `folder_in_use` renames that folder aside and back, because a remove there stops at git's `Should I try again?` with the rest queued behind it, and answering no leaves the worktree half gone |
| A repository row reports the checked-out branch and nothing else | A chip, the dot, the sort and the fleet summary all read HEAD's branch. Summing every local branch reported commits to push on repositories clean on `main`, and git2's `upstream()` fails on a gone ref the same as on a branch never pushed, so a merged pull request's branch counted as unpushed work. `goneUpstream` tells the two apart. Other branches live in the branch menu and Clean up |
| Staging a hunk types `git apply --cached` against a patch file | It is the one action whose argument nobody can type, since the argument is the hunk. Writing it out under GitView's data folder, never into the repository, makes the argument a path, so the command stays readable and re-runnable and the scrollback still says what happened. `git add -p` does the same underneath. Build the patch from libgit2's bytes rather than from the trimmed display rows, and give a lone hunk a new-side start of its own |
