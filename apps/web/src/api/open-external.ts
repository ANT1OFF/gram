import { askToOpen } from "@/links/link-dialog";

import type { Api } from "./types";

/** Opens `url` in the default browser: through the desktop bridge when present, else the server's opener. */
export const openExternalUrl = async (api: Api, url: string): Promise<void> => {
  const bridge = window.gram;
  if (bridge?.openExternal) await bridge.openExternal(url);
  else await api.openExternal(url);
};

/**
 * Opens a URL from content the app didn't write, such as a terminal's output: the desktop shell
 * asks before it opens, and in a browser the page asks first.
 */
export const openContentUrl = async (api: Api, url: string): Promise<void> => {
  const bridge = window.gram;
  if (bridge?.openExternal) await bridge.openExternal(url);
  else if (await askToOpen(url)) await api.openExternal(url);
};
