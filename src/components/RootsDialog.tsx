import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";

interface Props {
  roots: string[];
  onChange: (roots: string[]) => void;
  onClose: () => void;
}

/**
 * The watched folders.
 *
 * One verb covers both cases people mean by "open a repository". A folder full
 * of checkouts becomes a scan root, and a single project becomes a scan root
 * that happens to hold exactly one repository, because `fleet::discover` already
 * counts a root that is itself a repository.
 */
export default function RootsDialog({ roots, onChange, onClose }: Props) {
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
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div className="confirm roots" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Watched folders</h2>
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
        </div>

        {error && <p className="root-error">{error}</p>}

        <div className="confirm-actions">
          <button className="btn" onClick={browse} disabled={busy}>
            Browse…
          </button>
          <button className="btn accent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
