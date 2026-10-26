import type { UpdateCheck, UpdateInstallResult, UpdateSource } from "@gram/contracts";
import { Channels } from "@gram/shell/channels";
import type { ShellIpc } from "@gram/shell/modules/ipc";

/**
 * Smoke opens the real renderer without runApp's services. Answer its update/tray/login-item/
 * notification bridge with unavailable state before navigation, without opening an updater or
 * starting a tray. Normal startup keeps registerIpc/installTray and the real updater entirely separate.
 */
export function installSmokeIpc(ipc: ShellIpc, currentVersion: string): void {
  const message = "Updates are unavailable during a smoke run.";
  ipc.handle(
    Channels.updatesCheck,
    () =>
      ({
        available: false,
        unavailable: true,
        unavailableMessage: message,
        currentVersion,
        canSelfInstall: false,
      }) satisfies UpdateCheck,
  );
  ipc.handle(
    Channels.updatesInstall,
    () => ({ updating: false, error: message }) satisfies UpdateInstallResult,
  );
  ipc.handle(Channels.updatesAutoCheck, () => false);
  ipc.handle(
    Channels.updatesSource,
    () => ({ repo: null, visibility: "private" }) satisfies UpdateSource,
  );
  ipc.handle(Channels.updatesNativeState, () => null);
  ipc.handle(Channels.updatesNativeCheck, () => null);
  ipc.handle(Channels.updatesNativeDownload, () => null);
  ipc.handle(Channels.updatesNativeInstall, () => null);
  ipc.handle(Channels.updatesNativeDismiss, () => null);
  ipc.handle(Channels.keepInTrayGet, () => false);
  ipc.handle(Channels.keepInTraySet, () => {});
  ipc.handle(Channels.notificationStatusGet, () => ({ supported: false, last: null }));
  ipc.handle(Channels.notificationStatusTest, () => {});
  ipc.handle(Channels.notificationStatusSettings, () => false);
  ipc.handle(Channels.launchAtLoginGet, () => null);
  ipc.handle(Channels.launchAtLoginSet, () => null);
  ipc.handle(Channels.launchAtLoginSettings, () => false);
}
