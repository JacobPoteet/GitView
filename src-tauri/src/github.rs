//! GitHub reads, through the `gh` CLI.
//!
//! The same argument that sends fetch and push to `git.exe`. `gh` already holds
//! the user's GitHub credentials, in the keyring or the credential manager,
//! already has the scopes, and revoking it revokes this too. GitView never
//! sources, stores or redacts a token because it never sees one.
//!
//! The alternative was an HTTP client in this process plus a token read out of
//! the Windows Credential Manager. That puts a secret in GitView's memory and a
//! TLS stack in a binary built with `lto = true`, to reimplement authentication
//! that is already working on the machine. See the Credentials note in the wiki.
//!
//! Writes do not come through here. `gh pr merge` and `gh run rerun` get typed
//! into the shell like every other action, so the rule that every action names
//! its command survives contact with GitHub.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Whether the inbox can work at all, and why not when it cannot.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    /// `gh version 2.100.0`, or None when it is not on PATH.
    pub version: Option<String>,
    pub logged_in: bool,
}

/// One pull request or issue, flattened out of the GraphQL response.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// `pr` or `issue`.
    pub kind: String,
    /// The local folder this belongs to, so clicking a row can select it.
    pub repo_path: String,
    pub repo_name: String,
    pub owner_repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub updated_at: String,
    pub author: String,
    pub draft: bool,
    /// PRs only. The branch, so the header can match it against HEAD.
    pub head_ref: Option<String>,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or none asked for.
    pub review_decision: Option<String>,
    /// The check rollup on the head commit: `SUCCESS`, `FAILURE`, `PENDING`.
    pub checks: Option<String>,
    /// Opened by the person holding the token.
    pub mine: bool,
    /// A review is requested of them.
    pub review_requested: bool,
    /// An issue assigned to them.
    pub assigned: bool,
}

/// Everything the inbox draws, cached as one blob.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inbox {
    pub viewer: Option<String>,
    pub items: Vec<InboxItem>,
    pub fetched_at: i64,
    /// Repositories the query could not resolve: renamed, private, or gone.
    /// They drop out rather than failing the sweep.
    pub unresolved: Vec<String>,
    /// Set when nothing came back at all.
    pub error: Option<String>,
}

// --------------------------------------------------------------- the response

#[derive(Deserialize)]
struct Envelope {
    data: Option<Data>,
    #[serde(default)]
    errors: Vec<GqlError>,
}

/// Only the message is read. Which repository failed is decided from the null
/// alias beside it, which also covers an alias the query never built.
#[derive(Deserialize)]
struct GqlError {
    message: String,
}

#[derive(Deserialize)]
struct Data {
    viewer: Option<Login>,
    #[serde(flatten)]
    repos: std::collections::HashMap<String, Option<RepoBits>>,
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoBits {
    pull_requests: Nodes<PrNode>,
    issues: Nodes<IssueNode>,
}

#[derive(Deserialize)]
struct Nodes<T> {
    #[serde(default = "Vec::new")]
    nodes: Vec<T>,
}

impl<T> Default for Nodes<T> {
    fn default() -> Self {
        Self { nodes: Vec::new() }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrNode {
    number: i64,
    title: String,
    url: String,
    is_draft: bool,
    updated_at: String,
    head_ref_name: String,
    review_decision: Option<String>,
    author: Option<Login>,
    #[serde(default)]
    review_requests: Nodes<ReviewRequest>,
    #[serde(default)]
    commits: Nodes<CommitNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRequest {
    requested_reviewer: Option<Login>,
}

#[derive(Deserialize)]
struct CommitNode {
    commit: Option<CommitRollup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitRollup {
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueNode {
    number: i64,
    title: String,
    url: String,
    updated_at: String,
    author: Option<Login>,
    #[serde(default)]
    assignees: Nodes<Login>,
}

// ------------------------------------------------------------------ the query

/// How much of each repository to ask for.
///
/// Twenty open pull requests and twenty open issues per repository is past the
/// point where a list is worth reading, and the node count is what GraphQL
/// charges for. Two repositories measured 50 nodes at cost 1 against a 5000
/// point hourly budget.
const PAGE: usize = 20;

fn fragment() -> String {
    format!(
        r#"
fragment FleetBits on Repository {{
  pullRequests(states: OPEN, first: {PAGE}, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{
    nodes {{
      number title url isDraft updatedAt headRefName reviewDecision
      author {{ login }}
      reviewRequests(first: 5) {{ nodes {{ requestedReviewer {{ ... on User {{ login }} }} }} }}
      commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ state }} }} }} }}
    }}
  }}
  issues(states: OPEN, first: {PAGE}, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{
    nodes {{
      number title url updatedAt
      author {{ login }}
      assignees(first: 5) {{ nodes {{ login }} }}
    }}
  }}
}}"#
    )
}

/// One request for the whole fleet, one alias per repository.
///
/// REST would need a call per repository per resource, which is roughly sixty
/// calls to fill this list and reaches the rate limit during an ordinary
/// morning. GraphQL charges by node count instead.
pub fn build_query(targets: &[(String, String, String)]) -> String {
    let mut out = String::from("query {\n  viewer { login }\n");
    for (index, (_, _, owner_repo)) in targets.iter().enumerate() {
        let Some((owner, name)) = owner_repo.split_once('/') else {
            continue;
        };
        out.push_str(&format!(
            "  r{index}: repository(owner: {}, name: {}) {{ ...FleetBits }}\n",
            quote(owner),
            quote(name)
        ));
    }
    out.push_str("}\n");
    out.push_str(&fragment());
    out
}

/// A GraphQL string literal.
///
/// Repository names come from an origin URL, so they are the one part of this
/// query that is not written here.
fn quote(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for ch in raw.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

// ------------------------------------------------------------------- the calls

/// One `gh` invocation, with the environment a windowless process needs.
///
/// `update` borrows this rather than growing a second copy of the prompt
/// disabling and the `CREATE_NO_WINDOW` flag, both of which are the difference
/// between a failed call and a console flashing up on somebody's desktop.
pub(crate) fn gh(args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    cmd.args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A GUI has no console, so anything that wants to prompt has to fail
        // instead of blocking on a read nobody can answer.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("CLICOLOR", "0");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("could not start gh: {err}"))?;

    if let Some(body) = stdin {
        let Some(pipe) = child.stdin.as_mut() else {
            return Err("gh took no stdin".to_string());
        };
        pipe.write_all(body.as_bytes())
            .map_err(|err| format!("could not write the query to gh: {err}"))?;
    }
    // Dropping the handle closes the pipe, which is what lets gh finish reading.
    drop(child.stdin.take());

    let out = child
        .wait_with_output()
        .map_err(|err| format!("gh did not finish: {err}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();

    // gh exits non-zero when any alias in the query failed, and prints the
    // whole usable response to stdout anyway. Reading the exit code first would
    // turn one renamed repository into a fleet-wide failure, so stdout wins and
    // the code is only consulted when there is nothing to parse.
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("gh exited {}", out.status.code().unwrap_or(-1))
        } else {
            stderr
        });
    }
    Ok(stdout)
}

pub fn status() -> GhStatus {
    let version = gh(&["--version"], None)
        .ok()
        .and_then(|out| out.lines().next().map(|line| line.trim().to_string()))
        .filter(|line| !line.is_empty());

    // `auth status` exits non-zero when nobody is logged in, and that is the
    // one place its exit code is the answer rather than a side effect.
    let logged_in = version.is_some()
        && Command::new("gh")
            .args(["auth", "status"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

    GhStatus { version, logged_in }
}

/// Reads the fleet's pull requests and issues in one request.
///
/// `targets` is `(path, name, owner/repo)` for every repository that has a
/// GitHub remote. A repository the token cannot resolve comes back as a null
/// alias and lands in `unresolved` rather than failing the sweep.
pub fn fetch(targets: &[(String, String, String)], now: i64) -> Inbox {
    if targets.is_empty() {
        return Inbox {
            fetched_at: now,
            ..Default::default()
        };
    }

    let query = build_query(targets);
    let raw = match gh(&["api", "graphql", "-F", "query=@-"], Some(&query)) {
        Ok(raw) => raw,
        Err(error) => {
            return Inbox {
                fetched_at: now,
                error: Some(error),
                ..Default::default()
            }
        }
    };

    let envelope: Envelope = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Inbox {
                fetched_at: now,
                error: Some(format!("could not read gh's response: {err}")),
                ..Default::default()
            }
        }
    };

    let Some(data) = envelope.data else {
        let first = envelope
            .errors
            .first()
            .map(|e| e.message.clone())
            .unwrap_or_else(|| "gh returned no data".to_string());
        return Inbox {
            fetched_at: now,
            error: Some(first),
            ..Default::default()
        };
    };

    let viewer = data.viewer.map(|v| v.login);
    let mut items = Vec::new();
    let mut unresolved = Vec::new();

    for (index, (path, name, owner_repo)) in targets.iter().enumerate() {
        let alias = format!("r{index}");
        match data.repos.get(&alias) {
            Some(Some(bits)) => {
                collect(bits, path, name, owner_repo, viewer.as_deref(), &mut items)
            }
            // Present and null, or absent because the alias was never built.
            _ => unresolved.push(owner_repo.clone()),
        }
    }

    // Newest first, which is the order a list of things wanting a reply reads in.
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Inbox {
        viewer,
        items,
        fetched_at: now,
        unresolved,
        error: None,
    }
}

fn collect(
    bits: &RepoBits,
    path: &str,
    name: &str,
    owner_repo: &str,
    viewer: Option<&str>,
    out: &mut Vec<InboxItem>,
) {
    for pr in &bits.pull_requests.nodes {
        let author = pr
            .author
            .as_ref()
            .map(|a| a.login.clone())
            .unwrap_or_default();
        let review_requested = viewer.is_some_and(|me| {
            pr.review_requests
                .nodes
                .iter()
                .filter_map(|r| r.requested_reviewer.as_ref())
                .any(|r| r.login == me)
        });
        let checks = pr
            .commits
            .nodes
            .first()
            .and_then(|c| c.commit.as_ref())
            .and_then(|c| c.status_check_rollup.as_ref())
            .map(|r| r.state.clone());

        out.push(InboxItem {
            kind: "pr".to_string(),
            repo_path: path.to_string(),
            repo_name: name.to_string(),
            owner_repo: owner_repo.to_string(),
            number: pr.number,
            title: pr.title.clone(),
            url: pr.url.clone(),
            updated_at: pr.updated_at.clone(),
            mine: viewer.is_some_and(|me| me == author),
            author,
            draft: pr.is_draft,
            head_ref: Some(pr.head_ref_name.clone()),
            review_decision: pr.review_decision.clone(),
            checks,
            review_requested,
            assigned: false,
        });
    }

    for issue in &bits.issues.nodes {
        let author = issue
            .author
            .as_ref()
            .map(|a| a.login.clone())
            .unwrap_or_default();
        let assigned = viewer.is_some_and(|me| {
            issue
                .assignees
                .nodes
                .iter()
                .any(|assignee| assignee.login == me)
        });

        out.push(InboxItem {
            kind: "issue".to_string(),
            repo_path: path.to_string(),
            repo_name: name.to_string(),
            owner_repo: owner_repo.to_string(),
            number: issue.number,
            title: issue.title.clone(),
            url: issue.url.clone(),
            updated_at: issue.updated_at.clone(),
            mine: viewer.is_some_and(|me| me == author),
            author,
            draft: false,
            head_ref: None,
            review_decision: None,
            checks: None,
            review_requested: false,
            assigned,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets() -> Vec<(String, String, String)> {
        vec![
            (
                r"F:\GitHub\GitView".into(),
                "GitView".into(),
                "JacobPoteet/GitView".into(),
            ),
            (
                r"F:\GitHub\LunchSpecial".into(),
                "LunchSpecial".into(),
                "JacobPoteet/LunchSpecial".into(),
            ),
        ]
    }

    #[test]
    fn one_alias_per_repository() {
        let query = build_query(&targets());
        assert!(query.contains(r#"r0: repository(owner: "JacobPoteet", name: "GitView")"#));
        assert!(query.contains(r#"r1: repository(owner: "JacobPoteet", name: "LunchSpecial")"#));
        // One request, so the fragment is defined once and the viewer asked for
        // once however many repositories are in the fleet.
        assert_eq!(query.matches("fragment FleetBits").count(), 1);
        assert_eq!(query.matches("viewer { login }").count(), 1);
    }

    #[test]
    fn a_repository_name_cannot_escape_its_string() {
        let hostile = vec![(
            "p".into(),
            "n".into(),
            r#"owner/name") { x } evil: repository(owner: "a"#.into(),
        )];
        let query = build_query(&hostile);
        // The quote is escaped, so the injected braces stay inside the literal.
        assert!(query.contains(r#"name: "name\") { x } evil: repository(owner: \"a""#));
        assert!(!query.contains("evil: repository(owner: \"a\")"));
    }

    #[test]
    fn an_owner_repo_with_no_slash_is_skipped() {
        let query = build_query(&[("p".into(), "n".into(), "no-slash-here".into())]);
        assert!(!query.contains("r0:"));
    }

    /// The shape gh returns when one alias in the query failed: complete data
    /// for the rest, a null for that one, and an `errors` array beside it.
    #[test]
    fn a_null_alias_drops_out_instead_of_failing_the_sweep() {
        let raw = r#"{
          "data": {
            "viewer": {"login": "JacobPoteet"},
            "r0": {
              "pullRequests": {"nodes": [{
                "number": 16, "title": "Fleet-wide sync", "url": "https://x/16",
                "isDraft": false, "updatedAt": "2026-09-10T02:00:00Z",
                "headRefName": "batch", "reviewDecision": null,
                "author": {"login": "JacobPoteet"},
                "reviewRequests": {"nodes": []},
                "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]}
              }]},
              "issues": {"nodes": []}
            },
            "r1": null
          },
          "errors": [{"type": "NOT_FOUND", "path": ["r1"], "message": "Could not resolve"}]
        }"#;
        let envelope: Envelope = serde_json::from_str(raw).unwrap();
        let data = envelope.data.unwrap();
        assert!(data.repos.get("r1").unwrap().is_none());
        assert!(data.repos.get("r0").unwrap().is_some());
        assert_eq!(envelope.errors.len(), 1);
        assert!(envelope.errors[0].message.contains("Could not resolve"));
    }

    #[test]
    fn a_pull_request_carries_its_checks_and_who_it_wants() {
        let bits: RepoBits = serde_json::from_str(
            r#"{
              "pullRequests": {"nodes": [{
                "number": 7, "title": "T", "url": "u", "isDraft": true,
                "updatedAt": "2026-09-09T00:00:00Z", "headRefName": "feature",
                "reviewDecision": "CHANGES_REQUESTED",
                "author": {"login": "someone"},
                "reviewRequests": {"nodes": [{"requestedReviewer": {"login": "me"}}]},
                "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE"}}}]}
              }]},
              "issues": {"nodes": [{
                "number": 12, "title": "I", "url": "u2",
                "updatedAt": "2026-09-08T00:00:00Z",
                "author": {"login": "me"},
                "assignees": {"nodes": [{"login": "me"}]}
              }]}
            }"#,
        )
        .unwrap();

        let mut items = Vec::new();
        collect(&bits, "p", "n", "o/r", Some("me"), &mut items);
        assert_eq!(items.len(), 2);

        let pr = &items[0];
        assert_eq!(pr.kind, "pr");
        assert_eq!(pr.checks.as_deref(), Some("FAILURE"));
        assert_eq!(pr.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert!(pr.review_requested);
        assert!(!pr.mine);
        assert!(pr.draft);
        assert_eq!(pr.head_ref.as_deref(), Some("feature"));

        let issue = &items[1];
        assert_eq!(issue.kind, "issue");
        assert!(issue.assigned);
        assert!(issue.mine);
        assert!(issue.checks.is_none());
    }

    /// A pull request with no checks configured, no reviewer asked, and a
    /// deleted author account. Every one of those is null in the response.
    #[test]
    fn missing_pieces_do_not_panic() {
        let bits: RepoBits = serde_json::from_str(
            r#"{
              "pullRequests": {"nodes": [{
                "number": 1, "title": "T", "url": "u", "isDraft": false,
                "updatedAt": "2026-09-09T00:00:00Z", "headRefName": "main",
                "reviewDecision": null, "author": null,
                "reviewRequests": {"nodes": [{"requestedReviewer": null}]},
                "commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]}
              }]},
              "issues": {"nodes": []}
            }"#,
        )
        .unwrap();
        let mut items = Vec::new();
        collect(&bits, "p", "n", "o/r", Some("me"), &mut items);
        assert_eq!(items.len(), 1);
        assert!(items[0].checks.is_none());
        assert_eq!(items[0].author, "");
        assert!(!items[0].review_requested);
    }
}
