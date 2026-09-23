//! Scan roots.
//!
//! A list rather than one path, because projects rarely all live under the same
//! parent. Nothing is watched until someone says so: the folders people keep
//! checkouts in are offered as suggestions on the welcome screen, never written
//! behind their back. An empty list stays empty, so removing every folder
//! brings the welcome screen back rather than a re-detected guess.

use std::path::PathBuf;

use serde::Serialize;

use crate::cache::Cache;
use crate::fleet;

const KEY: &str = "scan_roots";

pub fn roots(cache: &Cache) -> Vec<String> {
    cache
        .get_setting(KEY)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

pub fn set_roots(cache: &Cache, roots: &[String]) -> anyhow::Result<()> {
    cache.set_setting(KEY, &serde_json::to_string(roots)?)?;
    Ok(())
}

/// A folder the welcome screen offers to watch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub path: String,
    /// What a scan of it would find, so the offer says what it is worth.
    pub repos: usize,
}

/// The places people keep a folder full of checkouts that exist and hold at
/// least one repository, minus the ones already watched. Ordered so a
/// dedicated drive comes before a home directory.
pub fn suggest(watched: &[String]) -> Vec<Suggestion> {
    suggest_from(candidates(), watched)
}

fn suggest_from(candidates: Vec<PathBuf>, watched: &[String]) -> Vec<Suggestion> {
    let mut out: Vec<Suggestion> = Vec::new();
    for path in candidates {
        if !path.is_dir() {
            continue;
        }
        let path = path.to_string_lossy().to_string();
        if watched.iter().any(|w| w.eq_ignore_ascii_case(&path))
            || out.iter().any(|s| s.path.eq_ignore_ascii_case(&path))
        {
            continue;
        }
        let repos = fleet::discover(std::slice::from_ref(&path)).len();
        if repos > 0 {
            out.push(Suggestion { path, repos });
        }
    }
    out.truncate(5);
    out
}

fn candidates() -> Vec<PathBuf> {
    // A dev build can be told where to look, so a first run can be rehearsed on
    // a machine whose F:\GitHub would otherwise always be found. `;` separates
    // paths, and an empty value means nothing is found. Debug builds only, like
    // `GITVIEW_DATA_DIR`.
    if cfg!(debug_assertions) {
        if let Some(raw) = std::env::var_os("GITVIEW_DETECT_ROOTS") {
            return raw
                .to_string_lossy()
                .split(';')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .collect();
        }
    }

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
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_watched_until_someone_says_so() {
        let cache = Cache::in_memory().unwrap();
        assert!(roots(&cache).is_empty());
        // Reading must not write a guess back.
        assert!(cache.get_setting(KEY).is_none());
    }

    #[test]
    fn an_emptied_list_stays_empty() {
        let cache = Cache::in_memory().unwrap();
        set_roots(&cache, &["F:\\Work".to_string()]).unwrap();
        set_roots(&cache, &[]).unwrap();
        assert!(roots(&cache).is_empty());
    }

    #[test]
    fn a_suggestion_holds_a_repository_and_is_not_already_watched() {
        let base = std::env::temp_dir().join(format!("gitview-suggest-{}", std::process::id()));
        let full = base.join("full");
        let bare = base.join("bare");
        let watched = base.join("watched");
        for dir in [&full, &bare, &watched] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::create_dir_all(full.join("one").join(".git")).unwrap();
        std::fs::create_dir_all(full.join("two").join(".git")).unwrap();
        std::fs::create_dir_all(watched.join("three").join(".git")).unwrap();

        let found = suggest_from(
            vec![
                full.clone(),
                bare,
                watched.clone(),
                base.join("missing"),
                full.clone(),
            ],
            &[watched.to_string_lossy().to_uppercase()],
        );
        let _ = std::fs::remove_dir_all(&base);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, full.to_string_lossy());
        assert_eq!(found[0].repos, 2);
    }
}
