import type { ThreadId, ThreadSummary } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { focusedAttention } from "./use-acknowledge-attention";

const THREAD = "t-red" as ThreadId;

const summary = (checks: "failing" | "passing"): ThreadSummary =>
  ({
    thread: { id: THREAD, parked: false },
    status: "idle",
    pendingRequests: [],
    git: {
      repo: true,
      branch: "feat/x",
      worktree: true,
      head: "abc",
      changesToken: "t",
      changedFiles: 0,
      behindBase: 0,
      aheadBase: 0,
      conflicts: false,
      pr: {
        number: 1,
        state: "OPEN",
        url: "https://github.com/acme/web/pull/1",
        title: "x",
        isDraft: false,
        checks,
        headMatches: true,
        aheadOfPr: false,
        headRefOid: "abc",
      },
    },
  }) as unknown as ThreadSummary;

const input = (overrides: Partial<Parameters<typeof focusedAttention>[0]> = {}) => ({
  gridShown: true,
  hasFocus: true,
  loaded: true,
  focusedThread: THREAD,
  byId: { [THREAD]: summary("failing") },
  ...overrides,
});

describe("focusedAttention", () => {
  it("is the focused thread's attention while its pane is on screen in a focused window", () => {
    expect(focusedAttention(input())).toEqual({ threadId: THREAD, key: "ci:1:abc" });
  });

  it("acknowledges nothing off the thread grid, unfocused, unloaded or without attention", () => {
    // /new, /settings and / replace the grid, so the focused pane isn't what the user sees.
    expect(focusedAttention(input({ gridShown: false }))).toBeUndefined();
    expect(focusedAttention(input({ hasFocus: false }))).toBeUndefined();
    expect(focusedAttention(input({ loaded: false }))).toBeUndefined();
    expect(focusedAttention(input({ focusedThread: undefined }))).toBeUndefined();
    expect(focusedAttention(input({ byId: { [THREAD]: summary("passing") } }))).toBeUndefined();
  });
});
