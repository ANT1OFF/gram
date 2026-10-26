// @vitest-environment happy-dom
import { type AgentKind, type ModelRef, type ProfileId } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useDraftAgentChoice, useLocalDefaultChoice } from "./use-default-choice";
import { useModelsQuery } from "./models";

const models = (agent: AgentKind) => ({
  models: [
    { id: `${agent}-other`, displayName: "Other", supportsEffort: false },
    { id: `${agent}-default`, displayName: "CLI default", supportsEffort: false, isDefault: true },
  ],
});
const wrapper = (
  listModels: Api["listModels"],
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
) => {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiProvider api={{ listModels } as Api}>{children}</ApiProvider>
    </QueryClientProvider>
  );
};
afterEach(cleanup);

describe("new-thread local default discovery", () => {
  it.each(["claude", "codex"] as const)(
    "uses only usable %s's advertised default",
    async (available) => {
      const listModels = vi.fn(async (agent: AgentKind) => {
        if (agent !== available) throw new Error("Selected CLI is absent or signed out");
        return models(agent);
      });
      const { result } = renderHook(() => useDraftAgentChoice(undefined), {
        wrapper: wrapper(listModels),
      });
      await waitFor(() =>
        expect(result.current.choice).toEqual({
          agent: available,
          model: `${available}-default`,
          speed: "standard",
        }),
      );
      expect(result.current.discovering).toBe(false);
      expect(result.current.choice.profileId).toBeUndefined();
    },
  );

  it("waits for both initial probes and retains the inferred harness after its auth discovery fails", async () => {
    let finishClaude!: (value: ReturnType<typeof models>) => void;
    let signedOut = false;
    const client = new QueryClient();
    const listModels = vi.fn((agent: AgentKind) =>
      agent === "claude"
        ? signedOut
          ? Promise.reject(new Error("Claude login expired"))
          : new Promise<ReturnType<typeof models>>((resolve) => {
              finishClaude = resolve;
            })
        : Promise.resolve(models(agent)),
    );
    const { result } = renderHook(
      () => {
        const draft = useDraftAgentChoice(undefined);
        // AgentFields keeps observing the selected harness after automatic inference finishes.
        useModelsQuery(draft.choice.agent, draft.choice.profileId, !draft.discovering);
        return draft;
      },
      {
        wrapper: wrapper(listModels, client),
      },
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    expect(result.current.discovering).toBe(true);
    expect(result.current.choice.model).toBe("");
    await act(async () => finishClaude(models("claude")));
    await waitFor(() => expect(result.current.choice.model).toBe("claude-default"));
    signedOut = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["models", "claude", null] });
    });
    await waitFor(() =>
      expect(client.getQueryState(["models", "claude", null])?.status).toBe("error"),
    );
    expect(result.current.choice.agent).toBe("claude");
    expect(result.current.choice.model).toBe("claude-default");
    expect(listModels).toHaveBeenCalledTimes(3);
  });

  it("never replaces a user choice with a late automatic discovery", async () => {
    let finishCodex!: (value: ReturnType<typeof models>) => void;
    const listModels = vi.fn((agent: AgentKind) =>
      agent === "codex"
        ? new Promise<ReturnType<typeof models>>((resolve) => {
            finishCodex = resolve;
          })
        : Promise.reject(new Error("Claude unavailable")),
    );
    const { result } = renderHook(() => useDraftAgentChoice(undefined), {
      wrapper: wrapper(listModels),
    });
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    const selected = {
      agent: "claude",
      model: "saved-preview",
      profileId: "explicit" as ProfileId,
      variant: "high",
      speed: "fast",
    } as const;
    act(() => result.current.setChoice(selected));
    await act(async () => finishCodex(models("codex")));
    expect(result.current.choice).toEqual(selected);
    expect(result.current.discovering).toBe(false);
  });

  it.each(["claude", "codex"] as const)(
    "preserves saved %s without probing either provider",
    (agent) => {
      const listModels = vi.fn(async () => {
        throw new Error("Auth failure");
      });
      const saved: ModelRef = {
        agent,
        model: "saved",
        profileId: "explicit" as ProfileId,
        variant: "high",
      };
      const { result } = renderHook(() => useDraftAgentChoice(saved), {
        wrapper: wrapper(listModels),
      });
      expect(result.current.choice).toEqual(saved);
      expect(result.current.discovering).toBe(false);
      expect(listModels).not.toHaveBeenCalled();
    },
  );

  it("leaves the model empty when neither local harness offers models", async () => {
    const { result } = renderHook(() => useDraftAgentChoice(undefined), {
      wrapper: wrapper(async () => ({ models: [] })),
    });
    await waitFor(() => expect(result.current.discovering).toBe(false));
    expect(result.current.choice.model).toBe("");
  });

  it("displays Codex's automatic Settings choice without selecting a saved profile", async () => {
    const { result } = renderHook(() => useLocalDefaultChoice(true), {
      wrapper: wrapper(async (agent) => {
        if (agent === "claude") throw new Error("Claude absent");
        return models(agent);
      }),
    });
    await waitFor(() =>
      expect(result.current.choice).toEqual({
        agent: "codex",
        model: "codex-default",
        speed: "standard",
      }),
    );
  });
});
