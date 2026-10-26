import type { DesktopBridge } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";

/** The agent browser module's bridge half: Settings → Agent may browse, to read and shrink. */
export const agentBrowsePreload = (ipc: PreloadIpc): Pick<DesktopBridge, "agentBrowse"> => ({
  agentBrowse: {
    list: () => ipc.invoke(Channels.agentBrowseList),
    remove: (host) => ipc.invoke(Channels.agentBrowseRemove, host),
    onChange: (callback) => ipc.subscribe<readonly string[]>(Channels.agentBrowseChanged, callback),
  },
});
