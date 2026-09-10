import { installUpdateCommand, openUrlCommand, type ShellKind } from "../lib/shell";
import { relativeTime, type UpdateCheck } from "../lib/types";

interface Props {
  check: UpdateCheck;
  shell: ShellKind;
  /** The repository whose shell the command gets typed into, when one is live. */
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
 * line, and the NSIS installer that runs is one somebody watched arrive.
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
        <h2>GitView {release.version}</h2>
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
                  it happens. Hold <kbd>Shift</kbd> to type the line without running it.
                </>
              ) : (
                <>
                  Select a repository first. The line is typed at its prompt like every other
                  action here, and nothing in GitView has a prompt until something is open.
                </>
              )}{" "}
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
            disabled={!target}
            title={
              target
                ? `Start-Process ${release.url}`
                : "Open a repository first: the command needs a shell to be typed into."
            }
            onClick={(event) => onCommand(openUrlCommand(release.url, shell), event.shiftKey)}
          >
            Release notes
          </button>
          {command && (
            <button className="btn" onClick={() => onCopy(command)}>
              Copy the command
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Later
          </button>
          {command && (
            <button
              className="btn accent"
              disabled={!target}
              title={
                target
                  ? command
                  : "Open a repository first: the command needs a shell to be typed into."
              }
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
