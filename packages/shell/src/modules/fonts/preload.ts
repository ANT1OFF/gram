import type { DesktopBridge } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";

/** The fonts module's bridge half: the installed families (`installFonts` serves them). */
export const fontsPreload = (ipc: PreloadIpc): Pick<DesktopBridge, "listFonts"> => ({
  listFonts: () => ipc.invoke(Channels.listFonts),
});
