import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  cleanupCommands,
  cleanupRows,
  confirmLabel,
  pullFirst,
  type CleanupRow,
  type ShellState,
} from "../lib/cleanup";
import type { ShellKind } from "../lib/shell";
import { relativeTime, type CleanupRead, type GitOutcome, type RepoState, type Squashed } from "../lib/types";
import Dialog from "./Dialog";

/** One branch to start from, when the dialog opened from that branch's menu. */
export interface CleanupFocus {
  branch: string;
  withRemote: boolean;
}

interface Props {
  repo: RepoState;
  shell: ShellKind;
  focus: CleanupFocus | null;
  /** The re-read after the fetch is news to the rest of the app too. */
  onState: (state: RepoState) => void;
  /** What GitView's own shells in a folder are doing, since they close first. */
  shellState: (path: string) => ShellState;
  /** Types the lines, after closing GitView's shells in those folders. */
  onRun: (commands: string[], worktrees: string[]) => void;
  onClose: () => void;
}

interface Snapshot {
  repo: RepoState;
  squashed: Squashed[];
  read: CleanupRead;
}

async function readAll(path: string): Promise<Snapshot> {
  const [repo, squashed, read] = await Promise.all([
    api.repoRefresh(path),
    api.repoSquashed(path),
    api.repoCleanup(path),
  ]);
  return { repo, squashed, read };
}

/** A group's own tick: on, off, or the dash when only some of its rows are on. */
function GroupTick({
  rows,
  isTicked,
  onChange,
}: {
  rows: CleanupRow[];
  isTicked: (row: CleanupRow) => boolean;
  onChange: (value: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  const on = rows.filter(isTicked).length;
  useEffect(() => {
    if (box.current) box.current.indeterminate = on > 0 && on < rows.length;
  }, [on, rows.length]);
  return (
    <input
      ref={box}
      type="checkbox"
      checked={rows.length > 0 && on === rows.length}
      disabled={rows.length === 0}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/**
 * Ready and not ready, one line a branch.
 *
 * Reading this should take as long as reading the branch menu, which is where
 * its words come from: `merged`, `squashed`, `gone`, `local`, `worktree`. Each
 * tag's title holds the sentence, and the commands are one click down, so nothing
 * is hidden and nothing has to be read to press the button on a routine tidy-up.
 *
 * It fetches first, since a merge an hour ago is what makes a row ready, and that
 * is why a remote delete here is never aimed at a ref already gone. The rows from
 * before the fetch show straight away and the button waits for it.
 */
export default function CleanupDialog({
  repo,
  shell,
  focus,
  onState,
  shellState,
  onRun,
  onClose,
}: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [fetching, setFetching] = useState(repo.remoteUrl !== null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Only what somebody changed. Everything else follows the row, so a row a
  // fetch has just proved ready starts ticked without undoing a choice.
  const [changed, setChanged] = useState<Map<string, boolean>>(new Map());
  const [withRemote, setWithRemote] = useState(focus ? focus.withRemote : true);

  const path = repo.path;
  const hasRemote = repo.remoteUrl !== null;
  useEffect(() => {
    let stale = false;
    const load = async () => {
      const next = await readAll(path);
      if (stale) return;
      setSnapshot(next);
      onState(next.repo);
    };
    const run = async () => {
      try {
        await load();
        if (!hasRemote || stale) return;
        const outcome = await api.gitRun(path, ["fetch", "--prune"]).catch(
          (err): GitOutcome => ({
            code: -1,
            stdout: "",
            stderr: String(err),
            command: "git fetch --prune",
          }),
        );
        if (stale) return;
        if (outcome.code !== 0) setFetchError(outcome.stderr.trim() || `exit ${outcome.code}`);
        await load();
      } catch (err) {
        if (!stale) setFailed(String(err));
      } finally {
        if (!stale) setFetching(false);
      }
    };
    void run();
    return () => {
      stale = true;
    };
    // `onState` is a stable setter, and `repo` changes every time `onState` runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, hasRemote]);

  const rows = useMemo(
    () => (snapshot ? cleanupRows(snapshot.repo, snapshot.squashed, snapshot.read, shellState) : []),
    [snapshot, shellState],
  );

  const selectable = (row: CleanupRow) =>
    row.blocked === null && (withRemote || row.branch !== null || row.worktree !== null);
  const starts = (row: CleanupRow) => (focus ? row.key === focus.branch : row.ticked);
  const isTicked = (row: CleanupRow) => selectable(row) && (changed.get(row.key) ?? starts(row));

  const ticked = rows.filter(isTicked);
  const commands = cleanupCommands(ticked, {
    kind: shell,
    pull: snapshot ? pullFirst(snapshot.repo) : false,
    withRemote,
  });
  const worktrees = ticked.flatMap((row) =>
    row.worktree && !row.worktree.prunable ? [row.worktree.path] : [],
  );

  const setGroup = (group: CleanupRow[], value: boolean) =>
    setChanged((current) => {
      const next = new Map(current);
      for (const row of group) next.set(row.key, value);
      return next;
    });

  const renderRow = (row: CleanupRow) => {
    const off = !selectable(row);
    return (
      <label
        key={row.key}
        className={`cleanup-row${off ? " blocked" : ""}`}
        title={off ? (row.blocked ?? undefined) : undefined}
      >
        <input
          type="checkbox"
          checked={isTicked(row)}
          disabled={off}
          onChange={(event) => {
            const value = event.target.checked;
            setChanged((current) => new Map(current).set(row.key, value));
          }}
        />
        <span className="cleanup-name" title={row.label}>
          {row.label}
        </span>
        <span className="cleanup-tags">
          {row.tags
            .filter((tag) => withRemote || !tag.origin)
            .map((tag) => (
              <span key={tag.label} className={`chip ${tag.chip}`} title={tag.title}>
                {tag.label}
              </span>
            ))}
        </span>
        <span className="cleanup-when">
          {row.lastCommitAt ? relativeTime(row.lastCommitAt) : ""}
        </span>
      </label>
    );
  };

  const renderGroup = (name: string, group: CleanupRow[]) => {
    if (group.length === 0) return null;
    const tickable = group.filter(selectable);
    return (
      <>
        <label className="cleanup-group">
          <GroupTick
            rows={tickable}
            isTicked={isTicked}
            onChange={(value) => setGroup(tickable, value)}
          />
          {name}
          <span className="cleanup-count">{group.length}</span>
        </label>
        {group.map(renderRow)}
      </>
    );
  };

  const nothing = snapshot !== null && !fetching && rows.length === 0;

  return (
    <Dialog
      label="Clean up branches"
      className="wide"
      onClose={onClose}
      actions={
        nothing ? undefined : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn accent"
              disabled={ticked.length === 0 || fetching}
              title={fetching ? "git fetch --prune" : commands.join("\n")}
              onClick={() => {
                onRun(commands, worktrees);
                onClose();
              }}
            >
              {fetching ? "Fetching…" : confirmLabel(ticked, withRemote)}
            </button>
          </>
        )
      }
    >
      {failed && <p>This repository could not be read: {failed}</p>}
      {nothing && !failed && <p>Nothing to clean up.</p>}

      {fetchError && (
        <p className="cleanup-fetch-failed" title={fetchError}>
          Could not reach origin, so this is as of the last fetch.
        </p>
      )}

      {rows.length > 0 && (
        <div className="batch-list cleanup-list">
          {renderGroup("Ready", rows.filter((row) => row.ticked))}
          {renderGroup("Not ready", rows.filter((row) => !row.ticked))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="cleanup-foot">
          <details className="cleanup-commands">
            <summary>
              {commands.length} {commands.length === 1 ? "command" : "commands"}
            </summary>
            <pre>{commands.join("\n")}</pre>
          </details>
          {hasRemote && (
            <label className="cleanup-remote">
              <input
                type="checkbox"
                checked={withRemote}
                onChange={(event) => setWithRemote(event.target.checked)}
              />
              Also delete on origin
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}
