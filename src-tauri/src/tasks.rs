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
    /// A personal note, set by hand and shown as a tooltip. Never written into
    /// the manifest: it is GitView's own record of what a task is for, not the
    /// project's, so it stays out of a `git diff` nobody else asked for.
    #[serde(default)]
    pub description: Option<String>,
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
            description: None,
        }
    }
}

pub fn discover(repo: &Path) -> Vec<Task> {
    let mut tasks = Vec::new();

    gitview_tasks(repo, &mut tasks);
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

/// A tool-independent manifest for the one case none of the others cover: a bespoke script
/// with no `package.json` or `Makefile` to live in. Checked in, so the task travels with the
/// repository through git rather than staying a saved row on whichever machine typed it first.
/// Other tables and keys are ignored, and a file that is not valid TOML proposes nothing rather
/// than failing discovery for the whole repository.
///
/// ```toml
/// [[task]]
/// name = "install"
/// command = "powershell -ExecutionPolicy Bypass -File tools/install-local.ps1"
/// ```
fn gitview_tasks(repo: &Path, out: &mut Vec<Task>) {
    let Some(contents) = read(repo, "gitview.toml") else {
        return;
    };
    let Ok(manifest) = toml::from_str::<Manifest>(&contents) else {
        return;
    };
    for entry in manifest.task {
        // A `'''` command keeps the newline before its closing quotes; the terminal adds its own.
        if let (Some(name), Some(command)) = (entry.name, entry.command) {
            out.push(Task::new("gitview.toml", &name, command.trim().to_string()));
        }
    }
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    task: Vec<ManifestTask>,
}

/// Both keys optional, so an entry missing one is skipped instead of failing the file.
#[derive(Deserialize)]
struct ManifestTask {
    name: Option<String>,
    command: Option<String>,
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

/// A project at the root takes the bare commands. A solution root builds and tests bare too, but
/// `dotnet run` there finds no project and fails, so each runnable project the solution lists gets
/// a `dotnet run --project` of its own. `dotnet build` refuses a folder holding two solutions, so
/// with more than one at the root every command names its solution.
fn dotnet_tasks(repo: &Path, out: &mut Vec<Task>) {
    let mut solutions = Vec::new();
    let mut has_csproj = false;
    for entry in std::fs::read_dir(repo).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower.ends_with(".csproj") {
            has_csproj = true;
        } else if lower.ends_with(".sln") {
            solutions.push(name);
        }
    }

    if has_csproj {
        for (name, command) in [
            ("build", "dotnet build"),
            ("run", "dotnet run"),
            ("test", "dotnet test"),
        ] {
            out.push(Task::new("dotnet", name, command.to_string()));
        }
        return;
    }

    // `read_dir` promises no order, and the list should not reshuffle between scans.
    solutions.sort();
    if let [_] = solutions.as_slice() {
        out.push(Task::new("dotnet", "build", "dotnet build".to_string()));
        out.push(Task::new("dotnet", "test", "dotnet test".to_string()));
    } else {
        for solution in &solutions {
            let stem = file_stem(solution);
            let arg = shell_arg(solution);
            out.push(Task::new(
                "dotnet",
                &format!("build {stem}"),
                format!("dotnet build {arg}"),
            ));
            out.push(Task::new(
                "dotnet",
                &format!("test {stem}"),
                format!("dotnet test {arg}"),
            ));
        }
    }

    for solution in &solutions {
        let Some(contents) = read(repo, solution) else {
            continue;
        };
        for project in solution_projects(&contents) {
            let name = format!("run {}", file_stem(&project));
            // Two solutions often list the same project.
            if out.iter().any(|task| task.id == format!("dotnet:{name}")) {
                continue;
            }
            if !read(repo, &project).is_some_and(|csproj| runnable(&csproj)) {
                continue;
            }
            let command = format!("dotnet run --project {}", shell_arg(&project));
            out.push(Task::new("dotnet", &name, command));
        }
    }
}

/// The `.csproj` paths a solution lists, with forward slashes. Each project line reads
/// `Project("{type}") = "Name", "path\to\Name.csproj", "{guid}"`; a solution folder has the same
/// shape with its name for a path, so it falls out on the extension.
fn solution_projects(solution: &str) -> Vec<String> {
    solution
        .lines()
        .filter(|line| line.trim_start().starts_with("Project("))
        .filter_map(|line| {
            let (_, rest) = line.split_once('=')?;
            let path = rest.split('"').nth(3)?;
            path.to_lowercase()
                .ends_with(".csproj")
                .then(|| path.replace('\\', "/"))
        })
        .collect()
}

/// An `Exe` or `WinExe` that is not a test project. A test project can be an `Exe` too, since
/// the newer test runners build one, but `dotnet test` is how it runs.
fn runnable(csproj: &str) -> bool {
    let text: String = csproj.to_lowercase().split_whitespace().collect();
    let executable = text.contains("<outputtype>exe</outputtype>")
        || text.contains("<outputtype>winexe</outputtype>");
    let test = text.contains("microsoft.net.test.sdk")
        || text.contains("<istestproject>true</istestproject>");
    executable && !test
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Quoted when it holds a space, so the terminal passes it as one argument.
fn shell_arg(value: &str) -> String {
    if value.contains(' ') {
        format!("\"{value}\"")
    } else {
        value.to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gitview-tasks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn gitview_toml_proposes_each_task() {
        let dir = scratch_dir("basic");
        std::fs::write(
            dir.join("gitview.toml"),
            "[[task]]\nname = \"install\"\ncommand = \"powershell -File tools/install-local.ps1\"\n\n[[task]]\nname = \"lint\"\ncommand = \"npm run lint\"\n",
        )
        .unwrap();

        let mut out = Vec::new();
        gitview_tasks(&dir, &mut out);

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "gitview.toml:install");
        assert_eq!(out[0].command, "powershell -File tools/install-local.ps1");
        assert_eq!(out[1].name, "lint");
        assert_eq!(out[1].command, "npm run lint");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A task missing either key contributes nothing rather than a half-built row.
    #[test]
    fn a_task_needs_both_a_name_and_a_command() {
        let dir = scratch_dir("incomplete");
        std::fs::write(dir.join("gitview.toml"), "[[task]]\nname = \"orphan\"\n").unwrap();

        let mut out = Vec::new();
        gitview_tasks(&dir, &mut out);

        assert!(out.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_escaped_quote_survives_parsing() {
        let dir = scratch_dir("escaped");
        std::fs::write(
            dir.join("gitview.toml"),
            "[[task]]\nname = \"greet\"\ncommand = \"echo \\\"hello\\\"\"\n",
        )
        .unwrap();

        let mut out = Vec::new();
        gitview_tasks(&dir, &mut out);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "echo \"hello\"");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tasks_from(name: &str, manifest: &str) -> Vec<Task> {
        let dir = scratch_dir(name);
        std::fs::write(dir.join("gitview.toml"), manifest).unwrap();
        let mut out = Vec::new();
        gitview_tasks(&dir, &mut out);
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    /// The hand-rolled scanner read `"build" # why` as a value that was not a string, and
    /// dropped the task without a word.
    #[test]
    fn a_trailing_comment_keeps_the_task() {
        let out = tasks_from(
            "comment",
            "[[task]]\nname = \"build\" # the release build\ncommand = \"npm run build\" # slow\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "build");
        assert_eq!(out[0].command, "npm run build");
    }

    /// A literal string, the natural way to write a Windows path without doubling backslashes.
    #[test]
    fn a_single_quoted_string_is_read_literally() {
        let out = tasks_from(
            "literal",
            "[[task]]\nname = 'install'\ncommand = 'powershell -File tools\\install.ps1'\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "install");
        assert_eq!(out[0].command, "powershell -File tools\\install.ps1");
    }

    #[test]
    fn a_multi_line_literal_command_is_read_whole() {
        let out = tasks_from(
            "multiline",
            "[[task]]\nname = \"release\"\ncommand = '''\nnpm run build && npm run package\n'''\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "npm run build && npm run package");
    }

    #[test]
    fn other_tables_and_keys_are_ignored() {
        let out = tasks_from(
            "other",
            "title = \"tools\"\n\n[settings]\nshell = \"pwsh\"\n\n[[task]]\nname = \"lint\"\ncommand = \"npm run lint\"\ncwd = \"web\"\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "gitview.toml:lint");
    }

    #[test]
    fn an_unparseable_manifest_proposes_nothing() {
        let out = tasks_from(
            "broken",
            "[[task]]\nname = \"build\ncommand = \"npm run build\"\n",
        );
        assert!(out.is_empty());
    }

    fn write(dir: &std::path::Path, path: &str, contents: &str) {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn solution(projects: &[(&str, &str)]) -> String {
        let mut text = String::from(
            "Microsoft Visual Studio Solution File, Format Version 12.00\n\
             Project(\"{2150E333-8FDC-42A3-9474-1A3956D46DE8}\") = \"src\", \"src\", \"{827E0CD3-B72D-47B6-A68D-7590B98EB39B}\"\n\
             EndProject\n",
        );
        for (name, path) in projects {
            text.push_str(&format!(
                "Project(\"{{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}}\") = \"{name}\", \"{path}\", \"{{F42E50EA-3413-459D-B4C2-1433521EEDD0}}\"\r\nEndProject\r\n"
            ));
        }
        text
    }

    const EXE: &str = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n  </PropertyGroup>\n</Project>\n";
    const WINEXE: &str = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <OutputType>WinExe</OutputType>\n  </PropertyGroup>\n</Project>\n";
    const LIBRARY: &str = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n";
    const TESTS: &str = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <IsTestProject>true</IsTestProject>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include=\"Microsoft.NET.Test.Sdk\" Version=\"17.8.0\" />\n  </ItemGroup>\n</Project>\n";

    fn dotnet_from(dir: &std::path::Path) -> Vec<(String, String)> {
        let mut out = Vec::new();
        dotnet_tasks(dir, &mut out);
        out.into_iter()
            .map(|task| (task.id, task.command))
            .collect()
    }

    fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
        expected
            .iter()
            .map(|(id, command)| (id.to_string(), command.to_string()))
            .collect()
    }

    /// ShrinkRay's layout: a bare `dotnet run` at its root failed with "Couldn't find a project
    /// to run". The library and the test project, an `Exe` itself, get no run task.
    #[test]
    fn a_solution_root_runs_each_runnable_project() {
        let dir = scratch_dir("dotnet-solution");
        write(
            &dir,
            "Fleet.sln",
            &solution(&[
                ("Fleet.Core", "src\\Fleet.Core\\Fleet.Core.csproj"),
                ("Fleet.Cli", "src\\Fleet.Cli\\Fleet.Cli.csproj"),
                ("Fleet.Tests", "tests\\Fleet.Tests\\Fleet.Tests.csproj"),
                ("Fleet.Desk", "src\\Fleet Desk\\Fleet.Desk.csproj"),
            ]),
        );
        write(&dir, "src/Fleet.Core/Fleet.Core.csproj", LIBRARY);
        write(&dir, "src/Fleet.Cli/Fleet.Cli.csproj", EXE);
        write(&dir, "tests/Fleet.Tests/Fleet.Tests.csproj", TESTS);
        write(&dir, "src/Fleet Desk/Fleet.Desk.csproj", WINEXE);

        assert_eq!(
            dotnet_from(&dir),
            pairs(&[
                ("dotnet:build", "dotnet build"),
                ("dotnet:test", "dotnet test"),
                (
                    "dotnet:run Fleet.Cli",
                    "dotnet run --project src/Fleet.Cli/Fleet.Cli.csproj"
                ),
                (
                    "dotnet:run Fleet.Desk",
                    "dotnet run --project \"src/Fleet Desk/Fleet.Desk.csproj\""
                ),
            ])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A project at the root keeps the bare commands, solution or not.
    #[test]
    fn a_root_project_keeps_the_bare_commands() {
        let dir = scratch_dir("dotnet-project");
        write(&dir, "Tool.csproj", EXE);
        write(&dir, "Tool.sln", &solution(&[("Tool", "Tool.csproj")]));

        assert_eq!(
            dotnet_from(&dir),
            pairs(&[
                ("dotnet:build", "dotnet build"),
                ("dotnet:run", "dotnet run"),
                ("dotnet:test", "dotnet test"),
            ])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Bare `dotnet build` stops at MSB1011 when the folder holds two solutions, so each command
    /// names one. A project both solutions list gets one run task.
    #[test]
    fn several_solutions_are_each_named() {
        let dir = scratch_dir("dotnet-solutions");
        write(
            &dir,
            "Full.sln",
            &solution(&[
                ("App", "src\\App\\App.csproj"),
                ("Server", "src\\Server\\Server.csproj"),
            ]),
        );
        write(
            &dir,
            "App.sln",
            &solution(&[("App", "src\\App\\App.csproj")]),
        );
        write(&dir, "src/App/App.csproj", WINEXE);
        write(&dir, "src/Server/Server.csproj", EXE);

        assert_eq!(
            dotnet_from(&dir),
            pairs(&[
                ("dotnet:build App", "dotnet build App.sln"),
                ("dotnet:test App", "dotnet test App.sln"),
                ("dotnet:build Full", "dotnet build Full.sln"),
                ("dotnet:test Full", "dotnet test Full.sln"),
                ("dotnet:run App", "dotnet run --project src/App/App.csproj"),
                (
                    "dotnet:run Server",
                    "dotnet run --project src/Server/Server.csproj"
                ),
            ])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_dotnet_files_proposes_nothing() {
        let dir = scratch_dir("dotnet-absent");
        write(&dir, "README.md", "# nothing here\n");
        assert!(dotnet_from(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_manifest_proposes_nothing() {
        let dir = scratch_dir("absent");
        let mut out = Vec::new();
        gitview_tasks(&dir, &mut out);
        assert!(out.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
