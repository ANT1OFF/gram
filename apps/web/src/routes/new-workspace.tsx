import { ProjectId, WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { NewWorkspaceSheet } from "@/orchestration/new-workspace";

/**
 * `?from=<id>` starts the new workspace from that workspace's charter; `?repo=<id>` starts it with
 * that repository picked, as the first run does; `?read=true` starts it with "Read the repositories
 * first" ticked, which the first run's card promises.
 */
export interface NewWorkspaceSearch {
  readonly from?: WorkspaceId;
  readonly repo?: ProjectId;
  readonly read?: true;
}

const isWorkspaceId = Schema.is(WorkspaceId);
const isProjectId = Schema.is(ProjectId);

export const Route = createFileRoute("/new-workspace")({
  validateSearch: (search: Record<string, unknown>): NewWorkspaceSearch => {
    const from = search["from"];
    const repo = search["repo"];
    const read = search["read"] === true || search["read"] === "true";
    return {
      ...(isWorkspaceId(from) ? { from } : {}),
      ...(isProjectId(repo) ? { repo } : {}),
      ...(read ? { read: true as const } : {}),
    };
  },
  component: NewWorkspacePage,
});

function NewWorkspacePage() {
  const { from, repo, read } = Route.useSearch();
  return <NewWorkspaceSheet from={from} repo={repo} read={read} />;
}
