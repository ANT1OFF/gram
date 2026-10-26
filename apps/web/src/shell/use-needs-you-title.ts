import { useEffect } from "react";

import { needsYouCount } from "@/desktop/use-desktop-bridge";
import { useAttentionStore } from "@/sidebar/attention";
import { useThreadsStore } from "@/stores/threads";

const APP_TITLE = "Gram";

/** The window title: the needs-you count in front, and just the name at zero. */
export const titleFor = (count: number): string =>
  count > 0 ? `(${count}) ${APP_TITLE}` : APP_TITLE;

/**
 * Mount once per window: keeps `document.title` in step with the needs-you count. Electron mirrors
 * it into the window's own title.
 */
export function useNeedsYouTitle() {
  useEffect(() => {
    const sync = () => {
      document.title = titleFor(needsYouCount(Object.values(useThreadsStore.getState().byId)));
    };
    sync();
    const unsubscribeAttention = useAttentionStore.subscribe(sync);
    const unsubscribeThreads = useThreadsStore.subscribe((state, prev) => {
      if (state.byId !== prev.byId) sync();
    });
    return () => {
      unsubscribeAttention();
      unsubscribeThreads();
      document.title = APP_TITLE;
    };
  }, []);
}
