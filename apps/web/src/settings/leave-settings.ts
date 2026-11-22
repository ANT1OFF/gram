import type { ThreadId } from "@gram/contracts";
import {
  useLocation,
  useNavigate,
  useRouter,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useShortcut } from "@/keyboard/registry";
import { appPathname, withoutBasePath } from "@/lib/app-path";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";

export const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

const RETURN_KEY = "gram.settings-return";

const storedReturn = (): string | undefined => {
  try {
    return sessionStorage.getItem(RETURN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

let returnTo = storedReturn() ?? "/";

/** The location Back and Esc leave Settings for. */
export const settingsReturn = (): string => returnTo;

/** Remembers where Esc from Settings returns to, whichever way Settings was opened. Mount once. */
export function useRememberSettingsReturn() {
  const { pathname, href } = useLocation();
  useEffect(() => {
    if (isSettingsPath(pathname)) return;
    returnTo = href;
    try {
      sessionStorage.setItem(RETURN_KEY, href);
    } catch (_withoutSessionStorageBackStillKnowsItUntilA) {}
  }, [pathname, href]);
  useHoldReadingPlaces();
}

/** Leaves Settings for where you came from, with the focus back in its composer. */
export function leaveSettings(navigate: UseNavigateResult<string>): void {
  void navigate({ href: returnTo }).then(() =>
    focusPaneComposer(useLayoutStore.getState().grid.focused),
  );
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
    run: () => leaveSettings(navigate),
  });
  return headingRef;
}

/**
 * Where a transcript was being read when the window left it for Settings: the row at the top of the
 * view, by its message id, and how far past that row's start the view was.
 */
export interface ReadingPlace {
  readonly key: string;
  readonly offset: number;
}

const held = new Map<ThreadId, ReadingPlace>();
let path: string | undefined;
const pathNow = (): string => (path ??= typeof window === "undefined" ? "/" : appPathname());

function useHoldReadingPlaces() {
  const router = useRouter();
  useEffect(() => {
    pathNow();
    return router.history.subscribe(() => {
      const from = pathNow();
      path = withoutBasePath(router.history.location.pathname);
      if (path !== from && !isSettingsPath(path) && !isSettingsPath(from)) held.clear();
    });
  }, [router]);
}

/** Holds `threadId`'s reading place when its transcript leaves because Settings opened. */
export const holdReadingPlace = (threadId: ThreadId, place: ReadingPlace): void => {
  if (isSettingsPath(pathNow())) held.set(threadId, place);
};

/** `threadId`'s held reading place, for its transcript coming back from Settings. */
export const heldReadingPlace = (threadId: ThreadId): ReadingPlace | undefined =>
  isSettingsPath(pathNow()) ? undefined : held.get(threadId);

/** Lets `threadId`'s reading place go once its transcript is back on it. */
export const releaseReadingPlace = (threadId: ThreadId): void => {
  held.delete(threadId);
};
