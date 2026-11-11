import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type AnyRoute } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

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
    // The generated tree's children, with the added pages beside them. Its types stay the
    // generated ones: an added page is reached by its path as a string, never a typed `to`.
    const own = Object.values((routeTree.children ?? {}) as Record<string, AnyRoute>);
    (routeTree as unknown as AnyRoute).addChildren([...own, ...options.extra]);
  }
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
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
