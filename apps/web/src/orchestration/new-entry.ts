import type { ThreadId, WorkspaceId } from "@gram/contracts";

import { prefillDraftProject } from "@/composer/draft-prefill";
import { useThreadsStore } from "@/stores/threads";

/** What the New form starts (the workspace being the sheet its "in" chip opens). */
export type NewEntry = "task" | "worker" | "oneOff" | "workspace";

/** Where a pick lands: an existing first screen, with what it starts on in its search. */
export type NewEntryRoute =
  | { readonly to: "/new-task"; readonly search: { way?: "direct"; workspace?: WorkspaceId } }
  | { readonly to: "/new" }
  | { readonly to: "/new-workspace" };

/**
 * The route for `entry`. A task or worker names its workspace when one is given; without one the
 * draft starts on its own default.
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

/** Prefills `/new` with `threadId`'s folder, as ⌘T does, before going there. */
export const prefillOneOff = (threadId: ThreadId | undefined) => {
  const checkout = threadId
    ? useThreadsStore.getState().byId[threadId]?.thread.checkout
    : undefined;
  prefillDraftProject(checkout ? (checkout.repoRoot ?? checkout.path) : undefined);
};
