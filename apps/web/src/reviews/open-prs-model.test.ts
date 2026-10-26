import type { OwnPr, PrStatus, ThreadSummary } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { prFactsOfListPr } from "@/components/pr-facts";
import { prMarksOf } from "@/components/pr-marks-model";

import { openPrMergeNote, openPrRows } from "./open-prs-model";

const pr = (repo: string, number: number, extra: Partial<OwnPr> = {}): OwnPr => ({
  repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  isDraft: false,
  updatedAt: "2026-09-17T08:00:00Z",
  ...extra,
});

const badge = (repo: string, number: number, extra: Partial<PrStatus> = {}): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/${repo}/pull/${number}`,
  title: `Badge ${number}`,
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  ...extra,
});

interface ThreadFixture {
  branch?: string;
  origin?: string;
  pr?: PrStatus;
  extraPrs?: PrStatus[];
  boundPr?: { repo: string; number: number };
  role?: "orchestrator";
  lastActivityAt?: number;
}

const threads = (fixtures: Record<string, ThreadFixture>): Record<string, ThreadSummary> =>
  Object.fromEntries(
    Object.entries(fixtures).map(([id, f]) => [
      id,
      {
        thread: {
          id,
          title: `Thread ${id}`,
          checkout: { kind: "worktree", path: `/w/${id}` },
          lastActivityAt: f.lastActivityAt ?? 1,
          ...(f.boundPr === undefined ? {} : { boundPr: { ...f.boundPr, monitor: false } }),
          ...(f.role === undefined ? {} : { role: f.role }),
        },
        git: {
          repo: true,
          ...(f.branch === undefined ? {} : { branch: f.branch }),
          ...(f.origin === undefined ? {} : { origin: f.origin }),
          ...(f.pr === undefined ? {} : { pr: f.pr }),
          ...(f.extraPrs === undefined ? {} : { extraPrs: f.extraPrs }),
        },
      } as unknown as ThreadSummary,
    ]),
  );

/** A badge seen after the poll whose lookup didn't read the reviews. */
const unreadBadge = (headRefOid: string) =>
  badge("acme/web", 1, { updatedAt: "2026-09-17T09:00:00Z", headRefOid, reviewUnread: true });

describe("openPrRows", () => {
  it("names the owner: a binding, a badge, else a thread on the head branch", () => {
    const rows = openPrRows(
      [
        pr("acme/web", 1),
        pr("acme/web", 2),
        pr("acme/web", 3, { headRef: "feat/three" }),
        pr("acme/web", 4, { headRef: "feat/four" }),
      ],
      threads({
        bound: { boundPr: { repo: "Acme/Web", number: 1 } },
        badged: { extraPrs: [badge("acme/web", 2)] },
        branch: { branch: "feat/three", origin: "acme/web" },
        // On the right branch of another repository, and an orchestrator: neither owns anything.
        fork: { branch: "feat/four", origin: "someone/web" },
        orch: { branch: "feat/four", origin: "acme/web", role: "orchestrator" },
      }),
    );
    expect(rows.map((r) => [r.number, r.owner])).toEqual([
      [1, "bound"],
      [2, "badged"],
      [3, "branch"],
      [4, undefined],
    ]);
  });

  it("gives a PR two threads could own to the most recently active", () => {
    const rows = openPrRows(
      [pr("acme/web", 3, { headRef: "feat/three" })],
      threads({
        old: { branch: "feat/three", origin: "acme/web", lastActivityAt: 1 },
        recent: { branch: "feat/three", origin: "acme/web", lastActivityAt: 9 },
      }),
    );
    expect(rows[0]?.owner).toBe("recent");
  });

  it("takes the checks, reviews and merge state of a badge that saw GitHub later", () => {
    const listed = pr("acme/web", 1, {
      checks: "pending",
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      bot: { verdict: "commented", onHead: false },
    });
    const LATER = "2026-09-17T09:00:00Z";
    const fresh = badge("acme/web", 1, {
      updatedAt: LATER,
      title: "Renamed",
      isDraft: true,
      checks: "failing",
      mergeState: "DIRTY",
      review: {
        bots: ["example-code-review"],
        latestVerdict: "changesRequested",
        reviewedHead: true,
        roundInFlight: false,
        threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
      },
    });
    const [row] = openPrRows([listed], threads({ t: { pr: fresh } }));
    expect(row).toEqual({
      ...pr("acme/web", 1),
      updatedAt: LATER,
      detailsAt: LATER,
      title: "Renamed",
      isDraft: true,
      checks: "failing",
      mergeState: "DIRTY",
      bot: { verdict: "changesRequested", onHead: true },
      owner: "t",
    });

    // A badge carried over failed refreshes knows less than the poll, and so does one that saw
    // nothing the poll hadn't: a quiet thread's badge can be older than the poll.
    for (const older of [
      { ...fresh, stale: { reason: "rate limited", since: 1 } },
      { ...fresh, updatedAt: listed.updatedAt },
      { ...fresh, updatedAt: "2026-09-16T08:00:00Z" },
      badge("acme/web", 1, { checks: "failing" }),
    ]) {
      const [kept] = openPrRows([listed], threads({ t: { pr: older } }));
      expect(kept).toEqual({ ...listed, owner: "t" });
    }

    // One whose lookup didn't read the reviews keeps the poll's bot verdict.
    const [unread] = openPrRows([listed], threads({ t: { pr: { ...fresh, reviewUnread: true } } }));
    expect(unread?.bot).toEqual({ verdict: "commented", onHead: false });
  });

  it("keeps the poll's bot verdict past a badge that didn't read reviews, on its head only", () => {
    const approved = pr("acme/web", 1, {
      headOid: "aaa",
      detailsAt: "2026-09-17T08:00:00Z",
      bot: { verdict: "approved", onHead: true },
    });
    // A push since: the approval is of an earlier commit now.
    const [pushed] = openPrRows([approved], threads({ t: { pr: unreadBadge("bbb") } }));
    expect(pushed).toMatchObject({
      headOid: "bbb",
      bot: { verdict: "approved", onHead: false },
    });
    // A comment since, on the same head: still the head's.
    const [same] = openPrRows([approved], threads({ t: { pr: unreadBadge("aaa") } }));
    expect(same?.bot).toEqual({ verdict: "approved", onHead: true });
    // A poll that never read the head can't say it is still the one.
    const { headOid: _headOid, ...headless } = approved;
    const [unknown] = openPrRows([headless], threads({ t: { pr: unreadBadge("aaa") } }));
    expect(unknown?.bot).toEqual({ verdict: "approved", onHead: false });
  });

  it("dates the checks by the lookup that read them, so carried ones yield to a later badge", () => {
    // The lookup was refused at 09:00, so the 08:00 checks are carried; the search saw 09:00.
    const carried = pr("acme/web", 1, {
      updatedAt: "2026-09-17T09:00:00Z",
      detailsAt: "2026-09-17T08:00:00Z",
      checks: "passing",
      mergeState: "CLEAN",
      isDraft: true,
    });
    const pushed = badge("acme/web", 1, {
      updatedAt: "2026-09-17T09:00:00Z",
      checks: "failing",
      mergeState: "BLOCKED",
      isDraft: false,
    });
    const [row] = openPrRows([carried], threads({ t: { pr: pushed } }));
    // The marks are the badge's; the draft flag ties with the search, which keeps it.
    expect(row).toMatchObject({
      checks: "failing",
      mergeState: "BLOCKED",
      detailsAt: "2026-09-17T09:00:00Z",
      updatedAt: "2026-09-17T09:00:00Z",
      isDraft: true,
    });
    // With fresh details, the same badge ties with them and changes nothing.
    const [fresh] = openPrRows(
      [{ ...carried, detailsAt: "2026-09-17T09:00:00Z" }],
      threads({ t: { pr: pushed } }),
    );
    expect(fresh).toMatchObject({ checks: "passing", mergeState: "CLEAN" });
  });

  it("drops a PR a later badge says merged, and adds the open ones the poll didn't return", () => {
    const rows = openPrRows(
      [pr("acme/web", 1, { updatedAt: "2026-09-17T08:00:00Z" })],
      threads({
        merged: {
          pr: badge("acme/web", 1, { state: "MERGED", updatedAt: "2026-09-17T08:30:00Z" }),
        },
        theirs: {
          pr: badge("acme/api", 5, {
            updatedAt: "2026-09-18T08:00:00Z",
            headRef: "fix/five",
            reviewDecision: "APPROVED",
          }),
          extraPrs: [badge("acme/api", 6, { state: "CLOSED" })],
        },
      }),
    );
    expect(rows).toEqual([
      {
        repo: "acme/api",
        number: 5,
        title: "Badge 5",
        url: "https://github.com/acme/api/pull/5",
        isDraft: false,
        updatedAt: "2026-09-18T08:00:00Z",
        headRef: "fix/five",
        checks: "pending",
        reviewDecision: "APPROVED",
        owner: "theirs",
      },
    ]);
  });

  it("lets the freshest of two threads' badges speak for a PR, whoever owns it", () => {
    const later = "2026-09-17T08:30:00Z";
    const two = (other: PrStatus) =>
      threads({
        // The more recently active thread holds the older badge.
        recent: { pr: badge("acme/web", 1, { checks: "pending" }), lastActivityAt: 9 },
        quiet: { extraPrs: [other], lastActivityAt: 1 },
      });
    const merged = badge("acme/web", 1, { state: "MERGED", updatedAt: later });
    expect(openPrRows([pr("acme/web", 1)], two(merged))).toEqual([]);
    // The other way round: the more recently active thread holds the newer one.
    const swapped = threads({
      recent: { pr: merged, lastActivityAt: 9 },
      quiet: { extraPrs: [badge("acme/web", 1, { checks: "pending" })], lastActivityAt: 1 },
    });
    expect(openPrRows([pr("acme/web", 1)], swapped)).toEqual([]);
    expect(openPrRows([], swapped)).toEqual([]);
    // Once the poll stops listing it, the older OPEN badge doesn't bring it back.
    expect(openPrRows([], two(merged))).toEqual([]);
    const [row] = openPrRows(
      [pr("acme/web", 1)],
      two(badge("acme/web", 1, { checks: "failing", updatedAt: later })),
    );
    expect(row).toMatchObject({ checks: "failing", owner: "recent" });
    // A stale badge loses to one that isn't, however late it says it saw GitHub.
    const [kept] = openPrRows(
      [pr("acme/web", 1)],
      two({ ...merged, stale: { reason: "rate limited", since: 1 } }),
    );
    expect(kept?.number).toBe(1);
  });

  it("keeps a PR an older badge says merged, since the poll found it open after", () => {
    const rows = openPrRows(
      [pr("acme/web", 1)],
      threads({ t: { pr: badge("acme/web", 1, { state: "MERGED" }) } }),
    );
    expect(rows.map((r) => r.number)).toEqual([1]);
  });

  it("is the poll's list, newest first, with no threads", () => {
    const rows = openPrRows(
      [pr("acme/web", 1, { updatedAt: "2026-09-16T08:00:00Z" }), pr("acme/web", 2)],
      {},
    );
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
  });
});

const marksOf = (extra: Partial<OwnPr>) => prMarksOf(prFactsOfListPr(pr("acme/web", 1, extra)));
const merges = (extra: Partial<OwnPr>) => marksOf(extra).mergeAll.map((mark) => mark.kind);

describe("an open PR row's merge marks", () => {
  it("are the PR vocabulary's (`mergeMarksOf`), as the overview's rows have them", () => {
    expect(merges({ checks: "passing", mergeState: "DIRTY" })).toEqual(["conflicts"]);
    expect(marksOf({ mergeState: "DIRTY" }).merge?.detail).toBe("Conflicts with its base");
    expect(merges({ mergeState: "BEHIND" })).toEqual(["behind"]);
    expect(merges({ mergeState: "CLEAN", reviewDecision: "APPROVED" })).toEqual(["mergeable"]);
    expect(merges({ mergeState: "UNSTABLE" })).toEqual(["unstable"]);
    expect(merges({ mergeState: "BLOCKED" })).toEqual(["blocked"]);
    // A draft has no merge marks; its state says it.
    expect(merges({ mergeState: "CLEAN", isDraft: true })).toEqual([]);
  });

  it("leave only a draft's note to words", () => {
    expect(openPrMergeNote(pr("acme/web", 1, { mergeState: "BLOCKED" }))).toBeUndefined();
    expect(openPrMergeNote(pr("acme/web", 1, { isDraft: true }))).toBe(
      "A draft, so it can't merge yet",
    );
    expect(openPrMergeNote(pr("acme/web", 1, { mergeState: "DIRTY" }))).toBeUndefined();
  });
});

it("keeps supplementary information and ownership while a fresh badge replaces cached statuses", () => {
  const stamp = "2026-09-17T08:00:00Z";
  const rows = openPrRows(
    [
      pr("example/tools", 6, {
        author: "ada",
        isBot: false,
        labels: ["offline"],
        additions: 0,
        deletions: 8,
        informationAt: stamp,
        informationStale: true,
        detailsAt: stamp,
        detailsStale: true,
        checks: "failing",
        headOid: "old",
      }),
    ],
    threads({
      owned: {
        pr: badge("example/tools", 6, {
          updatedAt: "2026-09-17T09:00:00Z",
          checks: "passing",
          headRefOid: "new",
        }),
      },
    }),
  );
  expect(rows[0]).toMatchObject({
    author: "ada",
    isBot: false,
    labels: ["offline"],
    additions: 0,
    deletions: 8,
    informationAt: stamp,
    informationStale: true,
    checks: "passing",
    headOid: "new",
    owner: "owned",
  });
  expect(rows[0]?.detailsStale).toBeUndefined();
  expect(prMarksOf(prFactsOfListPr(rows[0]!)).checks).toMatchObject({
    kind: "passing",
    word: "Checks passing",
  });

  const stale = openPrRows(
    [pr("example/tools", 6, { checks: "failing", updatedAt: "2026-09-17T09:00:00Z" })],
    threads({
      other: {
        pr: badge("example/tools", 6, {
          updatedAt: "2026-09-17T10:00:00Z",
          checks: "passing",
          stale: { reason: "error", since: 1 },
        }),
      },
    }),
  );
  expect(stale[0]?.checks).toBe("failing");
});
