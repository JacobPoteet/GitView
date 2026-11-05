//! What it would take to delete a repository's other branches.
//!
//! The sweep knows which branches exist and who holds them. It cannot know
//! what removing a worktree would refuse over or lose, and it should not try: a
//! status per worktree on every sweep is the cost the sweep exists to avoid. So
//! the Clean up dialog reads this when it opens, and nothing else does.
//!
//! `git status` is asked through `git.exe` rather than libgit2, the one read in
//! the app that goes this way, because the question is what `git worktree
//! remove` is going to say, and it decides by running that same command. The two
//! disagree on the case this module exists for. A file whose line endings were
//! rewritten changes size, git reports it modified without comparing content,
//! and libgit2 hashes it through the same filter, gets the indexed blob and
//! reports it clean. Trusting libgit2 here would offer a remove git then refuses.

use git2::Repository;
use serde::Serialize;
use std::path::Path;

use crate::fleet::{default_branch, default_tip, native, origin_refs, read_worktrees, RepoState};
use crate::gitops;

/// Names to show per list. The list is for judging a worktree, not for reading
/// a whole tree, and the counts say how much was left off.
const MAX_NAMES: usize = 20;

/// Remote branches to measure, newest first. A count against the trunk per
/// branch is the cost, and past this nobody is reading the rows.
const MAX_REMOTE: usize = 200;

/// The largest file worth reading to compare line endings. Anything bigger is
/// reported as changed, which sends it down the route that keeps a copy.
const MAX_COMPARED: u64 = 8 * 1024 * 1024;

/// Ignored folders that a build recreates, left out of what the dialog warns
/// about. Everything else ignored goes with the worktree too, and might not
/// come back: `.env.local` is ignored because it matters.
const REBUILT: &[&str] = &[
    ".cache",
    ".claude",
    ".gradle",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".venv",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "dist",
    "gen",
    "node_modules",
    "obj",
    "out",
    "target",
    "venv",
];

/// What removing one linked worktree would run into.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCheck {
    pub path: String,
    /// Tracked changes and untracked files: work `git stash push -u` can keep.
    pub changed: Vec<String>,
    pub changed_count: usize,
    /// Files git calls modified whose content matches but for line endings.
    /// `git restore` puts them right, and nothing is lost by it. Listed whole,
    /// since the command has to name them; see `MAX_RESTORED` in `cleanup.ts`.
    pub line_endings: Vec<String>,
    /// Ignored files outside `REBUILT`, which neither a stash nor a remove keeps.
    pub ignored: Vec<String>,
    pub ignored_count: usize,
    /// git refuses to remove a worktree holding submodules without `--force`.
    pub submodules: bool,
    /// A program has the folder open, so `git worktree remove` would stop at
    /// "Should I try again? (y/n)" with the rest of the commands queued behind it.
    pub in_use: bool,
    /// The status could not be read, so nothing above can be trusted.
    pub error: Option<String>,
}

/// One branch on origin, measured against the trunk.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// As origin names it, `feat/x` rather than `origin/feat/x`.
    pub name: String,
    pub tip: String,
    /// Commits here that the trunk does not have. Zero is contained, and None
    /// is a repository with no trunk to measure against.
    pub ahead: Option<usize>,
    pub last_commit_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRead {
    /// Every linked worktree whose folder is still there.
    pub worktrees: Vec<WorktreeCheck>,
    /// Every branch on origin but the default, newest first, up to `MAX_REMOTE`.
    pub remote_branches: Vec<RemoteBranch>,
}

pub fn read(path: &Path) -> CleanupRead {
    let Ok(repo) = Repository::open(path) else {
        return CleanupRead::default();
    };
    let mut state = RepoState::empty(path);
    read_worktrees(&repo, &mut state);
    CleanupRead {
        worktrees: state
            .worktrees
            .iter()
            .filter(|worktree| !worktree.main && !worktree.prunable)
            .map(|worktree| check_worktree(Path::new(&worktree.path)))
            .collect(),
        remote_branches: remote_branches(&repo),
    }
}

/// Asks git what it would refuse over, then sorts the answer.
fn check_worktree(path: &Path) -> WorktreeCheck {
    let mut check = WorktreeCheck {
        path: native(path),
        changed: Vec::new(),
        changed_count: 0,
        line_endings: Vec::new(),
        ignored: Vec::new(),
        ignored_count: 0,
        submodules: false,
        in_use: false,
        error: None,
    };
    match folder_in_use(path) {
        Ok(held) => check.in_use = held,
        Err(message) => {
            check.error = Some(message);
            return check;
        }
    }
    let repo = match Repository::open(path) {
        Ok(repo) => repo,
        Err(err) => {
            check.error = Some(err.message().to_string());
            return check;
        }
    };
    check.submodules = has_submodules(&repo);

    let args: Vec<String> = ["status", "--porcelain=v1", "-z", "--ignored"]
        .map(str::to_string)
        .to_vec();
    let outcome = gitops::run(path, &args);
    if outcome.code != 0 {
        check.error = Some(outcome.stderr.trim().to_string());
        return check;
    }

    for entry in status_entries(&outcome.stdout) {
        match entry.code {
            "!!" => {
                if !is_rebuilt(entry.path) {
                    check.ignored_count += 1;
                    if check.ignored.len() < MAX_NAMES {
                        check.ignored.push(entry.path.to_string());
                    }
                }
            }
            " M" if differs_only_in_line_endings(&repo, path, entry.path) => {
                check.line_endings.push(entry.path.to_string());
            }
            _ => {
                check.changed_count += 1;
                if check.changed.len() < MAX_NAMES {
                    check.changed.push(entry.path.to_string());
                }
            }
        }
    }
    check
}

/// Whether something has this folder or anything under it open.
///
/// Windows refuses to rename a folder with a process standing anywhere inside it
/// or a file held open in it, which is the same thing that stops the delete, and
/// it refuses at once rather than asking. The folder goes back in the same breath.
/// Nothing can see it moved unless it starts in that moment, and anything already
/// running in there is what makes the first rename fail.
///
/// A running `.exe` is the gap: it stops the delete and not the rename, measured
/// 5 Nov 2026, so a dev build started from inside still reaches git's prompt.
#[cfg(windows)]
fn folder_in_use(path: &Path) -> Result<bool, String> {
    let mut aside = path.as_os_str().to_owned();
    aside.push(".gitview-probe");
    let aside = std::path::PathBuf::from(aside);
    if std::fs::rename(path, &aside).is_err() {
        return Ok(true);
    }
    // Defender or the indexer can look at a new name the moment it appears.
    let mut last = None;
    for _ in 0..40 {
        match std::fs::rename(&aside, path) {
            Ok(()) => return Ok(false),
            Err(err) => last = Some(err),
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err(format!(
        "could not move {} back from {}: {}",
        path.display(),
        aside.display(),
        last.map(|err| err.to_string()).unwrap_or_default()
    ))
}

#[cfg(not(windows))]
fn folder_in_use(_path: &Path) -> Result<bool, String> {
    Ok(false)
}

struct StatusEntry<'a> {
    code: &'a str,
    path: &'a str,
}

/// `git status --porcelain -z`: `XY path`, NUL between entries, and a rename or
/// copy followed by one more field holding the path it came from.
fn status_entries(stdout: &str) -> Vec<StatusEntry<'_>> {
    let mut out = Vec::new();
    let mut fields = stdout.split('\0');
    while let Some(field) = fields.next() {
        let (Some(code), Some(path)) = (field.get(..2), field.get(3..)) else {
            continue;
        };
        if code.contains(['R', 'C']) {
            fields.next();
        }
        out.push(StatusEntry { code, path });
    }
    out
}

fn is_rebuilt(path: &str) -> bool {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .is_some_and(|name| REBUILT.contains(&name))
}

/// Whether a modified file is the indexed one with its line endings changed.
///
/// Compares bytes with every carriage return dropped, which is exactly the
/// claim being made. Read straight from disk rather than through libgit2's
/// filters, whose idea of the file is what cannot be relied on here.
fn differs_only_in_line_endings(repo: &Repository, root: &Path, file: &str) -> bool {
    let on_disk = root.join(file);
    let small = std::fs::metadata(&on_disk).is_ok_and(|meta| meta.len() <= MAX_COMPARED);
    if !small {
        return false;
    }
    let Ok(index) = repo.index() else {
        return false;
    };
    let Some(entry) = index.get_path(Path::new(file), 0) else {
        return false;
    };
    let Ok(blob) = repo.find_blob(entry.id) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(&on_disk) else {
        return false;
    };
    let plain =
        |bytes: &[u8]| -> Vec<u8> { bytes.iter().copied().filter(|b| *b != b'\r').collect() };
    plain(&bytes) == plain(blob.content())
}

/// A gitlink in the index, which is what `git worktree remove` checks for.
fn has_submodules(repo: &Repository) -> bool {
    const GITLINK: u32 = 0o160000;
    repo.index()
        .map(|index| index.iter().any(|entry| entry.mode == GITLINK))
        .unwrap_or(false)
}

fn remote_branches(repo: &Repository) -> Vec<RemoteBranch> {
    let default = default_branch(repo);
    let (base, _) = default_tip(repo, default.as_deref());

    let mut found: Vec<(String, git2::Oid, Option<i64>)> = origin_refs(repo)
        .into_iter()
        .filter(|name| Some(name) != default.as_ref())
        .filter_map(|name| {
            let oid = repo
                .find_reference(&format!("refs/remotes/origin/{name}"))
                .ok()?
                .target()?;
            let when = repo.find_commit(oid).ok().map(|c| c.time().seconds());
            Some((name, oid, when))
        })
        .collect();
    found.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    found.truncate(MAX_REMOTE);

    found
        .into_iter()
        .map(|(name, tip, last_commit_at)| RemoteBranch {
            name,
            tip: tip.to_string(),
            ahead: base
                .and_then(|base| repo.graph_ahead_behind(tip, base).ok())
                .map(|(ahead, _)| ahead),
            last_commit_at,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn git(cwd: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git.exe")
    }

    /// A repository that converts line endings, with one file committed and one
    /// linked worktree, the way a Windows checkout of this project is set up.
    fn fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("gitview-clean-{tag}-{}", std::process::id()));
        let work = dir.join("work");
        let linked = dir.join("linked");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "core.autocrlf", "true"]);
        git(&work, &["config", "user.email", "t@t"]);
        git(&work, &["config", "user.name", "t"]);
        git(&work, &["config", "commit.gpgsign", "false"]);
        std::fs::write(work.join("a.txt"), "one\r\ntwo\r\n").unwrap();
        std::fs::write(work.join(".gitignore"), "target/\n.env.local\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "base"]);
        git(
            &work,
            &["worktree", "add", "-q", "../linked", "-b", "topic"],
        );
        (dir, work, linked)
    }

    fn check_of(work: &Path) -> WorktreeCheck {
        let read = read(work);
        assert_eq!(read.worktrees.len(), 1);
        read.worktrees.into_iter().next().unwrap()
    }

    #[test]
    fn a_clean_worktree_has_nothing_to_report() {
        let (dir, work, _) = fixture("clean");
        let check = check_of(&work);
        assert_eq!(check.changed_count, 0);
        assert!(check.line_endings.is_empty());
        assert!(check.ignored.is_empty());
        assert!(!check.submodules);
        assert_eq!(check.error, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn line_endings_alone_are_told_apart_from_an_edit() {
        let (dir, work, linked) = fixture("eol");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(linked.join("a.txt"), "one\ntwo\n").unwrap();

        // The premise: git refuses this, and the diff is empty.
        let refused = git(&work, &["worktree", "remove", "../linked"]);
        assert!(!refused.status.success());

        let check = check_of(&work);
        assert_eq!(check.line_endings, vec!["a.txt".to_string()]);
        assert_eq!(check.changed_count, 0);

        // Restoring what the dialog names is enough for a plain remove to work.
        assert!(git(&linked, &["restore", "--", "a.txt"]).status.success());
        assert!(git(&work, &["worktree", "remove", "../linked"])
            .status
            .success());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_real_edit_and_a_new_file_count_as_changed() {
        let (dir, work, linked) = fixture("edit");
        std::fs::write(linked.join("a.txt"), "one\nthree\n").unwrap();
        std::fs::write(linked.join("new.txt"), "n\n").unwrap();
        let check = check_of(&work);
        assert!(check.line_endings.is_empty());
        assert_eq!(check.changed_count, 2);
        assert!(check.changed.contains(&"a.txt".to_string()));
        assert!(check.changed.contains(&"new.txt".to_string()));

        // A stash is what makes the remove safe, and it outlives the worktree.
        let stash = git(&linked, &["stash", "push", "-u", "-m", "kept"]);
        assert!(stash.status.success());
        assert!(git(&work, &["worktree", "remove", "../linked"])
            .status
            .success());
        let list = git(&work, &["stash", "list"]);
        assert!(String::from_utf8_lossy(&list.stdout).contains("kept"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignored_files_are_named_unless_a_build_recreates_them() {
        let (dir, work, linked) = fixture("ignored");
        std::fs::create_dir_all(linked.join("target").join("debug")).unwrap();
        std::fs::write(linked.join("target").join("debug").join("x"), "x").unwrap();
        std::fs::write(linked.join(".env.local"), "SECRET=1\n").unwrap();
        let check = check_of(&work);
        assert_eq!(check.ignored, vec![".env.local".to_string()]);
        assert_eq!(check.ignored_count, 1);
        assert_eq!(check.changed_count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_already_gone_is_not_checked() {
        let (dir, work, linked) = fixture("gone");
        std::fs::remove_dir_all(&linked).unwrap();
        assert!(read(&work).worktrees.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rename_takes_its_second_field_with_it() {
        let entries = status_entries("R  new.txt\0old.txt\0 M a.txt\0!! target/\0");
        let paths: Vec<_> = entries.iter().map(|e| (e.code, e.path)).collect();
        assert_eq!(
            paths,
            vec![("R ", "new.txt"), (" M", "a.txt"), ("!!", "target/")]
        );
    }

    #[test]
    fn only_a_folder_a_build_makes_is_written_off() {
        assert!(is_rebuilt("node_modules/"));
        assert!(is_rebuilt("src-tauri/target/"));
        assert!(is_rebuilt(".claude/"));
        assert!(is_rebuilt("src-tauri/gen/"));
        assert!(!is_rebuilt(".env.local"));
        assert!(!is_rebuilt("notes/"));
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_with_a_process_standing_in_it_reads_as_in_use() {
        let (dir, work, linked) = fixture("held");
        assert!(!check_of(&work).in_use);
        // Still where git expects it after being moved aside and back.
        assert!(git(&linked, &["status", "--porcelain"]).status.success());

        let sub = linked.join("deep");
        std::fs::create_dir_all(&sub).unwrap();
        let mut holder = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .current_dir(&sub)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("ping");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(check_of(&work).in_use);

        holder.kill().unwrap();
        holder.wait().unwrap();
        // The handle goes a moment after the process does.
        let mut held = true;
        for _ in 0..40 {
            held = check_of(&work).in_use;
            if !held {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(!held);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn origin_is_measured_against_the_trunk_and_its_default_left_out() {
        let dir = std::env::temp_dir().join(format!("gitview-clean-rem-{}", std::process::id()));
        let work = dir.join("work");
        let origin = dir.join("origin.git");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&work).unwrap();
        git(&dir, &["init", "-q", "--bare", "origin.git"]);
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "user.email", "t@t"]);
        git(&work, &["config", "user.name", "t"]);
        git(&work, &["config", "commit.gpgsign", "false"]);
        git(
            &work,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git(&work, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(&work, &["push", "-q", "-u", "origin", "main"]);
        git(&work, &["push", "-q", "origin", "main:contained"]);
        git(&work, &["switch", "-qc", "ahead"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "more"]);
        git(&work, &["push", "-q", "origin", "ahead"]);
        git(&work, &["switch", "-q", "main"]);
        git(&work, &["fetch", "-q", "--prune"]);

        let found = read(&work).remote_branches;
        let by_name = |n: &str| found.iter().find(|b| b.name == n);
        assert!(by_name("main").is_none());
        assert_eq!(by_name("contained").unwrap().ahead, Some(0));
        assert_eq!(by_name("ahead").unwrap().ahead, Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
