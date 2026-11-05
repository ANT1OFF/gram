import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { preloadRightPanel } from "@/components/right-panel";
import { preloadWorkspaceSheet } from "@/settings/workspace-sheet";

const ignore = () => {};

/**
 * Fetches what the shell leaves out of its first download once the first frame is up: markdown
 * first, since an open thread's transcript waits for it, then the right panel's tabs, the
 * workspace sheet and Settings' last page while the window is idle, before anyone opens them. A
 * Settings that has to fetch its code when ⌘, is pressed opens a beat late.
 */
export function usePreloadAfterPaint() {
  const router = useRouter();
  useEffect(() => {
    let idle: number | undefined;
    const frame = requestAnimationFrame(() => {
      loadMarkdown().catch(ignore);
      const rest = () => {
        preloadRightPanel().catch(ignore);
        preloadWorkspaceSheet().catch(ignore);
        // `/settings` redirects to the page open last, which the preload follows.
        router.preloadRoute({ to: "/settings" }).catch(ignore);
      };
      idle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(rest, { timeout: 2000 })
          : window.setTimeout(rest, 200);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (idle === undefined) return;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [router]);
}
