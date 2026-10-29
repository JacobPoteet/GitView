//! Who last touched each line of a file, as of one commit or as it is on disk.
//!
//! A read, in process through `git2` like the diff. `Repository::blame_file`
//! answers per hunk, a run of lines that one commit wrote, and that is what
//! goes back: the pane spreads a hunk over its lines itself, so a file of six
//! thousand lines with forty authors is forty rows and not six thousand. Each
//! commit is looked up once for its time and author, since a hunk names only
//! the id.
//!
//! Capped at the same six thousand lines as the diff, on the same argument:
//! past that the pane has stopped drawing rows to put a gutter beside.

use git2::{BlameOptions, Oid, Repository};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// The line the diff stops at, and so the line the gutter does.
const MAX_LINES: usize = 6000;

/// One run of lines that one commit wrote, numbered on the file as of the
/// commit the blame was asked for.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    /// The first line, counting from 1.
    pub start: u32,
    pub lines: u32,
    pub id: String,
    pub short: String,
    pub author: String,
    /// Seconds since the epoch, the commit's own time.
    pub time: i64,
    pub summary: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub hunks: Vec<BlameHunk>,
    /// The read stopped at the cap.
    pub truncated: bool,
    pub error: Option<String>,
}

pub fn read_blame(repo_path: &Path, sha: &str, file: &str) -> Blame {
    match blame(repo_path, sha, file) {
        Ok(blame) => blame,
        Err(err) => Blame {
            error: Some(err.message().to_string()),
            ..Blame::default()
        },
    }
}

fn blame(repo_path: &Path, sha: &str, file: &str) -> Result<Blame, git2::Error> {
    let repo = Repository::open(repo_path)?;
    let newest = repo.revparse_single(sha)?.peel_to_commit()?.id();
    let mut opts = BlameOptions::new();
    opts.newest_commit(newest);
    let blame = repo.blame_file(Path::new(file), Some(&mut opts))?;
    collect(&repo, &blame)
}

/// Who last touched each line of the file on disk, for the file view.
///
/// A blame of HEAD, then `blame_buffer` over the bytes on disk, which numbers
/// it on the working tree's lines and gives the lines nobody has committed a
/// zero id. A file HEAD does not have, or a repository with no commit yet, is
/// uncommitted from its first line to its last.
pub fn read_blame_worktree(repo_path: &Path, file: &str) -> Blame {
    match blame_worktree(repo_path, file) {
        Ok(blame) => blame,
        Err(err) => Blame {
            error: Some(err.message().to_string()),
            ..Blame::default()
        },
    }
}

fn blame_worktree(repo_path: &Path, file: &str) -> Result<Blame, git2::Error> {
    let repo = Repository::open(repo_path)?;
    let root = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("The repository has no working tree."))?;
    let bytes =
        std::fs::read(root.join(file)).map_err(|err| git2::Error::from_str(&err.to_string()))?;
    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let tracked = head
        .as_ref()
        .and_then(|c| c.tree().ok())
        .is_some_and(|tree| tree.get_path(Path::new(file)).is_ok());
    let Some(head) = head.filter(|_| tracked) else {
        let count = bytes.split(|b| *b == b'\n').count()
            - usize::from(bytes.last() == Some(&b'\n') || bytes.is_empty());
        let mut out = Blame::default();
        if count > 0 {
            out.truncated = count > MAX_LINES;
            out.hunks.push(uncommitted(1, count.min(MAX_LINES) as u32));
        }
        return Ok(out);
    };
    // `blame_buffer` compares bytes, and with `core.autocrlf` the disk has CRLF
    // where the commit has LF, so every line read as uncommitted. A commit
    // with no CR in the file gets the disk's CRLFs folded the way `git add`
    // would fold them.
    let committed = head
        .tree()?
        .get_path(Path::new(file))?
        .to_object(&repo)?
        .peel_to_blob()?;
    let bytes = if committed.content().contains(&b'\r') {
        bytes
    } else {
        fold_crlf(&bytes)
    };
    let mut opts = BlameOptions::new();
    opts.newest_commit(head.id());
    let base = repo.blame_file(Path::new(file), Some(&mut opts))?;
    let blame = base.blame_buffer(&bytes)?;
    collect(&repo, &blame)
}

fn fold_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*b);
    }
    out
}

/// A run of lines nobody has committed. No sha to open, and the time is now,
/// which tints it as the newest thing in the gutter, as it is.
fn uncommitted(start: u32, lines: u32) -> BlameHunk {
    BlameHunk {
        start,
        lines,
        id: String::new(),
        short: String::new(),
        author: String::new(),
        time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64),
        summary: "Not committed yet".to_string(),
    }
}

fn collect(repo: &Repository, blame: &git2::Blame<'_>) -> Result<Blame, git2::Error> {
    let mut out = Blame::default();
    let mut seen: HashMap<Oid, (String, String, i64, String)> = HashMap::new();
    for hunk in blame.iter() {
        let start = hunk.final_start_line() as u32;
        let lines = hunk.lines_in_hunk() as u32;
        if start as usize > MAX_LINES {
            out.truncated = true;
            break;
        }
        let id = hunk.final_commit_id();
        if id.is_zero() {
            let room = (MAX_LINES as u32 + 1).saturating_sub(start);
            out.truncated = lines > room;
            out.hunks.push(uncommitted(start, lines.min(room)));
            if out.truncated {
                break;
            }
            continue;
        }
        let (short, author, time, summary) = match seen.get(&id) {
            Some(found) => found.clone(),
            None => {
                let commit = repo.find_commit(id)?;
                let short = repo
                    .find_object(id, None)?
                    .short_id()?
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let author = commit.author().name().unwrap_or("").to_string();
                let summary = commit.summary().unwrap_or("").to_string();
                let found = (short, author, commit.time().seconds(), summary);
                seen.insert(id, found.clone());
                found
            }
        };
        let lines = if (start + lines) as usize > MAX_LINES + 1 {
            out.truncated = true;
            (MAX_LINES as u32 + 1).saturating_sub(start)
        } else {
            lines
        };
        out.hunks.push(BlameHunk {
            start,
            lines,
            id: id.to_string(),
            short,
            author,
            time,
            summary,
        });
        if out.truncated {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This repository's own history, which is enough to see hunks come back
    /// numbered and attributed, and to say what a real file costs.
    #[test]
    fn blames_this_repository() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let started = std::time::Instant::now();
        let blame = read_blame(&root, "HEAD", "src/App.tsx");
        let took = started.elapsed();
        assert!(blame.error.is_none(), "{:?}", blame.error);
        assert!(!blame.hunks.is_empty());
        assert_eq!(blame.hunks[0].start, 1);
        let total: u32 = blame.hunks.iter().map(|h| h.lines).sum();
        assert!(total > 1000, "App.tsx is longer than that: {total}");
        for pair in blame.hunks.windows(2) {
            assert_eq!(
                pair[0].start + pair[0].lines,
                pair[1].start,
                "hunks are contiguous"
            );
        }
        eprintln!(
            "blame src/App.tsx: {} lines in {} hunks, {} ms",
            total,
            blame.hunks.len(),
            took.as_millis()
        );
    }

    /// The working tree's blame numbers lines as they are on disk: a line
    /// inserted above shifts the committed ones down, and the inserted line
    /// has no sha. A file HEAD does not have is uncommitted throughout.
    #[test]
    fn the_working_tree_blame_follows_the_lines_on_disk() {
        let dir = std::env::temp_dir().join(format!(
            "gitview-blame-wt-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let commit = repo
            .commit(Some("HEAD"), &sig, &sig, "first", &tree, &[])
            .unwrap();

        std::fs::write(dir.join("a.txt"), "zero\none\ntwo\n").unwrap();
        let blame = read_blame_worktree(&dir, "a.txt");
        assert!(blame.error.is_none(), "{:?}", blame.error);
        let spans: Vec<_> = blame
            .hunks
            .iter()
            .map(|h| (h.start, h.lines, h.id.clone()))
            .collect();
        assert_eq!(
            spans,
            [(1, 1, String::new()), (2, 2, commit.to_string())],
            "the inserted line is uncommitted and the rest moved down one"
        );

        // The same lines with CRLF on disk, as `core.autocrlf` leaves them,
        // are still the committed ones.
        std::fs::write(dir.join("a.txt"), "zero\r\none\r\ntwo\r\n").unwrap();
        let crlf = read_blame_worktree(&dir, "a.txt");
        let spans: Vec<_> = crlf
            .hunks
            .iter()
            .map(|h| (h.start, h.lines, h.id.is_empty()))
            .collect();
        assert_eq!(spans, [(1, 1, true), (2, 2, false)]);

        std::fs::write(dir.join("b.txt"), "x\ny").unwrap();
        let new = read_blame_worktree(&dir, "b.txt");
        assert_eq!(new.hunks.len(), 1);
        assert_eq!((new.hunks[0].start, new.hunks[0].lines), (1, 2));
        assert!(new.hunks[0].id.is_empty());

        drop(tree);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
