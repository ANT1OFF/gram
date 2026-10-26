// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  gatewayAgentModel,
  newWorkspaceCharter,
  type AgentKind,
  type GatewayProfile,
  type OrchestratorCharter,
  type ProfileId,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { UNLISTED_EFFORTS } from "@/composer/models";
import { useServerSettings } from "@/settings-sync/store";
import { themeStore } from "@/theme/store";

import { RosterEditor } from "./roster-editor";
import { SOL_ROSTER } from "./roster-test-fixtures";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

const efforts = ["low", "medium", "high"] as const;
const gateway: GatewayProfile = {
  id: "litellm" as ProfileId,
  name: "LiteLLM",
  baseURL: "https://llm.example.test/v1",
  keyRef: "",
  models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
  default: true,
};

const api = {
  listProfiles: async () => [gateway],
  listModels: async (agent: AgentKind, profileId?: ProfileId) => {
    if (agent === "codex" && profileId === gateway.id) {
      return { models: [gatewayAgentModel({ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }, "codex")] };
    }
    if (agent === "claude") {
      return {
        models: [
          { id: "opus", displayName: "Opus", supportsEffort: true, efforts, isDefault: true },
          { id: "sonnet", displayName: "Sonnet", supportsEffort: true, efforts },
        ],
      };
    }
    // Codex isn't set up on its own login here.
    throw Object.assign(new Error("not installed"), { _tag: "AgentUnavailable" });
  },
} as unknown as Api;

let current: OrchestratorCharter;
const onChange = vi.fn((next: OrchestratorCharter) => void (current = next));

const view = (charter: OrchestratorCharter) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ApiProvider api={api}>
      <RosterEditor charter={charter} onChange={onChange} />
    </ApiProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  themeStore.setState({ motion: "off" });
  onChange.mockClear();
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("RosterEditor", () => {
  it("keeps effort variants distinct when adding, editing and removing rows", async () => {
    current = newWorkspaceCharter({ workerModels: SOL_ROSTER });
    const { rerender } = render(view(current));
    fireEvent.click(screen.getByTestId("worker-model-add"));
    fireEvent.change(screen.getByTestId("worker-model-form-note"), {
      target: { value: "default effort jobs" },
    });
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>("worker-model-save").disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("worker-model-save"));
    rerender(view(current));
    expect(screen.getAllByTestId("worker-model")).toHaveLength(4);
    const last = screen.getAllByTestId("worker-model")[3]!;
    fireEvent.change(within(last).getByTestId("worker-model-effort"), {
      target: { value: "high" },
    });
    // Editing effort cannot turn an entry into one already in the list.
    expect(current.workerModels?.[3]?.variant).toBeUndefined();
    fireEvent.change(within(last).getByTestId("worker-model-effort"), {
      target: { value: "low" },
    });
    rerender(view(current));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove Claude Code opus" })[0]!);
    rerender(view(current));
    expect(
      screen.getAllByTestId<HTMLInputElement>("worker-model-note").map((note) => note.value),
    ).toEqual(current.workerModels?.map((model) => model.useFor));
    expect(screen.getAllByTestId("worker-model")).toHaveLength(3);
    expect(current.workerModels?.[2]).toMatchObject({
      model: "opus",
      variant: "low",
      useFor: "default effort jobs",
    });
  });

  it("shows local setup instructions without taking up a keyless gateway", async () => {
    current = newWorkspaceCharter({ workerModels: SOL_ROSTER });
    render(view(current));
    const entries = screen.getAllByTestId("worker-model");
    expect(entries.map((entry) => entry.getAttribute("data-agent"))).toEqual([
      "claude",
      "codex",
      "claude",
    ]);
    expect(entries[0]!.getAttribute("data-default")).toBe("true");
    expect(
      within(entries[0]!).getByLabelText<HTMLSelectElement>("Effort for Claude Code opus").value,
    ).toBe("high");
    await waitFor(() => expect(entries[1]!.getAttribute("data-unavailable")).toBe("true"));
    const warning = within(entries[1]!).getByTestId("worker-model-warning");
    expect(warning.textContent).toContain("Codex couldn't list local models");
    expect(within(warning).getByRole("link").getAttribute("href")).toBe("/settings/agents");
  });

  it("changes an entry's effort and nothing else", () => {
    current = newWorkspaceCharter({ workerModels: SOL_ROSTER });
    render(view(current));
    const [opus] = screen.getAllByTestId("worker-model");
    fireEvent.change(within(opus!).getByLabelText("Effort for Claude Code opus"), {
      target: { value: "low" },
    });
    expect(current.workerModels?.[0]).toMatchObject({
      model: "opus",
      variant: "low",
      default: true,
    });
    expect(current.workerModels?.[1]).toMatchObject({ model: "gpt-6.1-sol", variant: "high" });
    expect(current.orchestratorModel).toEqual({
      agent: "claude",
      model: "opus",
      variant: "high",
      speed: "standard",
    });
  });

  it("offers effort for a gateway model that lists none, saying the gateway doesn't", async () => {
    current = {
      ...newWorkspaceCharter({}),
      workerModels: [{ agent: "codex", model: "gpt-6.1-sol", profileId: gateway.id }],
    };
    render(view(current));
    const [sol] = screen.getAllByTestId("worker-model");
    const select = await within(sol!).findByLabelText<HTMLSelectElement>(/^Effort for /);
    await waitFor(() => expect(select.title).toBe(UNLISTED_EFFORTS));
    expect([...select.options].map((option) => option.textContent)).toContain(
      "High effort (not listed)",
    );
    fireEvent.change(select, { target: { value: "high" } });
    expect(current.workerModels?.[0]).toMatchObject({ model: "gpt-6.1-sol", variant: "high" });
  });

  it("shows the charter's orchestrator model when the charter changes under it", async () => {
    const { rerender } = render(view({ maxConcurrentWorkers: 1 }));
    const follow = screen.getByTestId<HTMLSelectElement>("orchestrator-model-follow");
    expect(follow.value).toBe("follow");
    // The workspace arrives, or is saved elsewhere, after the editor mounted.
    rerender(
      view({
        maxConcurrentWorkers: 1,
        orchestratorModel: { agent: "claude", model: "sonnet" },
      }),
    );
    expect(follow.value).toBe("own");
    const picker = within(screen.getByTestId("orchestrator-model"));
    await waitFor(() =>
      expect(picker.getByRole("combobox", { name: "Model" }).textContent).toContain("Sonnet"),
    );
  });
});
