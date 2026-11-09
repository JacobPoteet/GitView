---
paths:
  - "src/App.tsx"
  - "src/components/**"
  - "src/styles.css"
  - "src/theme-*.css"
  - "src/lib/themes.ts"
  - "src/lib/keys.ts"
  - "src/lib/clipboard.ts"
---

# Interface

Loaded when Claude touches components, styles, themes, chords or the clipboard.

| Rule | Why |
| --- | --- |
| A pane that wants a fourth column shares the main one, and never covers the terminal | The grid is full at sidebar + 1fr + changes, 296 and 300 by default and dragged from there. `.main.split` hides `.graph` with `display: none` and clamps `.terminal-pane` to `--shell-pct` (47% by default, dragged on `RowSplitter`, one value for every pane so moving between them resizes nothing), so a pane gets its room from the branch strip rather than from the shell. Never unmount the strip and never let the terminal flex: the first hands its `ResizeObserver` a 0x0 container on the way back, and the second is the 0x0 the old overlay existed to avoid. Whatever a pane types has to be readable while the pane is still open |
| A routine dialog is a list of names and tags, and the sentences are titles | Clean up's first version gave each row four sentences and a path, and the warning that mattered was the sentence that got skipped. A row is one line in the branch menu's words, each tag's title holds the sentence, and a state that can go wrong gets a control that says so rather than a paragraph. Commands fold under a count, since they still land in the shell |
| A font size is one of the six `--fs-` tokens, and the mono face is for what a prompt would accept | Fourteen literal sizes had crept into a 10 to 12.5 px band, and mono on pane titles and the status bar meant it said nothing. A path, a sha, a branch, a ref or a command is mono; a title, a count, a verb or a chord is not. A glyph used as an icon keeps a literal size. No label is uppercase, except under the LCARS theme, which uppercases chrome and leaves anything in the mono face as typed. The wiki's `Interface/Theme.md` has the scale |
| A sticky element is dimmed by colour, never by `opacity` | Opacity applies to the element's own background, so a translucent line-number gutter lets a long line scroll straight through it |
| Everything closes with the X in its top right | One gesture for every pane and every dialog, plus `Escape`, which peels one layer per press: a dialog, the inbox, a commit, the history, a diff, a file. `CloseButton.tsx` draws the X, so a new surface imports it rather than pasting a glyph. A footer button survives only where it is a different act: Cancel abandons a choice, which is not what closing a finished report does |
| A failed pane read uses `PaneNote` with `kind="error"`, and never the empty voice | A diff, commit or history that failed to read looked like one with nothing in it. Error is red, announced, and offers Try again where the pane can re-run the read |
| A right-click opens the surface's own menu, never the webview's | WebView2 offers Back, Reload, Print and Share, and `App.tsx` swallows the event at the document. A surface with something to offer uses `ContextMenu.tsx` and builds its items from actions it already has; there is no "Type without running" item because shift-click on any item already does that. Text fields keep the native menu for cut, copy and paste |
| A chord is added to `lib/keys.ts` and nowhere else | Three places have to agree on it: the terminal releases it rather than handing it to the shell, `App` acts on it, and the settings dialog lists it. `isClaimed` and `SHORTCUTS` both read the one table, and `chordOf` is the only reading of a key event, so a handler that tests `event.key` itself is a chord the terminal will swallow |
| The clipboard is read in Rust, and written from the webview | `navigator.clipboard.readText()` makes WebView2 raise an Edge permission dialog over the window; `clipboard_text` through `arboard` asks nothing. `writeText` never prompts, so `copyText` stays where it is |
| A theme is a registry entry in `lib/themes.ts` plus a block of tokens under `:root[data-theme]` | Colour, radius, blur, shadow and the type scale are tokens, so a theme redefines them rather than touching a selector. What a token cannot say (bevels, a title bar) goes in that theme's own file, scoped to its attribute. The terminal's palette is in the registry because xterm needs hex. The default carries no attribute. A new literal radius or shadow in `styles.css` is a rule every theme has to override, so use `--r-xs`, `--r-sm`, `--r-pill`, `--radius*` and `--shadow-*` |
