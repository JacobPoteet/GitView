/**
 * The first-run tour: what each step points at and says, and where its card
 * goes.
 *
 * A step moves on when you do the thing it describes, or when you press Next,
 * so the tour teaches by having you use the real window rather than by a
 * slideshow over it. Each step finds its target by a `data-tour` attribute,
 * and a step whose target is missing is skipped rather than pointing at
 * nothing: no `gh` means no inbox button, and no inbox step.
 */

/** What the app reports as it happens. `next` is the card's own button. */
export type TourEvent = "select" | "block" | "palette" | "next";

export interface TourStep {
  id: string;
  /** The `data-tour` value of the element the card points at. */
  anchor: string;
  title: string;
  body: string;
  /** The event that moves the tour on, besides Next. */
  advanceOn: TourEvent;
  /** What the card asks you to do, shown under the body. */
  action?: string;
}

export const STEPS: TourStep[] = [
  {
    id: "fleet",
    anchor: "fleet",
    title: "Your repositories",
    body: "Every repository in the folders you watch, one row each. The chips count commits ahead of and behind the remote, and files changed.",
    action: "Pick one to open it.",
    advanceOn: "select",
  },
  {
    id: "terminal",
    anchor: "terminal",
    title: "Its shell",
    body: "A real shell, opened in that repository. It keeps running when you look at another one, so a dev server stays up while you work elsewhere.",
    action: "Run something here. git status will do.",
    advanceOn: "block",
  },
  {
    id: "actions",
    anchor: "actions",
    title: "Buttons that name their command",
    body: "Hover a button to read the git command it types. A click runs it in the shell, where you can read it back. Shift-click types it and leaves it at the prompt.",
    advanceOn: "next",
  },
  {
    id: "graph",
    anchor: "graph",
    title: "How far you have drifted",
    body: "This strip compares the branch you are on with its base: what you have that it lacks, and what it has that you lack. The history of every branch opens from here.",
    advanceOn: "next",
  },
  {
    id: "changes",
    anchor: "changes",
    title: "Staging types too",
    body: "Your working tree, file by file. Staging a file or a single hunk and committing all go through the shell, so the scrollback says what happened.",
    advanceOn: "next",
  },
  {
    id: "palette",
    anchor: "palette",
    title: "Everything else",
    body: "Ctrl+K opens the palette: every repository, every script GitView found in your manifests, and every action in the app.",
    action: "Press Ctrl+K.",
    advanceOn: "palette",
  },
  {
    id: "inbox",
    anchor: "inbox",
    title: "GitHub, read through gh",
    body: "Pull requests, issues and checks for the whole fleet, in one pane. Reading happens out of sight; merging and commenting get typed into the repository's shell.",
    advanceOn: "next",
  },
];

/**
 * The step to show at or after `from`, skipping any whose anchor is absent.
 * Returns `STEPS.length` when none is left, which is the tour finishing.
 */
export function nextVisible(from: number, present: (anchor: string) => boolean): number {
  let i = Math.max(0, from);
  while (i < STEPS.length && !present(STEPS[i].anchor)) i++;
  return i;
}

/** Where the tour goes on `event` from step `at`. Unchanged when the event is not this step's. */
export function advance(at: number, event: TourEvent): number {
  const step = STEPS[at];
  if (!step) return at;
  return event === "next" || event === step.advanceOn ? at + 1 : at;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 12;

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where a card of `size` goes beside `anchor`.
 *
 * Tried in order: right, left, below (left-aligned, then right-aligned),
 * above, then inside the anchor's bottom edge. The first that fits the
 * viewport and covers nothing in `avoid` wins, which is how the card stays off
 * the terminal: the app passes the terminal's rect unless the terminal is what
 * the card is about. With nothing clean, the
 * first that fits the viewport wins, and the inside placement always fits.
 */
export function place(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  avoid: Rect[] = [],
): { left: number; top: number } {
  const { width, height } = size;
  const maxLeft = viewport.width - width - GAP;
  const maxTop = viewport.height - height - GAP;
  const alongY = clamp(anchor.top, GAP, maxTop);
  const alongX = clamp(anchor.left, GAP, maxLeft);
  const candidates = [
    { left: anchor.left + anchor.width + GAP, top: alongY },
    { left: anchor.left - GAP - width, top: alongY },
    { left: alongX, top: anchor.top + anchor.height + GAP },
    // Below again, lined up with the anchor's right edge instead, which is
    // what keeps a card for a small button in the sidebar's corner inside
    // the sidebar.
    {
      left: clamp(anchor.left + anchor.width - width, GAP, maxLeft),
      top: anchor.top + anchor.height + GAP,
    },
    { left: alongX, top: anchor.top - GAP - height },
  ];
  const inside = {
    left: clamp(anchor.left + GAP, GAP, maxLeft),
    top: clamp(anchor.top + anchor.height - height - GAP, GAP, maxTop),
  };
  const fits = (c: { left: number; top: number }) =>
    c.left >= GAP && c.top >= GAP && c.left <= maxLeft && c.top <= maxTop;
  const clean = (c: { left: number; top: number }) =>
    !avoid.some((rect) => overlaps({ ...c, width, height }, rect));

  return (
    candidates.find((c) => fits(c) && clean(c)) ??
    (clean(inside) ? inside : undefined) ??
    candidates.find(fits) ??
    inside
  );
}
