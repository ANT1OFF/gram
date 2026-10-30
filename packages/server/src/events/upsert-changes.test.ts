import { describe, expect, it } from "@effect/vitest";
import type { ServerEvent, Thread, ThreadId } from "@gram/contracts";
import { besidesActivity, upsertsChanging } from "./upsert-changes.ts";

const thread = (overrides: Partial<Thread> = {}) =>
  ({
    id: "t1",
    title: "one",
    parked: false,
    unread: false,
    lastActivityAt: 1,
    ...overrides,
  }) as unknown as Thread;

const upsert = (overrides: Partial<Thread> = {}): ServerEvent => ({
  type: "thread.upsert",
  thread: thread(overrides),
});

describe("upsertsChanging", () => {
  it("passes an upsert only when the fields it keys on moved", () => {
    const passes = upsertsChanging((t) => String(t.parked));
    expect(passes(upsert())).toBe(true);
    expect(passes(upsert({ title: "renamed" }))).toBe(false);
    expect(passes(upsert({ parked: true }))).toBe(true);
    expect(passes(upsert({ parked: true }))).toBe(false);
    // Each thread is followed on its own.
    expect(passes(upsert({ id: "t2" as ThreadId, parked: true }))).toBe(true);
    // A removed thread is forgotten, so its next upsert is news again.
    expect(passes({ type: "thread.removed", threadId: "t1" as ThreadId })).toBe(true);
    expect(passes(upsert({ parked: true }))).toBe(true);
    expect(passes({ type: "threads.snapshot", threads: [] })).toBe(true);
  });

  it("keys on all of a thread but its activity", () => {
    const passes = upsertsChanging(besidesActivity);
    expect(passes(upsert())).toBe(true);
    expect(passes(upsert({ lastActivityAt: 2, unread: true }))).toBe(false);
    expect(passes(upsert({ revision: 2 }))).toBe(false);
    expect(passes(upsert({ lastActivityAt: 3, title: "renamed" }))).toBe(true);
  });
});
