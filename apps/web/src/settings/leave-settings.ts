import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useShortcut } from "@/keyboard/registry";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";

const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

/** The last location outside Settings; the grid until there has been one. */
let returnTo = "/";

/** Remembers where Esc from Settings returns to, whichever way Settings was opened. Mount once. */
export function useRememberSettingsReturn() {
  const { pathname, href } = useLocation();
  useEffect(() => {
    if (!isSettingsPath(pathname)) returnTo = href;
  }, [pathname, href]);
}

/**
 * Settings' keyboard entry and exit: focus starts on the returned heading, and Esc from any page goes
 * back to where you came from. A field being typed in, a select or a dialog keeps its own Esc.
 */
export function useSettingsKeyboard() {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  useShortcut({
    id: "settings.close",
    keys: "escape",
    label: "Leave settings",
    group: "App",
    run: () => {
      void navigate({ href: returnTo }).then(() =>
        focusPaneComposer(useLayoutStore.getState().grid.focused),
      );
    },
  });
  return headingRef;
}
