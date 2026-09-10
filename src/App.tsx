import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FleetSidebar from "./components/FleetSidebar";
import TerminalPane, {
  blockOutput,
  closeSession,
  revealBlock,
  sendCommand,
  subscribeBlocks,
} from "./components/TerminalPane";
import BlockBar from "./components/BlockBar";
import TaskList from "./components/TaskList";
import BranchGraph from "./components/BranchGraph";
import BranchMenu from "./components/BranchMenu";
import ChangesPane from "./components/ChangesPane";
import RootsDialog from "./components/RootsDialog";
import BatchDialog from "./components/BatchDialog";
import InboxPane from "./components/InboxPane";
import CommandPalette, { type PaletteItem } from "./components/CommandPalette";
import { api } from "./lib/api";
import { copyText } from "./lib/clipboard";
import { openUrlCommand, shellKind } from "./lib/shell";
import {
  fetchPlan,
  isSkip,
  newRun,
  pruneCommand,
  runRepo,
  verbFor,
  type BatchKind,
  type BatchRow,
  type BatchRun,
} from "./lib/batch";
import {
  relativeTime,
  type AppInfo,
  type BranchGraph as Graph,
  type CommandBlock,
  type FileChange,
  type Inbox,
  type RepoPref,
  type RepoState,
  type Task,
} from "./lib/types";

interface Confirmation {
  title: string;
  body: string;
  /** Shown verbatim when the action is a command. Omitted when it is not. */
  command?: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * The line in the status bar.
 *
 * Most of them are just text. A batch leaves one that opens its transcript, so
 * the report is a click away rather than a modal that interrupted the work.
 */
interface Note {
  text: string;
  onClick?: () => void;
}

/** A command on its way into the task list, waiting to be named. */
interface PendingTask {
  repoPath: string;
  command: string;
  name: string;
}

const GRAPH_KEY = "gitview.graph.collapsed";

/**
 * A first guess at what to call a command being kept as a task.
 *
 * The runner prefix is the part that carries no information: every script in a
 * package is `npm run <something>`, and the something is the name. Everything
 * else keeps its first two words, so `cargo test` stays `cargo test`.
 */
function taskNameFor(command: string): string {
  const stripped = command.replace(/^(npm|pnpm|yarn|bun|deno)\s+(run\s+)?/i, "");
  return stripped.split(/\s+/).slice(0, 2).join(" ").slice(0, 40) || command.slice(0, 40);
}

export default function App() {
  const [repos, setRepos] = useState<RepoState[]>([]);
  const [prefs, setPrefs] = useState<Map<string, RepoPref>>(new Map());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
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
  // The one repository whose shell was closed on purpose, until something else
  // is selected. Anything wider would mean a repository you opened yesterday
  // greeting you with a button instead of a prompt.
  const [closedShell, setClosedShell] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  /** The last batch, running or finished, and whether its transcript is up. */
  const [batch, setBatch] = useState<BatchRun | null>(null);
  const [batchKind, setBatchKind] = useState<BatchKind>("sync");
  const [batchOpen, setBatchOpen] = useState(false);
  /** Bumped to remount the dialog, which is what clears a stale selection. */
  const [batchEpoch, setBatchEpoch] = useState(0);
  // Read between repositories, so stopping never interrupts a command that has
  // already started. A ref rather than state: the loop has to see the change.
  const batchStopped = useRef(false);
  // Fetch-all is one palette keystroke and the palette opens over the dialog,
  // so a second batch can be started on top of a running one. Whichever ran
  // last owns the transcript, and the older loop stops writing to it.
  const batchToken = useRef(0);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [note, setNoteState] = useState<Note | null>(null);
  const setNote = useCallback((text: string) => setNoteState({ text }), []);
  const [blocks, setBlocks] = useState<CommandBlock[]>([]);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  /**
   * A command waiting for its repository's shell to exist.
   *
   * An inbox row can act on a repository that is not open, and `sendCommand`
   * writes to the PTY directly, so firing it after a fixed delay loses the
   * command whenever spawning the shell takes longer than the guess. This waits
   * for the session to report itself live instead.
   */
  const [pendingCommand, setPendingCommand] = useState<{
    path: string;
    command: string;
  } | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxReading, setInboxReading] = useState(false);
  /** Bumped when a task is saved or deleted, to re-read the list. */
  const [taskEpoch, setTaskEpoch] = useState(0);
  const [pendingTask, setPendingTask] = useState<PendingTask | null>(null);

  const selected = useMemo(
    () => repos.find((r) => r.path === selectedPath) ?? null,
    [repos, selectedPath],
  );

  // Commands are typed at a prompt, so quoting has to match whatever is there.
  const shell = useMemo(() => shellKind(info?.shell), [info]);

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
      const report = await api.fleetScan((repo) => {
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

      // A folder renamed since the last launch brought its pins and its saved
      // tasks with it. Silence is what made the old behaviour a bug, so this
      // says what moved.
      if (report.adopted.length > 0) {
        await loadPrefs();
        const names = report.adopted.map((move) => move.ownerRepo).join(", ");
        setNote(
          report.adopted.length === 1
            ? `Preferences for ${names} followed it to its new folder.`
            : `Preferences for ${report.adopted.length} repositories followed them: ${names}.`,
        );
      }
    } catch (err) {
      setNote(String(err));
    } finally {
      setScanning(false);
    }
  }, [upsert, loadPrefs]);

  // Cache first, so the list is on screen before anything is opened.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cached, appInfo, storedInbox] = await Promise.all([
          api.fleetCached(),
          api.appInfo(),
          // Cached like the fleet rows, so the pane has something before gh is
          // asked anything.
          api.githubCached().catch(() => null),
        ]);
        if (cancelled) return;
        setRepos(cached);
        setInbox(storedInbox);
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
  }, [selectedPath, taskEpoch]);

  // Selecting a repository is as deliberate as closing its shell was, so it
  // clears the closed flag and the pane opens a fresh session.
  useEffect(() => {
    setClosedShell(null);
    if (!selectedPath) {
      setChanges([]);
      return;
    }
    let cancelled = false;
    api
      .repoChanges(selectedPath)
      .then((found) => {
        if (!cancelled) setChanges(found);
      })
      .catch(() => {
        if (!cancelled) setChanges([]);
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

  // Blocks belong to the session, not to this component, so they survive a view
  // change the same way the scrollback does. Resubscribing on `shellOpen` is
  // what clears the strip when a shell is closed and fills it again on reopen.
  useEffect(() => {
    if (!selectedPath || closedShell === selectedPath) {
      setBlocks([]);
      return;
    }
    return subscribeBlocks(selectedPath, setBlocks);
  }, [selectedPath, closedShell]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setConfirmation(null);
        setRootsOpen(false);
        setPendingTask(null);
        // A batch that is still running keeps its dialog: closing it would hide
        // the only place the commands it is about to run are reported.
        setBatchOpen((open) => (open && batch?.running === true ? open : false));
        setInboxOpen(false);
      }
    }
    // The terminal lets Ctrl+K through to here rather than handling it itself,
    // see attachCustomKeyEventHandler in TerminalPane.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [batch?.running]);

  useEffect(() => {
    if (!pendingCommand || !live.has(pendingCommand.path)) return;
    sendCommand(pendingCommand.path, pendingCommand.command).catch((err) =>
      setNote(String(err)),
    );
    setPendingCommand(null);
  }, [pendingCommand, live, setNote]);

  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!note) return;
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNoteState(null), 6000);
  }, [note]);

  const refreshRepo = useCallback(
    (path: string) => {
      api.repoRefresh(path).then(upsert).catch(() => undefined);
      // A commit typed by hand empties the changes pane, and the pane is right
      // next to the prompt it was typed at.
      if (path === selectedPath) {
        api.repoChanges(path).then(setChanges).catch(() => undefined);
      }
    },
    [upsert, selectedPath],
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

  /**
   * The pinned group's new order, applied here before it is written.
   *
   * Waiting for the write and a re-read would let the dragged row snap back to
   * where it was for a frame, and the positions being written are exactly the
   * ones set here, so there is nothing to read back.
   */
  const reorderPins = useCallback(async (paths: string[]) => {
    setPrefs((current) => {
      const next = new Map(current);
      paths.forEach((path, index) => {
        const pref = next.get(path);
        if (pref) next.set(path, { ...pref, pinnedPos: index });
      });
      return next;
    });
    await api.repoReorderPins(paths).catch((err) => setNote(String(err)));
  }, [setNote]);

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
   * Ending a session always asks first.
   *
   * Persistence is the whole reason a dev server survives switching projects, so
   * the one control that undoes it has to name what it is about to stop. There
   * is no way to tell a live build from an idle prompt from out here.
   */
  const askCloseShell = useCallback(
    (path: string) => {
      const repo = repos.find((r) => r.path === path);
      setConfirmation({
        title: `Close the shell in ${repo?.name ?? path}`,
        body: "Anything still running in it stops: a dev server, a watcher, a build. Sessions outlive a view change precisely so those keep going, so this is the only thing that ends one.",
        confirmLabel: "Close the shell",
        onConfirm: () => {
          closeSession(path);
          setLive((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
          if (path === selectedPath) setClosedShell(path);
        },
      });
    },
    [repos, selectedPath],
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

  /**
   * A block is the command, its exit code and its output as one unit, which is
   * exactly what is worth handing to Claude. Nothing is sent anywhere: it goes
   * to the clipboard and the user decides where it lands.
   */
  const copyBlock = useCallback(
    async (block: CommandBlock) => {
      const output = blockOutput(block.repoPath, block.id);
      const text = [
        `Command: ${block.command}`,
        `Directory: ${block.repoPath}`,
        block.exitCode === null ? "Still running." : `Exit code: ${block.exitCode}`,
        "",
        output || "(nothing from this command is left in the scrollback)",
      ].join("\n");
      const copied = await copyText(text);
      setNote(
        copied
          ? `Copied ${block.command} and its output.`
          : "The clipboard refused the copy.",
      );
    },
    [],
  );

  const askSaveTask = useCallback((block: CommandBlock) => {
    setPendingTask({
      repoPath: block.repoPath,
      command: block.command,
      name: taskNameFor(block.command),
    });
  }, []);

  const saveTask = useCallback(async () => {
    if (!pendingTask) return;
    const name = pendingTask.name.trim();
    if (!name) return;
    try {
      await api.taskSave(pendingTask.repoPath, name, pendingTask.command);
      setPendingTask(null);
      setTaskEpoch((n) => n + 1);
      setNote(`Saved ${name}.`);
    } catch (err) {
      setNote(String(err));
    }
  }, [pendingTask]);

  /**
   * Saved tasks are the only ones that can be deleted. A discovered task belongs
   * to a manifest, and hiding is what that one has.
   */
  const askDeleteTask = useCallback((task: Task) => {
    setConfirmation({
      title: `Delete the saved task ${task.name}`,
      body: "It was kept from a command run here, so deleting it costs the name and nothing else. Anything discovered from a manifest is untouched.",
      command: task.command,
      confirmLabel: "Delete the task",
      onConfirm: () => {
        api
          .taskDelete(task.id)
          .then(() => setTaskEpoch((n) => n + 1))
          .catch((err) => setNote(String(err)));
      },
    });
  }, []);

  // Typed at a prompt, so it is one PowerShell line. A batch runs the same two
  // commands as two separate invocations, see `lib/batch.ts`.
  const syncCommand = "git fetch --prune; git pull --ff-only";

  function pruneConfirmation(repo: RepoState): Confirmation {
    const command = pruneCommand(repo);
    return {
      title: `Delete ${repo.mergedBranches.length} merged branches`,
      body: `Every branch listed is already contained in ${repo.defaultBranch ?? "the default branch"}. git branch -d refuses anything unmerged, and the output prints each deleted branch's commit so it can be recreated.`,
      command,
      confirmLabel: "Delete branches",
      onConfirm: () => emit(command),
    };
  }

  /**
   * A repository the fleet-wide actions are allowed to touch.
   *
   * A hidden repository is one the user has said they are not thinking about,
   * so it stays out of a sweep as well as out of the list.
   */
  const batchCandidates = useMemo(
    () => repos.filter((repo) => !prefs.get(repo.path)?.hidden),
    [repos, prefs],
  );

  /**
   * Runs a batch, one repository at a time, keeping a transcript as it goes.
   *
   * Sequential on purpose: twelve concurrent fetches would finish sooner and
   * arrive as twelve interleaved reports, and the point of the transcript is
   * that it reads in the order the work happened. Stopping is offered instead,
   * and it takes effect between repositories.
   */
  const runBatch = useCallback(
    async (kind: BatchKind, paths: string[]) => {
      const targets = paths
        .map((path) => repos.find((repo) => repo.path === path))
        .filter((repo): repo is RepoState => repo != null);
      if (targets.length === 0) return;

      batchStopped.current = false;
      const token = (batchToken.current += 1);
      setBatch(newRun(kind, targets));

      const patch = (path: string, change: (row: BatchRow) => BatchRow) => {
        if (batchToken.current !== token) return;
        setBatch((current) =>
          current
            ? {
                ...current,
                rows: current.rows.map((row) => (row.path === path ? change(row) : row)),
              }
            : current,
        );
      };

      let failures = 0;
      let acted = 0;
      for (const repo of targets) {
        if (batchStopped.current || batchToken.current !== token) break;
        patch(repo.path, (row) => ({ ...row, state: "running" }));

        const result = await runRepo(kind, repo, upsert);
        if (result.failed) failures += 1;
        else if (result.steps.some((step) => step.outcome)) acted += 1;

        patch(repo.path, (row) => ({
          ...row,
          state: "done",
          steps: result.steps,
          headline: result.headline,
          failed: result.failed,
        }));
        if (batchToken.current === token) {
          setBatch((current) => (current ? { ...current, done: current.done + 1 } : current));
        }
      }

      if (batchToken.current !== token) return;
      const stopped = batchStopped.current;
      setBatch((current) =>
        current ? { ...current, running: false, cancelled: stopped } : current,
      );
      setNoteState({
        text:
          `${verbFor[kind]} ran in ${acted} ${acted === 1 ? "repository" : "repositories"}` +
          (failures > 0 ? `, ${failures} failed` : "") +
          (stopped ? ", then stopped" : "") +
          ".",
        onClick: () => setBatchOpen(true),
      });
    },
    [repos, upsert],
  );

  /**
   * The one operation allowed to run out of sight, so the one that has to be
   * honest about failing.
   *
   * No dialog and no picking: the value of this action is that it is one
   * keystroke over the whole fleet. The transcript is written anyway, and the
   * note in the status bar opens it.
   */
  const fetchAll = useCallback(() => {
    setBatchKind("fetch");
    setNote("Fetching every repository…");
    return runBatch(
      "fetch",
      batchCandidates.filter((repo) => !isSkip(fetchPlan(repo))).map((repo) => repo.path),
    );
  }, [batchCandidates, runBatch]);

  /**
   * Opens a fresh pick stage.
   *
   * The epoch is what remounts the dialog. Ctrl+K reaches the palette over an
   * open transcript, so asking for a prune while a finished sync was still on
   * screen left the dialog mounted and holding the sixteen repositories the
   * sync had selected.
   */
  /**
   * One GraphQL request for the whole fleet, through the gh CLI.
   *
   * A failed read keeps the last good list on screen rather than emptying the
   * pane, because the usual reason is a laptop that was off the network.
   */
  const refreshInbox = useCallback(async () => {
    setInboxReading(true);
    try {
      const next = await api.githubRefresh();
      setInbox((current) => (next.error && current ? { ...current, error: next.error } : next));
      if (next.error) setNote(next.error);
      else if (next.unresolved.length > 0) {
        setNote(`Read the inbox. ${next.unresolved.length} did not resolve.`);
      }
    } catch (err) {
      setNote(String(err));
    } finally {
      setInboxReading(false);
    }
  }, [setNote]);

  /**
   * One read on launch when the cached copy has gone stale.
   *
   * Without it the sidebar badge stays at whatever it was when the app last
   * closed, which is a number that looks live and is not. Ten minutes because
   * the query costs one point out of five thousand an hour.
   */
  const inboxLaunched = useRef(false);
  useEffect(() => {
    if (inboxLaunched.current) return;
    if (!info?.gh.version || !info.gh.loggedIn) return;
    inboxLaunched.current = true;
    const age = inbox ? Math.floor(Date.now() / 1000) - inbox.fetchedAt : Infinity;
    if (age > 600) refreshInbox();
  }, [info, inbox, refreshInbox]);

  const openBatch = useCallback((kind: BatchKind) => {
    setBatchKind(kind);
    setBatch(null);
    setBatchEpoch((n) => n + 1);
    setBatchOpen(true);
  }, []);

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
          run: () => setConfirmation(pruneConfirmation(selected)),
        });
      }

      const pinned = prefs.get(selected.path)?.pinnedAt != null;
      const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      if (lastBlock) {
        items.push({
          id: "action:rerun",
          label: `Run ${lastBlock.command} again`,
          kind: "task",
          hint: "the last command in this shell",
          run: () => emit(lastBlock.command),
        });
        items.push({
          id: "action:save-block",
          label: `Save ${lastBlock.command} as a task`,
          kind: "task",
          hint: "keeps it in this repository's list",
          run: () => askSaveTask(lastBlock),
        });
      }
      const lastFailure = [...blocks]
        .reverse()
        .find((block) => block.exitCode !== null && block.exitCode !== 0);
      if (lastFailure) {
        items.push({
          id: "action:copy-failure",
          label: `Copy ${lastFailure.command} for Claude`,
          kind: "task",
          hint: `exit ${lastFailure.exitCode}, with its output`,
          run: () => copyBlock(lastFailure),
        });
      }

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

    // One row per live shell, which is what makes the count in the status bar
    // worth clicking: it opens the palette, and the palette is where the
    // sessions can be ended without hunting for the row that owns each one.
    for (const path of live) {
      const repo = repos.find((r) => r.path === path);
      items.push({
        id: `close:${path}`,
        label: `Close the shell in ${repo?.name ?? path}`,
        kind: "fleet",
        hint: "ends the process and its scrollback",
        run: () => askCloseShell(path),
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
      id: "action:batch-sync",
      label: "Sync several repositories",
      kind: "fleet",
      hint: "fetch and fast-forward, with a transcript",
      run: () => openBatch("sync"),
    });
    const prunable = batchCandidates.filter((repo) => repo.mergedBranches.length > 0);
    if (prunable.length > 0) {
      const branches = prunable.reduce((sum, repo) => sum + repo.mergedBranches.length, 0);
      items.push({
        id: "action:batch-prune",
        label: `Prune merged branches across ${prunable.length} repositories`,
        kind: "fleet",
        hint: `${branches} branches, named before anything runs`,
        run: () => openBatch("prune"),
      });
    }
    if (info?.gh.version) {
      const waiting = (inbox?.items ?? []).filter(
        (item) => item.reviewRequested || item.assigned,
      ).length;
      items.push({
        id: "action:inbox",
        label: "GitHub inbox",
        kind: "fleet",
        hint: waiting > 0 ? `${waiting} waiting on you` : "pull requests and issues, fleet-wide",
        run: () => setInboxOpen(true),
      });
      for (const item of inbox?.items ?? []) {
        items.push({
          id: `gh:${item.ownerRepo}:${item.kind}${item.number}`,
          label: `${item.repoName} #${item.number} ${item.title}`,
          kind: item.kind === "pr" ? "git" : "task",
          hint: item.kind === "pr" ? "pull request" : "issue",
          run: () => {
            setSelectedPath(item.repoPath);
            setInboxOpen(true);
          },
        });
      }
    }
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
  }, [
    repos,
    prefs,
    tasks,
    selected,
    live,
    blocks,
    emit,
    scan,
    setPinned,
    setHidden,
    askCloseShell,
    askSaveTask,
    copyBlock,
    batchCandidates,
    openBatch,
    fetchAll,
    inbox,
    info,
  ]);

  /** Items that want something from this person, which is what a badge means. */
  const inboxWaiting = useMemo(
    () =>
      (inbox?.items ?? []).filter((item) => item.reviewRequested || item.assigned).length,
    [inbox],
  );

  /**
   * Open pull requests per repository, for the sidebar chip.
   *
   * Built from the inbox rather than stored on `RepoState`, which is scanner
   * output and cannot see GitHub. Same merge the preferences get.
   */
  const repoGithub = useMemo(() => {
    const map = new Map<string, { open: number; failing: boolean }>();
    for (const item of inbox?.items ?? []) {
      if (item.kind !== "pr") continue;
      const row = map.get(item.repoPath) ?? { open: 0, failing: false };
      row.open += 1;
      if (item.checks === "FAILURE" || item.checks === "ERROR") row.failing = true;
      map.set(item.repoPath, row);
    }
    return map;
  }, [inbox]);

  /**
   * The open pull request for the branch that is checked out, when there is one.
   *
   * Matched on `headRef` rather than looked up, because the inbox has already
   * been read and this is the one row of it that belongs to what is on screen.
   */
  const branchPr = useMemo(() => {
    if (!selected?.branch) return null;
    return (
      (inbox?.items ?? []).find(
        (item) =>
          item.kind === "pr" &&
          item.repoPath === selected.path &&
          item.headRef === selected.branch,
      ) ?? null
    );
  }, [inbox, selected]);

  const dirty = selected ? selected.staged + selected.modified : 0;
  const hiddenCount = useMemo(
    () => repos.filter((r) => prefs.get(r.path)?.hidden).length,
    [repos, prefs],
  );
  const shellReady = selected != null && live.has(selected.path);

  return (
    <div className="app">
      {/* The fleet and the tasks share the left rail. Tasks belong to whichever
          repository is selected, which is chosen immediately above them, and
          moving them here freed the right-hand column for the working tree. */}
      <div className="rail">
        <FleetSidebar
          repos={repos}
          prefs={prefs}
          github={repoGithub}
          inboxWaiting={inboxWaiting}
          onOpenInbox={info?.gh.version ? () => setInboxOpen(true) : null}
          selectedPath={selectedPath}
          liveSessions={live}
          query={query}
          scanning={scanning}
          onQuery={setQuery}
          onSelect={setSelectedPath}
          onPin={setPinned}
          onReorderPins={reorderPins}
          onHide={setHidden}
          onCloseShell={askCloseShell}
          onManageRoots={() => setRootsOpen(true)}
        />
        <TaskList
          tasks={selected ? tasks : []}
          disabled={!shellReady}
          onRun={(task) => emit(task.command)}
          onSetHidden={setTaskHidden}
          onDelete={askDeleteTask}
        />
      </div>

      <main className="main">
        {selected ? (
          <>
            <header className="repo-head">
              <div className="repo-title">
                <h1>{selected.name}</h1>
                {branchPr && (
                  <button
                    className="head-pr"
                    title={`${branchPr.title}

gh pr view ${branchPr.number} --web`}
                    onClick={() => setInboxOpen(true)}
                  >
                    PR #{branchPr.number}
                    {branchPr.draft && <span className="inbox-badge draft">draft</span>}
                    {branchPr.reviewDecision === "APPROVED" && (
                      <span className="inbox-badge approved">approved</span>
                    )}
                    {branchPr.reviewDecision === "CHANGES_REQUESTED" && (
                      <span className="inbox-badge changes">changes</span>
                    )}
                    {branchPr.checks && (
                      <span
                        className={`inbox-checks ${
                          branchPr.checks === "SUCCESS"
                            ? "ok"
                            : branchPr.checks === "FAILURE" || branchPr.checks === "ERROR"
                              ? "bad"
                              : "pending"
                        }`}
                      >
                        {branchPr.checks === "SUCCESS"
                          ? "✓"
                          : branchPr.checks === "FAILURE" || branchPr.checks === "ERROR"
                            ? "✕"
                            : "•"}
                      </span>
                    )}
                  </button>
                )}
                <span className="path">
                  {selected.branch ?? "no commits"}
                  {selected.ahead > 0 && ` ↑${selected.ahead}`}
                  {selected.behind > 0 && ` ↓${selected.behind}`}
                  {dirty > 0 && ` · ${dirty} changed`}
                  {selected.lastCommitAt && ` · ${relativeTime(selected.lastCommitAt)}`}
                </span>
              </div>

              <div className="head-actions">
                <BranchMenu repo={selected} shell={shell} onCommand={emit} />
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
                  onClick={() => setConfirmation(pruneConfirmation(selected))}
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

            <TerminalPane
              repoPath={selected.path}
              open={closedShell !== selected.path}
              onSettled={refreshRepo}
              onLiveChange={onLiveChange}
              onRequestClose={askCloseShell}
              onReopen={() => setClosedShell(null)}
            >
              <BlockBar
                blocks={blocks}
                onRun={(command) => emit(command)}
                onSave={askSaveTask}
                onCopy={copyBlock}
                onReveal={(block) => revealBlock(block.repoPath, block.id)}
                portCommand={(port) => openUrlCommand(`http://localhost:${port}`, shell)}
                onPort={(port) => emit(openUrlCommand(`http://localhost:${port}`, shell))}
              />
            </TerminalPane>
          </>
        ) : (
          <div className="terminal-pane">
            <div className="pane-tab-bar">terminal</div>
            <p className="empty">
              {repos.length === 0 && scanning
                ? "Scanning the roots…"
                : "Pick a repository on the left, or press Ctrl+K."}
            </p>
          </div>
        )}
        {inboxOpen && (
          <InboxPane
            inbox={inbox}
            gh={info?.gh ?? null}
            refreshing={inboxReading}
            onRefresh={refreshInbox}
            onClose={() => setInboxOpen(false)}
            onSelect={(path) => {
              setSelectedPath(path);
              setInboxOpen(false);
            }}
            onCommand={(path, command) => {
              // The command lands in that repository's shell, which means
              // selecting it first: a session belongs to a repository. The
              // command waits for that shell rather than for a timer.
              setSelectedPath(path);
              setInboxOpen(false);
              setPendingCommand({ path, command });
            }}
            onCopy={async (text) => {
              const copied = await copyText(text);
              setNote(copied ? `Copied ${text}` : "The clipboard refused the copy.");
            }}
          />
        )}
      </main>

      <ChangesPane
        repo={selected}
        changes={changes}
        disabled={!shellReady}
        shell={shell}
        onCommand={emit}
      />

      <div className="status-bar">
        <span>{repos.length - hiddenCount} repos</span>
        {hiddenCount > 0 && <span>{hiddenCount} hidden</span>}
        {scanning && <span style={{ color: "var(--accent)" }}>scanning {scanned}</span>}
        {live.size > 0 && (
          <button
            className="status-link"
            style={{ color: "var(--green)" }}
            onClick={() => setPaletteOpen(true)}
            title="Every open shell, and the row that closes one"
          >
            {live.size} shells
          </button>
        )}
        {note &&
          (note.onClick ? (
            <button
              className="status-link"
              style={{ color: "var(--amber)" }}
              onClick={note.onClick}
              title="Every command it ran, and what git said"
            >
              {note.text}
            </button>
          ) : (
            <span style={{ color: "var(--amber)" }}>{note.text}</span>
          ))}
        <span className="spacer" />
        {info && (
          <span
            title={
              info.gh.version
                ? info.gh.loggedIn
                  ? `${info.gh.version}, logged in. The inbox reads GitHub through it, so GitView never holds a token.`
                  : `${info.gh.version}, not logged in. Run gh auth login.`
                : "gh is not on PATH, so there is no inbox."
            }
          >
            {info.gh.version ? (info.gh.loggedIn ? "gh" : "gh · no auth") : "no gh"}
          </span>
        )}
        {info?.gitVersion && <span>{info.gitVersion}</span>}
        {info && (
          <span
            title={
              info.shellIntegration
                ? "This shell reports where each command starts and ends, which is what fills the strip above the terminal."
                : "This shell reports nothing about the commands run in it, so there are no blocks."
            }
          >
            {info.shell.split(/[\\/]/).pop()}
            {info.shellIntegration && " · blocks"}
          </span>
        )}
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

      {batchOpen && (
        <BatchDialog
          key={`${batchKind}:${batchEpoch}`}
          kind={batchKind}
          candidates={batchCandidates}
          run={batch}
          onStart={(paths) => runBatch(batchKind, paths)}
          onCancel={() => {
            batchStopped.current = true;
          }}
          onSelect={(path) => {
            setSelectedPath(path);
            setBatchOpen(false);
          }}
          onCopy={async (text) => {
            const copied = await copyText(text);
            setNote(copied ? "Copied the transcript." : "The clipboard refused the copy.");
          }}
          onClose={() => setBatchOpen(false)}
        />
      )}

      {pendingTask && (
        <div className="confirm-backdrop" onMouseDown={() => setPendingTask(null)}>
          <form
            className="confirm"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              saveTask();
            }}
          >
            <h2>Keep this command as a task</h2>
            <p>
              It joins this repository's list above anything discovery found, and running it types
              the same line you just typed. Nothing is written into the repository: the task lives
              in GitView's own database, keyed on this folder.
            </p>
            <pre>{pendingTask.command}</pre>
            <input
              className="text-input"
              autoFocus
              value={pendingTask.name}
              placeholder="A name for it"
              onChange={(e) => setPendingTask({ ...pendingTask, name: e.target.value })}
            />
            <div className="confirm-actions">
              <button type="button" className="btn" onClick={() => setPendingTask(null)}>
                Cancel
              </button>
              <button type="submit" className="btn accent" disabled={!pendingTask.name.trim()}>
                Save the task
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmation && (
        <div className="confirm-backdrop" onMouseDown={() => setConfirmation(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{confirmation.title}</h2>
            <p>{confirmation.body}</p>
            {confirmation.command && <pre>{confirmation.command}</pre>}
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmation(null)}>
                Cancel
              </button>
              <button
                className="btn accent"
                onClick={() => {
                  confirmation.onConfirm();
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
