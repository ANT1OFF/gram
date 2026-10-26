import type { BoundPr, GitState, PrCheckRun, PrStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { checkBuckets, extraRowsOf, foldedRows, prRowOf, stripLayout } from "./pr-strip-model";
import { prGlyphOf } from "@/components/pr-glyph-model";
import { formatCount } from "@/lib/format";

const run = (status: PrCheckRun["status"]) => ({
  name: status,
  status,
  link: "https://example.test",
});

const badge: PrStatus = {
  number: 4,
  state: "OPEN",
  url: "https://github.com/ANT1OFF/gram/pull/4",
  title: "Port the rewrite work",
  isDraft: false,
  checks: "failing",
  headMatches: true,
  aheadOfPr: false,
};

const git = (pr: PrStatus | undefined): GitState => ({
  repo: true,
  branch: "feat/port",
  worktree: false,
  head: "abc",
  changesToken: "",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  origin: "ANT1OFF/gram",
  ...(pr === undefined ? {} : { pr }),
});

describe("checkBuckets", () => {
  it("counts checks per outcome, worst first, and leaves empty outcomes out", () => {
    const runs = [run("passing"), run("neutral"), run("passing"), run("failing")];
    expect(checkBuckets(runs)).toEqual([
      { kind: "failed", label: "Failed", count: 1 },
      { kind: "passed", label: "Passed", count: 2 },
      { kind: "skipped", label: "Skipped", count: 1 },
    ]);
    expect(checkBuckets([])).toEqual([]);
  });
});

/** The glyph the row above the composer draws for the branch's PR. */
const glyph = (pr: PrStatus) => prGlyphOf(prRowOf(undefined, git(pr))?.facts).kind;

describe("prRowOf", () => {
  it("is absent without a bound or branch PR", () => {
    expect(prRowOf(undefined, git(undefined))).toBeUndefined();
    expect(prRowOf(undefined, undefined)).toBeUndefined();
  });

  it("draws the branch PR from the badge alone", () => {
    expect(prRowOf(undefined, git(badge))).toMatchObject({
      number: 4,
      repo: "gram",
      branch: "feat/port",
      bound: false,
      additions: undefined,
    });
    const sized = { ...badge, headRef: "feat/port-rewrite", additions: 5624, deletions: 394 };
    expect(prRowOf(undefined, git(sized))).toMatchObject({
      branch: "feat/port-rewrite",
      additions: 5624,
      deletions: 394,
    });
  });

  it("draws the row's glyph from its facts, the sidebar's: conflicts only on an open PR", () => {
    expect(glyph({ ...badge, checks: "passing", mergeState: "DIRTY" })).toBe("conflicts");
    expect(glyph({ ...badge, state: "MERGED", mergeState: "DIRTY" })).toBe("merged");
    // Worse than conflicts: failing required checks, as the sidebar's glyph puts them.
    expect(glyph({ ...badge, checks: "failing", mergeState: "DIRTY" })).toBe("failing");
    // A check nobody requires failing doesn't turn the row red.
    expect(glyph({ ...badge, checks: "failing", requiredChecks: "passing" })).toBe("ready");
  });

  it("follows a PR bound from another repository and ignores the branch's badge", () => {
    const bound: BoundPr = { repo: "EXAMPLE/infra", number: 88, monitor: true };
    expect(prRowOf(bound, git(badge))).toMatchObject({
      number: 88,
      repo: "infra",
      branch: undefined,
      status: undefined,
      additions: undefined,
      bound: true,
    });
  });

  it("doesn't take the branch's PR for a bound one with the same number in another repository", () => {
    const bound: BoundPr = { repo: "EXAMPLE/infra", number: 4, monitor: false };
    const row = prRowOf(bound, git({ ...badge, mergeState: "DIRTY" }));
    expect(row).toMatchObject({
      number: 4,
      repo: "infra",
      branch: undefined,
      url: undefined,
      status: undefined,
      facts: undefined,
      additions: undefined,
    });
  });

  it("uses the badge the server swapped in for the bound PR, but not this checkout's branch", () => {
    const bound: BoundPr = { repo: "example/infra", number: 4, monitor: false };
    const swapped = {
      ...badge,
      url: "https://github.com/EXAMPLE/infra/pull/4",
      checks: "passing" as const,
    };
    const row = prRowOf(bound, git(swapped));
    expect(row?.status).toMatchObject({ checks: "passing" });
    expect(row?.url).toBe(swapped.url);
    expect(row?.branch).toBeUndefined();
  });

  it("keeps the badge for a PR bound in this repository, whatever the case of owner/repo", () => {
    const bound: BoundPr = { repo: "ant1off/GRAM", number: 4, monitor: false };
    expect(prRowOf(bound, git(badge))).toMatchObject({
      branch: "feat/port",
      status: { checks: "failing" },
    });
  });
});

describe("a row's place and card", () => {
  it("calls the checkout's own repository and branch local", () => {
    expect(prRowOf(undefined, git(badge))).toMatchObject({
      fullRepo: "ANT1OFF/gram",
      repoUrl: "https://github.com/ANT1OFF/gram",
      localRepo: true,
      localBranch: true,
    });
  });

  it("keeps the repository local but not the branch once the PR's branch isn't the one checked out", () => {
    expect(prRowOf(undefined, git({ ...badge, headRef: "feat/other" }))).toMatchObject({
      branch: "feat/other",
      localRepo: true,
      localBranch: false,
    });
  });

  it("gives a PR bound from another repository neither, and its own host's repository page", () => {
    const bound: BoundPr = { repo: "example/infra", number: 4, monitor: false };
    const swapped = {
      ...badge,
      url: "https://organization.example.invalid/example/infra/pull/4",
      headRef: "feat/port",
    };
    expect(prRowOf(bound, git(swapped))).toMatchObject({
      branch: "feat/port",
      repoUrl: "https://organization.example.invalid/example/infra",
      localRepo: false,
      localBranch: false,
    });
  });

  it("fills the card from the badge, and keeps it over an older detail", () => {
    const carried = {
      ...badge,
      author: "mona",
      additions: 1,
      deletions: 2,
      changedFiles: 3,
      updatedAt: "2026-09-16T11:20:00Z",
    };
    expect(prRowOf(undefined, git(carried))).toMatchObject({
      title: "Port the rewrite work",
      author: "mona",
      additions: 1,
      deletions: 2,
      changedFiles: 3,
      updatedAt: Date.parse("2026-09-16T11:20:00Z"),
    });
    expect(prRowOf(undefined, git({ ...carried, headRef: "feat/renamed" }))).toMatchObject({
      branch: "feat/renamed",
      author: "mona",
    });
  });
});

describe("extraRowsOf", () => {
  const followed: BoundPr[] = [
    { repo: "ANT1OFF/gram", number: 8, monitor: true },
    { repo: "EXAMPLE/infra", number: 8, monitor: false },
  ];

  it("keeps the binding order and matches each badge by repository and number", () => {
    const infra = {
      ...badge,
      number: 8,
      url: "https://github.com/example/infra/pull/8",
      title: "Infra",
    };
    const rows = extraRowsOf(followed, { ...git(badge), extraPrs: [infra] });
    expect(rows.map((row) => [row.repo, row.number, row.title, row.monitor])).toEqual([
      ["gram", 8, undefined, true],
      ["infra", 8, "Infra", false],
    ]);
    expect(rows[0]?.status).toBeUndefined();
    expect(rows[0]?.url).toBe("https://github.com/ANT1OFF/gram/pull/8");
  });

  it("takes a followed PR's branch and card from its badge", () => {
    const infra = {
      ...badge,
      number: 8,
      url: "https://github.com/example/infra/pull/8",
      headRef: "feat/infra",
      author: "mona",
      changedFiles: 1,
    };
    const rows = extraRowsOf(followed, { ...git(badge), extraPrs: [infra] });
    expect(rows[1]).toMatchObject({
      branch: "feat/infra",
      author: "mona",
      changedFiles: 1,
      repoUrl: "https://github.com/example/infra",
      localRepo: false,
    });
    expect(rows[0]).toMatchObject({ branch: undefined, localRepo: true, localBranch: false });
  });

  it("shows a followed PR as merged whatever the badge says about this branch", () => {
    const merged = {
      ...badge,
      number: 8,
      state: "MERGED" as const,
      headMatches: false,
      url: "https://github.com/ANT1OFF/gram/pull/8",
    };
    const [row] = extraRowsOf(followed, { ...git(badge), extraPrs: [merged] });
    expect(row?.status).toMatchObject({ state: "MERGED", headMatches: true });
  });

  it("is empty for a thread that follows nothing", () => {
    expect(extraRowsOf(undefined, git(badge))).toEqual([]);
  });
});

describe("hidden rows", () => {
  const open = { ...badge, checks: "passing", headRefOid: "h1" } satisfies PrStatus;

  it("lays out the rows left visible, the thread's own first, and counts the hidden ones", () => {
    const followed: BoundPr[] = [
      { repo: "example/infra", number: 4, monitor: false },
      { repo: "example/web", number: 9, monitor: false },
    ];
    const state = git(open);
    const own = prRowOf(undefined, state);
    const extras = extraRowsOf(followed, state);
    const numbers = (hidden: Parameters<typeof stripLayout>[2]) => {
      const layout = stripLayout(own, extras, hidden);
      return {
        rows: layout.visible.map((item) => `${item.kind}:${item.row.fullRepo}#${item.row.number}`),
        hidden: layout.hidden,
      };
    };
    expect(numbers(undefined)).toEqual({
      rows: ["own:ANT1OFF/gram#4", "extra:example/infra#4", "extra:example/web#9"],
      hidden: 0,
    });
    // The same number in another repository is another PR.
    expect(numbers([{ repo: "ANT1OFF/gram", number: 4 }])).toEqual({
      rows: ["extra:example/infra#4", "extra:example/web#9"],
      hidden: 1,
    });
    expect(
      numbers([
        { repo: "ANT1OFF/gram", number: 4 },
        { repo: "example/infra", number: 4 },
        { repo: "example/web", number: 9 },
      ]),
    ).toEqual({ rows: [], hidden: 3 });
    // An entry for a PR the thread no longer shows counts for nothing.
    expect(numbers([{ repo: "example/api", number: 1 }]).hidden).toBe(0);
  });

  it("keeps a hidden row that came back above the fold", () => {
    const followed: BoundPr[] = [
      { repo: "example/infra", number: 4, monitor: false },
      { repo: "example/web", number: 9, monitor: false },
    ];
    const failing = { ...open, number: 9, url: "https://github.com/example/web/pull/9" };
    const state = { ...git(open), extraPrs: [{ ...failing, checks: "failing" as const }] };
    const layout = stripLayout(prRowOf(undefined, state), extraRowsOf(followed, state), [
      { repo: "example/web", number: 9, state: "OPEN" },
    ]);
    expect(layout.hidden).toBe(0);
    expect(foldedRows(layout.visible).map((item) => [item.row.number, item.resurfaced])).toEqual([
      [4, false],
      [9, true],
    ]);
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(5624)).toBe("5,624");
    expect(formatCount(0)).toBe("0");
  });
});
