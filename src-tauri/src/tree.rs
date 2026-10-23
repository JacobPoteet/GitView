//! The folders of one repository's working tree, a directory at a time.
//!
//! What the rail draws when it swaps the fleet for one project. The listing is
//! the disk, not the index: an untracked file is a file you can see, and the
//! tree is where you go looking for it. `git2` answers the one question the disk
//! cannot, which entries `.gitignore` covers, so `target` and `node_modules`
//! come back marked rather than missing.
//!
//! Read per directory, because a repository with fifty thousand files under
//! `node_modules` costs nothing until somebody opens that folder. A deep read,
//! the Ctrl+click on a folder, walks every folder under it that is not ignored,
//! and stops at `MAX_ENTRIES` with whole listings only: a folder is listed in
//! full or left closed, never drawn with half its files.

use git2::{Index, Repository};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};

/// Rows a deep read stops at. A row is a DOM node, and 6000 rows of diff paint
/// in 695 ms; a tree that opens slower than the diff is a click that looks lost.
const MAX_ENTRIES: usize = 5000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// From the repository's root, with forward slashes, the way `git status`
    /// and the changes column spell it.
    pub path: String,
    pub dir: bool,
    /// Covered by a `.gitignore`. Drawn faint, and never walked into by a
    /// deep read.
    pub ignored: bool,
}

/// One folder's entries, folders first, each group by name ignoring case.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The folder, spelt like `Entry::path`. The root is the empty string.
    pub dir: String,
    pub entries: Vec<Entry>,
    /// The folder could not be read: it was deleted since it was drawn, or
    /// Windows refused it.
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub listings: Vec<Listing>,
    /// A deep read stopped at the cap and left some folders closed.
    pub truncated: bool,
}

/// Lists each folder in `dirs`, and with `deep` every folder under each of
/// them that is not ignored.
pub fn read(repo_path: &Path, dirs: &[String], deep: bool) -> Result<Tree, String> {
    walk(repo_path, dirs, deep, MAX_ENTRIES)
}

fn walk(repo_path: &Path, dirs: &[String], deep: bool, cap: usize) -> Result<Tree, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let root = repo
        .workdir()
        .ok_or("A bare repository has no working tree to list.")?
        .to_path_buf();
    // Read once for the whole call. Without an index every entry is asked
    // about, which is slow and still right.
    let index = repo.index().ok();
    let mut tree = Tree::default();
    let mut queue: VecDeque<String> = dirs
        .iter()
        .map(|d| d.trim_matches('/').to_string())
        .collect();
    let mut rows = 0;
    while let Some(dir) = queue.pop_front() {
        let listing = list(&repo, index.as_ref(), &root, &dir);
        if deep {
            if rows > 0 && rows + listing.entries.len() > cap {
                tree.truncated = true;
                break;
            }
            rows += listing.entries.len();
            queue.extend(
                listing
                    .entries
                    .iter()
                    .filter(|e| e.dir && !e.ignored)
                    .map(|e| e.path.clone()),
            );
        }
        tree.listings.push(listing);
    }
    Ok(tree)
}

fn list(repo: &Repository, index: Option<&Index>, root: &Path, dir: &str) -> Listing {
    let mut listing = Listing {
        dir: dir.to_string(),
        entries: Vec::new(),
        error: None,
    };
    let Some(folder) = inside(root, dir) else {
        listing.error = Some(format!("{dir} is not inside the repository."));
        return listing;
    };
    // Everything inside an ignored folder is ignored, and asking per entry
    // costs a walk up the `.gitignore` stack each time. `node_modules` is
    // the folder most likely to be opened and the one with the most in it.
    let folder_ignored = !dir.is_empty() && repo.is_path_ignored(Path::new(dir)).unwrap_or(false);
    let read = match std::fs::read_dir(&folder) {
        Ok(read) => read,
        Err(err) => {
            listing.error = Some(err.to_string());
            return listing;
        }
    };
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        // The repository's own folder, or the file a linked worktree has in
        // its place. Nothing in it is anyone's working tree.
        if dir.is_empty() && name == ".git" {
            continue;
        }
        // A link is drawn as a file and never followed: a junction back up
        // the tree would make a deep read walk in a circle until the cap.
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let path = if dir.is_empty() {
            name.clone()
        } else {
            format!("{dir}/{name}")
        };
        // A tracked file is never ignored, whatever `.gitignore` says, and
        // asking costs about 0.4 ms an entry in a release build: libgit2
        // rebuilds the `.gitignore` stack from the root on every call, so a
        // folder of 3000 files took 1.3 s. Only what git does not have yet is
        // asked about.
        let ignored = folder_ignored
            || (!index.is_some_and(|index| tracked(index, &path, is_dir))
                && repo.is_path_ignored(Path::new(&path)).unwrap_or(false));
        listing.entries.push(Entry {
            name,
            path,
            dir: is_dir,
            ignored,
        });
    }
    listing.entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    listing
}

/// Whether the index holds this file, at any stage of a merge, or anything
/// under this folder.
fn tracked(index: &Index, path: &str, dir: bool) -> bool {
    if dir {
        return index.find_prefix(format!("{path}/")).is_ok();
    }
    (0..=3).any(|stage| index.get_path(Path::new(path), stage).is_some())
}

/// The folder on disk, or nothing for a path that would leave the working
/// tree. The frontend only sends paths this module handed it, so a `..` here
/// is a bug rather than an attack, and a bug should list nothing.
fn inside(root: &Path, dir: &str) -> Option<PathBuf> {
    let rel = Path::new(dir);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(root.join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gitview-tree-{tag}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            Repository::init(&dir).expect("git init");
            Self { dir }
        }

        fn write(&self, name: &str) {
            let path = self.dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).expect("folders");
            std::fs::write(path, "x").expect("write file");
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn names(listing: &Listing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_folders_first_and_skips_git() {
        let fx = Fixture::new("order");
        fx.write("b.txt");
        fx.write("A.txt");
        fx.write("src/main.rs");
        fx.write("Docs/x.md");
        let tree = read(&fx.dir, &["".into()], false).unwrap();
        assert_eq!(tree.listings.len(), 1);
        assert_eq!(names(&tree.listings[0]), ["Docs", "src", "A.txt", "b.txt"]);
        let src = &tree.listings[0].entries[1];
        assert_eq!(src.path, "src");
        assert!(src.dir);
    }

    #[test]
    fn marks_what_gitignore_covers() {
        let fx = Fixture::new("ignore");
        std::fs::write(fx.dir.join(".gitignore"), "target/\n*.log\n").unwrap();
        fx.write("target/debug/app.exe");
        fx.write("build.log");
        fx.write("src/lib.rs");
        let tree = read(&fx.dir, &["".into(), "target".into()], false).unwrap();
        let root = &tree.listings[0];
        let ignored = |name: &str| {
            root.entries
                .iter()
                .find(|e| e.name == name)
                .unwrap()
                .ignored
        };
        assert!(ignored("target"));
        assert!(ignored("build.log"));
        assert!(!ignored("src"));
        assert!(!ignored(".gitignore"));
        // Inside an ignored folder, everything is.
        assert!(tree.listings[1].entries.iter().all(|e| e.ignored));
    }

    #[test]
    fn a_tracked_file_is_never_ignored() {
        let fx = Fixture::new("tracked");
        std::fs::write(
            fx.dir.join(".gitignore"),
            "*.log
",
        )
        .unwrap();
        fx.write("kept.log");
        fx.write("stray.log");
        let repo = Repository::open(&fx.dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("kept.log")).unwrap();
        index.write().unwrap();
        let tree = read(&fx.dir, &["".into()], false).unwrap();
        let ignored = |name: &str| {
            tree.listings[0]
                .entries
                .iter()
                .find(|e| e.name == name)
                .unwrap()
                .ignored
        };
        assert!(!ignored("kept.log"));
        assert!(ignored("stray.log"));
    }

    #[test]
    fn a_deep_read_walks_everything_not_ignored() {
        let fx = Fixture::new("deep");
        std::fs::write(fx.dir.join(".gitignore"), "node_modules/\n").unwrap();
        fx.write("src/lib/a.ts");
        fx.write("src/lib/deeper/b.ts");
        fx.write("node_modules/pkg/index.js");
        let tree = read(&fx.dir, &["".into()], true).unwrap();
        let dirs: Vec<&str> = tree.listings.iter().map(|l| l.dir.as_str()).collect();
        assert_eq!(dirs, ["", "src", "src/lib", "src/lib/deeper"]);
        assert!(!tree.truncated);
    }

    #[test]
    fn a_deep_read_stops_at_the_cap_with_whole_listings() {
        let fx = Fixture::new("cap");
        for i in 0..3 {
            for j in 0..4 {
                fx.write(&format!("d{i}/f{j}"));
            }
        }
        // The root's three rows and d0's four fit under ten; d1's four do not.
        let tree = walk(&fx.dir, &["".into()], true, 10).unwrap();
        assert!(tree.truncated);
        assert_eq!(tree.listings.len(), 2);
        assert!(tree.listings.iter().all(|l| l.error.is_none()));
    }

    #[test]
    fn a_missing_or_escaping_folder_lists_nothing() {
        let fx = Fixture::new("missing");
        let tree = read(&fx.dir, &["gone".into(), "../elsewhere".into()], false).unwrap();
        assert!(tree
            .listings
            .iter()
            .all(|l| l.error.is_some() && l.entries.is_empty()));
    }
}
