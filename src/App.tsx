import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FleetSidebar from "./components/FleetSidebar";
import TerminalPane, { sendCommand } from "./components/TerminalPane";
import TaskList from "./components/TaskList";
import CommandPalette, { type PaletteItem } from "./components/CommandPalette";
import { api } from "./lib/api";
import { relativeTime, type AppInfo, type RepoState, type Task } from "./lib/types";

interface Confirmation {
  title: string;
  body: string;
  command: string;
  confirmLabel: string;
}

export default function App() {
  const [repos, setRepos] = useState<RepoState[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [live, setLive] = useState<Set<string>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const selected = useMemo(
    () => repos.find((r) => r.path === selectedPath) ?? null,
    [repos, selectedPath],
  );

  const upsert = useCallback((repo: RepoState) => {
    setRepos((current) => {
      const index = current.findIndex((r) => r.path === repo.path);
      if (index === -1) return [...current, repo];
      const next = [...current];
      next[index] = repo;
      return next;
    });
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setScanned(0);
    try {
      await api.fleetScan((repo) => {
        upsert(repo);
        setScanned((n) => n + 1);
      });
    } catch (err) {
      setNote(String(err));
    } finally {
      setScanning(false);
    }
  }, [upsert]);

  // Cache first, so the list is on screen before anything is opened.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cached, appInfo] = await Promise.all([api.fleetCached(), api.appInfo()]);
        if (cancelled) return;
        setRepos(cached);
        setInfo(appInfo);
        const liveIds = await api.ptyLive();
        if (!cancelled) setLive(new Set(liveIds));
      } catch (err) {
        if (!cancelled) setNote(String(err));
      }
      if (!cancelled) await scan();
    })();
    return () => {
      cancelled = true;
    };
  }, [scan]);

  useEffect(() => {
    if (!selectedPath) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    api
      .repoTasks(selectedPath)
      .then((found) => {
        if (!cancelled) setTasks(found);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") setConfirmation(null);
    }
    // The terminal lets Ctrl+K through to here rather than handling it itself,
    // see attachCustomKeyEventHandler in TerminalPane.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!note) return;
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 6000);
  }, [note]);

  const refreshRepo = useCallback(
    (path: string) => {
      api.repoRefresh(path).then(upsert).catch(() => undefined);
    },
    [upsert],
  );

  const onLiveChange = useCallback((path: string, isLive: boolean) => {
    setLive((current) => {
      const next = new Set(current);
      if (isLive) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  /**
   * Every action in the app goes through here, so the command is always visible
   * in the terminal rather than happening behind the UI. Holding shift types it
   * without running it.
   */
  const emit = useCallback(
    async (command: string, typeOnly = false) => {
      if (!selectedPath) return;
      if (typeOnly) await api.ptyWrite(selectedPath, command);
      else await sendCommand(selectedPath, command);
    },
    [selectedPath],
  );

  const syncCommand = "git fetch --prune; git pull --ff-only";

  function pruneCommand(repo: RepoState): string {
    return `git branch -d ${repo.mergedBranches.join(" ")}`;
  }

  async function fetchAll() {
    setNote("Fetching every repository…");
    const targets = repos.filter((r) => !r.error && r.remoteUrl);
    for (const repo of targets) {
      await api.gitRun(repo.path, ["fetch", "--prune", "--quiet"]).catch(() => undefined);
      refreshRepo(repo.path);
    }
    setNote(`Fetched ${targets.length} repositories.`);
  }

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    for (const repo of repos) {
      items.push({
        id: `repo:${repo.path}`,
        label: repo.name,
        kind: "repo",
        hint: repo.branch ?? "",
        run: () => setSelectedPath(repo.path),
      });
    }

    if (selected) {
      for (const task of tasks) {
        items.push({
          id: `task:${task.id}`,
          label: `${selected.name} · ${task.name}`,
          kind: "task",
          hint: task.command,
          run: () => emit(task.command),
        });
      }
      items.push({
        id: "action:sync",
        label: `Sync ${selected.name}`,
        kind: "git",
        hint: syncCommand,
        run: () => emit(syncCommand),
      });
      if (selected.mergedBranches.length > 0) {
        items.push({
          id: "action:prune",
          label: `Prune ${selected.mergedBranches.length} merged branches`,
          kind: "git",
          hint: pruneCommand(selected),
          run: () =>
            setConfirmation({
              title: `Delete ${selected.mergedBranches.length} merged branches`,
              body: `Every branch listed is already contained in ${selected.defaultBranch ?? "the default branch"}. git branch -d refuses anything unmerged, and the output prints each deleted branch's commit so it can be recreated.`,
              command: pruneCommand(selected),
              confirmLabel: "Delete branches",
            }),
        });
      }
    }

    items.push({
      id: "action:fetch-all",
      label: "Fetch every repository",
      kind: "fleet",
      hint: "git fetch --prune in each",
      run: fetchAll,
    });
    items.push({
      id: "action:rescan",
      label: "Rescan the fleet",
      kind: "fleet",
      run: scan,
    });

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, tasks, selected, emit, scan]);

  const dirty = selected ? selected.staged + selected.modified : 0;

  return (
    <div className="app">
      <FleetSidebar
        repos={repos}
        selectedPath={selectedPath}
        liveSessions={live}
        query={query}
        scanning={scanning}
        onQuery={setQuery}
        onSelect={setSelectedPath}
      />

      <main className="main">
        {selected ? (
          <>
            <header className="repo-head">
              <div className="repo-title">
                <h1>{selected.name}</h1>
                <span className="path">
                  {selected.branch ?? "no commits"}
                  {selected.ahead > 0 && ` ↑${selected.ahead}`}
                  {selected.behind > 0 && ` ↓${selected.behind}`}
                  {dirty > 0 && ` · ${dirty} changed`}
                  {selected.lastCommitAt && ` · ${relativeTime(selected.lastCommitAt)}`}
                </span>
              </div>

              <div className="head-actions">
                <button
                  className="btn"
                  title={`${syncCommand}\n\nShift-click to type it without running it.`}
                  onClick={(e) => emit(syncCommand, e.shiftKey)}
                >
                  Sync
                </button>
                <button
                  className="btn"
                  disabled={selected.mergedBranches.length === 0}
                  title={
                    selected.mergedBranches.length > 0
                      ? pruneCommand(selected)
                      : "No merged branches to delete"
                  }
                  onClick={() =>
                    setConfirmation({
                      title: `Delete ${selected.mergedBranches.length} merged branches`,
                      body: `Every branch listed is already contained in ${selected.defaultBranch ?? "the default branch"}. git branch -d refuses anything unmerged, and the output prints each deleted branch's commit so it can be recreated.`,
                      command: pruneCommand(selected),
                      confirmLabel: "Delete branches",
                    })
                  }
                >
                  Prune merged
                  {selected.mergedBranches.length > 0 && ` (${selected.mergedBranches.length})`}
                </button>
                <button
                  className="btn"
                  title="Re-read this repository"
                  onClick={() => refreshRepo(selected.path)}
                >
                  Refresh
                </button>
                <button className="btn accent" onClick={() => setPaletteOpen(true)}>
                  ⌘K
                </button>
              </div>
            </header>

            <div className="panes">
              <TerminalPane
                repoPath={selected.path}
                onSettled={refreshRepo}
                onLiveChange={onLiveChange}
              />
              <TaskList
                tasks={tasks}
                disabled={!live.has(selected.path)}
                onRun={(task) => emit(task.command)}
              />
            </div>
          </>
        ) : (
          <div className="panes">
            <div className="terminal-pane">
              <div className="pane-tab-bar">terminal</div>
              <p className="empty">
                {repos.length === 0 && scanning
                  ? "Scanning the roots…"
                  : "Pick a repository on the left, or press Ctrl+K."}
              </p>
            </div>
            <TaskList tasks={[]} disabled onRun={() => undefined} />
          </div>
        )}
      </main>

      <div className="status-bar">
        <span>{repos.length} repos</span>
        {scanning && <span style={{ color: "var(--accent)" }}>scanning {scanned}</span>}
        {live.size > 0 && <span style={{ color: "var(--green)" }}>{live.size} shells</span>}
        {note && <span style={{ color: "var(--amber)" }}>{note}</span>}
        <span className="spacer" />
        {info?.gitVersion && <span>{info.gitVersion}</span>}
        {info && <span>{info.shell.split(/[\\/]/).pop()}</span>}
        <span>
          <kbd>Ctrl</kbd> <kbd>K</kbd>
        </span>
      </div>

      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      )}

      {confirmation && (
        <div className="confirm-backdrop" onMouseDown={() => setConfirmation(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{confirmation.title}</h2>
            <p>{confirmation.body}</p>
            <pre>{confirmation.command}</pre>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmation(null)}>
                Cancel
              </button>
              <button
                className="btn accent"
                onClick={() => {
                  emit(confirmation.command);
                  setConfirmation(null);
                }}
              >
                {confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
