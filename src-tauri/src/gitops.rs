//! Everything that talks to a remote runs through the real `git` binary.
//!
//! Credential helpers, the Windows Credential Manager, SSH agents, host key
//! prompts and proxies are all solved by the user's existing git configuration.
//! Reimplementing that inside the app is where other GUIs collect "cannot push"
//! reports, so fetch, push and pull spawn a subprocess and inherit the
//! environment instead.

use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

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

/// How long a `git` call may run. A fetch over a slow link is minutes, and a
/// remote that never answers is forever: an ssh host behind a dead VPN held a
/// blocking thread, and the batch behind it, until the app was closed.
const GIT_LIMIT: Duration = Duration::from_secs(300);

/// Runs a command to completion, or kills it at `limit`.
///
/// `Command::output` has no deadline. The streams are read on threads so a
/// full pipe cannot stall the child, and `stdin`, when given, is written on
/// one too and closed after, which is what lets `gh` finish reading. On a
/// timeout the readers are left to end on their own: a grandchild such as ssh
/// can keep a pipe open after its parent is killed.
pub(crate) fn output_within(
    mut cmd: Command,
    stdin: Option<&str>,
    limit: Duration,
) -> std::io::Result<Output> {
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    if let (Some(body), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let body = body.to_owned();
        std::thread::spawn(move || {
            let _ = pipe.write_all(body.as_bytes());
        });
    }
    let drain = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(child.stdout.take().map(|s| Box::new(s) as _));
    let stderr = drain(child.stderr.take().map(|s| Box::new(s) as _));

    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("did not finish within {} seconds", limit.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
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

    match output_within(cmd, None, GIT_LIMIT) {
        Ok(out) => GitOutcome {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            command: printable,
        },
        Err(err) => GitOutcome {
            code: -1,
            stdout: String::new(),
            stderr: if err.kind() == std::io::ErrorKind::TimedOut {
                format!("git {err}")
            } else {
                format!("could not start git: {err}")
            },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_that_finishes_returns_its_output() {
        let out = output_within(
            {
                let mut c = Command::new("git");
                c.arg("--version");
                c
            },
            None,
            Duration::from_secs(30),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).starts_with("git version"));
    }

    #[cfg(windows)]
    #[test]
    fn a_command_that_never_finishes_is_killed_at_the_limit() {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 20"]);
        let started = Instant::now();
        let err = output_within(cmd, None, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
