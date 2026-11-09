---
paths:
  - "src-tauri/src/cache.rs"
  - "src-tauri/src/settings.rs"
  - "src-tauri/src/fleet.rs"
  - "src/lib/settings.ts"
  - "src/lib/types.ts"
  - "src/lib/palette.ts"
  - "src/components/SettingsDialog.tsx"
  - "src/components/CommandPalette.tsx"
---

# Settings, preferences and the database

Loaded when Claude touches settings, the SQLite cache, or what the palette lists.

| Rule | Why |
| --- | --- |
| A setting about the app lives in `lib/settings.ts`, and a setting about a repository lives in SQLite | The terminal's type size and the launch checks are choices about this window and this install, read synchronously before the first terminal opens, so they sit in one `localStorage` object merged over its defaults. Pins, hides and the watched folders are read from Rust or belong to a repository, so they stay in the database. The settings dialog is the one home for the first kind: a switch added anywhere else is a switch nobody finds |
| A preference is never stored in `RepoState` | That struct is scanner output, cached as a blob and rewritten every sweep. Pins and hides live in `repo_pref` and `task_pref`, and the frontend merges them |
| A schema change reaches an installed database by `ALTER TABLE` | The one on this machine holds pins and saved tasks somebody set. `add_column_if_missing` checks `PRAGMA table_info` rather than catching an error whose message would also cover a real failure, and a new column that replaces an old sort key is backfilled from it so the upgrade changes nothing on screen |
| Hiding something removes it from the palette | Demoting it still leaves it in the way, and the palette is where a project's thirty npm scripts do the most damage |
| A preference is keyed on the path, and follows a rename by `owner/repo` | Keying on the identity outright strands every repository with no remote. `repo_identity` records what was at a path so a move can be recognised afterwards, guarded so two clones of one project cannot fight over a set of pins |
