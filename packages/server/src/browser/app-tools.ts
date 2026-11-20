import { Layer } from "effect";
import { DevServerAppToolsLive } from "./dev-server-tools.ts";
import { PanePort } from "./pane-port.ts";
import { BrowserAppToolsLive } from "./tools.ts";

/**
 * The browser's app tools: the agent's own page and its dev servers. Merged with the pane port,
 * so the handlers that show an agent's page to a client reach the same port.
 */
export const BrowserFamilyAppToolsLive = Layer.mergeAll(
  BrowserAppToolsLive.pipe(Layer.provideMerge(PanePort.layer)),
  DevServerAppToolsLive,
);
