/**
 * The glyph in front of a chip's count, drawn rather than typed.
 *
 * The chips used to open with a character (`↓`, `⇡`, `⇅`, `⌫`, `⧉`), and at
 * 11 px in the mono face an arrow is a hairline and the rest are guesses: the
 * behind count was the one that could not be read at all (#146). An SVG keeps
 * one weight and one size whichever font the character would have fallen back
 * to. A glyph used as an icon keeps a literal size, like every other icon.
 */
export type ChipKind = "behind" | "ahead" | "unpushed" | "dirty" | "merged" | "stash" | "pr";

const PATHS: Record<ChipKind, string> = {
  behind: "M8 2.5v10.5M3.8 8.8 8 13l4.2-4.2",
  ahead: "M8 13.5V3M3.8 7.2 8 3l4.2 4.2",
  // Up and off this disk: an arrow leaving from under a bar.
  unpushed: "M8 14V5.5M4.3 9.2 8 5.5l3.7 3.7M3 2.2h10",
  dirty: "",
  // A branch merged in and ready to go, as the bin it goes to.
  merged: "M2.8 4.3h10.4M6.2 4.3V2.6h3.6v1.7M4.3 4.3l.7 9h6l.7-9",
  stash: "M2.2 3h11.6v3.2H2.2zM3.3 6.2v7h9.4v-7M6.3 9h3.4",
  // The pull request mark: two commits on one rail, a third it points into.
  pr: "M4.5 5.3v5.4M11.5 10.7V7.2a2.4 2.4 0 0 0-2.4-2.4H7.2M8.6 3.2 7 4.8l1.6 1.6",
};

export default function ChipIcon({ kind }: { kind: ChipKind }) {
  return (
    <svg className="chip-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      {kind === "dirty" ? (
        <circle cx="8" cy="8" r="4" fill="currentColor" />
      ) : (
        <path
          d={PATHS[kind]}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {kind === "pr" && (
        <>
          <circle cx="4.5" cy="3.4" r="1.9" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="4.5" cy="12.6" r="1.9" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="11.5" cy="12.6" r="1.9" stroke="currentColor" strokeWidth="1.8" />
        </>
      )}
    </svg>
  );
}
