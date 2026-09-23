/** One end of a link between a pull request and an issue, as the desk shows it. */
export interface Link {
  key: string;
  /** `#130`, or `owner/repo#130` across repositories. */
  label: string;
  title: string;
  /** What a click does, for the tooltip: a jump in the list, or a typed command. */
  hint: string;
  onOpen: (typeOnly: boolean) => void;
}

/**
 * The desk's line naming what a pull request closes, or what closes an issue.
 * Each entry is a button, since the question after "closes #130" is almost
 * always "which one was that".
 */
export function Links({ lead, links }: { lead: string; links: Link[] }) {
  if (links.length === 0) return null;
  return (
    <div className="inbox-links">
      <span className="inbox-links-lead">{lead}</span>
      <ul>
        {links.map((link) => (
          <li key={link.key}>
            <button
              className="inbox-link"
              title={link.hint}
              onClick={(event) => link.onOpen(event.shiftKey)}
            >
              <span className="inbox-link-number">{link.label}</span>
              <span className="inbox-link-title">{link.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
