import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { cloneCommand, cloneName, clonePath, type ShellKind } from "../lib/shell";
import type { RootSuggestion } from "../lib/types";

interface Props {
  roots: string[];
  shell: ShellKind;
  /** The watched folders changed, and the fleet wants a rescan. */
  onRoots: (roots: string[]) => void;
  /**
   * Types the clone into GitView's own shell. `target` is where the new
   * repository will be, so the app can open it once the sweep finds it.
   */
  onClone: (command: string, typeOnly: boolean, target: string) => void;
}

/**
 * What the main column shows until there is something to pick.
 *
 * Nothing is watched on a first run. The folders people keep checkouts in are
 * offered here with what each one holds, and one click writes the choice, so a
 * new install never fills the sidebar from folders nobody chose. The same page
 * comes back when the last folder is removed.
 *
 * Cloning is typed like every other action: the line goes into GitView's own
 * shell, where its progress is visible, and the folder it lands in is watched
 * first so the sweep that follows finds it.
 */
export default function Welcome({ roots, shell, onRoots, onClone }: Props) {
  const [found, setFound] = useState<RootSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .settingsSuggestRoots()
      .then((list) => !cancelled && setFound(list))
      .catch(() => !cancelled && setFound([]));
    return () => {
      cancelled = true;
    };
  }, [roots]);

  async function watch(path: string) {
    setBusy(true);
    setError(null);
    try {
      onRoots(await api.settingsAddRoot(path));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function choose(title: string): Promise<string | null> {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  }

  const into = parent ?? roots[0] ?? found?.[0]?.path ?? null;
  const name = cloneName(url);
  const target = into && name ? clonePath(into, name) : null;
  const command = target ? cloneCommand(url, target, shell) : null;

  async function clone(typeOnly: boolean) {
    if (!into || !target || !command) return;
    setBusy(true);
    setError(null);
    try {
      if (!roots.some((root) => root.toLowerCase() === into.toLowerCase())) {
        onRoots(await api.settingsAddRoot(into));
      }
      onClone(command, typeOnly, target);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const nothingFound = found !== null && found.length === 0;

  return (
    <div className="welcome">
      <div className="welcome-body">
        <h2>{roots.length === 0 ? "Watch your projects" : "No repositories here yet"}</h2>
        <p>
          {roots.length === 0
            ? "GitView lists every repository in the folders you watch, one level down. Pick the folder your projects sit in, or a single project."
            : "The watched folders hold no repositories. Watch another folder, or clone one into them."}
        </p>

        {found === null ? (
          <p className="welcome-dim">Looking in the usual places…</p>
        ) : (
          found.length > 0 && (
            <ul className="root-list welcome-found" aria-label="Folders found on this machine">
              {found.map((folder) => (
                <li key={folder.path}>
                  <span title={folder.path}>{folder.path}</span>
                  <em>
                    {folder.repos} {folder.repos === 1 ? "repository" : "repositories"}
                  </em>
                  <button className="btn accent" disabled={busy} onClick={() => watch(folder.path)}>
                    Watch
                  </button>
                </li>
              ))}
            </ul>
          )
        )}

        <div className="welcome-actions">
          <button
            className={`btn${nothingFound ? " accent" : ""}`}
            disabled={busy}
            onClick={async () => {
              const picked = await choose("Watch a folder");
              if (picked) await watch(picked);
            }}
          >
            {found && found.length > 0 ? "Choose another folder…" : "Choose a folder…"}
          </button>
        </div>

        <h3>Or clone one</h3>
        <div className="root-add">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && command) clone(e.shiftKey);
            }}
            placeholder="https://github.com/owner/repo.git"
            spellCheck={false}
            aria-label="Repository URL"
          />
          <button
            className="btn"
            disabled={busy || !command}
            title={command ? `${command}\n\nShift-click to type it without running it.` : undefined}
            onClick={(e) => clone(e.shiftKey)}
          >
            Clone
          </button>
        </div>
        <p className="welcome-dim">
          {into ? (
            <>
              Into <code>{into}</code>{" "}
            </>
          ) : (
            "Pick the folder it goes in. "
          )}
          <button
            className="link-btn"
            disabled={busy}
            onClick={async () => {
              const picked = await choose("Clone into");
              if (picked) setParent(picked);
            }}
          >
            {into ? "Change…" : "Choose…"}
          </button>
        </p>
        {command && (
          <p className="welcome-command">
            <code>{command}</code>
          </p>
        )}

        {error && <p className="root-error">{error}</p>}

        <p className="welcome-foot">
          Settings → Folders, or the + above the sidebar, changes these later.
        </p>
      </div>
    </div>
  );
}
