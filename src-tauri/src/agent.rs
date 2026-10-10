//! Claude's state, from hooks that ride in on `--settings`.
//!
//! The Claude tab types `claude --settings "<data dir>\claude-hooks.json"`, so
//! the hooks exist for that one run and nothing is written to `~/.claude`.
//! Each hook appends its event name to the file `GITVIEW_AGENT_FILE` names, a
//! variable set in every shell's environment, one file per session. A thread
//! tails the files and emits `agent-event`: no port, no server, no watcher
//! crate. See the Agent note in the wiki.

use parking_lot::Mutex;
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How often the files are read. A hook's own cost is a PowerShell start, so
/// finer than this would only measure the poll.
const POLL: Duration = Duration::from_millis(100);

/// The hooks, as `(event, matcher)`. Which state each one means is the
/// frontend's to say; this is only what Claude is asked to report.
const EVENTS: &[(&str, Option<&str>)] = &[
    ("UserPromptSubmit", None),
    ("PreToolUse", None),
    ("PermissionRequest", None),
    // `idle_prompt` fires after a minute of nobody answering a finished turn,
    // which is not a question, so only the two that are.
    ("Notification", Some("permission_prompt|elicitation_dialog")),
    ("Stop", None),
    ("StopFailure", None),
    ("SessionEnd", None),
];

struct Tail {
    id: String,
    path: PathBuf,
    offset: u64,
}

fn tails() -> &'static Mutex<Vec<Tail>> {
    static TAILS: OnceLock<Mutex<Vec<Tail>>> = OnceLock::new();
    TAILS.get_or_init(|| Mutex::new(Vec::new()))
}

#[derive(Serialize, Clone)]
struct AgentEvent {
    id: String,
    event: String,
}

fn dir() -> PathBuf {
    crate::cache::data_dir().join("agent")
}

/// A name a file can carry for any session id, which is a path or `path#claude`.
fn file_name(id: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in id.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}.log")
}

/// The file a session's hooks append to, emptied and now tailed. Called when a
/// shell opens, so a hook can never write to a file nobody reads.
pub fn register(id: &str) -> Option<PathBuf> {
    let dir = dir();
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(file_name(id));
    std::fs::write(&path, b"").ok()?;
    let mut tails = tails().lock();
    tails.retain(|tail| tail.id != id);
    tails.push(Tail {
        id: id.to_string(),
        path: path.clone(),
        offset: 0,
    });
    Some(path)
}

/// Stops tailing a closed session.
pub fn unregister(id: &str) {
    tails().lock().retain(|tail| tail.id != id);
}

/// The settings file `claude --settings` takes, written fresh because it is
/// small and a stale one from an older GitView would carry older hooks.
pub fn hooks_file() -> Result<String, String> {
    let dir = crate::cache::data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("claude-hooks.json");
    std::fs::write(&path, hooks_json()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The hook command for one event. It has to mean the same thing to cmd and
/// to bash, whichever Claude runs it in: no `%VAR%`, no `$VAR`, and a double
/// quote only around the whole argument.
fn command(event: &str) -> String {
    format!(
        "powershell -NoProfile -NonInteractive -Command \"[IO.File]::AppendAllText([Environment]::GetEnvironmentVariable('GITVIEW_AGENT_FILE'),'{event}'+[char]10)\""
    )
}

fn hooks_json() -> String {
    let mut hooks = serde_json::Map::new();
    for (event, matcher) in EVENTS {
        let mut group = serde_json::json!({
            "hooks": [{ "type": "command", "command": command(event) }]
        });
        if let Some(matcher) = matcher {
            group["matcher"] = (*matcher).into();
        }
        hooks.insert((*event).to_string(), serde_json::json!([group]));
    }
    serde_json::json!({ "hooks": hooks }).to_string()
}

/// Reads whatever each file gained since the last pass.
fn drain(app: &AppHandle) {
    let mut found = Vec::new();
    {
        let mut tails = tails().lock();
        for tail in tails.iter_mut() {
            let Ok(mut file) = std::fs::File::open(&tail.path) else {
                continue;
            };
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            if len < tail.offset {
                tail.offset = 0;
            }
            if len == tail.offset || file.seek(SeekFrom::Start(tail.offset)).is_err() {
                continue;
            }
            let mut text = String::new();
            if file.read_to_string(&mut text).is_err() {
                continue;
            }
            // A line still being written has no newline yet; leave it for the
            // next pass.
            let Some(end) = text.rfind('\n') else {
                continue;
            };
            tail.offset += (end + 1) as u64;
            for line in text[..end].lines() {
                let event = line.trim().trim_start_matches('\u{feff}');
                if !event.is_empty() {
                    found.push(AgentEvent {
                        id: tail.id.clone(),
                        event: event.to_string(),
                    });
                }
            }
        }
    }
    for event in found {
        let _ = app.emit("agent-event", event);
    }
}

/// Starts the thread that tails the files. Idle when no shell is open.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        if !tails().lock().is_empty() {
            drain(&app);
        }
    });
}

pub fn env_for(id: &str) -> Option<(String, String)> {
    register(id).map(|path| {
        (
            "GITVIEW_AGENT_FILE".into(),
            path.to_string_lossy().into_owned(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_event_has_a_hook_and_only_the_notification_has_a_matcher() {
        let value: serde_json::Value = serde_json::from_str(&hooks_json()).unwrap();
        let hooks = value["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), EVENTS.len());
        assert_eq!(
            hooks["Notification"][0]["matcher"],
            "permission_prompt|elicitation_dialog"
        );
        assert!(hooks["Stop"][0].get("matcher").is_none());
    }

    #[test]
    fn a_hook_names_its_event_and_the_variable_without_expanding_either() {
        let command = command("Stop");
        assert!(command.contains("'Stop'"));
        assert!(command.contains("GetEnvironmentVariable('GITVIEW_AGENT_FILE')"));
        assert!(!command.contains('$') && !command.contains('%'));
    }

    #[test]
    fn two_sessions_do_not_share_a_file() {
        assert_ne!(file_name("F:\\a"), file_name("F:\\a#claude"));
        assert_eq!(file_name("F:\\a"), file_name("F:\\a"));
    }
}
