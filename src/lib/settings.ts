/**
 * The app's own settings, in one place.
 *
 * Every choice here is about this window and this install: how big the
 * terminal's type is, whether the app fetches on launch. None of it is about
 * a repository, which is why it lives in `localStorage` beside the graph's
 * collapsed flag rather than in SQLite beside the pins. The watched folders
 * stay in the database because the scanner reads them from Rust.
 *
 * One JSON blob under one key, merged over the defaults on read, so a setting
 * added later reads as its default on an install that never saw it and a
 * setting removed later is ignored rather than crashing the parse.
 */

import { useSyncExternalStore } from "react";

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
  };
  launch: {
    /** `git fetch` in every repository at launch, when the last one is stale. */
    fetch: boolean;
    /** Ask GitHub for the latest release at launch. Only a word in the status bar either way. */
    checkUpdate: boolean;
  };
}

export const DEFAULTS: Settings = {
  terminal: { fontSize: 12.5, screenReader: false },
  launch: { fetch: true, checkUpdate: true },
};

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 20;

const KEY = "gitview.settings";
/** The key screen reader mode had before there was a settings object. */
const LEGACY_READER_KEY = "gitview.terminal.screenReader";

type Stored = { [K in keyof Settings]?: Partial<Settings[K]> };

function read(): Settings {
  let stored: Stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    stored = {};
  }
  const settings: Settings = {
    terminal: { ...DEFAULTS.terminal, ...stored.terminal },
    launch: { ...DEFAULTS.launch, ...stored.launch },
  };
  // A choice made through the palette before the settings dialog existed.
  const legacy = localStorage.getItem(LEGACY_READER_KEY);
  if (legacy !== null && stored.terminal?.screenReader === undefined) {
    settings.terminal.screenReader = legacy === "1";
  }
  if (!Number.isFinite(settings.terminal.fontSize)) {
    settings.terminal.fontSize = DEFAULTS.terminal.fontSize;
  }
  settings.terminal.fontSize = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, settings.terminal.fontSize),
  );
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
  localStorage.setItem(KEY, JSON.stringify(current));
  localStorage.removeItem(LEGACY_READER_KEY);
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
