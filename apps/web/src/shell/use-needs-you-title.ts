import { useEffect } from "react";

import type { ShellDocument } from "@/embed/contract";
import { useEmbedPageTitle } from "@/embed/slots";
import { useEmbedShell } from "@/embed/store";
import { needsYouCount, useDerivedAsks } from "@/orchestration/needs-you-store";

const APP_TITLE = "Gram";

/**
 * The window title: the needs-you count in front, and just the name at zero. An app in front of
 * Gram may write it itself (`shell.document.title`), from the page's name and the count; one that
 * throws leaves Gram's own.
 */
export const titleFor = (
  count: number,
  shellDocument: ShellDocument = {},
  page: string | undefined = undefined,
): string => {
  const own = count > 0 ? `(${count}) ${APP_TITLE}` : APP_TITLE;
  if (shellDocument.title === undefined) return own;
  try {
    return shellDocument.title({ name: page, needsYou: count });
  } catch {
    return own;
  }
};

/**
 * Mount once per window: keeps `document.title` in step with the needs-you count, the one the
 * sidebar's pill shows, and with the page when an app in front of Gram names the tab. Electron
 * mirrors it into the window's own title.
 */
export function useNeedsYouTitle() {
  const shellDocument = useEmbedShell((s) => s.document);
  const page = useEmbedPageTitle();
  useEffect(() => {
    const sync = () => {
      document.title = titleFor(needsYouCount(), shellDocument, page);
    };
    sync();
    const unsubscribe = useDerivedAsks.subscribe((state, prev) => {
      if (state.needsYou !== prev.needsYou) sync();
    });
    return () => {
      unsubscribe();
      document.title = APP_TITLE;
    };
  }, [shellDocument, page]);
}
