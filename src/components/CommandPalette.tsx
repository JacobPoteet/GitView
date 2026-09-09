import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteItem {
  id: string;
  label: string;
  kind: string;
  hint?: string;
  run: () => void;
}

interface Props {
  items: PaletteItem[];
  onClose: () => void;
}

/** Subsequence match, so "lsdev" finds "LunchSpecial · dev". */
function matches(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let index = 0;
  for (const char of haystack.toLowerCase()) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

export default function CommandPalette({ items, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => matches(needle, `${item.label} ${item.kind} ${item.hint ?? ""}`))
      .slice(0, 60);
  }, [items, query]);

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
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a repository, run a task, sync"
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <p className="empty">Nothing matches.</p>}
          {results.map((item, index) => (
            <button
              key={item.id}
              className={`palette-item${index === active ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                onClose();
                item.run();
              }}
            >
              <span className="kind">{item.kind}</span>
              <span className="label">{item.label}</span>
              {item.hint && <span className="hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
