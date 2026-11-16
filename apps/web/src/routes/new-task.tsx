import type { WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { NewTaskDraft } from "@/composer/new-task-draft";

/** `?workspace=<id>` aims the draft at that workspace. */
export interface NewTaskSearch {
  readonly workspace?: WorkspaceId;
}

export const Route = createFileRoute("/new-task")({
  validateSearch: (search: Record<string, unknown>): NewTaskSearch => {
    const workspace = search["workspace"];
    return typeof workspace === "string" && workspace !== ""
      ? { workspace: workspace as WorkspaceId }
      : {};
  },
  component: NewTaskPage,
});

function NewTaskPage() {
  const { workspace } = Route.useSearch();
  return <NewTaskDraft initialWorkspace={workspace} />;
}
