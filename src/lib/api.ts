import { invoke, Channel } from "@tauri-apps/api/core";
import type { AppInfo, GitOutcome, RepoState, Task } from "./types";

export const api = {
  fleetCached: () => invoke<RepoState[]>("fleet_cached"),

  /** Streams one repo at a time so the list fills as the scan runs. */
  fleetScan: (onRepo: (repo: RepoState) => void) => {
    const channel = new Channel<RepoState>();
    channel.onmessage = onRepo;
    return invoke<number>("fleet_scan", { onRepo: channel });
  },

  repoRefresh: (path: string) => invoke<RepoState>("repo_refresh", { path }),
  repoTasks: (path: string) => invoke<Task[]>("repo_tasks", { path }),

  taskSave: (repoPath: string, name: string, command: string) =>
    invoke<Task>("task_save", { repoPath, name, command }),
  taskDelete: (id: string) => invoke<void>("task_delete", { id }),

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
  ptyLive: () => invoke<string[]>("pty_live"),

  settingsRoots: () => invoke<string[]>("settings_roots"),
  settingsSetRoots: (roots: string[]) => invoke<void>("settings_set_roots", { roots }),
  appInfo: () => invoke<AppInfo>("app_info"),
};
