import { contextBridge } from "electron";

import { installPageGuard } from "@gram/shell/preload";

installPageGuard(contextBridge);
