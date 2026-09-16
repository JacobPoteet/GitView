import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { settings } from "../lib/settings";
import type { AppInfo, UpdateCheck } from "../lib/types";

/**
 * The launch check against the latest GitHub release, and its dialog.
 *
 * Quiet at launch on purpose. A dialog on startup is the behaviour that makes
 * an updater the first thing people turn off, so an available release becomes
 * one word in the status bar and nothing else. Asked from the palette it
 * announces either answer, because somebody who asked wants to be told.
 */
export function useUpdate(info: AppInfo | null, setNote: (text: string) => void) {
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  const checkUpdate = useCallback(
    async (announce = false) => {
      try {
        const found = await api.updateCheck();
        setUpdate(found);
        if (!announce) return;
        if (found.error) setNote(`Could not ask GitHub: ${found.error}`);
        else if (found.available) setUpdateOpen(true);
        else setNote(`GitView ${found.current} is the latest release.`);
      } catch (err) {
        if (announce) setNote(String(err));
      }
    },
    [setNote],
  );

  // After the first paint rather than beside the cached fleet, so a slow gh
  // never holds up the window. No gh, no check and nothing said about it: the
  // status bar already reports whether it is there.
  // Asked from the palette it still answers when the launch check is off:
  // the setting is about being asked, not about asking.
  useEffect(() => {
    if (!info?.gh.version || !settings().launch.checkUpdate) return;
    checkUpdate();
  }, [info?.gh.version, checkUpdate]);

  return { update, updateOpen, setUpdateOpen, checkUpdate };
}
