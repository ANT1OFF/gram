// @vitest-environment happy-dom
import type { AgentModel } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";

import { ModelSelect } from "./model-select";

const MODELS: AgentModel[] = [
  { id: "opus", displayName: "Claude Opus", supportsEffort: true },
  { id: "haiku", displayName: "Claude Haiku", supportsEffort: false },
];

function Routed({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: () => children }),
      history: createMemoryHistory({ initialEntries: ["/new"] }),
    }),
  );
  return <RouterProvider router={router} />;
}

const show = (listModels: Api["listModels"]) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider api={{ listModels, listProfiles: async () => [] } as unknown as Api}>
        <Routed>
          <ModelSelect agent="claude" value="" onChange={() => undefined} />
        </Routed>
      </ApiProvider>
    </QueryClientProvider>,
  );

const NONE = {
  text: "Connect a Claude account to pick a model.",
  action: { label: "Model accounts", to: "/accounts" },
};

afterEach(() => {
  cleanup();
  useEmbedShell.setState(EMPTY_SHELL);
});

describe("ModelSelect, narrowed by the embedding app", () => {
  it("offers every listed model on Gram's own", async () => {
    show(async () => ({ models: MODELS }));
    await screen.findByRole("combobox", { name: "Model" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers only what the app's check passes", async () => {
    useEmbedShell.setState({
      models: { offered: (_agent, model) => model === "haiku", none: NONE },
    });
    show(async () => ({ models: MODELS }));
    await screen.findByRole("combobox", { name: "Model" });
    expect(screen.queryByText(NONE.text)).toBeNull();
  });

  it("says the app's words, with its link, when nothing is left to pick", async () => {
    useEmbedShell.setState({ models: { offered: () => false, none: NONE } });
    show(async () => ({ models: MODELS }));
    expect(await screen.findByText(NONE.text)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(NONE.text);
    expect(screen.getByRole("link", { name: "Model accounts" }).getAttribute("href")).toBe(
      "/accounts",
    );
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  });

  it("adds the app's link beside Gram's own error when the list can't be read", async () => {
    useEmbedShell.setState({ models: { none: NONE } });
    show(async () => {
      throw new Error("Start a machine to run this.");
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Start a machine to run this.");
    expect(alert.textContent).toContain(NONE.text);
    expect(screen.getByRole("button", { name: "Retry models" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Model accounts" })).toBeTruthy();
  });

  it("keeps every model when the app's check throws", async () => {
    useEmbedShell.setState({
      models: {
        offered: () => {
          throw new Error("broken");
        },
        none: NONE,
      },
    });
    show(async () => ({ models: MODELS }));
    await screen.findByRole("combobox", { name: "Model" });
    expect(screen.queryByText(NONE.text)).toBeNull();
  });
});
