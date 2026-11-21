import type { OrchestratorLedger, WorkspaceId } from "@gram/contracts";

export interface LedgerWatchOptions<T = OrchestratorLedger> {
  /** Opens the stream; iteration ends when `signal` aborts. */
  readonly open: (workspaceId: WorkspaceId, signal: AbortSignal) => AsyncIterable<T>;
  /** Every item a stream yields (a ledger, or the feature cards), the first one included. */
  readonly publish: (item: T) => void;
  /**
   * How long a stream outlives its last viewer, so going from the board to a worker and back doesn't
   * reopen it. 0 closes it at once.
   */
  readonly keepWarmMs?: number;
}

export interface LedgerWatch {
  /** Counts one more viewer of the workspace's ledger; call the result once when it leaves. */
  retain(workspaceId: WorkspaceId): () => void;
  /** The workspaces with an open stream, for tests and diagnostics. */
  watching(): readonly WorkspaceId[];
  /** Whether the workspace's stream is open and has delivered: it carries every change from then. */
  isLive(workspaceId: WorkspaceId): boolean;
}

interface Entry {
  refs: number;
  readonly abort: AbortController;
  evict: ReturnType<typeof setTimeout> | undefined;
  delivered: boolean;
}

const LEDGER_KEEP_WARM_MS = 5_000;

export function createLedgerWatch<T = OrchestratorLedger>({
  open,
  publish,
  keepWarmMs = LEDGER_KEEP_WARM_MS,
}: LedgerWatchOptions<T>): LedgerWatch {
  const entries = new Map<WorkspaceId, Entry>();

  const start = (workspaceId: WorkspaceId): Entry => {
    const entry: Entry = {
      refs: 0,
      abort: new AbortController(),
      evict: undefined,
      delivered: false,
    };
    entries.set(workspaceId, entry);
    void (async () => {
      try {
        for await (const item of open(workspaceId, entry.abort.signal)) {
          entry.delivered = true;
          publish(item);
        }
      } catch (error) {
        if (!entry.abort.signal.aborted) console.error("ledger watch", workspaceId, error);
      }
      if (entries.get(workspaceId) === entry && !entry.abort.signal.aborted) {
        clearTimeout(entry.evict);
        entries.delete(workspaceId);
      }
    })();
    return entry;
  };

  const close = (workspaceId: WorkspaceId, entry: Entry) => {
    entry.abort.abort();
    if (entries.get(workspaceId) === entry) entries.delete(workspaceId);
  };

  return {
    retain(workspaceId) {
      const entry = entries.get(workspaceId) ?? start(workspaceId);
      entry.refs++;
      clearTimeout(entry.evict);
      entry.evict = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (entry.refs > 0) return;
        if (keepWarmMs <= 0) close(workspaceId, entry);
        else entry.evict = setTimeout(() => close(workspaceId, entry), keepWarmMs);
      };
    },
    watching: () => [...entries.keys()],
    isLive: (workspaceId) => {
      const entry = entries.get(workspaceId);
      return entry !== undefined && entry.delivered && !entry.abort.signal.aborted;
    },
  };
}
