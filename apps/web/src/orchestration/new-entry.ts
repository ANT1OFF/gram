import type { ThreadId, WorkspaceId, WorkspaceState } from "@gram/contracts";

import { prefillDraftProject } from "@/composer/draft-prefill";
import { useThreadsStore } from "@/stores/threads";

import type { TaskTarget } from "./task-model";

/** The four things the sidebar's New menu starts. */
export type NewEntry = "task" | "worker" | "oneOff" | "workspace";

/** Where a pick lands: an existing first screen, with what it starts on in its search. */
export type NewEntryRoute =
  | { readonly to: "/new-task"; readonly search: { way?: "direct"; workspace?: WorkspaceId } }
  | { readonly to: "/new" }
  | { readonly to: "/new-workspace" };

/**
 * The route for `entry`. A task or worker names its workspace when one is given, so a pick from the
 * Send to submenu lands there; without one the draft starts on its own default.
 */
export const newEntryRoute = (entry: NewEntry, workspaceId?: WorkspaceId): NewEntryRoute => {
  if (entry === "oneOff") return { to: "/new" };
  if (entry === "workspace") return { to: "/new-workspace" };
  return {
    to: "/new-task",
    search: {
      ...(entry === "worker" ? { way: "direct" as const } : {}),
      ...(workspaceId === undefined ? {} : { workspace: workspaceId }),
    },
  };
};

/** The workspace `target` names, if it is one that exists. */
export const targetWorkspace = (
  target: TaskTarget | undefined,
  workspaces: readonly WorkspaceState[],
): WorkspaceState | undefined =>
  target?.kind === "workspace"
    ? workspaces.find((state) => state.workspace.id === target.workspaceId)
    : undefined;

/** The menu's words for a task or a worker, naming the workspace it goes to by default. */
export const newEntryLabel = (entry: "task" | "worker", workspace: string | undefined): string =>
  entry === "task"
    ? workspace === undefined
      ? "New task"
      : `Task for ${workspace}'s orchestrator`
    : workspace === undefined
      ? "New worker"
      : `Worker in ${workspace}`;

/** Prefills `/new` with `threadId`'s folder, as ⌘T does, before going there. */
export const prefillOneOff = (threadId: ThreadId | undefined) => {
  const checkout = threadId
    ? useThreadsStore.getState().byId[threadId]?.thread.checkout
    : undefined;
  prefillDraftProject(checkout ? (checkout.repoRoot ?? checkout.path) : undefined);
};
