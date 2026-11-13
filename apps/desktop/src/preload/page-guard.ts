// The preload of pinned pages' frames (`@gram/shell` `modules/pages`): the clipboard guard in the
// main world before the page's own scripts, and nothing else. No `window.gram`, no channel.
import { contextBridge } from "electron";

import { installPageGuard } from "@gram/shell/preload";

installPageGuard(contextBridge);
