import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ContextMenu, { useContextMenu, type MenuEntry } from "./ContextMenu";
import { quote, type ShellKind } from "../lib/shell";
import type { BranchGraph as Graph, BranchSummary, GraphCommit, Squashed } from "../lib/types";
import { relativeTime, signedTitle } from "../lib/types";

interface Props {
  graph: Graph | null;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Opens the whole history. The strip is an excerpt of it, forty commits each
   * way, so the way to the rest sits on the strip rather than among the header's
   * commands, where it was the one button that did not type anything.
   */
  onHistory: () => void;
  /** Set when the branch you are on was squash-merged into the base. */
  squashed: Squashed | null;
  /** Types a command in the repository's shell. Shift-click leaves it unrun. */
  onCommand: (command: string, typeOnly: boolean) => void;
  /** Opens the commit pane on a node. The click itself types nothing. */
  onOpen: (commit: { id: string; short: string }) => void;
  onCopy: (text: string, what: string) => void;
  /** Opens the tag dialog on a commit. The app owns it, as it owns the delete. */
  onTag: (commit: { id: string; short: string; summary: string }) => void;
  /** Opens the reset confirmation on a commit. The app owns it. */
  onReset: (commit: { id: string; short: string; summary: string }, mode: ResetMode) => void;
  /** Every local branch, so a commit that is a branch tip offers the branch. */
  branches: BranchSummary[];
  shell: ShellKind;
}

/** A local branch pointing at a commit, and whether you are on it. */
export interface TipOf {
  name: string;
  isHead: boolean;
}

/** What the commit menu needs from the surface that opens it. */
export interface CommitMenuContext {
  shell: ShellKind;
  /** The branch HEAD is on, or null when detached or unborn. */
  headBranch: string | null;
  onCommand: (command: string, typeOnly: boolean) => void;
  onCopy: (text: string, what: string) => void;
  /** Opens the tag dialog on a commit. The app owns it, as it owns the delete. */
  onTag: (commit: { id: string; short: string; summary: string }) => void;
  /** Asks first, and the app owns the dialog: a reset is the discard rule again. */
  onReset: (commit: { id: string; short: string; summary: string }, mode: ResetMode) => void;
}

export type ResetMode = "soft" | "mixed" | "hard";

/**
 * The commit menu, shared with the history pane's rows.
 *
 * `git checkout <sha>` detaches HEAD even when the sha is a branch tip, which
 * is how right-clicking main's newest commit left Jacob detached at the commit
 * he was already looking at. A commit that is the tip of a local branch offers
 * `git switch <branch>` for each, and the detached checkout says so in its
 * label rather than in the tooltip.
 *
 * Revert, cherry-pick and reset are the three commands a person runs with a
 * sha they would otherwise copy out of the list, which is the argument the
 * surface holds and the prompt does not. Cherry-pick is off for a commit HEAD
 * already reaches, since git would pause on an empty commit rather than say
 * so. Reset asks first, once per mode, so the dialog can say what each keeps.
 */
export function commitMenu(
  commit: { id: string; short: string; summary: string; isMerge?: boolean; inHead: boolean },
  tips: TipOf[],
  ctx: CommitMenuContext,
): MenuEntry[] {
  const { shell, headBranch, onCommand, onCopy, onTag, onReset } = ctx;
  const show = `git --no-pager show --stat ${commit.short}`;
  const checkout = `git checkout ${commit.short}`;
  // A merge has two parents and git will not guess which side to undo; -m 1
  // keeps the first, which is the branch the merge landed on.
  const revert = commit.isMerge ? `git revert -m 1 ${commit.short}` : `git revert ${commit.short}`;
  const pick = `git cherry-pick ${commit.short}`;
  const onto = headBranch ?? "HEAD";
  const resets: { mode: ResetMode; keeps: string }[] = [
    { mode: "soft", keeps: "keeps every change, staged" },
    { mode: "mixed", keeps: "keeps every change, unstaged" },
    { mode: "hard", keeps: "throws the changes away" },
  ];
  return [
    { label: "Show", title: show, run: (typeOnly) => onCommand(show, typeOnly) },
    {
      label: "Tag this commit",
      title: `git tag <name> ${commit.short}\n\nAsks for the name first, and offers the push.`,
      run: () => onTag(commit),
    },
    ...tips.map((tip): MenuEntry => {
      const command = `git switch ${quote(tip.name, shell)}`;
      return {
        label: `Switch to ${tip.name}`,
        title: tip.isHead ? "You are on it." : command,
        disabled: tip.isHead,
        run: (typeOnly) => onCommand(command, typeOnly),
      };
    }),
    {
      label: "Check out detached",
      title: `${checkout}\n\nLeaves HEAD at this commit and on no branch. git switch - comes back.`,
      run: (typeOnly) => onCommand(checkout, typeOnly),
    },
    "-",
    {
      label: "Revert this commit",
      title: `${revert}\n\nA new commit on ${onto} that undoes this one.${commit.isMerge ? " -m 1 keeps the side the merge landed on." : ""}`,
      run: (typeOnly) => onCommand(revert, typeOnly),
    },
    {
      label: `Cherry-pick onto ${onto}`,
      title: commit.inHead
        ? `${onto} already has this commit. git would pause on an empty cherry-pick.`
        : `${pick}\n\nReplays this commit on top of ${onto}.`,
      disabled: commit.inHead,
      run: (typeOnly) => onCommand(pick, typeOnly),
    },
    { label: `Reset ${onto} to here`, heading: true },
    ...resets.map(
      (r): MenuEntry => ({
        label: `${r.mode}: ${r.keeps}`,
        title: headBranch
          ? `git reset --${r.mode} ${commit.short}\n\nAsks first.`
          : "Detached: there is no branch to move.",
        danger: r.mode === "hard",
        disabled: !headBranch,
        run: () => onReset(commit, r.mode),
      }),
    ),
    "-",
    { label: "Copy SHA", title: commit.id, run: () => onCopy(commit.id, "the commit id") },
    { label: "Copy message", run: () => onCopy(commit.summary, "the message") },
  ];
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

export default function BranchGraph({
  graph,
  collapsed,
  squashed,
  onToggle,
  onHistory,
  onCommand,
  onOpen,
  onCopy,
  onTag,
  onReset,
  branches,
  shell,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const menu = useContextMenu<GraphCommit>();

  // The strip's refs are bare names, local, remote and tag alike, so the local
  // branch list is what says which of them can be switched to.
  const tipsOf = (commit: GraphCommit): TipOf[] =>
    branches
      .filter((b) => commit.refs.includes(b.name))
      .map((b) => ({ name: b.name, isHead: b.isHead }));
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
    <section className={`graph${collapsed ? " collapsed" : ""}`} data-tour="graph">
      <div className="graph-bar">
        <button
          className="graph-toggle"
          onClick={onToggle}
          title={collapsed ? "Expand the branch graph" : "Collapse the branch graph"}
        >
          <span className="graph-summary">{summary}</span>
          <span className="graph-chevron">{collapsed ? "▸" : "▾"}</span>
          {graph.unrelated && <span className="graph-note">no shared history</span>}
          {graph.truncated && <span className="graph-note">first 40 each way</span>}
        </button>
        <button className="graph-history" onClick={onHistory} title="Every commit on every branch">
          History
        </button>
      </div>

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
                  <Node
                    key={node.commit.id}
                    node={node}
                    captions={model.layout.captions}
                    detached={graph.detached}
                    onCommand={onCommand}
                    onOpen={onOpen}
                    onMenu={menu.open}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}

      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions for ${menu.menu.payload.short}`}
          entries={commitMenu(
            {
              ...menu.menu.payload,
              // The top rail past the fork is what the base has and you do
              // not; everything else on the strip is under HEAD.
              inHead: !graph?.theirs.some((c) => c.id === menu.menu?.payload.id),
            },
            tipsOf(menu.menu.payload),
            { shell, headBranch: graph?.detached ? null : (graph?.head ?? null), onCommand, onCopy, onTag, onReset },
          )}
          onClose={menu.close}
        />
      )}
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
  detached,
  onCommand,
  onOpen,
  onMenu,
}: {
  node: Placed;
  captions: boolean;
  detached: boolean;
  onCommand: (command: string, typeOnly: boolean) => void;
  onOpen: (commit: { id: string; short: string }) => void;
  onMenu: (event: ReactMouseEvent, commit: GraphCommit) => void;
}) {
  const { commit } = node;
  // A click opens the commit pane and types nothing. Shift-click keeps the
  // typed route, with `--no-pager` because `git show` hands its output to the
  // pager, which then holds the shell until you find out that the way out is Q.
  const command = `git --no-pager show --stat ${commit.short}`;
  return (
    <button
      className={`graph-node ${node.lane}${node.tip ? " tip" : ""}${node.head ? " head" : ""}${commit.isMerge ? " merge" : ""}${commit.signature ? " signed" : ""}`}
      style={{ left: node.x, top: node.y }}
      onClick={(event) =>
        event.shiftKey ? onCommand(command, true) : onOpen({ id: commit.id, short: commit.short })
      }
      onContextMenu={(event) => onMenu(event, commit)}
      title={`${node.head ? "You are on this commit.\n\n" : ""}${commit.short}  ${commit.summary}\n${commit.author}, ${relativeTime(commit.time)}\n${commit.signature ? `${signedTitle(commit.signature, commit.short)}\n` : ""}\nClick to read the commit.\nShift-click to type ${command} without running it.`}
    >
      <span className="graph-dot" />
      {/* The HEAD badge only earns its place when HEAD is detached: on a
          branch, the emphasised dot already says which commit you are on, and
          the badge would sit next to the branch name it duplicates. One row
          above the node rather than two absolute badges stacked on each other,
          so HEAD and a branch name on the same commit both stay read. */}
      {((node.head && detached) || commit.refs.length > 0) && (
        <span className="graph-refs">
          {node.head && detached && <span className="graph-ref head">HEAD</span>}
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
