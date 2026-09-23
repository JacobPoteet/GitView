import { describe, expect, it } from "vitest";
import { STEPS, advance, nextVisible, place } from "./tour";

describe("advance", () => {
  it("moves on the step's own event and on Next, and ignores the rest", () => {
    const select = STEPS.findIndex((s) => s.advanceOn === "select");
    expect(advance(select, "select")).toBe(select + 1);
    expect(advance(select, "next")).toBe(select + 1);
    expect(advance(select, "palette")).toBe(select);
  });

  it("does nothing past the end", () => {
    expect(advance(STEPS.length, "next")).toBe(STEPS.length);
  });
});

describe("nextVisible", () => {
  it("skips a step whose anchor is not on screen", () => {
    const inbox = STEPS.findIndex((s) => s.anchor === "inbox");
    expect(nextVisible(inbox, (a) => a !== "inbox")).toBe(inbox + 1);
    expect(nextVisible(0, () => true)).toBe(0);
  });

  it("finishes when nothing is left", () => {
    expect(nextVisible(0, () => false)).toBe(STEPS.length);
  });
});

describe("place", () => {
  const viewport = { width: 1480, height: 940 };
  const card = { width: 260, height: 160 };
  const sidebar = { left: 0, top: 80, width: 296, height: 700 };
  const terminal = { left: 296, top: 400, width: 884, height: 510 };

  it("goes to the right of the anchor when there is room", () => {
    expect(place(sidebar, card, viewport)).toEqual({ left: 308, top: 80 });
  });

  it("stays off a rect it is told to avoid", () => {
    const tall = { ...card, height: 400 };
    const spot = place(sidebar, tall, viewport, [terminal]);
    const covers =
      spot.left < terminal.left + terminal.width &&
      terminal.left < spot.left + tall.width &&
      spot.top < terminal.top + terminal.height &&
      terminal.top < spot.top + tall.height;
    expect(covers).toBe(false);
  });

  it("keeps a card for a small corner button inside the sidebar", () => {
    const inbox = { left: 169, top: 12, width: 24, height: 24 };
    const graph = { left: 296, top: 48, width: 884, height: 137 };
    const spot = place(inbox, { width: 260, height: 200 }, viewport, [
      { ...terminal, top: graph.top + graph.height },
    ]);
    expect(spot).toEqual({ left: 12, top: 48 });
  });

  it("falls back inside the anchor when nothing outside fits", () => {
    const whole = { left: 0, top: 0, width: 1480, height: 940 };
    const spot = place(whole, card, viewport);
    expect(spot.left).toBeGreaterThanOrEqual(12);
    expect(spot.top + card.height).toBeLessThanOrEqual(940 - 12);
  });
});
