---
paths:
  - "src-tauri/src/diff.rs"
  - "src-tauri/src/history.rs"
  - "src-tauri/src/graph.rs"
  - "src-tauri/src/blame.rs"
  - "src/components/BranchGraph.tsx"
  - "src/components/HistoryPane.tsx"
  - "src/components/DiffPane.tsx"
  - "src/components/DiffHunks.tsx"
  - "src/components/CommitFilesPane.tsx"
  - "src/components/ImageDiff.tsx"
---

# History, graph and diff

Loaded when Claude touches the branch graph, the commit history, blame, or the diff.

| Rule | Why |
| --- | --- |
| A diff is read without a pathspec, and capped at 6000 rows | Rename detection pairs a delete with an add, and a pathspec drops one half of the pair before `find_similar` sees it, so a renamed file arrives as a whole-file delete. The cap stands in for virtualisation: 6000 rows of plain DOM paint in 695 ms, and past it the pane names the `git diff` that has the rest |
| The commit history packs its lanes in Rust and walks from the top for every page | A lane depends on every commit newer than it, so a page starting in the middle has nothing to work from. Walking oids is cheap and reading a commit's text is not, so the walk runs whole and only the rows asked for are read: 140 ms a page over 5,500 commits, and the same 140 ms whichever page |
| A lane colour is never `--red` or `--amber` | Those already mean a failed command and a repository wanting attention. A trunk that lands in either reads as a warning it is not, so the history has `--lane-1` to `--lane-6` of its own |
| A read that depends on the refs keys on `refSignature`, never on HEAD alone and never on `scannedAt` | HEAD's branch and counts miss a prune, and `scannedAt` redraws for nothing. The string holds every local tip, so a branch deleted, created or reset reaches the graph, the squash detection and the history, and a refresh that changed nothing leaves all three alone. The Refresh button bumps an epoch inside it, which is how tags and remote refs get re-read at all |
