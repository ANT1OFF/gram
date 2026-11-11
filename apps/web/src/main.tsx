import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApiProvider, createApi } from "./api/context";
import { installKeyboard } from "./keyboard/registry";
import { createAppRouter } from "./router";
import "./styles/globals.css";

const queryClient = new QueryClient();

const router = createAppRouter(queryClient);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element missing");

/**
 * Renders once the API client is in hand. Not a top-level `await`: the client's chunk imports the
 * one this module is bundled in (see `vite.config.ts`), and a module awaiting a chunk that imports
 * it back while it still runs never finishes.
 */
async function start(root: HTMLElement) {
  const api = await createApi();
  installKeyboard();

  createRoot(root).render(
    <StrictMode>
      <ApiProvider api={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiProvider>
    </StrictMode>,
  );
}

start(rootElement).catch((error: unknown) => {
  console.error("gram: start", error);
  throw error;
});
