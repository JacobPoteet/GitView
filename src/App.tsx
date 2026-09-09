import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FleetSidebar from "./components/FleetSidebar";
import TerminalPane, { sendCommand } from "./components/TerminalPane";
import TaskList from "./components/TaskList";
import BranchGraph from "./components/BranchGraph";
import RootsDialog from "./components/RootsDialog";
import CommandPalette, { type PaletteItem } from "./components/CommandPalette";
import { api } from "./lib/api";
import {
  relativeTime,
  type AppInfo,
  type BranchGraph as Graph,
  type RepoPref,
  type RepoState,
  type Task,
} from "./lib/types";

interface Confirmation {
  title: string;
  body: string;
  command: string;
  confirmLabel: string;
}

const GRAPH_KEY = "gitview.graph.collapsed";

export default function App() {
  const [repos, setRepos] = useState<RepoState[]>([]);
  const [prefs, setPrefs] = useState<Map<string, RepoPref>>(new Map());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [graphCollapsed, setGraphCollapsed] = useState(
    () => localStorage.getItem(GRAPH_KEY) === "1",
  );
  const [roots, setRoots] = useState<string[]>([]);
  const [rootsOpen, setRootsOpen] = useState(false);
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

  const loadPrefs = useCallback(async () => {
    try {
      const rows = await api.repoPrefs();
      setPrefs(new Map(rows.map((row) => [row.path, row])));
    } catch {
      // A missing preference is a cosmetic loss, not a reason to blank the fleet.
    }
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setScanned(0);
    try {
      const seen = new Set<string>();
      await api.fleetScan((repo) => {
        seen.add(repo.path);
        upsert(repo);
        setScanned((n) => n + 1);
      });
      // The stream only adds and updates, so a repository that has gone away
      // stays on screen until this runs. Removing a watched folder made that
      // obvious: the rows behind it kept their place until the next launch.
      // Pruning only after the scan resolves keeps a failed sweep from emptying
      // the list.
      setRepos((current) => current.filter((repo) => seen.has(repo.path)));
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
        setRoots(appInfo.roots);
        await loadPrefs();
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
  }, [scan, loadPrefs]);

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

  // The graph is cheap enough to read fresh, and it has to move the moment HEAD
  // does. Keying on the branch and its counts rather than on `scannedAt` keeps a
  // refresh that changed nothing from redrawing the strip.
  const headSignature = selected
    ? `${selected.branch}|${selected.lastCommitAt}|${selected.ahead}|${selected.behind}`
    : "";

  useEffect(() => {
    if (!selectedPath) {
      setGraph(null);
      return;
    }
    let cancelled = false;
    api
      .repoGraph(selectedPath)
      .then((found) => {
        if (!cancelled) setGraph(found);
      })
      .catch(() => {
        if (!cancelled) setGraph(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, headSignature]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setConfirmation(null);
        setRootsOpen(false);
      }
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

  const toggleGraph = useCallback(() => {
    setGraphCollapsed((collapsed) => {
      localStorage.setItem(GRAPH_KEY, collapsed ? "0" : "1");
      return !collapsed;
    });
  }, []);

  const setPinned = useCallback(
    async (path: string, pinned: boolean) => {
      await api.repoSetPinned(path, pinned).catch((err) => setNote(String(err)));
      await loadPrefs();
    },
    [loadPrefs],
  );

  const setHidden = useCallback(
    async (path: string, hidden: boolean) => {
      await api.repoSetHidden(path, hidden).catch((err) => setNote(String(err)));
      await loadPrefs();
      // Leaving a hidden repository open would keep a shell attached to something
      // the list no longer shows, with no obvious way back to it.
      if (hidden && path === selectedPath) setSelectedPath(null);
    },
    [loadPrefs, selectedPath],
  );

  const setTaskHidden = useCallback(
    async (task: Task, hidden: boolean) => {
      if (!selectedPath) return;
      setTasks((current) =>
        current.map((t) => (t.id === task.id ? { ...t, hidden } : t)),
      );
      await api.taskSetHidden(selectedPath, task.id, hidden).catch((err) => setNote(String(err)));
    },
    [selectedPath],
  );

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
    // A hidden repository is one the user has said they are not thinking about,
    // so it stays out of the fleet-wide sweep too.
    const targets = repos.filter(
      (r) => !r.error && r.remoteUrl && !prefs.get(r.path)?.hidden,
    );
    for (const repo of targets) {
      await api.gitRun(repo.path, ["fetch", "--prune", "--quiet"]).catch(() => undefined);
      refreshRepo(repo.path);
    }
    setNote(`Fetched ${targets.length} repositories.`);
  }

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    for (const repo of repos) {
      if (prefs.get(repo.path)?.hidden) continue;
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
        if (task.hidden) continue;
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

      const pinned = prefs.get(selected.path)?.pinnedAt != null;
      items.push({
        id: "action:pin",
        label: `${pinned ? "Unpin" : "Pin"} ${selected.name}`,
        kind: "fleet",
        hint: pinned ? "back to the sorted list" : "hold a position at the top",
        run: () => setPinned(selected.path, !pinned),
      });
      items.push({
        id: "action:hide",
        label: `Hide ${selected.name}`,
        kind: "fleet",
        hint: "out of the list and out of this palette",
        run: () => setHidden(selected.path, true),
      });
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
    items.push({
      id: "action:roots",
      label: "Watched folders",
      kind: "fleet",
      hint: "add or remove a folder GitView scans",
      run: () => setRootsOpen(true),
    });

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, prefs, tasks, selected, emit, scan, setPinned, setHidden]);

  const dirty = selected ? selected.staged + selected.modified : 0;
  const hiddenCount = useMemo(
    () => repos.filter((r) => prefs.get(r.path)?.hidden).length,
    [repos, prefs],
  );

  return (
    <div className="app">
      <FleetSidebar
        repos={repos}
        prefs={prefs}
        selectedPath={selectedPath}
        liveSessions={live}
        query={query}
        scanning={scanning}
        onQuery={setQuery}
        onSelect={setSelectedPath}
        onPin={setPinned}
        onHide={setHidden}
        onManageRoots={() => setRootsOpen(true)}
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

            <BranchGraph
              graph={graph}
              collapsed={graphCollapsed}
              onToggle={toggleGraph}
              onCommand={emit}
            />

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
                onSetHidden={setTaskHidden}
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
            <TaskList tasks={[]} disabled onRun={() => undefined} onSetHidden={() => undefined} />
          </div>
        )}
      </main>

      <div className="status-bar">
        <span>{repos.length - hiddenCount} repos</span>
        {hiddenCount > 0 && <span>{hiddenCount} hidden</span>}
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

      {rootsOpen && (
        <RootsDialog
          roots={roots}
          onChange={(next) => {
            setRoots(next);
            scan();
          }}
          onClose={() => setRootsOpen(false)}
        />
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
