import {
  applySettingsPatch,
  overviewHiddenOf,
  overviewSidebarOf,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import type { Palette } from "@gram/themes";
import type { StoreApi } from "zustand";

import { isNotImplemented } from "@/api/errors";
import type { Api } from "@/api/types";
import type { LayoutState } from "@/stores/layout";
import type { ThemeStore } from "@/theme/store";

import {
  appearanceFromPrefs,
  paletteOps,
  prefsFromAppearance,
  settingsPatch,
  toThemePalette,
  type SyncedSettings,
} from "./mapping";

type SettingsSyncApi = Pick<
  Api,
  "getSettings" | "updateSettings" | "listPalettes" | "upsertPalette" | "removePalette"
>;

export interface SettingsSyncOptions {
  api: SettingsSyncApi;
  theme: ThemeStore;
  layout: Pick<StoreApi<LayoutState>, "getState" | "subscribe">;
  /** Called once the server's settings have been applied. */
  onLoaded?: (settings: Settings) => void;
  debounceMs?: number;
  /** Where changes the server hasn't acknowledged wait between launches; `localStorage` by default. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export const SETTINGS_DEBOUNCE_MS = 400;

/** Local changes the server hasn't acknowledged yet, as a settings patch. */
export const UNSYNCED_SETTINGS_KEY = "gram.settings.unsynced";

/** Unimplemented RPCs keep local state quietly; anything else is logged and local state kept. */
const report = (what: string, error: unknown) => {
  if (!isNotImplemented(error)) console.error(`settings sync: ${what}`, error);
};

/**
 * Keeps theme preferences, the side panels and custom palettes in step with the server. The
 * server wins at start (local storage is only the first-paint cache), except for local changes it
 * never acknowledged: a push still debouncing when the window closed, or one that failed. Those
 * wait under `UNSYNCED_SETTINGS_KEY` and are applied over the server's values and pushed at the next
 * start. Afterwards local changes are pushed, debounced, as patches of only what changed. Pulled
 * values are recorded as synced before listening, so applying them never echoes back.
 */
export function createSettingsSync(options: SettingsSyncOptions) {
  const { api, theme, layout, debounceMs = SETTINGS_DEBOUNCE_MS } = options;
  const storage = options.storage ?? globalThis.localStorage;
  /** What the last push assumed the server holds; the base for the next patch. */
  let synced: SyncedSettings | undefined;
  /** What the server has acknowledged; the base for the unsynced record. */
  let confirmed: SyncedSettings | undefined;
  let syncedPalettes: readonly Palette[] | undefined;
  /** The custom palettes the server has acknowledged; what a failed palette push falls back to. */
  let confirmedPalettes: readonly Palette[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** Applying pulled values is not a local change, so it must not be scheduled as one. */
  let pulling = false;
  /** A pull is running: changes are still recorded, but no push may race its reads. */
  let holding = false;
  /** Every write still out, so a pull can wait for one a timer started before it. */
  let pushing: Promise<unknown> = Promise.resolve();
  const unsubscribe: (() => void)[] = [];

  const current = (): SyncedSettings => ({
    appearance: appearanceFromPrefs(theme.getState()),
    sidebarWidth: layout.getState().sidebarWidth,
    panelOpen: layout.getState().panelOpen,
    panelWidth: layout.getState().panelWidth,
    panelTab: layout.getState().panelTab,
    focusMode: layout.getState().focusMode,
    overviewSidebar: layout.getState().overviewSidebar,
    overviewHidden: layout.getState().overviewHidden,
  });

  const apply = (settings: Settings) => {
    theme.getState().setTheme(prefsFromAppearance(settings.appearance));
    const { sidebar, panel } = settings;
    layout.getState().setSidebarWidth(sidebar.width);
    layout.getState().setPanel({ open: panel.open, width: panel.width, tab: panel.tab });
    layout.getState().setFocusMode(settings.layout?.focusMode ?? false);
    layout.getState().setOverviewSidebar(overviewSidebarOf(settings));
    layout.getState().setOverviewHidden(overviewHiddenOf(settings));
  };

  /** Records what the server hasn't acknowledged, or clears the record once it has everything. */
  const recordUnsynced = () => {
    if (!confirmed) return;
    const patch = settingsPatch(confirmed, current());
    if (patch) storage.setItem(UNSYNCED_SETTINGS_KEY, JSON.stringify(patch));
    else storage.removeItem(UNSYNCED_SETTINGS_KEY);
  };

  const readUnsynced = (): SettingsPatch | undefined => {
    try {
      const raw = storage.getItem(UNSYNCED_SETTINGS_KEY);
      return raw === null ? undefined : (JSON.parse(raw) as SettingsPatch);
    } catch {
      return undefined;
    }
  };

  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    const pending: Promise<unknown>[] = [];
    if (synced) {
      const next = current();
      const patch = settingsPatch(synced, next);
      synced = next;
      if (patch) {
        pending.push(
          api.updateSettings(patch).then(
            () => {
              confirmed = next;
              recordUnsynced();
            },
            (e: unknown) => {
              // The next push diffs from what the server really has, so it retries this one.
              synced = confirmed;
              report("save", e);
            },
          ),
        );
      }
    }
    if (syncedPalettes) {
      const local = theme.getState().customPalettes;
      const ops = paletteOps(syncedPalettes, local);
      syncedPalettes = local;
      let failed = false;
      const fail = (what: string) => (e: unknown) => {
        failed = true;
        report(what, e);
      };
      const writes = [
        ...ops.upsert.map((palette) =>
          api.upsertPalette(palette).catch(fail(`save ${palette.id}`)),
        ),
        ...ops.remove.map((id) => api.removePalette(id).catch(fail(`remove ${id}`))),
      ];
      pending.push(
        Promise.all(writes).then(() => {
          // As with settings: the next push diffs from what the server really has, so it retries.
          if (failed) syncedPalettes = confirmedPalettes;
          else confirmedPalettes = local;
        }),
      );
    }
    const writes = Promise.all(pending);
    pushing = Promise.all([pushing, writes]);
    await writes;
  };

  const schedule = () => {
    if (disposed || pulling) return;
    // Recorded now rather than at the push, so closing the window mid-debounce loses nothing.
    recordUnsynced();
    clearTimeout(timer);
    if (holding) return;
    timer = setTimeout(() => void flush(), debounceMs);
  };

  // Local changes are pushed once something was read to diff them against: at start, or at the
  // first pull to succeed when the server was unreachable as the window opened.
  let listening = false;
  const listen = () => {
    if (listening || disposed) return;
    listening = true;
    unsubscribe.push(theme.subscribe(schedule), layout.subscribe(schedule));
  };

  return {
    async start() {
      const [settings, palettes] = await Promise.allSettled([
        api.getSettings(),
        api.listPalettes(),
      ]);
      if (disposed) return;
      const unsynced = readUnsynced();
      let loaded: Settings | undefined;
      if (settings.status === "fulfilled") {
        apply(settings.value);
        synced = confirmed = current();
        loaded = unsynced ? applySettingsPatch(settings.value, unsynced) : settings.value;
        if (unsynced) apply(loaded);
      } else {
        report("load settings", settings.reason);
      }
      if (palettes.status === "fulfilled") {
        const custom = palettes.value.filter((p) => !p.builtin).map(toThemePalette);
        theme.getState().setCustomPalettes(custom);
        syncedPalettes = confirmedPalettes = custom;
      } else {
        report("load palettes", palettes.reason);
      }
      if (synced || syncedPalettes) listen();
      if (loaded) options.onLoaded?.(loaded);
      if (loaded && unsynced) await flush();
    },
    /** Pushes pending changes now instead of waiting for the debounce. */
    flush,
    /**
     * Takes the server's settings and palettes again, for a change made behind this window's back:
     * another window can edit both. What was pulled becomes the new baseline, and everything
     * the server had not acknowledged is laid back over it as the local change it still is: a push
     * that failed, an edit made while one was out, an edit made during the reads. Pushes are held
     * for the duration, and one already out is waited for, so no write can land between the reads
     * and be undone by them. Palettes land before settings so a newly saved palette can be selected.
     */
    async pull() {
      holding = true;
      let edited: SettingsPatch | undefined;
      let ackedPalettes: readonly Palette[] | undefined;
      let localPalettes: readonly Palette[] = [];
      let pulledSettings: Settings | undefined;
      try {
        await flush();
        await pushing;
        const [settings, palettes] = await Promise.allSettled([
          api.getSettings(),
          api.listPalettes(),
        ]);
        if (disposed) return;
        edited = confirmed ? settingsPatch(confirmed, current()) : undefined;
        localPalettes = theme.getState().customPalettes;

        pulling = true;
        try {
          if (palettes.status === "fulfilled") {
            ackedPalettes = confirmedPalettes;
            const pulled = palettes.value.filter((p) => !p.builtin).map(toThemePalette);
            theme.getState().setCustomPalettes(pulled);
            syncedPalettes = confirmedPalettes = pulled;
          } else {
            report("reload palettes", palettes.reason);
          }
          if (settings.status === "fulfilled") {
            pulledSettings = settings.value;
            apply(settings.value);
            synced = confirmed = current();
            recordUnsynced();
            options.onLoaded?.(settings.value);
          } else {
            report("reload settings", settings.reason);
          }
        } finally {
          pulling = false;
        }
      } finally {
        holding = false;
      }

      // Replayed outside `pulling` and `holding`, so they are scheduled like any local change.
      if (ackedPalettes) {
        const ops = paletteOps(ackedPalettes, localPalettes);
        const removed = new Set<string>(ops.remove);
        const changed = new Set<string>(ops.upsert.map((p) => p.id));
        if (removed.size > 0 || changed.size > 0) {
          theme
            .getState()
            .setCustomPalettes([
              ...theme
                .getState()
                .customPalettes.filter((p) => !removed.has(p.id) && !changed.has(p.id)),
              ...localPalettes.filter((p) => changed.has(p.id)),
            ]);
        }
      }
      if (pulledSettings && edited) apply(applySettingsPatch(pulledSettings, edited));
      if (synced || syncedPalettes) listen();
      // A read that failed replays nothing, and what was held back still has to go out.
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const stop of unsubscribe) stop();
    },
  };
}
