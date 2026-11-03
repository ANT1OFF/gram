import type { OrchestratorLedger, ThreadId } from "@gram/contracts";

import { useNow } from "@/lib/use-now";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";

import { orchestratorWaitingOn, type WaitingOn } from "./waiting-on";
import { workerWaitings } from "./workers-model";

// What a workspace's workers and its orchestrator wait on, for the sidebar's rows and the Board's
// chips; ⌘J's rows read the same `workerWaitings` through their own rows. Times tick by the minute.

const NO_ASKS: ReadonlySet<ThreadId> = new Set();

/** What each of the ledger's workers at rest waits on, by thread (`workerWaitings`). */
export function useWorkerWaitings(
  ledger: Pick<OrchestratorLedger, "features"> | undefined,
  asking: ReadonlySet<ThreadId> = NO_ASKS,
): Readonly<Record<string, WaitingOn>> {
  const now = useNow(ledger !== undefined, undefined, 60_000);
  return useThreadsStore(
    useSame((s) =>
      workerWaitings(ledger, { byId: s.byId, statusDetail: s.statusDetail, now, asking }),
    ),
  );
}

/**
 * What the workspace's orchestrator waits on at rest (`orchestratorWaitingOn`): the wakes its
 * ledger lists and a limit its thread waits out.
 */
export function useOrchestratorWaiting(
  ledger: Pick<OrchestratorLedger, "orchestratorThreadId" | "wakes"> | undefined,
): WaitingOn | undefined {
  const threadId = ledger?.orchestratorThreadId;
  const status = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.status,
  );
  const limitWait = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread.limitWait,
  );
  const waits = (ledger?.wakes?.length ?? 0) > 0 || limitWait !== undefined;
  const now = useNow(waits, undefined, 60_000);
  if (threadId === undefined || !waits) return undefined;
  return orchestratorWaitingOn(
    {
      status,
      wakes: ledger?.wakes,
      limitWait: limitWait?.cancelled === true ? undefined : limitWait,
    },
    now,
  );
}
