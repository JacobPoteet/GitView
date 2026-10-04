//! A shell's scrollback, kept across restarts.
//!
//! Closing the app ends every session, and until 16 Sep 2026 the scrollback
//! went with it. The frontend serialises each buffer with xterm's serialize
//! addon and hands the text here, with the command blocks that were anchored
//! in it; the next launch writes the text back into the terminal before the
//! shell prints its first prompt, so yesterday's build output is still above
//! the cursor. One pair of files per session id under `scrollback/` in the
//! data folder: the text as `.ansi`, the blocks as `.json`.
//!
//! Nothing here is swept on a timer, unlike `scratch`: a scrollback is
//! overwritten on the next save and cleared from the settings dialog, and a
//! repository not opened for a month still has a scrollback worth keeping.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A command block as it was anchored in the buffer when it was saved. The
/// line is where its command sat, which the restore hands back to xterm as a
/// marker; the frontend then checks the line against the command text the
/// way it does for a live block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBlock {
    pub command: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub line: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub text: String,
    pub blocks: Vec<StoredBlock>,
    /// Seconds since the epoch at which it was written.
    pub saved_at: i64,
}

fn dir() -> Result<PathBuf, String> {
    let dir = crate::cache::data_dir().join("scrollback");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn paths(id: &str) -> Result<(PathBuf, PathBuf), String> {
    let dir = dir()?;
    let slug = crate::scratch::slug(id);
    Ok((
        dir.join(format!("{slug}.ansi")),
        dir.join(format!("{slug}.json")),
    ))
}

/// Writes beside the target and renames over it, so a crash or a kill during
/// the close hold leaves the old file whole instead of half of a new one. The
/// text and its blocks are two files, and a torn pair puts the gutter on the
/// wrong lines.
fn write_atomic(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let mut temp = path.clone().into_os_string();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

/// Writes a session's buffer and blocks, replacing what was there.
pub fn write(id: &str, text: &str, blocks: &[StoredBlock]) -> Result<(), String> {
    let (ansi, json) = paths(id)?;
    let meta = Stored {
        text: String::new(),
        blocks: blocks.to_vec(),
        saved_at: crate::cache::now_secs(),
    };
    let body = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    // The blocks first: a text with no sidecar is still the scrollback, and a
    // sidecar newer than its text is the half that misleads.
    write_atomic(&json, body.as_bytes())?;
    write_atomic(&ansi, text.as_bytes())
}

/// What was saved for a session, or nothing when there is nothing.
pub fn read(id: &str) -> Result<Option<Stored>, String> {
    let (ansi, json) = paths(id)?;
    let Ok(text) = std::fs::read_to_string(&ansi) else {
        return Ok(None);
    };
    // The blocks are a hint about the text. Text with no readable blocks is
    // still the scrollback, so a bad sidecar costs the gutter and not the
    // lines.
    let mut meta: Stored = std::fs::read_to_string(&json)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or(Stored {
            text: String::new(),
            blocks: Vec::new(),
            saved_at: 0,
        });
    meta.text = text;
    Ok(Some(meta))
}

/// Forgets one session's scrollback, for when its shell is closed on purpose.
pub fn remove(id: &str) -> Result<(), String> {
    let (ansi, json) = paths(id)?;
    let _ = std::fs::remove_file(ansi);
    let _ = std::fs::remove_file(json);
    Ok(())
}

/// Every byte under the folder, for the settings dialog to state.
pub fn size() -> Result<u64, String> {
    let dir = dir()?;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    Ok(entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum())
}

/// Removes every saved scrollback.
pub fn clear() -> Result<(), String> {
    let dir = dir()?;
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_replaces_the_file_and_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("gitview-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.ansi");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert!(!dir.join("a.ansi.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
