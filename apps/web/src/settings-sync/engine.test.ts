// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  NotImplemented,
  type Palette,
  type PaletteId,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLayoutStore } from "@/stores/layout";
import { createThemeStore } from "@/theme/store";

import { createSettingsSync, SETTINGS_DEBOUNCE_MS, UNSYNCED_SETTINGS_KEY } from "./engine";
import { toThemePalette } from "./mapping";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

const seeds = {
  bg: "#101010",
  surface: "#141414",
  text: "#eeeeee",
  muted: "#777777",
  accent: "#7aa2f7",
  accent2: "#bb9af7",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  cyan: "#7dcfff",
};
const palette = (id: string, extra: Partial<Palette> = {}): Palette => ({
  id: id as PaletteId,
  name: id,
  mode: "dark",
  seeds,
  ...extra,
});

const fakeApi = (settings: Settings = DEFAULT_SETTINGS, palettes: Palette[] = []) => ({
  getSettings: vi.fn(async () => settings),
  updateSettings: vi.fn(async (patch: SettingsPatch) => applySettingsPatch(settings, patch)),
  listPalettes: vi.fn(async (): Promise<readonly Palette[]> => palettes),
  upsertPalette: vi.fn(async (p: Palette) => p),
  removePalette: vi.fn(async () => {}),
});

/** A launch: the theme store hydrates from `storage`, which the engine also keeps unsynced changes in. */
const setup = (api: ReturnType<typeof fakeApi>, storage = memoryStorage()) => {
  const theme = createThemeStore(storage);
  const sync = createSettingsSync({ api, theme, layout: useLayoutStore, storage });
  return { theme, sync, storage };
};

beforeEach(() => {
  vi.useFakeTimers();
  useLayoutStore.setState({ sidebarWidth: 280 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createSettingsSync", () => {
  it("reads the overview sections turned off, and saves a change as only what is off", async () => {
    useLayoutStore.setState({ overviewHidden: [] });
    const api = fakeApi({
      ...DEFAULT_SETTINGS,
      layout: { overviewSections: { doneToday: false, pullRequests: true } },
    });
    const { sync } = setup(api);
    await sync.start();
    expect(useLayoutStore.getState().overviewHidden).toEqual(["doneToday"]);
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).not.toHaveBeenCalled();

    useLayoutStore.getState().setOverviewHidden(["doneToday", "usage"]);
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).toHaveBeenLastCalledWith({
      layout: { overviewSections: { doneToday: false, usage: false } },
    });
    useLayoutStore.getState().setOverviewHidden([]);
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).toHaveBeenLastCalledWith({ layout: { overviewSections: null } });
    sync.dispose();
    useLayoutStore.setState({ overviewHidden: [] });
  });

  it("records the overview's mode when the server's settings hide it", async () => {
    useLayoutStore.setState({ overviewSidebar: "compact", overviewBeforeHide: undefined });
    const api = fakeApi({ ...DEFAULT_SETTINGS, layout: { overviewSidebar: "hidden" } });
    const { sync } = setup(api);
    await sync.start();
    expect(useLayoutStore.getState()).toMatchObject({
      overviewSidebar: "hidden",
      overviewBeforeHide: "compact",
    });
    // ⌘B then shows it as it was before the other window hid it.
    useLayoutStore.setState({ windowWidth: 1440 });
    useLayoutStore.getState().toggleOverview();
    expect(useLayoutStore.getState().overviewSidebar).toBe("compact");
    sync.dispose();
    useLayoutStore.setState({ overviewSidebar: undefined, overviewBeforeHide: undefined });
  });

  it("applies the server's appearance, overview width and custom palettes without echoing them", async () => {
    const api = fakeApi(
      {
        ...DEFAULT_SETTINGS,
        appearance: { ...DEFAULT_SETTINGS.appearance, look: "glass", mode: "light" },
        sidebar: { ...DEFAULT_SETTINGS.sidebar, width: 300 },
      },
      [palette("tokyo-night", { builtin: true }), palette("my-owl")],
    );
    const { theme, sync } = setup(api);
    await sync.start();

    expect(theme.getState()).toMatchObject({ look: "glass", mode: "light" });
    expect(useLayoutStore.getState().sidebarWidth).toBe(300);
    expect(theme.getState().customPalettes.map((p) => p.id)).toEqual(["my-owl"]);

    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(api.upsertPalette).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("pulls changes saved by another window, without echoing it or leaving it unsynced", async () => {
    const api = fakeApi();
    const { theme, sync, storage } = setup(api);
    await sync.start();

    api.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, look: "glass" },
      sidebar: { ...DEFAULT_SETTINGS.sidebar, width: 300 },
    });
    api.listPalettes.mockResolvedValue([palette("external")]);
    await sync.pull();

    expect(theme.getState().look).toBe("glass");
    expect(useLayoutStore.getState().sidebarWidth).toBe(300);
    expect(theme.getState().customPalettes.map((p) => p.id)).toEqual(["external"]);
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(api.upsertPalette).not.toHaveBeenCalled();
    expect(storage.getItem(UNSYNCED_SETTINGS_KEY)).toBeNull();
    sync.dispose();
  });

  it("keeps a change made while a pull is in flight, and pushes it over what was pulled", async () => {
    const api = fakeApi();
    const { theme, sync, storage } = setup(api);
    await sync.start();

    const inFlight = Promise.withResolvers<Settings>();
    api.getSettings.mockReturnValue(inFlight.promise);
    api.listPalettes.mockResolvedValue([palette("external")]);
    const pulled = sync.pull();
    await vi.advanceTimersByTimeAsync(0);

    // The user acts while the requests are out: a density, and a palette of their own.
    theme.getState().setTheme({ density: "compact" });
    theme.getState().setCustomPalettes([toThemePalette(palette("mine"))]);
    inFlight.resolve({
      ...DEFAULT_SETTINGS,
      sidebar: { ...DEFAULT_SETTINGS.sidebar, width: 300 },
    });
    await pulled;

    // Both sides survive: what the other window saved, and what the user did meanwhile.
    expect(useLayoutStore.getState().sidebarWidth).toBe(300);
    expect(theme.getState().density).toBe("compact");
    expect(
      theme
        .getState()
        .customPalettes.map((p) => p.id)
        .toSorted(),
    ).toEqual(["external", "mine"]);
    // Until the push lands it is on record, so closing the window now wouldn't lose it.
    expect(storage.getItem(UNSYNCED_SETTINGS_KEY)).toContain("compact");

    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    // One push, of the section the user touched, and nothing echoing back what was pulled.
    expect(api.updateSettings).toHaveBeenCalledOnce();
    const pushed = api.updateSettings.mock.calls[0]![0];
    expect(pushed.appearance).toMatchObject({ density: "compact" });
    expect(pushed).not.toHaveProperty("sidebar");
    expect(api.upsertPalette.mock.calls.map(([p]) => p.id)).toEqual(["mine"]);
    expect(api.removePalette).not.toHaveBeenCalled();
    expect(storage.getItem(UNSYNCED_SETTINGS_KEY)).toBeNull();
    sync.dispose();
  });

  it("pulls over a push that failed without losing what it carried, and sends it again", async () => {
    const api = fakeApi();
    const { theme, sync, storage } = setup(api);
    await sync.start();

    // The pull's own flush is the push that fails, so the server never heard of either change.
    theme.getState().setTheme({ density: "compact" });
    theme.getState().setCustomPalettes([toThemePalette(palette("mine"))]);
    api.updateSettings.mockRejectedValueOnce(new Error("offline"));
    api.upsertPalette.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      sidebar: { ...DEFAULT_SETTINGS.sidebar, width: 300 },
    });
    api.listPalettes.mockResolvedValue([palette("external")]);
    await sync.pull();

    expect(useLayoutStore.getState().sidebarWidth).toBe(300);
    expect(theme.getState().density).toBe("compact");
    expect(
      theme
        .getState()
        .customPalettes.map((p) => p.id)
        .toSorted(),
    ).toEqual(["external", "mine"]);
    expect(storage.getItem(UNSYNCED_SETTINGS_KEY)).toContain("compact");

    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
    expect(api.updateSettings.mock.calls[1]![0].appearance).toMatchObject({ density: "compact" });
    expect(api.upsertPalette.mock.calls.map(([p]) => p.id)).toEqual(["mine", "mine"]);
    expect(api.removePalette).not.toHaveBeenCalled();
    expect(storage.getItem(UNSYNCED_SETTINGS_KEY)).toBeNull();
    sync.dispose();
  });

  it("keeps an edit made while the pull's own push is still out, and lets no push race its reads", async () => {
    const api = fakeApi();
    const { theme, sync } = setup(api);
    await sync.start();

    theme.getState().setTheme({ density: "compact" });
    const write = Promise.withResolvers<Settings>();
    api.updateSettings.mockReturnValueOnce(write.promise);
    const reads = Promise.withResolvers<Settings>();
    api.getSettings.mockReturnValue(reads.promise);
    const pulled = sync.pull();
    await vi.advanceTimersByTimeAsync(0);

    // Not in the push that is out, and made before the reads begin: the gap a snapshot taken after
    // the flush fell into.
    theme.getState().setTheme({ mode: "light" });
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).toHaveBeenCalledOnce();
    expect(api.getSettings).toHaveBeenCalledOnce();

    write.resolve(DEFAULT_SETTINGS);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getSettings).toHaveBeenCalledTimes(2);
    // Held while the reads are out too: a write landing now would be undone by an older answer.
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).toHaveBeenCalledOnce();

    reads.resolve({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, look: "glass" },
      sidebar: { ...DEFAULT_SETTINGS.sidebar, width: 300 },
    });
    await pulled;
    expect(theme.getState()).toMatchObject({ look: "glass", mode: "light" });
    expect(useLayoutStore.getState().sidebarWidth).toBe(300);

    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
    expect(api.updateSettings.mock.calls[1]![0].appearance).toMatchObject({ mode: "light" });
    sync.dispose();
  });

  it("pushes one debounced patch holding only the changed sections", async () => {
    const api = fakeApi();
    const { theme, sync } = setup(api);
    await sync.start();

    theme.getState().setTheme({ mode: "light" });
    theme.getState().setTheme({ motion: "off" });
    useLayoutStore.getState().setSidebarWidth(300);
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS - 1);
    expect(api.updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(api.updateSettings).toHaveBeenCalledOnce();
    expect(api.updateSettings).toHaveBeenCalledWith({
      appearance: { mode: "light", motion: "off" },
      sidebar: { width: 300 },
    });
    sync.dispose();
  });

  it("upserts added and removes deleted custom palettes", async () => {
    const api = fakeApi(DEFAULT_SETTINGS, [palette("my-owl")]);
    const { theme, sync } = setup(api);
    await sync.start();

    theme.getState().setCustomPalettes([toThemePalette(palette("my-latte"))]);
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS);

    expect(api.upsertPalette).toHaveBeenCalledWith(expect.objectContaining({ id: "my-latte" }));
    expect(api.removePalette).toHaveBeenCalledWith("my-owl");
    sync.dispose();
  });

  it("keeps local state quietly while the server lacks settings", async () => {
    const api = fakeApi();
    api.getSettings.mockRejectedValue(new NotImplemented({ rpc: "settings.get" }));
    api.listPalettes.mockRejectedValue(new NotImplemented({ rpc: "palettes.list" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { theme, sync } = setup(api);
    await sync.start();

    theme.getState().setTheme({ mode: "light" });
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS);

    expect(theme.getState().mode).toBe("light");
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("starts pushing local changes once a pull succeeds after a start that read nothing", async () => {
    const api = fakeApi();
    api.getSettings.mockRejectedValueOnce(new Error("restarting"));
    api.listPalettes.mockRejectedValueOnce(new Error("restarting"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { theme, sync } = setup(api);
    await sync.start();

    await sync.pull();
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).not.toHaveBeenCalled();

    // An ordinary change later on, with no pull to carry it.
    theme.getState().setTheme({ density: "compact" });
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS * 2);
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it("logs other failures and keeps local state", async () => {
    const api = fakeApi();
    api.getSettings.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sync } = setup(api);
    await sync.start();

    expect(error).toHaveBeenCalledWith("settings sync: load settings", expect.any(Error));
    sync.dispose();
  });

  it("keeps a change still debouncing when the window closed over the server's older value", async () => {
    const api = fakeApi({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, mode: "dark" },
    });
    const first = setup(api);
    await first.sync.start();
    first.theme.getState().setTheme({ mode: "light" });
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS - 1);
    first.sync.dispose();
    expect(api.updateSettings).not.toHaveBeenCalled();

    // The next launch: same local storage, and the server still says dark.
    const next = setup(api, first.storage);
    expect(next.theme.getState().mode).toBe("light");
    await next.sync.start();

    expect(next.theme.getState().mode).toBe("light");
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { mode: "light" } });
    expect(next.storage.getItem(UNSYNCED_SETTINGS_KEY)).toBeNull();
    next.sync.dispose();
  });

  it("lets the server win at start when every local change was acknowledged", async () => {
    const api = fakeApi();
    const first = setup(api);
    await first.sync.start();
    first.theme.getState().setTheme({ mode: "light" });
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS);
    expect(first.storage.getItem(UNSYNCED_SETTINGS_KEY)).toBeNull();
    first.sync.dispose();

    // Another device switched to dark since.
    api.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, mode: "dark" },
    });
    const next = setup(api, first.storage);
    await next.sync.start();
    expect(next.theme.getState().mode).toBe("dark");
    expect(api.updateSettings).toHaveBeenCalledOnce();
    next.sync.dispose();
  });

  it("retries a failed push at the next start", async () => {
    const api = fakeApi();
    api.updateSettings.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = setup(api);
    await first.sync.start();
    first.theme.getState().setTheme({ motion: "off" });
    await first.sync.flush();
    first.sync.dispose();
    expect(JSON.parse(first.storage.getItem(UNSYNCED_SETTINGS_KEY) ?? "null")).toEqual({
      appearance: { motion: "off" },
    });

    const next = setup(api, first.storage);
    await next.sync.start();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { motion: "off" } });
    expect(next.storage.getItem(UNSYNCED_SETTINGS_KEY)).toBeNull();
    next.sync.dispose();
  });
});
