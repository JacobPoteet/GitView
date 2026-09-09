//! Task discovery across mixed toolchains.
//!
//! The fleet spans npm projects, Rust crates, Unity projects, Python trees and a
//! GBA build, so no single runner covers it. Discovery reads whatever manifest a
//! repository happens to hold and proposes the commands it implies. Anything
//! discovery misses gets saved by hand and lives in the database, see `cache.rs`.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Which manifest proposed it, or "saved" when a person did.
    pub source: String,
    pub saved: bool,
    /// Sent to the collapsed section at the bottom of the list. Discovery finds
    /// every script a project declares, and most projects declare several that
    /// only CI or an agent ever runs.
    #[serde(default)]
    pub hidden: bool,
}

impl Task {
    fn new(source: &str, name: &str, command: String) -> Self {
        Self {
            id: format!("{source}:{name}"),
            name: name.to_string(),
            command,
            source: source.to_string(),
            saved: false,
            hidden: false,
        }
    }
}

pub fn discover(repo: &Path) -> Vec<Task> {
    let mut tasks = Vec::new();

    node_tasks(repo, &mut tasks);
    cargo_tasks(repo, &mut tasks);
    make_tasks(repo, &mut tasks);
    just_tasks(repo, &mut tasks);
    python_tasks(repo, &mut tasks);
    dotnet_tasks(repo, &mut tasks);
    cmake_tasks(repo, &mut tasks);
    unity_tasks(repo, &mut tasks);
    compose_tasks(repo, &mut tasks);

    tasks
}

fn read(repo: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(repo.join(name)).ok()
}

/// npm, and whichever of pnpm, yarn or bun the lockfile points at.
fn node_tasks(repo: &Path, out: &mut Vec<Task>) {
    let Some(raw) = read(repo, "package.json") else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let runner = package_manager(repo);

    if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
        for name in scripts.keys() {
            let command = if runner == "npm" {
                format!("npm run {name}")
            } else {
                format!("{runner} {name}")
            };
            out.push(Task::new("package.json", name, command));
        }
    }

    let install = match runner.as_str() {
        "npm" => "npm install".to_string(),
        other => format!("{other} install"),
    };
    out.push(Task::new("package.json", "install", install));
}

fn package_manager(repo: &Path) -> String {
    for (lockfile, runner) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
    ] {
        if repo.join(lockfile).exists() {
            return runner.to_string();
        }
    }
    "npm".to_string()
}

fn cargo_tasks(repo: &Path, out: &mut Vec<Task>) {
    if !repo.join("Cargo.toml").exists() {
        return;
    }
    for (name, command) in [
        ("build", "cargo build"),
        ("run", "cargo run"),
        ("test", "cargo test"),
        ("check", "cargo check"),
        ("release", "cargo build --release"),
    ] {
        out.push(Task::new("Cargo.toml", name, command.to_string()));
    }
}

/// Reads target names off the left of a rule. Skips pattern rules, variable
/// assignments and anything indented, which is a recipe line rather than a target.
fn make_tasks(repo: &Path, out: &mut Vec<Task>) {
    let Some(contents) = read(repo, "Makefile").or_else(|| read(repo, "makefile")) else {
        return;
    };
    for line in contents.lines() {
        if line.starts_with(char::is_whitespace) || line.starts_with('#') {
            continue;
        }
        let Some((target, rest)) = line.split_once(':') else {
            continue;
        };
        if rest.starts_with('=') || target.contains('%') || target.contains('$') {
            continue;
        }
        let target = target.trim();
        if target.is_empty() || target.starts_with('.') || target.contains(' ') {
            continue;
        }
        out.push(Task::new("Makefile", target, format!("make {target}")));
    }
}

fn just_tasks(repo: &Path, out: &mut Vec<Task>) {
    let Some(contents) = read(repo, "justfile").or_else(|| read(repo, "Justfile")) else {
        return;
    };
    for line in contents.lines() {
        if line.starts_with(char::is_whitespace) || line.starts_with('#') {
            continue;
        }
        let Some((head, _)) = line.split_once(':') else {
            continue;
        };
        let name = head.split_whitespace().next().unwrap_or("").trim();
        if name.is_empty() || name.contains('=') {
            continue;
        }
        out.push(Task::new("justfile", name, format!("just {name}")));
    }
}

fn python_tasks(repo: &Path, out: &mut Vec<Task>) {
    if repo.join("uv.lock").exists() {
        out.push(Task::new("uv", "sync", "uv sync".to_string()));
        out.push(Task::new("uv", "run", "uv run python -m main".to_string()));
        return;
    }
    if repo.join("pyproject.toml").exists() {
        out.push(Task::new(
            "pyproject.toml",
            "install",
            "pip install -e .".to_string(),
        ));
        return;
    }
    if repo.join("requirements.txt").exists() {
        out.push(Task::new(
            "requirements.txt",
            "install",
            "pip install -r requirements.txt".to_string(),
        ));
    }
}

fn dotnet_tasks(repo: &Path, out: &mut Vec<Task>) {
    let has_project = std::fs::read_dir(repo)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                name.ends_with(".sln") || name.ends_with(".csproj")
            })
        })
        .unwrap_or(false);
    if !has_project {
        return;
    }
    for (name, command) in [
        ("build", "dotnet build"),
        ("run", "dotnet run"),
        ("test", "dotnet test"),
    ] {
        out.push(Task::new("dotnet", name, command.to_string()));
    }
}

fn cmake_tasks(repo: &Path, out: &mut Vec<Task>) {
    if !repo.join("CMakeLists.txt").exists() {
        return;
    }
    out.push(Task::new(
        "CMakeLists.txt",
        "configure",
        "cmake -B build".to_string(),
    ));
    out.push(Task::new(
        "CMakeLists.txt",
        "build",
        "cmake --build build".to_string(),
    ));
}

/// Unity has no command worth guessing, so the task records the version instead
/// and the row exists to say what the project is.
fn unity_tasks(repo: &Path, out: &mut Vec<Task>) {
    let Some(contents) = read(repo, "ProjectSettings/ProjectVersion.txt") else {
        return;
    };
    let version = contents
        .lines()
        .find_map(|line| line.strip_prefix("m_EditorVersion:"))
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    out.push(Task::new(
        "unity",
        &format!("Unity {version}"),
        format!("# Unity project, editor {version}"),
    ));
}

fn compose_tasks(repo: &Path, out: &mut Vec<Task>) {
    let present = ["docker-compose.yml", "docker-compose.yaml", "compose.yml"]
        .iter()
        .any(|name| repo.join(name).exists());
    if !present {
        return;
    }
    out.push(Task::new("compose", "up", "docker compose up".to_string()));
    out.push(Task::new(
        "compose",
        "down",
        "docker compose down".to_string(),
    ));
}
