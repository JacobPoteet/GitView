import { useState } from "react";
import { settings, updateSettings } from "../../lib/settings";
import { mergeCommand, openUrlCommand, rerunCommand, type ShellKind } from "../../lib/shell";
import { checkTone, mergeBlock } from "../../lib/inbox";
import type { InboxItem, MergeMethod } from "../../lib/types";

const CHECK_GLYPH = { ok: "✓", bad: "✕", pending: "•", off: "–" } as const;

export function CheckMark({ state }: { state: InboxItem["checks"] }) {
  if (!state) return null;
  const tone = checkTone(state);
  return (
    <span className={`inbox-checks ${tone}`} title={`checks: ${state.toLowerCase()}`}>
      {CHECK_GLYPH[tone]}
    </span>
  );
}

/** The merge method last picked for this repository, if the repository still allows it. */
function storedMethod(item: InboxItem): MergeMethod {
  const picked = settings().github.mergeMethod[item.ownerRepo];
  if (picked && item.mergeMethods.includes(picked)) return picked;
  return item.mergeMethods[0] ?? "squash";
}

/**
 * The desk under a pull request row: its checks by name, whether GitHub would
 * let it merge, and the button that merges it. Everything here is the page on
 * GitHub with the browser left closed, and everything it does gets typed.
 */
export function Desk({
  item,
  shell,
  onCommand,
  onMerge,
}: {
  item: InboxItem;
  shell: ShellKind;
  onCommand: (path: string, command: string, typeOnly?: boolean) => void;
  onMerge: (item: InboxItem, method: MergeMethod, command: string) => void;
}) {
  const [method, setMethod] = useState<MergeMethod>(() => storedMethod(item));

  const pick = (next: MergeMethod) => {
    setMethod(next);
    updateSettings("github", {
      mergeMethod: { ...settings().github.mergeMethod, [item.ownerRepo]: next },
    });
  };

  const block = mergeBlock(item);
  const command = mergeCommand(item.number, method, !item.deleteBranchOnMerge);
  const passed = item.checkRuns.filter((run) => run.state === "SUCCESS").length;
  const counted = item.checkRuns.filter((run) => checkTone(run.state) !== "off").length;
  const running = item.checkRuns.some((run) => run.state === "PENDING");
  const failing = item.checkRuns.some((run) => run.state === "FAILURE");
  // Actions takes a moment to register a check on a fresh push, and until it
  // does the rollup is null. A pull request that moved in the last hour with
  // no rollup is more likely waiting than checkless.
  const fresh = Date.parse(item.updatedAt) > Date.now() - 3_600_000;

  // One button per run, not per job: `--failed` re-runs every failed job in
  // the run, so a matrix with three red cells is one command.
  const failedRuns = [
    ...new Set(
      item.checkRuns
        .filter((run) => run.state === "FAILURE" && run.runId !== null)
        .map((run) => run.runId as number),
    ),
  ];

  const typed = (command: string) => `${command}

Typed into ${item.repoName}'s shell.`;

  return (
    <div className="inbox-desk">
      <div className="inbox-desk-line">
        <span className="inbox-desk-refs">
          <bdi>{item.headRef}</bdi> → <bdi>{item.baseRef ?? "?"}</bdi>
        </span>
        <span className="inbox-desk-size">
          <span className="add">+{item.additions}</span> <span className="del">−{item.deletions}</span>
          {" in "}
          {item.changedFiles} {item.changedFiles === 1 ? "file" : "files"}
        </span>
        {/* `UNSTABLE` is GitHub's word for a merge it would allow with a
            check that is not green, and a check still running counts. The
            runs say which. */}
        {item.mergeState === "CLEAN" && <span className="inbox-badge approved">mergeable</span>}
        {item.mergeState === "UNSTABLE" && failing && (
          <span className="inbox-badge changes">mergeable, checks failing</span>
        )}
        {item.mergeState === "UNSTABLE" && !failing && running && (
          <span className="inbox-badge draft">mergeable, checks running</span>
        )}
        {item.mergeState === "UNSTABLE" && !failing && !running && (
          <span className="inbox-badge approved">mergeable</span>
        )}
      </div>

      {item.checkRuns.length > 0 ? (
        <ul className="inbox-checklist">
          {item.checkRuns.map((run, index) => {
            const tone = checkTone(run.state);
            return (
              <li key={`${run.name}${index}`} className={`inbox-check ${tone}`}>
                <span className={`inbox-checks ${tone}`}>{CHECK_GLYPH[tone]}</span>
                {run.url ? (
                  <button
                    className="inbox-check-name link"
                    title={typed(openUrlCommand(run.url, shell))}
                    onClick={() => onCommand(item.repoPath, openUrlCommand(run.url as string, shell))}
                  >
                    {run.name}
                  </button>
                ) : (
                  <span className="inbox-check-name">{run.name}</span>
                )}
                <span className="inbox-when">{run.state.toLowerCase()}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="inbox-when">
          {fresh ? "No checks reported yet. Actions takes a moment to start them." : "No checks on the head commit."}
        </p>
      )}

      <div className="inbox-desk-actions">
        <span className="inbox-when">
          {item.checkRuns.length > 0 && `${passed} of ${counted} passed`}
          {block && (
            <>
              {item.checkRuns.length > 0 && " · "}
              {block}
            </>
          )}
        </span>

        {failedRuns.map((runId) => (
          <button
            key={runId}
            className="btn tiny"
            title={typed(rerunCommand(runId))}
            onClick={(event) => onCommand(item.repoPath, rerunCommand(runId), event.shiftKey)}
          >
            Re-run failed
          </button>
        ))}

        {item.draft && (
          <button
            className="btn tiny"
            title={typed(`gh pr ready ${item.number}`)}
            onClick={(event) => onCommand(item.repoPath, `gh pr ready ${item.number}`, event.shiftKey)}
          >
            Mark ready
          </button>
        )}

        {item.mergeState === "BEHIND" && (
          <button
            className="btn tiny"
            title={typed(`gh pr update-branch ${item.number}`)}
            onClick={(event) =>
              onCommand(item.repoPath, `gh pr update-branch ${item.number}`, event.shiftKey)
            }
          >
            Update branch
          </button>
        )}

        {item.mergeMethods.length > 1 && (
          <select
            className="inbox-method"
            value={method}
            title="How the branch lands on the base. Squash is one commit per pull request, which is how this history reads."
            onChange={(event) => pick(event.target.value as MergeMethod)}
          >
            {item.mergeMethods.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}

        <button
          className="btn tiny accent"
          disabled={block !== null}
          title={block ?? `${command}

Asks first, then types it into ${item.repoName}'s shell.`}
          onClick={() => onMerge(item, method, command)}
        >
          {item.deleteBranchOnMerge ? "Merge" : "Merge & delete branch"}
        </button>
      </div>
    </div>
  );
}
