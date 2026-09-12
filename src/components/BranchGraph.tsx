import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BranchGraph as Graph, GraphCommit, Squashed } from "../lib/types";
import { relativeTime } from "../lib/types";

interface Props {
  graph: Graph | null;
  collapsed: boolean;
  onToggle: () => void;
  /** Set when the branch you are on was squash-merged into the base. */
  squashed: Squashed | null;
  /** Types a command in the repository's shell. Shift-click leaves it unrun. */
  onCommand: (command: string, typeOnly: boolean) => void;
}

/**
 * Two rails, time running left to right.
 *
 * The top rail carries the shared history and then the base branch's own
 * commits, the bottom rail carries yours, and they part at the fork. Every
 * other git client draws lanes assigned by a packing algorithm, which answers
 * "what is the shape of this DAG". The question here is narrower: what does the
 * branch I am on have that main does not, and what does main have that I do not.
 * Two rails answer it without a legend.
 */

/** Wide enough to caption each node. Past this the rails go to bare dots. */
const WIDE_LIMIT = 7;

/**
 * `trunk` is a floor, not a count.
 *
 * It used to be the number of shared commits drawn, and two of them is what a
 * repository in sync with its base has to show: a strip that stopped a couple of
 * hundred pixels in and left the rest of the pane empty. The strip now measures
 * itself and spends whatever width the branch does not need on more history,
 * down to this many.
 */
/*
 * The two rails sit 84 px apart in the wide layout, not 62.
 *
 * Both rails put their commits in the same columns, so a caption hanging under
 * a top-rail node and a ref badge standing over the bottom-rail node beneath it
 * occupy the same strip of canvas. At 62 px they overlapped by about ten, which
 * only showed once a repository had commits on both sides at once. Two roots
 * with no shared history is the case that made it obvious.
 */
const LAYOUT = {
  wide: { gap: 122, trunk: 2, top: 38, bottom: 122, height: 172, captions: true },
  compact: { gap: 26, trunk: 8, top: 30, bottom: 68, height: 96, captions: false },
} as const;

const PAD_X = 66;

interface Placed {
  commit: GraphCommit;
  x: number;
  y: number;
  lane: "trunk" | "fork" | "theirs" | "ours";
  tip: boolean;
  /** The commit HEAD is on. Marked wherever it lands, including on the trunk. */
  head: boolean;
}

export default function BranchGraph({ graph, collapsed, squashed, onToggle, onCommand }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // How much history fits is a question about the pane, so the pane has to be
  // measured. Zero until the first observation, which `build` reads as "draw the
  // floor" rather than as "draw nothing". The scroller mounts with the graph,
  // so the observer has to be attached again when the graph arrives.
  const hasGraph = graph !== null;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [collapsed, hasGraph]);

  const model = useMemo(() => build(graph, width), [graph, width]);

  // Newest first. The right end is where the answer is, and a long branch would
  // otherwise open scrolled to history nobody asked about.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [model]);

  // Wheeling over a horizontal strip should move it sideways. Without this the
  // page swallows the gesture and the strip never scrolls.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      if (event.deltaX !== 0 || !el) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!graph) return null;

  const summary = describe(graph, squashed);

  return (
    <section className={`graph${collapsed ? " collapsed" : ""}`}>
      <button className="graph-bar" onClick={onToggle} title="Collapse the branch graph">
        <span className="graph-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="graph-summary">{summary}</span>
        {graph.unrelated && <span className="graph-note">no shared history</span>}
        {graph.truncated && <span className="graph-note">first 40 each way</span>}
      </button>

      {!collapsed &&
        (graph.error ? (
          <p className="empty">{graph.error}</p>
        ) : model.nodes.length === 0 ? (
          <p className="empty">No commits here yet.</p>
        ) : (
          <div className="graph-body">
            <div className="graph-gutter" style={{ height: model.height }}>
              <Label
                y={model.layout.top}
                name={graph.base ?? "no base"}
                count={graph.theirs.length}
                arrow={graph.unrelated ? "" : "↓"}
                kind="base"
              />
              {/* With nothing of your own ahead of the base, HEAD sits on the
                  fork and there is no second rail. Labelling an empty line
                  reads as a rail that failed to draw. */}
              {graph.ours.length > 0 && (
                <Label
                  y={model.layout.bottom}
                  name={graph.head ?? "HEAD"}
                  count={graph.ours.length}
                  arrow={graph.unrelated ? "" : "↑"}
                  kind="head"
                />
              )}
            </div>

            <div className="graph-scroll" ref={scroller}>
              <div
                className="graph-canvas"
                style={{ width: model.width, height: model.height }}
              >
                <svg width={model.width} height={model.height} aria-hidden>
                  {model.rails.map((rail) => (
                    <path key={rail.key} d={rail.d} className={`rail ${rail.key}`} />
                  ))}
                </svg>

                {model.nodes.map((node) => (
                  <Node key={node.commit.id} node={node} captions={model.layout.captions} onCommand={onCommand} />
                ))}
              </div>
            </div>
          </div>
        ))}
    </section>
  );
}

function Label({
  y,
  name,
  count,
  arrow,
  kind,
}: {
  y: number;
  name: string;
  count: number;
  arrow: string;
  kind: string;
}) {
  return (
    <span className={`graph-label ${kind}`} style={{ top: y }}>
      <span className="graph-label-name" title={name}>
        {name}
      </span>
      {count > 0 && (
        <span className="graph-label-count">
          {arrow}
          {count}
        </span>
      )}
    </span>
  );
}

function Node({
  node,
  captions,
  onCommand,
}: {
  node: Placed;
  captions: boolean;
  onCommand: (command: string, typeOnly: boolean) => void;
}) {
  const { commit } = node;
  // `git show` hands its output to the pager, which then holds the shell until
  // you find out that the way out is Q. The strip is a place you click to read a
  // commit message, not a place to open a reader, so this prints and returns to
  // the prompt. The full diff is one `git show` away in the same shell.
  const command = `git --no-pager show --stat ${commit.short}`;
  return (
    <button
      className={`graph-node ${node.lane}${node.tip ? " tip" : ""}${node.head ? " head" : ""}${commit.isMerge ? " merge" : ""}`}
      style={{ left: node.x, top: node.y }}
      onClick={(event) => onCommand(command, event.shiftKey)}
      title={`${node.head ? "You are on this commit.\n\n" : ""}${commit.short}  ${commit.summary}\n${commit.author}, ${relativeTime(commit.time)}\n\n${command}\nShift-click to type it without running it.`}
    >
      <span className="graph-dot" />
      {/* One row above the node rather than two absolute badges stacked on each
          other, so HEAD and a branch name on the same commit both stay read. */}
      {(node.head || commit.refs.length > 0) && (
        <span className="graph-refs">
          {node.head && <span className="graph-ref head">HEAD</span>}
          {commit.refs.length > 0 && <span className="graph-ref">{commit.refs[0]}</span>}
        </span>
      )}
      {captions && (
        <span className="graph-caption">
          <span className="sha">{commit.short}</span>
          <span className="msg">{commit.summary}</span>
        </span>
      )}
    </button>
  );
}

/**
 * Turns the three lists into placed nodes and the paths that join them.
 *
 * `available` is the measured width of the scroller. The branch is drawn in
 * full and whatever is left over goes to shared history, so a repository in sync
 * with its base fills the strip with the trunk rather than stopping two commits
 * in. Zero means unmeasured, and the floors in `LAYOUT` apply.
 */
function build(graph: Graph | null, available: number) {
  const empty = {
    nodes: [] as Placed[],
    rails: [] as { key: string; d: string }[],
    width: 0,
    height: LAYOUT.compact.height,
    layout: LAYOUT.compact,
  };
  if (!graph) return empty;

  const spread = Math.max(graph.ours.length, graph.theirs.length);
  const layout = spread <= WIDE_LIMIT ? LAYOUT.wide : LAYOUT.compact;

  // Columns that fit without scrolling. The branch has first claim on them.
  const fits =
    available > 0
      ? Math.max(1, Math.floor((available - PAD_X * 2) / layout.gap) + 1)
      : layout.trunk + spread;
  const room = Math.max(layout.trunk, fits - spread);

  // Unrelated histories have no shared commits and no fork. Two branches that
  // never met are two independent rails, and drawing a trunk under them would
  // put the pair's supposed parting at a commit only one of them can reach.
  const trunk = graph.unrelated ? [] : graph.trunk.slice(-room);
  const x = (column: number) => PAD_X + column * layout.gap;
  // Which node you are standing on. The tip of `ours` most of the time, but a
  // repository level with its base has no `ours` and a detached HEAD can be any
  // node on screen, and those are the two cases the strip could not answer.
  const isHead = (commit: GraphCommit) => commit.id === graph.headId;

  const nodes: Placed[] = [];

  trunk.forEach((commit, i) => {
    const last = i === trunk.length - 1;
    nodes.push({
      commit,
      x: x(i),
      y: layout.top,
      // The last shared commit is the fork, and it earns a different mark: it is
      // the answer to "when did these two part".
      lane: last && (graph.ours.length > 0 || graph.theirs.length > 0) ? "fork" : "trunk",
      tip: false,
      head: isHead(commit),
    });
  });

  const start = trunk.length;
  graph.theirs.forEach((commit, i) => {
    nodes.push({
      commit,
      x: x(start + i),
      y: layout.top,
      lane: "theirs",
      tip: i === graph.theirs.length - 1,
      head: isHead(commit),
    });
  });
  graph.ours.forEach((commit, i) => {
    nodes.push({
      commit,
      x: x(start + i),
      y: layout.bottom,
      lane: "ours",
      tip: i === graph.ours.length - 1,
      head: isHead(commit),
    });
  });

  const hasFork = trunk.length > 0;
  const forkX = x(hasFork ? trunk.length - 1 : 0);
  const rails: { key: string; d: string }[] = [];

  if (trunk.length > 1) {
    rails.push({ key: "trunk", d: `M ${x(0)} ${layout.top} H ${forkX}` });
  }
  if (graph.theirs.length > 0) {
    const from = hasFork ? forkX : x(0);
    rails.push({
      key: "theirs",
      d: `M ${from} ${layout.top} H ${x(start + graph.theirs.length - 1)}`,
    });
  }
  if (graph.ours.length > 0) {
    const last = x(start + graph.ours.length - 1);
    if (hasFork) {
      const first = x(start);
      const bend = Math.min(layout.gap * 0.6, 46);
      rails.push({
        key: "ours",
        d:
          `M ${forkX} ${layout.top} C ${forkX + bend} ${layout.top} ${first - bend} ${layout.bottom} ${first} ${layout.bottom}` +
          ` H ${last}`,
      });
    } else {
      // Nothing to bend away from.
      rails.push({ key: "ours", d: `M ${x(0)} ${layout.bottom} H ${last}` });
    }
  }

  const columns = trunk.length + spread;
  const width = PAD_X * 2 + Math.max(columns - 1, 0) * layout.gap;

  // With no second rail the strip only needs room for the top one, and the
  // terminal gets the rest. Being in sync is the common case here.
  const height =
    graph.ours.length === 0 ? layout.top + (layout.captions ? 62 : 26) : layout.height;

  return { nodes, rails, width, height, layout };
}

function describe(graph: Graph, squashed: Squashed | null): string {
  if (graph.error) return "Unreadable";
  const head = graph.head ?? "HEAD";
  if (graph.baseKind === "none") {
    return graph.detached ? `Detached at ${head}` : `${head}, nothing to compare against`;
  }
  const base = graph.base ?? "the base";
  if (graph.unrelated) {
    return `${head} and ${base} share no history`;
  }
  // Ahead of the base and already on it under another commit. Saying only
  // "3 ahead" here is what makes a squash-merged branch look like unfinished
  // work for as long as it sits in the list.
  if (squashed) {
    return `${head} was squashed into ${squashed.intoShort} on ${base}`;
  }
  const parts: string[] = [];
  if (graph.ours.length > 0) parts.push(`${graph.ours.length} ahead`);
  if (graph.theirs.length > 0) parts.push(`${graph.theirs.length} behind`);
  if (parts.length === 0) return `${head} matches ${base}`;
  return `${head} is ${parts.join(" and ")} of ${base}`;
}
