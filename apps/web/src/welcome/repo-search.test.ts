import type { RepositoryCandidate } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { matchRepos } from "./repo-search";

const repo = (name: string, root: string): RepositoryCandidate => ({ name, root });

const REPOS = [
  repo("api", "/Users/dev/code/api"),
  repo("web", "/Users/dev/code/web"),
  repo("client-app", "/Users/dev/Documents/code/client-app"),
  repo("docs", "/Users/dev/Documents/code/api-docs"),
];

describe("matchRepos", () => {
  it("keeps the list as it is for an empty query", () => {
    expect(matchRepos(REPOS, "  ")).toBe(REPOS);
  });

  it("matches every word in the name or the path, ignoring case", () => {
    expect(matchRepos(REPOS, "WEB").map((r) => r.name)).toEqual(["web"]);
    expect(matchRepos(REPOS, "documents app").map((r) => r.name)).toEqual(["client-app"]);
    expect(matchRepos(REPOS, "nothing")).toEqual([]);
  });

  it("puts name matches before path-only ones", () => {
    expect(matchRepos(REPOS, "api").map((r) => r.name)).toEqual(["api", "docs"]);
  });
});
