import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type AnyRoute } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { NotFound } from "./shell/not-found";

/**
 * The app's router. `basepath` and `extra` are for an app in front of Gram that serves this one
 * under a path and adds pages of its own beside Gram's (`embed/mount.tsx`); on its own the app
 * passes neither.
 */
export const createAppRouter = (
  queryClient: QueryClient,
  options: { basepath?: string | undefined; extra?: readonly AnyRoute[] | undefined } = {},
) => {
  if (options.extra !== undefined && options.extra.length > 0) {
    const own: readonly AnyRoute[] = Object.values(routeTree.children ?? {});
    routeTree.addChildren([...own, ...options.extra]);
  }
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFound,
    ...(options.basepath === undefined || options.basepath === ""
      ? {}
      : { basepath: options.basepath }),
  });
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
