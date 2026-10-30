import { useEffect } from "react";

import { needsYouCount, useDerivedAsks } from "@/orchestration/needs-you-store";

const APP_TITLE = "Gram";

/** The window title: the needs-you count in front, and just the name at zero. */
export const titleFor = (count: number): string =>
  count > 0 ? `(${count}) ${APP_TITLE}` : APP_TITLE;

/**
 * Mount once per window: keeps `document.title` in step with the needs-you count, the one the
 * sidebar's pill shows. Electron mirrors it into the window's own title.
 */
export function useNeedsYouTitle() {
  useEffect(() => {
    const sync = () => {
      document.title = titleFor(needsYouCount());
    };
    sync();
    const unsubscribe = useDerivedAsks.subscribe((state, prev) => {
      if (state.needsYou !== prev.needsYou) sync();
    });
    return () => {
      unsubscribe();
      document.title = APP_TITLE;
    };
  }, []);
}
