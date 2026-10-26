// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type AgentKind,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { choiceFromModel } from "@/composer/default-choice";
import { useServerSettings } from "@/settings-sync/store";

import { AgentsSection } from "./agents-section";
import { AGENTS_DEFAULTS, NOTIFICATIONS_DEFAULTS, type DefaultSetting } from "./defaults";
import { useRestoreDefaults } from "./restore-defaults";
import { useSaveSettings } from "./use-save-settings";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

function RestoreHarness({
  defaults = Object.values(AGENTS_DEFAULTS),
}: {
  defaults?: readonly DefaultSetting[];
}) {
  const { button, strip } = useRestoreDefaults(defaults);
  return (
    <div data-testid="restore">
      {button}
      {strip}
    </div>
  );
}

let stored: Settings;
const updateSettings = vi.fn(async (patch: SettingsPatch) => {
  stored = applySettingsPatch(stored, patch);
  return stored;
});

beforeEach(() => {
  stored = DEFAULT_SETTINGS;
  updateSettings.mockClear();
  useServerSettings.setState({ settings: stored });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider
        api={
          {
            updateSettings,
            listProfiles: async () => [],
            listModels: async () => ({
              models: [{ id: "opus", displayName: "Claude Opus", supportsEffort: true }],
            }),
          } as unknown as Api
        }
      >
        <AgentsSection />
      </ApiProvider>
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("AgentsSection", () => {
  it("displays the CLI model default without saving or marking the unset setting changed", async () => {
    expect((await screen.findByRole("combobox", { name: "Model" })).textContent).toContain(
      "Claude Opus",
    );
    expect(updateSettings).not.toHaveBeenCalled();
    expect(stored.agents.defaultModel).toBeUndefined();
    expect(screen.queryByRole("button", { name: /to default/ })).toBeNull();
  });

  it("displays an unset default from Codex alone without saving or asking for Claude setup", async () => {
    cleanup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ApiProvider
          api={
            {
              updateSettings,
              listProfiles: async () => [],
              listModels: async (agent: AgentKind) => {
                if (agent !== "codex") throw new Error("Claude Code isn't installed");
                return {
                  models: [
                    {
                      id: "codex-only",
                      displayName: "Codex CLI default",
                      supportsEffort: false,
                      isDefault: true,
                    },
                  ],
                };
              },
            } as unknown as Api
          }
        >
          <AgentsSection />
        </ApiProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" }).textContent).toContain("Codex"),
    );
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain(
      "Codex CLI default",
    );
    expect(screen.queryByText(/Claude Code isn't installed/)).toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(stored.agents.defaultModel).toBeUndefined();
  });

  it("saves a valid idle timeout and rejects one out of range", async () => {
    const idle = screen.getByLabelText<HTMLInputElement>("Close idle sessions after");
    expect(idle.value).toBe(String(DEFAULT_SETTINGS.agents.idleEvictMinutes));

    fireEvent.change(idle, { target: { value: "0" } });
    fireEvent.blur(idle);
    expect(screen.getByRole("alert").textContent).toContain("from 1 to 1440");
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.change(idle, { target: { value: "45" } });
    fireEvent.keyDown(idle, { key: "Enter" });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ agents: { idleEvictMinutes: 45 } }),
    );
  });

  it("marks a changed setting with a reset that puts the default back", async () => {
    expect(screen.queryByRole("button", { name: /to default/ })).toBeNull();
    const idle = screen.getByLabelText<HTMLInputElement>("Close idle sessions after");
    fireEvent.change(idle, { target: { value: "45" } });
    fireEvent.blur(idle);
    const reset = await screen.findByRole("button", {
      name: "Reset Close idle sessions after to default",
    });
    fireEvent.click(reset);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({
        agents: { idleEvictMinutes: DEFAULT_SETTINGS.agents.idleEvictMinutes },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /to default/ })).toBeNull());
  });

  it("puts a failed save under its own row, clamping a long one until opened", async () => {
    const long = `The server said no. ${"Details follow. ".repeat(20)}`;
    updateSettings.mockRejectedValueOnce(new Error(long));
    const idle = screen.getByLabelText<HTMLInputElement>("Close idle sessions after");
    fireEvent.change(idle, { target: { value: "30" } });
    fireEvent.blur(idle);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The server said no.");
    expect(alert.querySelector("p")!.className).toContain("line-clamp-3");
    fireEvent.click(screen.getByRole("button", { name: "Show full error" }));
    expect(alert.querySelector("p")!.className).not.toContain("line-clamp-3");
  });

  it("shows the default mode", () => {
    expect(screen.getByRole("combobox", { name: "Default mode" }).textContent).toContain("Auto");
  });
});

const renderHarness = (api: Partial<Api> = {}, defaults?: readonly DefaultSetting[]) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider api={{ updateSettings, ...api } as unknown as Api}>
        <RestoreHarness {...(defaults === undefined ? {} : { defaults })} />
      </ApiProvider>
    </QueryClientProvider>,
  );

describe("Restore defaults", () => {
  it("is disabled, and says why, while nothing differs", () => {
    const { getByRole } = renderHarness();
    const button = getByRole("button", { name: /Restore defaults/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement!.textContent).toContain(
      "Everything here is already at its default.",
    );
  });

  it("names what it resets, then resets all of it in one save", async () => {
    stored = applySettingsPatch(stored, {
      agents: { defaultMode: "plan", idleEvictMinutes: 45 },
    });
    useServerSettings.setState({ settings: stored });
    const { getByRole, findByRole } = renderHarness();
    fireEvent.click(getByRole("button", { name: /Restore defaults/ }));
    const strip = await findByRole("group", { name: "Restore defaults" });
    expect(strip.textContent).toContain("Resets Default mode and Close idle sessions after.");
    fireEvent.click(within(strip).getByRole("button", { name: "Restore defaults" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({
        agents: {
          defaultMode: DEFAULT_SETTINGS.agents.defaultMode,
          idleEvictMinutes: DEFAULT_SETTINGS.agents.idleEvictMinutes,
        },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Restore defaults" })).toBeNull(),
    );
  });
});

describe("Restore defaults, once saved", () => {
  it("closes, and says only the review requests are late when their refresh fails", async () => {
    stored = applySettingsPatch(stored, { notifications: { reviewRequestsHideBots: false } });
    useServerSettings.setState({ settings: stored });
    const refreshReviewRequests = vi.fn(async () => {
      throw new Error("gh is offline");
    });
    const { getByRole, findByRole } = renderHarness(
      { refreshReviewRequests } as Partial<Api>,
      Object.values(NOTIFICATIONS_DEFAULTS),
    );
    fireEvent.click(getByRole("button", { name: /Restore defaults/ }));
    const strip = await findByRole("group", { name: "Restore defaults" });
    fireEvent.click(within(strip).getByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(refreshReviewRequests).toHaveBeenCalled());
    expect((await screen.findAllByRole("alert")).at(-1)!.textContent).toContain(
      "Defaults restored, but the review requests didn't refresh: gh is offline",
    );
    expect(screen.queryByRole("group", { name: "Restore defaults" })).toBeNull();
    expect(stored.notifications.reviewRequestsHideBots).toBe(true);
  });
});

describe("useSaveSettings", () => {
  it("saves one patch at a time, so the last one asked for is the one that stays", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: SettingsPatch[] = [];
    const slowFirst = vi.fn(async (patch: SettingsPatch) => {
      sent.push(patch);
      if (sent.length === 1) await gate;
      return updateSettings(patch);
    });
    const { result } = renderHook(() => useSaveSettings(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ApiProvider api={{ updateSettings: slowFirst } as unknown as Api}>{children}</ApiProvider>
      ),
    });
    const save = result.current;
    const first = save({ agents: { defaultFolder: "~/draft" } });
    const second = save({ agents: { defaultFolder: null } });
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual([
      { agents: { defaultFolder: "~/draft" } },
      { agents: { defaultFolder: null } },
    ]);
    expect(useServerSettings.getState().settings?.agents.defaultFolder).toBeUndefined();
  });
});

describe("choiceFromModel", () => {
  it("waits for the CLI default when unset, and preserves an explicit gateway profile", () => {
    expect(choiceFromModel(undefined)).toEqual({ agent: "claude", model: "", speed: "standard" });
    expect(choiceFromModel({ agent: "codex", model: "gpt-5", profileId: "gw" } as never)).toEqual({
      agent: "codex",
      model: "gpt-5",
      profileId: "gw",
    });
  });
});
