import {
  DEFAULT_SETTINGS,
  type PrStatus,
  type ReviewRequest,
  type Settings,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  botReviewedRepos,
  heldForMissingBot,
  MAX_AGE_OPTIONS,
  maxAgeChoice,
  maxAgePatch,
  noBotRepoPatch,
  parseRepo,
  suggestedBotRepos,
  withBotRepo,
} from "./review-request-filters";

describe("maximum age presets", () => {
  it("round-trips every preset through its patch", () => {
    for (const { value } of MAX_AGE_OPTIONS) {
      const days = maxAgePatch(value).reviewRequestsMaxAgeDays;
      expect(maxAgeChoice(days ?? undefined)).toBe(value);
    }
  });

  it("clears the cutoff with null, which is how a patch unsets a field", () => {
    expect(maxAgePatch("off")).toEqual({ reviewRequestsMaxAgeDays: null });
  });

  it("names no preset for a cutoff set some other way", () => {
    expect(maxAgeChoice(14)).toBeUndefined();
  });
});

const awaiting = (reviewBotRepos?: string[]): Settings => ({
  ...DEFAULT_SETTINGS,
  notifications: {
    ...DEFAULT_SETTINGS.notifications,
    reviewRequestsAwaitBot: true,
    ...(reviewBotRepos === undefined ? {} : { reviewBotRepos }),
  },
});

const request = (repo: string, bot?: ReviewRequest["bot"]): ReviewRequest => ({
  repo,
  number: 1,
  title: "PR",
  url: `https://github.com/${repo}/pull/1`,
  author: "jordan",
  updatedAt: "2026-09-17T08:00:00Z",
  ...(bot === undefined ? {} : { bot }),
});

const reviewed = { verdict: "approved", onHead: true } as const;

describe("review-bot repositories", () => {
  it("suggests where a bot reviewed a request or the user's PR, once each, sorted", () => {
    const prs = [
      {
        url: "https://github.com/example/web/pull/4",
        review: { bots: ["example-code-review[bot]"] },
      },
      { url: "https://github.com/example/docs/pull/5" },
      {
        url: "https://github.com/EXAMPLE/API/pull/6",
        review: { bots: ["example-code-review[bot]"] },
      },
    ] as unknown as PrStatus[];
    const prRepos = botReviewedRepos(prs);
    expect(prRepos).toEqual(["example/web", "EXAMPLE/API"]);
    expect(
      suggestedBotRepos([request("example/api", reviewed), request("example/infra")], prRepos),
    ).toEqual(["example/api", "example/web"]);
  });

  it("offers 'no review bot' only on a request held for a bot that never reviewed it", () => {
    expect(heldForMissingBot(DEFAULT_SETTINGS, request("example/api"))).toBe(false);
    expect(heldForMissingBot(awaiting(), request("example/api"))).toBe(true);
    expect(heldForMissingBot(awaiting(["example/api"]), request("example/api"))).toBe(true);
    expect(heldForMissingBot(awaiting(["example/web"]), request("example/api"))).toBe(false);
    const stale = { verdict: "approved", onHead: false } as const;
    expect(heldForMissingBot(awaiting(["example/api"]), request("example/api", stale))).toBe(false);
  });

  it("takes a repo off the list, starting from the suggestions when it was never filled in", () => {
    expect(noBotRepoPatch(["example/api", "example/web"], [], "EXAMPLE/api")).toEqual({
      reviewBotRepos: ["example/web"],
    });
    expect(noBotRepoPatch(undefined, ["example/infra", "example/web"], "example/web")).toEqual({
      reviewBotRepos: ["example/infra"],
    });
  });

  it("reads a repository typed or pasted, and adds it once", () => {
    expect(parseRepo(" example/api ")).toBe("example/api");
    expect(parseRepo("https://github.com/example/api/pull/12")).toBe("example/api");
    expect(parseRepo("https://github.com/example/api.git")).toBe("example/api");
    expect(parseRepo("example")).toBeUndefined();
    expect(parseRepo("example/api/extra")).toBeUndefined();
    expect(withBotRepo(["example/api"], "EXAMPLE/Api")).toEqual(["example/api"]);
    expect(withBotRepo(["example/api"], "example/web")).toEqual(["example/api", "example/web"]);
  });
});
