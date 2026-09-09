import { useMemo, useState } from "react";
import type { Task } from "../lib/types";

interface Props {
  tasks: Task[];
  disabled: boolean;
  onRun: (task: Task) => void;
  onSetHidden: (task: Task, hidden: boolean) => void;
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
}: {
  task: Task;
  disabled: boolean;
  onRun: (task: Task) => void;
  onSetHidden: (task: Task, hidden: boolean) => void;
}) {
  return (
    <div className="task-row-wrap">
      <button
        className="task-row"
        disabled={disabled}
        onClick={() => onRun(task)}
        title={task.command}
      >
        <span className="name">{task.name}</span>
        <span className="cmd">{task.command}</span>
      </button>
      <button
        className="row-action"
        onClick={() => onSetHidden(task, !task.hidden)}
        title={task.hidden ? "Move back into the list" : "Move to Hidden"}
      >
        <HideIcon hidden={task.hidden} />
      </button>
    </div>
  );
}

/**
 * Discovery finds every script a project declares, and most projects declare
 * several that only CI or an agent ever runs. Hiding one drops it out of the
 * palette as well, which is where the noise actually hurt.
 */
export default function TaskList({ tasks, disabled, onRun, onSetHidden }: Props) {
  const [showHidden, setShowHidden] = useState(false);

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
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
