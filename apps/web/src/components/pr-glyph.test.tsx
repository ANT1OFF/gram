import type { GitState, PrStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { threadPrEntries, type PrGlyphThread } from "./pr-glyph";

const pr = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 120,
  state: "OPEN",
  url: "https://github.com/example/web/pull/120",
  title: "Open files as tabs",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  additions: 412,
  deletions: 37,
  ...overrides,
});

const git = (overrides: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "feat/file-tabs",
  worktree: true,
  head: "abc",
  changesToken: "tok",
  changedFiles: 0,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 2,
  conflicts: false,
  upstream: "synced",
  origin: "example/web",
  pr: pr(),
  ...overrides,
});

const thread: PrGlyphThread = {
  checkout: { kind: "worktree", path: "/code/web/.worktrees/file-tabs", branch: "feat/file-tabs" },
};

describe("threadPrEntries", () => {
  it("lists the thread's own PR, then those it follows", () => {
    const entries = threadPrEntries(
      {
        ...thread,
        extraPrs: [{ repo: "example/api", number: 731, monitor: false }],
      },
      git({
        extraPrs: [
          pr({
            number: 731,
            url: "https://github.com/example/api/pull/731",
            title: "Bump the API client",
            state: "MERGED",
          }),
        ],
      }),
    );
    expect(
      entries.map(({ key, glyph, own, additions, deletions }) => ({
        key,
        kind: glyph.kind,
        own,
        additions,
        deletions,
      })),
    ).toEqual([
      { key: "example/web#120", kind: "ready", own: true, additions: 412, deletions: 37 },
      { key: "example/api#731", kind: "merged", own: false, additions: 412, deletions: 37 },
    ]);
  });

  it("keeps what the row's other chips said as notes on the PR", () => {
    const [entry] = threadPrEntries(
      thread,
      git({
        pr: pr({ stale: { reason: "rate limited", since: Date.now() - 60_000 } }),
        workElsewhere: { branch: "feat/other", path: "/code/web/.worktrees/other" },
      }),
    );
    expect(entry!.stale).toBe(true);
    expect(entry!.notes.join("\n")).toMatch(/Couldn't refresh from GitHub \(rate limited\)/);
    expect(entry!.notes).toContain("Uncommitted work on “feat/other” in another worktree");
  });

  it("has nothing to show without a PR", () => {
    const { pr: _pr, ...bare } = git();
    expect(threadPrEntries(thread, bare)).toEqual([]);
    expect(threadPrEntries(thread, undefined)).toEqual([]);
  });
});
