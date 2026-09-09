import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { BranchGraph as Graph, GraphCommit } from "../lib/types";
import { relativeTime } from "../lib/types";

interface Props {
  graph: Graph | null;
  collapsed: boolean;
  onToggle: () => void;
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

const LAYOUT = {
  wide: { gap: 122, trunk: 2, top: 38, bottom: 100, height: 150, captions: true },
  compact: { gap: 26, trunk: 8, top: 30, bottom: 68, height: 96, captions: false },
} as const;

const PAD_X = 66;

interface Placed {
  commit: GraphCommit;
  x: number;
  y: number;
  lane: "trunk" | "fork" | "theirs" | "ours";
  tip: boolean;
}

export default function BranchGraph({ graph, collapsed, onToggle, onCommand }: Props) {
  const scroller = useRef<HTMLDivElement>(null);

  const model = useMemo(() => build(graph), [graph]);

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

  const summary = describe(graph);

  return (
    <section className={`graph${collapsed ? " collapsed" : ""}`}>
      <button className="graph-bar" onClick={onToggle} title="Collapse the branch graph">
        <span className="graph-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="graph-summary">{summary}</span>
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
                arrow="↓"
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
                  arrow="↑"
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
  const command = `git show ${commit.short}`;
  return (
    <button
      className={`graph-node ${node.lane}${node.tip ? " tip" : ""}${commit.isMerge ? " merge" : ""}`}
      style={{ left: node.x, top: node.y }}
      onClick={(event) => onCommand(command, event.shiftKey)}
      title={`${commit.short}  ${commit.summary}\n${commit.author}, ${relativeTime(commit.time)}\n\n${command}\nShift-click to type it without running it.`}
    >
      <span className="graph-dot" />
      {commit.refs.length > 0 && <span className="graph-ref">{commit.refs[0]}</span>}
      {captions && (
        <span className="graph-caption">
          <span className="sha">{commit.short}</span>
          <span className="msg">{commit.summary}</span>
        </span>
      )}
    </button>
  );
}

/** Turns the three lists into placed nodes and the paths that join them. */
function build(graph: Graph | null) {
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

  const trunk = graph.trunk.slice(-layout.trunk);
  const x = (column: number) => PAD_X + column * layout.gap;

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
    });
  });

  const forkColumn = trunk.length - 1;
  graph.theirs.forEach((commit, i) => {
    nodes.push({
      commit,
      x: x(forkColumn + 1 + i),
      y: layout.top,
      lane: "theirs",
      tip: i === graph.theirs.length - 1,
    });
  });
  graph.ours.forEach((commit, i) => {
    nodes.push({
      commit,
      x: x(forkColumn + 1 + i),
      y: layout.bottom,
      lane: "ours",
      tip: i === graph.ours.length - 1,
    });
  });

  const forkX = x(Math.max(forkColumn, 0));
  const rails: { key: string; d: string }[] = [];

  if (trunk.length > 1) {
    rails.push({ key: "trunk", d: `M ${x(0)} ${layout.top} H ${forkX}` });
  }
  if (graph.theirs.length > 0) {
    rails.push({
      key: "theirs",
      d: `M ${forkX} ${layout.top} H ${x(forkColumn + graph.theirs.length)}`,
    });
  }
  if (graph.ours.length > 0) {
    const first = x(forkColumn + 1);
    const bend = Math.min(layout.gap * 0.6, 46);
    rails.push({
      key: "ours",
      d:
        `M ${forkX} ${layout.top} C ${forkX + bend} ${layout.top} ${first - bend} ${layout.bottom} ${first} ${layout.bottom}` +
        ` H ${x(forkColumn + graph.ours.length)}`,
    });
  }

  const columns = trunk.length + spread;
  const width = PAD_X * 2 + Math.max(columns - 1, 0) * layout.gap;

  // With no second rail the strip only needs room for the top one, and the
  // terminal gets the rest. Being in sync is the common case here.
  const height =
    graph.ours.length === 0 ? layout.top + (layout.captions ? 62 : 26) : layout.height;

  return { nodes, rails, width, height, layout };
}

function describe(graph: Graph): string {
  if (graph.error) return "Unreadable";
  const head = graph.head ?? "HEAD";
  if (graph.baseKind === "none") {
    return graph.detached ? `Detached at ${head}` : `${head}, nothing to compare against`;
  }
  const base = graph.base ?? "the base";
  const parts: string[] = [];
  if (graph.ours.length > 0) parts.push(`${graph.ours.length} ahead`);
  if (graph.theirs.length > 0) parts.push(`${graph.theirs.length} behind`);
  if (parts.length === 0) return `${head} matches ${base}`;
  return `${head} is ${parts.join(" and ")} of ${base}`;
}
