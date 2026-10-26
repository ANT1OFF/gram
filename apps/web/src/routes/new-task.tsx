import type { WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { NewTaskDraft } from "@/composer/new-task-draft";

/** `?way=direct` starts a worker straight away; `?workspace=<id>` aims the draft at that workspace. */
export interface NewTaskSearch {
  readonly way?: "direct";
  readonly workspace?: WorkspaceId;
}

export const Route = createFileRoute("/new-task")({
  validateSearch: (search: Record<string, unknown>): NewTaskSearch => {
    const workspace = search["workspace"];
    return {
      ...(search["way"] === "direct" ? { way: "direct" as const } : {}),
      ...(typeof workspace === "string" && workspace !== ""
        ? { workspace: workspace as WorkspaceId }
        : {}),
    };
  },
  component: NewTaskPage,
});

function NewTaskPage() {
  const { way, workspace } = Route.useSearch();
  return <NewTaskDraft initialWay={way} initialWorkspace={workspace} />;
}
