import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEMES, isThemeId, themeFor } from "./themes";

describe("themes", () => {
  it("has unique ids, and the default is one of them", () => {
    const ids = THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME);
  });

  it("resolves an unknown id to the default", () => {
    expect(themeFor("nope").id).toBe(DEFAULT_THEME);
    expect(isThemeId("nope")).toBe(false);
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
  });

  it("gives every terminal palette hex colours xterm can parse", () => {
    for (const theme of THEMES) {
      for (const value of [...Object.values(theme.terminal), ...Object.values(theme.search)]) {
        expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });
});
