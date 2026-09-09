import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api } from "../lib/api";

/**
 * Sessions live in this module rather than in component state, so switching to
 * another repository and back keeps the shell, the scrollback and any dev server
 * running. The host element is retained too: xterm's buffer lives in that DOM,
 * so the pane detaches and reattaches it instead of rebuilding a terminal.
 */
interface Session {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
}

const sessions = new Map<string, Session>();

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

function getSession(id: string): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const term = new Terminal({
    fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, ui-monospace, monospace',
    fontSize: 12.5,
    lineHeight: 1.35,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 20000,
    theme: THEME,
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const host = document.createElement("div");
  host.style.height = "100%";

  const session: Session = { term, fit, host, opened: false };
  sessions.set(id, session);
  return session;
}

interface Props {
  repoPath: string | null;
  /** Fires once output has been quiet for a beat, which is when a hand-typed
   *  commit is worth picking up in the sidebar. */
  onSettled: (repoPath: string) => void;
  onLiveChange: (repoPath: string, live: boolean) => void;
}

export default function TerminalPane({ repoPath, onSettled, onLiveChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!repoPath || !containerRef.current) return;

    const container = containerRef.current;
    const session = getSession(repoPath);

    container.replaceChildren(session.host);

    if (!session.opened) {
      session.term.open(session.host);
      // WebGL keeps a chatty build readable. The DOM renderer falls behind on
      // that kind of output, so failing over is a downgrade worth logging.
      try {
        session.term.loadAddon(new WebglAddon());
      } catch {
        console.warn("WebGL renderer unavailable, using the default renderer");
      }
      session.opened = true;
    }

    session.fit.fit();
    const { cols, rows } = session.term;

    let disposed = false;

    api
      .ptyOpen(repoPath, repoPath, cols, rows, (chunk) => {
        if (disposed) return;
        session.term.write(chunk);
        window.clearTimeout(settleTimer.current);
        settleTimer.current = window.setTimeout(() => onSettled(repoPath), 900);
      })
      .then(() => {
        onLiveChange(repoPath, true);
        session.term.focus();
      })
      .catch((err) => {
        session.term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
        onLiveChange(repoPath, false);
      });

    const onData = session.term.onData((data) => {
      api.ptyWrite(repoPath, data).catch(() => undefined);
    });

    const observer = new ResizeObserver(() => {
      try {
        session.fit.fit();
        api.ptyResize(repoPath, session.term.cols, session.term.rows).catch(() => undefined);
      } catch {
        // The pane can be measured mid-transition, where fit throws. Harmless.
      }
    });
    observer.observe(container);

    return () => {
      disposed = true;
      onData.dispose();
      observer.disconnect();
      window.clearTimeout(settleTimer.current);
      // The session stays open on purpose. Closing here would kill the dev
      // server every time the user looked at another project.
    };
  }, [repoPath, onSettled, onLiveChange]);

  if (!repoPath) {
    return (
      <div className="terminal-pane">
        <div className="pane-tab-bar">terminal</div>
        <p className="empty">Pick a repository to open its shell.</p>
      </div>
    );
  }

  return (
    <div className="terminal-pane">
      <div className="pane-tab-bar">
        <span>shell</span>
        <span style={{ color: "var(--line-strong)" }}>·</span>
        <span>{repoPath}</span>
      </div>
      <div className="terminal-host" ref={containerRef} />
    </div>
  );
}

/** Types a command at the prompt of a repository's shell. */
export async function sendCommand(repoPath: string, command: string) {
  await api.ptyWrite(repoPath, `${command}\r`);
  sessions.get(repoPath)?.term.focus();
}
