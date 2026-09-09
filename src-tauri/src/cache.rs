//! SQLite cache behind the instant cold start.
//!
//! The fleet list paints from this table before any repository is opened, so the
//! rows are on screen while the scan runs. See the State Cache note in the wiki.

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::fleet::RepoState;
use crate::tasks::Task;

pub struct Cache {
    conn: Mutex<Connection>,
}

/// A display choice about one repository.
///
/// Kept out of `RepoState` because that struct is scanner output, cached as a
/// JSON blob and rewritten on every sweep. A pin folded into it would be a
/// preference living in a cache that the next scan is free to replace.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoPref {
    pub path: String,
    pub hidden: bool,
    pub pinned_at: Option<i64>,
}

/// A set of preferences that followed a repository to a new folder.
///
/// Reported rather than done silently: the whole complaint about the old
/// behaviour was that it happened without saying anything.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Adoption {
    pub owner_repo: String,
    pub from: String,
    pub to: String,
}

/// Whether a path has anything worth carrying across a rename.
fn has_prefs(conn: &Connection, path: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM repo_pref  WHERE path = ?1)
              + (SELECT COUNT(*) FROM task_pref  WHERE repo_path = ?1)
              + (SELECT COUNT(*) FROM saved_task WHERE repo_path = ?1)",
        params![path],
        |r| r.get(0),
    )?;
    Ok(count > 0)
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

            -- How the fleet list should treat a repository, kept apart from
            -- RepoState because that is scanner output and this is a choice.
            CREATE TABLE IF NOT EXISTS repo_pref (
                path      TEXT PRIMARY KEY,
                hidden    INTEGER NOT NULL DEFAULT 0,
                pinned_at INTEGER
            );

            -- What was at a path last time a scan ran, so a folder that has
            -- been renamed can be recognised at its new one. Written by the
            -- scanner, never by a preference, so nothing has to remember to
            -- keep it up to date.
            CREATE TABLE IF NOT EXISTS repo_identity (
                path       TEXT PRIMARY KEY,
                owner_repo TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS repo_identity_owner ON repo_identity (owner_repo);

            -- Task ids are only unique inside a repository, so the key is both.
            CREATE TABLE IF NOT EXISTS task_pref (
                repo_path TEXT NOT NULL,
                task_id   TEXT NOT NULL,
                hidden    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (repo_path, task_id)
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

    // ------------------------------------------------------------ preferences

    /// Every repository the user has pinned or hidden.
    ///
    /// Rows are only written when a preference is set, so this list is short and
    /// usually much shorter than the fleet.
    pub fn repo_prefs(&self) -> Result<Vec<RepoPref>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT path, hidden, pinned_at FROM repo_pref
             WHERE hidden = 1 OR pinned_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RepoPref {
                path: r.get(0)?,
                hidden: r.get::<_, i64>(1)? != 0,
                pinned_at: r.get(2)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_repo_hidden(&self, path: &str, hidden: bool) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO repo_pref (path, hidden) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET hidden = ?2",
            params![path, hidden as i64],
        )?;
        Ok(())
    }

    /// Pin order is the moment it was pinned, so a pinned repository holds the
    /// position it was given rather than moving when its status changes.
    pub fn set_repo_pinned(&self, path: &str, pinned: bool) -> Result<()> {
        let at: Option<i64> = pinned.then(now_secs);
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO repo_pref (path, pinned_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET pinned_at = ?2",
            params![path, at],
        )?;
        Ok(())
    }

    pub fn hidden_tasks(&self, repo_path: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT task_id FROM task_pref WHERE repo_path = ?1 AND hidden = 1")?;
        let rows = stmt.query_map(params![repo_path], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_task_hidden(&self, repo_path: &str, task_id: &str, hidden: bool) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO task_pref (repo_path, task_id, hidden) VALUES (?1, ?2, ?3)
             ON CONFLICT(repo_path, task_id) DO UPDATE SET hidden = ?3",
            params![repo_path, task_id, hidden as i64],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------- identity

    /// Moves every preference from a path that has gone to the path the same
    /// repository now sits at.
    ///
    /// Preferences are keyed on the absolute path, so renaming a project folder
    /// discarded the pin, the hidden flag and every saved task with no warning
    /// and no way back. `owner/repo` from the origin URL survives a rename and a
    /// re-clone, and the scanner already parses it.
    ///
    /// Three guards, because moving someone's preferences to the wrong row is
    /// worse than losing them:
    ///
    /// - the old path must be gone from disk, so a checkout merely dropped out
    ///   of the scan roots keeps what it had;
    /// - exactly one repository on disk may claim that `owner/repo`, so two
    ///   clones of the same project never fight over one set of pins;
    /// - the new path must have no preferences of its own to overwrite.
    ///
    /// Anything that fails a guard is left alone and stays adoptable later.
    pub fn adopt_moved_repos(&self, fleet: &[(String, Option<String>)]) -> Result<Vec<Adoption>> {
        let mut claims: HashMap<&str, Vec<&str>> = HashMap::new();
        for (path, owner) in fleet {
            if let Some(owner) = owner {
                claims
                    .entry(owner.as_str())
                    .or_default()
                    .push(path.as_str());
            }
        }

        let live: HashSet<&str> = fleet.iter().map(|(path, _)| path.as_str()).collect();

        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT path, owner_repo FROM repo_identity")?;
        let known: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        let mut moved = Vec::new();
        for (old_path, owner) in &known {
            if live.contains(old_path.as_str()) {
                continue;
            }
            if Path::new(old_path).exists() {
                continue;
            }
            let Some(candidates) = claims.get(owner.as_str()) else {
                continue;
            };
            let [new_path] = candidates.as_slice() else {
                continue;
            };
            if has_prefs(&conn, new_path)? {
                continue;
            }
            if !has_prefs(&conn, old_path)? {
                conn.execute(
                    "DELETE FROM repo_identity WHERE path = ?1",
                    params![old_path],
                )?;
                continue;
            }

            conn.execute(
                "UPDATE repo_pref SET path = ?2 WHERE path = ?1",
                params![old_path, new_path],
            )?;
            conn.execute(
                "UPDATE task_pref SET repo_path = ?2 WHERE repo_path = ?1",
                params![old_path, new_path],
            )?;
            // The saved-task id embeds the path, so it has to move with the row.
            conn.execute(
                "UPDATE saved_task SET repo_path = ?2, id = 'saved:' || ?2 || ':' || name
                 WHERE repo_path = ?1",
                params![old_path, new_path],
            )?;
            conn.execute(
                "DELETE FROM repo_identity WHERE path = ?1",
                params![old_path],
            )?;

            moved.push(Adoption {
                owner_repo: owner.clone(),
                from: old_path.clone(),
                to: (*new_path).to_string(),
            });
        }

        for (path, owner) in fleet {
            if let Some(owner) = owner {
                conn.execute(
                    "INSERT INTO repo_identity (path, owner_repo) VALUES (?1, ?2)
                     ON CONFLICT(path) DO UPDATE SET owner_repo = ?2",
                    params![path, owner],
                )?;
            }
        }

        Ok(moved)
    }

    /// Drops cached rows for repositories that are no longer on disk, so a deleted
    /// project stops appearing after the next scan.
    ///
    /// Preferences survive on purpose. An unplugged drive or a scan root removed
    /// by accident would otherwise silently discard every pin behind it.
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
                hidden: false,
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
            hidden: false,
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
