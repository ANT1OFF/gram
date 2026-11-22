import type { HostedSiteBridge } from "@gram/contracts/desktop-bridge";
import { HOSTED_SITE_TURN_GRANT } from "./site-channel.ts";

/**
 * The hosted site window's preload: `window.gramHostedSite`, one call, and nothing of the app's
 * bridge. The main process decides each answer (`site-window.ts`).
 */
export const installHostedSiteBridge = (
  bridge: { exposeInMainWorld(name: string, api: unknown): void },
  ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> },
): void => {
  const site: HostedSiteBridge = {
    turnGrant: async (threadId) =>
      (await ipc.invoke(HOSTED_SITE_TURN_GRANT, { threadId })) as Awaited<
        ReturnType<HostedSiteBridge["turnGrant"]>
      >,
  };
  bridge.exposeInMainWorld("gramHostedSite", site);
};
