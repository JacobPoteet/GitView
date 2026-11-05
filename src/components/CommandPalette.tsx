import { useEffect, useMemo, useRef, useState } from "react";
import { rank, type Rankable } from "../lib/palette";

export interface PaletteItem extends Rankable {
  id: string;
  kind: string;
  run: () => void;
}

interface Props {
  items: PaletteItem[];
  onClose: () => void;
}

export default function CommandPalette({ items, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => rank(query, items).slice(0, 60), [items, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(".palette-item.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = results[active];
      if (item) {
        onClose();
        item.run();
      }
    }
  }

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        {/* The input is a combobox over the list, so a screen reader follows
            the arrow keys: `aria-activedescendant` names the row they are on
            without moving focus off the field, and the rows are options with
            ids for it to point at. The id is the row's position: item ids
            hold paths, which are not valid in an id. */}
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a repository, run a task, sync"
          spellCheck={false}
          role="combobox"
          aria-label="Command"
          aria-autocomplete="list"
          aria-expanded={results.length > 0}
          aria-controls="palette-options"
          aria-activedescendant={results[active] ? `palette-option-${active}` : undefined}
        />
        <div className="palette-list" ref={listRef} id="palette-options" role="listbox">
          {results.length === 0 && <p className="empty">Nothing matches.</p>}
          {results.map((item, index) => (
            <button
              key={item.id}
              id={`palette-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={`palette-item${index === active ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                onClose();
                item.run();
              }}
            >
              <span className="kind">{item.kind[0].toUpperCase() + item.kind.slice(1)}</span>
              <span className="label">{item.label}</span>
              {item.hint && <span className="hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
