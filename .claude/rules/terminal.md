---
paths:
  - "src/components/TerminalPane.tsx"
  - "src/components/BlockBar.tsx"
  - "src/lib/sessions.ts"
  - "src/lib/agent.ts"
  - "src/lib/shell.ts"
  - "src-tauri/src/pty.rs"
  - "src-tauri/src/scrollback.rs"
  - "src-tauri/src/agent.rs"
  - "src-tauri/src/shell_integration.ps1"
  - "src-tauri/src/lib.rs"
---

# Terminal and sessions

Loaded when Claude touches the terminal, its sessions, or the shell integration.

| Rule | Why |
| --- | --- |
| A terminal session is never closed on a view change | Closing it would kill a dev server every time the user looked at another project |
| The window's close is a request Rust holds | `on_window_event` prevents the close and emits `closing`; the frontend writes every shell's scrollback and calls `app_quit`. Closing outright would end the buffers before the write began. The hold is bounded at three seconds in `saveAllSessions`, so a save that hangs cannot keep the app open |
| A command aimed at a repository waits for its session, never for a timer | `sendCommand` writes to the PTY directly, so a command sent while the shell is still starting is lost with an unhandled rejection. Select the repository, then send when `live` reports it |
| A command aimed at a repository goes to a shell at its prompt | A shell running `claude`, another CLI or a dev server reads typed text as its own input, so `gh pr merge` became a message to Claude. `pickShell` in `lib/sessions.ts` takes the tab on screen if it is free, then the first free shell, then a new one; busy means an OSC 133 block is still running, from `isBusy`, with no list of tool names. `emit` and every `pendingCommand` go through it. The Claude tab never qualifies. It stays asleep until clicked, and is not an agent panel: it types `claude` at a prompt and GitView adds no UI around it |
| The prompt hook wraps the user's prompt and touches nothing on disk | Overwriting `prompt` discards Starship and oh-my-posh. The script is handed over as `-EncodedCommand` after the profile has loaded, so it captures whatever is there. Never write to a profile without asking |
| Claude integration is opt-in in the AI settings; GitView never writes to `~/.claude`, and its hooks go in through `--settings` on the command it types | Hooks are how Orca learns working, waiting and done, and Orca puts them in the user's own Claude settings. A per-run file keeps them inside GitView's tab. Without the switch, or in a shell where `claude` is typed by hand, the reading falls back to what Claude prints: the OSC 0 title says working (`◐`, `◑`) or idle (`✳`), and a question's `Esc to cancel` footer at the bottom of the screen separates waiting from done. `lib/agent.ts` holds the reading; `readAgent` in `TerminalPane.tsx` feeds it. The wiki's Terminal note has the titles as measured |
| A terminal line number is checked against the command text before it is used | ConPTY repaints on resize and can duplicate a line, and `cls` rewrites lines in place, so a marker stops describing what it was taken from. `anchor` in `TerminalPane.tsx` is the only way to turn a block into a line |
| The output channel belongs to the session, not to a React effect | An effect-owned callback drops everything a shell prints while its pane is off screen, which is most of what a dev server prints. Sessions outlive views, and so does their output |
## Verifying a terminal change

A dev build exposes `window.__gitview.sessions`, which is the only way to read a session's blocks,
its markers and its buffer. The WebGL renderer draws to a canvas, so there is no terminal text in
the DOM to scrape. Vite drops the handle from a production bundle.

Restart the app rather than trusting Vite's hot update when the change touches the terminal.
`TerminalPane` holds its sessions in module state, so a hot update leaves the existing `Terminal`
object in place without any new handler attached.
