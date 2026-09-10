import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { relativeTime, type HistoryRow, type Squashed } from "../lib/types";

interface Props {
  repoPath: string;
  repoName: string;
  /** No live shell means a commit has nowhere to be shown. */
  disabled: boolean;
  /**
   * Branches that were squash-merged, and the commit each one became.
   *
   * A squash leaves no link in the object database, so the branch forks off and
   * stops and the commit that swallowed it looks like anybody's. These are the
   * two ends of a join nothing else in the picture can draw.
   */
  squashed: Squashed[];
  onClose: () => void;
  onCommand: (command: string, typeOnly: boolean) => void;
  onError: (message: string) => void;
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
  onClose,
  onCommand,
  onError,
}: Props) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [crowded, setCrowded] = useState(false);
  const [lanes, setLanes] = useState(1);
  const [head, setHead] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const [done, setDone] = useState(false);

  const scroller = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  // A page in flight, so a scroll that keeps going does not ask twice for the
  // same 400 commits. A ref rather than state: the check has to see the change
  // before React has re-rendered.
  const loading = useRef(false);

  const loadPage = useCallback(
    async (offset: number) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const page = await api.repoHistory(repoPath, offset, PAGE);
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
        setRows((current) =>
          offset === 0 ? page.rows : [...current, ...page.rows],
        );
        if (page.rows.length < PAGE) setDone(true);
      } catch (err) {
        onError(String(err));
        setDone(true);
      } finally {
        loading.current = false;
        setReading(false);
      }
    },
    [repoPath, onError],
  );

  useEffect(() => {
    setRows([]);
    setDone(false);
    setReading(true);
    loadPage(0);
  }, [loadPage]);

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
    const ground = getComputedStyle(host).getPropertyValue("--bg").trim() || "#111";
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
    }
  }, [rows, first, last, scrollTop, viewport, lanes]);

  const gutter = Math.min(lanes, 16) * LANE + LANE;

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
        <span className="history-count">
          {rows.length.toLocaleString()} of {total.toLocaleString()}
          {capped && "+"}
        </span>
        <button className="pane-close" onClick={onClose} title="Close (Escape)">
          ✕
        </button>
      </div>

      <div
        className="history-scroll"
        ref={scroller}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {/* The canvas is sticky rather than tall: it covers the viewport and is
            redrawn on scroll, so a repository with forty thousand commits never
            allocates a forty-thousand-row bitmap. */}
        <canvas className="history-canvas" ref={canvas} aria-hidden />

        {rows.length === 0 && !reading && <p className="empty">No commits here yet.</p>}
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
              disabled={disabled}
              onCommand={onCommand}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Row({
  row,
  top,
  gutter,
  swallowed,
  tipOf,
  disabled,
  onCommand,
}: {
  row: HistoryRow;
  top: number;
  gutter: number;
  /** Branches this commit is, under another name, through a squash. */
  swallowed: Squashed[] | null;
  /** Set when this row is the tip of a branch that was squashed onto the trunk. */
  tipOf: Squashed | null;
  disabled: boolean;
  onCommand: (command: string, typeOnly: boolean) => void;
}) {
  // `--no-pager` and `--stat`, for the reason the branch graph gives: `git show`
  // hands its output to a pager that holds the shell until you find out the way
  // out is `Q`, and a large commit floods the scrollback.
  const command = `git --no-pager show --stat ${row.short}`;

  return (
    <button
      className={`history-row${row.isMerge ? " merge" : ""}`}
      style={{ top, height: ROW }}
      disabled={disabled}
      onClick={(event) => onCommand(command, event.shiftKey)}
      title={`${row.summary}\n\n${row.author} · ${new Date(row.time * 1000).toLocaleString()}\n${row.id}\n\n${command}\nShift-click to type it without running it.`}
    >
      <span className="history-lanes" style={{ width: gutter }} />
      {row.refs.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className={`history-ref ${ref.kind}`}>
          {ref.name}
        </span>
      ))}
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
      <span className="history-when">{relativeTime(row.time)}</span>
      <span className="history-sha">{row.short}</span>
    </button>
  );
}
