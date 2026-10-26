import { describe, expect, it } from "@effect/vitest";
import {
  HelperEventPayload,
  RECAP_AWAY_MS,
  RECAP_IDLE_MS,
  RecapView,
  recapDue,
  recapFacts,
  suggestKeepRate,
} from "./assist.ts";
import type { GitState } from "./git.ts";
import type { ThreadId, TurnId } from "./ids.ts";
import { expectRoundTrip } from "./test-utils.ts";

const git = (patch: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "chore/deps",
  worktree: true,
  head: "abc123",
  changesToken: "tok",
  changedFiles: 0,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  ...patch,
});

const pr = (patch: Partial<NonNullable<GitState["pr"]>> = {}): NonNullable<GitState["pr"]> => ({
  number: 235,
  state: "OPEN",
  url: "https://github.com/o/r/pull/235",
  title: "Codex effort",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...patch,
});

describe("recapDue", () => {
  const now = 100 * RECAP_AWAY_MS;
  const idle = now - RECAP_IDLE_MS;

  it("wants a thread idle two hours with something new since you left it", () => {
    expect(recapDue({ now, lastActivityAt: idle, lastViewedAt: idle - 1, busy: false })).toBe(true);
    expect(recapDue({ now, lastActivityAt: idle + 1, lastViewedAt: 0, busy: false })).toBe(false);
  });

  it("counts a thread never left as unseen", () => {
    expect(recapDue({ now, lastActivityAt: idle, busy: false })).toBe(true);
  });

  it("wants nothing for a thread you saw settle, until you've been away a day", () => {
    expect(recapDue({ now, lastActivityAt: idle - 10, lastViewedAt: idle, busy: false })).toBe(
      false,
    );
    const away = now - RECAP_AWAY_MS;
    expect(recapDue({ now, lastActivityAt: away - 10, lastViewedAt: away, busy: false })).toBe(
      true,
    );
  });

  it("never interrupts a turn that is running or waiting on you", () => {
    expect(recapDue({ now, lastActivityAt: 0, busy: true })).toBe(false);
  });
});

/** The default branch, which the git state gives no `base`. */
const onMain = ({ base: _base, ...rest }: GitState): GitState => ({ ...rest, branch: "main" });

describe("recapFacts", () => {
  it("says what the branch holds that isn't on GitHub yet", () => {
    expect(recapFacts(git({ changedFiles: 14, aheadBase: 2 }))).toEqual([
      "14 files changed",
      "not pushed",
      "no PR yet",
    ]);
    expect(recapFacts(git({ changedFiles: 1 }))).toEqual(["1 file changed", "no PR yet"]);
  });

  it("names the PR and whether the branch is pushed to it", () => {
    expect(recapFacts(git({ aheadBase: 3, upstream: "synced", pr: pr() }))).toEqual([
      "pushed",
      "#235 open",
    ]);
    expect(
      recapFacts(
        git({ aheadBase: 3, upstream: "ahead", aheadUpstream: 1, pr: pr({ isDraft: true }) }),
      ),
    ).toEqual(["not pushed", "#235 draft"]);
    expect(recapFacts(git({ pr: pr({ state: "MERGED" }) }))).toEqual(["#235 merged"]);
  });

  it("has nothing to say about a clean base branch or a folder outside git", () => {
    expect(recapFacts(onMain(git()))).toEqual([]);
    expect(recapFacts(onMain(git({ changedFiles: 2 })))).toEqual(["2 files changed"]);
    expect(recapFacts(git({ repo: false, changedFiles: 3 }))).toEqual([]);
    expect(recapFacts(undefined)).toEqual([]);
  });
});

describe("assist contracts", () => {
  it("round-trips a recap and a helper event", () => {
    expectRoundTrip(RecapView, {
      threadId: "t1" as ThreadId,
      recap: { recap: "You bumped the deps.", next: null, replies: ["Commit this"] },
      lastActiveAt: 5,
      turnId: "turn-1" as TurnId,
    });
    expectRoundTrip(HelperEventPayload, { kind: "recap", event: "dismissedFast" });
  });
});

describe("suggestKeepRate", () => {
  it("counts the turns whose suggestions were taken against the turns they showed in", () => {
    expect(suggestKeepRate({ shown: 0, taken: 0 })).toBeUndefined();
    expect(suggestKeepRate({ shown: 10, taken: 2 })).toBe(0.2);
    expect(suggestKeepRate({ shown: 2, taken: 3 })).toBe(1);
  });
});
