import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { appPathname } from "@/lib/app-path";

import { isSettingsPath } from "./leave-settings";

/** Where a Settings link or command goes: the tab open last time, or a page of its own. */
export type SettingsEntry = "/settings" | "/settings/diagnostics";

/**
 * A Settings link's target, replacing the entry when Settings is already open. `/settings`
 * redirects to the tab open last time, which is then the open one: pushed, it left two of the same
 * entry, and the first Back seemed to do nothing. Opened from elsewhere it adds one entry, so one
 * Back leaves Settings. `gram/settings-entry` keeps every link to `/settings` on this.
 */
export function useSettingsLink(to: SettingsEntry = "/settings") {
  const pathname = useLocation({ select: (location) => location.pathname });
  return { to: settingsTarget(to, pathname), replace: isSettingsPath(pathname) };
}

/**
 * Where a Settings link goes from `pathname`. With Settings open, `/settings` is its open page (a
 * sub-page's own page): where the index's redirect to the tab open last time lands anyway, and
 * going by the index drew Settings with no page, its list gone and its picker saying "Section", for
 * a frame on the way.
 */
export function settingsTarget(to: SettingsEntry, pathname: string): SettingsEntry {
  if (to !== "/settings" || !isSettingsPath(pathname)) return to;
  return (/^\/settings\/[^/]+/.exec(pathname)?.[0] ?? to) as SettingsEntry;
}

/**
 * Opens Settings as `useSettingsLink`'s link does, reading where the window is when it runs. The
 * same function on every render, so an effect that holds it subscribes once.
 */
export function useOpenSettings(): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    const pathname = appPathname();
    void navigate({ to: settingsTarget("/settings", pathname), replace: isSettingsPath(pathname) });
  }, [navigate]);
}
