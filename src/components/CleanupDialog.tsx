import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  cleanupCommands,
  cleanupRows,
  confirmLabel,
  pullFirst,
  touchesClaude,
  type CleanupRow,
} from "../lib/cleanup";
import type { ShellKind } from "../lib/shell";
import type { CleanupRead, GitOutcome, RepoState, Squashed } from "../lib/types";
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
  /** GitView's own shells in those folders, as a sentence. Null when it has none. */
  describeShells: (paths: string[]) => string | null;
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

/**
 * Every branch but the one you are on, and what deleting each one takes.
 *
 * What the dialog says is only worth anything if it is current, so it fetches
 * first: a merge on GitHub an hour ago is what turns a row from unfinished into
 * finished, and it is why a remote delete here is never aimed at a ref already
 * gone. The rows from before the fetch show straight away, and the button waits
 * for the fetch, whichever way it ends.
 */
export default function CleanupDialog({
  repo,
  shell,
  focus,
  onState,
  describeShells,
  onRun,
  onClose,
}: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [fetching, setFetching] = useState(repo.remoteUrl !== null);
  const [fetched, setFetched] = useState<GitOutcome | null>(null);
  // Only what somebody changed. Everything else follows the row, so a row a
  // fetch has just proved finished starts ticked without undoing a choice.
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
        setFetched(outcome);
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
    () => (snapshot ? cleanupRows(snapshot.repo, snapshot.squashed, snapshot.read) : []),
    [snapshot],
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

  const setAll = (test: (row: CleanupRow) => boolean) =>
    setChanged(new Map(rows.map((row) => [row.key, test(row)])));

  const worktrees = ticked.flatMap((row) =>
    row.worktree && !row.worktree.prunable ? [row.worktree.path] : [],
  );
  const shells = describeShells(worktrees);
  // What will go leads its group. Sorted on how the row starts rather than on
  // its tick, so a row does not jump out from under the pointer when clicked.
  const finished = rows
    .filter((row) => row.finished)
    .sort((a, b) => Number(b.ticked) - Number(a.ticked));
  const others = rows.filter((row) => !row.finished);
  const on = snapshot?.repo.branch ?? repo.branch ?? "this branch";

  const renderRow = (row: CleanupRow) => {
    const blockedHere = !selectable(row);
    return (
      <label
        key={row.key}
        className={`cleanup-row${blockedHere ? " blocked" : ""}`}
        title={row.worktree?.path ?? undefined}
      >
        <input
          type="checkbox"
          checked={isTicked(row)}
          disabled={blockedHere}
          onChange={(event) => {
            const value = event.target.checked;
            setChanged((current) => new Map(current).set(row.key, value));
          }}
        />
        <span className="cleanup-name">{row.label}</span>
        <span className="cleanup-note">{row.why}</span>
        {row.blocked && <span className="cleanup-note">{row.blocked}</span>}
        {row.notes.map((note) => (
          <span key={note} className="cleanup-note">
            {note}
          </span>
        ))}
        {withRemote && row.remoteNote && <span className="cleanup-note">{row.remoteNote}</span>}
      </label>
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
      {failed ? (
        <p>This repository could not be read: {failed}</p>
      ) : nothing ? (
        <p>Nothing to clean up.</p>
      ) : (
        <p>
          Every branch but <code>{on}</code>. Finished ones start ticked. A tick removes the
          worktree holding the branch, then the branch, then its copy on origin.
        </p>
      )}

      {hasRemote && !failed && (
        <div className="cleanup-fetch">
          <code>git fetch --prune</code>
          {fetching ? (
            <span className="batch-muted-note">running</span>
          ) : fetched && fetched.code !== 0 ? (
            <span className="batch-code bad">
              exit {fetched.code}. What follows is as of the last fetch.
            </span>
          ) : (
            <span className="batch-code ok">exit {fetched?.code ?? 0}</span>
          )}
          {fetched && fetched.code !== 0 && <pre>{fetched.stderr.trim()}</pre>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="batch-pick-head">
          <button className="link-btn" onClick={() => setAll((row) => row.ticked)}>
            Finished
          </button>
          <button className="link-btn" onClick={() => setAll(() => true)}>
            All {rows.length}
          </button>
          <button className="link-btn" onClick={() => setAll(() => false)}>
            None
          </button>
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

      {rows.length > 0 && (
        <div className="batch-list">
          {finished.length > 0 && <div className="cleanup-group">Finished</div>}
          {finished.map(renderRow)}
          {others.length > 0 && <div className="cleanup-group">Not finished</div>}
          {others.map(renderRow)}
        </div>
      )}

      {commands.length > 0 && <pre className="cleanup-commands">{commands.join("\n")}</pre>}

      {(shells || touchesClaude(ticked)) && (
        <p className="cleanup-warning">
          {shells}
          {shells && touchesClaude(ticked) && " "}
          {touchesClaude(ticked) &&
            "If a Claude Code session is still open in one of these worktrees, git asks whether to try again: exit the session and answer y. An n drops the worktree anyway and leaves its empty folder behind."}
        </p>
      )}
    </Dialog>
  );
}
