//! GitView's Rust core.
//!
//! The frontend only ever talks to the commands declared here. Anything that
//! reads a repository goes through `fleet`, anything that reaches a remote goes
//! through `gitops`, and the terminal lives in `pty`.

pub mod cache;
pub mod fleet;
pub mod gitops;
pub mod pty;
pub mod settings;
pub mod tasks;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use cache::Cache;
use fleet::RepoState;
use gitops::GitOutcome;
use pty::PtyManager;
use tasks::Task;

pub struct AppState {
    cache: Arc<Cache>,
    pty: Arc<PtyManager>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    git_version: Option<String>,
    shell: String,
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
) -> Result<usize, String> {
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
        for path in paths {
            let repo_state = fleet::read_repo(&path);
            let _ = cache.put_repo(&repo_state);
            if on_repo.send(repo_state).is_err() {
                break;
            }
            scanned += 1;
        }
        scanned
    })
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

// ---------------------------------------------------------------- tasks

#[tauri::command]
async fn repo_tasks(state: State<'_, AppState>, path: String) -> Result<Vec<Task>, String> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut found = tasks::discover(&PathBuf::from(&path));
        if let Ok(saved) = cache.saved_tasks(&path) {
            // Saved tasks lead, because a person chose those.
            let mut all = saved;
            all.append(&mut found);
            return all;
        }
        found
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

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        git_version: gitops::version(),
        shell: pty::default_shell(),
        data_dir: cache::data_dir().to_string_lossy().to_string(),
        roots: settings::roots(&state.cache),
    }
}

// ---------------------------------------------------------------- entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            repo_tasks,
            task_save,
            task_delete,
            git_run,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_alive,
            pty_live,
            settings_roots,
            settings_set_roots,
            app_info,
        ])
        .run(tauri::generate_context!())
        .expect("GitView failed to start");
}
