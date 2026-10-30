import type { OrchestratorLedger, ThreadId, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { Api, SetStageInput } from "@/api/types";
import { useNow } from "@/lib/use-now";
import { useThreadsStore } from "@/stores/threads";

import {
  freshSessionPct,
  handoffRunning,
  TIDY_UP_MESSAGE,
  tidyUpBlocked,
  type HandoffMark,
} from "./board-model";
import { parseQuestions, QUESTIONS_FILE, type MemoryQuestion } from "./memory-model";
import {
  ledgerWithStage,
  optimisticStage,
  stageOf,
  withStage,
  type StageTarget,
} from "./stage-model";
import { stageHolds } from "./use-orchestration";

/** A failure of something done with one click, where there is no form to say it in. */
const notifyError = (title: string, error: unknown) =>
  useThreadsStore
    .getState()
    .applyEvent({ type: "notify", kind: "error", title, body: errorMessage(error) });

const replaceWorkspace =
  (next: WorkspaceState) =>
  (all: readonly WorkspaceState[] | undefined): readonly WorkspaceState[] | undefined =>
    all?.map((state) => (state.workspace.id === next.workspace.id ? next : state));

/**
 * Sets a feature's or a group's stage as the user. The new stage shows at once, as "set by you ·
 * just now", in the workspace and the ledger the board and the tree draw from, and is held there
 * until the ledger stream shows it; a refusal puts both back and says why in a toast. Resolves to
 * whether it went through.
 */
export function useSetStage(workspaceId: WorkspaceId) {
  const api = useApi();
  const queryClient = useQueryClient();
  return async (
    target: StageTarget,
    input: Pick<SetStageInput, "stage" | "plan" | "note">,
  ): Promise<boolean> => {
    const workspacesKey = ["workspaces"];
    const ledgerKey = ["orchestratorLedger", workspaceId];
    const workspaces = queryClient.getQueryData<readonly WorkspaceState[]>(workspacesKey);
    const ledger = queryClient.getQueryData<OrchestratorLedger>(ledgerKey);
    const state = workspaces?.find((candidate) => candidate.workspace.id === workspaceId);
    const stage = optimisticStage(
      state === undefined ? undefined : stageOf(state, target),
      input,
      Date.now(),
    );
    if (state !== undefined) {
      queryClient.setQueryData(workspacesKey, replaceWorkspace(withStage(state, target, stage)));
    }
    if (ledger !== undefined) {
      queryClient.setQueryData(ledgerKey, ledgerWithStage(ledger, target, stage));
    }
    const hold = stageHolds.hold(workspaceId, target, stage);
    try {
      const next = await api.setOrchestratorStage(workspaceId, { ...target, ...input });
      queryClient.setQueryData(workspacesKey, replaceWorkspace(next));
      const stored = stageOf(next, target);
      if (stored === undefined) {
        hold.release();
      } else {
        hold.confirm(stored);
        queryClient.setQueryData<OrchestratorLedger>(ledgerKey, (current) =>
          current === undefined ? current : ledgerWithStage(current, target, stored),
        );
      }
      return true;
    } catch (error) {
      hold.release();
      queryClient.setQueryData(workspacesKey, workspaces);
      queryClient.setQueryData(ledgerKey, ledger);
      // What was put back may itself be stale by now: a ledger streamed in, or the workspaces were
      // read again, while the call ran.
      void queryClient.invalidateQueries({ queryKey: ledgerKey });
      void queryClient.invalidateQueries({ queryKey: workspacesKey });
      notifyError("Couldn't set the stage", error);
      return false;
    }
  };
}

/**
 * Resumes a paused workspace from wherever its pause is shown, and puts the new state where the
 * board, the tree and the orchestrator's banner read it; a refusal is a toast.
 */
export function useResume(workspaceId: WorkspaceId | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  return async (): Promise<boolean> => {
    if (workspaceId === undefined) return false;
    try {
      const next = await api.setOrchestratorPaused(workspaceId, false);
      queryClient.setQueryData(["workspaces"], replaceWorkspace(next));
      void queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", workspaceId] });
      return true;
    } catch (error) {
      notifyError("Couldn't resume orchestration", error);
      return false;
    }
  };
}

/** Moves a feature into a group, or out of its group without one; a refusal is a toast. */
export function useSetGroup(workspaceId: WorkspaceId) {
  const api = useApi();
  const queryClient = useQueryClient();
  return async (feature: string, group: string | undefined): Promise<boolean> => {
    try {
      const next = await api.setOrchestratorGroup(workspaceId, feature, group);
      queryClient.setQueryData(["workspaces"], replaceWorkspace(next));
      void queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", workspaceId] });
      return true;
    } catch (error) {
      notifyError(
        group === undefined ? "Couldn't take it out of the group" : "Couldn't move it to the group",
        error,
      );
      return false;
    }
  };
}

interface HandoffState {
  readonly marks: Readonly<Record<string, HandoffMark>>;
  /** The workspace whose "Fresh session" confirmation is open, from a menu or the palette. */
  readonly confirming: WorkspaceId | undefined;
  mark(workspaceId: WorkspaceId, mark: HandoffMark): void;
  clear(workspaceId: WorkspaceId): void;
  confirm(workspaceId: WorkspaceId | undefined): void;
}

/**
 * Handoffs this window asked for. The server says only that one is under way, so until the
 * orchestrator's thread carries a new agent session this is what "handing off…" is drawn from.
 */
export const useHandoffStore = create<HandoffState>()((set) => ({
  marks: {},
  confirming: undefined,
  mark: (workspaceId, mark) => set((s) => ({ marks: { ...s.marks, [workspaceId]: mark } })),
  clear: (workspaceId) =>
    set((s) => {
      const { [workspaceId]: _gone, ...marks } = s.marks;
      return { marks };
    }),
  confirm: (confirming) => set({ confirming }),
}));

/** What the confirmation says before a handoff, wherever it is asked for. */
export const FRESH_SESSION_EXPLANATION =
  "Starts a fresh agent session on this thread. The orchestrator first writes anything unsaved to its memory, then starts again from memory and the current ledger.";

/**
 * A workspace's handoff: whether one is running, the context fill that suggests one, and the call
 * that starts it. `running` is true from the click until the orchestrator's thread shows another
 * agent session.
 */
export function useHandoff(state: WorkspaceState | undefined) {
  const api = useApi();
  const workspaceId = state?.workspace.id;
  const orchestratorId = state?.workspace.orchestratorThreadId;
  const summary = useThreadsStore((s) =>
    orchestratorId === undefined ? undefined : s.byId[orchestratorId],
  );
  const usage = useThreadsStore((s) =>
    orchestratorId === undefined ? undefined : s.usage[orchestratorId],
  );
  const mark = useHandoffStore((s) =>
    workspaceId === undefined ? undefined : s.marks[workspaceId],
  );
  // Ticks only while a handoff is claimed, so the claim is dropped when it has run too long.
  const now = useNow(mark !== undefined, undefined, 5_000);
  const running = handoffRunning(mark, summary?.thread, now);
  const starting = useRef(false);

  const start = async (): Promise<boolean> => {
    if (workspaceId === undefined || starting.current) return false;
    starting.current = true;
    useHandoffStore.getState().mark(workspaceId, {
      fromSession: summary?.thread.agentSessionId,
      startedAt: Date.now(),
    });
    try {
      await api.orchestratorHandoff(workspaceId);
      return true;
    } catch (error) {
      useHandoffStore.getState().clear(workspaceId);
      notifyError("Couldn't start a fresh session", error);
      return false;
    } finally {
      starting.current = false;
    }
  };

  return {
    /** Whether there is an orchestrator to hand off at all. */
    available: summary !== undefined,
    running,
    /** The orchestrator's context fill once it is worth a fresh session; `undefined` below that. */
    suggestedAtPct: running ? undefined : freshSessionPct(usage),
    start,
  };
}

/**
 * Asks the orchestrator to tidy up, as a message of the user's: queued behind its current turn
 * when it is busy, never steered into it. Resolves to whether it was queued.
 */
export const sendTidyUp = async (api: Api, orchestratorId: ThreadId): Promise<boolean> =>
  (await api.send(orchestratorId, { text: TIDY_UP_MESSAGE })).queued;

/** How long Tidy up shows that it went, before it can be pressed again. */
export const TIDY_SENT_MS = 2_500;

/**
 * The board's Tidy up: why it can't be sent, if it can't, whether it has just gone (`sent` or
 * `queued`, for `TIDY_SENT_MS`), whether it is resting (pending or just gone, so a second press
 * can't queue a second sweep), and the call. A failure is a toast.
 */
export function useTidyUp(state: WorkspaceState) {
  const api = useApi();
  const orchestratorId = state.workspace.orchestratorThreadId;
  const summary = useThreadsStore((s) =>
    orchestratorId === undefined ? undefined : s.byId[orchestratorId],
  );
  const [sent, setSent] = useState<"sent" | "queued">();
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    if (sent === undefined) return;
    const timer = setTimeout(() => setSent(undefined), TIDY_SENT_MS);
    return () => clearTimeout(timer);
  }, [sent]);

  const blocked = tidyUpBlocked(summary);
  const resting = pending || sent !== undefined;
  const send = async () => {
    if (blocked !== undefined || orchestratorId === undefined || resting || sending.current) return;
    sending.current = true;
    setPending(true);
    try {
      setSent((await sendTidyUp(api, orchestratorId)) ? "queued" : "sent");
    } catch (error) {
      notifyError("Couldn't ask the orchestrator to tidy up", error);
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  return { blocked, sent, resting, send };
}

const NO_QUESTIONS: readonly MemoryQuestion[] = [];

/**
 * Every entry of the workspace's `questions.md`, open and closed. A
 * workspace with no such file, or no memory yet, has none: that the read failed is not worth a word
 * on a board header.
 */
const questionsQuery = (api: Api, workspaceId: WorkspaceId | undefined) => ({
  queryKey: ["memory", workspaceId, "questions"],
  queryFn: async () => {
    try {
      return parseQuestions((await api.readMemory(workspaceId!, QUESTIONS_FILE)).content);
    } catch {
      // No questions.md is the ordinary case, and the Memory view is where a real fault is said.
      return NO_QUESTIONS;
    }
  },
  enabled: workspaceId !== undefined,
  retry: false,
  staleTime: 30_000,
});

export function useQuestions(workspaceId: WorkspaceId | undefined): readonly MemoryQuestion[] {
  const { data } = useQuery(questionsQuery(useApi(), workspaceId));
  return data ?? NO_QUESTIONS;
}

/** How many questions each workspace has left open, from the same reads as `useOpenQuestions`. */
export function useOpenQuestionCounts(
  workspaceIds: readonly WorkspaceId[],
): ReadonlyMap<WorkspaceId, number> {
  const api = useApi();
  // As one string, so the map only changes when a count does.
  const counts = useQueries({
    queries: workspaceIds.map((id) => questionsQuery(api, id)),
    combine: (results) =>
      results
        .map(({ data }) => (data ?? NO_QUESTIONS).filter((question) => question.open).length)
        .join(","),
  });
  return useMemo(() => {
    const each = counts === "" ? [] : counts.split(",").map(Number);
    return new Map(workspaceIds.map((id, i) => [id, each[i] ?? 0]));
  }, [counts, workspaceIds]);
}

/** Each workspace's entries still waiting for the user, from the same reads as `useOpenQuestions`. */
export function useOpenQuestionsOf(
  workspaceIds: readonly WorkspaceId[],
): ReadonlyMap<WorkspaceId, readonly MemoryQuestion[]> {
  const api = useApi();
  const lists = useQueries({
    queries: workspaceIds.map((id) => questionsQuery(api, id)),
    combine: (results) => results.map(({ data }) => data ?? NO_QUESTIONS),
  });
  return useMemo(
    () =>
      new Map(
        workspaceIds.map((id, i) => [
          id,
          (lists[i] ?? NO_QUESTIONS).filter((question) => question.open),
        ]),
      ),
    [lists, workspaceIds],
  );
}

/** The entries still waiting for the user. */
export function useOpenQuestions(workspaceId: WorkspaceId | undefined): readonly MemoryQuestion[] {
  const all = useQuestions(workspaceId);
  return useMemo(() => all.filter((question) => question.open), [all]);
}
