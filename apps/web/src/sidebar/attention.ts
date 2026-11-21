import {
  requiredChecksOf,
  ledgerPrsOf,
  workerOwnsCiFix,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
} from "@gram/contracts";
import { create } from "zustand";
import { botAsksChanges, prUrlOf } from "@/components/pr-marks-model";
import { reviewStatusOf } from "@/components/review-glyph";
import { useThreadsStore } from "@/stores/threads";
import { liveWorkerEntry } from "@/orchestration/board-model";

/** Why an otherwise quiet thread needs the user. */
export type AttentionReason = "ciFailed" | "changesRequested";

export interface Attention {
  /** The most pressing reason: a red build before a change request. */
  readonly reason: AttentionReason;
  /**
   * Every active reason's occurrence: seeing it acknowledges them all, until a new head commit
   * fails or a new review round asks for changes.
   */
  readonly key: string;
  readonly label: string;
}

const QUIET: ReadonlySet<string> = new Set(["idle", "cold", "ended"]);

const LABELS: Record<AttentionReason, string> = {
  ciFailed: "CI failed",
  changesRequested: "Changes requested",
};

/**
 * What a thread's open PR asks of the user: a red required check and/or the review bot asking for
 * changes on its head (`botAsksChanges`, as its row's glyph reads it).
 * Absent while the agent works or asks, for a parked thread, once the PR is merged or closed, and
 * for an orchestrator, whose checkout's PR is none of the ones it drives. A worker's red build is
 * never the user's (`ownsCiFailure`): its worker fixes it, or its orchestrator, and an agent asks
 * the user when it needs them.
 */
export function attentionOf(summary: ThreadSummary): Attention | undefined {
  if (summary.thread.role === "orchestrator") return undefined;
  const pr = summary.git?.pr;
  if (pr === undefined || pr.state !== "OPEN") return undefined;
  if (summary.thread.parked || !QUIET.has(summary.status)) return undefined;
  const head = pr.headRefOid ?? pr.updatedAt ?? "";
  const reasons: Array<[AttentionReason, string]> = [];
  if (requiredChecksOf(pr) === "failing" && !ownsCiFailure(summary, pr.url))
    reasons.push(["ciFailed", `ci:${pr.number}:${head}`]);
  if (botAsksChanges(reviewStatusOf(pr.review))) {
    reasons.push(["changesRequested", `review:${pr.number}:${pr.review?.latestReviewId ?? head}`]);
  }
  const [first] = reasons;
  if (first === undefined) return undefined;
  return {
    reason: first[0],
    key: reasons.map(([, key]) => key).join("|"),
    label: LABELS[first[0]],
  };
}

/**
 * Whether an agent, not the user, answers for a thread's failing checks on the PR at `url`: the
 * thread is a worker (spawned by an orchestrator, or in its workspace's ledger, archived or not),
 * whose live self fixes them and whose orchestrator follows them up once it is gone; or a live
 * worker follows the same PR (`workerOwnsCiFix`). The latest ledger supplies the workers.
 */
export function ownsCiFailure(summary: ThreadSummary, url: string): boolean {
  if (summary.thread.spawnedBy !== undefined) return true;
  const ledger =
    summary.thread.workspaceId === undefined
      ? undefined
      : useAttentionStore.getState().ledgers[summary.thread.workspaceId];
  return (
    ledger?.features.some((feature) =>
      feature.workers.some((worker) => {
        if (worker.threadId === summary.thread.id) return true;
        const live = useThreadsStore.getState().byId[worker.threadId];
        if (live === undefined || live.thread.parked) return false;
        return ledgerPrsOf(worker).some(
          (pr) =>
            prUrlOf(pr).toLowerCase() === url.toLowerCase() &&
            workerOwnsCiFix(liveWorkerEntry(worker, live), pr),
        );
      }),
    ) ?? false
  );
}

/** Acknowledgements kept in settings; the least recently acknowledged go first. */
export const ACK_LIMIT = 200;

interface AttentionState {
  readonly ledgers: Readonly<Record<string, OrchestratorLedger>>;
  setLedger(ledger: OrchestratorLedger): void;
  readonly loaded: boolean;
  readonly acknowledged: Readonly<Record<string, string>>;
  hydrate(saved: readonly string[]): void;
  acknowledge(threadId: ThreadId, key: string): boolean;
}

const parseSaved = (saved: readonly string[]): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const entry of saved) {
    const space = entry.indexOf(" ");
    if (space > 0) record[entry.slice(0, space)] = entry.slice(space + 1);
  }
  return record;
};

export const savedAcknowledgements = (acknowledged: Readonly<Record<string, string>>): string[] =>
  Object.entries(acknowledged)
    .slice(-ACK_LIMIT)
    .map(([threadId, key]) => `${threadId} ${key}`);

export const useAttentionStore = create<AttentionState>()((set, get) => ({
  ledgers: {},
  setLedger: (ledger) =>
    set((s) =>
      s.ledgers[ledger.workspaceId] === ledger
        ? s
        : { ledgers: { ...s.ledgers, [ledger.workspaceId]: ledger } },
    ),
  loaded: false,
  acknowledged: {},
  hydrate: (saved) =>
    set((s) => ({ loaded: true, acknowledged: { ...parseSaved(saved), ...s.acknowledged } })),
  acknowledge: (threadId, key) => {
    if (get().acknowledged[threadId] === key) return false;
    set((s) => {
      const { [threadId]: _previous, ...others } = s.acknowledged;
      const entries = Object.entries({ ...others, [threadId]: key });
      return { acknowledged: Object.fromEntries(entries.slice(-ACK_LIMIT)) };
    });
    return true;
  },
}));

/**
 * The attention the user hasn't seen: it clears once the thread is opened, or on its own when the
 * build goes green or the PR merges. Nothing is unseen until the saved acknowledgements have loaded,
 * so a restart doesn't raise what was already seen.
 */
export function unseenAttention(
  summary: ThreadSummary,
  acknowledged: Readonly<Record<string, string>> = useAttentionStore.getState().acknowledged,
): Attention | undefined {
  if (!useAttentionStore.getState().loaded) return undefined;
  const attention = attentionOf(summary);
  return attention !== undefined && acknowledged[summary.thread.id] !== attention.key
    ? attention
    : undefined;
}
