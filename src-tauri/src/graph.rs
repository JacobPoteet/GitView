//! The branch graph.
//!
//! This answers one question: how does the branch you are standing on relate to
//! the branch you will merge it into. That is much smaller than "draw the DAG",
//! and the smaller question has a shape a person reads in one glance.
//!
//! The output is three lists rather than a set of lanes, because the lanes here
//! carry meaning. `theirs` is what a pull brings, `ours` is what a merge brings,
//! and `trunk` is the shared history behind the fork. A packing algorithm would
//! assign those same commits to columns that mean nothing.

use git2::{BranchType, Oid, Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Per side. A branch that has run a long way from its base is a wide picture to
/// draw and a wider one to read, so the walk stops and the graph says it stopped.
const MAX_PER_SIDE: usize = 40;

/// Shared commits kept to the left of the fork, for context.
///
/// This is a budget, not a count. The strip decides how many of these it can
/// actually draw from the width it has been given, because a repository sitting
/// in sync with its base has nothing but trunk to show and a two-commit picture
/// left a pane of empty canvas to its right. Thirty-two first-parent commits
/// fill a 2560 px strip at the wide gap and cost one `find_commit` each.
const TRUNK_DEPTH: usize = 32;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub id: String,
    pub short: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
    /// Branch and tag names pointing at this commit, already shortened.
    pub refs: Vec<String>,
    pub is_merge: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchGraph {
    pub path: String,
    /// The branch HEAD is on, or a short id when detached.
    pub head: Option<String>,
    /// The commit HEAD points at, in full.
    ///
    /// The strip marks it. Without it there is no way to see where you are
    /// standing when the branch is level with its base and every node on screen
    /// is shared history, or when HEAD is detached behind the tip.
    pub head_id: Option<String>,
    pub detached: bool,
    /// The branch being compared against, as it should be shown.
    pub base: Option<String>,
    /// Why that base was picked: `remote-default`, `default`, `upstream` or `none`.
    pub base_kind: String,
    /// Shared history, oldest first, ending at the fork point.
    pub trunk: Vec<GraphCommit>,
    /// On the base and not on HEAD, oldest first. What a pull would bring.
    pub theirs: Vec<GraphCommit>,
    /// On HEAD and not on the base, oldest first. What a merge would bring.
    pub ours: Vec<GraphCommit>,
    /// Set when either side hit `MAX_PER_SIDE`, so the view can say so.
    pub truncated: bool,
    /// HEAD and the base share no ancestor at all, so there is no fork to draw.
    ///
    /// An orphan branch, a history grafted in from another repository, anything
    /// in `--allow-unrelated-histories` territory. `ours` and `theirs` stay
    /// correct because they come from revwalks with a `hide`; it is the fork
    /// marker and the shared rail that have nothing to say.
    pub unrelated: bool,
    pub error: Option<String>,
}

impl BranchGraph {
    fn empty(path: &Path) -> Self {
        Self {
            path: path.to_string_lossy().to_string(),
            head: None,
            head_id: None,
            detached: false,
            base: None,
            base_kind: "none".to_string(),
            trunk: Vec::new(),
            theirs: Vec::new(),
            ours: Vec::new(),
            truncated: false,
            unrelated: false,
            error: None,
        }
    }

    fn failed(path: &Path, message: String) -> Self {
        let mut graph = Self::empty(path);
        graph.error = Some(message);
        graph
    }
}

pub fn read(path: &Path) -> BranchGraph {
    let repo = match Repository::open(path) {
        Ok(repo) => repo,
        Err(err) => return BranchGraph::failed(path, err.message().to_string()),
    };

    let mut graph = BranchGraph::empty(path);

    let Ok(head_ref) = repo.head() else {
        // A fresh `git init` with no commits. Nothing to draw and nothing wrong.
        return graph;
    };
    let Some(head_oid) = head_ref.target() else {
        return graph;
    };

    graph.detached = !head_ref.is_branch();
    let head_branch = if graph.detached {
        None
    } else {
        head_ref.shorthand().map(str::to_string)
    };
    graph.head = head_branch
        .clone()
        .or_else(|| Some(short_id(&head_oid.to_string())));
    graph.head_id = Some(head_oid.to_string());

    let names = ref_names(&repo);

    let (base_oid, base_name, base_kind) = pick_base(&repo, head_branch.as_deref());
    graph.base = base_name;
    graph.base_kind = base_kind;

    let Some(base_oid) = base_oid else {
        // Nothing to compare against, so recent history is the whole story.
        graph.trunk = walk_first_parent(&repo, head_oid, TRUNK_DEPTH, &names);
        return graph;
    };

    // A base pointing at the same commit as HEAD is the in-sync case. Both sides
    // come back empty and the trunk carries the picture on its own.
    let (ours, ours_cut) = walk_between(&repo, head_oid, base_oid, &names);
    let (theirs, theirs_cut) = walk_between(&repo, base_oid, head_oid, &names);
    graph.ours = ours;
    graph.theirs = theirs;
    graph.truncated = ours_cut || theirs_cut;

    // No merge base means the two branches never met. Falling back to HEAD here
    // drew the trunk as HEAD's own recent history and claimed the pair parted at
    // a commit only one of them can reach, which is a picture that lies rather
    // than one that fails. The absence is a state now, and the view draws two
    // independent rails and says so.
    match repo.merge_base(head_oid, base_oid) {
        Ok(fork) => graph.trunk = walk_first_parent(&repo, fork, TRUNK_DEPTH, &names),
        Err(_) => graph.unrelated = true,
    }

    graph
}

/// Picks what the current branch should be measured against.
///
/// On a feature branch that is the default branch, preferring `origin/main` over
/// the local copy because the local copy is usually the stale one. On the default
/// branch itself there is no other trunk to compare to, so it falls back to that
/// branch's own upstream, which is the ahead and behind question instead.
fn pick_base(
    repo: &Repository,
    head_branch: Option<&str>,
) -> (Option<Oid>, Option<String>, String) {
    let default = default_branch(repo);

    if let (Some(head), Some(default)) = (head_branch, default.as_deref()) {
        if head != default {
            let remote = format!("origin/{default}");
            if let Some(oid) = branch_oid(repo, &remote, BranchType::Remote) {
                return (Some(oid), Some(remote), "remote-default".to_string());
            }
            if let Some(oid) = branch_oid(repo, default, BranchType::Local) {
                return (Some(oid), Some(default.to_string()), "default".to_string());
            }
        }
    }

    if let Some(head) = head_branch {
        if let Ok(branch) = repo.find_branch(head, BranchType::Local) {
            if let Ok(upstream) = branch.upstream() {
                let name = upstream.name().ok().flatten().map(str::to_string);
                if let (Some(oid), Some(name)) = (upstream.get().target(), name) {
                    return (Some(oid), Some(name), "upstream".to_string());
                }
            }
        }
    }

    (None, None, "none".to_string())
}

fn branch_oid(repo: &Repository, name: &str, kind: BranchType) -> Option<Oid> {
    repo.find_branch(name, kind).ok()?.get().target()
}

fn default_branch(repo: &Repository) -> Option<String> {
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            return Some(target.rsplit('/').next().unwrap_or(target).to_string());
        }
    }
    for candidate in ["main", "master", "develop", "trunk"] {
        if repo.find_branch(candidate, BranchType::Local).is_ok() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Commits reachable from `tip` but not from `other`, oldest first.
///
/// The bool says the walk was cut short, which the view turns into a marker
/// rather than silently drawing a shorter branch than the one on disk.
fn walk_between(
    repo: &Repository,
    tip: Oid,
    other: Oid,
    names: &HashMap<Oid, Vec<String>>,
) -> (Vec<GraphCommit>, bool) {
    let Ok(mut walk) = repo.revwalk() else {
        return (Vec::new(), false);
    };
    let _ = walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME);
    if walk.push(tip).is_err() {
        return (Vec::new(), false);
    }
    let _ = walk.hide(other);

    let mut out = Vec::new();
    let mut truncated = false;
    for oid in walk.flatten() {
        if out.len() == MAX_PER_SIDE {
            truncated = true;
            break;
        }
        if let Some(commit) = load(repo, oid, names) {
            out.push(commit);
        }
    }
    // The walk hands back newest first, and the graph reads left to right in time.
    out.reverse();
    (out, truncated)
}

/// The shared spine behind the fork.
///
/// First parent only, so one old merge does not drag an entire side branch into
/// the context rows.
fn walk_first_parent(
    repo: &Repository,
    tip: Oid,
    depth: usize,
    names: &HashMap<Oid, Vec<String>>,
) -> Vec<GraphCommit> {
    let Ok(mut walk) = repo.revwalk() else {
        return Vec::new();
    };
    let _ = walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME);
    if walk.push(tip).is_err() {
        return Vec::new();
    }
    walk.simplify_first_parent().ok();

    let mut out = Vec::new();
    for oid in walk.flatten().take(depth) {
        if let Some(commit) = load(repo, oid, names) {
            out.push(commit);
        }
    }
    out.reverse();
    out
}

fn load(repo: &Repository, oid: Oid, names: &HashMap<Oid, Vec<String>>) -> Option<GraphCommit> {
    let commit = repo.find_commit(oid).ok()?;
    let id = oid.to_string();

    // The signature is bound rather than chained into the struct below. A
    // temporary in the tail expression outlives `commit`, which it borrows from.
    let signature = commit.author();
    let author = signature
        .name()
        .unwrap_or("unknown")
        // A first name is all the width a caption has.
        .split_whitespace()
        .next()
        .unwrap_or("unknown")
        .to_string();

    Some(GraphCommit {
        short: short_id(&id),
        summary: commit.summary().unwrap_or("").to_string(),
        author,
        time: commit.time().seconds(),
        refs: names.get(&oid).cloned().unwrap_or_default(),
        is_merge: commit.parent_count() > 1,
        id,
    })
}

fn short_id(id: &str) -> String {
    id.chars().take(7).collect()
}

/// Every branch and tag name, grouped by the commit it points at, so a node can
/// wear its labels without a lookup per commit.
fn ref_names(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();

    if let Ok(branches) = repo.branches(None) {
        for (branch, kind) in branches.flatten() {
            let Ok(Some(name)) = branch.name() else {
                continue;
            };
            // `origin/HEAD` points at a name that is already in this map.
            if kind == BranchType::Remote && name.ends_with("/HEAD") {
                continue;
            }
            if let Some(oid) = branch.get().target() {
                map.entry(oid).or_default().push(name.to_string());
            }
        }
    }

    let _ = repo.tag_foreach(|oid, name| {
        let name = String::from_utf8_lossy(name);
        let short = name.rsplit('/').next().unwrap_or(&name).to_string();
        // An annotated tag resolves to the commit it wraps; a lightweight tag is
        // the commit already. Either way the peeled id is what the graph draws.
        let target = repo
            .find_tag(oid)
            .ok()
            .and_then(|tag| tag.target().ok())
            .map(|obj| obj.id())
            .unwrap_or(oid);
        map.entry(target).or_default().push(short);
        true
    });

    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::path::PathBuf;

    /// A repository under the system temp directory, removed when the test ends.
    ///
    /// No `tempfile` dependency: one directory and a `Drop` is less to carry than
    /// a crate, and the tree is deliberately short.
    struct Fixture {
        dir: PathBuf,
        repo: Repository,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gitview-graph-{tag}-{}-{:?}",
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

        /// An empty-tree commit on `refname`. The message differs per commit so
        /// two roots with the same tree do not collapse into one object id.
        fn commit(&self, refname: &str, message: &str, parents: &[Oid]) -> Oid {
            let sig = Signature::now("Test", "test@example.com").expect("signature");
            let tree_id = self
                .repo
                .treebuilder(None)
                .expect("treebuilder")
                .write()
                .expect("write tree");
            let tree = self.repo.find_tree(tree_id).expect("find tree");
            let loaded: Vec<git2::Commit> = parents
                .iter()
                .map(|oid| self.repo.find_commit(*oid).expect("find parent"))
                .collect();
            let refs: Vec<&git2::Commit> = loaded.iter().collect();
            self.repo
                .commit(Some(refname), &sig, &sig, message, &tree, &refs)
                .expect("commit")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The case that used to draw a fork at HEAD.
    ///
    /// With no merge base the trunk was `walk_first_parent(head)`, so the picture
    /// claimed the two branches parted at a commit only one of them can reach.
    /// None of the eleven repositories on the development machine has an
    /// unrelated history, which is why this went unnoticed and why it is a
    /// fixture rather than an observation.
    #[test]
    fn an_orphan_branch_has_no_fork_and_says_so() {
        let fixture = Fixture::new("orphan");
        fixture.commit("refs/heads/main", "root of main", &[]);
        fixture.commit("refs/heads/orphan", "root of orphan", &[]);
        fixture
            .repo
            .set_head("refs/heads/orphan")
            .expect("checkout orphan");

        let graph = read(&fixture.dir);

        assert!(graph.error.is_none(), "{:?}", graph.error);
        assert!(graph.unrelated, "two roots share no ancestor");
        assert!(
            graph.trunk.is_empty(),
            "there is no shared history to draw, got {:?}",
            graph.trunk.iter().map(|c| &c.summary).collect::<Vec<_>>()
        );
        // Both sides still come from revwalks with a `hide`, so both stay right.
        assert_eq!(graph.base.as_deref(), Some("main"));
        assert_eq!(graph.ours.len(), 1);
        assert_eq!(graph.theirs.len(), 1);
    }

    /// The ordinary case, so the fix above cannot quietly empty every trunk.
    #[test]
    fn a_branch_off_main_keeps_its_shared_history() {
        let fixture = Fixture::new("fork");
        let first = fixture.commit("refs/heads/main", "one", &[]);
        let second = fixture.commit("refs/heads/main", "two", &[first]);
        fixture.commit("refs/heads/feature", "three", &[second]);
        fixture
            .repo
            .set_head("refs/heads/feature")
            .expect("checkout feature");

        let graph = read(&fixture.dir);

        assert!(!graph.unrelated);
        assert_eq!(graph.trunk.len(), 2, "both shared commits, oldest first");
        assert_eq!(graph.trunk[0].summary, "one");
        assert_eq!(graph.trunk[1].summary, "two");
        assert_eq!(graph.ours.len(), 1);
        assert_eq!(graph.ours[0].summary, "three");
        assert!(graph.theirs.is_empty());
    }

    /// The strip marks the commit you are standing on, and it can only do that
    /// if the id it is matching against is the one HEAD resolves to.
    #[test]
    fn head_id_is_the_commit_head_resolves_to() {
        let fixture = Fixture::new("head-id");
        let first = fixture.commit("refs/heads/main", "one", &[]);
        let second = fixture.commit("refs/heads/main", "two", &[first]);
        // `git init` leaves HEAD on whatever the default branch name is, which
        // is not necessarily the one these commits went to.
        fixture
            .repo
            .set_head("refs/heads/main")
            .expect("checkout main");

        let graph = read(&fixture.dir);
        assert_eq!(graph.head_id.as_deref(), Some(second.to_string().as_str()));

        // Detached behind the tip is the case the old picture could not answer
        // at all: nothing on the strip said which node you were on.
        fixture.repo.set_head_detached(first).expect("detach");
        let behind = read(&fixture.dir);
        assert!(behind.detached);
        assert_eq!(behind.head_id.as_deref(), Some(first.to_string().as_str()));
    }
}
