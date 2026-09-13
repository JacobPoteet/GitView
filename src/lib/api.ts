import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AppInfo,
  BranchGraph,
  FileChange,
  FileDiff,
  History,
  GitOutcome,
  Inbox,
  RepoPref,
  RepoState,
  ScanReport,
  Squashed,
  Task,
  UpdateCheck,
} from "./types";

export const api = {
  fleetCached: () => invoke<RepoState[]>("fleet_cached"),

  /** Streams one repo at a time so the list fills as the scan runs. */
  fleetScan: (onRepo: (repo: RepoState) => void) => {
    const channel = new Channel<RepoState>();
    channel.onmessage = onRepo;
    return invoke<ScanReport>("fleet_scan", { onRepo: channel });
  },

  repoRefresh: (path: string) => invoke<RepoState>("repo_refresh", { path }),
  repoTasks: (path: string) => invoke<Task[]>("repo_tasks", { path }),
  repoGraph: (path: string) => invoke<BranchGraph>("repo_graph", { path }),
  /**
   * Local branches that were squash-merged, and the commit each one became.
   * Read for the open repository, not in the sweep: see squash.rs.
   */
  repoSquashed: (path: string) => invoke<Squashed[]>("repo_squashed", { path }),
  repoChanges: (path: string) => invoke<FileChange[]>("repo_changes", { path }),
  /** One page of the whole DAG. Lanes come packed, see history.rs. */
  repoHistory: (path: string, offset: number, limit: number) =>
    invoke<History>("repo_history", { path, offset, limit }),
  /** One file, on one side of the index. Read per file, not per working tree. */
  repoDiff: (path: string, file: string, staged: boolean) =>
    invoke<FileDiff>("repo_diff", { path, file, staged }),

  repoPrefs: () => invoke<RepoPref[]>("repo_prefs"),
  repoSetHidden: (path: string, hidden: boolean) =>
    invoke<void>("repo_set_hidden", { path, hidden }),
  repoSetPinned: (path: string, pinned: boolean) =>
    invoke<void>("repo_set_pinned", { path, pinned }),
  /** The pinned group in the order it is now drawn, whole rather than as a move. */
  repoReorderPins: (paths: string[]) => invoke<void>("repo_reorder_pins", { paths }),
  taskSetHidden: (repoPath: string, taskId: string, hidden: boolean) =>
    invoke<void>("task_set_hidden", { repoPath, taskId, hidden }),

  taskSave: (repoPath: string, name: string, command: string) =>
    invoke<Task>("task_save", { repoPath, name, command }),
  taskDelete: (id: string) => invoke<void>("task_delete", { id }),

  /** The inbox as last read, so the pane paints before gh is asked anything. */
  githubCached: () => invoke<Inbox | null>("github_cached"),
  /** One GraphQL request for the whole fleet, through the gh CLI. */
  githubRefresh: () => invoke<Inbox>("github_refresh"),
  /**
   * Writes a new issue's body out under GitView's data folder and hands back
   * the path, which is the argument the typed `gh issue create` needs. Only a
   * body with a newline in it goes through here; a one-liner is quoted inline.
   */
  githubIssueBody: (ownerRepo: string, title: string, body: string) =>
    invoke<string>("github_issue_body", { ownerRepo, title, body }),

  /** The latest release, read through gh. One call, at launch. */
  updateCheck: () => invoke<UpdateCheck>("update_check"),

  /**
   * Writes one hunk out as a patch under GitView's data folder and hands back
   * the path, which is the argument the typed `git apply` needs.
   */
  diffHunkPatch: (
    path: string,
    file: string,
    staged: boolean,
    hunkIndex: number,
    header: string,
  ) => invoke<string>("diff_hunk_patch", { path, file, staged, hunkIndex, header }),

  gitRun: (path: string, args: string[]) =>
    invoke<GitOutcome>("git_run", { path, args }),

  ptyOpen: (
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    onOutput: (chunk: string) => void,
  ) => {
    const channel = new Channel<string>();
    channel.onmessage = onOutput;
    return invoke<boolean>("pty_open", { id, cwd, cols, rows, onOutput: channel });
  },
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
  /** Whether the shell behind a session is still running. */
  ptyAlive: (id: string) => invoke<boolean>("pty_alive", { id }),
  ptyLive: () => invoke<string[]>("pty_live"),

  settingsRoots: () => invoke<string[]>("settings_roots"),
  settingsSetRoots: (roots: string[]) => invoke<void>("settings_set_roots", { roots }),
  settingsAddRoot: (path: string) => invoke<string[]>("settings_add_root", { path }),
  settingsRemoveRoot: (path: string) => invoke<string[]>("settings_remove_root", { path }),
  appInfo: () => invoke<AppInfo>("app_info"),
  /** The clipboard's text, read in Rust so WebView2 never asks permission. */
  clipboardText: () => invoke<string>("clipboard_text"),
};
