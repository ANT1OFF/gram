import { isExternalUrl } from "@gram/contracts";

import { useEmbedShell } from "@/embed/store";
import { askToOpen } from "@/links/link-dialog";

import type { Api } from "./types";

/**
 * Whether links open in this browser rather than through the server. A hosted server runs away
 * from the person, where its opener would open nothing they can see: there the page opens it.
 */
const opensHere = (): boolean => useEmbedShell.getState().hosted;

/** Opens an http(s) `url` in a new tab of this browser, the opener cut off from this page. */
const openInTab = (url: string): void => {
  if (isExternalUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * Opens `url` in the default browser: through the desktop bridge when present, in a new tab when
 * the server is hosted, else through the server's opener.
 */
export const openExternalUrl = async (api: Api, url: string): Promise<void> => {
  const bridge = window.gram;
  if (bridge?.openExternal) await bridge.openExternal(url);
  else if (opensHere()) openInTab(url);
  else await api.openExternal(url);
};

/**
 * Opens a URL from content the app didn't write, such as a terminal's output: the desktop shell
 * asks before it opens, and in a browser the page asks first.
 */
export const openContentUrl = async (api: Api, url: string): Promise<void> => {
  const bridge = window.gram;
  if (bridge?.openExternal) await bridge.openExternal(url);
  else if (await askToOpen(url)) {
    if (opensHere()) openInTab(url);
    else await api.openExternal(url);
  }
};
