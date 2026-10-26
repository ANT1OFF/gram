// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
  type ThreadSummary,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { playChime } from "@/desktop/chime";
import type * as ChimeModule from "@/desktop/chime";
import { useSeedReviewBotRepos } from "@/reviews/review-requests";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { themeStore } from "@/theme/store";

import { NotificationsSection } from "./notifications-section";

vi.mock("@/desktop/chime", async (importOriginal) => ({
  ...(await importOriginal<typeof ChimeModule>()),
  playChime: vi.fn(),
}));

let stored: Settings;
const updateSettings = vi.fn(async (patch: SettingsPatch) => {
  stored = applySettingsPatch(stored, patch);
  useServerSettings.setState({ settings: stored });
  return stored;
});
/** Successful polls, which is what moves `checkedAt`. */
let polls = 0;
const refreshReviewRequests = vi.fn(async (_options?: { force?: boolean }) => {
  polls += 1;
});
const listReviewRequests = vi.fn(async () => ({
  requests: [
    {
      repo: "example/api",
      number: 530,
      title: "Add rate limit headers",
      url: "https://github.com/example/api/pull/530",
      author: "jordan",
      updatedAt: "2026-09-17T08:40:00Z",
      bot: { verdict: "approved" as const, onHead: true },
    },
  ],
  checkedAt: polls,
}));

beforeEach(() => {
  stored = DEFAULT_SETTINGS;
  updateSettings.mockClear();
  refreshReviewRequests.mockClear();
  useServerSettings.setState({ settings: stored });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider
        api={{ updateSettings, refreshReviewRequests, listReviewRequests } as unknown as Api}
      >
        <NotificationsSection />
        <SeedReviewBotRepos />
      </ApiProvider>
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
  useThreadsStore.setState({ ready: false, byId: {} });
  themeStore.setState({ motion: themeStore.getInitialState().motion });
});

/** A thread whose PR badge says a review bot has been on it. */
const withBadge = (id: string, repo: string) =>
  act(() =>
    useThreadsStore.setState((s) => ({
      byId: {
        ...s.byId,
        [id]: {
          git: { pr: { url: `https://github.com/${repo}/pull/1`, review: { bots: ["bot"] } } },
        } as unknown as ThreadSummary,
      },
    })),
  );

function SeedReviewBotRepos() {
  useSeedReviewBotRepos();
  return null;
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("NotificationsSection", () => {
  it("turns review requests off and on, polling at once after each change", async () => {
    const toggle = screen.getByRole<HTMLButtonElement>("switch", {
      name: /Check for review requests/,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    await waitFor(() => expect(refreshReviewRequests).toHaveBeenCalledWith({ force: true }));
    expect(updateSettings).toHaveBeenCalledWith({ notifications: { reviewRequests: false } });
    expect(stored.notifications.reviewRequests).toBe(false);
  });

  it("narrows review requests to direct ones, and follows the parent toggle", async () => {
    const direct = screen.getByRole<HTMLButtonElement>("switch", {
      name: /Direct requests only/,
    });
    expect(direct.getAttribute("aria-checked")).toBe("true");
    expect(direct.disabled).toBe(false);

    fireEvent.click(direct);
    await waitFor(() => expect(refreshReviewRequests).toHaveBeenCalledWith({ force: true }));
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: { reviewRequestsDirectOnly: false },
    });
    expect(stored.notifications.reviewRequestsDirectOnly).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: /Check for review requests/ }));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("switch", { name: /Direct requests only/ }).disabled,
      ).toBe(true),
    );
  });

  it("holds no notification by default, and saves a hold that is turned on", async () => {
    const checks = screen.getByRole<HTMLButtonElement>("switch", { name: /Wait for checks/ });
    const bot = screen.getByRole<HTMLButtonElement>("switch", { name: /Wait for review bot/ });
    expect(checks.getAttribute("aria-checked")).toBe("false");
    expect(bot.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checks);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { reviewRequestsAwaitChecks: true },
      }),
    );
    fireEvent.click(bot);
    await waitFor(() => expect(stored.notifications.reviewRequestsAwaitBot).toBe(true));
  });

  it("lists the repositories with a review bot while it waits for one, starting suggested", async () => {
    expect(screen.queryByTestId("review-bot-repos")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Wait for review bot/ }));
    // The list is left for the app to fill in once it knows enough; until then it shows suggested.
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { reviewRequestsAwaitBot: true },
      }),
    );
    expect(await screen.findByRole("button", { name: "Remove example/api" })).toBeTruthy();

    const input = await screen.findByRole("textbox", { name: "Repositories with a review bot" });
    fireEvent.change(input, { target: { value: "example" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("owner/name");
    fireEvent.change(input, { target: { value: "https://github.com/example/web/pull/9" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(stored.notifications.reviewBotRepos).toEqual(["example/api", "example/web"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove example/api" }));
    await waitFor(() => expect(stored.notifications.reviewBotRepos).toEqual(["example/web"]));
    expect(refreshReviewRequests).toHaveBeenLastCalledWith({ force: true });
    // Taken off, it is suggested again, since its bot has reviewed there.
    fireEvent.click(await screen.findByRole("button", { name: "Add example/api" }));
    await waitFor(() =>
      expect(stored.notifications.reviewBotRepos).toEqual(["example/web", "example/api"]),
    );
  });

  it("fills the list in from a poll of its own once the threads are known", async () => {
    fireEvent.click(screen.getByRole("switch", { name: /Wait for review bot/ }));
    await waitFor(() => expect(stored.notifications.reviewRequestsAwaitBot).toBe(true));
    expect(stored.notifications.reviewBotRepos).toBeUndefined();

    // A forced poll that fails leaves the last result, which isn't enough to seed from.
    refreshReviewRequests.mockImplementationOnce(async () => {});
    act(() => useThreadsStore.setState({ ready: true }));
    await waitFor(() => expect(refreshReviewRequests).toHaveBeenCalledTimes(2));
    expect(stored.notifications.reviewBotRepos).toBeUndefined();

    // A badge landing while the seed saves is added behind it.
    let saved!: () => void;
    updateSettings.mockImplementationOnce(async (patch: SettingsPatch) => {
      await new Promise<void>((resolve) => (saved = resolve));
      stored = applySettingsPatch(stored, patch);
      useServerSettings.setState({ settings: stored });
      return stored;
    });
    act(() => useThreadsStore.setState({ ready: false }));
    act(() => useThreadsStore.setState({ ready: true }));
    await waitFor(() => expect(saved).toBeDefined());
    withBadge("t-0", "example/ops");
    act(() => saved());
    await waitFor(() =>
      expect(stored.notifications.reviewBotRepos).toEqual(["example/api", "example/ops"]),
    );

    // A badge that lands after the snapshot still adds its repository, but only the once.
    withBadge("t-1", "example/web");
    await waitFor(() =>
      expect(stored.notifications.reviewBotRepos).toEqual([
        "example/api",
        "example/ops",
        "example/web",
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove example/web" }));
    await waitFor(() =>
      expect(stored.notifications.reviewBotRepos).toEqual(["example/api", "example/ops"]),
    );
    // Two badges in quick succession both land, the second saved after the first.
    withBadge("t-2", "example/web");
    withBadge("t-3", "example/infra");
    withBadge("t-4", "example/docs");
    await waitFor(() =>
      expect(stored.notifications.reviewBotRepos).toEqual([
        "example/api",
        "example/ops",
        "example/infra",
        "example/docs",
      ]),
    );
  });

  it("hides bot pull requests by default, and follows the parent toggle", async () => {
    const bots = screen.getByRole<HTMLButtonElement>("switch", {
      name: /Hide bot pull requests/,
    });
    expect(bots.getAttribute("aria-checked")).toBe("true");
    expect(bots.disabled).toBe(false);

    fireEvent.click(bots);
    await waitFor(() => expect(refreshReviewRequests).toHaveBeenCalledWith({ force: true }));
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: { reviewRequestsHideBots: false },
    });
    expect(stored.notifications.reviewRequestsHideBots).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: /Check for review requests/ }));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("switch", { name: /Hide bot pull requests/ }).disabled,
      ).toBe(true),
    );
  });

  it("sets a maximum age, clears it again, and follows the parent toggle", async () => {
    expect(radio("Off").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(radio("30 days"));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { reviewRequestsMaxAgeDays: 30 },
      }),
    );
    expect(refreshReviewRequests).toHaveBeenCalledWith({ force: true });
    expect(stored.notifications.reviewRequestsMaxAgeDays).toBe(30);
    await waitFor(() => expect(radio("30 days").getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(radio("Off"));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({
        notifications: { reviewRequestsMaxAgeDays: null },
      }),
    );
    expect(stored.notifications.reviewRequestsMaxAgeDays).toBeUndefined();

    fireEvent.click(screen.getByRole("switch", { name: /Check for review requests/ }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("radio", { name: "7 days" }).disabled).toBe(true),
    );
  });

  it("picks a sound or None, and previews without saving", async () => {
    expect(radio("Chime").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(radio("Bell"));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { sounds: true, chime: "bell" },
      }),
    );
    await waitFor(() => expect(radio("Bell").getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(radio("None"));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ notifications: { sounds: false } }),
    );
    await waitFor(() => expect(radio("None").getAttribute("aria-checked")).toBe("true"));

    updateSettings.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Preview Marimba" }));
    expect(playChime).toHaveBeenCalledWith("marimba");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("is one tab stop, and arrow keys choose the next sound", async () => {
    expect(radio("Chime").tabIndex).toBe(0);
    expect(radio("Bell").tabIndex).toBe(-1);

    fireEvent.keyDown(radio("Chime"), { key: "ArrowRight" });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: { sounds: true, chime: "bell" },
      }),
    );
    await waitFor(() => expect(radio("Bell").tabIndex).toBe(0));

    fireEvent.keyDown(radio("Bell"), { key: "ArrowLeft" });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({
        notifications: { sounds: true, chime: "chime" },
      }),
    );
  });

  it("says when Motion Off keeps notifications quiet, while Preview still plays", () => {
    expect(screen.queryByTestId("sound-motion-off")).toBeNull();
    act(() => themeStore.setState({ motion: "off" }));
    expect(screen.getByTestId("sound-motion-off").textContent).toContain("Preview still plays");
    fireEvent.click(screen.getByRole("button", { name: "Preview Bell" }));
    expect(playChime).toHaveBeenCalledWith("bell");
  });
});
