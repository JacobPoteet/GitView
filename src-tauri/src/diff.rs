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

/// One side of the index, as a diff.
///
/// No pathspec. Rename detection pairs a delete with an add, and a pathspec
/// filters one half of that pair out before `find_similar` ever sees it, so a
/// renamed file would arrive as a whole-file delete. The deltas are metadata;
/// the content behind one is read only when a `Patch` is built for it, which
/// happens once, for the file that was asked for.
fn build(repo: &Repository, staged: bool) -> Result<git2::Diff<'_>, git2::Error> {
    let mut opts = DiffOptions::new();
    opts.context_lines(CONTEXT)
        .include_typechange(true)
        .include_untracked(true)
        // Without this an untracked file is a delta with no content, so a file
        // just written shows as an empty diff rather than as its own contents,
        // which is the one time you most want to read it.
        .show_untracked_content(true)
        .recurse_untracked_dirs(true);

    let index = repo.index()?;
    let mut diff = if staged {
        let tree = repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .and_then(|oid: Oid| repo.find_commit(oid).ok())
            .and_then(|commit| commit.tree().ok());
        repo.diff_tree_to_index(tree.as_ref(), Some(&index), Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?
    };

    let mut finder = DiffFindOptions::new();
    finder.renames(true).copies(false);
    let _ = diff.find_similar(Some(&mut finder));
    Ok(diff)
}

/// Where the file the frontend named sits in that diff. Either side matches,
/// so a rename is found by the name it now has.
fn locate(diff: &git2::Diff<'_>, file: &str) -> Option<usize> {
    let wanted = file.replace('\\', "/");
    diff.deltas().position(|delta| {
        slashed(delta.new_file().path()).as_deref() == Some(wanted.as_str())
            || slashed(delta.old_file().path()).as_deref() == Some(wanted.as_str())
    })
}

/// One file, on one side.
pub fn read_file(repo_path: &Path, file: &str, staged: bool) -> FileDiff {
    let repo = match Repository::open(repo_path) {
        Ok(repo) => repo,
        Err(err) => return FileDiff::failed(file, staged, err.message().to_string()),
    };

    let diff = match build(&repo, staged) {
        Ok(diff) => diff,
        Err(err) => return FileDiff::failed(file, staged, err.message().to_string()),
    };

    let Some(idx) = locate(&diff, file) else {
        return FileDiff::empty(file, staged);
    };
    let Some(delta) = diff.get_delta(idx) else {
        return FileDiff::empty(file, staged);
    };

    expand(&diff, idx, delta, FileDiff::empty(file, staged))
}

/// One delta out of a diff, turned into the rows the pane draws.
///
/// Shared by the working-tree reads and the commit read, which build different
/// diffs and want the same file out of them.
fn expand(
    diff: &git2::Diff<'_>,
    idx: usize,
    delta: git2::DiffDelta<'_>,
    mut out: FileDiff,
) -> FileDiff {
    let file = out.path.clone();
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

    let patch = match Patch::from_diff(diff, idx) {
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

// -------------------------------------------------------------- one commit

/// One file a commit touched, as a row in the commit pane's list. The hunks
/// are a second read, per file, through `read_commit_file`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub binary: bool,
    pub additions: usize,
    pub deletions: usize,
}

/// A commit as the pane reads it: the message, who and when, its parents, and
/// every file it touched with its counts.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDiff {
    pub id: String,
    pub short: String,
    pub summary: String,
    /// The message past the first paragraph, trimmed. Empty when there is none.
    pub body: String,
    pub author: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub parents: Vec<String>,
    pub files: Vec<CommitFile>,
    pub additions: usize,
    pub deletions: usize,
    pub error: Option<String>,
}

impl CommitDiff {
    fn failed(sha: &str, message: String) -> Self {
        Self {
            id: sha.to_string(),
            short: sha.chars().take(7).collect(),
            summary: String::new(),
            body: String::new(),
            author: String::new(),
            time: 0,
            parents: Vec::new(),
            files: Vec::new(),
            additions: 0,
            deletions: 0,
            error: Some(message),
        }
    }
}

/// A commit against its first parent, which is what `git show` prints and what
/// the ring in the history means: the change as the trunk saw it arrive. A root
/// commit is diffed against nothing, so every file in it reads as new.
///
/// No pathspec here either, for the reason `build` gives: rename detection
/// needs both halves of the pair.
fn build_commit<'r>(
    repo: &'r Repository,
    sha: &str,
) -> Result<(git2::Commit<'r>, git2::Diff<'r>), git2::Error> {
    let oid = repo.revparse_single(sha)?.peel_to_commit()?.id();
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent = commit.parent(0).ok().and_then(|p| p.tree().ok());

    let mut opts = DiffOptions::new();
    opts.context_lines(CONTEXT).include_typechange(true);
    let mut diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))?;

    let mut finder = DiffFindOptions::new();
    finder.renames(true).copies(false);
    let _ = diff.find_similar(Some(&mut finder));
    Ok((commit, diff))
}

/// The commit and its file list.
///
/// The counts cost a `Patch` per file, which reads the content. `git show
/// --stat` pays the same, and the alternative is a list with no numbers on it.
pub fn read_commit(repo_path: &Path, sha: &str) -> CommitDiff {
    let repo = match Repository::open(repo_path) {
        Ok(repo) => repo,
        Err(err) => return CommitDiff::failed(sha, err.message().to_string()),
    };
    let (commit, diff) = match build_commit(&repo, sha) {
        Ok(pair) => pair,
        Err(err) => return CommitDiff::failed(sha, err.message().to_string()),
    };

    // `summary` joins the first paragraph into one line and `body` is what
    // follows it, both libgit2's. Splitting the message at its first newline
    // instead put a wrapped subject's second line at the top of the body, so
    // it read twice.
    let summary = commit.summary().unwrap_or_default().to_string();
    let body = commit.body().unwrap_or_default().trim().to_string();

    let mut out = CommitDiff {
        id: commit.id().to_string(),
        short: commit.id().to_string().chars().take(7).collect(),
        summary,
        body,
        author: commit.author().name().unwrap_or_default().to_string(),
        time: commit.time().seconds(),
        parents: commit
            .parent_ids()
            .map(|id| id.to_string().chars().take(7).collect())
            .collect(),
        files: Vec::new(),
        additions: 0,
        deletions: 0,
        error: None,
    };

    for (idx, delta) in diff.deltas().enumerate() {
        let path = slashed(delta.new_file().path())
            .or_else(|| slashed(delta.old_file().path()))
            .unwrap_or_default();
        let old_path = if matches!(delta.status(), Delta::Renamed | Delta::Copied) {
            slashed(delta.old_file().path())
        } else {
            None
        };
        let mut file = CommitFile {
            path,
            old_path,
            status: status_name(delta.status()).to_string(),
            binary: delta.old_file().is_binary() || delta.new_file().is_binary(),
            additions: 0,
            deletions: 0,
        };
        if !file.binary {
            match Patch::from_diff(&diff, idx) {
                Ok(Some(patch)) => {
                    if let Ok((_, added, removed)) = patch.line_stats() {
                        file.additions = added;
                        file.deletions = removed;
                    }
                }
                Ok(None) => file.binary = true,
                Err(_) => {}
            }
        }
        out.additions += file.additions;
        out.deletions += file.deletions;
        out.files.push(file);
    }

    out
}

/// One file out of a commit, in the shape the working-tree reads return so the
/// pane draws it with the same rows. `staged` is false and means nothing here.
pub fn read_commit_file(repo_path: &Path, sha: &str, file: &str) -> FileDiff {
    let repo = match Repository::open(repo_path) {
        Ok(repo) => repo,
        Err(err) => return FileDiff::failed(file, false, err.message().to_string()),
    };
    let (_, diff) = match build_commit(&repo, sha) {
        Ok(pair) => pair,
        Err(err) => return FileDiff::failed(file, false, err.message().to_string()),
    };
    let Some(idx) = locate(&diff, file) else {
        return FileDiff::empty(file, false);
    };
    let Some(delta) = diff.get_delta(idx) else {
        return FileDiff::empty(file, false);
    };
    expand(&diff, idx, delta, FileDiff::empty(file, false))
}

/// Writes the file as one commit had it and hands back the path.
///
/// Opening a file from a commit cannot open the working tree's copy, which is
/// the latest one, and the commit's copy exists only as a blob. So it goes out
/// to `show/<short sha>/<path>` under GitView's data folder, never into the
/// repository, with its directories kept so the editor's tab reads `shell.ts`
/// and its language mode still fires. The frontend then types `Invoke-Item` on
/// the path like the working tree's Open does, and a shift-click leaves the
/// line readable at the prompt. A deleted file has no blob at that commit and
/// is an error here; the row is disabled before it gets this far.
pub fn export_commit_file(repo_path: &Path, sha: &str, file: &str) -> Result<String, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let commit = repo
        .revparse_single(sha)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| e.message().to_string())?;
    let entry = commit
        .tree()
        .and_then(|t| t.get_path(Path::new(file)))
        .map_err(|_| format!("{file} is not in {}.", &sha[..sha.len().min(7)]))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| e.message().to_string())?;

    let short: String = commit.id().to_string().chars().take(7).collect();
    let dir = crate::scratch::dir("show")?;

    // The relative path is git's, forward slashes, joined a segment at a time
    // so the line at the prompt reads one way through. `..` cannot come out of
    // a tree entry, so nothing here escapes the folder.
    let path = file
        .split('/')
        .fold(dir.join(short), |acc, part| acc.join(part));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, blob.content()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ------------------------------------------------------------ hunk staging

/// The mode a `new file mode` line has to carry, written out rather than cast
/// from `FileMode`, whose discriminants are 0 to 6 and not the numbers git uses.
fn mode_of(file: &git2::DiffFile<'_>) -> u32 {
    match file.mode() {
        git2::FileMode::BlobExecutable => 0o100755,
        git2::FileMode::Link => 0o120000,
        git2::FileMode::Commit => 0o160000,
        _ => 0o100644,
    }
}

/// One hunk, written as a patch `git apply` will take.
///
/// Staging a hunk is the one action in this app with no command a person could
/// type, because the argument is the hunk itself. The patch file is that
/// argument: GitView writes it under its own data folder and the command that
/// applies it gets typed at the prompt like every other action here, so what
/// ran is on screen and the file it ran on is still there to read.
///
/// Built from libgit2's own line content rather than from the `DiffLine` rows
/// the pane drew. Those rows have their line endings trimmed for display, and a
/// repository holding CRLF in the index needs them back.
pub fn hunk_patch(
    repo_path: &Path,
    file: &str,
    staged: bool,
    hunk_index: usize,
    expect_header: &str,
) -> Result<String, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let diff = build(&repo, staged).map_err(|e| e.message().to_string())?;
    let idx = locate(&diff, file).ok_or_else(|| format!("{file} has no diff on this side."))?;
    let delta = diff
        .get_delta(idx)
        .ok_or_else(|| "That file left the diff between reading it and staging it.".to_string())?;

    let patch = Patch::from_diff(&diff, idx)
        .map_err(|e| e.message().to_string())?
        .ok_or_else(|| format!("{file} has no text to apply."))?;

    let (hunk, line_count) = patch
        .hunk(hunk_index)
        .map_err(|_| "That hunk is gone. Read the file again.".to_string())?;

    // The pane drew this hunk from an earlier read. Anything that moved the
    // file since has renumbered the hunks, so the header is checked against
    // what was on screen rather than trusting an index into a list that has
    // been rebuilt.
    let header = String::from_utf8_lossy(hunk.header())
        .trim_end_matches(['\n', '\r'])
        .to_string();
    if header != expect_header {
        return Err(format!(
            "That hunk moved. The pane had {expect_header}, the file now has {header}. Reopen it."
        ));
    }

    let old_path = slashed(delta.old_file().path()).unwrap_or_else(|| file.to_string());
    let new_path = slashed(delta.new_file().path()).unwrap_or_else(|| file.to_string());
    let created = delta.old_file().id().is_zero();
    let removed = delta.new_file().id().is_zero() && delta.status() == Delta::Deleted;

    let mut out = String::new();
    out.push_str(&format!("diff --git a/{old_path} b/{new_path}\n"));
    if created {
        out.push_str(&format!(
            "new file mode {:06o}\n",
            mode_of(&delta.new_file())
        ));
    } else if removed {
        out.push_str(&format!(
            "deleted file mode {:06o}\n",
            mode_of(&delta.old_file())
        ));
    }
    out.push_str(&format!(
        "--- {}\n",
        if created {
            "/dev/null".to_string()
        } else {
            format!("a/{old_path}")
        }
    ));
    out.push_str(&format!(
        "+++ {}\n",
        if removed {
            "/dev/null".to_string()
        } else {
            format!("b/{new_path}")
        }
    ));

    // The hunk travels alone, so the new-side start cannot be the one git wrote:
    // that number already carries the shift every earlier hunk would have made,
    // and none of them are in this patch. With nothing before it the new side
    // starts where the old side does, and a hunk that only adds lines starts one
    // past it, which is git's own `@@ -0,0 +1,3 @@`.
    let new_start = if hunk.old_lines() == 0 {
        hunk.old_start() + 1
    } else {
        hunk.old_start()
    };
    let context = header
        .rsplit_once("@@")
        .map(|(_, tail)| tail.to_string())
        .unwrap_or_default();
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@{}\n",
        hunk.old_start(),
        hunk.old_lines(),
        new_start,
        hunk.new_lines(),
        context
    ));

    for l in 0..line_count {
        let Ok(line) = patch.line_in_hunk(hunk_index, l) else {
            continue;
        };
        match line.origin() {
            '=' | '>' | '<' => {
                out.push_str("\\ No newline at end of file\n");
            }
            origin => {
                out.push(origin);
                out.push_str(&String::from_utf8_lossy(line.content()));
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
        }
    }

    Ok(out)
}

/// Puts the patch under GitView's data folder and hands back the path.
///
/// Never inside the repository. A patch file appearing in the working tree
/// would show up in the list of changes it was written to stage.
pub fn write_patch(
    repo_path: &str,
    file: &str,
    staged: bool,
    hunk_index: usize,
    text: &str,
) -> Result<String, String> {
    let dir = crate::scratch::dir("patches")?;

    // The whole relative path, flattened, so two files with the same basename
    // do not share a patch. The name is read at a prompt, so it stays legible.
    let side = if staged { "unstage" } else { "stage" };
    let name = crate::scratch::slug(&format!(
        "{}-{side}-{file}-h{}",
        crate::scratch::repo_name(repo_path),
        hunk_index + 1
    ));
    let path = dir.join(format!("{name}.patch"));

    // LF, whatever the working tree uses. `git apply` reads the patch as text
    // and the content lines came out of the index, which is LF here.
    std::fs::write(&path, text.replace("\r\n", "\n")).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
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

    // ------------------------------------------------------- hunk staging

    /// Runs the patch through the same `git apply --cached` the app types, and
    /// reports what git said when it refused.
    ///
    /// libgit2 can apply a patch in process, and it is not what runs here. The
    /// command the button types is `git.exe`, so that is what has to accept the
    /// file, down to the header numbers and the line endings.
    fn apply(fixture: &Fixture, patch: &str, extra: &[&str]) {
        let file = fixture.dir.parent().unwrap().join(format!(
            "gitview-patch-{}-{:?}.patch",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&file, patch).expect("write patch");
        let out = std::process::Command::new("git")
            .arg("apply")
            .arg("--cached")
            .args(extra)
            .arg(&file)
            .current_dir(&fixture.dir)
            .output()
            .expect("run git apply");
        let _ = std::fs::remove_file(&file);
        assert!(
            out.status.success(),
            "git apply refused the patch: {}\n--- patch ---\n{patch}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn body(range: std::ops::Range<usize>) -> String {
        range.map(|n| format!("line {n}\n")).collect()
    }

    /// The point of the whole thing: one hunk out of two reaches the index and
    /// the other one does not.
    #[test]
    fn one_hunk_of_two_reaches_the_index() {
        let fixture = Fixture::new("one-hunk");
        fixture.write("a.txt", &body(0..30));
        fixture.stage("a.txt");
        fixture.commit("first");

        let edited = body(0..30)
            .replace("line 2\n", "line 2 changed\n")
            .replace("line 25\n", "line 25 changed\n");
        fixture.write("a.txt", &edited);

        let before = read_file(&fixture.dir, "a.txt", false);
        assert_eq!(before.hunks.len(), 2, "two edits, far apart, two hunks");

        let patch = hunk_patch(&fixture.dir, "a.txt", false, 0, &before.hunks[0].header)
            .expect("build the patch");
        apply(&fixture, &patch, &[]);

        let staged = read_file(&fixture.dir, "a.txt", true);
        let unstaged = read_file(&fixture.dir, "a.txt", false);
        assert_eq!(added(&staged), vec!["line 2 changed"]);
        assert_eq!(added(&unstaged), vec!["line 25 changed"]);
    }

    /// The second hunk on its own is the case the header arithmetic exists for.
    /// git writes a new-side start that already carries the shift from every
    /// earlier hunk, and none of those are in this patch.
    #[test]
    fn the_second_hunk_alone_carries_its_own_numbers() {
        let fixture = Fixture::new("second-hunk");
        fixture.write("a.txt", &body(0..30));
        fixture.stage("a.txt");
        fixture.commit("first");

        // The first hunk adds two lines, so git's new-side start for the second
        // one sits two further down than the index has it.
        let edited = body(0..30)
            .replace("line 2\n", "line 2\nline 2a\nline 2b\n")
            .replace("line 25\n", "line 25 changed\n");
        fixture.write("a.txt", &edited);

        let before = read_file(&fixture.dir, "a.txt", false);
        assert_eq!(before.hunks.len(), 2);

        let patch = hunk_patch(&fixture.dir, "a.txt", false, 1, &before.hunks[1].header)
            .expect("build the patch");
        apply(&fixture, &patch, &[]);

        let staged = read_file(&fixture.dir, "a.txt", true);
        assert_eq!(added(&staged), vec!["line 25 changed"]);
    }

    /// Unstaging is the same patch run backwards, against the other side.
    #[test]
    fn a_staged_hunk_comes_back_out_in_reverse() {
        let fixture = Fixture::new("reverse");
        fixture.write("a.txt", &body(0..30));
        fixture.stage("a.txt");
        fixture.commit("first");

        let edited = body(0..30)
            .replace("line 2\n", "line 2 changed\n")
            .replace("line 25\n", "line 25 changed\n");
        fixture.write("a.txt", &edited);
        fixture.stage("a.txt");

        let staged = read_file(&fixture.dir, "a.txt", true);
        assert_eq!(staged.hunks.len(), 2);

        let patch =
            hunk_patch(&fixture.dir, "a.txt", true, 0, &staged.hunks[0].header).expect("patch");
        apply(&fixture, &patch, &["--reverse"]);

        let after = read_file(&fixture.dir, "a.txt", true);
        assert_eq!(
            added(&after),
            vec!["line 25 changed"],
            "the first hunk left the index and the second stayed"
        );
    }

    /// An untracked file is not in the index at all, so its patch needs the
    /// `new file mode` line or git apply has nothing to create.
    #[test]
    fn an_untracked_file_stages_through_a_new_file_patch() {
        let fixture = Fixture::new("new-file");
        fixture.write("seed.txt", "seed\n");
        fixture.stage("seed.txt");
        fixture.commit("first");

        fixture.write("fresh.txt", "one\ntwo\nthree\n");
        let diff = read_file(&fixture.dir, "fresh.txt", false);
        assert_eq!(diff.status, "new");

        let patch =
            hunk_patch(&fixture.dir, "fresh.txt", false, 0, &diff.hunks[0].header).expect("patch");
        assert!(
            patch.contains("new file mode 100644"),
            "the patch has to say the file is new:\n{patch}"
        );
        apply(&fixture, &patch, &[]);

        let staged = read_file(&fixture.dir, "fresh.txt", true);
        assert_eq!(added(&staged), vec!["one", "two", "three"]);
    }

    /// The pane draws a hunk from an earlier read. Anything that moved the file
    /// since has renumbered the hunks, and applying the wrong one silently is
    /// the failure worth refusing.
    #[test]
    fn a_hunk_that_moved_is_refused_rather_than_applied() {
        let fixture = Fixture::new("moved");
        fixture.write("a.txt", &body(0..30));
        fixture.stage("a.txt");
        fixture.commit("first");
        fixture.write(
            "a.txt",
            &body(0..30).replace("line 2\n", "line 2 changed\n"),
        );

        let err = hunk_patch(&fixture.dir, "a.txt", false, 0, "@@ -900,7 +900,7 @@")
            .expect_err("a header that does not match must not produce a patch");
        assert!(err.contains("moved"), "{err}");
    }

    // ---------------------------------------------------------- one commit

    /// The list the commit pane draws: every file, with its counts, and the
    /// commit's own text around it. `git show --stat` is the reference.
    #[test]
    fn a_commit_lists_its_files_with_their_counts() {
        let fixture = Fixture::new("commit-list");
        fixture.write(
            "a.txt", "one
two
",
        );
        fixture.write(
            "b.txt", "keep
",
        );
        fixture.stage("a.txt");
        fixture.stage("b.txt");
        fixture.commit("first");

        fixture.write(
            "a.txt",
            "one
three
",
        );
        std::fs::remove_file(fixture.dir.join("b.txt")).expect("remove");
        fixture.write(
            "c.txt", "new
",
        );
        fixture.stage("a.txt");
        fixture.stage("b.txt");
        fixture.stage("c.txt");
        fixture.commit(
            "second

The body, on its own paragraph.
",
        );

        let commit = read_commit(&fixture.dir, "HEAD");

        assert!(commit.error.is_none(), "{:?}", commit.error);
        assert_eq!(commit.summary, "second");
        assert_eq!(commit.body, "The body, on its own paragraph.");
        assert_eq!(commit.author, "Test");
        assert_eq!(commit.parents.len(), 1);
        let rows: Vec<(&str, &str, usize, usize)> = commit
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str(), f.additions, f.deletions))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("a.txt", "modified", 1, 1),
                ("b.txt", "deleted", 0, 1),
                ("c.txt", "new", 1, 0),
            ]
        );
        assert_eq!((commit.additions, commit.deletions), (2, 2));

        let file = read_commit_file(&fixture.dir, "HEAD", "a.txt");
        assert!(file.error.is_none(), "{:?}", file.error);
        assert_eq!(added(&file), vec!["three"]);
        assert_eq!(file.hunks.len(), 1);
    }

    /// A subject wrapped over two lines is one paragraph, and the body starts
    /// after it rather than after the first newline.
    #[test]
    fn a_wrapped_subject_stays_out_of_the_body() {
        let fixture = Fixture::new("commit-wrapped");
        fixture.write("a.txt", "one\n");
        fixture.stage("a.txt");
        fixture.commit("first line of the subject\nsecond line of the subject\n\nThe body.\n");

        let commit = read_commit(&fixture.dir, "HEAD");
        assert_eq!(
            commit.summary,
            "first line of the subject second line of the subject"
        );
        assert_eq!(commit.body, "The body.");
    }

    /// A root commit has no parent to diff against. Diffing against nothing is
    /// what `git show` does there too: every file is new.
    #[test]
    fn a_root_commit_reads_every_file_as_new() {
        let fixture = Fixture::new("commit-root");
        fixture.write(
            "a.txt", "one
two
",
        );
        fixture.stage("a.txt");
        fixture.commit("first");

        let commit = read_commit(&fixture.dir, "HEAD");
        assert!(commit.error.is_none(), "{:?}", commit.error);
        assert!(commit.parents.is_empty());
        assert_eq!(commit.files.len(), 1);
        assert_eq!(commit.files[0].status, "new");
        assert_eq!(commit.files[0].additions, 2);

        let file = read_commit_file(&fixture.dir, "HEAD", "a.txt");
        assert_eq!(added(&file), vec!["one", "two"]);
    }

    /// A rename in a commit shows once, under the name it has now, the same
    /// way the working-tree read reports one.
    #[test]
    fn a_renamed_file_in_a_commit_shows_once() {
        let fixture = Fixture::new("commit-rename");
        fixture.write("old.rs", &body(0..30));
        fixture.stage("old.rs");
        fixture.commit("first");
        std::fs::rename(fixture.dir.join("old.rs"), fixture.dir.join("new.rs")).expect("rename");
        fixture.stage("old.rs");
        fixture.stage("new.rs");
        fixture.commit("move");

        let commit = read_commit(&fixture.dir, "HEAD");
        assert_eq!(commit.files.len(), 1, "{:?}", commit.files);
        assert_eq!(commit.files[0].path, "new.rs");
        assert_eq!(commit.files[0].old_path.as_deref(), Some("old.rs"));
        assert_eq!(commit.files[0].status, "renamed");
    }

    /// A sha that names nothing is an answer with an error in it, which the
    /// pane shows, rather than a panic across the Tauri boundary.
    #[test]
    fn an_unknown_commit_is_an_error_not_a_panic() {
        let fixture = Fixture::new("commit-missing");
        fixture.write(
            "a.txt", "one
",
        );
        fixture.stage("a.txt");
        fixture.commit("first");

        let commit = read_commit(&fixture.dir, "deadbeef");
        assert!(commit.error.is_some());
        assert!(commit.files.is_empty());
    }

    /// Opening a file from a commit hands out that commit's bytes, not the
    /// working tree's, at a path that ends the way the file's own does.
    #[test]
    fn export_writes_the_commits_copy_not_the_working_trees() {
        let fixture = Fixture::new("export");
        std::fs::create_dir_all(fixture.dir.join("src")).expect("mkdir");
        fixture.write(
            "src/a.txt",
            "old
",
        );
        fixture.stage("src/a.txt");
        fixture.commit("first");
        let first = fixture.repo.head().unwrap().target().unwrap().to_string();
        fixture.write(
            "src/a.txt",
            "new
",
        );
        fixture.stage("src/a.txt");
        fixture.commit("second");

        let path = export_commit_file(&fixture.dir, &first, "src/a.txt").expect("export");
        assert!(path.ends_with("a.txt"), "{path}");
        assert!(path.contains(&first[..7]), "{path}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "old
"
        );
        let _ = std::fs::remove_dir_all(Path::new(&path).parent().unwrap().parent().unwrap());

        let missing = export_commit_file(&fixture.dir, &first, "src/b.txt");
        assert!(missing.is_err());
    }
}
