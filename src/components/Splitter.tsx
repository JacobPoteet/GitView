import { useRef, type PointerEvent } from "react";

interface Props {
  /** Which column the handle resizes, which is also which edge it sits on. */
  side: "sidebar" | "changes";
  /** The column's width when the drag starts. */
  width: number;
  min: number;
  max: number;
  /** Called as the pointer moves, with the width already clamped. */
  onDrag: (width: number) => void;
  /** Called once, when the pointer lifts. */
  onDrop: (width: number) => void;
  onReset: () => void;
  /** The narrowest the main column may become, measured by the caller. */
  mainMin: () => number;
  /** The other column's current width, so the two together leave the main column its floor. */
  other: number;
}

/**
 * A drag handle on a column edge.
 *
 * Six pixels wide and straddling the border, so the border is the target and
 * the handle never shows as a bar. The pointer is captured for the drag, which
 * is what keeps a fast drag from losing the handle when the pointer outruns it.
 * Double-click puts the default width back. The handle carries no state: the
 * caller sets the width as it is dragged and stores it when it drops.
 */
export default function Splitter({
  side,
  width,
  min,
  max,
  onDrag,
  onDrop,
  onReset,
  mainMin,
  other,
}: Props) {
  const start = useRef<{ x: number; width: number; floor: number } | null>(null);

  function clamp(next: number, floor: number): number {
    // The main column keeps its floor: whatever the sidebar and the changes
    // column take between them, the terminal keeps its 80 columns.
    const room = window.innerWidth - other - floor;
    return Math.round(Math.min(max, room, Math.max(min, next)));
  }

  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser is not tracking, which only a script produces.
    }
    start.current = { x: event.clientX, width, floor: mainMin() };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    onDrag(clamp(start.current.width + (side === "sidebar" ? dx : -dx), start.current.floor));
  }

  function up(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const next = clamp(start.current.width + (side === "sidebar" ? dx : -dx), start.current.floor);
    start.current = null;
    onDrop(next);
  }

  return (
    <div
      className={`splitter ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "sidebar" ? "Sidebar width" : "Changes column width"}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      title="Drag to resize. Double-click for the default."
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
      }}
      onDoubleClick={onReset}
    />
  );
}
