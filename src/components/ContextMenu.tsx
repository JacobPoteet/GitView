import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

/**
 * One item in a right-click menu.
 *
 * `run` takes the same `typeOnly` every button in the app does, so shift-click
 * on an item types the command without running it. `title` is the command,
 * shown as the tooltip, since a menu item names what it runs like everything
 * else here.
 */
export interface MenuItem {
  label: string;
  title?: string;
  danger?: boolean;
  disabled?: boolean;
  run: (typeOnly: boolean) => void;
}

/** A `"-"` between two items draws a rule. */
export type MenuEntry = MenuItem | "-";

export interface MenuAt {
  x: number;
  y: number;
}

/**
 * Where a right-click landed, and what it landed on.
 *
 * The payload is whatever the surface needs to build its items: the file, the
 * task, the commit. It is captured at the click, so a list that re-sorts under
 * the open menu still acts on the row that was clicked.
 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<{ at: MenuAt; payload: T } | null>(null);
  return {
    menu,
    open(event: ReactMouseEvent, payload: T) {
      // Both, because a chip sits inside a row that has a menu of its own, and
      // the document listener that suppresses the webview's menu must not see
      // one that was handled.
      event.preventDefault();
      event.stopPropagation();
      setMenu({ at: { x: event.clientX, y: event.clientY }, payload });
    },
    close() {
      setMenu(null);
    },
  };
}

/**
 * The menu itself, in viewport coordinates.
 *
 * Anything that is not the menu closes it: a click elsewhere, Escape, a list
 * scrolling out from under it, another right-click. `mousedown` on the window
 * rather than a click on a backdrop, so the click that dismisses it also
 * reaches whatever it was aimed at. It measures itself after the first paint
 * and moves back inside the window from the right and the bottom, which is
 * where a right-click in a 300 px column most often lands.
 */
export default function ContextMenu({
  at,
  entries,
  label,
  onClose,
}: {
  at: MenuAt;
  entries: MenuEntry[];
  /** Read by a screen reader as the menu's name. */
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(at);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - height - 4)),
    });
  }, [at]);

  // Focus lands on the first item, and the arrows walk the rest, so the menu
  // can be used once it is open without the mouse that opened it.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  }

  useEffect(() => {
    function dismiss(event: Event) {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", dismiss);
    // Capture, because the list that scrolls is not the window.
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [onClose]);

  return (
    <div
      className="row-menu"
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      // A right-click on the menu itself is nothing, rather than a second menu.
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) =>
        entry === "-" ? (
          <hr key={index} className="row-menu-rule" />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={entry.danger ? "danger" : undefined}
            disabled={entry.disabled}
            title={entry.title}
            onClick={(event) => {
              entry.run(event.shiftKey);
              onClose();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}

/** True inside a field where the webview's own cut, copy and paste belong. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}
