import { useRef, type PointerEvent } from "react";

interface Props {
  /** The shell's share of the column, in percent, when the drag starts. */
  value: number;
  min: number;
  max: number;
  /** Called as the pointer moves, with the share already clamped. */
  onDrag: (percent: number) => void;
  /** Called once, when the pointer lifts. */
  onDrop: (percent: number) => void;
  onReset: () => void;
  /** Selector of the ancestor whose height the share is measured against. Default: the parent. */
  scope?: string;
  label?: string;
}

/**
 * The handle between a pane and the shell under it, the horizontal twin of
 * `Splitter`. It measures its parent, the main column, so the share it reports
 * is the shell's part of that column whatever the header above takes.
 */
export default function RowSplitter({
  value,
  min,
  max,
  onDrag,
  onDrop,
  onReset,
  scope,
  label = "Pane height",
}: Props) {
  const dragging = useRef(false);

  function share(event: PointerEvent<HTMLDivElement>): number {
    const el = event.currentTarget;
    const box = (scope ? el.closest(scope) : el.parentElement)?.getBoundingClientRect();
    if (!box || box.height <= 0) return value;
    const percent = ((box.bottom - event.clientY) / box.height) * 100;
    return Math.round(Math.min(max, Math.max(min, percent)));
  }

  return (
    <div
      className="splitter row"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title="Drag to resize. Double-click for the default."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser is not tracking, which only a script produces.
        }
        dragging.current = true;
      }}
      onPointerMove={(event) => {
        if (dragging.current) onDrag(share(event));
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        onDrop(share(event));
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onDoubleClick={onReset}
    />
  );
}
