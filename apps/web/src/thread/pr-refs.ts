// Pull request references in an agent's text, found where the markdown is rendered and resolved
// against what the thread already knows. A bare `#N` doesn't say which repository it is in, so it
// becomes a link only when exactly one repository can be meant: a wrong link is worse than none.
// `owner/repo#N` and a github.com PR or issue URL say it themselves, and always link.

import type { BoundPr, GitState, WorkerLedgerEntry } from "@gram/contracts";

import { prLifecycleOf, prUrlOf, type PrLifecycle } from "@/components/pr-marks-model";
import { identityOf, samePrIdentity, targetBadge } from "@/panels/pr-identity";

/** A PR the thread knows by repository and number. */
interface KnownPr {
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  readonly url?: string | undefined;
  /** Its state, once a badge or the ledger has it. */
  readonly state?: PrLifecycle | undefined;
}

/** What a thread's references are resolved against. */
export interface PrRefIndex {
  readonly prs: readonly KnownPr[];
  /** Every `owner/repo` the thread is known to work in, each once. */
  readonly repos: readonly string[];
  /** Where a bare `#N` no known PR has goes: the thread's repository, when it works in one only. */
  readonly home?: string | undefined;
}

export const EMPTY_PR_REF_INDEX: PrRefIndex = { prs: [], repos: [] };

/** A reference as written: `repo` is `owner/repo`, a bare repository name, or absent for `#N`. */
export interface PrRef {
  readonly repo?: string | undefined;
  readonly number: number;
  readonly url?: string | undefined;
}

/** Where a resolved reference goes. */
export interface PrRefTarget {
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  /** Its state, when the thread knows it. */
  readonly state?: PrLifecycle | undefined;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const uniqueRepos = (repos: Iterable<string>): string[] => {
  const kept: string[] = [];
  for (const repo of repos) if (!kept.some((seen) => sameRepo(seen, repo))) kept.push(repo);
  return kept;
};

/**
 * The PRs a thread knows (its own, the ones it follows and, for an orchestrator, its workers') and
 * the repositories they and its checkout are in. Nothing here is fetched: it is all in the store.
 */
export function prRefIndexOf({
  git,
  boundPr,
  extraPrs,
  workers,
  repoCount,
}: {
  git: GitState | undefined;
  boundPr: BoundPr | undefined;
  extraPrs: readonly BoundPr[] | undefined;
  workers: readonly WorkerLedgerEntry[] | undefined;
  /**
   * How many repositories the thread works in, named or not: a workspace's projects, or a worker's
   * checkouts. Before a PR names each of them, `repos` alone would make several look like one.
   */
  repoCount: number;
}): PrRefIndex {
  const prs: KnownPr[] = [];
  if (boundPr !== undefined) {
    const badge = targetBadge(git, boundPr);
    prs.push({
      repo: boundPr.repo,
      number: boundPr.number,
      url: badge?.url,
      state: badge === undefined ? undefined : prLifecycleOf(badge),
    });
  }
  if (git?.pr !== undefined) {
    const { repo, number } = identityOf(git.pr, git.origin);
    if (repo !== undefined) {
      prs.push({ repo, number, url: git.pr.url, state: prLifecycleOf(git.pr) });
    }
  }
  for (const extra of extraPrs ?? []) {
    const badge = git?.extraPrs?.find((pr) => samePrIdentity(identityOf(pr), extra));
    prs.push({
      repo: extra.repo,
      number: extra.number,
      url: badge?.url,
      // A followed PR is never this branch's, so its merge or close always holds.
      state: badge === undefined ? undefined : prLifecycleOf({ ...badge, headMatches: true }),
    });
  }
  for (const worker of workers ?? []) {
    const repos = [worker, ...(worker.alsoIn ?? [])];
    for (const pr of repos.flatMap((repo) => [repo.pr, ...(repo.morePrs ?? [])])) {
      if (pr !== undefined) {
        prs.push({
          repo: pr.repo,
          number: pr.number,
          url: pr.url,
          state: pr.state === undefined ? undefined : prLifecycleOf({ state: pr.state }),
        });
      }
    }
  }
  const repos = uniqueRepos([
    ...(git?.origin === undefined ? [] : [git.origin]),
    ...prs.map((pr) => pr.repo),
  ]);
  return { prs, repos, ...(repos.length === 1 && repoCount <= 1 ? { home: repos[0] } : {}) };
}

const shortName = (repo: string) => repo.slice(repo.indexOf("/") + 1);

/**
 * Where `ref` points, or nothing when that can't be told. A bare `#N` is a PR the thread knows by
 * that number in one repository only, else a PR in the thread's one repository; `repo#N` names a
 * repository the thread knows by that short name, when only one has it.
 */
export function resolvePrRef(ref: PrRef, index: PrRefIndex): PrRefTarget | undefined {
  const { number } = ref;
  const to = (repo: string): PrRefTarget => {
    const known = index.prs.filter((pr) => samePrIdentity(pr, { repo, number }));
    const state = known.find((pr) => pr.state !== undefined)?.state;
    return {
      repo,
      number,
      url: prUrlOf({
        repo,
        number,
        url: ref.url ?? known.find((pr) => pr.url !== undefined)?.url,
      }),
      ...(state === undefined ? {} : { state }),
    };
  };
  const pick = (repos: readonly string[]) => (repos.length === 1 ? to(repos[0]!) : undefined);
  if (ref.repo?.includes("/")) return to(ref.repo);
  if (ref.repo !== undefined) {
    const name = ref.repo;
    return pick(index.repos.filter((repo) => sameRepo(shortName(repo), name)));
  }
  const known = uniqueRepos(index.prs.filter((pr) => pr.number === number).map((pr) => pr.repo));
  if (known.length > 0) return pick(known);
  return index.home === undefined ? undefined : to(index.home);
}

/** The custom element a reference renders as; its component resolves it. */
export const PR_REF_TAG = "pr-ref";

interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/** Whose text is never read for references: code, links (a thread's among them), and headings. */
const OPAQUE = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "a",
  "thread-ref",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/**
 * `#N`, `repo#N` or `owner/repo#N`, starting the text or after whitespace or `(`: never inside a
 * word, a path or a URL's fragment.
 */
const REF = /(^|[\s(])((?:[\w.-]+\/)?[\w.-]+)?#(\d+)\b/g;

/** Longer than this, a bare `#N` is more likely an id or a date than a PR; a named repo has none. */
const BARE_DIGITS = 6;

const GITHUB_URL =
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)\/?(?:[?#]|$)/i;

/** Any positive safe integer, as `parsePrRef` takes: GitHub puts no ceiling on the number. */
const isPrNumber = (digits: string) => {
  const number = Number(digits);
  return Number.isSafeInteger(number) && number >= 1;
};

const refElement = (ref: PrRef, children: HastNode[]): HastElement => ({
  type: "element",
  tagName: PR_REF_TAG,
  properties: {
    dataNumber: String(ref.number),
    ...(ref.repo === undefined ? {} : { dataRepo: ref.repo }),
    ...(ref.url === undefined ? {} : { dataUrl: ref.url }),
  },
  children,
});

/** `text` with every reference in it made a `pr-ref` element; the same node when there is none. */
function splitPrRefs(text: HastText): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  for (const match of text.value.matchAll(REF)) {
    const [, , repo, digits] = match;
    if (!isPrNumber(digits!) || (repo === undefined && digits!.length > BARE_DIGITS)) continue;
    const start = match.index + match[1]!.length;
    if (start > last) out.push({ type: "text", value: text.value.slice(last, start) });
    const written = match[0].slice(match[1]!.length);
    out.push(refElement({ repo, number: Number(digits) }, [{ type: "text", value: written }]));
    last = start + written.length;
  }
  if (out.length === 0) return [text];
  if (last < text.value.length) out.push({ type: "text", value: text.value.slice(last) });
  return out;
}

const githubRef = (node: HastElement): PrRef | undefined => {
  const href = node.properties?.["href"];
  const match = typeof href === "string" ? GITHUB_URL.exec(href) : null;
  return match === null || !isPrNumber(match[2]!)
    ? undefined
    : { repo: match[1]!, number: Number(match[2]), url: href as string };
};

const visit = (node: HastNode): void => {
  if (!("children" in node) || node.children === undefined) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      next.push(...splitPrRefs(child as HastText));
      continue;
    }
    if (child.type === "element") {
      const element = child as HastElement;
      const ref = element.tagName === "a" ? githubRef(element) : undefined;
      if (ref !== undefined) {
        next.push(refElement(ref, element.children));
        continue;
      }
      if (!OPAQUE.has(element.tagName)) visit(element);
    }
    next.push(child);
  }
  node.children = next;
};

/**
 * A rehype plugin, run after sanitizing, that marks every PR reference for the `pr-ref` component.
 * It only finds them; whether one links is decided at render, against what the thread knows then.
 */
export const rehypePrRefs = () => (tree: HastNode) => visit(tree);
