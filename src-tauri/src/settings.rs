//! Scan roots.
//!
//! A list rather than one path, because projects rarely all live under the same
//! parent. The first run guesses from the folders that exist, and the guess is
//! written back so later runs never re-detect.

use std::path::PathBuf;

use crate::cache::Cache;

const KEY: &str = "scan_roots";

pub fn roots(cache: &Cache) -> Vec<String> {
    if let Some(raw) = cache.get_setting(KEY) {
        if let Ok(stored) = serde_json::from_str::<Vec<String>>(&raw) {
            if !stored.is_empty() {
                return stored;
            }
        }
    }

    let detected = detect();
    let _ = set_roots(cache, &detected);
    detected
}

pub fn set_roots(cache: &Cache, roots: &[String]) -> anyhow::Result<()> {
    cache.set_setting(KEY, &serde_json::to_string(roots)?)?;
    Ok(())
}

/// Checks the places people keep a folder full of checkouts and keeps the ones
/// that exist. Ordered so a dedicated drive wins over a home directory.
fn detect() -> Vec<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    for drive in ["F", "E", "D", "C"] {
        candidates.push(PathBuf::from(format!("{drive}:\\GitHub")));
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("GitHub"));
        candidates.push(home.join("source").join("repos"));
        candidates.push(home.join("Documents").join("GitHub"));
        candidates.push(home.join("Projects"));
        candidates.push(home.join("dev"));
        candidates.push(home.join("src"));
    }

    let mut roots: Vec<String> = candidates
        .into_iter()
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().to_string())
        .collect();

    roots.dedup();
    roots.truncate(3);
    roots
}
