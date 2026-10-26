import {
  initialBabysitState,
  serializeReviewNotice,
  type BabysitBudget,
  type HumanReviewNotice,
  type ReviewMonitorResult,
  type ReviewNotice,
  type GramUIMessage,
  type Thread,
  type ThreadId,
} from "@gram/contracts";

import { MockInvalidState } from "./mock-fs";
import { MOCK_HEAD_OID } from "./mock-review";

// Babysit mode for MockApi: the toggle, then one scripted review notice round.

const PR_URL = "https://github.com/example/api/pull/412";

export const mockReviewNotice = (number: number): ReviewNotice => ({
  kind: "review",
  number,
  headRefOid: MOCK_HEAD_OID,
  verdict: "changesRequested",
  mergeState: "BLOCKED",
  round: 3,
  blockers: [
    {
      reviewThreadId: "PRRT_retry_last_error",
      path: "src/retry.ts",
      line: 42,
      body: "`retry` swallows the last error once attempts run out, so callers see `undefined` instead of the failure.",
      url: `${PR_URL}#discussion_PRRC_1`,
    },
  ],
  suggestions: [
    {
      reviewThreadId: "PRRT_tick_async",
      path: "src/retry.test.ts",
      line: 18,
      body: "Drain pending timers instead of ticking a fixed 100 ms.",
      url: `${PR_URL}#discussion_PRRC_3`,
    },
  ],
  ciFailed: ["test (windows)"],
});

export const mockHumanReviewNotice = (number: number): HumanReviewNotice => ({
  kind: "humanReview",
  number,
  headRefOid: MOCK_HEAD_OID,
  reviews: [
    {
      id: "PRR_person_2",
      author: "octocat",
      verdict: "changesRequested",
      commitOid: MOCK_HEAD_OID,
      submittedAt: "2026-09-25T10:01:00Z",
      body: "The retry needs a test for the last attempt.",
    },
    {
      id: "PRR_person_1",
      author: "hubot",
      verdict: "approved",
      commitOid: MOCK_HEAD_OID,
      submittedAt: "2026-09-25T10:00:00Z",
      body: "",
    },
  ],
  newReviewIds: ["PRR_person_2"],
});

export interface MockBabysitHost {
  thread(threadId: ThreadId): Thread;
  /** The branch's PR from the thread's git state. */
  pr(threadId: ThreadId): { repo: string; number: number } | undefined;
  /** Stores the thread and emits `thread.upsert`. */
  replace(thread: Thread): void;
  putMessage(threadId: ThreadId, message: GramUIMessage): void;
  delay(ms: number): Promise<void>;
  ids(): string;
}

/** `thread.setBabysit` for the mock; a first notice lands shortly after enabling. */
export function createMockBabysit(host: MockBabysitHost) {
  const deliverNotice = async (threadId: ThreadId, startedAt: number) => {
    await host.delay(2000);
    const thread = host.thread(threadId);
    if (!thread.babysit || thread.babysit.startedAt !== startedAt || !thread.boundPr) return;
    const notice = mockReviewNotice(thread.boundPr.number);
    host.putMessage(threadId, {
      id: host.ids(),
      role: "user",
      metadata: { createdAt: Date.now() },
      parts: [
        { type: "text", text: serializeReviewNotice(notice) },
        { type: "data-review-notice", id: host.ids(), data: notice },
      ],
    });
    host.replace({
      ...thread,
      babysit: { ...thread.babysit, rounds: 1 },
      lastActivityAt: Date.now(),
    });
  };

  return {
    async set(threadId: ThreadId, enabled: boolean, budget?: BabysitBudget): Promise<Thread> {
      const current = host.thread(threadId);
      if (!enabled) {
        const { babysit: _off, ...rest } = current;
        // Like the server: turning babysit off stops its review monitor too.
        const thread: Thread =
          rest.boundPr === undefined
            ? rest
            : { ...rest, boundPr: { ...rest.boundPr, reviewMonitor: false } };
        host.replace(thread);
        return thread;
      }
      const pr = current.boundPr ?? host.pr(threadId);
      if (!pr) throw new MockInvalidState("This branch has no PR");
      const startedAt = Date.now();
      const thread: Thread = {
        ...current,
        boundPr: {
          repo: pr.repo,
          number: pr.number,
          monitor: current.boundPr?.monitor ?? false,
          reviewMonitor: true,
        },
        babysit: initialBabysitState(startedAt, budget),
      };
      host.replace(thread);
      void deliverNotice(threadId, startedAt);
      return thread;
    },

    async setReviewMonitor(threadId: ThreadId, enabled: boolean): Promise<ReviewMonitorResult> {
      const current = host.thread(threadId);
      const pr = current.boundPr ?? host.pr(threadId);
      if (!pr) {
        if (!enabled) return {};
        throw new MockInvalidState("This branch has no PR");
      }
      const bound = {
        repo: pr.repo,
        number: pr.number,
        monitor: current.boundPr?.monitor ?? false,
        reviewMonitor: enabled,
      };
      host.replace({ ...current, boundPr: bound });
      return { bound };
    },
  };
}
