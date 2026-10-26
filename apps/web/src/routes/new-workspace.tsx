import type { ProjectId, WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { NewWorkspaceSheet } from "@/orchestration/new-workspace";

/**
 * `?from=<id>` starts the new workspace from that workspace's charter; `?repo=<id>` starts it with
 * that repository picked, as the first run does.
 */
export interface NewWorkspaceSearch {
  readonly from?: WorkspaceId;
  readonly repo?: ProjectId;
}

const idParam = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export const Route = createFileRoute("/new-workspace")({
  validateSearch: (search: Record<string, unknown>): NewWorkspaceSearch => {
    const from = idParam(search["from"]);
    const repo = idParam(search["repo"]);
    return {
      ...(from === undefined ? {} : { from: from as WorkspaceId }),
      ...(repo === undefined ? {} : { repo: repo as ProjectId }),
    };
  },
  component: NewWorkspacePage,
});

function NewWorkspacePage() {
  const { from, repo } = Route.useSearch();
  return <NewWorkspaceSheet from={from} repo={repo} />;
}
