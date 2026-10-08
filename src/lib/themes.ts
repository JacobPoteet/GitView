/**
 * The themes the app can wear, and the one place that applies them.
 *
 * A theme is two things. Its CSS is a block of token overrides under
 * `:root[data-theme="<id>"]` in `styles.css`; the default theme is the bare
 * `:root` and has no block. Its terminal palette lives here, because xterm
 * parses its own colours and cannot read a custom property. Adding a theme is
 * one entry in `THEMES` and one block of tokens.
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

export const THEMES: Theme[] = [GITVIEW];

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
