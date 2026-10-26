// @vitest-environment happy-dom
import type { AgentKind, GatewayProfile, ProfileId } from "@gram/contracts";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";

import { AgentFields, gatewayReady, type AgentChoice } from "./agent-fields";

const LITELLM = "litellm" as ProfileId;

const mockApi = (agents?: readonly AgentKind[]) =>
  createMockApi({ speed: 0, autoplay: false, ...(agents ? { agents } : {}) });

/** Holds the choice like the new-thread draft does, reporting each change. */
function Harness({
  initial,
  onChoice,
}: {
  initial: AgentChoice;
  onChoice: (choice: AgentChoice) => void;
}) {
  const [choice, setChoice] = useState(initial);
  useEffect(() => onChoice(choice), [choice, onChoice]);
  return <AgentFields value={choice} onChange={setChoice} />;
}

/** Hands out the query client, so a test can refetch as a `profiles.changed` event would. */
function OnClient({ onClient }: { onClient: (client: QueryClient) => void }) {
  const client = useQueryClient();
  useEffect(() => {
    onClient(client);
  }, [client, onClient]);
  return null;
}

/** `ui` as the only route, so links render. */
function InRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: () => children }),
      history: createMemoryHistory({ initialEntries: ["/new"] }),
    }),
  );
  return <RouterProvider router={router} />;
}

const profile = (id: string, patch: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: id as ProfileId,
  name: id,
  baseURL: `https://${id}.example.test/v1`,
  keyRef: "",
  models: [],
  ...patch,
});

afterEach(cleanup);

describe("AgentFields", () => {
  it("keeps supported subscription agents discoverable without optional adapters", async () => {
    const api = mockApi();
    const listModels = vi.spyOn(api, "listModels");
    renderWithApi(
      <AgentFields value={{ agent: "claude", model: "opus" }} onChange={() => {}} />,
      api,
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledWith("claude"));
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Agent"));
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Grok Build" })).toBeTruthy();
  });

  it("explains the Grok CLI routing limitation and never offers a gateway selector", async () => {
    const api = mockApi();
    renderWithApi(
      <AgentFields value={{ agent: "grok", model: "synthetic-grok" }} onChange={() => {}} />,
      api,
    );
    expect(await screen.findByText(/^Grok Build is unavailable:/)).toBeTruthy();
    expect(screen.queryByLabelText("Gateway profile")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Grok Build is unavailable in Gram",
    );
    expect(
      gatewayReady({ agent: "grok", model: "synthetic-grok", profileId: LITELLM }, [
        profile(LITELLM, { keyRef: "synthetic" }),
      ]),
    ).toBe(false);
  });
  it("stays on Claude's own subscription even with a saved default gateway", async () => {
    const api = mockApi();
    const listModels = vi.spyOn(api, "listModels");
    const onChoice = vi.fn();
    renderWithApi(
      <Harness initial={{ agent: "claude", model: "opus" }} onChoice={onChoice} />,
      api,
    );
    expect((await screen.findByLabelText("Gateway profile")).textContent).toContain("Subscription");
    await waitFor(() => expect(listModels).toHaveBeenCalledWith("claude"));
    expect(onChoice).toHaveBeenLastCalledWith({ agent: "claude", model: "opus" });
  });

  it("lists Claude's explicit gateway models once it has a key", async () => {
    const api = mockApi();
    await api.setProfileKey(LITELLM, "synthetic-test-key");
    const listModels = vi.spyOn(api, "listModels");
    renderWithApi(
      <AgentFields
        value={{ agent: "claude", profileId: LITELLM, model: "gpt-5.5" }}
        onChange={() => {}}
      />,
      api,
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledWith("claude", LITELLM));
    expect(await screen.findByLabelText("Model")).toBeTruthy();
  });

  it("offers effort only when the account's listed model supports it", async () => {
    renderWithApi(
      <AgentFields
        value={{ agent: "claude", model: "opus", variant: "high" }}
        onChange={() => {}}
      />,
      mockApi(),
    );
    expect((await screen.findByLabelText("Effort")).textContent).toContain("High effort");
    cleanup();
    renderWithApi(
      <AgentFields value={{ agent: "claude", model: "haiku" }} onChange={() => {}} />,
      mockApi(),
    );
    expect((await screen.findByLabelText("Model")).textContent).toContain("Claude Haiku");
    expect(screen.queryByLabelText("Effort")).toBeNull();
  });

  it.each(["codex"] as const)(
    "keeps %s local even when a keyed gateway is the default",
    async (agent) => {
      const api = mockApi(["claude", agent]);
      await api.setProfileKey(LITELLM, "synthetic-test-key");
      const listModels = vi.spyOn(api, "listModels");
      const onChoice = vi.fn();
      renderWithApi(<Harness initial={{ agent, model: "" }} onChoice={onChoice} />, api);
      await waitFor(() => expect(onChoice).toHaveBeenLastCalledWith({ agent, model: "gpt-5.5" }));
      expect(listModels).toHaveBeenCalledWith(agent);
      expect(listModels).not.toHaveBeenCalledWith(agent, LITELLM);
      expect(screen.queryByRole("link", { name: "Add your gateway key" })).toBeNull();
    },
  );

  it("uses the CLI account's default instead of inventing a preferred model", async () => {
    const api = mockApi(["claude", "codex"]);
    vi.spyOn(api, "listModels").mockResolvedValue({
      models: [
        { id: "other", displayName: "Other", supportsEffort: false },
        {
          id: "account-default",
          displayName: "Account default",
          supportsEffort: false,
          isDefault: true,
        },
      ],
    });
    const onChoice = vi.fn();
    renderWithApi(<Harness initial={{ agent: "codex", model: "" }} onChoice={onChoice} />, api);
    await waitFor(() =>
      expect(onChoice).toHaveBeenLastCalledWith({ agent: "codex", model: "account-default" }),
    );
    expect(onChoice).not.toHaveBeenCalledWith(expect.objectContaining({ model: "other" }));
  });

  it("allows Codex without any gateway profiles", async () => {
    const api = mockApi(["claude", "codex"]);
    await api.removeProfile(LITELLM);
    const onChoice = vi.fn();
    renderWithApi(<Harness initial={{ agent: "codex", model: "" }} onChoice={onChoice} />, api);
    await waitFor(() =>
      expect(onChoice).toHaveBeenLastCalledWith({
        agent: "codex",
        model: "gpt-5.5",
      }),
    );
    expect(screen.queryByLabelText("Gateway profile")).toBeNull();
    expect(screen.queryByRole("link", { name: "Add your gateway key" })).toBeNull();
  });

  it("switches Codex between an explicit gateway and its own account without carrying the model or effort", async () => {
    const api = mockApi(["claude", "codex"]);
    await api.setProfileKey(LITELLM, "synthetic-test-key");
    const onChoice = vi.fn();
    renderWithApi(
      <Harness
        initial={{ agent: "codex", model: "gpt-5.5", variant: "high" }}
        onChoice={onChoice}
      />,
      api,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Gateway profile"));
    await user.click(await screen.findByRole("option", { name: "Personal Gateway" }));
    await waitFor(() =>
      expect(onChoice).toHaveBeenLastCalledWith({
        agent: "codex",
        profileId: LITELLM,
        model: "gpt-5.5",
        speed: "standard",
      }),
    );
    await user.click(screen.getByLabelText("Gateway profile"));
    await user.click(await screen.findByRole("option", { name: "Subscription" }));
    await waitFor(() =>
      expect(onChoice).toHaveBeenLastCalledWith({
        agent: "codex",
        model: "gpt-5.5",
        speed: "standard",
      }),
    );
  });

  it.each(["claude", "codex"] as const)(
    "requires a key only for %s's explicitly selected gateway",
    async (agent) => {
      renderWithApi(
        <InRouter>
          <AgentFields
            value={{ agent, profileId: LITELLM, model: "gateway-model" }}
            onChange={() => {}}
          />
        </InRouter>,
        mockApi(["claude", "codex"]),
      );
      expect(
        (await screen.findByRole("link", { name: "Add your gateway key" })).getAttribute("href"),
      ).toBe("/settings/gateways");
      expect(screen.queryByLabelText("Model")).toBeNull();
    },
  );

  it("blocks the explicit gateway again when its key is cleared", async () => {
    const api = mockApi(["claude", "codex"]);
    await api.setProfileKey(LITELLM, "synthetic-test-key");
    let client: QueryClient | undefined;
    renderWithApi(
      <InRouter>
        <OnClient onClient={(c) => (client = c)} />
        <Harness
          initial={{ agent: "codex", profileId: LITELLM, model: "gpt-5.5" }}
          onChoice={() => {}}
        />
      </InRouter>,
      api,
    );
    expect(await screen.findByLabelText("Model")).toBeTruthy();
    await api.setProfileKey(LITELLM, "");
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ["profiles"] });
    });
    expect(await screen.findByRole("link", { name: "Add your gateway key" })).toBeTruthy();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("shows a model-discovery login failure and can retry after sign-in", async () => {
    const api = mockApi(["claude", "codex"]);
    const launchChecks = vi.spyOn(api, "launchChecks");
    const listModels = vi
      .spyOn(api, "listModels")
      .mockRejectedValue(new Error("Codex isn't signed in. Run `codex login`."));
    const onChoice = vi.fn();
    renderWithApi(<Harness initial={{ agent: "codex", model: "" }} onChoice={onChoice} />, api);
    expect((await screen.findByRole("alert")).textContent).toContain("codex login");
    expect(onChoice).not.toHaveBeenCalledWith(expect.objectContaining({ model: "opus" }));
    listModels.mockResolvedValue({
      models: [
        {
          id: "account-model",
          displayName: "Account model",
          supportsEffort: false,
          isDefault: true,
        },
      ],
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry models" }));
    await waitFor(() =>
      expect(onChoice).toHaveBeenLastCalledWith({ agent: "codex", model: "account-model" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(launchChecks).toHaveBeenCalledWith(true);
  });

  it("withdraws cached account models when a refresh reports sign-out", async () => {
    const api = mockApi(["claude", "codex"]);
    const listModels = vi.spyOn(api, "listModels");
    let client: QueryClient | undefined;
    renderWithApi(
      <>
        <OnClient
          onClient={(next) => {
            client = next;
          }}
        />
        <Harness initial={{ agent: "codex", model: "" }} onChoice={() => {}} />
      </>,
      api,
    );
    expect((await screen.findByLabelText("Model")).textContent).toContain("GPT-5.5");
    listModels.mockRejectedValue(new Error("Codex isn't signed in. Run `codex login`."));
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ["models", "codex"] });
    });
    expect((await screen.findByRole("alert")).textContent).toContain("codex login");
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByLabelText("Effort")).toBeNull();
  });
});

describe("gatewayReady", () => {
  const keyed = profile("keyed", { keyRef: "profile:keyed" });
  const keyless = profile("keyless");
  it.each(["claude", "codex"] as const)(
    "allows %s's own local authentication without a gateway",
    (agent) => {
      expect(gatewayReady({ agent, model: "account-model" }, [])).toBe(true);
      expect(gatewayReady({ agent, model: "account-model" }, [keyless, keyed])).toBe(true);
    },
  );
  it.each(["claude", "codex"] as const)(
    "requires %s's explicitly selected profile to exist and have a key",
    (agent) => {
      expect(gatewayReady({ agent, model: "m", profileId: keyless.id }, [keyless])).toBe(false);
      expect(gatewayReady({ agent, model: "m", profileId: keyed.id }, [])).toBe(false);
      expect(gatewayReady({ agent, model: "m", profileId: keyed.id }, [keyed])).toBe(true);
    },
  );
});
