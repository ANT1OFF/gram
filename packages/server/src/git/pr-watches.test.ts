import { describe, expect, it } from "vitest";
import { ThreadId, type PrStatus } from "@gram/contracts";
import * as Schema from "effect/Schema";
import { makePrWatches } from "./pr-watches.ts";

const t1 = Schema.decodeUnknownSync(ThreadId)("t1");
const t2 = Schema.decodeUnknownSync(ThreadId)("t2");
const ref = { repo: "acme/web", number: 7 };
const badge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 7,
  url: "https://github.com/acme/web/pull/7",
  state: "OPEN",
  title: "Invented PR",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: "head1",
  ...overrides,
});

describe("PR watch ownership", () => {
  it("combines owners and threads into one lookup with reviews, keeping repository identity", () => {
    const watches = makePrWatches();
    watches.replace("wake", [{ ...ref, threadId: t1 }]);
    watches.replace("dependency", [
      { repo: "ACME/Web", number: 7, threadId: t1, reviews: true },
      { ...ref, threadId: t2 },
      { repo: "acme/lib", number: 7, threadId: t2 },
    ]);
    expect(watches.forThread(t1)).toHaveLength(1);
    expect(watches.forThreads([t1, t2])).toEqual([
      { ...ref, threadId: t2, reviews: true },
      { repo: "acme/lib", number: 7, threadId: t2, reviews: false },
    ]);
    watches.replace("dependency", []);
    expect(watches.forThread(t2)).toEqual([]);
    expect(watches.forThread(t1)).toEqual([{ ...ref, threadId: t1, reviews: false }]);
  });

  it("keeps a shared badge until its last owner leaves and removes obsolete thread indexes", () => {
    const watches = makePrWatches();
    watches.replace("wake", [{ ...ref, threadId: t1 }]);
    watches.replace("dependency", [{ ...ref, threadId: t2 }]);
    const seen = badge();
    expect(watches.note(seen)).toBe(seen);
    watches.replace("wake", [{ repo: "acme/lib", number: 8, threadId: t1 }]);
    expect(watches.badge(ref)).toBe(seen);
    expect(watches.forThread(t1)[0]?.repo).toBe("acme/lib");
    watches.replace("dependency", []);
    expect(watches.has(ref)).toBe(false);
    expect(watches.badge(ref)).toBeUndefined();
    expect(watches.note(seen)).toBeUndefined();
  });

  it("preserves read reviews only on the same head and reports each changed badge once", () => {
    const watches = makePrWatches();
    watches.replace("wake", [{ ...ref, threadId: t1 }]);
    const review = {
      threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
      bots: ["invented-bot"],
      roundInFlight: false,
      verdictOnHead: "approved" as const,
      reviewedHead: true,
    };
    watches.note(badge({ review }));
    const unread = badge({ checks: "passing", reviewUnread: true });
    expect(watches.note(unread)).toEqual(badge({ checks: "passing", review }));
    expect(watches.note(unread)).toBeUndefined();
    expect(watches.badge(ref)?.review).toBe(review);
    const pushed = badge({ headRefOid: "head2", reviewUnread: true });
    expect(watches.note(pushed)).toBe(pushed);
    expect(watches.badge(ref)?.review).toBeUndefined();
  });

  it("ignores stale, malformed and other-repository observations", () => {
    const watches = makePrWatches();
    watches.replace("wake", [{ ...ref, threadId: t1 }]);
    const seen = badge();
    watches.note(seen);
    expect(
      watches.note(badge({ checks: "passing", stale: { since: 1, reason: "offline" } })),
    ).toBeUndefined();
    expect(watches.note(badge({ url: "invalid" }))).toBeUndefined();
    expect(watches.note(badge({ url: "https://github.com/acme/lib/pull/7" }))).toBeUndefined();
    expect(watches.badge(ref)).toBe(seen);
  });

  it("keeps an explicit lookup for a later watch without replaying the same observation", () => {
    const watches = makePrWatches();
    const seen = badge();
    watches.remember(ref, seen);
    expect(watches.badge(ref)).toBe(seen);
    watches.replace("wake", [{ ...ref, threadId: t1 }]);
    expect(watches.note(seen)).toBeUndefined();
    watches.replace("wake", []);
    expect(watches.badge(ref)).toBeUndefined();
  });
});
