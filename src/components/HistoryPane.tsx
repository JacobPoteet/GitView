import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import { commitMenu, type ResetMode } from "./BranchGraph";
import { quote, type ShellKind } from "../lib/shell";
import { api } from "../lib/api";
import {
  parseHistoryFilter,
  relativeTime,
  signedTitle,
  type HistoryFilter,
  type HistoryRef,
  type HistoryRow,
  type Squashed,
} from "../lib/types";

interface Props {
  repoPath: string;
  repoName: string;
  /** No live shell means Shift-click has nowhere to type, and a prune nowhere to run. */
  disabled: boolean;
  /** Opens the commit pane on a row. The click itself types nothing. */
  onOpen: (commit: { id: string; short: string }) => void;
  /**
   * Branches that were squash-merged, and the commit each one became.
   *
   * A squash leaves no link in the object database, so the branch forks off and
   * stops and the commit that swallowed it looks like anybody's. These are the
   * two ends of a join nothing else in the picture can draw.
   */
  squashed: Squashed[];
  /**
   * Moves when a ref does. The pane re-reads what it has loaded, in place, so
   * a commit or a prune typed while it is open reaches it without the scroll
   * position going back to the top.
   */
  reloadKey: string;
  shell: ShellKind;
  /**
   * Branches the trunk contains or swallowed, which is what Prune deletes. The
   * button lives here rather than in the header because this is the view that
   * shows a branch is finished: the chip sits on a commit under the trunk's, or
   * ends at a "squashed into" note. Zero disables it rather than hiding it.
   */
  prunable: number;
  /** The commands Prune would type, for the tooltip. */
  pruneTitle: string;
  onPrune: () => void;
  onClose: () => void;
  onCommand: (command: string, typeOnly: boolean) => void;
  /** Deleting asks first, and the app owns the dialog. */
  onDeleteBranch: (name: string) => void;
  /** Tagging asks for a name first, and the app owns that dialog too. */
  onTag: (commit: { id: string; short: string; summary: string }) => void;
  onReset: (commit: { id: string; short: string; summary: string }, mode: ResetMode) => void;
  /** The branch HEAD is on, for the menu's labels. Null when detached. */
  headBranch: string | null;
  /**
   * What origin has under `refs/tags/`, by name, peeled to the commit. Null
   * until `git ls-remote` has answered, or when there is no origin to ask,
   * and a chip then says nothing about where its tag is.
   */
  remoteTags: Map<string, string> | null;
  /** Whether there is an origin to push to. Without one Push is disabled, not hidden. */
  hasRemote: boolean;
  onCopy: (text: string, what: string) => void;
  onError: (message: string) => void;
}

/** What a right-click landed on: a commit row, or a branch chip sitting on one. */
type Target = { row: HistoryRow; ref: HistoryRef | null };

/**
 * Where a tag is, as far as origin is concerned.
 *
 * `here` rather than `local`, because `local` is already the class a branch
 * chip wears. `unknown` is no answer yet, or no origin. `moved` is a name origin has on a
 * different commit, which a push would refuse without `--force` and which is
 * worth a mark of its own rather than passing as pushed.
 */
type TagPlace = "unknown" | "here" | "pushed" | "moved";

function tagPlace(name: string, commit: string, remoteTags: Map<string, string> | null): TagPlace {
  if (!remoteTags) return "unknown";
  const at = remoteTags.get(name);
  if (at === undefined) return "here";
  return at === commit ? "pushed" : "moved";
}

/** What a tag chip says on hover, and what its mark means. */
function tagTitle(name: string, place: TagPlace): string {
  switch (place) {
    case "pushed":
      return `${name} is on origin at this commit.`;
    case "here":
      return `${name} is only here. git push origin ${name} sends it.`;
    case "moved":
      return `origin has a ${name} on a different commit. git push would refuse it; git push --force origin ${name} moves it.`;
    default:
      return name;
  }
}

/**
 * The whole DAG, scrolling, over the main column.
 *
 * Canvas rails under plain DOM rows, and only the rows on screen exist. A node
 * per commit in SVG stops scrolling smoothly in the low thousands, which is the
 * reason [[Branch Graph]] caps itself at 88 and this pane was left until now.
 * The rows carry the text and take the clicks; the canvas carries the lines and
 * takes none.
 */

/** Row height in px. Everything below measures against this one number. */
const ROW = 26;
/** Lane column width. Sixteen of these is the widest gutter the backend allows. */
const LANE = 13;
/** Rows drawn above and below the viewport, so a fast scroll has something to show. */
const OVERSCAN = 8;
/** Commits per request. */
const PAGE = 400;

/**
 * Where each repository's history was scrolled to, by path.
 *
 * The commit pane takes this pane's slot in the main column, so opening a
 * commit unmounts the list and closing it mounts a fresh one. Without this the
 * fresh one read page one and sat at the top, and the row you had just opened
 * was somewhere below. Module state, like the sessions in `TerminalPane`: it
 * has to outlive the component. Keyed on the path so a selection change lands
 * on that repository's own place.
 */
const places = new Map<string, number>();

/**
 * Lane colours, in the order lanes open.
 *
 * Read off the stylesheet rather than written here, so the pane follows the
 * theme's tokens the way the terminal does. Lanes carry no meaning, so the
 * palette only has to keep two neighbouring lines apart, and it skips the hues
 * that already mean something: amber is attention here and red is a failed
 * command, so a trunk landing in either reads as a warning it is not.
 */
const LANE_TOKENS = [
  "--lane-1",
  "--lane-2",
  "--lane-3",
  "--lane-4",
  "--lane-5",
  "--lane-6",
];

function laneColours(host: HTMLElement): string[] {
  const style = getComputedStyle(host);
  return LANE_TOKENS.map((token) => style.getPropertyValue(token).trim() || "#888");
}

export default function HistoryPane({
  repoPath,
  repoName,
  disabled,
  squashed,
  reloadKey,
  shell,
  prunable,
  pruneTitle,
  onPrune,
  onClose,
  onCommand,
  onOpen,
  onDeleteBranch,
  onTag,
  onReset,
  headBranch,
  remoteTags,
  hasRemote,
  onCopy,
  onError,
}: Props) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const menu = useContextMenu<Target>();

  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [crowded, setCrowded] = useState(false);
  const [lanes, setLanes] = useState(1);
  const [head, setHead] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const [done, setDone] = useState(false);
  /**
   * The filter field's text, and the filter it parses to. The field is what
   * is typed; the filter is what the read takes, and it is re-read on a
   * short debounce rather than a keystroke, since each read walks every
   * commit to test it. Kept per pane rather than per repository: a filter
   * is a question about the history on screen, not a preference.
   */
  const scroller = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter | null>(null);
  const [filtered, setFiltered] = useState(false);
  useEffect(() => {
    const next = parseHistoryFilter(query);
    const timer = window.setTimeout(() => {
      setFilter((was) => {
        // A new question starts at the top: the place kept for the unfiltered
        // list means nothing in a list of forty matches.
        if (JSON.stringify(was) !== JSON.stringify(next)) scroller.current?.scrollTo(0, 0);
        return next;
      });
    }, next ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  // The place to go back to, taken once at mount and cleared once reached.
  // A ref rather than state: it is read inside `loadPage` to size the first
  // read, and it must not re-run that read when it clears.
  const restore = useRef(places.get(repoPath) ?? 0);

  // A page in flight, so a scroll that keeps going does not ask twice for the
  // same 400 commits. A ref rather than state: the check has to see the change
  // before React has re-rendered.
  const loading = useRef(false);
  // A read from the top supersedes whatever was in flight. Each one takes a
  // number, and a page that lands carrying an older number is dropped rather
  // than appended to rows it was not read against.
  const generation = useRef(0);
  const loaded = useRef(0);
  loaded.current = rows.length;

  /**
   * A row's menu is the commit: what the click already does, and the id. A
   * local branch chip gets the branch instead, which is where deleting lives:
   * the history is the view that shows a branch is finished, so it is the
   * view to remove it from.
   */
  function rowMenu({ row, ref }: Target): MenuEntry[] {
    // A detached HEAD's chip is named `HEAD` and is no branch: nothing to
    // switch to and nothing to delete, so it gets the commit's menu.
    const isBranch = (r: HistoryRef) => r.kind === "local" || (r.kind === "head" && r.name !== "HEAD");
    if (ref && isBranch(ref)) {
      const current = ref.kind === "head";
      const switchTo = `git switch ${quote(ref.name, shell)}`;
      return [
        {
          label: `Switch to ${ref.name}`,
          title: current ? "You are on it." : switchTo,
          disabled: current,
          run: (typeOnly) => onCommand(switchTo, typeOnly),
        },
        { label: "Copy branch name", run: () => onCopy(ref.name, "the branch name") },
        "-",
        {
          label: `Delete ${ref.name}`,
          danger: true,
          disabled: current,
          title: current ? "You are on it. Switch away first." : "Asks first, and names the command.",
          run: () => onDeleteBranch(ref.name),
        },
      ];
    }
    // A tag chip offers the tag: sending it, and taking it back. Deleting
    // does not ask first, unlike a branch: `git tag -d` prints the commit it
    // was at, and a tag holds no work of its own to lose.
    if (ref && ref.kind === "tag") {
      const arg = quote(ref.name, shell);
      const place = tagPlace(ref.name, row.id, remoteTags);
      const push = `git push origin ${arg}`;
      const remove = `git tag -d ${arg}`;
      return [
        {
          label: "Push to origin",
          title: !hasRemote
            ? "No origin to push to."
            : place === "pushed"
              ? `${tagTitle(ref.name, place)} Nothing to push.`
              : place === "moved"
                ? `${push}\n\n${tagTitle(ref.name, place)}`
                : push,
          disabled: !hasRemote || place === "pushed",
          run: (typeOnly) => onCommand(push, typeOnly),
        },
        { label: "Copy tag name", run: () => onCopy(ref.name, "the tag name") },
        "-",
        {
          label: `Delete ${ref.name}`,
          danger: true,
          title: `${remove}\n\nHere only. A copy on origin stays until git push origin --delete ${arg}.`,
          run: (typeOnly) => onCommand(remove, typeOnly),
        },
      ];
    }
    const tips = row.refs.filter(isBranch).map((r) => ({ name: r.name, isHead: r.kind === "head" }));
    return commitMenu(row, tips, { shell, headBranch, onCommand, onCopy, onTag, onReset });
  }

  const loadPage = useCallback(
    async (offset: number, limit = PAGE) => {
      if (offset > 0 && loading.current) return;
      const mine = offset === 0 ? ++generation.current : generation.current;
      loading.current = true;
      try {
        const page = await api.repoHistory(repoPath, offset, limit, filter);
        if (mine !== generation.current) return;
        if (page.error) {
          onError(page.error);
          setDone(true);
          return;
        }
        setTotal(page.total);
        setCapped(page.capped);
        setCrowded((was) => was || page.crowded);
        setLanes((was) => Math.max(was, page.lanes));
        setHead(page.head);
        setFiltered(page.filtered);
        setRows((current) =>
          offset === 0 ? page.rows : [...current, ...page.rows],
        );
        setDone(page.rows.length < limit);
      } catch (err) {
        if (mine !== generation.current) return;
        onError(String(err));
        setDone(true);
      } finally {
        if (mine === generation.current) {
          loading.current = false;
          setReading(false);
        }
      }
    },
    [repoPath, onError, filter],
  );

  // The first run is the mount, and it reads far enough to cover the place
  // being restored, so the scroll lands on rows rather than on a blank band
  // waiting for page two. Every run after it is a ref that moved, and those
  // re-read as many rows as are on screen so the window stays where it was;
  // the rows already there stay up until the fresh ones replace them.
  useEffect(() => {
    const wanted = Math.ceil((restore.current + 600) / ROW) + OVERSCAN;
    loadPage(0, Math.max(PAGE, loaded.current, wanted));
  }, [loadPage, reloadKey]);

  // Back to where it was, once there are rows under that offset. Setting
  // `scrollTop` on an element shorter than the target clamps it to the bottom,
  // which is why this waits for the rows rather than running at mount.
  useLayoutEffect(() => {
    const el = scroller.current;
    const target = restore.current;
    if (!el || target === 0) return;
    // A place at the foot of a short history is never covered by a full
    // viewport of rows. Once the walk is done there is nothing more to wait
    // for, and the browser clamps to the bottom, which is where it was.
    if (rows.length * ROW < target + viewport && !done) return;
    restore.current = 0;
    el.scrollTop = target;
    setScrollTop(el.scrollTop);
  }, [rows.length, viewport, done]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);

  // Another page once the tail is in sight, rather than at the very bottom: a
  // fetch that starts when the scrollbar is already against the end shows an
  // empty band for as long as the walk takes.
  useEffect(() => {
    if (done || reading || loading.current) return;
    if (last > rows.length - OVERSCAN * 4) loadPage(rows.length);
  }, [last, rows.length, done, reading, loadPage]);

  /**
   * The rails.
   *
   * Drawn for the rows on screen only, in the canvas's own coordinates, with
   * the fractional scroll offset applied so the lines stay glued to the rows
   * they belong to rather than stepping a row at a time.
   */
  useEffect(() => {
    const el = canvas.current;
    const host = scroller.current;
    if (!el || !host) return;
    const width = Math.min(lanes, 16) * LANE + LANE;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(viewport * dpr);
    el.style.width = `${width}px`;
    el.style.height = `${viewport}px`;

    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, viewport);
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";

    const colours = laneColours(host);
    const style = getComputedStyle(host);
    const ground = style.getPropertyValue("--bg").trim() || "#111";
    const green = style.getPropertyValue("--green").trim() || "#4c4";
    const x = (lane: number) => Math.min(lane, 15) * LANE + LANE / 2 + 4;
    const y = (index: number) => index * ROW + ROW / 2 - scrollTop;

    // Lines first, so a node always sits on top of the line it belongs to.
    for (let i = first; i < last; i++) {
      const row = rows[i];
      if (!row) continue;
      const top = y(i);
      for (const [from, to] of row.edges) {
        // The outer of the two columns is the branch and the inner is what it
        // came off, so a branch keeps one colour from the merge that took it
        // all the way down to the commit it forked at.
        ctx.strokeStyle = colours[Math.max(from, to) % colours.length];
        ctx.beginPath();
        ctx.moveTo(x(from), top);
        if (from === to) {
          ctx.lineTo(x(to), top + ROW);
        } else {
          // A line changing column bends across the middle of the band rather
          // than cutting the corner, which keeps two lanes crossing readable.
          ctx.bezierCurveTo(
            x(from),
            top + ROW * 0.45,
            x(to),
            top + ROW * 0.55,
            x(to),
            top + ROW,
          );
        }
        ctx.stroke();
      }
    }

    for (let i = first; i < last; i++) {
      const row = rows[i];
      if (!row) continue;
      const cx = x(row.lane);
      const cy = y(i);
      ctx.fillStyle = colours[row.lane % colours.length];
      ctx.beginPath();
      ctx.arc(cx, cy, row.isMerge ? 4 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      // A merge is a ring, the way the branch graph draws its fork, so the two
      // pictures use one vocabulary.
      if (row.isMerge) {
        ctx.fillStyle = ground;
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // The commit you are standing on wears the branch graph's green ring, so
      // the two pictures say "you are here" the same way. Drawn round the lane
      // colour rather than over it: the lane still says which line the commit
      // is on.
      if (row.isHead) {
        ctx.strokeStyle = green;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1.5;
      }
    }
  }, [rows, first, last, scrollTop, viewport, lanes]);

  // A filtered list is flat, and one lane's worth of gutter is all it needs.
  const gutter = (filtered ? 1 : Math.min(lanes, 16)) * LANE + LANE;

  // Both ends of the join, by the two things a row knows about itself: its own
  // id, and the branch names sitting on it.
  const swallowed = new Map<string, Squashed[]>();
  const isTipOf = new Map<string, Squashed>();
  for (const entry of squashed) {
    const at = swallowed.get(entry.into) ?? [];
    at.push(entry);
    swallowed.set(entry.into, at);
    isTipOf.set(entry.branch, entry);
  }

  return (
    <section className="history-pane">
      <div className="pane-tab-bar">
        <span>history</span>
        <span className="tab-path" title={repoPath}>
          {repoName}
          {head && ` · ${head}`}
        </span>
        {crowded && (
          <span className="history-note" title="Past sixteen lanes the rails stop being exact.">
            crowded
          </span>
        )}
        <span className="history-filter">
          <input
            value={query}
            spellCheck={false}
            placeholder="Filter: text, author:name, path:src/lib"
            title="Matches the message. author: matches the name or email, path: keeps commits that changed that file or folder, like git log -- path."
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="history-filter-clear"
              onClick={() => setQuery("")}
              title="Clear the filter"
              aria-label="Clear the filter"
            >
              ✕
            </button>
          )}
        </span>
        <span className="history-count" title={filtered ? "Commits matching the filter" : undefined}>
          {filtered && "matching "}
          {rows.length.toLocaleString()} of {total.toLocaleString()}
          {capped && "+"}
        </span>
        <button
          className="btn tiny"
          disabled={prunable === 0 || disabled}
          title={disabled ? "Waiting for the shell" : pruneTitle}
          onClick={onPrune}
        >
          Prune merged
          {prunable > 0 && ` (${prunable})`}
        </button>
        <button className="pane-close" onClick={onClose} title="Close (Escape)" aria-label="Close">
          ✕
        </button>
      </div>

      <div
        className="history-scroll"
        ref={scroller}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          // Written on every scroll rather than at unmount: React unmounts
          // after the DOM is gone, and a detached scroller reads 0.
          if (restore.current === 0) places.set(repoPath, event.currentTarget.scrollTop);
        }}
      >
        {/* The canvas is sticky rather than tall: it covers the viewport and is
            redrawn on scroll, so a repository with forty thousand commits never
            allocates a forty-thousand-row bitmap. */}
        <canvas className="history-canvas" ref={canvas} aria-hidden />

        {rows.length === 0 && !reading && (
          <p className="empty">{filtered ? "Nothing matches." : "No commits here yet."}</p>
        )}
        {rows.length === 0 && reading && <p className="empty">Reading the history…</p>}

        <div className="history-rows" style={{ height: rows.length * ROW }}>
          {rows.slice(first, last).map((row, offset) => (
            <Row
              key={row.id}
              row={row}
              top={(first + offset) * ROW}
              gutter={gutter}
              swallowed={swallowed.get(row.id) ?? null}
              tipOf={row.refs.map((r) => isTipOf.get(r.name)).find(Boolean) ?? null}
              remoteTags={remoteTags}
              disabled={disabled}
              onCommand={onCommand}
              onOpen={onOpen}
              onMenu={menu.open}
            />
          ))}
        </div>
      </div>

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={
            menu.menu.payload.ref
              ? `Actions for ${menu.menu.payload.ref.name}`
              : `Actions for ${menu.menu.payload.row.short}`
          }
          entries={rowMenu(menu.menu.payload)}
          onClose={menu.close}
        />
      )}
    </section>
  );
}

function Row({
  row,
  top,
  gutter,
  swallowed,
  tipOf,
  remoteTags,
  disabled,
  onCommand,
  onOpen,
  onMenu,
}: {
  row: HistoryRow;
  top: number;
  gutter: number;
  /** Branches this commit is, under another name, through a squash. */
  swallowed: Squashed[] | null;
  /** Set when this row is the tip of a branch that was squashed onto the trunk. */
  tipOf: Squashed | null;
  remoteTags: Map<string, string> | null;
  disabled: boolean;
  onCommand: (command: string, typeOnly: boolean) => void;
  onOpen: (commit: { id: string; short: string }) => void;
  onMenu: (event: ReactMouseEvent, target: Target) => void;
}) {
  // A click opens the commit pane and types nothing: reading a commit is a
  // lookup, and until 12 Sep 2026 every lookup scrolled the shell. Shift-click
  // keeps the typed route, `--no-pager` and `--stat` because `git show` hands
  // its output to a pager that holds the shell until you find out the way out
  // is `Q`, and a large commit floods the scrollback.
  const command = `git --no-pager show --stat ${row.short}`;

  return (
    <button
      className={`history-row${row.isMerge ? " merge" : ""}${row.isHead ? " head" : ""}`}
      style={{ top, height: ROW }}
      onClick={(event) => {
        if (event.shiftKey) {
          if (!disabled) onCommand(command, true);
        } else {
          onOpen({ id: row.id, short: row.short });
        }
      }}
      onContextMenu={(event) => onMenu(event, { row, ref: null })}
      title={`${row.isHead ? "You are on this commit.\n\n" : ""}${row.summary}\n\n${row.author} · ${new Date(row.time * 1000).toLocaleString()}\n${row.id}\n\nClick to read the commit.\nShift-click to type ${command} without running it.`}
    >
      <span className="history-lanes" style={{ width: gutter }} />
      {row.refs.map((ref) => {
        // A tag chip says whether origin has it. `↑` is the mark the sidebar
        // uses for commits that have not been pushed, so it means the same
        // thing on a tag; `≠` is a name origin has somewhere else.
        const place = ref.kind === "tag" ? tagPlace(ref.name, row.id, remoteTags) : "unknown";
        return (
          <span
            key={`${ref.kind}:${ref.name}`}
            className={`history-ref ${ref.kind}${place === "unknown" ? "" : ` ${place}`}`}
            title={ref.kind === "tag" ? tagTitle(ref.name, place) : undefined}
            onContextMenu={(event) => onMenu(event, { row, ref })}
          >
            {place === "here" && <span className="history-ref-mark">↑</span>}
            {place === "moved" && <span className="history-ref-mark">≠</span>}
            {ref.name}
          </span>
        );
      })}
      {swallowed?.map((entry) => (
        <span
          key={entry.branch}
          className="history-ref squashed"
          title={`This commit is ${entry.branch}, squashed onto ${entry.base}. It rolled up ${entry.commits} ${entry.commits === 1 ? "commit" : "commits"}.

A squash keeps no link to the branch it came from, so the two are joined here by their patch rather than by git.`}
        >
          ⤳ {entry.branch}
        </span>
      ))}
      <span className="history-summary">{row.summary || "(no message)"}</span>
      {tipOf && (
        <span
          className="history-squashed-into"
          title={`${tipOf.intoSummary}

This branch ends here because a squash rebuilt its ${tipOf.commits} ${tipOf.commits === 1 ? "commit" : "commits"} as ${tipOf.intoShort} on ${tipOf.base}. Nothing in git links the two.`}
        >
          squashed into {tipOf.intoShort}
        </span>
      )}
      <span className="history-author">{row.author}</span>
      {row.signature && (
        <span className="history-signed" title={signedTitle(row.signature, row.short)} aria-label="signed">
          ✓
        </span>
      )}
      <span className="history-when">{relativeTime(row.time)}</span>
      <span className="history-sha">{row.short}</span>
    </button>
  );
}
