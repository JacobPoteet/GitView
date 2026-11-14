import { Fragment, memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { hasInlineMarkdown, isWebLink, keepTrailers } from "../lib/markdown";

/**
 * What a click on a link does. GitView never navigates its own window, so a
 * link types a command the way a port chip does, and the surface that owns the
 * shell says which. Without one, a link is text with its address in the title.
 */
export interface LinkAction {
  open: (href: string, typeOnly: boolean) => void;
  /** The tooltip: the command the click types. */
  title: (href: string) => string;
}

/**
 * The elements GitView draws its own way. A link is a button, since the
 * window must not navigate. An image is a link to itself rather than an
 * `<img>`: the page has no CSP, and an issue body's screenshot would be a
 * request to the network from a client that otherwise makes none. A task box
 * is a mark rather than a disabled checkbox, which would read as a control.
 */
function components(link: LinkAction | undefined): Components {
  const anchor = (href: string, children: ReactNode) =>
    link && isWebLink(href) ? (
      <button
        type="button"
        className="md-link"
        title={link.title(href)}
        onClick={(event) => link.open(href, event.shiftKey)}
      >
        {children}
      </button>
    ) : (
      <span className="md-link-text" title={href}>
        {children}
      </span>
    );
  return {
    a: ({ href, children }) => anchor(href ?? "", children),
    img: ({ src, alt }) => {
      const href = typeof src === "string" ? src : "";
      return anchor(href, alt || href);
    },
    input: ({ type, checked }) =>
      type === "checkbox" ? (
        <span
          className={`md-box${checked ? " checked" : ""}`}
          role="img"
          aria-label={checked ? "done" : "not done"}
        >
          {checked ? "✓" : ""}
        </span>
      ) : null,
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    ),
  };
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Raw HTML is shown as typed, which react-markdown does with it by default,
 * because a commit subject that says `Vec<String>` or `<Dialog>` without
 * backticks means the words, and dropping tags would eat them. Two shapes are
 * not words: a comment, which issue templates leave behind and GitHub hides,
 * and `<br>`, which tables use for a line break.
 */
function tidyHtml() {
  const walk = (node: HastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): HastNode[] => {
      if (child.type === "raw") {
        const raw = (child.value ?? "").trim();
        if (/^<!--[\s\S]*-->$/.test(raw)) return [];
        if (/^<br\s*\/?>$/i.test(raw)) {
          return [{ type: "element", tagName: "br", properties: {}, children: [] }];
        }
      }
      walk(child);
      return [child];
    });
  };
  return (tree: HastNode) => walk(tree);
}

const GFM = [remarkGfm];
const HTML = [tidyHtml];

/** A commit body or an issue thread. */
export default function Markdown({
  source,
  className,
  link,
}: {
  source: string;
  className?: string;
  link?: LinkAction;
}) {
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={GFM} rehypePlugins={HTML} components={components(link)}>
        {keepTrailers(source)}
      </ReactMarkdown>
    </div>
  );
}

/**
 * micromark's names for the constructs that start a block. A subject is one
 * line, so `- `, `# ` or `1. ` at its start is how it was typed rather than a
 * list or a heading, and switching them off keeps those characters on screen.
 */
const BLOCK_CONSTRUCTS = [
  "blockQuote",
  "codeFenced",
  "codeIndented",
  "definition",
  "headingAtx",
  "htmlFlow",
  "list",
  "setextUnderline",
  "thematicBreak",
];

function inlineOnly(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  data.micromarkExtensions ??= [];
  data.micromarkExtensions.push({ disable: { null: BLOCK_CONSTRUCTS } });
}

const LINE_PLUGINS = [remarkGfm, inlineOnly];
const LINE_ELEMENTS = ["p", "code", "strong", "em", "del", "a"];
const LINE_COMPONENTS: Components = { ...components(undefined), p: ({ children }) => <>{children}</> };

/**
 * One line of Markdown, for a subject: a commit summary, an issue title. Only
 * the inline syntax is read, and a link is never a control, since these sit
 * inside rows that are buttons already. Memoised and short-circuited, because
 * a history page draws a few hundred of them and most hold no syntax at all.
 */
export const MarkdownLine = memo(function MarkdownLine({ text }: { text: string }) {
  if (!hasInlineMarkdown(text)) return <Fragment>{text}</Fragment>;
  return (
    <ReactMarkdown
      remarkPlugins={LINE_PLUGINS}
      allowedElements={LINE_ELEMENTS}
      unwrapDisallowed
      components={LINE_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
});
