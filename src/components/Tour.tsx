import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { place, type Rect, type TourStep } from "../lib/tour";

interface Props {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onClose: () => void;
}

const WIDTH = 260;

function rectOf(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0
    ? null
    : { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * One step of the tour: a ring around the thing it is about, and a card beside
 * it.
 *
 * Nothing here blocks the window. The ring takes no pointer events, so what it
 * circles is still what you click, and the step that asks you to run something
 * leaves the prompt yours. The card stays off the terminal unless the terminal
 * is the subject, so the shell is never covered, the same rule every pane
 * follows. A step whose target is not on screen draws nothing until it is.
 */
export default function Tour({ step, index, total, onNext, onClose }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);

  // Following the anchor. Panes open, columns get dragged and the sidebar
  // fills as the sweep lands, so a rect read once goes stale; an observer on
  // the anchor and the body, plus the window's resize, covers what moves it.
  useEffect(() => {
    const selector = `[data-tour="${step.anchor}"]`;
    let observed: Element | null = null;
    const measure = () => {
      const el = document.querySelector(selector);
      if (el !== observed) {
        if (observed) observer.unobserve(observed);
        if (el) observer.observe(el);
        observed = el;
      }
      const next = rectOf(el);
      // The mutation observer fires for every node the app touches, so an
      // unchanged rect must not cost a render.
      setAnchor((current) =>
        current &&
        next &&
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    // An anchor that mounts later, such as the graph once a repository is
    // picked, changes no size the observer is watching.
    const mutations = new MutationObserver(measure);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [step.anchor]);

  useLayoutEffect(() => {
    if (!anchor || !card.current) {
      setSpot(null);
      return;
    }
    const terminal =
      step.anchor === "terminal" ? null : rectOf(document.querySelector('[data-tour="terminal"]'));
    const next = place(
      anchor,
      { width: WIDTH, height: card.current.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      terminal ? [terminal] : [],
    );
    setSpot((current) =>
      current && current.left === next.left && current.top === next.top ? current : next,
    );
  }, [anchor, step]);

  // Escape ends the tour, unless it belongs to something else on screen: a
  // dialog, the palette or a menu takes it first, and in the terminal it is
  // the shell's. Heard in the capture phase, before React's own handlers: the
  // palette closes itself during the bubble, and by the time a bubbling
  // listener looked for it the Escape that closed it would end the tour too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as Element | null;
      if (target?.closest?.(".xterm")) return;
      if (document.querySelector('[aria-modal="true"], .row-menu')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!anchor) return null;
  const last = index === total - 1;

  return (
    <>
      <div
        className="tour-ring"
        aria-hidden="true"
        style={{
          left: anchor.left,
          top: anchor.top,
          width: anchor.width,
          height: anchor.height,
        }}
      />
      <div
        ref={card}
        className="tour-card"
        role="region"
        aria-label="Tour"
        aria-live="polite"
        style={{
          width: WIDTH,
          left: spot?.left ?? -9999,
          top: spot?.top ?? -9999,
        }}
      >
        <div className="tour-head">
          <span className="tour-count">
            {index + 1} of {total}
          </span>
          <button
            type="button"
            className="pane-close"
            onClick={onClose}
            title="End the tour (Escape)"
            aria-label="End the tour"
          >
            ✕
          </button>
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        {step.action && <p className="tour-action">{step.action}</p>}
        <div className="tour-foot">
          <button className="btn accent" onClick={last ? onClose : onNext}>
            {last ? "Done" : step.action ? "Skip" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}
