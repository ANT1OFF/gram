import type { BoundPr, PrStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  identityOf,
  ifTarget,
  prTargetOf,
  repoOfPrUrl,
  samePrIdentity,
  targetBadge,
} from "./pr-identity";

const url = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

const badgeOf = (repo: string, number: number, over: Partial<PrStatus> = {}): PrStatus => ({
  number,
  state: "OPEN",
  url: url(repo, number),
  title: "",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...over,
});

const bind = (repo: string, number: number): BoundPr => ({ repo, number, monitor: false });

describe("repoOfPrUrl", () => {
  it.each([
    ["https://github.com/ANT1OFF/gram/pull/4", "ANT1OFF/gram"],
    ["https://github.com/example/api/pull/412/files", "example/api"],
    ["https://organization.example.invalid/team/repo.name/pull/7", "team/repo.name"],
    ["https://github.com/example/api/issues/4", undefined],
    ["not a url", undefined],
  ])("%s → %s", (input, repo) => {
    expect(repoOfPrUrl(input)).toBe(repo);
  });
});

describe("samePrIdentity", () => {
  it.each([
    [
      "same repo and number",
      { repo: "example/api", number: 4 },
      { repo: "example/api", number: 4 },
      true,
    ],
    ["case differs", { repo: "EXAMPLE/Api", number: 4 }, { repo: "example/api", number: 4 }, true],
    [
      "number differs",
      { repo: "example/api", number: 4 },
      { repo: "example/api", number: 5 },
      false,
    ],
    ["repo differs", { repo: "example/api", number: 4 }, { repo: "example/web", number: 4 }, false],
    ["neither names a repo", { repo: undefined, number: 4 }, { repo: undefined, number: 4 }, true],
    [
      "only one names a repo",
      { repo: "example/api", number: 4 },
      { repo: undefined, number: 4 },
      false,
    ],
  ])("%s", (_name, a, b, same) => {
    expect(samePrIdentity(a, b)).toBe(same);
    expect(samePrIdentity(b, a)).toBe(same);
  });
});

/**
 * The thread's state after each transition, and what may be shown for it: whether the badge in
 * `git.state` and a detail left over from before the transition are this PR.
 */
const transitions: ReadonlyArray<{
  name: string;
  origin: string | undefined;
  badge: PrStatus | undefined;
  boundPr: BoundPr | undefined;
  /** The detail on screen from before the transition. */
  previous: { repo: string; number: number };
  target: { repo: string | undefined; number: number } | undefined;
  usesBadge: boolean;
  keepsPrevious: boolean;
}> = [
  {
    name: "branch PR, refetched after a push",
    origin: "example/api",
    badge: badgeOf("example/api", 4),
    boundPr: undefined,
    previous: { repo: "example/api", number: 4 },
    target: { repo: "example/api", number: 4 },
    usesBadge: true,
    keepsPrevious: true,
  },
  {
    name: "bind the branch's own PR",
    origin: "example/api",
    badge: badgeOf("example/api", 4),
    boundPr: bind("EXAMPLE/api", 4),
    previous: { repo: "example/api", number: 4 },
    target: { repo: "EXAMPLE/api", number: 4 },
    usesBadge: true,
    keepsPrevious: true,
  },
  {
    name: "rebind to another number in the same repo, before its badge lands",
    origin: "example/api",
    badge: badgeOf("example/api", 4),
    boundPr: bind("example/api", 9),
    previous: { repo: "example/api", number: 4 },
    target: { repo: "example/api", number: 9 },
    usesBadge: false,
    keepsPrevious: false,
  },
  {
    name: "bind the same number in another repo, before its badge lands",
    origin: "example/api",
    badge: badgeOf("example/api", 4),
    boundPr: bind("example/infra", 4),
    previous: { repo: "example/api", number: 4 },
    target: { repo: "example/infra", number: 4 },
    usesBadge: false,
    keepsPrevious: false,
  },
  {
    name: "bound elsewhere, once the server swapped its badge in",
    origin: "example/api",
    badge: badgeOf("example/infra", 4, { headMatches: false }),
    boundPr: bind("example/infra", 4),
    previous: { repo: "example/infra", number: 4 },
    target: { repo: "example/infra", number: 4 },
    usesBadge: true,
    keepsPrevious: true,
  },
  {
    name: "unbind a same-numbered PR from another repo",
    origin: "example/api",
    badge: badgeOf("example/api", 4),
    boundPr: undefined,
    previous: { repo: "example/infra", number: 4 },
    target: { repo: "example/api", number: 4 },
    usesBadge: true,
    keepsPrevious: false,
  },
  {
    name: "the same unbind on a checkout with no recorded origin",
    origin: undefined,
    badge: badgeOf("example/api", 4),
    boundPr: undefined,
    previous: { repo: "example/infra", number: 4 },
    target: { repo: "example/api", number: 4 },
    usesBadge: true,
    keepsPrevious: false,
  },
  {
    name: "no origin, branch PR refetched",
    origin: undefined,
    badge: badgeOf("example/api", 4),
    boundPr: undefined,
    previous: { repo: "example/api", number: 4 },
    target: { repo: "example/api", number: 4 },
    usesBadge: true,
    keepsPrevious: true,
  },
  {
    name: "unbind with no branch PR",
    origin: "example/api",
    badge: undefined,
    boundPr: undefined,
    previous: { repo: "example/api", number: 4 },
    target: undefined,
    usesBadge: false,
    keepsPrevious: false,
  },
];

describe("across bind, rebind and unbind", () => {
  it.each(transitions)("$name", (row) => {
    const git = { origin: row.origin, pr: row.badge };
    const target = prTargetOf(git, row.boundPr);
    expect(target).toEqual(row.target);
    expect(targetBadge(git, row.boundPr) !== undefined).toBe(row.usesBadge);
    const previous = {
      number: row.previous.number,
      url: url(row.previous.repo, row.previous.number),
    };
    expect(ifTarget(target, previous, row.origin) !== undefined).toBe(row.keepsPrevious);
  });
});

describe("targetBadge", () => {
  it("anchors a bound PR's badge, so one that merged or closed doesn't read as open", () => {
    const merged = badgeOf("example/infra", 4, { state: "MERGED", headMatches: false });
    const git = { origin: "example/api", pr: merged };
    expect(targetBadge(git, bind("example/infra", 4))).toMatchObject({
      state: "MERGED",
      headMatches: true,
    });
  });

  it("leaves a branch lookup's anchoring alone: a reused branch name isn't a merged PR", () => {
    const phantom = badgeOf("example/api", 4, { state: "MERGED", headMatches: false });
    expect(targetBadge({ origin: "example/api", pr: phantom }, undefined)?.headMatches).toBe(false);
  });
});

describe("identityOf", () => {
  it("reads the repository from the URL and falls back to origin", () => {
    expect(identityOf({ number: 4, url: url("example/infra", 4) }, "example/api")).toEqual({
      repo: "example/infra",
      number: 4,
    });
    expect(identityOf({ number: 4, url: "" }, "example/api")).toEqual({
      repo: "example/api",
      number: 4,
    });
  });
});
