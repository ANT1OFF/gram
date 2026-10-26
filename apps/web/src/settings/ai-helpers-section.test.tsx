// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  EXAMPLE_GATEWAY,
  type GatewayProfile,
  type HelperStatus,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { typingReporter } from "@/composer/typing-presence";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import {
  AiHelpersSection,
  formatUsd,
  helperEfforts,
  pauseLine,
  saveHelperPick,
  saveHelperContext,
  suggestRateLine,
  usageLine,
  withPick,
} from "./ai-helpers-section";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

const mockApi = () => createMockApi({ speed: 0, autoplay: false });

const haiku55 = { id: "claude-haiku-5.5-eu", name: "claude-haiku-5.5-eu" };
const luna = { id: "gpt-6-luna", name: "gpt-6-luna" };

/** Synthetic default gateway, moved to the example address and given invented model metadata. */
const onExample = async (api: MockApi, overrides: Partial<GatewayProfile> = {}) => {
  await api.updateSettings({ helpers: { source: "gateway" } });
  const [litellm] = await api.listProfiles();
  await api.upsertProfile({
    ...litellm!,
    baseURL: EXAMPLE_GATEWAY.baseURL,
    models: [...litellm!.models, haiku55, luna],
    ...overrides,
  });
};

const toggle = (name: string) => screen.getByRole("switch", { name }) as HTMLButtonElement;
const picker = (name: string) => screen.findByRole("combobox", { name });

beforeEach(() => {
  useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, helpers: { source: "gateway" } } });
});
afterEach(cleanup);

describe("AiHelpersSection", () => {
  for (const source of ["claude", "codex"] as const)
    it(`describes strict Claude and guided Codex in advanced settings for ${source}`, async () => {
      const api = mockApi();
      const helpers = { source };
      await api.updateSettings({ helpers });
      useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, helpers } });
      const update = vi.spyOn(api, "updateSettings");
      renderWithApi(<AiHelpersSection />, api);
      await picker("Helper source");
      fireEvent.click(screen.getByText("Advanced · fallback and context"));
      expect(screen.getByText(/Claude is tool-free; Codex uses guided generation/)).toBeTruthy();
      expect(screen.queryByText(/Helpers have no tools/)).toBeNull();
      expect(toggle("Thread titles").disabled).toBe(true);
      expect(update).not.toHaveBeenCalled();
    });

  it("defaults absent source to local automatic without reusing gateway consent or USD controls", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const api = mockApi();
    const [gateway] = await api.listProfiles();
    await api.upsertProfile({
      ...gateway!,
      helperContext: { baseURL: gateway!.baseURL, scope: "conversation" },
    });
    renderWithApi(<AiHelpersSection />, api);
    expect((await picker("Helper source")).textContent).toContain(
      "Automatic (local subscriptions)",
    );
    expect((await picker("Claude Code / Anthropic helper model")).textContent).toContain(
      "Haiku 5.5",
    );
    expect((await picker("Helper context to Claude Code / Anthropic")).textContent).toContain(
      "No context (off)",
    );
    fireEvent.click(screen.getByText("Advanced · fallback and context"));
    expect((await picker("Helper context to Codex / OpenAI")).textContent).toContain(
      "No context (off)",
    );
    expect(toggle("Thread titles").disabled).toBe(true);
    expect(screen.queryByLabelText("Gateway estimate limit")).toBeNull();
    expect(await screen.findByText(/Residual native tools and CLI host instructions/)).toBeTruthy();
  });
  it("preserves deliberately saved local models and scopes without a claimed entitlement", async () => {
    const api = mockApi();
    const helpers = {
      source: "claude" as const,
      claudeModel: "withdrawn-haiku",
      claudeContext: "opening" as const,
    };
    await api.updateSettings({ helpers });
    useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, helpers } });
    renderWithApi(<AiHelpersSection />, api);
    expect((await picker("Claude Code / Anthropic helper model")).textContent).toContain(
      "withdrawn-haiku (unavailable)",
    );
    fireEvent.click(screen.getByText("Advanced · fallback and context"));
    expect((await picker("Local helper fallback")).textContent).toContain("None");
    expect(toggle("Thread titles").disabled).toBe(false);
    expect(toggle("Thread plans").disabled).toBe(true);
    expect((await picker("Helper context to Codex / OpenAI")).textContent).toContain("No context");
  });

  it("renders exact High defaults without saving, then persists independent effort and model choices on reload", async () => {
    const user = userEvent.setup();
    const api = mockApi();
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const update = vi.spyOn(api, "updateSettings");
    const status = await api.helperStatus();
    vi.spyOn(api, "helperStatus").mockResolvedValue({
      ...status,
      providers: [
        status.providers![0]!,
        {
          provider: "codex",
          state: "ready",
          detail: "Synthetic supported adapter",
          models: [
            {
              id: "gpt-6-luna",
              displayName: "GPT-6 Luna",
              supportsEffort: true,
              efforts: ["low", "high"],
            },
          ],
        },
      ],
    });
    const view = renderWithApi(<AiHelpersSection />, api);
    await waitFor(async () =>
      expect((await picker("Claude Code / Anthropic helper effort")).textContent).toContain(
        "High effort",
      ),
    );
    expect(update).not.toHaveBeenCalled();
    await user.click(await picker("Claude Code / Anthropic helper effort"));
    await user.click(screen.getByRole("option", { name: "Low effort" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ helpers: { claudeEffort: "low" } }));
    await user.click(await picker("Helper source"));
    await user.click(screen.getByRole("option", { name: "Codex (local)" }));
    await waitFor(async () =>
      expect((await picker("Codex / OpenAI helper model")).textContent).toContain("GPT-6 Luna"),
    );
    expect((await picker("Codex / OpenAI helper effort")).textContent).toContain("High effort");
    await user.click(await picker("Codex / OpenAI helper effort"));
    await user.click(screen.getByRole("option", { name: "High effort" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ helpers: { codexEffort: "high" } }));
    await user.click(await picker("Codex / OpenAI helper model"));
    await user.click(screen.getByRole("option", { name: "GPT-6 Luna" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ helpers: { codexModel: "gpt-6-luna" } }),
    );
    view.unmount();
    useServerSettings.setState({ settings: await api.getSettings() });
    renderWithApi(<AiHelpersSection />, api);
    expect((await picker("Helper source")).textContent).toContain("Codex");
    expect((await picker("Codex / OpenAI helper model")).textContent).toContain("GPT-6 Luna");
    await user.click(screen.getByText("Advanced · fallback and context"));
    expect((await picker("Claude Code / Anthropic helper effort")).textContent).toContain(
      "Low effort",
    );
    expect((await api.getSettings()).helpers).toMatchObject({
      claudeEffort: "low",
      codexModel: "gpt-6-luna",
      codexEffort: "high",
      source: "codex",
    });
    expect((await api.getSettings()).helpers?.codexContext).toBeUndefined();
  });

  it("recommends Haiku 5.5 with a Luna fallback, and offers an effort with a picked model only", async () => {
    const api = mockApi();
    await onExample(api);
    const view = renderWithApi(<AiHelpersSection />, api);
    expect((await picker("Helper model for Personal Gateway")).textContent).toContain(
      "Automatic — currently claude-haiku-5.5-eu, recommended",
    );
    expect((await picker("Helper fallback for Personal Gateway")).textContent).toContain(
      "Automatic — currently gpt-6-luna, recommended",
    );
    expect(screen.queryByRole("combobox", { name: /effort/ })).toBeNull();
    view.unmount();

    await onExample(api, {
      helperModel: "gpt-5.5",
      helperEffort: "low",
      helperFallback: { model: "gpt-6-luna-gone" },
    });
    renderWithApi(<AiHelpersSection />, api);
    expect((await picker("Helper model effort for Personal Gateway")).textContent).toContain(
      "Low effort",
    );
    // A model picked earlier that discovery no longer lists is still the choice.
    expect((await picker("Helper fallback for Personal Gateway")).textContent).toContain(
      "No longer listed: gpt-6-luna-gone",
    );
  });

  it("says automatic has no fallback while Luna, its only one, is the model", async () => {
    const api = mockApi();
    await onExample(api, { helperModel: "gpt-6-luna" });
    renderWithApi(<AiHelpersSection />, api);
    expect((await picker("Helper fallback for Personal Gateway")).textContent).toMatch(
      /Automatic — none, as .+ is the model/,
    );
  });

  it("starts on the first model where Haiku 5.5 isn't listed, with no fallback", async () => {
    renderWithApi(<AiHelpersSection />, mockApi());
    expect((await picker("Helper model for Personal Gateway")).textContent).toContain(
      "Automatic — currently GPT-5.5",
    );
    expect((await picker("Helper fallback for Personal Gateway")).textContent).toContain(
      "Automatic — none until gpt-6-luna is listed",
    );
    expect(screen.getByRole("combobox", { name: "Helper source" }).textContent).toContain(
      "Gateway",
    );
  });

  it("stores a slot's pick on the profile, the default as nothing and no fallback as null", () => {
    const profile: GatewayProfile = {
      ...EXAMPLE_GATEWAY,
      keyRef: "",
      models: [],
      helperModel: "a",
      helperEffort: "low",
      helperFallback: null,
    };
    expect(withPick(profile, "primary", undefined)).not.toHaveProperty("helperModel");
    expect(withPick(profile, "primary", undefined)).not.toHaveProperty("helperEffort");
    expect(withPick(profile, "primary", { model: "b" })).toMatchObject({ helperModel: "b" });
    expect(withPick(profile, "primary", { model: "b" })).not.toHaveProperty("helperEffort");
    expect(withPick(profile, "fallback", undefined)).not.toHaveProperty("helperFallback");
    const { helperFallback: _none, ...unset } = profile;
    expect(withPick(unset, "fallback", null)).toMatchObject({
      helperFallback: null,
    });
  });

  it("saves the two slots one after another, so neither undoes the other", async () => {
    const api = mockApi();
    await onExample(api);
    const [stale] = await api.listProfiles();
    await Promise.all([
      saveHelperPick(api, stale!, "primary", { model: "gpt-5.5" }),
      saveHelperPick(api, stale!, "fallback", null),
    ]);
    const [saved] = await api.listProfiles();
    expect(saved).toMatchObject({ helperModel: "gpt-5.5", helperFallback: null });
  });

  it("keeps every helper off until context is allowed, then follows feature switches", async () => {
    const api = mockApi();
    const save = vi.spyOn(api, "updateSettings");
    renderWithApi(<AiHelpersSection />, api);
    await picker("Helper model for Personal Gateway");
    expect(toggle("Thread titles").disabled).toBe(true);
    expect(toggle("Thread plans").disabled).toBe(true);
    const upsert = vi.spyOn(api, "upsertProfile");
    fireEvent.change(screen.getByRole("combobox", { name: "Helper context permission" }), {
      target: { value: "opening" },
    });
    expect(screen.getByRole("group", { name: "Allow helper context" }).textContent).toContain(
      "first message",
    );
    expect(upsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow context" }));
    await waitFor(() => expect(toggle("Thread titles").disabled).toBe(false));
    expect(toggle("Thread plans").disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Helper context permission" }), {
      target: { value: "conversation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow context" }));
    await waitFor(() => expect(toggle("Thread plans").disabled).toBe(false));

    fireEvent.click(toggle("Thread titles"));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ helpers: { title: false } }));
    fireEvent.click(toggle("Use the helper model"));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ helpers: { enabled: false } }));
    await waitFor(() => expect(toggle("Thread titles").disabled).toBe(true));
  });

  it("shows the suggestions' acceptance rate under their switch", async () => {
    const api = mockApi();
    await onExample(api);
    renderWithApi(<AiHelpersSection />, api);
    expect((await screen.findByTestId("suggest-rate")).textContent).toBe(
      "Last 7 days: used in 9 of 34 turns that offered them (26%).",
    );
  });

  it("saves the daily budget, refuses nothing at all, and shows today's use", async () => {
    const api = mockApi();
    await onExample(api);
    const save = vi.spyOn(api, "updateSettings");
    renderWithApi(<AiHelpersSection />, api);
    const field = screen.getByLabelText("Gateway estimate limit") as HTMLInputElement;
    expect(field.value).toBe("2");
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(screen.getByRole("alert").textContent).toContain("more than $0");
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalledWith({ helpers: { dailyBudgetUsd: 5 } }));
    expect(await screen.findByText(/42 calls · \$0\.03 of \$2\.00 · 1 failure/)).toBeTruthy();
    expect(screen.getByTestId("helper-usage").textContent).toContain("Titles12 calls");
  });
});

const profile = (model: GatewayProfile["models"][number]) =>
  ({ id: "p", name: "p", baseURL: "", keyRef: "", models: [model] }) as unknown as GatewayProfile;
const values = (r: ReturnType<typeof helperEfforts>) => r.options.map((o) => o.value);

describe("helper context consent", () => {
  it("serializes context and model saves, revokes consent, and refuses endpoint changes", async () => {
    const api = mockApi();
    const [consentingProfile] = await api.listProfiles();
    if (!consentingProfile) throw new Error("missing test consentingProfile");
    await Promise.all([
      saveHelperContext(api, consentingProfile, "opening"),
      saveHelperPick(api, consentingProfile, "primary", { model: "gpt-5.5" }),
    ]);
    const saved = (await api.listProfiles()).find((p) => p.id === consentingProfile.id)!;
    expect(saved.helperContext).toEqual({ baseURL: consentingProfile.baseURL, scope: "opening" });
    expect(saved.helperModel).toBe("gpt-5.5");
    await api.upsertProfile({ ...saved, baseURL: "https://changed.example/v1" });
    await expect(saveHelperContext(api, consentingProfile, "conversation")).rejects.toThrow();
    await saveHelperContext(api, { ...saved, baseURL: "https://changed.example/v1" }, "off");
    expect(
      (await api.listProfiles()).find((p) => p.id === consentingProfile.id)?.helperContext,
    ).toBeUndefined();
  });
});

describe("helperEfforts", () => {
  it("offers what the gateway lists, and nothing for a model without an effort", () => {
    const listed = helperEfforts(
      profile({ id: "m", name: "m", variants: ["low", "high"] }),
      "m",
      undefined,
    );
    expect(values(listed)).toEqual(["low", "high"]);
    expect(listed.unlisted).toBe(false);
    const none = { id: "m", name: "m", info: { reasoning: false } };
    expect(values(helperEfforts(profile(none), "m", undefined))).toEqual([]);
    // A stored effort the model doesn't take stays shown, as such, until it's changed.
    expect(helperEfforts(profile(none), "m", "high").options).toEqual([
      { value: "high", label: "High effort (not offered)" },
    ]);
  });

  it("marks the efforts it offers as not listed when the gateway says nothing", () => {
    const unlisted = helperEfforts(profile({ id: "m", name: "m" }), "m", undefined);
    expect(unlisted.unlisted).toBe(true);
    expect(values(unlisted)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(unlisted.options[0]!.label).toBe("Low effort (not listed)");
  });
});

describe("helper usage lines", () => {
  const status: HelperStatus = {
    day: "2026-10-01",
    calls: 312,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0.07,
    failures: 3,
    lines: [],
    dailyBudgetUsd: 2,
  };

  it("reads as one line, with fractions of a cent said so", () => {
    expect(usageLine(status)).toBe("312 calls · $0.07 of $2.00 · 3 failures");
    expect(usageLine({ ...status, calls: 1, failures: 0 })).toBe("1 call · $0.07 of $2.00");
    expect(formatUsd(0.0004)).toBe("under $0.01");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("says how suggested replies are doing against the 20% they need", () => {
    const counts = {
      since: "2026-09-25",
      shown: 34,
      taken: 9,
      accepted: 7,
      wordAccepted: 2,
      editedAfter: 1,
      dismissed: 5,
    };
    expect(suggestRateLine(counts)).toBe(
      "Last 7 days: used in 9 of 34 turns that offered them (26%).",
    );
    // Nothing changes at the bar for keeping them on by default, so the line never names it.
    expect(suggestRateLine({ ...counts, taken: 3 })).toBe(
      "Last 7 days: used in 3 of 34 turns that offered them (9%).",
    );
    expect(suggestRateLine({ ...counts, shown: 0, taken: 0 })).toBe(
      "None shown in the last 7 days.",
    );
  });

  it("says why helpers are paused", () => {
    expect(pauseLine(status)).toBeUndefined();
    expect(pauseLine({ ...status, paused: { reason: "budget", until: 0 } })).toBe(
      "Helpers paused until midnight UTC: daily budget reached.",
    );
    expect(pauseLine({ ...status, paused: { reason: "keyDisabled", until: 0 } })).toContain(
      "disabled your key",
    );
  });

  it("tells the server about typing at most every 2 s", async () => {
    let now = 0;
    const send = vi.fn(async () => {});
    const report = typingReporter(send, () => now);
    report();
    now = 1_500;
    report();
    now = 2_000;
    report();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
