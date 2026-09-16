import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "../lib/api";
import {
  DEFAULTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  updateSettings,
  useSettings,
} from "../lib/settings";
import type { AppInfo } from "../lib/types";

export type SettingsSection = "folders" | "terminal" | "launch" | "about";

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
  { id: "terminal", label: "Terminal" },
  { id: "launch", label: "Launch" },
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
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="confirm settings" role="dialog" aria-modal="true" aria-label="Settings">
        <h2>
          Settings
          <button className="pane-close" onClick={onClose} title="Close (Escape)" aria-label="Close">
            ✕
          </button>
        </h2>
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
            {section === "terminal" && <TerminalSection />}
            {section === "launch" && <LaunchSection gh={info?.gh.version != null} />}
            {section === "about" && <About info={info} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

/** A switch with its name and the one sentence that says what it costs. */
function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={`setting-row${disabled ? " disabled" : ""}`}>
      <span className="setting-text">
        <span className="setting-label">{label}</span>
        <span className="setting-hint">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
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

// --------------------------------------------------------------- terminal

function TerminalSection() {
  const { terminal } = useSettings();
  // The field holds text while it is being edited, so a size typed one digit
  // at a time never lands on the terminal as "1" on the way to "14".
  const [typed, setTyped] = useState(String(terminal.fontSize));
  useEffect(() => setTyped(String(terminal.fontSize)), [terminal.fontSize]);

  function commitSize() {
    const size = Number(typed);
    if (!Number.isFinite(size)) {
      setTyped(String(terminal.fontSize));
      return;
    }
    const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
    updateSettings("terminal", { fontSize: clamped });
    setTyped(String(clamped));
  }

  return (
    <>
      <h3>Terminal</h3>
      <div className="setting-row">
        <span className="setting-text">
          <span className="setting-label">Type size</span>
          <span className="setting-hint">
            {FONT_SIZE_MIN} to {FONT_SIZE_MAX} points. Every open shell refits as it changes.
          </span>
        </span>
        <span className="setting-number">
          <input
            type="number"
            inputMode="decimal"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={0.5}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSize();
            }}
            aria-label="Type size in points"
          />
          {terminal.fontSize !== DEFAULTS.terminal.fontSize && (
            <button
              className="btn tiny"
              onClick={() => updateSettings("terminal", { fontSize: DEFAULTS.terminal.fontSize })}
              title={`Back to ${DEFAULTS.terminal.fontSize}`}
            >
              Reset
            </button>
          )}
        </span>
      </div>
      <Toggle
        label="Screen reader mode"
        hint="A live region a reader can follow, in every shell. The renderer pays for it on every line a build prints, so it stays off until asked for."
        checked={terminal.screenReader}
        onChange={(on) => updateSettings("terminal", { screenReader: on })}
      />
    </>
  );
}

// ----------------------------------------------------------------- launch

function LaunchSection({ gh }: { gh: boolean }) {
  const { launch } = useSettings();
  return (
    <>
      <h3>Launch</h3>
      <Toggle
        label="Fetch every repository"
        hint="git fetch across the fleet when the window opens and the last fetch is more than ten minutes old. Fetch and never pull: nothing in a working tree moves without a click."
        checked={launch.fetch}
        onChange={(on) => updateSettings("launch", { fetch: on })}
      />
      <Toggle
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
