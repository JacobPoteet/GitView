/**
 * The inbox's pure half: how a row is keyed, how the rows fall into groups,
 * and the reading of a pull request's checks and mergeability. Nothing here
 * renders, so it has tests; the components that draw the groups are under
 * `components/inbox/`.
 */

import type { CheckRun, InboxItem, IssueRef, RepoState } from "./types";

/**
 * Groups, in the order they want something from you.
 *
 * The fleet list answers which repositories need attention. This answers what
 * needs a reply, which is a different question about the same eleven folders,
 * so it borrows the same group-label idiom rather than inventing one.
 */
export interface Group {
  key: string;
  label: string;
  hint?: string;
  items: InboxItem[];
}

/** Which question the groups are answering. */
export type Mode = "need" | "repo";

/** One key per row, stable across refreshes, so an open desk stays open. */
export function itemKey(item: Pick<InboxItem, "ownerRepo" | "kind" | "number">): string {
  return `${item.ownerRepo}#${item.kind}${item.number}`;
}

/** The row an issue a pull request closes would have, whether or not the inbox holds it. */
export function refKey(ref: IssueRef): string {
  return itemKey({ ownerRepo: ref.ownerRepo, kind: "issue", number: ref.number });
}

/**
 * How a pull request names an issue: `#130` in its own repository, and the
 * whole `owner/repo#130` across one, the way GitHub writes a closing keyword.
 */
export function refLabel(ref: IssueRef, from: string): string {
  return ref.ownerRepo === from ? `#${ref.number}` : `${ref.ownerRepo}#${ref.number}`;
}

/**
 * The other end of `closes`: for each issue some open pull request will
 * close, the pull requests that will. GitHub only records the link on the
 * pull request, so an issue row learns it has one from here.
 */
export function closedBy(items: InboxItem[]): Map<string, InboxItem[]> {
  const out = new Map<string, InboxItem[]>();
  for (const item of items) {
    for (const ref of item.closes ?? []) {
      const key = refKey(ref);
      const existing = out.get(key);
      if (existing) existing.push(item);
      else out.set(key, [item]);
    }
  }
  return out;
}

/** What each row wants from you, which is the question an inbox exists for. */
export function byNeed(items: InboxItem[]): Group[] {
  const prs = items.filter((item) => item.kind === "pr");
  const issues = items.filter((item) => item.kind === "issue");

  const review = prs.filter((pr) => pr.reviewRequested);
  const taken = new Set(review);

  const failing = prs.filter(
    (pr) => !taken.has(pr) && pr.mine && (pr.checks === "FAILURE" || pr.checks === "ERROR"),
  );
  failing.forEach((pr) => taken.add(pr));

  const mine = prs.filter((pr) => !taken.has(pr) && pr.mine);
  mine.forEach((pr) => taken.add(pr));

  const assigned = issues.filter((issue) => issue.assigned);
  const claimed = new Set(assigned);

  // Issues you opened yourself. Without this they fall in with other people's,
  // and on a fleet holding one public repository that is most of the list, so
  // "elsewhere" ended up describing your own backlog.
  const opened = issues.filter((issue) => !claimed.has(issue) && issue.mine);
  opened.forEach((issue) => claimed.add(issue));

  const others = [
    ...prs.filter((pr) => !taken.has(pr)),
    ...issues.filter((issue) => !claimed.has(issue)),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return [
    { key: "need:review", label: "Needs your review", items: review },
    { key: "need:failing", label: "Yours, checks failing", items: failing },
    { key: "need:mine", label: "Your pull requests", items: mine },
    { key: "need:assigned", label: "Assigned to you", items: assigned },
    { key: "need:opened", label: "Issues you opened", items: opened },
    { key: "need:others", label: "From other people", items: others },
  ].filter((group) => group.items.length > 0);
}

/**
 * One group per repository, newest activity first.
 *
 * Ordered by the freshest row each repository holds rather than by name, so the
 * project that moved this morning is still the one at the top. Inside a group
 * the pull requests come before the issues: a PR is a thing that is going to
 * land, and an issue is a thing somebody wrote down.
 */
export function byRepo(items: InboxItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const existing = groups.get(item.ownerRepo);
    if (existing) existing.items.push(item);
    else
      groups.set(item.ownerRepo, {
        key: `repo:${item.ownerRepo}`,
        label: item.repoName,
        hint: item.ownerRepo,
        items: [item],
      });
  }

  const rank = (item: InboxItem) => (item.kind === "pr" ? 0 : 1);
  const freshest = (group: Group) =>
    group.items.reduce((newest, item) => (item.updatedAt > newest ? item.updatedAt : newest), "");

  for (const group of groups.values()) {
    group.items.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }
  return [...groups.values()].sort((a, b) => freshest(b).localeCompare(freshest(a)));
}

/** The three colours a check can be. Skipped and cancelled read as neither passed nor failed. */
export function checkTone(state: InboxItem["checks"] | CheckRun["state"]): "ok" | "bad" | "pending" | "off" {
  if (state === "SUCCESS") return "ok";
  if (state === "FAILURE" || state === "ERROR") return "bad";
  if (state === "SKIPPED" || state === "CANCELLED") return "off";
  return "pending";
}

/**
 * Why the Merge button is off, in the words the dialog on GitHub would use.
 * Null when it is on. `UNSTABLE` is a failing check that is not required, and
 * `UNKNOWN` is GitHub still computing the merge: both leave the button on and
 * let the scrollback say what GitHub decided.
 */
export function mergeBlock(item: InboxItem): string | null {
  if (item.draft) return "A draft. Mark it ready first.";
  if (item.mergeable === "CONFLICTING" || item.mergeState === "DIRTY")
    return `Conflicts with ${item.baseRef ?? "the base branch"}. Resolve them on the branch and push.`;
  if (item.mergeState === "BLOCKED")
    return "Blocked by branch protection: a required review or check is missing.";
  if (item.mergeState === "BEHIND")
    return `Behind ${item.baseRef ?? "the base branch"}, and the branch protection wants it brought up to date first.`;
  if (item.mergeMethods.length === 0) return "The repository allows no merge method the token can use.";
  return null;
}

/**
 * A branch holding one commit is a pull request with that commit's subject
 * for a title, which is what `gh pr create --fill` would pick. More than one
 * and nothing is guessed.
 */
export function suggestedTitle(repo: RepoState | null): string {
  if (!repo || repo.aheadOfDefault !== 1) return "";
  return repo.lastCommitSummary ?? "";
}
