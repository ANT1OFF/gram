import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

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
  const replace = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  return { to, replace };
}

/**
 * Opens Settings as `useSettingsLink`'s link does, reading where the window is when it runs. The
 * same function on every render, so an effect that holds it subscribes once.
 */
export function useOpenSettings(): () => void {
  const navigate = useNavigate();
  const router = useRouter();
  return useCallback(
    () =>
      void navigate({
        to: "/settings",
        replace: isSettingsPath(router.state.location.pathname),
      }),
    [navigate, router],
  );
}
