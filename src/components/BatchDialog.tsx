import { useMemo, useState } from "react";
import {
  fetchPlan,
  isSkip,
  previewOf,
  prunePlan,
  stepOutput,
  transcriptText,
  verbFor,
  type BatchKind,
  type BatchRow,
  type BatchRun,
} from "../lib/batch";
import type { RepoState } from "../lib/types";
import Dialog from "./Dialog";

interface Props {
  kind: BatchKind;
  /** Everything pickable, with the hidden rows already gone. */
  candidates: RepoState[];
  /** Null until something has been started. */
  run: BatchRun | null;
  onStart: (paths: string[]) => void;
  onCancel: () => void;
  /** Opening the repository is the recovery path, so its name is a button. */
  onSelect: (path: string) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}

const BLURB: Record<BatchKind, string> = {
  fetch:
    "One fetch per repository, in order. Nothing in a working tree moves: a fetch only updates what this machine knows about the remote.",
  sync: "Two commands per repository, in order: git fetch --prune, then git pull --ff-only when the branch can be fast-forwarded. Anything that cannot is fetched and left alone, and the transcript says which and why.",
  prune:
    "git branch -d per repository, naming the branches the default branch already contains. -d refuses anything unmerged, and it prints each deleted branch's commit, which is the only way back. Those lines are in the transcript, and the transcript can be copied.",
};

/** The plan that decides whether a repository is worth picking at all. */
function gate(kind: BatchKind, repo: RepoState) {
  return kind === "prune" ? prunePlan(repo) : fetchPlan(repo);
}

function StepList({ row }: { row: BatchRow }) {
  return (
    <div className="batch-steps">
      {row.steps.map((step, index) => {
        if (step.skipped) {
          return (
            <div className="batch-step" key={index}>
              <span className="batch-step-label">{step.label}</span>
              <span className="batch-skipped">skipped, {step.skipped}</span>
            </div>
          );
        }
        const output = stepOutput(step);
        return (
          <div className="batch-step" key={index}>
            <span className="batch-step-label">{step.label}</span>
            <code>{step.command}</code>
            {step.outcome && (
              <span className={step.outcome.code === 0 ? "batch-code ok" : "batch-code bad"}>
                exit {step.outcome.code}
              </span>
            )}
            {output && <pre>{output}</pre>}
          </div>
        );
      })}
    </div>
  );
}

export default function BatchDialog({
  kind,
  candidates,
  run,
  onStart,
  onCancel,
  onSelect,
  onCopy,
  onClose,
}: Props) {
  const eligible = useMemo(
    () => candidates.filter((repo) => !isSkip(gate(kind, repo))),
    [candidates, kind],
  );

  // Rows that cannot be picked go last. They arrive in scan order, which put a
  // repository with no remote at the top of a list of sixteen it is not part of.
  const listed = useMemo(() => {
    const blocked = (repo: RepoState) => (isSkip(gate(kind, repo)) ? 1 : 0);
    return [...candidates].sort(
      (a, b) => blocked(a) - blocked(b) || a.name.localeCompare(b.name),
    );
  }, [candidates, kind]);

  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(eligible.map((repo) => repo.path)),
  );
  // A row opens to its commands and their output. A failure and a prune open
  // themselves, since both have something the user has to read.
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const branchTotal = useMemo(
    () =>
      candidates
        .filter((repo) => picked.has(repo.path))
        .reduce((sum, repo) => sum + repo.mergedBranches.length, 0),
    [candidates, picked],
  );

  if (!run) {
    const verb = verbFor[kind];
    return (
      <Dialog
        label={`${verb} ${picked.size} of ${candidates.length} repositories`}
        className="wide"
        onClose={onClose}
        actions={
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn accent"
              disabled={picked.size === 0}
              onClick={() => onStart(listed.filter((r) => picked.has(r.path)).map((r) => r.path))}
            >
              {kind === "prune"
                ? `Delete ${branchTotal} ${branchTotal === 1 ? "branch" : "branches"}`
                : `${verb} ${picked.size}`}
            </button>
          </>
        }
      >
        <p>{BLURB[kind]}</p>

        <div className="batch-pick-head">
          <button
            className="link-btn"
            onClick={() => setPicked(new Set(eligible.map((r) => r.path)))}
          >
            All {eligible.length}
          </button>
          <button className="link-btn" onClick={() => setPicked(new Set())}>
            None
          </button>
          {eligible.length < candidates.length && (
            <span className="batch-muted-note">
              {candidates.length - eligible.length} cannot be picked
            </span>
          )}
        </div>

        <div className="batch-list">
          {listed.map((repo) => {
            const blocked = isSkip(gate(kind, repo));
            const on = picked.has(repo.path);
            return (
              <label
                key={repo.path}
                className={`batch-pick${blocked ? " blocked" : ""}`}
                title={repo.path}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={blocked}
                  onChange={() => toggle(repo.path)}
                />
                <span className="batch-pick-name">{repo.name}</span>
                <span className="batch-pick-hint">{previewOf(kind, repo)}</span>
                {kind === "prune" && repo.mergedBranches.length > 0 && (
                  <code className="batch-pick-command">
                    git branch -d {repo.mergedBranches.join(" ")}
                  </code>
                )}
              </label>
            );
          })}
        </div>
      </Dialog>
    );
  }

  // What the run did, rather than how many rows it had. "15 of 16 clean"
  // counted fifteen repositories that were skipped as successes.
  let ran = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of run.rows) {
    if (row.state !== "done") continue;
    if (row.failed) failed += 1;
    else if (row.steps.some((step) => step.outcome)) ran += 1;
    else skipped += 1;
  }
  const tally = [`${ran} ran`];
  if (skipped > 0) tally.push(`${skipped} skipped`);
  if (failed > 0) tally.push(`${failed} failed`);
  return (
    <Dialog
      label={`${verbFor[run.kind]} ${run.running ? "running" : "finished"}`}
      title={
        <>
          {run.running
            ? `${verbFor[run.kind]}ing ${run.done + 1} of ${run.rows.length}`
            : `${verbFor[run.kind]} finished · ${tally.join(", ")}`}
          {run.cancelled && " · stopped"}
        </>
      }
      className="wide"
      // A run still going keeps its dialog: this is the only place the
      // commands it is about to type are named.
      closable={!run.running}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={() => onCopy(transcriptText(run))}>
            Copy transcript
          </button>
          {run.running && (
            <button className="btn accent" onClick={onCancel}>
              Stop after this one
            </button>
          )}
        </>
      }
    >
      <p>
        Every command it ran is here with its exit code and its output, which is what a shell would
        have shown. Clicking a name opens that repository, where the same command can be run by
        hand.
      </p>

      <div className="batch-list transcript">
        {run.rows.map((row) => {
          const open = opened.has(row.path) || row.failed || run.kind === "prune";
          return (
            <div key={row.path} className={`batch-row ${row.state}`}>
              <div className="batch-row-head">
                <span
                  className={`dot ${
                    row.state === "waiting"
                      ? "clean"
                      : row.state === "running"
                        ? "live"
                        : row.failed
                          ? "error"
                          : "clean"
                  }`}
                />
                <button className="report-name" onClick={() => onSelect(row.path)} title={row.path}>
                  {row.name}
                </button>
                <span className={row.failed ? "batch-headline bad" : "batch-headline"}>
                  {row.state === "waiting"
                    ? run.cancelled
                      ? "not reached"
                      : "waiting"
                    : row.headline || "running"}
                </span>
                {row.steps.length > 0 && !row.failed && run.kind !== "prune" && (
                  <button
                    className="link-btn"
                    onClick={() =>
                      setOpened((current) => {
                        const next = new Set(current);
                        if (next.has(row.path)) next.delete(row.path);
                        else next.add(row.path);
                        return next;
                      })
                    }
                  >
                    {open ? "hide" : "commands"}
                  </button>
                )}
              </div>
              {open && row.steps.length > 0 && <StepList row={row} />}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
