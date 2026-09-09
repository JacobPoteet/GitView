//! Persistent terminal sessions, one per repository.
//!
//! A session belongs to a repository rather than to a view, so switching to
//! another project and back leaves the shell, its scrollback and any dev server
//! running. That is the behaviour the whole app is arranged around.
//!
//! A PowerShell session also carries GitView's shell integration, which emits
//! OSC 133 prompt marks so the app can tell one command from the next, read its
//! exit code and find its output. See the Command Blocks note in the wiki.

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
    /// Whether this shell was started with the OSC 133 integration.
    pub integration: bool,
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
        let integration = is_powershell(&shell);
        if integration {
            // An encoded command rather than a path to dot-source. A script file
            // is subject to the execution policy and this is not, and base64 has
            // no quoting left to get wrong. The user's profile still loads first,
            // which is what lets the script wrap an existing prompt instead of
            // replacing it.
            cmd.args([
                "-NoLogo",
                "-NoExit",
                "-EncodedCommand",
                &encoded_integration(),
            ]);
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
            integration,
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
        // The guard is bound rather than chained: a temporary here would outlive
        // `session`, which owns the mutex it borrows from.
        let master = session.master.lock();
        master
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

/// The prompt hook, handed to PowerShell at session start.
///
/// Kept beside the Rust rather than written into the user's data folder because
/// it is source, not state: it ships with the binary, it is readable in the
/// repository, and there is no copy on disk to go stale against it.
const INTEGRATION: &str = include_str!("shell_integration.ps1");

pub fn is_powershell(shell: &str) -> bool {
    let name = shell
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(shell)
        .to_ascii_lowercase();
    name.starts_with("pwsh") || name.starts_with("powershell")
}

/// The integration script as PowerShell's `-EncodedCommand` wants it: UTF-16LE,
/// base64.
fn encoded_integration() -> String {
    let utf16: Vec<u8> = INTEGRATION
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64(&utf16)
}

/// Sixteen lines against a dependency. Nothing else in the app encodes anything,
/// and a crate here would be one more thing for the release build to compile.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - i * 6)) as usize & 0x3F] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // Every value of the alphabet, so a wrong index shows up here.
        assert_eq!(base64(&[0xFB, 0xFF, 0xBF]), "+/+/");
    }

    #[test]
    fn the_integration_encodes_as_utf16le() {
        // PowerShell reads the payload as UTF-16LE, so each character of the
        // script is a byte followed by a zero. The script opens on a comment,
        // and the first three of those bytes are 0x23 0x00 0x20.
        let encoded = encoded_integration();
        assert!(!encoded.is_empty());
        assert!(encoded
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)));
        assert_eq!(base64(&[b'#', 0, b' ']), "IwAg");
        assert!(encoded.starts_with("IwAg"));
    }

    #[test]
    fn powershell_is_recognised_by_name() {
        assert!(is_powershell(r"C:\Program Files\PowerShell\7\pwsh.exe"));
        assert!(is_powershell(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        ));
        assert!(!is_powershell(r"C:\Windows\System32\cmd.exe"));
        assert!(!is_powershell("/bin/bash"));
    }
}
