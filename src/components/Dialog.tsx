import type { FormEvent, ReactNode } from "react";

interface Props {
  /** What assistive tech calls it, and the heading unless `title` says otherwise. */
  label: string;
  /** The heading, when it carries more than the label: a count, a "stopped" tail. */
  title?: ReactNode;
  /** Widths and layouts the stylesheet keys on: `wide`, `settings`, `update`. */
  className?: string;
  onClose: () => void;
  /**
   * False takes the X away and makes the backdrop inert. Only a batch still
   * running asks for it: its dialog is the one place the commands it is about
   * to type are named.
   */
  closable?: boolean;
  /** Makes the body a form, so Enter in a field submits. */
  onSubmit?: () => void;
  /** The row of buttons at the foot. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * The chrome every dialog shares: the backdrop that closes on a click outside,
 * the heading with the X in its top right, and the action row. One copy, so
 * the rule that everything closes with the X is kept in one place rather than
 * in every dialog that follows it. `Escape` is not here: `App` handles it,
 * since that handler has to know what is on top.
 */
export default function Dialog({
  label,
  title,
  className,
  onClose,
  closable = true,
  onSubmit,
  actions,
  children,
}: Props) {
  const body = (
    <>
      <h2>
        {title ?? label}
        {closable && (
          <button
            type="button"
            className="pane-close"
            onClick={onClose}
            title="Close (Escape)"
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </h2>
      {children}
      {actions && <div className="confirm-actions">{actions}</div>}
    </>
  );
  const classes = className ? `confirm ${className}` : "confirm";
  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={(e) => closable && e.target === e.currentTarget && onClose()}
    >
      {onSubmit ? (
        <form
          className={classes}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        <div className={classes} role="dialog" aria-modal="true" aria-label={label}>
          {body}
        </div>
      )}
    </div>
  );
}
