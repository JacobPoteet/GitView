import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { settings, useSetting } from "../lib/settings";
import { getBlocks } from "../components/TerminalPane";
import { itemKey } from "../lib/inbox";
import type { AppInfo, Inbox } from "../lib/types";

/**
 * The GitHub inbox: the read, the poll, the launch read, and the re-read
 * after a typed `gh` command with the row it removes.
 *
 * Everything here used to be nine pieces of `App`'s state. It owns them now
 * and hands back what the render needs; `App` still decides when a command
 * is typed and when a shell settles, and tells this through `armAfter` and
 * `settled`.
 */
export function useInbox(info: AppInfo | null, setNote: (text: string) => void) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxReading, setInboxReading] = useState(false);
  /** A row the inbox opens expanded, when the header's PR button brought you there. */
  const [inboxFocus, setInboxFocus] = useState<string | null>(null);
  /**
   * A typed `gh` write whose exit the inbox is waiting on.
   *
   * A merge or a re-run changes what GitHub would answer, and the pane has no
   * way to know the command finished except the block it left behind in that
   * shell. `settled` runs when the shell's output settles and checks here.
   *
   * `drops` names the row the command removes when it exits 0. A merge is
   * final the moment `gh pr merge` returns, and the row goes on that rather
   * than on the read that follows, because the read is not always right: a
   * poll that started a second before the merge landed answers with the list
   * as it was, and GitHub's own answer can lag the merge by a few seconds.
   */
  const inboxAfter = useRef<{ path: string; command: string; drops?: string } | null>(null);
  /**
   * The same, as state, for the desk. The ref is what `settled` reads; the
   * state is what disables the merge button while `gh pr merge` is still in
   * the shell, so a second click cannot type it twice.
   */
  const [inboxTyped, setInboxTyped] = useState<{ path: string; command: string; drops?: string } | null>(
    null,
  );
  /**
   * Rows a command has removed, keyed like `itemKey`. A read that still lists
   * one was answered from before the command, and the row stays gone.
   */
  const inboxGone = useRef<Set<string>>(new Set());

  /**
   * One GraphQL request for the whole fleet, through the gh CLI.
   *
   * A failed read keeps the last good list on screen rather than emptying the
   * pane, because the usual reason is a laptop that was off the network.
   */
  const inboxInFlight = useRef<Promise<void> | null>(null);
  const inboxAgain = useRef(false);
  const refreshInbox = useCallback((after = false): Promise<void> => {
    // The poll, a settled command and the button can all ask at once, and one
    // read answers all three. The promise is shared so a caller that arrived
    // second still waits for the read it got. A caller whose command just
    // finished is the exception: a read already on the wire was asked before
    // the command ran, so it gets another read after this one rather than
    // that one's answer.
    if (inboxInFlight.current) {
      if (after) inboxAgain.current = true;
      return inboxInFlight.current;
    }
    const read = (async () => {
      setInboxReading(true);
      try {
        const next = await api.githubRefresh();
        const gone = inboxGone.current;
        if (gone.size > 0) next.items = next.items.filter((item) => !gone.has(itemKey(item)));
        setInbox((current) => (next.error && current ? { ...current, error: next.error } : next));
        if (next.error) setNote(next.error);
        else if (next.unresolved.length > 0) {
          setNote(`Read the inbox. ${next.unresolved.length} did not resolve.`);
        }
      } catch (err) {
        setNote(String(err));
      } finally {
        inboxInFlight.current = null;
        setInboxReading(false);
      }
      if (inboxAgain.current) {
        inboxAgain.current = false;
        await refreshInboxRef.current();
      }
    })();
    inboxInFlight.current = read;
    return read;
  }, [setNote]);
  const refreshInboxRef = useRef(refreshInbox);
  refreshInboxRef.current = refreshInbox;

  /**
   * The interval read.
   *
   * Once a minute while a pull request in the list has checks running, no
   * checks reported yet, or a merge GitHub is still computing, and otherwise
   * every ten, both from the GitHub section of the settings. The whole fleet
   * reads at cost 8 of 5000 an hour, so the fast rate is affordable, but it is
   * held to pull requests that moved in the last hour: a stranger's PR whose
   * checks never ran would otherwise keep the fast rate on for good. The null
   * rollup counts because Actions takes a moment to register a check after a
   * push, and the first read after `gh pr create` lands inside that moment.
   */
  const github = useSetting((s) => s.github);
  useEffect(() => {
    if (!info?.gh.version || !info.gh.loggedIn || !github.poll) return;
    const hourAgo = Date.now() - 3_600_000;
    const busy = (inbox?.items ?? []).some(
      (item) =>
        item.kind === "pr" &&
        Date.parse(item.updatedAt) > hourAgo &&
        (item.checks === null ||
          item.checks === "PENDING" ||
          item.checks === "EXPECTED" ||
          item.mergeable === "UNKNOWN"),
    );
    const every = (busy ? github.busyMinutes : github.idleMinutes) * 60_000;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshInbox();
    }, every);
    return () => window.clearInterval(timer);
  }, [info, inbox, refreshInbox, github]);

  /**
   * One read on launch when the cached copy has gone stale.
   *
   * Without it the sidebar badge stays at whatever it was when the app last
   * closed, which is a number that looks live and is not. Ten minutes by
   * default, from the GitHub section of the settings, because a read costs
   * eight points of five thousand an hour.
   */
  const inboxLaunched = useRef(false);
  useEffect(() => {
    if (inboxLaunched.current) return;
    if (!info?.gh.version || !info.gh.loggedIn) return;
    inboxLaunched.current = true;
    const age = inbox ? Math.floor(Date.now() / 1000) - inbox.fetchedAt : Infinity;
    if (age > settings().github.launchStaleMinutes * 60) refreshInbox();
  }, [info, inbox, refreshInbox]);

  /** A `gh` write was typed into a repository's shell; re-read once it has exited. */
  const armAfter = useCallback((path: string, command: string, drops?: string) => {
    inboxAfter.current = { path, command, drops };
    setInboxTyped(inboxAfter.current);
  }, []);

  /**
   * A shell settled. A `gh` write the inbox typed there has finished when its
   * block has an exit code. A shell with no prompt hook leaves no blocks at
   * all, and there the first settle is the best signal there is. `id` is the
   * shell whose blocks to read, which is the repository's first unless a
   * second one did the typing.
   */
  const settled = useCallback(
    (path: string, id: string) => {
      const waiting = inboxAfter.current;
      if (!waiting || waiting.path !== path) return;
      const blocks = getBlocks(id);
      const block = [...blocks].reverse().find((b) => b.command === waiting.command);
      if (blocks.length === 0 || (block && block.endedAt !== null)) {
        inboxAfter.current = null;
        setInboxTyped(null);
        if (waiting.drops && block?.exitCode === 0) {
          const key = waiting.drops;
          inboxGone.current.add(key);
          setInbox((current) =>
            current ? { ...current, items: current.items.filter((item) => itemKey(item) !== key) } : current,
          );
        }
        refreshInbox(true);
      }
    },
    [refreshInbox],
  );

  return {
    inbox,
    /** For the boot read, which loads the cached copy beside the fleet rows. */
    setInbox,
    inboxOpen,
    setInboxOpen,
    inboxReading,
    /** The `gh` write the inbox typed and is waiting on, for the desk to show. */
    inboxTyped,
    inboxFocus,
    setInboxFocus,
    refreshInbox,
    armAfter,
    settled,
  };
}
