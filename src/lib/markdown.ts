/**
 * The pieces of Markdown rendering that are GitView's own. The parsing is
 * `react-markdown` with `remark-gfm`, drawn by `components/Markdown.tsx`; what
 * lives here is what no Markdown library knows about commit messages.
 */

const TRAILER = /^[A-Za-z][A-Za-z0-9-]*: \S/;
const BLANK = /^\s*$/;

/**
 * Keeps a block of trailer lines (`Signed-off-by: ...`, `Co-Authored-By: ...`)
 * one to a line. Markdown runs consecutive lines into one paragraph, which
 * reads as one long line of names. Two trailing spaces are Markdown's hard
 * break, added to every line but the last of a paragraph made only of
 * trailers. A lone `Note: ...` line is left alone, since one line has nothing
 * to run into.
 */
export function keepTrailers(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length) {
    let end = start;
    while (end < lines.length && !BLANK.test(lines[end])) end += 1;
    const block = lines.slice(start, end);
    if (block.length > 1 && block.every((line) => TRAILER.test(line))) {
      for (let k = start; k < end - 1; k += 1) lines[k] = `${lines[k].trimEnd()}  `;
    }
    start = end + 1;
  }
  return lines.join("\n");
}

/**
 * Whether one line could hold any inline Markdown at all. Most commit
 * subjects hold none, and a history page draws hundreds of them, so those skip
 * the parser and render as the text they are.
 */
export function hasInlineMarkdown(text: string): boolean {
  return /[`*_~[<\\&]|https?:\/\/|www\./i.test(text);
}

/** Whether a link may be offered as something to open. Only the web, never a path. */
export function isWebLink(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
