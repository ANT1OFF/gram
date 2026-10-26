import { describe, expect, it } from "@effect/vitest";
import {
  anyPrOpen,
  mergedAndDone,
  threadPrBadges,
  type GitState,
  type MergeSettle,
  type PrStatus,
  type Thread,
} from "@gram/contracts";
import { branchPrOf, completionStep, workSince } from "./completion.ts";

const url = (n: number, repo = "acme/web") => `https://github.com/${repo}/pull/${n}`;

const pr = (number: number, overrides: Partial<PrStatus> = {}): PrStatus => ({
  number,
  state: "OPEN",
  url: url(number),
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...overrides,
});

const merged = (number: number, overrides: Partial<PrStatus> = {}) =>
  pr(number, { state: "MERGED", ...overrides });

const git = (overrides: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "feat/x",
  worktree: true,
  head: "h1",
  changesToken: "c1",
  changedFiles: 0,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 1,
  conflicts: false,
  ...overrides,
});

type CompletionThread = Parameters<typeof completionStep>[0];

const record = (numbers: ReadonlyArray<number>, overrides: Partial<MergeSettle> = {}) => ({
  merged: numbers.map((number) => ({ number, url: url(number) })),
  head: "h1",
  changesToken: "c1",
  ...overrides,
});

/** A thread that settled when #7 merged, with the checkout as it was then. */
const settledOn7: CompletionThread = {
  completedAt: 1,
  completedReason: "prMerged",
  settledMerge: record([7]),
};

const step = (
  thread: CompletionThread,
  state: GitState,
  prs: ReadonlyArray<PrStatus | undefined> = state.pr ? [state.pr] : [],
) => completionStep(thread, state, prs);

describe("completionStep", () => {
  it("settles once on a merge, recording which and where the checkout was", () => {
    const state = git({ pr: merged(7) });
    expect(step({}, state)).toEqual({
      kind: "settle",
      prs: [{ number: 7, url: url(7) }],
      merge: record([7]),
    });
    expect(step(settledOn7, state)).toEqual({ kind: "none" });
  });

  it("case 1: reopens when work resumes after the merge, and the same merge doesn't settle it again", () => {
    const commit = git({ pr: merged(7, { aheadOfPr: true }), head: "h2", changesToken: "c2" });
    expect(step(settledOn7, commit)).toEqual({ kind: "reopen" });
    const edits = git({ pr: merged(7), changesToken: "c2", changedFiles: 2 });
    expect(step(settledOn7, edits)).toEqual({ kind: "reopen" });
    // Reopened: the merge it settled on is recorded, so it stays open.
    const { completedAt: _at, completedReason: _reason, ...reopened } = settledOn7;
    expect(step(reopened, commit)).toEqual({ kind: "none" });
  });

  it("case 1: switching to the base and pulling, or a stray file, is not work", () => {
    // `resolveBase` gives a checkout on the default branch no base at all.
    const { base: _base, ...onMain } = git({ branch: "main", head: "main", aheadBase: 0 });
    expect(step(settledOn7, onMain, [])).toEqual({ kind: "none" });
    expect(step(settledOn7, git({ pr: merged(7), head: "main", aheadBase: 0 }))).toEqual({
      kind: "none",
    });
    const stray = { ...settledOn7, settledMerge: record([7], { changesToken: "c-stray" }) };
    // The stray file goes: the token moves, but nothing is left changed.
    expect(step(stray, git({ pr: merged(7), changesToken: "c1", changedFiles: 0 }))).toEqual({
      kind: "none",
    });
    // Edits after the pull are work, though nothing is ahead of the base.
    const edited = { ...onMain, changesToken: "c3", changedFiles: 1 };
    expect(step(settledOn7, edited, [])).toEqual({ kind: "reopen" });
    expect(step(stray, git({ pr: merged(7), changesToken: "c-stray", changedFiles: 1 }))).toEqual({
      kind: "none",
    });
  });

  it("case 2: a second PR bound after the merge reopens it, and its own merge settles and names it", () => {
    const bound = { ...settledOn7, boundPr: { repo: "acme/web", number: 8, monitor: false } };
    expect(step(bound, git({ pr: pr(8) }))).toEqual({ kind: "reopen" });
    const { completedAt: _at, completedReason: _reason, ...reopened } = bound;
    expect(step(reopened, git({ pr: merged(8, { headMatches: false }) }))).toMatchObject({
      kind: "settle",
      prs: [{ number: 8, url: url(8) }],
    });
  });

  it("remembers every merge it settled on across rebinds, so binding an old one again is no news", () => {
    const on8 = {
      ...settledOn7,
      boundPr: { repo: "acme/web", number: 8, monitor: false },
      completedAt: undefined,
      completedReason: undefined,
    };
    const { completedAt: _at, completedReason: _reason, ...reopened } = on8;
    const settled8 = step(reopened, git({ pr: merged(8, { headMatches: false }) }));
    expect(settled8).toMatchObject({ kind: "settle", prs: [{ number: 8 }] });
    const merge = settled8.kind === "settle" ? settled8.merge : undefined;
    expect(merge?.merged.map((mark) => mark.number)).toEqual([7, 8]);
    const back = {
      boundPr: { repo: "acme/web", number: 7, monitor: false },
      ...(merge === undefined ? {} : { settledMerge: merge }),
    };
    expect(step(back, git({ pr: merged(7) }))).toEqual({ kind: "none" });
  });

  it("case 3: a thread marked done keeps its completion when the PR merges; an idle one becomes merged", () => {
    const state = git({ pr: merged(7) });
    const agent: CompletionThread = { completedAt: 1, completedReason: "agent" };
    expect(step(agent, state)).toEqual({ kind: "record", merge: record([7]) });
    // Its merge recorded, the agent's word isn't undone by a PR that opens, nor by more work.
    expect(step({ ...agent, settledMerge: record([7]) }, git({ pr: pr(8) }))).toEqual({
      kind: "none",
    });
  });

  it("case 4: a followed PR still open holds the settle, and reopens a merge completion", () => {
    const extra = pr(9, { url: url(9, "acme/lib") });
    const state = git({ pr: merged(7), extraPrs: [extra] });
    expect(step({}, state, [state.pr, extra])).toEqual({ kind: "none" });
    // One not looked up yet may be open: nothing settles, and nothing reopens on a guess either.
    expect(step({}, state, [state.pr, undefined])).toEqual({ kind: "none" });
    expect(step(settledOn7, state, [state.pr, undefined])).toEqual({ kind: "none" });
    expect(step(settledOn7, state, [state.pr, extra])).toEqual({ kind: "reopen" });
    const done = { ...extra, state: "MERGED" as const };
    expect(step({ settledMerge: record([7]) }, state, [state.pr, done])).toMatchObject({
      kind: "settle",
      prs: [{ number: 9 }],
    });
    // A closed one counts as none.
    expect(step({}, state, [state.pr, { ...extra, state: "CLOSED" }])).toMatchObject({
      kind: "settle",
    });
    // The main one closed unmerged: the followed one's merge settles it.
    const closed = git({ pr: pr(7, { state: "CLOSED" }), extraPrs: [done] });
    expect(step({}, closed, [closed.pr, done])).toMatchObject({
      kind: "settle",
      prs: [{ number: 9 }],
    });
  });

  it("case 5: with the remote branch gone, a new commit or another open PR by name reopens it", () => {
    expect(step(settledOn7, git({ head: "h2", changesToken: "c2" }), [])).toEqual({
      kind: "reopen",
    });
    expect(step(settledOn7, git({ pr: pr(12) }))).toEqual({ kind: "reopen" });
  });

  it("leaves an orchestrator alone, and a merge the checkout doesn't match", () => {
    expect(step({ role: "orchestrator" }, git({ pr: merged(7) }))).toEqual({ kind: "none" });
    expect(step({}, git({ pr: merged(7, { headMatches: false }) }))).toEqual({ kind: "none" });
  });
});

describe("workSince", () => {
  it("needs a recorded checkout and a repo", () => {
    expect(workSince({ merged: [] }, git({ head: "h2" }))).toBe(false);
    expect(workSince(record([7]), git({ repo: false, head: "h2" }))).toBe(false);
    // On the default branch there is no base, and nothing is ahead of one.
    const { base: _base, ...noBase } = git({ branch: "main", head: "h2", aheadBase: 0 });
    expect(workSince(record([7]), noBase)).toBe(false);
  });
});

describe("branchPrOf", () => {
  const bound = { boundPr: { repo: "acme/web", number: 7, monitor: false } };

  it("is the checkout's own PR only when the thread is bound to another", () => {
    expect(branchPrOf(bound, { pr: pr(8) })?.number).toBe(8);
    expect(branchPrOf(bound, { pr: merged(7) })).toBeUndefined();
    expect(branchPrOf({}, { pr: pr(8) })).toBeUndefined();
    expect(
      branchPrOf(
        { ...bound, extraPrs: [{ repo: "acme/web", number: 8, monitor: false }] },
        {
          pr: pr(8),
        },
      ),
    ).toBeUndefined();
  });
});

const following = (
  extras: ReadonlyArray<number>,
): Pick<Thread, "extraPrs" | "completedReason"> => ({
  extraPrs: extras.map((number) => ({ repo: "acme/web", number, monitor: false })),
});

describe("the shared completion predicates", () => {
  it("leaves a gap for a bound main PR whose badge hasn't landed", () => {
    const bound = { boundPr: { repo: "acme/web", number: 7, monitor: false } };
    expect(threadPrBadges(bound, git({ pr: pr(8) }))).toEqual([undefined]);
    expect(threadPrBadges(bound, undefined)).toEqual([undefined]);
    expect(threadPrBadges(bound, git({ pr: merged(7) }))).toEqual([merged(7)]);
    // So a followed PR's merge can't settle the thread while the main one may still be open.
    const extra = merged(9, { url: url(9, "acme/lib") });
    const state = git({ extraPrs: [extra] });
    const prs = threadPrBadges(
      { ...bound, extraPrs: [{ repo: "acme/lib", number: 9, monitor: false }] },
      state,
    );
    expect(step(bound, state, prs)).toEqual({ kind: "none" });
  });

  it("reads a badge of the bound PR's number from another repo as not landed yet", () => {
    // Rebound from acme/old#12 to acme/new#12 before the new badge came: the old one's merge
    // is neither the thread's, here or in the ledger, nor a reason to settle it.
    const old = merged(12, { url: url(12, "acme/old") });
    const rebound = { boundPr: { repo: "acme/new", number: 12, monitor: false } };
    const prs = threadPrBadges(rebound, git({ pr: old }));
    expect(prs).toEqual([undefined]);
    expect(mergedAndDone({}, prs)).toBe(false);
    expect(step(rebound, git({ pr: old }), prs)).toEqual({ kind: "none" });
    expect(step(rebound, git({ pr: old }), [old])).toEqual({ kind: "none" });
    const own = merged(12, { url: url(12, "Acme/New") });
    expect(threadPrBadges(rebound, git({ pr: own }))).toEqual([own]);
  });

  it("leaves out a bound PR GitHub says doesn't exist, so it holds nothing open", () => {
    const thread = {
      boundPr: { repo: "acme/web", number: 7, monitor: false },
      extraPrs: [{ repo: "acme/lib", number: 42, monitor: false }],
    };
    const missingPrs = [{ repo: "acme/lib", number: 42 }];
    expect(threadPrBadges(thread, git({ pr: merged(7), missingPrs }))).toEqual([merged(7)]);
    expect(threadPrBadges(thread, git({ missingPrs: [{ repo: "acme/web", number: 7 }] }))).toEqual([
      undefined,
    ]);
    expect(
      mergedAndDone(
        { completedReason: "prMerged" },
        threadPrBadges(thread, git({ pr: merged(7), missingPrs })),
      ),
    ).toBe(true);
  });

  it("lists a thread's PRs with a gap for one not looked up, which counts as open", () => {
    const state = git({ pr: merged(7), extraPrs: [merged(9)] });
    const prs = threadPrBadges(following([9, 10]), state);
    expect(prs.map((badge) => badge?.number)).toEqual([7, 9, undefined]);
    expect(anyPrOpen(prs)).toBe(true);
    expect(mergedAndDone(following([9, 10]), prs)).toBe(false);
    expect(mergedAndDone(following([9]), threadPrBadges(following([9]), state))).toBe(true);
  });

  it("isn't merged once reopened since its merges, until a merge it hasn't seen", () => {
    const reopened = { settledMerge: record([7]) };
    expect(mergedAndDone(reopened, [merged(7)])).toBe(false);
    expect(mergedAndDone(reopened, [merged(7), merged(8)])).toBe(true);
    expect(
      mergedAndDone({ ...reopened, completedAt: 1, completedReason: "prMerged" }, [merged(7)]),
    ).toBe(true);
  });

  it("an open PR wins over a merge completion", () => {
    expect(mergedAndDone({ completedReason: "prMerged" }, [pr(225)])).toBe(false);
    expect(mergedAndDone({ completedReason: "prMerged" }, [])).toBe(true);
    expect(mergedAndDone({ completedReason: "agent" }, [pr(7, { state: "CLOSED" })])).toBe(false);
  });
});
