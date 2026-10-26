import { existsSync } from "node:fs";

import { isAppIconId, localPortUrl, type MenuShortcuts, type UpdateSource } from "@gram/contracts";
import { app, BrowserWindow, clipboard, dialog, shell } from "electron";

import { Channels } from "@gram/shell/channels";
import { noticesPath, openAcknowledgements } from "./acknowledgements.ts";
import type { AppIcon } from "./app-icon.ts";
import { runningBuildInfo } from "./build-info.ts";
import { bundlePathOf, chooseFolder, openPrivacySettings } from "./folder-access.ts";
import type { LoginItem } from "./login-item.ts";
import { openNotificationSettings, TEST_NOTIFICATION } from "./notification-settings.ts";
import { APP_ID } from "./app-id.ts";
import {
  focusWindow,
  notify,
  notifyShell,
  openLink,
  parseMenuShortcuts,
  setBadge,
  setTitleBarTheme,
  setVibrancy,
  trustedLinkHosts,
  untrustLinkHost,
  withdrawNotification,
  type WindowIpc,
} from "@gram/shell/electron";
import {
  badgeCount,
  isAllowedExternalUrl,
  isPortNumber,
  isRevealablePath,
  isThreadIdArg,
  isWindowId,
  parseGridLayout,
  parseInstallIntent,
  parseNotification,
  parseTitleBarTheme,
} from "@gram/shell/core";
import type { NotificationStatusTracker } from "@gram/shell/core";
import type { ShellIpc } from "@gram/shell/modules/ipc";
import type { UpdateService } from "@gram/shell/modules/update";
import type { NativeUpdates } from "./update/native-updates.ts";

/** A diagnostics report is a few hundred KB at most. */
const MAX_CLIPBOARD_CHARS = 5_000_000;

/** The window operations the bridge exposes; the sender's window is found from its web contents. */
export interface IpcOptions {
  /** The app's IPC behind its trust check; the shell modules install on it too. */
  readonly ipc: ShellIpc;
  readonly updates: UpdateService;
  /** Electron's updater, on Developer ID signed macOS installs only. */
  readonly native?: NativeUpdates | undefined;
  /** Where this install's updater reads releases; see `updateSource`. */
  readonly updateSource: UpdateSource;
  /** Whether windows check for updates on their own; see `autoUpdateCheckEnabled`. */
  readonly autoUpdateCheck: boolean | (() => Promise<boolean>);
  readonly windows: WindowIpc;
  /** Rebuilds the menu with the user's keybindings. */
  readonly setMenuShortcuts: (shortcuts: MenuShortcuts) => void;
  /** The Dock or taskbar icon the user picked in Settings. */
  readonly appIcon: Pick<AppIcon, "get" | "set">;
  /** "Open at login"; see `login-item.ts`. */
  readonly loginItem: LoginItem;
  /** What happened to the newest notification; see `core/notification-status.ts`. */
  readonly notificationStatus: Pick<NotificationStatusTracker, "status">;
}

const threadIdOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const threadId: unknown = Reflect.get(input, "threadId");
  return isThreadIdArg(threadId) ? threadId : undefined;
};

/** Wires the preload bridge to the shell. Every message is dropped unless it comes from a trusted page. */
export function registerIpc({
  ipc,
  updates,
  native,
  updateSource,
  autoUpdateCheck,
  windows,
  setMenuShortcuts,
  appIcon,
  loginItem,
  notificationStatus,
}: IpcOptions) {
  const { on, handle } = ipc;

  on(Channels.setBadge, (_event, count) => setBadge(badgeCount(count)));
  on(Channels.notify, (event, input) => {
    const notification = parseNotification(input);
    if (notification) notify(notification, BrowserWindow.fromWebContents(event.sender));
  });
  on(Channels.notificationWithdraw, (_event, id) => {
    if (typeof id === "string") withdrawNotification(id);
  });
  on(Channels.setTitleBarTheme, (_event, input) => {
    const theme = parseTitleBarTheme(input);
    if (theme) setTitleBarTheme(theme);
  });
  on(Channels.setVibrancy, (_event, enabled) => setVibrancy(enabled === true));
  on(Channels.setMenuShortcuts, (_event, input) => setMenuShortcuts(parseMenuShortcuts(input)));
  handle(Channels.appIconGet, () => appIcon.get());
  handle(Channels.appIconSet, (icon) => {
    if (!isAppIconId(icon)) throw new Error("appIcon.set needs one of APP_ICONS");
    appIcon.set(icon);
  });
  handle(Channels.notificationStatusGet, () => notificationStatus.status());
  handle(Channels.notificationStatusTest, (_arg, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    notifyShell({
      ...TEST_NOTIFICATION,
      test: true,
      onClick: () => {
        if (win !== null && !win.isDestroyed()) focusWindow(win);
      },
    });
  });
  handle(Channels.notificationStatusSettings, () =>
    openNotificationSettings({
      platform: process.platform,
      appId: APP_ID,
      openExternal: (url) => shell.openExternal(url),
    }),
  );
  handle(Channels.launchAtLoginGet, () => loginItem.state());
  handle(Channels.launchAtLoginSet, (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("launchAtLogin.set needs a boolean");
    return loginItem.set(enabled);
  });
  handle(Channels.launchAtLoginSettings, () => loginItem.openSettings());

  handle(Channels.openExternal, (url, event) =>
    isAllowedExternalUrl(url)
      ? openLink(url, BrowserWindow.fromWebContents(event.sender) ?? undefined)
      : false,
  );
  handle(Channels.openLocalPort, async (port) => {
    if (!isPortNumber(port)) return false;
    await shell.openExternal(localPortUrl(port));
    return true;
  });
  handle(Channels.trustedLinksList, () => trustedLinkHosts());
  handle(Channels.trustedLinksRemove, (host) => {
    if (typeof host === "string") untrustLinkHost(host);
  });
  handle(Channels.copyText, (text) => {
    if (typeof text !== "string" || text.length > MAX_CLIPBOARD_CHARS) {
      throw new Error("copyText needs a string of at most 5 MB");
    }
    clipboard.writeText(text);
  });
  handle(Channels.showItemInFolder, (path) => {
    if (!isRevealablePath(path) || !existsSync(path)) return false;
    shell.showItemInFolder(path);
    return true;
  });
  handle(Channels.openPrivacySettings, () =>
    openPrivacySettings({
      platform: process.platform,
      openExternal: (url) => shell.openExternal(url),
    }),
  );
  handle(Channels.openAcknowledgements, () =>
    openAcknowledgements(
      noticesPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
      (path) => shell.openPath(path),
    ),
  );
  handle(Channels.chooseFolder, (input, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return chooseFolder(
      (options) =>
        window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
      input,
    );
  });
  handle(Channels.appBuildInfo, () => runningBuildInfo(app.getVersion(), app.isPackaged));
  handle(Channels.appBundlePath, () => bundlePathOf(app.getPath("exe")));
  handle(Channels.updatesCheck, (channel) =>
    updates.check(channel === "prerelease" ? "prerelease" : "stable"),
  );
  handle(Channels.updatesInstall, (input) => {
    // A signed install has one way in: Electron's updater, behind the same stop fence.
    if (native)
      return {
        updating: false,
        error: "This Gram updates from the update button or Settings → Updates.",
      };
    const intent = parseInstallIntent(input);
    return intent
      ? updates.install(intent)
      : { updating: false, error: "malformed install request" };
  });
  handle(Channels.updatesAutoCheck, () =>
    typeof autoUpdateCheck === "function" ? autoUpdateCheck() : autoUpdateCheck,
  );
  handle(Channels.updatesSource, () => updateSource);
  // Null everywhere but a Developer ID signed macOS install; the renderer then shows the other.
  handle(Channels.updatesNativeState, () => native?.state() ?? null);
  handle(Channels.updatesNativeCheck, (channel) =>
    native ? native.check(channel === "prerelease" ? "prerelease" : "stable", true) : null,
  );
  handle(Channels.updatesNativeDownload, () => native?.download() ?? null);
  handle(Channels.updatesNativeInstall, (version) =>
    !native ? null : typeof version === "string" ? native.install(version) : native.state(),
  );
  handle(Channels.updatesNativeDismiss, () => native?.dismiss() ?? null);

  handle(Channels.windowOpen, (input) => {
    const threadId = threadIdOf(input);
    windows.open(threadId === undefined ? {} : { threadId });
  });
  handle(Channels.windowFocus, (input) => {
    const windowId: unknown =
      typeof input === "object" && input !== null ? Reflect.get(input, "windowId") : undefined;
    return isWindowId(windowId) ? windows.focus(windowId, threadIdOf(input)) : false;
  });
  handle(Channels.windowLayoutGet, (_arg, event) => windows.layoutFor(event.sender) ?? null);
  on(Channels.windowLayoutSet, (event, input) => {
    const layout = parseGridLayout(input);
    if (layout) windows.saveLayoutFor(event.sender, layout);
  });
}
