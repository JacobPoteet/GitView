import { describe, expect, it } from "vitest";
import { chordOf, isClaimed, repoChord, SHORTCUTS } from "./keys";

const press = (over: Partial<Parameters<typeof chordOf>[0]>) => ({
  key: "",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("chordOf", () => {
  it("spells a letter upper-case whatever caps lock says", () => {
    expect(chordOf(press({ key: "h", code: "KeyH" }))).toBe("Ctrl+H");
    expect(chordOf(press({ key: "H", code: "KeyH" }))).toBe("Ctrl+H");
  });

  it("reads a digit and the backquote from the code, since shift and layouts change the key", () => {
    expect(chordOf(press({ key: "!", code: "Digit1", shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(chordOf(press({ key: "3", code: "Digit3" }))).toBe("Ctrl+3");
    expect(chordOf(press({ key: "~", code: "Backquote", shiftKey: true }))).toBe("Ctrl+Shift+`");
    expect(chordOf(press({ key: "0", code: "Digit0" }))).toBeNull();
  });

  it("names shift, treats meta as ctrl, and needs ctrl", () => {
    expect(chordOf(press({ key: "C", code: "KeyC", shiftKey: true }))).toBe("Ctrl+Shift+C");
    expect(chordOf(press({ key: "k", code: "KeyK", ctrlKey: false, metaKey: true }))).toBe("Ctrl+K");
    expect(chordOf(press({ key: "k", code: "KeyK", ctrlKey: false }))).toBeNull();
  });

  it("names alt over a letter, and leaves AltGr's characters to the shell", () => {
    expect(chordOf(press({ key: "b", code: "KeyB", altKey: true }))).toBe("Ctrl+Alt+B");
    // AltGr+Q on a German keyboard, and AltGr+7.
    expect(chordOf(press({ key: "@", code: "KeyQ", altKey: true }))).toBeNull();
    expect(chordOf(press({ key: "{", code: "Digit7", altKey: true }))).toBeNull();
  });

  it("is null for a key the table has no spelling for", () => {
    expect(chordOf(press({ key: "Enter", code: "Enter" }))).toBeNull();
    expect(chordOf(press({ key: "F5", code: "F5" }))).toBeNull();
  });
});

describe("isClaimed", () => {
  it("claims the chords App acts on and nothing the shell wants", () => {
    expect(isClaimed(press({ key: "k", code: "KeyK" }))).toBe(true);
    expect(isClaimed(press({ key: "`", code: "Backquote" }))).toBe(true);
    expect(isClaimed(press({ key: ",", code: "Comma" }))).toBe(true);
    // Ctrl+C is the shell's interrupt, and Ctrl+L is its clear.
    expect(isClaimed(press({ key: "c", code: "KeyC" }))).toBe(false);
    expect(isClaimed(press({ key: "l", code: "KeyL" }))).toBe(false);
    expect(isClaimed(press({ key: "C", code: "KeyC", shiftKey: true }))).toBe(true);
    expect(isClaimed(press({ key: "b", code: "KeyB", altKey: true }))).toBe(true);
    // Ctrl+B is Claude Code's background key, so the chord needs the Alt.
    expect(isClaimed(press({ key: "b", code: "KeyB" }))).toBe(false);
  });
});

describe("repoChord", () => {
  it("numbers the first nine and no more", () => {
    expect(repoChord(0)).toBe("Ctrl+1");
    expect(repoChord(8)).toBe("Ctrl+9");
    expect(repoChord(9)).toBeNull();
  });
});

describe("SHORTCUTS", () => {
  it("lists every claimed chord, so the dialog and the handler agree", () => {
    const listed = SHORTCUTS.map((s) => s.chord).join(" ");
    for (const chord of ["Ctrl+K", "Ctrl+`", "Ctrl+Shift+C", "Ctrl+H", "Ctrl+I", "Ctrl+,", "Ctrl+Alt+B", "Ctrl+F"]) {
      expect(listed).toContain(chord);
    }
  });
});
