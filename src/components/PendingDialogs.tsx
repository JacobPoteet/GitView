import Dialog from "./Dialog";
import type { Task } from "../lib/types";

/** A command on its way into the task list, waiting to be named. */
export interface PendingTask {
  repoPath: string;
  command: string;
  name: string;
}

/** A task's description, being edited before it is saved. */
export interface PendingDescription {
  repoPath: string;
  task: Task;
  text: string;
}

/** A commit on its way to being tagged, waiting for the name. */
export interface PendingTag {
  repoPath: string;
  commit: { id: string; short: string; summary: string };
  name: string;
  message: string;
  push: boolean;
}

interface Props {
  task: PendingTask | null;
  onTask: (next: PendingTask | null) => void;
  onSaveTask: () => void;
  description: PendingDescription | null;
  onDescription: (next: PendingDescription | null) => void;
  onSaveDescription: () => void;
  tag: PendingTag | null;
  onTag: (next: PendingTag | null) => void;
  onCreateTag: () => void;
  /** The lines the tag dialog will type, for its preview and its button's title. */
  tagLines: string[];
  tagNameOk: boolean;
  tagNameTaken: boolean;
  shellReady: boolean;
  hasRemote: boolean;
}

/**
 * The three small dialogs that ask for one piece of text before something is
 * kept or typed: a name for a task, a note for a task, a name for a tag. They
 * were 140 lines at the foot of `App`. The state stays there, because Escape
 * and the actions that open them live there too.
 */
export default function PendingDialogs({
  task: pendingTask,
  onTask: setPendingTask,
  onSaveTask: saveTask,
  description: pendingDescription,
  onDescription: setPendingDescription,
  onSaveDescription: saveDescription,
  tag: pendingTag,
  onTag: setPendingTag,
  onCreateTag: createTag,
  tagLines,
  tagNameOk,
  tagNameTaken,
  shellReady,
  hasRemote,
}: Props) {
  return (
    <>
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
    </>
  );
}
