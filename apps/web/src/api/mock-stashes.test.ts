import { DRAFT_STASH_LIMIT, type StashId, type ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { createMockStashes } from "./mock-stashes";

const T1 = "t-one" as ThreadId;
const T2 = "t-two" as ThreadId;

describe("createMockStashes", () => {
  it("keeps stashes per thread, newest first, dropping the oldest past the limit", () => {
    const stashes = createMockStashes(false);
    stashes.add(T2, "elsewhere", []);
    for (let n = 0; n <= DRAFT_STASH_LIMIT; n++) stashes.add(T1, `draft ${n}`, []);

    const own = stashes.list(T1);
    expect(own).toHaveLength(DRAFT_STASH_LIMIT);
    expect(own[0]?.text).toBe(`draft ${DRAFT_STASH_LIMIT}`);
    expect(own.map((s) => s.text)).not.toContain("draft 0");
    expect(stashes.list(T2).map((s) => s.text)).toEqual(["elsewhere"]);
  });

  it("stores a retried add with the same id once, and refuses another thread's id", () => {
    const stashes = createMockStashes(false);
    const id = "5a9b6bc9-01d5-4fb3-aacf-ec410b8b74d5" as StashId;
    const first = stashes.add(T1, "sent once", [], id);

    expect(stashes.add(T1, "sent once", [], id)).toEqual(first);
    expect(stashes.list(T1)).toEqual([first]);
    expect(() => stashes.add(T2, "clash", [], id)).toThrow(/gone/);
    expect(stashes.list(T2)).toEqual([]);
  });

  it("takes a stash once, and only from its own thread", () => {
    const stashes = createMockStashes(false);
    const saved = stashes.add(T1, "half a thought", [{ path: "/tmp/shot.png", name: "shot.png" }]);

    expect(() => stashes.take(T2, saved.id)).toThrow(/gone/);
    expect(stashes.take(T1, saved.id)).toEqual(saved);
    expect(stashes.list(T1)).toEqual([]);
    expect(() => stashes.take(T1, saved.id)).toThrow(/gone/);
  });
});
