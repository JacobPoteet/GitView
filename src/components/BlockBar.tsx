import { useEffect, useMemo, useState } from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import { blockOutput } from "./TerminalPane";
import { blockDuration, portsIn, type CommandBlock } from "../lib/types";

interface Props {
  blocks: CommandBlock[];
  onRun: (command: string, typeOnly?: boolean) => void;
  onSave: (block: CommandBlock) => void;
  /** The block as a whole: command, exit code and output, for Claude. */
  onCopy: (block: CommandBlock) => void;
  /** Just text, and the status line says what. */
  onCopyText: (text: string, what: string) => void;
  onReveal: (block: CommandBlock) => void;
  /** The command a port chip types, so the chip can name it like every other
   *  control in the app does. */
  portCommand: (port: number) => string;
  onPort: (port: number) => void;
}

/**
 * The last thing that ran in this repository's shell, and what can be done with
 * it.
 *
 * Everything here was already on screen a moment ago. What the strip adds is
 * that the app now knows which lines belonged to which command and how it ended,
 * so a command can be promoted to a task, handed to Claude, or found again
 * without scrolling for it.
 */
export default function BlockBar({
  blocks,
  onRun,
  onSave,
  onCopy,
  onCopyText,
  onReveal,
  portCommand,
  onPort,
}: Props) {
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  const running = last != null && last.exitCode === null;
  const menu = useContextMenu<CommandBlock>();

  // A running block's clock is the only thing on this row that moves on its own.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running, last?.id]);

  const ports = useMemo(() => {
    if (!last || !running) return [];
    return portsIn(blockOutput(last.repoPath, last.id));
    // The strip redraws when a block changes or the output settles, which is
    // when a dev server has finished announcing itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, last?.id, running]);

  const failure = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (block.exitCode !== null && block.exitCode !== 0) return block;
    }
    return null;
  }, [blocks]);

  if (!last) return null;

  const state = running ? "running" : last.exitCode === 0 ? "ok" : "failed";

  // The bar's buttons, plus the two the bar has no room for: typing the command
  // to edit before it runs, and copying the command alone.
  function barMenu(block: CommandBlock): MenuEntry[] {
    const live = block.exitCode === null;
    return [
      {
        label: "Run again",
        title: live ? "It is still running" : block.command,
        disabled: live,
        run: (typeOnly) => onRun(block.command, typeOnly),
      },
      { label: "Scroll back to it", run: () => onReveal(block) },
      "-",
      { label: "Save as task", run: () => onSave(block) },
      { label: "Copy command", title: block.command, run: () => onCopyText(block.command, "the command") },
      {
        label: "Copy for Claude",
        title: "The command, its exit code and its output",
        run: () => onCopy(block),
      },
    ];
  }

  return (
    <div className={`block-bar ${state}`} onContextMenu={(event) => menu.open(event, last)}>
      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.command}`}
          entries={barMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
      <button
        className="block-status"
        onClick={() => onReveal(last)}
        title="Scroll back to this command"
      >
        {running ? "running" : last.exitCode === 0 ? "✓" : `exit ${last.exitCode}`}
      </button>

      <span className="block-command" title={last.command}>
        {last.command}
      </span>
      {/* A block read back from a saved scrollback is a record, not something
          that just finished, and the bar says so in place of Run again. */}
      {last.restored ? (
        <span className="block-time" title="Read back from the last time this shell was open">
          previous session
        </span>
      ) : (
        <span className="block-time">{blockDuration(last)}</span>
      )}

      {ports.length > 0 && (
        <span className="block-ports">
          {ports.map((port) => (
            <button
              key={port}
              className="port-chip"
              onClick={() => onPort(port)}
              title={portCommand(port)}
            >
              :{port}
            </button>
          ))}
        </span>
      )}

      <span className="spacer" />

      {failure && failure.id !== last.id && (
        <button
          className="block-action warn"
          onClick={() => onReveal(failure)}
          title={`${failure.command} — exit ${failure.exitCode}`}
        >
          Last failure
        </button>
      )}
      {!last.restored && (
        <button
          className="block-action"
          disabled={running}
          onClick={() => onRun(last.command)}
          title={running ? "It is still running" : last.command}
        >
          Run again
        </button>
      )}
      <button className="block-action" onClick={() => onSave(last)} title="Keep this as a task">
        Save as task
      </button>
      <button
        className="block-action"
        onClick={() => onCopy(last)}
        title="Copy the command, its exit code and its output"
      >
        Copy for Claude
      </button>
    </div>
  );
}
