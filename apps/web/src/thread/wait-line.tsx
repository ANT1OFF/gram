import type { ThreadId } from "@gram/contracts";

import { useThreadsStore } from "@/stores/threads";

import { LimitWaitLine } from "./limit-wait-line";
import { MachineMoveLine } from "./machine-move-line";

const LIVE: ReadonlySet<string> = new Set(["running", "starting"]);

const movingUnderLiveSession = (
  entry:
    | { readonly thread: { readonly machineMove?: unknown }; readonly status: string }
    | undefined,
): boolean => entry?.thread.machineMove !== undefined && LIVE.has(entry.status);

/**
 * Whether the thread waits to carry on by itself, which a quiet line under its transcript says
 * (`WaitLine`): its machine is moving, or it waits out a provider limit, or one just cleared.
 */
export const useWaitLine = (threadId: ThreadId): boolean =>
  useThreadsStore((s) => {
    const thread = s.byId[threadId]?.thread;
    return (
      movingUnderLiveSession(s.byId[threadId]) ||
      thread?.limitWait !== undefined ||
      thread?.limitCleared !== undefined
    );
  });

/** The quiet line of a thread that waits to carry on by itself, in place of an error. */
export function WaitLine({ threadId }: { threadId: ThreadId }) {
  const machineMove = useThreadsStore((s) =>
    movingUnderLiveSession(s.byId[threadId]) ? s.byId[threadId]?.thread.machineMove : undefined,
  );
  const limitWait = useThreadsStore((s) => s.byId[threadId]?.thread.limitWait);
  const limitCleared = useThreadsStore((s) => s.byId[threadId]?.thread.limitCleared);
  if (machineMove !== undefined) return <MachineMoveLine move={machineMove} />;
  return (
    <LimitWaitLine
      thread={{
        id: threadId,
        ...(limitWait === undefined ? {} : { limitWait }),
        ...(limitCleared === undefined ? {} : { limitCleared }),
      }}
    />
  );
}
