import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { NavigationDefaults } from "@/embed/contract";

/** What marks the main navigation's region (the dock, or an auto-hidden sidebar). */
export const NAV_REGION = "data-nav-region";

/** What marks one of the dock's items, for the keyboard to find. */
export const DOCK_ITEM = "data-dock-item";

/** Where the main navigation sits: the sidebar at the left, or a dock at the top or bottom. */
export type NavigationPosition = "side" | "top" | "bottom";

export const NAVIGATION_POSITIONS: readonly NavigationPosition[] = ["side", "top", "bottom"];

/** A navigation layout, each value left out taking the one under it. */
export interface NavigationPrefs {
  readonly position?: NavigationPosition;
  readonly autoHide?: boolean;
}

/** The navigation layout in effect. */
export interface NavigationLayout {
  readonly position: NavigationPosition;
  readonly autoHide: boolean;
}

/** Gram's own: the sidebar, always shown. */
export const DEFAULT_NAVIGATION: NavigationLayout = {
  position: "side",
  autoHide: false,
};

interface NavigationState {
  /** The embedding app's default, from `MountOptions.layout.navigation`. Not persisted. */
  readonly host: NavigationPrefs;
  /** What the person picked in Settings → Appearance, over the host's default. */
  readonly picked: NavigationPrefs;
  /** An auto-hidden navigation held in view by ⌘B until it is hidden again. Not persisted. */
  readonly revealed: boolean;
  /** Whether an auto-hidden navigation is in view now, for whatever reason. Not persisted. */
  readonly shown: boolean;
  /** Counts the times it was hidden on purpose (⌘B, Escape), which drops what held it. */
  readonly hideTick: number;
  /** The dock's Overview sheet, the sidebar's list over the page. Not persisted. */
  readonly sheet: boolean;
  setHost(host: NavigationDefaults | undefined): void;
  pick(prefs: NavigationPrefs): void;
  setRevealed(revealed: boolean): void;
  setShown(shown: boolean): void;
  /** Slides an auto-hidden navigation away, whatever held it in view. */
  hide(): void;
  setSheet(sheet: boolean): void;
}

/** The host's navigation options in the store's terms; unknown values are dropped. */
export function hostNavigationPrefs(host: NavigationDefaults | undefined): NavigationPrefs {
  if (host === undefined) return {};
  const position =
    host.position === "dock"
      ? host.edge === "top"
        ? "top"
        : "bottom"
      : host.position === "side"
        ? "side"
        : undefined;
  return {
    ...(position === undefined ? {} : { position }),
    ...(typeof host.autoHide === "boolean" ? { autoHide: host.autoHide } : {}),
  };
}

/** The person's pick over the host's default over Gram's own. */
export function navigationLayout(
  state: Pick<NavigationState, "host" | "picked">,
): NavigationLayout {
  return {
    position: state.picked.position ?? state.host.position ?? DEFAULT_NAVIGATION.position,
    autoHide: state.picked.autoHide ?? state.host.autoHide ?? DEFAULT_NAVIGATION.autoHide,
  };
}

function sanitizePicked(raw: unknown): NavigationPrefs {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(NAVIGATION_POSITIONS.includes(r["position"] as NavigationPosition)
      ? { position: r["position"] as NavigationPosition }
      : {}),
    ...(typeof r["autoHide"] === "boolean" ? { autoHide: r["autoHide"] } : {}),
  };
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set) => ({
      host: {},
      picked: {},
      revealed: false,
      shown: false,
      hideTick: 0,
      sheet: false,
      setHost: (host) => set({ host: hostNavigationPrefs(host) }),
      pick: (prefs) => set((s) => ({ picked: { ...s.picked, ...prefs }, sheet: false })),
      setRevealed: (revealed) => set({ revealed }),
      setShown: (shown) => set({ shown }),
      hide: () => set((s) => ({ revealed: false, hideTick: s.hideTick + 1 })),
      setSheet: (sheet) => set({ sheet }),
    }),
    {
      name: "gram.navigation",
      version: 1,
      storage: createJSONStorage(() => globalThis.localStorage),
      partialize: ({ picked }) => ({ picked }),
      merge: (persisted, current) => ({
        ...current,
        picked: sanitizePicked((persisted as { picked?: unknown } | undefined)?.picked),
      }),
    },
  ),
);

/** The navigation layout in effect; a phone keeps its drawer, so it is always `side` there. */
export function useNavigationLayout(phone = false): NavigationLayout {
  const position = useNavigationStore((s) => navigationLayout(s).position);
  const autoHide = useNavigationStore((s) => navigationLayout(s).autoHide);
  return phone ? DEFAULT_NAVIGATION : { position, autoHide };
}

/** The navigation layout in effect now, outside React. */
export const navigationNow = (): NavigationLayout =>
  navigationLayout(useNavigationStore.getState());
