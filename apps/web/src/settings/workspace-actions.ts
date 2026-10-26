import type { OrchestratorCharter, WorkspaceState } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { SaveWorkspaceInput } from "@/api/types";
import { useLayoutStore } from "@/stores/layout";
import { showUndo } from "@/stores/undo-toasts";

import { draftOfWorkspace, validateWorkspaceDraft } from "./workspace-settings-model";

/**
 * A workspace's changes as Settings makes them: each saves at once and says so with Undo, which
 * puts back what was there before. One save at a time: a field changed while another saves would
 * build on the charter from before it.
 */
export function useWorkspaceChanges(state: WorkspaceState | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The charter a save is sending, shown until it settles: a change shows at once rather than
  // after the save and the refetch, and a refused one falls back to the saved charter.
  const [saving, setSaving] = useState<OrchestratorCharter>();

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
      state === undefined
        ? undefined
        : queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", state.workspace.id] }),
    ]);

  /** Runs `change`, then offers `undo` under `title`; a refusal goes to `fail`, or the page's error. */
  const run = (
    change: () => Promise<unknown>,
    title: string,
    undo: (() => Promise<unknown>) | undefined,
    fail: (message: string) => void = setError,
  ): Promise<void> => {
    setError(undefined);
    setBusy(true);
    return change()
      .then(refresh)
      .then(() => {
        if (undo !== undefined && state !== undefined) {
          showUndo({
            key: `workspace:${state.workspace.id}`,
            title,
            undo: () => undo().then(refresh),
          });
        }
      })
      .catch((e: unknown) => fail(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const saveCharter = (
    next: OrchestratorCharter,
    title: string,
    fail?: (message: string) => void,
  ): Promise<void> => {
    if (state === undefined) return Promise.resolve();
    const { id } = state.workspace;
    const before = state.charter;
    setSaving(next);
    return run(
      () => api.setOrchestratorCharter(id, next),
      title,
      () => api.setOrchestratorCharter(id, before),
      fail,
    ).finally(() => setSaving(undefined));
  };

  const saveWorkspace = (
    input: SaveWorkspaceInput,
    title: string,
    fail?: (message: string) => void,
  ): Promise<void> => {
    if (state === undefined) return Promise.resolve();
    const before = validateWorkspaceDraft(draftOfWorkspace(state.workspace), state.workspace.id);
    return run(
      () => api.saveWorkspace(input),
      title,
      "input" in before ? () => api.saveWorkspace(before.input) : undefined,
      fail,
    );
  };

  /** Pausing says so with Undo; resuming needs no way back. */
  const setPaused = (paused: boolean): Promise<void> => {
    if (state === undefined) return Promise.resolve();
    const { id, name } = state.workspace;
    return run(
      () => api.setOrchestratorPaused(id, paused),
      `Paused ${name}`,
      paused ? () => api.setOrchestratorPaused(id, false) : undefined,
    );
  };

  const openOrchestrator = (): Promise<void> => {
    if (state === undefined) return Promise.resolve();
    const workspaceId = state.workspace.id;
    return run(
      async () => {
        const thread = await api.openOrchestrator({ workspaceId });
        useLayoutStore.getState().openThread(thread.id);
        await navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
      },
      "",
      undefined,
    );
  };

  return {
    /** The charter to show: the one being saved, else the saved one. */
    charter: saving ?? state?.charter,
    busy,
    error,
    setError,
    saveCharter,
    saveWorkspace,
    setPaused,
    openOrchestrator,
  };
}
