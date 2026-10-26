import {
  MAX_EXTRA_PRS,
  MAX_HIDDEN_PRS,
  samePr,
  type BoundPr,
  type HiddenPr,
  type PrStatus,
  type Thread,
  type ThreadId,
} from "@gram/contracts";

import { MockInvalidState } from "./mock-fs";

// `Thread.extraPrs` and `Thread.hiddenPrs` for MockApi: the server's refusals, and a badge per
// followed PR.

const CHECKS: readonly PrStatus["checks"][] = ["passing", "failing", "pending"];

/** A followed PR's badge; its checks depend only on the number, so a spec can pick an outcome. */
export const mockExtraBadge = ({ repo, number }: Pick<BoundPr, "repo" | "number">): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/${repo}/pull/${number}`,
  title: `Pull request #${number}`,
  isDraft: false,
  checks: CHECKS[number % CHECKS.length]!,
  headMatches: false,
  aheadOfPr: false,
  headRef: `feat/pr-${number}`,
  author: "mona",
  additions: number * 3,
  deletions: number,
  changedFiles: number,
  updatedAt: "2026-09-16T11:20:00Z",
});

export interface MockExtraPrsHost {
  thread(threadId: ThreadId): Thread;
  /** Stores the thread and emits `thread.upsert`. */
  replace(thread: Thread): void;
}

const withExtras = (thread: Thread, extras: readonly BoundPr[]): Thread => {
  const { extraPrs: _extras, ...rest } = thread;
  return extras.length === 0 ? rest : { ...rest, extraPrs: extras };
};

export function createMockExtraPrs(host: MockExtraPrsHost) {
  return {
    bind(threadId: ThreadId, repo: string, number: number, monitor = false) {
      const thread = host.thread(threadId);
      const extras = thread.extraPrs ?? [];
      const ref = { repo, number };
      if (thread.boundPr && samePr(thread.boundPr, ref)) {
        throw new MockInvalidState(`${repo}#${number} is already this thread's pull request`);
      }
      if (extras.some((extra) => samePr(extra, ref))) {
        throw new MockInvalidState(`${repo}#${number} is already followed by this thread`);
      }
      if (extras.length >= MAX_EXTRA_PRS) {
        throw new MockInvalidState(`a thread follows at most ${MAX_EXTRA_PRS} extra pull requests`);
      }
      const next = [...extras, { repo, number, monitor }];
      host.replace(withExtras(thread, next));
      return next;
    },

    unbind(threadId: ThreadId, repo: string, number: number) {
      const thread = host.thread(threadId);
      host.replace(
        withExtras(
          thread,
          (thread.extraPrs ?? []).filter((extra) => !samePr(extra, { repo, number })),
        ),
      );
    },

    setMonitor(threadId: ThreadId, repo: string, number: number, monitor: boolean) {
      const thread = host.thread(threadId);
      const extras = thread.extraPrs ?? [];
      if (!extras.some((extra) => samePr(extra, { repo, number }))) {
        throw new MockInvalidState(`${repo}#${number} isn't followed by this thread`);
      }
      host.replace(
        withExtras(
          thread,
          extras.map((extra) => (samePr(extra, { repo, number }) ? { ...extra, monitor } : extra)),
        ),
      );
    },

    promote(threadId: ThreadId, repo: string, number: number): BoundPr {
      const thread = host.thread(threadId);
      const extras = thread.extraPrs ?? [];
      const promoted = extras.find((extra) => samePr(extra, { repo, number }));
      if (!promoted) throw new MockInvalidState(`${repo}#${number} isn't followed by this thread`);
      if (thread.babysit) {
        throw new MockInvalidState(
          "Babysit mode is tied to the current pull request; turn it off first.",
        );
      }
      const demoted = thread.boundPr
        ? [
            {
              repo: thread.boundPr.repo,
              number: thread.boundPr.number,
              monitor: thread.boundPr.monitor,
            },
          ]
        : [];
      const rest = extras.filter((extra) => !samePr(extra, { repo, number }));
      host.replace({ ...withExtras(thread, [...demoted, ...rest]), boundPr: promoted });
      return promoted;
    },

    hide(threadId: ThreadId, pr: HiddenPr) {
      const thread = host.thread(threadId);
      const kept = (thread.hiddenPrs ?? []).filter((hidden) => !samePr(hidden, pr));
      host.replace({ ...thread, hiddenPrs: [...kept, pr].slice(-MAX_HIDDEN_PRS) });
    },

    showHidden(threadId: ThreadId) {
      const { hiddenPrs: _hidden, ...rest } = host.thread(threadId);
      host.replace(rest);
    },
  };
}
