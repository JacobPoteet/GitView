/**
 * The keyboard, in one table.
 *
 * Every chord here is claimed in three places that have to agree: the
 * terminal releases it rather than sending it to the shell, `App` acts on
 * it, and the settings dialog lists it. One table keeps the three from
 * drifting, and `chordOf` is the one reading of a key event, so `Ctrl+Shift+C`
 * and `Ctrl+C` with caps lock on are the same chord everywhere.
 *
 * Rebinding is not here. The table is what the app does, not what this
 * person chose, and a Keyboard section that lists it read-only is enough for
 * the chords to be found without a cheat sheet.
 */

export interface Shortcut {
  /** The chord as `chordOf` spells it: `Ctrl+Shift+C`, `` Ctrl+` ``, `Ctrl+1`. */
  chord: string;
  /** What it does, for the settings dialog. */
  does: string;
}

export const SHORTCUTS: Shortcut[] = [
  { chord: "Ctrl+K", does: "Open the command palette" },
  { chord: "Ctrl+1 to Ctrl+9", does: "Select the first nine repositories, in the order the sidebar draws them" },
  { chord: "Ctrl+`", does: "Focus the terminal" },
  { chord: "Ctrl+Shift+C", does: "Focus the commit subject" },
  { chord: "Ctrl+H", does: "Open or close the history" },
  { chord: "Ctrl+I", does: "Open or close the inbox" },
  { chord: "Ctrl+,", does: "Open or close the settings" },
  { chord: "Ctrl+F", does: "Search, in whichever surface has focus: the scrollback, the history, or the repositories" },
  { chord: "Ctrl+Enter", does: "Commit, from the subject or the description" },
  { chord: "Escape", does: "Close what is on top, or leave the field" },
];

/** The chords `App` acts on, as `chordOf` spells them. `Ctrl+Enter` belongs to the commit box. */
const CLAIMED = new Set([
  "Ctrl+K",
  "Ctrl+1",
  "Ctrl+2",
  "Ctrl+3",
  "Ctrl+4",
  "Ctrl+5",
  "Ctrl+6",
  "Ctrl+7",
  "Ctrl+8",
  "Ctrl+9",
  "Ctrl+`",
  "Ctrl+Shift+C",
  "Ctrl+H",
  "Ctrl+I",
  "Ctrl+,",
  "Ctrl+F",
]);

/** The subset of a key event that names a chord. What a `KeyboardEvent` has, without needing one. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The chord a key event spells, or null when it is not one: no Ctrl, or Alt
 * held, which is AltGr on a keyboard that types `@` with it.
 *
 * Read from `code` for a digit and the backquote, because `Shift+1` reports
 * `!` as its key and a layout can put `` ` `` anywhere; from `key` for a
 * letter, upper-cased so caps lock changes nothing. Meta counts as Ctrl so
 * the same table holds on a Mac keyboard.
 */
export function chordOf(event: KeyLike): string | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  let key: string;
  const digit = /^Digit([1-9])$/.exec(event.code ?? "");
  if (digit) key = digit[1];
  else if (event.code === "Backquote") key = "`";
  else if (event.key === "," || event.code === "Comma") key = ",";
  else if (/^[a-z]$/i.test(event.key)) key = event.key.toUpperCase();
  else return null;
  return `Ctrl+${event.shiftKey ? "Shift+" : ""}${key}`;
}

/** Whether `App` wants this event, which is what the terminal asks before handing it to the shell. */
export function isClaimed(event: KeyLike): boolean {
  const chord = chordOf(event);
  return chord !== null && CLAIMED.has(chord);
}

/** The chord that selects the nth visible repository, for a palette hint. Null past the ninth. */
export function repoChord(index: number): string | null {
  return index >= 0 && index < 9 ? `Ctrl+${index + 1}` : null;
}
