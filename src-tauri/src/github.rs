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
    /// Each check behind that rollup, so a red one names the job. Every field
    /// from here to `delete_branch_on_merge` defaults, because the cached blob
    /// on an installed machine was written before they existed.
    #[serde(default)]
    pub check_runs: Vec<CheckRun>,
    /// PRs only. The branch it merges into.
    #[serde(default)]
    pub base_ref: Option<String>,
    /// `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while GitHub is still working
    /// it out in the background.
    #[serde(default)]
    pub mergeable: Option<String>,
    /// `CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, `HAS_HOOKS`, `DRAFT`
    /// or `UNKNOWN`: whether the Merge button on GitHub would be green.
    #[serde(default)]
    pub merge_state: Option<String>,
    #[serde(default)]
    pub additions: i64,
    #[serde(default)]
    pub deletions: i64,
    #[serde(default)]
    pub changed_files: i64,
    /// `squash`, `merge`, `rebase`: the ones the repository allows, in that
    /// order. Denormalised onto the row the way `repo_name` is.
    #[serde(default)]
    pub merge_methods: Vec<String>,
    /// GitHub deletes the head branch itself after a merge, so
    /// `--delete-branch` would only be repeating it.
    #[serde(default)]
    pub delete_branch_on_merge: bool,
    /// Opened by the person holding the token.
    pub mine: bool,
    /// A review is requested of them.
    pub review_requested: bool,
    /// An issue assigned to them.
    pub assigned: bool,
}

/// One check on a pull request's head commit, whether it came from Actions as
/// a `CheckRun` or from an older integration as a `StatusContext`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub name: String,
    /// `SUCCESS`, `FAILURE`, `PENDING`, `SKIPPED` or `CANCELLED`. GitHub has
    /// a dozen conclusions and the pane has three colours, so the folding
    /// happens here rather than in every component that draws one.
    pub state: String,
    pub url: Option<String>,
    /// The Actions run the check belongs to, which is what `gh run rerun`
    /// takes. None for a status context, which has no run to re-run.
    pub run_id: Option<i64>,
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
    #[serde(default)]
    squash_merge_allowed: bool,
    #[serde(default)]
    merge_commit_allowed: bool,
    #[serde(default)]
    rebase_merge_allowed: bool,
    #[serde(default)]
    delete_branch_on_merge: bool,
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
    #[serde(default)]
    base_ref_name: Option<String>,
    review_decision: Option<String>,
    mergeable: Option<String>,
    merge_state_status: Option<String>,
    #[serde(default)]
    additions: i64,
    #[serde(default)]
    deletions: i64,
    #[serde(default)]
    changed_files: i64,
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
    #[serde(default)]
    contexts: Nodes<RollupNode>,
}

/// A rollup holds two kinds of node and GraphQL tells them apart by
/// `__typename`. Anything else GitHub adds later lands in `Other` rather than
/// failing the whole response.
#[derive(Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
enum RollupNode {
    CheckRun {
        name: String,
        conclusion: Option<String>,
        details_url: Option<String>,
        check_suite: Option<CheckSuite>,
    },
    StatusContext {
        context: String,
        state: String,
        target_url: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckSuite {
    workflow_run: Option<WorkflowRun>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowRun {
    database_id: Option<i64>,
}

impl RollupNode {
    fn flatten(&self) -> Option<CheckRun> {
        match self {
            RollupNode::CheckRun {
                name,
                conclusion,
                details_url,
                check_suite,
            } => Some(CheckRun {
                name: name.clone(),
                state: match conclusion.as_deref() {
                    None => "PENDING",
                    Some("SUCCESS") => "SUCCESS",
                    Some("NEUTRAL") | Some("SKIPPED") => "SKIPPED",
                    Some("CANCELLED") => "CANCELLED",
                    // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE,
                    // STALE: the job did not pass, and the URL says why.
                    Some(_) => "FAILURE",
                }
                .to_string(),
                url: details_url.clone(),
                run_id: check_suite
                    .as_ref()
                    .and_then(|s| s.workflow_run.as_ref())
                    .and_then(|r| r.database_id),
            }),
            RollupNode::StatusContext {
                context,
                state,
                target_url,
            } => Some(CheckRun {
                name: context.clone(),
                state: match state.as_str() {
                    "SUCCESS" => "SUCCESS",
                    "PENDING" | "EXPECTED" => "PENDING",
                    _ => "FAILURE",
                }
                .to_string(),
                url: target_url.clone(),
                run_id: None,
            }),
            RollupNode::Other => None,
        }
    }
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

/// Checks per pull request. This repository's CI is one job; a project with
/// a matrix has a handful. Past ten the rollup still says whether the rest
/// passed, and the browser has the list.
const CHECKS: usize = 10;

fn fragment() -> String {
    format!(
        r#"
fragment FleetBits on Repository {{
  squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed deleteBranchOnMerge
  pullRequests(states: OPEN, first: {PAGE}, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{
    nodes {{
      number title url isDraft updatedAt headRefName baseRefName reviewDecision
      mergeable mergeStateStatus additions deletions changedFiles
      author {{ login }}
      reviewRequests(first: 5) {{ nodes {{ requestedReviewer {{ ... on User {{ login }} }} }} }}
      commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{
        state
        contexts(first: {CHECKS}) {{ nodes {{
          __typename
          ... on CheckRun {{ name conclusion detailsUrl checkSuite {{ workflowRun {{ databaseId }} }} }}
          ... on StatusContext {{ context state targetUrl }}
        }} }}
      }} }} }} }}
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
    let mut merge_methods = Vec::new();
    if bits.squash_merge_allowed {
        merge_methods.push("squash".to_string());
    }
    if bits.merge_commit_allowed {
        merge_methods.push("merge".to_string());
    }
    if bits.rebase_merge_allowed {
        merge_methods.push("rebase".to_string());
    }

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
        let rollup = pr
            .commits
            .nodes
            .first()
            .and_then(|c| c.commit.as_ref())
            .and_then(|c| c.status_check_rollup.as_ref());
        let checks = rollup.map(|r| r.state.clone());
        let check_runs = rollup
            .map(|r| {
                r.contexts
                    .nodes
                    .iter()
                    .filter_map(RollupNode::flatten)
                    .collect()
            })
            .unwrap_or_default();

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
            check_runs,
            base_ref: pr.base_ref_name.clone(),
            mergeable: pr.mergeable.clone(),
            merge_state: pr.merge_state_status.clone(),
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
            merge_methods: merge_methods.clone(),
            delete_branch_on_merge: bits.delete_branch_on_merge,
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
            check_runs: Vec::new(),
            base_ref: None,
            mergeable: None,
            merge_state: None,
            additions: 0,
            deletions: 0,
            changed_files: 0,
            merge_methods: Vec::new(),
            delete_branch_on_merge: false,
            review_requested: false,
            assigned,
        });
    }
}

/// How long a written issue body is left on disk. The same day a hunk patch
/// gets, for the same reason: shift-click leaves the line unrun at a prompt.
const BODY_KEEP_SECS: u64 = 86_400;

/// Writes an issue body out and hands back the path `--body-file` wants.
///
/// A body has paragraphs in it and a newline typed at a prompt submits the
/// line, so the body is the one argument here nobody can type. `git apply
/// --cached` already settled the shape of that answer: the argument becomes a
/// file under GitView's own data folder, never inside the repository, and the
/// command stays a line somebody can read before it runs and run again after.
/// A single-line body needs none of this and gets quoted inline instead.
pub fn write_issue_body(owner_repo: &str, title: &str, body: &str) -> Result<String, String> {
    let dir = crate::cache::data_dir().join("issues");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    sweep(&dir);

    let stem: String = format!("{owner_repo}-{title}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(90)
        .collect();
    let path = dir.join(format!("{stem}.md"));

    // LF. This is markdown on its way to GitHub, which is where every other
    // issue on the repository was written.
    std::fs::write(&path, body.replace("\r\n", "\n")).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Drops the bodies nobody is going to submit any more. A failure here leaves a
/// file behind, which is a file; the write that follows is the point.
fn sweep(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|t| now.duration_since(t).map_err(std::io::Error::other))
            .map(|age| age.as_secs() > BODY_KEEP_SECS)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
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
        // No contexts asked for in this shape, and no merge methods on the
        // repository: both default rather than fail.
        assert!(pr.check_runs.is_empty());
        assert!(pr.merge_methods.is_empty());
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

    /// The shape gh returned for #31 on 10 Sep 2026, plus a status context
    /// and a still-running job beside it. Each kind of node folds to one of
    /// the pane's states, and the Actions run id comes through for `gh run
    /// rerun`.
    #[test]
    fn each_check_folds_to_a_state_and_keeps_its_run() {
        let bits: RepoBits = serde_json::from_str(
            r#"{
              "squashMergeAllowed": true, "mergeCommitAllowed": false,
              "rebaseMergeAllowed": true, "deleteBranchOnMerge": false,
              "pullRequests": {"nodes": [{
                "number": 31, "title": "T", "url": "u", "isDraft": false,
                "updatedAt": "2026-09-10T00:00:00Z", "headRefName": "ui-sweep",
                "baseRefName": "main", "reviewDecision": null,
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "additions": 1264, "deletions": 177, "changedFiles": 18,
                "author": {"login": "me"},
                "reviewRequests": {"nodes": []},
                "commits": {"nodes": [{"commit": {"statusCheckRollup": {
                  "state": "FAILURE",
                  "contexts": {"nodes": [
                    {"__typename": "CheckRun", "name": "build", "conclusion": "TIMED_OUT",
                     "detailsUrl": "https://github.com/o/r/actions/runs/34533227812/job/1",
                     "checkSuite": {"workflowRun": {"databaseId": 34533227812}}},
                    {"__typename": "CheckRun", "name": "lint", "conclusion": null,
                     "detailsUrl": null, "checkSuite": {"workflowRun": null}},
                    {"__typename": "StatusContext", "context": "ci/legacy", "state": "SUCCESS",
                     "targetUrl": "https://ci.example/1"},
                    {"__typename": "SomethingNew", "name": "x"}
                  ]}
                }}}]}
              }]},
              "issues": {"nodes": []}
            }"#,
        )
        .unwrap();
        let mut items = Vec::new();
        collect(&bits, "p", "n", "o/r", Some("me"), &mut items);
        let pr = &items[0];

        assert_eq!(pr.merge_methods, vec!["squash", "rebase"]);
        assert_eq!(pr.base_ref.as_deref(), Some("main"));
        assert_eq!(pr.mergeable.as_deref(), Some("MERGEABLE"));
        assert_eq!(pr.merge_state.as_deref(), Some("CLEAN"));
        assert_eq!(
            (pr.additions, pr.deletions, pr.changed_files),
            (1264, 177, 18)
        );

        assert_eq!(pr.check_runs.len(), 3, "the unknown typename drops out");
        assert_eq!(
            pr.check_runs[0],
            CheckRun {
                name: "build".into(),
                state: "FAILURE".into(),
                url: Some("https://github.com/o/r/actions/runs/34533227812/job/1".into()),
                run_id: Some(34533227812),
            }
        );
        assert_eq!(pr.check_runs[1].state, "PENDING");
        assert_eq!(pr.check_runs[1].run_id, None);
        assert_eq!(pr.check_runs[2].name, "ci/legacy");
        assert_eq!(pr.check_runs[2].state, "SUCCESS");
        assert_eq!(pr.check_runs[2].run_id, None);
    }

    /// The blob `github_inbox` holds on an installed machine predates every
    /// field the desk added. It has to read back as it did, not as an error
    /// that empties the pane.
    #[test]
    fn a_cached_item_from_before_the_desk_still_reads() {
        let old = r#"{
          "kind": "pr", "repoPath": "p", "repoName": "n", "ownerRepo": "o/r",
          "number": 1, "title": "T", "url": "u", "updatedAt": "2026-09-10T00:00:00Z",
          "author": "me", "draft": false, "headRef": "b", "reviewDecision": null,
          "checks": "SUCCESS", "mine": true, "reviewRequested": false, "assigned": false
        }"#;
        let item: InboxItem = serde_json::from_str(old).unwrap();
        assert!(item.check_runs.is_empty());
        assert!(item.mergeable.is_none());
        assert_eq!(item.additions, 0);
        assert!(!item.delete_branch_on_merge);
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
