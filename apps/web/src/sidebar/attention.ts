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

/** Nobody is working the PR in these statuses, so a red build or a change request is the user's. */
const QUIET: ReadonlySet<string> = new Set(["idle", "cold", "ended"]);

const LABELS: Record<AttentionReason, string> = {
  ciFailed: "CI failed",
  changesRequested: "Changes requested",
};

/**
 * What a thread's open PR asks of the user: a red required check and/or the review bot asking for
 * changes on its head (`botAsksChanges`, as its row's glyph reads it).
 * Absent while the agent works or asks, for a parked thread, once the PR is merged or closed, and
 * for an orchestrator, whose checkout's PR is none of the ones it drives.
 */
export function attentionOf(summary: ThreadSummary): Attention | undefined {
  if (summary.thread.role === "orchestrator") return undefined;
  const pr = summary.git?.pr;
  if (pr === undefined || pr.state !== "OPEN") return undefined;
  const archivedWorker = summary.thread.parked && summary.thread.spawnedBy !== undefined;
  if ((summary.thread.parked && !archivedWorker) || (!QUIET.has(summary.status) && !archivedWorker))
    return undefined;
  const head = pr.headRefOid ?? pr.updatedAt ?? "";
  const reasons: Array<[AttentionReason, string]> = [];
  if (requiredChecksOf(pr) === "failing" && !ownsCiFailure(summary, pr.url))
    reasons.push(["ciFailed", `ci:${pr.number}:${head}`]);
  if (!summary.thread.parked && botAsksChanges(reviewStatusOf(pr.review))) {
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

/** The latest ledger supplies holds, standing reports and unreported stops to every badge. */
export function ownsCiFailure(summary: ThreadSummary, url: string): boolean {
  const ledger =
    summary.thread.workspaceId === undefined
      ? undefined
      : useAttentionStore.getState().ledgers[summary.thread.workspaceId];
  return (
    ledger?.features.some((feature) =>
      feature.workers.some((worker) => {
        const live =
          worker.threadId === summary.thread.id
            ? summary
            : useThreadsStore.getState().byId[worker.threadId];
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
  /** False until `attention.acknowledged` arrives from settings; nothing is raised before that. */
  readonly loaded: boolean;
  /** Per thread, the attention key the user has seen. */
  readonly acknowledged: Readonly<Record<string, string>>;
  /** Merges the saved acknowledgements under the ones seen here. */
  hydrate(saved: readonly string[]): void;
  /** True when `key` is new for the thread. */
  acknowledge(threadId: ThreadId, key: string): boolean;
}

/** `<thread id> <key>` entries, as `attention.acknowledged` stores them, into a per-thread record. */
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
