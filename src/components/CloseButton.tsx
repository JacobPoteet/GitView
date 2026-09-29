/**
 * The X in a pane's or a dialog's top right. One drawn cross, one hit area and
 * one name for every surface that closes, so "everything closes with the X" is
 * a component rather than seven copies of a glyph. Some had a `✕`, one a `×`
 * and the terminal an SVG with no accessible name at all.
 */
interface Props {
  onClick: () => void;
  /** What closing means here, when it is not simply closing: "End the tour". */
  label?: string;
  /** Names Escape, for the surfaces that close on it. The terminal's tab does not. */
  escape?: boolean;
  /** Overrides the tooltip, for a close that has a longer story. */
  title?: string;
}

export default function CloseButton({ onClick, label = "Close", escape = true, title }: Props) {
  return (
    <button
      type="button"
      className="pane-close"
      onClick={onClick}
      title={title ?? (escape ? `${label} (Escape)` : label)}
      aria-label={label}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}
