import type { DesktopBridge } from "@gram/contracts/desktop-bridge";
import type { PageViewState } from "@gram/contracts/link-trust";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";

/** The pages module's bridge half: pinned pages in the `gram-pages` session (`installPages`). */
export const pagesPreload = (ipc: PreloadIpc): Pick<DesktopBridge, "pages"> => ({
  pages: {
    open: (key, url) => ipc.invoke(Channels.pagesOpen, { key, url }),
    setBounds: (key, bounds) => ipc.send(Channels.pagesBounds, { key, bounds }),
    reload: (key) => ipc.send(Channels.pagesReload, { key }),
    close: (key) => ipc.send(Channels.pagesClose, { key }),
    onState: (key, callback) =>
      ipc.subscribe<{ readonly key: string; readonly state: PageViewState }>(
        Channels.pagesState,
        (update) => {
          if (update.key === key) callback(update.state);
        },
      ),
  },
});
