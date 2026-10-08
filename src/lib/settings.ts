/**
 * The app's own settings, in one place.
 *
 * Every choice here is about this window and this install: how big the
 * terminal's type is, whether the app fetches on launch, whether the graph is
 * folded away. None of it is about a repository, which is why it lives in
 * `localStorage` rather than in SQLite beside the pins. The watched folders
 * stay in the database because the scanner reads them from Rust.
 *
 * One JSON blob under one key, merged over the defaults on read, so a setting
 * added later reads as its default on an install that never saw it and a
 * setting removed later is ignored rather than crashing the parse. This is the
 * only module that touches `localStorage`: a key written anywhere else is a
 * setting the dialog cannot show.
 */

import { useSyncExternalStore } from "react";
import type { MergeMethod } from "./types";

export type CursorStyle = "bar" | "block" | "underline";
export const CURSOR_STYLES: CursorStyle[] = ["bar", "block", "underline"];

export interface Settings {
  terminal: {
    /** Points. xterm takes a float, and 12.5 is what the app shipped with. */
    fontSize: number;
    /**
     * A live region a screen reader can follow. Off by default because xterm
     * mirrors every line into the DOM and pays on every frame a dev server
     * prints.
     */
    screenReader: boolean;
    /**
     * Write each shell's scrollback out on close and read it back on the next
     * launch, so yesterday's build output is still above the cursor.
     */
    restoreScrollback: boolean;
    /**
     * The shell to start, as a path or a bare name looked up on PATH. Empty is
     * automatic: PowerShell 7 when installed, Windows PowerShell otherwise.
     * Read when a shell opens, so the ones already running keep theirs.
     */
    shell: string;
    /** A bundled face from `TERMINAL_FACES`, or the name of any font installed on this machine. */
    fontFamily: string;
    /** Lines of history each shell keeps in memory, and the most a saved scrollback holds. */
    scrollback: number;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
  };
  launch: {
    /** `git fetch` in every repository at launch, when the last one is stale. */
    fetch: boolean;
    /** Rescan the fleet when the window comes back to the front after a while away. */
    refreshOnFocus: boolean;
    /** Ask GitHub for the latest release at launch. Only a word in the status bar either way. */
    checkUpdate: boolean;
  };
  graph: {
    /** The branch graph folded to its strip. */
    collapsed: boolean;
  };
  layout: {
    /** The sidebar's width in pixels. */
    sidebar: number;
    /** The changes column's width in pixels. */
    changes: number;
    /**
     * The share of the main column the shell keeps while a pane (inbox, history,
     * a diff) is open, in percent. One number for every pane, so going from the
     * history to the inbox does not resize what you are looking at.
     */
    shell: number;
    /**
     * The tasks panel's share of the left rail, in percent. Null until dragged:
     * the panel is as tall as its list, up to a third, which suits a project
     * with three scripts and one with thirty alike.
     */
    tasks: number | null;
    /** The changes column slid away, for a narrow window. Its width is kept for when it returns. */
    changesHidden: boolean;
  };
  inbox: {
    /** Rows grouped by repository, or by what each one needs. */
    mode: "repo" | "need";
    /** The group headings folded shut, by their key. */
    collapsed: string[];
  };
  github: {
    /** Read the inbox on a timer at all. Off for a laptop on a metered connection. */
    poll: boolean;
    /** Minutes between reads while a recent pull request has checks running. */
    busyMinutes: number;
    /** Minutes between reads otherwise. */
    idleMinutes: number;
    /** How old the cached inbox can be at launch before it is read again. Minutes. */
    launchStaleMinutes: number;
    /**
     * The merge method last picked per `owner/repo`. About a repository, but
     * about this person's habit with it rather than its state, and the desk
     * reads it synchronously when it opens, so it sits here rather than in
     * SQLite.
     */
    mergeMethod: Record<string, MergeMethod>;
  };
  ai: {
    /**
     * A Claude tab beside each repository's first shell. It stays asleep until
     * it is clicked, then opens a shell there and types `claude`.
     */
    claudeTab: boolean;
  };
  tour: {
    /** The step on screen, an index into `STEPS` in `lib/tour.ts`. */
    step: number;
    /** Finished or closed. Replaying from the palette or About clears it. */
    done: boolean;
  };
}

export const DEFAULTS: Settings = {
  terminal: {
    fontSize: 12.5,
    screenReader: false,
    restoreScrollback: true,
    shell: "",
    fontFamily: "JetBrains Mono",
    scrollback: 20000,
    cursorStyle: "bar",
    cursorBlink: true,
  },
  launch: { fetch: true, refreshOnFocus: false, checkUpdate: true },
  graph: { collapsed: false },
  layout: { sidebar: 296, changes: 300, shell: 47, tasks: null, changesHidden: false },
  inbox: { mode: "repo", collapsed: [] },
  github: { poll: true, busyMinutes: 1, idleMinutes: 10, launchStaleMinutes: 10, mergeMethod: {} },
  ai: { claudeTab: false },
  tour: { step: 0, done: false },
};

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 20;
/** Under a screenful there is nothing to scroll back to; over this xterm's buffer is the memory bill. */
export const SCROLLBACK_MIN = 1000;
export const SCROLLBACK_MAX = 100000;
/** A focus that follows another within this is one trip away from the window, not two. */
export const FOCUS_REFRESH_GAP_MS = 60_000;

/** The monospace faces that ship in the binary, so the choice is the same on every machine. */
export const TERMINAL_FACES = ["JetBrains Mono", "Cascadia Code", "Fira Code", "IBM Plex Mono"];

/** What draws when the chosen face is missing. */
const FALLBACK_FONTS = "Consolas, ui-monospace, monospace";

/** The stack xterm is given: the chosen face first, then what a machine always has. */
export function terminalFontStack(family: string): string {
  const named = family.replace(/[;{}"]/g, "").trim() || DEFAULTS.terminal.fontFamily;
  return `"${named}", ${FALLBACK_FONTS}`;
}
/** An interval under a minute is a poll GitHub would notice; over a day is off with extra steps. */
export const MINUTES_MIN = 1;
export const MINUTES_MAX = 1440;
/**
 * What a column may be dragged to. The sidebar's floor keeps a repository
 * name and its chips on one row; the changes column's keeps a path readable.
 * The ceilings are where a column stops being a column.
 */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
export const CHANGES_MIN = 240;
export const CHANGES_MAX = 560;
/** The shell's share of the column beside a pane: a prompt and a few lines, up to most of it. */
export const SHELL_MIN = 20;
export const SHELL_MAX = 80;
/** The tasks panel: a header and a row or two, up to most of the rail's lower half. */
export const TASKS_MIN = 12;
export const TASKS_MAX = 60;
/**
 * What one read of the inbox costs against GitHub's 5000 points an hour,
 * measured over ten repositories with the check contexts in the query. The
 * dialog states it beside each interval, so the trade is visible where it is
 * made.
 */
export const INBOX_READ_COST = 8;
export const RATE_LIMIT_PER_HOUR = 5000;

function minutes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(value)));
}

function pixels(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

const KEY = "gitview.settings";

/**
 * The keys each setting had before it joined the object. Read once, when the
 * object has nothing for that setting yet, and removed on the next write.
 */
const LEGACY = {
  /** Screen reader mode, from the palette before the settings dialog existed. */
  reader: "gitview.terminal.screenReader",
  graph: "gitview.graph.collapsed",
  inboxMode: "gitview.inbox.mode",
  inboxCollapsed: "gitview.inbox.collapsed",
  /** A prefix: one key per repository, `:owner/repo` after it. */
  mergeMethod: "gitview.inbox.mergeMethod",
};

type Stored = { [K in keyof Settings]?: Partial<Settings[K]> };

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Every `localStorage` key, for the one legacy setting that was a family of keys. */
function keys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
  } catch {
    return [];
  }
}

function read(): Settings {
  let stored: Stored = {};
  try {
    stored = JSON.parse(getItem(KEY) ?? "{}") ?? {};
  } catch {
    stored = {};
  }
  const settings: Settings = {
    terminal: { ...DEFAULTS.terminal, ...stored.terminal },
    launch: { ...DEFAULTS.launch, ...stored.launch },
    graph: { ...DEFAULTS.graph, ...stored.graph },
    layout: { ...DEFAULTS.layout, ...stored.layout },
    inbox: { ...DEFAULTS.inbox, ...stored.inbox },
    github: { ...DEFAULTS.github, ...stored.github },
    ai: { ...DEFAULTS.ai, ...stored.ai },
    // An install that already wrote settings before the tour existed is not a
    // first run, so it starts with the tour behind it rather than over it.
    tour: stored.tour
      ? { ...DEFAULTS.tour, ...stored.tour }
      : getItem(KEY) !== null
        ? { ...DEFAULTS.tour, done: true }
        : { ...DEFAULTS.tour },
  };
  const reader = getItem(LEGACY.reader);
  if (reader !== null && stored.terminal?.screenReader === undefined) {
    settings.terminal.screenReader = reader === "1";
  }
  const graph = getItem(LEGACY.graph);
  if (graph !== null && stored.graph?.collapsed === undefined) {
    settings.graph.collapsed = graph === "1";
  }
  const mode = getItem(LEGACY.inboxMode);
  if (mode === "need" && stored.inbox?.mode === undefined) {
    settings.inbox.mode = "need";
  }
  const collapsed = getItem(LEGACY.inboxCollapsed);
  if (collapsed !== null && stored.inbox?.collapsed === undefined) {
    try {
      const parsed: unknown = JSON.parse(collapsed);
      if (Array.isArray(parsed)) settings.inbox.collapsed = parsed.filter((k) => typeof k === "string");
    } catch {
      // Not what it wrote. The default stands.
    }
  }
  if (stored.github?.mergeMethod === undefined) {
    const prefix = `${LEGACY.mergeMethod}:`;
    for (const key of keys()) {
      if (!key.startsWith(prefix)) continue;
      const picked = getItem(key);
      if (picked) settings.github.mergeMethod[key.slice(prefix.length)] = picked as MergeMethod;
    }
  }
  if (!Number.isFinite(settings.terminal.fontSize)) {
    settings.terminal.fontSize = DEFAULTS.terminal.fontSize;
  }
  settings.terminal.fontSize = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, settings.terminal.fontSize),
  );
  const term = settings.terminal;
  term.shell = typeof term.shell === "string" ? term.shell.trim() : "";
  term.fontFamily =
    typeof term.fontFamily === "string" && term.fontFamily.trim()
      ? term.fontFamily.trim()
      : DEFAULTS.terminal.fontFamily;
  term.scrollback = pixels(
    term.scrollback,
    SCROLLBACK_MIN,
    SCROLLBACK_MAX,
    DEFAULTS.terminal.scrollback,
  );
  if (!CURSOR_STYLES.includes(term.cursorStyle)) term.cursorStyle = DEFAULTS.terminal.cursorStyle;
  term.cursorBlink = term.cursorBlink !== false;
  settings.launch.refreshOnFocus = settings.launch.refreshOnFocus === true;
  const layout = settings.layout;
  layout.sidebar = pixels(layout.sidebar, SIDEBAR_MIN, SIDEBAR_MAX, DEFAULTS.layout.sidebar);
  layout.changes = pixels(layout.changes, CHANGES_MIN, CHANGES_MAX, DEFAULTS.layout.changes);
  layout.shell = pixels(layout.shell, SHELL_MIN, SHELL_MAX, DEFAULTS.layout.shell);
  layout.tasks =
    layout.tasks === null ? null : pixels(layout.tasks, TASKS_MIN, TASKS_MAX, 34);
  layout.changesHidden = layout.changesHidden === true;
  const gh = settings.github;
  gh.busyMinutes = minutes(gh.busyMinutes, DEFAULTS.github.busyMinutes);
  gh.idleMinutes = minutes(gh.idleMinutes, DEFAULTS.github.idleMinutes);
  gh.launchStaleMinutes = minutes(gh.launchStaleMinutes, DEFAULTS.github.launchStaleMinutes);
  const tour = settings.tour;
  tour.step = Number.isInteger(tour.step) && tour.step >= 0 ? tour.step : 0;
  tour.done = tour.done === true;
  return settings;
}

let current: Settings = read();
const listeners = new Set<() => void>();

export function settings(): Settings {
  return current;
}

/**
 * Writes one category's changes and tells every subscriber.
 *
 * Replaces the object rather than mutating it, so a React subscriber sees a
 * new reference and a comparison by identity is enough.
 */
export function updateSettings<K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) {
  current = { ...current, [key]: { ...current[key], ...patch } };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
    // The object now holds everything the old keys did.
    for (const legacy of keys()) {
      if (Object.values(LEGACY).some((old) => legacy === old || legacy.startsWith(`${old}:`))) {
        localStorage.removeItem(legacy);
      }
    }
  } catch {
    // A private window. The choice lasts the session.
  }
  for (const listener of listeners) listener();
}

/** Runs `listener` after every change. Returns the unsubscribe. */
export function subscribeSettings(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The settings, re-rendering whoever asked when any of them change. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, settings);
}

/**
 * One value out of the settings, re-rendering only when that value changes.
 * For `App`, which wants the graph's flag and not a render per step of the
 * type-size slider.
 */
export function useSetting<T>(select: (settings: Settings) => T): T {
  return useSyncExternalStore(subscribeSettings, () => select(current));
}
