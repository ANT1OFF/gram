import { useEffect } from "react";

import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { preloadRightPanel } from "@/components/right-panel";
import { preloadWorkspaceSheet } from "@/settings/workspace-sheet";

const ignore = () => {};

/**
 * Fetches what the shell leaves out of its first download once the first frame is up: markdown
 * first, since an open thread's transcript waits for it, then the right panel's tabs and the
 * workspace sheet while the window is idle, before anyone opens them.
 */
export function usePreloadAfterPaint() {
  useEffect(() => {
    let idle: number | undefined;
    const frame = requestAnimationFrame(() => {
      loadMarkdown().catch(ignore);
      const rest = () => {
        preloadRightPanel().catch(ignore);
        preloadWorkspaceSheet().catch(ignore);
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
  }, []);
}
