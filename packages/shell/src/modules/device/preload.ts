import type { DesktopBridge } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";

/**
 * The personal device's bridge half: Settings reads it, signs in and out, and stops lending.
 * Lending, resuming, lifting a pause and starting afresh only ask the shell to put the decision
 * to the person.
 */
export const hostedDevicePreload = (ipc: PreloadIpc): Pick<DesktopBridge, "hostedDevice"> => ({
  hostedDevice: {
    state: () => ipc.invoke(Channels.hostedDeviceState),
    signIn: (server) => ipc.invoke(Channels.hostedDeviceSignIn, { server }),
    signOut: (origin) => ipc.invoke(Channels.hostedDeviceSignOut, { origin }),
    refresh: (origin) => ipc.invoke(Channels.hostedDeviceRefresh, { origin }),
    lend: (origin, workspace) => ipc.invoke(Channels.hostedDeviceLend, { origin, workspace }),
    resume: (origin, workspace) => ipc.invoke(Channels.hostedDeviceResume, { origin, workspace }),
    stop: (origin, workspace) => ipc.invoke(Channels.hostedDeviceStop, { origin, workspace }),
    liftPause: (origin) => ipc.invoke(Channels.hostedDeviceLiftPause, { origin }),
    startAfresh: () => ipc.invoke(Channels.hostedDeviceStartAfresh),
    activity: () => ipc.invoke(Channels.hostedDeviceActivity),
    onChange: (callback) => ipc.subscribe<null>(Channels.hostedDeviceChanged, () => callback()),
  },
});
