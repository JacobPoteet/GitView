import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import type { Task } from "../lib/types";

interface Props {
  tasks: Task[];
  disabled: boolean;
  onRun: (task: Task, typeOnly?: boolean) => void;
  onSetHidden: (task: Task, hidden: boolean) => void;
  /** Opens the dialog that sets or edits a task's description. */
  onSetDescription: (task: Task) => void;
  /** Clears it immediately, the same directness as toggling hidden. */
  onClearDescription: (task: Task) => void;
  /** Only a saved task can be deleted. A discovered one belongs to a manifest. */
  onDelete: (task: Task) => void;
  /** Copies, and says so in the status bar. `what` finishes "Copied …". */
  onCopy: (text: string, what: string) => void;
}

function HideIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      {hidden ? (
        <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}

function Row({
  task,
  disabled,
  onRun,
  onSetHidden,
  onDelete,
  onMenu,
}: {
  task: Task;
  disabled: boolean;
  onRun: (task: Task) => void;
  onSetHidden: (task: Task, hidden: boolean) => void;
  onDelete: (task: Task) => void;
  onMenu: (event: ReactMouseEvent, task: Task) => void;
}) {
  return (
    <div className="task-row-wrap" onContextMenu={(event) => onMenu(event, task)}>
      <button
        className="task-row"
        disabled={disabled}
        onClick={() => onRun(task)}
        title={task.description ?? task.command}
      >
        <span className="name">{task.name}</span>
        {task.description && <span className="task-desc-dot" aria-hidden />}
        <span className="cmd">{task.command}</span>
      </button>
      <button
        className="row-action"
        onClick={() => onSetHidden(task, !task.hidden)}
        title={task.hidden ? "Move back into the list" : "Move to Hidden"}
      >
        <HideIcon hidden={task.hidden} />
      </button>
      {task.saved && (
        <button className="row-action" onClick={() => onDelete(task)} title="Delete this task">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Discovery finds every script a project declares, and most projects declare
 * several that only CI or an agent ever runs. Hiding one drops it out of the
 * palette as well, which is where the noise actually hurt.
 */
export default function TaskList({
  tasks,
  disabled,
  onRun,
  onSetHidden,
  onSetDescription,
  onClearDescription,
  onDelete,
  onCopy,
}: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const menu = useContextMenu<Task>();

  function rowMenu(task: Task): MenuEntry[] {
    return [
      { label: "Run", title: task.command, disabled, run: (typeOnly) => onRun(task, typeOnly) },
      { label: "Copy command", title: task.command, run: () => onCopy(task.command, "the command") },
      "-",
      {
        label: task.hidden ? "Move back into the list" : "Hide",
        title: task.hidden ? undefined : "Drops it from the list and the palette",
        run: () => onSetHidden(task, !task.hidden),
      },
      {
        label: task.description ? "Edit description…" : "Set description…",
        run: () => onSetDescription(task),
      },
      ...(task.description
        ? [{ label: "Remove description", run: () => onClearDescription(task) }]
        : []),
      ...(task.saved
        ? [{ label: "Delete task", danger: true, run: () => onDelete(task) }]
        : []),
    ];
  }

  const { grouped, hidden } = useMemo(() => {
    const map = new Map<string, Task[]>();
    const buried: Task[] = [];
    for (const task of tasks) {
      if (task.hidden) {
        buried.push(task);
        continue;
      }
      const list = map.get(task.source);
      if (list) list.push(task);
      else map.set(task.source, [task]);
    }
    return { grouped: [...map.entries()], hidden: buried };
  }, [tasks]);

  const shown = tasks.length - hidden.length;

  return (
    <div className="task-pane">
      <div className="task-head">
        <span>Tasks</span>
        <span>{hidden.length > 0 ? `${shown} of ${tasks.length}` : tasks.length}</span>
      </div>

      <div className="task-list">
        {tasks.length === 0 && (
          <p className="empty">
            No manifest here that names a command.
            <br />
            Run one in the shell, then save it.
          </p>
        )}

        {shown === 0 && tasks.length > 0 && (
          <p className="empty">Every task here is hidden.</p>
        )}

        {grouped.map(([source, items]) => (
          <div key={source}>
            <div className="task-source">{source}</div>
            {items.map((task) => (
              <Row
                key={task.id}
                task={task}
                disabled={disabled}
                onRun={onRun}
                onSetHidden={onSetHidden}
                onDelete={onDelete}
                onMenu={menu.open}
              />
            ))}
          </div>
        ))}
      </div>

      {hidden.length > 0 && (
        <div className={`task-hidden${showHidden ? " open" : ""}`}>
          <button className="task-hidden-bar" onClick={() => setShowHidden((v) => !v)}>
            <span className="chevron">{showHidden ? "▾" : "▸"}</span>
            Hidden
            <span className="count">{hidden.length}</span>
          </button>
          {showHidden && (
            <div className="task-hidden-list">
              {hidden.map((task) => (
                <Row
                  key={task.id}
                  task={task}
                  disabled={disabled}
                  onRun={onRun}
                  onSetHidden={onSetHidden}
                  onDelete={onDelete}
                  onMenu={menu.open}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.name}`}
          entries={rowMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </div>
  );
}
