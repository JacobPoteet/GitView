//! GitView's Rust core.
//!
//! The frontend only ever talks to the commands declared here. Anything that
//! reads a repository goes through `fleet`, anything that reaches a remote goes
//! through `gitops`, and the terminal lives in `pty`.

pub mod blame;
pub mod cache;
pub mod diff;
pub mod fleet;
pub mod github;
pub mod gitops;
pub mod graph;
pub mod history;
pub mod pty;
pub mod scratch;
pub mod scrollback;
pub mod settings;
pub mod signing;
pub mod squash;
pub mod tasks;
pub mod update;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use cache::{Adoption, Cache, RepoPref};
use diff::{CommitDiff, FileDiff};
use fleet::{FileChange, RepoState};
use github::{GhProbe, GhStatus, Inbox, IssueDetail};
use gitops::GitOutcome;
use graph::BranchGraph;
use history::History;
use pty::PtyManager;
use squash::Squashed;
use tasks::Task;
use update::UpdateCheck;

pub struct AppState {
    cache: Arc<Cache>,
    pty: Arc<PtyManager>,
}

/// What one sweep did.
///
/// The count was the whole return value until preferences learned to follow a
/// renamed folder. Moving someone's pins is not something to do quietly, so the
/// moves come back with the count and the status bar says what happened.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned: usize,
    pub adopted: Vec<Adoption>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    git_version: Option<String>,
    shell: String,
    /// Whether this shell gets OSC 133 marks, which is what makes command
    /// blocks possible. A shell without them is not broken, it just has none.
    shell_integration: bool,
    /// Whether `gh` is on PATH and logged in, which is what the inbox needs.
    /// Reported rather than assumed, the same way shell integration is.
    gh: GhStatus,
    data_dir: String,
    roots: Vec<String>,
}

// ---------------------------------------------------------------- fleet

/// Rows straight out of SQLite. Paints before any repository is opened, which is
/// what makes the window useful in the first frame.
#[tauri::command]
fn fleet_cached(state: State<'_, AppState>) -> Result<Vec<RepoState>, String> {
    state.cache.all_repos().map_err(|e| e.to_string())
}

/// Walks the scan roots and streams one row per repository as it is read, so a
/// slow project never holds up the fast ones.
#[tauri::command]
async fn fleet_scan(
    state: State<'_, AppState>,
    on_repo: Channel<RepoState>,
) -> Result<ScanReport, String> {
    let cache = state.cache.clone();
    let roots = settings::roots(&cache);

    tauri::async_runtime::spawn_blocking(move || {
        let paths = fleet::discover(&roots);
        let keep: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let _ = cache.retain_repos(&keep);

        let mut scanned = 0usize;
        let mut identity: Vec<(String, Option<String>)> = Vec::with_capacity(paths.len());
        for path in paths {
            let repo_state = fleet::read_repo(&path);
            let _ = cache.put_repo(&repo_state);
            identity.push((repo_state.path.clone(), repo_state.owner_repo.clone()));
            if on_repo.send(repo_state).is_err() {
                break;
            }
            scanned += 1;
        }

        // After the sweep, not before: a folder renamed since the last launch is
        // only recognisable once this pass has read what is at the new path.
        let adopted = cache.adopt_moved_repos(&identity).unwrap_or_default();
        ScanReport { scanned, adopted }
    })
    .await
    .map_err(|e| e.to_string())
}

/// The working tree of one repository, file by file.
///
/// Read on demand rather than during the sweep. Eleven repositories do not need
/// their file lists on the home screen, and the one that is open needs it fresh
/// every time the shell goes quiet.
#[tauri::command]
async fn repo_changes(path: String) -> Result<Vec<FileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || fleet::read_changes(&PathBuf::from(&path)))
        .await
        .map_err(|e| e.to_string())
}

/// One file's diff, on one side of the index.
///
/// Read on demand, per file, rather than for the whole working tree: the pane
/// shows one file at a time and sixteen changed files is an ordinary afternoon
/// here. The side is passed in because a file staged and then edited again has
/// two diffs, and the changes column already lists it twice for that reason.
#[tauri::command]
async fn repo_diff(path: String, file: String, staged: bool) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff::read_file(&PathBuf::from(&path), &file, staged)
    })
    .await
    .map_err(|e| e.to_string())
}

/// One commit: its text, its parents, and every file it touched with counts.
///
/// The pane reads the list first and the hunks per file, the same split the
/// working tree gets, so a forty-file merge costs one list and one file rather
/// than forty diffs nobody scrolled to.
#[tauri::command]
async fn repo_commit(path: String, sha: String) -> Result<CommitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || diff::read_commit(&PathBuf::from(&path), &sha))
        .await
        .map_err(|e| e.to_string())
}

/// One file out of a commit, against the commit's first parent.
#[tauri::command]
async fn repo_commit_file(path: String, sha: String, file: String) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff::read_commit_file(&PathBuf::from(&path), &sha, &file)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Who last touched each line of a file, as of a commit. See blame.rs.
#[tauri::command]
async fn repo_blame(path: String, sha: String, file: String) -> Result<blame::Blame, String> {
    tauri::async_runtime::spawn_blocking(move || {
        blame::read_blame(&PathBuf::from(&path), &sha, &file)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Writes one file as a commit had it, under GitView's data folder, and hands
/// back the path for the frontend to type `Invoke-Item` on. See `diff.rs`.
#[tauri::command]
async fn commit_file_export(path: String, sha: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff::export_commit_file(&PathBuf::from(&path), &sha, &file)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes one hunk out as a patch and hands back the path.
///
/// Staging a hunk is the only action here whose argument cannot be typed, since
/// the argument is the hunk. The patch file is that argument: it lands under
/// GitView's own data folder, never in the repository, and the frontend types
/// `git apply --cached` against it at the prompt like every other action. What
/// ran is on screen and the file it ran on is still there to read.
#[tauri::command]
async fn diff_hunk_patch(
    path: String,
    file: String,
    staged: bool,
    hunk_index: usize,
    header: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = diff::hunk_patch(&PathBuf::from(&path), &file, staged, hunk_index, &header)?;
        diff::write_patch(&path, &file, staged, hunk_index, &text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One repository, read fresh. The frontend calls this after the terminal goes
/// quiet, which is how a commit typed by hand reaches the sidebar.
#[tauri::command]
async fn repo_refresh(state: State<'_, AppState>, path: String) -> Result<RepoState, String> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repo_state = fleet::read_repo(&PathBuf::from(&path));
        let _ = cache.put_repo(&repo_state);
        repo_state
    })
    .await
    .map_err(|e| e.to_string())
}

/// The shape of one repository's current branch against the branch it merges
/// into. Small enough to read fresh every time HEAD moves, so nothing caches it.
#[tauri::command]
async fn repo_graph(path: String) -> Result<BranchGraph, String> {
    tauri::async_runtime::spawn_blocking(move || graph::read(&PathBuf::from(&path)))
        .await
        .map_err(|e| e.to_string())
}

/// The whole DAG, a page at a time.
///
/// Lanes are packed in the backend because the assignment depends on every
/// commit newer than the one being drawn, so a page starting in the middle
/// could not work them out from what it holds. The walk runs from the top each
/// time and only the window is turned into rows.
#[tauri::command]
async fn repo_history(
    path: String,
    offset: usize,
    limit: usize,
    filter: Option<history::Filter>,
) -> Result<History, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history::read(&PathBuf::from(&path), offset, limit, filter.as_ref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Local branches that were squash-merged, and the commit each one became.
///
/// Read for the open repository rather than in the sweep: it costs a patch id
/// per branch plus one per trunk commit since the fork, and the sweep is
/// measured in milliseconds across the whole fleet.
#[tauri::command]
async fn repo_squashed(path: String) -> Result<Vec<Squashed>, String> {
    tauri::async_runtime::spawn_blocking(move || squash::detect(&PathBuf::from(&path)))
        .await
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------------ preferences

/// Pins and hides, merged into the list by the frontend rather than folded into
/// `RepoState`, which the next scan overwrites.
#[tauri::command]
fn repo_prefs(state: State<'_, AppState>) -> Result<Vec<RepoPref>, String> {
    state.cache.repo_prefs().map_err(|e| e.to_string())
}

#[tauri::command]
fn repo_set_hidden(state: State<'_, AppState>, path: String, hidden: bool) -> Result<(), String> {
    state
        .cache
        .set_repo_hidden(&path, hidden)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn repo_set_pinned(state: State<'_, AppState>, path: String, pinned: bool) -> Result<(), String> {
    state
        .cache
        .set_repo_pinned(&path, pinned)
        .map_err(|e| e.to_string())
}

/// The pinned group's order, as the sidebar now has it.
///
/// The whole list is sent rather than the move that produced it, so the backend
/// never has to reconstruct what the user is looking at.
#[tauri::command]
fn repo_reorder_pins(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    state.cache.reorder_pins(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
fn task_set_hidden(
    state: State<'_, AppState>,
    repo_path: String,
    task_id: String,
    hidden: bool,
) -> Result<(), String> {
    state
        .cache
        .set_task_hidden(&repo_path, &task_id, hidden)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- tasks

#[tauri::command]
async fn repo_tasks(state: State<'_, AppState>, path: String) -> Result<Vec<Task>, String> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = tasks::discover(&PathBuf::from(&path));
        if let Ok(saved) = cache.saved_tasks(&path) {
            // Saved tasks lead, because a person chose those.
            let mut ordered = saved;
            ordered.append(&mut all);
            all = ordered;
        }
        // The list arrives whole and flagged. The pane decides where a hidden
        // task is drawn; the palette drops it entirely.
        if let Ok(hidden) = cache.hidden_tasks(&path) {
            for task in &mut all {
                task.hidden = hidden.iter().any(|id| id == &task.id);
            }
        }
        all
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn task_save(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    command: String,
) -> Result<Task, String> {
    state
        .cache
        .save_task(&repo_path, &name, &command)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn task_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.cache.delete_task(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- github

/// The inbox as it was last read. Paints before `gh` has been asked anything.
#[tauri::command]
fn github_cached(state: State<'_, AppState>) -> Option<Inbox> {
    state.cache.inbox()
}

/// One GraphQL request for the whole fleet.
///
/// The targets are built here rather than in the frontend so the query is
/// assembled from what the scanner parsed out of each origin URL.
#[tauri::command]
async fn github_refresh(state: State<'_, AppState>) -> Result<Inbox, String> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let targets: Vec<(String, String, String)> = cache
            .all_repos()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|repo| repo.owner_repo.map(|owner| (repo.path, repo.name, owner)))
            .collect();

        let inbox = github::fetch(&targets, cache::now_secs());
        // A failed sweep leaves the last good one in place, so the pane does not
        // empty itself because a laptop was off the network.
        if inbox.error.is_none() {
            let _ = cache.put_inbox(&inbox);
        }
        inbox
    })
    .await
    .map_err(|e| e.to_string())
}

/// One issue, with its body and the tail of its comments.
///
/// Read out of sight, the same as the sweep: it is a read, and the desk under
/// the row is where the answer goes. Not cached, because a thread changes
/// between two openings of the same row and the read is one small request.
#[tauri::command]
async fn github_issue(owner_repo: String, number: i64) -> Result<IssueDetail, String> {
    tauri::async_runtime::spawn_blocking(move || github::issue(&owner_repo, number))
        .await
        .map_err(|e| e.to_string())?
}

/// The settings page's connection test: one small read through the same
/// `gh api graphql` the inbox uses, so a pass means the inbox works and a
/// failure carries gh's own reason.
#[tauri::command]
async fn github_probe() -> Result<GhProbe, String> {
    tauri::async_runtime::spawn_blocking(github::probe)
        .await
        .map_err(|e| e.to_string())?
}

/// Writes an issue body out and hands back the path `gh issue create` will
/// read it from.
///
/// The one part of opening an issue that cannot be typed, for the reason a hunk
/// cannot be: a newline at a prompt submits the line. Everything else about the
/// issue is on the command, and the command goes into the repository's shell,
/// so GitHub is still written by typing.
#[tauri::command]
async fn github_issue_body(
    owner_repo: String,
    title: String,
    body: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::write_issue_body(&owner_repo, &title, &body)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes a commit message out and hands back the path `git commit -F` wants.
/// Only a message with a line break in its body comes here; a subject alone is
/// quoted inline. See scratch.rs.
#[tauri::command]
async fn commit_message_file(path: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || scratch::write_commit_message(&path, &message))
        .await
        .map_err(|e| e.to_string())?
}

/// A session's scrollback and blocks, written for the next launch. See scrollback.rs.
#[tauri::command]
async fn scrollback_write(
    id: String,
    text: String,
    blocks: Vec<scrollback::StoredBlock>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || scrollback::write(&id, &text, &blocks))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scrollback_read(id: String) -> Result<Option<scrollback::Stored>, String> {
    tauri::async_runtime::spawn_blocking(move || scrollback::read(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scrollback_remove(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || scrollback::remove(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scrollback_size() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(scrollback::size)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scrollback_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(scrollback::clear)
        .await
        .map_err(|e| e.to_string())?
}

/// Ends the process. The window's close is intercepted so the frontend can
/// save every scrollback first; this is what it calls once it has.
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Whether a newer GitView has been released.
///
/// One `gh release view`, out of sight for the same reason the inbox sweep is:
/// the question belongs to the app rather than to a repository, so there is no
/// prompt to type it at. Installing does have one, and types its command.
#[tauri::command]
async fn update_check() -> Result<UpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(|| update::check(cache::now_secs()))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- git

#[tauri::command]
async fn git_run(path: String, args: Vec<String>) -> Result<GitOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || gitops::run(&PathBuf::from(&path), &args))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- terminal

#[tauri::command]
fn pty_open(
    state: State<'_, AppState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_output: Channel<String>,
) -> Result<bool, String> {
    state.pty.open(&id, &cwd, cols, rows, on_output)
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    state.pty.write(&id, &data)
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: String) {
    state.pty.close(&id)
}

#[tauri::command]
fn pty_alive(state: State<'_, AppState>, id: String) -> bool {
    state.pty.is_alive(&id)
}

#[tauri::command]
fn pty_live(state: State<'_, AppState>) -> Vec<String> {
    state.pty.live_ids()
}

// ---------------------------------------------------------------- settings

#[tauri::command]
fn settings_roots(state: State<'_, AppState>) -> Vec<String> {
    settings::roots(&state.cache)
}

#[tauri::command]
fn settings_set_roots(state: State<'_, AppState>, roots: Vec<String>) -> Result<(), String> {
    settings::set_roots(&state.cache, &roots).map_err(|e| e.to_string())
}

/// Appends a folder to the scan roots and hands back the new list.
///
/// One verb covers both "watch this folder full of checkouts" and "watch this
/// one repository", because `fleet::discover` already treats a root that is
/// itself a repository as one of its results.
#[tauri::command]
fn settings_add_root(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let trimmed = path.trim().trim_end_matches(['/', '\\']).to_string();
    if trimmed.is_empty() {
        return Err("Give a folder path.".to_string());
    }
    if !PathBuf::from(&trimmed).is_dir() {
        return Err(format!("{trimmed} is not a folder on this machine."));
    }

    let mut roots = settings::roots(&state.cache);
    if roots.iter().any(|r| r.eq_ignore_ascii_case(&trimmed)) {
        return Ok(roots);
    }
    roots.push(trimmed);
    settings::set_roots(&state.cache, &roots).map_err(|e| e.to_string())?;
    Ok(roots)
}

#[tauri::command]
fn settings_remove_root(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let roots: Vec<String> = settings::roots(&state.cache)
        .into_iter()
        .filter(|r| !r.eq_ignore_ascii_case(&path))
        .collect();
    settings::set_roots(&state.cache, &roots).map_err(|e| e.to_string())?;
    Ok(roots)
}

/// When the fleet was last fetched, as seconds since the epoch, or zero.
///
/// The counts on every sidebar row are only as true as the last fetch, and
/// the app rather than any one repository is what did the fetching, so the
/// time lives in the settings table beside the roots rather than in a
/// `RepoState`, which the scanner rewrites every sweep.
#[tauri::command]
fn settings_fetched_at(state: State<'_, AppState>) -> i64 {
    state
        .cache
        .get_setting("fleet_fetched_at")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

#[tauri::command]
fn settings_set_fetched_at(state: State<'_, AppState>, at: i64) -> Result<(), String> {
    state
        .cache
        .set_setting("fleet_fetched_at", &at.to_string())
        .map_err(|e| e.to_string())
}

/// The clipboard's text, for the shell's Paste.
///
/// The webview can read it too, but WebView2 asks first with an Edge permission
/// dialog, once per user data folder, and a browser prompt over a desktop app
/// is the wrong answer to a right-click. An empty clipboard is an empty string,
/// which pastes nothing rather than an error.
#[tauri::command]
fn clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    let shell = pty::default_shell();
    AppInfo {
        git_version: gitops::version(),
        gh: github::status(),
        shell_integration: pty::is_powershell(&shell),
        shell,
        data_dir: cache::data_dir().to_string_lossy().to_string(),
        roots: settings::roots(&state.cache),
    }
}

// ---------------------------------------------------------------- entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The close button asks rather than closes: the frontend hears
        // `closing`, writes every shell's scrollback out, and calls `app_quit`.
        // Without the hold the buffers would be gone before the write began.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = tauri::Emitter::emit(window, "closing", ());
            }
        })
        .setup(|app| {
            let cache = Cache::open()?;
            app.manage(AppState {
                cache: Arc::new(cache),
                pty: Arc::new(PtyManager::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fleet_cached,
            fleet_scan,
            repo_refresh,
            repo_graph,
            repo_history,
            repo_squashed,
            repo_changes,
            repo_diff,
            repo_commit,
            repo_commit_file,
            repo_blame,
            diff_hunk_patch,
            commit_file_export,
            repo_prefs,
            repo_set_hidden,
            repo_set_pinned,
            repo_reorder_pins,
            task_set_hidden,
            repo_tasks,
            task_save,
            task_delete,
            github_cached,
            github_refresh,
            github_issue_body,
            commit_message_file,
            github_issue,
            github_probe,
            update_check,
            git_run,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_alive,
            pty_live,
            scrollback_write,
            scrollback_read,
            scrollback_remove,
            scrollback_size,
            scrollback_clear,
            app_quit,
            settings_roots,
            settings_set_roots,
            settings_add_root,
            settings_remove_root,
            settings_fetched_at,
            settings_set_fetched_at,
            clipboard_text,
            app_info,
        ])
        .run(tauri::generate_context!())
        .expect("GitView failed to start");
}
