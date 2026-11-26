import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, type RenderResult } from "@testing-library/react";
import { Fragment, useState, useSyncExternalStore, type ReactNode } from "react";

import { ApiProvider } from "@/api/context";
import { servedAllBut } from "@/api/served";
import type { Api } from "@/api/types";

async function* emptyThreadFeed(): AsyncGenerator<never> {}

function withPanelCalls(api: Partial<Api>): Partial<Api> {
  const fake = Object.create(api) as Partial<Api>;
  return Object.assign(fake, {
    ...("threadFeed" in api ? {} : { threadFeed: emptyThreadFeed }),
    ...("served" in api ? {} : { served: servedAllBut() }),
  });
}

function withApi(ui: ReactNode, api: Partial<Api>): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const provided = "threadFeed" in api && "served" in api ? api : withPanelCalls(api);
  const fake = provided as Api;
  return (
    <ApiProvider api={fake}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </ApiProvider>
  );
}

/** Renders `ui` inside a fresh query client (no retries) and the given api. */
export function renderWithApi(ui: ReactNode, api: Partial<Api>): RenderResult {
  return render(withApi(ui, api));
}

/** Remounts `children` on each click of its "Remount" button, as switching back to a thread does. */
export function Remount({ children }: { children: ReactNode }) {
  const [mount, setMount] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setMount((n) => n + 1)}>
        Remount
      </button>
      <Fragment key={mount}>{children}</Fragment>
    </>
  );
}

/** Opt-in real navigation context without changing the default API/query-only fixture. */
export function renderWithRouter(ui: ReactNode, api: Partial<Api>) {
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "$" })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const result = renderWithApi(
    <RouterContextProvider router={router}>{ui}</RouterContextProvider>,
    api,
  );
  return { ...result, router };
}

/**
 * Renders `ui` as the page of a real router at `path`, whose routes carry the app's own params
 * (`/t/$threadId`, `/w/$workspaceId/files`, `/settings/$page`, …): for a component that links,
 * navigates or reads where it is. With `api`, inside `renderWithApi`'s providers. Waits for the
 * router's first load, so `ui` is on screen when it returns; `router.state.location` says where
 * a navigation went, and `rerender(next)` shows `next` on the same page, as a parent's new props
 * would.
 */
export async function renderInRouter(
  ui: ReactNode,
  { path = "/", api }: { readonly path?: string; readonly api?: Partial<Api> } = {},
) {
  const root = createRootRoute();
  const shown = { ui, listeners: new Set<() => void>() };
  const subscribe = (listener: () => void) => {
    shown.listeners.add(listener);
    return () => void shown.listeners.delete(listener);
  };
  const Page = () => useSyncExternalStore(subscribe, () => shown.ui);
  const router = createRouter({
    routeTree: root.addChildren(
      [
        "/t/$threadId",
        "/w/$workspaceId/files",
        "/w/$workspaceId/memory",
        "/settings/workspaces/$workspaceId",
        "/settings/$page",
        "$",
      ].map((route) => createRoute({ getParentRoute: () => root, path: route, component: Page })),
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const routed = <RouterProvider router={router} />;
  const result = render(api === undefined ? routed : withApi(routed, api));
  const rerender = (next: ReactNode) =>
    act(() => {
      shown.ui = next;
      for (const listener of shown.listeners) listener();
    });
  return { ...result, router, rerender };
}
