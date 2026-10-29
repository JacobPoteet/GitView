import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { FileDiff } from "../lib/types";

/** Where an image's bytes come from: a commit, or a side of the index. */
export interface ImageSource {
  repoPath: string;
  staged: boolean;
  /** A commit, read against its first parent. Null for the working tree. */
  sha: string | null;
}

/** The backend refuses past this too. Twenty megabytes is a large photograph. */
const MAX_IMAGE = 20 * 1024 * 1024;

type Mode = "side" | "swipe" | "onion" | "diff";

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: "side", label: "side by side", title: "Before and after next to each other" },
  { id: "swipe", label: "swipe", title: "Drag a divider across the pair" },
  { id: "onion", label: "onion skin", title: "Fade the after image over the before" },
  { id: "diff", label: "difference", title: "Pixels that differ are bright, the rest is black" },
];

/** Kept for the session so walking through a folder of images does not reset it. */
let rememberedMode: Mode = "side";

interface Loaded {
  url: string;
  width: number;
  height: number;
  size: number;
}

interface Pair {
  before: Loaded | null;
  after: Loaded | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function release(pair: Pair | null) {
  if (pair?.before) URL.revokeObjectURL(pair.before.url);
  if (pair?.after) URL.revokeObjectURL(pair.after.url);
}

/**
 * An image in the diff pane: the one image of an added or deleted file, and
 * both of a changed one, in the mode the reader picks.
 *
 * The bytes arrive as a raw response and become object URLs, so nothing is
 * base64 and nothing is written to disk. An `<img>` never runs a script, which
 * is what makes an SVG from a repository safe to draw.
 */
export default function ImageDiff({ diff, source }: { diff: FileDiff; source: ImageSource }) {
  const info = diff.image;
  const [mode, setModeState] = useState<Mode>(rememberedMode);
  const [fit, setFit] = useState(true);
  const [amount, setAmount] = useState(50);
  const [pair, setPair] = useState<Pair | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const held = useRef<Pair | null>(null);

  function setMode(next: Mode) {
    rememberedMode = next;
    setModeState(next);
  }

  const oldSize = info?.oldSize ?? null;
  const newSize = info?.newSize ?? null;
  const oversize =
    (oldSize !== null && oldSize > MAX_IMAGE) || (newSize !== null && newSize > MAX_IMAGE);

  useEffect(() => {
    if (!info || oversize) return;
    let cancelled = false;

    async function read(newSide: boolean, size: number): Promise<Loaded> {
      const buffer = await api.repoDiffImage(
        source.repoPath,
        diff.path,
        source.staged,
        source.sha,
        newSide,
      );
      const url = URL.createObjectURL(new Blob([buffer], { type: info!.mime }));
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        URL.revokeObjectURL(url);
        throw new Error("The webview could not decode this image.");
      }
      return { url, width: img.naturalWidth, height: img.naturalHeight, size };
    }

    Promise.allSettled([
      oldSize !== null ? read(false, oldSize) : Promise.resolve(null),
      newSize !== null ? read(true, newSize) : Promise.resolve(null),
    ]).then(([before, after]) => {
      const next: Pair = {
        before: before.status === "fulfilled" ? before.value : null,
        after: after.status === "fulfilled" ? after.value : null,
      };
      if (cancelled) {
        release(next);
        return;
      }
      const reason = [before, after].find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      // The previous pair stays up until this one lands, so an edit made at
      // the prompt swaps the picture rather than flashing the pane empty.
      release(held.current);
      held.current = next;
      setPair(next);
      setFailure(reason ? String(reason.reason) : null);
    });

    return () => {
      cancelled = true;
    };
    // The diff object is new on every read, which is the signal the file may
    // have changed even when its size did not.
  }, [diff, info, oversize, oldSize, newSize, source.repoPath, source.staged, source.sha]);

  useEffect(
    () => () => {
      release(held.current);
      held.current = null;
    },
    [],
  );

  if (!info) return null;

  const removed = diff.status === "deleted";
  const both = oldSize !== null && newSize !== null;
  const before = pair?.before ?? null;
  const after = pair?.after ?? null;
  const shown = [before, after].filter((side): side is Loaded => side !== null);
  const boxW = Math.max(1, ...shown.map((side) => side.width));
  const boxH = Math.max(1, ...shown.map((side) => side.height));

  function caption(side: Loaded | null, size: number | null, name: string) {
    return (
      <figcaption>
        <span className="image-name">{name}</span>
        {side ? ` ${side.width}×${side.height}` : ""}
        {size !== null ? ` · ${formatBytes(size)}` : ""}
      </figcaption>
    );
  }

  function single(side: Loaded | null, size: number | null, name: string) {
    return (
      <figure className="image-one">
        <div className="image-frame checker">
          {side && (
            <img
              src={side.url}
              alt={name}
              className={fit ? "fit" : "actual"}
              draggable={false}
            />
          )}
        </div>
        {caption(side, size, name)}
      </figure>
    );
  }

  // The file view hands over an image with nothing uncommitted, which has one
  // side without being new.
  const label = removed ? "removed" : diff.status === "unchanged" ? "on disk" : "new";

  return (
    <div className="image-diff">
      <div className="image-bar">
        {both && (
          <span className="image-modes" role="group" aria-label="Comparison mode">
            {MODES.map((entry) => (
              <button
                key={entry.id}
                className={mode === entry.id ? "on" : ""}
                aria-pressed={mode === entry.id}
                title={entry.title}
                onClick={() => setMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </span>
        )}
        {(mode === "swipe" || mode === "onion") && both && (
          <input
            className="image-slider"
            type="range"
            min={0}
            max={100}
            value={amount}
            aria-label={mode === "swipe" ? "Divider position" : "After image opacity"}
            onChange={(event) => setAmount(Number(event.target.value))}
          />
        )}
        <span className="image-spacer" />
        <button
          className="image-fit"
          aria-pressed={!fit}
          onClick={() => setFit((value) => !value)}
          title={fit ? "Show at the pixels the file has" : "Shrink to fit the pane"}
        >
          {fit ? "fit" : "1:1"}
        </button>
      </div>

      {oversize && (
        <p className="empty">
          Too large to preview here: {oldSize !== null ? `before ${formatBytes(oldSize)}` : ""}
          {oldSize !== null && newSize !== null ? ", " : ""}
          {newSize !== null ? `after ${formatBytes(newSize)}` : ""}. The limit is{" "}
          {formatBytes(MAX_IMAGE)} a side.
        </p>
      )}

      {failure && <p className="image-failure">{failure}</p>}

      {!oversize && !both && (
        <div className="image-solo">
          {removed
            ? single(before, oldSize, label)
            : single(after, newSize, label)}
        </div>
      )}

      {!oversize && both && mode === "side" && (
        <div className="image-pair">
          <figure>
            <div className="image-frame checker">
              {before && (
                <img src={before.url} alt="before" className={fit ? "fit" : "actual"} draggable={false} />
              )}
            </div>
            {caption(before, oldSize, "before")}
          </figure>
          <figure>
            <div className="image-frame checker">
              {after && (
                <img src={after.url} alt="after" className={fit ? "fit" : "actual"} draggable={false} />
              )}
            </div>
            {caption(after, newSize, "after")}
          </figure>
        </div>
      )}

      {!oversize && both && mode !== "side" && (
        <div className="image-stackwrap">
          <div
            className={`image-stack${mode === "diff" ? " dark" : " checker"}`}
            style={{
              width: fit ? `min(100%, ${boxW}px)` : `${boxW}px`,
              aspectRatio: `${boxW} / ${boxH}`,
            }}
          >
            {before && <img src={before.url} alt="before" draggable={false} />}
            {after && (
              <img
                src={after.url}
                alt="after"
                draggable={false}
                className={mode === "diff" ? "blend" : undefined}
                style={
                  mode === "swipe"
                    ? { clipPath: `inset(0 0 0 ${amount}%)` }
                    : mode === "onion"
                      ? { opacity: amount / 100 }
                      : undefined
                }
              />
            )}
            {mode === "swipe" && <span className="image-divider" style={{ left: `${amount}%` }} />}
          </div>
          <p className="image-caption-row">
            <span>
              <span className="image-name">before</span>
              {before ? ` ${before.width}×${before.height}` : ""} · {formatBytes(oldSize)}
            </span>
            <span>
              <span className="image-name">after</span>
              {after ? ` ${after.width}×${after.height}` : ""} · {formatBytes(newSize)}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
