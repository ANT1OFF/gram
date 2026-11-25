import { ThreadId, WorkspaceId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

const isThreadId = Schema.is(ThreadId);
const isWorkspaceId = Schema.is(WorkspaceId);

/** The thread the window's route is on (`/t/$threadId`), or undefined on any other page. */
export function useRouteThreadId(): ThreadId | undefined {
  const { threadId } = useParams({ strict: false });
  return isThreadId(threadId) ? threadId : undefined;
}

/** The workspace the window's route names in its path (`/w/$workspaceId/…`), if it names one. */
export function useRouteWorkspaceId(): WorkspaceId | undefined {
  const { workspaceId } = useParams({ strict: false });
  return isWorkspaceId(workspaceId) ? workspaceId : undefined;
}
