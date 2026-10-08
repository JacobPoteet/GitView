import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "../lib/api";
import {
  CHANGES_MAX,
  CHANGES_MIN,
  CURSOR_STYLES,
  DEFAULTS,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  TERMINAL_FACES,
  type CursorStyle,
  type Settings,
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
import type { AppInfo, ResolvedShell } from "../lib/types";
import { SHORTCUTS } from "../lib/keys";
import { openUrlCommand, type ShellKind } from "../lib/shell";
import { THEMES } from "../lib/themes";
import Dialog from "./Dialog";

export type SettingsSection =
  | "folders"
  | "appearance"
  | "layout"
  | "terminal"
  | "general"
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
  shell: ShellKind;
  /** A link in About types the command that opens it, like every other action. */
  onCommand: (command: string, typeOnly: boolean) => void;
  /** Starts the first-run tour again from its first step. */
  onReplayTour: () => void;
  onClose: () => void;
}

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "folders", label: "Folders" },
  { id: "appearance", label: "Appearance" },
  { id: "layout", label: "Layout" },
  { id: "terminal", label: "Terminal" },
  { id: "general", label: "General" },
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
  shell,
  onCommand,
  onReplayTour,
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
          {section === "appearance" && <AppearanceSection />}
          {section === "layout" && <LayoutSection />}
          {section === "terminal" && <TerminalSection />}
          {section === "general" && (
            <GeneralSection gh={info?.gh.version != null} claude={info?.claude ?? null} />
          )}
          {section === "github" && <GitHubSection info={info} />}
          {section === "keyboard" && <Keyboard />}
          {section === "about" && (
            <About info={info} shell={shell} onCommand={onCommand} onReplayTour={onReplayTour} />
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- pieces

/** A switch with its name, and a hint only when there is something to warn about. */
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
  hint?: string;
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
      {hint && <span className="setting-hint">{hint}</span>}
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
  unit,
  value,
  fallback,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  unit?: string;
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
      {hint && <span className="setting-hint">{hint}</span>}
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
        {unit && <span className="setting-unit">{unit}</span>}
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

interface PickOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const CUSTOM = "\u0000custom";

/**
 * A dropdown of named choices ending in Custom, which opens a field for a value
 * of your own. A value that is not one of the choices is a custom one, so a path
 * or a font typed on another install still shows as what it is. `problem` is the
 * only line of explanation: a row says nothing until something is wrong.
 */
function PickRow({
  label,
  value,
  options,
  customPlaceholder,
  problem,
  onChange,
}: {
  label: string;
  value: string;
  options: PickOption[];
  /** Offers a Custom choice with this placeholder; without it the list is closed. */
  customPlaceholder?: string;
  problem?: string;
  onChange: (value: string) => void;
}) {
  const named = options.some((option) => option.value === value);
  const [asked, setAsked] = useState(false);
  const custom = customPlaceholder !== undefined && (!named || asked);
  const [typed, setTyped] = useState(named ? "" : value);
  useEffect(() => setTyped(named ? "" : value), [value, named]);
  const commit = () => {
    const next = typed.trim();
    if (next && next !== value) onChange(next);
  };
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      {problem && (
        <span className="setting-hint bad" role="status">
          {problem}
        </span>
      )}
      <span className="setting-number">
        <select
          value={custom ? CUSTOM : value}
          aria-label={label}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setAsked(true);
              return;
            }
            setAsked(false);
            onChange(e.target.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
          {customPlaceholder !== undefined && <option value={CUSTOM}>Custom…</option>}
        </select>
        {custom && (
          <input
            type="text"
            className="wide"
            value={typed}
            placeholder={customPlaceholder}
            spellCheck={false}
            autoFocus={asked}
            aria-label={`${label}, custom`}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
        )}
      </span>
    </div>
  );
}

/**
 * Puts every setting a section owns back to its default. A switch has no Reset
 * of its own, since a row that is a label cannot hold a button, so this is the
 * way back for them, and for the rest in one click.
 */
function ResetSection<K extends "terminal" | "launch">({
  category,
  keys,
}: {
  category: K;
  keys: (keyof Settings[K])[];
}) {
  const current = useSettings()[category];
  const moved = keys.some((key) => current[key] !== DEFAULTS[category][key]);
  return (
    <p className="about-links">
      <button
        type="button"
        className="link-btn"
        disabled={!moved}
        onClick={() => {
          const patch: Partial<Settings[K]> = {};
          for (const key of keys) patch[key] = DEFAULTS[category][key];
          updateSettings(category, patch);
        }}
      >
        Reset this section to its defaults
      </button>
    </p>
  );
}

/**
 * Whether a typeface is installed, by measuring: a string drawn in the named
 * face and a generic fallback is a different width from the fallback alone only
 * if the name resolved. `document.fonts.check` answers true for a name it has
 * never heard of, so it cannot be asked.
 */
function fontInstalled(family: string): boolean {
  const first = family.split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (!first) return true;
  const canvas = document.createElement("canvas").getContext("2d");
  if (!canvas) return true;
  const sample = "mmmmmmmmmmlli1 WwO0@";
  const width = (stack: string) => {
    canvas.font = `64px ${stack}`;
    return canvas.measureText(sample).width;
  };
  return (
    width(`"${first}", monospace`) !== width("monospace") ||
    width(`"${first}", serif`) !== width("serif")
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
      <h3>Folders</h3>
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

function LayoutSection() {
  const { layout } = useSettings();
  return (
    <>
      <h3>Layout</h3>
      <NumberRow
        label="Sidebar width"
        unit="px"
        value={layout.sidebar}
        fallback={DEFAULTS.layout.sidebar}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        step={1}
        onChange={(sidebar) => updateSettings("layout", { sidebar })}
      />
      <NumberRow
        label="Changes width"
        unit="px"
        value={layout.changes}
        fallback={DEFAULTS.layout.changes}
        min={CHANGES_MIN}
        max={CHANGES_MAX}
        step={1}
        onChange={(changes) => updateSettings("layout", { changes })}
      />
    </>
  );
}

// --------------------------------------------------------------- terminal

/** The shells worth naming. Anything else is a path under Custom. */
const SHELLS = [
  { value: "", label: "Automatic" },
  { value: "pwsh", label: "PowerShell 7" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Command Prompt" },
];

/** Which of the named shells this machine has, asked once when the section opens. */
function useInstalledShells(): Record<string, boolean> {
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      SHELLS.filter((s) => s.value).map((s) =>
        api.shellResolve(s.value).then(
          (r) => [s.value, r.found] as const,
          () => [s.value, false] as const,
        ),
      ),
    ).then((pairs) => {
      if (!cancelled) setInstalled(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return installed;
}

function TerminalSection() {
  const { terminal } = useSettings();
  // What the saved scrollback takes on disk, read once when the section opens.
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    api.scrollbackSize().then(setSize, () => setSize(0));
  }, []);
  const installed = useInstalledShells();
  const resolved = useResolvedShell(terminal.shell);
  const fontMissing =
    !TERMINAL_FACES.includes(terminal.fontFamily) && !fontInstalled(terminal.fontFamily);
  const shellProblem =
    resolved && !resolved.found
      ? `Not found. New shells use ${resolved.path}.`
      : resolved && !resolved.integration
        ? "This shell has no command blocks."
        : undefined;
  return (
    <>
      <h3>Terminal</h3>
      <PickRow
        label="Shell"
        value={terminal.shell}
        options={SHELLS.map((s) => {
          const missing = s.value !== "" && installed[s.value] === false;
          return {
            value: s.value,
            label: missing ? `${s.label} (not installed)` : s.label,
            disabled: missing && terminal.shell !== s.value,
          };
        })}
        customPlaceholder="Path to a shell"
        problem={shellProblem}
        onChange={(shell) => updateSettings("terminal", { shell })}
      />
      <PickRow
        label="Font"
        value={terminal.fontFamily}
        options={TERMINAL_FACES.map((face) => ({ value: face, label: face }))}
        customPlaceholder="Any installed font"
        problem={fontMissing ? "Not installed on this machine." : undefined}
        onChange={(fontFamily) => updateSettings("terminal", { fontFamily })}
      />
      <NumberRow
        label="Font size"
        unit="pt"
        value={terminal.fontSize}
        fallback={DEFAULTS.terminal.fontSize}
        min={FONT_SIZE_MIN}
        max={FONT_SIZE_MAX}
        step={0.5}
        onChange={(fontSize) => updateSettings("terminal", { fontSize })}
      />
      <PickRow
        label="Cursor"
        value={terminal.cursorStyle}
        options={CURSOR_STYLES.map((style) => ({
          value: style,
          label: style[0].toUpperCase() + style.slice(1),
        }))}
        onChange={(cursorStyle) =>
          updateSettings("terminal", { cursorStyle: cursorStyle as CursorStyle })
        }
      />
      <Toggle
        id="setting-cursor-blink"
        label="Blink the cursor"
        checked={terminal.cursorBlink}
        onChange={(on) => updateSettings("terminal", { cursorBlink: on })}
      />
      <NumberRow
        label="Scrollback"
        unit="lines"
        value={terminal.scrollback}
        fallback={DEFAULTS.terminal.scrollback}
        min={SCROLLBACK_MIN}
        max={SCROLLBACK_MAX}
        step={1000}
        onChange={(scrollback) => updateSettings("terminal", { scrollback })}
      />
      <Toggle
        id="setting-restore-scrollback"
        label="Keep scrollback across restarts"
        checked={terminal.restoreScrollback}
        onChange={(on) => updateSettings("terminal", { restoreScrollback: on })}
      />
      <div className="setting-row">
        <span className="setting-label">Saved scrollback</span>
        <span className="setting-hint">
          {size === null ? "…" : size === 0 ? "Nothing saved" : formatBytes(size)}
        </span>
        <span className="setting-number">
          <button
            className="btn tiny"
            disabled={!size}
            onClick={async () => {
              await api.scrollbackClear().catch(() => undefined);
              setSize(await api.scrollbackSize().catch(() => 0));
            }}
          >
            Clear
          </button>
        </span>
      </div>
      <Toggle
        id="setting-screen-reader"
        label="Screen reader mode"
        hint="Slows long build output."
        checked={terminal.screenReader}
        onChange={(on) => updateSettings("terminal", { screenReader: on })}
      />
      <ResetSection
        category="terminal"
        keys={[
          "shell",
          "fontFamily",
          "fontSize",
          "cursorStyle",
          "cursorBlink",
          "scrollback",
          "screenReader",
          "restoreScrollback",
        ]}
      />
    </>
  );
}

/** What a shell preference resolves to on this machine, asked of Rust when it changes. */
function useResolvedShell(preference: string): ResolvedShell | null {
  const [resolved, setResolved] = useState<ResolvedShell | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.shellResolve(preference).then(
      (found) => {
        if (!cancelled) setResolved(found);
      },
      () => {
        if (!cancelled) setResolved(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [preference]);
  return resolved;
}

/** "12.4 KB", "3.1 MB": the size the row states. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- general

function AppearanceSection() {
  const { appearance } = useSettings();
  return (
    <>
      <h3>Appearance</h3>
      <div className="theme-list" role="radiogroup" aria-label="Theme">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={theme.id === appearance.theme}
            className={`theme-option${theme.id === appearance.theme ? " on" : ""}`}
            onClick={() => updateSettings("appearance", { theme: theme.id })}
          >
            <span className="theme-name">{theme.label}</span>
            <span className="theme-hint">{theme.hint}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function GeneralSection({ gh, claude }: { gh: boolean; claude: string | null }) {
  const { launch, ai } = useSettings();
  return (
    <>
      <h3>General</h3>
      <Toggle
        id="setting-launch-fetch"
        label="Fetch every repository at launch"
        hint="Fetch only. Nothing is pulled."
        checked={launch.fetch}
        onChange={(on) => updateSettings("launch", { fetch: on })}
      />
      <Toggle
        id="setting-launch-refresh-on-focus"
        label="Rescan when the window comes back"
        checked={launch.refreshOnFocus}
        onChange={(on) => updateSettings("launch", { refreshOnFocus: on })}
      />
      <Toggle
        id="setting-launch-update"
        label="Check for a new GitView"
        hint={gh ? undefined : "Needs gh."}
        checked={launch.checkUpdate}
        disabled={!gh}
        onChange={(on) => updateSettings("launch", { checkUpdate: on })}
      />
      <Toggle
        id="setting-ai-claude-tab"
        label="Show a Claude tab"
        hint={claude ? undefined : "claude is not on PATH."}
        checked={ai.claudeTab}
        onChange={(on) => updateSettings("ai", { claudeTab: on })}
      />
      <ResetSection category="launch" keys={["fetch", "refreshOnFocus", "checkUpdate"]} />
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
 * The inbox's timers, each with what it costs beside it. A read of the fleet
 * measured 8 points against 5000 an hour, so the numbers are affordable; they
 * are shown so the trade is visible where it is made.
 */
function GitHubSection({ info }: { info: AppInfo | null }) {
  const { github } = useSettings();
  const gh = info?.gh.version != null && info.gh.loggedIn;
  const why = !info?.gh.version
    ? "Needs gh."
    : !info.gh.loggedIn
      ? "gh is not logged in."
      : undefined;
  return (
    <>
      <h3>GitHub</h3>
      <Connection />
      <Toggle
        id="setting-github-poll"
        label="Read the inbox on a timer"
        hint={why}
        checked={github.poll}
        disabled={!gh}
        onChange={(on) => updateSettings("github", { poll: on })}
      />
      <NumberRow
        label="Read every"
        unit="min"
        hint={costOf(github.idleMinutes)}
        value={github.idleMinutes}
        fallback={DEFAULTS.github.idleMinutes}
        min={MINUTES_MIN}
        max={MINUTES_MAX}
        step={1}
        disabled={!gh || !github.poll}
        onChange={(idleMinutes) => updateSettings("github", { idleMinutes })}
      />
      <NumberRow
        label="Read every, while checks run"
        unit="min"
        hint={costOf(github.busyMinutes)}
        value={github.busyMinutes}
        fallback={DEFAULTS.github.busyMinutes}
        min={MINUTES_MIN}
        max={MINUTES_MAX}
        step={1}
        disabled={!gh || !github.poll}
        onChange={(busyMinutes) => updateSettings("github", { busyMinutes })}
      />
      <NumberRow
        label="Read at launch if older than"
        unit="min"
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

/** What the connection test has said so far. */
type Probe =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "ok"; login: string; remaining: number; limit: number; resetAt: string }
  | { state: "bad"; error: string };

/**
 * The test connection row: one `gh api graphql` asking who the token belongs
 * to, the same call the inbox makes, so a pass means the inbox works. A failure
 * shows gh's own sentence.
 */
function Connection() {
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const test = async () => {
    setProbe({ state: "busy" });
    try {
      setProbe({ state: "ok", ...(await api.githubProbe()) });
    } catch (err) {
      setProbe({ state: "bad", error: String(err) });
    }
  };
  const hint =
    probe.state === "idle"
      ? ""
      : probe.state === "busy"
        ? "Asking GitHub…"
        : probe.state === "ok"
          ? `${probe.login}, ${probe.remaining} of ${probe.limit} points left until ${clockOf(probe.resetAt)}`
          : probe.error;
  return (
    <div className="setting-row">
      <span className="setting-label">Connection</span>
      <span className={`setting-hint ${probe.state}`} role="status">
        {hint}
      </span>
      <span className="setting-number">
        <button
          className="btn tiny"
          disabled={probe.state === "busy"}
          onClick={test}
          title="gh api graphql, one small query. Nothing is written."
        >
          Test
        </button>
      </span>
    </div>
  );
}

/** "20:00", for the ISO instant GitHub states; the raw string if it will not parse. */
function clockOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
      <p>Shift-click any button to type its command without running it.</p>
    </>
  );
}

// ------------------------------------------------------------------ about

const REPO_URL = "https://github.com/JacobPoteet/GitView";
const AUTHOR_URL = "https://github.com/JacobPoteet";

const LINKS: [string, string][] = [
  ["Source", REPO_URL],
  ["Releases", `${REPO_URL}/releases`],
  ["Report an issue", `${REPO_URL}/issues/new`],
  ["Project page", "https://jacobpoteet.github.io/GitView"],
];

function About({
  info,
  shell,
  onCommand,
  onReplayTour,
}: {
  info: AppInfo | null;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
  onReplayTour: () => void;
}) {
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
      <p className="about-links">
        {LINKS.map(([label, url]) => (
          <Link key={url} url={url} shell={shell} onCommand={onCommand}>
            {label}
          </Link>
        ))}
      </p>
      <p className="about-links">
        <button type="button" className="link-btn" onClick={onReplayTour}>
          Replay the tour
        </button>
      </p>
      <p className="about-made-by">
        Made by{" "}
        <Link url={AUTHOR_URL} shell={shell} onCommand={onCommand}>
          <strong>Jacob Poteet</strong>
        </Link>
      </p>
    </>
  );
}

/**
 * A link that opens by typing. `Start-Process` at the prompt is how every other
 * URL in the app reaches the browser, and an `<a>` here would be the one that
 * did not say how. Shift-click types without running, the same as any button.
 */
function Link({
  url,
  shell,
  onCommand,
  children,
}: {
  url: string;
  shell: ShellKind;
  onCommand: (command: string, typeOnly: boolean) => void;
  children: ReactNode;
}) {
  const command = openUrlCommand(url, shell);
  return (
    <button
      type="button"
      className="link-btn"
      title={command}
      onClick={(event) => onCommand(command, event.shiftKey)}
    >
      {children}
    </button>
  );
}
