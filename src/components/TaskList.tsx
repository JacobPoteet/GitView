import { useMemo } from "react";
import type { Task } from "../lib/types";

interface Props {
  tasks: Task[];
  disabled: boolean;
  onRun: (task: Task) => void;
}

export default function TaskList({ tasks, disabled, onRun }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const list = map.get(task.source);
      if (list) list.push(task);
      else map.set(task.source, [task]);
    }
    return [...map.entries()];
  }, [tasks]);

  return (
    <div className="task-pane">
      <div className="task-head">
        <span>Tasks</span>
        <span>{tasks.length}</span>
      </div>

      <div className="task-list">
        {tasks.length === 0 && (
          <p className="empty">
            No manifest here that names a command.
            <br />
            Run one in the shell, then save it.
          </p>
        )}

        {grouped.map(([source, items]) => (
          <div key={source}>
            <div className="task-source">{source}</div>
            {items.map((task) => (
              <button
                key={task.id}
                className="task-row"
                disabled={disabled}
                onClick={() => onRun(task)}
                title={task.command}
              >
                <span className="name">{task.name}</span>
                <span className="cmd">{task.command}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
