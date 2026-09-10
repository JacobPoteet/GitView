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
    /// Where the row sits inside the pinned group, once someone has dragged it.
    ///
    /// `pinned_at` was the order for two phases and cannot express one: it is
    /// the moment the pin happened, so moving a row would mean rewriting when
    /// it was pinned, and every row below it as well.
    pub pinned_pos: Option<i64>,
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

/// Gives every pin that has no position one, in the order it was pinned.
///
/// That is the order the list was already drawn in, so the upgrade changes
/// nothing on screen. Positions are assigned in Rust rather than by a counting
/// subquery because two pins made in the same second would otherwise share a
/// position, and the sort would pick between them by whatever came back first.
fn backfill_pin_order(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT path, pinned_at FROM repo_pref
         WHERE pinned_at IS NOT NULL AND pinned_pos IS NULL",
    )?;
    let mut rows: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    if rows.is_empty() {
        return Ok(());
    }
    rows.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));

    let start: i64 = conn.query_row(
        "SELECT COALESCE(MAX(pinned_pos), -1) + 1 FROM repo_pref",
        [],
        |r| r.get(0),
    )?;
    for (offset, (path, _)) in rows.iter().enumerate() {
        conn.execute(
            "UPDATE repo_pref SET pinned_pos = ?2 WHERE path = ?1",
            params![path, start + offset as i64],
        )?;
    }
    Ok(())
}

/// Removes a preference row that has stopped holding a preference.
///
/// Unhiding or unpinning leaves a row of defaults behind, and `has_prefs` counts
/// rows rather than reading them, so one of those at a path is enough to stop a
/// renamed repository from adopting its own pins.
fn drop_empty_pref(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM repo_pref WHERE path = ?1 AND hidden = 0 AND pinned_at IS NULL",
        params![path],
    )?;
    Ok(())
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

/// Adds a column to a table that predates it.
///
/// SQLite has no `ADD COLUMN IF NOT EXISTS`, and the alternative is to catch a
/// failure whose message would also cover a real problem. The names here are
/// literals in this file, never anything a user typed.
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let present = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == column);
    drop(stmt);
    if !present {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

impl Cache {
    pub fn open() -> Result<Self> {
        let dir = data_dir();
        std::fs::create_dir_all(&dir)?;
        Self::from_connection(Connection::open(dir.join("gitview.db"))?)
    }

    /// A cache with no file behind it. The schema and its migrations are what
    /// the tests are for, and neither needs a disk.
    #[cfg(test)]
    fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
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
                path       TEXT PRIMARY KEY,
                hidden     INTEGER NOT NULL DEFAULT 0,
                pinned_at  INTEGER,
                pinned_pos INTEGER
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

        // An installed database predates the column, and the pins in it are an
        // order the user is already looking at.
        add_column_if_missing(&conn, "repo_pref", "pinned_pos", "INTEGER")?;
        backfill_pin_order(&conn)?;

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
            "SELECT path, hidden, pinned_at, pinned_pos FROM repo_pref
             WHERE hidden = 1 OR pinned_at IS NOT NULL
             ORDER BY pinned_pos",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RepoPref {
                path: r.get(0)?,
                hidden: r.get::<_, i64>(1)? != 0,
                pinned_at: r.get(2)?,
                pinned_pos: r.get(3)?,
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
        drop_empty_pref(&conn, path)?;
        Ok(())
    }

    /// A new pin lands at the end of the pinned group.
    ///
    /// The group is an order somebody arranged, so putting a new row at the top
    /// would move every row they had placed. `pinned_at` is still recorded,
    /// because it is what an upgrade orders the group by.
    pub fn set_repo_pinned(&self, path: &str, pinned: bool) -> Result<()> {
        let conn = self.conn.lock();
        if !pinned {
            conn.execute(
                "UPDATE repo_pref SET pinned_at = NULL, pinned_pos = NULL WHERE path = ?1",
                params![path],
            )?;
            drop_empty_pref(&conn, path)?;
            return Ok(());
        }
        let next: i64 = conn.query_row(
            "SELECT COALESCE(MAX(pinned_pos), -1) + 1 FROM repo_pref",
            [],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO repo_pref (path, pinned_at, pinned_pos) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET pinned_at = ?2, pinned_pos = ?3",
            params![path, now_secs(), next],
        )?;
        Ok(())
    }

    /// Writes an order across the pinned rows.
    ///
    /// The whole list arrives rather than one move, so the write is a single
    /// transaction and a row the frontend forgot cannot be left sharing a
    /// position with another. A path that is no longer pinned is ignored, since
    /// a stale list must not be able to pin something by reordering it.
    pub fn reorder_pins(&self, paths: &[String]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for (index, path) in paths.iter().enumerate() {
            tx.execute(
                "UPDATE repo_pref SET pinned_pos = ?2
                 WHERE path = ?1 AND pinned_at IS NOT NULL",
                params![path, index as i64],
            )?;
        }
        tx.commit()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned paths, in the order the sidebar would draw them.
    fn pin_order(cache: &Cache) -> Vec<String> {
        cache
            .repo_prefs()
            .unwrap()
            .into_iter()
            .filter(|p| p.pinned_at.is_some())
            .map(|p| p.path)
            .collect()
    }

    #[test]
    fn a_new_pin_goes_to_the_end_of_the_group() {
        let cache = Cache::in_memory().unwrap();
        for path in ["a", "b", "c"] {
            cache.set_repo_pinned(path, true).unwrap();
        }
        assert_eq!(pin_order(&cache), ["a", "b", "c"]);
    }

    #[test]
    fn reordering_writes_the_list_it_is_given() {
        let cache = Cache::in_memory().unwrap();
        for path in ["a", "b", "c"] {
            cache.set_repo_pinned(path, true).unwrap();
        }
        cache
            .reorder_pins(&["c".into(), "a".into(), "b".into()])
            .unwrap();
        assert_eq!(pin_order(&cache), ["c", "a", "b"]);
    }

    #[test]
    fn a_stale_list_cannot_pin_by_reordering() {
        let cache = Cache::in_memory().unwrap();
        cache.set_repo_pinned("a", true).unwrap();
        // "b" was unpinned in another window while this list was on screen.
        cache.reorder_pins(&["b".into(), "a".into()]).unwrap();
        assert_eq!(pin_order(&cache), ["a"]);
    }

    #[test]
    fn unpinning_the_middle_row_leaves_the_rest_in_order() {
        let cache = Cache::in_memory().unwrap();
        for path in ["a", "b", "c"] {
            cache.set_repo_pinned(path, true).unwrap();
        }
        cache.set_repo_pinned("b", false).unwrap();
        assert_eq!(pin_order(&cache), ["a", "c"]);
        // Positions are not compacted, so the next pin has to clear the highest
        // one rather than the count.
        cache.set_repo_pinned("d", true).unwrap();
        assert_eq!(pin_order(&cache), ["a", "c", "d"]);
    }

    #[test]
    fn unpinning_and_unhiding_leave_no_row_behind() {
        let cache = Cache::in_memory().unwrap();
        cache.set_repo_pinned("a", true).unwrap();
        cache.set_repo_hidden("a", true).unwrap();
        cache.set_repo_pinned("a", false).unwrap();
        {
            let conn = cache.conn.lock();
            // Still hidden, so the row is still holding something.
            assert!(has_prefs(&conn, "a").unwrap());
        }
        cache.set_repo_hidden("a", false).unwrap();
        let conn = cache.conn.lock();
        assert!(!has_prefs(&conn, "a").unwrap());
    }

    #[test]
    fn an_older_database_keeps_the_order_it_was_showing() {
        // repo_pref as it shipped: no pinned_pos, and the group ordered by the
        // moment each pin was made.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE repo_pref (
                 path      TEXT PRIMARY KEY,
                 hidden    INTEGER NOT NULL DEFAULT 0,
                 pinned_at INTEGER
             );
             INSERT INTO repo_pref (path, hidden, pinned_at) VALUES
                 ('third', 0, 300), ('first', 0, 100), ('second', 0, 200),
                 ('hidden-only', 1, NULL);",
        )
        .unwrap();

        let cache = Cache::from_connection(conn).unwrap();
        assert_eq!(pin_order(&cache), ["first", "second", "third"]);

        // And the upgraded rows can be reordered like any other.
        cache
            .reorder_pins(&["second".into(), "third".into(), "first".into()])
            .unwrap();
        assert_eq!(pin_order(&cache), ["second", "third", "first"]);
    }

    #[test]
    fn pins_made_in_the_same_second_get_distinct_positions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE repo_pref (
                 path      TEXT PRIMARY KEY,
                 hidden    INTEGER NOT NULL DEFAULT 0,
                 pinned_at INTEGER
             );
             INSERT INTO repo_pref (path, hidden, pinned_at) VALUES
                 ('b', 0, 100), ('a', 0, 100), ('c', 0, 100);",
        )
        .unwrap();

        let cache = Cache::from_connection(conn).unwrap();
        let positions: Vec<i64> = cache
            .repo_prefs()
            .unwrap()
            .into_iter()
            .filter_map(|p| p.pinned_pos)
            .collect();
        assert_eq!(positions, [0, 1, 2]);
        assert_eq!(pin_order(&cache), ["a", "b", "c"]);
    }
}
