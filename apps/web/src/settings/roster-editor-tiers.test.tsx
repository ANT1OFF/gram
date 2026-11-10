// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  RECOMMENDED,
  type AgentKind,
  type OrchestratorCharter,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const efforts = ["low", "medium", "high", "xhigh"] as const;
// Synthetic lists shaped like each CLI's: Claude's aliases with the ids they run, Codex's ids.
const api = {
  listProfiles: async () => [],
  listModels: async (agent: AgentKind) => ({
    models:
      agent === "claude"
        ? [
            {
              id: "opus",
              displayName: "Opus",
              supportsEffort: true,
              efforts,
              resolvedId: "claude-opus-5-5",
            },
            {
              id: "sonnet",
              displayName: "Sonnet",
              supportsEffort: true,
              efforts,
              resolvedId: "claude-sonnet-5-5",
            },
          ]
        : [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", supportsEffort: true, efforts }],
  }),
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

describe("RosterEditor with entries that follow a tier", () => {
  it("shows what each runs on here, and keeps one following at an effort picked", async () => {
    current = {
      maxConcurrentWorkers: 1,
      workerModels: [
        { tier: "scoped", default: true },
        { tier: "lead", agent: "claude" },
      ],
    };
    const { rerender } = render(view(current));
    await waitFor(() =>
      expect(screen.getAllByTestId("worker-model")[0]!.dataset["agent"]).toBe("codex"),
    );
    const [scoped, lead] = screen.getAllByTestId("worker-model");
    expect(scoped!.dataset["tier"]).toBe("scoped");
    expect(scoped!.textContent).toContain("gpt-6.1-sol");
    expect(lead!.textContent).toContain("opus");
    // The tier's note is a hint, not a note of the user's.
    const note = within(scoped!).getByTestId<HTMLInputElement>("worker-model-note");
    expect(note.value).toBe("");
    expect(note.placeholder).toBe(RECOMMENDED.tiers.scoped.note);

    // A note of their own keeps the entry following.
    fireEvent.change(note, { target: { value: "Synthetic note" } });
    fireEvent.blur(note);
    expect(current.workerModels?.[0]).toEqual({
      tier: "scoped",
      default: true,
      useFor: "Synthetic note",
    });
    rerender(view(current));

    // An effort picked keeps it following, at that effort; the menu ends at high.
    const effort = within(screen.getAllByTestId("worker-model")[1]!).getByTestId<HTMLSelectElement>(
      "worker-model-effort",
    );
    await waitFor(() =>
      expect([...effort.options].map((option) => option.value)).toEqual([
        "default",
        "low",
        "medium",
        "high",
      ]),
    );
    fireEvent.change(effort, { target: { value: "high" } });
    expect(current.workerModels?.[1]).toEqual({ tier: "lead", agent: "claude", variant: "high" });
    rerender(view(current));

    // The model's default effort is the tier's own again.
    fireEvent.change(
      within(screen.getAllByTestId("worker-model")[1]!).getByTestId("worker-model-effort"),
      { target: { value: "default" } },
    );
    expect(current.workerModels?.[1]).toEqual({ tier: "lead", agent: "claude" });
    expect(current.workerModels?.[0]).toMatchObject({ tier: "scoped" });
  });

  it("says why an entry, or the orchestrator, can't run here", async () => {
    current = {
      maxConcurrentWorkers: 1,
      // Nothing here lists Fable or Astra, and only a newer Gram knows "huge".
      orchestratorModel: { tier: "top" },
      workerModels: [{ tier: "top" }, { tier: "huge" }, { tier: "scoped", default: true }],
    };
    render(view(current));
    await waitFor(() => expect(screen.getAllByTestId("worker-model-warning")).toHaveLength(3));
    const [orchestrator, top, huge] = screen.getAllByTestId("worker-model-warning");
    expect(orchestrator!.textContent).toContain("Nothing here fills the Top tier: Claude Code");
    expect(top!.textContent).toContain("Nothing here fills the Top tier: Claude Code");
    expect(huge!.textContent).toContain("only a newer version of Gram knows");
    const rows = screen.getAllByTestId("worker-model");
    expect(rows.map((row) => row.dataset["unavailable"])).toEqual(["true", "true", undefined]);
  });

  it("keeps an inherited default's reason when the orchestrator follows it", async () => {
    useServerSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, defaultModel: { tier: "top" } },
      },
    });
    current = { maxConcurrentWorkers: 1 };
    render(view(current));
    const warning = await screen.findByTestId("worker-model-warning");
    expect(warning.textContent).toContain(
      "Your default model is unavailable: nothing here fills the Top tier",
    );
  });
});

const on = {
  ...DEFAULT_SETTINGS,
  agents: { ...DEFAULT_SETTINGS.agents, recommendedSetup: { enabled: true } },
};

describe("RosterEditor with the recommended setup on", () => {
  it("marks each slot as following or yours, with the words on hover only", async () => {
    useServerSettings.setState({ settings: on });
    current = {
      maxConcurrentWorkers: 1,
      orchestratorModel: { tier: "lead" },
      workerModels: [
        { tier: "scoped", default: true },
        { agent: "codex", model: "gpt-6.1-sol", variant: "high", useFor: "Synthetic reviews" },
      ],
    };
    const { rerender } = render(view(current));
    await waitFor(() => expect(screen.getAllByTestId("slot-follow")).toHaveLength(1));
    const orchestrator = screen.getByTestId("orchestrator-model");
    const glyph = within(orchestrator).getByTestId("slot-glyph");
    expect(glyph.dataset["follows"]).toBe("true");
    expect(glyph.getAttribute("aria-label")).toBe("Recommended · Lead tier · updates with Gram");
    // The words aren't on the row: only the glyph's label carries them.
    expect(orchestrator.textContent).not.toContain("updates with Gram");

    const [scoped, pinned] = screen.getAllByTestId("worker-model");
    expect(within(scoped!).getByTestId("slot-glyph").getAttribute("aria-label")).toBe(
      "Recommended · Scoped tier · updates with Gram",
    );
    expect(within(scoped!).queryByTestId("slot-follow")).toBeNull();
    const pin = within(pinned!).getByTestId("slot-glyph");
    expect(pin.dataset["follows"]).toBeUndefined();
    expect(pin.getAttribute("aria-label")).toBe("Your choice · updates leave it alone");
    // A pinned row offers every effort its model lists.
    expect(
      [...within(pinned!).getByTestId<HTMLSelectElement>("worker-model-effort").options].map(
        (option) => option.value,
      ),
    ).toContain("xhigh");

    // Follow recommended moves it to the tier that runs Sol at high here, on Codex, keeping its note.
    fireEvent.click(within(pinned!).getByRole("button", { name: "Follow recommended" }));
    expect(current.workerModels?.[1]).toEqual({
      tier: "lead",
      agent: "codex",
      useFor: "Synthetic reviews",
    });
    rerender(view(current));
    await waitFor(() => expect(screen.queryByTestId("slot-follow")).toBeNull());
  });

  it("moves a pinned orchestrator back to Lead", async () => {
    useServerSettings.setState({ settings: on });
    current = {
      maxConcurrentWorkers: 1,
      orchestratorModel: { agent: "claude", model: "opus", variant: "xhigh" },
    };
    render(view(current));
    const orchestrator = screen.getByTestId("orchestrator-model");
    expect(within(orchestrator).getByTestId("slot-glyph").getAttribute("aria-label")).toBe(
      "Your choice · updates leave it alone",
    );
    fireEvent.click(within(orchestrator).getByRole("button", { name: "Follow recommended" }));
    expect(current.orchestratorModel).toEqual({ tier: "lead" });
  });

  it("shows no glyphs while the mode is off", async () => {
    current = {
      maxConcurrentWorkers: 1,
      orchestratorModel: { agent: "claude", model: "opus" },
      workerModels: [{ tier: "scoped" }, { agent: "claude", model: "sonnet" }],
    };
    render(view(current));
    await waitFor(() =>
      expect(screen.getAllByTestId("worker-model")[0]!.dataset["agent"]).toBe("codex"),
    );
    expect(screen.queryByTestId("slot-glyph")).toBeNull();
    expect(screen.queryByTestId("slot-follow")).toBeNull();
  });
});
