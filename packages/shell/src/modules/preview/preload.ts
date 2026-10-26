import type { DesktopBridge, PreviewState } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";

/** The preview module's bridge half: each thread's Preview tab page (`installPreview` serves it). */
export const previewPreload = (ipc: PreloadIpc): Pick<DesktopBridge, "preview"> => ({
  preview: {
    open: (threadId, url) => ipc.invoke(Channels.previewOpen, { threadId, url }),
    setBounds: (threadId, bounds) => ipc.send(Channels.previewBounds, { threadId, bounds }),
    back: (threadId) => ipc.send(Channels.previewBack, { threadId }),
    forward: (threadId) => ipc.send(Channels.previewForward, { threadId }),
    reload: (threadId) => ipc.send(Channels.previewReload, { threadId }),
    state: (threadId) => ipc.invoke(Channels.previewStateGet, { threadId }),
    inspect: (threadId, target) => ipc.invoke(Channels.previewInspect, { threadId, target }),
    viewport: (threadId, preset) => ipc.invoke(Channels.previewViewport, { threadId, preset }),
    takeOver: (threadId) => ipc.send(Channels.previewTakeOver, { threadId }),
    handBack: (threadId) => ipc.send(Channels.previewHandBack, { threadId }),
    onState: (threadId, callback) =>
      ipc.subscribe<{ readonly threadId: string; readonly state: PreviewState }>(
        Channels.previewState,
        (update) => {
          if (update.threadId === threadId) callback(update.state);
        },
      ),
  },
});
