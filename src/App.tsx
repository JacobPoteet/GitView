import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import FleetSidebar, { drawnOrder, groupRepos } from "./components/FleetSidebar";
import TerminalPane, {
  blockOutput,
  closeSession,
  focusSession,
  sessionsFor,
  getBlocks,
  revealBlock,
  sendCommand,
  subscribeBlocks,
  widthForColumns,
} from "./components/TerminalPane";
import BlockBar from "./components/BlockBar";
import Dialog from "./components/Dialog";
import Splitter from "./components/Splitter";
import TaskList from "./components/TaskList";
import BranchGraph, { type ResetMode } from "./components/BranchGraph";
import BranchMenu from "./components/BranchMenu";
import ChangesPane from "./components/ChangesPane";
import CommitFilesPane from "./components/CommitFilesPane";
import CommitPane from "./components/CommitPane";
import DiffPane from "./components/DiffPane";
import HistoryPane from "./components/HistoryPane";
import OperationBar from "./components/OperationBar";
import ContextMenu, { isEditable, type MenuAt, type MenuEntry } from "./components/ContextMenu";
import SettingsDialog, { type SettingsSection } from "./components/SettingsDialog";
import BatchDialog from "./components/BatchDialog";
import InboxPane from "./components/InboxPane";
import { itemKey, refKey, refLabel } from "./lib/inbox";
import UpdateDialog from "./components/UpdateDialog";
import Splash from "./components/Splash";
import Welcome from "./components/Welcome";
import Tour from "./components/Tour";
import { useBatch } from "./hooks/useBatch";
import { useTour } from "./hooks/useTour";
import { useInbox } from "./hooks/useInbox";
import { useUpdate } from "./hooks/useUpdate";
import CommandPalette, { type PaletteItem } from "./components/CommandPalette";
import { api } from "./lib/api";
import {
  CHANGES_MAX,
  CHANGES_MIN,
  DEFAULTS,
  settings,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  updateSettings,
  useSetting,
} from "./lib/settings";
import { chordOf, repoChord } from "./lib/keys";
import { sessionLabel, sessionNumber, sessionRepo } from "./lib/sessions";
import { copyText } from "./lib/clipboard";
import {
  discardCommands,
  openUrlCommand,
  pushCommand,
  quote,
  shellKind,
  tagCommand,
  validRefName,
} from "./lib/shell";
import { pruneCommands, pruneSplit } from "./lib/batch";
import {
  fleetSummary,
  isUntracked,
  relativeTime,
  stashTitle,
  type AppInfo,
  type BranchGraph as Graph,
  type CommandBlock,
  type CommitDiff,
  type CommitTarget,
  type DiffTarget,
  type FileChange,
  type RepoPref,
  type RepoState,
  type Squashed,
  type Task,
} from "./lib/types";

interface Confirmation {
  title: string;
  body: string;
  /**
   * Shown verbatim when the action is a command. Omitted when it is not, and
   * newline-separated when the action takes more than one — a discard holding
   * both a tracked and an untracked file needs `git restore` and `git clean`.
   */
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

/** A task's description, being edited before it is saved. */
interface PendingDescription {
  repoPath: string;
  task: Task;
  text: string;
}

/** A commit on its way to being tagged, waiting for the name. */
interface PendingTag {
  repoPath: string;
  commit: { id: string; short: string; summary: string };
  name: string;
  message: string;
  push: boolean;
}


/**
 * How long the splash stays up at the least.
 *
 * A warm cache is one SQLite read, and a cover that came and went inside a
 * frame or two would read as a flicker rather than a launch. The word finishes
 * typing at 600 ms, and this leaves the cursor a beat before the exit.
 */
const SPLASH_MIN_MS = 900;
/**
 * How long `.app.arriving` stays on: the panels, then the longest cascade the
 * rows can run, then a frame. The row delay is capped in the stylesheet, so a
 * fleet of forty is no longer than one of sixteen.
 */
const ARRIVE_MS = 1500;

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

/** Module-level so a pane effect that depends on it never re-runs for it. */
const noop = () => undefined;

export default function App() {
  const [repos, setRepos] = useState<RepoState[]>([]);
  const [prefs, setPrefs] = useState<Map<string, RepoPref>>(new Map());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  /**
   * Local branches that were squash-merged into the trunk.
   *
   * Read for the open repository rather than in the sweep, because it costs a
   * patch id per branch against recent history. Nothing about it belongs on
   * `RepoState`, which the next sweep overwrites.
   */
  const [squashed, setSquashed] = useState<Squashed[]>([]);
  /**
   * The file the diff pane is showing, or nothing.
   *
   * Held here rather than in the changes column because the pane it opens
   * belongs to the main column, which the changes column does not own, and
   * because the side has to be able to follow a file that has just been staged.
   */
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  /**
   * Whether the scrolling history is up.
   *
   * A boolean rather than a path: it always belongs to whatever is selected,
   * and it closes with the selection the way the diff pane does.
   */
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * A filter the history opens on, from "History of this file" in the
   * changes column, the commit's file list or the diff pane. The epoch is
   * bumped per ask so the same file can be asked for again after the
   * filter was cleared; see HistoryPane's `seed`.
   */
  const [historySeed, setHistorySeed] = useState<{ query: string; epoch: number } | null>(null);
  /** The whole history, with no filter left over from a file's. */
  const openHistory = useCallback(() => {
    setHistorySeed(null);
    setHistoryOpen(true);
  }, []);
  const openFileHistory = useCallback((file: string) => {
    // A path with a space in it would split into two words at the field.
    // None here has one, and the filter would still match on the first
    // half; the field is a filter rather than a form.
    setHistorySeed((was) => ({ query: `path:${file}`, epoch: (was?.epoch ?? 0) + 1 }));
    setCommitTarget(null);
    setDiffTarget(null);
    setHistoryOpen(true);
  }, []);
  /**
   * The commit the commit pane is open on, if any.
   *
   * Carries the repository like the diff target does, so a selection change
   * closes it. It sits above the history in precedence and leaves `historyOpen`
   * alone, which is what puts the history back when it closes: the pane opens
   * from a history row nine times out of ten, and closing both would drop you
   * at the terminal with your place in the list lost.
   */
  const [commitTarget, setCommitTarget] = useState<CommitTarget | null>(null);
  /**
   * The open commit, read once per target. Held here rather than in the pane
   * because two regions draw it: the pane draws the message and one file's
   * hunks, and the right-hand column draws the file list in place of the
   * working tree while the pane is up.
   */
  const [commit, setCommit] = useState<CommitDiff | null>(null);
  const [commitFile, setCommitFile] = useState<string | null>(null);
  const graphCollapsed = useSetting((s) => s.graph.collapsed);
  const [roots, setRoots] = useState<string[]>([]);
  /** The settings dialog, and the section it opens on. Null while closed. */
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(0);
  /** The first sweep has resolved, so `repos` is the fleet and not its cached copy. */
  const [swept, setSwept] = useState(false);
  /**
   * Whether the splash has been released.
   *
   * A warm cache releases it once the rows are in state: the sweep that
   * follows updates a list that is already on screen. A cold launch has no
   * rows, so it holds until the sweep has run, because an empty sidebar
   * filling row by row is the thing worth covering.
   */
  const [booted, setBooted] = useState(false);
  /**
   * Whether the columns are still sliding into place.
   *
   * Set with `booted` and cleared once the last of them has landed, so the
   * transforms come off: a transformed rail would anchor the fixed row menu to
   * itself rather than to the window.
   */
  const [arriving, setArriving] = useState(false);
  useEffect(() => {
    if (!booted) return;
    setArriving(true);
    const timer = window.setTimeout(() => setArriving(false), ARRIVE_MS);
    return () => window.clearTimeout(timer);
  }, [booted]);
  /** Session ids with a shell behind them: a path for a first shell, `path#2` for a second. */
  const [live, setLive] = useState<Set<string>>(new Set());
  /** The repositories with any shell live, which is what the sidebar's dot means. */
  const livePaths = useMemo(() => new Set([...live].map(sessionRepo)), [live]);
  /**
   * The tab on screen per repository, when it is not the first. A second
   * shell is opened for the command the first cannot take, so the choice has
   * to survive looking at another project and coming back.
   */
  const [activeTabs, setActiveTabs] = useState<Map<string, string>>(new Map());
  const activeTabsRef = useRef(activeTabs);
  activeTabsRef.current = activeTabs;
  /** The session a command aimed at a repository lands in: its active tab, else its first shell. */
  const tabOf = useCallback((path: string) => activeTabsRef.current.get(path) ?? path, []);
  const selectTab = useCallback((id: string) => {
    setActiveTabs((current) => {
      const next = new Map(current);
      const path = sessionRepo(id);
      if (id === path) next.delete(path);
      else next.set(path, id);
      return next;
    });
  }, []);
  // The one shell that was closed on purpose, until something else is
  // selected. Anything wider would mean a repository you opened yesterday
  // greeting you with a button instead of a prompt.
  const [closedShell, setClosedShell] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [note, setNoteState] = useState<Note | null>(null);
  const setNote = useCallback((text: string) => setNoteState({ text }), []);
  const [blocks, setBlocks] = useState<CommandBlock[]>([]);
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
    /** Shift was held, so it is left at the prompt rather than run. */
    typeOnly: boolean;
  } | null>(null);
  /**
   * A shell of GitView's own, in its data folder, for the one command that
   * belongs to no repository: its own update. Opened by that command when
   * nothing is selected, since the main column has no prompt until then, and
   * shown there for as long as nothing is. Selecting a repository swaps it out
   * without ending it, the same as any other session.
   */
  const [ownShell, setOwnShell] = useState(false);
  /**
   * Where a clone typed from the welcome screen will land. Each time GitView's
   * own shell goes quiet the fleet is swept again, and once a sweep finds this
   * path the new repository is opened. A clone that fails leaves it set, which
   * costs a sweep per quiet shell until the next clone replaces it.
   */
  const [cloneTarget, setCloneTarget] = useState<string | null>(null);
  /** Bumped when a task is saved or deleted, to re-read the list. */
  const [taskEpoch, setTaskEpoch] = useState(0);
  const [pendingTask, setPendingTask] = useState<PendingTask | null>(null);
  const [pendingDescription, setPendingDescription] = useState<PendingDescription | null>(null);
  const [pendingTag, setPendingTag] = useState<PendingTag | null>(null);

  const selected = useMemo(
    () => repos.find((r) => r.path === selectedPath) ?? null,
    [repos, selectedPath],
  );

  /**
   * What Prune would delete: the branches the trunk contains, plus the ones it
   * swallowed through a squash. The second half is why the count on the button
   * was zero on every repository that squash-merges its pull requests.
   */
  const prunable = useMemo(
    () => (selected ? pruneSplit(selected, squashed) : { merged: [], squashed: [] }),
    [selected, squashed],
  );
  const prunableCount = prunable.merged.length + prunable.squashed.length;

  /** The entry for the branch you are standing on, if it was squash-merged. */
  const headSquashed = useMemo(
    () => squashed.find((s) => s.branch === selected?.branch) ?? null,
    [squashed, selected?.branch],
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

  /**
   * A note with something to click, for the one place that wants one: the
   * batch's summary opens its transcript.
   */
  const setNoteWith = useCallback(
    (text: string, onClick: () => void) => setNoteState({ text, onClick }),
    [],
  );
  const { update, updateOpen, setUpdateOpen, checkUpdate } = useUpdate(info, setNote);
  const {
    inbox: inboxRead,
    setInbox,
    inboxOpen,
    setInboxOpen,
    inboxReading,
    inboxTyped,
    inboxFocus,
    setInboxFocus,
    refreshInbox,
    armAfter,
    settled: inboxSettled,
  } = useInbox(info, setNote);
  /**
   * The inbox without the hidden repositories. The next read leaves them out
   * of the query, but the stored one still holds them, and hiding a repository
   * should drop its rows now rather than at the next poll.
   */
  const inbox = useMemo(() => {
    if (!inboxRead) return inboxRead;
    const items = inboxRead.items.filter((item) => !prefs.get(item.repoPath)?.hidden);
    return items.length === inboxRead.items.length ? inboxRead : { ...inboxRead, items };
  }, [inboxRead, prefs]);
  /**
   * The Refresh button's count, and part of `refSignature` below. A batch
   * bumps it too, once its commands have landed in the repository on screen:
   * a fetch moves `origin/main`, and the graph is drawn against it, but the
   * signature is built from local tips and cannot see a remote ref move.
   */
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  // Read through a ref so `synced` and `refreshRepo` keep one identity. Each
  // session holds the copy of `refreshRepo` it was handed when its pane was
  // open, and a copy with the selection baked in would fill the changes pane
  // from whichever repository last had a dev server print something.
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  const synced = useCallback((path: string) => {
    if (path === selectedRef.current) setRefreshEpoch((epoch) => epoch + 1);
  }, []);
  const {
    batch,
    batchKind,
    batchOpen,
    setBatchOpen,
    batchEpoch,
    batchCandidates,
    runBatch,
    fetchAll,
    syncAll,
    openBatch,
    stopBatch,
    fetchedAt,
    setFetchedAt,
    transcriptSeen,
    setTranscriptSeen,
  } = useBatch({ repos, prefs, swept, upsert, synced, setNote, setNoteWith });

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
      setSwept(true);

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
      // The sweep used to drop this on the floor, and a malformed cache table
      // failed every write for days before a dev build's boot read tripped
      // over it. The fleet is on screen either way; what is lost is the next
      // launch's first frame, and a database that needs rebuilding.
      if (report.cacheError) {
        setNote(`The cache refused the sweep's writes: ${report.cacheError}. The fleet is on screen, but the next launch starts cold.`);
      }
    } catch (err) {
      setNote(String(err));
    } finally {
      setScanning(false);
    }
  }, [upsert, loadPrefs, setNote]);

  // Cache first, so the list is on screen before anything is opened.
  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    let released = false;
    const release = () => {
      if (released || cancelled) return;
      released = true;
      const remaining = SPLASH_MIN_MS - (performance.now() - started);
      window.setTimeout(() => {
        if (!cancelled) setBooted(true);
      }, Math.max(0, remaining));
    };
    (async () => {
      let warm = false;
      try {
        // The cached fleet is a warm start, not a requirement: a cache that
        // cannot be read leaves the sweep to paint the list a moment later.
        // Failing the whole boot on it took `info` down too, and with it the
        // inbox and the gh status, for a fault in one table.
        let cacheError: string | null = null;
        const [cached, appInfo, storedInbox, lastFetch] = await Promise.all([
          api.fleetCached().catch((err): RepoState[] => {
            cacheError = String(err);
            return [];
          }),
          api.appInfo(),
          // Cached like the fleet rows, so the pane has something before gh is
          // asked anything.
          api.githubCached().catch(() => null),
          api.settingsFetchedAt().catch(() => 0),
        ]);
        if (cancelled) return;
        setRepos(cached);
        setInbox(storedInbox);
        setFetchedAt(lastFetch);
        setInfo(appInfo);
        setRoots(appInfo.roots);
        if (cacheError) setNote(`The fleet cache could not be read: ${cacheError}`);
        await loadPrefs();
        const liveIds = await api.ptyLive();
        if (!cancelled) setLive(new Set(liveIds));
        warm = cached.length > 0;
      } catch (err) {
        if (!cancelled) setNote(String(err));
      }
      // A failed read releases it too: the note it left is in the status bar,
      // and a cover that never lifts would hide the one line that says why.
      if (warm) release();
      if (!cancelled) await scan();
      release();
    })();
    return () => {
      cancelled = true;
    };
    // The two setters come out of hooks, so the lint cannot see they are
    // React's own and stable.
  }, [scan, loadPrefs, setNote, setInbox, setFetchedAt]);

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

  /**
   * Keep the diff pane pointed at something that still exists.
   *
   * Staging a file from inside the pane is the ordinary case: the row it was
   * opened from disappears from Changed and reappears under Staged one refresh
   * later. Closing the pane there would mean it shut itself every time it was
   * used, so the side follows the file, and only a file that has left the
   * working tree entirely closes it.
   */
  useEffect(() => {
    setHistoryOpen(false);
    setHistorySeed(null);
  }, [selectedPath]);

  useEffect(() => {
    if (commitTarget && commitTarget.repoPath !== selectedPath) setCommitTarget(null);
  }, [commitTarget, selectedPath]);

  useEffect(() => {
    setCommit(null);
    setCommitFile(null);
    if (!commitTarget) return;
    let cancelled = false;
    api
      .repoCommit(commitTarget.repoPath, commitTarget.id)
      .then((next) => {
        if (cancelled) return;
        setCommit(next);
        // The first file opens on its own, so a one-file commit reads as a
        // diff without a second click. A commit opened from a file's blame
        // gutter opens on that file, since that is the line being followed.
        const asked = commitTarget.file;
        const wanted = asked && next.files.some((f) => f.path === asked) ? asked : null;
        setCommitFile(wanted ?? next.files[0]?.path ?? null);
      })
      .catch((err) => {
        if (!cancelled) setNote(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [commitTarget, setNote]);

  useEffect(() => {
    if (!diffTarget) return;
    if (diffTarget.repoPath !== selectedPath) {
      setDiffTarget(null);
      return;
    }
    const sides = changes.filter((c) => c.path === diffTarget.file);
    if (sides.length === 0) {
      setDiffTarget(null);
      return;
    }
    if (!sides.some((c) => c.staged === diffTarget.staged)) {
      setDiffTarget({ ...diffTarget, staged: sides[0].staged });
    }
  }, [changes, diffTarget, selectedPath]);

  const openDiff = useCallback(
    (file: string, staged: boolean) => {
      if (!selectedPath) return;
      // The commit pane outranks the diff in the column, so a click in the
      // changes column while a commit is up would otherwise do nothing visible.
      setCommitTarget(null);
      setDiffTarget((current) =>
        current && current.file === file && current.staged === staged
          ? null
          : { repoPath: selectedPath, file, staged },
      );
    },
    [selectedPath],
  );

  const openCommit = useCallback(
    (commit: { id: string; short: string; file?: string }) => {
      if (!selectedPath) return;
      setCommitTarget({ repoPath: selectedPath, id: commit.id, short: commit.short, file: commit.file });
    },
    [selectedPath],
  );

  /** Which sides of the open file the working tree has, for the pane's tabs. */
  const diffSides = useMemo(() => {
    const rows = diffTarget ? changes.filter((c) => c.path === diffTarget.file) : [];
    return {
      staged: rows.some((c) => c.staged),
      unstaged: rows.some((c) => !c.staged),
    };
  }, [changes, diffTarget]);

  /**
   * Every ref in one string.
   *
   * The graph, the squash detection and the history read fresh whenever this
   * moves and stay put when a refresh changed nothing. HEAD's branch and its
   * counts were the key at first, and a prune moved none of them: the branch it
   * deleted stayed in `squashed`, and the button went on counting it. Every
   * local tip is in here now, so a branch created, deleted, amended or reset
   * reaches the picture. Working-tree counts are left out on purpose, because
   * a build writing files is not a ref moving.
   *
   * `refreshEpoch` is the Refresh button, and a fetch that settled here. Both
   * ask for everything, including the tags and remote refs a signature built
   * from the sweep cannot see.
   */
  const refSignature = selected
    ? [
        refreshEpoch,
        selected.branch,
        selected.detached,
        selected.upstream,
        selected.ahead,
        selected.behind,
        selected.defaultBase,
        selected.aheadOfDefault,
        selected.behindDefault,
        selected.lastCommitAt,
        // A rebase moving a step rewrites HEAD, and finishing one moves the
        // branch. Either way the picture is stale until this changes.
        selected.operation ? `${selected.operation.kind}:${selected.operation.step ?? ""}` : "",
        ...selected.branches.map(
          (b) => `${b.name}@${b.tip}:${b.ahead}:${b.behind}:${b.upstream ?? ""}:${b.aheadOfUpstream}`,
        ),
        ...selected.tags.map((t) => `${t.name}@${t.tip}`),
      ].join("|")
    : "";

  /**
   * What origin has under `refs/tags/`, so a tag chip can say whether it was
   * pushed. `git ls-remote` is a network read, run out of sight like fetch-all
   * because its answer is a list and not a scrollback. It is asked again when
   * a tag appears or goes, when a `git push` settles in this repository, and
   * on Refresh; a commit or a branch switch does not ask, since neither moves
   * a tag on origin. Null is no answer: no origin, no tags, or offline.
   */
  const [remoteTags, setRemoteTags] = useState<Map<string, string> | null>(null);
  const [pushEpoch, setPushEpoch] = useState(0);
  const tagNames = selected ? selected.tags.map((t) => t.name).join("|") : "";
  const hasRemote = selected?.remoteUrl !== null && selected?.remoteUrl !== undefined;
  useEffect(() => {
    setRemoteTags(null);
    if (!selectedPath || !hasRemote || tagNames === "") return;
    let cancelled = false;
    api
      .gitRun(selectedPath, ["ls-remote", "--tags", "origin"])
      .then((out) => {
        if (cancelled || out.code !== 0) return;
        // Two lines per annotated tag: the tag object, then `name^{}` with the
        // commit it wraps. The peeled line wins where there is one, so every
        // entry ends up as the commit, which is what a history row is.
        const found = new Map<string, string>();
        for (const line of out.stdout.split("\n")) {
          const [sha, ref] = line.trim().split(/\s+/);
          if (!sha || !ref?.startsWith("refs/tags/")) continue;
          const peeled = ref.endsWith("^{}");
          const name = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
          if (peeled || !found.has(name)) found.set(name, sha);
        }
        setRemoteTags(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedPath, hasRemote, tagNames, refreshEpoch, pushEpoch]);

  useEffect(() => {
    if (!selectedPath) {
      setSquashed([]);
      return;
    }
    let cancelled = false;
    api
      .repoSquashed(selectedPath)
      .then((found) => {
        if (!cancelled) setSquashed(found);
      })
      .catch(() => {
        if (!cancelled) setSquashed([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, refSignature]);

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
  }, [selectedPath, refSignature]);

  // Blocks belong to the session, not to this component, so they survive a view
  // change the same way the scrollback does. Resubscribing on `shellOpen` is
  // what clears the strip when a shell is closed and fills it again on reopen.
  const sessionId = selectedPath ? tabOf(selectedPath) : null;
  useEffect(() => {
    if (!sessionId || closedShell === sessionId) {
      setBlocks([]);
      return;
    }
    return subscribeBlocks(sessionId, setBlocks);
  }, [sessionId, closedShell]);

  /**
   * The column widths. Dragging writes the CSS variable straight onto the
   * frame, so a drag is a style change and not a render of everything in
   * the grid; the drop is what reaches the settings and re-renders once.
   */
  const layout = useSetting((s) => s.layout);
  const appRef = useRef<HTMLDivElement>(null);
  const setColumn = useCallback((name: "--sidebar-w" | "--changes-w", width: number) => {
    appRef.current?.style.setProperty(name, `${width}px`);
  }, []);
  /**
   * The narrowest the main column goes: 80 columns of the terminal, read off
   * a shell that is on screen. The fallback is that width at the shipped type
   * size, measured: 7 px a cell and 25 px of padding and scrollbar.
   */
  const mainMin = useCallback(() => widthForColumns(80) ?? 585, []);

  // The sidebar's rows in the order it draws them, for Ctrl+1 to Ctrl+9.
  const drawn = useMemo(() => drawnOrder(groupRepos(repos, prefs, query)), [repos, prefs, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const chord = chordOf(event);
      if (chord === "Ctrl+K") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (chord && /^Ctrl\+[1-9]$/.test(chord)) {
        const repo = drawn[Number(chord.slice(5)) - 1];
        event.preventDefault();
        if (repo) setSelectedPath(repo.path);
      } else if (chord === "Ctrl+`") {
        event.preventDefault();
        if (selectedPath) focusSession(tabOf(selectedPath));
      } else if (chord === "Ctrl+Shift+C") {
        // The field is in the changes column, which the commit pane's file
        // list replaces while a commit is open. No field, nothing to focus.
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".commit-title")?.focus();
      } else if (chord === "Ctrl+H") {
        event.preventDefault();
        if (historyOpen) setHistoryOpen(false);
        else if (selectedPath) openHistory();
      } else if (chord === "Ctrl+I") {
        event.preventDefault();
        if (info?.gh.version) setInboxOpen((open) => !open);
      } else if (chord === "Ctrl+,") {
        event.preventDefault();
        setSettingsOpen((open) => (open ? null : "terminal"));
      } else if (chord === "Ctrl+F") {
        // The terminal pane hears its own Ctrl+F on the way down and opens the
        // scrollback search; everything else lands here. The surface is the
        // one the focus is in, and the sidebar's filter when it is in none.
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".terminal-pane")) return;
        event.preventDefault();
        const surface = target?.closest(".history-pane")
          ? ".history-pane .history-filter input"
          : ".sidebar-search input";
        const field = document.querySelector<HTMLInputElement>(surface);
        field?.focus();
        field?.select();
      }
      if (event.key === "Escape") {
        // Escape in a text field means the field, not the window. Writing a
        // commit message while reading the diff it describes, Escape closed
        // the diff; typed into the sidebar filter, it closed whatever pane was
        // open in the main column. A field inside a dialog is the exception:
        // there Escape means close, and the dialog is what the eye is on.
        const target = event.target;
        if (isEditable(target) && !(target as HTMLElement).closest('[role="dialog"]')) {
          const field = target as HTMLInputElement | HTMLTextAreaElement;
          if (field.closest(".sidebar-search") && field.value !== "") setQuery("");
          else field.blur();
          return;
        }
        // The palette closes itself on Escape, and that is all Escape there
        // means: the history you opened it over is still where you left it.
        // Read from the DOM rather than `paletteOpen`: React flushes the
        // palette's own close before this listener runs, so the state already
        // says closed by the time the event gets here.
        if (target instanceof Element && target.closest(".palette")) return;
        // A right-click menu closes itself on Escape too, and the pane it was
        // opened over stays. Read from the DOM for the same reason.
        if (document.querySelector(".row-menu")) return;
        // The commit pane sits over the history it was opened from, so Escape
        // peels it and leaves the history where it was. A second Escape closes
        // everything, as before. Only when it is the thing on screen, though:
        // the inbox and every dialog draw over it, and Escape there has to
        // close what the eye is on rather than a pane it cannot see.
        const covered =
          inboxOpen ||
          confirmation !== null ||
          settingsOpen !== null ||
          pendingTask !== null ||
          pendingTag !== null ||
          batchOpen ||
          updateOpen ||
          paletteOpen;
        if (commitTarget && !covered) {
          setCommitTarget(null);
          return;
        }
        setConfirmation(null);
        setSettingsOpen(null);
        setPendingTask(null);
        setPendingTag(null);
        // A batch that is still running keeps its dialog: closing it would hide
        // the only place the commands it is about to run are reported.
        setBatchOpen((open) => (open && batch?.running === true ? open : false));
        setInboxOpen(false);
        setUpdateOpen(false);
        setDiffTarget(null);
        setHistoryOpen(false);
      }
    }
    // The terminal lets Ctrl+K through to here rather than handling it itself,
    // see attachCustomKeyEventHandler in TerminalPane.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    batch?.running,
    commitTarget,
    inboxOpen,
    confirmation,
    settingsOpen,
    pendingTask,
    pendingTag,
    batchOpen,
    updateOpen,
    paletteOpen,
    drawn,
    selectedPath,
    tabOf,
    historyOpen,
    openHistory,
    info?.gh.version,
    setBatchOpen,
    setInboxOpen,
    setUpdateOpen,
  ]);

  // The webview's own right-click menu is Back, Reload, Print and Share, none
  // of which is anything here. Every surface that has something to offer opens
  // a menu of its own and stops the event before it gets this far, so what
  // reaches here is a click on nothing and is swallowed. A text field keeps the
  // native one: cut, copy and paste are exactly what a right-click there wants.
  //
  // Selected text is the one thing the native menu did that is worth keeping,
  // so a right-click on a selection anywhere gets Copy and nothing else.
  const [textMenu, setTextMenu] = useState<{ at: MenuAt; text: string } | null>(null);

  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      if (isEditable(event.target)) return;
      event.preventDefault();
      const text = window.getSelection()?.toString() ?? "";
      if (text.length > 0) setTextMenu({ at: { x: event.clientX, y: event.clientY }, text });
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    // Aimed at a repository, landing in whichever of its shells is on screen.
    if (!pendingCommand) return;
    const id = tabOf(pendingCommand.path);
    if (!live.has(id)) return;
    const { command, typeOnly } = pendingCommand;
    const sent = typeOnly ? api.ptyWrite(id, command) : sendCommand(id, command);
    sent.catch((err) => setNote(String(err)));
    setPendingCommand(null);
  }, [pendingCommand, live, setNote, tabOf]);

  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!note) return;
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNoteState(null), 6000);
  }, [note]);



  /**
   * The one refresh button, in the sidebar head beside the folders button.
   *
   * It used to be three: a Refresh in the repository header that re-read one
   * repository and bumped the epoch, a Refresh in the inbox that asked GitHub,
   * and Rescan the fleet in the palette. Each was only visible where it was
   * least needed, and the header's did not exist until a repository was open.
   * One button asks for everything: the sweep re-reads every repository, the
   * epoch re-reads the tags and remote refs the sweep cannot see, and the
   * inbox reads if gh is here to ask.
   *
   * The button reflects only the refresh it started. It used to borrow
   * `scanning` and `inboxReading`, and the inbox poll set the second one every
   * minute while a check was running, so the button greyed out and turned on
   * its own with nothing clicked. A control that disables itself on a timer
   * reads as a fault. The launch sweep and the poll have their own signs: the
   * status bar's count and the inbox's read-just-now line.
   */
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshEpoch((epoch) => epoch + 1);
    try {
      await Promise.all([scan(), info?.gh.version ? refreshInbox() : null]);
    } finally {
      setRefreshing(false);
    }
  }, [scan, refreshInbox, info?.gh.version, refreshing]);


  const lastPush = useRef<number | null>(null);
  const lastFetch = useRef<number | null>(null);

  const refreshRepo = useCallback(
    // `id` is the shell that settled, which is where its blocks are: the
    // repository's first shell unless a second one did the typing.
    (path: string, id: string = path) => {
      api.repoRefresh(path).then(upsert).catch(() => undefined);
      // A commit typed by hand empties the changes pane, and the pane is right
      // next to the prompt it was typed at.
      if (path === selectedRef.current) {
        api.repoChanges(path).then(setChanges).catch(() => undefined);
        // A push is the one command that changes what origin holds without
        // moving anything here, so it is the one that asks `ls-remote` again.
        // The block's id is kept so a dev server settling every few seconds
        // behind a finished push does not ask on every one of them.
        const pushed = [...getBlocks(id)]
          .reverse()
          .find((b) => b.endedAt !== null && /^git push\b/.test(b.command));
        if (pushed && pushed.id !== lastPush.current) {
          lastPush.current = pushed.id;
          setPushEpoch((n) => n + 1);
        }
        // A fetch is the opposite: it moves remote refs and nothing local, and
        // `refSignature` is built from local tips, so the header's Sync typed
        // at this prompt would leave the graph drawn against the old
        // `origin/main`. Same guard, same reason.
        const fetched = [...getBlocks(id)]
          .reverse()
          .find((b) => b.endedAt !== null && /^git (fetch|pull)\b/.test(b.command));
        if (fetched && fetched.id !== lastFetch.current) {
          lastFetch.current = fetched.id;
          setRefreshEpoch((n) => n + 1);
        }
      }

      // A `gh` write the inbox typed here may have finished; the inbox
      // reads the block and decides.
      inboxSettled(path, id);
    },
    [upsert, inboxSettled],
  );
  /** A session settled; the repository it belongs to is what wants re-reading. */
  const settled = useCallback((id: string) => refreshRepo(sessionRepo(id), id), [refreshRepo]);

  const onLiveChange = useCallback((path: string, isLive: boolean) => {
    setLive((current) => {
      const next = new Set(current);
      if (isLive) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const toggleGraph = useCallback(() => {
    updateSettings("graph", { collapsed: !settings().graph.collapsed });
  }, []);

  const setPinned = useCallback(
    async (path: string, pinned: boolean) => {
      await api.repoSetPinned(path, pinned).catch((err) => setNote(String(err)));
      await loadPrefs();
    },
    [loadPrefs, setNote],
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
      // The sweep stopped reading it while it was hidden, so its row is as old
      // as the day it was hidden.
      if (!hidden) api.repoRefresh(path).then(upsert).catch(() => undefined);
    },
    [loadPrefs, selectedPath, setNote, upsert],
  );

  const setTaskHidden = useCallback(
    async (task: Task, hidden: boolean) => {
      if (!selectedPath) return;
      setTasks((current) =>
        current.map((t) => (t.id === task.id ? { ...t, hidden } : t)),
      );
      await api.taskSetHidden(selectedPath, task.id, hidden).catch((err) => setNote(String(err)));
    },
    [selectedPath, setNote],
  );

  const askSetDescription = useCallback(
    (task: Task) => {
      if (!selectedPath) return;
      setPendingDescription({ repoPath: selectedPath, task, text: task.description ?? "" });
    },
    [selectedPath],
  );

  const clearDescription = useCallback(
    async (task: Task) => {
      if (!selectedPath) return;
      setTasks((current) =>
        current.map((t) => (t.id === task.id ? { ...t, description: null } : t)),
      );
      await api
        .taskSetDescription(selectedPath, task.id, null)
        .catch((err) => setNote(String(err)));
    },
    [selectedPath, setNote],
  );

  const saveDescription = useCallback(async () => {
    if (!pendingDescription) return;
    const { repoPath, task, text } = pendingDescription;
    const trimmed = text.trim();
    const description = trimmed.length > 0 ? trimmed : null;
    setTasks((current) =>
      current.map((t) => (t.id === task.id ? { ...t, description } : t)),
    );
    setPendingDescription(null);
    await api
      .taskSetDescription(repoPath, task.id, description)
      .catch((err) => setNote(String(err)));
  }, [pendingDescription, setNote]);

  /**
   * Ending a session always asks first.
   *
   * Persistence is the whole reason a dev server survives switching projects, so
   * the one control that undoes it has to name what it is about to stop. There
   * is no way to tell a live build from an idle prompt from out here.
   */
  const askCloseShell = useCallback(
    (id: string) => {
      const path = sessionRepo(id);
      const repo = repos.find((r) => r.path === path);
      const own = path === info?.dataDir;
      const which = sessionNumber(id) === 1 ? "the shell" : sessionLabel(id);
      setConfirmation({
        title: own ? "Close GitView's own shell" : `Close ${which} in ${repo?.name ?? path}`,
        body: "Anything still running in it stops: a dev server, a watcher, a build. Sessions outlive a view change precisely so those keep going, so this is the only thing that ends one.",
        confirmLabel: "Close the shell",
        onConfirm: () => {
          // The tab that takes its place: the one before it, read before the
          // map forgets this one.
          const remaining = sessionsFor(path).filter((other) => other !== id);
          closeSession(id);
          setLive((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          if (sessionNumber(id) === 1) {
            if (path === selectedPath && tabOf(path) === id) setClosedShell(id);
          } else {
            selectTab(remaining[remaining.length - 1] ?? path);
          }
          if (own) setOwnShell(false);
        },
      });
    },
    [repos, selectedPath, info?.dataDir, tabOf, selectTab],
  );

  /**
   * Types a command that belongs to the app rather than to a repository.
   *
   * The selected repository's shell takes it when there is one, waiting for
   * `live` if it is still starting, and a closed one is reopened for it. With
   * nothing selected the command opens GitView's own shell and waits on that
   * instead, so the update never asks you to pick a repository it has no
   * interest in.
   */
  const emitOwn = useCallback(
    (command: string, typeOnly: boolean) => {
      if (selected) {
        if (closedShell === tabOf(selected.path)) setClosedShell(null);
        setPendingCommand({ path: selected.path, command, typeOnly });
      } else if (info) {
        setOwnShell(true);
        setPendingCommand({ path: info.dataDir, command, typeOnly });
      }
    },
    [selected, closedShell, info, tabOf],
  );

  // The tour waits for a repository to point at, and for the splash to lift.
  // Without gh there is no inbox button, so its step is left out of the count.
  const tourSkip = useMemo(() => (info?.gh.version ? [] : ["inbox"]), [info?.gh.version]);
  const tour = useTour(booted && roots.length > 0 && repos.length > 0, tourSkip);
  const { fire: fireTour } = tour;
  const { close: closeTour } = tour;
  const endTour = useCallback(() => {
    closeTour();
    setNote("Show the tour, in Ctrl+K, walks through the window again.");
  }, [closeTour, setNote]);
  useEffect(() => {
    if (selectedPath) fireTour("select");
  }, [selectedPath, fireTour]);
  useEffect(() => {
    if (paletteOpen) fireTour("palette");
  }, [paletteOpen, fireTour]);
  const finishedBlocks = blocks.filter((block) => block.exitCode !== null).length;
  const seenBlocks = useRef(finishedBlocks);
  useEffect(() => {
    if (finishedBlocks > seenBlocks.current) fireTour("block");
    seenBlocks.current = finishedBlocks;
  }, [finishedBlocks, fireTour]);

  const ownSettled = useCallback(() => {
    if (cloneTarget) scan();
  }, [cloneTarget, scan]);

  useEffect(() => {
    if (!cloneTarget) return;
    const landed = repos.find((repo) => repo.path.toLowerCase() === cloneTarget.toLowerCase());
    if (!landed) return;
    setCloneTarget(null);
    setSelectedPath(landed.path);
  }, [cloneTarget, repos]);

  /**
   * Every action in the app goes through here, so the command is always visible
   * in the terminal rather than happening behind the UI. Holding shift types it
   * without running it.
   */
  const emit = useCallback(
    async (command: string, typeOnly = false) => {
      if (!sessionId) return;
      if (typeOnly) await api.ptyWrite(sessionId, command);
      else await sendCommand(sessionId, command);
    },
    [sessionId],
  );

  /**
   * Throwing away work that was never committed.
   *
   * The one action in the changes pane a scrollback cannot undo, so it is the
   * one that asks first. What it asks with is the command itself, the way Prune
   * does: `git restore` for anything git already has a copy of, `git clean` for
   * anything it does not, and both when the selection holds both.
   *
   * `all` swaps the named paths for `.`, because that is what a person types,
   * and because the pane's bulk control means the working tree rather than the
   * twelve rows that happen to be on screen.
   */
  const askDiscard = useCallback(
    (rows: FileChange[], all: boolean) => {
      if (rows.length === 0) return;
      const targets = rows.map((row) => ({ path: row.path, untracked: isUntracked(row) }));
      const commands = discardCommands(targets, shell, all);
      if (commands.length === 0) return;

      // A restore and a clean are different promises, and the dialog has to
      // make whichever one applies. `git clean` does not put a file back; it
      // takes it away, and there is nowhere it goes.
      const gone = targets.filter((t) => t.untracked).length;
      const kept = targets.length - gone;
      const what =
        gone === 0
          ? "The working tree goes back to what the index holds."
          : kept === 0
            ? gone === 1
              ? "It is untracked, so there is no copy in git to put back. The file is removed."
              : `All ${gone} are untracked, so there is no copy in git to put back. The files are removed.`
            : `The ${kept === 1 ? "tracked one goes" : `${kept} tracked ones go`} back to what the index holds. The other ${gone === 1 ? "one is untracked and is" : `${gone} are untracked and are`} removed outright, because git has no copy to put back.`;

      setConfirmation({
        title: all
          ? `Discard ${rows.length} unstaged ${rows.length === 1 ? "change" : "changes"}`
          : `Discard ${rows[0].path}`,
        body: `${what} None of this has been committed, so there is no reflog to find it in afterwards.`,
        command: commands.join("\n"),
        confirmLabel: all ? `Discard all ${rows.length}` : "Discard",
        onConfirm: async () => {
          // One at a time and in order: `git clean` has to see the working tree
          // `git restore` left, and both belong in the scrollback anyway.
          for (const command of commands) await emit(command, false);
        },
      });
    },
    [shell, emit],
  );

  /**
   * Giving up on a paused operation.
   *
   * `--abort` puts the branch back where it started, which git keeps, but it
   * throws away whatever has been resolved in the working tree since it
   * paused, which nothing keeps. That is the discard rule: the one step here
   * a scrollback cannot undo is the one that asks.
   */
  const askAbort = useCallback(
    (command: string) => {
      if (!selected?.operation) return;
      const op = selected.operation;
      const what =
        op.kind === "bisect"
          ? "Leaves the bisect and checks out the branch you started it from. Nothing in the working tree is lost."
          : `Puts ${op.branch ?? "the branch"} back where it was before the ${op.kind} started. Anything resolved in the working tree since it paused is thrown away, and there is no reflog for that.`;
      setConfirmation({
        title: `Abort the ${op.kind}`,
        body: what,
        command,
        confirmLabel: op.kind === "bisect" ? "Reset" : "Abort",
        onConfirm: () => emit(command),
      });
    },
    [selected, emit],
  );

  /** Every right-click menu's Copy, with the one status line they all share. */
  const copy = useCallback(
    async (text: string, what: string) => {
      const copied = await copyText(text);
      setNote(copied ? `Copied ${what}.` : "The clipboard refused the copy.");
    },
    [setNote],
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
    [setNote],
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
  }, [pendingTask, setNote]);

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
  }, [setNote]);

  // Typed at a prompt, so it is one PowerShell line. A batch runs the same two
  // commands as two separate invocations, see `lib/batch.ts`.
  const syncCommand = "git fetch --prune; git pull --ff-only";

  /**
   * The push, and why it might be off.
   *
   * Off on a detached HEAD, which has no branch to push, and when the branch
   * tracks something and is not ahead of it, which is nothing to push. A
   * branch with no upstream is always on: the first push is what gives it one.
   */
  const push = useMemo(() => {
    if (!selected || !selected.branch || selected.detached) return null;
    const hasUpstream = selected.upstream !== null;
    const command = pushCommand(selected.branch, hasUpstream, shell);
    const nothing = hasUpstream && selected.ahead === 0;
    return {
      command,
      label: hasUpstream ? "Push" : "Publish",
      count: selected.ahead,
      disabled: nothing,
      title: nothing
        ? `Nothing to push: ${selected.branch} is level with ${selected.upstream}.`
        : `${command}\n\n${
            hasUpstream
              ? `${selected.ahead} ${selected.ahead === 1 ? "commit" : "commits"} to ${selected.upstream}.`
              : `${selected.branch} has no upstream yet. This pushes it to origin and sets one.`
          }${selected.behind > 0 ? ` ${selected.upstream} is ${selected.behind} ahead, so git will refuse until you pull.` : ""}\n\nShift-click to type it without running it.`,
    };
  }, [selected, shell]);

  /**
   * Prune, for one repository, with the squash-merged branches included.
   *
   * The two halves take different flags and the dialog has to say so. A branch
   * the trunk already contains goes through `git branch -d`, which refuses
   * anything it is not sure about. A squash-merged branch is contained by
   * nothing, so `-d` refuses it as well, and deleting it means `-D` and taking
   * GitView's word for it. That is stated rather than buried.
   */
  function pruneConfirmation(repo: RepoState, found: Squashed[]): Confirmation {
    const split = pruneSplit(repo, found);
    const total = split.merged.length + split.squashed.length;
    const trunk = repo.defaultBase ?? repo.defaultBranch ?? "the default branch";
    const commands = pruneCommands(split);

    const body =
      split.squashed.length === 0
        ? `Every branch listed is already contained in ${trunk}. git branch -d refuses anything unmerged, and the output prints each deleted branch's commit so it can be recreated.`
        : `${split.merged.length > 0 ? `${split.merged.length} of these are contained in ${trunk}, and go through git branch -d, which refuses anything unmerged. ` : ""}${split.squashed.length} were squash-merged: ${split.squashed.join(", ")}. A squash rebuilds the work as a new commit with no link back, so git considers them unmerged and -d will not take them. GitView matched each one's patch to a commit on ${trunk}. -D deletes them on that evidence rather than on git's. The output prints each commit, so a wrong answer is recoverable.`;

    return {
      title: `Delete ${total} merged ${total === 1 ? "branch" : "branches"}`,
      body,
      command: commands.join("\n"),
      confirmLabel: "Delete branches",
      onConfirm: () => commands.forEach((command) => emit(command)),
    };
  }

  /**
   * One branch, from a right-click. Asks first, the way Prune does, and with
   * the same split: `-d` for a branch the trunk contains, `-D` with the reason
   * spelled out for one it does not. The reason differs. A squash-merged branch
   * is finished work git cannot see; anything else is unmerged work, and the
   * dialog says how many commits that is rather than calling it safe.
   */
  function deleteBranchConfirmation(repo: RepoState, name: string, found: Squashed[]): Confirmation {
    const branch = repo.branches.find((b) => b.name === name);
    const squash = found.find((s) => s.branch === name);
    const trunk = repo.defaultBase ?? repo.defaultBranch ?? "the default branch";
    const arg = quote(name, shell);

    let command: string;
    let body: string;
    if (branch?.merged) {
      command = `git branch -d ${arg}`;
      body = `${name} is already contained in ${trunk}. git branch -d refuses anything unmerged, and its output prints the commit it was at, so it can be recreated.`;
    } else if (squash) {
      command = `git branch -D ${arg}`;
      body = `${name} was squash-merged: GitView matched its patch to ${squash.intoShort} on ${squash.base}. A squash rebuilds the work as a new commit with no link back, so git considers the branch unmerged and -d will not take it. -D deletes it on that evidence rather than on git's. The output prints the commit it was at, so a wrong answer is recoverable.`;
    } else {
      command = `git branch -D ${arg}`;
      const ahead = branch?.ahead ?? 0;
      body = `${name} is not contained in ${trunk}${ahead > 0 ? `: it is ${ahead} ${ahead === 1 ? "commit" : "commits"} ahead of it` : ""}. -d would refuse, so this is -D, which deletes the branch whether or not anything else holds those commits. The output prints the commit it was at, and git reflog keeps it reachable for a while, but nothing here has checked that the work is anywhere else.`;
    }

    return {
      title: `Delete ${name}`,
      body,
      command,
      confirmLabel: "Delete branch",
      onConfirm: () => emit(command),
    };
  }

  const askDeleteBranch = useCallback(
    (name: string) => {
      if (selected) setConfirmation(deleteBranchConfirmation(selected, name, squashed));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, squashed, shell],
  );

  /**
   * A tag, from a right-click on a commit. The dialog asks for the name, takes
   * a message that makes it annotated, and offers the push as a checkbox, so
   * the two lines a release needs come out of one dialog: `git tag` and then
   * `git push origin <tag>`. The second is typed after the first, and a name
   * git refuses fails in the scrollback before the push can send anything.
   */
  const askTag = useCallback(
    (commit: { id: string; short: string; summary: string }) => {
      if (selectedPath) setPendingTag({ repoPath: selectedPath, commit, name: "", message: "", push: false });
    },
    [selectedPath],
  );

  /**
   * Moving the branch to a commit. Asks first, once per mode, with one
   * sentence on what that mode keeps: soft leaves everything staged, mixed
   * leaves it unstaged, and hard throws it away, which is the discard rule.
   * The commits left behind stay in the reflog, and the dialog says how to
   * find them.
   */
  const askReset = useCallback(
    (commit: { id: string; short: string; summary: string }, mode: ResetMode) => {
      if (!selected?.branch || selected.detached) return;
      const command = `git reset --${mode} ${commit.short}`;
      const keeps =
        mode === "soft"
          ? "Everything between here and the current tip stays in the working tree and in the index, staged, as if it had been added and never committed."
          : mode === "mixed"
            ? "Everything between here and the current tip stays in the working tree, unstaged. The index is reset."
            : "The working tree and the index are set to this commit. Every uncommitted change is thrown away, and there is no reflog for those.";
      setConfirmation({
        title: `Reset ${selected.branch} to ${commit.short}`,
        body: `${commit.summary}

${keeps} The commits above it are no longer on ${selected.branch}, and git reflog is where they stay reachable.`,
        command,
        confirmLabel: mode === "hard" ? "Reset and discard" : "Reset",
        onConfirm: () => emit(command),
      });
    },
    [selected, emit],
  );

  const tagLines = useMemo(() => {
    if (!pendingTag) return [];
    const name = pendingTag.name.trim();
    const lines = [tagCommand(name || "<name>", pendingTag.message, pendingTag.commit.short, shell)];
    if (pendingTag.push) lines.push(`git push origin ${quote(name || "<name>", shell)}`);
    return lines;
  }, [pendingTag, shell]);

  const tagNameTaken = pendingTag ? selected?.tags.some((t) => t.name === pendingTag.name.trim()) ?? false : false;
  const tagNameOk = pendingTag ? validRefName(pendingTag.name.trim()) && !tagNameTaken : false;

  function createTag() {
    if (!pendingTag || !tagNameOk) return;
    tagLines.forEach((line) => emit(line));
    setPendingTag(null);
  }




  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    // In the sidebar's order, so the chord in the hint is the row's number.
    const numbered = new Map(drawn.map((repo, index) => [repo.path, repoChord(index)]));
    for (const repo of repos) {
      if (prefs.get(repo.path)?.hidden) continue;
      const chord = numbered.get(repo.path);
      items.push({
        id: `repo:${repo.path}`,
        label: repo.name,
        kind: "repo",
        hint: [repo.branch ?? "", chord].filter(Boolean).join(" · "),
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
      if (push && !push.disabled) {
        items.push({
          id: "action:push",
          label: `${push.label} ${selected.branch}`,
          kind: "git",
          hint: push.command,
          run: () => emit(push.command),
        });
      }
      items.push({
        id: "action:sync",
        label: `Sync ${selected.name}`,
        kind: "git",
        hint: syncCommand,
        run: () => emit(syncCommand),
      });
      if (prunableCount > 0) {
        items.push({
          id: "action:prune",
          label: `Prune ${prunableCount} merged ${prunableCount === 1 ? "branch" : "branches"}`,
          kind: "git",
          hint: pruneCommands(prunable).join("  ·  "),
          run: () => setConfirmation(pruneConfirmation(selected, squashed)),
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
        id: "action:history",
        label: `History of ${selected.name}`,
        kind: "fleet",
        hint: "every commit on every branch · Ctrl+H",
        run: () => openHistory(),
      });
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
    for (const id of live) {
      const path = sessionRepo(id);
      const repo = repos.find((r) => r.path === path);
      const which = sessionNumber(id) === 1 ? "the shell" : sessionLabel(id);
      items.push({
        id: `close:${id}`,
        label: `Close ${which} in ${repo?.name ?? path}`,
        kind: "fleet",
        hint: "ends the process and its scrollback",
        run: () => askCloseShell(id),
      });
    }

    items.push({
      id: "action:sync-all",
      label: "Sync all",
      kind: "fleet",
      hint: "git fetch --prune, then git pull --ff-only where it can",
      run: syncAll,
    });
    items.push({
      id: "action:batch-sync",
      label: "Sync several…",
      kind: "fleet",
      hint: "pick the repositories first",
      run: () => openBatch("sync"),
    });
    items.push({
      id: "action:fetch-all",
      label: "Fetch all",
      kind: "fleet",
      hint: "git fetch --prune in each, nothing pulled",
      run: fetchAll,
    });
    // Ancestry only, and named apart from the single-repository `prunable`
    // above it, which also counts the squash-merged ones. The batch stays on
    // `git branch -d`; see prunePlan for why.
    const containedElsewhere = batchCandidates.filter(
      (repo) => repo.mergedBranches.length > 0,
    );
    if (containedElsewhere.length > 0) {
      const branches = containedElsewhere.reduce(
        (sum, repo) => sum + repo.mergedBranches.length,
        0,
      );
      items.push({
        id: "action:batch-prune",
        label: `Prune merged across ${containedElsewhere.length} repositories…`,
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
        hint: `${waiting > 0 ? `${waiting} waiting on you` : "pull requests and issues, fleet-wide"} · Ctrl+I`,
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
    if (info?.gh.version) {
      const ready = update?.available === true && update.latest != null;
      items.push({
        id: "action:update",
        label: ready ? `Update GitView to ${update!.latest!.version}` : "Check for a new GitView",
        kind: "fleet",
        hint: ready
          ? `${update!.latest!.tag}, from the GitHub release`
          : "asks gh for the latest release",
        run: () => (ready ? setUpdateOpen(true) : checkUpdate(true)),
      });
    }
    items.push({
      id: "action:refresh",
      label: "Refresh",
      kind: "fleet",
      hint: "rescan the fleet, re-read the refs, read the inbox",
      run: refreshAll,
    });
    items.push({
      id: "action:roots",
      label: "Watched folders",
      kind: "fleet",
      hint: "add or remove a folder GitView scans",
      run: () => setSettingsOpen("folders"),
    });
    items.push({
      id: "action:settings",
      label: "Settings",
      kind: "fleet",
      hint: "terminal, launch, GitHub, keyboard, and the folders GitView watches · Ctrl+,",
      run: () => setSettingsOpen("terminal"),
    });
    items.push({
      id: "action:tour",
      label: "Show the tour",
      kind: "fleet",
      hint: "the first-run walk through the window, from the top",
      run: tour.replay,
    });
    // For reviewing the first run over and over under `npm run dev:ftue`.
    // Vite drops the branch from a production bundle.
    if (import.meta.env.DEV) {
      items.push({
        id: "action:reset-first-run",
        label: "Reset first run",
        kind: "fleet",
        hint: "dev build only: forget the watched folders and reload",
        run: async () => {
          await api.settingsSetRoots([]);
          tour.replay();
          window.location.reload();
        },
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    repos,
    prefs,
    drawn,
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
    syncAll,
    fetchAll,
    inbox,
    info,
    update,
    checkUpdate,
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
  // Hidden rows leave the summary as they leave the palette and the batches.
  const summary = useMemo(() => fleetSummary(batchCandidates), [batchCandidates]);
  const shellReady = sessionId != null && live.has(sessionId);

  /**
   * The stash chip's menu: one entry per stash, newest first, each with the
   * three things git can do with it. Pop and apply type straight away. Drop
   * asks first, since a dropped stash is the other thing in this app a
   * scrollback cannot bring back: `git stash drop` prints the sha, and the
   * sha is reachable for as long as gc leaves it, which is a hope rather than
   * a reflog.
   */
  const [stashMenu, setStashMenu] = useState<MenuAt | null>(null);
  const stashEntries = useMemo((): MenuEntry[] => {
    if (!selected) return [];
    const entries: MenuEntry[] = [];
    selected.stashes.forEach((stash, i) => {
      const ref = quote(`stash@{${stash.index}}`, shell);
      if (i > 0) entries.push("-");
      entries.push({ label: stash.message, heading: true });
      entries.push({
        label: "Pop",
        title: `git stash pop ${ref}\n\nApplies it and drops it.`,
        disabled: !shellReady,
        run: (typeOnly) => emit(`git stash pop ${ref}`, typeOnly),
      });
      entries.push({
        label: "Apply",
        title: `git stash apply ${ref}\n\nApplies it and keeps it.`,
        disabled: !shellReady,
        run: (typeOnly) => emit(`git stash apply ${ref}`, typeOnly),
      });
      entries.push({
        label: "Drop",
        danger: true,
        disabled: !shellReady,
        title: "Asks first, and names the command.",
        run: () =>
          setConfirmation({
            title: `Drop stash@{${stash.index}}`,
            body: `${stash.message}\n\nThe output prints the commit it was, which stays reachable until git's next gc and nowhere else. Nothing in the working tree changes.`,
            command: `git stash drop ${ref}`,
            confirmLabel: "Drop it",
            onConfirm: () => emit(`git stash drop ${ref}`),
          }),
      });
    });
    return entries;
  }, [selected, shell, shellReady, emit]);

  /**
   * The pane sharing the main column with the terminal, or nothing.
   *
   * One at a time, and never on top of the shell. These three used to be
   * `position: absolute; inset: 0` over the whole column, which meant clicking
   * a commit in the history printed `git show` into a terminal nobody could see
   * until they closed the history. They are in flow now: the branch strip goes,
   * the terminal keeps the bottom of the column, and what a click prints is
   * readable while the pane that caused it is still open.
   *
   * The precedence is the old paint order. The inbox went in last and drew on
   * top, so the inbox still wins.
   */
  const pane = inboxOpen ? (
    <InboxPane
      inbox={inbox}
      gh={info?.gh ?? null}
      repos={repos}
      selectedPath={selectedPath}
      shell={shell}
      refreshing={inboxReading}
      waiting={inboxTyped}
      onClose={() => {
        setInboxOpen(false);
        setInboxFocus(null);
      }}
      onSelect={(path) => {
        setSelectedPath(path);
        setInboxOpen(false);
        setInboxFocus(null);
      }}
      onCommand={(path, command, typeOnly = false) => {
        // The command lands in that repository's shell, which means selecting
        // it first: a session belongs to a repository. The command waits for
        // that shell rather than for a timer. The pane stays up: the shell is
        // the third of the column under it, so the output is in view, and a
        // merge that closed the inbox left you reopening it to see the row go.
        setSelectedPath(path);
        setPendingCommand({ path, command, typeOnly });
        // Anything `gh` writes changes the next read. A line left at the
        // prompt has not been run, so it arms nothing.
        if (!typeOnly && command.startsWith("gh ")) armAfter(path, command);
      }}
      onMerge={(item, method, command) => {
        const base = item.baseRef ?? "the base branch";
        const head = item.headRef ?? "the branch";
        const landing =
          method === "squash"
            ? `Squashes ${head} into one commit on ${base}.`
            : method === "rebase"
              ? `Rebases ${head}'s commits onto ${base}, one by one.`
              : `Merges ${head} into ${base} with a merge commit.`;
        const cleanup = item.deleteBranchOnMerge
          ? `GitHub deletes ${head} on origin itself afterwards; the local copy stays until Prune.`
          : `Then deletes ${head} on origin and, if the shell is standing on it, switches to ${base} and deletes the local copy too.`;
        const failing = item.checkRuns.filter((run) => run.state === "FAILURE").length;
        const pending = item.checkRuns.filter((run) => run.state === "PENDING").length;
        const warning =
          failing > 0
            ? ` ${failing} ${failing === 1 ? "check is" : "checks are"} failing. GitHub refuses the merge if the branch protection requires them, and merges anyway if it does not.`
            : pending > 0
              ? ` ${pending} ${pending === 1 ? "check is" : "checks are"} still running.`
              : "";
        // The issues go in the dialog because this is the click that closes
        // them, and a merge the dialog did not warn about closing #130 is a
        // reopen later.
        const closing =
          item.closes.length === 0
            ? ""
            : `

When it lands, GitHub closes:
${item.closes.map((ref) => `${refLabel(ref, item.ownerRepo)}  ${ref.title}`).join("\n")}`;
        setConfirmation({
          title: `Merge #${item.number} into ${base}`,
          body: `${item.title}

${landing} ${cleanup}${warning}${closing}`,
          command,
          confirmLabel: "Merge",
          onConfirm: () => {
            setSelectedPath(item.repoPath);
            setPendingCommand({ path: item.repoPath, command, typeOnly: false });
            armAfter(item.repoPath, command, [itemKey(item), ...item.closes.map(refKey)]);
          },
        });
      }}
      openKey={inboxFocus}
      onError={setNote}
      onCopy={copy}
    />
  ) : commitTarget && selected ? (
    <CommitPane
      target={commitTarget}
      commit={commit}
      file={commitFile}
      disabled={!shellReady}
      shell={shell}
      onClose={() => setCommitTarget(null)}
      onCommand={emit}
      onOpenCommit={openCommit}
    />
  ) : historyOpen && selected ? (
    <HistoryPane
      repoPath={selected.path}
      repoName={selected.name}
      disabled={!shellReady}
      squashed={squashed}
      reloadKey={refSignature}
      shell={shell}
      prunable={prunableCount}
      pruneTitle={
        prunableCount > 0 ? pruneCommands(prunable).join("\n") : "No merged branches to delete"
      }
      onPrune={() => setConfirmation(pruneConfirmation(selected, squashed))}
      onClose={() => {
        setHistoryOpen(false);
        setHistorySeed(null);
      }}
      onCommand={emit}
      onOpen={openCommit}
      onDeleteBranch={askDeleteBranch}
      onTag={askTag}
      onReset={askReset}
      headBranch={selected.detached ? null : selected.branch}
      remoteTags={remoteTags}
      hasRemote={hasRemote}
      onCopy={copy}
      onError={setNote}
      seed={historySeed}
    />
  ) : diffTarget ? (
    <DiffPane
      target={diffTarget}
      sides={diffSides}
      disabled={!shellReady}
      shell={shell}
      /* `changes` is replaced whenever the working tree is re-read, which is
         exactly when a diff can have changed under the pane. */
      reloadKey={changes}
      onSide={(staged) => setDiffTarget({ ...diffTarget, staged })}
      onFileHistory={() => openFileHistory(diffTarget.file)}
      onClose={() => setDiffTarget(null)}
      onCommand={emit}
      onError={setNote}
    />
  ) : null;

  return (
    <div
      ref={appRef}
      className={`app${arriving ? " arriving" : ""}`}
      style={
        {
          "--sidebar-w": `${layout.sidebar}px`,
          "--changes-w": `${layout.changes}px`,
        } as CSSProperties
      }
    >
      <Splitter
        side="sidebar"
        width={layout.sidebar}
        other={layout.changes}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        mainMin={mainMin}
        onDrag={(w) => setColumn("--sidebar-w", w)}
        onDrop={(sidebar) => updateSettings("layout", { sidebar })}
        onReset={() => updateSettings("layout", { sidebar: DEFAULTS.layout.sidebar })}
      />
      <Splitter
        side="changes"
        width={layout.changes}
        other={layout.sidebar}
        min={CHANGES_MIN}
        max={CHANGES_MAX}
        mainMin={mainMin}
        onDrag={(w) => setColumn("--changes-w", w)}
        onDrop={(changes) => updateSettings("layout", { changes })}
        onReset={() => updateSettings("layout", { changes: DEFAULTS.layout.changes })}
      />
      {/* The fleet and the tasks share the left rail. Tasks belong to whichever
          repository is selected, which is chosen immediately above them, and
          moving them here freed the right-hand column for the working tree. */}
      <div className="rail">
        <FleetSidebar
          repos={repos}
          watching={roots.length > 0}
          prefs={prefs}
          github={repoGithub}
          inboxWaiting={inboxWaiting}
          onOpenInbox={info?.gh.version ? () => setInboxOpen(true) : null}
          selectedPath={selectedPath}
          liveSessions={livePaths}
          query={query}
          scanning={scanning}
          refreshing={refreshing}
          onRefresh={refreshAll}
          onQuery={setQuery}
          onSelect={setSelectedPath}
          onPin={setPinned}
          onReorderPins={reorderPins}
          onHide={setHidden}
          onCopy={copy}
          onCloseShell={askCloseShell}
          onManageRoots={() => setSettingsOpen("folders")}
          onOpenSettings={() => setSettingsOpen("terminal")}
        />
        <TaskList
          tasks={selected ? tasks : []}
          disabled={!shellReady}
          onRun={(task, typeOnly) => emit(task.command, typeOnly)}
          onSetHidden={setTaskHidden}
          onSetDescription={askSetDescription}
          onClearDescription={clearDescription}
          onDelete={askDeleteTask}
          onCopy={copy}
        />
      </div>

      <main className={`main${pane ? " split" : ""}`}>
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
                    onClick={() => {
                      setInboxFocus(itemKey(branchPr));
                      setInboxOpen(true);
                    }}
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
                <BranchMenu
                  repo={selected}
                  shell={shell}
                  squashed={squashed}
                  onCommand={emit}
                  onDeleteBranch={askDeleteBranch}
                  onCopy={copy}
                />
                {/* The same chips as the sidebar row, so a count means the same
                    thing in both places and wears the same colour. */}
                <span className="path head-stats">
                  {selected.ahead > 0 && (
                    <span className="chip ahead" title="commits ahead of upstream">
                      ↑{selected.ahead}
                    </span>
                  )}
                  {selected.behind > 0 && (
                    <span className="chip behind" title="commits behind upstream">
                      ↓{selected.behind}
                    </span>
                  )}
                  {dirty > 0 && (
                    <span className="chip dirty" title="staged and modified files">
                      {dirty} changed
                    </span>
                  )}
                  {/* Click types `git stash list`, so the entries land where
                      they can be read; right-click offers each one. */}
                  {selected.stashes.length > 0 && (
                    <button
                      className="chip branches chip-button"
                      title={`${stashTitle(selected.stashes)}\n\ngit stash list\nRight-click for pop, apply and drop.`}
                      disabled={!shellReady}
                      onClick={(e) => emit("git stash list", e.shiftKey)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setStashMenu({ x: e.clientX, y: e.clientY });
                      }}
                    >
                      ⧉{selected.stashes.length} {selected.stashes.length === 1 ? "stash" : "stashes"}
                    </button>
                  )}
                  {selected.lastCommitAt && <span>{relativeTime(selected.lastCommitAt)}</span>}
                </span>
              </div>

              <div className="head-actions" data-tour="actions">
                {push && (
                  <button
                    className="btn"
                    disabled={push.disabled || !shellReady}
                    title={shellReady ? push.title : "Waiting for the shell"}
                    onClick={(e) => emit(push.command, e.shiftKey)}
                  >
                    {push.label}
                    {push.count > 0 && <span className="btn-count">↑{push.count}</span>}
                  </button>
                )}
                <button
                  className="btn"
                  title={`${syncCommand}\n\nShift-click to type it without running it.`}
                  onClick={(e) => emit(syncCommand, e.shiftKey)}
                >
                  Sync
                </button>
                <button
                  className="btn accent"
                  data-tour="palette"
                  onClick={() => setPaletteOpen(true)}
                >
                  Ctrl+K
                </button>
              </div>
            </header>

            {selected.operation && (
              <OperationBar
                operation={selected.operation}
                conflicted={selected.conflicted}
                disabled={!shellReady}
                onCommand={emit}
                onAbort={askAbort}
              />
            )}

            <BranchGraph
              graph={graph}
              collapsed={graphCollapsed}
              squashed={headSquashed}
              onToggle={toggleGraph}
              onHistory={openHistory}
              onCommand={emit}
              onOpen={openCommit}
              onCopy={copy}
              onTag={askTag}
              onReset={askReset}
              branches={selected.branches}
              shell={shell}
            />

            {/* Between the strip and the shell. `.main.split` hides the strip,
                so the pane takes that height and the rest from the terminal,
                which keeps a floor rather than being covered over. */}
            {pane}

            <TerminalPane
              repoPath={selected.path}
              sessionId={sessionId}
              onSelectTab={selectTab}
              open={closedShell !== sessionId}
              onSettled={settled}
              onLiveChange={onLiveChange}
              onRequestClose={askCloseShell}
              onNote={setNote}
              onReopen={() => setClosedShell(null)}
            >
              <BlockBar
                blocks={blocks}
                onRun={(command, typeOnly) => emit(command, typeOnly)}
                onSave={askSaveTask}
                onCopy={copyBlock}
                onCopyText={copy}
                onReveal={(block) => revealBlock(block.repoPath, block.id)}
                portCommand={(port) => openUrlCommand(`http://localhost:${port}`, shell)}
                onPort={(port) => emit(openUrlCommand(`http://localhost:${port}`, shell))}
              />
            </TerminalPane>
          </>
        ) : ownShell && info ? (
          /* GitView's own shell, in the place a repository's would be. No block
             bar: nothing here is a task worth saving against a repository. */
          <>
            {pane}
            <TerminalPane
              repoPath={info.dataDir}
              sessionId={info.dataDir}
              onSelectTab={noop}
              open
              onSettled={ownSettled}
              onLiveChange={onLiveChange}
              onRequestClose={askCloseShell}
              onNote={setNote}
              onReopen={noop}
            />
          </>
        ) : (
          /* Nothing selected means there is no shell to keep visible, so the
             pane gets the column outright rather than splitting it with a
             placeholder. The inbox is the one that opens from here. */
          pane ?? (
            <div className="terminal-pane">
              <div className="pane-tab-bar">
                <span>terminal</span>
              </div>
              {roots.length === 0 || (repos.length === 0 && !scanning) ? (
                <Welcome
                  roots={roots}
                  shell={shell}
                  onRoots={(next) => {
                    setRoots(next);
                    scan();
                  }}
                  onClone={(command, typeOnly, target) => {
                    setCloneTarget(target);
                    emitOwn(command, typeOnly);
                  }}
                />
              ) : (
                <p className="empty">
                  {repos.length === 0 && scanning
                    ? "Scanning the roots…"
                    : "Pick a repository on the left to open its shell, or press Ctrl+K."}
                </p>
              )}
            </div>
          )
        )}
      </main>

      {/* While a commit is open the column lists that commit's files, so the
          main column keeps its full height for the hunks. The working tree is
          back the moment the pane closes. */}
      {commitTarget && selected ? (
        <CommitFilesPane
          target={commitTarget}
          commit={commit}
          file={commitFile}
          disabled={!shellReady}
          shell={shell}
          onPick={setCommitFile}
          onCommand={emit}
          onCopy={copy}
          onNote={setNote}
          onClose={() => setCommitTarget(null)}
          onFileHistory={openFileHistory}
        />
      ) : (
        <ChangesPane
          repo={selected}
          changes={changes}
          disabled={!shellReady}
          shell={shell}
          open={diffTarget}
          onCommand={emit}
          onOpenDiff={openDiff}
          onDiscard={askDiscard}
          onCopy={copy}
          onNote={setNote}
          onFileHistory={openFileHistory}
        />
      )}

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
        {/* A live region, always present, so a note like Copied is spoken.
            A region that appears with its text does not announce it. */}
        <span className="status-note" role="status" aria-live="polite">
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
        </span>
        {update?.available && update.latest && (
          <button
            className="status-link"
            style={{ color: "var(--accent)" }}
            onClick={() => setUpdateOpen(true)}
            title={`GitView ${update.latest.version} is out. You are on ${update.current}.`}
          >
            update {update.latest.version}
          </button>
        )}
        <span className="spacer" />
        {/* What the fleet needs, then the button that clears the front of the
            list. The tooling that used to sit here (gh, git, the shell) only
            speaks up now when something is wrong with it, since a version
            string nobody acts on was the one thing on this bar without a
            click behind it. */}
        {info && !info.gh.version && (
          <span title="gh is not on PATH, so there is no inbox.">no gh</span>
        )}
        {info?.gh.version && !info.gh.loggedIn && (
          <span title={`${info.gh.version}, not logged in. Run gh auth login.`}>gh · no auth</span>
        )}
        {info && !info.shellIntegration && (
          <span title="This shell reports nothing about the commands run in it, so there are no blocks.">
            no blocks
          </span>
        )}
        <span
          className="fleet-summary"
          title={
            fetchedAt
              ? `As of the last fetch, ${relativeTime(fetchedAt)}. Each number counts repositories.`
              : "Nothing has fetched yet, so this is as of the last time each repository was read."
          }
        >
          {summary.length > 0
            ? summary.join(" · ")
            : `fleet in sync · fetched ${relativeTime(fetchedAt)}`}
        </span>
        {batch?.running && batch.kind !== "prune" ? (
          <span className="sync-all busy" aria-live="polite">
            {batch.kind === "fetch" ? "Fetching" : "Syncing"} {Math.min(batch.done + 1, batch.rows.length)} of{" "}
            {batch.rows.length}…
          </span>
        ) : batch && !batchOpen && batch.kind === "sync" && !transcriptSeen ? (
          <button
            className="sync-all"
            onClick={() => {
              setTranscriptSeen(true);
              setBatchOpen(true);
            }}
            title="Every command the sync ran, and what git said"
          >
            Transcript
          </button>
        ) : (
          <button
            className="sync-all"
            onClick={syncAll}
            disabled={batchCandidates.length === 0 || batch?.running === true}
            title="git fetch --prune, then git pull --ff-only in each repository it can fast-forward. The rest are fetched and left alone."
          >
            Sync all
          </button>
        )}
      </div>

      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      )}

      {settingsOpen && (
        <SettingsDialog
          section={settingsOpen}
          onSection={setSettingsOpen}
          roots={roots}
          onRoots={(next) => {
            setRoots(next);
            scan();
          }}
          info={info}
          shell={shell}
          onCommand={(command, typeOnly) => {
            emitOwn(command, typeOnly);
            setSettingsOpen(null);
          }}
          onReplayTour={() => {
            setSettingsOpen(null);
            tour.replay();
          }}
          onClose={() => setSettingsOpen(null)}
        />
      )}

      {batchOpen && (
        <BatchDialog
          key={`${batchKind}:${batchEpoch}`}
          kind={batchKind}
          candidates={batchCandidates}
          run={batch}
          onStart={(paths) => runBatch(batchKind, paths)}
          onCancel={stopBatch}
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
        <Dialog
          label="Keep this command as a task"
          onClose={() => setPendingTask(null)}
          onSubmit={saveTask}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPendingTask(null)}>
                Cancel
              </button>
              <button type="submit" className="btn accent" disabled={!pendingTask.name.trim()}>
                Save the task
              </button>
            </>
          }
        >
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
        </Dialog>
      )}

      {pendingDescription && (
        <Dialog
          label={`Description for ${pendingDescription.task.name}`}
          onClose={() => setPendingDescription(null)}
          onSubmit={saveDescription}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPendingDescription(null)}>
                Cancel
              </button>
              <button type="submit" className="btn accent">
                Save
              </button>
            </>
          }
        >
          <p>
            Shown as a tooltip over this task. Kept in GitView's own database, keyed to this
            folder: nothing is written into the repository.
          </p>
          <input
            className="text-input"
            autoFocus
            value={pendingDescription.text}
            placeholder="What this task is for"
            onChange={(e) =>
              setPendingDescription({ ...pendingDescription, text: e.target.value })
            }
          />
        </Dialog>
      )}

      {pendingTag && (
        <Dialog
          label={`Tag ${pendingTag.commit.short}`}
          onClose={() => setPendingTag(null)}
          onSubmit={createTag}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPendingTag(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn accent"
                disabled={!tagNameOk || !shellReady}
                title={
                  !shellReady
                    ? "Waiting for the shell"
                    : tagNameTaken
                      ? "A tag by that name already exists here."
                      : !tagNameOk
                        ? "Needs a name git would take."
                        : tagLines.join("\n")
                }
              >
                {pendingTag.push && hasRemote ? "Tag and push" : "Create tag"}
              </button>
            </>
          }
        >
          <p>
            {pendingTag.commit.summary}
            {"\n"}A message makes it an annotated tag, the kind a release wants. Without one it is
            a lightweight tag, a name and nothing else.
          </p>
          <div className="tag-fields">
            <input
              className="text-input"
              autoFocus
              spellCheck={false}
              value={pendingTag.name}
              placeholder="v1.2.0"
              title={
                tagNameTaken
                  ? "A tag by that name already exists here."
                  : pendingTag.name && !tagNameOk
                    ? "git would refuse this name."
                    : undefined
              }
              onChange={(e) => setPendingTag({ ...pendingTag, name: e.target.value })}
            />
            <textarea
              value={pendingTag.message}
              placeholder="Message, for an annotated tag. Leave it empty for a lightweight one."
              onChange={(e) => setPendingTag({ ...pendingTag, message: e.target.value })}
            />
            <label className={hasRemote ? undefined : "off"}>
              <input
                type="checkbox"
                checked={pendingTag.push && hasRemote}
                disabled={!hasRemote}
                onChange={(e) => setPendingTag({ ...pendingTag, push: e.target.checked })}
              />
              {hasRemote ? "Push it to origin too" : "No origin to push to"}
            </label>
          </div>
          <pre>{tagLines.join("\n")}</pre>
        </Dialog>
      )}

      {updateOpen && update && (
        <UpdateDialog
          check={update}
          shell={shell}
          target={selected?.name ?? null}
          onCommand={(command, typeOnly) => {
            emitOwn(command, typeOnly);
            setUpdateOpen(false);
          }}
          onCopy={async (text) => {
            const copied = await copyText(text);
            setNote(copied ? "Copied the command." : "The clipboard refused the copy.");
          }}
          onClose={() => setUpdateOpen(false)}
        />
      )}

      {stashMenu && (
        <ContextMenu
          at={stashMenu}
          label="Stashes"
          entries={stashEntries}
          onClose={() => setStashMenu(null)}
        />
      )}

      {textMenu && (
        <ContextMenu
          at={textMenu.at}
          label="Selection"
          entries={[{ label: "Copy", run: () => copy(textMenu.text, "the selection") }]}
          onClose={() => setTextMenu(null)}
        />
      )}

      {confirmation && (
        <Dialog
          label={confirmation.title}
          onClose={() => setConfirmation(null)}
          actions={
            <>
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
            </>
          }
        >
          <p>{confirmation.body}</p>
          {confirmation.command && <pre>{confirmation.command}</pre>}
        </Dialog>
      )}
      {tour.step && (
        <Tour
          step={tour.step}
          index={tour.index}
          total={tour.total}
          onNext={() => fireTour("next")}
          onClose={endTour}
        />
      )}
      <Splash done={booted} />
    </div>
  );
}
