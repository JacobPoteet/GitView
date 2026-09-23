import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import { copyText } from "../lib/clipboard";
import { Terminal, type IDecoration, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import type { CommandBlock, StoredBlock } from "../lib/types";
import { settings, subscribeSettings } from "../lib/settings";
import { isClaimed } from "../lib/keys";
import { nextSessionId, sessionLabel, sessionsOf } from "../lib/sessions";

/**
 * Sessions live in this module rather than in component state, so switching to
 * another repository and back keeps the shell, the scrollback and any dev server
 * running. The host element is retained too: xterm's buffer lives in that DOM,
 * so the pane detaches and reattaches it instead of rebuilding a terminal.
 *
 * The output channel is owned by the session for the same reason. It used to be
 * owned by the React effect, which meant a build that finished while you were
 * looking at another project wrote into a callback that had already been told to
 * ignore it, and those lines never reached the scrollback at all.
 */
interface Session {
  id: string;
  term: Terminal;
  fit: FitAddon;
  /** Search over the buffer. Per session, since the buffer is. */
  search: SearchAddon;
  /** The buffer as text with its escapes, for saving across a restart. */
  serialize: SerializeAddon;
  /** The debounced save, and when the last one happened. */
  saveTimer: number | undefined;
  savedAt: number;
  /** Whether the saved scrollback has been asked for, so a second open never writes it twice. */
  restored: boolean;
  host: HTMLDivElement;
  opened: boolean;
  /** Whether the Rust side is holding a channel that reaches this session. */
  attached: boolean;
  webgl: WebglAddon | null;

  blocks: CommandBlock[];
  /** The block between its C and D marks, which is where output is arriving. */
  running: CommandBlock | null;
  /** Carried from the E mark to the C mark that follows it. */
  nextCommand: string;
  marks: Map<number, { start: IMarker | null }>;
  decorations: Map<number, IDecoration>;
  /** The line each block's gutter mark was last drawn on. */
  painted: Map<number, number>;
  listeners: Set<(blocks: CommandBlock[]) => void>;
  /** Rebuilt whenever the list changes, so React can compare by reference. */
  snapshot: CommandBlock[];

  onSettled: ((repoPath: string) => void) | null;
  settleTimer: number | undefined;
}

const sessions = new Map<string, Session>();

/**
 * How a search match is drawn. The addon wants #RRGGBB, so these are the
 * theme's violet and its lighter step written out, the same family as the
 * cursor; the selection colour is what the active match sits over.
 */
const SEARCH_DECORATIONS = {
  matchBackground: "#3B3F63",
  matchBorder: "#5B4BD6",
  matchOverviewRuler: "#5B4BD6",
  activeMatchBackground: "#7C5CFF",
  activeMatchBorder: "#C4B5FD",
  activeMatchColorOverviewRuler: "#C4B5FD",
};

/**
 * The settings every terminal shares: the type size and whether xterm keeps
 * a live region a screen reader can follow.
 *
 * `lib/settings` owns the values. This applies them to every open session
 * when they change, and `getSession` reads them for every session opened
 * after. A size change refits the attached session so the shell learns its
 * new column count, and the rest refit when they next attach.
 */
function applyTerminalSettings() {
  const { fontSize, screenReader } = settings().terminal;
  for (const session of sessions.values()) {
    session.term.options.screenReaderMode = screenReader;
    if (session.term.options.fontSize !== fontSize) {
      session.term.options.fontSize = fontSize;
      if (session.host.isConnected) {
        try {
          session.fit.fit();
          api.ptyResize(session.id, session.term.cols, session.term.rows).catch(() => undefined);
        } catch {
          // Measured mid-transition. The ResizeObserver refits on the next frame.
        }
      }
    }
  }
}
subscribeSettings(applyTerminalSettings);

// Driving the window over the WebView2 debug port is how this project checks a
// terminal change, and none of the state worth checking is in the DOM. Vite
// drops this from a production bundle.
if (import.meta.env.DEV) {
  (window as unknown as { __gitview: unknown }).__gitview = { sessions };
}
let nextBlockId = 1;

/** Past this, the oldest block and its marks are dropped. */
const BLOCK_LIMIT = 200;
/** Lines of a block's output that "Copy for Claude" carries, from the end. */
const OUTPUT_LIMIT = 400;
/** How far from its recorded line a command line is worth looking for. */
const ANCHOR_REACH = 3;
/** Blocks re-checked when one starts or finishes. Older ones are off screen. */
const RECONCILE_LIMIT = 60;
/** Enough of a command to recognise its line by, without the whole thing. */
const ANCHOR_TAIL = 24;

const THEME = {
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
};

// ------------------------------------------------------------ prompt marks

/**
 * Undoes the escaping the shell integration applies to a mark's payload. The
 * shell escapes the characters that would end the sequence early or split it
 * into another parameter; everything else travels as itself.
 */
function unescapeMark(payload: string): string {
  return payload.replace(/\\(\\|x[0-9a-fA-F]{2})/g, (_, group: string) =>
    group === "\\" ? "\\" : String.fromCharCode(parseInt(group.slice(1), 16)),
  );
}

function notify(session: Session) {
  reconcile(session);
  session.snapshot = [...session.blocks];
  for (const listener of session.listeners) listener(session.snapshot);
}

// ------------------------------------------------------------ anchoring

function lineText(session: Session, y: number): string | null {
  const buffer = session.term.buffer.normal;
  if (y < 0 || y >= buffer.length) return null;
  return buffer.getLine(y)?.translateToString(true) ?? null;
}

/**
 * The whole line at a row, and the rows it takes up.
 *
 * A command long enough to wrap occupies several rows, and each one holds a
 * fragment. Matching a fragment against the command text fails, so the rows are
 * put back together before anything is compared.
 */
function logicalLine(
  session: Session,
  y: number,
): { text: string; first: number; last: number } | null {
  const buffer = session.term.buffer.normal;
  if (y < 0 || y >= buffer.length) return null;

  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;

  let last = first;
  let text = buffer.getLine(first)?.translateToString(true) ?? "";
  while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) {
    last += 1;
    text += buffer.getLine(last)?.translateToString(true) ?? "";
  }
  return { text, first, last };
}

/** The last row of the line that starts at `first`. */
function lineEnd(session: Session, first: number): number {
  return logicalLine(session, first)?.last ?? first;
}

/** A marker at an absolute line. xterm only takes an offset from the cursor. */
function markerAt(session: Session, line: number): IMarker | null {
  const buffer = session.term.buffer.normal;
  return session.term.registerMarker(line - (buffer.baseY + buffer.cursorY)) ?? null;
}

/**
 * Where a block's command line is now, or null if it has gone.
 *
 * A line number on its own is not an identity for a line. The buffer is not
 * append-only: `cls`, a full-screen program, and PSReadLine repainting the
 * prompt after a resize all rewrite lines that are already there, so a marker
 * taken before any of that ends up describing whatever now occupies that line.
 * Reading a block's output through a marker alone was off by one line for
 * exactly this reason, and the wrong line looked plausible.
 *
 * The command text is the second opinion. The shell already told us what was
 * typed, the prompt line ends with it, and that is enough to move the marker
 * back onto it or to conclude the line is no longer there.
 */
function anchor(session: Session, block: CommandBlock): number | null {
  const marks = session.marks.get(block.id);
  const marker = marks?.start;
  if (!marks || !marker || marker.isDisposed) return null;

  const first = block.command.split("\n")[0].trimEnd();
  const tail = first.length > ANCHOR_TAIL ? first.slice(-ANCHOR_TAIL) : first;
  const matches = (y: number) => {
    const line = logicalLine(session, y);
    return line && line.text.trimEnd().endsWith(tail) ? line : null;
  };

  for (let step = 0; step <= ANCHOR_REACH; step += 1) {
    const candidates = step === 0 ? [marker.line] : [marker.line - step, marker.line + step];
    for (const y of candidates) {
      let line = matches(y);
      if (!line) continue;

      // Resizing makes ConPTY repaint, and a repaint can leave the command on
      // screen twice. The lower copy is the one the output follows.
      for (let below = matches(line.last + 1); below; below = matches(line.last + 1)) {
        line = below;
      }

      if (line.first !== marker.line) {
        const moved = markerAt(session, line.first);
        if (moved) {
          marker.dispose();
          marks.start = moved;
        }
      }
      return line.first;
    }
  }

  marker.dispose();
  marks.start = null;
  return null;
}

/**
 * Keeps the gutter honest. A mark left on a line that has since become
 * something else is worse than no mark, so it goes.
 */
function reconcile(session: Session) {
  for (const block of session.blocks.slice(-RECONCILE_LIMIT)) {
    const line = anchor(session, block);
    if (line === null) {
      session.decorations.get(block.id)?.dispose();
      session.decorations.delete(block.id);
      session.painted.delete(block.id);
    } else if (session.painted.get(block.id) !== line) {
      paint(session, block);
    }
  }
}

// ------------------------------------------------------------ decorations

function paint(session: Session, block: CommandBlock) {
  const line = anchor(session, block);
  const marker = session.marks.get(block.id)?.start;
  if (line === null || !marker) return;
  session.decorations.get(block.id)?.dispose();
  const state =
    block.exitCode === null ? "running" : block.exitCode === 0 ? "ok" : "failed";
  try {
    const decoration = session.term.registerDecoration({ marker, x: 0, width: 1 });
    if (!decoration) return;
    decoration.onRender((element) => {
      // Add, never assign. xterm positions a decoration through its own
      // `xterm-decoration` class, so overwriting className drops the element out
      // of absolute positioning and every mark stacks at the top of the pane
      // instead of sitting on its command.
      element.classList.add("block-mark", state);
    });
    session.decorations.set(block.id, decoration);
    session.painted.set(block.id, line);
  } catch {
    // A decoration is a hint about a line, never the reason to lose the line.
  }
}

function forget(session: Session, block: CommandBlock) {
  session.decorations.get(block.id)?.dispose();
  session.decorations.delete(block.id);
  session.painted.delete(block.id);
  session.marks.get(block.id)?.start?.dispose();
  session.marks.delete(block.id);
}

function beginBlock(session: Session) {
  const command = session.nextCommand.trim();
  session.nextCommand = "";
  // Without PSReadLine there is no command text and nothing worth a row. The
  // prompt marks still arrive, and the shell is no worse off than before.
  if (!command) return;

  // At the C mark the cursor has already moved past the command, so the line
  // holding what was typed is the one above it.
  const start = session.term.registerMarker(-1) ?? session.term.registerMarker(0);
  const block: CommandBlock = {
    id: nextBlockId++,
    repoPath: session.id,
    command,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
  };
  session.running = block;
  session.blocks.push(block);
  session.marks.set(block.id, { start: start ?? null });
  paint(session, block);

  while (session.blocks.length > BLOCK_LIMIT) {
    const dropped = session.blocks.shift();
    if (dropped) forget(session, dropped);
  }
  notify(session);
}

function endBlock(session: Session, payload: string) {
  const block = session.running;
  session.running = null;
  if (!block) return;
  const code = Number.parseInt(payload, 10);
  block.exitCode = Number.isNaN(code) ? 0 : code;
  block.endedAt = Date.now();
  paint(session, block);
  notify(session);
}

function handleMark(session: Session, data: string) {
  const kind = data[0];
  const payload = data.slice(2);
  if (kind === "E") session.nextCommand = unescapeMark(payload);
  else if (kind === "C") beginBlock(session);
  else if (kind === "D") endBlock(session, payload);
  // A and B mark the prompt itself. Neither says anything reliable about a
  // line, because of the cursor lag described in `outputEnd`.
}

// ------------------------------------------------------------ reading back

/** The buffer between two lines, unwrapped, with the ANSI already resolved. */
function readLines(term: Terminal, from: number, to: number): string[] {
  const buffer = term.buffer.normal;
  const first = Math.max(0, from);
  const last = Math.min(to, buffer.length - 1);
  const lines: string[] = [];
  let current = "";
  let started = false;

  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && started) {
      current += text;
    } else {
      if (started) lines.push(current);
      current = text;
      started = true;
    }
  }
  if (started) lines.push(current);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/**
 * Where a block's output ends.
 *
 * The next command's prompt line is the boundary, and that line anchors itself,
 * so nothing here depends on a stored line number surviving. Only the newest
 * finished block has no successor to measure against.
 */
function outputEnd(session: Session, block: CommandBlock, start: number): number {
  const index = session.blocks.indexOf(block);
  const next = index === -1 ? undefined : session.blocks[index + 1];
  if (next) {
    const nextStart = anchor(session, next);
    if (nextStart !== null && nextStart > start) return nextStart - 1;
  }

  // Nothing has been typed since, so the last line with anything on it is the
  // prompt that came back, and the output stops one line above it. Measuring
  // this rather than marking it is deliberate: ConPTY holds a cursor move until
  // the next write, so a marker taken at the D mark lands on the last line of
  // the output and one taken at B lands there too.
  const buffer = session.term.buffer.normal;
  let line = buffer.baseY + buffer.cursorY;
  while (line > start && (lineText(session, line) ?? "").trim() === "") line -= 1;
  return block.exitCode === null ? line : line - 1;
}

/**
 * What a block printed, read out of the terminal buffer rather than kept in a
 * second copy. xterm has already applied the escape codes, so a progress bar
 * that rewrote its own line reads as the line it ended on.
 *
 * Empty when the command's line is no longer in the scrollback, which is the
 * honest answer after a `cls` or once 20,000 lines have gone past.
 */
export function blockOutput(repoPath: string, blockId: number): string {
  const session = sessions.get(repoPath);
  const block = session?.blocks.find((candidate) => candidate.id === blockId);
  if (!session || !block) return "";
  const start = anchor(session, block);
  if (start === null) return "";

  const lines = readLines(
    session.term,
    lineEnd(session, start) + 1,
    outputEnd(session, block, start),
  );
  if (lines.length <= OUTPUT_LIMIT) return lines.join("\n");
  return [
    `[${lines.length - OUTPUT_LIMIT} earlier lines not shown]`,
    ...lines.slice(-OUTPUT_LIMIT),
  ].join("\n");
}

/** Puts a block's command line back on screen. */
export function revealBlock(repoPath: string, blockId: number) {
  const session = sessions.get(repoPath);
  const block = session?.blocks.find((candidate) => candidate.id === blockId);
  if (!session || !block) return;
  const line = anchor(session, block);
  if (line === null) return;
  session.term.scrollToLine(Math.max(0, line - 1));
  session.term.focus();
}

export function getBlocks(repoPath: string): CommandBlock[] {
  return sessions.get(repoPath)?.snapshot ?? [];
}

/** Fires whenever a block starts or finishes in this repository's shell. */
export function subscribeBlocks(
  repoPath: string,
  listener: (blocks: CommandBlock[]) => void,
): () => void {
  const session = getSession(repoPath);
  session.listeners.add(listener);
  listener(session.snapshot);
  return () => {
    session.listeners.delete(listener);
  };
}

// ------------------------------------------------------------ the session

function getSession(id: string): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const term = new Terminal({
    fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, ui-monospace, monospace',
    fontSize: settings().terminal.fontSize,
    lineHeight: 1.35,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 20000,
    theme: THEME,
    allowProposedApi: true,
    screenReaderMode: settings().terminal.screenReader,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const search = new SearchAddon();
  term.loadAddon(search);
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  // The terminal holds focus whenever a repository is selected, so without this
  // Ctrl+K reached the shell as a literal ^K and the palette never opened.
  //
  // Returning false stops xterm processing the key, which both keeps it out of
  // the PTY and lets it bubble to App's window listener. Do not also dispatch an
  // event here: the window handler already fires, and two toggles cancel out.
  //
  // Ctrl+F takes the same route for the pane's own search field: the pane
  // hears it on the host and opens the field, and the shell never sees ^F.
  // Every other chord in `lib/keys.ts` goes the same way, so Ctrl+H reaches
  // the history rather than the shell's backspace.
  term.attachCustomKeyEventHandler((event) => !(event.type === "keydown" && isClaimed(event)));

  const host = document.createElement("div");
  host.style.height = "100%";

  const session: Session = {
    id,
    term,
    fit,
    search,
    serialize,
    saveTimer: undefined,
    savedAt: 0,
    restored: false,
    host,
    opened: false,
    attached: false,
    webgl: null,
    blocks: [],
    running: null,
    nextCommand: "",
    marks: new Map(),
    decorations: new Map(),
    painted: new Map(),
    listeners: new Set(),
    snapshot: [],
    onSettled: null,
    settleTimer: undefined,
  };

  // Registering the handler on the parser rather than scanning the raw chunk
  // means the mark is dealt with at the exact point in the buffer the shell
  // emitted it, which is what makes a marker land on the right line.
  term.parser.registerOscHandler(133, (data) => {
    handleMark(session, data);
    return true;
  });

  sessions.set(id, session);
  return session;
}

function receive(session: Session, chunk: string) {
  session.term.write(chunk);
  // A command that prints without pause never settles, so it is saved on a
  // clock as well: a dev server's log is the scrollback most worth keeping.
  if (session.running && Date.now() - session.savedAt > SAVE_EVERY) scheduleSave(session, 0);
  window.clearTimeout(session.settleTimer);
  session.settleTimer = window.setTimeout(() => {
    session.onSettled?.(session.id);
    // A dev server announces its port on the way up and then goes quiet, so the
    // moment the output settles is the moment the port is worth reading.
    if (session.running) notify(session);
    scheduleSave(session);
  }, 900);
}

// ------------------------------------------------------------ across restarts

/** How long a shell that keeps printing goes between saves. */
const SAVE_EVERY = 15_000;

/**
 * The buffer and the blocks, written out for the next launch. Debounced, so a
 * build that settles every few hundred milliseconds does not write twenty
 * thousand lines each time. Only a session with a shell behind it: a closed
 * one has had its file removed on purpose.
 */
function scheduleSave(session: Session, delay = 2000) {
  if (!settings().terminal.restoreScrollback || !session.attached) return;
  window.clearTimeout(session.saveTimer);
  session.saveTimer = window.setTimeout(() => saveSession(session), delay);
}

async function saveSession(session: Session): Promise<void> {
  window.clearTimeout(session.saveTimer);
  session.saveTimer = undefined;
  if (!settings().terminal.restoreScrollback || !session.attached) return;
  session.savedAt = Date.now();
  // A block still running has no exit code to record, and its output is the
  // part of the buffer most likely to change before the next save, so it
  // waits for the save after it ends.
  const blocks: StoredBlock[] = [];
  for (const block of session.blocks) {
    if (block.exitCode === null) continue;
    const line = anchor(session, block);
    if (line === null) continue;
    blocks.push({
      command: block.command,
      startedAt: block.startedAt,
      endedAt: block.endedAt,
      exitCode: block.exitCode,
      line,
    });
  }
  try {
    await api.scrollbackWrite(session.id, session.serialize.serialize(), blocks);
  } catch {
    // A write that failed is a scrollback that is not restored, and nothing
    // the shell is doing depends on it.
  }
}

/**
 * Writes every live shell out. Called once when the window is asked to
 * close, which Rust holds until this has finished and `app_quit` is called.
 * The hold is bounded: a save that hangs must not keep the app open.
 */
export async function saveAllSessions(): Promise<void> {
  const live = [...sessions.values()].filter((session) => session.attached);
  await Promise.race([
    Promise.all(live.map((session) => saveSession(session))),
    new Promise((resolve) => window.setTimeout(resolve, 3000)),
  ]);
}

// The close button is a request: Rust holds it, this writes, and `app_quit`
// finishes. Registered once for the module, since the sessions are.
listen("closing", async () => {
  try {
    await saveAllSessions();
  } finally {
    api.appQuit().catch(() => undefined);
  }
}).catch(() => undefined);

/**
 * Puts a saved scrollback back into a fresh terminal, before the shell's
 * first prompt lands, and re-anchors its blocks on the lines they sat on.
 * Each block goes through `anchor` the way a live one does, so a line that
 * does not end with its command is a block that is not restored.
 */
async function restoreSession(session: Session): Promise<void> {
  if (session.restored || !settings().terminal.restoreScrollback) return;
  session.restored = true;
  let stored;
  try {
    stored = await api.scrollbackRead(session.id);
  } catch {
    return;
  }
  if (!stored || !stored.text) return;
  await new Promise<void>((resolve) => session.term.write(stored.text, resolve));
  for (const saved of stored.blocks) {
    const marker = markerAt(session, saved.line);
    if (!marker) continue;
    const block: CommandBlock = {
      id: nextBlockId++,
      repoPath: session.id,
      command: saved.command,
      startedAt: saved.startedAt,
      endedAt: saved.endedAt,
      exitCode: saved.exitCode,
      restored: true,
    };
    session.marks.set(block.id, { start: marker });
    if (anchor(session, block) === null) {
      session.marks.delete(block.id);
      continue;
    }
    session.blocks.push(block);
    paint(session, block);
  }
  // A dim rule between then and now, so the eye can find where this launch
  // begins without reading the timestamps. Then a screen's worth of blank
  // lines: ConPTY clears the viewport as the shell starts, so what was
  // restored has to be in the scrollback by then, where a clear cannot reach.
  const when = stored.savedAt ? new Date(stored.savedAt * 1000).toLocaleString() : "";
  const rule = `\r\n\x1b[2m── previous session${when ? `, saved ${when}` : ""} ──\x1b[0m`;
  await new Promise<void>((resolve) =>
    session.term.write(rule + "\r\n".repeat(session.term.rows), resolve),
  );
  notify(session);
}

/** WebGL, with the fallback logged rather than silent. */
function loadRenderer(session: Session) {
  if (session.webgl) return;
  try {
    const addon = new WebglAddon();
    // Detaching the host to show another repository can take the GL context
    // with it. Disposing on loss falls back to the DOM renderer instead of
    // leaving a canvas that has stopped painting.
    addon.onContextLoss(() => {
      addon.dispose();
      session.webgl = null;
    });
    session.term.loadAddon(addon);
    session.webgl = addon;
  } catch {
    console.warn("WebGL renderer unavailable, using the default renderer");
  }
}

interface Props {
  repoPath: string | null;
  /** The shell on screen: the path for the first, `path#2` for the next. See `lib/sessions.ts`. */
  sessionId: string | null;
  /** A tab was clicked, or `+` asked for one more. */
  onSelectTab: (sessionId: string) => void;
  /** False once the shell has been closed on purpose, until it is asked for
   *  again. Without it the pane would open a replacement on the next render and
   *  there would still be no way to end a session. */
  open: boolean;
  /** Fires once output has been quiet for a beat, which is when a hand-typed
   *  commit is worth picking up in the sidebar. Named by session id. */
  onSettled: (sessionId: string) => void;
  onLiveChange: (sessionId: string, live: boolean) => void;
  onRequestClose: (sessionId: string) => void;
  onReopen: (sessionId: string) => void;
  /** The status bar, for the one thing the menu can fail at: a paste the
   *  clipboard refused to hand over. */
  onNote: (text: string) => void;
  /** The block strip, drawn under the tab bar so it belongs to this shell
   *  rather than floating between the graph and the terminal. */
  children?: ReactNode;
}

export default function TerminalPane({
  repoPath,
  sessionId,
  onSelectTab,
  open,
  onSettled,
  onLiveChange,
  onRequestClose,
  onReopen,
  onNote,
  children,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu<null>();

  /**
   * Search over the scrollback, in the tab bar. Opened by Ctrl+F with the
   * shell focused, or from the shell's menu. Enter steps forward, Shift+Enter
   * back, Escape closes it and hands focus back to the shell. Incremental, so
   * the first match lights up as the word is typed, and the count in the
   * field is the addon's own. It is per pane rather than per session: a
   * search is a question, not state the scrollback carries.
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchHits, setSearchHits] = useState<{ index: number; count: number } | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const session = sessionId ? sessions.get(sessionId) : undefined;

  useEffect(() => {
    setSearchOpen(false);
    setSearchText("");
    setSearchHits(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !open) return;
    const found = sessions.get(sessionId);
    if (!found) return;
    const sub = found.search.onDidChangeResults((r) =>
      setSearchHits(r.resultCount >= 0 ? { index: r.resultIndex, count: r.resultCount } : null),
    );
    return () => sub.dispose();
  }, [sessionId, open]);

  useEffect(() => {
    if (searchOpen) searchField.current?.focus();
  }, [searchOpen]);

  // The first tab is always drawn, so a repository whose only shell was
  // closed still shows where a new one goes; the rest are whatever sessions
  // exist plus the one being opened, which is not in the map until its effect
  // runs.
  const tabs = repoPath
    ? sessionsOf(repoPath, new Set([repoPath, ...sessions.keys(), ...(sessionId ? [sessionId] : [])]))
    : [];

  function runSearch(text: string, backwards = false, incremental = false) {
    if (!session) return;
    if (!text) {
      session.search.clearDecorations();
      setSearchHits(null);
      return;
    }
    const options = { incremental, decorations: SEARCH_DECORATIONS };
    if (backwards) session.search.findPrevious(text, options);
    else session.search.findNext(text, options);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchText("");
    setSearchHits(null);
    session?.search.clearDecorations();
    session?.term.focus();
  }

  function onSearchKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(searchText, event.shiftKey);
    } else if (event.key === "Escape") {
      // Stops here: the window's Escape would leave the field and nothing
      // else, and the field is what should go.
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    }
  }

  /**
   * Copy, paste, clear, close. The webview's menu used to stand in for the
   * first two, at the price of Print and Share sitting next to them. Copy is
   * the selection, which is why it is off without one; xterm has no idea what
   * a right-click means, so the row is built here rather than asked for.
   */
  function shellMenu(): MenuEntry[] {
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const selection = session?.term.getSelection() ?? "";
    return [
      {
        label: "Copy",
        disabled: selection.length === 0,
        title: selection.length === 0 ? "Select something first" : undefined,
        run: () => {
          copyText(selection).then((ok) => {
            if (!ok) onNote("The clipboard refused the copy.");
            session?.term.clearSelection();
            session?.term.focus();
          });
        },
      },
      {
        label: "Paste",
        run: () => {
          // Through Rust rather than `navigator.clipboard.readText()`, which
          // makes WebView2 put an Edge permission dialog over the window.
          api
            .clipboardText()
            .then((text) => {
              if (text) session?.term.paste(text);
              session?.term.focus();
            })
            .catch((err) => onNote(`The clipboard refused the paste: ${String(err)}`));
        },
      },
      "-",
      {
        label: "Find",
        title: "Ctrl+F. Search the scrollback.",
        run: () => setSearchOpen(true),
      },
      {
        label: "Clear",
        title: "clear",
        run: (typeOnly) => {
          if (!sessionId) return;
          if (typeOnly) api.ptyWrite(sessionId, "clear").catch(() => undefined);
          else sendCommand(sessionId, "clear");
        },
      },
      {
        label: "New shell here",
        title: "Another prompt in the same folder, for when this one is holding a dev server",
        run: () => repoPath && onSelectTab(nextSessionId(repoPath, sessions.keys())),
      },
      {
        label: "Close shell",
        danger: true,
        title: "Ends the session, and whatever is running in it",
        run: () => sessionId && onRequestClose(sessionId),
      },
    ];
  }

  useEffect(() => {
    if (!repoPath || !sessionId || !open || !containerRef.current) return;

    const container = containerRef.current;
    const session = getSession(sessionId);
    session.onSettled = onSettled;

    container.replaceChildren(session.host);

    if (!session.opened) {
      session.term.open(session.host);
      session.opened = true;
    }
    loadRenderer(session);

    session.fit.fit();
    const { cols, rows } = session.term;

    (async () => {
      try {
        // `attached` only says a channel was handed over, so a shell that has
        // since exited still has to be reopened.
        const alive = session.attached ? await api.ptyAlive(sessionId) : false;
        if (!alive) {
          // A fresh terminal gets what the last launch left, before the shell
          // prints its first prompt. A reopened one after a close on purpose
          // has had its file removed, so there is nothing to put back.
          await restoreSession(session);
          await api.ptyOpen(sessionId, repoPath, cols, rows, (chunk) => receive(session, chunk));
          session.attached = true;
        }
        onLiveChange(sessionId, true);
        session.term.focus();
      } catch (err) {
        session.term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
        onLiveChange(sessionId, false);
      }
    })();

    const onData = session.term.onData((data) => {
      api.ptyWrite(sessionId, data).catch(() => undefined);
    });

    const observer = new ResizeObserver(() => {
      try {
        session.fit.fit();
        api.ptyResize(sessionId, session.term.cols, session.term.rows).catch(() => undefined);
      } catch {
        // The pane can be measured mid-transition, where fit throws. Harmless.
      }
    });
    observer.observe(container);

    return () => {
      onData.dispose();
      observer.disconnect();
      // The session stays open on purpose, and so does its output channel:
      // closing here would kill the dev server every time the user looked at
      // another project, and detaching the channel would lose what it printed
      // while they were away. Ending one is a separate, deliberate act; see
      // `closeSession`.
    };
  }, [repoPath, sessionId, open, onSettled, onLiveChange]);

  if (!repoPath || !sessionId) {
    return (
      <div className="terminal-pane">
        <div className="pane-tab-bar">
          <span>terminal</span>
        </div>
        <p className="empty">Pick a repository to open its shell.</p>
      </div>
    );
  }

  // One tab per shell in this folder. The first is "shell" and the rest count
  // up from the highest still open; the `+` opens the next. Drawn in the closed
  // state too, so a second shell stays reachable after the first is ended.
  const tabBar = (
    <>
      {tabs.map((id) => (
        <button
          key={id}
          className={`terminal-tab${id === sessionId ? " on" : ""}`}
          onClick={() => onSelectTab(id)}
          aria-current={id === sessionId ? "true" : undefined}
          title={id}
        >
          {sessionLabel(id)}
        </button>
      ))}
      <button
        className="terminal-tab add"
        onClick={() => onSelectTab(nextSessionId(repoPath, sessions.keys()))}
        title="Another shell in this folder, for when this one is holding a dev server"
        aria-label="Open another shell here"
      >
        +
      </button>
      <span style={{ color: "var(--line-strong)" }}>·</span>
    </>
  );

  if (!open) {
    return (
      // `closed` so a pane sharing the column does not give a third of it to a
      // button. There is no scrollback here to keep in sight.
      <div className="terminal-pane closed">
        <div className="pane-tab-bar">
          {tabBar}
          <span>closed</span>
        </div>
        <div className="empty">
          <p>The shell for this repository is closed.</p>
          <button className="btn" onClick={() => onReopen(sessionId)}>
            Open a shell
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="terminal-pane"
      data-tour="terminal"
      onKeyDownCapture={(event) => {
        // Ctrl+F from the shell, which the key handler above lets through.
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSearchOpen(true);
          if (searchOpen) searchField.current?.select();
        }
      }}
    >
      <div className="pane-tab-bar">
        {tabBar}
        <span className="tab-path">{repoPath}</span>
        {searchOpen && (
          <span className="history-filter terminal-search">
            <input
              ref={searchField}
              value={searchText}
              spellCheck={false}
              placeholder="Find in the scrollback"
              title="Enter for the next match, Shift+Enter for the previous, Escape to close."
              onChange={(e) => {
                setSearchText(e.target.value);
                runSearch(e.target.value, false, true);
              }}
              onKeyDown={onSearchKey}
            />
            <span className="terminal-search-count">
              {searchText ? (searchHits && searchHits.count > 0 ? `${searchHits.index + 1} of ${searchHits.count}` : "none") : ""}
            </span>
            <button
              className="history-filter-clear"
              onClick={closeSearch}
              title="Close the search (Escape)"
              aria-label="Close the search"
            >
              ✕
            </button>
          </span>
        )}
        <button
          className="pane-close"
          onClick={() => onRequestClose(sessionId)}
          title={`Close ${sessionLabel(sessionId)}`}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {children}
      <div
        className="terminal-host"
        ref={containerRef}
        onContextMenu={(event) => menu.open(event, null)}
      />
      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label="Shell"
          entries={shellMenu()}
          onClose={menu.close}
        />
      )}
    </div>
  );
}

/**
 * The width the main column needs for `cols` columns of terminal, measured
 * off a shell that is on screen: xterm sizes its screen to exactly the
 * columns it has, so the cell is the ratio and not an estimate, and what the
 * host takes around the screen (padding and xterm's own scrollbar) is the
 * difference. Null before any shell has been drawn.
 */
export function widthForColumns(cols: number): number | null {
  for (const session of sessions.values()) {
    const screen = session.term.element?.querySelector<HTMLElement>(".xterm-screen");
    const host = session.host.parentElement;
    if (screen && host && screen.clientWidth > 0 && session.term.cols > 0) {
      const cell = screen.clientWidth / session.term.cols;
      return Math.ceil(cols * cell + (host.clientWidth - screen.clientWidth));
    }
  }
  return null;
}

/** Every session id a repository has, first to last. */
export function sessionsFor(repoPath: string): string[] {
  return sessionsOf(repoPath, sessions.keys());
}

/** Puts the cursor in a shell, when it exists. */
export function focusSession(repoPath: string): boolean {
  const session = sessions.get(repoPath);
  if (!session) return false;
  session.term.focus();
  return true;
}

/** Types a command at the prompt of a repository's shell. */
export async function sendCommand(repoPath: string, command: string) {
  await api.ptyWrite(repoPath, `${command}\r`);
  sessions.get(repoPath)?.term.focus();
}

/**
 * Ends a session for good: the shell exits, the scrollback goes, and the module
 * map forgets it so the next open builds a fresh terminal.
 *
 * `pty_close` has existed since the terminal was written and nothing called it,
 * which is how clicking through the fleet once ended with eight PowerShell
 * processes and no control anywhere that brought the count down.
 */
export async function closeSession(repoPath: string) {
  await api.ptyClose(repoPath).catch(() => undefined);
  // Ended for good: the scrollback goes, and so does the copy on disk.
  api.scrollbackRemove(repoPath).catch(() => undefined);
  const session = sessions.get(repoPath);
  if (!session) return;
  window.clearTimeout(session.settleTimer);
  window.clearTimeout(session.saveTimer);
  session.attached = false;
  // The scrollback is going, and the blocks are a view of it.
  session.blocks = [];
  session.running = null;
  session.snapshot = [];
  for (const listener of session.listeners) listener(session.snapshot);
  session.term.dispose();
  session.host.remove();
  sessions.delete(repoPath);
}
