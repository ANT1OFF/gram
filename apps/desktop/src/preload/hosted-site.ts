import { contextBridge, ipcRenderer } from "electron";

import { installHostedSiteBridge } from "@gram/shell/preload";

installHostedSiteBridge(contextBridge, ipcRenderer);
