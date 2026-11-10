// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type AgentKind, type OrchestratorCharter } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useServerSettings } from "@/settings-sync/store";
import { themeStore } from "@/theme/store";

import { RosterEditor } from "./roster-editor";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

const efforts = ["low", "medium", "high"] as const;
// Codex alone: Claude Code isn't installed.
const api = {
  listProfiles: async () => [],
  listModels: async (agent: AgentKind) => {
    if (agent === "claude")
      throw Object.assign(new Error("not installed"), { _tag: "AgentUnavailable" });
    return {
      models: [
        {
          id: "gpt-6.1-sol",
          displayName: "GPT-6.1-Sol",
          supportsEffort: true,
          efforts,
          isDefault: true,
        },
      ],
    };
  },
} as unknown as Api;

let current: OrchestratorCharter;
const onChange = vi.fn((next: OrchestratorCharter) => void (current = next));

beforeEach(() => {
  themeStore.setState({ motion: "off" });
  onChange.mockClear();
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("RosterEditor on a machine with Codex alone", () => {
  it("starts an orchestrator of its own on Codex's Lead, not Claude", async () => {
    current = { maxConcurrentWorkers: 1 };
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ApiProvider api={api}>
          <RosterEditor charter={current} onChange={onChange} />
        </ApiProvider>
      </QueryClientProvider>,
    );
    const follow = screen.getByTestId<HTMLSelectElement>("orchestrator-model-follow");
    // Once Codex has answered, "a model of its own" starts on what a new workspace would.
    await waitFor(() => {
      fireEvent.change(follow, { target: { value: "own" } });
      expect(current.orchestratorModel).toMatchObject({
        agent: "codex",
        model: "gpt-6.1-sol",
        variant: "high",
      });
    });
  });
});
