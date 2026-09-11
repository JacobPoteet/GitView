import { useEffect, useState } from "react";

/**
 * What covers the grid while it assembles.
 *
 * The app renders its three columns empty, fills the sidebar from the cache in
 * one jump, then streams the scan row by row, and watching that happen is what
 * made a launch feel slow. This sits over it until the cache is in state and
 * fades out, so the first thing on screen is a settled window.
 *
 * The name is typed at a prompt once, after which the cursor just blinks. The
 * typing is the part that would wear out by the fortieth launch, and the
 * hairline underneath is what says something is still happening.
 */
export default function Splash({ done }: { done: boolean }) {
  // Mounted on its own timer rather than on `transitionend`, which does not
  // fire for an element that was covered when the transition began.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setGone(true), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [done]);

  if (gone) return null;
  return (
    <div className={`splash${done ? " exiting" : ""}`} aria-hidden="true">
      <div className="splash-prompt">
        <div className="splash-line">
          <span className="splash-chev">❯</span>
          <span className="splash-word">gitview</span>
          <span className="splash-cursor" />
        </div>
        <div className="splash-track" />
      </div>
    </div>
  );
}

/** Matches the transition in `.splash`. */
export const EXIT_MS = 220;
