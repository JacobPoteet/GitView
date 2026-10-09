import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
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

/**
 * A line of text over a group of items, for a menu that lists several things
 * with the same actions each: the stash menu names the stash, then Pop,
 * Apply and Drop under it. Not focusable and does nothing.
 */
export interface MenuHeading {
  label: string;
  heading: true;
}

/**
 * An item that opens a second menu beside it, for a group too rare to show in
 * full every time: reset's three modes, or the branches at a commit when there
 * are several. Hover, a click or the right arrow opens it; the left arrow and
 * Escape close it again.
 */
export interface MenuSubmenu {
  label: string;
  title?: string;
  disabled?: boolean;
  entries: MenuEntry[];
}

/** A `"-"` between two items draws a rule. */
export type MenuEntry = MenuItem | MenuHeading | MenuSubmenu | "-";

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

  useEffect(() => {
    function dismiss(event: Event) {
      // A submenu is inside the menu's element, so a click in one is not a
      // click elsewhere.
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
    <MenuPanel
      panelRef={ref}
      entries={entries}
      label={label}
      style={{ left: pos.x, top: pos.y }}
      onClose={onClose}
    />
  );
}

/**
 * One column of items: the menu, or a submenu inside it.
 *
 * Each panel walks only its own items with the arrows, so a submenu's items
 * are not in the top level's order. Escape and the left arrow inside a
 * submenu are handled here and stopped, which keeps the window listener from
 * closing the whole menu when only the submenu should go.
 */
function MenuPanel({
  panelRef,
  entries,
  label,
  style,
  onClose,
  onBack,
}: {
  panelRef: MutableRefObject<HTMLDivElement | null>;
  entries: MenuEntry[];
  label: string;
  style: CSSProperties;
  onClose: () => void;
  /** Set on a submenu: closes it and gives focus back to its item. */
  onBack?: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);

  function items(): HTMLButtonElement[] {
    return Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        ":scope > button:not(:disabled), :scope > .row-menu-sub > button:not(:disabled)",
      ) ?? [],
    );
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    // A key pressed inside an open submenu is that submenu's business.
    const list = items();
    if (!list.includes(event.target as HTMLButtonElement)) return;
    if (onBack && (event.key === "Escape" || event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    list[(at + step + list.length) % list.length].focus();
  }

  return (
    <div
      className={onBack ? "row-menu row-menu-child" : "row-menu"}
      ref={panelRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
      // A right-click on the menu itself is nothing, rather than a second menu.
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) =>
        entry === "-" ? (
          <hr key={index} className="row-menu-rule" />
        ) : "heading" in entry ? (
          <div key={index} className="row-menu-heading" title={entry.label}>
            {entry.label}
          </div>
        ) : "entries" in entry ? (
          <Submenu
            key={index}
            entry={entry}
            open={open === index}
            onOpen={() => setOpen(index)}
            onShut={() => setOpen(null)}
            onClose={onClose}
          />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={entry.danger ? "danger" : undefined}
            disabled={entry.disabled}
            title={entry.title}
            // Moving onto a plain item closes a sibling's submenu, as a
            // desktop menu does.
            onMouseEnter={() => setOpen(null)}
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

/**
 * The item that opens a submenu, and the submenu once it is open.
 *
 * The child sits to the item's right, and goes to its left when the right
 * would run off the window, which is where a menu opened near the edge
 * already is. It moves up by however much it would run off the bottom.
 */
function Submenu({
  entry,
  open,
  onOpen,
  onShut,
  onClose,
}: {
  entry: MenuSubmenu;
  open: boolean;
  onOpen: () => void;
  onShut: () => void;
  onClose: () => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const child = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState({ left: false, lift: 0 });
  // Set when the keyboard or a click opened it, so focus follows into the
  // child. A hover leaves focus where it was.
  const focusChild = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    const item = button.current?.getBoundingClientRect();
    const el = child.current?.getBoundingClientRect();
    if (!item || !el) return;
    setPlace({
      left: item.right + el.width + 4 > window.innerWidth,
      lift: Math.max(0, item.top + el.height + 4 - window.innerHeight),
    });
    if (focusChild.current) {
      focusChild.current = false;
      child.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  }, [open]);

  function enter() {
    focusChild.current = true;
    if (open) child.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    else onOpen();
  }

  return (
    <div className="row-menu-sub">
      <button
        ref={button}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={open ? "open" : undefined}
        disabled={entry.disabled}
        title={entry.title}
        onMouseEnter={onOpen}
        onClick={enter}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          enter();
        }}
      >
        <span>{entry.label}</span>
        <span className="row-menu-arrow" aria-hidden="true">
          ▸
        </span>
      </button>
      {open && (
        <MenuPanel
          panelRef={child}
          entries={entry.entries}
          label={entry.label}
          style={{ [place.left ? "right" : "left"]: "100%", top: -5 - place.lift }}
          onClose={onClose}
          onBack={() => {
            onShut();
            button.current?.focus();
          }}
        />
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
