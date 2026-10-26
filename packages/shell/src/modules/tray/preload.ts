import type { DesktopBridge, TrayAction } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";

/**
 * The tray module's bridge half: "Keep running in the tray" (on macOS, the menu bar item it
 * shows), and the menu of asks and workspaces each window sends it.
 */
export const trayPreload = (ipc: PreloadIpc): Pick<DesktopBridge, "keepInTray" | "tray"> => ({
  keepInTray: {
    get: () => ipc.invoke(Channels.keepInTrayGet),
    set: (enabled) => ipc.invoke(Channels.keepInTraySet, enabled),
    onChange: (callback) => ipc.subscribe(Channels.keepInTrayChanged, callback),
  },
  tray: {
    show: (menu) => ipc.send(Channels.trayMenu, menu),
    onAction: (callback) => ipc.subscribe<TrayAction>(Channels.trayAction, callback),
  },
});
