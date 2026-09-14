//! The full commit history, across every ref.
//!
//! [[Branch Graph]] answers one question about two branches and caps itself at
//! 88 nodes. This is the other thing: the whole DAG, scrolling, with the lanes
//! a packing algorithm assigns. Those lanes carry no meaning of their own, which
//! is exactly why the branch graph does not use them.
//!
//! Lanes are packed here rather than in the frontend. The assignment depends on
//! every commit before the one being drawn, so a page that started in the middle
//! of the history could not work it out from what it holds. The walk therefore
//! runs from the newest commit each time and only the requested window is turned
//! into rows; walking oids is cheap, and `find_commit` is what costs.

use git2::{BranchType, Oid, Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// How far back the walk goes before it gives up counting.
///
/// The count is what lets the pane say `400 of 4,312`, and it costs one pass
/// over the oids. A repository past this has a scroll bar nobody can aim
/// anyway, and the pane says the number is a floor.
const MAX_WALK: usize = 100_000;

/// The widest the lane field is allowed to get.
///
/// Sixteen lanes is 208 px of gutter and more branches at one commit than any
/// repository here has had. Past it, new lanes reuse the last column: the rails
/// stop being exact and the pane says so, rather than the gutter eating the pane.
const MAX_LANES: usize = 16;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRef {
    pub name: String,
    /// `head`, `local`, `remote` or `tag`.
    pub kind: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: String,
    pub short: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub refs: Vec<HistoryRef>,
    pub is_merge: bool,
    /// `ssh`, `gpg`, `x509` or `other` when the commit carries a signature.
    pub signature: Option<String>,
    /// The commit HEAD is on. On a branch or detached, either way it is the
    /// one the next commit lands on top of.
    pub is_head: bool,
    /// The column this commit's node sits in.
    pub lane: usize,
    /// What to draw in the band between this row and the one under it, as
    /// `[column here, column below]`. A pair with two equal numbers is a lane
    /// passing straight through; an unequal one is a line sliding across.
    pub edges: Vec<(usize, usize)>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub rows: Vec<HistoryRow>,
    /// Where this page starts in the walk.
    pub offset: usize,
    /// Commits in the whole walk, or `MAX_WALK` when it stopped counting.
    pub total: usize,
    /// The walk hit `MAX_WALK`, so `total` is a floor rather than a count.
    pub capped: bool,
    /// The widest lane index used anywhere in this page, plus one.
    pub lanes: usize,
    /// Some commit wanted a seventeenth lane and got the sixteenth.
    pub crowded: bool,
    /// The branch HEAD is on, or a short id when detached.
    pub head: Option<String>,
    pub error: Option<String>,
}

impl History {
    fn empty(offset: usize) -> Self {
        Self {
            rows: Vec::new(),
            offset,
            total: 0,
            capped: false,
            lanes: 1,
            crowded: false,
            head: None,
            error: None,
        }
    }

    fn failed(offset: usize, message: String) -> Self {
        let mut out = Self::empty(offset);
        out.error = Some(message);
        out
    }
}

/// One commit's place in the lane field, before its text has been read.
struct Placed {
    id: Oid,
    lane: usize,
    /// What each lane expects next, once this commit has been dealt with.
    after: Vec<Option<Oid>>,
    /// Lanes this commit itself opened, which is what a merge's second parent
    /// does. Their line starts at the commit's own node rather than at the top
    /// of the new column, or the branch a merge brought in appears out of thin
    /// air one row under the merge that took it.
    opened: Vec<usize>,
}

pub fn read(repo_path: &Path, offset: usize, limit: usize) -> History {
    let repo = match Repository::open(repo_path) {
        Ok(repo) => repo,
        Err(err) => return History::failed(offset, err.message().to_string()),
    };

    let mut out = History::empty(offset);
    out.head = head_name(&repo);

    let mut walk = match repo.revwalk() {
        Ok(walk) => walk,
        Err(err) => return History::failed(offset, err.message().to_string()),
    };
    // Topological first, so a merge's two sides do not interleave by timestamp
    // into a picture with lines crossing for no reason a reader can name.
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).ok();
    let mut pushed = false;
    for glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
        if walk.push_glob(glob).is_ok() {
            pushed = true;
        }
    }
    if !pushed && walk.push_head().is_err() {
        // A fresh `git init` with no commits and no refs. Nothing to draw and
        // nothing wrong.
        return out;
    }

    // One row past the window, because a row's edges are drawn against the
    // lane the row below it landed in.
    let want_to = offset.saturating_add(limit).saturating_add(1);
    let mut placed: Vec<Placed> = Vec::with_capacity(limit + 1);
    let mut active: Vec<Option<Oid>> = Vec::new();
    let mut index = 0usize;

    for step in walk {
        let Ok(id) = step else { continue };
        let parents = parents_of(&repo, id);

        let mut mine: Option<usize> = None;
        let mut closing: Vec<usize> = Vec::new();
        for (slot, expecting) in active.iter().enumerate() {
            if *expecting == Some(id) {
                match mine {
                    None => mine = Some(slot),
                    Some(_) => closing.push(slot),
                }
            }
        }
        let lane = match mine {
            Some(slot) => slot,
            None => free_lane(&mut active, &mut out.crowded),
        };

        // The commit's own lane carries on to its first parent; the lanes that
        // were also waiting for it end here and are drawn merging into it.
        for slot in &closing {
            active[*slot] = None;
        }
        active[lane] = parents.first().copied();
        // A second parent already being waited for needs no lane of its own:
        // the two sides meet at that commit and the lanes close there.
        let mut opened: Vec<usize> = Vec::new();
        for parent in parents.iter().skip(1) {
            if active.contains(&Some(*parent)) {
                continue;
            }
            let slot = free_lane(&mut active, &mut out.crowded);
            active[slot] = Some(*parent);
            opened.push(slot);
        }

        if index >= offset && index < want_to {
            placed.push(Placed {
                id,
                lane,
                after: active.clone(),
                opened,
            });
        }

        index += 1;
        if index >= MAX_WALK {
            out.capped = true;
            break;
        }
    }
    out.total = index;

    // Edges, now that every row's lane is known. The last one collected exists
    // only to give the row above it something to point at.
    let drawn = placed.len().min(limit);
    for i in 0..drawn {
        let below = placed.get(i + 1);
        let mut edges = Vec::new();
        for (slot, expecting) in placed[i].after.iter().enumerate() {
            let Some(oid) = expecting else { continue };
            // A lane this commit opened is a parent link, so its line starts at
            // the commit's node. Every other lane was already running and starts
            // in its own column.
            let from = if placed[i].opened.contains(&slot) {
                placed[i].lane
            } else {
                slot
            };
            match below {
                Some(next) if next.id == *oid => edges.push((from, next.lane)),
                // Off the bottom of the page, or a lane whose commit is further
                // down: either way it leaves this row going straight down.
                _ => edges.push((from, slot)),
            }
        }
        placed[i].after.clear();
        placed[i].after.shrink_to_fit();

        let Ok(commit) = repo.find_commit(placed[i].id) else {
            continue;
        };
        let lane = placed[i].lane;
        out.lanes = out.lanes.max(lane + 1);
        for (from, to) in &edges {
            out.lanes = out.lanes.max(from + 1).max(to + 1);
        }

        out.rows.push(HistoryRow {
            id: commit.id().to_string(),
            short: short_id(&commit.id().to_string()),
            summary: commit.summary().unwrap_or("").to_string(),
            author: commit.author().name().unwrap_or("unknown").to_string(),
            time: commit.time().seconds(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            refs: Vec::new(),
            is_merge: commit.parent_count() > 1,
            signature: crate::signing::kind(&repo, placed[i].id),
            is_head: false,
            lane,
            edges,
        });
    }

    // Refs cost a pass over every reference in the repository, so they are
    // looked up once and only for the commits this page actually drew.
    let names = ref_names(&repo);
    let head_oid = repo.head().ok().and_then(|head| head.target());
    let detached = repo.head_detached().unwrap_or(false);
    for row in &mut out.rows {
        if let Ok(oid) = Oid::from_str(&row.id) {
            if let Some(found) = names.get(&oid) {
                row.refs = found.clone();
            }
            if Some(oid) == head_oid {
                row.is_head = true;
                // A detached HEAD sits on no branch, so no ref carries the
                // `head` kind. The row still has to say where you are, and
                // the name git itself prints is the one that goes on it.
                if detached {
                    row.refs.insert(
                        0,
                        HistoryRef {
                            name: "HEAD".to_string(),
                            kind: "head".to_string(),
                        },
                    );
                }
            }
        }
    }

    out
}

/// The first lane with nothing in it, or a new one on the end.
///
/// Past `MAX_LANES` it hands back the last column rather than growing. The rails
/// there stop being exact, which is the trade against a gutter wider than the
/// text beside it.
fn free_lane(active: &mut Vec<Option<Oid>>, crowded: &mut bool) -> usize {
    if let Some(slot) = active.iter().position(|slot| slot.is_none()) {
        return slot;
    }
    if active.len() >= MAX_LANES {
        *crowded = true;
        return MAX_LANES - 1;
    }
    active.push(None);
    active.len() - 1
}

/// Parent ids without loading the commit's message or author.
fn parents_of(repo: &Repository, id: Oid) -> Vec<Oid> {
    match repo.find_commit(id) {
        Ok(commit) => commit.parent_ids().collect(),
        Err(_) => Vec::new(),
    }
}

fn head_name(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        return head.shorthand().map(str::to_string);
    }
    head.target().map(|oid| short_id(&oid.to_string()))
}

fn short_id(id: &str) -> String {
    id.chars().take(7).collect()
}

/// Every branch and tag, by the commit it points at.
///
/// The branch HEAD is on is marked `head` rather than `local`, so the pane can
/// show where you are standing without a second lookup.
fn ref_names(repo: &Repository) -> HashMap<Oid, Vec<HistoryRef>> {
    let mut map: HashMap<Oid, Vec<HistoryRef>> = HashMap::new();
    let head = repo
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().map(str::to_string));

    if let Ok(branches) = repo.branches(None) {
        for (branch, kind) in branches.flatten() {
            let Ok(Some(name)) = branch.name() else {
                continue;
            };
            // `origin/HEAD` points at a name already in this map.
            if kind == BranchType::Remote && name.ends_with("/HEAD") {
                continue;
            }
            let Some(oid) = branch.get().target() else {
                continue;
            };
            let is_head = kind == BranchType::Local && head.as_deref() == Some(name);
            let kind = if is_head {
                "head"
            } else if kind == BranchType::Remote {
                "remote"
            } else {
                "local"
            };
            map.entry(oid).or_default().push(HistoryRef {
                name: name.to_string(),
                kind: kind.to_string(),
            });
        }
    }

    let _ = repo.tag_foreach(|oid, name| {
        let name = String::from_utf8_lossy(name);
        let short = name.rsplit('/').next().unwrap_or(&name).to_string();
        // An annotated tag resolves to the commit it wraps; a lightweight tag is
        // the commit already.
        let target = repo
            .find_tag(oid)
            .ok()
            .and_then(|tag| tag.target().ok())
            .map(|obj| obj.id())
            .unwrap_or(oid);
        map.entry(target).or_default().push(HistoryRef {
            name: short,
            kind: "tag".to_string(),
        });
        true
    });

    // A commit carrying HEAD, a branch and two tags should read in that order
    // rather than in whatever order the reference iterator happened to give.
    for names in map.values_mut() {
        names.sort_by_key(|r| match r.kind.as_str() {
            "head" => 0,
            "local" => 1,
            "remote" => 2,
            _ => 3,
        });
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::path::PathBuf;

    /// The same throwaway repository the graph tests build, with commits that
    /// carry no tree, so a shape can be written in four lines.
    struct Fixture {
        dir: PathBuf,
        repo: Repository,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gitview-history-{tag}-{}-{:?}",
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

    fn row<'a>(history: &'a History, summary: &str) -> &'a HistoryRow {
        history
            .rows
            .iter()
            .find(|r| r.summary == summary)
            .unwrap_or_else(|| {
                panic!(
                    "no row called {summary}, got {:?}",
                    history.rows.iter().map(|r| &r.summary).collect::<Vec<_>>()
                )
            })
    }

    /// A history with nothing but one line in it draws one line.
    #[test]
    fn a_straight_history_stays_in_one_lane() {
        let fixture = Fixture::new("straight");
        let first = fixture.commit("refs/heads/main", "one", &[]);
        let second = fixture.commit("refs/heads/main", "two", &[first]);
        fixture.commit("refs/heads/main", "three", &[second]);

        let history = read(&fixture.dir, 0, 50);

        assert!(history.error.is_none(), "{:?}", history.error);
        assert_eq!(history.total, 3);
        assert_eq!(history.lanes, 1);
        assert!(history.rows.iter().all(|r| r.lane == 0));
        assert_eq!(row(&history, "three").edges, vec![(0, 0)]);
        // The oldest commit has no parent, so nothing leaves it.
        assert!(row(&history, "one").edges.is_empty());
    }

    /// The shape the lane packing exists for. A branch off `main`, merged back:
    /// the side branch takes a lane of its own and gives it up at the fork.
    #[test]
    fn a_merge_opens_a_lane_and_the_fork_closes_it() {
        let fixture = Fixture::new("merge");
        let base = fixture.commit("refs/heads/main", "base", &[]);
        let ours = fixture.commit("refs/heads/main", "ours", &[base]);
        let theirs = fixture.commit("refs/heads/side", "theirs", &[base]);
        fixture.commit("refs/heads/main", "merge", &[ours, theirs]);

        let history = read(&fixture.dir, 0, 50);

        assert!(history.error.is_none(), "{:?}", history.error);
        assert_eq!(history.total, 4);
        assert_eq!(history.lanes, 2, "one branch off the trunk is two lanes");
        assert_eq!(row(&history, "merge").lane, 0);
        assert!(row(&history, "merge").is_merge);
        assert_eq!(row(&history, "ours").lane, 0);
        assert_eq!(row(&history, "theirs").lane, 1);
        assert_eq!(row(&history, "base").lane, 0);

        // The row above `base` is where the second lane slides back into the
        // first. Whichever of the two sides is drawn last carries that edge.
        let closing: Vec<(usize, usize)> = history
            .rows
            .iter()
            .flat_map(|r| r.edges.iter().copied())
            .filter(|(from, to)| from != to)
            .collect();
        assert!(
            closing.contains(&(1, 0)),
            "the side lane has to come back to the trunk, got {closing:?}"
        );

        // The merge's second parent opens that lane, so its line starts at the
        // merge's own node. Without it the branch appears out of thin air one
        // row under the merge that took it.
        assert!(
            row(&history, "merge").edges.contains(&(0, 1)),
            "the merge has to reach across to the lane it opened, got {:?}",
            row(&history, "merge").edges
        );
    }

    /// Refs land on the commit they point at, and the branch HEAD is on is
    /// marked apart from the rest so the pane can say where you are standing.
    #[test]
    fn the_branch_head_is_on_is_marked_apart() {
        let fixture = Fixture::new("refs");
        let base = fixture.commit("refs/heads/main", "base", &[]);
        fixture.commit("refs/heads/side", "tip", &[base]);
        fixture
            .repo
            .set_head("refs/heads/side")
            .expect("checkout side");

        let history = read(&fixture.dir, 0, 50);

        assert_eq!(history.head.as_deref(), Some("side"));
        assert!(row(&history, "tip").is_head);
        assert!(!row(&history, "base").is_head);
        let kinds: Vec<&str> = row(&history, "tip")
            .refs
            .iter()
            .map(|r| r.kind.as_str())
            .collect();
        assert_eq!(kinds, vec!["head"]);
        let names: Vec<&str> = row(&history, "base")
            .refs
            .iter()
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(names, vec!["main"]);
    }

    /// A detached HEAD is on no branch, so the commit under it says `HEAD`
    /// itself rather than leaving the reader to find the short id in the
    /// header.
    #[test]
    fn a_detached_head_marks_its_commit() {
        let fixture = Fixture::new("detached");
        let base = fixture.commit("refs/heads/main", "base", &[]);
        fixture.commit("refs/heads/main", "tip", &[base]);
        fixture
            .repo
            .set_head_detached(base)
            .expect("detach at base");

        let history = read(&fixture.dir, 0, 50);

        assert_eq!(
            history.head.as_deref(),
            Some(&short_id(&base.to_string())[..])
        );
        let at_base = row(&history, "base");
        assert!(at_base.is_head);
        let names: Vec<(&str, &str)> = at_base
            .refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str()))
            .collect();
        assert_eq!(names, vec![("HEAD", "head")]);
        let at_tip = row(&history, "tip");
        assert!(!at_tip.is_head);
        assert!(at_tip.refs.iter().all(|r| r.kind != "head"));
    }

    /// A page from the middle still knows which lane the row under it landed
    /// in, which is the whole reason the walk runs from the top every time.
    #[test]
    fn a_page_from_the_middle_still_draws_its_edges() {
        let fixture = Fixture::new("paged");
        let mut parent = fixture.commit("refs/heads/main", "c0", &[]);
        for n in 1..10 {
            parent = fixture.commit("refs/heads/main", &format!("c{n}"), &[parent]);
        }

        let page = read(&fixture.dir, 4, 3);

        assert_eq!(
            page.total, 10,
            "the count is of the whole walk, not the page"
        );
        assert_eq!(page.offset, 4);
        assert_eq!(page.rows.len(), 3);
        assert_eq!(
            page.rows
                .iter()
                .map(|r| r.summary.as_str())
                .collect::<Vec<_>>(),
            vec!["c5", "c4", "c3"]
        );
        // The last row of the page has a parent below the page, so its lane
        // still leaves the bottom of the band.
        assert_eq!(page.rows[2].edges, vec![(0, 0)]);
    }
}
