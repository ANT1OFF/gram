import type {
  AppUpdateState,
  DesktopBridge,
  DesktopMenuAction,
  DesktopNotificationAction,
  GridLayout,
  NotificationStatus,
  UpdateProgress,
} from "@gram/contracts";
import { contextBridge, ipcRenderer, webFrame, webUtils, type IpcRendererEvent } from "electron";

import { Channels } from "@gram/shell/channels";
import {
  agentBrowsePreload,
  composeBridge,
  connectionPreload,
  fontsPreload,
  preloadIpc,
  previewPreload,
  speechPreload,
  trayPreload,
} from "@gram/shell/preload";
import { parseWindowArg } from "@gram/shell/window-arg";

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const windowInfo = parseWindowArg(process.argv);

const ipc = preloadIpc(ipcRenderer);

/** The desktop's own members; the shell modules' come with them in `bridge` below. */
const base = {
  platform: process.platform,
  ...(windowInfo === undefined ? {} : { window: windowInfo }),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onMenu: (callback) => subscribe<DesktopMenuAction>(Channels.menu, callback),
  setBadge: (count) => ipcRenderer.send(Channels.setBadge, count),
  notify: (notification) => ipcRenderer.send(Channels.notify, notification),
  onNotificationClick: (callback) => subscribe<string | null>(Channels.notificationClick, callback),
  onNotificationAction: (callback) =>
    subscribe<DesktopNotificationAction>(Channels.notificationAction, callback),
  withdrawNotification: (id) => ipcRenderer.send(Channels.notificationWithdraw, id),
  setTitleBarTheme: (theme) => ipcRenderer.send(Channels.setTitleBarTheme, theme),
  setVibrancy: (enabled) => ipcRenderer.send(Channels.setVibrancy, enabled),
  // The zoom the View menu's roles drive, in their half-level steps and Chromium's own range, so a
  // press handled here and one the menu caught land on the same scale, remembered per origin.
  zoom: (step) =>
    webFrame.setZoomLevel(
      step === "reset"
        ? 0
        : Math.min(9, Math.max(-8, webFrame.getZoomLevel() + (step === "in" ? 0.5 : -0.5))),
    ),
  zoomFactor: () => webFrame.getZoomFactor(),
  fullScreen: {
    get: () => ipcRenderer.invoke(Channels.windowFullScreenGet),
    onChange: (callback) => subscribe<boolean>(Channels.windowFullScreenChanged, callback),
  },
  setMenuShortcuts: (shortcuts) => ipcRenderer.send(Channels.setMenuShortcuts, shortcuts),
  appIcon: {
    get: () => ipcRenderer.invoke(Channels.appIconGet),
    set: (icon) => ipcRenderer.invoke(Channels.appIconSet, icon),
  },
  openExternal: (url) => ipcRenderer.invoke(Channels.openExternal, url),
  openLocalPort: (port) => ipcRenderer.invoke(Channels.openLocalPort, port),
  trustedLinks: {
    list: () => ipcRenderer.invoke(Channels.trustedLinksList),
    remove: (host) => ipcRenderer.invoke(Channels.trustedLinksRemove, host),
    onChange: (callback) => subscribe<readonly string[]>(Channels.trustedLinksChanged, callback),
  },
  copyText: (text) => ipcRenderer.invoke(Channels.copyText, text),
  showItemInFolder: (path) => ipcRenderer.invoke(Channels.showItemInFolder, path),
  openPrivacySettings: () => ipcRenderer.invoke(Channels.openPrivacySettings),
  openAcknowledgements: () => ipcRenderer.invoke(Channels.openAcknowledgements),
  notificationStatus: {
    get: () => ipcRenderer.invoke(Channels.notificationStatusGet),
    onChange: (callback) =>
      subscribe<NotificationStatus>(Channels.notificationStatusChanged, callback),
    sendTest: () => ipcRenderer.invoke(Channels.notificationStatusTest),
    openSettings: () => ipcRenderer.invoke(Channels.notificationStatusSettings),
  },
  launchAtLogin: {
    get: () => ipcRenderer.invoke(Channels.launchAtLoginGet),
    set: (enabled) => ipcRenderer.invoke(Channels.launchAtLoginSet, enabled),
    openSettings: () => ipcRenderer.invoke(Channels.launchAtLoginSettings),
  },
  chooseFolder: async (options) =>
    ((await ipcRenderer.invoke(Channels.chooseFolder, options ?? {})) as string | null) ??
    undefined,
  appBuildInfo: () => ipcRenderer.invoke(Channels.appBuildInfo),
  appBundlePath: () => ipcRenderer.invoke(Channels.appBundlePath),
  openWindow: async (options) => {
    await ipcRenderer.invoke(Channels.windowOpen, options ?? {});
  },
  focusWindow: (windowId, threadId) =>
    ipcRenderer.invoke(Channels.windowFocus, { windowId, threadId }),
  windowLayout: async () =>
    ((await ipcRenderer.invoke(Channels.windowLayoutGet)) as GridLayout | null) ?? undefined,
  setWindowLayout: (layout) => ipcRenderer.send(Channels.windowLayoutSet, layout),
  onOpenThread: (callback) => subscribe<string>(Channels.windowOpenThread, callback),
  updates: {
    check: (channel) => ipcRenderer.invoke(Channels.updatesCheck, channel),
    install: (intent) => ipcRenderer.invoke(Channels.updatesInstall, intent),
    onProgress: (callback) => subscribe<UpdateProgress>(Channels.updatesProgress, callback),
    autoCheck: () => ipcRenderer.invoke(Channels.updatesAutoCheck),
    source: () => ipcRenderer.invoke(Channels.updatesSource),
    native: {
      state: () => ipcRenderer.invoke(Channels.updatesNativeState),
      onState: (callback) => subscribe<AppUpdateState>(Channels.updatesNativeChanged, callback),
      check: (channel) => ipcRenderer.invoke(Channels.updatesNativeCheck, channel),
      download: () => ipcRenderer.invoke(Channels.updatesNativeDownload),
      install: (version) => ipcRenderer.invoke(Channels.updatesNativeInstall, version),
      dismiss: () => ipcRenderer.invoke(Channels.updatesNativeDismiss),
    },
  },
} satisfies Omit<
  DesktopBridge,
  "listFonts" | "reportConnection" | "keepInTray" | "tray" | "speech" | "preview" | "agentBrowse"
>;

const bridge: DesktopBridge = composeBridge(
  base,
  fontsPreload(ipc),
  previewPreload(ipc),
  connectionPreload(ipc),
  trayPreload(ipc),
  speechPreload(ipc, window),
  agentBrowsePreload(ipc),
);

contextBridge.exposeInMainWorld("gram", bridge);
