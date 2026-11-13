import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { preloadRightPanel } from "@/components/right-panel";
import { lazyParts } from "@/lib/lazy-part";
import { preloadWorkspaceSheet } from "@/settings/workspace-sheet";

import { thisLinkIsConstrained } from "./constrained-link";

const ignore = () => {};

/**
 * Fetches what the shell leaves out of its first download once the first frame is up: markdown
 * first, since an open thread's transcript waits for it, then the right panel's tabs, the
 * workspace sheet and Settings' last page while the window is idle, before anyone opens them. A
 * Settings that has to fetch its code when ⌘, is pressed opens a beat late. Then the dialogs,
 * sheets and views made with `lazyPart`, one per idle moment, so none of them adds a long task to
 * the window's first seconds.
 *
 * Over a slow or metered link only the markdown is fetched: the rest is a hundred files and a third
 * of the launch's bytes, and there they hold up the transcript and the feed the person is waiting
 * for. Each part still loads when it is first opened.
 */
export function usePreloadAfterPaint() {
  const router = useRouter();
  useEffect(() => {
    let idle: number | undefined;
    let stopped = false;
    const whenIdle = (run: () => void) => {
      idle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(run, { timeout: 2000 })
          : window.setTimeout(run, 200);
    };
    const parts = [...lazyParts()];
    const next = () => {
      const part = parts.shift();
      if (stopped || part === undefined) return;
      part
        .preload()
        .catch(ignore)
        .finally(() => {
          if (!stopped) whenIdle(next);
        });
    };
    const frame = requestAnimationFrame(() => {
      loadMarkdown().catch(ignore);
      if (thisLinkIsConstrained()) return;
      whenIdle(() => {
        preloadRightPanel().catch(ignore);
        preloadWorkspaceSheet().catch(ignore);
        // `/settings` redirects to the page open last, which the preload follows.
        router.preloadRoute({ to: "/settings" }).catch(ignore);
        whenIdle(next);
      });
    });
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (idle === undefined) return;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [router]);
}
