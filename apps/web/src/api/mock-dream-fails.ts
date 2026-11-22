import type { Dream, Thread } from "@gram/contracts";

import { sleep } from "@/lib/sleep";

import type { MockDreamsHost } from "./mock-dreams";
import { mockDreamFails } from "./mock-overrides";

/**
 * With `gram.mock.dreamFails`, the memory update `dream` fails a moment after it starts: its
 * thread ends in error before writing anything, and the update records an `agent_error`.
 */
export const failDreamSoon = (
  host: Pick<MockDreamsHost, "replace" | "setStatus">,
  thread: Thread,
  dream: Dream,
  put: (next: Dream) => Dream,
): void => {
  if (!mockDreamFails()) return;
  void sleep(1_500).then(() => {
    host.replace({
      ...thread,
      lastError: {
        kind: "modelUnavailable",
        retryable: true,
        text: "Claude Code stopped: the model was overloaded (529) before the update wrote anything.",
        at: Date.now(),
      },
    });
    host.setStatus(thread.id, "error");
    put({ ...dream, status: "failed", failure: "agent_error", endedAt: Date.now() });
  });
};
