import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { settings } from "../lib/settings";
import { fetchPlan, isSkip, newRun, runRepo, verbFor, type BatchKind, type BatchRow, type BatchRun } from "../lib/batch";
import type { RepoPref, RepoState } from "../lib/types";

interface Args {
  repos: RepoState[];
  prefs: Map<string, RepoPref>;
  /** The first sweep has resolved, which is when a launch fetch may plan. */
  swept: boolean;
  upsert: (repo: RepoState) => void;
  setNote: (text: string) => void;
  /** A note with something to click: the one that opens the transcript. */
  setNoteWith: (text: string, onClick: () => void) => void;
}

/**
 * The fleet-wide batches: the run loop, the transcript, the stop flag and
 * the token, plus the two launches (fetch-all from the palette, sync-all from
 * the status bar) and the fetch that runs on its own when the last one has
 * gone stale.
 */
export function useBatch({ repos, prefs, swept, upsert, setNote, setNoteWith }: Args) {
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
  /** Seconds since the epoch at which the fleet was last fetched, 0 for never. */
  const [fetchedAt, setFetchedAt] = useState(0);
  /** Whether the last Sync all's transcript has been opened, so the button can go back to being Sync all. */
  const [transcriptSeen, setTranscriptSeen] = useState(true);

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
    async (kind: BatchKind, paths: string[], whole = false) => {
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
      // The fleet counts as fetched when the run was aimed at all of it and
      // reached the end. A stopped run leaves the rest at whatever the last
      // fetch left them.
      if (kind !== "prune" && whole && !stopped) {
        const at = Math.floor(Date.now() / 1000);
        setFetchedAt(at);
        api.settingsSetFetchedAt(at).catch(() => undefined);
      }
      setNoteWith(
        `${verbFor[kind]} ran in ${acted} ${acted === 1 ? "repository" : "repositories"}` +
          (failures > 0 ? `, ${failures} failed` : "") +
          (stopped ? ", then stopped" : "") +
          ".",
        () => setBatchOpen(true),
      );
    },
    [repos, upsert, setNoteWith],
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
      true,
    );
  }, [batchCandidates, runBatch, setNote]);

  /**
   * The button in the status bar. Sync, over the whole fleet, with no pick
   * list: the dialog pre-checks every eligible row anyway, so the pick stage
   * is a click that changes nothing. The transcript is written as always and
   * the button turns into the way to open it.
   */
  const syncAll = useCallback(() => {
    setBatchKind("sync");
    setBatchEpoch((n) => n + 1);
    setBatchOpen(false);
    setTranscriptSeen(false);
    return runBatch("sync", batchCandidates.map((repo) => repo.path), true);
  }, [batchCandidates, runBatch]);

  /**
   * One fetch on launch when the last one has gone stale, under the same
   * ten-minute rule the inbox uses.
   *
   * Every `↓n` chip and the whole attention sort come from the last fetch,
   * and a scan does not fetch, so without this the sidebar could not see a
   * repository that fell behind overnight. Fetch rather than sync: nothing in
   * a working tree moves on its own at launch. It waits for the first sweep
   * to resolve: the cached rows arrive a render before the preferences do,
   * and a fetch planned from that render includes the hidden repositories.
   */
  const fetchLaunched = useRef(false);
  useEffect(() => {
    if (fetchLaunched.current || !swept || batchCandidates.length === 0) return;
    fetchLaunched.current = true;
    if (!settings().launch.fetch) return;
    if (Math.floor(Date.now() / 1000) - fetchedAt > 600) fetchAll();
  }, [swept, batchCandidates, fetchedAt, fetchAll]);

  /**
   * Opens a fresh pick stage.
   *
   * The epoch is what remounts the dialog. Ctrl+K reaches the palette over an
   * open transcript, so asking for a prune while a finished sync was still on
   * screen left the dialog mounted and holding the sixteen repositories the
   * sync had selected.
   */
  const openBatch = useCallback((kind: BatchKind) => {
    setBatchKind(kind);
    setBatch(null);
    setBatchEpoch((n) => n + 1);
    setBatchOpen(true);
  }, []);

  /** Stop after the repository that is running. */
  const stopBatch = useCallback(() => {
    batchStopped.current = true;
  }, []);

  return {
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
    /** For the boot read, which loads the stored time beside the fleet rows. */
    setFetchedAt,
    transcriptSeen,
    setTranscriptSeen,
  };
}
