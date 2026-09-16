//! Who last touched each line of a file, as of one commit.
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
}
