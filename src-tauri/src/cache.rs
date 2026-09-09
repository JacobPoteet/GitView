//! SQLite cache behind the instant cold start.
//!
//! The fleet list paints from this table before any repository is opened, so the
//! rows are on screen while the scan runs. See the State Cache note in the wiki.

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::PathBuf;

use crate::fleet::RepoState;
use crate::tasks::Task;

pub struct Cache {
    conn: Mutex<Connection>,
}

impl Cache {
    pub fn open() -> Result<Self> {
        let dir = data_dir();
        std::fs::create_dir_all(&dir)?;
        let conn = Connection::open(dir.join("gitview.db"))?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS repo_state (
                path       TEXT PRIMARY KEY,
                json       TEXT NOT NULL,
                scanned_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS saved_task (
                id         TEXT PRIMARY KEY,
                repo_path  TEXT NOT NULL,
                name       TEXT NOT NULL,
                command    TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS saved_task_repo ON saved_task (repo_path);

            CREATE TABLE IF NOT EXISTS setting (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn put_repo(&self, state: &RepoState) -> Result<()> {
        let json = serde_json::to_string(state)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO repo_state (path, json, scanned_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET json = ?2, scanned_at = ?3",
            params![state.path, json, state.scanned_at],
        )?;
        Ok(())
    }

    pub fn all_repos(&self) -> Result<Vec<RepoState>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json FROM repo_state ORDER BY path")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(state) = serde_json::from_str::<RepoState>(&row?) {
                out.push(state);
            }
        }
        Ok(out)
    }

    /// Drops cached rows for repositories that are no longer on disk, so a deleted
    /// project stops appearing after the next scan.
    pub fn retain_repos(&self, keep: &[String]) -> Result<()> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT path FROM repo_state")?;
        let existing: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for path in existing {
            if !keep.iter().any(|k| k == &path) {
                conn.execute("DELETE FROM repo_state WHERE path = ?1", params![path])?;
            }
        }
        Ok(())
    }

    pub fn saved_tasks(&self, repo_path: &str) -> Result<Vec<Task>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, command FROM saved_task WHERE repo_path = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![repo_path], |r| {
            Ok(Task {
                id: r.get(0)?,
                name: r.get(1)?,
                command: r.get(2)?,
                source: "saved".to_string(),
                saved: true,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn save_task(&self, repo_path: &str, name: &str, command: &str) -> Result<Task> {
        let id = format!("saved:{}:{}", repo_path, name);
        let now = now_secs();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO saved_task (id, repo_path, name, command, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET command = ?4",
            params![id, repo_path, name, command, now],
        )?;
        Ok(Task {
            id,
            name: name.to_string(),
            command: command.to_string(),
            source: "saved".to_string(),
            saved: true,
        })
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM saved_task WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT value FROM setting WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO setting (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }
}

pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("GitView")
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
