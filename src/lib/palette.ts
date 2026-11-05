/**
 * How the command palette ranks a row against what was typed.
 *
 * The bands, best first: the whole label, the front of it, a word in it, the
 * middle of a word, then the hint. Inbox rows sit below all of those, and only
 * scattered letters sit below inbox rows.
 */

export interface Rankable {
  label: string;
  hint?: string;
  /**
   * A pull request or an issue from the inbox. Their titles are long enough to
   * hold almost any five letters in order, so they match only on a word start,
   * and rank below anything the palette can do.
   */
  inbox?: boolean;
}

/** What may come before a word. `#` so that `12` finds `#12`. */
const BOUNDARY = /[\s·:/\-#_.(]/;

/** A hit further along a label is worth a little less, and never a whole band. */
const offset = (at: number) => Math.min(at, 99);

/** The fewest characters of `label` that hold `needle` in order, or null when none do. */
function span(needle: string, label: string): number | null {
  let best: number | null = null;
  for (let start = label.indexOf(needle[0]); start !== -1; start = label.indexOf(needle[0], start + 1)) {
    let found = 0;
    for (let at = start; at < label.length; at += 1) {
      if (label[at] === needle[found]) found += 1;
      if (found === needle.length) {
        const length = at - start + 1;
        if (best === null || length < best) best = length;
        break;
      }
    }
    if (found < needle.length) break;
  }
  return best;
}

/**
 * Higher is better, null means no match.
 *
 * Subsequence matching runs against the label only. Including the hint made
 * every npm task match almost anything, because "npm run x" donates the r, u
 * and n of a query like "prune". The hint still matches, but only contiguously.
 */
export function score(needle: string, item: Rankable): number | null {
  if (!needle) return 0;
  const label = item.label.toLowerCase();
  const hint = (item.hint ?? "").toLowerCase();
  const inLabel = label.indexOf(needle);
  const wordStart = wordStartOf(needle, label);

  if (item.inbox) {
    if (wordStart >= 0) return 500 - offset(wordStart);
    return hint.includes(needle) ? 400 : null;
  }

  if (label === needle) return 1100;
  if (inLabel === 0) return 1000;
  if (wordStart >= 0) return 900 - offset(wordStart);
  if (inLabel > 0) return 800 - offset(inLabel);

  const inHint = hint.indexOf(needle);
  if (inHint >= 0) return 700 - offset(inHint);

  // "lsdev" still finds "LunchSpecial · dev". Tighter runs rank first, and a run
  // sprawled across a long label bottoms out above nothing.
  const run = span(needle, label);
  return run === null ? null : Math.max(1, 300 - (run - needle.length));
}

/** Where `needle` starts a word in `label`, or -1. */
function wordStartOf(needle: string, label: string): number {
  for (let at = label.indexOf(needle); at !== -1; at = label.indexOf(needle, at + 1)) {
    if (at === 0 || BOUNDARY.test(label[at - 1])) return at;
  }
  return -1;
}

/** The rows that match, best first. Ties keep their order, which puts repositories before tasks. */
export function rank<T extends Rankable>(query: string, items: T[]): T[] {
  const needle = query.trim().toLowerCase();
  return items
    .map((item) => ({ item, rank: score(needle, item) }))
    .filter((row): row is { item: T; rank: number } => row.rank !== null)
    .sort((a, b) => b.rank - a.rank)
    .map((row) => row.item);
}
