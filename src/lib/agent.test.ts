import { describe, expect, it } from "vitest";
import { asksForInput, settle, strongest, titleActivity } from "./agent";

describe("titleActivity", () => {
  it("reads the titles Claude Code 2.1.282 set, in the order it set them", () => {
    expect(titleActivity("claude")).toBeNull();
    expect(titleActivity("✳ Claude Code")).toBe("idle");
    expect(titleActivity("◐ Claude Code")).toBe("working");
    expect(titleActivity("◑ Echo probe-123")).toBe("working");
    expect(titleActivity("✳ Echo probe-123")).toBe("idle");
    expect(titleActivity("")).toBeNull();
  });

  it("reads the braille spinner earlier versions drew", () => {
    expect(titleActivity("⠂ Fix the build")).toBe("working");
  });

  it("leaves a shell's own title alone", () => {
    expect(titleActivity("Windows PowerShell")).toBeNull();
    expect(titleActivity("F:\\GitHub\\GitView")).toBeNull();
    expect(titleActivity("✳Claude")).toBeNull();
  });
});

describe("asksForInput", () => {
  const permission = [
    "Do you want to create probe.txt?",
    "❯ 1. Yes",
    "  2. Yes, and allow Claude to edit files in its ~/.claude folder for this session",
    "  3. No",
    "",
    "Esc to cancel · Tab to amend",
  ];

  it("sees a permission request", () => {
    expect(asksForInput(permission)).toBe(true);
  });

  it("sees the prompt after a turn as nothing", () => {
    expect(
      asksForInput([
        "● I ran echo probe-123 in Bash and it printed probe-123.",
        "✻ Sautéed for 4s · done 10:18 PM",
        "────────",
        "❯ ",
        "────────",
        "  ⏸ manual mode on · ← for agents",
      ]),
    ).toBe(false);
  });

  it("only looks at the bottom of the screen", () => {
    expect(asksForInput([...permission, ...Array(12).fill("scrolled past")])).toBe(false);
  });
});

describe("settle", () => {
  it("walks one turn: launch, work, finish", () => {
    let state = settle(null, "idle", false);
    expect(state).toBeNull();
    state = settle(state, "working", false);
    expect(state).toBe("running");
    state = settle(state, "idle", false);
    expect(state).toBe("done");
  });

  it("walks a turn that stops to ask", () => {
    expect(settle("running", "idle", true)).toBe("waiting");
    expect(settle("waiting", "working", false)).toBe("running");
    // Escape at the question stops the turn, which is a finished one.
    expect(settle("waiting", "idle", false)).toBe("done");
  });

  it("keeps a finished turn finished until it is seen", () => {
    expect(settle("done", "idle", false)).toBe("done");
  });

  it("clears on a title that is not an agent's", () => {
    expect(settle("running", null, false)).toBeNull();
    expect(settle("done", null, false)).toBeNull();
  });
});

describe("strongest", () => {
  it("ranks a question over a finished turn over work", () => {
    expect(strongest(["running", "done"])).toBe("done");
    expect(strongest(["done", "waiting", "running"])).toBe("waiting");
    expect(strongest([null, undefined, "running"])).toBe("running");
    expect(strongest([])).toBeNull();
  });
});
