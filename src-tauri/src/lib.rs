//! GitView's Rust core.
//!
//! The frontend only ever talks to the commands declared here. Anything that
//! reads a repository goes through `fleet`, anything that reaches a remote goes
//! through `gitops`, and the terminal lives in `pty`.

pub mod cache;
pub mod fleet;
pub mod github;
pub mod gitops;
pub mod graph;
pub mod pty;
pub mod settings;
pub mod tasks;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use cache::{Adoption, Cache, RepoPref};
use fleet::{FileChange, RepoState};
use github::{GhStatus, Inbox};
use gitops::GitOutcome;
use graph::BranchGraph;
use pty::PtyManager;
use tasks::Task;

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
            repo_changes,
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
            git_run,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_alive,
            pty_live,
            settings_roots,
            settings_set_roots,
            settings_add_root,
            settings_remove_root,
            app_info,
        ])
        .run(tauri::generate_context!())
        .expect("GitView failed to start");
}
