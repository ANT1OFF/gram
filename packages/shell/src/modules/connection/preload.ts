import type { DesktopBridge } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";

/** The connection module's bridge half: a window's socket state, for the shell's log. */
export const connectionPreload = (ipc: PreloadIpc): Pick<DesktopBridge, "reportConnection"> => ({
  reportConnection: (connection) => ipc.send(Channels.connectionState, connection),
});
