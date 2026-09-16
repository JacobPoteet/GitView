import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "../lib/api";
import {
  CHANGES_MAX,
  CHANGES_MIN,
  DEFAULTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  INBOX_READ_COST,
  MINUTES_MAX,
  MINUTES_MIN,
  RATE_LIMIT_PER_HOUR,
  updateSettings,
  useSettings,
} from "../lib/settings";
import type { AppInfo } from "../lib/types";
import { SHORTCUTS } from "../lib/keys";
import Dialog from "./Dialog";

export type SettingsSection =
  | "folders"
  | "layout"
  | "terminal"
  | "launch"
  | "github"
  | "keyboard"
  | "about";

interface Props {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  roots: string[];
  /** The watched folders changed, and the fleet wants a rescan. */
  onRoots: (roots: string[]) => void;
  info: AppInfo | null;
  onClose: () => void;
}

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "folders", label: "Folders" },
  { id: "layout", label: "Layout" },
  { id: "terminal", label: "Terminal" },
  { id: "launch", label: "Launch" },
  { id: "github", label: "GitHub" },
  { id: "keyboard", label: "Keyboard" },
  { id: "about", label: "About" },
];

/**
 * The app's settings, in one dialog with a section list down the left.
 *
 * Everything here applies as it is changed: there is no Save, because a
 * setting that waits for a button is a setting you cannot try. The watched
 * folders were a dialog of their own until 15 Sep 2026 and keep their own
 * section, since the `+` in the sidebar still opens straight onto them.
 */
export default function SettingsDialog({
  section,
  onSection,
  roots,
  onRoots,
  info,
  onClose,
}: Props) {
  return (
    <Dialog label="Settings" className="settings" onClose={onClose}>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              className={entry.id === section ? "on" : ""}
              onClick={() => onSection(entry.id)}
              aria-current={entry.id === section ? "page" : undefined}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="settings-page">
          {section === "folders" && <Folders roots={roots} onChange={onRoots} />}
          {section === "layout" && <LayoutSection />}
          {section === "terminal" && <TerminalSection />}
          {section === "launch" && <LaunchSection gh={info?.gh.version != null} />}
          {section === "github" && <GitHubSection info={info} />}
          {section === "keyboard" && <Keyboard />}
          {section === "about" && <About info={info} />}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- pieces

/** A switch with its name and the one sentence that says what it costs. */
function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  // The row is the label, so a click anywhere on it flips the switch. The
  // text sits one span deep because the lint rule reads no deeper than that,
  // and the grid puts the switch in a column of its own.
  return (
    <label htmlFor={id} className={`setting-row${disabled ? " disabled" : ""}`}>
      <span className="setting-label">{label}</span>
      <span className="setting-hint">{hint}</span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/**
 * A number with its name, its hint, and a Reset that appears once it has
 * moved. The field holds text while it is being edited, so a size typed one
 * digit at a time never lands as "1" on the way to "14"; it commits on Enter
 * or blur, clamped to the range.
 */
function NumberRow({
  label,
  hint,
  value,
  fallback,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  fallback: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [typed, setTyped] = useState(String(value));
  useEffect(() => setTyped(String(value)), [value]);

  function commit() {
    const next = Number(typed);
    if (!Number.isFinite(next)) {
      setTyped(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, next));
    onChange(clamped);
    setTyped(String(clamped));
  }

  return (
    <div className={`setting-row${disabled ? " disabled" : ""}`}>
      <span className="setting-label">{label}</span>
      <span className="setting-hint">{hint}</span>
      <span className="setting-number">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={typed}
          disabled={disabled}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          aria-label={label}
        />
        {value !== fallback && !disabled && (
          <button
            className="btn tiny"
            onClick={() => onChange(fallback)}
            title={`Back to ${fallback}`}
          >
            Reset
          </button>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- folders

/**
 * The watched folders.
 *
 * One verb covers both cases people mean by "open a repository". A folder full
 * of checkouts becomes a scan root, and a single project becomes a scan root
 * that happens to hold exactly one repository, because `fleet::discover` already
 * counts a root that is itself a repository.
 */
function Folders({ roots, onChange }: { roots: string[]; onChange: (roots: string[]) => void }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.settingsAddRoot(trimmed));
      setTyped("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    // The picker is the only reason this app asks for a Tauri plugin. Typing a
    // path works too, and is often faster for someone who lives in a shell.
    const picked = await open({ directory: true, multiple: false, title: "Watch a folder" });
    if (typeof picked === "string") await add(picked);
  }

  async function remove(path: string) {
    setBusy(true);
    try {
      onChange(await api.settingsRemoveRoot(path));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Watched folders</h3>
      <p>
        Every folder here is scanned one level deep. Add the folder your projects sit in, or a
        single project when it lives somewhere else.
      </p>

      <ul className="root-list">
        {roots.length === 0 && <li className="empty">Nothing watched yet.</li>}
        {roots.map((root) => (
          <li key={root}>
            <span title={root}>{root}</span>
            <button className="row-action" onClick={() => remove(root)} title="Stop watching">
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="root-add">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add(typed);
          }}
          placeholder="F:\Work"
          spellCheck={false}
        />
        <button className="btn" disabled={busy || !typed.trim()} onClick={() => add(typed)}>
          Add
        </button>
        <button className="btn accent" onClick={browse} disabled={busy}>
          Browse…
        </button>
      </div>

      {error && <p className="root-error">{error}</p>}
    </>
  );
}

// ----------------------------------------------------------------- layout

/**
 * The two column widths. The handles on the column edges are the usual way
 * to set them; the numbers are here so the dialog shows every setting the
 * app keeps and so a width can be typed or put back without finding the
 * edge.
 */
function LayoutSection() {
  const { layout } = useSettings();
  return (
    <>
      <h3>Layout</h3>
      <NumberRow
        label="Sidebar width"
        hint={`${SIDEBAR_MIN} to ${SIDEBAR_MAX} pixels. Drag the edge beside the repositories, or double-click it for the default.`}
        value={layout.sidebar}
        fallback={DEFAULTS.layout.sidebar}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        step={1}
        onChange={(sidebar) => updateSettings("layout", { sidebar })}
      />
      <NumberRow
        label="Changes column width"
        hint={`${CHANGES_MIN} to ${CHANGES_MAX} pixels. Drag the edge beside the working tree, or double-click it for the default.`}
        value={layout.changes}
        fallback={DEFAULTS.layout.changes}
        min={CHANGES_MIN}
        max={CHANGES_MAX}
        step={1}
        onChange={(changes) => updateSettings("layout", { changes })}
      />
      <p>The middle column takes what is left, and never less than the terminal needs for 80 columns.</p>
    </>
  );
}

// --------------------------------------------------------------- terminal

function TerminalSection() {
  const { terminal } = useSettings();
  // What the saved scrollback takes on disk, read once when the section opens.
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    api.scrollbackSize().then(setSize, () => setSize(0));
  }, []);
  return (
    <>
      <h3>Terminal</h3>
      <NumberRow
        label="Type size"
        hint={`${FONT_SIZE_MIN} to ${FONT_SIZE_MAX} points. Every open shell refits as it changes.`}
        value={terminal.fontSize}
        fallback={DEFAULTS.terminal.fontSize}
        min={FONT_SIZE_MIN}
        max={FONT_SIZE_MAX}
        step={0.5}
        onChange={(fontSize) => updateSettings("terminal", { fontSize })}
      />
      <Toggle
        id="setting-screen-reader"
        label="Screen reader mode"
        hint="A live region a reader can follow, in every shell. The renderer pays for it on every line a build prints, so it stays off until asked for."
        checked={terminal.screenReader}
        onChange={(on) => updateSettings("terminal", { screenReader: on })}
      />
      <Toggle
        id="setting-restore-scrollback"
        label="Keep the scrollback across restarts"
        hint="Each shell's buffer is written out as it settles and on close, and read back above the first prompt of the next launch. Off, nothing is written and what is saved stays until cleared."
        checked={terminal.restoreScrollback}
        onChange={(on) => updateSettings("terminal", { restoreScrollback: on })}
      />
      <div className="setting-row">
        <span className="setting-label">Saved scrollback</span>
        <span className="setting-hint">
          {size === null ? "…" : size === 0 ? "Nothing saved." : `${formatBytes(size)}, one file per shell, under the data folder.`}
        </span>
        <span className="setting-number">
          <button
            className="btn tiny"
            disabled={!size}
            onClick={async () => {
              await api.scrollbackClear().catch(() => undefined);
              setSize(await api.scrollbackSize().catch(() => 0));
            }}
            title="Remove every saved scrollback. The open shells keep theirs until they next save."
          >
            Clear
          </button>
        </span>
      </div>
    </>
  );
}

/** "12.4 KB", "3.1 MB": the size the row states. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

// ----------------------------------------------------------------- launch

function LaunchSection({ gh }: { gh: boolean }) {
  const { launch } = useSettings();
  return (
    <>
      <h3>Launch</h3>
      <Toggle
        id="setting-launch-fetch"
        label="Fetch every repository"
        hint="git fetch across the fleet when the window opens and the last fetch is more than ten minutes old. Fetch and never pull: nothing in a working tree moves without a click."
        checked={launch.fetch}
        onChange={(on) => updateSettings("launch", { fetch: on })}
      />
      <Toggle
        id="setting-launch-update"
        label="Check for a new GitView"
        hint={
          gh
            ? "Ask GitHub for the latest release through gh. A newer one is a word in the status bar and nothing else; the palette can still ask on demand."
            : "Needs gh, which this machine does not have."
        }
        checked={launch.checkUpdate}
        disabled={!gh}
        onChange={(on) => updateSettings("launch", { checkUpdate: on })}
      />
    </>
  );
}

// ----------------------------------------------------------------- github

/** "6 reads an hour, 48 of 5000 points", for an interval in minutes. */
function costOf(minutes: number): string {
  const reads = 60 / minutes;
  const shown = reads >= 1 ? Math.round(reads) : reads.toFixed(2).replace(/0+$/, "");
  const points = Math.round(reads * INBOX_READ_COST);
  return `${shown} ${reads === 1 ? "read" : "reads"} an hour, ${points} of ${RATE_LIMIT_PER_HOUR} points`;
}

/**
 * The inbox's timers, each with what it costs beside it.
 *
 * The rate limit is 5000 points an hour and a read of the fleet measured cost
 * 8, so the numbers here are affordable by a wide margin; they are shown so
 * the trade is visible where it is made, and so a laptop on a metered
 * connection can turn the timer off without losing the button.
 */
function GitHubSection({ info }: { info: AppInfo | null }) {
  const { github } = useSettings();
  const gh = info?.gh.version != null && info.gh.loggedIn;
  const why = !info?.gh.version
    ? "Needs gh, which this machine does not have."
    : !info.gh.loggedIn
      ? "gh is not logged in, so the inbox has nothing to read."
      : null;
  return (
    <>
      <h3>GitHub</h3>
      <Toggle
        id="setting-github-poll"
        label="Read the inbox on a timer"
        hint={
          why ??
          "One GraphQL query for the whole fleet, out of sight. Off, the inbox reads at launch, after a command, and when the refresh button asks."
        }
        checked={github.poll}
        disabled={!gh}
        onChange={(on) => updateSettings("github", { poll: on })}
      />
      <NumberRow
        label="Minutes between reads"
        hint={`While nothing is running: ${costOf(github.idleMinutes)}.`}
        value={github.idleMinutes}
        fallback={DEFAULTS.github.idleMinutes}
        min={MINUTES_MIN}
        max={MINUTES_MAX}
        step={1}
        disabled={!gh || !github.poll}
        onChange={(idleMinutes) => updateSettings("github", { idleMinutes })}
      />
      <NumberRow
        label="Minutes between reads while checks run"
        hint={`While a pull request that moved in the last hour has checks running: ${costOf(github.busyMinutes)}.`}
        value={github.busyMinutes}
        fallback={DEFAULTS.github.busyMinutes}
        min={MINUTES_MIN}
        max={MINUTES_MAX}
        step={1}
        disabled={!gh || !github.poll}
        onChange={(busyMinutes) => updateSettings("github", { busyMinutes })}
      />
      <NumberRow
        label="Read at launch when older than"
        hint="Minutes. The cached inbox shows straight away either way; this is when it is read again behind it."
        value={github.launchStaleMinutes}
        fallback={DEFAULTS.github.launchStaleMinutes}
        min={MINUTES_MIN}
        max={MINUTES_MAX}
        step={1}
        disabled={!gh}
        onChange={(launchStaleMinutes) => updateSettings("github", { launchStaleMinutes })}
      />
    </>
  );
}

// --------------------------------------------------------------- keyboard

/** The chords, read-only. Rebinding is not a thing here yet. */
function Keyboard() {
  return (
    <>
      <h3>Keyboard</h3>
      <dl className="about-list keys-list">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.chord}>
            <dt>
              <kbd>{shortcut.chord}</kbd>
            </dt>
            <dd>{shortcut.does}</dd>
          </div>
        ))}
      </dl>
      <p>
        Each chord is released by the terminal rather than sent to the shell, so it works with the
        cursor at a prompt. The palette shows the chord beside anything that has one.
      </p>
    </>
  );
}

// ------------------------------------------------------------------ about

function About({ info }: { info: AppInfo | null }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(null));
  }, []);
  const rows: [string, string][] = [
    ["GitView", version ?? "…"],
    ["git", info?.gitVersion ?? "not found"],
    [
      "gh",
      info?.gh.version
        ? `${info.gh.version}${info.gh.loggedIn ? "" : ", not logged in"}`
        : "not found",
    ],
    ["Shell", info?.shell ?? "…"],
    ["Data folder", info?.dataDir ?? "…"],
  ];
  return (
    <>
      <h3>About</h3>
      <dl className="about-list">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        Repository reads go through libgit2. Anything that touches a remote runs git, and anything
        on GitHub runs gh, so their credentials are the ones in use.
      </p>
    </>
  );
}
