import type { NotificationStatus } from "@gram/contracts";
import type { Page } from "@playwright/test";

// A fake macOS desktop shell for screens that show only inside it, such as Settings → General's
// Window group. Each member answers with invented state; nothing reads the host's login items,
// notification permission, tray or accounts.

export interface DesktopShellState {
  readonly keepInTray?: boolean;
  /** `launchAtLogin.get`'s answer; leave out for a shell older than the setting. */
  readonly launchAtLogin?: { readonly enabled: boolean; readonly needsApproval: boolean } | null;
  /** `notificationStatus.get`'s answer; leave out for a shell older than the row. */
  readonly notificationStatus?: NotificationStatus;
}

export async function seedDesktopShell(page: Page, state: DesktopShellState) {
  await page.addInitScript((seed) => {
    Object.defineProperty(window, "gram", {
      configurable: true,
      value: {
        platform: "darwin",
        onMenu: () => () => {},
        onNotificationClick: () => () => {},
        notify() {},
        setBadge() {},
        setTitleBarTheme() {},
        setVibrancy() {},
        setMenuShortcuts() {},
        reportConnection() {},
        windowLayout: async () => null,
        setWindowLayout() {},
        listFonts: async () => [],
        openExternal: async () => true,
        copyText: async () => {},
        keepInTray: {
          get: async () => seed.keepInTray ?? false,
          set: async () => {},
          onChange: () => () => {},
        },
        ...(seed.launchAtLogin === undefined
          ? {}
          : {
              launchAtLogin: {
                get: async () => seed.launchAtLogin,
                set: async (enabled: boolean) => ({ enabled, needsApproval: false }),
                openSettings: async () => true,
              },
            }),
        ...(seed.notificationStatus === undefined
          ? {}
          : {
              notificationStatus: {
                get: async () => seed.notificationStatus,
                onChange: () => () => {},
                sendTest: async () => {},
                openSettings: async () => true,
              },
            }),
        updates: {
          autoCheck: async () => false,
          onProgress: () => () => {},
          check: async () => ({
            available: false,
            unavailable: true,
            currentVersion: "0.0.0",
            canSelfInstall: false,
          }),
        },
      },
    });
  }, state);
}
