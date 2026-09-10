//! The diff reader.
//!
//! A read, so it runs in process through `git2` like the scanner and the graph,
//! and nothing here spawns `git`. What comes back is structured rather than a
//! block of patch text: the pane draws its own gutters, and hunk staging needs
//! to address one hunk out of many, which a string does not give it.
//!
//! Two sides, and they are different questions. `staged` diffs HEAD against the
//! index and answers "what would this commit contain"; unstaged diffs the index
//! against the working tree and answers "what have I not staged yet". A file
//! edited after being staged has both, which is why the changes column lists it
//! twice and why this takes the side as an argument rather than guessing.

use git2::{Delta, DiffFindOptions, DiffOptions, Oid, Patch, Repository};
use serde::Serialize;
use std::path::Path;

/// Context lines around each change, which is git's own default.
const CONTEXT: u32 = 3;

/// A cap on the rows one file's diff turns into.
///
/// A regenerated lockfile is twenty thousand lines and nobody reads it in a
/// pane; the pane says it stopped and the whole thing is one `git diff` away in
/// the shell. Six thousand covers every hand-written change seen here so far.
const MAX_LINES: usize = 6000;

/// A cap on one line, because a minified bundle is a single line megabytes long
/// and the renderer has to lay all of it out before it can clip it.
const MAX_LINE: usize = 1000;

/// git's own wording for the marker, written here rather than taken from
/// libgit2, whose content for those origins is the line the marker follows.
const NO_NEWLINE: &str = "No newline at end of file";

/// One row of a hunk.
///
/// `old` and `new` are the line numbers on each side, absent on the side the
/// line does not exist. A `\` row is git's "No newline at end of file", kept
/// rather than folded into a flag because a patch built back out of these rows
/// has to emit it again.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// One of ` `, `+`, `-`, `\`.
    pub origin: char,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
    /// The line was longer than `MAX_LINE` and what is here is the front of it.
    pub clipped: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// The `@@ -a,b +c,d @@` line as git writes it, including the function
    /// context it puts after the second `@@`.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Where a rename came from. Null for everything else.
    pub old_path: Option<String>,
    /// Which side this was read from, so the pane can label it.
    pub staged: bool,
    /// `new`, `modified`, `deleted`, `renamed` or `typechange`, the same
    /// vocabulary the changes column already uses.
    pub status: String,
    /// git could not read it as text, so there are no hunks and never will be.
    pub binary: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<DiffHunk>,
    /// The read stopped at `MAX_LINES` and the pane says so.
    pub truncated: bool,
    /// The file has no diff on this side at all, which is not an error: a row
    /// can outlive its diff by a few hundred milliseconds when the shell has
    /// just staged what it named.
    pub empty: bool,
    pub error: Option<String>,
}

impl FileDiff {
    fn empty(path: &str, staged: bool) -> Self {
        Self {
            path: path.to_string(),
            old_path: None,
            staged,
            status: "modified".to_string(),
            binary: false,
            additions: 0,
            deletions: 0,
            hunks: Vec::new(),
            truncated: false,
            empty: true,
            error: None,
        }
    }

    fn failed(path: &str, staged: bool, message: String) -> Self {
        let mut diff = Self::empty(path, staged);
        diff.error = Some(message);
        diff
    }
}

fn status_name(delta: Delta) -> &'static str {
    match delta {
        Delta::Added | Delta::Untracked => "new",
        Delta::Deleted => "deleted",
        Delta::Renamed | Delta::Copied => "renamed",
        Delta::Typechange => "typechange",
        _ => "modified",
    }
}

/// Paths come out of libgit2 with whatever separator the platform used. The
/// frontend holds the ones `read_changes` reported, which are forward-slashed,
/// so both sides are normalised before they are compared.
fn slashed(path: Option<&Path>) -> Option<String> {
    path.map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// One file, on one side.
pub fn read_file(repo_path: &Path, file: &str, staged: bool) -> FileDiff {
    let repo = match Repository::open(repo_path) {
        Ok(repo) => repo,
        Err(err) => return FileDiff::failed(file, staged, err.message().to_string()),
    };

    let mut opts = DiffOptions::new();
    opts.context_lines(CONTEXT)
        .include_typechange(true)
        .include_untracked(true)
        // Without this an untracked file is a delta with no content, so a file
        // just written shows as an empty diff rather than as its own contents,
        // which is the one time you most want to read it.
        .show_untracked_content(true)
        .recurse_untracked_dirs(true);

    // No pathspec here. Rename detection pairs a delete with an add, and a
    // pathspec filters one half of that pair out before `find_similar` ever
    // sees it, so a renamed file would arrive as a whole-file delete. The
    // deltas are metadata; the content behind one is read only when a `Patch`
    // is built for it, which happens once, for the file that was asked for.
    let index = match repo.index() {
        Ok(index) => index,
        Err(err) => return FileDiff::failed(file, staged, err.message().to_string()),
    };

    let diff = if staged {
        let tree = repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .and_then(|oid: Oid| repo.find_commit(oid).ok())
            .and_then(|commit| commit.tree().ok());
        repo.diff_tree_to_index(tree.as_ref(), Some(&index), Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(Some(&index), Some(&mut opts))
    };

    let mut diff = match diff {
        Ok(diff) => diff,
        Err(err) => return FileDiff::failed(file, staged, err.message().to_string()),
    };

    let mut finder = DiffFindOptions::new();
    finder.renames(true).copies(false);
    let _ = diff.find_similar(Some(&mut finder));

    let wanted = file.replace('\\', "/");
    let found = diff.deltas().position(|delta| {
        slashed(delta.new_file().path()).as_deref() == Some(wanted.as_str())
            || slashed(delta.old_file().path()).as_deref() == Some(wanted.as_str())
    });

    let Some(idx) = found else {
        return FileDiff::empty(file, staged);
    };
    let Some(delta) = diff.get_delta(idx) else {
        return FileDiff::empty(file, staged);
    };

    let mut out = FileDiff::empty(file, staged);
    out.empty = false;
    out.status = status_name(delta.status()).to_string();
    out.path = slashed(delta.new_file().path())
        .or_else(|| slashed(delta.old_file().path()))
        .unwrap_or_else(|| file.to_string());
    if matches!(delta.status(), Delta::Renamed | Delta::Copied) {
        out.old_path = slashed(delta.old_file().path());
    }
    if delta.old_file().is_binary() || delta.new_file().is_binary() {
        out.binary = true;
        return out;
    }

    let patch = match Patch::from_diff(&diff, idx) {
        Ok(Some(patch)) => patch,
        // A delta with no patch is libgit2's own answer for content it would
        // not expand, so it is reported as binary rather than as a failure.
        Ok(None) => {
            out.binary = true;
            return out;
        }
        Err(err) => {
            out.error = Some(err.message().to_string());
            return out;
        }
    };

    let mut rows = 0usize;
    for h in 0..patch.num_hunks() {
        let Ok((hunk, line_count)) = patch.hunk(h) else {
            continue;
        };
        let mut lines = Vec::with_capacity(line_count);
        for l in 0..line_count {
            if rows >= MAX_LINES {
                out.truncated = true;
                break;
            }
            let Ok(line) = patch.line_in_hunk(h, l) else {
                continue;
            };
            // libgit2 reports "no newline at end of file" as three origins of
            // its own: `=` when neither side has the newline, `>` when the old
            // side had it, `<` when the new side gained it. None of the three
            // is a line of content, and folding `>` into `+` counted the marker
            // as an addition and drew it as one. All three become the marker
            // row, which a patch rebuilt from these rows has to emit anyway.
            let origin = match line.origin() {
                '+' => '+',
                '-' => '-',
                '=' | '>' | '<' => '\\',
                other => other,
            };

            let (text, clipped) = if origin == '\\' {
                (NO_NEWLINE.to_string(), false)
            } else {
                let raw = String::from_utf8_lossy(line.content());
                let text = raw.trim_end_matches(['\n', '\r']);
                let clipped = text.chars().count() > MAX_LINE;
                if clipped {
                    (text.chars().take(MAX_LINE).collect(), true)
                } else {
                    (text.to_string(), false)
                }
            };

            match origin {
                '+' => out.additions += 1,
                '-' => out.deletions += 1,
                _ => {}
            }
            lines.push(DiffLine {
                origin,
                old: line.old_lineno(),
                new: line.new_lineno(),
                text,
                clipped,
            });
            rows += 1;
        }

        out.hunks.push(DiffHunk {
            header: String::from_utf8_lossy(hunk.header())
                .trim_end_matches(['\n', '\r'])
                .to_string(),
            old_start: hunk.old_start(),
            old_lines: hunk.old_lines(),
            new_start: hunk.new_start(),
            new_lines: hunk.new_lines(),
            lines,
        });

        if out.truncated {
            break;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::path::PathBuf;

    /// A repository under the system temp directory, removed when the test ends.
    /// The same shape the graph tests use, with real files in it.
    struct Fixture {
        dir: PathBuf,
        repo: Repository,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gitview-diff-{tag}-{}-{:?}",
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
            std::fs::write(self.dir.join(name), body).expect("write file");
        }

        fn stage(&self, name: &str) {
            let mut index = self.repo.index().expect("index");
            index
                .add_all([name], IndexAddOption::DEFAULT, None)
                .expect("add");
            index.write().expect("write index");
        }

        fn commit(&self, message: &str) {
            let mut index = self.repo.index().expect("index");
            let tree_id = index.write_tree().expect("write tree");
            let tree = self.repo.find_tree(tree_id).expect("find tree");
            let sig = Signature::now("Test", "test@example.com").expect("signature");
            let parent = self
                .repo
                .head()
                .ok()
                .and_then(|head| head.target())
                .and_then(|oid| self.repo.find_commit(oid).ok());
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            self.repo
                .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
                .expect("commit");
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn added(diff: &FileDiff) -> Vec<String> {
        diff.hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .filter(|line| line.origin == '+')
            .map(|line| line.text.clone())
            .collect()
    }

    /// Without `show_untracked_content` a file you have just written is a delta
    /// with no hunks, which reads in the pane as "nothing here" for the one file
    /// you most want to look at.
    #[test]
    fn an_untracked_file_shows_its_contents() {
        let fixture = Fixture::new("untracked");
        fixture.write("notes.txt", "one\ntwo\n");

        let diff = read_file(&fixture.dir, "notes.txt", false);

        assert!(diff.error.is_none(), "{:?}", diff.error);
        assert!(!diff.empty);
        assert_eq!(diff.status, "new");
        assert_eq!(added(&diff), vec!["one", "two"]);
    }

    /// The case the `staged` argument exists for. One file, two answers, and
    /// picking the wrong one shows work that has already been staged as if it
    /// were still waiting.
    #[test]
    fn a_file_staged_then_edited_has_a_diff_on_each_side() {
        let fixture = Fixture::new("both-sides");
        fixture.write("a.txt", "one\n");
        fixture.stage("a.txt");
        fixture.commit("first");

        fixture.write("a.txt", "one\ntwo\n");
        fixture.stage("a.txt");
        fixture.write("a.txt", "one\ntwo\nthree\n");

        let staged = read_file(&fixture.dir, "a.txt", true);
        let unstaged = read_file(&fixture.dir, "a.txt", false);

        assert_eq!(added(&staged), vec!["two"], "HEAD against the index");
        assert_eq!(added(&unstaged), vec!["three"], "index against the tree");
        assert_eq!(staged.additions, 1);
        assert_eq!(unstaged.additions, 1);
    }

    /// The reason `read_file` builds the whole diff rather than one filtered by
    /// pathspec. Rename detection pairs a delete with an add, and a pathspec
    /// drops one half of that pair before `find_similar` can see it, so the file
    /// would arrive as a whole-file delete of a name that no longer exists.
    #[test]
    fn a_renamed_file_keeps_the_name_it_came_from() {
        let fixture = Fixture::new("rename");
        let body: String = (0..30).map(|n| format!("line {n}\n")).collect();
        fixture.write("old.rs", &body);
        fixture.stage("old.rs");
        fixture.commit("first");

        std::fs::rename(fixture.dir.join("old.rs"), fixture.dir.join("new.rs")).expect("rename");
        fixture.stage("old.rs");
        fixture.stage("new.rs");

        let diff = read_file(&fixture.dir, "new.rs", true);

        assert!(diff.error.is_none(), "{:?}", diff.error);
        assert_eq!(diff.status, "renamed");
        assert_eq!(diff.old_path.as_deref(), Some("old.rs"));
        assert!(
            diff.hunks.is_empty(),
            "the contents did not move, so there is nothing to draw"
        );
    }

    /// A row can outlive its diff by a refresh. That is an empty answer rather
    /// than an error, and the pane says so in its own words.
    #[test]
    fn a_file_with_nothing_on_that_side_is_empty_not_an_error() {
        let fixture = Fixture::new("empty-side");
        fixture.write("a.txt", "one\n");
        fixture.stage("a.txt");

        let unstaged = read_file(&fixture.dir, "a.txt", false);

        assert!(unstaged.error.is_none(), "{:?}", unstaged.error);
        assert!(unstaged.empty);
        assert!(unstaged.hunks.is_empty());
    }

    /// libgit2 reports "no newline at end of file" as its own origin, and there
    /// are three of them: `=` when neither side has the newline, `>` when the
    /// old side had it, `<` when the new side gained it. None of the three is a
    /// line of content. Folding `>` into `+` counted the marker as an addition
    /// and drew it as one.
    #[test]
    fn the_no_newline_marker_is_not_a_changed_line() {
        let fixture = Fixture::new("eofnl");
        fixture.write("a.txt", "one\ntwo\n");
        fixture.stage("a.txt");
        fixture.commit("first");

        // Same two lines, and the trailing newline taken off.
        fixture.write("a.txt", "one\ntwo");

        let diff = read_file(&fixture.dir, "a.txt", false);

        assert!(diff.error.is_none(), "{:?}", diff.error);
        assert_eq!(diff.additions, 1, "one line changed, not two");
        assert_eq!(diff.deletions, 1);
        assert_eq!(added(&diff), vec!["two"]);
        let markers: Vec<char> = diff.hunks[0].lines.iter().map(|l| l.origin).collect();
        assert!(
            markers.contains(&'\\'),
            "the marker keeps a row of its own, got {markers:?}"
        );
    }
}
