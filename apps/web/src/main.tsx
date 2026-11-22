// oxlint-disable-next-line import/no-unassigned-import -- it must run before any other module
import "./api/mock-modes/install";
// oxlint-disable-next-line import/no-unassigned-import -- Motion's switch, apart from install's
import "./api/mock-modes/still-motion";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApiProvider, createApi } from "./api/context";
import { takeOriginKey } from "./api/origin-key";
import { installKeyboard } from "./keyboard/registry";
import { createAppRouter } from "./router";
import "./styles/globals.css";

takeOriginKey(window.location, window.history);

const queryClient = new QueryClient();

const router = createAppRouter(queryClient);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element missing");

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
