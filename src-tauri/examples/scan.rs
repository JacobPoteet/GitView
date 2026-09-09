//! Headless check on the fleet scanner.
//!
//! Prints what the sidebar would show, without starting a window:
//!
//! ```text
//! cargo run --example scan -- F:\GitHub
//! ```

use std::time::Instant;

use gitview_lib::fleet;

fn main() {
    let roots: Vec<String> = std::env::args().skip(1).collect();
    if roots.is_empty() {
        eprintln!("usage: cargo run --example scan -- <root> [root...]");
        std::process::exit(2);
    }

    let started = Instant::now();
    let paths = fleet::discover(&roots);
    println!(
        "found {} repositories in {:?}\n",
        paths.len(),
        started.elapsed()
    );

    println!(
        "{:<26} {:<28} {:>5} {:>5} {:>6} {:>7}  {}",
        "REPO", "BRANCH", "AHEAD", "BEHIND", "DIRTY", "MERGED", "REMOTE"
    );

    let mut total = std::time::Duration::ZERO;
    for path in &paths {
        let one = Instant::now();
        let state = fleet::read_repo(path);
        let elapsed = one.elapsed();
        total += elapsed;

        println!(
            "{:<26} {:<28} {:>5} {:>5} {:>6} {:>7}  {} ({:?})",
            truncate(&state.name, 26),
            truncate(&state.branch.clone().unwrap_or_else(|| "-".to_string()), 28),
            state.ahead,
            state.behind,
            state.staged + state.modified,
            state.merged_branches.len(),
            state.owner_repo.clone().unwrap_or_else(|| "-".to_string()),
            elapsed
        );

        if let Some(err) = &state.error {
            println!("    error: {err}");
        }
    }

    println!("\nscan total {total:?}, wall {:?}", started.elapsed());
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        text.to_string()
    } else {
        text.chars().take(width - 1).chain(['…']).collect()
    }
}
