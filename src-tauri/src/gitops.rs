//! Everything that talks to a remote runs through the real `git` binary.
//!
//! Credential helpers, the Windows Credential Manager, SSH agents, host key
//! prompts and proxies are all solved by the user's existing git configuration.
//! Reimplementing that inside the app is where other GUIs collect "cannot push"
//! reports, so fetch, push and pull spawn a subprocess and inherit the
//! environment instead.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// The command as typed, so the UI can show what it ran.
    pub command: String,
}

pub fn run(repo: &Path, args: &[String]) -> GitOutcome {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo)
        .args(args)
        // A GUI has no console, so a credential prompt would block on a read that
        // never returns. Failing fast gives the UI an error it can show, and the
        // recovery path is to run the same command in the terminal pane.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let printable = format!("git {}", args.join(" "));

    match cmd.output() {
        Ok(out) => GitOutcome {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            command: printable,
        },
        Err(err) => GitOutcome {
            code: -1,
            stdout: String::new(),
            stderr: format!("could not start git: {err}"),
            command: printable,
        },
    }
}

pub fn version() -> Option<String> {
    let out = run(Path::new("."), &["--version".to_string()]);
    if out.code == 0 {
        Some(out.stdout.trim().to_string())
    } else {
        None
    }
}
