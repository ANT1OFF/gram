import type { ThreadId } from "@gram/contracts";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useThreadsStore } from "@/stores/threads";

/**
 * Stops one of `threadId`'s background tasks, saying so when it can't. A task already gone counts
 * as stopped; any other failure is shown and rethrown, so the Stop that asked can be pressed again.
 */
export function useStopTask(threadId: ThreadId) {
  const api = useApi();
  return (taskId: string) =>
    api.stopTask(threadId, taskId).catch((error: unknown) => {
      // Gone already, which is what Stop was for.
      if (Reflect.get(error as object, "_tag") === "NotFound") return;
      useThreadsStore.getState().applyEvent({
        type: "notify",
        kind: "error",
        title: "Couldn't stop it",
        body: errorMessage(error),
      });
      throw error;
    });
}
