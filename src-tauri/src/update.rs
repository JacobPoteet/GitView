//! Whether a newer GitView has been released, asked through the `gh` CLI.
//!
//! The obvious answer was `tauri-plugin-updater`, and it was the wrong one for
//! this binary. That plugin carries an HTTP client and a TLS stack into a build
//! configured with `lto = true`, and it wants a minisign keypair whose private
//! half lives in an Actions secret from then on. The Decision Log already turned
//! down exactly that trade for the GitHub inbox: `gh` is on the machine, it is
//! already authenticated, and it already knows how to read a release.
//!
//! So this asks `gh release view` and compares two version strings. Nothing is
//! downloaded here. The installer is fetched by a command typed into the
//! terminal, like every other action in the app, which is also why there is no
//! signature to verify in process: what runs is an NSIS installer the user
//! watched arrive, from a release whose tag is on screen.

use serde::{Deserialize, Serialize};

use crate::github;

/// Where releases come from.
///
/// Hard-coded because an installed GitView has no checkout to read a remote out
/// of, and pointing the check at a repository it happens to be scanning would
/// offer somebody else's release as an upgrade to this app.
const REPO: &str = "JacobPoteet/GitView";

/// The version this binary was built as, which is the one `release.yml` makes
/// the tag agree with.
pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The latest release, flattened out of `gh release view`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// `owner/repo`, so the command the frontend types names the same place
    /// this was read from rather than keeping a second copy of the constant.
    pub repo: String,
    /// `v0.2.0`, as `gh release download` wants it.
    pub tag: String,
    /// `0.2.0`, as a version rather than a tag.
    pub version: String,
    pub name: String,
    pub url: String,
    pub published_at: String,
    /// The release body, CRLF normalised and capped. The page is one click away.
    pub notes: String,
    /// The Windows installer on that release, when the build has uploaded it. A
    /// tag whose release workflow is still running has a release and no asset.
    pub asset_name: Option<String>,
    pub asset_size: Option<u64>,
}

/// What the check found.
///
/// An error never becomes a dialog. The status bar says nothing, the same as a
/// check that found nothing newer, because a laptop off the network is not an
/// event worth interrupting anyone over.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: String,
    pub latest: Option<Release>,
    pub available: bool,
    pub checked_at: i64,
    pub error: Option<String>,
}

// --------------------------------------------------------------- the response

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseView {
    tag_name: String,
    #[serde(default)]
    name: String,
    url: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    is_prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    #[serde(default)]
    size: u64,
}

/// Auto-generated notes run to a few hundred characters. The cap is for a
/// hand-written release that runs to a manual, which would scroll forever in a
/// dialog and cross IPC for no reason.
const NOTES_CAP: usize = 4000;

// ----------------------------------------------------------------- comparison

/// Whether `candidate` is a version worth offering to somebody on `current`.
///
/// Numeric, component by component, because 0.10.0 sorts below 0.9.0 as a
/// string and that is a comparison an app gets to make wrong exactly once.
/// Semver's prerelease rule holds too: 1.0.0 beats 1.0.0-rc.1, so a release
/// never loses to the candidate it came from.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (theirs, their_pre) = parts(candidate);
    let (ours, our_pre) = parts(current);
    // Two components at minimum, which is what rules out a tag that is not a
    // version at all. `v2026-09-09` reads as major 2026 with a prerelease of
    // `09-09` otherwise, and beats every version this project will ever ship.
    if theirs.len() < 2 || ours.len() < 2 {
        return false;
    }

    let width = theirs.len().max(ours.len());
    for index in 0..width {
        let a = theirs.get(index).copied().unwrap_or(0);
        let b = ours.get(index).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }

    // Equal numbers. A release outranks a prerelease of itself; between two
    // prereleases the tail decides, which is close enough to semver for the
    // tags this project produces and is only ever consulted on a dead heat.
    match (their_pre.is_empty(), our_pre.is_empty()) {
        (true, false) => true,
        (false, false) => their_pre > our_pre,
        _ => false,
    }
}

/// `v1.2.3-rc.1+build` into `([1, 2, 3], "rc.1")`.
fn parts(raw: &str) -> (Vec<u64>, String) {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    // Build metadata is explicitly not part of precedence.
    let trimmed = trimmed.split('+').next().unwrap_or("");
    let (numbers, pre) = match trimmed.split_once('-') {
        Some((head, tail)) => (head, tail.to_string()),
        None => (trimmed, String::new()),
    };

    let mut out = Vec::new();
    for component in numbers.split('.') {
        match component.parse::<u64>() {
            Ok(value) => out.push(value),
            // A component that is not a number makes the rest meaningless, and
            // an unreadable version loses every comparison rather than winning
            // one by accident.
            Err(_) => return (Vec::new(), pre),
        }
    }
    (out, pre)
}

/// The asset a Windows machine can actually run.
///
/// `release.yml` uploads one `*-setup.exe` and nothing else, so the fallback is
/// for a release somebody assembled by hand.
fn installer(assets: &[Asset]) -> Option<&Asset> {
    assets
        .iter()
        .find(|asset| asset.name.to_lowercase().ends_with("-setup.exe"))
        .or_else(|| {
            assets
                .iter()
                .find(|asset| asset.name.to_lowercase().ends_with(".exe"))
        })
}

// ------------------------------------------------------------------- the call

/// Reads the latest release and says whether it is newer than this build.
///
/// One `gh` call, out of sight, for the same reason the inbox sweep is: there
/// is no repository this question belongs to, and so no prompt to type it at.
pub fn check(now: i64) -> UpdateCheck {
    let current = current().to_string();
    let raw = match github::gh(
        &[
            "release",
            "view",
            "--repo",
            REPO,
            "--json",
            "tagName,name,url,publishedAt,body,isDraft,isPrerelease,assets",
        ],
        None,
    ) {
        Ok(raw) => raw,
        Err(error) => {
            return UpdateCheck {
                current,
                latest: None,
                available: false,
                checked_at: now,
                error: Some(error),
            }
        }
    };

    let view: ReleaseView = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            return UpdateCheck {
                current,
                latest: None,
                available: false,
                checked_at: now,
                error: Some(format!("could not read gh's response: {err}")),
            }
        }
    };

    // gh already asks for the latest published release, so these two only fire
    // on a release made by hand. Offering a draft would point the download at
    // an asset nobody outside the repository can fetch.
    if view.is_draft || view.is_prerelease {
        return UpdateCheck {
            current,
            latest: None,
            available: false,
            checked_at: now,
            error: None,
        };
    }

    let version = view
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    let available = is_newer(&view.tag_name, &current);
    let asset = installer(&view.assets);

    UpdateCheck {
        available,
        latest: Some(Release {
            repo: REPO.to_string(),
            name: if view.name.trim().is_empty() {
                view.tag_name.clone()
            } else {
                view.name.clone()
            },
            tag: view.tag_name,
            version,
            url: view.url,
            published_at: view.published_at,
            notes: trim_notes(&view.body),
            asset_name: asset.map(|a| a.name.clone()),
            asset_size: asset.map(|a| a.size),
        }),
        current,
        checked_at: now,
        error: None,
    }
}

fn trim_notes(body: &str) -> String {
    let normalised = body.replace("\r\n", "\n");
    let trimmed = normalised.trim();
    if trimmed.chars().count() <= NOTES_CAP {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(NOTES_CAP).collect();
    out.push_str("\n…");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_release_is_newer() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(is_newer("0.1.1", "0.1.0"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
    }

    #[test]
    fn an_older_release_is_never_offered() {
        assert!(!is_newer("v0.1.0", "0.2.0"));
        // The downgrade a string comparison would call an upgrade.
        assert!(!is_newer("v0.9.0", "0.10.0"));
    }

    /// The comparison this function exists for.
    #[test]
    fn ten_beats_nine() {
        assert!(is_newer("v0.10.0", "0.9.0"));
        assert!(is_newer("v0.2.10", "0.2.9"));
    }

    #[test]
    fn a_missing_component_reads_as_zero() {
        assert!(is_newer("v0.2", "0.1.9"));
        assert!(!is_newer("v0.1", "0.1.0"));
        assert!(is_newer("v0.1.1", "0.1"));
    }

    #[test]
    fn a_release_outranks_its_own_prerelease() {
        assert!(is_newer("v1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("v1.0.0-rc.1", "1.0.0"));
        assert!(is_newer("v1.0.0-rc.2", "1.0.0-rc.1"));
    }

    #[test]
    fn an_unreadable_tag_wins_nothing() {
        assert!(!is_newer("nightly", "0.1.0"));
        assert!(!is_newer("", "0.1.0"));
        // A date tag splits into major 2026 with a prerelease of `09-09`, which
        // is why a candidate has to carry a minor number to count at all.
        assert!(!is_newer("v2026-09-09", "0.1.0"));
        assert!(!is_newer("v3", "0.1.0"));
    }

    #[test]
    fn the_installer_is_picked_out_of_the_assets() {
        let view: ReleaseView = serde_json::from_str(
            r#"{
              "tagName": "v0.2.0", "name": "v0.2.0",
              "url": "https://github.com/JacobPoteet/GitView/releases/tag/v0.2.0",
              "publishedAt": "2026-09-09T21:13:15Z", "body": "notes\r\nhere",
              "isDraft": false, "isPrerelease": false,
              "assets": [
                {"name": "sha256.txt", "size": 64},
                {"name": "GitView_0.2.0_x64-setup.exe", "size": 2280136}
              ]
            }"#,
        )
        .unwrap();
        let asset = installer(&view.assets).unwrap();
        assert_eq!(asset.name, "GitView_0.2.0_x64-setup.exe");
        assert_eq!(asset.size, 2280136);
        assert_eq!(trim_notes(&view.body), "notes\nhere");
    }

    /// The window between pushing a tag and the release workflow finishing.
    #[test]
    fn a_release_with_no_installer_yet_still_parses() {
        let view: ReleaseView =
            serde_json::from_str(r#"{"tagName": "v0.2.0", "url": "u", "assets": []}"#).unwrap();
        assert!(installer(&view.assets).is_none());
        assert!(view.name.is_empty());
        assert!(!view.is_draft);
    }

    #[test]
    fn long_notes_are_capped_rather_than_sent_whole() {
        let long = "x".repeat(NOTES_CAP + 500);
        let trimmed = trim_notes(&long);
        assert_eq!(trimmed.chars().count(), NOTES_CAP + 2);
        assert!(trimmed.ends_with('…'));
    }

    /// The version the binary reports has to be the one the tag is checked
    /// against, or `release.yml`'s three-way match guards nothing.
    #[test]
    fn the_current_version_comes_from_the_crate() {
        assert_eq!(current(), env!("CARGO_PKG_VERSION"));
        assert!(!is_newer(&format!("v{}", current()), current()));
    }
}
