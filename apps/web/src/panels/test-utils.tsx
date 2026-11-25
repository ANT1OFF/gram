import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import { Fragment, useState, type ReactNode } from "react";

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

/** Renders `ui` inside a fresh query client (no retries) and the given api. */
export function renderWithApi(ui: ReactNode, api: Partial<Api>): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const provided = "threadFeed" in api && "served" in api ? api : withPanelCalls(api);
  const fake = provided as Api;
  return render(
    <ApiProvider api={fake}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </ApiProvider>,
  );
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
