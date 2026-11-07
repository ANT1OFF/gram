import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * The place the window was on before it opened a New form: a thread, a workspace's own page (its
 * memory, files or settings), or somewhere that is neither, such as home or Usage.
 */
export type CameFrom =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "nowhere" };

const THREAD = /^\/t\/([^/]+)/;
const WORKSPACE_PAGE = /^\/(?:w|settings\/workspaces)\/([^/]+)/;

const isAside = (pathname: string) =>
  pathname === "/new" ||
  pathname === "/new-task" ||
  pathname === "/new-workspace" ||
  pathname === "/settings" ||
  pathname.startsWith("/settings/");

/**
 * The place `pathname` is, or `undefined` for one opened on the way somewhere: a New form (so
 * switching between them keeps where they were opened from) and Settings, except a workspace's
 * own page there.
 */
export const placeOf = (pathname: string): CameFrom | undefined => {
  const thread = THREAD.exec(pathname)?.[1];
  if (thread !== undefined)
    return { kind: "thread", threadId: decodeURIComponent(thread) as ThreadId };
  const workspace = WORKSPACE_PAGE.exec(pathname)?.[1];
  if (workspace !== undefined)
    return { kind: "workspace", workspaceId: decodeURIComponent(workspace) as WorkspaceId };
  return isAside(pathname) ? undefined : { kind: "nowhere" };
};

/**
 * The last place this window was on; `undefined` until it has been on one, as when it opened on a
 * form.
 */
let cameFrom: CameFrom | undefined;

export const readCameFrom = (): CameFrom | undefined => cameFrom;

/** Keeps `readCameFrom` up to date with the route. Mount once. */
export function useRememberCameFrom(): void {
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    cameFrom = placeOf(pathname) ?? cameFrom;
  }, [pathname]);
}

/** Forgets the place, as a fresh window has none. Tests only. */
export const resetCameFromForTests = (): void => {
  cameFrom = undefined;
};
