import type { ThreadId, ThreadSummary } from "@gram/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { attentionOf, savedAcknowledgements, useAttentionStore } from "./attention";

/**
 * The attention the user is looking at: the focused pane's, while the thread grid is on screen and
 * the window has focus. Off the grid (`/`, `/new`, `/settings`) the focused pane isn't visible, so
 * nothing counts as seen.
 */
export function focusedAttention({
  gridShown,
  hasFocus,
  loaded,
  focusedThread,
  byId,
}: {
  gridShown: boolean;
  hasFocus: boolean;
  loaded: boolean;
  focusedThread: ThreadId | null | undefined;
  byId: Readonly<Record<string, ThreadSummary>>;
}): { readonly threadId: ThreadId; readonly key: string } | undefined {
  if (!gridShown || !hasFocus || !loaded || !focusedThread) return undefined;
  const summary = byId[focusedThread];
  const attention = summary === undefined ? undefined : attentionOf(summary);
  return attention === undefined ? undefined : { threadId: focusedThread, key: attention.key };
}

/**
 * Mount once: loads the acknowledgements saved in settings, and while a thread pane is on screen in
 * a focused window counts the focused thread's attention as seen, now and whenever it changes, so a
 * red build on the thread you're looking at never nags. Acknowledgements are saved in settings so
 * they survive a restart.
 */
export function useAcknowledgeAttention() {
  const api = useApi();
  const gridShown = useLocation({ select: (location) => location.pathname.startsWith("/t/") });

  useEffect(() => {
    const hydrate = () => {
      const settings = useServerSettings.getState().settings;
      if (settings) useAttentionStore.getState().hydrate(settings.attention?.acknowledged ?? []);
    };
    const check = () => {
      const { grid } = useLayoutStore.getState();
      const seen = focusedAttention({
        gridShown,
        hasFocus: document.hasFocus(),
        loaded: useAttentionStore.getState().loaded,
        focusedThread: grid.panes[grid.focused],
        byId: useThreadsStore.getState().byId,
      });
      if (seen === undefined) return;
      if (!useAttentionStore.getState().acknowledge(seen.threadId, seen.key)) return;
      const acknowledged = savedAcknowledgements(useAttentionStore.getState().acknowledged);
      api
        .updateSettings({ attention: { acknowledged } })
        .then((settings) => useServerSettings.setState({ settings }))
        .catch((error: unknown) => console.error("attention: save acknowledgement", error));
    };
    hydrate();
    check();
    const unsubscribeSettings = useServerSettings.subscribe((s, prev) => {
      if (s.settings === prev.settings) return;
      hydrate();
      check();
    });
    const unsubscribeLayout = useLayoutStore.subscribe(check);
    const unsubscribeThreads = useThreadsStore.subscribe((s, prev) => {
      if (s.byId !== prev.byId) check();
    });
    window.addEventListener("focus", check);
    return () => {
      unsubscribeSettings();
      unsubscribeLayout();
      unsubscribeThreads();
      window.removeEventListener("focus", check);
    };
  }, [api, gridShown]);
}
