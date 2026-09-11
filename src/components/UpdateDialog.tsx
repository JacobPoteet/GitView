import { installUpdateCommand, openUrlCommand, type ShellKind } from "../lib/shell";
import { relativeTime, type UpdateCheck } from "../lib/types";

interface Props {
  check: UpdateCheck;
  shell: ShellKind;
  /** The selected repository, whose shell takes the command. Null opens GitView's own. */
  target: string | null;
  onCommand: (command: string, typeOnly: boolean) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}

/**
 * What a newer release is, and the command that installs it.
 *
 * The update is not applied from here. It is typed at the prompt like every
 * other action in the app, which is the whole reason there is no HTTP client
 * and no signing key in this project: `gh` fetches the asset, the tag is on the
 * line, and the NSIS installer that runs is one somebody watched arrive. The
 * prompt is the selected repository's when there is one, and GitView's own
 * otherwise: the command has no interest in a repository, so it never asks
 * you to pick one.
 */
export default function UpdateDialog({
  check,
  shell,
  target,
  onCommand,
  onCopy,
  onClose,
}: Props) {
  const release = check.latest;
  if (!release) return null;

  const command = release.assetName
    ? installUpdateCommand(release.repo, release.tag, release.assetName, shell)
    : null;
  const published = Date.parse(release.publishedAt);
  const size = release.assetSize ? `${(release.assetSize / 1_048_576).toFixed(1)} MB` : null;

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div className="confirm update" onMouseDown={(event) => event.stopPropagation()}>
        <h2>
          GitView {release.version}
          <button className="pane-close" onClick={onClose} title="Close (Escape)">
            ✕
          </button>
        </h2>
        <p>
          You are on {check.current}. Released{" "}
          {Number.isNaN(published) ? "recently" : relativeTime(Math.floor(published / 1000))}
          {size ? `, ${size}` : ""}.
        </p>

        {release.notes && <pre className="update-notes">{release.notes}</pre>}

        {command ? (
          <>
            <pre>{command}</pre>
            <p>
              {target ? (
                <>
                  It gets typed at <b>{target}</b>&apos;s prompt, so the download is visible while
                  it happens.
                </>
              ) : (
                <>
                  Nothing is open, so GitView opens a shell of its own in its data folder and
                  types it there, where the download is visible while it happens.
                </>
              )}{" "}
              Hold <kbd>Shift</kbd> to type the line without running it.{" "}
              The installer asks to close GitView before it replaces it.
            </p>
          </>
        ) : (
          <p>
            The release is up but has no installer attached yet, which is what the release build
            uploads when it finishes. The notes are on the release page in the meantime.
          </p>
        )}

        <div className="confirm-actions">
          <button
            className="btn"
            title={openUrlCommand(release.url, shell)}
            onClick={(event) => onCommand(openUrlCommand(release.url, shell), event.shiftKey)}
          >
            Release notes
          </button>
          {command && (
            <button className="btn" onClick={() => onCopy(command)}>
              Copy the command
            </button>
          )}
          {command && (
            <button
              className="btn accent"
              title={command}
              onClick={(event) => onCommand(command, event.shiftKey)}
            >
              Install {release.version}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
