import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApiProvider, createApi } from "./api/context";
import { installKeyboard } from "./keyboard/registry";
import { routeTree } from "./routeTree.gen";
import "./styles/globals.css";

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element missing");

const api = await createApi();
installKeyboard();

createRoot(rootElement).render(
  <StrictMode>
    <ApiProvider api={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>
  </StrictMode>,
);
