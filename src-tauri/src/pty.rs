//! Persistent terminal sessions, one per repository.
//!
//! A session belongs to a repository rather than to a view, so switching to
//! another project and back leaves the shell, its scrollback and any dev server
//! running. That is the behaviour the whole app is arranged around.

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;

pub struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Swappable so a reloaded frontend can reattach to a running shell.
    channel: Arc<Mutex<Option<Channel<String>>>>,
    alive: Arc<AtomicBool>,
    pub cwd: String,
    pub shell: String,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl PtyManager {
    pub fn open(
        &self,
        id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        channel: Channel<String>,
    ) -> Result<bool, String> {
        // Reattach rather than replacing a live shell.
        if let Some(existing) = self.sessions.lock().get(id) {
            if existing.alive.load(Ordering::SeqCst) {
                *existing.channel.lock() = Some(channel);
                return Ok(false);
            }
        }

        let shell = default_shell();
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("could not open a pty: {e}"))?;

        let mut cmd = CommandBuilder::new(&shell);
        if Path::new(cwd).is_dir() {
            cmd.cwd(cwd);
        }
        // Lets a shell profile detect the host without guessing.
        cmd.env("GITVIEW", "1");
        cmd.env("TERM", "xterm-256color");
        if shell.ends_with("pwsh.exe") || shell.ends_with("powershell.exe") {
            cmd.args(["-NoLogo"]);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start {shell}: {e}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("could not read from the pty: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("could not write to the pty: {e}"))?;

        let channel_slot = Arc::new(Mutex::new(Some(channel)));
        let alive = Arc::new(AtomicBool::new(true));

        let session = Arc::new(Session {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            channel: channel_slot.clone(),
            alive: alive.clone(),
            cwd: cwd.to_string(),
            shell: shell.clone(),
        });

        // Reader thread. Owns nothing the commands need, so a blocked read never
        // holds up pty_write or pty_resize.
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();

            loop {
                let read = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                pending.extend_from_slice(&buf[..read]);

                // A multi-byte character can straddle two reads, so only the
                // complete prefix goes out and the remainder waits for more bytes.
                let split = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(err) => {
                        if err.error_len().is_some() {
                            // A genuinely invalid byte, not a truncated character.
                            // Emit it lossily rather than stalling the stream.
                            pending.len()
                        } else {
                            err.valid_up_to()
                        }
                    }
                };

                if split > 0 {
                    let chunk = String::from_utf8_lossy(&pending[..split]).to_string();
                    pending.drain(..split);
                    if let Some(channel) = channel_slot.lock().as_ref() {
                        if channel.send(chunk).is_err() {
                            break;
                        }
                    }
                }
            }

            alive.store(false, Ordering::SeqCst);
            let _ = child.wait();
            if let Some(channel) = channel_slot.lock().as_ref() {
                let _ = channel.send("\r\n\u{1b}[2m[session ended]\u{1b}[0m\r\n".to_string());
            }
        });

        self.sessions.lock().insert(id.to_string(), session);
        Ok(true)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let session = self.get(id)?;
        let mut writer = session.writer.lock();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        writer.flush().map_err(|e| format!("flush failed: {e}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get(id)?;
        session
            .master
            .lock()
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }

    pub fn close(&self, id: &str) {
        if let Some(session) = self.sessions.lock().remove(id) {
            session.alive.store(false, Ordering::SeqCst);
            *session.channel.lock() = None;
        }
    }

    pub fn is_alive(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .get(id)
            .map(|s| s.alive.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    pub fn live_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .iter()
            .filter(|(_, s)| s.alive.load(Ordering::SeqCst))
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no terminal session named {id}"))
    }
}

/// PowerShell 7 when it is installed, Windows PowerShell otherwise.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if let Some(found) = find_on_path(candidate) {
                return found;
            }
        }
        "cmd.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[cfg(windows)]
fn find_on_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().to_string())
}
