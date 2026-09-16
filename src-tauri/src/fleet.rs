//! The fleet scanner.
//!
//! Turns a list of scan roots into the rows on the home screen. Reads run in
//! process through libgit2 rather than by spawning `git` per repository: six
//! invocations across a dozen repos is roughly eighty process spawns per refresh,
//! and Windows process creation is slow enough to feel at that rate.
//!
//! Network operations do not belong here. See `gitops.rs`.

use git2::{BranchType, Oid, Repository, RepositoryState, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::cache::now_secs;

/// One local branch, measured against the default branch.
///
/// The scanner already ran `graph_ahead_behind` per branch to decide what was
/// merged and threw both numbers away. Keeping them costs nothing and answers
/// two separate questions: which branches exist at all when you are standing on
/// the default one, and how far the branch you are on has drifted from it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummary {
    pub name: String,
    /// Commits here that the default branch does not have.
    pub ahead: usize,
    /// Commits on the default branch that are not here.
    pub behind: usize,
    pub is_head: bool,
    /// Contained in the default branch, so `git branch -d` would take it.
    pub merged: bool,
    pub last_commit_at: Option<i64>,
    /// The commit the branch points at. The frontend folds every tip into one
    /// key, so anything that moves a ref, a branch deleted or a commit amended
    /// in the same second, reaches the graph and the history.
    #[serde(default)]
    pub tip: Option<String>,
    /// What the branch tracks, `origin/feat` usually. None is a branch that
    /// has never been pushed, whose every commit is on this disk alone.
    #[serde(default)]
    pub upstream: Option<String>,
    /// Commits here that the upstream does not have. Zero without one; the
    /// measure for that case is `ahead`, against the default branch.
    #[serde(default)]
    pub ahead_of_upstream: usize,
}

/// One tag, and the commit it marks.
///
/// Here for the same reason `BranchSummary.tip` is: a tag created, deleted or
/// moved has to reach `refSignature`, and nothing else in the sweep sees one.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    pub name: String,
    /// The commit, with an annotated tag peeled to the one it wraps.
    pub tip: String,
}

/// What git is in the middle of, when it is in the middle of anything.
///
/// A paused rebase is the state a person most needs a client for and the one
/// a prompt is worst at: with no conflicted files it reads as a detached HEAD
/// and nothing says why. `Repository::state()` knows, and the files under the
/// git dir say how far along it is.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    /// `rebase`, `merge`, `cherry-pick`, `revert`, `bisect` or `am`.
    pub kind: String,
    /// The branch being rebased, from `rebase-merge/head-name`. Nothing else
    /// records one: a merge or a cherry-pick happens on the branch HEAD is on.
    pub branch: Option<String>,
    /// What it is going onto or bringing in: the branch at the rebase's `onto`
    /// when one points there, otherwise a short sha. A merge names
    /// `MERGE_HEAD`, a cherry-pick or revert the commit it is replaying.
    pub onto: Option<String>,
    /// The step a rebase is paused at, counting the one being applied, and how
    /// many there are. Absent for everything but a rebase or an am.
    pub step: Option<usize>,
    pub total: Option<usize>,
}

/// One stash entry, newest first, as `git stash list` prints it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashSummary {
    /// Its position: `stash@{0}` is the newest, and the one `pop` takes.
    pub index: usize,
    /// "WIP on main: abc1234 subject", or whatever `git stash push -m` said.
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: usize,
    pub modified: usize,
    pub untracked: usize,
    pub conflicted: usize,
    pub remote_url: Option<String>,
    pub owner_repo: Option<String>,
    pub default_branch: Option<String>,
    pub merged_branches: Vec<String>,
    pub local_branch_count: usize,
    /// Every local branch, newest first, with the current one leading.
    #[serde(default)]
    pub branches: Vec<BranchSummary>,
    /// Every tag, by name. Part of `refSignature`, like `branches`.
    #[serde(default)]
    pub tags: Vec<TagSummary>,
    /// The ref every branch was measured against, `origin/main` where there is
    /// one. Named so the UI can say what the numbers mean.
    #[serde(default)]
    pub default_base: Option<String>,
    /// Drift of the current branch from that base. Unlike `ahead` and `behind`
    /// these are filled whether or not the branch has an upstream, which is the
    /// case where work exists in exactly one place.
    #[serde(default)]
    pub ahead_of_default: usize,
    #[serde(default)]
    pub behind_default: usize,
    pub last_commit_at: Option<i64>,
    pub last_commit_summary: Option<String>,
    pub is_worktree: bool,
    /// A rebase, merge, cherry-pick, revert, bisect or am that git is paused
    /// in. None when it is not, which is nearly always.
    #[serde(default)]
    pub operation: Option<Operation>,
    /// Every stash, newest first. Work set aside and, a week later, forgotten.
    #[serde(default)]
    pub stashes: Vec<StashSummary>,
    pub error: Option<String>,
    pub scanned_at: i64,
}

impl RepoState {
    fn empty(path: &Path) -> Self {
        Self {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
            branch: None,
            detached: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            conflicted: 0,
            remote_url: None,
            owner_repo: None,
            default_branch: None,
            merged_branches: Vec::new(),
            local_branch_count: 0,
            branches: Vec::new(),
            tags: Vec::new(),
            default_base: None,
            ahead_of_default: 0,
            behind_default: 0,
            last_commit_at: None,
            last_commit_summary: None,
            is_worktree: false,
            operation: None,
            stashes: Vec::new(),
            error: None,
            scanned_at: now_secs(),
        }
    }
}

/// Walks each scan root one level deep and collects the directories that hold a
/// `.git` entry.
///
/// One level is deliberate. Recursing turns up vendored checkouts and anything
/// under `node_modules`, and the roots are already flat.
pub fn discover(roots: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    for root in roots {
        let root_path = Path::new(root);
        if !root_path.is_dir() {
            continue;
        }

        // A root can itself be a repository.
        if is_repo(root_path) {
            out.push(root_path.to_path_buf());
        }

        let Ok(entries) = std::fs::read_dir(root_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && is_repo(&path) {
                out.push(path);
            }
        }
    }

    out.sort();
    out.dedup();
    out
}

/// `.git` counts whether it is a directory or a file. A worktree created by
/// `git worktree add` stores `.git` as a file holding a `gitdir:` pointer, and a
/// directory-only check would skip every worktree on disk.
fn is_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

pub fn read_repo(path: &Path) -> RepoState {
    let mut state = RepoState::empty(path);
    state.is_worktree = path.join(".git").is_file();

    let mut repo = match Repository::open(path) {
        Ok(repo) => repo,
        Err(err) => {
            state.error = Some(err.message().to_string());
            return state;
        }
    };

    read_head(&repo, &mut state);
    read_upstream(&repo, &mut state);
    read_status(&repo, &mut state);
    read_remote(&repo, &mut state);
    state.default_branch = default_branch(&repo);
    read_branches(&repo, &mut state);
    read_tags(&repo, &mut state);
    state.operation = read_operation(&repo);
    read_stashes(&mut repo, &mut state);

    state.scanned_at = now_secs();
    state
}

fn read_head(repo: &Repository, state: &mut RepoState) {
    let Ok(head) = repo.head() else {
        // An unborn HEAD is a fresh `git init` with no commits. Not an error.
        state.branch = repo
            .find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(|t| short_ref(t).to_string()));
        return;
    };

    if head.is_branch() {
        state.branch = head.shorthand().map(str::to_string);
    } else {
        state.detached = true;
        state.branch = head.target().map(|oid| oid.to_string()[..7].to_string());
    }

    if let Some(oid) = head.target() {
        if let Ok(commit) = repo.find_commit(oid) {
            state.last_commit_at = Some(commit.time().seconds());
            state.last_commit_summary = commit.summary().map(str::to_string);
        }
    }
}

fn read_upstream(repo: &Repository, state: &mut RepoState) {
    if state.detached {
        return;
    }
    let Some(branch_name) = state.branch.clone() else {
        return;
    };
    let Ok(branch) = repo.find_branch(&branch_name, BranchType::Local) else {
        return;
    };
    let Ok(upstream) = branch.upstream() else {
        return;
    };

    state.upstream = upstream.name().ok().flatten().map(str::to_string);

    if let (Some(local_oid), Some(upstream_oid)) = (branch.get().target(), upstream.get().target())
    {
        if let Ok((ahead, behind)) = repo.graph_ahead_behind(local_oid, upstream_oid) {
            state.ahead = ahead;
            state.behind = behind;
        }
    }
}

fn read_status(repo: &Repository, state: &mut RepoState) {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        // Collapsing an untracked directory to one entry keeps a fresh clone with
        // no node_modules install from counting thousands of files.
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .include_unmodified(false)
        .exclude_submodules(true);

    let Ok(statuses) = repo.statuses(Some(&mut opts)) else {
        return;
    };

    let index_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE;
    let worktree_flags =
        Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE;

    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_conflicted() {
            state.conflicted += 1;
            continue;
        }
        if status.intersects(index_flags) {
            state.staged += 1;
        }
        if status.contains(Status::WT_NEW) {
            state.untracked += 1;
        } else if status.intersects(worktree_flags) {
            state.modified += 1;
        }
    }
}

/// One row in the changes pane.
///
/// A file staged and then edited again is two rows, the way `git status` reports
/// it, because the two halves take different commands to undo.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// `new`, `modified`, `deleted`, `renamed`, `typechange` or `conflicted`.
    pub state: String,
    /// In the index rather than the worktree.
    pub staged: bool,
}

/// The working tree, file by file.
///
/// `read_status` counts these for the sidebar and throws the paths away, since a
/// row that says `3 changed` needs no more than that. The changes pane needs the
/// paths, and it is opened for one repository at a time rather than eleven, so
/// this is a separate read instead of a wider scan.
pub fn read_changes(path: &Path) -> Vec<FileChange> {
    let Ok(repo) = Repository::open(path) else {
        return Vec::new();
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        // Unlike the sweep, this one names files, and a collapsed directory
        // cannot be staged by path. A fresh clone with no install is the cost.
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false)
        .exclude_submodules(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let Ok(statuses) = repo.statuses(Some(&mut opts)) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in statuses.iter() {
        let status = entry.status();
        let name = entry.path().map(str::to_string).unwrap_or_default();
        if name.is_empty() {
            continue;
        }

        if status.is_conflicted() {
            out.push(FileChange {
                path: name,
                state: "conflicted".to_string(),
                staged: false,
            });
            continue;
        }

        if let Some(state) = index_state(status) {
            out.push(FileChange {
                path: name.clone(),
                state,
                staged: true,
            });
        }
        if let Some(state) = worktree_state(status) {
            out.push(FileChange {
                path: name,
                state,
                staged: false,
            });
        }
    }

    out.sort_by(|a, b| a.staged.cmp(&b.staged).then(a.path.cmp(&b.path)));
    out
}

fn index_state(status: Status) -> Option<String> {
    let state = if status.contains(Status::INDEX_NEW) {
        "new"
    } else if status.contains(Status::INDEX_DELETED) {
        "deleted"
    } else if status.contains(Status::INDEX_RENAMED) {
        "renamed"
    } else if status.contains(Status::INDEX_TYPECHANGE) {
        "typechange"
    } else if status.contains(Status::INDEX_MODIFIED) {
        "modified"
    } else {
        return None;
    };
    Some(state.to_string())
}

fn worktree_state(status: Status) -> Option<String> {
    let state = if status.contains(Status::WT_NEW) {
        "new"
    } else if status.contains(Status::WT_DELETED) {
        "deleted"
    } else if status.contains(Status::WT_RENAMED) {
        "renamed"
    } else if status.contains(Status::WT_TYPECHANGE) {
        "typechange"
    } else if status.contains(Status::WT_MODIFIED) {
        "modified"
    } else {
        return None;
    };
    Some(state.to_string())
}

fn read_remote(repo: &Repository, state: &mut RepoState) {
    let Ok(remote) = repo.find_remote("origin") else {
        return;
    };
    let Some(url) = remote.url() else {
        return;
    };
    state.remote_url = Some(redact_userinfo(url));
    state.owner_repo = parse_owner_repo(url);
}

/// Strips the `user:token@` component from an HTTP remote before the URL reaches
/// the cache.
///
/// `git remote set-url origin https://user:token@github.com/o/r` is a real thing
/// people do, and the cache is a plain file inside the roaming profile, so
/// storing the URL verbatim would write that token into every backup and sync
/// target. `git@github.com:o/r` is left alone: that is a username, not a secret.
pub fn redact_userinfo(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let Some((userinfo, host)) = rest.split_once('@') else {
        return url.to_string();
    };
    // Only the password half is a secret, and only when there is one.
    match userinfo.split_once(':') {
        Some((user, _)) => format!("{scheme}://{user}:***@{host}"),
        None => url.to_string(),
    }
}

/// Pulls `owner/repo` out of an origin URL so the GitHub layer can alias the whole
/// fleet into one GraphQL query.
pub fn parse_owner_repo(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);

    // git@github.com:owner/repo
    let tail = if let Some((_, after)) = without_git.split_once("github.com:") {
        after
    } else if let Some((_, after)) = without_git.split_once("github.com/") {
        after
    } else {
        return None;
    };

    let mut parts = tail.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?;
    Some(format!("{owner}/{repo}"))
}

fn default_branch(repo: &Repository) -> Option<String> {
    // What origin says, when origin has been asked.
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            return Some(short_ref(target).to_string());
        }
    }
    for candidate in ["main", "master", "develop", "trunk"] {
        if repo.find_branch(candidate, BranchType::Local).is_ok() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn short_ref(reference: &str) -> &str {
    reference.rsplit('/').next().unwrap_or(reference)
}

/// Where the default branch actually is, preferring the remote copy.
///
/// The local copy of `main` is usually the stale one, so measuring drift against
/// it understates how far a branch has run. This is the same choice `graph.rs`
/// makes in `pick_base`, and the two have to agree or the sidebar and the graph
/// would report different numbers for the same branch.
fn default_tip(repo: &Repository, default_branch: Option<&str>) -> (Option<Oid>, Option<String>) {
    let Some(name) = default_branch else {
        return (None, None);
    };
    let remote = format!("origin/{name}");
    if let Ok(branch) = repo.find_branch(&remote, BranchType::Remote) {
        if let Some(oid) = branch.get().target() {
            return (Some(oid), Some(remote));
        }
    }
    if let Ok(branch) = repo.find_branch(name, BranchType::Local) {
        if let Some(oid) = branch.get().target() {
            return (Some(oid), Some(name.to_string()));
        }
    }
    (None, None)
}

/// Every local branch, measured against that tip in one pass.
///
/// This walk already existed to find merged branches. It now keeps both halves
/// of each `graph_ahead_behind` result rather than testing one and discarding
/// the pair, which is what lets the sidebar sort on drift and the header list
/// the branches you cannot otherwise see from the default branch.
fn read_branches(repo: &Repository, state: &mut RepoState) {
    let (default_tip, base_name) = default_tip(repo, state.default_branch.as_deref());
    state.default_base = base_name;

    let Ok(branches) = repo.branches(Some(BranchType::Local)) else {
        return;
    };

    for item in branches.flatten() {
        let (branch, _) = item;
        let Ok(Some(name)) = branch.name() else {
            continue;
        };
        let name = name.to_string();
        state.local_branch_count += 1;

        let tip = branch.get().target();
        let last_commit_at = tip
            .and_then(|oid| repo.find_commit(oid).ok())
            .map(|commit| commit.time().seconds());
        let is_head = !state.detached && Some(&name) == state.branch.as_ref();

        // Every branch, not only HEAD's: the one switched away from last
        // week with three commits nobody has pushed is the one the fleet
        // view exists to surface.
        let upstream = branch.upstream().ok();
        let upstream_name = upstream
            .as_ref()
            .and_then(|u| u.name().ok().flatten().map(str::to_string));
        let ahead_of_upstream = match (tip, upstream.as_ref().and_then(|u| u.get().target())) {
            (Some(tip), Some(up)) => repo
                .graph_ahead_behind(tip, up)
                .map(|(a, _)| a)
                .unwrap_or(0),
            _ => 0,
        };

        let (ahead, behind) = match (tip, default_tip) {
            (Some(tip), Some(base)) => repo.graph_ahead_behind(tip, base).unwrap_or((0, 0)),
            // Nothing to measure against. Unrelated histories are not a special
            // case here: libgit2 counts both sides in full, which is the truth.
            _ => (0, 0),
        };

        // Never propose deleting the branch you are standing on or the default.
        let protected = Some(&name) == state.default_branch.as_ref() || is_head;
        let merged = !protected && default_tip.is_some() && tip.is_some() && ahead == 0;
        if merged {
            state.merged_branches.push(name.clone());
        }

        if is_head {
            state.ahead_of_default = ahead;
            state.behind_default = behind;
        }

        state.branches.push(BranchSummary {
            name,
            ahead,
            behind,
            is_head,
            merged,
            last_commit_at,
            tip: tip.map(|oid| oid.to_string()),
            upstream: upstream_name,
            ahead_of_upstream,
        });
    }

    // The branch you are on leads, then the ones touched most recently. A list
    // ordered by name buries the branch from yesterday under an alphabet.
    state.branches.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then(b.last_commit_at.cmp(&a.last_commit_at))
            .then(a.name.cmp(&b.name))
    });
}

/// Every tag, peeled to its commit, by name.
///
/// Sorted so two sweeps of an unchanged repository build the same key, whatever
/// order the reference iterator gave.
fn read_tags(repo: &Repository, state: &mut RepoState) {
    let _ = repo.tag_foreach(|oid, name| {
        let name = String::from_utf8_lossy(name);
        let name = name.strip_prefix("refs/tags/").unwrap_or(&name).to_string();
        let tip = repo
            .find_tag(oid)
            .ok()
            .and_then(|tag| tag.peel().ok())
            .map(|obj| obj.id())
            .unwrap_or(oid);
        state.tags.push(TagSummary {
            name,
            tip: tip.to_string(),
        });
        true
    });
    state.tags.sort_by(|a, b| a.name.cmp(&b.name));
}

/// Every stash entry, newest first.
///
/// `stash_foreach` wants the repository mutable, which the Fleet View note
/// once gave as the reason this was not read. `read_repo` opens a repository
/// of its own per read, so it has always owned a mutable one; the cost is a
/// walk of the `refs/stash` reflog, which is empty nearly everywhere.
fn read_stashes(repo: &mut Repository, state: &mut RepoState) {
    let mut found = Vec::new();
    let _ = repo.stash_foreach(|index, message, _oid| {
        found.push(StashSummary {
            index,
            message: message.to_string(),
        });
        true
    });
    state.stashes = found;
}

/// The operation git is paused in, and where it stands.
///
/// `state()` names it. The rest is read from the files git leaves under the
/// git dir, which `repo.path()` resolves for a worktree too: `rebase-merge/`
/// for the merge and interactive backends, `rebase-apply/` for `am` and the
/// apply backend, `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD` for the
/// rest. A file that is missing leaves its field empty rather than failing
/// the read, since the kind alone is worth showing.
pub fn read_operation(repo: &Repository) -> Option<Operation> {
    let git = repo.path();
    let read = |name: &str| {
        std::fs::read_to_string(git.join(name))
            .ok()
            .map(|s| s.trim().to_string())
    };
    let count = |name: &str| read(name).and_then(|s| s.parse::<usize>().ok());
    // A short sha, or the branch standing at it when one does: `onto` is an
    // oid and "onto main" is what the person typed.
    let name_of = |text: &str| -> Option<String> {
        let oid = Oid::from_str(text).ok()?;
        let mut branch = None;
        if let Ok(branches) = repo.branches(None) {
            for (b, _) in branches.flatten() {
                if b.get().target() == Some(oid) {
                    if let Ok(Some(name)) = b.name() {
                        branch = Some(name.to_string());
                        break;
                    }
                }
            }
        }
        Some(branch.unwrap_or_else(|| text[..text.len().min(7)].to_string()))
    };

    let mut op = Operation {
        kind: String::new(),
        branch: None,
        onto: None,
        step: None,
        total: None,
    };
    match repo.state() {
        RepositoryState::Clean => return None,
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => {
            op.kind = "rebase".to_string();
            let merge = git.join("rebase-merge").is_dir();
            let dir = if merge {
                "rebase-merge"
            } else {
                "rebase-apply"
            };
            op.branch = read(&format!("{dir}/head-name")).map(|r| short_ref(&r).to_string());
            op.onto = read(&format!("{dir}/onto")).and_then(|o| name_of(&o));
            let (step, total) = if merge {
                ("rebase-merge/msgnum", "rebase-merge/end")
            } else {
                ("rebase-apply/next", "rebase-apply/last")
            };
            op.step = count(step);
            op.total = count(total);
        }
        RepositoryState::Merge => {
            op.kind = "merge".to_string();
            op.onto = read("MERGE_HEAD")
                .and_then(|h| h.lines().next().map(str::to_string))
                .and_then(|h| name_of(&h));
        }
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            op.kind = "cherry-pick".to_string();
            op.onto = read("CHERRY_PICK_HEAD").and_then(|h| name_of(&h));
        }
        RepositoryState::Revert | RepositoryState::RevertSequence => {
            op.kind = "revert".to_string();
            op.onto = read("REVERT_HEAD").and_then(|h| name_of(&h));
        }
        RepositoryState::Bisect => op.kind = "bisect".to_string(),
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => {
            op.kind = "am".to_string();
            op.step = count("rebase-apply/next");
            op.total = count("rebase-apply/last");
        }
    }
    Some(op)
}

#[cfg(test)]
mod tests {
    use super::{parse_owner_repo, read_operation, read_repo};

    #[test]
    fn parses_every_origin_url_shape() {
        let cases = [
            "https://github.com/JacobPoteet/GitView.git",
            "https://github.com/JacobPoteet/GitView",
            "git@github.com:JacobPoteet/GitView.git",
            "ssh://git@github.com/JacobPoteet/GitView.git",
        ];
        for url in cases {
            assert_eq!(
                parse_owner_repo(url).as_deref(),
                Some("JacobPoteet/GitView"),
                "failed on {url}"
            );
        }
    }

    #[test]
    fn strips_a_token_from_a_remote_before_caching() {
        assert_eq!(
            super::redact_userinfo("https://jacob:ghp_secret@github.com/o/r.git"),
            "https://jacob:***@github.com/o/r.git"
        );
        // A username with no password is not a secret, and neither is scp-style ssh.
        assert_eq!(
            super::redact_userinfo("https://jacob@github.com/o/r.git"),
            "https://jacob@github.com/o/r.git"
        );
        assert_eq!(
            super::redact_userinfo("git@github.com:o/r.git"),
            "git@github.com:o/r.git"
        );
        assert_eq!(
            super::redact_userinfo("https://github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
    }

    #[test]
    fn ignores_non_github_remotes() {
        assert_eq!(parse_owner_repo("https://gitlab.com/a/b.git"), None);
        assert_eq!(parse_owner_repo(""), None);
    }

    /// A lightweight tag is its commit; an annotated one has to be peeled to
    /// reach it. Both come out as the commit, sorted by name, because the
    /// frontend compares them with what `git ls-remote` peels to.
    /// A rebase paused on a conflict, built with git.exe because libgit2 has
    /// no rebase that writes `rebase-merge/`, and the files there are what is
    /// being read.
    #[test]
    fn a_paused_rebase_says_which_branch_onto_what_and_how_far() {
        let dir = std::env::temp_dir().join(format!("gitview-op-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git.exe");
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("f"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        git(&["switch", "-qc", "feat"]);
        std::fs::write(dir.join("f"), "feat one\n").unwrap();
        git(&["commit", "-qam", "one"]);
        std::fs::write(dir.join("f"), "feat two\n").unwrap();
        git(&["commit", "-qam", "two"]);
        git(&["switch", "-q", "main"]);
        std::fs::write(dir.join("f"), "main\n").unwrap();
        git(&["commit", "-qam", "main moved"]);
        git(&["switch", "-q", "feat"]);
        git(&["rebase", "main"]);

        let repo = git2::Repository::open(&dir).unwrap();
        let op = read_operation(&repo).expect("a rebase in progress");
        assert_eq!(op.kind, "rebase");
        assert_eq!(op.branch.as_deref(), Some("feat"));
        assert_eq!(op.onto.as_deref(), Some("main"));
        assert_eq!((op.step, op.total), (Some(1), Some(2)));

        git(&["rebase", "--abort"]);
        assert!(read_operation(&repo).is_none());
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A branch switched away from with commits past its upstream, and one
    /// that was never pushed, each measured on its own rather than only HEAD.
    #[test]
    fn every_branch_knows_its_upstream_and_its_lead_over_it() {
        let dir = std::env::temp_dir().join(format!("gitview-up-{}", std::process::id()));
        let origin = dir.join("origin.git");
        let work = dir.join("work");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&work).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git.exe");
        };
        git(&dir, &["init", "-q", "--bare", "origin.git"]);
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "user.email", "t@t"]);
        git(&work, &["config", "user.name", "t"]);
        git(&work, &["config", "commit.gpgsign", "false"]);
        git(
            &work,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        std::fs::write(work.join("f"), "base\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "base"]);
        git(&work, &["push", "-q", "-u", "origin", "main"]);
        // Pushed once, then one more commit.
        git(&work, &["switch", "-qc", "tracked"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "sent"]);
        git(&work, &["push", "-q", "-u", "origin", "tracked"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "kept"]);
        // Never pushed at all.
        git(&work, &["switch", "-qc", "local", "main"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "two"]);
        git(&work, &["switch", "-q", "main"]);

        let state = read_repo(&work);
        let by_name = |n: &str| state.branches.iter().find(|b| b.name == n).unwrap();
        assert_eq!(by_name("main").upstream.as_deref(), Some("origin/main"));
        assert_eq!(by_name("main").ahead_of_upstream, 0);
        assert_eq!(
            by_name("tracked").upstream.as_deref(),
            Some("origin/tracked")
        );
        assert_eq!(by_name("tracked").ahead_of_upstream, 1);
        assert_eq!(by_name("local").upstream, None);
        assert_eq!(by_name("local").ahead, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stashes_are_read_newest_first() {
        let dir = std::env::temp_dir().join(format!("gitview-stash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git.exe");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("f"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        assert!(read_repo(&dir).stashes.is_empty());

        std::fs::write(dir.join("f"), "one\n").unwrap();
        git(&["stash", "push", "-q", "-m", "first thing"]);
        std::fs::write(dir.join("f"), "two\n").unwrap();
        git(&["stash", "push", "-q", "-m", "second thing"]);

        let state = read_repo(&dir);
        let messages: Vec<(usize, &str)> = state
            .stashes
            .iter()
            .map(|s| (s.index, s.message.as_str()))
            .collect();
        assert_eq!(
            messages,
            vec![(0, "On main: second thing"), (1, "On main: first thing")]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tags_are_read_peeled_and_sorted() {
        use git2::{Repository, Signature};
        let dir = std::env::temp_dir().join(format!(
            "gitview-fleet-tags-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let repo = Repository::init(&dir).expect("git init");
        let sig = Signature::now("Test", "test@example.com").expect("signature");
        let tree_id = repo
            .treebuilder(None)
            .expect("treebuilder")
            .write()
            .expect("tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let commit = repo
            .commit(Some("refs/heads/main"), &sig, &sig, "one", &tree, &[])
            .expect("commit");
        let object = repo.find_object(commit, None).expect("object");
        repo.tag_lightweight("zeta", &object, false)
            .expect("lightweight");
        let annotated = repo
            .tag("alpha", &object, &sig, "a release", false)
            .expect("annotated");
        assert_ne!(annotated, commit, "an annotated tag is its own object");

        let state = super::read_repo(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        let tags: Vec<(&str, &str)> = state
            .tags
            .iter()
            .map(|t| (t.name.as_str(), t.tip.as_str()))
            .collect();
        let id = commit.to_string();
        assert_eq!(tags, vec![("alpha", id.as_str()), ("zeta", id.as_str())]);
    }
}
