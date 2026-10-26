const REVIEW_BOT_FIXTURE = [
  { loginPattern: "example-code-review[bot]", rereviewCommand: "/agent review", canApprove: true },
];
import { describe, expect, it } from "@effect/vitest";

import {
  ownPrsSearchArgs,
  parseReviewRequestDetails,
  parseReviewRequestDetailsBody,
  parseReviewRequests,
  reviewRequestDetailsQuery,
  reviewRequestsSearchArgs,
  updatedSinceDate,
} from "./review-requests.ts";

describe("reviewRequestsSearchArgs", () => {
  it("asks only for PRs naming the user, with no drafts and none of their own", () => {
    expect(reviewRequestsSearchArgs({ directOnly: true })).toEqual([
      "search",
      "prs",
      "--state=open",
      "--draft=false",
      "--json",
      "number,title,url,repository,author,updatedAt,createdAt",
      "--limit",
      "100",
      "--",
      "user-review-requested:@me",
      "-author:@me",
    ]);
  });

  // gh quotes a positional holding a space as one term's value, so a combined
  // "user-review-requested:@me -author:@me" reaches the API as the malformed
  // user-review-requested:"@me -author:@me" and is rejected outright.
  it("keeps every qualifier in its own argument", () => {
    for (const directOnly of [true, false]) {
      for (const updatedSince of [undefined, "2026-08-19"]) {
        for (const arg of reviewRequestsSearchArgs({ directOnly, updatedSince })) {
          expect(arg).not.toMatch(/\s/);
        }
      }
    }
  });

  it("asks GitHub itself for the age cutoff, so the limit can't truncate it away", () => {
    expect(reviewRequestsSearchArgs({ directOnly: true, updatedSince: "2026-08-19" })).toEqual([
      "search",
      "prs",
      "--state=open",
      "--draft=false",
      "--json",
      "number,title,url,repository,author,updatedAt,createdAt",
      "--limit",
      "100",
      "--",
      "user-review-requested:@me",
      "-author:@me",
      "updated:>=2026-08-19",
    ]);
  });

  it("leaves the cutoff out when there is none", () => {
    expect(reviewRequestsSearchArgs({ directOnly: true, updatedSince: undefined })).toEqual(
      reviewRequestsSearchArgs({ directOnly: true }),
    );
    expect(reviewRequestsSearchArgs({ directOnly: false }).join(" ")).not.toContain("updated:");
  });

  it("widens to the user's teams when direct-only is off", () => {
    expect(reviewRequestsSearchArgs({ directOnly: false })).toEqual([
      "search",
      "prs",
      "--review-requested=@me",
      "--state=open",
      "--draft=false",
      "--json",
      "number,title,url,repository,author,updatedAt,createdAt",
      "--limit",
      "100",
      "--",
      "-author:@me",
    ]);
  });
});

describe("ownPrsSearchArgs", () => {
  it("asks for the user's open PRs, drafts included, the most recently updated first", () => {
    expect(ownPrsSearchArgs()).toEqual([
      "search",
      "prs",
      "--author=@me",
      "--state=open",
      "--json",
      "number,title,url,repository,author,updatedAt,createdAt,isDraft",
      "--sort=updated",
      "--limit",
      "100",
    ]);
    for (const arg of ownPrsSearchArgs()) expect(arg).not.toMatch(/\s/);
  });
});

describe("parseReviewRequests", () => {
  it("reads gh search prs output, skipping entries without a repo or number", () => {
    const stdout = JSON.stringify([
      {
        number: 12,
        title: "Fix the flake",
        url: "https://github.com/acme/web/pull/12",
        repository: { name: "web", nameWithOwner: "acme/web" },
        author: { login: "octocat" },
        updatedAt: "2026-09-17T08:00:00Z",
        createdAt: "2026-09-10T08:00:00Z",
      },
      { number: 13, title: "No repo", repository: {} },
      { title: "No number", repository: { nameWithOwner: "acme/web" } },
      { number: 14, repository: { nameWithOwner: "acme/api" } },
    ]);
    expect(parseReviewRequests(stdout)).toEqual([
      {
        repo: "acme/web",
        number: 12,
        title: "Fix the flake",
        url: "https://github.com/acme/web/pull/12",
        author: "octocat",
        isBot: false,
        isDraft: false,
        updatedAt: "2026-09-17T08:00:00Z",
        createdAt: "2026-09-10T08:00:00Z",
      },
      {
        repo: "acme/api",
        number: 14,
        title: "",
        url: "",
        author: "",
        isBot: false,
        isDraft: false,
        updatedAt: "",
        createdAt: "",
      },
    ]);
  });

  it("flags an app author by is_bot or by a [bot] login, and leaves people alone", () => {
    const stdout = JSON.stringify([
      {
        number: 1,
        repository: { nameWithOwner: "acme/web" },
        author: { login: "dependabot[bot]", is_bot: true },
      },
      { number: 2, repository: { nameWithOwner: "acme/web" }, author: { login: "renovate[bot]" } },
      {
        number: 3,
        repository: { nameWithOwner: "acme/web" },
        author: { login: "some-app", is_bot: true },
      },
      { number: 4, repository: { nameWithOwner: "acme/web" }, author: { login: "octocat" } },
      { number: 5, repository: { nameWithOwner: "acme/web" } },
    ]);
    expect(parseReviewRequests(stdout)?.map((r) => [r.number, r.isBot])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
      [5, false],
    ]);
  });

  it("keeps the flattened author's login beside the flag", () => {
    const stdout = JSON.stringify([
      {
        number: 1,
        repository: { nameWithOwner: "acme/web" },
        author: { login: "dependabot[bot]", is_bot: true },
      },
    ]);
    expect(parseReviewRequests(stdout)?.[0]?.author).toBe("dependabot[bot]");
  });

  it("reads a draft as one, and a payload that doesn't say as not", () => {
    const stdout = JSON.stringify([
      { number: 1, repository: { nameWithOwner: "acme/web" }, isDraft: true },
      { number: 2, repository: { nameWithOwner: "acme/web" }, isDraft: false },
      { number: 3, repository: { nameWithOwner: "acme/web" } },
    ]);
    expect(parseReviewRequests(stdout)?.map((r) => [r.number, r.isDraft])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  it("is undefined for output that isn't a JSON array", () => {
    expect(parseReviewRequests("")).toBeUndefined();
    expect(parseReviewRequests("{}")).toBeUndefined();
    expect(parseReviewRequests("not json")).toBeUndefined();
    expect(parseReviewRequests("[]")).toEqual([]);
  });
});

describe("updatedSinceDate", () => {
  it("counts the days back from the given clock, as a GitHub date", () => {
    const now = Date.parse("2026-09-18T11:30:00Z");
    expect(updatedSinceDate(7, now)).toBe("2026-09-11");
    expect(updatedSinceDate(30, now)).toBe("2026-08-19");
    expect(updatedSinceDate(90, now)).toBe("2026-06-20");
  });

  it("crosses a month and a year boundary", () => {
    expect(updatedSinceDate(7, Date.parse("2026-01-03T00:00:00Z"))).toBe("2025-12-27");
  });
});

const botReview = (state: string, oid: string, login = "example-code-review") => ({
  id: `r-${oid}-${state}`,
  author: { login },
  state,
  submittedAt: "2026-09-17T08:00:00Z",
  commit: { oid },
  body: "Summary",
});
const node = (rollup: string | null, reviews: ReadonlyArray<unknown>, decision?: string) => ({
  headRefOid: "head",
  reviewDecision: decision ?? null,
  commits: { nodes: [{ commit: { statusCheckRollup: rollup && { state: rollup } } }] },
  reviews: { nodes: reviews },
});

const rollupChecks = (state: string | null) =>
  parseReviewRequestDetails(node(state, []), REVIEW_BOT_FIXTURE)?.checks;

describe("review request details", () => {
  it("names every PR through typed variables", () => {
    expect(reviewRequestDetailsQuery(2)).toMatch(
      /^query\(\$o0:String!,\$n0:String!,\$p0:Int!,\$o1:String!,\$n1:String!,\$p1:Int!\)\{e0:repository\(owner:\$o0,name:\$n0\)\{pullRequest\(number:\$p0\)/,
    );
  });

  it("maps GitHub's rollup state, and no rollup to none", () => {
    expect(rollupChecks("SUCCESS")).toBe("passing");
    expect(rollupChecks("FAILURE")).toBe("failing");
    expect(rollupChecks("ERROR")).toBe("failing");
    expect(rollupChecks("PENDING")).toBe("pending");
    expect(rollupChecks("EXPECTED")).toBe("pending");
    expect(rollupChecks(null)).toBe("none");
  });

  it("reports the bot's latest review and whether it is of the head, ignoring people", () => {
    expect(
      parseReviewRequestDetails(
        node(
          "SUCCESS",
          [botReview("CHANGES_REQUESTED", "old"), botReview("APPROVED", "head", "jordan")],
          "REVIEW_REQUIRED",
        ),
        REVIEW_BOT_FIXTURE,
      ),
    ).toEqual({
      checks: "passing",
      reviewDecision: "REVIEW_REQUIRED",
      bot: { verdict: "changesRequested", onHead: false },
      headOid: "head",
    });
    expect(
      parseReviewRequestDetails(
        node("SUCCESS", [botReview("APPROVED", "head")]),
        REVIEW_BOT_FIXTURE,
      )?.bot,
    ).toEqual({ verdict: "approved", onHead: true });
  });

  it("carries the head branch, merge state and its own updatedAt when GitHub names them", () => {
    expect(
      parseReviewRequestDetails(
        {
          ...node("SUCCESS", []),
          headRefName: "feat/x",
          mergeStateStatus: "DIRTY",
          updatedAt: "2026-09-17T08:00:00Z",
          isDraft: false,
        },
        REVIEW_BOT_FIXTURE,
      ),
    ).toEqual({
      checks: "passing",
      headRef: "feat/x",
      mergeState: "DIRTY",
      updatedAt: "2026-09-17T08:00:00Z",
      isDraft: false,
      headOid: "head",
    });
    expect(
      parseReviewRequestDetails(
        { ...node("SUCCESS", []), headRefName: null, mergeStateStatus: null },
        REVIEW_BOT_FIXTURE,
      ),
    ).toEqual({ checks: "passing", headOid: "head" });
  });

  it("is undefined for a PR GitHub returned nothing for", () => {
    expect(parseReviewRequestDetails(null, REVIEW_BOT_FIXTURE)).toBeUndefined();
  });

  it("is undefined for a node missing a connection the query asked for", () => {
    const complete = node("SUCCESS", []);
    expect(
      parseReviewRequestDetails({ ...complete, commits: null }, REVIEW_BOT_FIXTURE),
    ).toBeUndefined();
    expect(
      parseReviewRequestDetails({ ...complete, reviews: null }, REVIEW_BOT_FIXTURE),
    ).toBeUndefined();
    expect(
      parseReviewRequestDetails({ ...complete, headRefOid: null }, REVIEW_BOT_FIXTURE),
    ).toBeUndefined();
  });

  // What `gh api graphql` prints alongside a non-zero exit: `errors`, and whatever `data` resolved.
  it("takes only the complete, unerrored aliases of a partial response", () => {
    const body = {
      data: {
        e0: { pullRequest: node("SUCCESS", []) },
        e1: { pullRequest: { ...node(null, []), commits: null } },
        e2: { pullRequest: node("FAILURE", []) },
        e3: null,
      },
      errors: [
        { path: ["e1", "pullRequest", "commits"], message: "Something went wrong" },
        { path: ["e2", "pullRequest", "reviews", "nodes", 0, "author"], message: "Timeout" },
        { path: ["e3"], type: "NOT_FOUND", message: "Could not resolve to a Repository" },
      ],
    };
    expect([...parseReviewRequestDetailsBody(body, 4, REVIEW_BOT_FIXTURE)]).toEqual([
      [0, { checks: "passing", headOid: "head" }],
    ]);
  });

  it("takes nothing from a response without data", () => {
    const refused = { errors: [{ type: "RATE_LIMIT", message: "API rate limit exceeded" }] };
    expect(parseReviewRequestDetailsBody(refused, 2, REVIEW_BOT_FIXTURE).size).toBe(0);
    expect(parseReviewRequestDetailsBody([], 2, REVIEW_BOT_FIXTURE).size).toBe(0);
  });
});

describe("optional PR information", () => {
  it("parses labels and known zero counts while old or null fields stay unknown", () => {
    const old = parseReviewRequestDetails(node(null, []), []);
    expect(old?.additions).toBeUndefined();
    expect(old?.labels).toBeUndefined();
    expect(
      parseReviewRequestDetails(
        {
          ...node(null, []),
          additions: 0,
          deletions: 12,
          labels: { nodes: [{ name: "bug" }, { name: "offline" }], totalCount: 102 },
        },
        [],
      ),
    ).toEqual({
      checks: "none",
      headOid: "head",
      additions: 0,
      deletions: 12,
      labels: ["bug", "offline"],
      labelsCount: 102,
    });
    const invalid = parseReviewRequestDetails(
      { ...node(null, []), additions: null, deletions: -1, labels: null },
      [],
    );
    expect(invalid?.additions).toBeUndefined();
    expect(invalid?.deletions).toBeUndefined();
    expect(invalid?.labels).toBeUndefined();
    expect(reviewRequestDetailsQuery(2)).toContain(
      "labels(first:100){nodes{name} totalCount} additions deletions",
    );
  });
  it("refuses unknown or missing check rollups rather than reporting no checks", () => {
    expect(parseReviewRequestDetails(node("FUTURE_STATE", []), [])).toBeUndefined();
    expect(
      parseReviewRequestDetails({ ...node(null, []), commits: { nodes: [{ commit: {} }] } }, []),
    ).toBeUndefined();
  });
});
