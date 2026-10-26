import type { OrchestratorLedger, ThreadId, ThreadSummary, WorkspaceId } from "@gram/contracts";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { createStatusHold } from "@/sidebar/hysteresis";
import { useThreadsStore } from "@/stores/threads";

import {
  workingCount,
  workingWorkerThreads,
  workspaceStatus,
  workspaceTrees,
  type WorkspaceStatus,
  type WorkspaceTree,
} from "./tree-model";
import { askedQuestions, useWorkspaceAsks } from "./ask-stack";
import { useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { workerTones } from "./workers-model";

/**
 * A workspace's live workers and how many of them work now, by their tones (`workerTones`): what
 * the sidebar's orchestrator line and the compact rail's tile both count, folded or open.
 */
export function useWorkerTally(
  workspaceId: WorkspaceId,
  ledger: OrchestratorLedger | undefined,
  asking: ReadonlySet<ThreadId>,
): { readonly live: number; readonly working: number } {
  const [live, working] = useThreadsStore(
    useShallow((s) => {
      const running = workingWorkerThreads(s.byId, s.statusDetail, workspaceId).map(
        (each) => each.thread.id,
      );
      const tally = workerTones(ledger, running, {
        byId: s.byId,
        statusDetail: s.statusDetail,
        asking,
      });
      return [tally.live, tally.working] as const;
    }),
  );
  return { live, working };
}

/** A workspace leaving a status waits this long, so one worker's quick turn doesn't reorder the list. */
const WORKSPACE_STATUS_HOLD_MS = 5_000;

/** Parking and unparking are the user's own doing, and what needs you mustn't wait. */
const holdsNot = (from: WorkspaceStatus, to: WorkspaceStatus): boolean =>
  to === "needsYou" || to === "parked" || from === "parked";

/**
 * Each workspace's status as the sidebar shows it, which is its lane. Moves into Needs you, in and out
 * of Parked, and a workspace's first status apply at once; any other move waits
 * `WORKSPACE_STATUS_HOLD_MS`, so a tree doesn't change lane on every quick turn of a worker.
 */
export function useWorkspaceStatuses(threads: readonly ThreadSummary[]): {
  readonly trees: readonly WorkspaceTree[];
  readonly statuses: ReadonlyMap<WorkspaceId, WorkspaceStatus>;
  readonly ledgers: ReturnType<typeof useOrchestratorLedgers>;
} {
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  // Its open questions as the stack still asks them, so an answered or snoozed one leaves its lane.
  const asks = useWorkspaceAsks();
  const questions = useMemo(
    () =>
      new Map(
        asks.map((w) => {
          const asked = askedQuestions(w.asks);
          return [w.workspaceId, asked.questions.length + asked.workerQuestions.length] as const;
        }),
      ),
    [asks],
  );
  const trees = useMemo(
    () => workspaceTrees(workspaces, threads, ledgers),
    [workspaces, threads, ledgers],
  );
  // One string, so an activity line that ticks without changing who works re-renders nothing.
  const working = useThreadsStore((s) =>
    trees.map((tree) => workingCount(tree, s.statusDetail)).join(","),
  );
  const target = useMemo(() => {
    const counts = working.split(",").map(Number);
    return new Map(
      trees.map((tree, i) => [
        tree.workspace.id,
        workspaceStatus(tree, {
          questions: questions.get(tree.workspace.id) ?? 0,
          working: counts[i] ?? 0,
        }),
      ]),
    );
  }, [trees, working, questions]);

  const [hold] = useState(() =>
    createStatusHold<WorkspaceId, WorkspaceStatus>(WORKSPACE_STATUS_HOLD_MS, holdsNot),
  );
  useEffect(() => hold.update(target), [hold, target]);
  useEffect(() => () => hold.dispose(), [hold]);
  // A workspace the hold hasn't heard of yet, on the render before the effect, shows as it is.
  const held = useStore(hold.store, (s) => s.shown);
  const shown = useMemo(
    () => new Map([...target].map(([id, status]) => [id, held.get(id) ?? status])),
    [target, held],
  );

  return { trees, statuses: shown, ledgers };
}
