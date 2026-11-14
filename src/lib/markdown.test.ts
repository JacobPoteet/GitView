import { describe, expect, it } from "vitest";
import { hasInlineMarkdown, isWebLink, keepTrailers } from "./markdown";

describe("keepTrailers", () => {
  it("hard-breaks every line but the last of a trailer block", () => {
    expect(keepTrailers("Body.\n\nSigned-off-by: A <a@b>\nCo-Authored-By: C <c@d>")).toBe(
      "Body.\n\nSigned-off-by: A <a@b>  \nCo-Authored-By: C <c@d>",
    );
  });

  it("leaves a lone trailer and a paragraph that only starts like one", () => {
    expect(keepTrailers("Note: one line")).toBe("Note: one line");
    expect(keepTrailers("Note: this wraps\nonto prose")).toBe("Note: this wraps\nonto prose");
  });

  it("reads CRLF the same as LF", () => {
    expect(keepTrailers("A-b: c\r\nD-e: f")).toBe("A-b: c  \nD-e: f");
  });
});

describe("hasInlineMarkdown", () => {
  it("lets a plain subject skip the parser", () => {
    expect(hasInlineMarkdown("Fix the scanner on a detached HEAD (#12)")).toBe(false);
  });

  it("sends anything with inline syntax to it", () => {
    expect(hasInlineMarkdown("Read `git2` once")).toBe(true);
    expect(hasInlineMarkdown("See https://a.dev")).toBe(true);
    expect(hasInlineMarkdown("**bold**")).toBe(true);
  });
});

describe("isWebLink", () => {
  it("offers only web links as something to open", () => {
    expect(isWebLink("https://github.com")).toBe(true);
    expect(isWebLink("javascript:alert(1)")).toBe(false);
    expect(isWebLink("docs/a.md")).toBe(false);
  });
});
