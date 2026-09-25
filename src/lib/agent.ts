/**
 * What an agent in a shell is doing, read from what it already prints.
 *
 * Claude Code sets the window title with OSC 0 and puts its state in the first
 * glyph: a half-filled circle that alternates about once a second while it
 * works, and `✳` once it stops. Measured on 2.1.282 through a ConPTY:
 *
 *   ✳ Claude Code          launched, waiting for the first message
 *   ◐ Echo probe-123       working, then ◑, then ◐ again
 *   ✳ Echo probe-123       finished, or asking permission to write a file
 *   (empty)                /exit
 *
 * The title cannot tell a finished turn from a question, so the screen does:
 * a permission request and an AskUserQuestion both draw a footer ending in
 * `Esc to cancel`, and the prompt Claude returns to after a turn never does.
 *
 * Nothing is sent to Claude and nothing is written to its settings. Orca gets
 * the same three states from hooks it adds to `~/.claude/settings.json`, which
 * is a write to somebody's profile. See the Decision Log.
 */

/** Running, waiting on an answer, or finished while nobody was looking. */
export type AgentState = "running" | "waiting" | "done";

/**
 * What a title says, or null when it is not an agent's title at all: a
 * shell's own, the bare `claude` PowerShell sets while it launches, or the
 * empty one Claude leaves behind on exit.
 */
export function titleActivity(title: string): "working" | "idle" | null {
  if (title.startsWith("✳ ")) return "idle";
  // The half circles are what 2.1 draws. Braille is the spinner earlier
  // versions drew in the same place.
  if (/^[◐◑◒◓⠀-⣿] /.test(title)) return "working";
  return null;
}

/** How many rows up from the bottom of the screen a question's footer can sit. */
const FOOTER_REACH = 8;

/** Whether the bottom of the screen is a question waiting on an answer. */
export function asksForInput(rows: string[]): boolean {
  return rows.slice(-FOOTER_REACH).some((row) => /esc to cancel/i.test(row));
}

/**
 * What an agent is doing once its title settles.
 *
 * Idle after work is a finished turn, or a question when the screen shows
 * one. Idle with no work before it is a fresh launch, which asks nothing of
 * anyone, and so is a question answered with Escape: it goes back to whatever
 * it was before the question.
 */
export function settle(
  previous: AgentState | null,
  activity: "working" | "idle" | null,
  asking: boolean,
): AgentState | null {
  if (activity === null) return null;
  if (activity === "working") return "running";
  if (asking) return "waiting";
  if (previous === "running" || previous === "waiting") return "done";
  return previous;
}

const RANK: Record<AgentState, number> = { running: 1, done: 2, waiting: 3 };

/**
 * One state for a repository with several shells: the one that most wants
 * you. A question outranks a finished turn, and both outrank work in progress.
 */
export function strongest(states: Iterable<AgentState | null | undefined>): AgentState | null {
  let best: AgentState | null = null;
  for (const state of states) {
    if (state && (!best || RANK[state] > RANK[best])) best = state;
  }
  return best;
}

/** What the sidebar says, as a tooltip and to a screen reader. */
export function agentLabel(state: AgentState): string {
  if (state === "running") return "Claude is working";
  if (state === "waiting") return "Claude is waiting for your answer";
  return "Claude finished. Open its tab to read the reply";
}
