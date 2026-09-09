//! The fleet scanner.
//!
//! Turns a list of scan roots into the rows on the home screen. Reads run in
//! process through libgit2 rather than by spawning `git` per repository: six
//! invocations across a dozen repos is roughly eighty process spawns per refresh,
//! and Windows process creation is slow enough to feel at that rate.
//!
//! Network operations do not belong here. See `gitops.rs`.

use git2::{BranchType, Repository, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::cache::now_secs;

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
    pub last_commit_at: Option<i64>,
    pub last_commit_summary: Option<String>,
    pub is_worktree: bool,
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
            last_commit_at: None,
            last_commit_summary: None,
            is_worktree: false,
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

    let repo = match Repository::open(path) {
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

fn read_remote(repo: &Repository, state: &mut RepoState) {
    let Ok(remote) = repo.find_remote("origin") else {
        return;
    };
    let Some(url) = remote.url() else {
        return;
    };
    state.remote_url = Some(url.to_string());
    state.owner_repo = parse_owner_repo(url);
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

fn read_branches(repo: &Repository, state: &mut RepoState) {
    let default_tip = state
        .default_branch
        .as_ref()
        .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
        .and_then(|branch| branch.get().target());

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

        // Never propose deleting the branch you are standing on or the default.
        if Some(&name) == state.default_branch.as_ref() || Some(&name) == state.branch.as_ref() {
            continue;
        }

        let (Some(tip), Some(default_tip)) = (branch.get().target(), default_tip) else {
            continue;
        };

        // Nothing on this branch that the default branch does not already have.
        if let Ok((ahead, _behind)) = repo.graph_ahead_behind(tip, default_tip) {
            if ahead == 0 {
                state.merged_branches.push(name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_owner_repo;

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
    fn ignores_non_github_remotes() {
        assert_eq!(parse_owner_repo("https://gitlab.com/a/b.git"), None);
        assert_eq!(parse_owner_repo(""), None);
    }
}
