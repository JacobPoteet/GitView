/**
 * The themes the app can wear, and the one place that applies them.
 *
 * A theme is two things. Its CSS is a file of its own, `theme-<id>.css`,
 * imported in `main.tsx`: token overrides under `:root[data-theme="<id>"]`,
 * then whatever a token cannot say, scoped to the same attribute. The default
 * theme is the bare `:root` in `styles.css` and has no file. Its terminal
 * palette lives here, because xterm parses its own colours and cannot read a
 * custom property. Adding a theme is one entry in `THEMES` and one file.
 *
 * This module imports nothing from `settings.ts`, which imports it to check a
 * stored id against `THEMES`.
 */

/** The colours xterm takes. Hex only: it cannot parse OKLCH. */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** How a find match is drawn. The search addon wants #RRGGBB for each. */
export interface SearchPalette {
  matchBackground: string;
  matchBorder: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
}

export interface Theme {
  id: string;
  label: string;
  /** One line for the picker. */
  hint: string;
  terminal: TerminalPalette;
  search: SearchPalette;
}

const GITVIEW: Theme = {
  id: "gitview",
  label: "GitView",
  hint: "The dark violet default.",
  terminal: {
    background: "#0F1013",
    foreground: "#E4E5EA",
    cursor: "#A78BFA",
    cursorAccent: "#0F1013",
    selectionBackground: "#2F3242",
    black: "#1A1C22",
    red: "#F87171",
    green: "#4ADE80",
    yellow: "#FBBF24",
    blue: "#60A5FA",
    magenta: "#A78BFA",
    cyan: "#22D3EE",
    white: "#D4D6DD",
    brightBlack: "#4B4F5C",
    brightRed: "#FCA5A5",
    brightGreen: "#86EFAC",
    brightYellow: "#FDE047",
    brightBlue: "#93C5FD",
    brightMagenta: "#C4B5FD",
    brightCyan: "#67E8F9",
    brightWhite: "#F5F6F8",
  },
  // The theme's violet and its lighter step, the same family as the cursor;
  // the selection colour is what the active match sits over.
  search: {
    matchBackground: "#3B3F63",
    matchBorder: "#5B4BD6",
    matchOverviewRuler: "#5B4BD6",
    activeMatchBackground: "#7C5CFF",
    activeMatchBorder: "#C4B5FD",
    activeMatchColorOverviewRuler: "#C4B5FD",
  },
};

const WIN98: Theme = {
  id: "win98",
  label: "Windows 98",
  hint: "Silver bevels, a navy title bar and a pixel face, after 98.css.",
  // The VGA sixteen, which is what a DOS prompt in Windows 98 drew.
  terminal: {
    background: "#000000",
    foreground: "#C0C0C0",
    cursor: "#C0C0C0",
    cursorAccent: "#000000",
    selectionBackground: "#000080",
    black: "#000000",
    red: "#AA0000",
    green: "#00AA00",
    yellow: "#AA5500",
    blue: "#0000AA",
    magenta: "#AA00AA",
    cyan: "#00AAAA",
    white: "#AAAAAA",
    brightBlack: "#555555",
    brightRed: "#FF5555",
    brightGreen: "#55FF55",
    brightYellow: "#FFFF55",
    brightBlue: "#5555FF",
    brightMagenta: "#FF55FF",
    brightCyan: "#55FFFF",
    brightWhite: "#FFFFFF",
  },
  search: {
    matchBackground: "#808000",
    matchBorder: "#FFFF55",
    matchOverviewRuler: "#FFFF55",
    activeMatchBackground: "#000080",
    activeMatchBorder: "#55FFFF",
    activeMatchColorOverviewRuler: "#55FFFF",
  },
};

export const THEMES: Theme[] = [GITVIEW, WIN98];

export const DEFAULT_THEME = GITVIEW.id;

/** The theme for an id, or the default when the id is unknown (a theme since removed). */
export function themeFor(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? GITVIEW;
}

export function isThemeId(id: unknown): id is string {
  return typeof id === "string" && THEMES.some((theme) => theme.id === id);
}

/**
 * Puts the theme on the document. The default carries no attribute, so the
 * bare `:root` tokens apply and an install that never opens Appearance sees
 * exactly what it saw before.
 */
export function applyTheme(id: string) {
  const root = document.documentElement;
  if (id === DEFAULT_THEME) delete root.dataset.theme;
  else root.dataset.theme = id;
}
