//! Branches that were squash-merged, and the commit each one became.
//!
//! A squash-merge builds a new commit out of a branch's content and gives it
//! one parent, so nothing in the object database records where it came from.
//! The branch is not an ancestor of anything; it forks off and stops. That is
//! what [[Commit History]] draws, and it is the truth, and it leaves two things
//! broken that this module fixes.
//!
//! `git branch -d` refuses a branch that is not an ancestor, and the scanner
//! decides merged the same way, so a fleet that squashes every pull request
//! accumulates local branches nothing will ever offer to delete. And the graph
//! cannot say that the commit on the trunk is the branch, because it has no
//! reason to think so.
//!
//! The test is git's own, the one behind `git cherry`: build the commit a squash
//! would have produced, take its patch id, and look for a commit on the trunk
//! carrying the same one. Nothing is written to the repository, no network is
//! touched, and it works for any host rather than only for GitHub.

use git2::{BranchType, Oid, Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// A ceiling on the trunk walk, for the case the fork point is not on it.
///
/// A branch normally stops the walk itself: a squash of that branch has to sit
/// somewhere between the trunk's tip and the commit the branch forked at, so
/// there is no reason to look past the fork. That only works when the fork is on
/// the trunk's first-parent line, and a branch taken off a commit that arrived
/// through a merge is not. This is what stops that case walking the repository.
const MAX_LOOKBACK: usize = 500;

/// A ceiling on how many branches are measured at once.
///
/// Each one costs a tree diff and a patch id before the walk starts. A fleet
/// with a hundred stale remote branches would spend that hundred times over for
/// an answer nobody reads past the first few rows.
const MAX_CANDIDATES: usize = 64;

/// A branch whose content is already on the trunk under a different commit.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Squashed {
    pub branch: String,
    /// The commit on the trunk carrying the same patch.
    pub into: String,
    pub into_short: String,
    pub into_summary: String,
    /// The ref it was measured against, so the UI can say what it means.
    pub base: String,
    /// Commits on the branch that the squash rolled into one.
    pub commits: usize,
    /// Standing on it, or it is the default branch. Never offer to delete it.
    pub protected: bool,
    /// A remote-tracking ref. Worth drawing the join for, and not something
    /// `git branch -D` can delete, so prune leaves it alone.
    pub remote: bool,
}

/// A branch waiting to be matched against the trunk, with the work done once.
struct Candidate {
    name: String,
    /// The commit the branch forked at. The walk cannot usefully go past it:
    /// a squash of this branch has to be newer than the point it forked from.
    fork: Oid,
    patch: Oid,
    commits: usize,
    protected: bool,
    remote: bool,
}

/// Every branch, local or remote, that is squash-merged into the trunk.
///
/// Read on demand for the repository that is open, not during the fleet sweep.
///
/// The order matters more than it looks. Building the trunk's patch ids first
/// and then asking each branch about them is the obvious shape and it is what
/// made this cost four seconds on a repository with no squashed branches at
/// all: every commit in the lookback got a tree diff and a patch id whether or
/// not anything was ever going to match it. The branches come first now, and a
/// repository with nothing to match walks no trunk at all.
pub fn detect(repo_path: &Path) -> Vec<Squashed> {
    let Ok(repo) = Repository::open(repo_path) else {
        return Vec::new();
    };
    let Some((base_oid, base_name)) = trunk(&repo) else {
        return Vec::new();
    };

    let mut candidates = candidates(&repo, base_oid);
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let Ok(mut walk) = repo.revwalk() else {
        return out;
    };
    if walk.push(base_oid).is_err() {
        return out;
    }
    walk.set_sorting(Sort::TOPOLOGICAL).ok();
    // First parent only. A commit reached through a merge's second parent is on
    // a branch rather than on the trunk, and a squash lands on the trunk.
    walk.simplify_first_parent().ok();

    for (seen, step) in walk.enumerate() {
        if seen >= MAX_LOOKBACK || candidates.is_empty() {
            break;
        }
        let Ok(oid) = step else { continue };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };

        // A root commit has nothing to diff against, and a merge's own diff is
        // not a patch anybody squashed. Both still count against the lookback.
        if commit.parent_count() == 1 {
            if let Some(patch) = commit_patch(&repo, &commit) {
                let mut matched = Vec::new();
                for (index, candidate) in candidates.iter().enumerate() {
                    if candidate.patch == patch {
                        matched.push(index);
                    }
                }
                for index in matched.iter().rev() {
                    let candidate = candidates.remove(*index);
                    out.push(Squashed {
                        branch: candidate.name,
                        into: oid.to_string(),
                        into_short: oid.to_string().chars().take(7).collect(),
                        into_summary: commit.summary().unwrap_or("").to_string(),
                        base: base_name.clone(),
                        commits: candidate.commits,
                        protected: candidate.protected,
                        remote: candidate.remote,
                    });
                }
            }
        }

        // Past its own fork point a branch cannot have been squashed onto the
        // trunk, because the squash is newer than the commit it was taken from.
        // This is what keeps the walk to a handful of commits in the ordinary
        // case, where the branch was merged last week.
        candidates.retain(|candidate| candidate.fork != oid);
    }

    out.sort_by(|a, b| a.branch.cmp(&b.branch));
    out
}

/// Branches worth measuring, with their patch computed once each.
///
/// A branch already contained in the trunk is skipped: `git branch -d` takes it
/// and the scanner counts it, so reporting it here would offer it twice and put
/// it on the `-D` path for no reason.
fn candidates(repo: &Repository, base: Oid) -> Vec<Candidate> {
    let head = repo.head().ok();
    let head_branch = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().map(str::to_string));
    let default = default_branch(repo);

    let Ok(branches) = repo.branches(None) else {
        return Vec::new();
    };

    // A local branch and its remote-tracking copy almost always point at the
    // same commit, so the fork point and the patch are the same work twice.
    // On the largest repository here that was four tree diffs done seven times,
    // and those diffs are most of what this costs.
    let mut seen: HashMap<(Oid, Oid), (Oid, usize)> = HashMap::new();

    let mut out = Vec::new();
    for (branch, kind) in branches.flatten() {
        if out.len() >= MAX_CANDIDATES {
            break;
        }
        let Ok(Some(name)) = branch.name() else {
            continue;
        };
        let remote = kind == BranchType::Remote;
        // `origin/HEAD` is another name for a branch already in this list.
        if remote && name.ends_with("/HEAD") {
            continue;
        }
        let Some(tip) = branch.get().target() else {
            continue;
        };
        if tip == base {
            continue;
        }
        if repo.graph_descendant_of(base, tip).unwrap_or(false) {
            continue;
        }
        let Ok(fork) = repo.merge_base(tip, base) else {
            continue;
        };
        let (patch, commits) = match seen.get(&(fork, tip)) {
            Some(known) => *known,
            None => {
                let Some(patch) = squash_patch(repo, fork, tip) else {
                    continue;
                };
                let commits = repo
                    .graph_ahead_behind(tip, base)
                    .map(|(ahead, _)| ahead)
                    .unwrap_or(0);
                seen.insert((fork, tip), (patch, commits));
                (patch, commits)
            }
        };

        out.push(Candidate {
            name: name.to_string(),
            fork,
            patch,
            commits,
            protected: !remote
                && (Some(name.to_string()) == head_branch || Some(name.to_string()) == default),
            remote,
        });
    }
    out
}

/// The patch a squash of this branch would have produced.
///
/// The diff from the fork point to the tip, which is exactly what one commit
/// holding the whole branch would contain. `git cherry` reaches the same number
/// by writing a dangling commit; libgit2 takes the patch id off the diff
/// directly, so nothing is written.
fn squash_patch(repo: &Repository, fork: Oid, tip: Oid) -> Option<Oid> {
    let from = repo.find_commit(fork).ok()?.tree().ok()?;
    let to = repo.find_commit(tip).ok()?.tree().ok()?;
    let diff = repo.diff_tree_to_tree(Some(&from), Some(&to), None).ok()?;
    diff.patchid(None).ok()
}

/// One trunk commit's own patch, against its first parent.
fn commit_patch(repo: &Repository, commit: &git2::Commit<'_>) -> Option<Oid> {
    let parent = commit.parent(0).ok()?;
    let from = parent.tree().ok()?;
    let to = commit.tree().ok()?;
    let diff = repo.diff_tree_to_tree(Some(&from), Some(&to), None).ok()?;
    diff.patchid(None).ok()
}

/// What to measure against, preferring the remote copy of the default branch
/// the way the scanner and the branch graph both do.
fn trunk(repo: &Repository) -> Option<(Oid, String)> {
    let default = default_branch(repo)?;
    let remote = format!("origin/{default}");
    if let Ok(branch) = repo.find_branch(&remote, BranchType::Remote) {
        if let Some(oid) = branch.get().target() {
            return Some((oid, remote));
        }
    }
    let branch = repo.find_branch(&default, BranchType::Local).ok()?;
    branch.get().target().map(|oid| (oid, default))
}

fn default_branch(repo: &Repository) -> Option<String> {
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            return Some(target.rsplit('/').next().unwrap_or(target).to_string());
        }
    }
    for name in ["main", "master"] {
        if repo.find_branch(name, BranchType::Local).is_ok() {
            return Some(name.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::path::PathBuf;

    /// A throwaway repository with real files in it, because a patch id off an
    /// empty tree is not a patch id anybody could match.
    struct Fixture {
        dir: PathBuf,
        repo: Repository,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gitview-squash-{tag}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            let repo = Repository::init(&dir).expect("git init");
            Self { dir, repo }
        }

        fn write(&self, name: &str, body: &str) {
            std::fs::write(self.dir.join(name), body).expect("write");
        }

        /// Commits whatever is in the working tree onto `refname`.
        ///
        /// The parent is that ref's own tip, or HEAD when the ref does not
        /// exist yet, which is what starting a branch does. Taking it from the
        /// ref alone made the first commit on a new branch a second root, so
        /// the branch shared no history with the trunk and there was no fork
        /// point for a squash to be measured from.
        fn commit(&self, refname: &str, message: &str) -> Oid {
            let mut index = self.repo.index().expect("index");
            index
                .add_all(["*"], IndexAddOption::DEFAULT, None)
                .expect("add");
            index.write().expect("write index");
            let tree_id = index.write_tree().expect("tree");
            let tree = self.repo.find_tree(tree_id).expect("find tree");
            let sig = Signature::now("Test", "test@example.com").expect("sig");
            let parent = self
                .repo
                .find_reference(refname)
                .ok()
                .and_then(|r| r.target())
                .or_else(|| self.repo.head().ok().and_then(|head| head.target()))
                .and_then(|oid| self.repo.find_commit(oid).ok());
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            self.repo
                .commit(Some(refname), &sig, &sig, message, &tree, &parents)
                .expect("commit")
        }

        /// Moves the working tree to whatever a ref points at, so the next
        /// commit builds on that content rather than on the last one written.
        fn checkout(&self, refname: &str) {
            let obj = self.repo.revparse_single(refname).expect("revparse");
            self.repo
                .checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().force()))
                .expect("checkout tree");
            self.repo.set_head(refname).expect("set head");
        }

        /// What GitHub does on `Squash and merge`: one commit whose tree is the
        /// branch's and whose only parent is the trunk. No link to the branch.
        fn squash_onto(&self, refname: &str, branch: &str, message: &str) -> Oid {
            let onto = self
                .repo
                .find_reference(refname)
                .expect("trunk ref")
                .target()
                .expect("trunk tip");
            let parent = self.repo.find_commit(onto).expect("find trunk tip");
            let tree = self
                .repo
                .revparse_single(branch)
                .expect("branch")
                .peel_to_commit()
                .expect("commit")
                .tree()
                .expect("tree");
            let sig = Signature::now("Test", "test@example.com").expect("sig");
            self.repo
                .commit(Some(refname), &sig, &sig, message, &tree, &[&parent])
                .expect("squash commit")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Builds `main` with two commits, a `feature` off it carrying two more,
    /// and the squash of that feature back onto `main`.
    fn squashed_fixture(tag: &str) -> Fixture {
        let fixture = Fixture::new(tag);
        fixture.write("a.txt", "one\n");
        fixture.commit("refs/heads/main", "first");
        fixture.write("b.txt", "two\n");
        fixture.commit("refs/heads/main", "second");

        fixture.checkout("refs/heads/main");
        fixture.write("feature.txt", "the work\n");
        fixture.commit("refs/heads/feature", "half the work");
        fixture.write("feature.txt", "the work\nand the rest\n");
        fixture.commit("refs/heads/feature", "the other half");

        fixture.checkout("refs/heads/main");
        fixture.squash_onto("refs/heads/main", "refs/heads/feature", "The work (#7)");
        fixture.checkout("refs/heads/main");
        fixture
    }

    /// The case the whole module exists for. Nothing in git links these two,
    /// and the patch id does.
    #[test]
    fn a_squash_merged_branch_is_found_and_named() {
        let fixture = squashed_fixture("found");

        // Precisely the state that makes `git branch -d` refuse it.
        let tip = fixture
            .repo
            .find_branch("feature", BranchType::Local)
            .unwrap()
            .get()
            .target()
            .unwrap();
        let main = fixture
            .repo
            .find_branch("main", BranchType::Local)
            .unwrap()
            .get()
            .target()
            .unwrap();
        assert!(
            !fixture.repo.graph_descendant_of(main, tip).unwrap(),
            "a squash leaves the branch unreachable, or this test proves nothing"
        );

        let found = detect(&fixture.dir);

        assert_eq!(found.len(), 1, "got {found:?}");
        assert_eq!(found[0].branch, "feature");
        assert_eq!(found[0].into, main.to_string());
        assert_eq!(found[0].into_summary, "The work (#7)");
        assert_eq!(found[0].commits, 2, "the squash rolled up two commits");
        assert!(!found[0].protected);
    }

    /// A branch merged the ordinary way is already an ancestor, so `git branch
    /// -d` takes it and the scanner counts it. Reporting it here would offer it
    /// twice and push it onto the `-D` path for no reason.
    #[test]
    fn a_branch_that_is_already_an_ancestor_is_left_alone() {
        let fixture = Fixture::new("ancestor");
        fixture.write("a.txt", "one\n");
        fixture.commit("refs/heads/main", "first");
        fixture.checkout("refs/heads/main");
        fixture.write("b.txt", "two\n");
        let tip = fixture.commit("refs/heads/feature", "work");
        // Fast-forward main onto it, which is what an ordinary merge leaves.
        fixture
            .repo
            .reference("refs/heads/main", tip, true, "ff")
            .expect("move main");

        assert!(detect(&fixture.dir).is_empty());
    }

    /// Work that is genuinely not on the trunk must never be offered for
    /// deletion, since `-D` would destroy it.
    #[test]
    fn an_unmerged_branch_is_not_reported() {
        let fixture = Fixture::new("unmerged");
        fixture.write("a.txt", "one\n");
        fixture.commit("refs/heads/main", "first");
        fixture.checkout("refs/heads/main");
        fixture.write("wip.txt", "not on main anywhere\n");
        fixture.commit("refs/heads/feature", "work in progress");
        fixture.checkout("refs/heads/main");

        assert!(detect(&fixture.dir).is_empty());
    }

    /// Standing on a branch is not a reason to hide it from the graph, and it
    /// is every reason not to delete it.
    #[test]
    fn the_branch_you_are_standing_on_is_flagged_protected() {
        let fixture = squashed_fixture("protected");
        fixture.checkout("refs/heads/feature");

        let found = detect(&fixture.dir);

        assert_eq!(found.len(), 1);
        assert!(found[0].protected, "HEAD is on it");
    }
}
