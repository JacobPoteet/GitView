import { useCallback } from "react";
import { settings, updateSettings, useSetting } from "../lib/settings";
import { STEPS, advance, nextVisible, type TourEvent, type TourStep } from "../lib/tour";

export interface Tour {
  /** The step on screen, or null when the tour is finished or not due. */
  step: TourStep | null;
  /** Its position, for the "2 of 6" counter. */
  index: number;
  total: number;
  /** Something happened in the app. Moves the tour on if it is what the step asked for. */
  fire: (event: TourEvent) => void;
  close: () => void;
  replay: () => void;
}

/**
 * The first-run tour's progress, kept in the settings object so it survives a
 * restart halfway through and a replay is one write.
 *
 * `active` says whether the window has anything for the tour to point at yet:
 * it waits behind the welcome screen until there is a repository. `skip`
 * lists anchors that will never appear on this machine, such as the inbox
 * button without `gh`, so the tour steps over them and counts without them.
 */
export function useTour(active: boolean, skip: string[]): Tour {
  const stored = useSetting((s) => s.tour);
  const present = useCallback((anchor: string) => !skip.includes(anchor), [skip]);

  const at = nextVisible(stored.step, present);
  const shown = STEPS.filter((s) => present(s.anchor));
  const step = active && !stored.done && at < STEPS.length ? STEPS[at] : null;

  const fire = useCallback(
    (event: TourEvent) => {
      const tour = settings().tour;
      if (tour.done) return;
      const from = nextVisible(tour.step, present);
      const to = nextVisible(advance(from, event), present);
      if (to === from) return;
      updateSettings("tour", { step: to, done: to >= STEPS.length });
    },
    [present],
  );

  const close = useCallback(() => updateSettings("tour", { done: true }), []);
  const replay = useCallback(() => updateSettings("tour", { step: 0, done: false }), []);

  return {
    step,
    index: step ? shown.indexOf(step) : -1,
    total: shown.length,
    fire,
    close,
    replay,
  };
}
