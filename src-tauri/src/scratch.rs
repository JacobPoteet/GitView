//! Files written under GitView's data folder so a typed command can name them.
//!
//! A hunk, an issue body and a commit message with line breaks are the
//! arguments nobody can type at a prompt. Each goes out as a file here, never
//! inside the repository, and the command carries the path: `git apply
//! --cached`, `--body-file`, `git commit -F`. The line stays readable before it
//! runs and re-runnable after. This module holds what those writers share:
//! the folder, the sweep, and the name.

use std::path::{Path, PathBuf};

/// How long a written file is left on disk.
///
/// Shift-clicking leaves the command at the prompt without running it, so the
/// file has to outlive the click by as long as somebody might leave a prompt
/// sitting there. A day covers it, and each write sweeps what is older.
pub const KEEP_SECS: u64 = 86_400;

/// One folder under the data folder, created if missing and swept of anything
/// older than [`KEEP_SECS`]. Files and folders both go: `show` keeps one
/// folder per commit, and a folder's mtime moves when a file lands in it, so a
/// commit somebody keeps opening stays.
///
/// A failed sweep leaves a file behind, which is a file; the write that
/// follows is the point.
pub fn dir(name: &str) -> Result<PathBuf, String> {
    let dir = crate::cache::data_dir().join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    sweep(&dir);
    Ok(dir)
}

fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|t| now.duration_since(t).map_err(std::io::Error::other))
            .map(|age| age.as_secs() > KEEP_SECS)
            .unwrap_or(false);
        if !stale {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// A name the prompt can show: alphanumerics, dots, dashes and underscores,
/// everything else a dash, and held under Windows' 255-byte segment cap with
/// the front and the back kept, since the back is where a deep path differs.
pub fn slug(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if flat.len() <= 200 {
        return flat;
    }
    let tail = &flat[flat.len() - 100..];
    format!("{}-{tail}", &flat[..99])
}

/// The folder name of a repository, for a file name that says which one.
pub fn repo_name(repo_path: &str) -> String {
    Path::new(repo_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string())
}

/// Writes a commit message out and hands back the path `git commit -F` wants.
///
/// A subject alone is `-m` and never comes here. A body with paragraphs could
/// be one `-m` per paragraph, and was until 16 Sep 2026, but a newline inside a
/// paragraph got joined to a space on the way, so a bulleted list arrived as
/// one line. A file keeps every line as written. LF, whatever the shell: git
/// reads the message as text and strips a trailing newline itself.
pub fn write_commit_message(repo_path: &str, message: &str) -> Result<String, String> {
    let dir = dir("messages")?;
    let subject = message
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(60)
        .collect::<String>();
    let name = slug(&format!("{}-{subject}", repo_name(repo_path)));
    let path = dir.join(format!("{name}.txt"));
    std::fs::write(&path, message.replace("\r\n", "\n")).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slug_keeps_what_a_prompt_can_read() {
        assert_eq!(slug("src/lib/shell.ts"), "src-lib-shell.ts");
        assert_eq!(slug("Fix the thing (again)"), "Fix-the-thing--again-");
    }

    #[test]
    fn a_long_slug_keeps_its_front_and_its_back() {
        let long = "a".repeat(150) + "/" + &"b".repeat(150);
        let short = slug(&long);
        assert_eq!(short.len(), 200);
        assert!(short.starts_with("aaa"));
        assert!(short.ends_with("bbb"));
    }

    #[test]
    fn a_message_is_written_with_every_line_it_had() {
        let message = "Subject\r\n\r\n- one\r\n- two\r\n";
        let path = write_commit_message("F:\\GitHub\\Example", message).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "Subject\n\n- one\n- two\n");
        assert!(path.ends_with("Example-Subject.txt"), "{path}");
        std::fs::remove_file(path).unwrap();
    }
}
